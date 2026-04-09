import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fetchBioiconSvg, fetchUserElementContent, fetchUserElementContentAsBase64 } from "../services/api";
import { useT } from "../contexts/LanguageContext";
import { useBioicons } from "../hooks/useBioicons";
import type { useUserElements } from "../hooks/useUserElements";
import type { DiagramEditorHandle } from "./DiagramEditor";
import { AssetGeneratorPanel } from "./AssetGeneratorPanel";

const PATH_PREFIX = import.meta.env.BASE_URL.replace(/\/$/, "");

function withPrefix(url: string): string {
  if (!url || !url.startsWith("/") || url.startsWith(PATH_PREFIX)) return url;
  return `${PATH_PREFIX}${url}`;
}

// Cache fetched element thumbnails as data URLs so they can be reused for drag ghost preview.
const _thumbCache = new Map<string, string>();

function UserElementThumb({ elementId, fileType, alt }: { elementId: string; fileType: string; alt: string }) {
  const [src, setSrc] = useState<string | undefined>(_thumbCache.get(elementId));

  useEffect(() => {
    if (_thumbCache.has(elementId)) {
      return;
    }
    let cancelled = false;
    fetchUserElementContentAsBase64(elementId)
      .then((b64) => {
        if (cancelled) return;
        const mime = fileType === "png" ? "image/png" : "image/svg+xml";
        const dataUrl = `data:${mime};base64,${b64}`;
        _thumbCache.set(elementId, dataUrl);
        setSrc(dataUrl);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [elementId, fileType]);

  if (!src) return <div className="h-10 w-10 animate-pulse rounded bg-gray-100" />;
  return <img src={src} alt={alt} className="max-h-10 max-w-10 object-contain" draggable={false} />;
}

type TabId = "bioicons" | "my";

interface BioiconsDrawerProps {
  editorRef: React.RefObject<DiagramEditorHandle | null>;
  onClose: () => void;
  userElements: ReturnType<typeof useUserElements>;
  imageModel?: string;
}

interface IconData {
  id: string;
  name: string;
  w: number;
  h: number;
  svg_url: string;
  author: string;
  license: string;
}

let _mergeCounter = 0;
function nextMergeId() {
  return `asset_${Date.now()}_${++_mergeCounter}`;
}

let _insertOffset = 0;

function buildMergeXml(svgText: string, w: number, h: number): string {
  const id = nextMergeId();
  const col = _insertOffset % 8;
  const row = Math.floor(_insertOffset / 8) % 6;
  const x = 80 + col * 100;
  const y = 80 + row * 100;
  _insertOffset++;

  // URL-encode SVG instead of base64 to avoid `;` in `data:...;base64,`
  // conflicting with draw.io's style delimiter which also uses `;`
  const encodedSvg = encodeURIComponent(svgText);
  const style = [
    "shape=image",
    "verticalLabelPosition=bottom",
    "labelBackgroundColor=default",
    "verticalAlign=top",
    "aspect=fixed",
    "imageAspect=0",
    `image=data:image/svg+xml,${encodedSvg}`,
  ].join(";");

  return [
    "<mxGraphModel>",
    "  <root>",
    '    <mxCell id="0"/>',
    '    <mxCell id="1" parent="0"/>',
    `    <mxCell id="${id}" value="" style="${style}" vertex="1" parent="1">`,
    `      <mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry"/>`,
    "    </mxCell>",
    "  </root>",
    "</mxGraphModel>",
  ].join("\n");
}

const svgTextCache = new Map<string, string>();
const DRAG_THRESHOLD = 5;

export function BioiconsDrawer({ editorRef, onClose, userElements, imageModel }: BioiconsDrawerProps) {
  const t = useT();
  const bio = useBioicons();
  const { search: bioSearch, loadMore: bioLoadMore } = bio;
  const userEls = userElements;
  const [activeTab, setActiveTab] = useState<TabId>("bioicons");
  const [searchInput, setSearchInput] = useState("");
  const [sidebarExpanded, setSidebarExpanded] = useState(true);
  const [insertingId, setInsertingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [generatorOpen, setGeneratorOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Drag state (refs to avoid re-render loops in global listeners)
  const dragInfoRef = useRef<{
    icon: IconData;
    startX: number;
    startY: number;
    moved: boolean;
    source: "bioicon" | "user";
    fileType?: string;
  } | null>(null);
  const [ghostPos, setGhostPos] = useState<{
    x: number;
    y: number;
    url: string;
    overEditor: boolean;
  } | null>(null);

  const handleSearchChange = useCallback(
    (value: string) => {
      setSearchInput(value);
      clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        bioSearch(value.trim());
      }, 300);
    },
    [bioSearch],
  );

  const clearSearch = useCallback(() => {
    setSearchInput("");
    bioSearch("");
  }, [bioSearch]);

  const doInsert = useCallback(
    async (icon: { id: string; w: number; h: number }) => {
      setInsertingId(icon.id);
      try {
        let svgText = svgTextCache.get(icon.id);
        if (!svgText) {
          svgText = await fetchBioiconSvg(icon.id);
          svgTextCache.set(icon.id, svgText);
        }
        const scale = Math.min(240 / icon.w, 240 / icon.h);
        const w = Math.round(icon.w * scale);
        const h = Math.round(icon.h * scale);
        const xml = buildMergeXml(svgText, w, h);
        editorRef.current?.mergeXml(xml);
      } catch (e) {
        console.error("Failed to insert bioicon:", e);
      } finally {
        setInsertingId(null);
      }
    },
    [editorRef],
  );

  const doInsertUserElement = useCallback(
    async (el: { id: string; width: number | null; height: number | null; file_type: string }) => {
      setInsertingId(el.id);
      try {
        const w = el.width || 240;
        const h = el.height || 240;
        const isSvg = el.file_type === "svg";
        const scale = isSvg
          ? Math.min(240 / w, 240 / h)
          : Math.min(240 / w, 240 / h, 1);
        const sw = Math.round(w * scale);
        const sh = Math.round(h * scale);

        if (isSvg) {
          const content = await fetchUserElementContent(el.id);
          const xml = buildMergeXml(content, sw, sh);
          editorRef.current?.mergeXml(xml);
        } else {
          const b64 = await fetchUserElementContentAsBase64(el.id);
          const svgWrapper = [
            `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${sw}" height="${sh}">`,
            `  <image xlink:href="data:image/png;base64,${b64}" width="${sw}" height="${sh}" />`,
            `</svg>`,
          ].join("");
          const xml = buildMergeXml(svgWrapper, sw, sh);
          editorRef.current?.mergeXml(xml);
        }
      } catch (e) {
        console.error("Failed to insert user element:", e);
      } finally {
        setInsertingId(null);
      }
    },
    [editorRef],
  );

  const handleUpload = useCallback(async () => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        await userEls.upload(file);
      } catch {
        // error handled in hook
      }
      e.target.value = "";
    },
    [userEls],
  );

  const handleDeleteElement = useCallback(
    async (elId: string) => {
      setDeletingId(elId);
      await userEls.remove(elId);
      setDeletingId(null);
    },
    [userEls],
  );

  const handleSaveGenerated = useCallback(
    async (imageB64: string, name: string): Promise<boolean> => {
      try {
        const byteString = atob(imageB64);
        const ab = new Uint8Array(byteString.length);
        for (let i = 0; i < byteString.length; i++) ab[i] = byteString.charCodeAt(i);
        const blob = new Blob([ab], { type: "image/png" });
        const file = new File([blob], `${name}.png`, { type: "image/png" });
        await userEls.upload(file, name);
        return true;
      } catch (e) {
        console.error("Failed to save generated asset:", e);
        return false;
      }
    },
    [userEls],
  );

  const doInsertRef = useRef(doInsert);
  doInsertRef.current = doInsert;
  const doInsertUserRef = useRef(doInsertUserElement);
  doInsertUserRef.current = doInsertUserElement;

  const handleIconMouseDown = useCallback(
    (e: React.MouseEvent, icon: IconData, source: "bioicon" | "user" = "bioicon", fileType?: string) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragInfoRef.current = {
        icon,
        startX: e.clientX,
        startY: e.clientY,
        moved: false,
        source,
        fileType,
      };
    },
    [],
  );

  // Transparent overlay to capture mouse events above the iframe during drag
  const overlayRef = useRef<HTMLDivElement | null>(null);

  function showDragOverlay() {
    if (overlayRef.current) return;
    const el = document.createElement("div");
    el.style.cssText =
      "position:fixed;inset:0;z-index:99998;cursor:grabbing;";
    document.body.appendChild(el);
    overlayRef.current = el;
  }

  function hideDragOverlay() {
    if (overlayRef.current) {
      overlayRef.current.remove();
      overlayRef.current = null;
    }
  }

  // Global mouse listeners for drag
  useEffect(() => {
    function isOverEditor(x: number, y: number): boolean {
      const iframe = document.querySelector(".diagrams-iframe");
      if (!iframe) return false;
      const rect = iframe.getBoundingClientRect();
      return (
        x >= rect.left &&
        x <= rect.right &&
        y >= rect.top &&
        y <= rect.bottom
      );
    }

    const handleMouseMove = (e: MouseEvent) => {
      const drag = dragInfoRef.current;
      if (!drag) return;

      if (!drag.moved) {
        const dx = e.clientX - drag.startX;
        const dy = e.clientY - drag.startY;
        if (Math.sqrt(dx * dx + dy * dy) <= DRAG_THRESHOLD) return;
        drag.moved = true;
        showDragOverlay();
        document.body.style.userSelect = "none";
      }

      setGhostPos({
        x: e.clientX,
        y: e.clientY,
        url: withPrefix(drag.icon.svg_url),
        overEditor: isOverEditor(e.clientX, e.clientY),
      });
    };

    const handleMouseUp = (e: MouseEvent) => {
      const drag = dragInfoRef.current;
      if (!drag) return;

      hideDragOverlay();
      document.body.style.cursor = "";
      document.body.style.userSelect = "";

      const shouldInsert = drag.moved ? isOverEditor(e.clientX, e.clientY) : true;
      if (shouldInsert) {
        if (drag.source === "user") {
          doInsertUserRef.current({
            id: drag.icon.id,
            width: drag.icon.w,
            height: drag.icon.h,
            file_type: drag.fileType || "svg",
          });
        } else {
          doInsertRef.current(drag.icon);
        }
      }

      dragInfoRef.current = null;
      setGhostPos(null);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      hideDragOverlay();
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (dragInfoRef.current) {
          dragInfoRef.current = null;
          setGhostPos(null);
          hideDragOverlay();
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
        } else {
          onClose();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleScroll = () => {
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 100) {
        bioLoadMore();
      }
    };
    el.addEventListener("scroll", handleScroll);
    return () => el.removeEventListener("scroll", handleScroll);
  }, [bioLoadMore]);

  useEffect(() => {
    return () => clearTimeout(debounceRef.current);
  }, []);

  const selectedCatInfo = bio.selectedCategory
    ? bio.categories.find((c) => c.name === bio.selectedCategory)
    : null;

  return (
    <>
      <div className="flex h-full w-[380px] flex-shrink-0 flex-col border-l border-amber-100/50 bg-white/95 backdrop-blur-sm">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-amber-100/50 bg-gradient-to-r from-amber-50 to-orange-50 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-xl bg-gradient-to-br from-amber-400 to-orange-500 shadow-sm shadow-orange-200/50">
              <svg className="h-4 w-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
              </svg>
            </div>
            <h3 className="text-sm font-bold text-amber-800">{t("bio.title")}</h3>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-amber-400 transition-colors hover:bg-amber-100 hover:text-amber-600"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-amber-100/50">
          <button
            onClick={() => setActiveTab("bioicons")}
            className={`flex-1 py-2.5 text-center text-xs font-semibold transition-colors ${
              activeTab === "bioicons"
                ? "border-b-2 border-amber-500 text-amber-700"
                : "text-stone-400 hover:text-stone-600"
            }`}
          >
            {t("bio.library")}
          </button>
          <button
            onClick={() => setActiveTab("my")}
            className={`flex-1 py-2.5 text-center text-xs font-semibold transition-colors ${
              activeTab === "my"
                ? "border-b-2 border-amber-500 text-amber-700"
                : "text-stone-400 hover:text-stone-600"
            }`}
          >
            {t("bio.myAssets")}
          </button>
        </div>

        {/* Bioicons tab content */}
        {activeTab === "bioicons" && (
          <>
            {/* Search */}
            <div className="border-b border-amber-100/50 px-3 py-2.5">
              <div className="relative">
                <svg className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-stone-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <input
                  type="text"
                  value={searchInput}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  placeholder={t("bio.searchPlaceholder")}
                  className="w-full rounded-xl border border-amber-200/60 bg-amber-50/30 py-2 pl-8 pr-3 text-xs text-stone-700 placeholder:text-stone-400 focus:border-amber-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-amber-200"
                />
                {searchInput && (
                  <button onClick={clearSearch} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600">
                    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
            </div>

            {/* Category sidebar + icon grid */}
            <div className="flex flex-1 overflow-hidden">
              <div className="w-[120px] flex-shrink-0 overflow-y-auto border-r border-amber-100/50 bg-amber-50/20 py-1">
                <button
                  onClick={() => setSidebarExpanded((v) => !v)}
                  className="flex w-full items-center gap-1 px-2 py-1.5 text-left text-[11px] font-bold text-amber-800 hover:bg-amber-50"
                >
                  <svg className={`h-3 w-3 text-amber-400 transition-transform ${sidebarExpanded ? "rotate-90" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                  Bioicons
                </button>

                {sidebarExpanded && (
                  <div className="ml-2">
                    <button
                      onClick={() => bio.selectCategory(null)}
                      className={`w-full rounded-l px-2 py-1 text-left text-[10px] ${bio.selectedCategory === null ? "bg-amber-50 font-medium text-amber-700" : "text-gray-600 hover:bg-gray-100"}`}
                    >
                      {t("bio.all")}
                    </button>
                    {bio.categories.map((cat) => (
                      <button
                        key={cat.name}
                        onClick={() => bio.selectCategory(cat.name)}
                        className={`flex w-full items-center justify-between rounded-l px-2 py-1 text-left text-[10px] transition-colors ${bio.selectedCategory === cat.name ? "bg-amber-100/60 font-semibold text-amber-700" : "text-stone-500 hover:bg-amber-50/50 hover:text-stone-700"}`}
                      >
                        <span className="truncate">{cat.name.replace(/_/g, " ")}</span>
                        <span className="ml-0.5 flex-shrink-0 text-[9px] text-stone-400">{cat.count}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div ref={scrollRef} className="flex-1 overflow-y-auto p-2">
                {selectedCatInfo && (
                  <div className="mb-2 text-[10px] text-gray-500">
                    {t("bio.catCount", {
                      name: selectedCatInfo.name.replace(/_/g, " "),
                      count: String(selectedCatInfo.count),
                    })}
                  </div>
                )}

                {bio.loading ? (
                  <div className="flex items-center justify-center py-12">
                    <div className="h-6 w-6 animate-spin rounded-full border-2 border-amber-500 border-t-transparent" />
                  </div>
                ) : bio.icons.length === 0 ? (
                  <div className="py-12 text-center text-xs text-gray-400">{t("bio.noResults")}</div>
                ) : (
                  <div className="grid grid-cols-4 gap-1">
                    {bio.icons.map((icon) => {
                      const isInserting = insertingId === icon.id;
                      return (
                        <div
                          key={icon.id}
                          onMouseDown={(e) => handleIconMouseDown(e, icon as IconData)}
                          className={`group flex cursor-grab select-none flex-col items-center rounded border border-transparent p-1.5 transition-colors hover:border-amber-300 hover:bg-amber-50 active:cursor-grabbing ${isInserting ? "opacity-50" : ""}`}
                          title={t("bio.iconTip", {
                            name: icon.name,
                            author: icon.author,
                            license: icon.license,
                          })}
                        >
                          <div className="flex h-10 w-10 items-center justify-center">
                            {isInserting ? (
                              <div className="h-4 w-4 animate-spin rounded-full border-2 border-amber-500 border-t-transparent" />
                            ) : (
                              <img src={withPrefix(icon.svg_url)} alt={icon.name} className="max-h-10 max-w-10 object-contain" loading="lazy" draggable={false} title={icon.name} />
                            )}
                          </div>
                          <span className="mt-0.5 w-full truncate text-center text-[8px] text-gray-500 group-hover:text-amber-700">
                            {icon.name.replace(/[-_]/g, " ")}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}

                {bio.loadingMore && (
                  <div className="flex justify-center py-4">
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-amber-500 border-t-transparent" />
                  </div>
                )}

                {!bio.loading && !bio.loadingMore && bio.hasMore && (
                  <button onClick={bio.loadMore} className="mt-2 w-full rounded-lg bg-amber-50/60 py-1.5 text-xs font-medium text-amber-600 transition-colors hover:bg-amber-100/60">
                    {t("bio.loadMore")}
                  </button>
                )}
              </div>
            </div>
          </>
        )}

        {/* My elements tab content */}
        {activeTab === "my" && (
          <div className="flex flex-1 flex-col overflow-hidden">
                <div className="flex items-center justify-between border-b px-3 py-2">
                  <span className="text-[10px] text-gray-400">
                    {t("bio.assetCount", { count: String(userEls.elements.length) })}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => setGeneratorOpen(true)}
                      className="flex items-center gap-1 rounded-lg bg-gradient-to-r from-amber-400 to-orange-500 px-2.5 py-1.5 text-[10px] font-semibold text-white shadow-sm shadow-orange-200/40 transition-all hover:shadow-md hover:shadow-orange-200/50"
                    >
                      <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
                      </svg>
                      {t("bio.smartGen")}
                    </button>
                    <button
                      onClick={handleUpload}
                      disabled={userEls.uploading}
                      className="flex items-center gap-1 rounded-lg border border-amber-200/60 bg-white px-2.5 py-1.5 text-[10px] font-medium text-stone-600 transition-colors hover:bg-amber-50 disabled:opacity-50"
                    >
                      {userEls.uploading ? (
                        <div className="h-3 w-3 animate-spin rounded-full border border-gray-400 border-t-transparent" />
                      ) : (
                        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                        </svg>
                      )}
                      {t("bio.upload")}
                    </button>
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".svg,.png,image/svg+xml,image/png"
                    className="hidden"
                    onChange={handleFileChange}
                  />
                </div>

                {userEls.error && (
                  <div className="mx-3 mt-2 rounded border border-red-200 bg-red-50 px-2 py-1 text-[10px] text-red-600">
                    {userEls.error}
                  </div>
                )}

                <div className="flex-1 overflow-y-auto p-2">
                  {userEls.loading ? (
                    <div className="flex items-center justify-center py-12">
                      <div className="h-6 w-6 animate-spin rounded-full border-2 border-amber-500 border-t-transparent" />
                    </div>
                  ) : userEls.elements.length === 0 ? (
                    <div className="py-12 text-center text-xs text-gray-400">
                      {t("bio.noAssets")}
                    </div>
                  ) : (
                    <div className="grid grid-cols-4 gap-1">
                      {userEls.elements.map((el) => {
                        const isInserting = insertingId === el.id;
                        const isDeleting = deletingId === el.id;
                        return (
                          <div
                            key={el.id}
                            onMouseDown={(e) =>
                              handleIconMouseDown(
                                e,
                                {
                                  id: el.id,
                                  name: el.display_name,
                                  w: el.width || 80,
                                  h: el.height || 80,
                                  svg_url: _thumbCache.get(el.id) || `${PATH_PREFIX}/api/v1/elements/${el.id}/content`,
                                  author: "",
                                  license: "",
                                },
                                "user",
                                el.file_type,
                              )
                            }
                            className={`group relative flex cursor-grab select-none flex-col items-center rounded border border-transparent p-1.5 transition-colors hover:border-amber-300 hover:bg-amber-50 active:cursor-grabbing ${isInserting || isDeleting ? "opacity-50" : ""}`}
                            title={t("bio.elTip", { name: el.display_name })}
                          >
                            <div className="flex h-10 w-10 items-center justify-center">
                              {isInserting ? (
                                <div className="h-4 w-4 animate-spin rounded-full border-2 border-amber-500 border-t-transparent" />
                              ) : (
                                <UserElementThumb elementId={el.id} fileType={el.file_type} alt={el.display_name} />
                              )}
                            </div>
                            <span className="mt-0.5 w-full truncate text-center text-[8px] text-gray-500 group-hover:text-amber-700">
                              {el.display_name}
                            </span>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                if (confirm(t("bio.confirmDelete"))) handleDeleteElement(el.id);
                              }}
                              className="absolute -right-0.5 -top-0.5 hidden rounded-full bg-red-500 p-0.5 text-white shadow group-hover:block"
                            >
                              <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
          </div>
        )}

        {/* Bottom hint */}
        <div className="border-t border-amber-100/50 bg-amber-50/30 px-3 py-2">
          <div className="text-center text-[10px] text-amber-600/60">
            {t("bio.dragHint")}
          </div>
        </div>
      </div>

      {/* Asset Generator Modal */}
      <AssetGeneratorPanel
        open={generatorOpen}
        onClose={() => setGeneratorOpen(false)}
        onSaveToLibrary={handleSaveGenerated}
        imageModel={imageModel}
      />

      {/* Drag ghost (portal to body so it's not clipped) */}
      {ghostPos &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[99999]"
            style={{
              left: ghostPos.x - 24,
              top: ghostPos.y - 24,
            }}
          >
            <div
              className={`flex h-12 w-12 items-center justify-center rounded-lg border-2 bg-white shadow-lg transition-colors ${
                ghostPos.overEditor
                  ? "border-amber-400 ring-2 ring-amber-200"
                  : "border-gray-300"
              }`}
            >
              <img
                src={ghostPos.url}
                alt=""
                className="h-8 w-8 object-contain"
                draggable={false}
              />
            </div>
            {ghostPos.overEditor && (
              <div className="mt-1 whitespace-nowrap rounded bg-amber-500 px-2 py-0.5 text-center text-[10px] text-white shadow">
                {t("bio.dropToAdd")}
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
