import asyncio
import base64
import json
import logging
import re
import time

import httpx

from app.core.config import LLM_MAX_RETRIES
from app.services.settings_service import load_settings

logger = logging.getLogger(__name__)

RETRY_DELAYS = [5, 15]
JSON_PARSE_RETRIES = 3
JSON_PARSE_RETRY_DELAY = 3
RETRYABLE_STATUS_CODES = {429, 500, 502, 503, 504, 524}
RETRYABLE_EXCEPTIONS = (
    httpx.ReadTimeout,
    httpx.ConnectTimeout,
    httpx.RemoteProtocolError,
    httpx.ConnectError,
    httpx.ReadError,
)

STREAM_READ_TIMEOUT = 200.0
TIMEOUT_IMAGE_GEN = httpx.Timeout(connect=10.0, read=240.0, write=10.0, pool=10.0)
TIMEOUT_DEFAULT = httpx.Timeout(connect=10.0, read=200.0, write=10.0, pool=10.0)


class LLMService:
    """OpenAI-compatible LLM client. API key and default base URL/models come from settings_service."""

    def __init__(self) -> None:
        self._model_override: str | None = None
        self._base_url_override: str | None = None
        self._image_model_override: str | None = None
        self.log_tag: str = ""
        self.asset_user_id: str | None = None
        self.asset_task_id: str | None = None
        self.asset_dir_prefix: str | None = None
        self.asset_use_sync_db: bool = False
        self._client: httpx.AsyncClient | None = None

    @property
    def model(self) -> str:
        if self._model_override is not None:
            return self._model_override
        return str(load_settings()["llm_model"])

    @model.setter
    def model(self, value: str | None) -> None:
        self._model_override = value

    @property
    def base_url(self) -> str:
        raw = (
            self._base_url_override
            if self._base_url_override is not None
            else str(load_settings()["llm_base_url"])
        )
        return raw.strip().rstrip("/")

    @base_url.setter
    def base_url(self, value: str | None) -> None:
        self._base_url_override = value

    @property
    def image_base_url(self) -> str:
        raw = str(load_settings().get("image_base_url", "")).strip()
        if not raw:
            raw = self.base_url
        return raw.strip().rstrip("/")

    @property
    def vision_base_url(self) -> str:
        raw = str(load_settings().get("vision_base_url", "")).strip()
        if not raw:
            raw = str(load_settings().get("image_base_url", "")).strip()
        if not raw:
            raw = self.base_url
        return raw.strip().rstrip("/")

    @property
    def image_model(self) -> str:
        if self._image_model_override is not None:
            return self._image_model_override
        return str(load_settings()["llm_image_model"])

    @image_model.setter
    def image_model(self, value: str | None) -> None:
        self._image_model_override = value

    def _require_api_key(self) -> str:
        key = str(load_settings().get("llm_api_key", "")).strip()
        if not key:
            raise ValueError(
                "LLM API key is not configured. Open application settings and set llm_api_key."
            )
        return key

    def _require_image_api_key(self) -> str:
        key = str(load_settings().get("image_api_key", "")).strip()
        if not key:
            # Fallback to general LLM API key if no separate image API key is provided
            key = str(load_settings().get("llm_api_key", "")).strip()
        if not key:
            raise ValueError(
                "Image API key is not configured. Open application settings and set image_api_key or llm_api_key."
            )
        return key

    def _require_vision_api_key(self) -> str:
        key = str(load_settings().get("vision_api_key", "")).strip()
        if not key:
            key = str(load_settings().get("image_api_key", "")).strip()
        if not key:
            key = str(load_settings().get("llm_api_key", "")).strip()
        if not key:
            raise ValueError(
                "Vision API key is not configured. Open application settings and set vision_api_key, image_api_key, or llm_api_key."
            )
        return key

    def _api_format(self) -> str:
        fmt = str(load_settings().get("api_format", "auto") or "auto").strip()
        if fmt not in {"auto", "gemini_native", "openai"}:
            return "auto"
        return fmt

    @staticmethod
    def _looks_openai_compatible_base_url(base_url: str) -> bool:
        u = (base_url or "").strip().lower().rstrip("/")
        return "/openai" in u or u.endswith("/v1")

    @staticmethod
    def _to_gemini_native_base_url(base_url: str) -> str:
        u = (base_url or "").strip().rstrip("/")
        lu = u.lower()
        # OpenAI-compatible Gemini endpoints often look like:
        #   https://generativelanguage.googleapis.com/v1beta/openai
        # Normalize them to host root before appending /v1beta/models/...
        for suffix in ("/v1beta/openai", "/v1/openai", "/openai", "/v1"):
            if lu.endswith(suffix):
                return u[: -len(suffix)]
        return u

    def _use_native_gemini_text(self) -> bool:
        fmt = self._api_format()
        if fmt == "gemini_native":
            return True
        if fmt == "openai":
            return False
        if self._looks_openai_compatible_base_url(self.base_url):
            return False
        return "gemini" in (self.model or "").lower()

    def _use_native_gemini_image(self) -> bool:
        fmt = self._api_format()
        if fmt == "gemini_native":
            return True
        if fmt == "openai":
            return False
        if self._looks_openai_compatible_base_url(self.image_base_url):
            return False
        return "gemini" in (self.image_model or "").lower()

    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(timeout=TIMEOUT_DEFAULT)
        return self._client

    async def _post_with_retry(
        self,
        url: str,
        body: dict,
        headers: dict,
        *,
        timeout: httpx.Timeout | float | None = None,
        max_retries: int = LLM_MAX_RETRIES,
    ) -> dict:
        model = body.get("model", "?")
        last_err: Exception | None = None
        for attempt in range(max_retries):
            is_last = attempt == max_retries - 1
            t0 = asyncio.get_event_loop().time()
            try:
                response = await self.client.post(
                    url, json=body, headers=headers,
                    timeout=timeout,
                )
                elapsed_ms = int((asyncio.get_event_loop().time() - t0) * 1000)
                if response.status_code in RETRYABLE_STATUS_CODES:
                    last_err = httpx.HTTPStatusError(
                        f"HTTP {response.status_code}",
                        request=response.request,
                        response=response,
                    )
                    if is_last:
                        logger.warning(
                            "%s[non-stream] HTTP %d from %s model=%s (%dms) — all %d attempts exhausted",
                            self.log_tag, response.status_code, url, model, elapsed_ms, max_retries,
                        )
                        break
                    delay = RETRY_DELAYS[min(attempt, len(RETRY_DELAYS) - 1)]
                    logger.warning(
                        "%s[non-stream] HTTP %d from %s model=%s (%dms, attempt %d/%d), retrying in %ds",
                        self.log_tag, response.status_code, url, model, elapsed_ms, attempt + 1, max_retries, delay,
                    )
                    await asyncio.sleep(delay)
                    continue
                if response.status_code >= 400:
                    err_text = response.text[:400]
                    raise httpx.HTTPStatusError(
                        f"HTTP {response.status_code} from {url} model={model}: {err_text}",
                        request=response.request,
                        response=response,
                    )
                return response.json()
            except RETRYABLE_EXCEPTIONS as e:
                elapsed_ms = int((asyncio.get_event_loop().time() - t0) * 1000)
                last_err = e
                if is_last:
                    logger.warning(
                        "%s[non-stream] %s model=%s (%dms, %s) — all %d attempts exhausted",
                        self.log_tag, url, model, elapsed_ms, type(e).__name__, max_retries,
                    )
                    break
                delay = RETRY_DELAYS[min(attempt, len(RETRY_DELAYS) - 1)]
                logger.warning(
                    "%s[non-stream] %s model=%s attempt %d/%d failed (%s, %dms), retrying in %ds",
                    self.log_tag, url, model, attempt + 1, max_retries, type(e).__name__, elapsed_ms, delay,
                )
                await asyncio.sleep(delay)
        raise last_err  # type: ignore[misc]

    async def _post_stream_with_retry(
        self,
        url: str,
        body: dict,
        headers: dict,
        *,
        read_timeout: float = STREAM_READ_TIMEOUT,
        max_retries: int = LLM_MAX_RETRIES,
    ) -> dict:
        timeout = httpx.Timeout(connect=10.0, read=read_timeout, write=10.0, pool=10.0)
        stream_body = {**body, "stream": True}
        model = body.get("model", "?")
        last_err: Exception | None = None

        for attempt in range(max_retries):
            is_last = attempt == max_retries - 1
            t0 = asyncio.get_event_loop().time()
            try:
                async with self.client.stream(
                    "POST", url, json=stream_body, headers=headers, timeout=timeout,
                ) as response:
                    elapsed_ms = int((asyncio.get_event_loop().time() - t0) * 1000)
                    if response.status_code in RETRYABLE_STATUS_CODES:
                        await response.aread()
                        last_err = httpx.HTTPStatusError(
                            f"HTTP {response.status_code}",
                            request=response.request,
                            response=response,
                        )
                        if is_last:
                            logger.warning(
                                "%s[stream] HTTP %d from %s model=%s (%dms) — all %d attempts exhausted",
                                self.log_tag, response.status_code, url, model, elapsed_ms, max_retries,
                            )
                            break
                        delay = RETRY_DELAYS[min(attempt, len(RETRY_DELAYS) - 1)]
                        logger.warning(
                            "%s[stream] HTTP %d from %s model=%s (%dms, attempt %d/%d), retrying in %ds",
                            self.log_tag, response.status_code, url, model, elapsed_ms, attempt + 1, max_retries, delay,
                        )
                        await asyncio.sleep(delay)
                        continue
                    if response.status_code >= 400:
                        err_bytes = await response.aread()
                        err_text = err_bytes.decode("utf-8", errors="ignore").strip()
                        raise httpx.HTTPStatusError(
                            f"HTTP {response.status_code} from {url} model={model}: {err_text[:400]}",
                            request=response.request,
                            response=response,
                        )

                    return await self._collect_stream_lines(response)
            except RETRYABLE_EXCEPTIONS as e:
                elapsed_ms = int((asyncio.get_event_loop().time() - t0) * 1000)
                last_err = e
                if is_last:
                    logger.warning(
                        "%s[stream] %s model=%s (%dms, %s) — all %d attempts exhausted",
                        self.log_tag, url, model, elapsed_ms, type(e).__name__, max_retries,
                    )
                    break
                delay = RETRY_DELAYS[min(attempt, len(RETRY_DELAYS) - 1)]
                logger.warning(
                    "%s[stream] %s model=%s attempt %d/%d failed (%s, %dms), retrying in %ds",
                    self.log_tag, url, model, attempt + 1, max_retries, type(e).__name__, elapsed_ms, delay,
                )
                await asyncio.sleep(delay)
        raise last_err  # type: ignore[misc]

    @staticmethod
    async def _collect_stream_lines(response: httpx.Response) -> dict:
        content_parts: list[str] = []
        role = "assistant"
        finish_reason: str | None = None
        model = ""

        async for line in response.aiter_lines():
            if not line.startswith("data: "):
                continue
            payload = line[6:].strip()
            if payload == "[DONE]":
                break
            try:
                chunk = json.loads(payload)
            except json.JSONDecodeError:
                continue

            model = chunk.get("model", model)
            choices = chunk.get("choices", [])
            if not choices:
                continue
            delta = choices[0].get("delta", {})
            if "role" in delta:
                role = delta["role"]
            if "content" in delta and delta["content"]:
                content_parts.append(delta["content"])
            if choices[0].get("finish_reason"):
                finish_reason = choices[0]["finish_reason"]

        return {
            "choices": [{
                "message": {"role": role, "content": "".join(content_parts)},
                "finish_reason": finish_reason,
            }],
            "model": model,
        }

    async def _auth_headers(self, channel: str = "text") -> dict[str, str]:
        if channel == "image":
            key = self._require_image_api_key()
        elif channel == "vision":
            key = self._require_vision_api_key()
        else:
            key = self._require_api_key()
        return {
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        }

    @staticmethod
    def _build_gemini_body(
        messages: list[dict],
        *,
        temperature: float = 0.1,
        tools: list[dict] | None = None,
        response_format: dict | None = None,
    ) -> dict:
        system_parts: list[dict] = []
        contents: list[dict] = []
        for msg in messages:
            role = msg.get("role", "user")
            content = msg.get("content")
            if role == "system":
                if isinstance(content, str):
                    system_parts.append({"text": content})
                continue

            if role == "tool":
                fn_name = msg.get("name", "unknown")
                raw = msg.get("content", "{}")
                try:
                    resp_data = json.loads(raw) if isinstance(raw, str) else raw
                except (json.JSONDecodeError, TypeError):
                    resp_data = {"result": raw}
                contents.append({
                    "role": "user",
                    "parts": [{"functionResponse": {"name": fn_name, "response": resp_data}}],
                })
                continue

            gemini_role = "model" if role == "assistant" else "user"
            parts: list[dict] = []
            tool_calls = msg.get("tool_calls") or []
            for tc in tool_calls:
                fn = tc.get("function", {})
                fn_name = fn.get("name", "")
                try:
                    fn_args = json.loads(fn.get("arguments", "{}"))
                except (json.JSONDecodeError, TypeError):
                    fn_args = {}
                parts.append({"functionCall": {"name": fn_name, "args": fn_args}})

            if isinstance(content, str) and content:
                parts.append({"text": content})
            elif isinstance(content, list):
                for item in content:
                    if not isinstance(item, dict):
                        continue
                    if item.get("type") == "text":
                        parts.append({"text": item.get("text", "")})
                    elif item.get("type") == "image_url":
                        url = item.get("image_url", {}).get("url", "")
                        if url.startswith("data:") and "," in url:
                            header, b64_data = url.split(",", 1)
                            mime_type = "image/png"
                            if ":" in header and ";" in header:
                                mime_type = header.split(":", 1)[1].split(";", 1)[0]
                            parts.append({"inlineData": {"mimeType": mime_type, "data": b64_data}})
                        elif url:
                            parts.append({"text": f"[image: {url}]"})

            if parts:
                contents.append({"role": gemini_role, "parts": parts})

        body: dict = {"contents": contents}
        if system_parts:
            body["systemInstruction"] = {"parts": system_parts}
        gen_config: dict = {"temperature": temperature}
        if response_format and response_format.get("type") == "json_object":
            gen_config["responseMimeType"] = "application/json"
        body["generationConfig"] = gen_config

        if tools:
            fn_decls = []
            for tool in tools:
                if tool.get("type") != "function":
                    continue
                fn = tool.get("function", {})
                decl: dict = {"name": fn.get("name", ""), "description": fn.get("description", "")}
                params = fn.get("parameters")
                if params:
                    decl["parameters"] = params
                fn_decls.append(decl)
            if fn_decls:
                body["tools"] = [{"functionDeclarations": fn_decls}]
        return body

    @staticmethod
    async def _collect_gemini_stream(response: httpx.Response) -> dict:
        text_parts: list[str] = []
        tool_calls: list[dict] = []
        finish_reason: str | None = None
        model = ""
        tc_index = 0
        async for line in response.aiter_lines():
            if not line.startswith("data: "):
                continue
            payload = line[6:].strip()
            if not payload or payload == "[DONE]":
                continue
            try:
                chunk = json.loads(payload)
            except json.JSONDecodeError:
                continue
            model = chunk.get("modelVersion", model)
            for candidate in chunk.get("candidates", []):
                for part in candidate.get("content", {}).get("parts", []):
                    if part.get("thought"):
                        continue
                    if "text" in part and part["text"]:
                        text_parts.append(part["text"])
                    if "functionCall" in part:
                        fc = part["functionCall"]
                        tool_calls.append({
                            "id": f"call_{tc_index}",
                            "type": "function",
                            "function": {
                                "name": fc.get("name", ""),
                                "arguments": json.dumps(fc.get("args", {}), ensure_ascii=False),
                            },
                        })
                        tc_index += 1
                raw_reason = candidate.get("finishReason")
                if raw_reason and raw_reason != "FINISH_REASON_UNSPECIFIED":
                    reason_map = {"STOP": "stop", "MAX_TOKENS": "length", "SAFETY": "content_filter"}
                    finish_reason = reason_map.get(raw_reason, str(raw_reason).lower())

        message: dict = {"role": "assistant", "content": "".join(text_parts)}
        if tool_calls:
            message["tool_calls"] = tool_calls
        return {"choices": [{"message": message, "finish_reason": finish_reason}], "model": model}

    async def _post_gemini_stream(
        self,
        body: dict,
        *,
        model: str,
        channel: str = "text",
        read_timeout: float = STREAM_READ_TIMEOUT,
        max_retries: int = LLM_MAX_RETRIES,
    ) -> dict:
        timeout = httpx.Timeout(connect=10.0, read=read_timeout, write=10.0, pool=10.0)
        if channel == "image":
            base_url = self.image_base_url
            api_key = self._require_image_api_key()
        else:
            base_url = self.base_url
            api_key = self._require_api_key()
        native_base = self._to_gemini_native_base_url(base_url)
        url = f"{native_base}/v1beta/models/{model}:streamGenerateContent?alt=sse&key={api_key}"

        last_err: Exception | None = None
        for attempt in range(max_retries):
            is_last = attempt == max_retries - 1
            t0 = asyncio.get_event_loop().time()
            try:
                async with self.client.stream(
                    "POST",
                    url,
                    json=body,
                    headers={"Content-Type": "application/json"},
                    timeout=timeout,
                ) as response:
                    elapsed_ms = int((asyncio.get_event_loop().time() - t0) * 1000)
                    if response.status_code in RETRYABLE_STATUS_CODES:
                        await response.aread()
                        last_err = httpx.HTTPStatusError(
                            f"HTTP {response.status_code}",
                            request=response.request,
                            response=response,
                        )
                        if is_last:
                            logger.warning(
                                "%s[gemini-stream] HTTP %d from %s model=%s (%dms) — all %d attempts exhausted",
                                self.log_tag, response.status_code, native_base, model, elapsed_ms, max_retries,
                            )
                            break
                        delay = RETRY_DELAYS[min(attempt, len(RETRY_DELAYS) - 1)]
                        await asyncio.sleep(delay)
                        continue
                    if response.status_code >= 400:
                        await response.aread()
                        response.raise_for_status()
                    return await self._collect_gemini_stream(response)
            except RETRYABLE_EXCEPTIONS as e:
                last_err = e
                if is_last:
                    break
                delay = RETRY_DELAYS[min(attempt, len(RETRY_DELAYS) - 1)]
                await asyncio.sleep(delay)
        raise last_err  # type: ignore[misc]

    async def chat(
        self,
        system_prompt: str,
        user_prompt: str,
        *,
        temperature: float = 0.1,
        response_format: str | None = None,
        read_timeout: float | None = None,
    ) -> str:
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]

        body: dict = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
        }
        if response_format == "json":
            body["response_format"] = {"type": "json_object"}

        stream_kw: dict = {}
        if read_timeout is not None:
            stream_kw["read_timeout"] = read_timeout

        use_native = self._use_native_gemini_text()
        try:
            if use_native:
                gem_body = self._build_gemini_body(
                    messages,
                    temperature=temperature,
                    response_format=body.get("response_format"),
                )
                data = await self._post_gemini_stream(
                    gem_body,
                    model=self.model,
                    channel="text",
                    read_timeout=stream_kw.get("read_timeout", STREAM_READ_TIMEOUT),
                )
            else:
                data = await self._post_stream_with_retry(
                    f"{self.base_url}/chat/completions",
                    body, await self._auth_headers(channel="text"),
                    **stream_kw,
                )
        except httpx.HTTPStatusError as e:
            status = getattr(getattr(e, "response", None), "status_code", None)
            retried = False
            if response_format == "json" and status == 400 and not use_native:
                logger.warning(
                    "%schat got HTTP 400 with response_format=json, retrying without response_format",
                    self.log_tag,
                )
                retry_body = dict(body)
                retry_body.pop("response_format", None)
                data = await self._post_stream_with_retry(
                    f"{self.base_url}/chat/completions",
                    retry_body, await self._auth_headers(channel="text"),
                    **stream_kw,
                )
                retried = True
            # Some OpenAI-compatible providers reject streaming payloads with 400.
            if status == 400 and not use_native and not retried:
                logger.warning(
                    "%schat stream got HTTP 400, retrying non-stream /chat/completions for compatibility",
                    self.log_tag,
                )
                ns_body = dict(body)
                ns_body.pop("stream", None)
                data = await self._post_with_retry(
                    f"{self.base_url}/chat/completions",
                    ns_body,
                    await self._auth_headers(channel="text"),
                    timeout=TIMEOUT_DEFAULT,
                )
            else:
                if not retried:
                    raise
        content = data["choices"][0]["message"]["content"]
        return content or ""

    async def chat_with_tools(
        self,
        messages: list[dict],
        tools: list[dict],
        *,
        temperature: float = 0.3,
    ) -> dict:
        body: dict = {
            "model": self.model,
            "messages": messages,
            "tools": tools,
            "temperature": temperature,
        }
        if self._use_native_gemini_text():
            gem_body = self._build_gemini_body(
                messages,
                temperature=temperature,
                tools=tools,
            )
            try:
                data = await self._post_gemini_stream(
                    gem_body,
                    model=self.model,
                    channel="text",
                    read_timeout=STREAM_READ_TIMEOUT,
                )
            except httpx.HTTPStatusError as e:
                if getattr(getattr(e, "response", None), "status_code", None) == 400:
                    # Fallback to OpenAI-compatible non-stream tool call.
                    data = await self._post_with_retry(
                        f"{self.base_url}/chat/completions",
                        body,
                        await self._auth_headers(channel="text"),
                        timeout=TIMEOUT_DEFAULT,
                    )
                else:
                    raise
        else:
            try:
                data = await self._post_stream_with_retry(
                    f"{self.base_url}/chat/completions",
                    body, await self._auth_headers(channel="text"),
                    read_timeout=STREAM_READ_TIMEOUT,
                )
            except httpx.HTTPStatusError as e:
                if getattr(getattr(e, "response", None), "status_code", None) == 400:
                    data = await self._post_with_retry(
                        f"{self.base_url}/chat/completions",
                        body,
                        await self._auth_headers(channel="text"),
                        timeout=TIMEOUT_DEFAULT,
                    )
                else:
                    raise
        return data["choices"][0]["message"]

    async def chat_json(
        self,
        system_prompt: str,
        user_prompt: str,
        *,
        temperature: float = 0.1,
    ) -> dict:
        last_err: Exception | None = None
        for attempt in range(JSON_PARSE_RETRIES):
            raw = await self.chat(
                system_prompt,
                user_prompt,
                temperature=temperature,
                response_format="json",
            )
            try:
                return self._parse_json(raw)
            except (json.JSONDecodeError, ValueError) as e:
                last_err = e
                if attempt < JSON_PARSE_RETRIES - 1:
                    logger.warning(
                        "%schat_json parse failed (attempt %d/%d): %s — retrying in %ds",
                        self.log_tag, attempt + 1, JSON_PARSE_RETRIES, e, JSON_PARSE_RETRY_DELAY,
                    )
                    await asyncio.sleep(JSON_PARSE_RETRY_DELAY)
        raise last_err  # type: ignore[misc]

    async def chat_with_image(
        self,
        system_prompt: str,
        user_text: str,
        image_b64: str,
        *,
        temperature: float = 0.1,
        response_format: str | None = None,
        read_timeout: float | None = None,
    ) -> str:
        messages = [
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": user_text},
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/png;base64,{image_b64}"},
                    },
                ],
            },
        ]

        body: dict = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
        }
        if response_format == "json":
            body["response_format"] = {"type": "json_object"}

        stream_kw: dict = {}
        if read_timeout is not None:
            stream_kw["read_timeout"] = read_timeout

        use_native = self._use_native_gemini_text()
        try:
            if use_native:
                gem_body = self._build_gemini_body(
                    messages,
                    temperature=temperature,
                    response_format=body.get("response_format"),
                )
                data = await self._post_gemini_stream(
                    gem_body,
                    model=self.model,
                    channel="text",
                    read_timeout=stream_kw.get("read_timeout", STREAM_READ_TIMEOUT),
                )
            else:
                data = await self._post_stream_with_retry(
                    f"{self.vision_base_url}/chat/completions",
                    body, await self._auth_headers(channel="vision"),
                    **stream_kw,
                )
        except httpx.HTTPStatusError as e:
            status = getattr(getattr(e, "response", None), "status_code", None)
            retried = False
            if response_format == "json" and status == 400 and not use_native:
                logger.warning(
                    "%schat_with_image got HTTP 400 with response_format=json, retrying without response_format",
                    self.log_tag,
                )
                retry_body = dict(body)
                retry_body.pop("response_format", None)
                data = await self._post_stream_with_retry(
                    f"{self.vision_base_url}/chat/completions",
                    retry_body, await self._auth_headers(channel="vision"),
                    **stream_kw,
                )
                retried = True
            if status == 400 and not use_native and not retried:
                logger.warning(
                    "%schat_with_image stream got HTTP 400, retrying non-stream /chat/completions",
                    self.log_tag,
                )
                ns_body = dict(body)
                ns_body.pop("stream", None)
                data = await self._post_with_retry(
                    f"{self.vision_base_url}/chat/completions",
                    ns_body,
                    await self._auth_headers(channel="vision"),
                    timeout=TIMEOUT_DEFAULT,
                )
            else:
                if not retried:
                    raise
        content = data["choices"][0]["message"]["content"]
        if isinstance(content, list):
            text_parts = [p.get("text", "") for p in content if p.get("type") == "text"]
            return " ".join(text_parts)
        return content or ""

    async def chat_with_image_json(
        self,
        system_prompt: str,
        user_text: str,
        image_b64: str,
        *,
        temperature: float = 0.1,
        read_timeout: float | None = None,
    ) -> dict:
        last_err: Exception | None = None
        for attempt in range(JSON_PARSE_RETRIES):
            raw = await self.chat_with_image(
                system_prompt,
                user_text,
                image_b64,
                temperature=temperature,
                response_format="json",
                read_timeout=read_timeout,
            )
            try:
                return self._parse_json(raw)
            except (json.JSONDecodeError, ValueError) as e:
                last_err = e
                if attempt < JSON_PARSE_RETRIES - 1:
                    logger.warning(
                        "%schat_with_image_json parse failed (attempt %d/%d): %s — retrying in %ds",
                        self.log_tag, attempt + 1, JSON_PARSE_RETRIES, e, JSON_PARSE_RETRY_DELAY,
                    )
                    await asyncio.sleep(JSON_PARSE_RETRY_DELAY)
        raise last_err  # type: ignore[misc]

    async def chat_with_images_json(
        self,
        system_prompt: str,
        user_text: str,
        images_b64: list[str],
        *,
        temperature: float = 0.1,
        read_timeout: float | None = None,
    ) -> dict:
        content_parts: list[dict] = [{"type": "text", "text": user_text}]
        for img_b64 in images_b64:
            content_parts.append({
                "type": "image_url",
                "image_url": {"url": f"data:image/png;base64,{img_b64}"},
            })

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": content_parts},
        ]
        body: dict = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
            "response_format": {"type": "json_object"},
        }

        stream_kw: dict = {}
        if read_timeout is not None:
            stream_kw["read_timeout"] = read_timeout

        last_err: Exception | None = None
        for attempt in range(JSON_PARSE_RETRIES):
            try:
                if self._use_native_gemini_text():
                    gem_body = self._build_gemini_body(
                        messages,
                        temperature=temperature,
                        response_format=body.get("response_format"),
                    )
                    data = await self._post_gemini_stream(
                        gem_body,
                        model=self.model,
                        channel="text",
                        read_timeout=stream_kw.get("read_timeout", STREAM_READ_TIMEOUT),
                    )
                else:
                    data = await self._post_stream_with_retry(
                        f"{self.vision_base_url}/chat/completions",
                        body, await self._auth_headers(channel="vision"),
                        **stream_kw,
                    )
            except httpx.HTTPStatusError as e:
                status = getattr(getattr(e, "response", None), "status_code", None)
                if status == 400 and "response_format" in body and not self._use_native_gemini_text():
                    logger.warning(
                        "%schat_with_images_json got HTTP 400 with response_format=json, retrying without response_format",
                        self.log_tag,
                    )
                    retry_body = dict(body)
                    retry_body.pop("response_format", None)
                    data = await self._post_stream_with_retry(
                        f"{self.vision_base_url}/chat/completions",
                        retry_body, await self._auth_headers(channel="vision"),
                        **stream_kw,
                    )
                else:
                    raise
            content = data["choices"][0]["message"]["content"]
            if isinstance(content, list):
                text_parts = [p.get("text", "") for p in content if p.get("type") == "text"]
                raw = " ".join(text_parts)
            else:
                raw = content or "{}"
            try:
                return self._parse_json(raw)
            except (json.JSONDecodeError, ValueError) as e:
                last_err = e
                if attempt < JSON_PARSE_RETRIES - 1:
                    logger.warning(
                        "%schat_with_images_json parse failed (attempt %d/%d): %s — retrying in %ds",
                        self.log_tag, attempt + 1, JSON_PARSE_RETRIES, e, JSON_PARSE_RETRY_DELAY,
                    )
                    await asyncio.sleep(JSON_PARSE_RETRY_DELAY)
        raise last_err  # type: ignore[misc]

    async def generate_image(
        self,
        system_prompt: str,
        user_prompt: str,
        *,
        temperature: float = 0.8,
        reference_image_b64: str | None = None,
        aspect_ratio: str | None = None,
        image_size: str | None = None,
        asset_logical_group: str = "components",
        asset_logical_id: str | None = None,
        asset_run_id: str | None = None,
        asset_dir_prefix: str | None = None,
        asset_task_type: str | None = None,
    ) -> str:
        if not self.image_model.strip():
            raise ValueError("llm_image_model is not configured in application settings")

        t0 = time.monotonic()
        used_model = self.image_model
        result_b64 = await self._generate_image_primary(
            system_prompt, user_prompt,
            temperature=temperature,
            reference_image_b64=reference_image_b64,
            aspect_ratio=aspect_ratio,
            image_size=image_size,
        )

        return result_b64

    async def _generate_image_primary(
        self,
        system_prompt: str,
        user_prompt: str,
        *,
        temperature: float = 0.8,
        reference_image_b64: str | None = None,
        aspect_ratio: str | None = None,
        image_size: str | None = None,
    ) -> str:
        model_lower = (self.image_model or "").lower()
        if model_lower.startswith("gpt-image"):
            try:
                return await self._generate_image_via_images_endpoint(
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                    reference_image_b64=reference_image_b64,
                )
            except httpx.HTTPStatusError as e:
                status = getattr(getattr(e, "response", None), "status_code", None)
                # Some OpenAI-compatible gateways reject /images/* for specific routes or auth
                # but still support image generation through /chat/completions.
                if status in {400, 401, 403, 404, 405, 415, 422, 500}:
                    logger.warning(
                        "%s/images/generations rejected (HTTP %s), fallback to /chat/completions",
                        self.log_tag,
                        status,
                    )
                else:
                    raise
        if self._use_native_gemini_image():
            try:
                return await self._generate_image_gemini_native(
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                    reference_image_b64=reference_image_b64,
                    temperature=temperature,
                )
            except Exception as e:
                logger.warning("%sGemini native image generation failed, fallback to OpenAI-compatible: %s", self.log_tag, e)
        if reference_image_b64:
            user_content: list[dict] | str = [
                {"type": "text", "text": user_prompt},
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:image/png;base64,{reference_image_b64}"},
                },
            ]
        else:
            user_content = user_prompt

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ]
        body: dict = {
            "model": self.image_model,
            "messages": messages,
            "temperature": temperature,
        }

        if aspect_ratio or image_size:
            ic: dict[str, str] = {}
            if aspect_ratio:
                ic["aspect_ratio"] = aspect_ratio
            if image_size:
                ic["image_size"] = image_size
            body["image_config"] = ic

        logger.info(
            "%sGenerating image with model=%s%s",
            self.log_tag, self.image_model,
            f" image_config={body['image_config']}" if "image_config" in body else "",
        )
        data = await self._post_with_retry(
            f"{self.image_base_url}/chat/completions",
            body, await self._auth_headers(channel="image"),
            timeout=TIMEOUT_IMAGE_GEN,
            max_retries=LLM_MAX_RETRIES,
        )
        image_b64 = self._extract_image_from_response(data)
        if not image_b64:
            raise ValueError(
                "No image found in response. "
                f"Content preview: {str(data.get('choices', [{}])[0].get('message', {}).get('content', ''))[:200]}"
            )
        return image_b64

    def _has_explicit_image_channel(self) -> bool:
        settings_data = load_settings()
        return bool(
            str(settings_data.get("image_base_url", "")).strip()
            or str(settings_data.get("image_api_key", "")).strip()
        )

    async def _generate_image_via_images_endpoint(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        reference_image_b64: str | None = None,
        size: str = "1024x1024",
        quality: str = "high",
    ) -> str:
        url = f"{self.image_base_url}/images/generations"
        prompt = f"{system_prompt}\n\n{user_prompt}" if system_prompt else user_prompt
        if reference_image_b64:
            prompt = (
                f"{prompt}\n\n"
                "[Reference image is provided. Preserve its style and layout intent as much as possible.]"
            )
        body = {
            "model": self.image_model,
            "prompt": prompt,
            "n": 1,
            "size": size,
            "quality": quality,
        }
        headers = await self._auth_headers(channel="image")
        response = await self.client.post(
            url,
            json=body,
            headers=headers,
            timeout=TIMEOUT_IMAGE_GEN,
        )

        if response.status_code == 401:
            auth = headers.get("Authorization", "")
            token = auth.split(" ", 1)[1] if auth.lower().startswith("bearer ") else ""
            if token:
                alt_headers = {
                    "Content-Type": "application/json",
                    "api-key": token,
                    "x-api-key": token,
                }
                logger.warning(
                    "%s/images/generations 401 with bearer auth, retrying once with api-key headers",
                    self.log_tag,
                )
                alt_resp = await self.client.post(
                    url,
                    json=body,
                    headers=alt_headers,
                    timeout=TIMEOUT_IMAGE_GEN,
                )
                if alt_resp.status_code < 400:
                    response = alt_resp

        if response.status_code >= 400:
            text = response.text[:400]
            raise httpx.HTTPStatusError(
                f"HTTP {response.status_code} from {url} model={self.image_model}: {text}",
                request=response.request,
                response=response,
            )

        data = response.json()

        data_list = data.get("data", [])
        if not data_list:
            raise ValueError("No image data found in /images/generations response")

        item = data_list[0]
        b64 = item.get("b64_json")
        if b64:
            return b64

        image_url = item.get("url", "")
        if image_url:
            img_resp = await self.client.get(image_url, timeout=httpx.Timeout(30.0))
            img_resp.raise_for_status()
            return base64.b64encode(img_resp.content).decode()

        raise ValueError("No b64_json/url found in /images/generations response")

    async def _generate_image_gemini_native(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        reference_image_b64: str | None = None,
        temperature: float = 0.8,
    ) -> str:
        parts: list[dict] = [{"text": f"{system_prompt}\n\n{user_prompt}" if system_prompt else user_prompt}]
        if reference_image_b64:
            parts.append({
                "inline_data": {
                    "mime_type": "image/png",
                    "data": reference_image_b64,
                },
            })

        body: dict = {
            "contents": [{"parts": parts}],
            "generationConfig": {
                "temperature": temperature,
                "responseModalities": ["TEXT", "IMAGE"],
            },
        }
        native_base = self._to_gemini_native_base_url(self.image_base_url)
        api_key = self._require_image_api_key()
        url = f"{native_base}/v1beta/models/{self.image_model}:generateContent?key={api_key}"
        response = await self.client.post(
            url,
            json=body,
            headers={"Content-Type": "application/json"},
            timeout=TIMEOUT_IMAGE_GEN,
        )
        response.raise_for_status()
        result = response.json()
        for cand in result.get("candidates", []):
            for part in cand.get("content", {}).get("parts", []):
                inline = part.get("inline_data") or part.get("inlineData") or {}
                b64 = inline.get("data", "")
                if b64:
                    return b64
        raise ValueError("No image data in Gemini native response")

    def _extract_image_from_response(self, data: dict) -> str | None:
        content = data["choices"][0]["message"]["content"]

        if isinstance(content, list):
            for part in content:
                if not isinstance(part, dict):
                    continue
                if part.get("type") == "image_url":
                    url = part.get("image_url", {}).get("url", "")
                    if "base64," in url:
                        return url.split("base64,", 1)[1]
                    return url
                if part.get("type") == "image":
                    return part.get("data") or part.get("source", {}).get("data")
                if part.get("type") in ("image", "image_url") and "image_url" in part:
                    url = part["image_url"].get("url", "")
                    if "base64," in url:
                        return url.split("base64,", 1)[1]

        if isinstance(content, str):
            match = re.search(r"data:image/[^;]+;base64,([A-Za-z0-9+/\n=]+)", content)
            if match:
                return match.group(1).replace("\n", "")

        return None

    def _parse_json(self, raw: str) -> dict:
        if not raw or not raw.strip():
            raise ValueError(f"{self.log_tag}LLM returned empty response, cannot parse JSON")

        def _unwrap(obj):
            if isinstance(obj, list) and len(obj) == 1 and isinstance(obj[0], dict):
                logger.debug("%sUnwrapping single-element array from LLM JSON", self.log_tag)
                return obj[0]
            return obj

        try:
            return _unwrap(json.loads(raw))
        except json.JSONDecodeError:
            pass

        cleaned = raw.strip()
        if cleaned.startswith("```"):
            cleaned = re.sub(r"^```(?:json)?\s*\n?", "", cleaned)
            cleaned = re.sub(r"\n?```\s*$", "", cleaned)
        try:
            return _unwrap(json.loads(cleaned))
        except json.JSONDecodeError:
            pass

        fixed = re.sub(r",\s*([}\]])", r"\1", cleaned)
        try:
            return _unwrap(json.loads(fixed))
        except json.JSONDecodeError:
            pass

        for suffix in ["]}",  "}]}", "}", "]}", "]"]:
            try:
                return _unwrap(json.loads(fixed + suffix))
            except json.JSONDecodeError:
                continue

        raise json.JSONDecodeError(
            f"{self.log_tag}Failed to parse JSON after all repair attempts",
            raw, 0,
        )

    async def close(self) -> None:
        if self._client and not self._client.is_closed:
            await self._client.aclose()

    async def list_models(self) -> list[str]:
        headers = await self._auth_headers(channel="text")
        response = await self.client.get(
            f"{self.base_url}/models",
            headers=headers,
        )
        response.raise_for_status()
        data = response.json()
        items = data.get("data", [])
        model_ids: list[str] = []
        for item in items:
            model_id = item.get("id")
            if isinstance(model_id, str) and model_id:
                model_ids.append(model_id)
        return model_ids
