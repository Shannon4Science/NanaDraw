import { Download, FileImage, FileType, Presentation } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../contexts/LanguageContext";

interface ExportPanelProps {
  onExportSvg: () => void;
  onExportPng: () => void;
  onExportPptx: () => void;
}

export function ExportPanel({
  onExportSvg,
  onExportPng,
  onExportPptx,
}: ExportPanelProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handlePptx = useCallback(() => {
    setExporting(true);
    try {
      onExportPptx();
    } finally {
      setTimeout(() => setExporting(false), 2000);
    }
    setOpen(false);
  }, [onExportPptx]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-full bg-white px-3.5 py-2 text-[13px] font-semibold text-stone-600 shadow-[0_2px_8px_rgba(0,0,0,0.08)] transition-all hover:shadow-[0_4px_12px_rgba(0,0,0,0.12)] active:scale-95"
        data-testid="export-btn"
      >
        <Download className="h-3.5 w-3.5" />
        {t("export.export")}
        <svg className="h-3 w-3 text-stone-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-48 overflow-hidden rounded-sm border border-stone-200 bg-white py-1 shadow-lg">
          <button
            onClick={() => { onExportSvg(); setOpen(false); }}
            className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-[13px] font-medium text-stone-600 transition-colors hover:bg-stone-50"
            data-testid="export-svg"
          >
            <FileType className="h-4 w-4 text-stone-400" />
            SVG
          </button>
          <button
            onClick={() => { onExportPng(); setOpen(false); }}
            className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-[13px] font-medium text-stone-600 transition-colors hover:bg-stone-50"
            data-testid="export-png"
          >
            <FileImage className="h-4 w-4 text-stone-400" />
            PNG
          </button>
          <button
            onClick={handlePptx}
            disabled={exporting}
            className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-[13px] font-medium text-orange-600 transition-colors hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="export-pptx"
          >
            <Presentation className="h-4 w-4 text-orange-400" />
            {exporting ? t("export.exporting") : "PPT"}
          </button>
        </div>
      )}
    </div>
  );
}
