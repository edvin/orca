//! Connecting AI tools (Claude Code, Claude Desktop, Cursor, VS Code,
//! Windsurf, Codex) to Orca's MCP server.
//!
//! Each tool starts `orca mcp` itself and talks MCP over stdio. That command
//! reads Orca's API token from the local config, so no tool's config holds a
//! secret and nobody copies tokens around. Connecting means adding an `orca`
//! entry to the tool's own MCP config; everything else in it is kept.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// Name of the server entry in every tool's config.
pub const SERVER_NAME: &str = "orca";

#[derive(Debug, Clone, Serialize)]
pub struct ClientStatus {
    pub id: &'static str,
    pub name: &'static str,
    /// The tool looks installed on this machine.
    pub detected: bool,
    /// Its config has an `orca` server.
    pub connected: bool,
    /// The file Orca changes.
    pub config_path: String,
    /// What to do after connecting, when there's something.
    pub after_connect: Option<&'static str>,
}

#[derive(Clone, Copy)]
enum Format {
    /// `{ "<key>": { "orca": { "command", "args" } } }`
    Json { key: &'static str, with_type: bool },
    /// `[mcp_servers.orca]` in TOML.
    CodexToml,
}

struct Client {
    id: &'static str,
    name: &'static str,
    path: fn() -> Option<PathBuf>,
    /// Folder (or program on PATH) whose presence means the tool is installed.
    detect: fn() -> bool,
    format: Format,
    after_connect: Option<&'static str>,
}

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

/// `Code/User` and friends: under Application Support on macOS, %APPDATA% on
/// Windows, ~/.config on Linux.
fn app_config(sub: &str) -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join(sub))
}

/// The `claude` CLI. An app started from the Dock or Finder gets a minimal
/// PATH, so the usual install places are tried too.
fn claude_cli_path() -> Option<PathBuf> {
    let names: &[&str] = if cfg!(windows) {
        &["claude.cmd", "claude.exe"]
    } else {
        &["claude"]
    };
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    let h = home();
    dirs.extend([
        h.join(".local").join("bin"),
        h.join(".claude").join("local"),
        h.join(".npm-global").join("bin"),
        h.join(".bun").join("bin"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ]);
    if let Some(appdata) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(appdata).join("npm"));
    }
    dirs.iter()
        .flat_map(|d| names.iter().map(move |n| d.join(n)))
        .find(|p| p.is_file())
}

fn on_path(program: &str) -> bool {
    let exe = if cfg!(windows) {
        format!("{program}.exe")
    } else {
        program.to_string()
    };
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).any(|d| d.join(&exe).is_file()))
        .unwrap_or(false)
}

fn clients() -> Vec<Client> {
    vec![
        Client {
            id: "claude-code",
            name: "Claude Code",
            path: || Some(home().join(".claude.json")),
            detect: || {
                claude_cli_path().is_some() || home().join(".claude.json").exists() || home().join(".claude").is_dir()
            },
            format: Format::Json {
                key: "mcpServers",
                with_type: true,
            },
            after_connect: Some("New Claude Code sessions have Orca's tools. Run /mcp in a session to check."),
        },
        Client {
            id: "claude-desktop",
            name: "Claude Desktop",
            path: || app_config("Claude").map(|d| d.join("claude_desktop_config.json")),
            detect: || app_config("Claude").is_some_and(|d| d.is_dir()),
            format: Format::Json {
                key: "mcpServers",
                with_type: false,
            },
            after_connect: Some("Quit and reopen Claude Desktop to load Orca."),
        },
        Client {
            id: "cursor",
            name: "Cursor",
            path: || Some(home().join(".cursor").join("mcp.json")),
            detect: || home().join(".cursor").is_dir(),
            format: Format::Json {
                key: "mcpServers",
                with_type: false,
            },
            after_connect: Some("Cursor picks it up under Settings → MCP."),
        },
        Client {
            id: "vscode",
            name: "VS Code",
            path: || app_config("Code").map(|d| d.join("User").join("mcp.json")),
            detect: || app_config("Code").is_some_and(|d| d.join("User").is_dir()),
            format: Format::Json {
                key: "servers",
                with_type: true,
            },
            after_connect: Some("Use it from Copilot Chat in agent mode."),
        },
        Client {
            id: "windsurf",
            name: "Windsurf",
            path: || Some(home().join(".codeium").join("windsurf").join("mcp_config.json")),
            detect: || home().join(".codeium").join("windsurf").is_dir(),
            format: Format::Json {
                key: "mcpServers",
                with_type: false,
            },
            after_connect: Some("Refresh the MCP servers in Windsurf's Cascade panel."),
        },
        Client {
            id: "codex",
            name: "Codex",
            path: || Some(home().join(".codex").join("config.toml")),
            detect: || on_path("codex") || home().join(".codex").is_dir(),
            format: Format::CodexToml,
            after_connect: Some("New Codex sessions have Orca's tools."),
        },
    ]
}

fn find(id: &str) -> anyhow::Result<Client> {
    clients()
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| anyhow::anyhow!("unknown AI tool '{id}' (known: {})", ids().join(", ")))
}

/// Every known tool's id, for help text.
pub fn ids() -> Vec<&'static str> {
    clients().iter().map(|c| c.id).collect()
}

/// Where each tool stands.
pub fn status() -> Vec<ClientStatus> {
    clients()
        .into_iter()
        .map(|c| {
            let path = (c.path)();
            ClientStatus {
                id: c.id,
                name: c.name,
                detected: (c.detect)(),
                connected: path.as_deref().is_some_and(|p| has_server(c.format, p)),
                config_path: path.map(|p| p.display().to_string()).unwrap_or_default(),
                after_connect: c.after_connect,
            }
        })
        .collect()
}

fn has_server(format: Format, path: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(path) else {
        return false;
    };
    match format {
        Format::Json { key, .. } => serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| v.get(key)?.get(SERVER_NAME).cloned())
            .is_some(),
        Format::CodexToml => text
            .parse::<toml_edit::DocumentMut>()
            .ok()
            .is_some_and(|d| d.get("mcp_servers").and_then(|m| m.get(SERVER_NAME)).is_some()),
    }
}

/// Add Orca to a tool's config, running `command args…`. Returns what to do next.
pub fn connect(id: &str, command: &Path, args: &[&str]) -> anyhow::Result<String> {
    let c = find(id)?;
    // Claude Code rewrites ~/.claude.json itself; its own CLI avoids racing it.
    if c.id == "claude-code" && claude_cli_path().is_some() {
        let _ = claude_cli(&["mcp", "remove", "--scope", "user", SERVER_NAME]);
        let mut cli_args = vec!["mcp", "add", "--scope", "user", SERVER_NAME, "--"];
        let cmd = command.to_string_lossy().to_string();
        cli_args.push(&cmd);
        cli_args.extend_from_slice(args);
        claude_cli(&cli_args)?;
        return Ok(c.after_connect.unwrap_or("Connected.").to_string());
    }
    let path = (c.path)().ok_or_else(|| anyhow::anyhow!("no config folder for {} on this system", c.name))?;
    let command = command.to_string_lossy().to_string();
    match c.format {
        Format::Json { key, with_type } => {
            let mut entry = serde_json::json!({ "command": command, "args": args });
            if with_type {
                entry["type"] = "stdio".into();
            }
            edit_json(&path, |root| {
                let servers = root
                    .entry(key)
                    .or_insert_with(|| serde_json::json!({}))
                    .as_object_mut()
                    .ok_or_else(|| anyhow::anyhow!("'{key}' in {} is not an object", path.display()))?;
                servers.insert(SERVER_NAME.into(), entry.clone());
                Ok(())
            })?;
        }
        Format::CodexToml => {
            let mut table = toml_edit::Table::new();
            table["command"] = toml_edit::value(command);
            table["args"] = toml_edit::value(args.iter().copied().collect::<toml_edit::Array>());
            edit_toml(&path, Some(table))?;
        }
    }
    Ok(c.after_connect.unwrap_or("Connected.").to_string())
}

/// Remove Orca from a tool's config.
pub fn disconnect(id: &str) -> anyhow::Result<()> {
    let c = find(id)?;
    if c.id == "claude-code" && claude_cli_path().is_some() {
        return claude_cli(&["mcp", "remove", "--scope", "user", SERVER_NAME]).map(|_| ());
    }
    let Some(path) = (c.path)() else { return Ok(()) };
    if !path.exists() {
        return Ok(());
    }
    match c.format {
        Format::Json { key, .. } => edit_json(&path, |root| {
            if let Some(servers) = root.get_mut(key).and_then(|v| v.as_object_mut()) {
                servers.remove(SERVER_NAME);
            }
            Ok(())
        }),
        Format::CodexToml => edit_toml(&path, None),
    }
}

fn claude_cli(args: &[&str]) -> anyhow::Result<String> {
    let claude = claude_cli_path().ok_or_else(|| anyhow::anyhow!("the claude command wasn't found"))?;
    let out = std::process::Command::new(claude)
        .args(args)
        .output()
        .map_err(|e| anyhow::anyhow!("could not run claude: {e}"))?;
    if !out.status.success() {
        anyhow::bail!(
            "claude {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Read a JSON object file (or start one), change it, and write it back
/// atomically. A file that isn't plain JSON (VS Code allows comments) is
/// left alone with an error rather than rewritten. If the tool rewrote the
/// file meanwhile, the change is made again on its new content.
fn edit_json(
    path: &Path,
    change: impl Fn(&mut serde_json::Map<String, serde_json::Value>) -> anyhow::Result<()>,
) -> anyhow::Result<()> {
    edit_text(path, |text| {
        let mut root = if text.trim().is_empty() {
            serde_json::Map::new()
        } else {
            match serde_json::from_str::<serde_json::Value>(text) {
                Ok(serde_json::Value::Object(m)) => m,
                _ => anyhow::bail!(
                    "{} isn't plain JSON (it may have comments), so Orca won't rewrite it. Add the server by hand.",
                    path.display()
                ),
            }
        };
        change(&mut root)?;
        Ok(serde_json::to_string_pretty(&serde_json::Value::Object(root))? + "\n")
    })
}

/// Set (or remove, with `None`) `[mcp_servers.orca]` in a TOML file,
/// keeping everything else, comments included, as written.
fn edit_toml(path: &Path, table: Option<toml_edit::Table>) -> anyhow::Result<()> {
    edit_text(path, |text| {
        let mut doc: toml_edit::DocumentMut = text
            .parse()
            .map_err(|e| anyhow::anyhow!("{} isn't valid TOML, so Orca won't rewrite it: {e}", path.display()))?;
        match &table {
            Some(t) => {
                if !doc.contains_key("mcp_servers") {
                    let mut servers = toml_edit::Table::new();
                    servers.set_implicit(true);
                    doc["mcp_servers"] = toml_edit::Item::Table(servers);
                }
                let servers = doc["mcp_servers"]
                    .as_table_like_mut()
                    .ok_or_else(|| anyhow::anyhow!("mcp_servers in {} is not a table", path.display()))?;
                servers.insert(SERVER_NAME, toml_edit::Item::Table(t.clone()));
            }
            None => {
                if let Some(servers) = doc.get_mut("mcp_servers").and_then(|m| m.as_table_like_mut()) {
                    servers.remove(SERVER_NAME);
                }
            }
        }
        Ok(doc.to_string())
    })
}

/// Rewrite a config file another program also writes: read, change, and
/// replace it only if it still holds what was read, else start over.
fn edit_text(path: &Path, change: impl Fn(&str) -> anyhow::Result<String>) -> anyhow::Result<()> {
    for _ in 0..5 {
        let before = std::fs::read_to_string(path).unwrap_or_default();
        let after = change(&before)?;
        if after == before {
            return Ok(());
        }
        if std::fs::read_to_string(path).unwrap_or_default() != before {
            continue;
        }
        return write_atomic(path, &after);
    }
    anyhow::bail!("{} keeps changing; close the tool and try again", path.display())
}

/// Replace a file in one step, keeping its permissions (configs that hold
/// API keys are often private) and writing through a symlinked dotfile.
fn write_atomic(path: &Path, text: &str) -> anyhow::Result<()> {
    let target = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let dir = target
        .parent()
        .ok_or_else(|| anyhow::anyhow!("{} has no folder", target.display()))?;
    std::fs::create_dir_all(dir)?;
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let tmp = dir.join(format!(".{name}.orca-{}.tmp", std::process::id()));
    {
        use std::io::Write;
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            let mode = std::fs::metadata(&target)
                .map(|m| m.permissions().mode() & 0o777)
                .unwrap_or(0o600);
            opts.mode(mode);
        }
        let _ = std::fs::remove_file(&tmp);
        let mut f = opts.open(&tmp)?;
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
    }
    if let Err(e) = std::fs::rename(&tmp, &target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(())
}

/// Where AI tools find the `orca` command: a copy outside the app bundle,
/// so the path stays valid across updates and AppImage mounts.
pub fn stable_cli_path() -> PathBuf {
    let dir = dirs::data_local_dir()
        .unwrap_or_else(|| home().join(".local").join("share"))
        .join("orca")
        .join("bin");
    dir.join(if cfg!(windows) { "orca.exe" } else { "orca" })
}

/// Copy `source` (the `orca` binary that ships with the app) to
/// [`stable_cli_path`] when that copy is missing or differs.
pub fn install_cli(source: &Path) -> anyhow::Result<PathBuf> {
    let dest = stable_cli_path();
    let same = std::fs::read(&dest)
        .ok()
        .zip(std::fs::read(source).ok())
        .is_some_and(|(a, b)| a == b);
    if !same {
        if let Some(dir) = dest.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = dest.with_extension("new");
        std::fs::copy(source, &tmp)
            .map_err(|e| anyhow::anyhow!("could not copy {} to {}: {e}", source.display(), tmp.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))?;
        }
        // Windows can't replace a running .exe, but it can rename one: move
        // the copy an AI tool is running out of the way first.
        #[cfg(windows)]
        {
            let old = dest.with_extension("old");
            let _ = std::fs::remove_file(&old);
            if dest.exists() {
                let _ = std::fs::rename(&dest, &old);
            }
        }
        std::fs::rename(&tmp, &dest)?;
    }
    #[cfg(windows)]
    let _ = std::fs::remove_file(dest.with_extension("old"));
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("orca-mcp-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn json_config_keeps_other_servers_and_keys() {
        let p = tmp("json").join("mcp.json");
        std::fs::write(&p, r#"{"theme":"dark","mcpServers":{"other":{"command":"x"}}}"#).unwrap();
        edit_json(&p, |root| {
            root.get_mut("mcpServers")
                .unwrap()
                .as_object_mut()
                .unwrap()
                .insert("orca".into(), serde_json::json!({"command":"/o"}));
            Ok(())
        })
        .unwrap();
        assert!(has_server(
            Format::Json {
                key: "mcpServers",
                with_type: false
            },
            &p
        ));
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(v["theme"], "dark");
        assert_eq!(v["mcpServers"]["other"]["command"], "x");
    }

    #[test]
    fn json_with_comments_is_not_rewritten() {
        let p = tmp("jsonc").join("mcp.json");
        std::fs::write(&p, "// mine\n{\"servers\":{}}").unwrap();
        assert!(edit_json(&p, |_| Ok(())).is_err());
        assert!(std::fs::read_to_string(&p).unwrap().starts_with("// mine"));
    }

    #[test]
    fn codex_toml_server_is_replaced_and_removed_keeping_the_rest() {
        let p = tmp("toml").join("config.toml");
        std::fs::write(
            &p,
            "# my settings\nmodel = \"o3\"\n\n[mcp_servers.orca]\ncommand = \"old\"\n\n[mcp_servers.git]\ncommand = \"git-mcp\" # keep\n",
        )
        .unwrap();
        let mut t = toml_edit::Table::new();
        t["command"] = toml_edit::value("C:\\Users\\Zoë\\orca.exe");
        t["args"] = toml_edit::value(["mcp"].into_iter().collect::<toml_edit::Array>());
        edit_toml(&p, Some(t)).unwrap();
        let text = std::fs::read_to_string(&p).unwrap();
        let doc: toml_edit::DocumentMut = text.parse().expect("still valid TOML");
        assert_eq!(
            doc["mcp_servers"]["orca"]["command"].as_str(),
            Some("C:\\Users\\Zoë\\orca.exe")
        );
        assert!(text.contains("# my settings") && text.contains("# keep") && !text.contains("\"old\""));
        assert!(has_server(Format::CodexToml, &p));
        edit_toml(&p, None).unwrap();
        let text = std::fs::read_to_string(&p).unwrap();
        assert!(!has_server(Format::CodexToml, &p) && text.contains("[mcp_servers.git]"));
    }

    #[test]
    fn a_quoted_or_inline_entry_is_still_one_server() {
        let p = tmp("toml-inline").join("config.toml");
        std::fs::write(&p, "[mcp_servers]\norca = { command = \"old\" }\n").unwrap();
        let mut t = toml_edit::Table::new();
        t["command"] = toml_edit::value("/new/orca");
        edit_toml(&p, Some(t)).unwrap();
        let doc: toml_edit::DocumentMut = std::fs::read_to_string(&p).unwrap().parse().unwrap();
        assert_eq!(doc["mcp_servers"]["orca"]["command"].as_str(), Some("/new/orca"));
    }

    #[cfg(unix)]
    #[test]
    fn private_configs_stay_private_and_symlinks_are_kept() {
        use std::os::unix::fs::PermissionsExt;
        let d = tmp("perm");
        let real = d.join("real.json");
        std::fs::write(&real, "{}").unwrap();
        std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o600)).unwrap();
        let link = d.join("link.json");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        edit_json(&link, |root| {
            root.insert("a".into(), 1.into());
            Ok(())
        })
        .unwrap();
        assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(std::fs::metadata(&real).unwrap().permissions().mode() & 0o777, 0o600);
        assert!(std::fs::read_to_string(&real).unwrap().contains("\"a\""));
    }
}
