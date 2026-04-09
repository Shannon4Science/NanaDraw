import { clsx } from "clsx";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Loader2,
  Search,
  X,
  ZoomIn,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../contexts/LanguageContext";
import { searchGallery } from "../services/api";
import type { GallerySearchResult, StyleReference } from "../types/paper";

interface GalleryModalProps {
  items: StyleReference[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onClose: () => void;
}

function MetaBadge({ text }: { text: string }) {
  return (
    <span className="rounded-full bg-surface-container px-2 py-0.5 text-[10px] text-on-surface-variant">
      {text}
    </span>
  );
}

function ScoreBadge({ score }: { score: number }) {
  const t = useT();
  const pct = Math.round(score * 100);
  return (
    <span className="rounded-full bg-primary-container/30 px-2 py-0.5 text-[10px] font-bold text-primary">
      {t("gallery.relevance", { pct: String(pct) })}
    </span>
  );
}

function DetailView({
  item,
  score,
  isSelected,
  onSelect,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
  index,
  total,
}: {
  item: StyleReference;
  score?: number;
  isSelected: boolean;
  onSelect: () => void;
  onPrev: () => void;
  onNext: () => void;
  hasPrev: boolean;
  hasNext: boolean;
  index: number;
  total: number;
}) {
  const t = useT();
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onPrev}
    >
      <div
        className="relative flex max-h-[95vh] max-w-[95vw] flex-col items-center gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        <img
          src={item.image_url}
          alt={item.name}
          className="max-h-[65vh] max-w-[90vw] rounded-lg object-contain shadow-2xl"
        />

        {/* Info panel */}
        <div className="w-full max-w-2xl rounded-xl bg-black/60 px-5 py-3">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm text-white/60">
                  {index + 1} / {total}
                </span>
                {score !== undefined && <ScoreBadge score={score} />}
              </div>
              <h3 className="mt-1 text-sm font-medium text-white line-clamp-2">
                {item.title || item.name}
              </h3>
              {item.authors.length > 0 && (
                <p className="mt-0.5 text-xs text-white/60 line-clamp-1">
                  {item.authors.slice(0, 3).join(", ")}
                  {item.authors.length > 3 && t("gallery.moreAuthors")}
                </p>
              )}
              {(item.year || item.conference) && (
                <p className="mt-0.5 text-xs text-white/50">
                  {[item.conference, item.year].filter(Boolean).join(" · ")}
                </p>
              )}
              {item.abstract && (
                <p className="mt-1.5 text-xs leading-relaxed text-white/50 line-clamp-3">
                  {item.abstract}
                </p>
              )}
            </div>
            <div className="flex flex-shrink-0 flex-col gap-1.5">
              <button
                onClick={onSelect}
                className={clsx(
                  "flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-sm font-medium transition-colors",
                  isSelected
                    ? "bg-primary-500 text-white"
                    : "bg-white/20 text-white hover:bg-white/30",
                )}
              >
                {isSelected && <Check className="h-4 w-4" />}
                {isSelected ? t("gallery.selected") : t("gallery.selectAsRef")}
              </button>
              {item.paper_url && (
                <a
                  href={item.paper_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 rounded-lg bg-white/10 px-3 py-1 text-xs text-white/70 hover:bg-white/20"
                >
                  <ExternalLink className="h-3 w-3" /> {t("gallery.paper")}
                </a>
              )}
              {item.code_url && (
                <a
                  href={item.code_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 rounded-lg bg-white/10 px-3 py-1 text-xs text-white/70 hover:bg-white/20"
                >
                  <ExternalLink className="h-3 w-3" /> {t("gallery.code")}
                </a>
              )}
            </div>
          </div>
        </div>

        {hasPrev && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onPrev();
            }}
            className="absolute left-2 top-1/3 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white transition-colors hover:bg-black/80"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
        )}
        {hasNext && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onNext();
            }}
            className="absolute right-2 top-1/3 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white transition-colors hover:bg-black/80"
          >
            <ChevronRight className="h-6 w-6" />
          </button>
        )}
      </div>
    </div>
  );
}

export function GalleryModal({ items, selectedId, onSelect, onClose }: GalleryModalProps) {
  const t = useT();
  const [detailIndex, setDetailIndex] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<GallerySearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const searchIdRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const inputRef = useRef<HTMLInputElement>(null);

  const displayItems: StyleReference[] = searchResults ?? items;
  const scoreMap = new Map<string, number>();
  if (searchResults) {
    for (const r of searchResults) {
      scoreMap.set(r.id, r.score);
    }
  }

  const doSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setSearchResults(null);
      setSearching(false);
      return;
    }
    const id = ++searchIdRef.current;
    setSearching(true);
    try {
      const data = await searchGallery(q.trim());
      if (id === searchIdRef.current) setSearchResults(data);
    } catch {
      if (id === searchIdRef.current) setSearchResults(null);
    } finally {
      if (id === searchIdRef.current) setSearching(false);
    }
  }, []);

  const handleQueryChange = useCallback(
    (value: string) => {
      setQuery(value);
      clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => doSearch(value), 300);
    },
    [doSearch],
  );

  const clearQuery = useCallback(() => {
    setQuery("");
    searchIdRef.current++;
    setSearchResults(null);
    setSearching(false);
    inputRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (detailIndex !== null) {
          setDetailIndex(null);
        } else if (query) {
          clearQuery();
        } else {
          onClose();
        }
      } else if (detailIndex !== null) {
        if (e.key === "ArrowLeft" && detailIndex > 0) {
          setDetailIndex(detailIndex - 1);
        } else if (e.key === "ArrowRight" && detailIndex < displayItems.length - 1) {
          setDetailIndex(detailIndex + 1);
        }
      }
    },
    [detailIndex, displayItems.length, onClose, query, clearQuery],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
    };
  }, [handleKeyDown]);

  useEffect(() => {
    return () => clearTimeout(debounceRef.current);
  }, []);

  return (
    <>
      <div className="fixed inset-0 z-50 flex flex-col bg-white">
        {/* Header */}
        <div className="flex items-center justify-between border-b px-6 py-3">
          <div className="flex items-center gap-3">
            <h2 className="font-headline text-lg font-bold text-on-surface">{t("gallery.title")}</h2>
            <span className="text-sm text-outline">
              {searchResults
                ? t("gallery.searchResultCount", { count: String(searchResults.length) })
                : t("gallery.totalCount", { count: String(items.length) })}
            </span>
            {selectedId && (
              <span className="rounded-full bg-primary-100 px-2.5 py-0.5 text-xs font-medium text-primary-700">
                {t("gallery.currentSelection", {
                  name: items.find((i) => i.id === selectedId)?.name || "",
                })}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            {/* Search box */}
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => handleQueryChange(e.target.value)}
                placeholder={t("gallery.searchPlaceholder")}
                className="w-64 rounded-full border border-outline-variant/10 bg-surface-container-low py-1.5 pl-9 pr-8 text-sm text-on-surface placeholder-outline outline-none transition-all focus:border-primary/30 focus:bg-surface-container-lowest focus:ring-2 focus:ring-primary-container/30"
              />
              {(query || searching) && (
                <button
                  onClick={clearQuery}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  {searching ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <X className="h-4 w-4" />
                  )}
                </button>
              )}
            </div>
            {selectedId && (
              <button
                onClick={() => onSelect(null)}
                className="text-sm text-gray-500 hover:text-gray-700"
              >
                {t("gallery.clearSelection")}
              </button>
            )}
            <button
              onClick={onClose}
              className="rounded-full p-1.5 text-on-surface-variant transition-all hover:bg-primary-container/20 hover:text-primary"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Grid */}
        <div className="flex-1 overflow-y-auto p-6">
          {displayItems.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-gray-400">
              <Search className="mb-3 h-10 w-10" />
              <p className="text-sm">
                {searching ? t("gallery.searching") : t("gallery.noResults")}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
              {displayItems.map((item, idx) => {
                const isSelected = selectedId === item.id;
                const itemScore = scoreMap.get(item.id);
                return (
                  <div
                    key={item.id}
                    className={clsx(
                      "group relative overflow-hidden rounded-xl border-2 transition-all",
                      isSelected
                        ? "border-primary-500 ring-2 ring-primary-200 shadow-md"
                        : "border-outline-variant/10 hover:border-outline-variant/30 hover:shadow-soft",
                    )}
                  >
                    {/* Image */}
                    <div className="aspect-[4/3] overflow-hidden bg-surface-container-low">
                      <img
                        src={item.thumbnail_url}
                        alt={item.name}
                        className="h-full w-full object-cover transition-transform group-hover:scale-105"
                        loading="lazy"
                      />
                    </div>

                    {/* Info */}
                    <div className="p-2">
                      <div className="text-xs font-medium text-on-surface line-clamp-1">
                        {item.title || item.name}
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        {item.year && <MetaBadge text={`${item.conference || ""} ${item.year}`.trim()} />}
                        {itemScore !== undefined && <ScoreBadge score={itemScore} />}
                        {!itemScore &&
                          item.tags.slice(0, 2).map((tag) => (
                            <MetaBadge key={tag} text={tag} />
                          ))}
                      </div>
                    </div>

                    {/* Overlay actions */}
                    <div className="absolute inset-0 flex items-center justify-center gap-2 bg-black/0 opacity-0 transition-all group-hover:bg-black/30 group-hover:opacity-100">
                      <button
                        onClick={() => setDetailIndex(idx)}
                        className="rounded-lg bg-white/90 px-3 py-1.5 text-xs font-medium text-gray-700 shadow transition-colors hover:bg-white"
                        title={t("gallery.viewLarge")}
                      >
                        <ZoomIn className="mr-1 inline h-3.5 w-3.5" />
                        {t("gallery.view")}
                      </button>
                      <button
                        onClick={() => onSelect(isSelected ? null : item.id)}
                        className={clsx(
                          "rounded-lg px-3 py-1.5 text-xs font-medium shadow transition-colors",
                          isSelected
                            ? "bg-primary-500 text-white hover:bg-primary-600"
                            : "bg-white/90 text-gray-700 hover:bg-white",
                        )}
                      >
                        {isSelected ? (
                          <>
                            <Check className="mr-1 inline h-3.5 w-3.5" />
                            {t("gallery.selectedBadge")}
                          </>
                        ) : (
                          t("gallery.select")
                        )}
                      </button>
                    </div>

                    {/* Selected badge */}
                    {isSelected && (
                      <div className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-primary-500 shadow">
                        <Check className="h-3 w-3 text-white" />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Detail overlay */}
      {detailIndex !== null && displayItems[detailIndex] && (
        <DetailView
          item={displayItems[detailIndex]}
          score={scoreMap.get(displayItems[detailIndex].id)}
          isSelected={selectedId === displayItems[detailIndex].id}
          onSelect={() =>
            onSelect(
              selectedId === displayItems[detailIndex].id
                ? null
                : displayItems[detailIndex].id,
            )
          }
          onPrev={() => detailIndex > 0 && setDetailIndex(detailIndex - 1)}
          onNext={() =>
            detailIndex < displayItems.length - 1 && setDetailIndex(detailIndex + 1)
          }
          hasPrev={detailIndex > 0}
          hasNext={detailIndex < displayItems.length - 1}
          index={detailIndex}
          total={displayItems.length}
        />
      )}
    </>
  );
}
