"""Draw.io XML assembly from blueprint + component images."""

import logging

from app.schemas.paper import ComponentCategory, DiagramBlueprint, StyleSpec
from app.services.pipeline.image_processor import ImageProcessor
from app.services.pipeline.style_utils import (
    FONT_FAMILY_MAP,
    get_connection_color,
    parse_style_notes,
)
from app.utils.xml_utils import sanitize_mxcells, wrap_with_mxfile

logger = logging.getLogger(__name__)

_IMAGE_CELL_STYLE = (
    "html=1;overflow=fill;whiteSpace=wrap;"
    "verticalAlign=middle;align=center;"
    "fillColor=none;strokeColor=none;"
)

_STAGE_BOX_DEFAULTS: dict[str, str] = {
    "rounded": "1", "whiteSpace": "wrap", "html": "1",
    "arcSize": "8", "opacity": "70",
    "fillColor": "#E3F2FD", "strokeColor": "#90CAF9",
    "fontSize": "13", "fontColor": "#333333", "fontStyle": "1",
    "verticalAlign": "top", "spacingTop": "8", "align": "center",
}

_TEXT_DEFAULTS: dict[str, str] = {
    "text": "", "html": "1", "align": "center",
    "verticalAlign": "middle", "whiteSpace": "wrap",
    "fontSize": "14", "fontColor": "#333333", "fontStyle": "0",
    "fillColor": "none", "strokeColor": "none",
}

_ARROW_DEFAULTS: dict[str, str] = {
    "shape": "flexArrow", "html": "1",
    "fillColor": "#616161", "strokeColor": "#616161",
    "strokeWidth": "2", "startWidth": "8", "endWidth": "8",
    "startSize": "5", "endSize": "5",
}

_CONNECTION_DEFAULTS: dict[str, str] = {
    "edgeStyle": "orthogonalEdgeStyle", "rounded": "1",
    "orthogonalLoop": "1", "jettySize": "auto", "html": "1",
    "strokeColor": "#616161", "strokeWidth": "2",
    "fontSize": "10", "fontColor": "#666666",
}


def _img_html(img_b64: str) -> str:
    """Build HTML-escaped <img> tag for embedding base64 image in draw.io cell value."""
    return (
        f'&lt;img src=&quot;data:image/png;base64,{img_b64}&quot; '
        f'width=&quot;100%&quot; height=&quot;100%&quot;/&gt;'
    )


def xml_escape(text: str) -> str:
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )


def assemble_drawio_xml(
    blueprint: DiagramBlueprint,
    component_images: dict[str, str],
    style_spec: StyleSpec | None = None,
    background_image: str | None = None,
) -> str:
    """Assemble a complete draw.io XML from blueprint components and generated images."""
    cells: list[str] = []
    cell_id = 2
    all_cell_ids: dict[str, str] = {}

    font_family = FONT_FAMILY_MAP.get(
        style_spec.font_scheme if style_spec and style_spec.font_scheme else "sans",
        "Helvetica",
    )

    bg = blueprint.background
    if background_image:
        cells.append(
            f'<mxCell id="{cell_id}" value="{_img_html(background_image)}" '
            f'vertex="1" parent="1" style="{_IMAGE_CELL_STYLE}">'
            f'<mxGeometry x="0" y="0" '
            f'width="{blueprint.canvas_width}" height="{blueprint.canvas_height}" as="geometry"/>'
            f"</mxCell>"
        )
        cell_id += 1
    elif bg.bg_type in ("solid_dark", "solid_light") and bg.color:
        bg_style = (
            f"rounded=0;whiteSpace=wrap;html=1;"
            f"fillColor={bg.color};strokeColor=none;"
        )
        cells.append(
            f'<mxCell id="{cell_id}" value="" '
            f'vertex="1" parent="1" style="{bg_style}">'
            f'<mxGeometry x="0" y="0" '
            f'width="{blueprint.canvas_width}" height="{blueprint.canvas_height}" as="geometry"/>'
            f"</mxCell>"
        )
        cell_id += 1

    sorted_components = sorted(blueprint.components, key=lambda c: c.z_order)

    for comp in sorted_components:
        eid = comp.id
        all_cell_ids[comp.id] = eid

        if comp.category == ComponentCategory.STAGE_BOX:
            sb_overrides = parse_style_notes(comp.style_notes)
            if "fontFamily" not in sb_overrides:
                sb_overrides["fontFamily"] = font_family
            merged_sb = {**_STAGE_BOX_DEFAULTS, **sb_overrides}
            style = ";".join(f"{k}={v}" for k, v in merged_sb.items()) + ";"
            label = xml_escape(comp.label) if comp.label else ""
            cells.append(
                f'<mxCell id="{eid}" value="{label}" '
                f'vertex="1" parent="1" style="{style}">'
                f'<mxGeometry x="{comp.bbox.x}" y="{comp.bbox.y}" '
                f'width="{comp.bbox.w}" height="{comp.bbox.h}" as="geometry"/>'
                f"</mxCell>"
            )

        elif comp.category == ComponentCategory.ILLUSTRATION:
            if comp.use_native and comp.native_style:
                style = comp.native_style
                if not style.endswith(";"):
                    style += ";"
                label = xml_escape(comp.label) if comp.label else ""
                cells.append(
                    f'<mxCell id="{eid}" value="{label}" '
                    f'vertex="1" parent="1" style="{style}">'
                    f'<mxGeometry x="{comp.bbox.x}" y="{comp.bbox.y}" '
                    f'width="{comp.bbox.w}" height="{comp.bbox.h}" as="geometry"/>'
                    f"</mxCell>"
                )
            elif comp.id in component_images:
                img_b64 = component_images[comp.id]
                comp_name = comp.name or comp.label or comp.id
                cx_r, cy_r, cw_r, ch_r = ImageProcessor.content_bbox_ratios(img_b64)
                geo_x = comp.bbox.x + comp.bbox.w * cx_r
                geo_y = comp.bbox.y + comp.bbox.h * cy_r
                geo_w = comp.bbox.w * cw_r
                geo_h = comp.bbox.h * ch_r
                cells.append(
                    f'<UserObject label="{_img_html(img_b64)}" '
                    f'nanadraw_name="{xml_escape(comp_name)}" '
                    f'nanadraw_visual_repr="{xml_escape(comp.visual_repr or "")}" '
                    f'nanadraw_category="{comp.category.value}" '
                    f'nanadraw_style_notes="{xml_escape(comp.style_notes or "")}" '
                    f'id="{eid}">'
                    f'<mxCell vertex="1" parent="1" style="{_IMAGE_CELL_STYLE}">'
                    f'<mxGeometry x="{geo_x}" y="{geo_y}" '
                    f'width="{geo_w}" height="{geo_h}" as="geometry"/>'
                    f"</mxCell>"
                    f"</UserObject>"
                )
            else:
                style = (
                    "rounded=1;whiteSpace=wrap;html=1;arcSize=20;"
                    "fillColor=#F5F5F5;strokeColor=#BDBDBD;strokeWidth=2;"
                    "fontSize=11;fontColor=#666666;"
                )
                label = xml_escape(comp.label or "?")
                cells.append(
                    f'<mxCell id="{eid}" value="{label}" '
                    f'vertex="1" parent="1" style="{style}">'
                    f'<mxGeometry x="{comp.bbox.x}" y="{comp.bbox.y}" '
                    f'width="{comp.bbox.w}" height="{comp.bbox.h}" as="geometry"/>'
                    f"</mxCell>"
                )

            has_generated_image = comp.id in component_images
            if comp.label and not has_generated_image:
                label_id = f"{comp.id}_lbl"
                label_text = xml_escape(comp.label)
                comp_notes = parse_style_notes(comp.style_notes)
                lbl_font_size = comp_notes.get("fontSize", "11")
                lbl_font_color = comp_notes.get("fontColor", "#555555")
                lbl_font_style = comp_notes.get("fontStyle", "0")
                label_style = (
                    f"text;html=1;align=center;verticalAlign=top;"
                    f"whiteSpace=wrap;fontFamily={font_family};"
                    f"fontSize={lbl_font_size};fontColor={lbl_font_color};"
                    f"fontStyle={lbl_font_style};"
                )
                label_y = comp.bbox.y + comp.bbox.h + 4
                label_w = max(comp.bbox.w, 80)
                label_x = comp.bbox.x - (label_w - comp.bbox.w) / 2
                lbl_size_int = max(10, int(float(lbl_font_size)))
                chars_per_line = max(1, int(label_w / max(6, lbl_size_int * 0.6)))
                label_h = max(24, (lbl_size_int + 4) * ((len(comp.label) // chars_per_line) + 1))
                cells.append(
                    f'<mxCell id="{label_id}" value="{label_text}" '
                    f'vertex="1" parent="1" style="{label_style}">'
                    f'<mxGeometry x="{label_x}" y="{label_y}" '
                    f'width="{label_w}" height="{label_h}" as="geometry"/>'
                    f"</mxCell>"
                )

        elif comp.category == ComponentCategory.TEXT:
            text_overrides = parse_style_notes(comp.style_notes)
            if "fontFamily" not in text_overrides:
                text_overrides["fontFamily"] = font_family
            merged = {**_TEXT_DEFAULTS, **text_overrides}
            style = ";".join(f"{k}={v}" for k, v in merged.items()) + ";"
            label = xml_escape(comp.label or "")
            cells.append(
                f'<mxCell id="{eid}" value="{label}" '
                f'vertex="1" parent="1" style="{style}">'
                f'<mxGeometry x="{comp.bbox.x}" y="{comp.bbox.y}" '
                f'width="{comp.bbox.w}" height="{comp.bbox.h}" as="geometry"/>'
                f"</mxCell>"
            )

        elif comp.category == ComponentCategory.ARROW:
            arrow_overrides = parse_style_notes(comp.style_notes)
            arrow_merged = {**_ARROW_DEFAULTS, **arrow_overrides}
            aw, ah = comp.bbox.w, comp.bbox.h
            is_vertical = aw < ah
            if is_vertical:
                arrow_merged["direction"] = "south"
                aw = max(20, min(aw, 40))
                ah = max(40, min(ah, 100))
            else:
                aw = max(40, min(aw, 100))
                ah = max(20, min(ah, 40))
            style = ";".join(f"{k}={v}" for k, v in arrow_merged.items()) + ";"
            label = xml_escape(comp.label) if comp.label else ""
            cells.append(
                f'<mxCell id="{eid}" value="{label}" '
                f'vertex="1" parent="1" style="{style}">'
                f'<mxGeometry x="{comp.bbox.x}" y="{comp.bbox.y}" '
                f'width="{aw}" height="{ah}" as="geometry"/>'
                f"</mxCell>"
            )

    comp_bboxes = {c.id: c.bbox for c in blueprint.components}
    arrow_centers: list[tuple[float, float]] = []
    for c in blueprint.components:
        if c.category == ComponentCategory.ARROW:
            arrow_centers.append((
                c.bbox.x + c.bbox.w / 2,
                c.bbox.y + c.bbox.h / 2,
            ))

    def _arrow_between(from_id: str, to_id: str) -> bool:
        """Check if an ARROW component sits spatially between two components."""
        if not arrow_centers:
            return False
        sb = comp_bboxes.get(from_id)
        tb = comp_bboxes.get(to_id)
        if sb is None or tb is None:
            return False
        src_cx, src_cy = sb.x + sb.w / 2, sb.y + sb.h / 2
        tgt_cx, tgt_cy = tb.x + tb.w / 2, tb.y + tb.h / 2
        margin = 15
        lo_x = min(src_cx, tgt_cx) - margin
        hi_x = max(src_cx, tgt_cx) + margin
        lo_y = min(src_cy, tgt_cy) - margin
        hi_y = max(src_cy, tgt_cy) + margin
        return any(lo_x <= ax <= hi_x and lo_y <= ay <= hi_y
                   for ax, ay in arrow_centers)

    palette_conn_color = get_connection_color(style_spec)

    known_ids = set(all_cell_ids.keys())
    for conn in blueprint.connections:
        src = all_cell_ids.get(conn.from_id)
        tgt = all_cell_ids.get(conn.to_id)
        if src is None or tgt is None:
            logger.warning(
                "Connection %s->%s dropped: missing endpoint (known: %s)",
                conn.from_id, conn.to_id, sorted(known_ids),
            )
            continue

        if _arrow_between(conn.from_id, conn.to_id):
            logger.debug(
                "Skipping connection %s->%s: ARROW component already exists between them",
                conn.from_id, conn.to_id,
            )
            continue

        conn_base = {
            **_CONNECTION_DEFAULTS,
            "strokeColor": palette_conn_color,
            "fillColor": "none",
            "fontFamily": font_family,
        }

        conn_overrides: dict[str, str] = {}
        if conn.style == "straight_arrow":
            conn_overrides["edgeStyle"] = "none"
            conn_overrides["curved"] = "0"
        elif conn.style == "curved_arrow":
            conn_overrides["edgeStyle"] = "elbowEdgeStyle"
            conn_overrides["curved"] = "1"
        elif conn.style == "orthogonal_arrow":
            conn_overrides["edgeStyle"] = "orthogonalEdgeStyle"
        if conn.style == "dashed_arrow":
            conn_overrides["dashed"] = "1"
        if conn.stroke_color:
            conn_overrides["strokeColor"] = conn.stroke_color
        if conn.stroke_width:
            conn_overrides["strokeWidth"] = conn.stroke_width
        edge_merged = {**conn_base, **conn_overrides}
        edge_style = ";".join(f"{k}={v}" for k, v in edge_merged.items()) + ";"

        label = xml_escape(conn.label) if conn.label else ""
        cells.append(
            f'<mxCell id="{cell_id}" value="{label}" edge="1" parent="1" '
            f'source="{src}" target="{tgt}" style="{edge_style}">'
            f'<mxGeometry relative="1" as="geometry"/>'
            f"</mxCell>"
        )
        cell_id += 1

    return wrap_with_mxfile(
        sanitize_mxcells("\n".join(cells)),
        page_width=int(blueprint.canvas_width or 1200),
        page_height=int(blueprint.canvas_height or 800),
    )
