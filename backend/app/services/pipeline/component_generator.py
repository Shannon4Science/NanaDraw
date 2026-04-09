"""Parallel component image generation with deduplication and reuse."""

import asyncio
import logging
import math
import re
import time
from collections.abc import AsyncGenerator
from dataclasses import dataclass, field

from app.prompts.fullgen_prompts import (
    BACKGROUND_GEN_SYSTEM,
    BACKGROUND_GEN_USER,
    COMPONENT_GEN_NATIVE_SYSTEM,
    COMPONENT_GEN_NATIVE_USER,
    COMPONENT_GEN_SYSTEM,
    COMPONENT_GEN_TEXT_SYSTEM,
    COMPONENT_GEN_TEXT_USER,
    COMPONENT_GEN_USER,
)
from app.schemas.paper import (
    BackgroundInfo,
    BlueprintComponent,
    ComponentCategory,
    DiagramBlueprint,
)
from app.services.llm_service import LLMService
from app.services.pipeline.image_processor import ImageProcessor

logger = logging.getLogger(__name__)

COMPONENT_MAX_ROUNDS = 1
GENERATE_RETRIES = 2
SIZE_BUCKET_STEP = 50
ARROW_SIZE_BUCKET_STEP = 100

DIRECTION_KEYWORDS = {
    "right": ["right", "rightward", "→", "->"],
    "left": ["left", "leftward", "←", "<-"],
    "up": ["up", "upward", "↑", "top"],
    "down": ["down", "downward", "↓", "bottom"],
}

ARROW_LIKE_KEYWORDS = [
    "arrow", "→", "←", "↑", "↓", "->", "<-",
    "pointer", "chevron", "direction",
]

ARROW_VISUAL_ATTRIBUTES = [
    "thick", "thin", "bold", "slim", "wide", "narrow",
    "gradient", "solid", "dashed", "dotted",
    "curved", "straight", "rounded", "sharp",
    "flat", "3d", "glossy", "matte",
    "chevron", "triangular", "pointed", "blunt",
    "double", "single",
]

ARROW_ATTR_SYNONYMS: dict[str, str] = {
    "sharp": "pointed",
    "wide": "thick",
    "bold": "thick",
    "slim": "thin",
    "narrow": "thin",
    "glossy": "3d",
    "blunt": "rounded",
}

DIRECTION_TRANSFORMS: dict[tuple[str, str], str] = {
    ("right", "left"): "flip_h",
    ("left", "right"): "flip_h",
    ("up", "down"): "flip_v",
    ("down", "up"): "flip_v",
    ("right", "up"): "rotate_90",
    ("right", "down"): "rotate_270",
    ("left", "up"): "rotate_270",
    ("left", "down"): "rotate_90",
    ("up", "right"): "rotate_270",
    ("up", "left"): "rotate_90",
    ("down", "right"): "rotate_90",
    ("down", "left"): "rotate_270",
}


def _size_bucket(val: float, step: int = SIZE_BUCKET_STEP) -> int:
    return int(math.ceil(val / step) * step)


def _is_arrow_like(comp: BlueprintComponent) -> bool:
    """Check if an illustration component represents an arrow-like shape."""
    text = (comp.visual_repr or comp.label or "").lower()
    return any(kw in text for kw in ARROW_LIKE_KEYWORDS)


def _detect_direction(text: str) -> str | None:
    """Detect arrow direction from descriptive text."""
    lower = text.lower()
    for direction, keywords in DIRECTION_KEYWORDS.items():
        for kw in keywords:
            if kw in lower:
                return direction
    return None


def _normalize_direction(text: str) -> str:
    """Remove direction keywords from text for canonical comparison."""
    lower = text.lower()
    for keywords in DIRECTION_KEYWORDS.values():
        for kw in keywords:
            lower = lower.replace(kw, "")
    return re.sub(r"\s+", " ", lower).strip()


def _normalize_style_notes(style: str) -> str:
    """Normalize key=value style notes for consistent comparison.

    Parses semicolon-separated pairs, sorts by key, normalizes whitespace.
    """
    style = style.strip().lower()
    if not style:
        return ""
    pairs: dict[str, str] = {}
    for part in style.split(";"):
        part = part.strip()
        if not part:
            continue
        if "=" in part:
            k, v = part.split("=", 1)
            pairs[k.strip()] = v.strip()
        else:
            pairs[part] = ""
    return ";".join(f"{k}={v}" if v else k for k, v in sorted(pairs.items()))


def _arrow_visual_signature(text: str, style_notes: str = "") -> str:
    """Extract a simplified visual fingerprint for arrow-like components.

    Instead of comparing the full free-form text, extracts structured
    attributes (colors + style adjectives) that determine visual appearance.
    Synonym normalization ensures "sharp"=="pointed", "wide"=="thick", etc.
    Colors are extracted from BOTH visual_repr text AND style_notes to ensure
    arrows with colors only in style_notes (e.g. strokeColor=#4A90D9) still match.
    """
    combined = f"{text} {style_notes}".lower()
    colors = sorted(set(re.findall(r"#[0-9a-fA-F]{3,8}", combined)))
    raw_attrs = [kw for kw in ARROW_VISUAL_ATTRIBUTES if kw in combined]
    normalized = sorted(set(ARROW_ATTR_SYNONYMS.get(a, a) for a in raw_attrs))
    return f"arrow|{'|'.join(colors)}|{'|'.join(normalized)}"


_ICON_PATTERN = re.compile(r"\bicon\b|\bsymbol\b|\blogo\b|\bbadge\b", re.IGNORECASE)


def _canonical_key(comp: BlueprintComponent) -> str:
    """Compute a deduplication key from component visual properties.

    Components with the same canonical key produce visually identical images
    (ignoring directional differences for arrow-like components).
    For arrow-like illustrations, uses a simplified visual fingerprint
    based on extracted colors and style attributes rather than full text.
    Icon-like components (id contains "icon" or visual_repr matches icon
    patterns) are never deduplicated — each gets a unique key.
    """
    is_arrow = _is_arrow_like(comp)
    raw_text = comp.visual_repr or comp.label or comp.id

    is_icon = (
        "icon" in comp.id.lower()
        or bool(_ICON_PATTERN.search(raw_text))
    )
    if is_icon:
        return f"{comp.category.value}|{raw_text}|{comp.id}"

    if is_arrow:
        visual = _arrow_visual_signature(raw_text, comp.style_notes or "")
        bucket_step = ARROW_SIZE_BUCKET_STEP
    else:
        visual = _normalize_direction(raw_text)
        bucket_step = SIZE_BUCKET_STEP

    style = _normalize_style_notes(comp.style_notes or "")
    w_bucket = _size_bucket(comp.bbox.w, bucket_step)
    h_bucket = _size_bucket(comp.bbox.h, bucket_step)
    return f"{comp.category.value}|{visual}|{style}|{w_bucket}x{h_bucket}"


@dataclass
class DedupGroup:
    """A group of components sharing the same canonical key."""
    canonical_key: str
    representative: BlueprintComponent
    rep_direction: str | None = None
    members: list[tuple[BlueprintComponent, str | None]] = field(default_factory=list)


def select_gen_prompts(
    comp: BlueprintComponent,
    blueprint: DiagramBlueprint,
    paper_text: str,
    ref_image: str,
    style_spec_section: str = "",
) -> tuple[str, str]:
    """Pick system/user prompt pair based on component category and use_native flag."""
    palette = ", ".join(blueprint.color_palette) or "professional academic colors"
    truncated_text = paper_text[:1500] if paper_text else "(not provided)"

    if comp.category == ComponentCategory.TEXT:
        return COMPONENT_GEN_TEXT_SYSTEM, COMPONENT_GEN_TEXT_USER.format(
            label=comp.label or comp.id,
            style_notes=comp.style_notes,
            global_style=blueprint.global_style,
            color_palette=palette,
        )

    if comp.use_native:
        return COMPONENT_GEN_NATIVE_SYSTEM, COMPONENT_GEN_NATIVE_USER.format(
            visual_repr=comp.visual_repr or comp.label or comp.id,
            label=comp.label or "",
            native_style=comp.native_style or "",
            global_style=blueprint.global_style,
            color_palette=palette,
            style_notes=comp.style_notes,
        )

    return COMPONENT_GEN_SYSTEM, COMPONENT_GEN_USER.format(
        visual_repr=comp.visual_repr or comp.label or comp.id,
        category=comp.category.value,
        global_style=blueprint.global_style,
        color_palette=palette,
        style_notes=comp.style_notes,
        paper_text=truncated_text,
        style_spec_section=style_spec_section,
    )


def _sse_event(event: str, data: dict) -> str:
    import json
    payload = json.dumps(data, ensure_ascii=False)
    return f"event: {event}\ndata: {payload}\n\n"


def _build_dedup_groups(targets: list[BlueprintComponent]) -> list[DedupGroup]:
    """Group components by canonical key for deduplication."""
    groups: dict[str, DedupGroup] = {}
    for comp in targets:
        key = _canonical_key(comp)
        direction = _detect_direction(comp.visual_repr or comp.label or "")
        if key not in groups:
            groups[key] = DedupGroup(
                canonical_key=key,
                representative=comp,
                rep_direction=direction,
            )
        else:
            groups[key].members.append((comp, direction))
    return list(groups.values())


def _apply_transform(
    processor: ImageProcessor, image_b64: str, transform: str,
    target_w: int, target_h: int,
) -> str:
    """Apply rotation/flip and resize to target dimensions."""
    if transform == "flip_h":
        transformed = processor.flip_horizontal(image_b64)
    elif transform == "flip_v":
        transformed = processor.flip_vertical(image_b64)
    elif transform == "rotate_90":
        transformed = processor.rotate_image(image_b64, 90)
    elif transform == "rotate_180":
        transformed = processor.rotate_image(image_b64, 180)
    elif transform == "rotate_270":
        transformed = processor.rotate_image(image_b64, 270)
    else:
        transformed = image_b64
    return processor.resize_contain(transformed, target_w, target_h)


async def generate_components(
    llm: LLMService,
    processor: ImageProcessor,
    blueprint: DiagramBlueprint,
    ref_image: str,
    paper_text: str = "",
    style_spec_section: str = "",
    result_images: dict[str, str] | None = None,
    global_semaphore=None,
    nana_soul: str | None = None,
) -> AsyncGenerator[str, None]:
    """Generate ILLUSTRATION components with deduplication and directional reuse.

    Yields SSE event strings (step_progress, step_complete, step_error) as each
    component finishes, enabling real-time progress. Populates result_images dict
    in-place; caller checks it after iteration.
    """
    if result_images is None:
        result_images = {}
    t0 = time.monotonic()

    gen_targets = [
        c for c in blueprint.components
        if c.category == ComponentCategory.ILLUSTRATION
    ]
    total = len(gen_targets)
    if total == 0:
        elapsed = int((time.monotonic() - t0) * 1000)
        yield _sse_event("step_complete", {
            "step_id": "component_generation",
            "elapsed_ms": elapsed,
            "artifact_type": "elements",
            "artifact": {"total": 0, "generated": 0, "ids": []},
        })
        return

    dedup_groups = _build_dedup_groups(gen_targets)
    reps = [g.representative for g in dedup_groups]
    reused_count = total - len(reps)

    logger.info(
        "Component generation: %d total, %d unique (%d reused), sequential",
        total, len(reps), reused_count,
    )

    rep_images: dict[str, str] = {}
    global_sem = global_semaphore
    progress_idx = 0
    progress_lock = asyncio.Lock()
    api_call_count = 0
    api_call_lock = asyncio.Lock()

    async def _next_idx() -> int:
        nonlocal progress_idx
        async with progress_lock:
            progress_idx += 1
            return progress_idx

    async def _inc_api_calls() -> None:
        nonlocal api_call_count
        async with api_call_lock:
            api_call_count += 1

    async def _acquire_global(sem):
        try:
            await sem.acquire()
            return True
        except Exception:
            return False

    async def _release_global(sem):
        try:
            await sem.release()
        except Exception:
            pass

    async def _generate_one(
        comp: BlueprintComponent,
    ) -> list[tuple[str, str | None, str]]:
        holding_global = global_sem and await _acquire_global(global_sem)
        try:
            sys_prompt, user_prompt = select_gen_prompts(
                comp, blueprint, paper_text, ref_image,
                style_spec_section=style_spec_section,
            )
            if nana_soul:
                from app.prompts.nana_soul import build_nana_soul_section
                sys_prompt += build_nana_soul_section(nana_soul)
            last_err: Exception | None = None
            for attempt in range(1, GENERATE_RETRIES + 1):
                try:
                    raw_b64 = await llm.generate_image(
                        sys_prompt, user_prompt, temperature=0.7,
                        reference_image_b64=ref_image,
                        asset_logical_group="components",
                        asset_logical_id=comp.id,
                        asset_run_id=llm.asset_task_id,
                    )
                    await _inc_api_calls()
                    arrow_like = _is_arrow_like(comp)
                    processed = await processor.ensure_transparent(
                        raw_b64,
                        opaque_threshold=0.85 if arrow_like else 0.92,
                        crop=not arrow_like,
                        prefer_edge_flood=not arrow_like,
                    )
                    if not arrow_like:
                        processed = ImageProcessor.crop_to_content(processed)
                        processed = ImageProcessor.detect_separator_artifact(processed)
                    return [(comp.id, processed, "success")]
                except Exception as e:
                    last_err = e
                    if attempt < GENERATE_RETRIES:
                        logger.warning(
                            "Component %s attempt %d/%d failed: %s — retrying",
                            comp.id, attempt, GENERATE_RETRIES, e,
                        )
                        await asyncio.sleep(2 * attempt)
                    else:
                        logger.warning(
                            "Component %s failed after %d attempts: %s",
                            comp.id, GENERATE_RETRIES, e,
                        )
            await _inc_api_calls()
            return [(comp.id, None, str(last_err))]
        except Exception as e:
            logger.warning("Component generation failed for %s: %s", comp.id, e)
            return [(comp.id, None, str(e))]
        finally:
            if holding_global and global_sem:
                await _release_global(global_sem)

    CONCURRENCY = 4
    local_sem = asyncio.Semaphore(CONCURRENCY)

    async def _gen_with_sem(comp: BlueprintComponent):
        async with local_sem:
            return (comp, await _generate_one(comp))

    pending = [asyncio.create_task(_gen_with_sem(comp)) for comp in reps]
    for coro in asyncio.as_completed(pending):
        comp, results_list = await coro
        for comp_id, img_b64, status in results_list:
            idx = await _next_idx()
            if img_b64:
                result_images[comp_id] = img_b64
                rep_images[comp_id] = img_b64
                yield _sse_event("step_progress", {
                    "step_id": "component_generation",
                    "element_id": comp_id,
                    "label": comp.label,
                    "category": comp.category.value,
                    "strategy": "generate",
                    "status": "success",
                    "image_b64": img_b64,
                    "index": idx,
                    "total": total,
                    "score": 0,
                    "round": 1,
                    "max_rounds": COMPONENT_MAX_ROUNDS,
                })
            else:
                yield _sse_event("step_progress", {
                    "step_id": "component_generation",
                    "element_id": comp_id,
                    "label": comp.label,
                    "category": comp.category.value,
                    "strategy": "generate",
                    "status": "failed",
                    "error": status,
                    "index": idx,
                    "total": total,
                    "score": 0,
                    "round": 1,
                    "max_rounds": COMPONENT_MAX_ROUNDS,
                })

    # Process dedup reuse groups (synchronous, fast)
    for group in dedup_groups:
        rep_img = rep_images.get(group.representative.id)
        if not rep_img:
            for member, _ in group.members:
                idx = await _next_idx()
                yield _sse_event("step_progress", {
                    "step_id": "component_generation",
                    "element_id": member.id,
                    "label": member.label,
                    "category": member.category.value,
                    "strategy": "reuse",
                    "status": "failed",
                    "error": "representative generation failed",
                    "index": idx,
                    "total": total,
                    "score": 0,
                    "round": 0,
                    "max_rounds": COMPONENT_MAX_ROUNDS,
                })
            continue

        for member, member_dir in group.members:
            idx = await _next_idx()
            transform_key = None
            strategy = "reuse"

            if group.rep_direction and member_dir and group.rep_direction != member_dir:
                transform_key = DIRECTION_TRANSFORMS.get(
                    (group.rep_direction, member_dir)
                )
                if transform_key:
                    strategy = "rotate_reuse"

            try:
                if transform_key:
                    member_img = _apply_transform(
                        processor, rep_img, transform_key,
                        int(member.bbox.w), int(member.bbox.h),
                    )
                else:
                    member_img = rep_img
                result_images[member.id] = member_img
                yield _sse_event("step_progress", {
                    "step_id": "component_generation",
                    "element_id": member.id,
                    "label": member.label,
                    "category": member.category.value,
                    "strategy": strategy,
                    "status": "success",
                    "image_b64": member_img,
                    "index": idx,
                    "total": total,
                    "score": 0,
                    "round": 0,
                    "max_rounds": COMPONENT_MAX_ROUNDS,
                })
            except Exception as e:
                logger.warning("Reuse failed for %s: %s", member.id, e)
                yield _sse_event("step_progress", {
                    "step_id": "component_generation",
                    "element_id": member.id,
                    "label": member.label,
                    "category": member.category.value,
                    "strategy": strategy,
                    "status": "failed",
                    "error": str(e),
                    "index": idx,
                    "total": total,
                    "score": 0,
                    "round": 0,
                    "max_rounds": COMPONENT_MAX_ROUNDS,
                })

    elapsed = int((time.monotonic() - t0) * 1000)
    logger.info(
        "Component generation done: %d/%d succeeded, %d reused, %d api_calls in %dms",
        len(rep_images), len(reps), reused_count, api_call_count, elapsed,
    )
    yield _sse_event("step_complete", {
        "step_id": "component_generation",
        "elapsed_ms": elapsed,
        "artifact_type": "elements",
        "artifact": {
            "total": total,
            "generated": len(rep_images),
            "reused": total - len(reps),
            "api_calls": api_call_count,
            "ids": list(result_images.keys()),
        },
    })

    if not result_images and total > 0:
        yield _sse_event("step_error", {
            "step_id": "component_generation",
            "elapsed_ms": elapsed,
            "error": "所有组件生成均失败",
        })


async def regenerate_component(
    llm: LLMService,
    processor: ImageProcessor,
    blueprint: DiagramBlueprint,
    component_id: str,
    ref_image_b64: str,
    paper_text: str = "",
    style_spec_section: str = "",
    temperature: float = 0.7,
) -> str:
    """Regenerate a single component image. Returns new base64 image.

    Raises ValueError if component not found, RuntimeError on generation failure.
    """
    comp = next(
        (c for c in blueprint.components if c.id == component_id),
        None,
    )
    if comp is None:
        raise ValueError(f"组件 {component_id} 不存在于蓝图中")

    sys_prompt, user_prompt = select_gen_prompts(
        comp, blueprint, paper_text, ref_image_b64,
        style_spec_section=style_spec_section,
    )
    raw_b64 = await llm.generate_image(
        sys_prompt, user_prompt, temperature=temperature,
        reference_image_b64=ref_image_b64,
        asset_logical_group="components",
        asset_logical_id=comp.id,
        asset_run_id=llm.asset_task_id,
    )
    arrow_like = _is_arrow_like(comp)
    processed = await processor.ensure_transparent(
        raw_b64,
        opaque_threshold=0.85 if arrow_like else 0.92,
        crop=not arrow_like,
        prefer_edge_flood=not arrow_like,
    )
    if not arrow_like:
        processed = ImageProcessor.crop_to_content(processed)
        processed = ImageProcessor.detect_separator_artifact(processed)
    return processed


async def generate_background(
    llm: LLMService,
    processor: ImageProcessor,
    blueprint: DiagramBlueprint,
    ref_image_b64: str,
) -> str | None:
    """Generate a background image if the blueprint specifies a dark background.

    Returns base64 PNG or None on failure.
    """
    bg: BackgroundInfo = blueprint.background
    if not bg.needs_generation:
        return None

    palette = ", ".join(blueprint.color_palette) or "professional academic colors"
    gradient_desc = ", ".join(bg.gradient_colors) if bg.gradient_colors else bg.color

    user_prompt = BACKGROUND_GEN_USER.format(
        bg_type=bg.bg_type,
        color=bg.color or "#1A1A2E",
        gradient_colors=gradient_desc,
        description=bg.description or "Dark professional background",
        width=int(blueprint.canvas_width),
        height=int(blueprint.canvas_height),
        global_style=blueprint.global_style,
        color_palette=palette,
    )

    try:
        raw_b64 = await llm.generate_image(
            BACKGROUND_GEN_SYSTEM, user_prompt, temperature=0.5,
            reference_image_b64=ref_image_b64,
            asset_logical_group="background",
            asset_logical_id="background",
            asset_run_id=llm.asset_task_id,
        )
        return processor.resize_contain(
            raw_b64, int(blueprint.canvas_width), int(blueprint.canvas_height),
        )
    except Exception as e:
        logger.warning("Background generation failed: %s", e)
        return None
