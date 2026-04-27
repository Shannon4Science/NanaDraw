import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, X } from "lucide-react";
import clsx from "clsx";
import { useTranslation } from "../contexts/LanguageContext";
import { getSettings, updateSettings, type Settings } from "../services/settingsApi";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
const DEFAULT_TEXT_MODEL = "gemini-3.1-pro-preview";
const DEFAULT_IMAGE_MODEL = "gemini-3-pro-image-preview";
const DEFAULT_COMPONENT_MODEL = "gemini-3.1-flash-image-preview";
const NANA_SOUL_MAX = 500;

type TabId = "api" | "documents" | "nana";

export interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
}

export function SettingsPanel({ open, onClose }: SettingsPanelProps) {
  const t = useTranslation();
  const [tab, setTab] = useState<TabId>("api");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const [llmApiKey, setLlmApiKey] = useState("");
  const [isKeyConfigured, setIsKeyConfigured] = useState(false);
  const [llmBaseUrl, setLlmBaseUrl] = useState(DEFAULT_BASE_URL);
  const [llmModel, setLlmModel] = useState(DEFAULT_TEXT_MODEL);
  const [llmImageModel, setLlmImageModel] = useState(DEFAULT_IMAGE_MODEL);
  const [llmComponentModel, setLlmComponentModel] = useState(DEFAULT_COMPONENT_MODEL);
  const [mineruApiToken, setMineruApiToken] = useState("");
  const [isMineruConfigured, setIsMineruConfigured] = useState(false);
  const [nanaSoul, setNanaSoul] = useState("");

  useEffect(() => {
    if (!open) return;
    setTab("api");
    setToast(null);
    let cancelled = false;
    setLoading(true);
    getSettings()
      .then((data: Settings) => {
        if (cancelled) return;
        setLlmApiKey("");
        setIsKeyConfigured(data.is_configured);
        setLlmBaseUrl(data.llm_base_url || DEFAULT_BASE_URL);
        setLlmModel(data.llm_model || DEFAULT_TEXT_MODEL);
        setLlmImageModel(data.llm_image_model || DEFAULT_IMAGE_MODEL);
        setLlmComponentModel(data.llm_component_model || DEFAULT_COMPONENT_MODEL);
        setMineruApiToken("");
        setIsMineruConfigured(data.mineru_is_configured);
        setNanaSoul(data.nana_soul || "");
      })
      .catch(() => {
        if (!cancelled) {
          setLlmApiKey("");
          setIsKeyConfigured(false);
          setLlmBaseUrl(DEFAULT_BASE_URL);
          setLlmModel(DEFAULT_TEXT_MODEL);
          setLlmImageModel(DEFAULT_IMAGE_MODEL);
          setLlmComponentModel(DEFAULT_COMPONENT_MODEL);
          setMineruApiToken("");
          setIsMineruConfigured(false);
          setNanaSoul("");
          setToast({ type: "error", text: t("settings.loadFailed") });
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [open, t]);

  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(id);
  }, [toast]);

  const handleSave = useCallback(async () => {
    const hasNewKey = llmApiKey.trim().length > 0;
    const hasNewMineruToken = mineruApiToken.trim().length > 0;
    if (tab === "api" && !hasNewKey && !isKeyConfigured) {
      setToast({ type: "error", text: t("settings.notConfigured") });
      return;
    }
    if (tab === "documents" && !hasNewMineruToken && !isMineruConfigured) {
      setToast({ type: "error", text: t("settings.mineruNotConfigured") });
      return;
    }
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        llm_base_url: llmBaseUrl.trim() || DEFAULT_BASE_URL,
        llm_model: llmModel.trim() || DEFAULT_TEXT_MODEL,
        llm_image_model: llmImageModel.trim() || DEFAULT_IMAGE_MODEL,
        llm_component_model: llmComponentModel.trim() || DEFAULT_COMPONENT_MODEL,
        nana_soul: nanaSoul.slice(0, NANA_SOUL_MAX),
        language: "zh",
      };
      if (hasNewKey) {
        payload.llm_api_key = llmApiKey.trim();
      }
      if (hasNewMineruToken) {
        payload.mineru_api_token = mineruApiToken.trim();
      }
      await updateSettings(payload as Partial<Omit<Settings, "is_configured" | "mineru_is_configured">>);
      if (hasNewKey) {
        setIsKeyConfigured(true);
      }
      if (hasNewMineruToken) {
        setIsMineruConfigured(true);
      }
      onClose();
    } catch {
      setToast({ type: "error", text: t("settings.saveFailed") });
    } finally {
      setSaving(false);
    }
  }, [tab, llmApiKey, isKeyConfigured, llmBaseUrl, llmModel, llmImageModel, llmComponentModel, mineruApiToken, isMineruConfigured, nanaSoul, onClose, t]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/35 backdrop-blur-[2px] p-4"
      role="presentation"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
        className="flex max-h-[min(90vh,720px)] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-amber-100/60 bg-white shadow-2xl shadow-amber-100/40 outline-none"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
      >
        <div className="flex items-center justify-between border-b border-amber-100/50 bg-gradient-to-r from-amber-50/90 to-orange-50/80 px-5 py-4">
          <h2 id="settings-title" className="font-headline text-lg font-bold text-stone-800">
            {t("settings.title")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-2 text-stone-400 transition-colors hover:bg-white/80 hover:text-stone-600"
            aria-label={t("chat.close")}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex border-b border-stone-100 px-2 pt-2">
          <button
            type="button"
            onClick={() => setTab("api")}
            className={clsx(
              "flex-1 rounded-t-lg px-3 py-2.5 text-sm font-semibold transition-colors",
              tab === "api"
                ? "bg-white text-amber-700 shadow-[0_-1px_0_0_white]"
                : "text-stone-500 hover:text-stone-700",
            )}
          >
            {t("settings.apiConfig")}
          </button>
          <button
            type="button"
            onClick={() => setTab("documents")}
            className={clsx(
              "flex-1 rounded-t-lg px-3 py-2.5 text-sm font-semibold transition-colors",
              tab === "documents"
                ? "bg-white text-amber-700 shadow-[0_-1px_0_0_white]"
                : "text-stone-500 hover:text-stone-700",
            )}
          >
            {t("settings.documents")}
          </button>
          <button
            type="button"
            onClick={() => setTab("nana")}
            className={clsx(
              "flex-1 rounded-t-lg px-3 py-2.5 text-sm font-semibold transition-colors",
              tab === "nana"
                ? "bg-white text-amber-700 shadow-[0_-1px_0_0_white]"
                : "text-stone-500 hover:text-stone-700",
            )}
          >
            {t("settings.nanaSoul")}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-stone-400">
              <Loader2 className="h-8 w-8 animate-spin text-amber-500" />
              <span className="text-sm">{t("chat.loading")}</span>
            </div>
          ) : tab === "api" ? (
            <div className="space-y-4">
              <label className="block">
                <span className="mb-1.5 flex items-center gap-2 text-xs font-semibold text-stone-600">
                  {t("settings.apiKey")}
                  {isKeyConfigured && (
                    <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-600 ring-1 ring-emerald-200/60">
                      ✓ {t("settings.apiKeyConfigured")}
                    </span>
                  )}
                </span>
                <input
                  type="text"
                  autoComplete="off"
                  value={llmApiKey}
                  onChange={(e) => setLlmApiKey(e.target.value)}
                  className="w-full rounded-xl border border-stone-200 bg-stone-50/50 px-3 py-2.5 text-sm text-stone-800 outline-none transition focus:border-amber-300 focus:bg-white focus:ring-2 focus:ring-amber-100"
                  placeholder={isKeyConfigured ? t("settings.apiKeyPlaceholder") : ""}
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold text-stone-600">{t("settings.baseUrl")}</span>
                <input
                  type="url"
                  value={llmBaseUrl}
                  onChange={(e) => setLlmBaseUrl(e.target.value)}
                  placeholder={DEFAULT_BASE_URL}
                  className="w-full rounded-xl border border-stone-200 bg-stone-50/50 px-3 py-2.5 text-sm text-stone-800 outline-none transition focus:border-amber-300 focus:bg-white focus:ring-2 focus:ring-amber-100"
                />
                <span className="mt-1 block text-[11px] leading-relaxed text-stone-400">{t("settings.baseUrlHint")}</span>
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold text-stone-600">{t("settings.textModel")}</span>
                <input
                  type="text"
                  value={llmModel}
                  onChange={(e) => setLlmModel(e.target.value)}
                  placeholder={DEFAULT_TEXT_MODEL}
                  className="w-full rounded-xl border border-stone-200 bg-stone-50/50 px-3 py-2.5 text-sm text-stone-800 outline-none transition focus:border-amber-300 focus:bg-white focus:ring-2 focus:ring-amber-100"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold text-stone-600">{t("settings.imageModel")}</span>
                <input
                  type="text"
                  value={llmImageModel}
                  onChange={(e) => setLlmImageModel(e.target.value)}
                  placeholder={DEFAULT_IMAGE_MODEL}
                  className="w-full rounded-xl border border-stone-200 bg-stone-50/50 px-3 py-2.5 text-sm text-stone-800 outline-none transition focus:border-amber-300 focus:bg-white focus:ring-2 focus:ring-amber-100"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold text-stone-600">{t("settings.componentModel")}</span>
                <input
                  type="text"
                  value={llmComponentModel}
                  onChange={(e) => setLlmComponentModel(e.target.value)}
                  placeholder={DEFAULT_COMPONENT_MODEL}
                  className="w-full rounded-xl border border-stone-200 bg-stone-50/50 px-3 py-2.5 text-sm text-stone-800 outline-none transition focus:border-amber-300 focus:bg-white focus:ring-2 focus:ring-amber-100"
                />
              </label>
            </div>
          ) : tab === "documents" ? (
            <div className="space-y-4">
              <p className="text-xs leading-relaxed text-stone-500">{t("settings.mineruTokenHelper")}</p>
              <label className="block">
                <span className="mb-1.5 flex items-center gap-2 text-xs font-semibold text-stone-600">
                  {t("settings.mineruToken")}
                  {isMineruConfigured && (
                    <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-600 ring-1 ring-emerald-200/60">
                      ✓ {t("settings.apiKeyConfigured")}
                    </span>
                  )}
                </span>
                <input
                  type="text"
                  autoComplete="off"
                  value={mineruApiToken}
                  onChange={(e) => setMineruApiToken(e.target.value)}
                  className="w-full rounded-xl border border-stone-200 bg-stone-50/50 px-3 py-2.5 text-sm text-stone-800 outline-none transition focus:border-amber-300 focus:bg-white focus:ring-2 focus:ring-amber-100"
                  placeholder={isMineruConfigured ? t("settings.apiKeyPlaceholder") : ""}
                />
              </label>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-xs leading-relaxed text-stone-500">{t("settings.nanaSoulHelper")}</p>
              <textarea
                value={nanaSoul}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v.length <= NANA_SOUL_MAX) setNanaSoul(v);
                }}
                rows={8}
                className="w-full resize-none rounded-xl border border-stone-200 bg-stone-50/50 px-3 py-2.5 text-sm text-stone-800 outline-none transition focus:border-amber-300 focus:bg-white focus:ring-2 focus:ring-amber-100"
              />
              <div className="text-right text-[11px] text-stone-400">
                {nanaSoul.length}/{NANA_SOUL_MAX}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-stone-100 bg-stone-50/50 px-5 py-4">
          {toast && (
            <span
              className={clsx(
                "text-sm font-medium",
                toast.type === "success" ? "text-emerald-600" : "text-red-600",
              )}
            >
              {toast.text}
            </span>
          )}
          {!toast && <span />}
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || loading}
            className="inline-flex min-w-[100px] items-center justify-center gap-2 rounded-full bg-gradient-to-r from-amber-500 to-orange-500 px-5 py-2.5 text-sm font-bold text-white shadow-lg shadow-amber-200/50 transition hover:opacity-95 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {t("settings.save")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
