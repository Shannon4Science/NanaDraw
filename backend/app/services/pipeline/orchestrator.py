import json
import logging
import time
import uuid
from collections.abc import AsyncGenerator

from app.schemas.paper import GenerateRequest, StyleReference
from app.services.gallery_service import get_gallery_service
from app.services.llm_service import LLMService
from app.services.pipeline.planner import PlannerService
from app.services.pipeline.fullgen_orchestrator import FullGenOrchestrator
from app.services.pipeline.xml_generator import XMLGeneratorService

logger = logging.getLogger(__name__)


def _sse(event: str, data: dict) -> str:
    payload = json.dumps(data, ensure_ascii=False)
    return f"event: {event}\ndata: {payload}\n\n"


FAST_MODE_STEPS = [
    {"id": "planning", "name": "文本分析与规划"},
    {"id": "xml_generation", "name": "图表 XML 生成"},
]


class PipelineOrchestrator:
    """Orchestrate the diagram generation pipeline with detailed step tracking."""

    def __init__(self, username: str = "anonymous", task_id: str | None = None, nana_soul: str | None = None) -> None:
        self.llm = LLMService()
        self.planner = PlannerService(self.llm)
        self.xml_generator = XMLGeneratorService(self.llm)
        self.gallery = get_gallery_service()
        self._full_gen: FullGenOrchestrator | None = None
        self.username = username
        self._task_id = task_id
        self._nana_soul = nana_soul

    @staticmethod
    def _resolve_image_model(request: GenerateRequest, llm: LLMService) -> str:
        return request.options.image_model or llm.image_model

    async def run(self, request: GenerateRequest) -> AsyncGenerator[str, None]:
        if request.mode == "full_gen":
            self._full_gen = FullGenOrchestrator.get_or_create(
                request.request_id, username=self.username,
            )
            self._full_gen.llm.image_model = self._resolve_image_model(request, self._full_gen.llm)
            async for event in self._full_gen.run(request, resume_from=request.resume_from):
                yield event
            return

        task_id = self._task_id or uuid.uuid4().hex[:8]
        self.llm.image_model = self._resolve_image_model(request, self.llm)
        tag = f"[task={task_id} user={self.username} mode={request.mode} base_url={self.llm.base_url}] "
        self.llm.log_tag = tag
        logger.info("%sPipeline started", tag)

        style_ref: StyleReference | None = None
        if request.style_ref_id:
            style_ref = self.gallery.get_by_id(request.style_ref_id)

        steps = FAST_MODE_STEPS
        yield _sse("pipeline_info", {"steps": steps, "total": len(steps), "mode": "fast"})

        # ── Step 1: Planning ──
        logger.info("%s Step 1/2 planning started", tag)
        yield _sse("step_start", {"step_id": "planning"})
        t0 = time.monotonic()

        try:
            result = await self.planner.analyze(
                request.text, style_ref, request.style_spec,
                sketch_image_b64=getattr(request, "sketch_image_b64", None),
                nana_soul=self._nana_soul,
            )
        except Exception as e:
            elapsed = int((time.monotonic() - t0) * 1000)
            logger.exception("%s Planning failed (%dms)", tag, elapsed)
            yield _sse("step_error", {
                "step_id": "planning",
                "elapsed_ms": elapsed,
                "error": str(e),
            })
            yield _sse("error", {"message": f"规划失败: {e}"})
            yield _sse("close", {})
            return

        plan = result.plan
        elapsed = int((time.monotonic() - t0) * 1000)
        logger.info("%s Step 1/2 planning done (%dms)", tag, elapsed)
        plan_data = plan.model_dump()
        yield _sse("step_complete", {
            "step_id": "planning",
            "elapsed_ms": elapsed,
            "artifact_type": "plan",
            "artifact": plan_data,
            "prompts": result.prompts,
        })
        yield _sse("plan", plan_data)

        if request.mode != "fast":
            yield _sse("close", {})
            return

        # ── Step 2: XML Generation ──
        logger.info("%s Step 2/2 xml_generation started", tag)
        yield _sse("step_start", {"step_id": "xml_generation"})
        t0 = time.monotonic()

        try:
            xml_result = await self.xml_generator.generate_direct(
                plan,
                color_scheme=request.options.color_scheme.value,
                sketch_image_b64=getattr(request, "sketch_image_b64", None),
                nana_soul=self._nana_soul,
            )
        except Exception as e:
            elapsed = int((time.monotonic() - t0) * 1000)
            logger.exception("%s XML generation failed (%dms)", tag, elapsed)
            yield _sse("step_error", {
                "step_id": "xml_generation",
                "elapsed_ms": elapsed,
                "error": str(e),
            })
            yield _sse("error", {"message": f"XML 生成失败: {e}"})
            yield _sse("close", {})
            return

        elapsed = int((time.monotonic() - t0) * 1000)
        logger.info("%s Step 2/2 xml_generation done (%dms)", tag, elapsed)
        yield _sse("step_complete", {
            "step_id": "xml_generation",
            "elapsed_ms": elapsed,
            "artifact_type": "xml",
            "artifact": xml_result.xml,
            "prompts": xml_result.prompts,
        })
        yield _sse("result", {"xml": xml_result.xml})
        logger.info("%s Pipeline completed", tag)
        yield _sse("close", {})

    async def cleanup(self) -> None:
        await self.llm.close()
        if self._full_gen:
            await self._full_gen.cleanup()
