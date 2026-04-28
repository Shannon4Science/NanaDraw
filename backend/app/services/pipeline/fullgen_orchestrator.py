"""v0.9 Full Generation Pipeline orchestrator.

Pipeline: Planning -> Reference Image -> Blueprint Extraction
         -> Component Generation -> Assembly

5-step pipeline driven by unified StyleSpec.
Delegates heavy logic to sub-modules (blueprint_utils, style_utils,
component_generator, xml_assembler).
"""

import asyncio
import base64
import json
import logging
import time
import uuid
import zlib
from collections import OrderedDict
from collections.abc import AsyncGenerator
from pathlib import Path

from app.prompts.fullgen_prompts import (
    BLUEPRINT_EXTRACT_SYSTEM,
    BLUEPRINT_EXTRACT_USER,
    BLUEPRINT_IMAGE_SYSTEM,
    BLUEPRINT_IMAGE_USER_FROM_PLAN,
    BLUEPRINT_IMAGE_USER_WITH_REF,
    BLUEPRINT_IMAGE_USER_WITH_SKETCH,
    BLUEPRINT_IMAGE_USER_WITH_SPEC,
    BLUEPRINT_STYLE_SPEC_ADDON,
    IMAGE_ONLY_SYSTEM,
)
from app.prompts.text_edit_prompts import (
    TEXT_EDIT_EXTRACT_SYSTEM,
    TEXT_EDIT_EXTRACT_USER,
    TEXT_EDIT_REMOVE_TEXT_PROMPT,
)
from app.schemas.paper import (
    ComponentCategory,
    DiagramBlueprint,
    DiagramPlan,
    GenerateRequest,
    StyleReference,
    StyleSpec,
)
from app.services.gallery_service import get_gallery_service
from app.services.llm_service import LLMService
from app.services.pipeline.blueprint_utils import sanitize_blueprint
from app.services.pipeline.component_generator import generate_background, generate_components
from app.services.pipeline.image_processor import ImageProcessor
from app.services.pipeline.planner import PlannerService
from app.services.pipeline.style_utils import (
    COLOR_PRESET_DESCRIPTION,
    COLOR_PRESET_PALETTE,
    build_style_spec_section,
)
from app.services.pipeline.xml_assembler import assemble_drawio_xml

_STATIC_ROOT = Path(__file__).resolve().parent.parent.parent.parent / "static"

logger = logging.getLogger(__name__)

_session_cache: OrderedDict[str, "FullGenOrchestrator"] = OrderedDict()
_CACHE_MAX = 20

FULL_GEN_STEPS = [
    {"id": "planning", "name": "文本理解与规划"},
    {"id": "image_generation", "name": "结构蓝图生成"},
    {"id": "blueprint_extraction", "name": "蓝图结构提取"},
    {"id": "component_generation", "name": "组件生成"},
    {"id": "assembly_refine", "name": "组装"},
]

IMAGE_ONLY_STEPS = [
    {"id": "planning", "name": "文本理解与规划"},
    {"id": "result_image", "name": "结果图片生成"},
]

FREE_MODE_STEPS = [
    {"id": "result_image", "name": "图片生成"},
]

TEXT_EDIT_STEPS = [
    {"id": "planning", "name": "文本理解与规划"},
    {"id": "result_image", "name": "背景图片生成"},
    {"id": "text_extraction", "name": "文字提取与组装"},
]

def _sse(event: str, data: dict) -> str:
    payload = json.dumps(data, ensure_ascii=False)
    return f"event: {event}\ndata: {payload}\n\n"


class FullGenOrchestrator:
    """Orchestrate the full generation pipeline (5 steps, StyleSpec driven)."""

    def __init__(self, request_id: str | None = None, username: str = "anonymous", nana_soul: str | None = None) -> None:
        self.request_id = request_id or uuid.uuid4().hex[:8]
        self.username = username
        self.llm = LLMService()
        self._update_tag()
        self.planner = PlannerService(self.llm)
        self.gallery = get_gallery_service()
        self.processor = ImageProcessor()

        self.plan: DiagramPlan | None = None
        self.plan_prompts: dict | None = None
        self.ref_image_b64: str | None = None
        self._original_style_ref_b64: str | None = None
        self.blueprint: DiagramBlueprint | None = None
        self.component_images: dict[str, str] = {}
        self.background_image: str | None = None
        self.paper_text: str = ""
        self.style_spec: StyleSpec | None = None
        self.canvas_type: str = "drawio"
        self._running: bool = False
        self._started_at: float = 0.0
        self.nana_soul: str | None = nana_soul

    @staticmethod
    def _extract_step_error(events: list[str], fallback: str = "Unknown error") -> str:
        import re as _re
        for e in events:
            if '"step_error"' in e:
                m = _re.search(r'"error"\s*:\s*"([^"]*)"', e)
                if m:
                    return m.group(1)
        return fallback

    def _update_tag(self) -> None:
        """Rebuild log tag with current model info."""
        self.tag = (
            f"[task={self.request_id} user={self.username} "
            f"base_url={self.llm.base_url} "
            f"text={self.llm.model} image={self.llm.image_model}] "
        )
        self.llm.log_tag = self.tag

    _RUNNING_TIMEOUT = 600  # 10 minutes auto-reset

    @staticmethod
    def _get_llm_semaphore():
        """Create a Redis-backed LLM semaphore, or None if Redis is unavailable."""
        try:
            from app.common.redis_semaphore import RedisLLMSemaphore
            from app.common.redis_service import get_redis
            from app.core.config import settings
            return RedisLLMSemaphore(
                get_redis(),
                max_concurrent=settings.LLM_GLOBAL_IMAGE_CONCURRENCY,
            )
        except Exception:
            return None

    _REDIS_TTL = 1800  # 30 minutes
    _REDIS_PREFIX = "ps:"

    @classmethod
    def get_or_create(
        cls, request_id: str | None = None, username: str = "anonymous",
    ) -> "FullGenOrchestrator":
        # L1: in-memory cache (same process)
        if request_id and request_id in _session_cache:
            _session_cache.move_to_end(request_id)
            inst = _session_cache[request_id]
            inst.username = username
            inst.tag = f"[task={inst.request_id} user={username}] "
            inst.llm.log_tag = inst.tag
            return inst
        # L2: Redis (cross-pod)
        if request_id:
            loaded = cls._load_from_redis(request_id, username)
            if loaded:
                if len(_session_cache) >= _CACHE_MAX:
                    _session_cache.popitem(last=False)
                _session_cache[request_id] = loaded
                logger.info(
                    "[task=%s user=%s] Restored orchestrator from Redis",
                    request_id, username,
                )
                return loaded
        # New instance
        orch = cls(request_id, username=username)
        if len(_session_cache) >= _CACHE_MAX:
            _session_cache.popitem(last=False)
        _session_cache[orch.request_id] = orch
        return orch

    # ── Redis persistence (L2 cache) ──

    def _save_to_redis(self) -> None:
        """Persist current state to Redis for cross-pod access.

        Uses a binary Redis client for zlib-compressed image data and a text
        client for JSON metadata. Called after each pipeline step completes.
        """
        try:
            from app.common.redis_service import get_sync_redis, get_sync_redis_binary
        except Exception:
            logger.debug("%s Redis unavailable, skip state save", self.tag)
            return

        try:
            r_text = get_sync_redis()
            r_bin = get_sync_redis_binary()
            key = f"{self._REDIS_PREFIX}{self.request_id}"
            ttl = self._REDIS_TTL

            # --- text metadata hash ---
            mapping: dict[str, str] = {
                "username": self.username,
                "paper_text": self.paper_text,
                "canvas_type": self.canvas_type,
            }
            if self.nana_soul:
                mapping["nana_soul"] = self.nana_soul
            if self.plan:
                mapping["plan"] = self.plan.model_dump_json()
            if self.blueprint:
                mapping["blueprint"] = self.blueprint.model_dump_json()
            if self.style_spec:
                mapping["style_spec"] = self.style_spec.model_dump_json()
            if self.plan_prompts:
                mapping["plan_prompts"] = json.dumps(self.plan_prompts, ensure_ascii=False)
            r_text.hset(key, mapping=mapping)
            r_text.expire(key, ttl)

            # --- large image blobs (compressed, binary client) ---
            if self.ref_image_b64:
                r_bin.set(f"{key}:ref_img", zlib.compress(self.ref_image_b64.encode()), ex=ttl)
            if self.background_image:
                r_bin.set(f"{key}:bg_img", zlib.compress(self.background_image.encode()), ex=ttl)

            # --- component images (compressed, stored as individual keys) ---
            if self.component_images:
                pipe = r_bin.pipeline()
                for cid, b64 in self.component_images.items():
                    comp_key = f"{key}:comp:{cid}"
                    pipe.set(comp_key, zlib.compress(b64.encode()), ex=ttl)
                pipe.execute()
                r_text.hset(key, "comp_ids", json.dumps(list(self.component_images.keys())))
                r_text.expire(key, ttl)

            # --- per-user latest: clean up old task ---
            user_key = f"ps:latest:{self.username}"
            old_task_id = r_text.get(user_key)
            if old_task_id and old_task_id != self.request_id:
                self._cleanup_redis_keys(r_text, r_bin, old_task_id)
            r_text.set(user_key, self.request_id, ex=ttl)

            logger.debug("%s State saved to Redis", self.tag)
        except Exception:
            logger.warning("%s Failed to save state to Redis", self.tag, exc_info=True)

    @classmethod
    def _cleanup_redis_keys(cls, r_text, r_bin, task_id: str) -> None:
        """Remove all Redis keys for a given task."""
        key = f"{cls._REDIS_PREFIX}{task_id}"
        comp_ids_raw = r_text.hget(key, "comp_ids")
        keys_to_delete = [key, f"{key}:ref_img", f"{key}:bg_img"]
        if comp_ids_raw:
            try:
                for cid in json.loads(comp_ids_raw):
                    keys_to_delete.append(f"{key}:comp:{cid}")
            except (json.JSONDecodeError, TypeError):
                pass
        r_text.delete(*keys_to_delete)

    @classmethod
    def _load_from_redis(
        cls, request_id: str, username: str = "anonymous",
    ) -> "FullGenOrchestrator | None":
        """Restore orchestrator state from Redis."""
        try:
            from app.common.redis_service import get_sync_redis, get_sync_redis_binary
        except Exception:
            return None

        try:
            r_text = get_sync_redis()
            r_bin = get_sync_redis_binary()
            key = f"{cls._REDIS_PREFIX}{request_id}"
            data = r_text.hgetall(key)
            if not data:
                return None

            orch = cls(request_id, username=username)
            orch.paper_text = data.get("paper_text", "")
            orch.nana_soul = data.get("nana_soul")
            orch.canvas_type = data.get("canvas_type", "drawio")

            if "plan" in data:
                orch.plan = DiagramPlan.model_validate_json(data["plan"])
            if "blueprint" in data:
                orch.blueprint = DiagramBlueprint.model_validate_json(data["blueprint"])
            if "style_spec" in data:
                orch.style_spec = StyleSpec.model_validate_json(data["style_spec"])
            if "plan_prompts" in data:
                orch.plan_prompts = json.loads(data["plan_prompts"])

            # Decompress images (binary client)
            ref_raw = r_bin.get(f"{key}:ref_img")
            if ref_raw:
                orch.ref_image_b64 = zlib.decompress(ref_raw).decode()
            bg_raw = r_bin.get(f"{key}:bg_img")
            if bg_raw:
                orch.background_image = zlib.decompress(bg_raw).decode()

            # Component images
            comp_ids_str = data.get("comp_ids")
            if comp_ids_str:
                try:
                    comp_ids = json.loads(comp_ids_str)
                except (json.JSONDecodeError, TypeError):
                    comp_ids = []
                if comp_ids:
                    pipe = r_bin.pipeline()
                    for cid in comp_ids:
                        pipe.get(f"{key}:comp:{cid}")
                    results = pipe.execute()
                    for cid, raw in zip(comp_ids, results):
                        if raw:
                            orch.component_images[cid] = zlib.decompress(raw).decode()

            # Refresh TTL on all keys
            ttl = cls._REDIS_TTL
            pipe_ttl = r_text.pipeline()
            pipe_ttl.expire(key, ttl)
            pipe_ttl.execute()
            r_bin_pipe = r_bin.pipeline()
            for suffix in ["ref_img", "bg_img"]:
                r_bin_pipe.expire(f"{key}:{suffix}", ttl)
            if comp_ids_str:
                for cid in json.loads(comp_ids_str):
                    r_bin_pipe.expire(f"{key}:comp:{cid}", ttl)
            r_bin_pipe.execute()

            return orch
        except Exception:
            logger.warning(
                "[task=%s] Failed to load state from Redis",
                request_id, exc_info=True,
            )
            return None

    def _check_resume_prerequisites(self, start_idx: int) -> list[str]:
        missing: list[str] = []
        if start_idx >= 1 and self.plan is None:
            missing.append("规划结果")
        if start_idx >= 2 and self.ref_image_b64 is None:
            missing.append("参考图")
        if start_idx >= 3 and self.blueprint is None:
            missing.append("蓝图")
        if start_idx >= 4 and not self.component_images:
            missing.append("组件图片")
        return missing

    # ── Main entry ──

    async def run(
        self, request: GenerateRequest, resume_from: str | None = None,
    ) -> AsyncGenerator[str, None]:
        if self._running:
            stale = (time.monotonic() - self._started_at) > self._RUNNING_TIMEOUT
            if stale:
                logger.warning(
                    "%s Stale _running flag detected (%.0fs), auto-resetting",
                    self.tag, time.monotonic() - self._started_at,
                )
                self._running = False
            else:
                yield _sse("error", {"message": "该会话正在生成中，请勿重复请求"})
                yield _sse("close", {})
                return
        self._running = True
        self._started_at = time.monotonic()
        try:
            async for event in self._run_pipeline(request, resume_from):
                yield event
        finally:
            self._running = False

    async def _run_pipeline(
        self, request: GenerateRequest, resume_from: str | None = None,
    ) -> AsyncGenerator[str, None]:
        pipeline_t0 = time.monotonic()
        from app.services.settings_service import load_settings as _load_settings

        _disk = _load_settings()
        self.llm.image_model = (
            request.options.image_model
            or str(_disk.get("llm_image_model") or "").strip()
            or self.llm.image_model
        )
        self._component_image_model = request.options.component_image_model
        self.canvas_type = getattr(request.options, "canvas_type", "drawio") or "drawio"
        self._update_tag()
        self.paper_text = request.text
        logger.info("%sFull-gen pipeline started (resume=%s)", self.tag, resume_from or "none")

        style_ref: StyleReference | None = None
        if request.style_ref_id:
            style_ref = self.gallery.get_by_id(request.style_ref_id)

        if request.style_spec:
            self.style_spec = request.style_spec

        image_only = getattr(request.options, "image_only", False) if request.options else False
        is_free = (
            getattr(request.options, "free", False)
            or getattr(request.options, "gpt_image", False)
        ) if request.options else False
        is_text_edit = getattr(request.options, "text_edit", False) if request.options else False
        if is_free:
            active_steps = FREE_MODE_STEPS
            pipeline_mode = "free"
        elif is_text_edit:
            active_steps = TEXT_EDIT_STEPS
            pipeline_mode = "text_edit"
        elif image_only:
            active_steps = IMAGE_ONLY_STEPS
            pipeline_mode = "image_only"
        else:
            active_steps = FULL_GEN_STEPS
            pipeline_mode = "full_gen"

        step_order = [s["id"] for s in active_steps]
        start_idx = 0
        if resume_from:
            if resume_from in step_order:
                start_idx = step_order.index(resume_from)
            else:
                logger.warning(
                    "%s Unknown resume_from=%s for mode=%s, fallback to full run",
                    self.tag, resume_from, pipeline_mode,
                )

        yield _sse("pipeline_info", {
            "steps": active_steps,
            "total": len(active_steps),
            "request_id": self.request_id,
            "mode": pipeline_mode,
        })

        # ── Free mode: single-step direct image generation ──
        if is_free:
            logger.info("%s Step 1/1 free_image_gen started", self.tag)
            yield _sse("step_start", {"step_id": "result_image"})
            ref_b64, events = await self._step_free_image_gen(
                request.text,
                step_id="result_image",
            )
            for evt in events:
                yield evt
            if ref_b64 is None:
                logger.error("%s Step 1/1 free_image_gen FAILED", self.tag)
                yield _sse("error", {"message": self._extract_step_error(events, "Image generation failed")})
                yield _sse("close", {})
                return
            self.ref_image_b64 = ref_b64
            elapsed = int((time.monotonic() - pipeline_t0) * 1000)
            logger.info("%s free mode pipeline completed (total %dms)", self.tag, elapsed)
            yield _sse("result", {"image": self.ref_image_b64})
            yield _sse("close", {})
            return

        # ── Text-edit mode: image + editable text overlay ──
        if is_text_edit:
            logger.info("%s Step 1/3 planning started (text_edit)", self.tag)
            yield _sse("step_start", {"step_id": "planning"})
            plan_result, plan_meta = await self._step_planning(request, style_ref)
            if plan_result is None:
                yield plan_meta
                logger.error("%s Step 1/3 planning FAILED (text_edit)", self.tag)
                yield _sse("close", {})
                return
            self.plan = plan_result
            self.plan_prompts = plan_meta
            self._save_to_redis()
            for evt in self._emit_planning_result(plan_result, plan_meta):
                yield evt

            logger.info("%s Step 2/3 result_image started (text_edit)", self.tag)
            yield _sse("step_start", {"step_id": "result_image"})
            ref_b64, img_events = await self._step_image_gen(
                plan_result,
                request,
                style_ref=style_ref,
                step_id="result_image",
                sketch_image_b64=getattr(request, "sketch_image_b64", None),
                image_only=True,
            )
            for evt in img_events:
                yield evt
            if ref_b64 is None:
                logger.error("%s Step 2/3 result_image FAILED (text_edit)", self.tag)
                yield _sse("error", {"message": self._extract_step_error(img_events, "Image generation failed")})
                yield _sse("close", {})
                return
            self.ref_image_b64 = ref_b64
            self._save_to_redis()

            logger.info("%s Step 3/3 text_extraction started (text_edit)", self.tag)
            yield _sse("step_start", {"step_id": "text_extraction"})
            xml, text_events = await self._step_text_edit_assembly(
                ref_b64,
                plan_result,
                step_id="text_extraction",
            )
            for evt in text_events:
                yield evt
            if xml is None:
                logger.error("%s Step 3/3 text_extraction FAILED (text_edit)", self.tag)
                yield _sse("error", {"message": self._extract_step_error(text_events, "Text extraction failed")})
                yield _sse("close", {})
                return

            elapsed = int((time.monotonic() - pipeline_t0) * 1000)
            logger.info("%s text_edit pipeline completed (total %dms)", self.tag, elapsed)
            yield _sse("result", {"xml": xml})
            yield _sse("close", {})
            return

        if start_idx > 0:
            missing = self._check_resume_prerequisites(start_idx)
            if missing:
                logger.warning(
                    "%s Session expired: missing %s (resume_from=%s)",
                    self.tag, missing, resume_from,
                )
                yield _sse("error", {
                    "message": f"会话已过期（缺少: {', '.join(missing)}），请重新生成",
                })
                yield _sse("close", {})
                return

        def _need_run(step_idx: int) -> bool:
            return start_idx <= step_idx

        # ── Step 1: Planning ──
        if _need_run(0):
            logger.info("%s Step 1/5 planning started", self.tag)
            yield _sse("step_start", {"step_id": "planning"})
            plan, meta = await self._step_planning(request, style_ref)
            if plan is None:
                logger.error("%s Step 1/5 planning FAILED", self.tag)
                yield meta
                yield _sse("close", {})
                return
            self.plan = plan
            self.plan_prompts = meta
            logger.info("%s Step 1/5 planning done (%dms)", self.tag, meta.get("elapsed", 0))
            self._save_to_redis()
            for evt in self._emit_planning_result(plan, meta):
                yield evt
        else:
            for evt in self._emit_cached_step("planning", "plan", self._plan_artifact()):
                yield evt

        # ── Step 2: Image Generation ──
        step2_id = "result_image" if image_only else "image_generation"
        step_label = "结果图片生成" if image_only else "结构蓝图生成"
        total_steps = len(active_steps)
        if _need_run(1):
            logger.info("%s Step 2/%d %s started", self.tag, total_steps, step2_id)
            yield _sse("step_start", {"step_id": step2_id})
            ref_b64, events = await self._step_image_gen(
                self.plan, request, style_ref, step_id=step2_id,
                sketch_image_b64=getattr(request, "sketch_image_b64", None),
                image_only=image_only,
            )
            for evt in events:
                yield evt
            if ref_b64 is None:
                logger.error("%s Step 2/%d %s FAILED", self.tag, total_steps, step2_id)
                yield _sse("close", {})
                return
            logger.info("%s Step 2/%d %s done", self.tag, total_steps, step2_id)
            self.ref_image_b64 = ref_b64
            self._save_to_redis()
        else:
            for evt in self._emit_cached_step(
                step2_id, "reference_image",
                {"image_b64_preview": "(cached)"},
            ):
                yield evt
            if self.ref_image_b64:
                yield _sse("reference_image", {"image": self.ref_image_b64})

        # ── image_only early exit ──
        if image_only:
            elapsed = int((time.monotonic() - pipeline_t0) * 1000)
            logger.info(
                "%s image_only pipeline completed (total %dms)", self.tag, elapsed,
            )
            yield _sse("result", {"image": self.ref_image_b64})
            yield _sse("close", {})
            return

        # ── Step 3: Blueprint Extraction ──
        if _need_run(2):
            need_style = self.style_spec is None
            logger.info(
                "%sStep 3/5 blueprint_extraction started (extract_style=%s)",
                self.tag, need_style,
            )
            yield _sse("step_start", {"step_id": "blueprint_extraction"})
            blueprint, extracted_style, events = await self._step_blueprint_extract(
                self.ref_image_b64, self.plan, extract_style=need_style,
            )
            if need_style and extracted_style:
                self.style_spec = extracted_style
            for evt in events:
                yield evt
            if blueprint is None:
                logger.error("%s Step 3/5 blueprint_extraction FAILED", self.tag)
                yield _sse("close", {})
                return
            logger.info("%s Step 3/5 blueprint_extraction done", self.tag)
            self.blueprint = sanitize_blueprint(blueprint)
            self._save_to_redis()
        else:
            for evt in self._emit_cached_step(
                "blueprint_extraction", "blueprint",
                self.blueprint.model_dump() if self.blueprint else {},
            ):
                yield evt

        # ── Step 4: Component Generation ──
        if _need_run(3):
            needs_bg = (
                self.blueprint is not None
                and self.blueprint.background.needs_generation
            )
            n_comps = len(self.blueprint.components) if self.blueprint else 0
            logger.info(
                "%s Step 4/5 component_generation started (%d components, bg=%s)",
                self.tag, n_comps, needs_bg,
            )
            yield _sse("step_start", {"step_id": "component_generation"})
            style_section = build_style_spec_section(self.style_spec)

            bg_task = None
            if needs_bg:
                bg_ref = self._original_style_ref_b64 or self.ref_image_b64
                bg_task = asyncio.ensure_future(generate_background(
                    self.llm, self.processor,
                    self.blueprint, bg_ref,
                ))

            from app.core.config import settings as _settings
            from app.services.settings_service import load_settings as _load_settings

            _disk = _load_settings()
            _original_image_model = self.llm.image_model
            _comp_model = (
                self._component_image_model
                or str(_disk.get("llm_image_model") or "").strip()
                or _settings.LLM_COMPONENT_MODEL
                or _settings.LLM_IMAGE_MODEL_FLASH
            )
            self.llm.image_model = _comp_model
            self._update_tag()
            logger.info(
                "%sComponent generation: image_model switched %s → %s",
                self.tag, _original_image_model, self.llm.image_model,
            )

            comp_images: dict[str, str] = {}
            step_error_seen = False
            global_sem = self._get_llm_semaphore()
            component_ref = self._original_style_ref_b64 or self.ref_image_b64
            async for evt in generate_components(
                self.llm, self.processor,
                self.blueprint, component_ref, self.paper_text,
                style_spec_section=style_section,
                result_images=comp_images,
                global_semaphore=global_sem,
                nana_soul=self.nana_soul,
            ):
                if "event: step_error" in evt:
                    step_error_seen = True
                yield evt

            self.llm.image_model = _original_image_model
            self._update_tag()
            logger.info("%sComponent generation done, image_model restored", self.tag)

            images = None if step_error_seen else comp_images

            if bg_task is not None:
                try:
                    self.background_image = await bg_task
                    if self.background_image:
                        logger.info("%s Background image generated", self.tag)
                    else:
                        logger.warning("%s Background generation returned None", self.tag)
                except Exception as e:
                    logger.warning("%s Background generation failed: %s", self.tag, e)

            if images is None:
                logger.error("%s Step 4/5 component_generation FAILED", self.tag)
                yield _sse("close", {})
                return
            logger.info("%s Step 4/5 component_generation done (%d images)", self.tag, len(images))
            self.component_images = images
            self._save_to_redis()
        else:
            for evt in self._emit_cached_step("component_generation", "elements", {
                "total": len(self.component_images),
                "ids": list(self.component_images.keys()),
            }):
                yield evt

        # ── Step 5: Assembly ──
        logger.info("%s Step 5/5 assembly started", self.tag)
        async for evt in self._step_assembly_refine(
            self.blueprint, self.component_images, self.ref_image_b64,
            background_image=self.background_image,
        ):
            yield evt
        total_ms = int((time.monotonic() - pipeline_t0) * 1000)
        logger.info("%s Full-gen pipeline completed (total %dms)", self.tag, total_ms)

    # ── Helpers ──

    def _emit_cached_step(self, step_id: str, artifact_type: str, artifact: object):
        yield _sse("step_start", {"step_id": step_id})
        yield _sse("step_complete", {
            "step_id": step_id,
            "elapsed_ms": 0,
            "artifact_type": artifact_type,
            "artifact": artifact,
            "cached": True,
        })

    def _plan_artifact(self) -> dict:
        return self.plan.model_dump() if self.plan else {}

    # ── Step implementations ──

    async def _step_planning(self, request, style_ref):
        t0 = time.monotonic()
        try:
            result = await self.planner.analyze(
                request.text, style_ref, self.style_spec,
                sketch_image_b64=getattr(request, "sketch_image_b64", None),
                nana_soul=self.nana_soul,
            )
        except Exception as e:
            elapsed = int((time.monotonic() - t0) * 1000)
            logger.exception("%s Planning failed (%dms)", self.tag, elapsed)
            error_events = (
                _sse("step_error", {"step_id": "planning", "elapsed_ms": elapsed, "error": str(e)})
                + _sse("error", {"message": f"规划失败: {e}"})
            )
            return None, error_events
        elapsed = int((time.monotonic() - t0) * 1000)
        return result.plan, {"elapsed": elapsed, "prompts": result.prompts}

    def _emit_planning_result(self, plan, meta):
        plan_data = plan.model_dump()
        yield _sse("step_complete", {
            "step_id": "planning",
            "elapsed_ms": meta["elapsed"],
            "artifact_type": "plan",
            "artifact": plan_data,
            "prompts": meta["prompts"],
        })
        yield _sse("plan", plan_data)

    def _load_style_ref_image(self, style_ref: StyleReference) -> str | None:
        """Read gallery reference image and return base64.

        Supports both local paths (/static/gallery/...) and CDN URLs (https://...).
        """
        url = style_ref.image_url

        if url.startswith(("http://", "https://")):
            import httpx
            try:
                resp = httpx.get(url, timeout=30, follow_redirects=True)
                resp.raise_for_status()
                return base64.b64encode(resp.content).decode()
            except Exception as e:
                logger.warning("%s Failed to download style ref from CDN: %s — %s", self.tag, url, e)
                return None

        rel = url.lstrip("/").removeprefix("static/")
        path = _STATIC_ROOT / rel
        if not path.exists():
            logger.warning("%s Style ref image not found: %s", self.tag, path)
            return None
        return base64.b64encode(path.read_bytes()).decode()

    async def _step_image_gen(
        self,
        plan: DiagramPlan,
        request: GenerateRequest,
        style_ref: StyleReference | None = None,
        step_id: str = "image_generation",
        sketch_image_b64: str | None = None,
        image_only: bool = False,
    ) -> tuple[str | None, list[str]]:
        events: list[str] = []
        t0 = time.monotonic()

        content_summary = plan.build_content_summary()
        common = {
            "title": plan.title,
            "layout": plan.layout.replace("_", " "),
            "steps_description": content_summary,
        }

        from app.prompts.nana_soul import build_nana_soul_section
        system_prompt = (IMAGE_ONLY_SYSTEM if image_only else BLUEPRINT_IMAGE_SYSTEM) + build_nana_soul_section(self.nana_soul)
        ref_image_b64: str | None = None

        if sketch_image_b64:
            ref_image_b64 = sketch_image_b64
            style_notes = getattr(plan, "style_notes", "") or ""
            ss = self.style_spec
            if ss and ss.has_fields():
                palette_desc = COLOR_PRESET_DESCRIPTION.get(
                    ss.color_preset or "", ss.color_preset or "model-inferred",
                )
                style_section = (
                    f"STYLE:\n- Visual style: {ss.visual_style or 'model-inferred'}\n"
                    f"- Color mood: {palette_desc}\n"
                    f"- Font scheme: {ss.font_scheme or 'model-inferred'}"
                )
                if ss.description:
                    style_section += f"\n- Style description: {ss.description}"
            elif ss and ss.description:
                style_section = f"STYLE GUIDANCE:\n{ss.description}"
            elif style_notes:
                style_section = f"STYLE GUIDANCE:\n{style_notes}"
            else:
                style_section = "STYLE: Clean academic style with professional layout."
            user_prompt = BLUEPRINT_IMAGE_USER_WITH_SKETCH.format(
                **common, style_section=style_section,
            )
        elif style_ref:
            ref_image_b64 = self._load_style_ref_image(style_ref)
            self._original_style_ref_b64 = ref_image_b64
            user_prompt = BLUEPRINT_IMAGE_USER_WITH_REF.format(**common)
        else:
            ss = self.style_spec
            if ss and ss.has_fields():
                palette_desc = COLOR_PRESET_DESCRIPTION.get(
                    ss.color_preset or "", ss.color_preset or "model-inferred",
                )
                desc_line = (
                    f"- Style description: {ss.description}"
                    if ss.description else ""
                )
                user_prompt = BLUEPRINT_IMAGE_USER_WITH_SPEC.format(
                    **common,
                    visual_style=ss.visual_style or "model-inferred",
                    palette_description=palette_desc,
                    font_scheme=ss.font_scheme or "model-inferred",
                    topology=ss.topology or "model-inferred",
                    layout_direction=ss.layout_direction or "model-inferred",
                    description_line=desc_line,
                )
            else:
                style_notes = getattr(plan, "style_notes", "") or ""
                if ss and ss.description:
                    style_notes = ss.description + ("\n" + style_notes if style_notes else "")
                user_prompt = BLUEPRINT_IMAGE_USER_FROM_PLAN.format(
                    **common,
                    style_notes=style_notes or "Clean academic style with professional layout.",
                )

        asset_group = "result_image" if image_only else "blueprint_ref"
        try:
            image_b64 = await self.llm.generate_image(
                system_prompt,
                user_prompt,
                temperature=0.8,
                reference_image_b64=ref_image_b64,
                asset_logical_group=asset_group,
                asset_logical_id="original",
            )
        except Exception as e:
            elapsed = int((time.monotonic() - t0) * 1000)
            logger.exception("%s Image generation failed", self.tag)
            events.append(_sse("step_error", {
                "step_id": step_id, "elapsed_ms": elapsed, "error": str(e),
            }))
            return None, events

        elapsed = int((time.monotonic() - t0) * 1000)
        events.append(_sse("step_complete", {
            "step_id": step_id,
            "elapsed_ms": elapsed,
            "artifact_type": "reference_image",
            "artifact": {"size_bytes": len(image_b64), "status": "generated"},
            "prompts": {"system": system_prompt, "user": user_prompt},
        }))
        events.append(_sse("reference_image", {"image": image_b64}))
        return image_b64, events

    async def _step_free_image_gen(
        self,
        request_text: str,
        step_id: str = "result_image",
    ) -> tuple[str | None, list[str]]:
        """Free mode: generate image directly from conversation text."""
        events: list[str] = []
        t0 = time.monotonic()

        system_prompt = (
            "You are an expert illustration designer. "
            "Generate a clean, modern, publication-quality illustration. "
            "Use clear labels, professional color scheme, and well-organized layout."
        )
        try:
            image_b64 = await self.llm.generate_image(
                system_prompt=system_prompt,
                user_prompt=request_text,
            )
        except Exception as e:
            elapsed = int((time.monotonic() - t0) * 1000)
            logger.exception("%s Free mode image generation failed", self.tag)
            events.append(_sse("step_error", {
                "step_id": step_id, "elapsed_ms": elapsed, "error": str(e),
            }))
            return None, events

        elapsed = int((time.monotonic() - t0) * 1000)
        events.append(_sse("step_complete", {
            "step_id": step_id,
            "elapsed_ms": elapsed,
            "artifact_type": "reference_image",
            "artifact": {"size_bytes": len(image_b64), "status": "generated"},
            "prompts": {"system": system_prompt, "user": request_text},
        }))
        events.append(_sse("reference_image", {"image": image_b64}))
        return image_b64, events

    async def _step_text_edit_assembly(
        self,
        background_b64: str,
        plan: DiagramPlan,
        step_id: str = "text_extraction",
    ) -> tuple[str | None, list[str]]:
        """Text-edit mode: extract text from image and overlay editable text cells."""
        events: list[str] = []
        t0 = time.monotonic()

        context = f"Title: {plan.title}\nLayout: {plan.layout}"
        if plan.steps:
            context += f"\nSteps: {', '.join(s.label for s in plan.steps[:10])}"
        elif plan.elements:
            context += f"\nElements: {', '.join(e.label for e in plan.elements[:10])}"

        try:
            _img = ImageProcessor.b64_to_image(background_b64)
            real_w, real_h = _img.size
            scale = 1200 / max(real_w, real_h)
            canvas_w = int(real_w * scale)
            canvas_h = int(real_h * scale)
        except Exception:
            real_w, real_h = 1200, 800
            canvas_w, canvas_h = 1200, 800

        try:
            result_text = await self.llm.chat_with_image(
                system_prompt=TEXT_EDIT_EXTRACT_SYSTEM,
                user_text=TEXT_EDIT_EXTRACT_USER.format(
                    context=context,
                    image_w=real_w,
                    image_h=real_h,
                    canvas_w=canvas_w,
                    canvas_h=canvas_h,
                ),
                image_b64=background_b64,
                temperature=0.3,
            )
        except Exception as e:
            elapsed = int((time.monotonic() - t0) * 1000)
            logger.exception("%s Text extraction VLM failed", self.tag)
            events.append(_sse("step_error", {
                "step_id": step_id, "elapsed_ms": elapsed, "error": str(e),
            }))
            return None, events

        text_data = _parse_json_safe(result_text)
        if not text_data or "text_components" not in text_data:
            elapsed = int((time.monotonic() - t0) * 1000)
            events.append(_sse("step_error", {
                "step_id": step_id,
                "elapsed_ms": elapsed,
                "error": "Failed to parse text extraction result",
            }))
            return None, events

        text_comps = text_data.get("text_components", [])
        clean_bg_b64 = background_b64
        try:
            clean_bg_b64 = await self.llm.generate_image(
                system_prompt="You are an expert image editor.",
                user_prompt=TEXT_EDIT_REMOVE_TEXT_PROMPT,
                reference_image_b64=background_b64,
                asset_logical_group="result_image",
                asset_logical_id="text_free_bg",
            )
        except Exception as e:
            logger.warning("%s Text-free background generation failed, fallback to original: %s", self.tag, e)

        xml = _build_text_edit_xml(clean_bg_b64, text_comps, canvas_w, canvas_h)
        elapsed = int((time.monotonic() - t0) * 1000)
        events.append(_sse("step_complete", {
            "step_id": step_id,
            "elapsed_ms": elapsed,
            "artifact_type": "xml",
            "artifact": {"text_count": len(text_comps)},
            "prompts": {
                "system": TEXT_EDIT_EXTRACT_SYSTEM[:200],
                "user": TEXT_EDIT_EXTRACT_USER.format(
                    context=context,
                    image_w=real_w,
                    image_h=real_h,
                    canvas_w=canvas_w,
                    canvas_h=canvas_h,
                )[:200],
                "bg_removal": TEXT_EDIT_REMOVE_TEXT_PROMPT[:200],
            },
        }))
        return xml, events

    async def _step_blueprint_extract(
        self, ref_image: str, plan: DiagramPlan, *, extract_style: bool = False,
    ) -> tuple[DiagramBlueprint | None, StyleSpec | None, list[str]]:
        events: list[str] = []
        t0 = time.monotonic()

        content_summary = plan.build_content_summary()
        user_prompt = BLUEPRINT_EXTRACT_USER.format(
            title=plan.title,
            layout=plan.layout.replace("_", " "),
            steps_summary=content_summary,
            style_notes=plan.style_notes or "",
        )

        system_prompt = BLUEPRINT_EXTRACT_SYSTEM
        if extract_style:
            system_prompt = BLUEPRINT_EXTRACT_SYSTEM + BLUEPRINT_STYLE_SPEC_ADDON

        img_kb = len(ref_image) * 3 // 4 // 1024
        logger.info(
            "%sBlueprint extraction LLM call (extract_style=%s, image~%dKB)",
            self.tag, extract_style, img_kb,
        )

        extracted_style: StyleSpec | None = None
        try:
            data = await self.llm.chat_with_image_json(
                system_prompt, user_prompt, ref_image,
                temperature=0.1,
                read_timeout=300.0,
            )

            if isinstance(data, list):
                logger.warning(
                    "%sBlueprint LLM returned list (len=%d) instead of dict, unwrapping",
                    self.tag, len(data),
                )
                data = data[0] if data and isinstance(data[0], dict) else {}

            if extract_style and "style_spec" in data:
                try:
                    extracted_style = StyleSpec.model_validate(data.pop("style_spec"))
                except Exception:
                    logger.warning("%sStyle spec parsing failed, using defaults", self.tag)

            blueprint = DiagramBlueprint.model_validate(data)
        except Exception as e:
            elapsed = int((time.monotonic() - t0) * 1000)
            logger.exception("%sBlueprint extraction failed (%dms)", self.tag, elapsed)
            events.append(_sse("step_error", {
                "step_id": "blueprint_extraction", "elapsed_ms": elapsed, "error": str(e),
            }))
            return None, None, events

        elapsed = int((time.monotonic() - t0) * 1000)
        illustration_count = sum(
            1 for c in blueprint.components if c.category == ComponentCategory.ILLUSTRATION
        )
        native_count = sum(1 for c in blueprint.components if c.use_native)

        events.append(_sse("step_complete", {
            "step_id": "blueprint_extraction",
            "elapsed_ms": elapsed,
            "artifact_type": "blueprint",
            "artifact": {
                "total_components": len(blueprint.components),
                "illustrations": illustration_count,
                "native_components": native_count,
                "connections": len(blueprint.connections),
                "global_style": blueprint.global_style,
                "color_palette": blueprint.color_palette,
                "components": [
                    {
                        "id": c.id,
                        "category": c.category.value,
                        "label": c.label,
                        "use_native": c.use_native,
                        "bbox": c.bbox.model_dump(),
                    }
                    for c in blueprint.components
                ],
            },
            "prompts": {"system": system_prompt, "user": user_prompt},
        }))
        return blueprint, extracted_style, events

    async def _step_assembly_refine(
        self,
        blueprint: DiagramBlueprint,
        component_images: dict[str, str],
        ref_image: str,
        background_image: str | None = None,
    ) -> AsyncGenerator[str, None]:
        yield _sse("step_start", {"step_id": "assembly_refine"})
        t0 = time.monotonic()

        final_xml = assemble_drawio_xml(
            blueprint, component_images, self.style_spec,
            background_image=background_image,
        )
        elapsed = int((time.monotonic() - t0) * 1000)
        yield _sse("step_complete", {
            "step_id": "assembly_refine",
            "elapsed_ms": elapsed,
            "artifact_type": "xml",
            "artifact": final_xml[:500] + "..." if len(final_xml) > 500 else final_xml,
            "prompts": {"system": "(programmatic assembly)", "user": "(none)"},
        })
        yield _sse("result", {"xml": final_xml})

        yield _sse("close", {})

    async def cleanup(self) -> None:
        await self.llm.close()


def _parse_json_safe(text: str) -> dict | None:
    """Best-effort JSON extraction from LLM output."""
    import re

    text = text.strip()
    m = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if m:
        text = m.group(1).strip()
    if text.startswith("{"):
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            pass
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        try:
            return json.loads(text[start:end + 1])
        except json.JSONDecodeError:
            pass
    return None


def _build_text_edit_xml(
    background_b64: str,
    text_components: list[dict],
    canvas_w: int = 1200,
    canvas_h: int = 800,
) -> str:
    """Build draw.io XML with image background and editable text overlays."""
    from xml.sax.saxutils import escape
    from app.services.pipeline.xml_assembler import _img_html

    cells: list[str] = []
    cell_id = 2
    bg_value = _img_html(background_b64)
    bg_style = (
        "html=1;overflow=fill;whiteSpace=wrap;"
        "verticalAlign=middle;align=center;"
        "fillColor=none;strokeColor=none;"
    )
    cells.append(
        f'      <mxCell id="{cell_id}" value="{bg_value}" style="{bg_style}" vertex="1" parent="1">'
        f'<mxGeometry width="{canvas_w}" height="{canvas_h}" as="geometry"/></mxCell>'
    )
    cell_id += 1

    for comp in text_components:
        bbox = comp.get("bbox", {})
        raw_x = bbox.get("x", 0) * canvas_w / 100
        raw_y = bbox.get("y", 0) * canvas_h / 100
        raw_w = max(bbox.get("w", 10) * canvas_w / 100, 20)
        raw_h = max(bbox.get("h", 5) * canvas_h / 100, 14)
        pad_w = raw_w * 0.10
        pad_h = raw_h * 0.10
        x = max(0, raw_x - pad_w / 2)
        y = max(0, raw_y - pad_h / 2)
        w = raw_w + pad_w
        h = raw_h + pad_h

        style_data = comp.get("style", {})
        font_size = style_data.get("fontSize", 14)
        font_color = style_data.get("fontColor", "#333333")
        font_style = style_data.get("fontStyle", 0)
        align = style_data.get("align", "center")
        style_str = ";".join([
            "text",
            "html=1",
            "whiteSpace=wrap",
            f"fontSize={font_size}",
            f"fontColor={font_color}",
            f"fontStyle={font_style}",
            f"align={align}",
            "verticalAlign=middle",
            "overflow=visible",
            "fillColor=none",
            "strokeColor=none",
        ]) + ";"
        label = escape(comp.get("content", ""))
        cells.append(
            f'      <mxCell id="{cell_id}" value="{label}" style="{style_str}" vertex="1" parent="1">'
            f'<mxGeometry x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" as="geometry"/></mxCell>'
        )
        cell_id += 1

    cells_str = "\n".join(cells)
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<mxGraphModel>\n'
        "  <root>\n"
        '    <mxCell id="0"/>\n'
        '    <mxCell id="1" parent="0"/>\n'
        f"{cells_str}\n"
        "  </root>\n"
        "</mxGraphModel>"
    )
