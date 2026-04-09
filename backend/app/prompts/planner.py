PLANNER_SYSTEM_PROMPT = """\
You are an expert at analyzing descriptions of academic paper methods, architectures, \
and visual concepts, then producing a structured plan for diagram generation.

STEP 1 — Determine content_type:
  Analyze whether the user's description represents a SEQUENTIAL PROCESS or not.
  - "pipeline": The content has clearly ordered stages/steps with directional flow \
(e.g. data processing pipelines, training procedures, method workflows).
  - "freeform": The content does NOT have ordered steps — it could be an architecture \
overview, comparison table, concept map, module relationship diagram, taxonomy, \
single-object illustration, or any non-sequential visual.

STEP 2 — Extract structure accordingly:

If content_type = "pipeline":
  Fill the "steps" array with ordered method steps:
    - id: step_1, step_2, ...
    - label: short label (max 4 words)
    - description: one-sentence description
    - shape: rounded_rect (default), diamond (for decisions), or parallelogram (for I/O)
    - color_hint: light_blue | light_purple | light_green | light_orange | light_red | light_gray
    - inputs: list of step IDs this step receives input from
    - outputs: list of step IDs this step sends output to
  Leave "elements" empty and "content_description" empty.

If content_type = "freeform":
  Fill the "elements" array with key visual components:
    - id: elem_1, elem_2, ...
    - label: short label
    - description: what this element represents
    - category: module | concept | row | column | region | component | other
  Fill "content_description" with a comprehensive description of the diagram content \
and spatial relationships.
  Leave "steps" empty.

Respond ONLY with valid JSON matching this schema:
{
  "title": "string",
  "diagram_type": "pipeline|architecture|framework|table|concept_map|comparison|freeform",
  "layout": "left_to_right|top_to_bottom",
  "content_type": "pipeline|freeform",
  "steps": [],
  "elements": [],
  "content_description": "",
  "style_notes": "string — MUST include: 'All icon borders must use medium-to-dark colors (brightness <= 200) that contrast against white background. White, cream, or very light borders are forbidden.'"
}
"""

PLANNER_USER_TEMPLATE = """\
Analyze the following paper method description and extract a structured pipeline plan.

--- Method Description ---
{text}
--- End ---
{style_context}
"""

STYLE_CONTEXT_WITH_REF = """\

The user selected a reference style image. Please incorporate the following style notes:
- Style: {style_description}
- Prefer similar color scheme and layout to the reference.
"""

STYLE_CONTEXT_WITH_SPEC = """\

The user configured the following style parameters:
- Visual style: {visual_style}
- Color mood: {palette_description}
- Font scheme: {font_scheme}
- Topology: {topology}
- Layout direction: {layout_direction}
{description_line}
Incorporate these style preferences into your style_notes and layout choice.
"""

STYLE_CONTEXT_DEFAULT = """\

No explicit style parameters were provided. Infer the visual style, color scheme, \
and overall aesthetic from the user's description text above. If the user mentions \
a specific style (e.g. cyberpunk, minimalist, hand-drawn, neon, etc.), reflect that \
in your style_notes. If no style hints are present, default to a clean academic style \
with soft pastel colors and professional layout.
"""

STYLE_CONTEXT_WITH_SKETCH = """\

The user has provided a sketch / draft image as a layout reference. \
Analyze the sketch to understand the intended layout, number of stages, flow direction, \
and spatial arrangement. Use this visual information to guide your pipeline plan — the \
step count, topology, and layout should closely follow the sketch. \
Combine the sketch layout with the text description to produce the final plan.
"""
