"""AI Assistant chat endpoint — SSE streaming."""

import asyncio
import logging

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from app.core.config import settings
from app.dependencies import require_auth
from app.services.assistant_service import AssistantService

SSE_KEEPALIVE_INTERVAL = 15

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/assistant", tags=["assistant"])


class RegenContextModel(BaseModel):
    task_id: str = ""
    component_id: str
    component_label: str
    visual_repr: str | None = None
    component_image_svg: str | None = None
    component_image_b64: str | None = None
    batch_components: list[dict] | None = None


class AssistantChatRequest(BaseModel):
    message: str = Field(..., min_length=1)
    history: list[dict] = Field(default_factory=list)
    selected_mode: str | None = Field(
        None,
        description="Locked mode: fast, full_gen, image_only, or None for auto",
    )
    style_ref_id: str | None = Field(None, description="Style reference ID from gallery")
    session_id: str | None = Field(None, description="Optional client session id (not persisted server-side)")
    sketch_image_b64: str | None = Field(None, description="Sketch image base64 as layout reference")
    text_model: str | None = Field(None, description="Override text model for this request")
    image_model: str | None = Field(None, description="Override image model for blueprint/result images")
    component_image_model: str | None = Field(
        None,
        description="Override component / asset image model",
    )
    regen_context: RegenContextModel | None = Field(
        None,
        description="Component regeneration context from canvas right-click",
    )
    canvas_type: str | None = Field(None, description="Target canvas: drawio")
    canvas_skeleton: str | None = Field(None, description="Current page draw.io XML (stripped) for LLM context")
    canvas_skeleton_full: str | None = Field(
        None,
        description="Full page XML with nanadraw_* attrs for metadata merge on modify_canvas",
    )
    canvas_images: dict[str, str] | None = Field(None, description="Image hash → base64 for canvas context")
    locale: str = Field("zh", description="UI language: zh or en")


@router.get("/status")
async def assistant_status():
    return JSONResponse({"enabled": settings.ENABLE_AI_ASSISTANT})


@router.post("/chat")
async def assistant_chat(
    body: AssistantChatRequest,
    _user=Depends(require_auth),
):
    if not settings.ENABLE_AI_ASSISTANT:
        raise HTTPException(status_code=404, detail="Not Found")

    username = getattr(_user, "nickname", None) or getattr(_user, "username", None) or "local"

    service = AssistantService(username=username, canvas_type=body.canvas_type or "drawio")
    if body.text_model:
        service.llm.model = body.text_model
    if body.image_model:
        service.image_model_override = body.image_model
    if body.component_image_model:
        service.component_image_model_override = body.component_image_model

    regen_ctx = body.regen_context.model_dump() if body.regen_context else None

    async def event_stream():
        queue: asyncio.Queue[str | None] = asyncio.Queue()

        async def _producer():
            try:
                async for event in service.chat_stream(
                    body.message,
                    body.history,
                    selected_mode=body.selected_mode,
                    style_ref_id=body.style_ref_id,
                    session_id=body.session_id,
                    sketch_image_b64=body.sketch_image_b64,
                    canvas_skeleton=body.canvas_skeleton,
                    canvas_skeleton_full=body.canvas_skeleton_full,
                    canvas_images=body.canvas_images,
                    canvas_type=body.canvas_type,
                    locale=body.locale,
                    regen_context=regen_ctx,
                ):
                    await queue.put(event)
            except Exception as e:
                logger.exception("Assistant chat stream error")
                import json as _json

                await queue.put(f"event: error\ndata: {_json.dumps({'message': str(e)})}\n\n")
            finally:
                await queue.put(None)

        producer_task = asyncio.create_task(_producer())
        try:
            while True:
                try:
                    item = await asyncio.wait_for(queue.get(), timeout=SSE_KEEPALIVE_INTERVAL)
                    if item is None:
                        break
                    yield item
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        except (asyncio.CancelledError, GeneratorExit):
            producer_task.cancel()
            raise
        finally:
            if not producer_task.done():
                producer_task.cancel()
            yield "event: close\ndata: {}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
