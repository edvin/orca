import { createSignal } from "solid-js";
import { componentsEn, componentsZhCN } from "./components";
import { corePagesEn, corePagesZhCN } from "./corePages";
import { infraPagesEn, infraPagesZhCN } from "./infraPages";
import { settingsDetailEn, settingsDetailZhCN } from "./settingsDetail";

export type Lang = "en" | "zh-CN";
export type TranslationParams = Record<string, unknown>;

const en: Record<string, string> = {
  ...componentsEn,
  ...corePagesEn,
  ...infraPagesEn,
  ...settingsDetailEn,
};

const zhCN: Record<string, string> = {
  ...componentsZhCN,
  ...corePagesZhCN,
  ...infraPagesZhCN,
  ...settingsDetailZhCN,
};

const dictionaries: Record<Lang, Record<string, string>> = {
  en,
  "zh-CN": zhCN,
};

function detectLang(): Lang {
  const saved = typeof localStorage !== "undefined" ? localStorage.getItem("orca-lang") : null;
  if (saved === "en" || saved === "zh-CN") return saved;
  if (typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("zh")) return "zh-CN";
  return "en";
}

const [lang, setLang] = createSignal<Lang>(detectLang());

export function t(key: string, params: TranslationParams = {}): string {
  const template = dictionaries[lang()][key] ?? en[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined || value === null ? match : String(value);
  });
}

export function changeLang(nextLang: Lang): void {
  setLang(nextLang);
  localStorage.setItem("orca-lang", nextLang);
  document.documentElement.lang = nextLang;
}

if (typeof document !== "undefined") {
  document.documentElement.lang = lang();
}

export { lang };
