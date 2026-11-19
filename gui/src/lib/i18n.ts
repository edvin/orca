import { createSignal } from "solid-js";
import { zhCN } from "./locales/zh-CN";

/**
 * Tiny reactive i18n for the Orca GUI.
 *
 * Design: English source strings are their own keys (`t("Containers")`).
 * Each non-English locale provides a dictionary mapping the English source
 * string to its translation; missing keys transparently fall back to English,
 * so partial locale files never break the UI.
 *
 * Adding a language = adding a dictionary module in `lib/locales/` and
 * registering it in `DICTIONARIES` + `AVAILABLE_LOCALES` below.
 */

export type Locale = "en" | "zh-CN";

export interface LocaleInfo {
  code: Locale;
  /** Native name shown in the language switcher */
  nativeLabel: string;
  /** English name (for tooltips / logs) */
  label: string;
}

export const AVAILABLE_LOCALES: LocaleInfo[] = [
  { code: "en", nativeLabel: "English", label: "English" },
  { code: "zh-CN", nativeLabel: "简体中文", label: "Chinese (Simplified)" },
];

const DICTIONARIES: Partial<Record<Locale, Record<string, string>>> = {
  "zh-CN": zhCN,
};

const STORAGE_KEY = "orca.locale";

function isLocale(value: unknown): value is Locale {
  return AVAILABLE_LOCALES.some((l) => l.code === value);
}

function detectLocale(): Locale {
  const langs =
    typeof navigator !== "undefined"
      ? [...(navigator.languages ?? []), navigator.language]
      : [];
  for (const lang of langs) {
    if (!lang) continue;
    const lower = lang.toLowerCase();
    const exact = AVAILABLE_LOCALES.find((l) => l.code.toLowerCase() === lower);
    if (exact) return exact.code;
    const [base] = lower.split("-");
    if (base === "zh") return "zh-CN";
  }
  return "en";
}

const [locale, setLocaleSignal] = createSignal<Locale>(readSavedLocale());

function readSavedLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLocale(saved)) return saved;
  } catch {}
  return detectLocale();
}

export function getLocale(): Locale {
  return locale();
}

export function setLocale(next: Locale): void {
  setLocaleSignal(next);
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {}
  if (typeof document !== "undefined") document.documentElement.lang = next;
}

/**
 * Translate a source string into the active locale.
 * Reactive when used inside SolidJS JSX templates.
 *
 * `t("Container {name} started", { name })` performs `{param}` interpolation.
 */
export function t(text: string, params?: Record<string, unknown>): string {
  const dict = DICTIONARIES[locale()];
  let out = dict?.[text] ?? text;
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      out = out.split(`{${key}}`).join(String(value));
    }
  }
  return out;
}

if (typeof document !== "undefined") document.documentElement.lang = locale();
