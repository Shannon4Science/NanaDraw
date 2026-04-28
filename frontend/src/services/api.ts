import { tStandalone as t } from "../contexts/LanguageContext";

const PATH_PREFIX = import.meta.env.BASE_URL.replace(/\/$/, "");
const API_BASE = `${PATH_PREFIX}/api/v1`;
const SETTINGS_API = `${PATH_PREFIX}/api/v1/settings`;
const FALLBACK_API_BASE = "/api/v1";

export async function fetchNanaSoul(): Promise<string> {
  const res = await fetch(SETTINGS_API);
  if (!res.ok) return "";
  const data = await res.json();
  return data.nana_soul || "";
}

export async function updateNanaSoul(content: string): Promise<string> {
  const res = await fetch(SETTINGS_API, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nana_soul: content }),
  });
  if (!res.ok) throw new Error("Failed to update settings");
  const data = await res.json();
  return data.nana_soul || "";
}

export async function cancelPipeline(taskId: string): Promise<void> {
  try {
    await fetch(`${API_BASE}/generate/${taskId}/cancel`, { method: "POST" });
  } catch {
    // best-effort
  }
}

// ── Gallery API ──

function prefixStaticUrl(url: string): string {
  if (url?.startsWith("/static/") && PATH_PREFIX) {
    return `${PATH_PREFIX}${url}`;
  }
  return url;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function patchGalleryUrls(items: any[]): any[] {
  for (const item of items) {
    if (item.thumbnail_url) item.thumbnail_url = prefixStaticUrl(item.thumbnail_url);
    if (item.image_url) item.image_url = prefixStaticUrl(item.image_url);
  }
  return items;
}

export async function fetchGallery(category?: string) {
  const params = category ? `?category=${category}` : "";
  const res = await fetch(`${API_BASE}/gallery${params}`);
  if (!res.ok) throw new Error("Failed to fetch gallery");
  const items = await res.json();
  patchGalleryUrls(items);
  return items;
}

export async function searchGallery(query: string, topK = 10) {
  const params = new URLSearchParams({ q: query, top_k: String(topK) });
  const res = await fetch(`${API_BASE}/gallery/search?${params}`);
  if (!res.ok) throw new Error("Failed to search gallery");
  const items = await res.json();
  patchGalleryUrls(items);
  return items;
}

// ── Bioicons API ──

export interface BioiconCategoryData {
  name: string;
  count: number;
}

export interface BioiconItemData {
  id: string;
  name: string;
  category: string;
  author: string;
  license: string;
  svg_url: string;
  w: number;
  h: number;
}

export interface BioiconsPageData {
  items: BioiconItemData[];
  total: number;
  page: number;
  limit: number;
}

export async function fetchBioiconCategories(): Promise<BioiconCategoryData[]> {
  const res = await fetch(`${API_BASE}/bioicons/categories`);
  if (!res.ok) throw new Error("Failed to fetch bioicon categories");
  return res.json();
}

export async function fetchBioicons(params: {
  category?: string;
  q?: string;
  page?: number;
  limit?: number;
}): Promise<BioiconsPageData> {
  const sp = new URLSearchParams();
  if (params.category) sp.set("category", params.category);
  if (params.q) sp.set("q", params.q);
  if (params.page) sp.set("page", String(params.page));
  if (params.limit) sp.set("limit", String(params.limit));
  const res = await fetch(`${API_BASE}/bioicons/icons?${sp}`);
  if (!res.ok) throw new Error("Failed to fetch bioicons");
  return res.json();
}

export async function fetchBioiconSvg(iconId: string): Promise<string> {
  const res = await fetch(`${API_BASE}/bioicons/icon/${iconId}/svg`);
  if (!res.ok) throw new Error("Failed to fetch bioicon SVG");
  return res.text();
}

// ── User Elements API ──

export interface UserElement {
  id: string;
  user_id: string;
  display_name: string;
  file_hash: string;
  s3_key: string;
  file_type: string;
  file_size: number | null;
  width: number | null;
  height: number | null;
  category: string | null;
  created_at: string;
}

export interface UserElementsPage {
  items: UserElement[];
  total: number;
  page: number;
  size: number;
}

export async function fetchUserElements(params?: {
  category?: string;
  page?: number;
  size?: number;
}): Promise<UserElementsPage> {
  const sp = new URLSearchParams();
  if (params?.category) sp.set("category", params.category);
  if (params?.page) sp.set("page", String(params.page));
  if (params?.size) sp.set("size", String(params.size));
  const res = await fetch(`${API_BASE}/elements?${sp}`);
  if (!res.ok) throw new Error("Failed to fetch user elements");
  return res.json();
}

export async function uploadUserElement(
  file: File,
  displayName?: string,
  category?: string,
): Promise<UserElement> {
  const form = new FormData();
  form.append("file", file);
  if (displayName) form.append("display_name", displayName);
  if (category) form.append("category", category);
  const res = await fetch(`${API_BASE}/elements`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err);
  }
  return res.json();
}

export async function deleteUserElement(elementId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/elements/${elementId}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to delete element");
}

export async function fetchUserElementContent(elementId: string): Promise<string> {
  const res = await fetch(`${API_BASE}/elements/${elementId}/content`);
  if (!res.ok) throw new Error("Failed to fetch element content");
  return res.text();
}

export async function fetchUserElementContentAsBase64(elementId: string): Promise<string> {
  const res = await fetch(`${API_BASE}/elements/${elementId}/content`);
  if (!res.ok) throw new Error("Failed to fetch element content");
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// ── Asset Generation API ──

export type AssetStyle =
  | "none"
  | "thin_linear" | "regular_linear" | "bold_linear"
  | "minimal_flat" | "doodle" | "hand_drawn"
  | "illustration" | "detailed_linear" | "fine_linear"
  | "custom";

export interface AssetGenItem {
  description: string;
  image_b64: string;
}

export async function generateAssetFromImage(
  file: File,
  style: AssetStyle,
  imageModel?: string,
  styleText?: string,
): Promise<{ image_b64: string }> {
  const form = new FormData();
  form.append("file", file);
  form.append("style", style);
  if (imageModel) form.append("image_model", imageModel);
  if (style === "custom" && styleText) form.append("style_text", styleText);
  const res = await fetch(`${API_BASE}/elements/generate-from-image`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: t("svc.stylizeFailed") }));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Settings API ──

export async function fetchAssistantStatus(): Promise<{ enabled: boolean }> {
  try {
    const res = await fetch(`${API_BASE}/assistant/status`);
    if (!res.ok) return { enabled: false };
    return res.json();
  } catch {
    return { enabled: false };
  }
}

// ── Document Parsing API ──

export interface ParsedPdfResult {
  file_name: string;
  markdown: string;
  batch_id: string;
  data_id: string;
  source: "mineru";
}

async function fetchDocumentsApi(path: string, init?: RequestInit): Promise<Response> {
  const primary = await fetch(`${API_BASE}${path}`, init);
  const contentType = (primary.headers.get("content-type") || "").toLowerCase();
  const shouldFallback = primary.status === 404 || contentType.includes("text/html");
  if (!shouldFallback) return primary;
  return fetch(`${FALLBACK_API_BASE}${path}`, init);
}

export async function parsePdfDocument(file: File): Promise<ParsedPdfResult> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetchDocumentsApi("/documents/parse-pdf", {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: t("svc.pdfParseFailed") }));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json();
}



// ── Pipeline SSE ──

export interface PipelineStepInfo {
  id: string;
  name: string;
}

export interface SSECallbacks {
  onQueuePosition?: (data: { position: number; total: number }) => void;
  onPipelineInfo?: (data: { steps: PipelineStepInfo[]; total: number; request_id?: string }) => void;
  onStepStart?: (data: { step_id: string }) => void;
  onStepComplete?: (data: {
    step_id: string;
    elapsed_ms: number;
    artifact_type: string;
    artifact: unknown;
    prompts?: { system: string; user: string };
    cached?: boolean;
  }) => void;
  onStepError?: (data: { step_id: string; elapsed_ms: number; error: string }) => void;
  onStepProgress?: (data: {
    step_id: string;
    element_id: string;
    label: string;
    strategy: string;
    status: string;
    error?: string;
    image_b64?: string;
    index: number;
    total: number;
  }) => void;
  onPlan?: (data: Record<string, unknown>) => void;
  onReferenceImage?: (data: { image: string }) => void;
  onResult?: (data: { xml?: string; image?: string; slides?: unknown[]; viewportRatio?: number }) => void;
  onError?: (data: { message: string }) => void;
  onClose?: () => void;
}

export async function generateDiagram(
  body: object,
  callbacks: SSECallbacks,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${API_BASE}/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const err = await res.text();
    callbacks.onError?.({ message: err });
    return;
  }

  const reader = res.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith("data: ") && currentEvent) {
        const raw = line.slice(6);
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(raw);
        } catch {
          continue;
        }
        switch (currentEvent) {
          case "queue_position":
            callbacks.onQueuePosition?.(data as never);
            break;
          case "pipeline_info":
            callbacks.onPipelineInfo?.(data as never);
            break;
          case "step_start":
            callbacks.onStepStart?.(data as never);
            break;
          case "step_complete":
            callbacks.onStepComplete?.(data as never);
            break;
          case "step_error":
            callbacks.onStepError?.(data as never);
            break;
          case "step_progress":
            callbacks.onStepProgress?.(data as never);
            break;
          case "plan":
            callbacks.onPlan?.(data);
            break;
          case "reference_image":
            callbacks.onReferenceImage?.(data as never);
            break;
          case "result":
            callbacks.onResult?.(data as never);
            break;
          case "cancelled":
            callbacks.onError?.({ message: (data as { message?: string }).message || t("svc.cancelled") });
            break;
          case "error":
            callbacks.onError?.(data as never);
            break;
          case "close":
            callbacks.onClose?.();
            break;
        }
        currentEvent = "";
      }
    }
  }
}

// ── Asset Generation SSE ──

export interface AssetSSECallbacks {
  onQueuePosition?: (data: { position: number; total: number }) => void;
  onAssetStart?: (data: { total: number }) => void;
  onAssetProgress?: (data: {
    index: number;
    total: number;
    description: string;
    image_b64?: string;
    status: string;
    error?: string;
  }) => void;
  onAssetComplete?: (data: { total: number; success: number; failed: number }) => void;
  onError?: (data: { message: string }) => void;
  onClose?: () => void;
}

export async function generateAssetsSSE(
  descriptions: string[],
  style: AssetStyle,
  imageModel: string | undefined,
  callbacks: AssetSSECallbacks,
  signal?: AbortSignal,
  styleText?: string,
): Promise<void> {
  const res = await fetch(`${API_BASE}/elements/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      descriptions,
      style,
      image_model: imageModel || null,
      style_text: style === "custom" ? (styleText || null) : null,
    }),
    signal,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: t("svc.genFailed") }));
    callbacks.onError?.({ message: err.detail || `HTTP ${res.status}` });
    return;
  }

  const reader = res.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith("data: ") && currentEvent) {
        const raw = line.slice(6);
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(raw);
        } catch {
          continue;
        }
        switch (currentEvent) {
          case "queue_position":
            callbacks.onQueuePosition?.(data as never);
            break;
          case "asset_start":
            callbacks.onAssetStart?.(data as never);
            break;
          case "asset_progress":
            callbacks.onAssetProgress?.(data as never);
            break;
          case "asset_complete":
            callbacks.onAssetComplete?.(data as never);
            break;
          case "error":
            callbacks.onError?.(data as never);
            break;
          case "close":
            callbacks.onClose?.();
            break;
        }
        currentEvent = "";
      }
    }
  }
}

// ── Assistant SSE ──

export interface AssistantAssetResult {
  images: Array<{ description: string; image_b64: string }>;
  style: string;
}

export interface AssistantSSECallbacks extends SSECallbacks {
  onAssistantMessage?: (data: { content: string; done: boolean }) => void;
  onToolCall?: (data: { name: string; arguments: Record<string, unknown> }) => void;
  onToolResult?: (data: { name: string; summary: string }) => void;
  onAssetResults?: (data: AssistantAssetResult) => void;
  onAssetStart?: (data: unknown) => void;
  onAssetProgress?: (data: unknown) => void;
  onAssetComplete?: (data: unknown) => void;
  onRegenStart?: (data: unknown) => void;
  onRegenProgress?: (data: unknown) => void;
  onRegenResults?: (data: { component_id: string; images: Array<{ image_b64: string; description: string }>; total: number; success: number }) => void;
  onRegenError?: (data: { message: string }) => void;
  onSkeletonPreview?: (data: { slides: unknown[]; viewportRatio: number; theme: unknown }) => void;
  onSubProgress?: (data: { step_id: string; completed: number; total: number }) => void;
  onTemplateImages?: (data: { images: Record<string, string>; template_ids: string[]; count: number }) => void;
  onCanvasUpdate?: (data: { xml: string; summary: string }) => void;
}

export async function assistantChat(
  message: string,
  history: Array<{ role: string; content: string }>,
  callbacks: AssistantSSECallbacks,
  signal?: AbortSignal,
  selectedMode?: string,
  styleRefId?: string,
  sessionId?: string,
  sketchImageB64?: string,
  textModel?: string,
  regenContext?: {
    task_id: string;
    component_id: string;
    component_label: string;
    visual_repr?: string;
    component_image_svg?: string;
    component_image_b64?: string;
    batch_components?: Array<{ component_id: string; component_label: string }>;
  },
  canvasType?: string,
  attachedFile?: { name: string; type: string; content: string },
  imageModel?: string,
  canvasSkeleton?: string,
  canvasSkeletonFull?: string,
  canvasImages?: Record<string, string>,
  componentImageModel?: string,
): Promise<void> {
  const body: Record<string, unknown> = { message, history };
  if (selectedMode) body.selected_mode = selectedMode;
  if (styleRefId) body.style_ref_id = styleRefId;
  if (sessionId) body.session_id = sessionId;
  if (sketchImageB64) body.sketch_image_b64 = sketchImageB64;
  if (textModel) body.text_model = textModel;
  if (regenContext) body.regen_context = regenContext;
  if (canvasType) body.canvas_type = canvasType;
  if (attachedFile) body.attached_file = attachedFile;
  if (imageModel) body.image_model = imageModel;
  if (canvasSkeleton) body.canvas_skeleton = canvasSkeleton;
  if (canvasSkeletonFull) body.canvas_skeleton_full = canvasSkeletonFull;
  if (canvasImages) body.canvas_images = canvasImages;
  if (componentImageModel) body.component_image_model = componentImageModel;
  const locale = localStorage.getItem("nanadraw_locale") || "zh";
  body.locale = locale;
  const res = await fetch(`${API_BASE}/assistant/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    const text = await res.text();
    callbacks.onError?.({ message: text || `HTTP ${res.status}` });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith("data: ") && currentEvent) {
        const raw = line.slice(6);
        let data: Record<string, unknown> = {};
        try {
          data = JSON.parse(raw);
        } catch {
          /* skip malformed */
        }

        switch (currentEvent) {
          case "assistant_message":
            callbacks.onAssistantMessage?.(data as never);
            break;
          case "tool_call":
            callbacks.onToolCall?.(data as never);
            break;
          case "tool_result":
            callbacks.onToolResult?.(data as never);
            break;
          case "asset_results":
            callbacks.onAssetResults?.(data as never);
            break;
          case "asset_start":
            callbacks.onAssetStart?.(data as never);
            break;
          case "asset_progress":
            callbacks.onAssetProgress?.(data as never);
            break;
          case "asset_complete":
            callbacks.onAssetComplete?.(data as never);
            break;
          case "regen_start":
            callbacks.onRegenStart?.(data as never);
            break;
          case "regen_progress":
            callbacks.onRegenProgress?.(data as never);
            break;
          case "regen_results":
            callbacks.onRegenResults?.(data as never);
            break;
          case "regen_error":
            callbacks.onRegenError?.(data as never);
            break;
          case "queue_position":
            callbacks.onQueuePosition?.(data as never);
            break;
          case "pipeline_info":
            callbacks.onPipelineInfo?.(data as never);
            break;
          case "step_start":
            callbacks.onStepStart?.(data as never);
            break;
          case "step_complete":
            callbacks.onStepComplete?.(data as never);
            break;
          case "step_error":
            callbacks.onStepError?.(data as never);
            break;
          case "step_progress":
            callbacks.onStepProgress?.(data as never);
            break;
          case "reference_image":
            callbacks.onReferenceImage?.(data as never);
            break;
          case "plan":
            callbacks.onPlan?.(data as never);
            break;
          case "skeleton_preview":
            callbacks.onSkeletonPreview?.(data as never);
            break;
          case "template_images":
            callbacks.onTemplateImages?.(data as never);
            break;
          case "sub_progress":
            callbacks.onSubProgress?.(data as never);
            break;
          case "canvas_update":
            if (!data.xml) {
              console.error("[SSE] canvas_update received but xml is missing/empty. data keys:", Object.keys(data));
            } else {
              console.log("[SSE] canvas_update received, xml length:", (data.xml as string).length);
            }
            callbacks.onCanvasUpdate?.(data as never);
            break;
          case "result":
            callbacks.onResult?.(data as never);
            break;
          case "cancelled":
            callbacks.onError?.({ message: (data as { message?: string }).message || t("svc.cancelled") });
            break;
          case "error":
            callbacks.onError?.(data as never);
            break;
          case "close":
            callbacks.onClose?.();
            break;
        }
        currentEvent = "";
      }
    }
  }
}
