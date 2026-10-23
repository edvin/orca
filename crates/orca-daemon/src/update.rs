//! Whether a newer Orca is out, for AI tools ("is my Orca current?") and
//! the app. Installing stays with the app: it restarts the daemon, and with
//! it the AI tool's connection, so the user clicks Update there.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{Value, json};

use crate::api::ApiError;
use crate::state::AppState;

const RELEASES: &str = "https://api.github.com/repos/edvin/orca/releases?per_page=30";
const HEADLESS_UPGRADE: &str = "curl -fsSL https://orca-desktop.com/install-daemon.sh | sudo sh";
/// GitHub allows 60 unauthenticated requests an hour; one an hour is plenty.
const CACHE_FOR: Duration = Duration::from_secs(3600);

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/update", get(check))
        .route("/update/prompt", post(prompt))
}

#[derive(Clone)]
struct Release {
    version: String,
    published: String,
    url: String,
    /// The `## ` headings of its notes: what it's about.
    headlines: Vec<String>,
}

static CACHE: Mutex<Option<(Instant, Vec<Release>)>> = Mutex::new(None);

/// `0.53.0` as numbers, to compare; anything unparsable sorts first.
fn version_key(v: &str) -> Vec<u64> {
    v.trim_start_matches('v')
        .split(['.', '-'])
        .take(3)
        .map(|p| p.parse().unwrap_or(0))
        .collect()
}

fn parse_releases(list: &Value) -> Vec<Release> {
    list.as_array()
        .into_iter()
        .flatten()
        .filter(|r| r["draft"] != json!(true) && r["prerelease"] != json!(true))
        .filter_map(|r| {
            let tag = r["tag_name"].as_str()?;
            Some(Release {
                version: tag.trim_start_matches('v').to_string(),
                published: r["published_at"].as_str().unwrap_or_default().to_string(),
                url: r["html_url"].as_str().unwrap_or_default().to_string(),
                headlines: r["body"]
                    .as_str()
                    .unwrap_or_default()
                    .lines()
                    .filter_map(|l| l.strip_prefix("## "))
                    .map(|h| h.trim().to_string())
                    .collect(),
            })
        })
        .collect()
}

async fn releases(refresh: bool) -> anyhow::Result<Vec<Release>> {
    if !refresh
        && let Some((at, list)) = CACHE.lock().unwrap().as_ref()
        && at.elapsed() < CACHE_FOR
    {
        return Ok(list.clone());
    }
    let client = reqwest::Client::builder()
        .user_agent(concat!("orca-daemon/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(10))
        .build()?;
    let list: Value = client
        .get(RELEASES)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let parsed = parse_releases(&list);
    *CACHE.lock().unwrap() = Some((Instant::now(), parsed.clone()));
    Ok(parsed)
}

/// The app is open when something follows the daemon's events.
fn app_open(state: &AppState) -> bool {
    state.events_tx.receiver_count() > 0
}

fn summary(current: &str, list: &[Release], app_open: bool) -> Value {
    let newer: Vec<&Release> = list
        .iter()
        .filter(|r| version_key(&r.version) > version_key(current))
        .collect();
    let latest = list.iter().max_by_key(|r| version_key(&r.version));
    json!({
        "current": current,
        "latest": latest.map(|r| r.version.clone()),
        "update_available": !newer.is_empty(),
        "release_url": latest.map(|r| r.url.clone()),
        "published": latest.map(|r| r.published.clone()),
        "newer_releases": newer.iter().map(|r| json!({
            "version": r.version, "published": r.published, "url": r.url, "headlines": r.headlines,
        })).collect::<Vec<_>>(),
        "how_to_update": if newer.is_empty() {
            "Up to date.".to_string()
        } else if app_open {
            "Click Update in the status bar of the Orca app (offer_update shows the prompt there). Orca restarts to install it.".to_string()
        } else {
            format!("This daemon runs without the app. Upgrade it on this machine with: {HEADLESS_UPGRADE}")
        },
    })
}

#[derive(serde::Deserialize, Default)]
struct CheckQuery {
    #[serde(default)]
    refresh: bool,
}

/// GET /update: this version, the latest release, and what the ones in
/// between are about.
async fn check(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(query): axum::extract::Query<CheckQuery>,
) -> Result<Json<Value>, ApiError> {
    let refresh = query.refresh;
    let list = releases(refresh)
        .await
        .map_err(|e| ApiError::bad_request(format!("Couldn't reach GitHub to check for updates: {e}")))?;
    Ok(Json(summary(env!("CARGO_PKG_VERSION"), &list, app_open(&state))))
}

/// POST /update/prompt: ask the open app to show its Update prompt. The
/// user decides; nothing installs from here.
async fn prompt(State(state): State<Arc<AppState>>) -> Result<Json<Value>, ApiError> {
    let list = releases(false)
        .await
        .map_err(|e| ApiError::bad_request(format!("Couldn't reach GitHub to check for updates: {e}")))?;
    let s = summary(env!("CARGO_PKG_VERSION"), &list, app_open(&state));
    if s["update_available"] != json!(true) {
        return Ok(Json(
            json!({ "shown": false, "message": "Orca is up to date.", "current": s["current"] }),
        ));
    }
    if !app_open(&state) {
        return Ok(Json(
            json!({ "shown": false, "message": s["how_to_update"], "latest": s["latest"] }),
        ));
    }
    let version = s["latest"].as_str().unwrap_or_default().to_string();
    let _ = state.events_tx.send(orca_core::event::Event {
        timestamp: chrono::Utc::now().to_rfc3339(),
        kind: orca_core::event::EventKind::UpdatePrompt {
            version: version.clone(),
        },
    });
    Ok(Json(json!({
        "shown": true,
        "latest": version,
        "message": format!("Orca now shows an Update prompt for v{version}. The developer clicks Update to install it; Orca then restarts, which ends this connection for a moment."),
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newer_releases_and_headlines() {
        let list = parse_releases(&json!([
            { "tag_name": "v0.53.0", "published_at": "2026-10-23", "html_url": "u3", "body": "## Workspaces\ntext\n## Gateway\n", "draft": false, "prerelease": false },
            { "tag_name": "v0.52.10", "published_at": "2026-10-22", "html_url": "u2", "body": "## Fixes", "draft": false, "prerelease": false },
            { "tag_name": "v0.54.0", "html_url": "u4", "body": "", "draft": true, "prerelease": false },
            { "tag_name": "v0.52.1", "html_url": "u1", "body": "", "draft": false, "prerelease": false },
        ]));
        let s = summary("0.52.1", &list, true);
        assert_eq!(s["latest"], "0.53.0");
        assert_eq!(s["update_available"], true);
        let newer = s["newer_releases"].as_array().unwrap();
        assert_eq!(newer.len(), 2);
        assert_eq!(newer[0]["headlines"], json!(["Workspaces", "Gateway"]));
        assert_eq!(summary("0.53.0", &list, true)["update_available"], false);
        assert!(
            summary("0.52.1", &list, false)["how_to_update"]
                .as_str()
                .unwrap()
                .contains("install-daemon.sh")
        );
    }
}
