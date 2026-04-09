"""Prompts for AI asset generation (icon / illustration generation)."""

STYLE_DESCRIPTIONS: dict[str, str] = {
    "thin_linear": (
        "Thin line art icon style. Use very thin, delicate strokes (1-1.5px). "
        "Clean and minimalist. Monochrome outline only, no fills. "
        "Suitable for professional scientific diagrams."
    ),
    "regular_linear": (
        "Regular line art icon style. Use standard weight strokes (2px). "
        "Clean outlines with occasional geometric detail. Monochrome. "
        "Balanced between detail and clarity."
    ),
    "bold_linear": (
        "Bold line art icon style. Use thick, confident strokes (3-4px). "
        "Strong outlines, heavy weight. Monochrome. "
        "High contrast, excellent readability at small sizes."
    ),
    "minimal_flat": (
        "Minimal flat design style. Use solid color fills with no outlines or very subtle edges. "
        "Simple geometric shapes, limited color palette (2-3 colors). "
        "Modern and clean, suitable for infographics."
    ),
    "doodle": (
        "Hand-drawn doodle style. Use slightly wobbly, organic lines as if drawn by hand. "
        "Casual and approachable. May include small imperfections for charm. "
        "Monochrome or limited color, sketch-like feel."
    ),
    "hand_drawn": (
        "Artistic hand-drawn style. Watercolor or pencil texture feel. "
        "Organic lines with visible brushwork. Warm and natural color tones. "
        "More refined than doodle, with artistic quality. "
        "Ensure crisp, well-defined edges for easy background removal."
    ),
    "illustration": (
        "Full-color illustration style. Rich details, vivid colors, and subtle shading/gradients. "
        "Professional quality suitable for presentations. "
        "Balanced realism with stylized elements. "
        "Ensure crisp, well-defined edges for easy background removal."
    ),
    "detailed_linear": (
        "Detailed line art style. Intricate fine lines with cross-hatching and texture details. "
        "More complex than regular linear. Monochrome. "
        "Suitable for technical or scientific illustrations."
    ),
    "fine_linear": (
        "Ultra-fine line art style. Extremely thin, precise strokes (0.5-1px). "
        "Highly refined and elegant. Monochrome outline only. "
        "Best for high-resolution output where fine detail shines."
    ),
    "custom": (
        "Follow the user-provided style description exactly."
    ),
}

ASSET_GEN_SYSTEM = """\
You are an expert icon and illustration designer. Generate a single high-quality \
image based on the user's description and the specified visual style.

CANVAS: The output image MUST be SQUARE (1:1 aspect ratio). \
Target 4096×4096 pixels — generate at the HIGHEST resolution possible.

Rules:
- Output EXACTLY ONE image per request.
- The image MUST have a CLEAN, SOLID WHITE or TRANSPARENT background — \
absolutely NO gradients, patterns, textures, or colored backgrounds.
- Ensure HIGH CONTRAST between the subject and the background.
- The subject MUST NOT blend into or touch the edges of the image.
- Leave generous padding (at least 15px on each side) around the subject.
- For line art styles, use DARK lines on WHITE background for clean separation.
- The subject should be centered with balanced padding.
- Keep the composition simple and iconic — this will be used as a diagram component.
- Do NOT add any text, labels, watermarks, or frames to the image.
- Match the specified style precisely.

BACKGROUND-REMOVAL FRIENDLY (critical for cutout/matting):
- Edges of the subject MUST be crisp and well-defined — NO feathering, \
soft blending, or anti-aliased transitions into the background.
- Do NOT add soft shadows, glow effects, or blurry halos around the subject.
- Fill the subject with saturated, medium-to-dark colors. AVOID white, \
near-white, or very light fills — they become invisible when placed on \
a white canvas after background removal.
- Use solid colors or simple gradients INSIDE the subject; avoid \
transparency or semi-transparency within the subject itself.
- If transparent PNG output is not possible, use a PURE WHITE (#FFFFFF) \
background with a clearly visible dark outline around the subject to \
ensure clean separation during automated background removal.
- ABSOLUTELY NO colored backgrounds, tinted panels, decorative color blocks, \
or gradient fills OUTSIDE the bounding shape. The area outside must be \
PURE WHITE (#FFFFFF) with ZERO color variation. Even a slight tint will \
break the automated background removal process.
"""

ASSET_GEN_USER = """\
Description: {description}

Visual style: {style_name}
Style details: {style_description}

Generate this as a clean, isolated icon/illustration on a SQUARE white canvas \
(1:1 aspect ratio, target 4096×4096 pixels). \
No text, no labels, no decorative borders. The subject should be clearly recognizable \
and suitable for use in an academic pipeline diagram. \
Be creative and produce a unique interpretation. Vary the composition, angle, or detail level.
"""

ASSET_RESTYLE_SYSTEM = """\
You are an expert icon and illustration designer specializing in style transfer. \
Given a reference image, recreate it in the specified visual style while preserving \
its core subject and composition.

CANVAS: The output image MUST be SQUARE (1:1 aspect ratio). \
Target 4096×4096 pixels — generate at the HIGHEST resolution possible.

Rules:
- Preserve the subject matter and general composition of the reference image.
- Apply the target visual style precisely.
- Output MUST have a CLEAN, SOLID WHITE or TRANSPARENT background.
- Do NOT add any text, labels, watermarks, or frames.
- Keep the result clean and suitable for use as a diagram component.
"""

ASSET_RESTYLE_USER = """\
Recreate this image in the following visual style:

Visual style: {style_name}
Style details: {style_description}

Preserve the subject and composition but transform the artistic style. \
Output on a clean white background with no text or borders.
"""
