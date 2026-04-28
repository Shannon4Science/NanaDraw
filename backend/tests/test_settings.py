from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1.endpoints import settings


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(settings.router)
    return TestClient(app)


def test_settings_masks_mineru_token(monkeypatch):
    monkeypatch.setattr(
        settings,
        "load_settings",
        lambda: {
            "llm_api_key": "llm-secret",
            "llm_base_url": "",
            "llm_model": "text-model",
            "llm_image_model": "image-model",
            "llm_component_model": "component-model",
            "mineru_api_token": "mineru-secret",
            "nana_soul": "",
            "language": "zh",
        },
    )

    res = _client().get("/settings")

    assert res.status_code == 200
    assert res.json()["mineru_api_token"] == "****cret"
    assert res.json()["mineru_is_configured"] is True


def test_settings_ignores_blank_mineru_token_update(monkeypatch):
    captured = {}

    def fake_update_settings(updates):
        captured.update(updates)
        return {
            "llm_api_key": "",
            "llm_base_url": "",
            "llm_model": "",
            "llm_image_model": "",
            "llm_component_model": "",
            "mineru_api_token": "existing-token",
            "nana_soul": "",
            "language": "zh",
        }

    monkeypatch.setattr(settings, "apply_settings_updates", fake_update_settings)

    res = _client().put("/settings", json={"mineru_api_token": "   "})

    assert res.status_code == 200
    assert "mineru_api_token" not in captured
    assert res.json()["mineru_is_configured"] is True
