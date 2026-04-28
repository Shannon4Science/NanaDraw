import { useCallback, useRef, useState } from "react";
import { assistantChat, cancelPipeline, generateDiagram, type AssistantAssetResult } from "../services/api";
import { useT } from "../contexts/LanguageContext";
import type { TranslationKey } from "../i18n/zh";
import type { PipelineStep, StepStatus } from "./useGenerate";
import type { AssistantMode } from "../types/paper";

const STEP_ID_KEYS: Record<string, TranslationKey> = {
  mode_selection: "pipeStep.mode_selection",
  planning: "pipeStep.planning",
  xml_generation: "pipeStep.xml_generation",
  image_generation: "pipeStep.image_generation",
  blueprint_extraction: "pipeStep.blueprint_extraction",
  component_generation: "pipeStep.component_generation",
  assembly_refine: "pipeStep.assembly_refine",
  result_image: "pipeStep.result_image",
  content_planning: "pipeStep.content_planning",
  template_generation: "pipeStep.template_generation",
  visual_spec_extraction: "pipeStep.visual_spec_extraction",
  asset_generation: "pipeStep.asset_generation",
  slides_assembly: "pipeStep.slides_assembly",
};

export type ChatRole = "user" | "assistant" | "tool_call" | "tool_result" | "asset_results" | "regen_results" | "regen_loading";

export interface AssetResultItem {
  description: string;
  image_b64: string;
}

export interface RegenResultItem {
  image_b64: string;
  description: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  done?: boolean;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  assetImages?: AssetResultItem[];
  regenImages?: RegenResultItem[];
  regenComponentId?: string;
  sketchImage?: string;
  attachedFile?: { name: string; type: string };
  taskId?: string;
}

export interface RegenContext {
  task_id: string;
  component_id: string;
  component_label: string;
  visual_repr?: string;
  component_image_svg?: string;
  component_image_b64?: string;
  batch_components?: Array<{
    component_id: string;
    component_label: string;
  }>;
}

interface AssistantState {
  messages: ChatMessage[];
  isLoading: boolean;
  pipelineSteps: PipelineStep[];
  resultXml: string | null;
  resultImage: string | null;
  referenceImage: string | null;
  canvasUpdateXml: string | null;
  canvasUpdateSummary: string | null;
  requestId: string | null;
  originalMode: string | null;
  queuePosition: number | null;
  queueTotal: number | null;
  pendingSketch: string | null;
  activeRegenContext: RegenContext | null;
}

const INITIAL: AssistantState = {
  messages: [],
  isLoading: false,
  pipelineSteps: [],
  resultXml: null,
  resultImage: null,
  referenceImage: null,
  canvasUpdateXml: null,
  canvasUpdateSummary: null,
  requestId: null,
  originalMode: null,
  queuePosition: null,
  queueTotal: null,
  pendingSketch: null,
  activeRegenContext: null,
};

let msgIdCounter = 0;
function nextId(): string {
  return `msg-${++msgIdCounter}`;
}

function makePipelineCallbacks(
  setState: React.Dispatch<React.SetStateAction<AssistantState>>,
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string,
) {
  return {
    onQueuePosition: ({ position, total }: { position: number; total: number }) => {
      setState((prev) => ({ ...prev, queuePosition: position, queueTotal: total }));
    },
    onPipelineInfo: ({ steps, request_id, mode }: { steps: { id: string; name: string }[]; request_id?: string; mode?: string }) => {
      const pipelineSteps: PipelineStep[] = steps.map((s) => ({
        id: s.id,
        name: STEP_ID_KEYS[s.id] ? t(STEP_ID_KEYS[s.id]) : s.name,
        status: "pending" as StepStatus,
      }));
      setState((prev) => ({
        ...prev,
        pipelineSteps,
        requestId: request_id ?? prev.requestId,
        originalMode: mode ?? prev.originalMode,
        queuePosition: null,
        queueTotal: null,
        pendingSketch: null,
      }));
    },
    onStepStart: ({ step_id }: { step_id: string }) => {
      setState((prev) => ({
        ...prev,
        pipelineSteps: prev.pipelineSteps.map((s) =>
          s.id === step_id ? { ...s, status: "running" as StepStatus, startedAt: Date.now() } : s,
        ),
      }));
    },
    onStepComplete: (data: { step_id: string; elapsed_ms: number; artifact_type: string; artifact: unknown; prompts?: PipelineStep["prompts"] }) => {
      setState((prev) => {
        let steps = prev.pipelineSteps.map((s) =>
          s.id === data.step_id
            ? {
                ...s,
                status: "completed" as StepStatus,
                elapsedMs: data.elapsed_ms,
                artifactType: data.artifact_type,
                artifact: data.artifact,
                prompts: data.prompts,
              }
            : s,
        );
        const completedIdx = steps.findIndex((s) => s.id === data.step_id);
        if (completedIdx >= 0 && completedIdx < steps.length - 1) {
          const next = steps[completedIdx + 1];
          if (next.status === "pending") {
            steps = steps.map((s, i) =>
              i === completedIdx + 1 ? { ...s, status: "running" as StepStatus, startedAt: Date.now() } : s,
            );
          }
        }
        return { ...prev, pipelineSteps: steps };
      });
    },
    onStepError: (data: { step_id: string; error: string }) => {
      setState((prev) => ({
        ...prev,
        pipelineSteps: prev.pipelineSteps.map((s) =>
          s.id === data.step_id
            ? { ...s, status: "error" as StepStatus, error: data.error }
            : s,
        ),
      }));
    },
    onStepProgress: (data: Record<string, unknown>) => {
      const stepId = data.step_id as string;
      const elementId = data.element_id as string | undefined;
      setState((prev) => ({
        ...prev,
        pipelineSteps: prev.pipelineSteps.map((s) => {
          if (s.id !== stepId) return s;
          if (elementId) {
            const existing = s.elementProgress ?? [];
            const idx = existing.findIndex((e) => e.element_id === elementId);
            const entry = { ...(idx >= 0 ? existing[idx] : {}), ...data } as PipelineStep["elementProgress"] extends (infer T)[] | undefined ? T : never;
            const updated = idx >= 0
              ? existing.map((e, i) => (i === idx ? entry : e))
              : [...existing, entry];
            return { ...s, elementProgress: updated };
          }
          return s;
        }),
      }));
    },
    onReferenceImage: (data: Record<string, unknown>) => {
      const img = data.image as string | undefined;
      if (img) setState((prev) => ({ ...prev, referenceImage: img }));
    },
    onSubProgress: (data: Record<string, unknown>) => {
      const stepId = data.step_id as string;
      const completed = data.completed as number;
      const total = data.total as number;
      setState((prev) => ({
        ...prev,
        pipelineSteps: prev.pipelineSteps.map((s) =>
          s.id === stepId
            ? {
                ...s,
                artifact: { ...(s.artifact as Record<string, unknown> || {}), completed, total },
              }
            : s,
        ),
      }));
    },
    onResult: (data: Record<string, unknown>) => {
      const xml = data.xml as string | undefined;
      const image = data.image as string | undefined;
      setState((prev) => ({
        ...prev,
        resultXml: xml ?? prev.resultXml,
        resultImage: image ?? prev.resultImage,
      }));
    },
    onError: (data: Record<string, unknown>) => {
      const msg = data.message as string;
      setState((prev) => ({
        ...prev,
        queuePosition: null,
        queueTotal: null,
        pipelineSteps: prev.pipelineSteps.map((s) =>
          s.status === "running" ? { ...s, status: "error" as StepStatus, error: msg || t("assistant.requestFailed") } : s,
        ),
      }));
    },
    onClose: () => {
      setState((prev) => ({
        ...prev,
        queuePosition: null,
        queueTotal: null,
        pipelineSteps: prev.pipelineSteps.map((s) =>
          s.status === "running"
            ? { ...s, status: "error" as StepStatus, error: t("assistant.networkError") }
            : s,
        ),
      }));
    },
  };
}

function generateSessionId(): string {
  return `ses-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function useAssistant(canvasType?: string) {
  const t = useT();
  const [state, setState] = useState<AssistantState>(INITIAL);
  const abortRef = useRef<AbortController | null>(null);
  const lastGenTextRef = useRef("");
  const sessionIdRef = useRef(generateSessionId());

  const sendMessage = useCallback(async (text: string, options?: { selectedMode?: AssistantMode; styleRefId?: string | null; sketchImage?: string | null; textModel?: string; imageModel?: string; componentImageModel?: string; regenContext?: RegenContext; attachedFile?: { name: string; type: string; content: string } | null; canvasSkeleton?: string | null; canvasSkeletonFull?: string | null; canvasImages?: Record<string, string> | null }) => {
    const assistantMsgId = nextId();

    const MAX_HISTORY = 20;
    const history = state.messages
      .filter((m) => m.role === "user" || (m.role === "assistant" && m.done))
      .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }))
      .slice(-MAX_HISTORY);

    const effectiveSketch = options?.sketchImage ?? state.pendingSketch;
    const effectiveFile = options?.attachedFile ?? null;
    const userMsg: ChatMessage = {
      id: nextId(), role: "user", content: text,
      ...(effectiveSketch ? { sketchImage: effectiveSketch } : {}),
      ...(effectiveFile ? { attachedFile: { name: effectiveFile.name, type: effectiveFile.type } } : {}),
    };

    // Persist regenContext: use explicit option, fall back to active state
    const effectiveRegenContext = options?.regenContext ?? state.activeRegenContext;

    setState((prev) => ({
      ...prev,
      isLoading: true,
      queuePosition: null,
      queueTotal: null,
      pendingSketch: effectiveSketch ?? prev.pendingSketch,
      activeRegenContext: effectiveRegenContext ?? prev.activeRegenContext,
      messages: [
        ...prev.messages,
        userMsg,
        { id: assistantMsgId, role: "assistant", content: "", done: false },
      ],
    }));

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const selectedMode = options?.selectedMode;
    let assistantText = "";

    try {
      await assistantChat(
        text,
        history,
        {
          onAssistantMessage: ({ content, done }) => {
            assistantText = content;
            setState((prev) => ({
              ...prev,
              isLoading: !done,
              messages: prev.messages.map((m) =>
                m.id === assistantMsgId ? { ...m, content, done } : m,
              ),
            }));
          },

          onToolCall: ({ name, arguments: args }) => {
            if (name === "generate_diagram") {
              if (args.text) lastGenTextRef.current = args.text as string;
              setState((prev) => ({
                ...prev,
                pipelineSteps: [],
                resultXml: null,
                resultImage: null,
                referenceImage: null,
                originalMode: null,
                activeRegenContext: null,
              }));
            }
            const toolMsg: ChatMessage = {
              id: nextId(),
              role: "tool_call",
              content: toolCallLabel(name, args, t),
              toolName: name,
              toolArgs: args,
            };
            setState((prev) => {
              const msgs = [...prev.messages];
              const aIdx = msgs.findIndex((m) => m.id === assistantMsgId);
              if (aIdx >= 0) msgs.splice(aIdx, 0, toolMsg);
              else msgs.push(toolMsg);
              return { ...prev, messages: msgs };
            });
          },

          onToolResult: ({ name, summary }) => {
            const toolMsg: ChatMessage = {
              id: nextId(),
              role: "tool_result",
              content: summary,
              toolName: name,
            };
            setState((prev) => {
              const msgs = [...prev.messages];
              const aIdx = msgs.findIndex((m) => m.id === assistantMsgId);
              if (aIdx >= 0) msgs.splice(aIdx, 0, toolMsg);
              else msgs.push(toolMsg);
              return { ...prev, messages: msgs };
            });
          },

          onAssetStart: () => {
            setState((prev) => ({
              ...prev,
              queuePosition: null,
              queueTotal: null,
              pipelineSteps: [{ id: "asset_gen", name: t("assistant.stepAssetGen"), status: "running" as StepStatus, startedAt: Date.now() }],
            }));
          },

          onAssetResults: (data: AssistantAssetResult) => {
            setState((prev) => ({
              ...prev,
              pipelineSteps: prev.pipelineSteps.map((s) =>
                s.id === "asset_gen" ? { ...s, status: "completed" as StepStatus, elapsedMs: s.startedAt ? Date.now() - s.startedAt : undefined } : s,
              ),
            }));
            const assetMsg: ChatMessage = {
              id: nextId(),
              role: "asset_results",
              content: t("assistant.assetGenResult", { n: String(data.images.length) }),
              assetImages: data.images,
            };
            setState((prev) => {
              const msgs = [...prev.messages];
              const aIdx = msgs.findIndex((m) => m.id === assistantMsgId);
              if (aIdx >= 0) msgs.splice(aIdx, 0, assetMsg);
              else msgs.push(assetMsg);
              return { ...prev, messages: msgs };
            });
          },

          onRegenStart: () => {
            const loadingMsg: ChatMessage = {
              id: `regen-loading-${Date.now()}`,
              role: "regen_loading",
              content: t("assistant.regenLoading"),
            };
            setState((prev) => {
              const msgs = [...prev.messages];
              const aIdx = msgs.findIndex((m) => m.id === assistantMsgId);
              if (aIdx >= 0) msgs.splice(aIdx, 0, loadingMsg);
              else msgs.push(loadingMsg);
              return { ...prev, messages: msgs };
            });
          },

          onRegenProgress: (data) => {
            const d = data as { completed?: number; total?: number };
            setState((prev) => ({
              ...prev,
              messages: prev.messages.map((m) =>
                m.role === "regen_loading"
                  ? { ...m, content: t("assistant.regenProgress", { done: String(d.completed ?? "?"), total: String(d.total ?? "?") }) }
                  : m,
              ),
            }));
          },

          onRegenResults: (data) => {
            const regenMsg: ChatMessage = {
              id: nextId(),
              role: "regen_results",
              content: t("assistant.regenDone", { n: String(data.success) }),
              regenImages: data.images,
              regenComponentId: data.component_id,
            };
            setState((prev) => {
              // Remove the loading message and add results
              const msgs = prev.messages.filter((m) => m.role !== "regen_loading");
              const aIdx = msgs.findIndex((m) => m.id === assistantMsgId);
              if (aIdx >= 0) msgs.splice(aIdx, 0, regenMsg);
              else msgs.push(regenMsg);
              return { ...prev, messages: msgs, activeRegenContext: null };
            });
          },

          onRegenError: (data) => {
            setState((prev) => ({
              ...prev,
              activeRegenContext: null,
              messages: prev.messages.map((m) =>
                m.id === assistantMsgId
                  ? { ...m, content: data.message || t("assistant.regenFailed"), done: true }
                  : m,
              ),
            }));
          },

          ...makePipelineCallbacks(setState, t),

          onCanvasUpdate: ({ xml, summary }) => {
            setState((prev) => ({
              ...prev,
              canvasUpdateXml: xml,
              canvasUpdateSummary: summary,
            }));
          },

          onError: (data) => {
            const msg = (data as Record<string, unknown>).message as string;
            setState((prev) => ({
              ...prev,
              isLoading: false,
              queuePosition: null,
              queueTotal: null,
              messages: prev.messages.map((m) =>
                m.id === assistantMsgId
                  ? { ...m, content: msg || assistantText || t("assistant.errorOccurred"), done: true }
                  : m,
              ),
            }));
          },

          onClose: () => {
            setState((prev) => {
              const allCompleted = prev.pipelineSteps.length > 0 &&
                prev.pipelineSteps.every((s) => s.status === "completed");
              let updatedMessages = prev.messages;
              if (allCompleted && prev.requestId) {
                updatedMessages = prev.messages.map((m) =>
                  m.id === assistantMsgId ? { ...m, taskId: prev.requestId! } : m,
                );
              }
              return { ...prev, messages: updatedMessages, queuePosition: null, queueTotal: null };
            });
          },
        },
        controller.signal,
        selectedMode === "auto" ? "full_gen" : selectedMode,
        options?.styleRefId ?? undefined,
        sessionIdRef.current,
        effectiveSketch ?? undefined,
        options?.textModel,
        effectiveRegenContext ?? undefined,
        canvasType,
        options?.attachedFile ?? undefined,
        options?.imageModel,
        options?.canvasSkeleton ?? undefined,
        options?.canvasSkeletonFull ?? undefined,
        options?.canvasImages ?? undefined,
        options?.componentImageModel,
      );
      setState((prev) => ({
        ...prev,
        isLoading: false,
        messages: prev.messages.map((m) =>
          m.id === assistantMsgId && !m.done ? { ...m, done: true } : m,
        ),
      }));
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setState((prev) => ({
          ...prev,
          isLoading: false,
          messages: prev.messages.map((m) =>
            m.id === assistantMsgId && !m.done
              ? { ...m, content: assistantText || t("assistant.cancelled"), done: true }
              : m,
          ),
        }));
      } else {
        throw err;
      }
    }
  }, [state.messages, state.pendingSketch, state.activeRegenContext, canvasType, t]);

  const retryStep = useCallback(
    (stepId: string) => {
      if (!state.requestId) return;

      setState((prev) => ({
        ...prev,
        isLoading: true,
        pipelineSteps: prev.pipelineSteps.map((s, i, arr) => {
          const retryIdx = arr.findIndex((x) => x.id === stepId);
          return i >= retryIdx
            ? { ...s, status: "pending" as StepStatus, error: undefined, elementProgress: undefined }
            : s;
        }),
      }));

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const mode = state.originalMode === "fast" ? "fast" : "full_gen";
      const retryOptions: Record<string, unknown> = {};
      if (state.originalMode === "free") retryOptions.free = true;
      if (state.originalMode === "image_only") retryOptions.image_only = true;
      if (state.originalMode === "text_edit") retryOptions.text_edit = true;
      if (state.originalMode === "gpt_image") retryOptions.gpt_image = true;
      const baseCallbacks = makePipelineCallbacks(setState, t);

      generateDiagram(
        {
          text: lastGenTextRef.current || "(resume)",
          mode,
          request_id: state.requestId,
          resume_from: stepId,
          ...(Object.keys(retryOptions).length > 0 ? { options: retryOptions } : {}),
        },
        {
          ...baseCallbacks,
          onPipelineInfo: ({ steps, request_id, mode: m }: { steps: { id: string; name: string }[]; request_id?: string; mode?: string }) => {
            setState((prev) => {
              const existingMap = new Map(prev.pipelineSteps.map((s) => [s.id, s]));
              const merged: PipelineStep[] = steps.map((s) => {
                const existing = existingMap.get(s.id);
                if (existing && existing.status === "completed") return existing;
                return { id: s.id, name: STEP_ID_KEYS[s.id] ? t(STEP_ID_KEYS[s.id]) : s.name, status: "pending" as StepStatus };
              });
              return {
                ...prev,
                pipelineSteps: merged,
                requestId: request_id ?? prev.requestId,
                originalMode: m ?? prev.originalMode,
                queuePosition: null,
                queueTotal: null,
              };
            });
          },
          onClose: () => {
            baseCallbacks.onClose();
            setState((prev) => ({ ...prev, isLoading: false }));
          },
          onError: (data) => {
            baseCallbacks.onError(data);
            setState((prev) => ({ ...prev, isLoading: false }));
          },
        },
        controller.signal,
      ).catch(() => {
        setState((prev) => ({ ...prev, isLoading: false }));
      });
    },
    [state.requestId, state.originalMode, t],
  );

  const addUserMessage = useCallback((text: string, sketchImage?: string) => {
    setState((prev) => ({
      ...prev,
      messages: [...prev.messages, {
        id: nextId(), role: "user" as ChatRole, content: text,
        ...(sketchImage ? { sketchImage } : {}),
      }],
    }));
  }, []);

  const addAssistantMessage = useCallback((text: string) => {
    setState((prev) => ({
      ...prev,
      messages: [...prev.messages, { id: nextId(), role: "assistant" as ChatRole, content: text, done: true }],
    }));
  }, []);

  const clearMessages = useCallback(() => {
    setState(INITIAL);
    lastGenTextRef.current = "";
    sessionIdRef.current = generateSessionId();
  }, []);

  const clearPipeline = useCallback(() => {
    setState((prev) => ({ ...prev, pipelineSteps: [], queuePosition: null, queueTotal: null }));
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    const taskId = state.requestId;
    if (taskId) cancelPipeline(taskId);
    setState((prev) => ({
      ...prev,
      isLoading: false,
      activeRegenContext: null,
      queuePosition: null,
      queueTotal: null,
      messages: prev.messages.filter((m) => m.role !== "regen_loading"),
      pipelineSteps: prev.pipelineSteps.map((s) =>
        s.status === "running" || s.status === "pending"
          ? { ...s, status: "error" as StepStatus, error: t("assistant.cancelled") }
          : s,
      ),
    }));
  }, [state.requestId, t]);

  const setActiveRegenContext = useCallback((ctx: RegenContext | null) => {
    setState((prev) => ({ ...prev, activeRegenContext: ctx }));
  }, []);

  const clearCanvasUpdate = useCallback(() => {
    setState((prev) => ({ ...prev, canvasUpdateXml: null, canvasUpdateSummary: null }));
  }, []);

  return {
    messages: state.messages,
    isLoading: state.isLoading,
    pipelineSteps: state.pipelineSteps,
    resultXml: state.resultXml,
    resultImage: state.resultImage,
    referenceImage: state.referenceImage,
    canvasUpdateXml: state.canvasUpdateXml,
    canvasUpdateSummary: state.canvasUpdateSummary,
    requestId: state.requestId,
    queuePosition: state.queuePosition,
    queueTotal: state.queueTotal,
    pendingSketch: state.pendingSketch,
    activeRegenContext: state.activeRegenContext,
    sendMessage,
    addUserMessage,
    addAssistantMessage,
    clearMessages,
    clearPipeline,
    cancel,
    retryStep,
    setActiveRegenContext,
    clearCanvasUpdate,
  };
}

function toolCallLabel(name: string, args: Record<string, unknown>, t: (key: TranslationKey, vars?: Record<string, string | number>) => string): string {
  switch (name) {
    case "search_gallery":
      return t("assistant.toolSearchGallery", { query: String(args.query ?? "") });
    case "generate_diagram": {
      const mode = args.mode as string | undefined;
      if (mode === "image_only") return t("chat.mode.imageOnly");
      if (mode === "free") return t("chat.mode.free");
      if (mode === "gpt_image") return t("chat.mode.gptImage");
      if (mode === "text_edit") return t("chat.mode.textEdit");
      if (mode === "full_gen") return t("assistant.toolFullGen");
      if (mode === "draft") return t("assistant.toolDraft");
      return t("assistant.toolGenDiagram");
    }
    case "generate_assets": {
      const descs = args.descriptions as string[] | undefined;
      return t("assistant.toolGenAsset", { desc: descs?.join(", ") ?? "" });
    }
    case "modify_canvas":
      return t("assistant.toolModifyCanvas", { desc: String(args.summary ?? "") });
    case "list_image_models":
      return t("assistant.toolListModels");
    default:
      return t("assistant.toolGeneric", { name });
  }
}
