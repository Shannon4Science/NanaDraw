import { useCallback, useRef, useState } from "react";
import { cancelPipeline, generateDiagram } from "../services/api";
import { useT } from "../contexts/LanguageContext";
import type { TranslationKey } from "../i18n/zh";
import type { DiagramPlan, GenerateRequest } from "../types/paper";

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

export type StepStatus = "pending" | "running" | "completed" | "error";

export interface PromptPair {
  system: string;
  user: string;
}

export interface ElementProgress {
  element_id: string;
  label: string;
  category?: string;
  strategy: string;
  status: string;
  error?: string;
  image_b64?: string;
  index: number;
  total: number;
  score?: number;
  round?: number;
  max_rounds?: number;
}

export interface PipelineStep {
  id: string;
  name: string;
  status: StepStatus;
  startedAt?: number;
  elapsedMs?: number;
  error?: string;
  artifactType?: string;
  artifact?: unknown;
  prompts?: PromptPair;
  elementProgress?: ElementProgress[];
}

interface GenerateState {
  isGenerating: boolean;
  steps: PipelineStep[];
  plan: DiagramPlan | null;
  referenceImage: string | null;
  resultXml: string | null;
  resultImage: string | null;
  resultSlides: unknown[] | null;
  resultViewportRatio: number | null;
  error: string | null;
  requestId: string | null;
  selectedStepId: string | null;
  queuePosition: number | null;
  queueTotal: number | null;
}

const INITIAL: GenerateState = {
  isGenerating: false,
  steps: [],
  plan: null,
  referenceImage: null,
  resultXml: null,
  resultImage: null,
  resultSlides: null,
  resultViewportRatio: null,
  error: null,
  requestId: null,
  selectedStepId: null,
  queuePosition: null,
  queueTotal: null,
};

function updateStep(
  steps: PipelineStep[],
  stepId: string,
  patch: Partial<PipelineStep>,
): PipelineStep[] {
  return steps.map((s) => (s.id === stepId ? { ...s, ...patch } : s));
}

const NETWORK_ERROR_PATTERNS = ["ReadTimeout", "NetworkError", "timeout", "network"];

function getPipelineTimeout(request: GenerateRequest): { ms: number; labelKey: "gen.timeout8min" | "gen.timeout15min" | "gen.timeout5min" } {
  const imageOnly = request.options?.image_only;
  if (imageOnly) return { ms: 8 * 60 * 1000, labelKey: "gen.timeout8min" };
  if (request.mode === "full_gen") return { ms: 15 * 60 * 1000, labelKey: "gen.timeout15min" };
  return { ms: 5 * 60 * 1000, labelKey: "gen.timeout5min" };
}

function normalizeError(error: string, networkMsg: string): string {
  if (NETWORK_ERROR_PATTERNS.some((p) => error.toLowerCase().includes(p.toLowerCase()))) {
    return networkMsg;
  }
  return error;
}

export function useGenerate() {
  const t = useT();
  const [state, setState] = useState<GenerateState>(INITIAL);
  const abortRef = useRef<AbortController | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRequestRef = useRef<GenerateRequest | null>(null);
  const genEpochRef = useRef(0);

  const runGenerate = useCallback(
    async (request: GenerateRequest, resumeFrom?: string) => {
      abortRef.current?.abort();
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      const controller = new AbortController();
      abortRef.current = controller;
      const epoch = ++genEpochRef.current;

      const isRetry = !!resumeFrom;

      setState((prev) => ({
        ...(isRetry ? prev : INITIAL),
        isGenerating: true,
        error: null,
        resultXml: isRetry ? prev.resultXml : null,
        steps: isRetry
          ? prev.steps.map((s) => {
              const stepIdx = prev.steps.findIndex((x) => x.id === resumeFrom);
              const thisIdx = prev.steps.indexOf(s);
              if (thisIdx >= stepIdx)
                return {
                  ...s,
                  status: "pending" as StepStatus,
                  error: undefined,
                  elementProgress: undefined,
                };
              return s;
            })
          : [],
      }));

      lastRequestRef.current = request;

      const timeout = getPipelineTimeout(request);
      const startPipelineTimeout = () => {
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        timeoutRef.current = setTimeout(() => {
          if (!controller.signal.aborted) {
            controller.abort();
            setState((prev) => {
              if (prev.requestId) cancelPipeline(prev.requestId);
              return {
                ...prev,
                isGenerating: false,
                error: t("gen.timeoutMsg", { label: t(timeout.labelKey) }),
                steps: prev.steps.map((s) =>
                  s.status === "running" || s.status === "pending"
                    ? { ...s, status: "error" as StepStatus, error: t("gen.frontendTimeout") }
                    : s,
                ),
              };
            });
          }
        }, timeout.ms);
      };

      try {
      await generateDiagram(
        request,
        {
          onQueuePosition: ({ position, total }) => {
            setState((prev) => ({ ...prev, queuePosition: position, queueTotal: total }));
          },
          onPipelineInfo: ({ steps, request_id }) => {
            startPipelineTimeout();
            setState((prev) => {
              if (isRetry && prev.steps.length > 0) {
                return { ...prev, requestId: request_id ?? prev.requestId, queuePosition: null, queueTotal: null };
              }
              const pipelineSteps: PipelineStep[] = steps.map((s) => ({
                id: s.id,
                name: STEP_ID_KEYS[s.id] ? t(STEP_ID_KEYS[s.id]) : s.name,
                status: "pending",
              }));
              return { ...prev, steps: pipelineSteps, requestId: request_id ?? null, queuePosition: null, queueTotal: null };
            });
          },
          onStepStart: ({ step_id }) => {
            setState((prev) => ({
              ...prev,
              steps: updateStep(prev.steps, step_id, { status: "running", startedAt: Date.now() }),
              selectedStepId: step_id,
            }));
          },
          onStepComplete: ({ step_id, elapsed_ms, artifact_type, artifact, prompts, cached }) => {
            setState((prev) => {
              const existing = prev.steps.find((s) => s.id === step_id);
              const patch: Partial<PipelineStep> = { status: "completed" };

              if (cached && existing?.artifactType) {
                if (elapsed_ms > 0) patch.elapsedMs = elapsed_ms;
              } else {
                patch.elapsedMs = elapsed_ms;
                patch.artifactType = artifact_type;
                patch.artifact = artifact;
                patch.prompts = prompts;
              }

              let steps = updateStep(prev.steps, step_id, patch);
              const completedIdx = steps.findIndex((s) => s.id === step_id);
              if (completedIdx >= 0 && completedIdx < steps.length - 1) {
                const next = steps[completedIdx + 1];
                if (next.status === "pending") {
                  steps = updateStep(steps, next.id, { status: "running", startedAt: Date.now() });
                }
              }
              return { ...prev, steps };
            });
          },
          onStepError: ({ step_id, elapsed_ms, error }) => {
            setState((prev) => ({
              ...prev,
              steps: updateStep(prev.steps, step_id, {
                status: "error",
                elapsedMs: elapsed_ms,
                error: normalizeError(error, t("gen.networkErrorMsg")),
              }),
              selectedStepId: step_id,
            }));
          },
          onStepProgress: (data) => {
            setState((prev) => ({
              ...prev,
              steps: prev.steps.map((s) => {
                if (s.id !== data.step_id) return s;
                const existing = s.elementProgress ?? [];
                const updated = existing.filter((e) => e.element_id !== data.element_id);
                updated.push(data);
                return { ...s, elementProgress: updated };
              }),
            }));
          },
          onPlan: (data) => {
            setState((prev) => ({ ...prev, plan: data as unknown as DiagramPlan }));
          },
          onReferenceImage: (data) => {
            setState((prev) => ({ ...prev, referenceImage: data.image }));
          },
          onResult: (data) => {
            if (epoch !== genEpochRef.current) return;
            if (timeoutRef.current) clearTimeout(timeoutRef.current);
            setState((prev) => ({
              ...prev,
              resultXml: data.xml ?? null,
              resultImage: data.image ?? null,
              resultSlides: data.slides ?? null,
              resultViewportRatio: data.viewportRatio ?? null,
              isGenerating: false,
            }));
          },
          onError: (data) => {
            if (epoch !== genEpochRef.current) return;
            if (timeoutRef.current) clearTimeout(timeoutRef.current);
            setState((prev) => ({
              ...prev,
              error: normalizeError(data.message, t("gen.networkErrorMsg")),
              isGenerating: false,
            }));
          },
          onClose: () => {
            if (epoch !== genEpochRef.current) return;
            if (timeoutRef.current) clearTimeout(timeoutRef.current);
            setState((prev) => {
              const hasResult = !!prev.resultXml || !!prev.resultImage || !!prev.resultSlides;
              if (hasResult) return { ...prev, isGenerating: false };
              return {
                ...prev,
                isGenerating: false,
                steps: prev.steps.map((s) =>
                  s.status === "running"
                    ? { ...s, status: "error" as StepStatus, error: t("gen.networkOrModelError") }
                    : s,
                ),
              };
            });
          },
        },
        controller.signal,
      );
      } catch (err) {
        if (epoch !== genEpochRef.current) return;
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        if (controller.signal.aborted) return;
        setState((prev) => ({
          ...prev,
          isGenerating: false,
          error: err instanceof Error ? err.message : t("gen.networkErrorMsg"),
        }));
      }
    },
    [t],
  );

  const generate = useCallback(
    (request: GenerateRequest) => runGenerate(request),
    [runGenerate],
  );

  const retryStep = useCallback(
    (stepId: string) => {
      const req = lastRequestRef.current;
      if (!req) return;
      const retryReq: GenerateRequest = {
        ...req,
        request_id: state.requestId ?? undefined,
        resume_from: stepId,
      };
      runGenerate(retryReq, stepId);
    },
    [runGenerate, state.requestId],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    const taskId = state.requestId;
    if (taskId) cancelPipeline(taskId);
    setState((prev) => ({
      ...prev,
      isGenerating: false,
      steps: prev.steps.map((s) =>
        s.status === "running" || s.status === "pending"
          ? { ...s, status: "error" as StepStatus, error: t("gen.cancelled") }
          : s,
      ),
    }));
  }, [state.requestId, t]);

  const selectStep = useCallback((stepId: string | null) => {
    setState((prev) => ({ ...prev, selectedStepId: stepId }));
  }, []);

  const updateComponentImage = useCallback(
    (componentId: string, newImageB64: string) => {
      setState((prev) => ({
        ...prev,
        steps: prev.steps.map((s) => {
          if (s.id !== "component_generation" || !s.elementProgress) return s;
          return {
            ...s,
            elementProgress: s.elementProgress.map((ep) =>
              ep.element_id === componentId
                ? { ...ep, image_b64: newImageB64, status: "success" }
                : ep,
            ),
          };
        }),
      }));
    },
    [],
  );

  return { ...state, generate, cancel, retryStep, selectStep, updateComponentImage };
}
