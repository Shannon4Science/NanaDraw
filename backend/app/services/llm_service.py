import asyncio
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
                response.raise_for_status()
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
                        await response.aread()
                        response.raise_for_status()

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

    async def _auth_headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._require_api_key()}",
            "Content-Type": "application/json",
        }

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

        data = await self._post_stream_with_retry(
            f"{self.base_url}/chat/completions",
            body, await self._auth_headers(),
            **stream_kw,
        )
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
        data = await self._post_with_retry(
            f"{self.base_url}/chat/completions",
            body, await self._auth_headers(),
            timeout=TIMEOUT_DEFAULT,
        )
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

        data = await self._post_stream_with_retry(
            f"{self.base_url}/chat/completions",
            body, await self._auth_headers(),
            **stream_kw,
        )
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
            data = await self._post_stream_with_retry(
                f"{self.base_url}/chat/completions",
                body, await self._auth_headers(),
                **stream_kw,
            )
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
            f"{self.base_url}/chat/completions",
            body, await self._auth_headers(),
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
        headers = await self._auth_headers()
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
