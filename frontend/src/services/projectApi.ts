import { gzip } from "pako";
import { tStandalone as t } from "../contexts/LanguageContext";

const PATH_PREFIX = import.meta.env.BASE_URL.replace(/\/$/, "");
const BASE = `${PATH_PREFIX}/api/v1/projects`;

async function apiFetch(url: string, opts?: RequestInit) {
  const res = await fetch(url, { ...opts });
  if (!res.ok) {
    const err = new Error(`${res.status} ${res.statusText}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export interface ProjectInfo {
  id: string;
  name: string;
  canvas_type: "drawio";
  status: string;
  thumbnail_url: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface ProjectListResponse {
  projects: ProjectInfo[];
  total: number;
  page: number;
  page_size: number;
}

export async function createProject(name?: string, canvasType?: string): Promise<{ id: string }> {
  return apiFetch(BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name || t("svc.defaultProjectName"), canvas_type: canvasType || "drawio" }),
  });
}

export async function listProjects(page = 1, pageSize = 20): Promise<ProjectListResponse> {
  return apiFetch(`${BASE}?page=${page}&page_size=${pageSize}`);
}

export interface ProjectDetail extends ProjectInfo {
  drawio_url: string | null;
}

export async function getProject(id: string): Promise<ProjectDetail> {
  return apiFetch(`${BASE}/${id}`);
}

export async function getCanvasData(id: string): Promise<string> {
  const res = await fetch(`${BASE}/${id}/canvas`);
  if (!res.ok) {
    const err = new Error(`${res.status} ${res.statusText}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return res.text();
}

export async function updateProject(id: string, data: { name?: string; canvas_type?: string }) {
  return apiFetch(`${BASE}/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function putJsonExpectEmpty(url: string, payload: unknown): Promise<void> {
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = new Error(`${res.status} ${res.statusText}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
}

export interface ExtractImagesResult {
  skeleton: string;
  images: Map<string, string>;
}

/**
 * Aggressively strip the skeleton XML to minimize tokens sent to the LLM.
 *
 * Removes:  nanadraw_visual_repr, nanadraw_style_notes,
 *           verbose HTML img labels (replaced with compact nanadraw://img ref),
 *           repeated identical style strings on image cells,
 *           mxGraphModel grid/guide/tooltip boilerplate attributes.
 *
 * Keeps:    nanadraw_name, nanadraw_category, id, mxGeometry (position/size).
 */
export function stripComponentDescriptions(skeleton: string): string {
  return skeleton
    .replace(/\s*nanadraw_visual_repr="[^"]*"/g, "")
    .replace(/\s*nanadraw_style_notes="[^"]*"/g, "")
    // Compact img labels: full HTML-escaped <img> → just the nanadraw ref
    .replace(
      /label="&lt;img src=&quot;(nanadraw:\/\/img\/[a-f0-9]{64})&quot; width=&quot;100%&quot; height=&quot;100%&quot;\/&gt;"/g,
      'image="$1"',
    )
    // Remove boilerplate style on image cells (identical for every component)
    .replace(
      / style="html=1;overflow=fill;whiteSpace=wrap;verticalAlign=middle;align=center;fillColor=none;strokeColor=none;"/g,
      "",
    )
    // Strip mxGraphModel boilerplate attributes (keep only pageWidth/pageHeight)
    .replace(
      /<mxGraphModel[^>]*?(pageWidth="[^"]*")[^>]*?(pageHeight="[^"]*")[^>]*?>/,
      "<mxGraphModel $1 $2>",
    );
}

export async function extractImages(canvasData: string): Promise<ExtractImagesResult> {
  const pngDataUriRe = /data:image\/png;base64,([A-Za-z0-9+/=]+)/g;
  const images = new Map<string, string>();
  const uriToHash = new Map<string, string>();

  for (const match of canvasData.matchAll(pngDataUriRe)) {
    const fullUri = match[0];
    const b64Payload = match[1];
    if (uriToHash.has(fullUri)) {
      continue;
    }
    const bytes = base64ToUint8Array(b64Payload);
    const hash = await sha256Hex(bytes);
    uriToHash.set(fullUri, hash);
    images.set(hash, b64Payload);
  }

  let skeleton = canvasData;
  for (const [fullUri, hash] of uriToHash) {
    skeleton = skeleton.split(fullUri).join(`nanadraw://img/${hash}`);
  }

  return { skeleton, images };
}

export interface ProjectImagesBatchResponse {
  images: Record<string, string>;
}

export async function restoreImages(skeleton: string, projectId: string): Promise<string> {
  const nanadrawImgRefRe = /nanadraw:\/\/img\/([a-f0-9]{64})/g;
  const hashes = [
    ...new Set([...skeleton.matchAll(nanadrawImgRefRe)].map((m) => m[1])),
  ];
  if (hashes.length === 0) {
    return skeleton;
  }

  const res = (await apiFetch(`${BASE}/${projectId}/images/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hashes }),
  })) as ProjectImagesBatchResponse;

  let restored = skeleton;
  for (const hash of hashes) {
    const b64 = res.images[hash];
    if (b64 === undefined) {
      continue;
    }
    const placeholder = `nanadraw://img/${hash}`;
    restored = restored.split(placeholder).join(`data:image/png;base64,${b64}`);
  }
  return restored;
}

const IMAGE_UPLOAD_CONCURRENCY = 5;

export async function uploadProjectImages(projectId: string, images: Map<string, string>): Promise<void> {
  const entries = [...images.entries()];
  for (let i = 0; i < entries.length; i += IMAGE_UPLOAD_CONCURRENCY) {
    const batch = entries.slice(i, i + IMAGE_UPLOAD_CONCURRENCY);
    await Promise.all(
      batch.map(([hash, data]) =>
        putJsonExpectEmpty(`${BASE}/${projectId}/images/${hash}`, { data }),
      ),
    );
  }
}

export async function saveCanvas(id: string, canvasData: string, thumbnailB64?: string) {
  const { skeleton, images } = await extractImages(canvasData);
  if (images.size > 0) {
    await uploadProjectImages(id, images);
  }
  const compressed = gzip(skeleton);
  return apiFetch(`${BASE}/${id}/canvas`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      canvas_data: uint8ToBase64(compressed),
      canvas_encoding: "gzip_b64",
      thumbnail_b64: thumbnailB64,
    }),
  });
}

export async function deleteProject(id: string) {
  return apiFetch(`${BASE}/${id}`, { method: "DELETE" });
}

export function thumbnailUrl(id: string): string {
  return `${BASE}/${id}/thumbnail`;
}
