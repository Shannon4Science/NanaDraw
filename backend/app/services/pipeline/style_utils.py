"""Style-related utilities: palette maps, style_notes parsing, StyleSpec helpers."""

from app.schemas.paper import StyleSpec

FONT_FAMILY_MAP: dict[str, str] = {
    "sans": "Helvetica",
    "serif": "Georgia",
    "mono": "Courier New",
    "handwritten": "Comic Sans MS",
    "rounded": "Nunito",
}

COLOR_PRESET_PALETTE: dict[str, list[str]] = {
    "pastel": ["#E3F2FD", "#F3E5F5", "#E8F5E9", "#FFF3E0", "#FCE4EC"],
    "vibrant": ["#42A5F5", "#AB47BC", "#66BB6A", "#FFA726", "#EF5350"],
    "academic_blue": ["#4A6B8A", "#C0392B", "#D4A84B", "#5B8C6B", "#E8E0D4"],
    "warm": ["#FF8A65", "#FFB74D", "#FFD54F", "#FFAB91", "#FFCCBC"],
    "cool": ["#4FC3F7", "#4DD0E1", "#80DEEA", "#B2EBF2", "#E0F7FA"],
    "natural_green": ["#66BB6A", "#81C784", "#A5D6A7", "#C8E6C9", "#E8F5E9"],
    "violet": ["#7E57C2", "#9575CD", "#B39DDB", "#D1C4E9", "#EDE7F6"],
    "monochrome": ["#212121", "#616161", "#9E9E9E", "#BDBDBD", "#E0E0E0"],
    "high_contrast": ["#212121", "#F44336", "#FFEB3B", "#4CAF50", "#2196F3"],
    "sunset": ["#BF360C", "#E64A19", "#FF5722", "#FF7043", "#FFAB91"],
}

COLOR_PRESET_DESCRIPTION: dict[str, str] = {
    "pastel": "Soft pastel tones — light blues, lavenders, mint greens, and peach. Gentle and calming.",
    "vibrant": "Bold, saturated colors — vivid blues, purples, greens, oranges, and reds. Energetic and eye-catching.",
    "academic_blue": "Classic scholarly palette with balanced, muted tones — slate blue, brick red, olive green, and amber. Publication-ready with warm neutral backgrounds.",
    "warm": "Warm tones — coral, amber, golden yellow, and salmon. Inviting and approachable.",
    "cool": "Cool tones — cyan, teal, and aqua shades. Modern and refreshing.",
    "natural_green": "Nature-inspired greens from forest to sage. Organic and balanced.",
    "violet": "Purple-dominant palette — from deep violet to soft lavender. Creative and elegant.",
    "monochrome": "Grayscale only — blacks, grays, and whites. Minimalist and formal.",
    "high_contrast": "High contrast — black base with strong accent colors (red, yellow, green, blue). Bold and striking.",
    "sunset": "Sunset gradient palette — deep red, burnt orange, coral, and peach. Dramatic and warm.",
}


CONNECTION_STROKE_COLOR: dict[str, str] = {
    "pastel": "#90CAF9",
    "vibrant": "#757575",
    "academic_blue": "#4A6B8A",
    "warm": "#BF8A65",
    "cool": "#4FC3F7",
    "natural_green": "#66BB6A",
    "violet": "#7E57C2",
    "monochrome": "#616161",
    "high_contrast": "#212121",
    "sunset": "#E64A19",
}


def get_connection_color(style_spec: StyleSpec | None) -> str:
    """Return a palette-appropriate connection stroke color."""
    if not style_spec or not style_spec.color_preset:
        return "#616161"
    return CONNECTION_STROKE_COLOR.get(style_spec.color_preset, "#616161")


def extract_style_value(style_notes: str, key: str, default: str) -> str:
    """Extract a single key=value from a style_notes string."""
    for part in style_notes.replace(";", " ").replace(",", " ").split():
        if "=" in part:
            k, v = part.split("=", 1)
            if k.strip().lower() == key.lower() and v.strip():
                return v.strip()
    return default


def parse_style_notes(style_notes: str) -> dict[str, str]:
    """Parse all key=value pairs from a draw.io-like style string."""
    parsed: dict[str, str] = {}
    for part in style_notes.replace(";", " ").replace(",", " ").split():
        if "=" in part:
            k, v = part.split("=", 1)
            k, v = k.strip(), v.strip()
            if k and v:
                parsed[k] = v
    return parsed


def build_style_from_notes(style_notes: str, defaults: dict[str, str]) -> str:
    """Build a draw.io style string by merging parsed style_notes over defaults."""
    parsed = parse_style_notes(style_notes)
    merged = {**defaults, **parsed}
    return ";".join(f"{k}={v}" for k, v in merged.items()) + ";"


def build_style_spec_section(style_spec: StyleSpec | None) -> str:
    """Build a text section describing the StyleSpec for component generation prompts.

    Only includes fields that are actually set (non-None).
    """
    if not style_spec or not style_spec.has_fields():
        if style_spec and style_spec.description:
            return f"\nStyle description: {style_spec.description}\n"
        return ""
    ss = style_spec
    lines = ["\nDetailed style specification:"]
    if ss.visual_style:
        lines.append(f"- Visual style: {ss.visual_style}")
    if ss.color_preset:
        palette = COLOR_PRESET_PALETTE.get(ss.color_preset, [])
        palette_str = ", ".join(palette) if palette else ss.color_preset
        lines.append(f"- Color preset: {ss.color_preset} ({palette_str})")
    if ss.font_scheme:
        lines.append(f"- Font scheme: {ss.font_scheme}")
    if ss.topology:
        lines.append(f"- Topology: {ss.topology}")
    if ss.layout_direction:
        lines.append(f"- Layout direction: {ss.layout_direction}")
    if ss.description:
        lines.append(f"- Style description: {ss.description}")
    return "\n".join(lines) + "\n"
