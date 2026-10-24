//! "Check this machine" on the Workspace page: everything a new developer's
//! machine needs for the workspace, each with what to do about it. It asks
//! git servers and the network, so it only runs when someone clicks it.

use std::path::Path;
use std::time::Duration;

use futures::StreamExt;
use orca_core::workspace::WorkspaceFile;
use serde::Serialize;

use crate::state::AppState;

#[derive(Debug, Serialize)]
pub struct Check {
    pub id: String,
    pub label: String,
    /// ok, warn, bad, or skip (doesn't apply here).
    pub status: &'static str,
    pub detail: String,
    /// What to do, when something's wrong.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix: Option<String>,
}

fn check(id: &str, label: &str, status: &'static str, detail: impl Into<String>, fix: Option<String>) -> Check {
    Check {
        id: id.into(),
        label: label.into(),
        status,
        detail: detail.into(),
        fix,
    }
}

pub async fn run(state: &AppState, file: &WorkspaceFile, dir: &Path) -> Vec<Check> {
    let gateway = state.config.lock().await.gateway.clone();
    let mut out = Vec::new();

    // The gateway, on the ports that make addresses work without one.
    let running = crate::gateway::is_running(state).await.unwrap_or(false);
    out.push(if !running {
        check(
            "gateway",
            "Gateway",
            "bad",
            "The gateway isn't running.",
            Some("Start it on the Gateway page, or click Update here.".into()),
        )
    } else if gateway.https_port != 443 {
        check(
            "gateway",
            "Gateway",
            "warn",
            format!(
                "Runs on port {}, so every address needs :{} after it.",
                gateway.https_port, gateway.https_port
            ),
            Some("Set the ports to 80 and 443 in the Gateway page's Settings, once nothing else uses them.".into()),
        )
    } else {
        check(
            "gateway",
            "Gateway",
            "ok",
            format!("Runs on ports 80 and 443 for *.{}.", gateway.domain),
            None,
        )
    });

    // Names under the domain have to reach this machine.
    let probe = format!("orca-check.{}", gateway.domain);
    let resolved = tokio::time::timeout(Duration::from_secs(5), tokio::net::lookup_host((probe.as_str(), 443))).await;
    out.push(match resolved {
        Ok(Ok(addrs)) => {
            let addrs: Vec<_> = addrs.collect();
            if !addrs.is_empty() && addrs.iter().all(|a| a.ip().is_loopback()) {
                check(
                    "dns",
                    "Domain",
                    "ok",
                    format!("*.{} points at this computer.", gateway.domain),
                    None,
                )
            } else {
                check(
                    "dns",
                    "Domain",
                    "bad",
                    format!(
                        "*.{} points elsewhere ({}).",
                        gateway.domain,
                        addrs.first().map(|a| a.ip().to_string()).unwrap_or_default()
                    ),
                    Some("Its DNS needs a wildcard record for 127.0.0.1, or add the names to /etc/hosts.".into()),
                )
            }
        }
        _ if gateway.domain == "localhost" || gateway.domain.ends_with(".localhost") => check(
            "dns",
            "Domain",
            "ok",
            "Browsers send *.localhost to this computer by themselves; other programs may not.",
            None,
        ),
        _ => check(
            "dns",
            "Domain",
            "bad",
            format!("*.{} doesn't resolve.", gateway.domain),
            Some("Its DNS needs a wildcard record for 127.0.0.1, or add the names to /etc/hosts.".into()),
        ),
    });

    // The team's certificate, when there is one.
    if let Some(expires) = crate::gateway::custom_cert_expiry(&gateway) {
        let days = (expires - chrono::Utc::now()).num_days();
        let when = expires.format("%-d %B %Y");
        out.push(match days {
            d if d < 0 => check(
                "certificate",
                "Team certificate",
                "bad",
                format!("Expired on {when}."),
                Some("Renew it and replace the files in the workspace repo, then Update.".into()),
            ),
            d if d <= crate::gateway::CERT_WARN_DAYS => check(
                "certificate",
                "Team certificate",
                "warn",
                format!("Expires in {d} days, on {when}."),
                Some("Renew it and replace the files in the workspace repo, then Update.".into()),
            ),
            _ => check(
                "certificate",
                "Team certificate",
                "ok",
                format!("Valid until {when}."),
                None,
            ),
        });
    }

    // Orca's own certificate authority: for everything a team certificate
    // doesn't cover.
    let needed = !matches!(gateway.tls_mode, orca_core::config::GatewayTlsMode::Custom)
        || gateway
            .routes
            .iter()
            .any(|r| r.enabled && !crate::gateway::custom_cert_covers(&gateway, &r.hostname));
    out.push(match crate::gateway::ca_trusted().await {
        Some(true) => check(
            "ca",
            "Orca's certificate authority",
            "ok",
            "Trusted by this computer.",
            None,
        ),
        Some(false) if needed => check(
            "ca",
            "Orca's certificate authority",
            "bad",
            "Not trusted yet, so browsers warn about the routes it signs.",
            Some("Run `orca ca install`, or use Settings → Certificates.".into()),
        ),
        Some(false) => check(
            "ca",
            "Orca's certificate authority",
            "skip",
            "Not trusted, and not needed: the team certificate covers every route.",
            None,
        ),
        None => check(
            "ca",
            "Orca's certificate authority",
            "skip",
            "Can't tell on this system.",
            None,
        ),
    });

    // The shared network.
    if let Some(net) = &file.network {
        let exists = state
            .rt()
            .await
            .docker
            .inspect_network::<String>(net, None)
            .await
            .is_ok();
        out.push(if exists {
            check("network", "Shared network", "ok", format!("{net} exists."), None)
        } else {
            check(
                "network",
                "Shared network",
                "bad",
                format!("{net} doesn't exist."),
                Some("Click Update: it creates it.".into()),
            )
        });
    }

    for host in &file.registries {
        out.push(if crate::workspace::registry_logged_in(host) {
            check(
                &format!("registry:{host}"),
                "Registry",
                "ok",
                format!("Logged in to {host}."),
                None,
            )
        } else {
            check(
                &format!("registry:{host}"),
                "Registry",
                "bad",
                format!("Not logged in to {host}, so its images won't pull."),
                Some(format!("Run `docker login {host}`.")),
            )
        });
    }

    let clis = crate::secrets::cli_status();
    if file.secrets.passbolt.is_some() {
        out.push(if clis.passbolt {
            check("passbolt", "Passbolt", "ok", "The Passbolt CLI is installed.", None)
        } else {
            check(
                "passbolt",
                "Passbolt",
                "warn",
                "The Passbolt CLI isn't installed: secrets are filled in by hand.",
                Some("Install go-passbolt-cli and run `passbolt configure`.".into()),
            )
        });
    }
    if file.secrets.onepassword.is_some() {
        out.push(if clis.onepassword {
            check("1password", "1Password", "ok", "The 1Password CLI is installed.", None)
        } else {
            check(
                "1password",
                "1Password",
                "warn",
                "The 1Password CLI (op) isn't installed: secrets are filled in by hand.",
                Some("Install it from 1password.com/downloads/command-line.".into()),
            )
        });
    }

    out.extend(repo_checks(file, dir).await);
    out
}

/// Whether each project's repository can be reached with this machine's git
/// credentials, a few at a time.
async fn repo_checks(file: &WorkspaceFile, _dir: &Path) -> Vec<Check> {
    let repos: Vec<(String, String)> = file.projects.iter().map(|(k, p)| (k.clone(), p.repo.clone())).collect();
    if repos.is_empty() {
        return Vec::new();
    }
    let results: Vec<(String, String, Result<(), String>)> = futures::stream::iter(repos)
        .map(|(key, repo)| async move {
            let r = reachable(&repo).await;
            (key, repo, r)
        })
        .buffer_unordered(6)
        .collect()
        .await;
    let failed: Vec<&(String, String, Result<(), String>)> = results.iter().filter(|r| r.2.is_err()).collect();
    if failed.is_empty() {
        return vec![check(
            "repos",
            "Repositories",
            "ok",
            format!("All {} can be cloned.", results.len()),
            None,
        )];
    }
    let mut names: Vec<&str> = failed.iter().map(|r| r.0.as_str()).collect();
    names.sort();
    let first = failed[0].2.as_ref().err().cloned().unwrap_or_default();
    let fix = if first.contains("Permission denied") || first.contains("publickey") {
        "Add your SSH key to your account on the git server, then check again."
    } else if first.contains("Could not resolve") || first.contains("timed out") {
        "The git server can't be reached: check your network or VPN."
    } else {
        "Check that you have access to these repositories on the git server."
    };
    vec![check(
        "repos",
        "Repositories",
        "bad",
        format!(
            "{} of {} can't be cloned: {}. Git said: {}",
            failed.len(),
            results.len(),
            names.join(", "),
            first.lines().last().unwrap_or("").trim()
        ),
        Some(fix.into()),
    )]
}

async fn reachable(repo: &str) -> Result<(), String> {
    let mut cmd = crate::workspace::git();
    cmd.args(["ls-remote", "--heads", "--", repo]);
    match tokio::time::timeout(Duration::from_secs(20), cmd.output()).await {
        Ok(Ok(out)) if out.status.success() => Ok(()),
        Ok(Ok(out)) => Err(String::from_utf8_lossy(&out.stderr).trim().to_string()),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err("timed out".into()),
    }
}
