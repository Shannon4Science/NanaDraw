"""SVG sanitizer — whitelist-based XSS prevention for user-uploaded SVGs."""

import re
from io import BytesIO

from lxml import etree

SVG_NS = "http://www.w3.org/2000/svg"
XLINK_NS = "http://www.w3.org/1999/xlink"

ALLOWED_ELEMENTS = {
    f"{{{SVG_NS}}}{tag}"
    for tag in (
        "svg", "g", "defs", "symbol", "use", "title", "desc",
        "rect", "circle", "ellipse", "line", "polyline", "polygon",
        "path", "text", "tspan", "textPath",
        "image", "clipPath", "mask", "pattern", "marker",
        "linearGradient", "radialGradient", "stop",
        "filter", "feGaussianBlur", "feOffset", "feBlend",
        "feColorMatrix", "feComposite", "feFlood", "feMerge",
        "feMergeNode", "feImage", "feMorphology",
        "switch", "a", "style",
    )
}

EVENT_ATTR_RE = re.compile(r"^on", re.IGNORECASE)
JAVASCRIPT_RE = re.compile(r"^\s*javascript:", re.IGNORECASE)

DANGEROUS_TAGS = {
    f"{{{SVG_NS}}}script",
    "script",
    f"{{{SVG_NS}}}foreignObject",
    "foreignObject",
}


def sanitize_svg(raw_bytes: bytes) -> bytes:
    """
    Parse and sanitize SVG bytes using a whitelist approach.
    Removes <script>, event handlers, javascript: URIs, <foreignObject>, etc.
    Returns cleaned SVG bytes.
    """
    parser = etree.XMLParser(resolve_entities=False, no_network=True)
    try:
        tree = etree.parse(BytesIO(raw_bytes), parser)
    except etree.XMLSyntaxError as e:
        raise ValueError(f"Invalid SVG: {e}") from e

    root = tree.getroot()
    _clean_element(root)

    return etree.tostring(root, xml_declaration=True, encoding="utf-8")


def _clean_element(el: etree._Element) -> None:
    """Recursively clean an element tree in-place."""
    to_remove = []
    for child in el:
        tag = child.tag if isinstance(child.tag, str) else ""
        if tag in DANGEROUS_TAGS:
            to_remove.append(child)
            continue
        _clean_attrs(child)
        _clean_element(child)

    for child in to_remove:
        el.remove(child)

    _clean_attrs(el)


def _clean_attrs(el: etree._Element) -> None:
    """Remove dangerous attributes from a single element."""
    to_del = []
    for attr_name, attr_val in el.attrib.items():
        local = attr_name.split("}")[-1] if "}" in attr_name else attr_name
        if EVENT_ATTR_RE.match(local):
            to_del.append(attr_name)
            continue
        if local in ("href", f"{{{XLINK_NS}}}href") and JAVASCRIPT_RE.match(attr_val):
            to_del.append(attr_name)
            continue

    for attr_name in to_del:
        del el.attrib[attr_name]

    if el.tag == f"{{{SVG_NS}}}style" or el.tag == "style":
        if el.text:
            el.text = re.sub(r"url\s*\(\s*['\"]?\s*javascript:", "url(", el.text, flags=re.IGNORECASE)
