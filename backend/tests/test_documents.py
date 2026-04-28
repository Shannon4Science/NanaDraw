from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1.endpoints import documents


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(documents.router)
    return TestClient(app)


def test_parse_pdf_rejects_non_pdf():
    res = _client().post(
        "/documents/parse-pdf",
        files={"file": ("notes.txt", b"hello", "text/plain")},
    )

    assert res.status_code == 400
    assert "PDF" in res.json()["detail"]


def test_parse_pdf_rejects_empty_pdf():
    res = _client().post(
        "/documents/parse-pdf",
        files={"file": ("paper.pdf", b"", "application/pdf")},
    )

    assert res.status_code == 400
    assert "空" in res.json()["detail"]


def test_parse_pdf_rejects_oversized_pdf(monkeypatch):
    monkeypatch.setattr(documents, "MAX_PDF_SIZE_BYTES", 4)

    res = _client().post(
        "/documents/parse-pdf",
        files={"file": ("paper.pdf", b"12345", "application/pdf")},
    )

    assert res.status_code == 413
    assert "200MB" in res.json()["detail"]


def test_parse_pdf_requires_mineru_token(monkeypatch):
    monkeypatch.setattr(documents, "load_settings", lambda: {"mineru_api_token": ""})

    res = _client().post(
        "/documents/parse-pdf",
        files={"file": ("paper.pdf", b"%PDF", "application/pdf")},
    )

    assert res.status_code == 400
    assert "MinerU Token" in res.json()["detail"]


def test_parse_pdf_returns_mineru_markdown(monkeypatch):
    monkeypatch.setattr(documents, "load_settings", lambda: {"mineru_api_token": "secret-token"})

    async def fake_parse_pdf_with_mineru(*, file_name: str, file_bytes: bytes, token: str):
        assert file_name == "paper.pdf"
        assert file_bytes == b"%PDF"
        assert token == "secret-token"
        return {
            "file_name": file_name,
            "markdown": "# Parsed",
            "batch_id": "batch-1",
            "data_id": "data-1",
            "source": "mineru",
        }

    monkeypatch.setattr(documents, "parse_pdf_with_mineru", fake_parse_pdf_with_mineru)

    res = _client().post(
        "/documents/parse-pdf",
        files={"file": ("paper.pdf", b"%PDF", "application/pdf")},
    )

    assert res.status_code == 200
    assert res.json()["markdown"] == "# Parsed"
    assert res.json()["source"] == "mineru"
