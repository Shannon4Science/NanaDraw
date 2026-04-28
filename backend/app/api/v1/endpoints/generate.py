"""Diagram generation endpoint — in-process SSE (no queue)."""

import json
import logging
import time
import uuid

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

from app.dependencies import require_auth
from app.schemas.paper import GenerateMode, GenerateRequest
from app.services.pipeline.fullgen_orchestrator import FullGenOrchestrator
from app.services.pipeline.orchestrator import PipelineOrchestrator
from app.services.settings_service import load_settings

logger = logging.getLogger(__name__)
router = APIRouter()


def _use_fullgen_orchestrator(request: GenerateRequest) -> bool:
    if request.mode == GenerateMode.FULL_GEN:
        return True
    if request.options and (
        request.options.image_only
        or request.options.free
        or request.options.gpt_image
        or request.options.text_edit
    ):
        return True
    return False


@router.post("/generate")
async def generate_diagram(
    request: GenerateRequest,
    user=Depends(require_auth),
) -> StreamingResponse:
    """Stream pipeline events from an in-process orchestrator."""
    username = (
        getattr(user, "nickname", None)
        or getattr(user, "username", None)
        or "anonymous"
    )
    task_id = request.request_id or uuid.uuid4().hex[:12]
    nana_soul = str(load_settings().get("nana_soul") or "").strip() or None

    async def event_stream():
        t0 = time.monotonic()
        try:
            if _use_fullgen_orchestrator(request):
                orch = FullGenOrchestrator.get_or_create(
                    request.request_id or task_id,
                    username=username,
                )
                orch.nana_soul = nana_soul
                try:
                    async for chunk in orch.run(
                        request,
                        resume_from=request.resume_from,
                    ):
                        yield chunk
                finally:
                    await orch.cleanup()
            else:
                orch = PipelineOrchestrator(
                    username=username,
                    task_id=task_id,
                    nana_soul=nana_soul,
                )
                try:
                    async for chunk in orch.run(request):
                        yield chunk
                finally:
                    await orch.cleanup()
        except GeneratorExit:
            elapsed = int((time.monotonic() - t0) * 1000)
            logger.info("[task=%s] SSE disconnected after %dms", task_id, elapsed)
        except Exception as e:
            elapsed = int((time.monotonic() - t0) * 1000)
            logger.exception("[task=%s] generate stream failed after %dms", task_id, elapsed)
            # Keep SSE contract stable for frontend retries instead of surfacing HTTP 500.
            payload = json.dumps({"message": f"生成失败: {e}"}, ensure_ascii=False)
            yield f"event: error\ndata: {payload}\n\n"
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


@router.post("/generate/{task_id}/cancel")
async def cancel_task(task_id: str, user=Depends(require_auth)):
    """No-op for in-process runs (keeps client API stable)."""
    logger.debug("[task=%s] cancel ignored (no queue)", task_id)
    return {"ok": True, "task_id": task_id}
