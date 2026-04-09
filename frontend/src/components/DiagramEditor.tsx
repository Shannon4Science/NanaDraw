import { DrawIoEmbed, type DrawIoEmbedRef, type UrlParameters } from "react-drawio";
import { inflateRaw } from "pako";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useLanguage, useT } from "../contexts/LanguageContext";
import {
  loadDiagramXml,
  migrateFromLocalStorage,
  removeDiagramXml,
  saveDiagramXml,
} from "../lib/diagramStorage";
import { diffCells, isPatchEmpty } from "../lib/xmlDiff";

export interface SaveToAssetsPayload {
  pngBase64: string;
  cellIds: string[];
  labels: string[];
}

export interface RegenCanvasCellInfo {
  id: string;
  label: string;
  visual_repr?: string;
  elementType?: string;
}

export interface RegenFromCanvasPayload {
  cells: RegenCanvasCellInfo[];
  pngBase64?: string;
  count: number;
}

export interface DiagramEditorHandle {
  loadXml: (xml: string) => void;
  addPage: (xml: string, pageName: string) => void;
  getXml: () => string;
  getCurrentPageXml: () => string;
  replaceCurrentPageXml: (pageXml: string) => void;
  exportSvg: () => void;
  exportPng: () => void;
  exportPngData: (callback: (pngDataUrl: string | null) => void) => void;
  mergeXml: (xml: string) => void;
  exportCanvasSvg: (callback: (svgData: string | null) => void) => void;
  replaceComponentImage: (componentId: string, imageB64: string) => void;
}

interface DiagramEditorProps {
  onXmlChange?: (xml: string) => void;
  onSaveToAssets?: (data: SaveToAssetsPayload) => void;
  onRegenFromCanvas?: (data: RegenFromCanvasPayload) => void;
  /** Called after debounced IndexedDB save when diagram has content (cloud sync hook). */
  onPersistCanvas?: (data: string) => void;
}

type PendingExportFormat = "svg" | "xmlsvg" | "png" | "png_data" | null;
type SelectionExportCallback = ((svgData: string | null) => void) | null;
type PngDataCallback = ((dataUrl: string | null) => void) | null;

const EMPTY_DIAGRAM =
  '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>';

const SAVE_DEBOUNCE_MS = 1500;
const MAX_LOAD_RETRIES = 4;
const LOAD_VERIFY_TIMEOUT_MS = 6000;

function countRootUserCells(root: Element): number {
  return Array.from(root.children).filter((c) => {
    const id = c.getAttribute("id");
    return id !== "0" && id !== "1";
  }).length;
}

function countUserCells(xml: string): number {
  try {
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    let total = 0;

    const diagrams = doc.querySelectorAll("mxfile > diagram");
    if (diagrams.length > 0) {
      for (const diagram of diagrams) {
        const root = diagram.querySelector("root");
        if (root) {
          total += countRootUserCells(root);
        } else if (diagram.textContent?.trim()) {
          try {
            const inner = decompressDiagramContent(diagram.textContent.trim());
            const innerDoc = new DOMParser().parseFromString(inner, "text/xml");
            const innerRoot = innerDoc.querySelector("root");
            total += innerRoot ? Math.max(1, countRootUserCells(innerRoot)) : 1;
          } catch {
            total += 1;
          }
        }
      }
      return total;
    }

    // Single-page mxGraphModel (no mxfile wrapper)
    const roots = doc.querySelectorAll("root");
    for (const root of roots) {
      total += countRootUserCells(root);
    }
    return total;
  } catch {
    return 0;
  }
}

function isNonEmptyDiagram(xml: string): boolean {
  if (!xml || xml === EMPTY_DIAGRAM) return false;
  try {
    const doc = new DOMParser().parseFromString(xml, "text/xml");

    // Multi-page mxfile: check ALL pages, not just the first
    const mxfile = doc.querySelector("mxfile");
    if (mxfile) {
      const diagrams = mxfile.querySelectorAll("diagram");
      if (diagrams.length === 0) return false;
      for (const diagram of diagrams) {
        // Page with inline <root> containing user cells
        const root = diagram.querySelector("root");
        if (root && root.children.length > 2) return true;
        // Page with compressed/base64 content (draw.io auto-compresses pages)
        const textContent = diagram.textContent?.trim();
        if (textContent && !diagram.querySelector("mxGraphModel")) return true;
        // Page with <mxGraphModel> that has user cells
        const model = diagram.querySelector("mxGraphModel > root");
        if (model && model.children.length > 2) return true;
      }
      // All pages are empty
      return false;
    }

    // Single-page mxGraphModel
    const root = doc.querySelector("root");
    if (!root) return false;
    return root.children.length > 2;
  } catch {
    return false;
  }
}

/**
 * Extract the inner <mxGraphModel> content from various XML formats.
 * Returns the full <mxGraphModel>...</mxGraphModel> string.
 */
function extractGraphModel(xml: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, "text/xml");

  const model = doc.querySelector("mxGraphModel");
  if (model) return new XMLSerializer().serializeToString(model);

  return xml;
}

/**
 * Decompress draw.io's deflate+base64 encoded diagram content.
 * draw.io stores: base64(deflateRaw(encodeURIComponent(xml)))
 */
function decompressDiagramContent(compressed: string): string {
  const binary = atob(compressed);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const inflated = inflateRaw(bytes, { to: "string" });
  return decodeURIComponent(inflated);
}

/**
 * Check if a diagram element is blank (only the 2 default root mxCells, no user content).
 */
function isDiagramBlank(diagram: Element): boolean {
  const model = diagram.querySelector("mxGraphModel");
  if (!model) return true;
  const cells = model.querySelectorAll("root > mxCell");
  const objects = model.querySelectorAll("root > object, root > UserObject");
  return cells.length <= 2 && objects.length === 0;
}

/**
 * Build a multi-page mxfile by appending a new diagram page.
 * If the current XML has only a single blank page, replaces it instead of appending.
 * Deduplicates the page name with _1, _2, etc.
 */
function addPageToXml(currentXml: string, newPageXml: string, pageName: string): string {
  const parser = new DOMParser();
  const serializer = new XMLSerializer();

  let mxfile: Document;
  const currentDoc = parser.parseFromString(currentXml, "text/xml");
  const existingMxfile = currentDoc.querySelector("mxfile");

  if (existingMxfile) {
    mxfile = currentDoc;
  } else {
    mxfile = parser.parseFromString("<mxfile></mxfile>", "text/xml");
    const mxfileEl = mxfile.querySelector("mxfile")!;

    const firstDiagram = mxfile.createElement("diagram");
    firstDiagram.setAttribute("id", `page_${Date.now()}`);
    firstDiagram.setAttribute("name", "Page 1");
    const graphModel = currentDoc.querySelector("mxGraphModel");
    if (graphModel) {
      firstDiagram.appendChild(mxfile.importNode(graphModel, true));
    }
    mxfileEl.appendChild(firstDiagram);
  }

  const mxfileEl = mxfile.querySelector("mxfile")!;
  const diagrams = mxfileEl.querySelectorAll("diagram");

  // If there is exactly one blank page, replace it instead of appending
  if (diagrams.length === 1 && isDiagramBlank(diagrams[0])) {
    mxfileEl.removeChild(diagrams[0]);
  }

  const existingNames = new Set<string>();
  mxfileEl.querySelectorAll("diagram").forEach((d) => {
    const name = d.getAttribute("name");
    if (name) existingNames.add(name);
  });

  let finalName = pageName;
  if (existingNames.has(finalName)) {
    let counter = 1;
    while (existingNames.has(`${pageName}_${counter}`)) counter++;
    finalName = `${pageName}_${counter}`;
  }

  const newDiagram = mxfile.createElement("diagram");
  newDiagram.setAttribute("id", `page_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
  newDiagram.setAttribute("name", finalName);

  const newModel = extractGraphModel(newPageXml);
  const newModelDoc = parser.parseFromString(newModel, "text/xml");
  const modelEl = newModelDoc.querySelector("mxGraphModel");
  if (modelEl) {
    newDiagram.appendChild(mxfile.importNode(modelEl, true));
  }

  mxfileEl.appendChild(newDiagram);

  return serializer.serializeToString(mxfile);
}

function downloadFile(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function base64ToUtf8(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

function downloadBase64Blob(filename: string, base64: string, mimeType: string) {
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  const blob = new Blob([arr], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export const DiagramEditor = forwardRef<DiagramEditorHandle, DiagramEditorProps>(
  function DiagramEditor({ onXmlChange, onSaveToAssets, onRegenFromCanvas, onPersistCanvas }, ref) {
    const { locale } = useLanguage();
    const t = useT();
    const langChangeXmlRef = useRef<string | null>(null);
    const prevLocaleRef = useRef(locale);
    const drawioRef = useRef<DrawIoEmbedRef>(null);
    const pendingFormat = useRef<PendingExportFormat>(null);
    const selectionExportCb = useRef<SelectionExportCallback>(null);
    const pngDataCb = useRef<PngDataCallback>(null);
    const currentXmlRef = useRef<string>(EMPTY_DIAGRAM);
    const saveTimerRef = useRef<ReturnType<typeof setTimeout>>();
    const hasLoadedRef = useRef(false);
    const pendingLoadRef = useRef<{
      xml: string;
      expectedCells: number;
      retries: number;
    } | null>(null);
    const loadVerifyTimerRef = useRef<ReturnType<typeof setTimeout>>();
    const activePageIndexRef = useRef(0);

    const [recoveryXml, setRecoveryXml] = useState<string | null>(null);
    const externalLoadedRef = useRef(false);
    const onPersistCanvasRef = useRef(onPersistCanvas);
    useLayoutEffect(() => {
      onPersistCanvasRef.current = onPersistCanvas;
    });

    // Save current XML before iframe remounts due to locale change
    useLayoutEffect(() => {
      if (prevLocaleRef.current !== locale) {
        langChangeXmlRef.current = currentXmlRef.current;
        prevLocaleRef.current = locale;
      }
    });

    // Async recovery: load from IndexedDB (and migrate any old localStorage data)
    useEffect(() => {
      let cancelled = false;
      (async () => {
        try {
          const migrated = await migrateFromLocalStorage();
          if (cancelled || externalLoadedRef.current) return;
          if (migrated && isNonEmptyDiagram(migrated)) {
            setRecoveryXml(migrated);
            return;
          }
          const saved = await loadDiagramXml();
          if (cancelled || externalLoadedRef.current) return;
          if (saved && isNonEmptyDiagram(saved)) {
            setRecoveryXml(saved);
          }
        } catch {
          /* IndexedDB unavailable */
        }
      })();
      return () => { cancelled = true; };
    }, []);

    const saveToStorage = useCallback((xml: string) => {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        if (isNonEmptyDiagram(xml)) {
          saveDiagramXml(xml).catch((e) => {
            console.warn(
              "[DiagramEditor] IndexedDB save failed (xml size=%dKB): %s",
              Math.round(xml.length / 1024),
              e,
            );
          });
          onPersistCanvasRef.current?.(xml);
        }
      }, SAVE_DEBOUNCE_MS);
    }, []);

    const retryOrGiveUpRef = useRef<() => void>(null!);
    const retryOrGiveUp = useCallback(() => {
      const pending = pendingLoadRef.current;
      if (!pending) return;

      clearTimeout(loadVerifyTimerRef.current);

      if (pending.retries < MAX_LOAD_RETRIES) {
        pending.retries++;
        console.warn(
          `[DiagramEditor] Load verification failed, retry ${pending.retries}/${MAX_LOAD_RETRIES}`,
        );
        drawioRef.current?.load({ xml: pending.xml });
        loadVerifyTimerRef.current = setTimeout(
          retryOrGiveUpRef.current,
          LOAD_VERIFY_TIMEOUT_MS,
        );
      } else {
        console.error(
          `[DiagramEditor] Load failed after ${MAX_LOAD_RETRIES} retries`,
        );
        pendingLoadRef.current = null;
      }
    }, []);
    useLayoutEffect(() => {
      retryOrGiveUpRef.current = retryOrGiveUp;
    });

    useImperativeHandle(ref, () => ({
      loadXml: (xml: string) => {
        clearTimeout(loadVerifyTimerRef.current);
        externalLoadedRef.current = true;
        setRecoveryXml(null);
        currentXmlRef.current = xml;
        drawioRef.current?.load({ xml });
        saveToStorage(xml);

        const expected = countUserCells(xml);
        if (expected > 0) {
          pendingLoadRef.current = { xml, expectedCells: expected, retries: 0 };
          loadVerifyTimerRef.current = setTimeout(
            retryOrGiveUp,
            LOAD_VERIFY_TIMEOUT_MS,
          );
        } else {
          pendingLoadRef.current = null;
        }
      },
      addPage: (xml: string, pageName: string) => {
        clearTimeout(loadVerifyTimerRef.current);
        const combined = addPageToXml(currentXmlRef.current, xml, pageName);
        currentXmlRef.current = combined;

        const parser = new DOMParser();
        const doc = parser.parseFromString(combined, "text/xml");
        const pageCount = doc.querySelectorAll("mxfile > diagram").length;
        const newPageIdx = Math.max(0, pageCount - 1);
        activePageIndexRef.current = newPageIdx;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (drawioRef.current as any)?.load({ xml: combined, page: newPageIdx });
        saveToStorage(combined);
        pendingLoadRef.current = null;
      },
      getXml: () => currentXmlRef.current,
      getCurrentPageXml: () => {
        const full = currentXmlRef.current;
        if (!full.includes("<mxfile")) return full;
        const doc = new DOMParser().parseFromString(full, "text/xml");
        const diagrams = doc.querySelectorAll("mxfile > diagram");
        const idx = Math.min(activePageIndexRef.current, diagrams.length - 1);
        const target = diagrams[idx];
        if (!target) return full;
        const model = target.querySelector("mxGraphModel");
        if (model) return new XMLSerializer().serializeToString(model);

        // draw.io auto-save may compress diagram content as deflate+base64
        const compressed = target.textContent?.trim();
        if (compressed) {
          try {
            return decompressDiagramContent(compressed);
          } catch {
            /* not compressed or decompression failed */
          }
        }
        return target.innerHTML;
      },
      replaceCurrentPageXml: (pageXml: string) => {
        console.log("[DiagramEditor] replaceCurrentPageXml called, xml length:", pageXml.length);

        // Extract the current page XML for diffing
        const currentPageXml = (() => {
          const f = currentXmlRef.current;
          if (!f.includes("<mxfile")) return f;
          const d = new DOMParser().parseFromString(f, "text/xml");
          const diagrams = d.querySelectorAll("mxfile > diagram");
          const t = diagrams[Math.min(activePageIndexRef.current, diagrams.length - 1)];
          if (!t) return f;
          const m = t.querySelector("mxGraphModel");
          if (m) return new XMLSerializer().serializeToString(m);
          const c = t.textContent?.trim();
          if (c) { try { return decompressDiagramContent(c); } catch { /* */ } }
          return t.innerHTML;
        })();

        // Compute cell-level diff (skips image cells automatically)
        const patch = diffCells(currentPageXml, pageXml);
        console.log("[DiagramEditor] diffCells result: remove=%d update=%d add=%s",
          patch.remove.length, patch.update.length, patch.addXml ? "yes" : "no");

        if (isPatchEmpty(patch)) {
          console.log("[DiagramEditor] No cell changes detected, skipping update");
          return;
        }

        // Update internal state: merge new XML into mxfile for persistence.
        // For image cells, restore nanadraw://img/ → base64 using current page data.
        const mergedPageXml = (() => {
          const NANADRAW_RE = /nanadraw:\/\/img\/[a-f0-9]{64}/;
          if (!NANADRAW_RE.test(pageXml)) return pageXml;

          const oldDoc = new DOMParser().parseFromString(currentPageXml, "text/xml");
          const idToLabel = new Map<string, string>();
          for (const tag of ["UserObject", "object"]) {
            for (const elem of oldDoc.querySelectorAll(tag)) {
              const id = elem.getAttribute("id");
              const label = elem.getAttribute("label") ?? "";
              if (id && label.includes("data:image/")) {
                idToLabel.set(id, label);
              }
            }
          }
          if (idToLabel.size === 0) return pageXml;

          const newDoc = new DOMParser().parseFromString(pageXml, "text/xml");
          for (const tag of ["UserObject", "object"]) {
            for (const elem of newDoc.querySelectorAll(tag)) {
              const id = elem.getAttribute("id");
              const label = elem.getAttribute("label") ?? "";
              if (id && label.includes("nanadraw://img/") && idToLabel.has(id)) {
                elem.setAttribute("label", idToLabel.get(id)!);
              }
            }
          }
          return new XMLSerializer().serializeToString(newDoc);
        })();

        const full = currentXmlRef.current;
        if (!full.includes("<mxfile")) {
          currentXmlRef.current = mergedPageXml;
        } else {
          const doc = new DOMParser().parseFromString(full, "text/xml");
          const diagrams = doc.querySelectorAll("mxfile > diagram");
          const idx = Math.min(activePageIndexRef.current, diagrams.length - 1);
          const target = diagrams[idx];
          if (target) {
            const wrapper = doc.createElement("diagram");
            wrapper.setAttribute("name", target.getAttribute("name") || `Page-${idx + 1}`);
            wrapper.setAttribute("id", target.getAttribute("id") || `page_${idx}`);
            const parsed = new DOMParser().parseFromString(mergedPageXml, "text/xml");
            const model = parsed.querySelector("mxGraphModel");
            if (model) {
              wrapper.appendChild(doc.importNode(model, true));
            } else {
              wrapper.innerHTML = mergedPageXml;
            }
            target.replaceWith(wrapper);
            currentXmlRef.current = new XMLSerializer().serializeToString(doc);
          }
        }
        saveToStorage(currentXmlRef.current);

        // Send patchCells to draw.io (tiny payload: only IDs + changed attrs)
        const iframe = document.querySelector(".diagrams-iframe") as HTMLIFrameElement;
        if (iframe?.contentWindow) {
          const patchMsg = {
            action: "patchCells" as const,
            remove: patch.remove,
            update: patch.update,
            add: patch.addXml,
          };
          console.log("[DiagramEditor] Sending patchCells postMessage, payload size:",
            JSON.stringify(patchMsg).length);

          const responseHandler = (evt: MessageEvent) => {
            if (typeof evt.data !== "string") return;
            try {
              const msg = JSON.parse(evt.data);
              if (msg.event === "patchCells") {
                window.removeEventListener("message", responseHandler);
                if (msg.success) {
                  console.log("[DiagramEditor] patchCells succeeded: removed=%d updated=%d",
                    msg.removed, msg.updated);
                } else {
                  console.error("[DiagramEditor] patchCells FAILED, falling back to drawioRef.load");
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  (drawioRef.current as any)?.load({
                    xml: currentXmlRef.current,
                    page: activePageIndexRef.current,
                  });
                }
              }
            } catch { /* ignore non-JSON messages */ }
          };
          window.addEventListener("message", responseHandler);

          iframe.contentWindow.postMessage(JSON.stringify(patchMsg), "*");
        } else {
          console.warn("[DiagramEditor] iframe not found, using drawioRef.load fallback");
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (drawioRef.current as any)?.load({
            xml: currentXmlRef.current,
            page: activePageIndexRef.current,
          });
        }
      },
      exportSvg: () => {
        pendingFormat.current = "svg";
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (drawioRef.current as any)?.exportDiagram({ format: "svg", currentPage: true });
      },
      exportPng: () => {
        pendingFormat.current = "png";
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (drawioRef.current as any)?.exportDiagram({ format: "png", currentPage: true });
      },
      exportPngData: (callback: (pngDataUrl: string | null) => void) => {
        if (!isNonEmptyDiagram(currentXmlRef.current)) {
          callback(null);
          return;
        }
        pngDataCb.current = callback;
        pendingFormat.current = "png_data";
        drawioRef.current?.exportDiagram({ format: "png" });
        const timer = setTimeout(() => {
          if (pngDataCb.current === callback) {
            pngDataCb.current = null;
            callback(null);
          }
        }, 10000);
        const origCb = callback;
        pngDataCb.current = (data) => {
          clearTimeout(timer);
          origCb(data);
        };
      },
      mergeXml: (xml: string) => {
        const currentXml = currentXmlRef.current;
        const parser = new DOMParser();
        const serializer = new XMLSerializer();
        const doc = parser.parseFromString(currentXml, "text/xml");

        let root: Element | null = null;

        if (currentXml.includes("<mxfile")) {
          const diagrams = doc.querySelectorAll("mxfile > diagram");
          const pageIdx = Math.min(activePageIndexRef.current, diagrams.length - 1);
          const target = diagrams[pageIdx];
          if (target) {
            root = target.querySelector("mxGraphModel > root") ?? target.querySelector("root");
            if (!root) {
              const model = doc.createElement("mxGraphModel");
              root = doc.createElement("root");
              const c0 = doc.createElement("mxCell");
              c0.setAttribute("id", "0");
              const c1 = doc.createElement("mxCell");
              c1.setAttribute("id", "1");
              c1.setAttribute("parent", "0");
              root.appendChild(c0);
              root.appendChild(c1);
              model.appendChild(root);
              target.appendChild(model);
            }
          }
        } else {
          root = doc.querySelector("mxGraphModel > root") ?? doc.querySelector("root");
        }

        if (!root) {
          currentXmlRef.current = xml;
          drawioRef.current?.load({ xml });
          return;
        }

        const mergeDoc = parser.parseFromString(xml, "text/xml");
        const mergeRoot = mergeDoc.querySelector("root");
        if (mergeRoot) {
          for (const cell of Array.from(mergeRoot.children)) {
            const id = cell.getAttribute("id");
            if (id !== "0" && id !== "1") {
              root.appendChild(doc.importNode(cell, true));
            }
          }
        }

        const updated = serializer.serializeToString(doc);
        currentXmlRef.current = updated;

        // Use mergeCells action to insert cells into the CURRENT page
        // without reloading the diagram (load() ignores the page param
        // and always navigates to urlParams['page'] = last page).
        const iframe = document.querySelector(".diagrams-iframe") as HTMLIFrameElement;
        if (iframe?.contentWindow) {
          iframe.contentWindow.postMessage(
            JSON.stringify({ action: "mergeCells", xml }),
            "*",
          );
        }

        saveToStorage(updated);
      },
      exportCanvasSvg: (callback: (svgData: string | null) => void) => {
        if (!isNonEmptyDiagram(currentXmlRef.current)) {
          callback(null);
          return;
        }
        selectionExportCb.current = callback;
        drawioRef.current?.exportDiagram({ format: "svg" });
        const timer = setTimeout(() => {
          if (selectionExportCb.current === callback) {
            selectionExportCb.current = null;
            callback(null);
          }
        }, 5000);
        const origCb = callback;
        selectionExportCb.current = (data) => {
          clearTimeout(timer);
          origCb(data);
        };
      },
      replaceComponentImage: (componentId: string, imageB64: string) => {
        const currentXml = currentXmlRef.current;
        const parser = new DOMParser();
        const doc = parser.parseFromString(currentXml, "text/xml");

        const updates: Array<{ id: string; value?: string; style?: string }> = [];

        const allCells = doc.querySelectorAll("mxCell");
        for (const cell of Array.from(allCells)) {
          const parentEl = cell.parentElement;
          const isWrapped = parentEl?.tagName === "UserObject" || parentEl?.tagName === "object";
          const cellId = (isWrapped ? parentEl!.getAttribute("id") : cell.getAttribute("id")) || "";
          if (cellId !== componentId && !cellId.startsWith(`${componentId}_`)) continue;

          const val = (isWrapped ? parentEl!.getAttribute("label") : cell.getAttribute("value")) || "";

          if (val.includes("data:image/png;base64,")) {
            const newVal = val.replace(
              /data:image\/png;base64,[^"&]+/,
              `data:image/png;base64,${imageB64}`,
            );
            updates.push({ id: cellId, value: newVal });
            continue;
          }

          const style = cell.getAttribute("style") || "";
          if (style.match(/image=data:image\/[^;]+;base64,/)) {
            const newStyle = style.replace(
              /image=data:image\/[^;]+;base64,[^;"]*/,
              `image=data:image/png;base64,${imageB64}`,
            );
            updates.push({ id: cellId, style: newStyle });
            continue;
          }
          if (style.match(/image=data:image\//)) {
            const newStyle = style.replace(
              /image=data:image\/[^;"]*/,
              `image=data:image/png;base64,${imageB64}`,
            );
            updates.push({ id: cellId, style: newStyle });
            continue;
          }
          const imageStyle =
            `shape=image;verticalLabelPosition=bottom;labelBackgroundColor=default;` +
            `verticalAlign=top;aspect=fixed;imageAspect=0;` +
            `image=data:image/png;base64,${imageB64}`;
          updates.push({ id: cellId, value: "", style: imageStyle });
        }

        if (updates.length === 0) return;

        const iframe = document.querySelector(".diagrams-iframe") as HTMLIFrameElement | null;
        if (iframe?.contentWindow) {
          iframe.contentWindow.postMessage(
            JSON.stringify({ action: "updateCells", cells: updates }),
            "*",
          );
        } else {
          // Fallback: full load (loses undo stack)
          const serializer = new XMLSerializer();
          for (const u of updates) {
            for (const cell of Array.from(allCells)) {
              const parentEl = cell.parentElement;
              const isWrapped = parentEl?.tagName === "UserObject" || parentEl?.tagName === "object";
              const cid = (isWrapped ? parentEl!.getAttribute("id") : cell.getAttribute("id")) || "";
              if (cid !== u.id) continue;
              if (u.value !== undefined) {
                if (isWrapped) parentEl!.setAttribute("label", u.value);
                else cell.setAttribute("value", u.value);
              }
              if (u.style !== undefined) cell.setAttribute("style", u.style);
            }
          }
          const updated = serializer.serializeToString(doc);
          currentXmlRef.current = updated;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (drawioRef.current as any)?.load({ xml: updated, page: activePageIndexRef.current });
          saveToStorage(updated);
        }
      },
    }));

    const handleAutoSave = useCallback(
      (data: { xml?: string; currentPage?: number }) => {
        if (typeof data.currentPage === "number") {
          activePageIndexRef.current = data.currentPage;
        }
        if (data.xml) {
          const wasMultiPage = currentXmlRef.current.includes("<mxfile");
          const isMultiPage = data.xml.includes("<mxfile");

          // Protect multi-page structure: don't let single-page autosave overwrite our mxfile
          if (wasMultiPage && !isMultiPage) {
            // Still check pending load verification — single-page autosave proves draw.io rendered content
            const pending = pendingLoadRef.current;
            if (pending) {
              const received = countUserCells(data.xml);
              if (received >= 1) {
                pendingLoadRef.current = null;
                clearTimeout(loadVerifyTimerRef.current);
              }
            }
            return;
          }

          currentXmlRef.current = data.xml;
          saveToStorage(data.xml);

          const pending = pendingLoadRef.current;
          if (pending) {
            const received = countUserCells(data.xml);
            if (
              received >=
              Math.max(1, Math.floor(pending.expectedCells * 0.5))
            ) {
              pendingLoadRef.current = null;
              clearTimeout(loadVerifyTimerRef.current);
            } else {
              retryOrGiveUp();
            }
          }
        }
      },
      [saveToStorage, retryOrGiveUp],
    );

    const handleExport = useCallback(
      (data: { data: string }) => {
        if (!data.data) return;

        // Selection export takes priority if pending
        if (selectionExportCb.current) {
          const cb = selectionExportCb.current;
          selectionExportCb.current = null;
          let svgText = data.data;
          // draw.io svg format may return data URL — decode to raw SVG
          if (svgText.startsWith("data:image/svg+xml;base64,")) {
            svgText = base64ToUtf8(svgText.slice("data:image/svg+xml;base64,".length));
          } else if (svgText.startsWith("data:image/svg+xml,")) {
            svgText = decodeURIComponent(svgText.slice("data:image/svg+xml,".length));
          }
          cb(svgText);
          return;
        }

        const fmt = pendingFormat.current;
        pendingFormat.current = null;

        if (fmt === "png_data" && pngDataCb.current) {
          const cb = pngDataCb.current;
          pngDataCb.current = null;
          const dataUrl = data.data.startsWith("data:")
            ? data.data
            : `data:image/png;base64,${data.data}`;
          cb(dataUrl);
          return;
        }

        if (fmt === "png") {
          let b64 = data.data;
          if (b64.startsWith("data:image/png;base64,")) {
            b64 = b64.slice("data:image/png;base64,".length);
          }
          downloadBase64Blob("diagram.png", b64, "image/png");
        } else if (fmt === "svg" || fmt === "xmlsvg") {
          let svgContent = data.data;
          // Handle various data URL formats draw.io may return:
          //   data:image/svg+xml;base64,...
          //   data:image/svg+xml;charset=utf-8;base64,...
          //   data:image/svg+xml,...  (URL-encoded)
          const b64Idx = svgContent.indexOf(";base64,");
          if (svgContent.startsWith("data:image/svg+xml") && b64Idx >= 0) {
            svgContent = base64ToUtf8(svgContent.slice(b64Idx + 8));
          } else if (svgContent.startsWith("data:image/svg+xml,")) {
            svgContent = decodeURIComponent(svgContent.slice("data:image/svg+xml,".length));
          }
          // Ensure XML declaration for proper encoding recognition
          if (!svgContent.startsWith("<?xml") && svgContent.includes("<svg")) {
            svgContent = '<?xml version="1.0" encoding="UTF-8"?>\n' + svgContent;
          }
          downloadFile("diagram.svg", svgContent, "image/svg+xml");
        }

        if (onXmlChange) {
          onXmlChange(data.data);
        }
      },
      [onXmlChange],
    );

    const [editorLoading, setEditorLoading] = useState(true);

    const handleLoad = useCallback(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (data?: any) => {
        hasLoadedRef.current = true;
        setEditorLoading(false);
        if (typeof data?.currentPage === "number") {
          activePageIndexRef.current = data.currentPage;
        }
        if (pendingLoadRef.current) {
          pendingLoadRef.current = null;
          clearTimeout(loadVerifyTimerRef.current);
        }
        if (langChangeXmlRef.current) {
          const xml = langChangeXmlRef.current;
          langChangeXmlRef.current = null;
          setTimeout(() => {
            drawioRef.current?.load({ xml });
          }, 300);
        } else if (externalLoadedRef.current && isNonEmptyDiagram(currentXmlRef.current)) {
          externalLoadedRef.current = false;
          const xml = currentXmlRef.current;
          setTimeout(() => {
            drawioRef.current?.load({ xml });
          }, 300);
        }
      },
      [],
    );

    useEffect(() => {
      return () => {
        clearTimeout(saveTimerRef.current);
        clearTimeout(loadVerifyTimerRef.current);
      };
    }, []);

    // Listen for NanaDraw custom messages from draw.io iframe
    const onSaveToAssetsRef = useRef(onSaveToAssets);
    const onRegenFromCanvasRef = useRef(onRegenFromCanvas);
    useLayoutEffect(() => {
      onSaveToAssetsRef.current = onSaveToAssets;
      onRegenFromCanvasRef.current = onRegenFromCanvas;
    });

    useEffect(() => {
      const handler = (evt: MessageEvent) => {
        if (typeof evt.data !== "string") return;
        try {
          const msg = JSON.parse(evt.data);

          // Track page switches from draw.io (fired when user clicks a page tab)
          if (msg.event === "pageSelected" || msg.event === "page" || msg.event === "currentPage") {
            const p = typeof msg.page === "number" ? msg.page
              : typeof msg.message?.page === "number" ? msg.message.page
              : typeof msg.pageIndex === "number" ? msg.pageIndex
              : undefined;
            if (p !== undefined) {
              activePageIndexRef.current = p;
            }
          }

          if (msg.event === "nanadraw:saveToAssets" && onSaveToAssetsRef.current) {
            onSaveToAssetsRef.current({
              pngBase64: msg.pngBase64,
              cellIds: msg.cellIds,
              labels: msg.labels,
            });
          } else if (msg.event === "nanadraw:regen" && onRegenFromCanvasRef.current) {
            const raw = Array.isArray(msg.cells)
              ? msg.cells
              : Array.isArray(msg.cellInfos)
                ? msg.cellInfos
                : [];
            const cells: RegenCanvasCellInfo[] = raw
              .map((c: unknown) => {
                const o = c as Record<string, unknown>;
                const id = String(o.id ?? o.cellId ?? "").trim();
                if (!id) return null;
                const label = String(o.label ?? "");
                const vr =
                  typeof o.visual_repr === "string" && o.visual_repr.trim()
                    ? o.visual_repr.trim()
                    : undefined;
                const elementType =
                  typeof o.elementType === "string" ? o.elementType : undefined;
                return { id, label, ...(vr ? { visual_repr: vr } : {}), ...(elementType ? { elementType } : {}) };
              })
              .filter((c: RegenCanvasCellInfo | null): c is RegenCanvasCellInfo => c !== null);
            const count = typeof msg.count === "number" ? msg.count : cells.length;
            onRegenFromCanvasRef.current({
              cells,
              pngBase64: msg.pngBase64,
              count,
            });
          }
        } catch {
          // Not a NanaDraw message — ignore
        }
      };
      window.addEventListener("message", handler);
      return () => window.removeEventListener("message", handler);
    }, []);

    return (
      <div className="relative h-full w-full">
        <DrawIoEmbed
          key={locale}
          ref={drawioRef}
          baseUrl={import.meta.env.VITE_DRAWIO_BASE_URL || `${window.location.origin}${import.meta.env.BASE_URL}drawio/`}
          autosave={true}
          onAutoSave={handleAutoSave}
          onExport={handleExport}
          onLoad={handleLoad}
          urlParameters={
            {
              dev: 1,
              ui: "kennedy",
              lang: locale,
              spin: false,
              libraries: true,
              saveAndExit: false,
              noSaveBtn: true,
              noExitBtn: true,
              pages: true,
              page: 999999,
            } as UrlParameters
          }
        />

        {/* Loading overlay */}
        {editorLoading && (
          <div className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-white/80 backdrop-blur-sm transition-opacity duration-300">
            <div className="flex flex-col items-center gap-4">
              <div className="relative h-12 w-12">
                <div className="absolute inset-0 animate-spin rounded-full border-[3px] border-amber-200 border-t-amber-500" />
              </div>
              <div className="text-center">
                <p className="text-sm font-medium text-stone-600">{t("editor.loading")}</p>
                <p className="mt-1 text-xs text-stone-400">{t("editor.loadingTip")}</p>
              </div>
            </div>
          </div>
        )}

        {/* Recovery banner */}
        {recoveryXml && (
          <div className="absolute left-1/2 top-3 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 shadow-lg">
            <svg
              className="h-5 w-5 flex-shrink-0 text-amber-500"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M13 16h-1v-4h-1m1-4h.01M12 2a10 10 0 100 20 10 10 0 000-20z"
              />
            </svg>
            <span className="text-sm text-amber-800">
              {t("editor.unsavedContent")}
            </span>
            <button
              onClick={() => {
                currentXmlRef.current = recoveryXml;
                let pageIdx = 0;
                if (recoveryXml.includes("<mxfile")) {
                  const d = new DOMParser().parseFromString(recoveryXml, "text/xml");
                  const cnt = d.querySelectorAll("mxfile > diagram").length;
                  pageIdx = Math.max(0, cnt - 1);
                }
                activePageIndexRef.current = pageIdx;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (drawioRef.current as any)?.load({ xml: recoveryXml, page: pageIdx });
                setRecoveryXml(null);
              }}
              className="rounded bg-amber-500 px-3 py-1 text-xs font-medium text-white hover:bg-amber-600"
            >
              {t("editor.recover")}
            </button>
            <button
              onClick={() => {
                setRecoveryXml(null);
                removeDiagramXml().catch(() => {});
              }}
              className="rounded bg-gray-200 px-3 py-1 text-xs font-medium text-gray-600 hover:bg-gray-300"
            >
              {t("editor.discard")}
            </button>
          </div>
        )}
      </div>
    );
  },
);
