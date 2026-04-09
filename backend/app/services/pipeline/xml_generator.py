import json
import logging
from dataclasses import dataclass

from app.prompts.drawio_xml import DRAWIO_SYSTEM_PROMPT, DRAWIO_USER_TEMPLATE
from app.prompts.nana_soul import build_nana_soul_section
from app.schemas.paper import DiagramPlan
from app.services.llm_service import LLMService
from app.utils.xml_utils import extract_mxcells, sanitize_mxcells, validate_mxcells, wrap_with_mxfile

logger = logging.getLogger(__name__)

XML_REPAIR_PROMPT = """\
The following draw.io mxCell XML has errors. Fix the XML so it is well-formed.
Only output the corrected mxCell elements, nothing else.

Error: {error}

Original XML:
{xml}
"""


@dataclass
class XmlResult:
    xml: str
    prompts: dict[str, str]


class XMLGeneratorService:
    """Generate draw.io XML from a diagram plan using LLM."""

    def __init__(self, llm: LLMService) -> None:
        self.llm = llm

    async def generate_direct(
        self,
        plan: DiagramPlan,
        color_scheme: str = "pastel",
        sketch_image_b64: str | None = None,
        nana_soul: str | None = None,
    ) -> XmlResult:
        """Generate draw.io mxCell XML directly from a plan (fast mode).

        Returns complete mxfile XML ready for draw.io loading, along with prompts used.
        """
        plan_json = json.dumps(plan.model_dump(), indent=2)

        system = DRAWIO_SYSTEM_PROMPT + build_nana_soul_section(nana_soul)

        user_prompt = DRAWIO_USER_TEMPLATE.format(
            plan_json=plan_json,
            color_scheme=color_scheme,
            layout=plan.layout,
        )

        if sketch_image_b64:
            user_prompt += (
                "\n\nA sketch/draft image of the desired diagram layout is attached. "
                "Use it as a visual reference for spatial arrangement and element positioning. "
                "Follow the sketch's layout structure as closely as possible."
            )
            raw_output = await self.llm.chat_with_image(
                system,
                user_prompt,
                sketch_image_b64,
                temperature=0.2,
            )
        else:
            raw_output = await self.llm.chat(
                system,
                user_prompt,
                temperature=0.2,
            )

        cells_xml = extract_mxcells(raw_output)
        is_valid, msg = validate_mxcells(cells_xml)

        if not is_valid:
            logger.warning("Initial XML invalid (%s), attempting repair", msg)
            cells_xml = await self._repair_xml(cells_xml, msg)

        cells_xml = sanitize_mxcells(cells_xml)

        return XmlResult(
            xml=wrap_with_mxfile(cells_xml),
            prompts={"system": system, "user": user_prompt},
        )

    async def _repair_xml(self, broken_xml: str, error: str) -> str:
        """Attempt to repair broken XML via LLM."""
        repair_prompt = XML_REPAIR_PROMPT.format(error=error, xml=broken_xml)

        raw = await self.llm.chat(
            "You fix broken XML. Output only valid mxCell elements.",
            repair_prompt,
            temperature=0.0,
        )

        repaired = extract_mxcells(raw)
        is_valid, msg = validate_mxcells(repaired)

        if not is_valid:
            logger.error("XML repair failed: %s. Using broken XML.", msg)
            return broken_xml

        return repaired
