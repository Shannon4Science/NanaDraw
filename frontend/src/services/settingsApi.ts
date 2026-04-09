const PATH_PREFIX = import.meta.env.BASE_URL.replace(/\/$/, "");
const API_BASE = `${PATH_PREFIX}/api/v1`;

export interface Settings {
  llm_api_key: string;
  llm_base_url: string;
  llm_model: string;
  llm_image_model: string;
  llm_component_model: string;
  nana_soul: string;
  language: string;
  is_configured: boolean;
}

export async function getSettings(): Promise<Settings> {
  const res = await fetch(`${API_BASE}/settings`);
  if (!res.ok) throw new Error("Failed to fetch settings");
  return res.json();
}

export async function updateSettings(data: Partial<Omit<Settings, "is_configured">>): Promise<Settings> {
  const res = await fetch(`${API_BASE}/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error("Failed to update settings");
  return res.json();
}
