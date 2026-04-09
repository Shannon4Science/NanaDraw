import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../contexts/LanguageContext";

interface SaveElementDialogProps {
  previewUrl: string;
  existingNames: string[];
  saving: boolean;
  onConfirm: (name: string) => void;
  onCancel: () => void;
  defaultName?: string;
}

export function SaveElementDialog({
  previewUrl,
  existingNames,
  saving,
  onConfirm,
  onCancel,
  defaultName = "",
}: SaveElementDialogProps) {
  const t = useT();
  const [name, setName] = useState(defaultName);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  const validate = useCallback(
    (value: string): string | null => {
      const trimmed = value.trim();
      if (!trimmed) return t("saveEl.emptyName");
      if (trimmed.length < 2) return t("saveEl.tooShort");
      if (trimmed.length > 64) return t("saveEl.tooLong");
      if (existingNames.some((n) => n.toLowerCase() === trimmed.toLowerCase())) {
        return t("saveEl.duplicate");
      }
      return null;
    },
    [existingNames, t],
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const err = validate(name);
      if (err) {
        setError(err);
        return;
      }
      onConfirm(name.trim());
    },
    [name, validate, onConfirm],
  );

  const handleChange = useCallback(
    (value: string) => {
      setName(value);
      if (error) setError(validate(value));
    },
    [error, validate],
  );

  return createPortal(
    <div
      className="fixed inset-0 z-[60000] flex items-center justify-center bg-black/15 backdrop-blur-[2px]"
      onClick={onCancel}
    >
      <div
        className="w-[400px] rounded-2xl bg-surface-container-lowest shadow-glass"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-outline-variant/10 px-5 py-3">
          <h3 className="font-headline text-sm font-bold text-on-surface">
            {t("saveEl.title")}
          </h3>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4">
          <div className="mb-4 flex items-center justify-center rounded-2xl border border-outline-variant/10 bg-surface-container-low p-3">
            <img
              src={previewUrl}
              alt="preview"
              className="max-h-32 max-w-full object-contain"
            />
          </div>

          <label className="mb-1 block text-xs font-medium text-on-surface-variant">
            {t("saveEl.nameLabel")}
          </label>
          <input
            ref={inputRef}
            type="text"
            value={name}
            onChange={(e) => handleChange(e.target.value)}
            placeholder={t("saveEl.namePlaceholder")}
            maxLength={64}
            disabled={saving}
            className={`w-full rounded-full border px-4 py-2 text-sm focus:outline-none transition-all ${
              error
                ? "border-error/30 focus:border-error/50"
                : "border-outline-variant/10 focus:border-primary/30 focus:ring-2 focus:ring-primary-container/30"
            }`}
          />
          {error && (
            <p className="mt-1 text-xs text-error">{error}</p>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={saving}
              className="rounded-full border border-outline-variant/10 px-4 py-1.5 text-xs font-bold text-on-surface-variant hover:bg-surface-container transition-all active:scale-95 disabled:opacity-50"
            >
              {t("saveEl.cancel")}
            </button>
            <button
              type="submit"
              disabled={saving || !name.trim()}
              className="flex items-center gap-1.5 rounded-full bg-primary px-4 py-1.5 text-xs font-bold text-on-primary hover:opacity-90 transition-all active:scale-95 disabled:opacity-50"
            >
              {saving && (
                <div className="h-3 w-3 animate-spin rounded-full border-2 border-on-primary border-t-transparent" />
              )}
              {t("saveEl.save")}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
