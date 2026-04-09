"""Prompts for v0.4 Full Generation Pipeline."""

# ── Step 2: Structure Blueprint / Image-Only Image Generation ──

BLUEPRINT_IMAGE_SYSTEM = """\
You are an expert academic diagram designer. Generate a pipeline diagram image \
based on the user's description.

STRUCTURAL REQUIREMENTS:
- Generate at the HIGHEST resolution possible (aim for 2048x1536 or above; \
at minimum 1024x768). Higher resolution is always better.
- Clear boundaries between all elements with adequate spacing (>=20px gap)
- NO text smaller than 10pt, NO overlapping elements
- Clean arrows connecting stages with optional labels
- Stage titles with numbered sections like "(1) Stage Name"

ARROW DESIGN (CRITICAL — arrows will be extracted as separate components):
- Arrows MUST be visually DETACHED from the icons/stages they connect. \
There must be a clear white gap (>=10px) between the arrow tip/tail and \
any icon bounding shape or stage background.
- NEVER draw arrows that visually merge into, overlap, or touch the icon \
bounding shapes. The arrow should START and END in the white space between \
stages, NOT on the icon border.
- Arrows should be simple, clean directional shapes (solid color, no complex \
decorations) so they can be cleanly separated from surrounding elements.
- AVOID thick decorated arrows that span the entire width between two icons \
with no white space — always leave a visible gap on both ends.

ICON DESIGN:
- Each icon MUST be enclosed in a clear bounding shape (rounded rect, circle, \
badge, etc.) with a visible darker border — this is critical for extraction
- Make icons visually rich and appealing: use color gradients, highlights, \
small interior details, and subtle depth cues to give each icon character
- Use varied, saturated fill colors across icons — avoid monotone palettes; \
each step should feel visually distinct while maintaining overall cohesion
- AVOID soft shadows or blurred edges that bleed outward; use crisp edges
- BORDER RULE (CRITICAL): Icon borders MUST be SOLID OPAQUE lines (2-4px). \
NEVER use neon glow, light emission, bloom, luminous outlines, or any effect \
that makes the border bleed or fade into the background. Even for neon/cyberpunk \
/dark themes: use bright solid-color borders (vivid color is fine, glow is NOT). \
All glow/neon effects go INSIDE the bounding shape only, never on the border edge
- BORDER COLOR CONTRAST (CRITICAL): Icon borders MUST use medium-to-dark colors \
with sufficient contrast against white. Border brightness must be <= 200. \
White (#FFFFFF), near-white, cream (#FFFDD0), or any border lighter than #C8C8C8 \
is FORBIDDEN — such borders will be invisible after background removal. Even for \
pastel/macaroon styles, use muted teal, dusty rose, slate gray, or similar \
medium-toned borders.

STAGE COMPOSITION (use when appropriate):
- When a pipeline step involves multiple distinct sub-processes or sub-concepts \
(e.g. "Data Preprocessing" covering cropping, normalization, and augmentation), \
you MAY group 2-4 small icons together inside a shared light-colored stage \
background region, creating a visually richer multi-icon stage
- The stage background should be a distinct, light-colored area that groups \
the sub-icons together visually
- Sub-icons within a stage should still each have their own bounding shape
- Only use this pattern when the step content naturally involves multiple \
sub-concepts. Simple single-concept steps should use a single icon

TEXT RULES:
- Stage titles: bold, >=14pt, placed above or inside the stage region
- Step descriptions/captions: >=10pt, placed below the icon
- All text must be legible against its background
"""

IMAGE_ONLY_SYSTEM = """\
You are an expert academic diagram designer. Generate a beautiful, \
publication-ready pipeline diagram image based on the user's description.

STRUCTURAL REQUIREMENTS:
- Generate at the HIGHEST resolution possible (aim for 2048x1536 or above; \
at minimum 1024x768). Higher resolution is always better.
- Clear boundaries between all elements with adequate spacing
- NO text smaller than 10pt, NO overlapping elements
- Clean arrows connecting stages with optional labels
- Stage titles with numbered sections like "(1) Stage Name"

ICON DESIGN:
- Make icons visually rich and appealing: use color gradients, highlights, \
small interior details, and subtle depth cues to give each icon character
- Use varied, saturated fill colors across icons — avoid monotone palettes; \
each step should feel visually distinct while maintaining overall cohesion
- Icons can use any shape or style — rounded rects, circles, free-form, \
badges, etc. Choose whatever looks best for the subject matter
- Focus on visual appeal and clarity rather than extraction-friendly borders

STAGE COMPOSITION (use when appropriate):
- When a pipeline step involves multiple distinct sub-processes or sub-concepts, \
you MAY group 2-4 small icons together inside a shared stage background region
- Only use this pattern when the step content naturally involves multiple \
sub-concepts. Simple single-concept steps should use a single icon

TEXT RULES:
- Stage titles: bold, >=14pt, placed above or inside the stage region
- Step descriptions/captions: >=10pt, placed below the icon
- All text must be legible against its background
"""

BLUEPRINT_IMAGE_USER_WITH_REF = """\
Generate a pipeline diagram image for the following research method.

Title: {title}
Layout: {layout}

Steps:
{steps_description}

STYLE: Match the visual style of the attached reference image exactly — \
replicate its color palette, icon rendering style, background treatment, \
typography, and overall aesthetic. Do NOT default to any other style.

MANDATORY — ICON BOUNDARIES (override reference style if needed):
Every icon/element MUST be enclosed in a clearly visible bounding shape \
(rounded rectangle, circle, badge, etc.) with a darker border outline. \
Even if the reference image uses borderless icons, YOU MUST add bounding \
shapes — this is a hard requirement for downstream automated extraction. \
The bounding shape should complement the reference style (matching colors \
and corner radius) while remaining clearly visible.
"""

BLUEPRINT_IMAGE_USER_WITH_SPEC = """\
Generate a pipeline diagram image for the following research method.

Title: {title}
Layout: {layout}

Steps:
{steps_description}

STYLE SPECIFICATION:
- Visual style: {visual_style}
- Color mood: {palette_description}
- Font scheme: {font_scheme}
- Diagram topology: {topology}
- Layout direction: {layout_direction}
{description_line}

Ensure every icon has a clear bounding shape with a visible border for \
easy extraction.
"""

BLUEPRINT_IMAGE_USER_FROM_PLAN = """\
Generate a pipeline diagram image for the following research method.

Title: {title}
Layout: {layout}

Steps:
{steps_description}

STYLE GUIDANCE (inferred from user description):
{style_notes}

Follow the style guidance above precisely. If it mentions a specific visual \
theme (e.g. cyberpunk, minimalist, hand-drawn), apply that theme throughout \
the entire diagram — colors, shapes, textures, and overall mood should all \
reflect the requested style.

Ensure every icon has a clear bounding shape with a visible border for \
easy extraction.
"""

BLUEPRINT_IMAGE_USER_WITH_SKETCH = """\
Generate a pipeline diagram image for the following research method.

Title: {title}
Layout: {layout}

Steps:
{steps_description}

LAYOUT REFERENCE:
The attached sketch/draft image shows the intended spatial layout and flow. \
Follow its arrangement of stages, flow direction, and overall composition as \
closely as possible. The sketch is a rough guide — improve the visual quality \
while preserving the layout.

{style_section}

Ensure every icon has a clear bounding shape with a visible border for \
easy extraction.
"""

# ── Step 3: Blueprint Extraction ──

BLUEPRINT_EXTRACT_SYSTEM = """\
You are a diagram structure analysis expert. Given a reference diagram image \
and the original plan, extract a detailed DiagramBlueprint in JSON.

COMPONENT CATEGORIES:
- "illustration": ANY visual element that should be independently generated as an image. \
This includes: icons, logos, cartoon illustrations, charts, decorated stage backgrounds, \
gradient boxes, thick/decorative arrows with visual effects, badges, banners, colored panels, \
and ANY element that has visual complexity beyond a plain rectangle or simple line. \
When in doubt, classify as illustration — it is better to generate than to use a native shape.
- "stage_box": ONLY use for very simple, plain colored rectangles that serve as containers \
with NO gradient, NO shadow, NO decoration — just a flat colored background with optional border. \
If the stage background has ANY visual detail (gradient, texture, rounded corners with shadow), \
classify it as "illustration" instead.
- "arrow": ONLY simple thin-line directional connectors between components. \
If an arrow is thick, decorated, curved with visual effects, or has a complex shape, \
classify it as "illustration" instead.
- "text": A text label, title, description, or caption. \
Rendered as draw.io text cell.

COORDINATE SYSTEM:
All bbox values are PERCENTAGES of the canvas (0-100), NOT pixels.
x and w are percentages of canvas_width; y and h are percentages of canvas_height.
Example: a component at the horizontal center occupying half the width → x=25, y=10, w=50, h=30.
canvas_width and canvas_height: set to the target draw.io canvas size.
Use 1200 for width and 800 for height (landscape); swap for portrait diagrams.

OUTPUT FORMAT (strict JSON, no markdown fences):
{{
  "canvas_width": <number>,
  "canvas_height": <number>,
  "global_style": "<overall style description: flat/3D/gradient, visual mood>",
  "color_palette": ["#hex1", "#hex2", "#hex3", ...],
  "background": {{
    "bg_type": "none|solid_light|solid_dark|gradient_dark|gradient_light",
    "color": "<primary background hex color, e.g. #1A1A2E>",
    "gradient_colors": ["<hex1>", "<hex2>"],
    "description": "<20-40 word description of the background appearance: color, gradient direction, texture, mood>",
    "needs_generation": <true ONLY if the background is dark/complex and must be generated as an image component; false for white, transparent, or light solid backgrounds>
  }},
  "components": [
    {{
      "id": "comp_1",
      "name": "<2-5 word semantic name describing the component's role, e.g. 'ResNet Encoder', 'Attention Module', 'Loss Arrow', 'Stage 1 Title'>",
      "category": "illustration|stage_box|arrow|text",
      "bbox": {{"x": <number>, "y": <number>, "w": <number>, "h": <number>}},
      "label": "<for stage_box/text: the visible text content; for illustration: ALWAYS empty string — any associated text must be a separate TEXT component>",
      "visual_repr": "<50-100 word description of this component as an ISOLATED object on a blank canvas — describe its shape, colors, sub-elements, and style — do NOT mention its position in the diagram, neighboring components, or the overall layout. ONLY for illustration category>",
      "style_notes": "<color/gradient/shadow/border styling details, use hex colors>",
      "z_order": <int, 0=bottom layer>,
      "use_native": <true if simple enough for draw.io native shape, false otherwise>,
      "native_style": "<draw.io style string when use_native=true, e.g. 'rounded=1;whiteSpace=wrap;fillColor=#dae8fc;strokeColor=#6c8ebf;'>"
    }}
  ],
  "connections": [
    {{
      "from_id": "comp_x",
      "to_id": "comp_y",
      "label": "<optional label>",
      "style": "arrow|dashed_arrow|straight_arrow|curved_arrow|orthogonal_arrow",
      "stroke_color": "<optional hex color, e.g. #616161>",
      "stroke_width": "<optional width, e.g. 2>"
    }}
  ]
}}

RULES:
1. bbox values are PERCENTAGES (0-100) of canvas_width / canvas_height, NOT pixels. \
For example, an element in the left quarter of the canvas might have x=2, w=23. \
Ensure that no component's x+w exceeds 100 or y+h exceeds 100.
2. Every illustration component MUST have a detailed visual_repr (50-100 words) describing \
shape, colors, sub-elements, and style — sufficient to regenerate the icon independently. \
CRITICAL: Describe the component as an ISOLATED object on a blank canvas. Do NOT reference \
its position in the diagram, neighboring components, or the overall layout. Write the \
description as if someone must recreate this single element without ever seeing the diagram.
3. For stage_box: style_notes MUST use draw.io key=value format separated by semicolons. \
Include fillColor, strokeColor, opacity (0-100), arcSize, fontSize, fontColor, fontStyle. \
  * fillColor / strokeColor — use EXACT hex colors from the reference image \
  * fontSize — the stage heading font size (typically 14-22 depending on the diagram) \
  * fontColor — exact hex of the heading text color \
  * fontStyle — 0=normal, 1=bold (stage headings are usually bold) \
Example: "fillColor=#E3F2FD;strokeColor=#90CAF9;opacity=70;fontSize=16;fontColor=#1A237E;fontStyle=1". \
If the stage box has a visible title/heading, the label field MUST contain that title text.
4. For text: style_notes MUST use draw.io key=value format with PRECISE values \
observed from the reference image. Required keys: \
  * fontSize=N — estimate carefully by comparing text height to the overall canvas: \
    main titles/headings: 18-28, stage titles/step names: 14-20, \
    body descriptions: 12-16, captions/footnotes: 9-12. \
    NEVER default everything to the same size; differentiate heading vs body vs caption. \
  * fontColor=#hex — use the EXACT hex color visible in the image, not a generic #333. \
    Titles are often darker (#111-#333), descriptions lighter (#555-#888), \
    accent text may use a palette color. \
  * fontStyle=N — 0=normal, 1=bold, 2=italic, 3=bold+italic. \
    Stage titles and headings are usually bold (1). Descriptions are usually normal (0). \
  * align=left|center|right — observe the actual text alignment in the image. \
Optional: fillColor=#hex if the text has a visible background panel/highlight. \
Example heading: "fontSize=22;fontStyle=1;fontColor=#1A237E;align=center". \
Example caption: "fontSize=11;fontStyle=0;fontColor=#757575;align=center". \
The label field MUST NOT be empty.
5. For arrow: style_notes MUST use draw.io key=value format. \
Include strokeColor, strokeWidth, fillColor. \
Carefully observe the arrow thickness in the reference image and set strokeWidth accordingly. \
Example: "strokeColor=#666666;strokeWidth=3;fillColor=#666666". \
SIZING: Arrow bbox must be proportional to surrounding components. \
For horizontal arrows: w=3-7%, h=2-5%. \
For vertical arrows: w=2-5%, h=3-7%. \
Do NOT make arrow bbox larger than nearby illustration/stage_box components.
6. BOUNDING SHAPE vs GROUPING CONTAINER: \
Components with a clear visible border (rounded rect, circle, badge, card, panel, etc.) \
should be extracted as a SINGLE illustration, regardless of how many sub-elements they \
contain. The key criterion is whether the component has a CLEAR BORDER that enables clean \
cropping during post-processing. \
  A) BORDERED COMPONENT (has a visible bounding shape with clear edges): \
    * Extract as ONE "illustration", even if it contains multiple sub-icons or details \
    * The bbox MUST include the full bounding shape border \
    * visual_repr should describe the outer shape AND all its inner contents \
    * A card with 3 small icons inside is still ONE component if the card has a clear border \
    * The illustration's "label" field MUST be empty ("") — any text labels associated \
      with the illustration must be extracted as separate TEXT components so they remain \
      editable. Generated icon images must NOT contain any text. \
  B) UNBOUNDED GROUP (multiple separate elements without a shared border): \
    * Extract each element INDIVIDUALLY as its own component \
    * Only split into separate components when there is NO shared bounding border \
  C) STAGE BOX: a large plain-colored area grouping a pipeline stage's elements → "stage_box" \
HOW TO DECIDE: does the group have a single CLEAR VISIBLE BORDER? \
  * YES, has a clear border → (A) one illustration \
  * NO, elements float freely without a shared border → (B) extract individually \
  * Plain light background grouping a stage → (C) stage_box \
  CRITICAL LIMIT: Rule 6A applies to INDIVIDUAL cards, badges, or panels — NOT to \
  the entire diagram or entire pipeline. A single illustration component should NEVER \
  span more than ~50% of the canvas width AND ~50% of the canvas height simultaneously. \
  If you find yourself creating one component that covers most of the canvas, STOP — \
  you are likely grouping too aggressively. Break it into individual per-step components. \
  Each pipeline step should have its OWN illustration(s), text label(s), and optional \
  stage_box. The diagram must be decomposed into many small components, NOT one giant image. \
  EXCEPTION — STAGE-LEVEL ILLUSTRATION: If a pipeline stage has a clearly decorated \
  background (gradient, shadow, rounded corners with visual effects), the entire stage \
  background — including its inner icons — MAY be extracted as ONE illustration even \
  if it approaches the 50% limit, as long as each stage is a SEPARATE component. \
  This is preferred over splitting into stage_box + individual inner icons when the \
  stage background is visually complex and enables clean per-stage cropping. \
  NO-TEXT IN ILLUSTRATION (CRITICAL): \
  a) The "label" field of illustration components MUST ALWAYS be empty (""). \
     All text content associated with an illustration (titles, captions, labels) \
     must be separate TEXT components so they remain editable by the user. \
  b) visual_repr MUST describe ONLY graphical elements (shapes, colors, gradients, \
     sub-icons, layout) — do NOT describe or reproduce any readable text content. \
  c) The generated image for the illustration MUST NOT contain any text, letters, \
     numbers, or placeholder text (e.g. "Lorem ipsum"). Text baked into images \
     cannot be edited and causes duplication when paired with TEXT components.
7. use_native=true ONLY for extremely simple shapes with zero visual detail (plain rectangle, basic circle). \
The vast majority of components should have use_native=false.
8. Assign z_order: stage_box=0, illustrations(background)=1, arrows=2, illustrations(icons)=3, text=4 (adjust for overlaps).
9. IMPORTANT: Prefer "illustration" category aggressively. Stage backgrounds with gradients, \
decorative arrows, badges, banners — all should be "illustration".
9b. ICON VISUAL_REPR UNIQUENESS (CRITICAL for deduplication): Every icon/small illustration \
component MUST have a visual_repr that is UNIQUE and CONTEXTUAL. Do NOT use generic \
descriptions like "document icon" or "search icon" repeated across stages. Instead, \
include the stage context and distinguishing visual details. Examples: \
  BAD: "document icon" (appears in 3 stages — will be deduplicated into one image) \
  GOOD: "input document icon with blue folder and incoming arrow badge" \
  GOOD: "processed document icon with green checkmark overlay" \
  GOOD: "output document icon with download arrow and file stack" \
Each icon should describe its unique visual identity so that the generation pipeline \
produces distinct images for each.
10. BORDER & STYLE CONSTRAINT FOR ASSEMBLY: When writing visual_repr for \
illustration components, ALWAYS specify that the bounding shape border must be a \
simple SOLID OPAQUE line (2-4px). This is CRITICAL for downstream automated \
cropping — the border must have a sharp, clean edge against the white background. \
FORBIDDEN in visual_repr: neon glow, light emission, bloom, outer glow, soft \
shadow on borders, luminous edges, glowing outlines, or any effect that causes \
the border to bleed/fade into the background. Even if the reference image uses \
neon/cyberpunk/glowing aesthetics, describe the border as a bright solid-color \
line (vivid color is fine, glow is NOT). All visual richness (gradients, \
highlights, glow effects, neon lighting) goes INSIDE the bounding shape only. \
The border color MUST contrast sharply with a white background (brightness <= 200). \
White, cream, or very light pastel borders are FORBIDDEN in visual_repr — they \
will be invisible after background removal.
11. color_palette should list the 3-6 dominant hex colors used throughout the diagram.
12. global_style should describe the overall visual feel in one sentence.
13. Include ALL visible elements. Do not skip small labels, captions, or decorative arrows. \
Text labels that are visually INSIDE a bordered illustration should be extracted as \
separate TEXT components (not baked into the illustration) — set illustration label="" \
and create a TEXT component with the appropriate label and bbox.
14. Use IDs like comp_1, comp_2, ... sequentially.
15. Every component MUST have a unique, meaningful "name" field (2-5 words) \
describing its semantic role in the pipeline (e.g. "ResNet Encoder", "Feature Map", \
"Training Loss Arrow", "Step 1 Title"). No two components should share the same name.
16. Output ONLY the JSON object. No explanations.
17. BACKGROUND ANALYSIS: Carefully analyze the diagram's background. \
If the background is white, near-white, or transparent → bg_type="none", needs_generation=false. \
If it is a light solid color (brightness > 200) → bg_type="solid_light", needs_generation=false. \
If it is a dark solid color (brightness ≤ 200, e.g. dark blue, black, charcoal) → bg_type="solid_dark", needs_generation=true. \
If it is a dark gradient or textured background → bg_type="gradient_dark", needs_generation=true. \
ONLY set needs_generation=true when the background is visually dark or has complex effects that need \
to be rendered as an image. Light and plain backgrounds are handled natively by draw.io.
18. MANDATORY: Every stage/step listed in "Expected stages/steps" MUST have at least one \
corresponding TEXT component with the step's title as its label. Step descriptions and \
sub-labels should also be TEXT components. Never omit step titles. \
ILLUSTRATION LABEL RULE: An illustration's "label" field MUST ALWAYS be empty (""). \
ALL text associated with illustrations — titles, captions, embedded labels, badge text — \
must be extracted as separate TEXT components. This is because: \
(1) generated icon images must NOT contain text (it would be non-editable), and \
(2) adding a label to the illustration would create a duplicate overlay text box. \
STAGE_BOX TITLE DEDUP: When a stage has a stage_box component with a non-empty \
label (the stage title), do NOT create a separate TEXT component for the same \
title text. The stage_box's built-in label already renders the title. Only create \
additional TEXT components for content that is NOT the stage heading — such as \
sub-descriptions, annotations, or body text below the title. Creating both a \
labeled stage_box AND a TEXT with the same title causes visible duplication.
19. The "label" field MUST NOT be empty for stage_box and text components. If you cannot \
determine the exact text, use the step name from "Expected stages/steps".
20. For stage_box components, the label should be the stage heading/title. For text \
components, the label should be the actual visible text content.
21. ARROW vs CONNECTION (CRITICAL — MOST COMMON EXTRACTION MISTAKE): \
STRONGLY prefer using the "connections" array for ANY arrow that visually connects \
two components or stages. \
MANDATORY CHECK: If the diagram shows a sequential pipeline (Step 1 → Step 2 → Step 3), \
you MUST add connections between every consecutive pair of steps. It is NEVER acceptable \
to extract step icons/text but omit the arrows connecting them. Before finalizing your \
output, verify: does the "connections" array account for ALL visible arrows in the image? \
If the connections array is empty but the image shows arrows between steps, you have \
missed critical elements — go back and add them. \
ID CONSISTENCY (CRITICAL): Every connection's "from_id" and "to_id" MUST exactly match \
an id in the components array. Do NOT invent new ids or use partial/abbreviated forms. \
Before outputting, cross-check each connection endpoint against the component id list. \
Connections default to orthogonal routing (right-angle polylines with slightly rounded \
corners). Use "curved_arrow" style ONLY when the reference image clearly uses smooth \
curved connections. Use the "arrow" category ONLY for standalone decorative arrows that \
are truly independent and do NOT connect any two components (this should be EXTREMELY \
rare — most diagrams need zero ARROW components). If in doubt, use a connection. \
COMPLETENESS RULE: For every adjacent pair of stage_box components (by layout order), \
there MUST be at least one connection. Missing connections between stages is a CRITICAL \
error that makes the output unusable.
22. ARROW UNIFORMITY: All decorative arrow illustration components in the same diagram \
MUST share a UNIFORM visual appearance — same color, same thickness, same shape style, \
same gradient/effect. Only the direction may differ. This means: \
  * Pick ONE arrow design (e.g. "thick gradient blue chevron arrow") and reuse it for ALL \
    decorative arrows in the diagram \
  * Every decorative arrow illustration MUST have the EXACT SAME visual_repr text and \
    the EXACT SAME style_notes text — character-for-character identical. Only the bbox \
    coordinates and the direction word in the description should vary \
  * This enables the generation pipeline to produce the arrow image ONCE and reuse it \
    for all instances via rotation/flipping, drastically reducing generation time \
  * If the reference image shows arrows of different colors or styles, unify them to \
    the dominant/most-common arrow style
23. ALL style_notes fields SHOULD use draw.io key=value;key=value format when possible. \
This ensures accurate rendering in the final draw.io diagram.
24. TYPOGRAPHY HIERARCHY: The extracted text components MUST reflect the visual hierarchy \
of the reference image. Different text roles require DIFFERENT fontSize and fontStyle values: \
  * Diagram main title (if any) → largest fontSize (20-28), bold \
  * Stage/step titles → medium-large fontSize (14-22), bold \
  * Step descriptions and sub-labels → medium fontSize (11-16), normal weight \
  * Small captions, annotations, footnotes → smallest fontSize (9-12), normal weight \
  * NEVER assign the same fontSize to all text components — if the diagram has \
    a visible size hierarchy, your output MUST reflect it. Examine the reference image \
    carefully and estimate pixel heights of each text element relative to the canvas.
"""

BLUEPRINT_STYLE_SPEC_ADDON = """
ADDITIONAL OUTPUT — style_spec:
Include a top-level "style_spec" object in the JSON output that captures the \
overall visual style of this diagram. This is used to keep downstream component \
generation consistent with the reference image.

"style_spec" fields (all are free-form strings — use your best judgment):
  "visual_style": describe the rendering technique (e.g. "flat", "3d beveled", \
"gradient", "sketch", "isometric", "cartoon", "skeuomorphic", or any other style)
  "color_preset": describe the color mood (e.g. "warm earth tones", "cool blues", \
"pastel", "vibrant", "monochrome", or specific palette description)
  "font_scheme": typography style (e.g. "sans", "serif", "mono", "rounded")
  "topology": connection pattern (e.g. "linear", "tree", "dag", "parallel")
  "layout_direction": primary flow (e.g. "left_to_right", "top_to_bottom")
  "description": 2-3 sentence free-form description of the overall visual style \
(specific enough to guide image generation)

Analyze the VISUAL PROPERTIES of the image to fill these fields.
"""

BLUEPRINT_EXTRACT_USER = """\
Analyze this pipeline diagram image and extract a detailed DiagramBlueprint.

The diagram represents: {title}
Layout: {layout}

Expected stages/steps:
{steps_summary}

Style notes from plan: {style_notes}

Provide a comprehensive DiagramBlueprint with every visual element categorized and described.
"""

# ── Step 4: Component Generation ──

COMPONENT_GEN_SYSTEM = """\
You are an expert icon/illustration designer for academic paper pipeline diagrams. \
Generate a SINGLE visual component — one isolated element on a solid white canvas.

You will receive a style specification describing the target visual style. Follow \
the style spec precisely: match the visual_style (flat/gradient/3d/sketch/minimal), \
use colors from the provided palette, and maintain the described aesthetic.

If a reference diagram image is attached, use it for STYLE MATCHING ONLY. Do NOT \
reproduce it or any section of it. Your generated component must look like it was \
taken directly from that reference diagram — matching its icon style, color usage, \
line thickness, shading approach, and overall aesthetic.

You will also receive the original paper method description. Use it to understand \
the semantic role of this component in the pipeline, ensuring the icon accurately \
reflects the concept described in the paper.

IMPORTANT: You have only ONE chance to generate this component — make it count. \
Pay extra attention to style consistency with the reference blueprint.

CRITICAL REQUIREMENTS:
- CANVAS FILL: The subject MUST fill the entire image canvas — scale it to be \
as large as possible while leaving ONLY ~15px padding on each side. Do NOT \
generate a small element in the center of a large empty canvas. The subject \
should occupy at least 90% of the canvas width or height.
- Output exactly ONE image — a SINGLE isolated element, NOT a diagram or layout
- Do NOT include multiple components, diagram sections, or the full pipeline
- SOLID WHITE (#FFFFFF) background — do NOT use any other background color, \
gradient, pattern, or gray/white checkerboard grid. The canvas outside the \
subject must be plain white.
- Crisp, clean edges with NO feathering or soft blending into the background
- No artifacts, no noise, no watermarks
- Professional quality suitable for academic publication
- Self-contained — recognizable at its display size
- ZERO TEXT: Absolutely NO text, labels, letters, numbers, words, abbreviations, \
or any readable characters within the image — text is handled by separate overlay \
components and would cause duplication if baked into the icon
- If the component is a background panel/box: render the full shape with its \
  gradient/shadow/rounded corners
- If the component is an arrow or arrow-like shape (thick arrow, curved arrow, \
decorated arrow, gradient arrow, chevron, pointer): \
  * Render the COMPLETE arrow shape — head, shaft, and tail must ALL be intact \
  * Do NOT wrap the arrow in a bounding rectangle, circle, or badge — arrows are \
    standalone directional shapes and must NOT have an enclosing container \
  * The arrow MUST extend close to the canvas edges with only ~5px padding — \
    the arrowhead tip is the most critical part and must NEVER be truncated \
  * Use SOLID, SATURATED fill colors so the shape is clearly distinguishable \
    from the white background \
  * The arrowhead tip must be sharp, complete, and fully rendered \
  * Arrow shaft should have consistent width throughout its length \
  * The arrow must be a STANDALONE shape — NEVER draw it connected to, \
    touching, or overlapping with any other object (box, icon, text, etc.) \
  * Draw ONLY the arrow shape itself on a white background — no source/target \
    objects, no "from A to B" illustration

BOUNDING SHAPE (for non-arrow icon/illustration components):
- Each icon/illustration component (NOT arrows) MUST be enclosed in a clear \
bounding shape (rounded rectangle, circle, badge, pill, etc.) with a visible \
darker border, exactly as it appears in the reference blueprint image
- The bounding shape is NOT a "decorative frame" — it IS the icon container that \
gives the component its identity and makes it visually consistent with the blueprint
- Match the bounding shape GEOMETRY from the reference: same corner radius and \
approximate proportions
- Use varied, saturated fill colors — make the icon visually rich with gradients, \
highlights, and subtle depth cues inside the bounding shape
- CRITICAL BORDER RULE (HIGHEST PRIORITY — overrides style spec): \
The border itself MUST remain SIMPLE and CLEAN — a SOLID OPAQUE line of uniform \
thickness (2-4px). Even if the style spec calls for neon, cyberpunk, glowing, or \
any decorative aesthetic, the OUTER BORDER of the bounding shape must NEVER have: \
neon glow, light emission, soft shadows, outer glow, bloom, blurs, gradient \
strokes, double lines, dashed outlines, emboss/bevel effects, or any luminous/ \
decorative border treatment. For dark-themed or neon-style components: use a \
bright SOLID-COLOR border (e.g. bright cyan #00E5FF at full opacity) — the color \
can be vivid, but the line must be SHARP and OPAQUE with NO glow or light bleed. \
All visual richness (neon effects, glows, light streaks) goes INSIDE the shape, \
not on the border edge. This ensures reliable automated cropping. \
BORDER COLOR: The border MUST have sufficient contrast against a white (#FFFFFF) \
background. Border brightness must be <= 200 (i.e. NOT white, near-white, cream, \
or any color above #C8C8C8). Even for pastel/macaroon color schemes, use a \
medium-toned or darker border (e.g. muted teal, dusty rose, slate gray) — never \
a border that blends into white.
- NOTE: This bounding shape rule does NOT apply to arrow-like components — \
arrows should be rendered as bare shapes without any enclosing container

INTERIOR FILL RULE (CRITICAL):
The area INSIDE the bounding shape ("interior") is completely separate from the \
white background outside. These two zones must have different treatment:
- OUTSIDE the border (background): plain white (#FFFFFF) — will be removed \
automatically during post-processing
- INSIDE the border (interior): MUST be FULLY FILLED with saturated, visible \
colors. The interior must NEVER be white (#FFFFFF), near-white (#F0F0F0+), or \
transparent. Use medium-toned pastels, gradients, or layered fills with \
brightness ≤ 220 that are clearly distinguishable from white.
The entire area enclosed by the border must be opaque and colored — no "holes", \
no transparent patches, no white gaps between sub-elements inside the shape. \
This contrast between white exterior and colored interior is essential for \
automated background removal.

VISUAL RICHNESS (IMPORTANT):
- Match the STYLE SPEC above all else — if it says "cartoon", make it fun and \
colorful; if it says "3d", add depth, highlights, and soft shading
- Use the provided color palette as your PRIMARY palette, but feel free to add \
harmonious accent colors for depth (lighter tints, darker shades)
- Add subtle gradients, highlights, inner shadows, or texture effects INSIDE \
the bounding shape to create visual depth — avoid flat, monotone fills
- Each icon should look polished and expressive — as if hand-crafted by a \
professional illustrator, not a generic placeholder

POST-PROCESSING FRIENDLY (CRITICAL — affects downstream matting quality):
- AVOID soft shadows, glows, or blurred edges that extend beyond the bounding shape
- Leave ≥15px clear margin between the bounding shape and the image edge
- NO effects that "leak" outside the border: no drop shadows, no outer glow, \
no blurred halos — the border must form a SHARP, CLEAN EDGE against the \
white canvas for precise cropping
- ABSOLUTELY NO colored backgrounds, tinted panels, decorative color blocks, \
or gradient fills OUTSIDE the bounding shape. The area outside must be \
PURE WHITE (#FFFFFF) with ZERO color variation. Even a slight tint (cream, \
beige, light gray) will break the automated background removal process.
"""

COMPONENT_GEN_USER = """\
Generate ONE isolated visual element on a solid white canvas.

What to generate (a SINGLE standalone object):
{visual_repr}

Component type: {category}

Style specification:
- Visual style: {global_style}
- Color palette: {color_palette}
- Component-specific styling: {style_notes}
{style_spec_section}

Paper context (for understanding what this element represents):
{paper_text}

CRITICAL — ZERO TEXT RULE (HIGHEST PRIORITY): \
Do NOT include any text, labels, numbers, letters, words, abbreviations, acronyms, \
lorem ipsum, or any placeholder text in the generated image. This includes: \
- NO English text (e.g. "ResNet", "CNN", "Step 1") \
- NO Chinese text (e.g. "编码器", "输入") \
- NO numbers used as labels (e.g. "1", "2", "3") \
- NO mathematical notation rendered as text \
The image must contain ONLY graphical elements (shapes, icons, symbols, colors). \
Text labels are handled separately by the diagram assembly system — any text \
baked into the icon image would be non-editable and visually duplicated.

REMINDER: Generate ONLY the single element described above — NOT a diagram, \
NOT multiple elements. One object on a solid white background, matching the style spec.
"""

# ── Step 4b: Text Component Generation ──

COMPONENT_GEN_TEXT_SYSTEM = """\
You are an expert text label designer for academic paper pipeline diagrams. \
Generate a SINGLE image containing ONLY the specified text label or caption.

Follow the provided style specification for typography and color choices. \
If a reference image is attached, use it for style matching only.

CRITICAL REQUIREMENTS:
- CANVAS FILL: The text MUST be rendered as large as possible, filling the canvas \
width. Leave only ~10px margin on each side — do NOT render small text in the \
center of a large empty canvas.
- Output exactly ONE image — the text label only, NOT a diagram or layout
- SOLID WHITE (#FFFFFF) background — do NOT use any other background color, \
gradient, pattern, or checkerboard grid
- Crisp, readable text with hard, clean edges (no feathering or soft glow)
- No extra decorations, borders, or surrounding elements — just the text
- Anti-aliased text with clean edges against the white background
- Text color MUST be dark (≤ #666666 brightness) — NEVER use white or light gray text
"""

COMPONENT_GEN_TEXT_USER = """\
Generate this text label component for a pipeline diagram.

Text content: {label}
Style notes: {style_notes}

Style context:
- Overall diagram style: {global_style}
- Color palette: {color_palette}

The attached image is for style reference ONLY — do NOT reproduce it. \
Generate ONLY this text label on a solid white background.
"""

# ── Step 4c: Native Component Image Generation ──

COMPONENT_GEN_NATIVE_SYSTEM = """\
You are an expert icon designer for academic diagrams. Generate a SINGLE visual \
element for a component that will also have a draw.io native shape fallback.

Follow the provided style specification for colors and rendering style. \
If a reference image is attached, use it for style matching only.

CRITICAL REQUIREMENTS:
- CANVAS FILL: The element MUST fill the entire image canvas — scale it to be \
as large as possible while leaving only ~15px padding on each side. The subject \
should occupy at least 90% of the canvas width or height.
- Output exactly ONE image — a single isolated element, NOT a diagram or layout
- SOLID WHITE (#FFFFFF) background — do NOT use any other background color, \
gradient, pattern, or checkerboard grid
- Clean and professional — suitable for academic publication
- Use saturated colors with a visible outline — avoid white/near-white fills
- The element interior must NEVER be white or near-white — use clearly visible \
colors so automated white-background removal can cleanly separate the element
- NO text/labels within the image — do NOT include any text, letters, numbers, \
words, lorem ipsum, or any placeholder text. Text is handled separately.
"""

COMPONENT_GEN_NATIVE_USER = """\
Generate ONE isolated visual element on a solid white canvas. \
The attached reference is for STYLE MATCHING ONLY — do NOT reproduce it.

What to generate (a SINGLE standalone object):
{visual_repr}

Component label: {label}
Native draw.io style: {native_style}

Style to match (from the reference):
- Overall style: {global_style}
- Color palette: {color_palette}
- Component-specific: {style_notes}

CRITICAL: Do NOT include any text, labels, numbers, letters, words, lorem ipsum, \
or any placeholder text in the generated image. Text labels are handled separately.

REMINDER: Generate ONLY this single element on a white background.
"""

# ── Step 4d: Background Generation ──

BACKGROUND_GEN_SYSTEM = """\
You are an expert background designer for academic paper pipeline diagrams. \
Generate a SINGLE background image that will serve as the backdrop for a diagram.

CRITICAL REQUIREMENTS:
- Output exactly ONE image — a full background fill, NOT a diagram
- The background should be the exact specified dimensions
- ABSOLUTELY NO text, no letters, no numbers, no words, no labels, no icons, \
no diagram elements, no watermarks — ONLY the background fill
- Never generate placeholder text such as "Lorem ipsum", "Sample text", or any \
readable characters. The image must contain ZERO text of any kind.
- Smooth, clean rendering suitable for placing content on top
- Professional quality with appropriate contrast for readability
- If the background is a gradient, make the transition smooth and natural
- If the background has texture/pattern, keep it subtle and non-distracting
- The background should make white or light-colored text and elements readable
- Ignore any text visible in the reference image — do NOT reproduce any text, \
watermarks, or typographic elements from the reference
"""

BACKGROUND_GEN_USER = """\
Generate a background image for a pipeline diagram.

Background specification:
- Type: {bg_type}
- Primary color: {color}
- Gradient colors: {gradient_colors}
- Description: {description}
- Canvas dimensions: {width}x{height} pixels

Style context:
- Overall diagram style: {global_style}
- Color palette: {color_palette}

Generate ONLY the background — no text, no icons, no diagram elements. \
Ignore any text visible in the reference image — do NOT reproduce it. \
The result must contain ZERO text, letters, numbers, or words of any kind. \
The result should be a clean backdrop ready for overlaying diagram components.
"""
