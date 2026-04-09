import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import zh, { type TranslationKey } from "../i18n/zh";
import en from "../i18n/en";

export type Locale = "zh" | "en";

interface LanguageState {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
}

const dictionaries: Record<Locale, Record<TranslationKey, string>> = { zh, en };
const STORAGE_KEY = "nanadraw_locale";

function detectInitialLocale(): Locale {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "en" || stored === "zh") return stored;
  const nav = navigator.language.toLowerCase();
  return nav.startsWith("zh") ? "zh" : "en";
}

const LanguageContext = createContext<LanguageState>({
  locale: "zh",
  setLocale: () => {},
  t: (key: TranslationKey) => String(key),
});

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleRaw] = useState<Locale>(detectInitialLocale);

  const setLocale = useCallback((l: Locale) => {
    setLocaleRaw(l);
    localStorage.setItem(STORAGE_KEY, l);
  }, []);

  const t = useCallback(
    (key: TranslationKey, vars?: Record<string, string | number>) => {
      let text = dictionaries[locale]?.[key] ?? dictionaries.zh[key] ?? key;
      if (vars) {
        for (const [k, v] of Object.entries(vars)) {
          text = text.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
        }
      }
      return text;
    },
    [locale],
  );

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  return (
    <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useLanguage() {
  return useContext(LanguageContext);
}

// eslint-disable-next-line react-refresh/only-export-components
export function useT() {
  return useContext(LanguageContext).t;
}

/** Alias for i18n consumers that expect a `useTranslation`-style hook name. */
// eslint-disable-next-line react-refresh/only-export-components
export function useTranslation() {
  return useContext(LanguageContext).t;
}

// eslint-disable-next-line react-refresh/only-export-components
export function tStandalone(key: TranslationKey, vars?: Record<string, string | number>): string {
  const stored = localStorage.getItem(STORAGE_KEY);
  const locale: Locale =
    stored === "en" || stored === "zh"
      ? stored
      : navigator.language.toLowerCase().startsWith("zh")
        ? "zh"
        : "en";
  let text = dictionaries[locale]?.[key] ?? dictionaries.zh[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return text;
}
