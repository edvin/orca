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
 * Adding a language is meant to be a one-file change: drop a dictionary module
 * in `lib/locales/` and add one entry to `AVAILABLE_LOCALES` below. Everything
 * else — the switcher, browser detection and the native menu — reads from that
 * list, so nothing else enumerates locales by name.
 *
 * `DICTIONARIES` is assembled from `AVAILABLE_LOCALES` rather than written out
 * separately, so the two can never disagree about which language exists.
 */

/**
 * The locale codes that ship with a dictionary.
 *
 * Widening this is the one change a new language needs here; `Locale` is derived
 * from the `AVAILABLE_LOCALES` list below so that omitting an entry is a type
 * error rather than a silently unreachable language.
 */
const DICTIONARY_MODULES = {
  "zh-CN": zhCN,
} as const;

export type Locale = "en" | keyof typeof DICTIONARY_MODULES;

export interface LocaleInfo {
  code: Locale;
  /** Native name shown in the language switcher */
  nativeLabel: string;
  /** English name (for tooltips / logs) */
  label: string;
}

/**
 * Each entry pairs a code with the BCP 47 tags it should answer to.
 *
 * The tags drive detection, which previously special-cased Chinese with a
 * literal `if (base === "zh")`. A language whose browser tag is a bare base
 * language (no region) declares that tag here — `zh` matches `zh-CN`, `pt`
 * matches `pt-BR` — and a regional variant only matches itself plus its base.
 */
interface LocaleEntry extends LocaleInfo {
  /** Tags accepted during detection, lower-cased, most specific first. */
  match: readonly string[];
}

const LOCALES: readonly LocaleEntry[] = [
  {
    code: "en",
    nativeLabel: "English",
    label: "English",
    match: ["en"],
  },
  {
    code: "zh-CN",
    nativeLabel: "简体中文",
    label: "Chinese (Simplified)",
    // `zh` so a browser reporting plain "zh" (no region) still lands on Simplified
    // rather than falling through to English.
    match: ["zh-cn", "zh-hans", "zh"],
  },
];

export const AVAILABLE_LOCALES: LocaleInfo[] = LOCALES.map(({ code, nativeLabel, label }) => ({
  code,
  nativeLabel,
  label,
}));

const DICTIONARIES: Partial<Record<Locale, Record<string, string>>> = DICTIONARY_MODULES;

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
    // A declared tag matches exactly, or as the region-less prefix of a
    // regional tag (`en` accepts `en-GB`, `zh-CN` does not accept `zh-TW`).
    for (const entry of LOCALES) {
      for (const tag of entry.match) {
        if (lower === tag || (tag.includes("-") ? false : lower.split("-")[0] === tag)) {
          return entry.code;
        }
      }
    }
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
  syncNativeLocale(next);
}

/**
 * Tell the native side about the new locale.
 *
 * `localStorage` is webview-only, so the Rust-built tray menu cannot read it.
 * This forwards the setting on every change; the native side persists it beside
 * the Orca config and rebuilds its menu. A failure is swallowed deliberately:
 * the interface is already translated, and a missed menu update must not turn a
 * language switch into an error.
 */
export function syncNativeLocale(locale: Locale): void {
  if (typeof window === "undefined") return;
  const internals = (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  if (!internals) return; // Running in a plain browser (tests, vite dev).
  import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke("set_menu_locale", { locale }))
    .catch(() => {});
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

// The tray menu is built during native startup, before any webview code runs, so
// it always begins in English. Push the persisted choice once here to bring it in
// line without waiting for the user to switch languages again.
syncNativeLocale(locale());
