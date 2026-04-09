import logging
from dataclasses import dataclass

from app.prompts.planner import (
    PLANNER_SYSTEM_PROMPT,
    PLANNER_USER_TEMPLATE,
    STYLE_CONTEXT_DEFAULT,
    STYLE_CONTEXT_WITH_REF,
    STYLE_CONTEXT_WITH_SKETCH,
    STYLE_CONTEXT_WITH_SPEC,
)
from app.prompts.nana_soul import build_nana_soul_section
from app.schemas.paper import DiagramPlan, StyleReference, StyleSpec
from app.services.llm_service import LLMService
from app.services.pipeline.style_utils import COLOR_PRESET_DESCRIPTION

logger = logging.getLogger(__name__)


@dataclass
class PlanResult:
    plan: DiagramPlan
    prompts: dict[str, str]


class PlannerService:
    """Analyze paper text and produce a structured diagram plan."""

    def __init__(self, llm: LLMService) -> None:
        self.llm = llm

    async def analyze(
        self,
        text: str,
        style_ref: StyleReference | None = None,
        style_spec: StyleSpec | None = None,
        sketch_image_b64: str | None = None,
        nana_soul: str | None = None,
    ) -> PlanResult:
        if style_ref and style_ref.style_description:
            style_context = STYLE_CONTEXT_WITH_REF.format(
                style_description=style_ref.style_description,
            )
        elif style_spec and style_spec.has_fields():
            palette_desc = COLOR_PRESET_DESCRIPTION.get(
                style_spec.color_preset or "",
                style_spec.color_preset or "model-inferred",
            )
            desc_line = (
                f"- Style description: {style_spec.description}"
                if style_spec.description else ""
            )
            style_context = STYLE_CONTEXT_WITH_SPEC.format(
                visual_style=style_spec.visual_style or "model-inferred",
                palette_description=palette_desc,
                font_scheme=style_spec.font_scheme or "model-inferred",
                topology=style_spec.topology or "model-inferred",
                layout_direction=style_spec.layout_direction or "model-inferred",
                description_line=desc_line,
            )
        elif style_spec and style_spec.description:
            style_context = (
                f"\n\nThe user described their desired style as: {style_spec.description}\n"
                "Incorporate this style description into your style_notes and layout choice.\n"
            )
        else:
            style_context = STYLE_CONTEXT_DEFAULT

        if sketch_image_b64:
            style_context += STYLE_CONTEXT_WITH_SKETCH

        user_prompt = PLANNER_USER_TEMPLATE.format(
            text=text,
            style_context=style_context,
        )

        system_prompt = PLANNER_SYSTEM_PROMPT + build_nana_soul_section(nana_soul)

        if sketch_image_b64:
            data = await self.llm.chat_with_image_json(
                system_prompt,
                user_prompt,
                sketch_image_b64,
                temperature=0.1,
            )
        else:
            data = await self.llm.chat_json(
                system_prompt,
                user_prompt,
                temperature=0.1,
            )

        plan = DiagramPlan.model_validate(data)

        # Auto-correct content_type when LLM output is inconsistent
        if plan.steps and not plan.elements:
            plan.content_type = "pipeline"
        elif plan.elements and not plan.steps:
            plan.content_type = "freeform"

        logger.info(
            "Plan: title=%r, content_type=%s, steps=%d, elements=%d",
            plan.title, plan.content_type, len(plan.steps), len(plan.elements),
        )
        return PlanResult(
            plan=plan,
            prompts={"system": system_prompt, "user": user_prompt},
        )
