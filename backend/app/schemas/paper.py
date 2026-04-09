import sys

if sys.version_info >= (3, 11):
    from enum import StrEnum
else:
    from enum import Enum

    class StrEnum(str, Enum):
        pass
from typing import Annotated, Literal

from pydantic import BaseModel, BeforeValidator, Field


def _coerce_str(v: object) -> str:
    return str(v) if v is not None else ""


CoercedStr = Annotated[str, BeforeValidator(_coerce_str)]


class DiagramType(StrEnum):
    PIPELINE = "pipeline"
    ARCHITECTURE = "architecture"
    FRAMEWORK = "framework"
    TABLE = "table"
    CONCEPT_MAP = "concept_map"
    COMPARISON = "comparison"
    FREEFORM = "freeform"


class ContentType(StrEnum):
    PIPELINE = "pipeline"
    FREEFORM = "freeform"


class ColorScheme(StrEnum):
    PASTEL = "pastel"
    VIBRANT = "vibrant"
    MONOCHROME = "monochrome"


class StyleSpec(BaseModel):
    """Style specification — all fields are free-form strings with no defaults.

    The LLM decides values based on user intent; None means "not specified".
    """
    visual_style: str | None = None
    color_preset: str | None = None
    font_scheme: str | None = None
    topology: str | None = None
    layout_direction: str | None = None
    description: str | None = None

    def has_fields(self) -> bool:
        """Return True if any style field (excluding description) is set."""
        return any([
            self.visual_style,
            self.color_preset,
            self.font_scheme,
            self.topology,
            self.layout_direction,
        ])


class GenerateMode(StrEnum):
    FAST = "fast"
    FULL_GEN = "full_gen"
    SLIDES = "slides"


class GenerateOptions(BaseModel):
    diagram_type: DiagramType | None = None
    color_scheme: ColorScheme = ColorScheme.PASTEL
    image_model: str | None = Field(
        None,
        description="Image generation model override (blueprint/result images)",
    )
    component_image_model: str | None = Field(
        None,
        description="Component generation model override (Step 4 components, regen, assets)",
    )
    image_only: bool = Field(
        False,
        description="When True, stop after image generation (Steps 1-2 of full_gen)",
    )
    canvas_type: Literal["drawio"] = Field(
        "drawio",
        description="Target canvas: drawio XML",
    )


class GenerateRequest(BaseModel):
    text: str = Field(..., min_length=1, description="Paper method description text")
    mode: GenerateMode = GenerateMode.FAST
    style_ref_id: str | None = Field(None, description="Style reference image ID from gallery")
    style_spec: StyleSpec | None = Field(None, description="Explicit style specification (alternative to style_ref_id)")
    options: GenerateOptions = Field(default_factory=GenerateOptions)
    request_id: str | None = Field(None, description="Request ID for resuming a previous session")
    resume_from: str | None = Field(None, description="Step ID to resume from on retry")
    sketch_image_b64: str | None = Field(None, description="Base64 encoded sketch image as layout reference")


class RegenerateComponentRequest(BaseModel):
    request_id: str = Field(..., description="Pipeline session request ID")
    component_id: str = Field(..., description="Component ID to regenerate")


class PlanStep(BaseModel):
    id: str
    label: CoercedStr
    description: CoercedStr
    shape: CoercedStr = "rounded_rect"
    color_hint: CoercedStr = "light_blue"
    inputs: list[str] = Field(default_factory=list)
    outputs: list[str] = Field(default_factory=list)


class ContentElement(BaseModel):
    """Non-sequential element for freeform diagrams (modules, concepts, rows)."""
    id: str
    label: CoercedStr
    description: CoercedStr
    category: CoercedStr = ""


class DiagramPlan(BaseModel):
    title: CoercedStr
    diagram_type: DiagramType
    layout: CoercedStr = "left_to_right"
    content_type: CoercedStr = "pipeline"
    steps: list[PlanStep] = Field(default_factory=list)
    elements: list[ContentElement] = Field(default_factory=list)
    content_description: CoercedStr = ""
    style_notes: CoercedStr = ""

    def build_content_summary(self) -> str:
        """Build a human-readable content summary regardless of content_type."""
        if self.content_type == "pipeline" and self.steps:
            return "\n".join(
                f"  {i + 1}. {s.label}: {s.description}"
                for i, s in enumerate(self.steps)
            )
        if self.elements:
            parts = [f"  - {e.label}: {e.description}" for e in self.elements]
            if self.content_description:
                parts.insert(0, self.content_description)
            return "\n".join(parts)
        return self.content_description or self.title


class SSEEvent(BaseModel):
    event: str
    data: dict


class StyleReference(BaseModel):
    id: str
    name: str
    title: str = ""
    authors: list[str] = Field(default_factory=list)
    year: str = ""
    conference: str = ""
    category: str
    thumbnail_url: str
    image_url: str
    tags: list[str] = Field(default_factory=list)
    paper_url: str = ""
    code_url: str = ""
    project_url: str = ""
    abstract: str = ""
    bibtex: str = ""
    style_description: str = ""


class GallerySearchResult(StyleReference):
    score: float = 0.0


# ── Bioicons Schemas ──

class BioiconCategory(BaseModel):
    name: str
    count: int


class BioiconItem(BaseModel):
    id: str
    name: str
    category: str
    author: str
    license: str
    svg_url: str
    w: float
    h: float


# ── Shared Schemas (BBox, StructureConnection) ──

class BBox(BaseModel):
    x: float
    y: float
    w: float
    h: float


class StructureConnection(BaseModel):
    from_id: str
    to_id: str
    label: CoercedStr = ""
    style: CoercedStr = "arrow"
    stroke_color: CoercedStr = ""
    stroke_width: CoercedStr = ""


# ── v0.4 Full Generation Mode Schemas ──

class ComponentCategory(StrEnum):
    ILLUSTRATION = "illustration"
    STAGE_BOX = "stage_box"
    ARROW = "arrow"
    TEXT = "text"


class BlueprintComponent(BaseModel):
    id: str
    category: ComponentCategory
    bbox: BBox
    label: CoercedStr = ""
    name: CoercedStr = ""
    visual_repr: CoercedStr = ""
    style_notes: CoercedStr = ""
    z_order: int = 0
    use_native: bool = False
    native_style: CoercedStr = ""


class BackgroundInfo(BaseModel):
    bg_type: str = "none"
    color: CoercedStr = ""
    gradient_colors: list[str] = Field(default_factory=list)
    description: CoercedStr = ""
    needs_generation: bool = False


class DiagramBlueprint(BaseModel):
    canvas_width: float = 1024
    canvas_height: float = 768
    global_style: CoercedStr = ""
    color_palette: list[str] = Field(default_factory=list)
    background: BackgroundInfo = Field(default_factory=BackgroundInfo)
    components: list[BlueprintComponent] = Field(default_factory=list)
    connections: list[StructureConnection] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Asset generation (smart icon/illustration generation)
# ---------------------------------------------------------------------------

class AssetStyle(StrEnum):
    NONE = "none"
    THIN_LINEAR = "thin_linear"
    REGULAR_LINEAR = "regular_linear"
    BOLD_LINEAR = "bold_linear"
    MINIMAL_FLAT = "minimal_flat"
    DOODLE = "doodle"
    HAND_DRAWN = "hand_drawn"
    ILLUSTRATION = "illustration"
    DETAILED_LINEAR = "detailed_linear"
    FINE_LINEAR = "fine_linear"
    CUSTOM = "custom"


class AssetGenRequest(BaseModel):
    descriptions: list[str] = Field(..., min_length=1, max_length=4)
    style: AssetStyle = AssetStyle.NONE
    style_text: str | None = Field(
        None,
        max_length=200,
        description="Free-form style description when style='custom'",
    )
    image_model: str | None = None


class AssetGenItem(BaseModel):
    description: str
    image_b64: str


class AssetGenResponse(BaseModel):
    images: list[AssetGenItem]


class AssetRestyleResponse(BaseModel):
    image_b64: str
