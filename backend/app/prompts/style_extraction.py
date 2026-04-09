"""Prompts for extracting StyleSpec from a reference diagram image."""

STYLE_EXTRACT_SYSTEM = """\
You are an expert at analyzing academic diagram visual styles. Given a reference \
diagram image, extract a structured StyleSpec describing its visual properties.

OUTPUT FORMAT (strict JSON, no markdown fences):
{{
  "visual_style": "<one of the visual_style options>",
  "color_preset": "<closest matching color preset>",
  "font_scheme": "<one of the font_scheme options>",
  "topology": "<one of the topology options>",
  "layout_direction": "<one of the layout_direction options>",
  "description": "<2-3 sentence description of the overall visual style>"
}}

FIELD DEFINITIONS:
- visual_style: The dominant rendering technique.
  - "flat": Solid colors, no shadows or gradients.
  - "academic": Clean academic illustration style with structured layouts.
  - "cartoon": Bold outlines, playful colors, rounded shapes.
  - "3d": Perspective, drop shadows, depth effects.
  - "isometric": Isometric projection, 3D-like without perspective distortion.
  - "sketch": Hand-drawn, informal look.
  - "minimal": Very sparse, lots of whitespace, thin lines.
  - "gradient": Smooth color transitions, soft shadows.
  - "linear": Simple line-art style with minimal fills.
  - "skeuomorphic": Realistic textures, detailed shading mimicking physical objects.
- color_preset: Closest matching preset from the following options.
  - "pastel": Soft, light, muted tones (pastels).
  - "vibrant": Bright, saturated, vivid colors.
  - "academic_blue": Blue-dominant professional academic palette.
  - "warm": Orange, red, yellow warm tones.
  - "cool": Blue, cyan, teal cool tones.
  - "natural_green": Green-dominant earthy, natural palette.
  - "violet": Purple/violet-dominant palette.
  - "monochrome": Grayscale only.
  - "high_contrast": Black + strong accent colors with high contrast.
  - "sunset": Orange-red warm sunset gradient palette.
- font_scheme: Observed typography style.
  - "sans": Clean sans-serif (Helvetica, Arial).
  - "serif": Traditional serif (Times, Georgia).
  - "mono": Monospace / code-like.
  - "handwritten": Casual, hand-written style fonts.
  - "rounded": Rounded, friendly typefaces (Nunito, Varela Round).
- topology: The connection pattern between components.
  - "linear": Sequential chain flow.
  - "tree": Tree-like branching with splits.
  - "dag": Directed acyclic graph with merges.
  - "cyclic": Contains feedback loops.
  - "parallel": Multiple parallel processing paths.
  - "hierarchical": Multi-level parent-child structure.
  - "u_shape": U-shaped encoder-decoder style layout.
- layout_direction: Primary flow direction.
  - "left_to_right": Horizontal left-to-right flow.
  - "top_to_bottom": Vertical top-to-bottom flow.
  - "bottom_to_top": Vertical bottom-to-top flow.
  - "radial": Center-outward radial layout.
- description: Free-form style description capturing nuances not covered by enums.

RULES:
1. Analyze the VISUAL PROPERTIES only, not the content/topic.
2. Choose the closest matching color_preset for the dominant color mood.
3. description should be specific enough to guide an image generation model.
4. Output ONLY the JSON. No explanations.
"""

STYLE_EXTRACT_USER = """\
Analyze this diagram image and extract its visual style properties as a StyleSpec.

Focus on: rendering technique, color mood/preset, typography, layout flow, and \
connection topology. Describe the style in enough detail to reproduce it.
"""
