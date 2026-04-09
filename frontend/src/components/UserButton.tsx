import { useCallback } from "react";
import { Link } from "react-router-dom";
import { FolderOpen, Globe } from "lucide-react";
import { useLanguage, useT } from "../contexts/LanguageContext";

export function LanguageSwitcher() {
  const { locale, setLocale } = useLanguage();
  const toggle = useCallback(() => {
    setLocale(locale === "zh" ? "en" : "zh");
  }, [locale, setLocale]);
  return (
    <button
      onClick={toggle}
      className="flex items-center gap-1.5 rounded-full bg-white px-3.5 py-2 text-[13px] font-semibold text-stone-500 shadow-[0_2px_8px_rgba(0,0,0,0.08)] transition-all hover:shadow-[0_4px_12px_rgba(0,0,0,0.12)] hover:text-stone-700 active:scale-95"
      title={locale === "zh" ? "Switch to English" : "切换到中文"}
    >
      <Globe className="h-4 w-4" />
      {locale === "zh" ? "EN" : "中"}
    </button>
  );
}

export function UserButton() {
  const t = useT();
  return (
    <Link
      to="/projects"
      className="flex items-center gap-1.5 rounded-full bg-white px-3.5 py-2 text-[13px] font-semibold text-stone-500 shadow-[0_2px_8px_rgba(0,0,0,0.08)] transition-all hover:shadow-[0_4px_12px_rgba(0,0,0,0.12)] hover:text-stone-700 active:scale-95"
    >
      <FolderOpen className="h-4 w-4" />
      {t("user.myProjects")}
    </Link>
  );
}
