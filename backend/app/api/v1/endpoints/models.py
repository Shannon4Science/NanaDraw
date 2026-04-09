from fastapi import APIRouter

from app.services.settings_service import load_settings

router = APIRouter(prefix="/models", tags=["models"])


@router.get("")
async def get_models():
    s = load_settings()
    return {
        "text_models": [{"id": s["llm_model"], "name": s["llm_model"]}],
        "image_models": [{"id": s["llm_image_model"], "name": s["llm_image_model"]}],
        "default_text_model": s["llm_model"],
        "default_image_model": s["llm_image_model"],
    }


@router.get("/image")
async def list_image_models():
    s = load_settings()
    mid = str(s.get("llm_image_model") or "")
    return {
        "items": [{"id": mid, "description": mid, "detail": ""}] if mid else [],
        "component_default": mid,
    }


@router.get("/text")
async def list_text_models():
    s = load_settings()
    mid = str(s.get("llm_model") or "")
    return {
        "items": [{"id": mid, "description": mid}] if mid else [],
        "current": mid,
    }
