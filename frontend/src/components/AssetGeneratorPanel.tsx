import { useCallback, useEffect, useRef, useState } from "react";
import { X, Sparkles, Upload, Loader2, Plus, Image, Check, ZoomIn } from "lucide-react";
import type { TranslationKey } from "../i18n/zh";
import type { AssetStyle } from "../services/api";
import { useLanguage, useT } from "../contexts/LanguageContext";
import { useAssetGenerator } from "../hooks/useAssetGenerator";

interface Props {
  open: boolean;
  onClose: () => void;
  onSaveToLibrary: (imageB64: string, name: string) => Promise<boolean>;
  imageModel?: string;
}

const STYLES: { id: AssetStyle; labelKey: TranslationKey; descKey: TranslationKey }[] = [
  { id: "none", labelKey: "assetGen.styleNone", descKey: "assetGen.styleNoneDesc" },
  { id: "thin_linear", labelKey: "assetGen.styleThinLinear", descKey: "assetGen.styleThinLinearDesc" },
  { id: "regular_linear", labelKey: "assetGen.styleRegularLinear", descKey: "assetGen.styleRegularLinearDesc" },
  { id: "bold_linear", labelKey: "assetGen.styleBoldLinear", descKey: "assetGen.styleBoldLinearDesc" },
  { id: "minimal_flat", labelKey: "assetGen.styleMinimalFlat", descKey: "assetGen.styleMinimalFlatDesc" },
  { id: "doodle", labelKey: "assetGen.styleDoodle", descKey: "assetGen.styleDoodleDesc" },
  { id: "hand_drawn", labelKey: "assetGen.styleHandDrawn", descKey: "assetGen.styleHandDrawnDesc" },
  { id: "illustration", labelKey: "assetGen.styleIllustration", descKey: "assetGen.styleIllustrationDesc" },
  { id: "detailed_linear", labelKey: "assetGen.styleDetailedLinear", descKey: "assetGen.styleDetailedLinearDesc" },
  { id: "fine_linear", labelKey: "assetGen.styleFineLinear", descKey: "assetGen.styleFineLinearDesc" },
  { id: "custom", labelKey: "assetGen.styleCustom", descKey: "assetGen.styleCustomDesc" },
];

const EXAMPLE_TAGS_ZH = [
  "手拿着硬币", "一块蛋糕", "智能手表", "龙", "古代建筑宫殿",
  "手机", "一个人骑着电动车送外卖", "DNA 双螺旋", "显微镜", "机器人手臂",
];
const EXAMPLE_TAGS_EN = [
  "hand holding a coin", "a cake", "smartwatch", "dragon", "ancient palace",
  "smartphone", "delivery rider on a scooter", "DNA double helix", "microscope", "robotic arm",
];
const EXAMPLE_TAGS: Record<string, string[]> = { zh: EXAMPLE_TAGS_ZH, en: EXAMPLE_TAGS_EN };

type TabId = "text" | "image";

function b64Key(b64: string) {
  const head = b64.slice(0, 64);
  const tail = b64.slice(-64);
  return head + tail;
}

export function AssetGeneratorPanel({ open, onClose, onSaveToLibrary, imageModel }: Props) {
  const t = useT();
  const { locale } = useLanguage();
  const [tab, setTab] = useState<TabId>("text");
  const [textInput, setTextInput] = useState("");
  const [selectedStyle, setSelectedStyle] = useState<AssetStyle>("none");
  const [styleText, setStyleText] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [savedSet, setSavedSet] = useState<Set<string>>(new Set());
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [namingItem, setNamingItem] = useState<{ b64: string; defaultName: string } | null>(null);
  const [namingInput, setNamingInput] = useState("");
  const namingInputRef = useRef<HTMLInputElement>(null);

  const {
    generating, results, error, queuePosition, queueTotal, progress,
    generateFromText, generateFromImage, clearResults, cancel,
  } = useAssetGenerator();

  const handleGenFromText = useCallback(() => {
    const descs = textInput
      .split(/[;；]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 4);
    if (descs.length === 0) return;
    generateFromText(descs, selectedStyle, imageModel, selectedStyle === "custom" ? styleText : undefined);
  }, [textInput, selectedStyle, styleText, generateFromText, imageModel]);

  const handleGenFromImage = useCallback(() => {
    if (!imageFile) return;
    generateFromImage(imageFile, selectedStyle, imageModel, selectedStyle === "custom" ? styleText : undefined);
  }, [imageFile, selectedStyle, styleText, generateFromImage, imageModel]);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImageFile(file);
    const reader = new FileReader();
    reader.onload = () => setImagePreview(reader.result as string);
    reader.readAsDataURL(file);
  }, []);

  const addTag = useCallback(
    (tag: string) => {
      const parts = textInput
        .split(/[;；]/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (parts.length >= 4) return;
      setTextInput(parts.length > 0 ? parts.join("；") + "；" + tag : tag);
    },
    [textInput],
  );

  const openNamingDialog = useCallback((b64: string, desc: string) => {
    const key = b64Key(b64);
    if (savedSet.has(key)) return;
    setNamingItem({ b64, defaultName: desc });
    setNamingInput(desc);
  }, [savedSet]);

  const confirmSave = useCallback(async () => {
    if (!namingItem) return;
    const name = namingInput.trim() || namingItem.defaultName;
    const key = b64Key(namingItem.b64);
    setSavingKey(key);
    try {
      const ok = await onSaveToLibrary(namingItem.b64, name);
      if (ok) {
        setSavedSet((prev) => new Set(prev).add(key));
      }
    } finally {
      setSavingKey(null);
      setNamingItem(null);
    }
  }, [namingItem, namingInput, onSaveToLibrary]);

  useEffect(() => {
    if (namingItem && namingInputRef.current) {
      namingInputRef.current.focus();
      namingInputRef.current.select();
    }
  }, [namingItem]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (previewSrc) {
          setPreviewSrc(null);
        } else if (namingItem) {
          setNamingItem(null);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose, previewSrc, namingItem]);

  if (!open) return null;

  const charCount = textInput.length;

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/15 backdrop-blur-[2px]">
        <div className="relative flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-surface-container-lowest shadow-glass">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-indigo-100 bg-gradient-to-r from-indigo-50 to-purple-50 px-5 py-3">
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-purple-500 shadow-sm">
                <Sparkles className="h-4 w-4 text-white" />
              </div>
              <h2 className="text-sm font-semibold text-indigo-800">{t("assetGen.title")}</h2>
            </div>
            <button
              onClick={onClose}
              className="rounded-lg p-1.5 text-indigo-400 transition-colors hover:bg-indigo-100 hover:text-indigo-600"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Tabs */}
          <div className="flex border-b">
            {(
              [
                { id: "text" as TabId, labelKey: "assetGen.fromText" as const },
                { id: "image" as TabId, labelKey: "assetGen.fromImage" as const },
              ] as const
            ).map((tabDef) => (
              <button
                key={tabDef.id}
                onClick={() => setTab(tabDef.id)}
                className={`flex-1 py-2.5 text-center text-sm font-medium transition-colors ${
                  tab === tabDef.id
                    ? "border-b-2 border-indigo-500 text-indigo-700"
                    : "text-gray-500 hover:text-gray-700"
                }`}
              >
                {t(tabDef.labelKey)}
              </button>
            ))}
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-5">
            {/* Text Tab */}
            {tab === "text" && (
              <div className="space-y-4">
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-700">
                    {t("assetGen.descLabel")}{" "}
                    <span className="font-normal text-gray-400">
                      {t("assetGen.descHint")}
                    </span>
                  </label>
                  <div className="relative">
                    <textarea
                      value={textInput}
                      onChange={(e) => {
                        if (e.target.value.length <= 200) setTextInput(e.target.value);
                      }}
                      placeholder={t("assetGen.descPlaceholder")}
                      rows={3}
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-800 placeholder-gray-400 transition-colors focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-200"
                    />
                    <span className="absolute bottom-2 right-2 text-[10px] text-gray-400">
                      {charCount} / 200
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {(EXAMPLE_TAGS[locale] || EXAMPLE_TAGS_EN).map((tag) => (
                      <button
                        key={tag}
                        onClick={() => addTag(tag)}
                        className="rounded-full border border-gray-200 bg-gray-50 px-2.5 py-0.5 text-[11px] text-gray-600 transition-colors hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700"
                      >
                        {tag}
                      </button>
                    ))}
                  </div>
                </div>

                <StyleGrid selected={selectedStyle} onSelect={setSelectedStyle} />

                {selectedStyle === "custom" && (
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-700">
                      {t("assetGen.styleDesc")}
                    </label>
                    <input
                      type="text"
                      value={styleText}
                      onChange={(e) => setStyleText(e.target.value.slice(0, 200))}
                      placeholder={t("assetGen.stylePlaceholder")}
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-800 placeholder-gray-400 transition-colors focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-200"
                    />
                  </div>
                )}

                <button
                  onClick={generating ? cancel : handleGenFromText}
                  disabled={!generating && (!textInput.trim() || (selectedStyle === "custom" && !styleText.trim()))}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-indigo-500 to-purple-500 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition-all hover:from-indigo-600 hover:to-purple-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {generating ? (
                    queuePosition != null ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        {t("assetGen.queue", {
                          pos: String(queuePosition),
                          total: String(queueTotal ?? "?"),
                        })}
                        {queuePosition > 1 && t("assetGen.queueAhead", { n: String(queuePosition - 1) })}
                      </>
                    ) : progress ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        {t("assetGen.genProgress", {
                          index: String(progress.index),
                          total: String(progress.total),
                        })}
                      </>
                    ) : (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        {t("assetGen.generating")}
                      </>
                    )
                  ) : (
                    <>
                      <Sparkles className="h-4 w-4" />
                      {t("assetGen.genIcons")}
                    </>
                  )}
                </button>
              </div>
            )}

            {/* Image Tab */}
            {tab === "image" && (
              <div className="space-y-4">
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-700">
                    {t("assetGen.uploadRef")}
                  </label>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    onChange={handleFileChange}
                  />
                  {imagePreview ? (
                    <div className="relative flex items-center justify-center rounded-lg border-2 border-dashed border-indigo-200 bg-indigo-50/30 p-4">
                      <img
                        src={imagePreview}
                        alt="preview"
                        className="max-h-40 rounded-md object-contain"
                      />
                      <button
                        onClick={() => {
                          setImageFile(null);
                          setImagePreview(null);
                          if (fileRef.current) fileRef.current.value = "";
                        }}
                        className="absolute right-2 top-2 rounded-full bg-white p-1 shadow-sm hover:bg-gray-100"
                      >
                        <X className="h-3 w-3 text-gray-500" />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => fileRef.current?.click()}
                      className="flex w-full flex-col items-center gap-2 rounded-lg border-2 border-dashed border-gray-200 bg-gray-50/50 p-6 text-gray-400 transition-colors hover:border-indigo-300 hover:bg-indigo-50/30 hover:text-indigo-500"
                    >
                      <Upload className="h-8 w-8" />
                      <span className="text-xs">{t("assetGen.dropOrClick")}</span>
                      <span className="text-[10px] text-gray-300">{t("assetGen.fileReq")}</span>
                    </button>
                  )}
                </div>

                <StyleGrid selected={selectedStyle} onSelect={setSelectedStyle} />

                {selectedStyle === "custom" && (
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-700">
                      {t("assetGen.styleDesc")}
                    </label>
                    <input
                      type="text"
                      value={styleText}
                      onChange={(e) => setStyleText(e.target.value.slice(0, 200))}
                      placeholder={t("assetGen.stylePlaceholder")}
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-800 placeholder-gray-400 transition-colors focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-200"
                    />
                  </div>
                )}

                <button
                  onClick={handleGenFromImage}
                  disabled={generating || !imageFile || (selectedStyle === "custom" && !styleText.trim())}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-indigo-500 to-purple-500 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition-all hover:from-indigo-600 hover:to-purple-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {generating ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {t("assetGen.generating")}
                    </>
                  ) : (
                    <>
                      <Image className="h-4 w-4" />
                      {t("assetGen.stylize")}
                    </>
                  )}
                </button>
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">
                {error}
              </div>
            )}

            {/* Results */}
            {results.length > 0 && (
              <div className="mt-5">
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-xs font-medium text-gray-600">
                    {t("assetGen.results", { count: String(results.length) })}
                  </h3>
                  <button
                    onClick={clearResults}
                    className="text-[10px] text-gray-400 hover:text-red-500"
                  >
                    {t("assetGen.clearResults")}
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {results.map((item, idx) => {
                    const key = b64Key(item.image_b64);
                    const isSaved = savedSet.has(key);
                    const isSaving = savingKey === key;
                    return (
                      <div
                        key={`${item.description}-${idx}`}
                        className="group relative overflow-hidden rounded-2xl border border-outline-variant/10 bg-surface-container-lowest shadow-soft transition-shadow hover:shadow-float"
                      >
                        <div
                          className="relative flex cursor-pointer items-center justify-center bg-gray-50 p-3"
                          onClick={() => setPreviewSrc(item.image_b64)}
                        >
                          <img
                            src={`data:image/png;base64,${item.image_b64}`}
                            alt={item.description}
                            className="h-24 w-24 object-contain"
                          />
                          <div className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all group-hover:bg-black/5 group-hover:opacity-100">
                            <ZoomIn className="h-5 w-5 text-gray-500" />
                          </div>
                        </div>
                        <div className="border-t px-2.5 py-2">
                          <p className="truncate text-[11px] text-gray-600" title={item.description}>
                            {item.description}
                          </p>
                          {isSaved ? (
                            <button
                              disabled
                              className="mt-1.5 flex w-full items-center justify-center gap-1 rounded-md border border-amber-200 bg-amber-50 py-1 text-[10px] font-medium text-amber-700"
                            >
                              <Check className="h-3 w-3" />
                              {t("assetGen.added")}
                            </button>
                          ) : (
                            <button
                              onClick={() => openNamingDialog(item.image_b64, item.description)}
                              disabled={isSaving}
                              className="mt-1.5 flex w-full items-center justify-center gap-1 rounded-md border border-indigo-200 bg-indigo-50 py-1 text-[10px] font-medium text-indigo-600 transition-colors hover:bg-indigo-100 disabled:opacity-50"
                            >
                              {isSaving ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <Plus className="h-3 w-3" />
                              )}
                              {t("assetGen.addToAssets")}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Naming Dialog */}
      {namingItem && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30"
          onClick={() => setNamingItem(null)}
        >
          <div
            className="w-80 rounded-2xl bg-surface-container-lowest p-5 shadow-glass"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-3 text-sm font-semibold text-gray-800">{t("assetGen.nameAsset")}</h3>
            <input
              ref={namingInputRef}
              type="text"
              value={namingInput}
              onChange={(e) => setNamingInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmSave();
              }}
              placeholder={t("assetGen.inputName")}
              className="mb-4 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-200"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setNamingItem(null)}
                className="rounded-lg px-4 py-1.5 text-xs text-gray-500 hover:bg-gray-100"
              >
                {t("assetGen.cancel")}
              </button>
              <button
                onClick={confirmSave}
                disabled={!namingInput.trim()}
                className="rounded-lg bg-indigo-500 px-4 py-1.5 text-xs font-medium text-white hover:bg-indigo-600 disabled:opacity-50"
              >
                {t("assetGen.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Lightbox Preview */}
      {previewSrc && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 backdrop-blur-sm"
          onClick={() => setPreviewSrc(null)}
        >
          <button
            onClick={() => setPreviewSrc(null)}
            className="absolute right-4 top-4 rounded-full bg-black/50 p-2 text-white transition-colors hover:bg-black/80"
          >
            <X className="h-5 w-5" />
          </button>
          <img
            src={`data:image/png;base64,${previewSrc}`}
            alt="preview"
            className="max-h-[85vh] max-w-[85vw] rounded-lg object-contain shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}

function StyleGrid({
  selected,
  onSelect,
}: {
  selected: AssetStyle;
  onSelect: (s: AssetStyle) => void;
}) {
  const t = useT();
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium text-gray-700">{t("assetGen.styleSelect")}</label>
      <div className="grid grid-cols-5 gap-2">
        {STYLES.map((s) => (
          <button
            key={s.id}
            onClick={() => onSelect(s.id)}
            className={`flex flex-col items-center gap-1 rounded-xl border-2 px-2 py-2.5 transition-all ${
              selected === s.id
                ? "border-indigo-500 bg-indigo-50 shadow-sm"
                : "border-gray-100 bg-white hover:border-indigo-200 hover:bg-indigo-50/30"
            }`}
          >
            <StyleIcon styleId={s.id} active={selected === s.id} />
            <span
              className={`text-[10px] font-medium leading-tight ${
                selected === s.id ? "text-indigo-700" : "text-gray-600"
              }`}
            >
              {t(s.labelKey)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function StyleIcon({ styleId, active }: { styleId: AssetStyle; active: boolean }) {
  const color = active ? "#6366f1" : "#9ca3af";
  const size = 24;

  if (styleId === "none") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="9" stroke={color} strokeWidth={1.5} strokeDasharray="4 2" />
        <path d="M8 12h8" stroke={color} strokeWidth={1.5} strokeLinecap="round" />
      </svg>
    );
  }

  if (styleId === "custom") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <path
          d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"
          stroke={color}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"
          stroke={color}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  const strokeWidthMap: Record<string, number> = {
    thin_linear: 0.8,
    regular_linear: 1.5,
    bold_linear: 3,
    minimal_flat: 0,
    doodle: 1.5,
    hand_drawn: 1.2,
    illustration: 0,
    detailed_linear: 1,
    fine_linear: 0.5,
  };

  const sw = strokeWidthMap[styleId] ?? 1.5;
  const fill = ["minimal_flat", "illustration"].includes(styleId);

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path
        d="M12 2l2.4 7.2H22l-6 4.5 2.4 7.3L12 16.5 5.6 21l2.4-7.3-6-4.5h7.6z"
        stroke={color}
        strokeWidth={sw}
        fill={fill ? color : "none"}
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity={fill ? 0.8 : 1}
      />
    </svg>
  );
}
