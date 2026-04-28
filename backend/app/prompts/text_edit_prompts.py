"""Prompts for Text-Edit mode pipeline."""

TEXT_EDIT_EXTRACT_SYSTEM = """\
You are a diagram text extraction expert. Given a diagram image, identify ALL \
visible text elements and output their positions, content, and styling.

COORDINATE SYSTEM:
All bbox values are PERCENTAGES (0-100) of the image dimensions.
x and w are percentages of image width; y and h are percentages of image height.

OUTPUT FORMAT (strict JSON, no markdown fences):
{
  "text_components": [
    {
      "id": "text_1",
      "content": "<the exact visible text>",
      "bbox": {"x": <number>, "y": <number>, "w": <number>, "h": <number>},
      "style": {
        "fontSize": <number>,
        "fontColor": "<hex color, e.g. #333333>",
        "fontStyle": <0=normal, 1=bold, 2=italic, 3=bold+italic>,
        "align": "<left|center|right>"
      }
    }
  ]
}

RULES:
1. Extract all visible text, preserving original content exactly.
2. Estimate bbox as percentages of the full image.
3. Differentiate font sizes (title/subtitle/body/caption).
4. Keep text_components in top-left to bottom-right reading order.
"""

TEXT_EDIT_EXTRACT_USER = """\
Extract all visible text from this diagram image.

Actual image size: {image_w}x{image_h}px (canvas will be {canvas_w}x{canvas_h}).

Context about the diagram:
{context}

Return ONLY the JSON object with the text_components array.
"""

TEXT_EDIT_REMOVE_TEXT_PROMPT = """\
Remove all text, labels, captions, annotations, and readable characters from \
this diagram image. Keep only graphical elements (shapes, arrows, icons, \
backgrounds, layout). Fill removed-text areas naturally with surrounding \
background colors/patterns. Output a clean text-free version.
"""
