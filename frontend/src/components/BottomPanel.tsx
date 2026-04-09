import { clsx } from "clsx";
import {
  Check,
  ChevronUp,
  RefreshCw,
  X as XIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useT } from "../contexts/LanguageContext";
import type { PipelineStep } from "../hooks/useGenerate";
import { StepDetailViewer } from "./StepDetailViewer";

interface BottomPanelProps {
  steps: PipelineStep[];
  selectedStepId: string | null;
  onSelectStep: (stepId: string | null) => void;
  onRetryStep: (stepId: string) => void;
  referenceImage: string | null;
  isGenerating: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onLoadXmlToCanvas?: (xml: string) => void;
  resultXml?: string | null;
  onElementSaved?: () => void;
  queuePosition?: number | null;
  queueTotal?: number | null;
  onRegenComponent?: (componentId: string, label: string) => void;
  canViewPrompts?: boolean;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function RunningTimer({ startedAt }: { startedAt: number }) {
  const [elapsed, setElapsed] = useState(() => Date.now() - startedAt);
  useEffect(() => {
    const id = setInterval(() => setElapsed(Date.now() - startedAt), 200);
    return () => clearInterval(id);
  }, [startedAt]);
  return <>{formatMs(elapsed)}</>;
}

const STATUS_ICON: Record<string, React.ReactNode> = {
  pending: <div className="h-4 w-4 rounded-full border-2 border-outline-variant/30" />,
  running: (
    <div className="relative flex h-4 w-4 items-center justify-center">
      <div className="absolute inset-0 rounded-full border-2 border-primary-container" />
      <div className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-primary" />
    </div>
  ),
  completed: (
    <div className="flex h-4 w-4 items-center justify-center rounded-full bg-amber-400">
      <Check className="h-2.5 w-2.5 text-gray-900" />
    </div>
  ),
  error: (
    <div className="flex h-4 w-4 items-center justify-center rounded-full bg-error">
      <XIcon className="h-2.5 w-2.5 text-white" />
    </div>
  ),
};

export function BottomPanel({
  steps,
  selectedStepId,
  onSelectStep,
  onRetryStep,
  referenceImage,
  isGenerating,
  collapsed,
  onToggleCollapse,
  onLoadXmlToCanvas,
  resultXml,
  onElementSaved,
  queuePosition,
  queueTotal,
  onRegenComponent,
  canViewPrompts = true,
}: BottomPanelProps) {
  const t = useT();
  if (steps.length === 0) return null;

  const completed = steps.filter((s) => s.status === "completed").length;
  const total = steps.length;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  const selectedStep = steps.find((s) => s.id === selectedStepId) ?? null;
  const isQueued = queuePosition != null && queuePosition > 0;

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-t-2xl border border-b-0 border-outline-variant/8 bg-surface-container-lowest/90 shadow-float backdrop-blur-xl">
      {/* ── Header bar ── */}
      <button
        onClick={onToggleCollapse}
        className="flex items-center justify-between bg-surface-container-lowest/80 px-4 py-2 backdrop-blur-xl transition-colors hover:bg-surface-container/30"
        data-testid="bottom-panel-toggle"
      >
        <div className="flex items-center gap-3">
          <span className="font-headline text-xs font-bold tracking-wide text-on-surface">{t("pipeline.title")}</span>
          {isQueued ? (
            <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-primary animate-pulse">
              <span className="inline-block h-2 w-2 rounded-full bg-primary-container" />
              {t("pipeline.queue", { pos: String(queuePosition), total: String(queueTotal ?? "?") })}
              {queuePosition > 1 && (
                <span className="text-primary/60">
                  {t("pipeline.queueAhead", { n: String(queuePosition - 1) })}
                </span>
              )}
            </span>
          ) : (
            <span className="text-[10px] uppercase tracking-widest text-outline">
              {t("pipeline.stepProgress", {
                completed: String(completed),
                total: String(total),
                pct: String(pct),
              })}
            </span>
          )}
          <div className="h-1.5 w-28 overflow-hidden rounded-full bg-surface-container">
            <div
              className={clsx(
                "h-full rounded-full transition-all duration-500",
                isQueued ? "bg-primary-container animate-pulse" : "bg-primary-container",
              )}
              style={{ width: isQueued ? "100%" : `${pct}%` }}
            />
          </div>
        </div>
        <ChevronUp
          className={clsx(
            "h-4 w-4 text-outline transition-transform",
            collapsed && "rotate-180",
          )}
        />
      </button>

      {!collapsed && (
        <div className="flex flex-1 overflow-hidden">
          {/* ── Step list ── */}
          <div className="flex w-56 flex-shrink-0 flex-col overflow-y-auto bg-surface-container-low/20">
            {steps.map((step) => (
              <div
                key={step.id}
                role="button"
                tabIndex={0}
                onClick={() => onSelectStep(step.id)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onSelectStep(step.id); }}
                className={clsx(
                  "flex cursor-pointer items-center gap-2.5 px-3 py-2.5 text-left transition-all",
                  selectedStepId === step.id
                    ? "bg-primary-container/15 border-l-2 border-l-primary"
                    : "hover:bg-surface-container-high/40 border-l-2 border-l-transparent",
                )}
              >
                {STATUS_ICON[step.status]}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-on-surface">
                    {step.name}
                  </div>
                  {step.status === "running" && step.startedAt != null ? (
                    <div className="text-[10px] font-mono text-primary animate-pulse">
                      <RunningTimer startedAt={step.startedAt} />
                    </div>
                  ) : step.elapsedMs != null ? (
                    <div className="text-[10px] font-mono text-outline">
                      {formatMs(step.elapsedMs)}
                    </div>
                  ) : null}
                </div>
                {!isGenerating && (step.status === "completed" || step.status === "error") && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onRetryStep(step.id);
                    }}
                    className={clsx(
                      "flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold transition-all active:scale-95",
                      step.status === "error"
                        ? "bg-error-container/20 text-error hover:bg-error-container/30"
                        : "bg-surface-container text-on-surface-variant hover:bg-surface-container-high",
                    )}
                    title={t("pipeline.retryFrom")}
                  >
                    <RefreshCw className="h-3 w-3" />
                    {t("pipeline.retry")}
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* ── Detail area ── */}
          <div className="flex-1 overflow-y-auto bg-surface-container-lowest/80 p-4 backdrop-blur-sm">
            {selectedStep ? (
              <StepDetailViewer
                step={selectedStep}
                referenceImage={referenceImage}
                onRetry={
                  !isGenerating && (selectedStep.status === "completed" || selectedStep.status === "error")
                    ? () => onRetryStep(selectedStep.id)
                    : undefined
                }
                onLoadXmlToCanvas={onLoadXmlToCanvas}
                resultXml={resultXml}
                onElementSaved={onElementSaved}
                onRegenComponent={onRegenComponent}
                canViewPrompts={canViewPrompts}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-outline">
                {t("pipeline.clickStep")}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
