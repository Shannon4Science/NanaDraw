const PATH_PREFIX = import.meta.env.BASE_URL.replace(/\/$/, "");
const API_BASE = `${PATH_PREFIX}/api/v1`;

const DEFAULT_TEXT_MODEL = "gemini-3.1-pro-preview";
const DEFAULT_IMAGE_MODEL = "gemini-3-pro-image-preview";
const DEFAULT_COMPONENT_MODEL = "gemini-3.1-flash-image-preview";

export interface ModelDefaults {
  textModel: string;
  imageModel: string;
  componentGenModel: string;
}

/** Loads model IDs from /api/v1/settings; falls back to hardcoded defaults. */
export async function fetchModelDefaults(): Promise<ModelDefaults> {
  try {
    const res = await fetch(`${API_BASE}/settings`);
    if (!res.ok) throw new Error("settings request failed");
    const data = (await res.json()) as Record<string, unknown>;

    const textModel =
      (typeof data.llm_model === "string" && data.llm_model) || DEFAULT_TEXT_MODEL;
    const imageModel =
      (typeof data.llm_image_model === "string" && data.llm_image_model) || DEFAULT_IMAGE_MODEL;
    const componentGenModel =
      (typeof data.llm_component_model === "string" && data.llm_component_model) || DEFAULT_COMPONENT_MODEL;

    return { textModel, imageModel, componentGenModel };
  } catch {
    return {
      textModel: DEFAULT_TEXT_MODEL,
      imageModel: DEFAULT_IMAGE_MODEL,
      componentGenModel: DEFAULT_COMPONENT_MODEL,
    };
  }
}
