"""NanaSoul — user-defined drawing constraints injected into generation prompts."""


def build_nana_soul_section(text: str | None) -> str:
    """Build a prompt section from NanaSoul text.

    Returns empty string if no constraints are provided.
    """
    if not text or not text.strip():
        return ""
    return (
        "\n\nUSER DRAWING CONSTRAINTS (NanaSoul):\n"
        f"{text.strip()}\n"
        "These constraints MUST override any default style choices. "
        "Apply them when planning style parameters and generating the diagram/component.\n"
    )
