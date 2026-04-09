"""Pillow-based composite preview renderer for v0.4 Full Generation Pipeline.

Renders a DiagramBlueprint + generated component images onto a white canvas
to produce a preview PNG for LLM-based consistency checks and global comparisons.
"""

import base64
import io
import logging
import math

from PIL import Image, ImageDraw, ImageFont

from app.schemas.paper import BlueprintComponent, ComponentCategory, DiagramBlueprint

logger = logging.getLogger(__name__)

_FONT_CACHE: dict[int, ImageFont.FreeTypeFont | ImageFont.ImageFont] = {}


def _get_font(size: int = 14) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    if size in _FONT_CACHE:
        return _FONT_CACHE[size]
    for path in [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/SFNSText.ttf",
        "/System/Library/Fonts/STHeiti Light.ttc",
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    ]:
        try:
            font = ImageFont.truetype(path, size)
            _FONT_CACHE[size] = font
            return font
        except (OSError, IOError):
            continue
    font = ImageFont.load_default()
    _FONT_CACHE[size] = font
    return font


def _get_bold_font(size: int = 14) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    cache_key = size + 10000
    if cache_key in _FONT_CACHE:
        return _FONT_CACHE[cache_key]
    for path in [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/SFNSText.ttf",
        "/System/Library/Fonts/PingFang.ttc",
    ]:
        try:
            font = ImageFont.truetype(path, size)
            _FONT_CACHE[cache_key] = font
            return font
        except (OSError, IOError):
            continue
    return _get_font(size)


def _hex_to_rgba(hex_color: str, alpha: int = 255) -> tuple[int, int, int, int]:
    h = hex_color.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    if len(h) < 6:
        h = h.ljust(6, "0")
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return (r, g, b, alpha)


def _parse_color_from_style(style_notes: str, key: str = "fillColor") -> str | None:
    """Extract a hex color value from a draw.io style-like string."""
    for part in style_notes.replace(";", " ").replace(",", " ").split():
        if "=" in part:
            k, v = part.split("=", 1)
            if k.strip().lower() == key.lower() and v.strip().startswith("#"):
                return v.strip()
    if style_notes.strip().startswith("#") and len(style_notes.strip()) <= 9:
        return style_notes.strip()
    return None


class PreviewRenderer:
    """Render a DiagramBlueprint to a composite Pillow image."""

    @staticmethod
    def render(
        blueprint: DiagramBlueprint,
        component_images: dict[str, str],
        *,
        bg_color: str = "#FFFFFF",
    ) -> str:
        """Render a composite preview image.

        Args:
            blueprint: The diagram blueprint with component positions.
            component_images: Mapping of component_id -> base64 PNG.
            bg_color: Canvas background color.

        Returns:
            Base64-encoded PNG of the composite preview.
        """
        w = int(blueprint.canvas_width)
        h = int(blueprint.canvas_height)
        canvas = Image.new("RGBA", (w, h), _hex_to_rgba(bg_color))
        draw = ImageDraw.Draw(canvas)

        sorted_components = sorted(blueprint.components, key=lambda c: c.z_order)

        for comp in sorted_components:
            try:
                if comp.category == ComponentCategory.STAGE_BOX:
                    _draw_stage_box(draw, comp)
                elif comp.category == ComponentCategory.ARROW:
                    _draw_arrow(draw, comp)
                elif comp.category == ComponentCategory.TEXT:
                    _draw_text(draw, comp)
                elif comp.category == ComponentCategory.ILLUSTRATION:
                    _draw_illustration(canvas, comp, component_images)
            except Exception:
                logger.warning("Failed to render component %s", comp.id, exc_info=True)

        for conn in blueprint.connections:
            _draw_connection(draw, conn, blueprint)

        flat = Image.new("RGB", canvas.size, (255, 255, 255))
        flat.paste(canvas, mask=canvas.split()[3])

        buf = io.BytesIO()
        flat.save(buf, format="PNG")
        return base64.b64encode(buf.getvalue()).decode()


def _draw_stage_box(draw: ImageDraw.Draw, comp: BlueprintComponent) -> None:
    x, y, w, h = int(comp.bbox.x), int(comp.bbox.y), int(comp.bbox.w), int(comp.bbox.h)

    fill_color = _parse_color_from_style(comp.style_notes, "fillColor")
    if not fill_color:
        fill_color = "#E3F2FD"
    stroke_color = _parse_color_from_style(comp.style_notes, "strokeColor")
    if not stroke_color:
        stroke_color = "#90CAF9"

    radius = 8
    draw.rounded_rectangle(
        [x, y, x + w, y + h],
        radius=radius,
        fill=_hex_to_rgba(fill_color, 180),
        outline=_hex_to_rgba(stroke_color),
        width=2,
    )

    if comp.label:
        font_size = 13
        font = _get_bold_font(font_size)
        font_color = _parse_color_from_style(comp.style_notes, "fontColor") or "#333333"
        bbox = font.getbbox(comp.label)
        text_w = bbox[2] - bbox[0]
        text_x = x + (w - text_w) // 2
        text_y = y + 6
        draw.text(
            (text_x, text_y), comp.label,
            fill=_hex_to_rgba(font_color), font=font,
        )


def _draw_arrow(draw: ImageDraw.Draw, comp: BlueprintComponent) -> None:
    x, y, w, h = int(comp.bbox.x), int(comp.bbox.y), int(comp.bbox.w), int(comp.bbox.h)
    color = _parse_color_from_style(comp.style_notes, "strokeColor") or "#666666"
    rgba = _hex_to_rgba(color)

    if w > h:
        start = (x, y + h // 2)
        end = (x + w, y + h // 2)
    else:
        start = (x + w // 2, y)
        end = (x + w // 2, y + h)

    draw.line([start, end], fill=rgba, width=2)
    _draw_arrowhead(draw, start, end, rgba)

    if comp.label:
        font = _get_font(10)
        font_color = _parse_color_from_style(comp.style_notes, "fontColor") or "#666666"
        mx = (start[0] + end[0]) // 2
        my = (start[1] + end[1]) // 2
        bbox = font.getbbox(comp.label)
        text_w = bbox[2] - bbox[0]
        draw.text(
            (mx - text_w // 2, my - 10), comp.label,
            fill=_hex_to_rgba(font_color), font=font,
        )


def _draw_arrowhead(
    draw: ImageDraw.Draw,
    start: tuple[int, int],
    end: tuple[int, int],
    color: tuple[int, int, int, int],
    size: int = 10,
) -> None:
    dx = end[0] - start[0]
    dy = end[1] - start[1]
    length = math.sqrt(dx * dx + dy * dy)
    if length < 1:
        return
    udx, udy = dx / length, dy / length

    px = end[0] - udx * size
    py = end[1] - udy * size

    lx = px - udy * size * 0.5
    ly = py + udx * size * 0.5
    rx = px + udy * size * 0.5
    ry = py - udx * size * 0.5

    draw.polygon([(end[0], end[1]), (int(lx), int(ly)), (int(rx), int(ry))], fill=color)


def _wrap_text(text: str, font: ImageFont.FreeTypeFont | ImageFont.ImageFont, max_width: int) -> list[str]:
    """Break text into lines that fit within max_width pixels."""
    if max_width <= 0:
        return [text]
    words = text.split()
    if not words:
        return [text]
    lines: list[str] = []
    current_line = words[0]
    for word in words[1:]:
        candidate = f"{current_line} {word}"
        bbox = font.getbbox(candidate)
        if (bbox[2] - bbox[0]) <= max_width:
            current_line = candidate
        else:
            lines.append(current_line)
            current_line = word
    lines.append(current_line)
    return lines


def _draw_text(draw: ImageDraw.Draw, comp: BlueprintComponent) -> None:
    x, y = int(comp.bbox.x), int(comp.bbox.y)
    max_w = int(comp.bbox.w)
    text = comp.label or ""
    if not text:
        return

    font_size = 14
    notes_lower = comp.style_notes.lower()
    if "bold" in notes_lower or "title" in notes_lower:
        font_size = 18
    elif "caption" in notes_lower or "small" in notes_lower:
        font_size = 11

    color_hex = _parse_color_from_style(comp.style_notes, "fontColor") or "#333333"
    use_bold = "bold" in notes_lower or "title" in notes_lower
    font = _get_bold_font(font_size) if use_bold else _get_font(font_size)
    rgba = _hex_to_rgba(color_hex)

    lines = _wrap_text(text, font, max_w) if max_w > 0 else [text]
    line_height = font_size + 4
    for i, line in enumerate(lines):
        draw.text((x, y + i * line_height), line, fill=rgba, font=font)


def _draw_illustration(
    canvas: Image.Image,
    comp: BlueprintComponent,
    component_images: dict[str, str],
) -> None:
    img_b64 = component_images.get(comp.id)
    if not img_b64:
        return

    img = Image.open(io.BytesIO(base64.b64decode(img_b64))).convert("RGBA")
    target_w = max(1, int(comp.bbox.w))
    target_h = max(1, int(comp.bbox.h))
    img = img.resize((target_w, target_h), Image.LANCZOS)

    paste_x = int(comp.bbox.x)
    paste_y = int(comp.bbox.y)
    canvas.paste(img, (paste_x, paste_y), img)

    if comp.label:
        draw = ImageDraw.Draw(canvas)
        font = _get_font(10)
        font_color = _parse_color_from_style(comp.style_notes, "fontColor") or "#555555"
        bbox = font.getbbox(comp.label)
        text_w = bbox[2] - bbox[0]
        label_x = paste_x + (target_w - text_w) // 2
        label_y = paste_y + target_h + 4
        draw.text(
            (label_x, label_y), comp.label,
            fill=_hex_to_rgba(font_color), font=font,
        )


def _draw_connection(
    draw: ImageDraw.Draw,
    conn,
    blueprint: DiagramBlueprint,
) -> None:
    comp_map = {c.id: c for c in blueprint.components}
    src = comp_map.get(conn.from_id)
    dst = comp_map.get(conn.to_id)
    if not src or not dst:
        return

    sx = int(src.bbox.x + src.bbox.w / 2)
    sy = int(src.bbox.y + src.bbox.h / 2)
    ex = int(dst.bbox.x + dst.bbox.w / 2)
    ey = int(dst.bbox.y + dst.bbox.h / 2)

    color = _hex_to_rgba("#888888")
    draw.line([(sx, sy), (ex, ey)], fill=color, width=2)
    _draw_arrowhead(draw, (sx, sy), (ex, ey), color)

    if conn.label:
        mx, my = (sx + ex) // 2, (sy + ey) // 2
        font = _get_font(11)
        draw.text((mx, my - 8), conn.label, fill=_hex_to_rgba("#666666"), font=font)
