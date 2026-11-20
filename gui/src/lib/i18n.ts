/**
 * Tiny reactive i18n for the Orca GUI.
 *
 * Design: English source strings are their own keys (`t("Containers")`).
 * Each non-English locale provides a dictionary mapping the English source
 * string to its translation; missing keys transparently fall back to English,
 * so partial locale files never break the UI.
 *
 * ## Adding a language
 *
 * Drop `lib/locales/<bcp47>.json` next to the others. Nothing else — this file
 * discovers the directory at build time via `import.meta.glob`, and
 *
 *     src-tauri/src/menu_i18n.rs
 *
 * reads the same directory from `src-tauri/build.rs`, so the native tray menu
 * picks the language up too. The file name is the locale code (`zh-CN.json` ->
 * `zh-CN`) and must be valid BCP 47.
 *
 * A locale file is a flat `{ "English source": "translation" }` map plus an
 * optional `$meta` block:
 *
 *     {
 *       "$meta": {
 *         "nativeLabel": "简体中文",
 *         "label": "Chinese (Simplified)",
 *         "match": ["zh-cn", "zh-hans", "zh"]
 *       },
 *       "Containers": "容器"
 *     }
 *
 * `nativeLabel` is shown in the language switcher (so it reads in its own
 * language), `label` is the English name for tooltips and logs, and `match`
 * lists the browser tags detection should accept. Omitting `$meta` is legal:
 * the code is the file name and the English name defaults to it.
 */
import { createSignal } from "solid-js";

/** Shape of a `lib/locales/*.json` file. */
interface LocaleFile {
  $meta?: {
    nativeLabel?: string;
    label?: string;
    /** BCP 47 tags, lower-cased, that detection should map to this locale. */
    match?: string[];
  };
  [source: string]: unknown;
}

/**
 * Every `lib/locales/*.json`, keyed by path. `eager` so the dictionaries are
 * bundled rather than fetched, and so the set is known synchronously at import.
 */
const LOCALE_FILES = import.meta.glob<LocaleFile>("./locales/*.json", {
  eager: true,
  import: "default",
});

/** `"zh-CN"` from `"./locales/zh-CN.json"`. The file name is the locale code. */
function codeOf(globPath: string): string {
  return globPath.slice(globPath.lastIndexOf("/") + 1, -".json".length);
}

export interface LocaleInfo {
  code: string;
  /** Native name shown in the language switcher */
  nativeLabel: string;
  /** English name (for tooltips / logs) */
  label: string;
}

interface ResolvedLocale extends LocaleInfo {
  /** Lower-cased tags accepted during detection, most specific first. */
  match: string[];
  dictionary: Record<string, string>;
}

/**
 * Locales derived from the files on disk, English first.
 *
 * English has no file: its "dictionary" is the source text itself, so it is
 * always available and cannot be missing.
 */
const LOCALES: ResolvedLocale[] = [
  { code: "en", nativeLabel: "English", label: "English", match: ["en"], dictionary: {} },
  ...Object.entries(LOCALE_FILES)
    .map(([globPath, raw]): ResolvedLocale => {
      const code = codeOf(globPath);
      const meta = raw.$meta ?? {};
      const { $meta: _ignored, ...entries } = raw;
      const dictionary: Record<string, string> = {};
      for (const [source, value] of Object.entries(entries)) {
        if (typeof value === "string") dictionary[source] = value;
      }
      return {
        code,
        nativeLabel: meta.nativeLabel ?? code,
        label: meta.label ?? code,
        // A locale with no declared tags is still reachable by its exact code.
        match: (meta.match ?? [code.toLowerCase()]).map((t) => t.toLowerCase()),
        dictionary,
      };
    })
    // Stable order independent of directory iteration.
    .sort((a, b) => a.code.localeCompare(b.code)),
];

export type Locale = string;

export const AVAILABLE_LOCALES: LocaleInfo[] = LOCALES.map(({ code, nativeLabel, label }) => ({
  code,
  nativeLabel,
  label,
}));

const DICTIONARIES: Record<string, Record<string, string>> = Object.fromEntries(
  LOCALES.map((l) => [l.code, l.dictionary]),
);

const STORAGE_KEY = "orca.locale";

/** The fallback locale. Its "dictionary" is empty, so lookups return the key. */
const DEFAULT_LOCALE = "en";

function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && LOCALES.some((l) => l.code === value);
}

function detectLocale(): Locale {
  const langs =
    typeof navigator !== "undefined"
      ? [...(navigator.languages ?? []), navigator.language]
      : [];
  for (const lang of langs) {
    if (!lang) continue;
    const lower = lang.toLowerCase();
    const base = lower.split("-")[0];
    for (const entry of LOCALES) {
      for (const tag of entry.match) {
        // An exact tag matches; a regionless tag also matches its variants
        // (`en` accepts `en-GB`) but a regional one does not (`zh-CN` rejects
        // `zh-TW`, so a Traditional Chinese browser falls through to English
        // rather than getting Simplified).
        if (lower === tag || (!tag.includes("-") && base === tag)) return entry.code;
      }
    }
  }
  return DEFAULT_LOCALE;
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
