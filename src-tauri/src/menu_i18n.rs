//! Translation for strings the native side renders itself.
//!
//! The GUI translates through `t()` in `gui/src/lib/i18n.ts`, which lives in the
//! webview. Native menus (the tray) are built in Rust and never reach it, so they
//! need their own lookup. This is deliberately a *language table*, not a
//! Chinese-only path: `TRANSLATIONS` maps a locale code to its dictionary, and
//! adding a language means adding one entry there plus a column in `MESSAGES`.
//! Only Simplified Chinese is populated today.
//!
//! The dictionary is intentionally small — it covers just the strings the native
//! side owns (tray menu items and tooltip), not a second copy of the GUI's 3000
//! entries. `i18n-port.mjs --rust` reports any native menu text that is missing
//! here, so the two cannot drift silently.
//!
//! The active locale is whatever the GUI last pushed through the
//! `set_menu_locale` command. It is stored beside the Orca config, so both sides
//! agree on one directory and the choice survives a restart. Reading it never
//! fails: an absent or unreadable file means English.

use std::path::PathBuf;
use std::sync::RwLock;

/// Directory the GUI and the native side share for locale state.
fn locale_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("orca")
}

fn locale_file() -> PathBuf {
    locale_dir().join("menu-locale")
}

/// The locale used when nothing is stored, or the stored value is unsupported.
const DEFAULT_LOCALE: &str = "en";

/// One translatable native string per row: the English source text, then its
/// translation in each supported language, in the order of `LOCALE_COLUMNS`.
///
/// A blank entry falls back to the English source, matching the GUI's rule that a
/// missing key must never break the interface.
const LOCALE_COLUMNS: &[&str] = &["zh-CN"];

const MESSAGES: &[(&str, &[&str])] = &[
    //  source                      zh-CN
    ("Running instances", &["运行中的实例"]),
    ("Show Orca", &["显示 Orca"]),
    ("Hide Window", &["隐藏窗口"]),
    ("Quit Orca", &["退出 Orca"]),
    ("Orca — Container Desktop", &["Orca — 容器桌面"]),
    ("Open {url}", &["打开 {url}"]),
];

/// Is `code` a language this build can render? English always counts.
pub fn is_supported(code: &str) -> bool {
    code == DEFAULT_LOCALE || LOCALE_COLUMNS.contains(&code)
}

/// `None` means "not read from disk yet", so an empty file is not re-read per call.
static LOCALE: RwLock<Option<String>> = RwLock::new(None);

/// The active locale, cached for the life of the process.
///
/// Anything unsupported resolves to `DEFAULT_LOCALE` rather than being used as a
/// lookup key, so a stale or hand-edited file cannot produce an unknown state.
fn current() -> String {
    if let Ok(guard) = LOCALE.read()
        && let Some(v) = guard.as_ref()
    {
        return v.clone();
    }
    let stored = std::fs::read_to_string(locale_file()).unwrap_or_default();
    let stored = stored.trim();
    let value = if is_supported(stored) { stored } else { DEFAULT_LOCALE }.to_string();
    if let Ok(mut guard) = LOCALE.write() {
        *guard = Some(value.clone());
    }
    value
}

/// Persist the locale the GUI just switched to.
///
/// Called only from the `set_menu_locale` command. A write failure is not fatal:
/// the menu keeps using whatever it has until the next successful write.
pub fn set_locale(locale: &str) {
    if let Ok(mut guard) = LOCALE.write() {
        *guard = Some(locale.to_string());
    }
    let dir = locale_dir();
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(locale_file(), locale);
}

/// Translate an English menu string into the active locale.
pub fn tr(text: &str) -> String {
    let locale = current();
    if locale == DEFAULT_LOCALE {
        return text.to_string();
    }
    let Some(column) = LOCALE_COLUMNS.iter().position(|c| c == &locale) else {
        return text.to_string();
    };
    for (source, translations) in MESSAGES {
        if *source == text {
            return match translations.get(column) {
                Some(t) if !t.is_empty() => t.to_string(),
                _ => text.to_string(),
            };
        }
    }
    text.to_string()
}

/// Translate a template such as `"Open {url}"` and fill in its placeholder.
pub fn tr_with(text: &str, key: &str, value: &str) -> String {
    tr(text).replace(&format!("{{{key}}}"), value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn english_passes_through() {
        assert_eq!(tr("Show Orca"), "Show Orca");
    }

    #[test]
    fn unknown_text_falls_back_to_source() {
        assert_eq!(tr("Not in the table"), "Not in the table");
    }

    #[test]
    fn placeholders_are_substituted() {
        assert_eq!(tr_with("Open {url}", "url", "http://x"), "Open http://x");
    }

    #[test]
    fn unsupported_locale_is_rejected() {
        assert!(!is_supported("xx-YY"));
        assert!(is_supported("zh-CN"));
        assert!(is_supported("en"));
    }

    #[test]
    fn every_row_has_one_translation_per_column() {
        for (source, translations) in MESSAGES {
            assert_eq!(
                translations.len(),
                LOCALE_COLUMNS.len(),
                "{source} has the wrong number of translations"
            );
        }
    }
}
