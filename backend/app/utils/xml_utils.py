import re
import xml.etree.ElementTree as ET

_ROOT_CELLS = '<mxCell id="0"/><mxCell id="1" parent="0"/>'

_MXFILE_TEMPLATE = (
    '<mxfile><diagram name="Pipeline" id="p2f">'
    '<mxGraphModel dx="1422" dy="794" grid="1" gridSize="10"'
    ' guides="1" tooltips="1" connect="1" arrows="1" fold="1"'
    ' page="1" pageScale="1" pageWidth="{page_width}" pageHeight="{page_height}"'
    " math=\"0\" shadow=\"0\">"
    "<root>{root_cells}{content}</root>"
    "</mxGraphModel></diagram></mxfile>"
)


def wrap_with_mxfile(cells_xml: str, page_width: int = 1200, page_height: int = 800) -> str:
    """Wrap raw mxCell elements with the full mxfile structure."""
    return _MXFILE_TEMPLATE.format(
        root_cells=_ROOT_CELLS,
        content=cells_xml,
        page_width=page_width,
        page_height=page_height,
    )


def strip_markdown_fences(text: str) -> str:
    """Remove markdown code fences (```xml ... ```) if present."""
    text = text.strip()
    text = re.sub(r"^```(?:xml|drawio)?\s*\n?", "", text)
    text = re.sub(r"\n?```\s*$", "", text)
    return text.strip()


def extract_mxcells(raw_output: str) -> str:
    """Extract only mxCell elements from LLM output, cleaning any wrapper."""
    cleaned = strip_markdown_fences(raw_output)

    if "<mxfile" in cleaned:
        try:
            root = ET.fromstring(cleaned)
            cells = root.findall(".//" + "mxCell")
            filtered = [
                c for c in cells if c.get("id") not in ("0", "1")
            ]
            return "".join(ET.tostring(c, encoding="unicode") for c in filtered)
        except ET.ParseError:
            pass

    if "<root>" in cleaned:
        match = re.search(r"<root>(.*?)</root>", cleaned, re.DOTALL)
        if match:
            inner = match.group(1)
            inner = re.sub(r'<mxCell\s+id="[01]"[^/]*/>', "", inner)
            return inner.strip()

    return cleaned


def sanitize_mxcells(cells_xml: str) -> str:
    """Fix common draw.io XML issues that cause "Could not add object" errors.

    - Deduplicates cell IDs (keeps first occurrence)
    - Ensures all parent references point to valid IDs (defaults to "1")
    - Removes cells with id "0" or "1" (reserved for root)
    - Strips non-mxCell elements that draw.io can't handle
    """
    test_xml = f"<root>{cells_xml}</root>"
    try:
        root = ET.fromstring(test_xml)
    except ET.ParseError:
        return cells_xml

    seen_ids: set[str] = set()
    valid_cells: list[ET.Element] = []

    for elem in list(root):
        if elem.tag == "mxCell":
            cid = elem.get("id", "")
            if cid in ("0", "1"):
                continue
            if cid in seen_ids:
                continue
            seen_ids.add(cid)
            valid_cells.append(elem)
        elif elem.tag == "object" or elem.tag == "UserObject":
            cid = elem.get("id", "")
            if cid in seen_ids:
                continue
            seen_ids.add(cid)
            valid_cells.append(elem)

    all_ids = seen_ids | {"0", "1"}
    for cell in valid_cells:
        parent = cell.get("parent")
        if parent and parent not in all_ids:
            cell.set("parent", "1")
        if cell.tag == "mxCell" and not cell.get("parent"):
            cell.set("parent", "1")

    return "".join(ET.tostring(c, encoding="unicode") for c in valid_cells)


def validate_mxcells(cells_xml: str) -> tuple[bool, str]:
    """Validate that the XML contains well-formed mxCell elements.

    Returns (is_valid, error_message).
    """
    if not cells_xml.strip():
        return False, "Empty XML content"

    test_xml = f"<root>{cells_xml}</root>"
    try:
        root = ET.fromstring(test_xml)
    except ET.ParseError as e:
        return False, f"XML parse error: {e}"

    cells = root.findall("mxCell")
    if not cells:
        all_elements = list(root)
        if not all_elements:
            return False, "No mxCell elements found"
        non_mx = [e.tag for e in all_elements if e.tag != "mxCell"]
        if non_mx:
            return False, f"Unexpected elements: {non_mx}"

    vertex_count = sum(1 for c in cells if c.get("vertex") == "1")
    edge_count = sum(1 for c in cells if c.get("edge") == "1")

    if vertex_count == 0:
        return False, "No vertex (node) elements found"

    return True, f"OK: {vertex_count} nodes, {edge_count} edges"


def validate_full_diagram(mxfile_xml: str) -> tuple[bool, str]:
    """Validate a complete mxfile XML document."""
    try:
        root = ET.fromstring(mxfile_xml)
    except ET.ParseError as e:
        return False, f"XML parse error: {e}"

    diagram = root.find(".//diagram")
    if diagram is None:
        return False, "Missing <diagram> element"

    model = root.find(".//mxGraphModel")
    if model is None:
        return False, "Missing <mxGraphModel> element"

    root_elem = root.find(".//root")
    if root_elem is None:
        return False, "Missing <root> element"

    cells = root_elem.findall("mxCell")
    ids = [c.get("id") for c in cells]
    if "0" not in ids or "1" not in ids:
        return False, "Missing root cells (id=0 and id=1)"

    return True, f"OK: {len(cells)} total cells"
