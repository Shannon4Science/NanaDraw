import { createElement, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Send,
  Loader2,
  Search,
  Image,
  Cpu,
  Trash2,
  CheckCircle2,
  AlertCircle,
  Sparkles,
  Plus,
  Check,
  ZoomIn,
  X,
  Bot,
  PanelRightClose,
  PanelRightOpen,
  Zap,
  Layers,
  ImageIcon,
  Wand2,
  Paperclip,
  FileUp,
} from "lucide-react";
import clsx from "clsx";
import ReactMarkdown from "react-markdown";
import { parsePdfDocument, type ParsedPdfResult } from "../services/api";
import { extractImages, stripComponentDescriptions } from "../services/projectApi";
import { ASSISTANT_AVATAR_URL } from "../lib/avatarUrl";
import { useT } from "../contexts/LanguageContext";
import type { TranslationKey } from "../i18n/zh";
import type { AssetResultItem, ChatMessage, RegenContext, RegenResultItem } from "../hooks/useAssistant";
import { useAssistant } from "../hooks/useAssistant";
import { useDragToCanvas, type DragPayload } from "../hooks/useDragToCanvas";
import type { PipelineStep } from "../hooks/useGenerate";
import type {
  AssistantMode,
  StyleReference,
} from "../types/paper";
import { GalleryModal } from "./GalleryModal";

// ── Constants ──

// eslint-disable-next-line react-refresh/only-export-components
export const MODE_LABEL_KEYS: Record<AssistantMode, TranslationKey> = {
  auto: "chat.mode.auto",
  fast: "chat.mode.draft",
  full_gen: "chat.mode.fullGen",
  image_only: "chat.mode.imageOnly",
};

const MODE_DESC_KEYS: Record<AssistantMode, TranslationKey> = {
  auto: "chat.mode.autoDesc",
  fast: "chat.mode.draftDesc",
  full_gen: "chat.mode.fullGenDesc",
  image_only: "chat.mode.imageOnlyDesc",
};

const MODE_ICONS: Record<AssistantMode, typeof Wand2> = {
  auto: Wand2,
  fast: Zap,
  full_gen: Layers,
  image_only: ImageIcon,
};

const DRAWIO_MODES: AssistantMode[] = ["auto", "fast", "image_only", "full_gen"];
const MAX_PDF_SIZE_BYTES = 200 * 1024 * 1024;

type PdfParseState =
  | { status: "parsing"; fileName: string }
  | { status: "done"; result: ParsedPdfResult; selectedText: string }
  | { status: "error"; fileName: string; error: string };

// ── Props ──

export interface ChatPanelProps {
  mode: AssistantMode;
  onModeChange: (mode: AssistantMode) => void;
  imageModel: string;
  textModel: string;
  componentGenModel: string;
  galleryItems: StyleReference[];
  galleryLoading?: boolean;
  selectedStyleId: string | null;
  onSelectStyleRef: (id: string | null) => void;
  onResultXml: (xml: string) => void;
  onResultImage?: (image: string) => void;
  onPipelineSteps: (steps: PipelineStep[]) => void;
  onReferenceImage: (img: string | null) => void;
  onRetryStepReady: (fn: ((id: string) => void) | null) => void;
  onSaveAsset: (b64: string, name: string) => Promise<boolean>;
  text: string;
  onTextChange: (text: string) => void;
  onGenerate: (text?: string, sketchImage?: string) => void;
  onCancel: () => void;
  isGenerating: boolean;
  genError: string | null;
  genPipelineSteps?: PipelineStep[];
  onQueueInfo?: (position: number | null, total: number | null) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  regenRequest?: { componentId: string; label: string; taskId: string } | null;
  onRegenRequestHandled?: () => void;
  canvasRegenRequest?: {
    cells: Array<{ id: string; label: string; visual_repr?: string; elementType?: string }>;
    pngBase64?: string;
    count: number;
    taskId: string;
  } | null;
  onCanvasRegenHandled?: () => void;
  onInsertComponent?: (componentId: string, imageB64: string) => void;
  onRequestIdChange?: (requestId: string | null) => void;
  editorRef?: React.RefObject<import("./DiagramEditor").DiagramEditorHandle>;
  onCanvasUpdate?: (xml: string, summary: string) => void;
}

// ── Main Component ──

export function ChatPanel({
  mode,
  onModeChange,
  imageModel,
  textModel,
  componentGenModel,
  galleryItems,
  galleryLoading,
  selectedStyleId,
  onSelectStyleRef,
  onResultXml,
  onResultImage,
  onPipelineSteps,
  onReferenceImage,
  onRetryStepReady,
  onSaveAsset,
  text,
  onCancel,
  isGenerating,
  genError,
  genPipelineSteps = [],
  onQueueInfo,
  collapsed,
  onToggleCollapse,
  regenRequest,
  onRegenRequestHandled,
  canvasRegenRequest,
  onCanvasRegenHandled,
  onInsertComponent,
  onRequestIdChange,
  editorRef,
  onCanvasUpdate,
}: ChatPanelProps) {
  const t = useT();
  const [input, setInput] = useState(text);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [stylePreview, setStylePreview] = useState(false);
  const [sketchImage, setSketchImage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const {
    messages,
    isLoading,
    pipelineSteps,
    resultXml,
    resultImage,
    referenceImage,
    requestId: assistantRequestId,
    queuePosition,
    queueTotal,
    sendMessage,
    addUserMessage,
    addAssistantMessage,
    clearMessages,
    cancel: cancelAssistant,
    retryStep,
    setActiveRegenContext,
    activeRegenContext,
    canvasUpdateXml,
    canvasUpdateSummary,
    clearCanvasUpdate,
  } = useAssistant("drawio");

  const { startDrag, ghostElement } = useDragToCanvas(
    editorRef ?? { current: null },
  );

  const bodyRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pdfTextRef = useRef<HTMLPreElement>(null);
  const [attachedFile, setAttachedFile] = useState<{ name: string; type: string; content: string } | null>(null);
  const [pdfParse, setPdfParse] = useState<PdfParseState | null>(null);
  const [pdfPanelCollapsed, setPdfPanelCollapsed] = useState(false);
  const bridgedXmlRef = useRef<string | null>(null);
  const bridgedImageRef = useRef<string | null>(null);
  // Bridge assistant state to DrawPage (dedup via refs to prevent
  // re-firing when only the callback reference changes)
  useEffect(() => {
    if (resultXml && resultXml !== bridgedXmlRef.current) {
      bridgedXmlRef.current = resultXml;
      onResultXml(resultXml);
    }
    if (!resultXml) bridgedXmlRef.current = null;
  }, [resultXml, onResultXml]);

  useEffect(() => {
    if (resultImage && resultImage !== bridgedImageRef.current) {
      bridgedImageRef.current = resultImage;
      onResultImage?.(resultImage);
    }
    if (!resultImage) bridgedImageRef.current = null;
  }, [resultImage, onResultImage]);

  // Bridge canvas_update events to DrawPage
  // NOTE: Do NOT call restoreImages here — the editor already has images loaded.
  // Expanding nanadraw://img/ to base64 inflates 14KB XML to ~4.5MB, which
  // crashes replacePageXml. Image restoration happens locally in DiagramEditor.
  useEffect(() => {
    if (!canvasUpdateXml) return;
    console.log("[CanvasUpdate] Received xml length:", canvasUpdateXml.length);
    onCanvasUpdate?.(canvasUpdateXml, canvasUpdateSummary ?? "");
    clearCanvasUpdate();
  }, [canvasUpdateXml, canvasUpdateSummary, onCanvasUpdate, clearCanvasUpdate]);

  const onQueueInfoRef = useRef(onQueueInfo);
  useLayoutEffect(() => {
    onQueueInfoRef.current = onQueueInfo;
  });
  useEffect(() => {
    onQueueInfoRef.current?.(queuePosition, queueTotal);
  }, [queuePosition, queueTotal]);

  useEffect(() => {
    onPipelineSteps(pipelineSteps);
  }, [pipelineSteps, onPipelineSteps]);

  useEffect(() => {
    onReferenceImage(referenceImage);
  }, [referenceImage, onReferenceImage]);

  useEffect(() => {
    onRetryStepReady(retryStep);
  }, [retryStep, onRetryStepReady]);

  // Bridge assistant requestId to DrawPage
  useEffect(() => {
    onRequestIdChange?.(assistantRequestId);
  }, [assistantRequestId, onRequestIdChange]);

  // Fixed-template regen: insert local messages without calling LLM.
  // The user's NEXT message will carry activeRegenContext to the backend.
  const lastRegenRef = useRef<string | null>(null);
  useEffect(() => {
    if (!regenRequest) {
      lastRegenRef.current = null;
      return;
    }
    const key = `${regenRequest.taskId}:${regenRequest.componentId}`;
    if (lastRegenRef.current === key) return;
    lastRegenRef.current = key;

    const regenCtx: RegenContext = {
      task_id: regenRequest.taskId,
      component_id: regenRequest.componentId,
      component_label: regenRequest.label,
    };
    addUserMessage(t("chat.regenUserMsg", { label: regenRequest.label }));
    addAssistantMessage(t("chat.regenImage", { label: regenRequest.label }));
    setActiveRegenContext(regenCtx);
    onRegenRequestHandled?.();
  }, [regenRequest, addUserMessage, addAssistantMessage, setActiveRegenContext, onRegenRequestHandled, t]);

  // Canvas regen request (right-click → "AI 重新生成" on draw.io)
  const lastCanvasRegenRef = useRef<string | null>(null);
  useEffect(() => {
    if (!canvasRegenRequest) {
      lastCanvasRegenRef.current = null;
      return;
    }
    const { cells, pngBase64, count, taskId } = canvasRegenRequest;
    const key = cells.map((c) => c.id).join(",");
    if (lastCanvasRegenRef.current === key) return;
    lastCanvasRegenRef.current = key;

    if (count === 1) {
      const cell = cells[0];
      const label = cell.label || cell.id;
      const isNativeData = cell.elementType === "chart" || cell.elementType === "table";
      const regenCtx: RegenContext = {
        task_id: taskId,
        component_id: cell.id,
        component_label: label,
        ...(cell.visual_repr?.trim() ? { visual_repr: cell.visual_repr.trim() } : {}),
        component_image_b64: pngBase64,
      };
      addUserMessage(t("chat.regenUserMsg", { label }));
      if (isNativeData) {
        addAssistantMessage(
          t("chat.regenNativeData", { type: cell.elementType === "chart" ? t("chat.chartType") : t("chat.tableType"), label }),
        );
      } else {
        addAssistantMessage(
          t("chat.regenImage", { label }),
        );
      }
      setActiveRegenContext(regenCtx);
    } else {
      const labels = cells.map((c) => c.label || c.id).join("、");
      const joinedRepr = cells
        .map((c) => c.visual_repr?.trim())
        .filter((s): s is string => Boolean(s))
        .join("\n\n---\n\n");
      const regenCtx: RegenContext = {
        task_id: taskId,
        component_id: cells[0].id,
        component_label: labels,
        ...(joinedRepr ? { visual_repr: joinedRepr } : {}),
        component_image_b64: pngBase64,
        batch_components: cells.map((c) => ({
          component_id: c.id,
          component_label: c.label || c.id,
        })),
      };
      addUserMessage(t("chat.regenBatchUser", { count: String(count), labels }));
      addAssistantMessage(
        t("chat.regenBatchAssistant", { count: String(count), labels }),
      );
      setActiveRegenContext(regenCtx);
    }
    onCanvasRegenHandled?.();
  }, [canvasRegenRequest, addUserMessage, addAssistantMessage, setActiveRegenContext, onCanvasRegenHandled, t]);

  // Auto-scroll chat body
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pipelineSteps, genPipelineSteps]);

  const selectedItem = selectedStyleId
    ? galleryItems.find((i) => i.id === selectedStyleId)
    : null;

  // ── Send / Generate logic ──

  const handleAction = useCallback(async () => {
    const trimmed = input.trim();
    if (isLoading || isGenerating) return;

    if (activeRegenContext) {
      setInput("");
      const text = trimmed || t("chat.regenDefaultHint");
      const regenOpts: Parameters<typeof sendMessage>[1] = {
        selectedMode: mode === "auto" ? "auto" : mode,
        textModel: textModel || undefined,
        imageModel: imageModel || undefined,
        componentImageModel: componentGenModel || undefined,
        regenContext: activeRegenContext,
      };
      if (editorRef?.current) {
        try {
          const pageXml = editorRef.current.getCurrentPageXml();
          if (pageXml && pageXml.includes("<mxCell")) {
            const { skeleton, images } = await extractImages(pageXml);
            regenOpts.canvasSkeleton = stripComponentDescriptions(skeleton);
            regenOpts.canvasSkeletonFull = skeleton;
            if (images.size <= 20) {
              regenOpts.canvasImages = Object.fromEntries(images);
            }
          }
        } catch { /* ignore extraction errors */ }
      }
      sendMessage(text, regenOpts);
      return;
    }

    if (!trimmed && !attachedFile) return;

    const text = attachedFile
      ? [
          t("chat.referenceMaterial", { name: attachedFile.name }),
          attachedFile.content,
          trimmed
            ? t("chat.userPromptWithReference", { prompt: trimmed })
            : t("chat.genFromAttachedFile", { name: attachedFile.name }),
        ].join("\n\n")
      : trimmed;

    const sketch = sketchImage;
    setInput("");
    setSketchImage(null);
    const opts: Parameters<typeof sendMessage>[1] = {
      selectedMode: mode === "auto" ? "auto" : mode,
      styleRefId: selectedStyleId,
      sketchImage: sketch,
      textModel: textModel || undefined,
      imageModel: imageModel || undefined,
      componentImageModel: componentGenModel || undefined,
    };
    if (attachedFile) {
      opts.attachedFile = attachedFile;
      setAttachedFile(null);
    }
    if (editorRef?.current) {
      try {
        const pageXml = editorRef.current.getCurrentPageXml();
        if (pageXml && pageXml.includes("<mxCell")) {
          const { skeleton, images } = await extractImages(pageXml);
          opts.canvasSkeleton = stripComponentDescriptions(skeleton);
          opts.canvasSkeletonFull = skeleton;
          if (canvasRegenRequest || images.size <= 20) {
            opts.canvasImages = Object.fromEntries(images);
          }
        }
      } catch { /* ignore extraction errors */ }
    }
    sendMessage(text, opts);
  }, [input, isLoading, isGenerating, mode, sendMessage, sketchImage, selectedStyleId, textModel, imageModel, componentGenModel, attachedFile, editorRef, canvasRegenRequest, activeRegenContext, t]);

  const handlePdfTextSelection = useCallback(() => {
    const selection = window.getSelection();
    const container = pdfTextRef.current;
    if (!selection || !container || !selection.anchorNode || !selection.focusNode) return;
    if (!container.contains(selection.anchorNode) || !container.contains(selection.focusNode)) return;
    const selected = selection.toString().trim();
    if (!selected) return;
    setPdfParse((prev) => (
      prev?.status === "done"
        ? { ...prev, selectedText: selected }
        : prev
    ));
  }, []);

  const handleUsePdfSelection = useCallback(() => {
    if (isLoading || isGenerating || pdfParse?.status !== "done") return;
    const selected = pdfParse.selectedText.trim();
    if (!selected) return;

    setAttachedFile({
      name: pdfParse.result.file_name,
      type: "pdf-selection",
      content: selected,
    });
    setPdfPanelCollapsed(true);
    textareaRef.current?.focus();
  }, [isLoading, isGenerating, pdfParse]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleAction();
      }
      if (e.key === "Escape" && collapsed) onToggleCollapse();
    },
    [handleAction, collapsed, onToggleCollapse],
  );

  const readFileAsB64 = useCallback((file: File) => {
    if (!file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const b64 = result.split(",")[1];
      if (b64) setSketchImage(b64);
    };
    reader.readAsDataURL(file);
  }, []);

  const readDocFile = useCallback(async (file: File) => {
    if (pdfParse?.status === "parsing") return;

    const ext = file.name.split(".").pop()?.toLowerCase();
    const isPdf = ext === "pdf" || file.type === "application/pdf";
    const isMd = ext === "md" || ext === "markdown" || file.type === "text/markdown";
    const isTxt = ext === "txt" || file.type === "text/plain";

    if (isPdf) {
      if (file.size > MAX_PDF_SIZE_BYTES) {
        setAttachedFile(null);
        setPdfParse({ status: "error", fileName: file.name, error: t("chat.pdfTooLarge") });
        return;
      }
      setAttachedFile(null);
      setPdfPanelCollapsed(false);
      setPdfParse({ status: "parsing", fileName: file.name });
      try {
        const result = await parsePdfDocument(file);
        setPdfParse({ status: "done", result, selectedText: "" });
      } catch (err) {
        setPdfParse({
          status: "error",
          fileName: file.name,
          error: err instanceof Error ? err.message : t("chat.pdfParseFailed"),
        });
      }
    } else if (isMd || isTxt) {
      setPdfParse(null);
      const reader = new FileReader();
      reader.onload = () => {
        const text = reader.result as string;
        setAttachedFile({ name: file.name, type: isMd ? "markdown" : "text", content: text });
      };
      reader.readAsText(file);
    }
  }, [pdfParse, t]);

  const handleDocFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) readDocFile(file);
      e.target.value = "";
    },
    [readDocFile],
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) readFileAsB64(file);
          return;
        }
      }
    },
    [readFileAsB64],
  );

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) readFileAsB64(file);
      e.target.value = "";
    },
    [readFileAsB64],
  );

  // ── Track generation completion to add assistant messages ──
  const prevGenRef = useRef(false);
  useEffect(() => {
    if (prevGenRef.current && !isGenerating && genPipelineSteps.length > 0) {
      const hasError = genPipelineSteps.some((s) => s.status === "error");
      if (hasError) {
        addAssistantMessage(t("chat.genFailed"));
      } else {
        addAssistantMessage(t("chat.genComplete"));
      }
    }
    prevGenRef.current = isGenerating;
  }, [isGenerating, genPipelineSteps, addAssistantMessage, t]);

  // ── Collapsed state ──

  if (collapsed) {
    return (
      <div
        className="flex h-full w-11 flex-shrink-0 cursor-pointer flex-col items-center gap-2 border-l pt-3 transition-colors hover:bg-[rgba(123,88,0,0.04)]"
        style={{ background: "rgba(255,255,255,0.92)", borderColor: "rgba(212,196,172,0.2)", boxShadow: "-2px 0 8px -2px rgba(25,28,30,0.06)" }}
        onClick={onToggleCollapse}
        title={t("chat.expandAssistant")}
        data-testid="panel-collapsed"
      >
        <img
          src={ASSISTANT_AVATAR_URL}
          alt={t("chat.title")}
          draggable={false}
          className="h-7 w-7 rounded-[10px] object-cover"
        />
        <PanelRightOpen className="h-4 w-4" style={{ color: "rgba(80,69,51,0.45)" }} />
      </div>
    );
  }

  const isActive = isGenerating || isLoading;
  const isPdfParsing = pdfParse?.status === "parsing";
  const canAct = (input.trim().length > 0 || !!attachedFile) && !isActive && !isPdfParsing;
  const actionLabel = mode === "auto" ? t("chat.send") : t("chat.generate");

  const rawSteps = isGenerating
    ? genPipelineSteps
    : pipelineSteps.length > 0 ? pipelineSteps : (isLoading ? [] : genPipelineSteps);
  const hasActiveStep = rawSteps.some((s) => s.status === "running" || s.status === "pending");
  const visibleSteps = (isActive || hasActiveStep) ? rawSteps : [];

  return (
    <div className="relative flex h-full flex-col bg-surface-container-low/50 backdrop-blur-sm">
      {pdfParse && (
        <div
          className={clsx(
            "absolute right-full top-3 z-30 mr-3 transition-all duration-200",
            pdfPanelCollapsed ? "bottom-auto w-11" : "bottom-3",
          )}
          style={pdfPanelCollapsed ? undefined : { width: "clamp(320px, 32vw, 460px)" }}
        >
          {pdfPanelCollapsed ? (
            <button
              type="button"
              onClick={() => setPdfPanelCollapsed(false)}
              className="flex h-36 w-11 flex-col items-center justify-center gap-2 rounded-2xl border border-amber-100/70 bg-white/95 text-amber-700 shadow-2xl shadow-amber-950/10 backdrop-blur-xl transition hover:bg-amber-50"
              title={pdfParse.status === "done" ? pdfParse.result.file_name : pdfParse.fileName}
            >
              <FileUp className="h-4 w-4" />
              <span className="[writing-mode:vertical-rl] text-[11px] font-bold tracking-wide">PDF</span>
            </button>
          ) : (
            <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-amber-100/70 bg-white/95 text-xs text-stone-700 shadow-2xl shadow-amber-950/10 backdrop-blur-xl">
              <div className="flex items-center gap-2 border-b border-amber-100/70 bg-gradient-to-r from-amber-50/95 to-orange-50/80 px-3 py-2.5">
                {pdfParse.status === "parsing" ? (
                  <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin text-amber-500" />
                ) : pdfParse.status === "error" ? (
                  <AlertCircle className="h-4 w-4 flex-shrink-0 text-red-500" />
                ) : (
                  <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-emerald-500" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-bold text-stone-800">
                    {pdfParse.status === "done" ? pdfParse.result.file_name : pdfParse.fileName}
                  </div>
                  <div className="truncate text-[11px] text-amber-700">
                    {pdfParse.status === "done"
                      ? (pdfParse.selectedText
                          ? t("chat.pdfSelectedChars", { count: String(pdfParse.selectedText.length) })
                          : t("chat.pdfNoSelection"))
                      : pdfParse.status === "parsing"
                        ? t("chat.pdfParsing")
                        : t("chat.pdfParseFailed")}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setPdfPanelCollapsed(true)}
                  className="rounded-full p-1.5 text-stone-400 transition hover:bg-white hover:text-amber-700"
                  title={t("chat.collapsePanel")}
                >
                  <PanelRightOpen className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setPdfParse(null)}
                  className="rounded-full p-1.5 text-stone-400 transition hover:bg-white hover:text-red-500"
                  title={t("chat.close")}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>

              <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
                {pdfParse.status === "parsing" && (
                  <div className="rounded-xl border border-amber-100 bg-amber-50/70 p-3 text-amber-700">
                    {t("chat.pdfParsing")}
                  </div>
                )}
                {pdfParse.status === "error" && (
                  <div className="rounded-xl border border-red-100 bg-red-50 p-3 text-red-600">
                    {pdfParse.error}
                  </div>
                )}
                {pdfParse.status === "done" && (
                  <>
                    <p className="text-[11px] leading-relaxed text-stone-500">{t("chat.pdfSelectHint")}</p>
                    <pre
                      ref={pdfTextRef}
                      onMouseUp={handlePdfTextSelection}
                      onKeyUp={handlePdfTextSelection}
                      className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded-xl border border-stone-200/80 bg-stone-50/70 p-3 font-mono text-[12px] leading-relaxed text-stone-700"
                    >
                      {pdfParse.result.markdown}
                    </pre>
                    <div className="flex items-center gap-2 border-t border-amber-100/70 pt-2">
                      <span className="min-w-0 flex-1 truncate text-[11px] text-amber-700">
                        {pdfParse.selectedText
                          ? t("chat.pdfSelectedChars", { count: String(pdfParse.selectedText.length) })
                          : t("chat.pdfNoSelection")}
                      </span>
                      <button
                        type="button"
                        onClick={handleUsePdfSelection}
                        disabled={!pdfParse.selectedText.trim() || isActive}
                        className="rounded-full bg-gradient-to-r from-amber-500 to-orange-500 px-3 py-1.5 text-[11px] font-semibold text-white shadow-sm shadow-amber-200/60 transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {t("chat.pdfUseSelection")}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Header ── */}
      <div className="flex items-center justify-between bg-surface-container-lowest/80 px-4 py-2.5 backdrop-blur-xl border-b border-outline-variant/8">
        <div className="flex items-center gap-2.5">
          <img
            src={ASSISTANT_AVATAR_URL}
            alt={t("chat.workbench")}
            draggable={false}
            className="h-8 w-8 rounded-full object-cover ring-2 ring-primary-container/40"
          />
          <div className="flex items-center gap-2">
            <span className="font-headline text-sm font-bold text-on-surface">{t("chat.workbench")}</span>
            <span className="inline-block rounded-full bg-amber-100/80 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-tighter text-amber-700">
              {t(MODE_LABEL_KEYS[mode])}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-0.5">
          <button
            onClick={clearMessages}
            className="rounded-full p-1.5 text-outline-variant hover:bg-primary-container/15 hover:text-primary transition-all"
            title={t("chat.clearChat")}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={onToggleCollapse}
            className="rounded-full p-1.5 text-outline-variant hover:bg-primary-container/15 hover:text-primary transition-all"
            title={t("chat.collapsePanel")}
            data-testid="panel-collapse-btn"
          >
            <PanelRightClose className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* ── Body ── */}
      <div ref={bodyRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-4">
        {messages.length === 0 && !isLoading && (
          <WelcomeHome
            mode={mode}
            onModeChange={onModeChange}
            onExampleClick={(text) => setInput(text)}
          />
        )}

        {messages.map((msg) => (
          <div key={msg.id}>
            <MessageBubble
              msg={msg}
              onSaveAsset={onSaveAsset}
              onInsertComponent={onInsertComponent}
              onImageDragStart={editorRef ? startDrag : undefined}
            />
          </div>
        ))}

        {ghostElement}

        {queuePosition != null && visibleSteps.length === 0 && (
          <div className="flex items-center gap-2 rounded-2xl border border-primary/10 bg-primary-container/20 p-3 text-xs text-primary">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span>{t("chat.queueInfo", { pos: String(queuePosition), total: String(queueTotal ?? "?") })}</span>
          </div>
        )}

        {visibleSteps.length > 0 && <PipelineMiniProgress steps={visibleSteps} />}

        {isActive && messages.every((m) => m.role !== "assistant" || m.done) && visibleSteps.length === 0 && (
          <div className="flex items-center gap-2 text-sm text-outline">
            <Loader2 className="h-4 w-4 animate-spin" /> {t("chat.thinking")}
          </div>
        )}

        {genError && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {genError}
          </div>
        )}
      </div>

      {/* ── Footer ── */}
      <div className="bg-surface-container-low/50 px-3 py-2.5">
        {/* Reference material bar — only relevant for image_only / full_gen */}
        {(mode === "auto" || mode === "full_gen" || mode === "image_only") && (
        <div className="mb-2 flex items-center gap-2 text-xs">
          {selectedItem ? (
            <>
              <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-primary-200 bg-primary-50 px-2 py-1.5">
                <img
                  src={selectedItem.thumbnail_url}
                  alt={selectedItem.name}
                  className="h-6 w-8 flex-shrink-0 cursor-pointer rounded object-cover ring-primary-300 transition-shadow hover:ring-2"
                  title={t("chat.clickToZoom")}
                  onClick={() => setStylePreview(true)}
                />
                <span className="flex-1 truncate text-on-surface">{selectedItem.name}</span>
                <button
                  onClick={() => onSelectStyleRef(null)}
                  className="text-outline hover:text-red-500"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
              <button
                onClick={() => setGalleryOpen(true)}
                className="flex-shrink-0 rounded-md border border-primary-200 bg-primary-50 px-2 py-1.5 text-primary-600 transition-colors hover:bg-primary-100 hover:text-primary-800"
              >
                {t("chat.changeImage")}
              </button>
            </>
          ) : (
            <button
              onClick={() => setGalleryOpen(true)}
              className="flex flex-1 items-center gap-1.5 rounded-lg border border-dashed border-gray-300 px-2.5 py-1.5 text-outline transition-colors hover:border-primary-400 hover:text-primary-600"
            >
              <Image className="h-3 w-3" />
              {galleryLoading ? t("chat.loading") : t("chat.styleRef")}
            </button>
          )}
        </div>
        )}

        {/* Text input */}
        <div className="rounded-2xl border border-outline-variant/10 bg-surface-container-lowest shadow-lg shadow-black/5 backdrop-blur-lg focus-within:ring-1 focus-within:ring-primary-container/30 transition-all">
          {sketchImage && (
            <div className="flex items-center gap-2 border-b border-gray-50 px-3 py-1.5">
              <img
                src={`data:image/png;base64,${sketchImage}`}
                alt={t("chat.sketchImage")}
                className="h-12 w-16 rounded object-cover ring-1 ring-gray-200"
              />
              <span className="flex-1 text-xs text-on-surface-variant">{t("chat.sketchAttached")}</span>
              <button
                onClick={() => setSketchImage(null)}
                className="text-outline hover:text-red-500"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={
              mode === "auto"
                ? t("chat.placeholder.chat")
                : t("chat.placeholder.generate")
            }
            disabled={isActive}
            rows={2}
            className="w-full resize-none bg-transparent px-3 py-2 text-sm text-gray-800 placeholder-gray-400 outline-none disabled:opacity-50"
            data-testid="chat-input"
          />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleFileChange}
          />
          <input
            type="file"
            accept=".pdf,application/pdf,.md,.txt,.markdown,text/plain,text/markdown"
            className="hidden"
            id="doc-file-input"
            onChange={handleDocFileChange}
          />

          {/* Attached file preview */}
          {attachedFile && (
            <div className="mx-3 flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5">
              <FileUp className="h-3.5 w-3.5 text-amber-500" />
              <div className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-amber-800">{attachedFile.name}</span>
                <span className="block truncate text-[10px] text-amber-700">
                  {attachedFile.type === "pdf-selection"
                    ? t("chat.pdfSelectionAttached")
                    : attachedFile.type === "markdown"
                      ? t("chat.mdAttached")
                      : t("chat.txtAttached")}
                </span>
              </div>
              <button
                onClick={() => setAttachedFile(null)}
                className="text-outline hover:text-red-500"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {/* Action bar */}
          <div className="flex items-end gap-1.5 border-t border-gray-50 px-2 py-1.5">
            {/* Attach sketch */}
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isActive}
              className={clsx(
                "mb-0.5 shrink-0 rounded-full border p-1 transition-all",
                sketchImage
                  ? "border-primary/30 bg-primary-container/30 text-primary"
                  : "border-outline-variant/10 text-outline hover:border-outline-variant/20 hover:text-on-surface-variant",
              )}
              title={t("chat.uploadSketch")}
            >
              <Paperclip className="h-3.5 w-3.5" />
            </button>

            <button
              onClick={() => document.getElementById("doc-file-input")?.click()}
              disabled={isActive || isPdfParsing}
              className={clsx(
                "mb-0.5 shrink-0 rounded-full border p-1 transition-all",
                attachedFile || pdfParse
                  ? "border-primary/30 bg-primary-container/30 text-primary"
                  : "border-outline-variant/10 text-outline hover:border-outline-variant/20 hover:text-on-surface-variant",
              )}
              title={t("chat.uploadFile")}
            >
              <FileUp className="h-3.5 w-3.5" />
            </button>

            {/* Mode */}
            <div className="flex min-w-0">
              <select
                value={mode}
                onChange={(e) => onModeChange(e.target.value as AssistantMode)}
                disabled={isActive}
                className={clsx(
                  "w-full rounded-full border px-1.5 py-1 text-[11px] font-bold outline-none transition-all",
                  mode !== "auto"
                    ? "border-primary/30 bg-primary-container/30 text-primary"
                    : "border-outline-variant/10 bg-surface-container-low text-on-surface-variant",
                )}
              >
                {DRAWIO_MODES.map((m) => (
                  <option key={m} value={m}>
                    {t(MODE_LABEL_KEYS[m])}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex-1" />

            {/* Send / Cancel */}
            {isActive ? (
              <button
                onClick={() => { onCancel(); cancelAssistant(); }}
                className="mb-0.5 shrink-0 rounded-lg bg-red-500 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-red-600"
              >
                {t("chat.stop")}
              </button>
            ) : (
              <button
                onClick={handleAction}
                disabled={!canAct}
                className={clsx(
                  "mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-all",
                  canAct
                    ? "bg-primary-container text-on-primary-container shadow-md shadow-primary-container/20 hover:scale-105 active:scale-95"
                    : "bg-surface-container text-outline-variant",
                )}
                title={actionLabel}
              >
                <Send className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Gallery Modal */}
      {galleryOpen && createPortal(
        <GalleryModal
          items={galleryItems}
          selectedId={selectedStyleId}
          onSelect={(id) => {
            onSelectStyleRef(id);
            if (id) setGalleryOpen(false);
          }}
          onClose={() => setGalleryOpen(false)}
        />,
        document.body,
      )}

      {/* Style Reference Preview Lightbox */}
      {stylePreview && selectedItem && createPortal(
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/20 backdrop-blur-sm"
          onClick={() => setStylePreview(false)}
        >
          <button
            onClick={() => setStylePreview(false)}
            className="absolute right-4 top-4 rounded-full bg-white/20 p-2 text-white backdrop-blur transition-colors hover:bg-white/40"
          >
            <X className="h-5 w-5" />
          </button>
          <div className="flex flex-col items-center gap-3" onClick={(e) => e.stopPropagation()}>
            <img
              src={selectedItem.thumbnail_url}
              alt={selectedItem.name}
              className="max-h-[70vh] max-w-[70vw] rounded-xl object-contain shadow-2xl"
            />
            <span className="rounded-lg bg-black/40 px-3 py-1 text-sm text-white">
              {selectedItem.name}
            </span>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

// ── WelcomeHome ──

function WelcomeHome({
  mode,
  onModeChange,
  onExampleClick,
}: {
  mode: AssistantMode;
  onModeChange: (m: AssistantMode) => void;
  onExampleClick?: (text: string) => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-col items-center gap-4 py-6 text-center">
      <img
        src={ASSISTANT_AVATAR_URL}
        alt={t("chat.workbench")}
        draggable={false}
        className="h-16 w-16 rounded-2xl object-cover shadow-md"
      />
      <div className="space-y-1.5">
        <p className="text-sm font-semibold text-on-surface">{t("chat.greeting")}</p>
        <p className="text-xs leading-relaxed text-outline">
          {t("chat.greetingSub")}
        </p>
        <p className="text-xs leading-relaxed text-outline">
          {t("chat.greetingTipSettings")}
        </p>
      </div>

      {/* Mode cards */}
      <div className="mt-2 grid w-full grid-cols-2 gap-2.5">
        {DRAWIO_MODES.map((m) => {
          const Icon = MODE_ICONS[m];
          const selected = mode === m;
          return (
            <button
              key={m}
              onClick={() => onModeChange(m)}
              className={clsx(
                "flex flex-col items-center gap-1.5 rounded-lg border px-3 py-3 text-center transition-all active:scale-[0.97]",
                selected
                  ? "border-amber-200 bg-amber-50 text-amber-700 shadow-[0_3px_12px_rgba(245,158,11,0.15)]"
                  : "border-transparent bg-white text-on-surface-variant shadow-[0_2px_8px_rgba(0,0,0,0.06)] hover:shadow-[0_4px_14px_rgba(0,0,0,0.1)]",
              )}
            >
              <Icon
                className={clsx(
                  "h-5 w-5",
                  selected ? "text-amber-600" : "text-stone-400",
                )}
              />
              <span
                className={clsx(
                  "text-xs font-semibold",
                  selected ? "text-amber-700" : "text-stone-600",
                )}
              >
                {t(MODE_LABEL_KEYS[m])}
              </span>
              <span className={clsx("text-[10px] leading-tight", selected ? "text-amber-600/60" : "text-stone-400")}>
                {t(MODE_DESC_KEYS[m])}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-3 flex w-full flex-col gap-2">
        {(["chat.example1", "chat.example2"] as const).map((k) => {
          const text = t(k);
          return (
            <button
              key={k}
              type="button"
              onClick={() => onExampleClick?.(text)}
              className="rounded-lg bg-white px-4 py-2.5 text-[12px] leading-snug text-stone-500 shadow-[0_2px_8px_rgba(0,0,0,0.06)] transition-all hover:shadow-[0_4px_12px_rgba(0,0,0,0.1)] hover:text-amber-600 active:scale-[0.97] cursor-pointer text-left"
            >
              {text}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── MessageBubble ──

function MessageBubble({
  msg,
  onSaveAsset,
  onInsertComponent,
  onImageDragStart,
}: {
  msg: ChatMessage;
  onSaveAsset?: (imageB64: string, name: string) => Promise<boolean>;
  onInsertComponent?: (componentId: string, imageB64: string) => void;
  onImageDragStart?: (e: React.MouseEvent, payload: DragPayload) => void;
}) {
  const t = useT();
  if (msg.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-xl rounded-tr-none bg-amber-100/90 text-on-surface px-4 py-2.5 text-sm leading-relaxed shadow-md">
          {msg.sketchImage && (
            <div className="mb-1.5 flex items-center gap-2 rounded-lg bg-amber-200/40 px-2 py-1">
              <img
                src={`data:image/png;base64,${msg.sketchImage}`}
                alt={t("chat.sketchImage")}
                className="h-10 w-14 rounded object-cover ring-1 ring-amber-300/30"
              />
              <span className="text-xs text-amber-800">{t("chat.sketchAttached")}</span>
            </div>
          )}
          {msg.attachedFile && (
            <div className="mb-1.5 flex items-center gap-2 rounded-lg bg-amber-200/40 px-2 py-1.5">
              <FileUp className="h-4 w-4 flex-shrink-0 text-amber-700" />
              <div className="min-w-0">
                <span className="block truncate text-xs font-medium text-on-surface">{msg.attachedFile.name}</span>
                <span className="text-[10px] text-amber-700">
                  {msg.attachedFile.type === "pdf-selection" ? t("chat.pdfSelectionAttached") : msg.attachedFile.type === "pdf" ? t("chat.pdfAttached") : msg.attachedFile.type === "markdown" ? t("chat.mdAttached") : t("chat.txtAttached")}
                </span>
              </div>
            </div>
          )}
          {msg.content}
        </div>
      </div>
    );
  }

  if (msg.role === "assistant") {
    return (
      <div className="flex items-start gap-2">
        <img
          src={ASSISTANT_AVATAR_URL}
          alt={t("chat.assistantAlt")}
          draggable={false}
          className="mt-1 h-8 w-8 flex-shrink-0 rounded-full object-cover ring-2 ring-primary-container/30"
        />
        <div
          className={clsx(
            "max-w-[85%] rounded-xl rounded-tl-none bg-surface-container-low px-4 py-2.5 text-sm text-on-surface shadow-sm",
            !msg.done && "animate-pulse",
          )}
        >
          {msg.content ? (
            <div className="prose prose-sm prose-gray max-w-none prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-headings:my-2 prose-strong:text-gray-800">
              <ReactMarkdown>{msg.content}</ReactMarkdown>
            </div>
          ) : (
            <span className="flex items-center gap-1 text-outline">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("chat.isThinking")}
            </span>
          )}
        </div>
      </div>
    );
  }

  if (msg.role === "tool_call") {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-secondary-container/40 px-3 py-2 text-xs font-bold text-on-secondary-container shadow-sm backdrop-blur-md">
        {createElement(toolIcon(msg.toolName), { className: "h-3.5 w-3.5 animate-pulse" })}
        <span>{msg.content}</span>
      </div>
    );
  }

  if (msg.role === "tool_result") {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-amber-50/80 px-3 py-2 text-xs text-amber-700">
        <CheckCircle2 className="h-3.5 w-3.5" />
        <span className="truncate">{formatToolResult(msg.content, t)}</span>
      </div>
    );
  }

  if (msg.role === "asset_results" && msg.assetImages?.length) {
    return <AssetResultsCard images={msg.assetImages} onSave={onSaveAsset} onImageDragStart={onImageDragStart} />;
  }

  if (msg.role === "regen_loading") {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-purple-100 bg-purple-50/50 px-3 py-2 text-xs text-purple-600">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {msg.content}
      </div>
    );
  }

  if (msg.role === "regen_results" && msg.regenImages?.length) {
    return (
      <ComponentRegenCard
        images={msg.regenImages}
        componentId={msg.regenComponentId || ""}
        onInsert={onInsertComponent}
        onImageDragStart={onImageDragStart}
      />
    );
  }

  return null;
}

// ── Helpers ──

function toolIcon(name?: string) {
  switch (name) {
    case "search_gallery":
      return Search;
    case "generate_diagram":
      return Image;
    case "generate_assets":
      return Sparkles;
    case "list_image_models":
      return Cpu;
    default:
      return Bot;
  }
}

function formatToolResult(raw: string, t: (key: TranslationKey, vars?: Record<string, string | number>) => string): string {
  try {
    const data = JSON.parse(raw);
    if (data.found !== undefined) return t("chat.foundStyles", { count: data.found });
    if (data.models) return t("chat.availableModels", { count: data.models.length });
    if (data.error) return t("chat.error", { msg: data.error });
    return raw;
  } catch {
    return raw.length > 100 ? raw.slice(0, 100) + "..." : raw;
  }
}

// ── PipelineMiniProgress ──

function MiniRunningTimer({ startedAt }: { startedAt: number }) {
  const [elapsed, setElapsed] = useState(() => Date.now() - startedAt);
  useEffect(() => {
    const id = setInterval(() => setElapsed(Date.now() - startedAt), 200);
    return () => clearInterval(id);
  }, [startedAt]);
  return <>{(elapsed / 1000).toFixed(1)}s</>;
}

function PipelineMiniProgress({ steps }: { steps: PipelineStep[] }) {
  const t = useT();
  const total = steps.length;
  const completed = steps.filter((s) => s.status === "completed").length;
  const hasError = steps.some((s) => s.status === "error");
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="rounded-lg border border-white/40 bg-surface-container-lowest/80 p-3 shadow-[0_8px_20px_-6px_rgba(0,0,0,0.05)] backdrop-blur-xl">
      <div className="mb-2 flex items-center justify-between text-xs font-bold text-on-surface-variant">
        <span>{t("chat.pipelineProgress")}</span>
        <span className="font-mono text-primary">{pct}%</span>
      </div>
      <div className="mb-2.5 h-1.5 overflow-hidden rounded-full bg-surface-container-high">
        <div
          className={clsx(
            "h-full rounded-full transition-all duration-500",
            hasError ? "bg-error" : "bg-primary-container shadow-[0_0_8px_rgba(242,177,13,0.3)]",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="space-y-1">
        {steps.map((s) => (
          <div key={s.id} className="flex items-center gap-2 rounded-lg px-1.5 py-1 text-xs text-on-surface-variant transition-colors hover:bg-surface-container/40">
            {s.status === "completed" && <CheckCircle2 className="h-3 w-3 text-amber-500" />}
            {s.status === "running" && <Loader2 className="h-3 w-3 animate-spin text-primary" />}
            {s.status === "error" && <AlertCircle className="h-3 w-3 text-error" />}
            {s.status === "pending" && (
              <span className="inline-block h-3 w-3 rounded-full border border-outline-variant/30" />
            )}
            <span className={clsx(s.status === "completed" && "text-outline")}>{s.name}</span>
            {s.status === "running" && s.startedAt != null ? (
              <span className="ml-auto animate-pulse font-mono text-primary/70">
                <MiniRunningTimer startedAt={s.startedAt} />
              </span>
            ) : s.elapsedMs != null ? (
              <span className="ml-auto font-mono text-outline-variant">{(s.elapsedMs / 1000).toFixed(1)}s</span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── AssetResultsCard ──

function AssetResultsCard({
  images,
  onSave,
  onImageDragStart,
}: {
  images: AssetResultItem[];
  onSave?: (imageB64: string, name: string) => Promise<boolean>;
  onImageDragStart?: (e: React.MouseEvent, payload: DragPayload) => void;
}) {
  const t = useT();
  const [savedKeys, setSavedKeys] = useState<Set<number>>(new Set());
  const [savingIdx, setSavingIdx] = useState<number | null>(null);
  const [previewIdx, setPreviewIdx] = useState<number | null>(null);

  const handleSave = useCallback(
    async (idx: number, desc: string, b64: string) => {
      if (!onSave || savedKeys.has(idx)) return;
      const name = window.prompt(t("chat.nameAsset"), desc);
      if (!name) return;
      setSavingIdx(idx);
      try {
        const ok = await onSave(b64, name);
        if (ok) setSavedKeys((prev) => new Set(prev).add(idx));
      } finally {
        setSavingIdx(null);
      }
    },
    [onSave, savedKeys, t],
  );

  return (
    <>
      <div className="rounded-xl border border-indigo-100 bg-indigo-50/50 p-3">
        <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-indigo-600">
          <Sparkles className="h-3.5 w-3.5" />
          {t("chat.genAssetsCount", { count: String(images.length) })}
        </div>
        <div className="grid grid-cols-3 gap-2">
          {images.map((img, idx) => {
            const isSaved = savedKeys.has(idx);
            const isSaving = savingIdx === idx;
            return (
              <div
                key={idx}
                className="group relative overflow-hidden rounded-lg border border-indigo-100 bg-white"
              >
                <div
                  className="relative flex cursor-grab items-center justify-center bg-gray-50 p-1.5 active:cursor-grabbing"
                  onClick={() => setPreviewIdx(idx)}
                  onMouseDown={(e) => {
                    if (e.button !== 0 || !onImageDragStart) return;
                    onImageDragStart(e, {
                      type: "png",
                      data: img.image_b64,
                      width: 100,
                      height: 100,
                      previewUrl: `data:image/png;base64,${img.image_b64}`,
                    });
                  }}
                >
                  <img
                    src={`data:image/png;base64,${img.image_b64}`}
                    alt={img.description}
                    draggable={false}
                    className="h-16 w-16 object-contain"
                  />
                  <div className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all group-hover:bg-black/5 group-hover:opacity-100">
                    <ZoomIn className="h-4 w-4 text-on-surface-variant" />
                  </div>
                </div>
                <div className="border-t px-1.5 py-1">
                  <p className="truncate text-[9px] text-on-surface-variant" title={img.description}>
                    {img.description}
                  </p>
                  {onSave &&
                    (isSaved ? (
                      <button
                        disabled
                        className="mt-1 flex w-full items-center justify-center gap-0.5 rounded border border-amber-200 bg-amber-50 py-0.5 text-[9px] font-medium text-amber-700"
                      >
                        <Check className="h-2.5 w-2.5" /> {t("chat.joined")}
                      </button>
                    ) : (
                      <button
                        onClick={() => handleSave(idx, img.description, img.image_b64)}
                        disabled={isSaving}
                        className="mt-1 flex w-full items-center justify-center gap-0.5 rounded border border-indigo-200 bg-indigo-50 py-0.5 text-[9px] font-medium text-indigo-600 transition-colors hover:bg-indigo-100 disabled:opacity-50"
                      >
                        {isSaving ? (
                          <Loader2 className="h-2.5 w-2.5 animate-spin" />
                        ) : (
                          <Plus className="h-2.5 w-2.5" />
                        )}
                        {t("chat.joinAsset")}
                      </button>
                    ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {previewIdx !== null && images[previewIdx] && createPortal(
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/30 backdrop-blur-sm"
          onClick={() => setPreviewIdx(null)}
        >
          <button
            onClick={() => setPreviewIdx(null)}
            className="absolute right-4 top-4 rounded-full bg-white/20 p-2 text-white backdrop-blur transition-colors hover:bg-white/40"
          >
            <X className="h-5 w-5" />
          </button>
          <img
            src={`data:image/png;base64,${images[previewIdx].image_b64}`}
            alt="preview"
            className="max-h-[85vh] max-w-[85vw] rounded-lg object-contain shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>,
        document.body,
      )}
    </>
  );
}

// ── ComponentRegenCard ──

function ComponentRegenCard({
  images,
  componentId,
  onInsert,
  onImageDragStart,
}: {
  images: RegenResultItem[];
  componentId: string;
  onInsert?: (componentId: string, imageB64: string) => void;
  onImageDragStart?: (e: React.MouseEvent, payload: DragPayload) => void;
}) {
  const t = useT();
  const [previewIdx, setPreviewIdx] = useState<number | null>(null);
  const [insertedSet, setInsertedSet] = useState<Set<number>>(new Set());

  return (
    <>
      <div className="rounded-xl border border-purple-100 bg-purple-50/50 p-3">
        <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-purple-600">
          <Sparkles className="h-3.5 w-3.5" />
          {t("chat.componentAltCount", { count: String(images.length) })}
        </div>
        <div className="grid grid-cols-3 gap-2">
          {images.map((img, idx) => {
            const isInserted = insertedSet.has(idx);
            return (
              <div
                key={idx}
                className={clsx(
                  "group relative overflow-hidden rounded-lg border bg-white",
                  isInserted ? "border-amber-400 ring-1 ring-amber-200" : "border-purple-100",
                )}
              >
                <div
                  className="relative flex cursor-grab items-center justify-center bg-gray-50 p-1.5 active:cursor-grabbing"
                  onClick={() => setPreviewIdx(idx)}
                  onMouseDown={(e) => {
                    if (e.button !== 0 || !onImageDragStart) return;
                    onImageDragStart(e, {
                      type: "png",
                      data: img.image_b64,
                      width: 200,
                      height: 200,
                      previewUrl: `data:image/png;base64,${img.image_b64}`,
                    });
                  }}
                >
                  <img
                    draggable={false}
                    src={`data:image/png;base64,${img.image_b64}`}
                    alt={img.description}
                    className="max-h-24 rounded object-contain"
                  />
                  <div className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all group-hover:bg-black/20 group-hover:opacity-100">
                    <ZoomIn className="h-5 w-5 text-white drop-shadow" />
                  </div>
                </div>
                {onInsert && (
                  <div className="flex items-center justify-center border-t border-gray-100 px-2 py-1">
                    <button
                      onClick={() => {
                        onInsert(componentId, img.image_b64);
                        setInsertedSet((prev) => new Set(prev).add(idx));
                      }}
                      disabled={isInserted}
                      className={clsx(
                        "flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors",
                        isInserted
                          ? "bg-amber-50 text-amber-600"
                          : "text-purple-500 hover:bg-purple-50",
                      )}
                    >
                      {isInserted ? (
                        <>
                          <Check className="h-3 w-3" /> {t("chat.inserted")}
                        </>
                      ) : (
                        <>
                          <Plus className="h-3 w-3" /> {t("chat.insertToCanvas")}
                        </>
                      )}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {previewIdx != null && createPortal(
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/30 backdrop-blur-sm"
          onClick={() => setPreviewIdx(null)}
        >
          <img
            src={`data:image/png;base64,${images[previewIdx].image_b64}`}
            alt={t("chat.preview")}
            className="max-h-[85vh] max-w-[85vw] rounded-lg object-contain shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            onClick={() => setPreviewIdx(null)}
            className="absolute right-4 top-4 rounded-full bg-white/20 p-2 text-white backdrop-blur transition-colors hover:bg-white/40"
          >
            <X className="h-5 w-5" />
          </button>
        </div>,
        document.body,
      )}
    </>
  );
}
