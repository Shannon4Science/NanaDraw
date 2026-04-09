"""Blueprint validation and sanitization utilities."""

import logging

from app.schemas.paper import BlueprintComponent, ComponentCategory, DiagramBlueprint

logger = logging.getLogger(__name__)

# Threshold: inner bbox must overlap >= 75% of its area with the outer bbox
_CONTAINMENT_RATIO = 0.75
# Only consider "small" illustration pairs (likely icon+frame, not stage boxes)
_MAX_FRAME_DIMENSION = 300

# Percentage bbox values above this threshold are treated as already-absolute pixels
_PCT_UPPER_PLAUSIBLE = 100.0

# Overlap IOU threshold for triggering nudge
_OVERLAP_IOU_THRESHOLD = 0.3
# Minimum gap (absolute px) to enforce between nudged components
_NUDGE_GAP = 8


def _bbox_overlap_ratio(inner: BlueprintComponent, outer: BlueprintComponent) -> float:
    """Fraction of *inner*'s area that lies within *outer*'s bbox."""
    ix1, iy1 = inner.bbox.x, inner.bbox.y
    ix2, iy2 = ix1 + inner.bbox.w, iy1 + inner.bbox.h
    ox1, oy1 = outer.bbox.x, outer.bbox.y
    ox2, oy2 = ox1 + outer.bbox.w, oy1 + outer.bbox.h

    inter_x1 = max(ix1, ox1)
    inter_y1 = max(iy1, oy1)
    inter_x2 = min(ix2, ox2)
    inter_y2 = min(iy2, oy2)

    if inter_x2 <= inter_x1 or inter_y2 <= inter_y1:
        return 0.0

    inter_area = (inter_x2 - inter_x1) * (inter_y2 - inter_y1)
    inner_area = inner.bbox.w * inner.bbox.h
    return inter_area / inner_area if inner_area > 0 else 0.0


def _merge_nested_illustrations(components: list[BlueprintComponent]) -> list[BlueprintComponent]:
    """Merge illustration pairs where one is a bounding frame around exactly one icon.

    When the extraction LLM splits a framed icon into "outer frame" + "inner icon",
    keep only the larger (frame) component and enrich its visual_repr with the
    inner icon's description.

    Key constraint: only merge when the outer contains exactly ONE inner illustration.
    If it contains 2+, it is a grouping container (not a bounding shape) and children
    should remain separate.
    """
    illustrations = [
        c for c in components if c.category == ComponentCategory.ILLUSTRATION
    ]
    if len(illustrations) < 2:
        return components

    # First pass: count how many children each outer would absorb
    children_of: dict[str, list[int]] = {}
    for i, outer in enumerate(illustrations):
        if outer.bbox.w > _MAX_FRAME_DIMENSION and outer.bbox.h > _MAX_FRAME_DIMENSION:
            continue
        contained: list[int] = []
        for j, inner in enumerate(illustrations):
            if i == j:
                continue
            if inner.bbox.w >= outer.bbox.w and inner.bbox.h >= outer.bbox.h:
                continue
            if _bbox_overlap_ratio(inner, outer) >= _CONTAINMENT_RATIO:
                contained.append(j)
        if contained:
            children_of[outer.id] = contained

    absorbed: set[str] = set()

    for i, outer in enumerate(illustrations):
        if outer.id not in children_of or outer.id in absorbed:
            continue
        child_indices = children_of[outer.id]
        # Only merge when the frame wraps exactly ONE child
        if len(child_indices) != 1:
            logger.debug(
                "Skipping merge for %s: contains %d children (likely a group container)",
                outer.id, len(child_indices),
            )
            continue

        inner = illustrations[child_indices[0]]
        if inner.id in absorbed:
            continue

        inner_repr = (inner.visual_repr or "").strip()
        outer_repr = (outer.visual_repr or "").strip()
        if inner_repr and inner_repr not in outer_repr:
            outer.visual_repr = f"{outer_repr}; inner element: {inner_repr}"
        absorbed.add(inner.id)
        logger.info(
            "Merged nested illustration %s into %s (1:1 frame+icon pair)",
            inner.id, outer.id,
        )

    if absorbed:
        return [c for c in components if c.id not in absorbed]
    return components


def _dedup_illustration_labels(components: list[BlueprintComponent]) -> list[BlueprintComponent]:
    """Clear labels on all non-native illustration components.

    Illustration components that will be rendered as generated images should
    never carry a label — text must be separate TEXT components.  Generated
    icon images must not contain text (non-editable), and adding a label to
    the illustration would create a duplicate overlay text box in the assembler.

    Only use_native illustrations keep their labels (they are draw.io native
    shapes where the label is rendered by the editor, not baked into an image).
    """
    for comp in components:
        if comp.category != ComponentCategory.ILLUSTRATION or not comp.label:
            continue
        if comp.use_native:
            continue
        logger.info(
            "Cleared label on illustration %s: '%s' (text must be separate TEXT component)",
            comp.id, comp.label,
        )
        comp.label = ""

    return components


_PCT_MAJORITY_THRESHOLD = 0.70

def _is_percentage_coords(bp: DiagramBlueprint) -> bool:
    """Heuristic: if most bbox values fit within 0-100 range, they're likely percentages.

    Uses majority voting (>=70%) instead of requiring ALL components to be
    within range, because LLM occasionally outputs one component slightly
    beyond 100 (e.g. x=50, w=60 → x+w=110).
    """
    if not bp.components:
        return False
    total = len(bp.components)
    in_range = 0
    for comp in bp.components:
        b = comp.bbox
        if (b.x + b.w <= _PCT_UPPER_PLAUSIBLE
                and b.y + b.h <= _PCT_UPPER_PLAUSIBLE
                and b.w <= _PCT_UPPER_PLAUSIBLE
                and b.h <= _PCT_UPPER_PLAUSIBLE):
            in_range += 1
    ratio = in_range / total
    if ratio >= _PCT_MAJORITY_THRESHOLD:
        if in_range < total:
            logger.info(
                "Percentage heuristic: %d/%d components in 0-100 range (%.0f%%), treating as percentages",
                in_range, total, ratio * 100,
            )
        return True
    return False


def _percent_to_absolute(bp: DiagramBlueprint) -> DiagramBlueprint:
    """Convert percentage-based bbox values (0-100) to absolute canvas coordinates.

    Components with bbox values slightly beyond 100 are clamped before conversion.
    """
    cw = bp.canvas_width or 1200
    ch = bp.canvas_height or 800

    if not _is_percentage_coords(bp):
        logger.info(
            "Blueprint bbox values appear to be absolute pixels (canvas %dx%d), skipping conversion",
            int(cw), int(ch),
        )
        return bp

    converted = 0
    clamped = 0
    for comp in bp.components:
        b = comp.bbox
        if b.x < 0: b.x = 0
        if b.y < 0: b.y = 0
        if b.w > _PCT_UPPER_PLAUSIBLE: b.w = _PCT_UPPER_PLAUSIBLE
        if b.h > _PCT_UPPER_PLAUSIBLE: b.h = _PCT_UPPER_PLAUSIBLE
        if b.x + b.w > _PCT_UPPER_PLAUSIBLE:
            clamped += 1
            b.x = max(0, _PCT_UPPER_PLAUSIBLE - b.w)
        if b.y + b.h > _PCT_UPPER_PLAUSIBLE:
            clamped += 1
            b.y = max(0, _PCT_UPPER_PLAUSIBLE - b.h)

        b.x = b.x / 100.0 * cw
        b.y = b.y / 100.0 * ch
        b.w = b.w / 100.0 * cw
        b.h = b.h / 100.0 * ch
        converted += 1

    logger.info(
        "Converted %d component bboxes from percentage to absolute (canvas %dx%d, %d clamped)",
        converted, int(cw), int(ch), clamped,
    )
    return bp


def _clamp_to_canvas(bp: DiagramBlueprint) -> DiagramBlueprint:
    """Ensure all components fit within canvas boundaries."""
    cw = bp.canvas_width or 1200
    ch = bp.canvas_height or 800
    margin = 4

    for comp in bp.components:
        b = comp.bbox
        if b.x < 0:
            b.x = margin
        if b.y < 0:
            b.y = margin

        if b.x + b.w > cw:
            overflow = b.x + b.w - cw + margin
            if b.x >= overflow:
                b.x -= overflow
            else:
                b.w = cw - b.x - margin
        if b.y + b.h > ch:
            overflow = b.y + b.h - ch + margin
            if b.y >= overflow:
                b.y -= overflow
            else:
                b.h = ch - b.y - margin

        b.w = max(b.w, 10)
        b.h = max(b.h, 10)

    return bp


def _iou(a: BlueprintComponent, b: BlueprintComponent) -> float:
    """Intersection-over-union of two component bboxes."""
    ax1, ay1 = a.bbox.x, a.bbox.y
    ax2, ay2 = ax1 + a.bbox.w, ay1 + a.bbox.h
    bx1, by1 = b.bbox.x, b.bbox.y
    bx2, by2 = bx1 + b.bbox.w, by1 + b.bbox.h

    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    if ix2 <= ix1 or iy2 <= iy1:
        return 0.0

    inter = (ix2 - ix1) * (iy2 - iy1)
    area_a = a.bbox.w * a.bbox.h
    area_b = b.bbox.w * b.bbox.h
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


_OVERLAP_MAX_PASSES = 5


def _is_text_near_illustration(
    text_comp: BlueprintComponent,
    illust_comp: BlueprintComponent,
    margin: float = 30.0,
) -> bool:
    """Check if a TEXT component is spatially adjacent to an ILLUSTRATION.

    TEXT labels placed near their associated icon (within margin px of its
    bbox edge) are expected to overlap slightly and should not be nudged.
    """
    if text_comp.category != ComponentCategory.TEXT:
        return False
    if illust_comp.category != ComponentCategory.ILLUSTRATION:
        return False
    tx1, ty1 = text_comp.bbox.x, text_comp.bbox.y
    tx2, ty2 = tx1 + text_comp.bbox.w, ty1 + text_comp.bbox.h
    ix1, iy1 = illust_comp.bbox.x - margin, illust_comp.bbox.y - margin
    ix2, iy2 = ix1 + illust_comp.bbox.w + 2 * margin, iy1 + illust_comp.bbox.h + 2 * margin
    return tx1 < ix2 and tx2 > ix1 and ty1 < iy2 and ty2 > iy1


def _resolve_overlaps(components: list[BlueprintComponent], canvas_w: float, canvas_h: float) -> list[BlueprintComponent]:
    """Detect significantly overlapping non-parent-child components and nudge apart.

    Multi-pass: after each round, re-check for new overlaps introduced by nudging.
    Runs until no more nudges are needed or _OVERLAP_MAX_PASSES is reached.

    Exclusions (no nudging):
    - stage_box components (they are containers)
    - TEXT components adjacent to an ILLUSTRATION (label near its icon)
    """
    non_stage = [c for c in components if c.category != ComponentCategory.STAGE_BOX]
    if len(non_stage) < 2:
        return components

    total_nudged = 0
    for pass_num in range(1, _OVERLAP_MAX_PASSES + 1):
        nudged = 0
        for i in range(len(non_stage)):
            for j in range(i + 1, len(non_stage)):
                a, b = non_stage[i], non_stage[j]

                if _is_text_near_illustration(a, b) or _is_text_near_illustration(b, a):
                    continue

                overlap = _iou(a, b)
                if overlap < _OVERLAP_IOU_THRESHOLD:
                    continue

                area_a = a.bbox.w * a.bbox.h
                area_b = b.bbox.w * b.bbox.h
                mover = b if area_a >= area_b else a
                anchor = a if mover is b else b

                mcx = mover.bbox.x + mover.bbox.w / 2
                mcy = mover.bbox.y + mover.bbox.h / 2
                acx = anchor.bbox.x + anchor.bbox.w / 2
                acy = anchor.bbox.y + anchor.bbox.h / 2
                dx = mcx - acx
                dy = mcy - acy

                if abs(dx) >= abs(dy):
                    shift = anchor.bbox.w / 2 + mover.bbox.w / 2 + _NUDGE_GAP - abs(dx)
                    if shift > 0:
                        mover.bbox.x += shift if dx >= 0 else -shift
                else:
                    shift = anchor.bbox.h / 2 + mover.bbox.h / 2 + _NUDGE_GAP - abs(dy)
                    if shift > 0:
                        mover.bbox.y += shift if dy >= 0 else -shift

                mover.bbox.x = max(0, min(mover.bbox.x, canvas_w - mover.bbox.w))
                mover.bbox.y = max(0, min(mover.bbox.y, canvas_h - mover.bbox.h))
                nudged += 1

        total_nudged += nudged
        if nudged == 0:
            break
        logger.info("Overlap pass %d: nudged %d pairs", pass_num, nudged)

    if total_nudged:
        logger.info("Resolved %d overlapping pairs in %d pass(es)", total_nudged, pass_num)
    return components


def sanitize_blueprint(bp: DiagramBlueprint) -> DiagramBlueprint:
    """Fix common issues in LLM-generated blueprints before assembly.

    - Convert percentage bboxes to absolute coordinates
    - Clamp negative coordinates to 0
    - Enforce minimum width/height
    - Deduplicate component IDs
    - Merge nested illustration pairs (frame + inner icon)
    - Deduplicate illustration labels vs TEXT components
    - Resolve overlapping components
    - Clamp components within canvas
    - Remove connections referencing unknown component IDs
    """
    bp = _percent_to_absolute(bp)

    seen_ids: set[str] = set()
    valid_components: list[BlueprintComponent] = []
    for comp in bp.components:
        if comp.bbox.w < 5:
            comp.bbox.w = 80
        if comp.bbox.h < 5:
            comp.bbox.h = 80
        if comp.bbox.x < 0:
            comp.bbox.x = 0
        if comp.bbox.y < 0:
            comp.bbox.y = 0
        if comp.id in seen_ids:
            continue
        seen_ids.add(comp.id)
        valid_components.append(comp)

    valid_components = _merge_nested_illustrations(valid_components)
    valid_components = _dedup_illustration_labels(valid_components)
    valid_components = _resolve_overlaps(
        valid_components, bp.canvas_width or 1200, bp.canvas_height or 800,
    )

    bp.components = valid_components
    bp = _clamp_to_canvas(bp)

    final_ids = {c.id for c in bp.components}
    valid_conns = [
        c for c in bp.connections
        if c.from_id in final_ids and c.to_id in final_ids
    ]
    bp.connections = valid_conns
    return bp
