import { clsx } from "clsx";
import { Check, Crop, Download, Loader2, RefreshCw, Save, Sparkles, X as XIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../contexts/LanguageContext";
import type { ElementProgress, PipelineStep, PromptPair } from "../hooks/useGenerate";
import { uploadUserElement } from "../services/api";

function StepRunningTimer({ startedAt }: { startedAt: number }) {
  const [elapsed, setElapsed] = useState(() => Date.now() - startedAt);
  useEffect(() => {
    const id = setInterval(() => setElapsed(Date.now() - startedAt), 200);
    return () => clearInterval(id);
  }, [startedAt]);
  return <>{elapsed < 1000 ? `${elapsed}ms` : `${(elapsed / 1000).toFixed(1)}s`}</>;
}

interface StepDetailViewerProps {
  step: PipelineStep;
  referenceImage: string | null;
  onRetry?: () => void;
  onLoadXmlToCanvas?: (xml: string) => void;
  resultXml?: string | null;
  onElementSaved?: () => void;
  onRegenComponent?: (componentId: string, label: string) => void;
  canViewPrompts?: boolean;
}

type TabKey = "artifact" | "prompt";

export function StepDetailViewer({
  step,
  referenceImage,
  onRetry,
  onLoadXmlToCanvas,
  resultXml,
  onElementSaved,
  onRegenComponent,
  canViewPrompts = true,
}: StepDetailViewerProps) {
  const t = useT();
  const [activeTab, setActiveTab] = useState<TabKey>("artifact");
  const hasArtifact = step.artifact != null;
  const hasPrompts = canViewPrompts && step.prompts != null;
  const hasRefImage = step.artifactType === "reference_image" && referenceImage;
  const hasElementProgress = (step.elementProgress?.length ?? 0) > 0;

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {step.status === "running" && (
            <div className="relative flex h-4 w-4 items-center justify-center">
              <div className="absolute inset-0 rounded-full border-2 border-amber-200" />
              <div className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-amber-500" />
            </div>
          )}
          <h3 className="font-headline text-sm font-bold text-on-surface">{step.name}</h3>
        </div>
        <div className="flex items-center gap-2">
          {step.status === "running" && step.startedAt != null ? (
            <span className="rounded-full bg-primary-container/30 px-2 py-0.5 text-[11px] font-mono text-primary animate-pulse">
              <StepRunningTimer startedAt={step.startedAt} />
            </span>
          ) : step.elapsedMs != null ? (
            <span className="rounded-full bg-surface-container px-2 py-0.5 text-[11px] font-mono text-on-surface-variant">
              {step.elapsedMs < 1000 ? `${step.elapsedMs}ms` : `${(step.elapsedMs / 1000).toFixed(1)}s`}
            </span>
          ) : null}
          {onRetry && (
            <button
              onClick={onRetry}
              className="flex items-center gap-1 rounded-full bg-error px-3 py-1 text-xs font-bold text-white hover:opacity-90 active:scale-95"
            >
              <RefreshCw className="h-3 w-3" />
              {t("step.retryFrom")}
            </button>
          )}
        </div>
      </div>

      {/* Error message */}
      {step.error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {step.error}
        </div>
      )}

      {/* Running indicator */}
      {step.status === "running" && !hasElementProgress && (
        <div className="flex items-center gap-2 text-sm text-amber-600">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("step.processing")}
        </div>
      )}

      {/* Element extraction progress */}
      {hasElementProgress && (
        <ElementProgressGrid
          items={step.elementProgress!}
          onElementSaved={onElementSaved}
          onRegenComponent={onRegenComponent}
        />
      )}

      {/* Tab bar */}
      {(hasArtifact || hasPrompts || hasRefImage) && (
        <div className="flex gap-1 border-b border-outline-variant/10">
          {(hasArtifact || hasRefImage) && (
            <button
              onClick={() => setActiveTab("artifact")}
              className={clsx(
                "px-3 py-1.5 text-xs font-medium transition-colors border-b-2",
                activeTab === "artifact"
                  ? "border-primary text-primary"
                  : "border-transparent text-on-surface-variant hover:text-on-surface",
              )}
            >
              {t("step.artifact")}
            </button>
          )}
          {hasPrompts && (
            <button
              onClick={() => setActiveTab("prompt")}
              className={clsx(
                "px-3 py-1.5 text-xs font-medium transition-colors border-b-2",
                activeTab === "prompt"
                  ? "border-primary text-primary"
                  : "border-transparent text-on-surface-variant hover:text-on-surface",
              )}
            >
              Prompt
            </button>
          )}
        </div>
      )}

      {/* Artifact content */}
      {activeTab === "artifact" && (
        <>
          {hasRefImage && <ReferenceImageDetail image={referenceImage!} />}
          {!hasRefImage && hasArtifact && (
            <ArtifactDetail type={step.artifactType!} data={step.artifact} />
          )}
          {step.artifactType === "xml" && resultXml && onLoadXmlToCanvas && (
            <div className="mt-3 flex items-center gap-2">
              <button
                onClick={() => onLoadXmlToCanvas(resultXml)}
                className="rounded-full bg-primary px-4 py-1.5 text-xs font-bold text-on-primary hover:opacity-90 active:scale-95"
              >
                {t("step.loadToCanvas")}
              </button>
              <button
                onClick={() => {
                  const blob = new Blob([resultXml], { type: "application/xml" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = "diagram.drawio";
                  a.click();
                  URL.revokeObjectURL(url);
                }}
                className="rounded-full bg-on-surface-variant px-4 py-1.5 text-xs font-bold text-surface hover:opacity-90 active:scale-95"
              >
                {t("step.downloadDrawio")}
              </button>
            </div>
          )}
        </>
      )}

      {/* Prompt content */}
      {activeTab === "prompt" && hasPrompts && <PromptDetail prompts={step.prompts!} />}
    </div>
  );
}

function ReferenceImageDetail({ image }: { image: string }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const src = `data:image/png;base64,${image}`;

  return (
    <div className="space-y-2">
      <p className="text-xs text-gray-500">
        {t("step.refImageDesc")}
      </p>
      <img
        src={src}
        alt="Reference diagram"
        className="max-h-[400px] cursor-zoom-in rounded-lg border border-gray-200 shadow-sm transition-shadow hover:shadow-md"
        onClick={() => setExpanded(true)}
      />

      {/* Full-screen lightbox */}
      {expanded && createPortal(
        <div
          className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-black/30 backdrop-blur-sm"
          onClick={() => setExpanded(false)}
        >
          <div className="relative max-h-[82vh] max-w-[92vw]" onClick={(e) => e.stopPropagation()}>
            <img
              src={src}
              alt="Reference diagram (full)"
              className="max-h-[82vh] max-w-[92vw] rounded-lg shadow-2xl"
            />
            <button
              onClick={() => setExpanded(false)}
              className="absolute -right-3 -top-3 flex h-8 w-8 items-center justify-center rounded-full bg-white text-gray-600 shadow-lg hover:bg-gray-100"
            >
              <XIcon className="h-4 w-4" />
            </button>
          </div>
          <a
            href={src}
            download="reference_image.png"
            onClick={(e) => e.stopPropagation()}
            className="mt-5 rounded-full bg-white/90 px-5 py-2 text-sm font-medium text-gray-700 shadow-lg hover:bg-white"
          >
            {t("step.downloadImage")}
          </a>
        </div>,
        document.body,
      )}
    </div>
  );
}

function ElementProgressGrid({
  items,
  onElementSaved,
  onRegenComponent,
}: {
  items: ElementProgress[];
  onElementSaved?: () => void;
  onRegenComponent?: (componentId: string, label: string) => void;
}) {
  const t = useT();
  const sorted = [...items].sort((a, b) => a.index - b.index);
  const total = sorted[0]?.total ?? 0;
  const done = sorted.filter((e) => e.status === "success" || e.status === "failed").length;
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const expandedItem = expandedId ? sorted.find((e) => e.element_id === expandedId) : null;

  const [saveName, setSaveName] = useState("");
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const categoryLabel: Record<string, { text: string; color: string }> = {
    illustration: { text: t("step.catIllustration"), color: "bg-purple-50 text-purple-600" },
    stage_box: { text: t("step.catStageBox"), color: "bg-amber-50 text-amber-600" },
    arrow: { text: t("step.catArrow"), color: "bg-orange-50 text-orange-600" },
    text: { text: t("step.catText"), color: "bg-gray-100 text-gray-500" },
    background: { text: t("step.catBackground"), color: "bg-stone-100 text-stone-600" },
    decoration: { text: t("step.catDecoration"), color: "bg-pink-50 text-pink-600" },
    pipeline: { text: t("step.catPipeline"), color: "bg-indigo-50 text-indigo-600" },
    template: { text: t("step.catTemplate"), color: "bg-amber-50 text-amber-600" },
  };

  const handleDownload = useCallback((item: ElementProgress) => {
    if (!item.image_b64) return;
    const byteChars = atob(item.image_b64);
    const bytes = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
    const blob = new Blob([bytes], { type: "image/png" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${item.label || item.element_id}.png`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const openSaveForm = useCallback((item: ElementProgress) => {
    setSaveName(item.label || item.element_id);
    setShowSaveForm(true);
    setSaveMsg(null);
  }, []);

  const handleSaveConfirm = useCallback(async () => {
    if (!expandedItem?.image_b64 || !saveName.trim()) return;
    const trimmed = saveName.trim();
    if (trimmed.length > 50) {
      setSaveMsg({ type: "err", text: t("step.nameTooLong") });
      return;
    }
    setSaving(true);
    setSaveMsg(null);
    try {
      const byteChars = atob(expandedItem.image_b64);
      const bytes = new Uint8Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
      const blob = new Blob([bytes], { type: "image/png" });
      const file = new File([blob], `${trimmed}.png`, { type: "image/png" });
      await uploadUserElement(file, trimmed, expandedItem.category);
      setSaveMsg({ type: "ok", text: t("step.savedToAssets") });
      setShowSaveForm(false);
      onElementSaved?.();
    } catch (e) {
      setSaveMsg({ type: "err", text: e instanceof Error ? e.message : t("step.saveFailed") });
    } finally {
      setSaving(false);
    }
  }, [expandedItem, saveName, onElementSaved, t]);

  const closeLightbox = useCallback(() => {
    setExpandedId(null);
    setShowSaveForm(false);
    setSaveMsg(null);
  }, []);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-on-surface-variant">{t("step.componentProgress")}</span>
        <span className="text-xs text-outline">
          {done}/{total}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-container">
        <div
          className="h-full rounded-full bg-primary-container transition-all duration-300"
          style={{ width: `${total > 0 ? (done / total) * 100 : 0}%` }}
        />
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {sorted.map((ep) => (
          <div
            key={ep.element_id}
            className={clsx(
              "flex flex-col items-center gap-1.5 rounded-2xl border p-2",
              ep.status === "success"
                ? "border-amber-200/50 bg-amber-50/30"
                : ep.status === "failed"
                  ? "border-error/20 bg-error-container/10"
                  : "border-outline-variant/10 bg-surface-container-low",
            )}
          >
            {/* Image preview or placeholder */}
            {ep.image_b64 ? (
              <img
                src={`data:image/png;base64,${ep.image_b64}`}
                alt={ep.label}
                className="h-16 w-16 cursor-zoom-in rounded border border-gray-200 object-contain bg-white transition-shadow hover:shadow-md"
                onClick={() => setExpandedId(ep.element_id)}
              />
            ) : ep.status === "failed" ? (
              <div className="flex h-16 w-16 items-center justify-center rounded border border-red-200 bg-red-50">
                <XIcon className="h-6 w-6 text-red-300" />
              </div>
            ) : (
              <div className="flex h-16 w-16 items-center justify-center rounded border border-gray-200 bg-gray-50">
                <Loader2 className="h-5 w-5 animate-spin text-gray-300" />
              </div>
            )}

            {/* Category badge + Label */}
            <div className="w-full text-center">
              {ep.category && categoryLabel[ep.category] && (
                <span className={clsx(
                  "mb-0.5 inline-block rounded px-1 py-0.5 text-[9px] font-medium",
                  categoryLabel[ep.category].color,
                )}>
                  {categoryLabel[ep.category].text}
                </span>
              )}
              <div className="truncate text-[11px] font-medium text-gray-700">{ep.label || ep.element_id}</div>
              <div className="flex items-center justify-center gap-1 text-[10px] text-gray-400">
                {ep.strategy === "crop" ? (
                  <><Crop className="h-3 w-3" /> {t("step.crop")}</>
                ) : (
                  <><Sparkles className="h-3 w-3" /> {t("step.generate")}</>
                )}
                {ep.status === "success" && <Check className="h-3 w-3 text-amber-500" />}
              </div>
              {ep.score != null && ep.score > 0 && (
                <div className="mt-0.5 flex items-center justify-center gap-1">
                  <span className={clsx(
                    "rounded px-1 py-0.5 font-mono text-[10px] font-medium",
                    ep.score >= 7 ? "bg-amber-50 text-amber-700"
                      : ep.score >= 5 ? "bg-amber-50 text-amber-700"
                      : "bg-red-50 text-red-700",
                  )}>
                    {ep.score}/10
                  </span>
                  {ep.round != null && ep.max_rounds != null && (
                    <span className="text-[9px] text-gray-400">
                      R{ep.round}/{ep.max_rounds}
                    </span>
                  )}
                </div>
              )}
              {ep.status === "success" && onRegenComponent && (ep.category === "illustration" || ep.category === "decoration" || ep.category === "pipeline" || ep.category === "background") && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onRegenComponent(ep.element_id, ep.label || ep.element_id);
                  }}
                  className="mt-1 flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium text-indigo-500 transition-colors hover:bg-indigo-50"
                  title={t("step.regenInChat")}
                >
                  <RefreshCw className="h-3 w-3" /> {t("step.chatRegen")}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Lightbox for enlarged component image */}
      {expandedItem?.image_b64 && createPortal(
        <div
          className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-black/30 backdrop-blur-sm"
          onClick={closeLightbox}
          onKeyDown={(e) => { if (e.key === "Escape") closeLightbox(); }}
        >
          <div className="relative" onClick={(e) => e.stopPropagation()}>
            <img
              src={`data:image/png;base64,${expandedItem.image_b64}`}
              alt={expandedItem.label || expandedItem.element_id}
              className="max-h-[70vh] max-w-[90vw] rounded-lg bg-white/10 shadow-2xl"
            />
            <button
              onClick={closeLightbox}
              className="absolute -right-3 -top-3 flex h-8 w-8 items-center justify-center rounded-full bg-white text-gray-600 shadow-lg hover:bg-gray-100"
            >
              <XIcon className="h-4 w-4" />
            </button>
          </div>

          {/* Info + action buttons */}
          <div className="mt-4 flex flex-col items-center gap-3" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2">
              {expandedItem.category && categoryLabel[expandedItem.category] && (
                <span className={clsx(
                  "rounded px-2 py-1 text-xs font-medium",
                  categoryLabel[expandedItem.category].color,
                )}>
                  {categoryLabel[expandedItem.category].text}
                </span>
              )}
              <span className="text-sm text-white/90">
                {expandedItem.label || expandedItem.element_id}
              </span>
            </div>

            {/* Action buttons */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => handleDownload(expandedItem)}
                className="flex items-center gap-1.5 rounded-full bg-white/90 px-4 py-2 text-sm font-medium text-gray-700 shadow-lg hover:bg-white"
              >
                <Download className="h-4 w-4" />
                {t("step.downloadImage")}
              </button>
              <button
                onClick={() => openSaveForm(expandedItem)}
                className="flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-bold text-on-primary shadow-lg hover:opacity-90 active:scale-95"
              >
                <Save className="h-4 w-4" />
                {t("step.addToAssets")}
              </button>
            </div>

            {/* Inline save form */}
            {showSaveForm && (
              <div className="flex items-center gap-2 rounded-xl bg-white/95 px-4 py-3 shadow-xl backdrop-blur">
                <input
                  type="text"
                  value={saveName}
                  onChange={(e) => setSaveName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleSaveConfirm(); }}
                  placeholder={t("step.inputAssetName")}
                  maxLength={50}
                  autoFocus
                  className="w-48 rounded-full border border-outline-variant/20 px-3 py-1.5 text-sm text-on-surface outline-none focus:border-primary/30 focus:ring-2 focus:ring-primary-container/30"
                />
                <button
                  onClick={handleSaveConfirm}
                  disabled={saving || !saveName.trim()}
                  className="flex items-center gap-1 rounded-full bg-primary px-3 py-1.5 text-sm font-bold text-on-primary hover:opacity-90 active:scale-95 disabled:opacity-50"
                >
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                  {t("step.confirm")}
                </button>
                <button
                  onClick={() => setShowSaveForm(false)}
                  className="rounded-full px-2 py-1.5 text-sm text-on-surface-variant hover:bg-surface-container"
                >
                  {t("step.cancel")}
                </button>
              </div>
            )}

            {/* Feedback message */}
            {saveMsg && (
              <div className={clsx(
                "rounded-lg px-4 py-2 text-sm font-medium shadow",
                saveMsg.type === "ok" ? "bg-amber-500 text-white" : "bg-red-500 text-white",
              )}>
                {saveMsg.text}
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

function TemplateImagesDetail({ data }: { data: Record<string, unknown> }) {
  const t = useT();
  const templateIds = (data.template_ids as string[]) || [];
  const count = (data.generated as number) || templateIds.length;
  const total = (data.total as number) || count;

  return (
    <div className="space-y-2">
      <p className="text-xs text-gray-500">
        {t("step.templateGenResult", { count: String(count), total: String(total) })}
      </p>
      {templateIds.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {templateIds.map((tid) => (
            <span key={tid} className="rounded bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
              {tid}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function SlidesArtifactDetail({ data }: { data: Record<string, unknown> }) {
  const t = useT();
  const slides = data.slides as unknown[] | undefined;
  const templates = data.templates as unknown[] | undefined;
  const gs = data.global_style as Record<string, unknown> | undefined;

  return (
    <div className="space-y-2">
      {gs && (
        <div className="rounded-lg bg-gray-50 p-2 text-xs text-gray-600">
          <span className="font-medium">{t("step.globalStyle")}</span>{" "}
          {gs.mood as string || t("step.notSpecified")} |{" "}
          {t("step.themeColor")}{" "}
          <span className="inline-block h-3 w-3 rounded-full align-text-top" style={{ backgroundColor: (gs.theme_color as string) || "#333" }} />{" "}
          {gs.theme_color as string}
        </div>
      )}
      {templates && templates.length > 0 && (
        <div className="rounded-lg bg-amber-50 p-2 text-xs text-amber-700">
          <span className="font-medium">
            {t("step.templatePages", { count: String(templates.length) })}
          </span>{" "}
          {(templates as Array<Record<string, unknown>>).map((tpl) => tpl.template_id as string).join(", ")}
        </div>
      )}
      {slides && (
        <div className="rounded-lg bg-amber-50 p-2 text-xs text-amber-700">
          <span className="font-medium">{t("step.slidesCount", { count: String(slides.length) })}</span>{" "}
          ({(slides as Array<Record<string, unknown>>).map((s) => s.slide_type as string).join(", ")})
        </div>
      )}
    </div>
  );
}

function ArtifactDetail({ type, data }: { type: string; data: unknown }) {
  const t = useT();

  if (type === "slides_blueprint" && typeof data === "object" && data !== null) {
    return <SlidesArtifactDetail data={data as Record<string, unknown>} />;
  }

  if (type === "template_images" && typeof data === "object" && data !== null) {
    return <TemplateImagesDetail data={data as Record<string, unknown>} />;
  }

  if (type === "visual_specs" && typeof data === "object" && data !== null) {
    const specs = data as Record<string, Record<string, unknown>>;
    return (
      <div className="space-y-1">
        {Object.entries(specs).map(([tid, spec]) => (
          <div key={tid} className="rounded-lg bg-gray-50 p-2 text-xs text-gray-600">
            <span className="font-medium">{tid}</span>: {t("step.colorsCount", { n: String(spec.colors as number || 0) })} |{" "}
            {(spec.keywords as string) || t("step.noKeywords")} |{" "}
            {t("step.bgReusable")} {spec.bg_reusable ? "✓" : "✗"}
          </div>
        ))}
      </div>
    );
  }

  if (type === "plan" && typeof data === "object" && data !== null) {
    return <PlanDetail data={data as Record<string, unknown>} />;
  }

  if (type === "blueprint" && typeof data === "object" && data !== null) {
    return <BlueprintDetail data={data as Record<string, unknown>} />;
  }

  if (type === "consistency" && typeof data === "object" && data !== null) {
    return <ConsistencyDetail data={data as Record<string, unknown>} />;
  }

  if ((type === "elements" || type === "assets") && typeof data === "object" && data !== null) {
    const d = data as Record<string, unknown>;
    const typeWord = type === "assets" ? t("step.assets") : t("step.components");
    return (
      <div className="rounded-lg bg-gray-50 p-3 text-sm text-gray-600">
        {d.generated != null
          ? t("step.genSuccess", {
              generated: String(d.generated),
              total: String(d.total),
              type: typeWord,
            })
          : t("step.extractSuccess", {
              extracted: String(d.extracted),
              total: String(d.total),
            })}
        {d.failed != null && Number(d.failed) > 0 && (
          <span className="ml-2 text-red-500">{t("step.failedCount", { n: String(d.failed) })}</span>
        )}
        {(d.ids as string[])?.length > 0 && (
          <div className="mt-1 text-xs text-gray-400">{(d.ids as string[]).join(", ")}</div>
        )}
      </div>
    );
  }

  if (type === "xml" && typeof data === "string") {
    return (
      <div className="max-h-[300px] overflow-auto rounded-lg bg-gray-900 p-3">
        <pre className="whitespace-pre-wrap break-all text-xs leading-relaxed text-amber-300">
          {data.slice(0, 3000)}
          {data.length > 3000 ? `\n${t("step.truncated")}` : ""}
        </pre>
      </div>
    );
  }

  return (
    <div className="max-h-[300px] overflow-auto rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
      <pre className="whitespace-pre-wrap">{JSON.stringify(data, null, 2).slice(0, 2000)}</pre>
    </div>
  );
}

function PlanDetail({ data }: { data: Record<string, unknown> }) {
  const t = useT();
  const steps = (data.steps ?? []) as Array<Record<string, string>>;
  const elements = (data.elements ?? []) as Array<Record<string, string>>;
  const contentType = String(data.content_type ?? "pipeline");
  const contentDesc = String(data.content_description ?? "");
  const items = contentType === "freeform" ? elements : steps;
  return (
    <div className="space-y-3">
      <div className="rounded-lg bg-amber-50 p-3">
        <div className="text-sm font-semibold text-amber-800">{String(data.title ?? "")}</div>
        <div className="mt-1 text-xs text-amber-600">
          {t("step.layout")} {String(data.layout ?? "")} · {t("step.type")} {String(data.diagram_type ?? "")}
          {contentType === "freeform" && ` · ${t("step.freeLayout")}`}
        </div>
        {typeof data.style_notes === "string" && data.style_notes && (
          <div className="mt-1 text-xs text-amber-500">
            {t("step.style")} {data.style_notes}
          </div>
        )}
        {contentDesc && (
          <div className="mt-1 text-xs text-amber-400 italic">{contentDesc}</div>
        )}
      </div>
      <div className="space-y-2">
        {items.map((s, i) => (
          <div key={i} className="flex items-start gap-2 rounded-lg border border-gray-100 bg-white p-2.5">
            <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-amber-100 text-[10px] font-bold text-amber-700">
              {contentType === "freeform" ? "·" : i + 1}
            </span>
            <div>
              <div className="text-xs font-semibold text-gray-700">{s.label}</div>
              <div className="text-xs text-gray-500">{s.description}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function BlueprintDetail({ data }: { data: Record<string, unknown> }) {
  const t = useT();
  const components = (data.components ?? []) as Array<Record<string, unknown>>;
  const connections = (data.connections ?? []) as Array<Record<string, unknown>>;
  const palette = (data.color_palette ?? []) as string[];

  return (
    <div className="space-y-3">
      <div className="rounded-lg bg-amber-50 p-3">
        <div className="text-sm font-semibold text-amber-800">{t("step.blueprintStructure")}</div>
        <div className="mt-1 flex flex-wrap gap-2 text-xs text-amber-600">
          <span>
            {t("step.totalComponents")} {String(data.total_components ?? 0)}
          </span>
          <span>·</span>
          <span>
            {t("step.illustrations")} {String(data.illustrations ?? 0)}
          </span>
          <span>·</span>
          <span>
            {t("step.nativeComponents")} {String(data.native_components ?? 0)}
          </span>
          <span>·</span>
          <span>
            {t("step.connections")} {String(connections.length)}
          </span>
        </div>
        {typeof data.global_style === "string" && data.global_style && (
          <div className="mt-1 text-xs text-amber-500">
            {t("step.style")} {data.global_style}
          </div>
        )}
        {palette.length > 0 && (
          <div className="mt-2 flex items-center gap-1">
            <span className="text-xs text-amber-500">{t("step.colorPalette")}</span>
            {palette.map((c, i) => (
              <div
                key={i}
                className="h-4 w-4 rounded border border-gray-200"
                style={{ backgroundColor: c }}
                title={c}
              />
            ))}
          </div>
        )}
      </div>

      {components.length > 0 && (
        <div>
          <div className="mb-1 text-xs font-medium text-gray-600">{t("step.componentList")}</div>
          <div className="max-h-[220px] overflow-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-left text-gray-400">
                  <th className="px-2 py-1">ID</th>
                  <th className="px-2 py-1">{t("step.colCategory")}</th>
                  <th className="px-2 py-1">{t("step.colLabel")}</th>
                  <th className="px-2 py-1">{t("step.colNative")}</th>
                  <th className="px-2 py-1">{t("step.colPosition")}</th>
                </tr>
              </thead>
              <tbody>
                {components.map((c, i) => {
                  const bbox = c.bbox as Record<string, number> | undefined;
                  const cat = String(c.category ?? "");
                  const catColor =
                    cat === "illustration"
                      ? "bg-purple-50 text-purple-600"
                      : cat === "stage_box"
                        ? "bg-amber-50 text-amber-600"
                        : cat === "arrow"
                          ? "bg-orange-50 text-orange-600"
                          : "bg-gray-100 text-gray-500";
                  return (
                    <tr key={i} className="border-b border-gray-50 text-gray-600">
                      <td className="px-2 py-1 font-mono text-[10px]">{String(c.id)}</td>
                      <td className="px-2 py-1">
                        <span className={clsx("rounded px-1 py-0.5 text-[10px]", catColor)}>
                          {cat}
                        </span>
                      </td>
                      <td className="px-2 py-1 max-w-[120px] truncate">{String(c.label ?? "")}</td>
                      <td className="px-2 py-1">{c.use_native ? "✓" : ""}</td>
                      <td className="px-2 py-1 font-mono text-[10px] text-gray-400">
                        {bbox ? `${bbox.x?.toFixed(0)},${bbox.y?.toFixed(0)} ${bbox.w?.toFixed(0)}x${bbox.h?.toFixed(0)}` : ""}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {connections.length > 0 && (
        <div>
          <div className="mb-1 text-xs font-medium text-gray-600">{t("step.connectionsHeader")}</div>
          <div className="flex flex-wrap gap-1">
            {connections.map((c, i) => (
              <span key={i} className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">
                {String(c.from_id)} → {String(c.to_id)}
                {typeof c.label === "string" && c.label && ` (${c.label})`}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ConsistencyDetail({ data }: { data: Record<string, unknown> }) {
  const t = useT();
  const total = Number(data.total ?? 0);
  const passed = Number(data.passed ?? 0);
  const regenerated = Number(data.regenerated ?? 0);
  const details = (data.details ?? []) as Array<Record<string, string>>;
  const status = data.status as string | undefined;

  if (status === "skipped") {
    return (
      <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-700">
        {t("step.validationSkipped", {
          reason: String(data.error ?? t("step.unknownReason")),
        })}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div
        className={clsx(
          "rounded-lg p-3 text-sm font-medium",
          regenerated === 0 ? "bg-amber-50 text-amber-700" : "bg-orange-50 text-orange-700",
        )}
      >
        {regenerated === 0
          ? t("step.allPassed", { passed: String(passed), total: String(total) })
          : t("step.partialPass", {
              passed: String(passed),
              total: String(total),
              regenerated: String(regenerated),
            })}
      </div>
      {details.length > 0 && (
        <div className="space-y-1">
          {details.map((d, i) => (
            <div key={i} className="flex items-center gap-2 text-xs text-gray-600">
              {d.status === "pass" ? (
                <Check className="h-3 w-3 text-amber-500" />
              ) : (
                <RefreshCw className="h-3 w-3 text-orange-500" />
              )}
              <span className="font-mono">{d.id}</span>
              {d.issue && <span className="text-gray-400">— {d.issue}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PromptDetail({ prompts }: { prompts: PromptPair }) {
  const [which, setWhich] = useState<"system" | "user">("user");
  return (
    <div className="space-y-2">
      <div className="flex gap-1">
        {(["system", "user"] as const).map((key) => (
          <button
            key={key}
            onClick={() => setWhich(key)}
            className={clsx(
              "rounded-full px-3 py-1 text-xs font-bold transition-all",
              which === key
                ? "bg-primary-container/40 text-primary"
                : "bg-surface-container text-on-surface-variant hover:bg-surface-container-high",
            )}
          >
            {key === "system" ? "System Prompt" : "User Prompt"}
          </button>
        ))}
      </div>
      <div className="max-h-[350px] overflow-auto rounded-lg bg-gray-900 p-3">
        <pre className="whitespace-pre-wrap break-words text-xs leading-relaxed text-amber-300">
          {prompts[which]}
        </pre>
      </div>
    </div>
  );
}
