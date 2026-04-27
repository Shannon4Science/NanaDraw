import io
import zipfile

import pytest

from app.services import mineru_service
from app.services.mineru_service import MinerUError, parse_pdf_with_mineru


class FakeResponse:
    def __init__(self, json_data=None, content: bytes = b""):
        self._json_data = json_data
        self.content = content

    def json(self):
        return self._json_data

    def raise_for_status(self):
        return None


def _zip_with(entries: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as archive:
        for name, text in entries.items():
            archive.writestr(name, text)
    return buf.getvalue()


class FakeMinerUClient:
    def __init__(self, *, apply_payload=None, poll_payload=None, zip_bytes=None, **_kwargs):
        self.apply_payload = apply_payload or {
            "code": 0,
            "data": {"batch_id": "batch-1", "file_urls": ["https://upload.example"]},
        }
        self.poll_payload = poll_payload or {
            "code": 0,
            "data": {
                "extract_result": {
                    "data_id": "data-1",
                    "file_name": "paper.pdf",
                    "state": "done",
                    "full_zip_url": "https://download.example/result.zip",
                }
            },
        }
        self.zip_bytes = zip_bytes or _zip_with({"nested/full.md": "# Parsed"})
        self.uploaded = b""

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def post(self, *_args, **_kwargs):
        return FakeResponse(self.apply_payload)

    async def put(self, _url, content: bytes):
        self.uploaded = content
        return FakeResponse({})

    async def get(self, url, **_kwargs):
        if str(url).endswith(".zip"):
            return FakeResponse(content=self.zip_bytes)
        return FakeResponse(self.poll_payload)


@pytest.mark.asyncio
async def test_parse_pdf_with_mineru_success(monkeypatch):
    monkeypatch.setattr(mineru_service, "POLL_INTERVAL_SECONDS", 0)

    result = await parse_pdf_with_mineru(
        file_name="paper.pdf",
        file_bytes=b"%PDF",
        token="secret",
        client_factory=FakeMinerUClient,
    )

    assert result["file_name"] == "paper.pdf"
    assert result["markdown"] == "# Parsed"
    assert result["batch_id"] == "batch-1"
    assert result["source"] == "mineru"


@pytest.mark.asyncio
async def test_parse_pdf_with_mineru_rejects_error_payload(monkeypatch):
    monkeypatch.setattr(mineru_service, "POLL_INTERVAL_SECONDS", 0)

    def factory(**kwargs):
        return FakeMinerUClient(apply_payload={"code": 7, "msg": "bad token"}, **kwargs)

    with pytest.raises(MinerUError, match="bad token"):
        await parse_pdf_with_mineru(
            file_name="paper.pdf",
            file_bytes=b"%PDF",
            token="secret",
            client_factory=factory,
        )


@pytest.mark.asyncio
async def test_parse_pdf_with_mineru_reports_failed_state(monkeypatch):
    monkeypatch.setattr(mineru_service, "POLL_INTERVAL_SECONDS", 0)

    def factory(**kwargs):
        return FakeMinerUClient(
            poll_payload={
                "code": 0,
                "data": {"extract_result": {"state": "failed", "err_msg": "parse failed"}},
            },
            **kwargs,
        )

    with pytest.raises(MinerUError, match="parse failed"):
        await parse_pdf_with_mineru(
            file_name="paper.pdf",
            file_bytes=b"%PDF",
            token="secret",
            client_factory=factory,
        )


@pytest.mark.asyncio
async def test_parse_pdf_with_mineru_requires_full_markdown(monkeypatch):
    monkeypatch.setattr(mineru_service, "POLL_INTERVAL_SECONDS", 0)

    def factory(**kwargs):
        return FakeMinerUClient(zip_bytes=_zip_with({"other.md": "No full file"}), **kwargs)

    with pytest.raises(MinerUError, match="full.md"):
        await parse_pdf_with_mineru(
            file_name="paper.pdf",
            file_bytes=b"%PDF",
            token="secret",
            client_factory=factory,
        )


@pytest.mark.asyncio
async def test_parse_pdf_with_mineru_times_out(monkeypatch):
    monkeypatch.setattr(mineru_service, "POLL_TIMEOUT_SECONDS", 0)

    with pytest.raises(MinerUError, match="timed out"):
        await parse_pdf_with_mineru(
            file_name="paper.pdf",
            file_bytes=b"%PDF",
            token="secret",
            client_factory=FakeMinerUClient,
        )
