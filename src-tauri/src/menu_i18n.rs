//! Translation for strings the native side renders itself.
//!
//! The GUI translates through `t()` in `gui/src/lib/i18n.ts`, which lives in the
//! webview. Native menus (the tray) are built in Rust and never reach it, so they
//! need their own lookup.
//!
//! ## Adding a language
//!
//! Drop `gui/src/lib/locales/<bcp47>.json`. Nothing here changes: `build.rs`
//! mirrors that directory into `NATIVE_LOCALES` at compile time, and both the
//! GUI and this module then serve the new language.
//!
//! ## Which strings live here
//!
//! Only the ones the native side owns — tray menu items and the tooltip. English
//! source text is the key, matching the GUI, so a missing entry falls back to
//! English instead of showing nothing.
//!
//! ## Where the active locale comes from
//!
//! `localStorage` is webview-only, so Rust cannot read the GUI's setting. The GUI
//! pushes it through the `set_menu_locale` command and this module persists it
//! beside the Orca config, so the two sides agree on one directory and the choice
//! survives a restart. Reading never fails: an absent or unreadable file means
//! English.

use std::path::PathBuf;
use std::sync::RwLock;

include!(concat!(env!("OUT_DIR"), "/native_locales.rs"));

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

/// Is `code` a language this build can render? English always counts.
pub fn is_supported(code: &str) -> bool {
    code == DEFAULT_LOCALE || NATIVE_LOCALE_CODES.contains(&code)
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
///
/// Falls back to the source text when the locale is English or the string has no
/// entry, matching the GUI's rule that a missing key must never break the UI.
pub fn tr(text: &str) -> String {
    let locale = current();
    if locale == DEFAULT_LOCALE {
        return text.to_string();
    }
    let Some((_, table)) = NATIVE_LOCALES.iter().find(|(code, _)| *code == locale) else {
        return text.to_string();
    };
    for (source, translated) in table.iter() {
        if *source == text && !translated.is_empty() {
            return translated.to_string();
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
    use std::sync::Mutex;

    /// The active locale is process-global, so tests that change it must not
    /// interleave. Cargo runs test functions on parallel threads by default; this
    /// mutex gives each one a stable locale for its body.
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    /// Run `body` with the active locale pinned to `locale`, restoring English.
    fn with_locale<T>(locale: &str, body: impl FnOnce() -> T) -> T {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        set_locale(locale);
        let out = body();
        set_locale(DEFAULT_LOCALE);
        out
    }

    #[test]
    fn english_passes_through() {
        with_locale(DEFAULT_LOCALE, || assert_eq!(tr("Show Orca"), "Show Orca"));
    }

    #[test]
    fn unknown_text_falls_back_to_source() {
        with_locale(DEFAULT_LOCALE, || {
            assert_eq!(tr("Not in any locale file"), "Not in any locale file")
        });
    }

    #[test]
    fn placeholders_are_substituted() {
        with_locale(DEFAULT_LOCALE, || {
            assert_eq!(tr_with("Open {url}", "url", "http://x"), "Open http://x")
        });
        with_locale("zh-CN", || {
            assert_eq!(tr_with("Open {url}", "url", "http://x"), "打开 http://x")
        });
    }

    #[test]
    fn unsupported_locale_is_rejected() {
        assert!(!is_supported("xx-YY"));
        assert!(is_supported("en"));
    }

    #[test]
    fn chinese_locale_is_discovered_from_disk() {
        // Proves build.rs found the file: the code is not hard-coded anywhere.
        assert!(
            NATIVE_LOCALE_CODES.contains(&"zh-CN"),
            "zh-CN.json should be discovered, got {:?}",
            NATIVE_LOCALE_CODES
        );
        assert!(is_supported("zh-CN"));
    }

    #[test]
    fn native_strings_are_translated() {
        with_locale("zh-CN", || {
            assert_eq!(tr("Show Orca"), "显示 Orca");
            assert_eq!(tr("Quit Orca"), "退出 Orca");
        });
    }

    #[test]
    fn every_generated_row_matches_the_source_key() {
        // Guards the build.rs parser: a mangled key would silently stop
        // translating, which no runtime assertion would catch.
        for (code, table) in NATIVE_LOCALES {
            for (source, _) in table.iter() {
                assert!(
                    !source.is_empty(),
                    "{code} has an empty source key"
                );
                assert!(
                    !source.contains("\\\""),
                    "{code} key still contains an escape: {source}"
                );
            }
        }
    }
}
