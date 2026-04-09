"""User element CRUD + inline AI asset generation."""

import base64
import binascii
import hashlib
import json
import logging
from io import BytesIO
from typing import Any, AsyncIterator, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import Response, StreamingResponse

from app.core.config import settings
from app.dependencies import LocalUser, get_current_user
from app.prompts.asset_gen import (
    ASSET_GEN_SYSTEM,
    ASSET_GEN_USER,
    ASSET_RESTYLE_SYSTEM,
    ASSET_RESTYLE_USER,
    STYLE_DESCRIPTIONS,
)
from app.schemas.paper import AssetGenRequest, AssetRestyleResponse, AssetStyle
from app.services import local_storage
from app.services.llm_service import LLMService

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/elements", tags=["elements"])

MAX_FILE_SIZE = 2 * 1024 * 1024
ALLOWED_TYPES = {"svg", "png"}
MIME_MAP = {"svg": "image/svg+xml", "png": "image/png"}


def _sse(event: str, data: dict[str, Any]) -> str:
    payload = json.dumps(data, ensure_ascii=False)
    return f"event: {event}\ndata: {payload}\n\n"


def _detect_type(filename: str, content_type: str | None) -> str:
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext in ALLOWED_TYPES:
        return ext
    if content_type and "svg" in content_type:
        return "svg"
    if content_type and "png" in content_type:
        return "png"
    raise HTTPException(status_code=400, detail="不支持的文件类型，仅支持 SVG 和 PNG")


def _parse_svg_dimensions(data: bytes) -> tuple[int, int]:
    try:
        from lxml import etree
        root = etree.fromstring(data)
        vb = root.get("viewBox")
        if vb:
            parts = vb.replace(",", " ").split()
            if len(parts) >= 4:
                return int(float(parts[2])), int(float(parts[3]))
        w = root.get("width")
        h = root.get("height")
        if w and h:
            return int(float(w.replace("px", ""))), int(float(h.replace("px", "")))
    except Exception:
        pass
    return 80, 80


def _parse_png_dimensions(data: bytes) -> tuple[int, int]:
    try:
        from PIL import Image
        img = Image.open(BytesIO(data))
        return img.width, img.height
    except Exception:
        return 80, 80


def _mime_for_type(file_type: str) -> str:
    return MIME_MAP.get(file_type, "application/octet-stream")


def _asset_meta_to_list_item(meta: dict[str, Any]) -> dict[str, Any]:
    ct = str(meta.get("content_type", ""))
    if "svg" in ct.lower():
        ft = "svg"
    else:
        ft = "png"
    return {
        "id": meta["id"],
        "user_id": "local",
        "display_name": meta.get("display_name", ""),
        "file_hash": "",
        "s3_key": "",
        "file_type": ft,
        "file_size": None,
        "width": None,
        "height": None,
        "category": meta.get("category") or None,
        "created_at": meta.get("created_at", ""),
    }


def _wrap_created_element(
    meta: dict[str, Any],
    content: bytes,
    file_type: str,
) -> dict[str, Any]:
    w, h = (_parse_svg_dimensions(content) if file_type == "svg" else _parse_png_dimensions(content))
    fh = hashlib.sha256(content).hexdigest()
    return {
        "id": meta["id"],
        "user_id": "local",
        "display_name": meta.get("display_name", ""),
        "file_hash": fh,
        "s3_key": "",
        "file_type": file_type,
        "file_size": len(content),
        "width": w,
        "height": h,
        "category": meta.get("category") or None,
        "created_at": meta.get("created_at", ""),
    }


def _resolve_style(body: AssetGenRequest) -> tuple[str, str]:
    style_value = body.style.value
    if style_value == "none":
        return ("default", "clean icon style suitable for academic diagrams")
    if style_value == "custom" and body.style_text:
        return ("custom", body.style_text)
    desc = STYLE_DESCRIPTIONS.get(style_value, "clean icon style")
    return (style_value.replace("_", " "), desc)


NUM_VARIANTS = 3


@router.post("/generate")
async def generate_assets(
    body: AssetGenRequest,
    _user: LocalUser = Depends(get_current_user),
):
    import asyncio

    for desc in body.descriptions:
        if len(desc) > 200:
            raise HTTPException(status_code=400, detail="单个描述不超过 200 字")

    descs = [d.strip() for d in body.descriptions if d.strip()]
    if not descs:
        raise HTTPException(status_code=400, detail="描述不能为空")

    style_name, style_description = _resolve_style(body)
    image_model = (
        body.image_model
        or (settings.LLM_COMPONENT_MODEL or "")
        or settings.LLM_IMAGE_MODEL_FLASH
        or settings.LLM_IMAGE_MODEL
    )

    async def event_stream() -> AsyncIterator[str]:
        from app.services.pipeline.image_processor import ImageProcessor

        tasks: list[tuple[str, float]] = []
        for desc in descs:
            for v in range(NUM_VARIANTS):
                tasks.append((desc, 0.7 + v * 0.1))

        total = len(tasks)
        yield _sse("asset_start", {"total": total})

        async def _gen_one(desc: str, temp: float) -> tuple[str, str | None, str | None]:
            llm = LLMService()
            llm.image_model = image_model
            try:
                user_prompt = ASSET_GEN_USER.format(
                    description=desc,
                    style_name=style_name,
                    style_description=style_description,
                )
                img = await llm.generate_image(
                    ASSET_GEN_SYSTEM, user_prompt, temperature=temp,
                )
                try:
                    img = await ImageProcessor.ensure_transparent(img, prefer_edge_flood=True)
                except Exception:
                    pass
                return (desc, img, None)
            except Exception as e:
                logger.warning("Asset gen failed for %r: %s", desc, e)
                return (desc, None, str(e))
            finally:
                await llm.close()

        results = await asyncio.gather(*[_gen_one(d, t) for d, t in tasks])

        success_count = 0
        fail_count = 0
        for i, (desc, img, err) in enumerate(results):
            if img:
                success_count += 1
                yield _sse("asset_progress", {
                    "index": i + 1, "total": total,
                    "description": desc, "image_b64": img,
                    "status": "success",
                })
            else:
                fail_count += 1
                yield _sse("asset_progress", {
                    "index": i + 1, "total": total,
                    "description": desc, "status": "failed",
                    "error": err or "unknown",
                })

        yield _sse("asset_complete", {
            "total": total, "success": success_count, "failed": fail_count,
        })
        yield _sse("close", {})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/generate-from-image", response_model=AssetRestyleResponse)
async def generate_from_image(
    file: UploadFile = File(...),
    style: AssetStyle = Form(AssetStyle.NONE),
    style_text: str | None = Form(None),
    image_model: str | None = Form(None),
    _user: LocalUser = Depends(get_current_user),
):
    data = await file.read()
    if len(data) > MAX_FILE_SIZE:
        raise HTTPException(status_code=400, detail="文件大小超过 2MB 限制")

    ref_b64 = base64.b64encode(data).decode("ascii")
    if style == AssetStyle.NONE:
        style_desc = ""
        style_name = ""
    elif style == AssetStyle.CUSTOM and style_text:
        style_desc = style_text
        style_name = "custom"
    else:
        style_desc = STYLE_DESCRIPTIONS.get(style.value, "clean icon style")
        style_name = style.value.replace("_", " ")
    user_prompt = ASSET_RESTYLE_USER.format(
        style_name=style_name or "faithful reproduction",
        style_description=style_desc or "Reproduce the subject faithfully in a clean icon style",
    )

    llm = LLMService()
    if image_model:
        llm.image_model = image_model
    llm.asset_user_id = _user.id
    try:
        image_b64 = await llm.generate_image(
            ASSET_RESTYLE_SYSTEM, user_prompt,
            temperature=0.8,
            reference_image_b64=ref_b64,
        )
        return AssetRestyleResponse(image_b64=image_b64)
    except Exception as e:
        logger.exception("Asset restyle failed")
        raise HTTPException(status_code=500, detail=f"风格化生成失败: {e}") from e
    finally:
        await llm.close()


@router.post("")
async def upload_element(
    file: UploadFile = File(...),
    display_name: Optional[str] = Form(None),
    category: Optional[str] = Form(None),
    _user: LocalUser = Depends(get_current_user),
):
    if not file.filename:
        raise HTTPException(status_code=400, detail="文件名为空")

    file_type = _detect_type(file.filename, file.content_type)
    data = await file.read()

    if len(data) > MAX_FILE_SIZE:
        raise HTTPException(status_code=400, detail="文件大小超过 2MB 限制")

    if file_type == "svg":
        from app.utils.svg_sanitizer import sanitize_svg
        try:
            data = sanitize_svg(data)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=f"SVG 格式无效: {e}") from e

    name = display_name or file.filename.rsplit(".", 1)[0]
    cat = category or ""
    ct = _mime_for_type(file_type)
    meta = await local_storage.create_asset(
        display_name=name,
        category=cat,
        content=data,
        content_type=ct,
    )
    return _wrap_created_element(meta, data, file_type)


@router.get("")
async def list_elements(
    category: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    size: int = Query(50, ge=1, le=200),
    _user: LocalUser = Depends(get_current_user),
):
    all_meta = await local_storage.list_assets()
    if category:
        filtered = [m for m in all_meta if (m.get("category") or "") == category]
    else:
        filtered = all_meta
    total = len(filtered)
    start = (page - 1) * size
    page_rows = filtered[start : start + size]
    items = [_asset_meta_to_list_item(m) for m in page_rows]
    return {"items": items, "total": total, "page": page, "size": size}


@router.delete("/{element_id}")
async def delete_element(element_id: str, _user: LocalUser = Depends(get_current_user)):
    element = await local_storage.get_asset(element_id)
    if not element:
        raise HTTPException(status_code=404, detail="素材不存在")

    ok = await local_storage.delete_asset(element_id)
    if not ok:
        raise HTTPException(status_code=404, detail="素材不存在")
    return {"success": True}


@router.get("/{element_id}/content")
async def get_element_content(element_id: str, _user: LocalUser = Depends(get_current_user)):
    element = await local_storage.get_asset(element_id)
    if not element:
        raise HTTPException(status_code=404, detail="素材不存在")

    loaded = await local_storage.load_asset_content(element_id)
    if loaded is None:
        raise HTTPException(status_code=404, detail="素材内容不存在")

    data, stored_ct = loaded
    ct = str(element.get("content_type") or stored_ct)
    file_type = "svg" if "svg" in ct.lower() else "png"
    return Response(content=data, media_type=MIME_MAP.get(file_type, stored_ct))
