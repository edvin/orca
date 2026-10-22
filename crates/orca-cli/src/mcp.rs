//! `orca mcp`: Orca's MCP server over stdio, for AI tools that start their
//! servers themselves (Claude Code, Claude Desktop, Cursor, VS Code, …).
//!
//! Each JSON-RPC message from stdin goes to the daemon's MCP endpoint with
//! the API token from Orca's config, so the AI tool's own config never holds
//! a secret. `--host` talks to a remote daemon from Orca Desktop's list.

use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;

/// Where to send MCP requests, and with which token.
pub struct Target {
    pub endpoint: String,
    pub token: Option<String>,
    pub tls_verify: bool,
    pub label: String,
}

impl Target {
    /// The local daemon, or a remote host by name or id.
    pub fn resolve(daemon_url: &str, token: Option<String>, host: Option<&str>) -> anyhow::Result<Self> {
        let config = orca_core::config::OrcaConfig::load().unwrap_or_default();
        match host {
            None => Ok(Self {
                endpoint: format!("{}/api/v1/agent/mcp", daemon_url.trim_end_matches('/')),
                token: token.or(config.api_token),
                tls_verify: true,
                label: "this machine".into(),
            }),
            Some(h) => {
                let remote = config
                    .remote_hosts
                    .iter()
                    .find(|r| r.name.eq_ignore_ascii_case(h) || r.id == h)
                    .ok_or_else(|| {
                        let known: Vec<&str> = config.remote_hosts.iter().map(|r| r.name.as_str()).collect();
                        anyhow::anyhow!(
                            "no remote host '{h}' in Orca Desktop (known: {})",
                            if known.is_empty() {
                                "none".into()
                            } else {
                                known.join(", ")
                            }
                        )
                    })?;
                let base = remote.url.trim_end_matches('/').trim_end_matches("/api/v1");
                Ok(Self {
                    endpoint: format!("{base}/api/v1/agent/mcp"),
                    token: Some(remote.token.clone()),
                    tls_verify: remote.tls_verify,
                    label: remote.name.clone(),
                })
            }
        }
    }
}

/// Serve MCP on stdin/stdout until stdin closes.
pub async fn serve(target: Target) -> anyhow::Result<()> {
    let http = reqwest::Client::builder()
        .danger_accept_invalid_certs(!target.tls_verify)
        // Tools such as builds and instance starts can take minutes.
        .timeout(std::time::Duration::from_secs(900))
        .build()?;
    let target = Arc::new(target);
    let stdout = Arc::new(Mutex::new(tokio::io::stdout()));
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    eprintln!("orca mcp: serving Orca on {} over stdio", target.label);

    let mut tasks = tokio::task::JoinSet::new();
    while let Some(line) = lines.next_line().await? {
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }
        let (http, target, stdout) = (http.clone(), target.clone(), stdout.clone());
        // Requests run concurrently; replies carry their id, so order doesn't matter.
        tasks.spawn(async move {
            if let Some(reply) = forward(&http, &target, &line).await {
                let mut out = stdout.lock().await;
                let _ = out.write_all(reply.as_bytes()).await;
                let _ = out.write_all(b"\n").await;
                let _ = out.flush().await;
            }
        });
    }
    while tasks.join_next().await.is_some() {}
    Ok(())
}

/// One message to the daemon; the reply to write, if any (notifications get none).
async fn forward(http: &reqwest::Client, target: &Target, line: &str) -> Option<String> {
    let message: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => {
            return Some(error_reply(
                serde_json::Value::Null,
                -32700,
                &format!("Parse error: {e}"),
            ));
        }
    };
    let id = message.get("id").cloned();
    let mut req = http.post(&target.endpoint).json(&message);
    if let Some(t) = &target.token {
        req = req.bearer_auth(t);
    }
    let result = req.send().await;
    let id = id?; // a notification: nothing to answer, whatever happened
    match result {
        Ok(resp) if resp.status().is_success() => match resp.text().await {
            Ok(body) if !body.trim().is_empty() => Some(body.replace('\n', " ")),
            _ => Some(error_reply(id, -32603, "Orca returned an empty reply")),
        },
        Ok(resp) if resp.status() == reqwest::StatusCode::UNAUTHORIZED => Some(error_reply(
            id,
            -32001,
            "Orca refused the API token. If Orca's token was reset, restart this AI tool so it reads the new one.",
        )),
        Ok(resp) => Some(error_reply(id, -32603, &format!("Orca answered {}", resp.status()))),
        Err(e) if e.is_connect() => Some(error_reply(
            id,
            -32000,
            &format!(
                "Orca isn't running on {}. Start Orca Desktop (or the orca-daemon service) and try again.",
                target.label
            ),
        )),
        Err(e) => Some(error_reply(id, -32603, &format!("Could not reach Orca: {e}"))),
    }
}

fn error_reply(id: serde_json::Value, code: i64, message: &str) -> String {
    serde_json::json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }).to_string()
}

/// `orca mcp install|uninstall|status`.
pub fn manage(action: &str, client: Option<&str>) -> anyhow::Result<()> {
    use orca_core::mcp_clients;
    match action {
        "status" => {
            for c in mcp_clients::status() {
                let state = if c.connected {
                    "connected"
                } else if c.detected {
                    "not connected"
                } else {
                    "not installed"
                };
                println!("{:<16} {:<14} {}", c.name, state, c.config_path);
            }
            Ok(())
        }
        "install" => {
            // AI tools run a copy outside wherever this binary lives (an app
            // bundle, an AppImage mount), so updates don't break the path.
            let exe = std::env::current_exe()?;
            let cli = mcp_clients::install_cli(&exe)?;
            let targets: Vec<String> = match client {
                Some(c) => vec![c.to_string()],
                None => mcp_clients::status()
                    .into_iter()
                    .filter(|c| c.detected)
                    .map(|c| c.id.to_string())
                    .collect(),
            };
            if targets.is_empty() {
                anyhow::bail!(
                    "found no AI tools on this machine. Name one: {}",
                    mcp_clients::ids().join(", ")
                );
            }
            for id in targets {
                match mcp_clients::connect(&id, &cli, &["mcp"]) {
                    Ok(next) => println!("✓ {id}: {next}"),
                    Err(e) => eprintln!("✗ {id}: {e}"),
                }
            }
            Ok(())
        }
        "uninstall" => {
            let targets: Vec<String> = match client {
                Some(c) => vec![c.to_string()],
                None => mcp_clients::status()
                    .into_iter()
                    .filter(|c| c.connected)
                    .map(|c| c.id.to_string())
                    .collect(),
            };
            for id in targets {
                mcp_clients::disconnect(&id)?;
                println!("Removed Orca from {id}");
            }
            Ok(())
        }
        other => anyhow::bail!("unknown action '{other}'"),
    }
}
