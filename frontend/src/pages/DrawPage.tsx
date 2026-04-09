import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import clsx from "clsx";
import { BioiconsDrawer } from "../components/BioiconsPanel";
import { BottomPanel } from "../components/BottomPanel";
import { ChatPanel, MODE_LABEL_KEYS } from "../components/ChatPanel";
import { DiagramEditor, type DiagramEditorHandle, type SaveToAssetsPayload, type RegenFromCanvasPayload } from "../components/DiagramEditor";
import { ExportPanel } from "../components/ExportPanel";
import { SaveElementDialog } from "../components/SaveElementDialog";
import { SettingsPanel } from "../components/SettingsPanel";
import { exportDrawioToPptx } from "../lib/pptxExport";
import { LanguageSwitcher, UserButton } from "../components/UserButton";
import { useGallery } from "../hooks/useGallery";
import type { PipelineStep } from "../hooks/useGenerate";
import { useGenerate } from "../hooks/useGenerate";
import { useUserElements } from "../hooks/useUserElements";
import { fetchModelDefaults } from "../services/modelsApi";
import { createProject, getCanvasData, getProject, restoreImages, saveCanvas, updateProject } from "../services/projectApi";
import type { AssistantMode, GenerateRequest, StyleSpec } from "../types/paper";
import { useT } from "../contexts/LanguageContext";
import type { TranslationKey } from "../i18n/zh";

type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";
const AUTO_SAVE_INTERVAL = 30_000;

function detectImageMime(b64: string): string {
  if (b64.startsWith("/9j/")) return "image/jpeg";
  if (b64.startsWith("iVBOR")) return "image/png";
  if (b64.startsWith("UklGR")) return "image/webp";
  if (b64.startsWith("R0lGOD")) return "image/gif";
  return "image/png";
}

function buildImagePageXml(imageB64: string): string {
  const mime = detectImageMime(imageB64);
  const dataUri = `data:${mime};base64,${imageB64}`;
  const htmlLabel = `&lt;img src=&quot;${dataUri}&quot; style=&quot;max-width:100%;max-height:100%&quot;&gt;`;
  return `<mxfile><diagram><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="img" value="${htmlLabel}" style="text;html=1;overflow=fill;fillColor=none;strokeColor=none;align=center;verticalAlign=middle;whiteSpace=wrap;" vertex="1" parent="1"><mxGeometry x="20" y="20" width="960" height="720" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>`;
}

const MIN_BOTTOM_H = 48;
const DEFAULT_BOTTOM_H = 280;
const MIN_PANEL_W = 320;
const MAX_PANEL_W = 720;
const DEFAULT_PANEL_W = 420;

const CANVAS_TYPE = "drawio" as const;

const MODE_DEFAULT_STEP_KEYS: Record<string, { id: string; nameKey: TranslationKey }[]> = {
  auto: [
    { id: "mode_selection", nameKey: "draw.mode.auto" },
  ],
  fast: [
    { id: "planning", nameKey: "draw.mode.planning" },
    { id: "xml_generation", nameKey: "draw.mode.xmlGen" },
  ],
  full_gen: [
    { id: "planning", nameKey: "draw.mode.textPlanning" },
    { id: "image_generation", nameKey: "draw.mode.blueprintGen" },
    { id: "blueprint_extraction", nameKey: "draw.mode.blueprintExtract" },
    { id: "component_generation", nameKey: "draw.mode.componentGen" },
    { id: "assembly_refine", nameKey: "draw.mode.assembly" },
  ],
  image_only: [
    { id: "planning", nameKey: "draw.mode.textPlanning" },
    { id: "result_image", nameKey: "draw.mode.resultImage" },
  ],
};

export function DrawPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const t = useT();
  const projectId = searchParams.get("project");

  const [text, setText] = useState("");
  const [mode, setMode] = useState<AssistantMode>("auto");
  const [selectedStyleId, setSelectedStyleId] = useState<string | null>(null);
  const [styleSpec] = useState<StyleSpec>({});


  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_W);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [bottomHeight, setBottomHeight] = useState(DEFAULT_BOTTOM_H);
  const [bottomCollapsed, setBottomCollapsed] = useState(true);
  const panelResizing = useRef(false);
  const bottomResizing = useRef(false);
  const rafRef = useRef(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const mainAreaRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const livePanelW = useRef(DEFAULT_PANEL_W);
  const liveBottomH = useRef(DEFAULT_BOTTOM_H);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  const [bioiconsOpen, setBioiconsOpen] = useState(false);
  const [bioBtnPos, setBioBtnPos] = useState({ left: 520, top: 10 });
  const bioDrag = useRef<{ startX: number; startY: number; origLeft: number; origTop: number; moved: boolean } | null>(null);
  const [imageModel, setImageModel] = useState<string>("gemini-3-pro-image-preview");
  const [componentGenModel, setComponentGenModel] = useState<string>("");
  const [textModel, setTextModel] = useState<string>("");

  const [assistantSteps, setAssistantSteps] = useState<PipelineStep[]>([]);
  const [assistantRefImage, setAssistantRefImage] = useState<string | null>(null);
  const [assistantQueue, setAssistantQueue] = useState<{ position: number | null; total: number | null }>({ position: null, total: null });
  const assistantRetryRef = useRef<((stepId: string) => void) | null>(null);
  const [regenRequest, setRegenRequest] = useState<{ componentId: string; label: string; taskId: string } | null>(null);
  const [canvasRegenRequest, setCanvasRegenRequest] = useState<{
    cells: Array<{ id: string; label: string; visual_repr?: string; elementType?: string }>;
    pngBase64?: string;
    count: number;
    taskId: string;
  } | null>(null);
  const [saveAssetDialog, setSaveAssetDialog] = useState<{ pngBase64: string; defaultName: string } | null>(null);
  const [saveAssetBusy, setSaveAssetBusy] = useState(false);
  const assistantRequestIdRef = useRef<string | null>(null);

  const [cloudProjectName, setCloudProjectName] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [saveDialogName, setSaveDialogName] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const serverNameRef = useRef<string | null>(null);

  const editorRef = useRef<DiagramEditorHandle>(null);
  const manualGenActiveRef = useRef(false);
  const autoSaveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const latestCanvasDataRef = useRef<string | null>(null);
  const pendingCloudDataRef = useRef<string | null>(null);
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const suppressDirtyRef = useRef(false);
  const suppressDirtyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const gallery = useGallery();
  const gen = useGenerate();
  const userEls = useUserElements();

  // When direct-gen starts, clear stale assistant data and expand panel
  useEffect(() => {
    manualGenActiveRef.current = gen.isGenerating;
    if (gen.isGenerating) {
      setAssistantSteps([]);
      setAssistantRefImage(null);
      setBottomCollapsed(false);
      if (bottomHeight < 200) setBottomHeight(DEFAULT_BOTTOM_H);
    }
  }, [gen.isGenerating]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAssistantPipelineSteps = useCallback((steps: PipelineStep[]) => {
    if (manualGenActiveRef.current) return;
    setAssistantSteps(steps);
    if (steps.length > 0) {
      setBottomCollapsed(false);
      setBottomHeight((h) => (h < 200 ? DEFAULT_BOTTOM_H : h));
    }
  }, []);

  const extractPageName = useCallback((steps: PipelineStep[]): string => {
    const planning = steps.find((s) => s.id === "planning" && s.status === "completed");
    if (planning?.artifact) {
      const art = planning.artifact as Record<string, unknown>;
      if (typeof art.title === "string" && art.title.trim()) return art.title.trim();
    }
    return t("draw.result");
  }, [t]);

  const canvasBackupRef = useRef<string | null>(null);

  const handleCanvasUpdate = useCallback((xml: string, _summary: string) => {
    if (editorRef.current) {
      canvasBackupRef.current = editorRef.current.getXml();
      editorRef.current.replaceCurrentPageXml(xml);
    } else {
      console.warn("[DrawPage] editorRef.current is null, cannot apply canvas update");
    }
  }, []);

  const handleAssistantResultXml = useCallback((xml: string) => {
    const pageName = extractPageName(assistantSteps);
    editorRef.current?.addPage(xml, pageName);
  }, [assistantSteps, extractPageName]);

  const handleAssistantResultImage = useCallback((image: string) => {
    const xml = buildImagePageXml(image);
    const pageName = extractPageName(assistantSteps);
    editorRef.current?.addPage(xml, pageName);
  }, [assistantSteps, extractPageName]);

  const handleAssistantRefImage = useCallback((img: string | null) => {
    setAssistantRefImage(img);
  }, []);

  const handleAssistantRetryReady = useCallback((fn: ((stepId: string) => void) | null) => {
    assistantRetryRef.current = fn;
  }, []);

  const handleRequestIdChange = useCallback((id: string | null) => {
    assistantRequestIdRef.current = id;
  }, []);

  const handleRegenComponent = useCallback((componentId: string, label: string) => {
    const taskId = assistantRequestIdRef.current || gen.requestId;
    if (!taskId) return;
    setRegenRequest({ componentId, label, taskId });
  }, [gen.requestId]);

  const handleRegenRequestHandled = useCallback(() => {
    setRegenRequest(null);
  }, []);

  const handleInsertComponent = useCallback((componentId: string, imageB64: string) => {
    canvasBackupRef.current = editorRef.current?.getXml() || null;
    editorRef.current?.replaceComponentImage(componentId, imageB64);
  }, []);

  // Canvas right-click → "添加到我的素材"
  const handleSaveToAssets = useCallback((data: SaveToAssetsPayload) => {
    const defaultName = data.labels.filter(Boolean).join("_") || t("draw.canvasElement");
    setSaveAssetDialog({ pngBase64: data.pngBase64, defaultName });
  }, [t]);

  const handleSaveAssetConfirm = useCallback(async (name: string) => {
    if (!saveAssetDialog) return;
    setSaveAssetBusy(true);
    try {
      const byteString = atob(saveAssetDialog.pngBase64);
      const ab = new Uint8Array(byteString.length);
      for (let i = 0; i < byteString.length; i++) ab[i] = byteString.charCodeAt(i);
      const blob = new Blob([ab], { type: "image/png" });
      const file = new File([blob], `${name}.png`, { type: "image/png" });
      await userEls.upload(file, name);
      setSaveAssetDialog(null);
    } catch (e) {
      console.error("Failed to save canvas element:", e);
    } finally {
      setSaveAssetBusy(false);
    }
  }, [saveAssetDialog, userEls]);

  // Canvas right-click → "AI 重新生成"
  const handleRegenFromCanvas = useCallback((data: RegenFromCanvasPayload) => {
    // Always provide a task_id: reuse existing pipeline task or create a new one
    // so that even context-free canvas elements have a traceable regen session.
    const existingTaskId = assistantRequestIdRef.current || gen.requestId;
    const taskId = existingTaskId || Math.random().toString(36).slice(2, 8) + Date.now().toString(36);
    setCanvasRegenRequest({
      cells: data.cells,
      pngBase64: data.pngBase64,
      count: data.count,
      taskId,
    });
    if (panelCollapsed) setPanelCollapsed(false);
  }, [gen.requestId, panelCollapsed]);

  const handleCanvasRegenHandled = useCallback(() => {
    setCanvasRegenRequest(null);
  }, []);

  const handleCanvasPersist = useCallback((data: string) => {
    latestCanvasDataRef.current = data;
    if (suppressDirtyRef.current) {
      suppressDirtyRef.current = false;
      return;
    }
    setSaveStatus((prev) => (prev === "saving" ? prev : "dirty"));
  }, []);

  const getCurrentCanvasData = useCallback(async (): Promise<string | null> => {
    const xml = editorRef.current?.getXml?.();
    if (typeof xml === "string" && xml.trim()) return xml;
    return latestCanvasDataRef.current;
  }, []);

  const getThumbnailB64 = useCallback(async (): Promise<string | undefined> => {
    if (!editorRef.current) return undefined;
    return new Promise((resolve) => {
      let done = false;
      const finish = (value?: string) => {
        if (done) return;
        done = true;
        resolve(value);
      };
      editorRef.current?.exportPngData((dataUrl) => {
        if (!dataUrl || !dataUrl.startsWith("data:image/png;base64,")) {
          finish(undefined);
          return;
        }
        finish(dataUrl.slice("data:image/png;base64,".length));
      });
      setTimeout(() => finish(undefined), 5000);
    });
  }, []);

  const doCloudSave = useCallback(async (opts?: { projectId?: string; includeThumbnail?: boolean }) => {
    const pid = opts?.projectId ?? projectIdRef.current;
    if (!pid) return false;
    const data = await getCurrentCanvasData();
    if (!data) {
      setSaveStatus("error");
      return false;
    }
    latestCanvasDataRef.current = data;
    setSaveStatus("saving");
    try {
      const thumbnailB64 = opts?.includeThumbnail ? await getThumbnailB64() : undefined;
      await saveCanvas(pid, data, thumbnailB64);
      setSaveStatus("saved");
      return true;
    } catch {
      setSaveStatus("error");
      return false;
    }
  }, [getCurrentCanvasData, getThumbnailB64]);

  const handleManualSave = useCallback(async () => {
    if (!projectIdRef.current) {
      setShowSaveDialog(true);
      return;
    }
    await doCloudSave({ includeThumbnail: true });
  }, [doCloudSave]);

  const handleCreateAndSave = useCallback(async (name: string) => {
    try {
      setSaveStatus("saving");
      const { id } = await createProject(name, CANVAS_TYPE);
      projectIdRef.current = id;
      const ok = await doCloudSave({ projectId: id, includeThumbnail: true });
      setCloudProjectName(name);
      serverNameRef.current = name;
      setShowSaveDialog(false);
      if (!ok) setSaveStatus("error");
      const params = new URLSearchParams(window.location.search);
      params.set("project", id);
      navigate(`/draw?${params.toString()}`, { replace: true });
    } catch {
      setSaveStatus("error");
    }
  }, [doCloudSave, navigate]);

  const handleRenameProject = useCallback(async (newName: string) => {
    const pid = projectIdRef.current;
    if (!pid || newName === serverNameRef.current) return;
    try {
      await updateProject(pid, { name: newName });
      setCloudProjectName(newName);
      serverNameRef.current = newName;
    } catch {
      // silent
    }
  }, []);

  // Load cloud project on mount
  useEffect(() => {
    if (!projectId) {
      setCloudProjectName(null);
      setSaveStatus(latestCanvasDataRef.current ? "dirty" : "idle");
      return;
    }
    (async () => {
      try {
        const proj = await getProject(projectId);
        setCloudProjectName(proj.name);
        serverNameRef.current = proj.name;
        const hasCanvas = !!proj.drawio_url;
        if (hasCanvas) {
          try {
            let data = await getCanvasData(projectId);
            if (data) {
              if (data.includes("nanadraw://img/")) {
                data = await restoreImages(data, projectId);
              }
              latestCanvasDataRef.current = data;
              suppressDirtyRef.current = true;
              if (suppressDirtyTimerRef.current) clearTimeout(suppressDirtyTimerRef.current);
              suppressDirtyTimerRef.current = setTimeout(() => { suppressDirtyRef.current = false; }, 3000);
              if (editorRef.current) {
                editorRef.current.loadXml(data);
              } else {
                pendingCloudDataRef.current = data;
              }
            }
          } catch {
            console.error("Failed to load canvas data from backend proxy");
          }
        }
        setSaveStatus("saved");
      } catch (e: unknown) {
        const status = (e as { status?: number }).status;
        if (status === 404) {
          const params = new URLSearchParams(window.location.search);
          params.delete("project");
          const qs = params.toString();
          navigate(qs ? `/draw?${qs}` : "/draw", { replace: true });
          setCloudProjectName(null);
          setSaveStatus("idle");
        } else {
          console.error("Failed to load project:", e);
        }
      }
    })();
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Periodic auto-save every 30 seconds
  useEffect(() => {
    autoSaveTimerRef.current = setInterval(() => {
      if (
        projectIdRef.current
        && (saveStatus === "dirty" || saveStatus === "error")
        && latestCanvasDataRef.current
      ) {
        doCloudSave();
      }
    }, AUTO_SAVE_INTERVAL);
    return () => {
      if (autoSaveTimerRef.current) clearInterval(autoSaveTimerRef.current);
    };
  }, [doCloudSave, saveStatus]);

  useEffect(() => {
    const timer = setInterval(() => {
      const data = pendingCloudDataRef.current;
      if (!data || !editorRef.current) return;
      pendingCloudDataRef.current = null;
      suppressDirtyRef.current = true;
      if (suppressDirtyTimerRef.current) clearTimeout(suppressDirtyTimerRef.current);
      suppressDirtyTimerRef.current = setTimeout(() => { suppressDirtyRef.current = false; }, 3000);
      editorRef.current.loadXml(data);
      clearInterval(timer);
    }, 200);
    return () => clearInterval(timer);
  }, []);

  // Keyboard shortcut: Ctrl/Cmd + S
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        handleManualSave();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleManualSave]);

  const displaySteps = useMemo(() => {
    if (assistantSteps.length > 0) return assistantSteps;
    if (gen.steps.length > 0) return gen.steps;
    const keys = MODE_DEFAULT_STEP_KEYS[mode] ?? MODE_DEFAULT_STEP_KEYS.auto;
    return keys.map(({ id, nameKey }) => ({ id, name: t(nameKey), status: "pending" as const }));
  }, [gen.steps, assistantSteps, mode, t]);

  const refreshModels = useCallback(() => {
    fetchModelDefaults()
      .then((m) => {
        setImageModel(m.imageModel);
        setComponentGenModel(m.componentGenModel);
        setTextModel(m.textModel);
      })
      .catch(() => { /* defaults already in fetchModelDefaults */ });
  }, []);

  useEffect(() => {
    refreshModels();
  }, [refreshModels]);

  // ── Resize handlers ──

  const showResizeOverlay = useCallback(() => {
    if (!overlayRef.current) {
      const el = document.createElement("div");
      el.style.cssText = "position:fixed;inset:0;z-index:9999;cursor:inherit;";
      document.body.appendChild(el);
      overlayRef.current = el;
    }
  }, []);
  const hideResizeOverlay = useCallback(() => {
    if (overlayRef.current) {
      overlayRef.current.remove();
      overlayRef.current = null;
    }
  }, []);

  const handlePanelMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    panelResizing.current = true;
    livePanelW.current = panelRef.current?.offsetWidth ?? DEFAULT_PANEL_W;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    showResizeOverlay();
  }, [showResizeOverlay]);

  const handleBottomMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    bottomResizing.current = true;
    liveBottomH.current = bottomRef.current?.offsetHeight ?? DEFAULT_BOTTOM_H;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    showResizeOverlay();
  }, [showResizeOverlay]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (panelResizing.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(() => {
          const newW = Math.min(Math.max(window.innerWidth - e.clientX, MIN_PANEL_W), MAX_PANEL_W);
          livePanelW.current = newW;
          if (panelRef.current) panelRef.current.style.width = `${newW}px`;
        });
      }
      if (bottomResizing.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(() => {
          const newH = Math.min(Math.max(window.innerHeight - e.clientY, 120), window.innerHeight - 200);
          liveBottomH.current = newH;
          if (bottomRef.current) bottomRef.current.style.height = `${newH}px`;
          if (mainAreaRef.current) mainAreaRef.current.style.height = `calc(100% - ${newH}px)`;
        });
      }
    };
    const handleMouseUp = () => {
      if (panelResizing.current) {
        panelResizing.current = false;
        setPanelWidth(livePanelW.current);
      }
      if (bottomResizing.current) {
        bottomResizing.current = false;
        setBottomHeight(liveBottomH.current);
      }
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      hideResizeOverlay();
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [hideResizeOverlay]);

  // ── Stable callbacks (avoid inline arrow functions in JSX) ──

  const handleQueueInfo = useCallback((pos: number | null, total: number | null) => {
    setAssistantQueue({ position: pos, total });
  }, []);

  const handleTogglePanel = useCallback(() => {
    setPanelCollapsed((c) => !c);
  }, []);

  // ── Generate handler ──
  const prevXmlRef = useRef<string | null>(null);
  const prevImageRef = useRef<string | null>(null);

  const handleGenerate = useCallback((textOverride?: string, sketchImage?: string) => {
    const actualText = textOverride || text;
    if (!actualText.trim()) return;
    const hasRef = !!selectedStyleId;
    const LEGACY_SCHEMES = ["pastel", "vibrant", "monochrome"] as const;
    const colorScheme = LEGACY_SCHEMES.includes(styleSpec.color_preset as typeof LEGACY_SCHEMES[number])
      ? (styleSpec.color_preset as "pastel" | "vibrant" | "monochrome")
      : "pastel";

    const isImageOnly = mode === "image_only";
    const needsFullGen = isImageOnly || mode === "auto";
    const backendMode = (needsFullGen ? "full_gen" : mode) as "fast" | "full_gen";

    const hasStyleFields = !!(styleSpec.visual_style || styleSpec.color_preset
      || styleSpec.font_scheme || styleSpec.topology || styleSpec.layout_direction
      || styleSpec.description);
    const effectiveStyleSpec = hasRef || !hasStyleFields ? undefined : styleSpec;

    const request: GenerateRequest = {
      text: actualText,
      mode: backendMode,
      style_ref_id: hasRef ? (selectedStyleId ?? undefined) : undefined,
      style_spec: effectiveStyleSpec,
      options: {
        color_scheme: colorScheme,
        image_model: imageModel || undefined,
        component_image_model: componentGenModel || undefined,
        image_only: isImageOnly || undefined,
        canvas_type: CANVAS_TYPE,
      },
      sketch_image_b64: sketchImage || undefined,
    };
    prevXmlRef.current = null;
    prevImageRef.current = null;
    gen.generate(request);
  }, [text, mode, selectedStyleId, styleSpec, imageModel, componentGenModel, gen]);

  // Load result XML into editor as a new page
  useEffect(() => {
    if (!gen.resultXml || gen.resultXml === prevXmlRef.current) return;
    prevXmlRef.current = gen.resultXml;
    const xmlToLoad = gen.resultXml;
    const pageName = extractPageName(gen.steps);
    const timer = setTimeout(() => {
      try {
        editorRef.current?.addPage(xmlToLoad, pageName);
      } catch (e) {
        console.error("[NanaDraw] Failed to load XML:", e);
      }
    }, 800);
    return () => clearTimeout(timer);
  }, [gen.resultXml]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load result image (image_only mode) into editor as a new page
  useEffect(() => {
    if (!gen.resultImage || gen.resultImage === prevImageRef.current) return;
    prevImageRef.current = gen.resultImage;
    const imageToLoad = gen.resultImage;
    const pageName = extractPageName(gen.steps);
    const timer = setTimeout(() => {
      try {
        const xml = buildImagePageXml(imageToLoad);
        editorRef.current?.addPage(xml, pageName);
      } catch (e) {
        console.error("[NanaDraw] Failed to load image:", e);
      }
    }, 800);
    return () => clearTimeout(timer);
  }, [gen.resultImage]); // eslint-disable-line react-hooks/exhaustive-deps

  const isActive = gen.isGenerating || assistantSteps.some((s) => s.status === "running");
  const canViewPrompts = true;

  // Prevent accidental close during generation
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (gen.isGenerating) e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [gen.isGenerating]);

  const modeBadgeClass =
    mode === "fast" ? "bg-amber-100/80 text-amber-700"
    : mode === "full_gen" ? "bg-orange-100/80 text-orange-700"
    : mode === "image_only" ? "bg-rose-100/80 text-rose-700"
    : "bg-stone-100 text-stone-500";

  const handleSaveAsset = useCallback(
    async (imageB64: string, name: string) => {
      try {
        const byteString = atob(imageB64);
        const ab = new Uint8Array(byteString.length);
        for (let i = 0; i < byteString.length; i++) ab[i] = byteString.charCodeAt(i);
        const blob = new Blob([ab], { type: "image/png" });
        const file = new File([blob], `${name}.png`, { type: "image/png" });
        await userEls.upload(file, name);
        return true;
      } catch {
        return false;
      }
    },
    [userEls],
  );

  const handleBioPointerDown = useCallback((e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    bioDrag.current = { startX: e.clientX, startY: e.clientY, origLeft: bioBtnPos.left, origTop: bioBtnPos.top, moved: false };
  }, [bioBtnPos]);

  const handleBioPointerMove = useCallback((e: React.PointerEvent) => {
    if (!bioDrag.current) return;
    const dx = e.clientX - bioDrag.current.startX;
    const dy = e.clientY - bioDrag.current.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) bioDrag.current.moved = true;
    if (!bioDrag.current.moved) return;
    setBioBtnPos({
      left: Math.max(4, bioDrag.current.origLeft + dx),
      top: Math.max(4, bioDrag.current.origTop + dy),
    });
  }, []);

  const handleBioPointerUp = useCallback(() => {
    const wasDrag = bioDrag.current?.moved;
    bioDrag.current = null;
    if (!wasDrag) setBioiconsOpen((v) => !v);
  }, []);

  return (
    <div className="flex h-screen flex-col">
      {/* Header */}
      <header className="relative z-20 flex items-center justify-between border-b border-amber-100/40 bg-white/70 px-6 py-2.5 backdrop-blur-xl">
        <div className="flex min-w-0 flex-1 items-center gap-4">
          <a href={import.meta.env.BASE_URL} className="relative z-10 flex shrink-0 items-center gap-2">
            <img src={`${import.meta.env.BASE_URL}logo.jpg`} alt="NanaDraw" className="h-9 w-9 rounded-xl object-contain shadow-sm" />
            <span className="bg-gradient-to-r from-amber-500 to-orange-500 bg-clip-text font-headline text-lg font-extrabold tracking-tight text-transparent">NanaDraw</span>
          </a>
          <div className="flex h-8 w-[220px] max-w-[28vw] min-w-0 items-center gap-2.5 border-l border-amber-200/30 pl-4">
            {projectId ? (
              <>
                <button
                  type="button"
                  onClick={() => navigate("/projects")}
                  className="shrink-0 rounded-full bg-amber-50/80 px-3 py-1 text-[13px] font-medium text-amber-700 transition-all hover:bg-amber-100 active:scale-95"
                >
                  {t("draw.back")}
                </button>
                <input
                  type="text"
                  value={cloudProjectName || ""}
                  onChange={(e) => setCloudProjectName(e.target.value)}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v) handleRenameProject(v);
                  }}
                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                  className="min-w-0 flex-1 truncate border-b border-transparent bg-transparent px-1 text-[13px] font-medium text-stone-700 outline-none transition hover:border-amber-200 focus:border-amber-400"
                  title={t("draw.clickToEdit")}
                />
              </>
            ) : (
              <>
                <span className="inline-block w-[38px] shrink-0" />
                <span className="min-w-0 truncate text-[13px] text-stone-400">{t("draw.unsavedCanvas")}</span>
              </>
            )}
            <div className="flex w-[80px] shrink-0 items-center justify-end gap-1.5">
              {saveStatus === "saving" && (
                <span className="flex items-center gap-1.5 text-[13px] text-stone-400">
                  <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-400" />
                  {t("draw.saving")}
                </span>
              )}
              {saveStatus === "saved" && (
                <span className="flex items-center gap-1.5 text-[13px] font-medium text-amber-600">
                  <span className="inline-block h-2 w-2 rounded-full bg-amber-500" />
                  {t("draw.saved")}
                </span>
              )}
              {saveStatus === "error" && (
                <span className="flex items-center gap-1.5 text-[13px] text-red-500">
                  <span className="inline-block h-2 w-2 rounded-full bg-red-400" />
                  {t("draw.saveFailed")}
                </span>
              )}
              {saveStatus === "dirty" && (
                <span className="flex items-center gap-1.5 text-[13px] text-stone-400">
                  <span className="inline-block h-2 w-2 rounded-full bg-stone-300" />
                  {t("draw.unsaved")}
                </span>
              )}
            </div>
          </div>
          <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${modeBadgeClass}`}>
            {t(MODE_LABEL_KEYS[mode])}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={handleManualSave}
            disabled={saveStatus === "saving"}
            className={clsx(
              "flex items-center gap-2 rounded-full px-4 py-2 text-[13px] font-semibold transition-all active:scale-95",
              projectId
                ? "bg-white text-stone-600 shadow-[0_2px_8px_rgba(0,0,0,0.08)] hover:shadow-[0_4px_12px_rgba(0,0,0,0.12)]"
                : "bg-gradient-to-r from-amber-400 to-orange-400 text-white shadow-[0_2px_10px_rgba(245,158,11,0.35)] hover:shadow-[0_4px_14px_rgba(245,158,11,0.45)]",
              saveStatus === "saving" && "cursor-not-allowed opacity-60",
            )}
            title={projectId ? t("draw.saveToCloud") : t("draw.saveAsNew")}
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
            </svg>
            {projectId ? t("draw.save") : t("draw.saveProject")}
          </button>
          {/* Reload / Download XML buttons removed — users export via ExportPanel */}
          <ExportPanel
            onExportSvg={() => { editorRef.current?.exportSvg(); }}
            onExportPng={() => { editorRef.current?.exportPng(); }}
            onExportPptx={() => {
              const xml = editorRef.current?.getCurrentPageXml();
              if (xml) exportDrawioToPptx(xml);
            }}
          />
          <button
            onClick={() => setShowSettings(true)}
            className="flex items-center gap-1.5 rounded-full bg-white px-3.5 py-2 text-[13px] font-semibold text-stone-500 shadow-[0_2px_8px_rgba(0,0,0,0.08)] transition-all hover:shadow-[0_4px_12px_rgba(0,0,0,0.12)] hover:text-stone-700 active:scale-95"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.573-1.066z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            {t("settings.title")}
          </button>
          <LanguageSwitcher />
          <UserButton />
        </div>
      </header>
      <SettingsPanel open={showSettings} onClose={() => { setShowSettings(false); refreshModels(); }} />

      {/* Main area: canvas + right ChatPanel */}
      <div
        ref={mainAreaRef}
        className="flex flex-1 overflow-hidden"
        style={{ height: !bottomCollapsed ? `calc(100% - ${bottomHeight}px)` : undefined }}
      >
        {/* Canvas */}
        <main className="relative isolate flex-1">
          <DiagramEditor
            ref={editorRef}
            onSaveToAssets={handleSaveToAssets}
            onRegenFromCanvas={handleRegenFromCanvas}
            onPersistCanvas={handleCanvasPersist}
          />
        </main>

        {/* Panel resize handle */}
        {!panelCollapsed && (
          <div
            onMouseDown={handlePanelMouseDown}
            className="flex w-1 flex-shrink-0 cursor-col-resize items-center justify-center bg-surface-container/30 transition-colors hover:bg-primary-container/40 active:bg-primary-container/60"
          >
            <div className="h-8 w-0.5 rounded-full bg-outline-variant/20" />
          </div>
        )}

        {/* Right ChatPanel */}
        <div
          ref={panelRef}
          className="relative flex-shrink-0"
          style={{ width: panelCollapsed ? 44 : panelWidth }}
        >
          <ChatPanel
            mode={mode}
            onModeChange={setMode}
            imageModel={imageModel}
            textModel={textModel}
            componentGenModel={componentGenModel}
            galleryItems={gallery.items}
            galleryLoading={gallery.loading}
            selectedStyleId={selectedStyleId}
            onSelectStyleRef={setSelectedStyleId}
            onResultXml={handleAssistantResultXml}
            onResultImage={handleAssistantResultImage}
            onPipelineSteps={handleAssistantPipelineSteps}
            onReferenceImage={handleAssistantRefImage}
            onRetryStepReady={handleAssistantRetryReady}
            onSaveAsset={handleSaveAsset}
            text={text}
            onTextChange={setText}
            onGenerate={handleGenerate}
            onCancel={gen.cancel}
            isGenerating={gen.isGenerating}
            genError={gen.error}
            genPipelineSteps={gen.steps}
            onQueueInfo={handleQueueInfo}
            collapsed={panelCollapsed}
            onToggleCollapse={handleTogglePanel}
            regenRequest={regenRequest}
            onRegenRequestHandled={handleRegenRequestHandled}
            canvasRegenRequest={canvasRegenRequest}
            onCanvasRegenHandled={handleCanvasRegenHandled}
            onInsertComponent={handleInsertComponent}
            onRequestIdChange={handleRequestIdChange}
            editorRef={editorRef}
            onCanvasUpdate={handleCanvasUpdate}
          />
        </div>
      </div>

      {/* Bioicons floating trigger — draggable, fixed over iframe */}
      <button
        onPointerDown={handleBioPointerDown}
        onPointerMove={handleBioPointerMove}
        onPointerUp={handleBioPointerUp}
        className={clsx(
          "fixed z-50 flex items-center gap-1.5 rounded-full px-3.5 py-2 text-[13px] font-bold select-none touch-none",
          !bioDrag.current && "transition-all duration-200 hover:scale-[1.03]",
          bioiconsOpen
            ? "bg-gradient-to-r from-amber-500 via-orange-500 to-rose-400 text-white shadow-[0_4px_16px_rgba(245,158,11,0.4)] ring-2 ring-white/30"
            : "bg-gradient-to-r from-amber-400 via-orange-400 to-rose-300 text-white shadow-[0_4px_16px_rgba(245,158,11,0.3)] hover:shadow-[0_6px_20px_rgba(245,158,11,0.45)]",
        )}
        style={{ left: bioBtnPos.left, top: bioBtnPos.top }}
        aria-label={t("draw.assetWorkshop")}
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
        </svg>
        {t("draw.assetWorkshop")}
      </button>

      {/* Bioicons overlay drawer */}
      {bioiconsOpen && (
        <div className="fixed inset-0 z-40 flex">
          <div className="h-full w-[380px] flex-shrink-0 shadow-2xl">
            <BioiconsDrawer
              editorRef={editorRef}
              onClose={() => setBioiconsOpen(false)}
              userElements={userEls}
              imageModel={imageModel}
            />
          </div>
          <div
            className="flex-1 bg-black/10 backdrop-blur-[1px]"
            onClick={() => setBioiconsOpen(false)}
          />
        </div>
      )}

      {/* Bottom resize handle */}
      {!bottomCollapsed && (
        <div
          onMouseDown={handleBottomMouseDown}
          className="flex h-1 cursor-row-resize items-center justify-center transition-colors hover:bg-primary-container/40 active:bg-primary-container/60"
        >
          <div className="h-0.5 w-8 rounded-full bg-outline-variant/20" />
        </div>
      )}

      {/* Bottom Panel */}
      <div ref={bottomRef} style={{ height: bottomCollapsed ? MIN_BOTTOM_H : bottomHeight, flexShrink: 0 }}>
        <BottomPanel
          steps={displaySteps}
          selectedStepId={gen.selectedStepId}
          onSelectStep={gen.selectStep}
          onRetryStep={assistantSteps.length > 0 ? (id) => assistantRetryRef.current?.(id) : gen.retryStep}
          referenceImage={assistantRefImage ?? gen.referenceImage}
          isGenerating={isActive}
          collapsed={bottomCollapsed}
          onToggleCollapse={() => setBottomCollapsed((c) => !c)}
          onLoadXmlToCanvas={(xml) => { editorRef.current?.loadXml(xml); }}
          resultXml={gen.resultXml}
          onElementSaved={userEls.refresh}
          queuePosition={gen.queuePosition ?? assistantQueue.position}
          queueTotal={gen.queueTotal ?? assistantQueue.total}
          onRegenComponent={handleRegenComponent}
          canViewPrompts={canViewPrompts}
        />
      </div>

      {/* Save canvas element to assets dialog */}
      {saveAssetDialog && (
        <SaveElementDialog
          previewUrl={`data:image/png;base64,${saveAssetDialog.pngBase64}`}
          existingNames={userEls.elements.map((e) => e.display_name)}
          saving={saveAssetBusy}
          onConfirm={handleSaveAssetConfirm}
          onCancel={() => setSaveAssetDialog(null)}
          defaultName={saveAssetDialog.defaultName}
        />
      )}

      {/* Save as new project dialog */}
      {showSaveDialog && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/20 backdrop-blur-[2px]"
          onClick={(e) => { if (e.target === e.currentTarget) setShowSaveDialog(false); }}
          onKeyDown={(e) => { if (e.key === "Escape") setShowSaveDialog(false); }}
        >
          <div className="w-96 rounded-2xl bg-surface-container-lowest p-6 shadow-glass">
            <h3 className="mb-4 text-base font-semibold text-gray-900">{t("draw.saveAsNewProject")}</h3>
            <input
              type="text"
              value={saveDialogName}
              onChange={(e) => setSaveDialogName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && saveDialogName.trim()) handleCreateAndSave(saveDialogName.trim());
              }}
              placeholder={t("draw.enterProjectName")}
              className="mb-4 w-full rounded-full border border-outline-variant/10 bg-surface-container-lowest px-4 py-2.5 text-sm outline-none transition focus:border-primary/30 focus:ring-2 focus:ring-primary-container/40"
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowSaveDialog(false)}
                className="rounded-full border border-outline-variant/10 px-4 py-2 text-sm font-bold text-on-surface-variant transition-all hover:bg-surface-container active:scale-95"
              >
                {t("draw.cancel")}
              </button>
              <button
                onClick={() => saveDialogName.trim() && handleCreateAndSave(saveDialogName.trim())}
                disabled={!saveDialogName.trim() || saveStatus === "saving"}
                className="rounded-full bg-primary px-5 py-2 text-sm font-bold text-on-primary transition-all hover:opacity-90 active:scale-95 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {saveStatus === "saving" ? t("draw.savingEllipsis") : t("draw.save")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
