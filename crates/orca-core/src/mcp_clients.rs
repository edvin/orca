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
            detect: || on_path("claude") || home().join(".claude.json").exists() || home().join(".claude").is_dir(),
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
        Format::CodexToml => text.lines().any(|l| l.trim() == format!("[mcp_servers.{SERVER_NAME}]")),
    }
}

/// Add Orca to a tool's config, running `command args…`. Returns what to do next.
pub fn connect(id: &str, command: &Path, args: &[&str]) -> anyhow::Result<String> {
    let c = find(id)?;
    // Claude Code rewrites ~/.claude.json itself; its own CLI avoids racing it.
    if c.id == "claude-code" && on_path("claude") {
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
            let args = args.iter().map(|a| format!("{a:?}")).collect::<Vec<_>>().join(", ");
            let block = format!("[mcp_servers.{SERVER_NAME}]\ncommand = {command:?}\nargs = [{args}]\n");
            edit_toml_section(&path, Some(&block))?;
        }
    }
    Ok(c.after_connect.unwrap_or("Connected.").to_string())
}

/// Remove Orca from a tool's config.
pub fn disconnect(id: &str) -> anyhow::Result<()> {
    let c = find(id)?;
    if c.id == "claude-code" && on_path("claude") {
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
        Format::CodexToml => edit_toml_section(&path, None),
    }
}

fn claude_cli(args: &[&str]) -> anyhow::Result<String> {
    let out = std::process::Command::new(if cfg!(windows) { "claude.exe" } else { "claude" })
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
/// left alone with an error rather than rewritten.
fn edit_json(
    path: &Path,
    change: impl FnOnce(&mut serde_json::Map<String, serde_json::Value>) -> anyhow::Result<()>,
) -> anyhow::Result<()> {
    let mut root = match std::fs::read_to_string(path) {
        Ok(text) if !text.trim().is_empty() => match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(serde_json::Value::Object(m)) => m,
            _ => anyhow::bail!(
                "{} isn't plain JSON (it may have comments), so Orca won't rewrite it. Add the server by hand.",
                path.display()
            ),
        },
        _ => serde_json::Map::new(),
    };
    change(&mut root)?;
    let text = serde_json::to_string_pretty(&serde_json::Value::Object(root))? + "\n";
    write_atomic(path, &text)
}

/// Replace (or remove, with `None`) the `[mcp_servers.orca]` table in a
/// TOML file, keeping everything else as written.
fn edit_toml_section(path: &Path, block: Option<&str>) -> anyhow::Result<()> {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let header = format!("[mcp_servers.{SERVER_NAME}]");
    let mut out = String::new();
    let mut skipping = false;
    for line in text.lines() {
        let t = line.trim();
        if t == header {
            skipping = true;
            continue;
        }
        if skipping && t.starts_with('[') {
            skipping = false;
        }
        if !skipping {
            out.push_str(line);
            out.push('\n');
        }
    }
    if let Some(block) = block {
        if !out.is_empty() && !out.ends_with("\n\n") {
            out.push('\n');
        }
        out.push_str(block);
    }
    write_atomic(path, &out)
}

fn write_atomic(path: &Path, text: &str) -> anyhow::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("orca-tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)?;
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
        std::fs::rename(&tmp, &dest)?;
    }
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
    fn codex_toml_section_is_replaced_and_removed() {
        let p = tmp("toml").join("config.toml");
        std::fs::write(
            &p,
            "model = \"o3\"\n\n[mcp_servers.orca]\ncommand = \"old\"\n\n[mcp_servers.git]\ncommand = \"git-mcp\"\n",
        )
        .unwrap();
        edit_toml_section(
            &p,
            Some("[mcp_servers.orca]\ncommand = \"/new/orca\"\nargs = [\"mcp\"]\n"),
        )
        .unwrap();
        let t = std::fs::read_to_string(&p).unwrap();
        assert!(t.contains("model = \"o3\"") && t.contains("[mcp_servers.git]") && t.contains("/new/orca"));
        assert!(!t.contains("\"old\""));
        assert_eq!(t.matches("[mcp_servers.orca]").count(), 1);
        edit_toml_section(&p, None).unwrap();
        let t = std::fs::read_to_string(&p).unwrap();
        assert!(!t.contains("mcp_servers.orca") && t.contains("[mcp_servers.git]"));
    }
}
