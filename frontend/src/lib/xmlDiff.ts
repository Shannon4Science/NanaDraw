/**
 * Cell-level diff between two draw.io mxGraphModel XML strings.
 *
 * Produces a compact patch (remove / update / add) that can be sent to
 * draw.io's `patchCells` postMessage action.  Image cells whose only
 * difference is a nanadraw://img/ ↔ data:image swap are treated as
 * unchanged so that large base64 payloads never travel through postMessage.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CellGeometry {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  relative?: number;
  offset?: { x: number; y: number };
  points?: Array<{ x: number; y: number }>;
}

export interface CellUpdate {
  id: string;
  value?: string;
  style?: string;
  geometry?: CellGeometry;
}

export interface CellPatch {
  remove: string[];
  update: CellUpdate[];
  addXml: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CellInfo {
  id: string;
  /** The wrapper element (UserObject / object) or the mxCell itself */
  wrapper: Element;
  /** The mxCell element (may be same as wrapper) */
  mxCell: Element;
  label: string;
  style: string;
  geo: CellGeometry | null;
  isImageCell: boolean;
}

function parseGeometry(mxCell: Element): CellGeometry | null {
  const geoEl = mxCell.querySelector(":scope > mxGeometry");
  if (!geoEl) return null;
  const geo: CellGeometry = {};
  const x = geoEl.getAttribute("x");
  const y = geoEl.getAttribute("y");
  const w = geoEl.getAttribute("width");
  const h = geoEl.getAttribute("height");
  const rel = geoEl.getAttribute("relative");
  if (x) geo.x = parseFloat(x);
  if (y) geo.y = parseFloat(y);
  if (w) geo.width = parseFloat(w);
  if (h) geo.height = parseFloat(h);
  if (rel) geo.relative = parseInt(rel, 10);

  const offsetEl = geoEl.querySelector(":scope > mxPoint");
  if (offsetEl) {
    geo.offset = {
      x: parseFloat(offsetEl.getAttribute("x") || "0"),
      y: parseFloat(offsetEl.getAttribute("y") || "0"),
    };
  }

  const pointEls = geoEl.querySelectorAll(":scope > Array > mxPoint");
  if (pointEls.length > 0) {
    geo.points = Array.from(pointEls).map((p) => ({
      x: parseFloat(p.getAttribute("x") || "0"),
      y: parseFloat(p.getAttribute("y") || "0"),
    }));
  }

  return geo;
}

function getCellLabel(wrapper: Element, mxCell: Element): string {
  if (wrapper !== mxCell) {
    return wrapper.getAttribute("label") ?? "";
  }
  return mxCell.getAttribute("value") ?? "";
}

const IMAGE_PATTERN = /data:image\/[^;]+;base64,|nanadraw:\/\/img\/[a-f0-9]{64}/;

function buildCellMap(doc: Document): Map<string, CellInfo> {
  const map = new Map<string, CellInfo>();
  const root = doc.querySelector("mxGraphModel > root") ?? doc.querySelector("root");
  if (!root) return map;

  for (const child of Array.from(root.children)) {
    const tag = child.tagName;
    let wrapper: Element;
    let mxCell: Element;

    if (tag === "UserObject" || tag === "object") {
      wrapper = child;
      const inner = child.querySelector(":scope > mxCell");
      if (!inner) continue;
      mxCell = inner;
    } else if (tag === "mxCell") {
      wrapper = child;
      mxCell = child;
    } else {
      continue;
    }

    const id = wrapper.getAttribute("id") ?? mxCell.getAttribute("id") ?? "";
    if (!id || id === "0" || id === "1") continue;

    const label = getCellLabel(wrapper, mxCell);
    const style = mxCell.getAttribute("style") ?? "";
    const geo = parseGeometry(mxCell);
    const isImageCell = IMAGE_PATTERN.test(label) || /image=data:image\//.test(style);

    map.set(id, { id, wrapper, mxCell, label, style, geo, isImageCell });
  }
  return map;
}

function geoEqual(a: CellGeometry | null, b: CellGeometry | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height &&
    a.relative === b.relative &&
    JSON.stringify(a.offset) === JSON.stringify(b.offset) &&
    JSON.stringify(a.points) === JSON.stringify(b.points)
  );
}

function geoDiff(
  oldGeo: CellGeometry | null,
  newGeo: CellGeometry | null,
): CellGeometry | undefined {
  if (geoEqual(oldGeo, newGeo)) return undefined;
  if (!newGeo) return undefined;
  return newGeo;
}

/**
 * Normalize a label for comparison by stripping image data.
 * Replaces both `data:image/...;base64,...` and `nanadraw://img/...`
 * with a placeholder so that only structural / text differences remain.
 */
function normalizeLabel(label: string): string {
  return label
    .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, "__IMG__")
    .replace(/nanadraw:\/\/img\/[a-f0-9]{64}/g, "__IMG__");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute a cell-level diff between `oldXml` (current page in the editor,
 * with base64 images) and `newXml` (from backend, with nanadraw://img/ refs).
 *
 * Image cells are identified and skipped when the only difference is the
 * image data format (base64 vs nanadraw://img/).
 */
export function diffCells(oldXml: string, newXml: string): CellPatch {
  const parser = new DOMParser();
  const oldDoc = parser.parseFromString(oldXml, "text/xml");
  const newDoc = parser.parseFromString(newXml, "text/xml");

  const oldMap = buildCellMap(oldDoc);
  const newMap = buildCellMap(newDoc);

  const remove: string[] = [];
  const update: CellUpdate[] = [];
  const addElements: Element[] = [];

  // Cells in old but not in new → remove
  for (const [id] of oldMap) {
    if (!newMap.has(id)) {
      remove.push(id);
    }
  }

  // Cells in new
  for (const [id, newCell] of newMap) {
    const oldCell = oldMap.get(id);

    if (!oldCell) {
      // New cell → add
      addElements.push(newCell.wrapper);
      continue;
    }

    // Skip image cells where only the image data format differs
    if (oldCell.isImageCell || newCell.isImageCell) {
      const oldNorm = normalizeLabel(oldCell.label);
      const newNorm = normalizeLabel(newCell.label);
      const oldStyleNorm = oldCell.style
        .replace(/image=data:image\/[^;]+;base64,[^;"]*/g, "image=__IMG__")
        .replace(/image=nanadraw:\/\/img\/[a-f0-9]{64}/g, "image=__IMG__");
      const newStyleNorm = newCell.style
        .replace(/image=data:image\/[^;]+;base64,[^;"]*/g, "image=__IMG__")
        .replace(/image=nanadraw:\/\/img\/[a-f0-9]{64}/g, "image=__IMG__");

      if (oldNorm === newNorm && oldStyleNorm === newStyleNorm && geoEqual(oldCell.geo, newCell.geo)) {
        continue;
      }
      // If there's a non-image difference (e.g. geometry moved), still update
      // but use the OLD label/style to preserve base64 images
      const cu: CellUpdate = { id };
      if (oldNorm !== newNorm) cu.value = oldCell.label;
      if (oldStyleNorm !== newStyleNorm) cu.style = oldCell.style;
      const gd = geoDiff(oldCell.geo, newCell.geo);
      if (gd) cu.geometry = gd;
      if (cu.value !== undefined || cu.style !== undefined || cu.geometry) {
        update.push(cu);
      }
      continue;
    }

    // Non-image cell: compare label, style, geometry
    const cu: CellUpdate = { id };
    if (oldCell.label !== newCell.label) cu.value = newCell.label;
    if (oldCell.style !== newCell.style) cu.style = newCell.style;
    const gd = geoDiff(oldCell.geo, newCell.geo);
    if (gd) cu.geometry = gd;

    if (cu.value !== undefined || cu.style !== undefined || cu.geometry) {
      update.push(cu);
    }
  }

  // Build addXml from collected elements
  let addXml: string | null = null;
  if (addElements.length > 0) {
    const serializer = new XMLSerializer();
    const parts = addElements.map((el) => serializer.serializeToString(el));
    addXml = `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${parts.join("")}</root></mxGraphModel>`;
  }

  return { remove, update, addXml };
}

/**
 * Check if a patch is empty (no changes).
 */
export function isPatchEmpty(patch: CellPatch): boolean {
  return patch.remove.length === 0 && patch.update.length === 0 && patch.addXml === null;
}
