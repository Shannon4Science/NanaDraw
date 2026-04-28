import asyncio
import io
import time
import uuid
import zipfile
from pathlib import Path
from typing import Any

import httpx


MINERU_API_BASE = "https://mineru.net/api/v4"
POLL_INTERVAL_SECONDS = 5
POLL_TIMEOUT_SECONDS = 600
ACTIVE_STATES = {"waiting-file", "uploading", "pending", "running", "converting"}


class MinerUError(RuntimeError):
    pass


def _auth_headers(token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "*/*",
    }


def _json_headers(token: str) -> dict[str, str]:
    return {
        **_auth_headers(token),
        "Content-Type": "application/json",
    }


def _ensure_success_payload(payload: dict[str, Any], action: str) -> dict[str, Any]:
    if payload.get("code") != 0:
        msg = str(payload.get("msg") or f"MinerU {action} failed")
        raise MinerUError(msg)
    data = payload.get("data")
    if not isinstance(data, dict):
        raise MinerUError(f"MinerU {action} returned invalid data")
    return data


def _first_matching_result(results: list[Any], data_id: str, file_name: str) -> dict[str, Any] | None:
    for item in results:
        if isinstance(item, dict) and item.get("data_id") == data_id:
            return item
    for item in results:
        if isinstance(item, dict) and item.get("file_name") == file_name:
            return item
    for item in results:
        if isinstance(item, dict):
            return item
    return None


def _extract_result(data: dict[str, Any], data_id: str, file_name: str) -> dict[str, Any]:
    result = data.get("extract_result")
    if isinstance(result, dict):
        return result
    if isinstance(result, list):
        matched = _first_matching_result(result, data_id, file_name)
        if matched:
            return matched

    results = data.get("extract_results")
    if isinstance(results, list):
        matched = _first_matching_result(results, data_id, file_name)
        if matched:
            return matched

    raise MinerUError("MinerU result payload is missing extract_result")


async def _download_full_markdown(client: httpx.AsyncClient, full_zip_url: str) -> str:
    response = await client.get(full_zip_url)
    response.raise_for_status()

    try:
        with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
            names = archive.namelist()
            full_md_name = next(
                (name for name in names if Path(name).name == "full.md"),
                None,
            )
            if not full_md_name:
                raise MinerUError("MinerU result zip does not contain full.md")
            with archive.open(full_md_name) as f:
                return f.read().decode("utf-8", errors="replace")
    except zipfile.BadZipFile as exc:
        raise MinerUError("MinerU result is not a valid zip file") from exc


async def parse_pdf_with_mineru(
    *,
    file_name: str,
    file_bytes: bytes,
    token: str,
    client_factory: Any | None = None,
) -> dict[str, str]:
    data_id = f"nanadraw-{uuid.uuid4().hex}"
    timeout = httpx.Timeout(connect=15.0, read=120.0, write=120.0, pool=15.0)
    make_client = client_factory or httpx.AsyncClient

    async with make_client(timeout=timeout) as client:
        apply_body = {
            "files": [
                {
                    "name": file_name,
                    "data_id": data_id,
                    "is_ocr": False,
                }
            ],
            "model_version": "vlm",
            "language": "ch",
            "enable_table": True,
            "enable_formula": True,
        }

        apply_response = await client.post(
            f"{MINERU_API_BASE}/file-urls/batch",
            headers=_json_headers(token),
            json=apply_body,
        )
        apply_response.raise_for_status()
        apply_data = _ensure_success_payload(apply_response.json(), "upload URL request")

        batch_id = str(apply_data.get("batch_id") or "")
        file_urls = apply_data.get("file_urls")
        if not batch_id or not isinstance(file_urls, list) or not file_urls:
            raise MinerUError("MinerU upload URL response is missing batch_id or file_urls")

        upload_response = await client.put(str(file_urls[0]), content=file_bytes)
        upload_response.raise_for_status()

        deadline = time.monotonic() + POLL_TIMEOUT_SECONDS
        result: dict[str, Any] | None = None
        while time.monotonic() < deadline:
            await asyncio.sleep(POLL_INTERVAL_SECONDS)
            poll_response = await client.get(
                f"{MINERU_API_BASE}/extract-results/batch/{batch_id}",
                headers=_json_headers(token),
            )
            poll_response.raise_for_status()
            poll_data = _ensure_success_payload(poll_response.json(), "result polling")
            result = _extract_result(poll_data, data_id, file_name)

            state = str(result.get("state") or "").lower()
            if state == "done":
                break
            if state == "failed":
                raise MinerUError(str(result.get("err_msg") or "MinerU parsing failed"))
            if state and state not in ACTIVE_STATES:
                raise MinerUError(f"Unexpected MinerU parsing state: {state}")
        else:
            raise MinerUError("MinerU parsing timed out")

        if not result:
            raise MinerUError("MinerU did not return a parsing result")

        full_zip_url = str(result.get("full_zip_url") or "")
        if not full_zip_url:
            raise MinerUError("MinerU result is missing full_zip_url")

        markdown = await _download_full_markdown(client, full_zip_url)
        if not markdown.strip():
            raise MinerUError("MinerU returned empty Markdown")

        return {
            "file_name": file_name,
            "markdown": markdown,
            "batch_id": batch_id,
            "data_id": str(result.get("data_id") or data_id),
            "source": "mineru",
        }
