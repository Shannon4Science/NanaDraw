import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, X } from "lucide-react";
import clsx from "clsx";
import { useTranslation } from "../contexts/LanguageContext";
import {
  clearLLMConfig,
  fetchLLMConfig,
  getSettings,
  updateLLMConfig,
  updateSettings,
  type Settings,
} from "../services/settingsApi";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
const DEFAULT_TEXT_MODEL = "gemini-3.1-pro-preview";
const DEFAULT_IMAGE_MODEL = "gemini-3-pro-image-preview";
const NANA_SOUL_MAX = 500;

type TabId = "api" | "documents" | "nana";
type ApiFormat = "auto" | "gemini_native" | "openai";

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

  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [apiKey, setApiKey] = useState("");
  const [imageBaseUrl, setImageBaseUrl] = useState("");
  const [imageApiKey, setImageApiKey] = useState("");
  const [textModel, setTextModel] = useState(DEFAULT_TEXT_MODEL);
  const [imageModel, setImageModel] = useState(DEFAULT_IMAGE_MODEL);
  const [apiFormat, setApiFormat] = useState<ApiFormat>("auto");
  const [showKey, setShowKey] = useState(false);
  const [showImageKey, setShowImageKey] = useState(false);
  const [hasConfig, setHasConfig] = useState(false);
  const [mineruApiToken, setMineruApiToken] = useState("");
  const [isMineruConfigured, setIsMineruConfigured] = useState(false);
  const [nanaSoul, setNanaSoul] = useState("");

  useEffect(() => {
    if (!open) return;
    setTab("api");
    setToast(null);
    setShowKey(false);
    setShowImageKey(false);
    let cancelled = false;
    setLoading(true);
    Promise.all([fetchLLMConfig(), getSettings()])
      .then(([cfg, data]) => {
        if (cancelled) return;
        const pool = cfg.pools?.[0];
        const imagePool = cfg.image_pools?.[0];
        setBaseUrl(pool?.base_url || data.llm_base_url || DEFAULT_BASE_URL);
        setApiKey(pool?.api_keys || "");
        setImageBaseUrl(imagePool?.base_url || data.image_base_url || "");
        setImageApiKey(imagePool?.api_keys || "");
        setTextModel(cfg.text_model || data.llm_model || DEFAULT_TEXT_MODEL);
        setImageModel(cfg.image_model || data.llm_image_model || DEFAULT_IMAGE_MODEL);
        setApiFormat((cfg.api_format || data.api_format || "auto") as ApiFormat);
        setHasConfig(Boolean(cfg.has_custom_config || (pool?.base_url && pool?.api_keys)));
        setMineruApiToken("");
        setIsMineruConfigured(data.mineru_is_configured);
        setNanaSoul(data.nana_soul || "");
      })
      .catch(() => {
        if (cancelled) return;
        setMineruApiToken("");
        setIsMineruConfigured(false);
        setToast({ type: "error", text: t("settings.loadFailed") });
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
    setSaving(true);
    try {
      if (tab === "api") {
        if (!baseUrl.trim() || !apiKey.trim() || !textModel.trim() || !imageModel.trim()) {
          setToast({ type: "error", text: "Base URL、API Key、文本模型、生图模型不能为空" });
          return;
        }
        const hasImageBase = imageBaseUrl.trim().length > 0;
        const hasImageKey = imageApiKey.trim().length > 0;
        if (hasImageBase !== hasImageKey) {
          setToast({ type: "error", text: "Image Base URL 与 Image API Key 需同时填写，或同时留空" });
          return;
        }
        await updateLLMConfig(
          baseUrl.trim(),
          apiKey.trim(),
          textModel.trim(),
          imageModel.trim(),
          imageBaseUrl.trim() || undefined,
          imageApiKey.trim() || undefined,
          apiFormat,
        );
        setHasConfig(true);
      } else if (tab === "documents") {
        const hasNewMineruToken = mineruApiToken.trim().length > 0;
        if (!hasNewMineruToken && !isMineruConfigured) {
          setToast({ type: "error", text: t("settings.mineruNotConfigured") });
          return;
        }
        await updateSettings({
          mineru_api_token: hasNewMineruToken ? mineruApiToken.trim() : undefined,
        } as Partial<Omit<Settings, "is_configured" | "mineru_is_configured">>);
        if (hasNewMineruToken) {
          setIsMineruConfigured(true);
          setMineruApiToken("");
        }
      } else {
        await updateSettings({
          nana_soul: nanaSoul.slice(0, NANA_SOUL_MAX),
          language: "zh",
        } as Partial<Omit<Settings, "is_configured" | "mineru_is_configured">>);
      }
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : t("settings.saveFailed");
      setToast({ type: "error", text: msg });
    } finally {
      setSaving(false);
    }
  }, [tab, baseUrl, apiKey, textModel, imageModel, imageBaseUrl, imageApiKey, apiFormat, mineruApiToken, isMineruConfigured, nanaSoul, t, onClose]);

  const handleClear = useCallback(async () => {
    setSaving(true);
    try {
      await clearLLMConfig();
      setBaseUrl(DEFAULT_BASE_URL);
      setApiKey("");
      setImageBaseUrl("");
      setImageApiKey("");
      setTextModel(DEFAULT_TEXT_MODEL);
      setImageModel(DEFAULT_IMAGE_MODEL);
      setApiFormat("auto");
      setHasConfig(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "清除失败";
      setToast({ type: "error", text: msg });
    } finally {
      setSaving(false);
    }
  }, []);

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
        className="flex max-h-[min(90vh,760px)] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-amber-100/60 bg-white shadow-2xl shadow-amber-100/40 outline-none"
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
            API 配置
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
            <div className="space-y-3">
              <h3 className="text-lg font-semibold text-stone-800">自定义 LLM 配置</h3>

              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold text-stone-600">Base URL</span>
                <input
                  type="text"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder={DEFAULT_BASE_URL}
                  className="w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-800 outline-none transition focus:border-amber-300 focus:ring-2 focus:ring-amber-100"
                />
              </label>

              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold text-stone-600">API Key</span>
                <div className="relative">
                  <input
                    type={showKey ? "text" : "password"}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="sk-..."
                    className="w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 pr-16 text-sm text-stone-800 outline-none transition focus:border-amber-300 focus:ring-2 focus:ring-amber-100"
                  />
                  <button
                    type="button"
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-stone-500 hover:text-stone-700"
                    onClick={() => setShowKey((v) => !v)}
                  >
                    {showKey ? "隐藏" : "显示"}
                  </button>
                </div>
              </label>

              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold text-stone-600">Image Base URL（可选，留空则复用上方文本通道）</span>
                <input
                  type="text"
                  value={imageBaseUrl}
                  onChange={(e) => setImageBaseUrl(e.target.value)}
                  placeholder="https://api.openai.com/v1"
                  className="w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-800 outline-none transition focus:border-amber-300 focus:ring-2 focus:ring-amber-100"
                />
              </label>

              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold text-stone-600">Image API Key（可选）</span>
                <div className="relative">
                  <input
                    type={showImageKey ? "text" : "password"}
                    value={imageApiKey}
                    onChange={(e) => setImageApiKey(e.target.value)}
                    placeholder="sk-..."
                    className="w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 pr-16 text-sm text-stone-800 outline-none transition focus:border-amber-300 focus:ring-2 focus:ring-amber-100"
                  />
                  <button
                    type="button"
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-stone-500 hover:text-stone-700"
                    onClick={() => setShowImageKey((v) => !v)}
                  >
                    {showImageKey ? "隐藏" : "显示"}
                  </button>
                </div>
              </label>

              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold text-stone-600">文本模型</span>
                <input
                  type="text"
                  value={textModel}
                  onChange={(e) => setTextModel(e.target.value)}
                  placeholder={DEFAULT_TEXT_MODEL}
                  className="w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-800 outline-none transition focus:border-amber-300 focus:ring-2 focus:ring-amber-100"
                />
              </label>

              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold text-stone-600">生图模型</span>
                <input
                  type="text"
                  value={imageModel}
                  onChange={(e) => setImageModel(e.target.value)}
                  placeholder={DEFAULT_IMAGE_MODEL}
                  className="w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-800 outline-none transition focus:border-amber-300 focus:ring-2 focus:ring-amber-100"
                />
              </label>

              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold text-stone-600">API 格式</span>
                <select
                  value={apiFormat}
                  onChange={(e) => setApiFormat(e.target.value as ApiFormat)}
                  className="w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-800 outline-none transition focus:border-amber-300 focus:ring-2 focus:ring-amber-100"
                >
                  <option value="auto">自动检测</option>
                  <option value="gemini_native">Gemini 原生</option>
                  <option value="openai">OpenAI 兼容</option>
                </select>
                <span className="mt-1 block text-[11px] leading-relaxed text-stone-400">
                  使用 Nano Banana 等 Gemini 服务选「Gemini 原生」；多数中转服务选「OpenAI 兼容」
                </span>
              </label>

              <div className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-700">
                推荐使用兼容 OpenAI 格式的中转 API 调用推荐模型，使用其他模型可能存在未经过测试的兼容性问题或效果差距。
              </div>

              <p className="text-xs leading-relaxed text-stone-400">
                配置后您的任务将以最高优先级执行，且不消耗积分。所有字段均为必填（Image 通道可选，若填写需 URL 与 Key 成对）。
              </p>
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
          {tab === "api" ? (
            <button
              type="button"
              onClick={handleClear}
              disabled={saving || loading || !hasConfig}
              className="text-sm font-medium text-red-500 transition hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40"
            >
              清除配置
            </button>
          ) : (
            <span />
          )}

          <div className="flex items-center gap-2">
            {toast && (
              <span
                className={clsx(
                  "text-xs font-medium",
                  toast.type === "success" ? "text-emerald-600" : "text-red-600",
                )}
              >
                {toast.text}
              </span>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-full px-4 py-2 text-sm text-stone-500 transition hover:bg-stone-100"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || loading}
              className="inline-flex min-w-[84px] items-center justify-center gap-2 rounded-full bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              保存
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
