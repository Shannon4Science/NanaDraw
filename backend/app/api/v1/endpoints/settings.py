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
    image_api_key: str = ""
    vision_api_key: str = ""
    llm_base_url: str = ""
    image_base_url: str = ""
    vision_base_url: str = ""
    llm_model: str = ""
    llm_image_model: str = ""
    llm_component_model: str = ""
    api_format: str = "auto"
    mineru_api_token: str = ""
    nana_soul: str = ""
    language: str = "zh"
    is_configured: bool = False
    mineru_is_configured: bool = False


class SettingsUpdate(BaseModel):
    llm_api_key: str | None = None
    image_api_key: str | None = None
    vision_api_key: str | None = None
    llm_base_url: str | None = None
    image_base_url: str | None = None
    vision_base_url: str | None = None
    llm_model: str | None = None
    llm_image_model: str | None = None
    llm_component_model: str | None = None
    api_format: str | None = None
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

    @field_validator("api_format")
    @classmethod
    def validate_api_format(cls, v: str | None) -> str | None:
        if v is None:
            return None
        vv = v.strip()
        if vv not in {"auto", "gemini_native", "openai"}:
            raise ValueError("api_format must be one of: auto, gemini_native, openai")
        return vv


class PoolResponse(BaseModel):
    base_url: str
    api_keys: str


class LLMConfigResponse(BaseModel):
    pools: list[PoolResponse] = []
    image_pools: list[PoolResponse] = []
    has_custom_config: bool = False
    text_model: str | None = None
    image_model: str | None = None
    api_format: str = "auto"


class PoolInput(BaseModel):
    base_url: str
    api_keys: str


class LLMConfigUpdateRequest(BaseModel):
    pools: list[PoolInput]
    image_pools: list[PoolInput] = []
    text_model: str
    image_model: str
    api_format: str = "auto"


def _to_response(data: dict[str, Any]) -> SettingsResponse:
    return SettingsResponse(
        llm_api_key=mask_api_key(str(data.get("llm_api_key", ""))),
        image_api_key=mask_api_key(str(data.get("image_api_key", ""))),
        vision_api_key=mask_api_key(str(data.get("vision_api_key", ""))),
        llm_base_url=str(data.get("llm_base_url", "") or ""),
        image_base_url=str(data.get("image_base_url", "") or ""),
        vision_base_url=str(data.get("vision_base_url", "") or ""),
        llm_model=str(data.get("llm_model", "") or ""),
        llm_image_model=str(data.get("llm_image_model", "") or ""),
        llm_component_model=str(data.get("llm_component_model", "") or ""),
        api_format=str(data.get("api_format", "") or "auto"),
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


@router.get("/llm-config", response_model=LLMConfigResponse)
async def get_llm_config():
    cfg = await asyncio.to_thread(load_settings)
    llm_base = str(cfg.get("llm_base_url", "") or "").strip()
    llm_key = str(cfg.get("llm_api_key", "") or "").strip()
    image_base = str(cfg.get("image_base_url", "") or "").strip()
    image_key = str(cfg.get("image_api_key", "") or "").strip()
    pools = [PoolResponse(base_url=llm_base, api_keys=llm_key)] if (llm_base or llm_key) else []
    image_pools = [PoolResponse(base_url=image_base, api_keys=image_key)] if (image_base or image_key) else []
    return LLMConfigResponse(
        pools=pools,
        image_pools=image_pools,
        has_custom_config=bool(llm_base and llm_key),
        text_model=str(cfg.get("llm_model", "") or ""),
        image_model=str(cfg.get("llm_image_model", "") or ""),
        api_format=str(cfg.get("api_format", "") or "auto"),
    )


@router.put("/llm-config")
async def update_llm_config(body: LLMConfigUpdateRequest):
    from fastapi import HTTPException

    pools = [{"base_url": p.base_url.strip(), "api_keys": p.api_keys.strip()} for p in body.pools if p.api_keys.strip()]
    image_pools = [{"base_url": p.base_url.strip(), "api_keys": p.api_keys.strip()} for p in body.image_pools if p.api_keys.strip()]

    missing: list[str] = []
    if not pools or not pools[0].get("base_url"):
        missing.append("Base URL")
    if not pools or not pools[0].get("api_keys"):
        missing.append("API Key")
    if not body.text_model or not body.text_model.strip():
        missing.append("文本模型 (Text Model)")
    if not body.image_model or not body.image_model.strip():
        missing.append("生图模型 (Image Model)")
    for idx, p in enumerate(body.image_pools, start=1):
        has_url = bool((p.base_url or "").strip())
        has_key = bool((p.api_keys or "").strip())
        if has_url != has_key:
            missing.append(f"生图专用通道 #{idx} 需同时填写 Base URL 与 API Key")
    if missing:
        raise HTTPException(status_code=400, detail=f"以下字段不能为空：{', '.join(missing)}")

    first = pools[0]
    first_img = image_pools[0] if image_pools else {"base_url": "", "api_keys": ""}
    updates = {
        "llm_base_url": first["base_url"],
        "llm_api_key": first["api_keys"],
        "image_base_url": first_img["base_url"],
        "image_api_key": first_img["api_keys"],
        "llm_model": body.text_model.strip(),
        "llm_image_model": body.image_model.strip(),
        # Open-source local keeps component model; default to image model for parity with GitLab personal config.
        "llm_component_model": body.image_model.strip(),
        "api_format": body.api_format if body.api_format in ("auto", "gemini_native", "openai") else "auto",
    }
    await asyncio.to_thread(apply_settings_updates, updates)
    return {"ok": True}


@router.delete("/llm-config")
async def clear_llm_config():
    await asyncio.to_thread(
        apply_settings_updates,
        {
            "llm_base_url": "",
            "llm_api_key": "",
            "image_base_url": "",
            "image_api_key": "",
            "vision_base_url": "",
            "vision_api_key": "",
            "llm_model": "",
            "llm_image_model": "",
            "llm_component_model": "",
            "api_format": "auto",
        },
    )
    return {"ok": True}
