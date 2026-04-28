const PATH_PREFIX = import.meta.env.BASE_URL.replace(/\/$/, "");
const API_BASE = `${PATH_PREFIX}/api/v1`;
const FALLBACK_API_BASE = "/api/v1";

export interface Settings {
  llm_api_key: string;
  image_api_key: string;
  vision_api_key: string;
  llm_base_url: string;
  image_base_url: string;
  vision_base_url: string;
  llm_model: string;
  llm_image_model: string;
  llm_component_model: string;
  api_format: "auto" | "gemini_native" | "openai";
  mineru_api_token: string;
  nana_soul: string;
  language: string;
  is_configured: boolean;
  mineru_is_configured: boolean;
}

export interface LLMPoolDisplay {
  base_url: string;
  api_keys: string;
}

export interface LLMConfigResponse {
  pools?: LLMPoolDisplay[];
  image_pools?: LLMPoolDisplay[];
  has_custom_config?: boolean;
  text_model?: string | null;
  image_model?: string | null;
  api_format?: "auto" | "gemini_native" | "openai";
}

async function parseErrorMessage(res: Response, fallback: string): Promise<string> {
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const err = await res.json().catch(() => ({} as Record<string, unknown>));
    if (err && typeof err === "object" && typeof err.detail === "string" && err.detail.trim()) {
      return err.detail;
    }
  } else {
    const text = await res.text().catch(() => "");
    if (text.trim()) return text.trim();
  }
  return fallback;
}

async function fetchWithApiFallback(path: string, init?: RequestInit): Promise<Response> {
  const primary = await fetch(`${API_BASE}${path}`, init);
  if (primary.status !== 404 || API_BASE === FALLBACK_API_BASE) return primary;
  return fetch(`${FALLBACK_API_BASE}${path}`, init);
}

export async function getSettings(): Promise<Settings> {
  const res = await fetchWithApiFallback("/settings");
  if (!res.ok) throw new Error("Failed to fetch settings");
  return res.json();
}

export async function updateSettings(
  data: Partial<Omit<Settings, "is_configured" | "mineru_is_configured">>,
): Promise<Settings> {
  const res = await fetchWithApiFallback("/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await parseErrorMessage(res, "Failed to update settings"));
  return res.json();
}

export async function fetchLLMConfig(): Promise<LLMConfigResponse> {
  const res = await fetchWithApiFallback("/settings/llm-config");
  if (!res.ok) throw new Error("Failed to fetch LLM config");
  return res.json();
}

export async function updateLLMConfig(
  baseUrl: string,
  apiKey: string,
  textModel: string,
  imageModel: string,
  imageBaseUrl?: string,
  imageApiKey?: string,
  apiFormat: "auto" | "gemini_native" | "openai" = "auto",
): Promise<void> {
  const pools = [{ base_url: baseUrl, api_keys: apiKey }];
  const imagePools = (imageBaseUrl || imageApiKey) ? [{ base_url: imageBaseUrl || "", api_keys: imageApiKey || "" }] : [];
  const res = await fetchWithApiFallback("/settings/llm-config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pools,
      image_pools: imagePools,
      text_model: textModel,
      image_model: imageModel,
      api_format: apiFormat,
    }),
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res, "Failed to update LLM config"));
  }
}

export async function clearLLMConfig(): Promise<void> {
  const res = await fetchWithApiFallback("/settings/llm-config", { method: "DELETE" });
  if (!res.ok) throw new Error(await parseErrorMessage(res, "Failed to clear LLM config"));
}
