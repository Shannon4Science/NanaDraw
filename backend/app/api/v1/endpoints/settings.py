import asyncio
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field, field_validator

from app.services.settings_service import (
    load_settings,
    mask_api_key,
    update_settings as apply_settings_updates,
)

router = APIRouter(prefix="/settings", tags=["settings"])


class SettingsResponse(BaseModel):
    llm_api_key: str = ""
    llm_base_url: str = ""
    llm_model: str = ""
    llm_image_model: str = ""
    llm_component_model: str = ""
    mineru_api_token: str = ""
    nana_soul: str = ""
    language: str = "zh"
    is_configured: bool = False
    mineru_is_configured: bool = False


class SettingsUpdate(BaseModel):
    llm_api_key: str | None = None
    llm_base_url: str | None = None
    llm_model: str | None = None
    llm_image_model: str | None = None
    llm_component_model: str | None = None
    mineru_api_token: str | None = None
    nana_soul: str | None = Field(default=None, max_length=500)
    language: str | None = None

    @field_validator("nana_soul", mode="before")
    @classmethod
    def strip_nana_soul(cls, v: Any) -> str | None:
        if v is None:
            return None
        if isinstance(v, str):
            return v.strip()
        return v


def _to_response(data: dict[str, Any]) -> SettingsResponse:
    return SettingsResponse(
        llm_api_key=mask_api_key(str(data.get("llm_api_key", ""))),
        llm_base_url=str(data.get("llm_base_url", "") or ""),
        llm_model=str(data.get("llm_model", "") or ""),
        llm_image_model=str(data.get("llm_image_model", "") or ""),
        llm_component_model=str(data.get("llm_component_model", "") or ""),
        mineru_api_token=mask_api_key(str(data.get("mineru_api_token", ""))),
        nana_soul=str(data.get("nana_soul", "") or ""),
        language=str(data.get("language", "") or "zh"),
        is_configured=bool(str(data.get("llm_api_key", "")).strip()),
        mineru_is_configured=bool(str(data.get("mineru_api_token", "")).strip()),
    )


@router.get("", response_model=SettingsResponse)
async def get_settings():
    """Return current settings. API key is masked (show last 4 chars only)."""
    data = await asyncio.to_thread(load_settings)
    return _to_response(data)


@router.put("", response_model=SettingsResponse)
async def update_settings(body: SettingsUpdate):
    """Update settings. Only non-None fields are updated."""
    updates = body.model_dump(exclude_none=True)
    mineru_token = updates.get("mineru_api_token")
    if isinstance(mineru_token, str):
        mineru_token = mineru_token.strip()
        if mineru_token:
            updates["mineru_api_token"] = mineru_token
        else:
            updates.pop("mineru_api_token")
    data = await asyncio.to_thread(apply_settings_updates, updates)
    return _to_response(data)
