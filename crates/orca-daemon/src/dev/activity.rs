//! Instance activity and idle stop.
//!
//! An instance counts as used when its URLs get requests through the gateway
//! or when someone runs Orca commands for it (UI, CLI, MCP). Projects that
//! set `idle_stop` in orca.yaml have instances stopped after that long
//! without use; nothing is deleted and a start brings them back as they were.
//! Projects with `start: on-create` get new worktrees started on their own.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use chrono::{DateTime, Utc};
use tokio::sync::Mutex;

use orca_core::dev::OrcaYaml;

use super::{deploy, jobs, project::ProjectCtx};
use crate::state::AppState;

type Map = Mutex<HashMap<String, DateTime<Utc>>>;

fn map() -> &'static Map {
    static M: OnceLock<Map> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

fn started() -> DateTime<Utc> {
    static S: OnceLock<DateTime<Utc>> = OnceLock::new();
    *S.get_or_init(Utc::now)
}

/// Record that an instance was used now.
pub async fn touch(project: &str, instance: &str) {
    map().lock().await.insert(format!("{project}/{instance}"), Utc::now());
}

pub async fn last_seen(project: &str, instance: &str) -> Option<DateTime<Utc>> {
    map().lock().await.get(&format!("{project}/{instance}")).copied()
}

/// Start the background loops. Call once at daemon startup.
pub fn spawn(state: Arc<AppState>) {
    let _ = started();
    // Fast loop: wake sleeping instances when their URL is requested.
    let wake_state = state.clone();
    tokio::spawn(async move {
        let mut cursor = LogCursor::default();
        loop {
            tokio::time::sleep(Duration::from_secs(3)).await;
            if let Err(e) = wake_requested(&wake_state, &mut cursor).await {
                tracing::debug!("wake on request: {e:#}");
            }
        }
    });
    tokio::spawn(async move {
        let mut cursor = LogCursor::default();
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            if let Err(e) = scan_gateway(&state, &mut cursor).await {
                tracing::debug!("gateway activity scan: {e:#}");
            }
            if let Err(e) = stop_idle(&state).await {
                tracing::warn!("idle stop: {e:#}");
            }
            start_new_worktrees(&state).await;
        }
    });
}

/// Start worktrees that appeared since Orca last looked, for projects with
/// `dev.start: on-create`. Worktrees already there when Orca first sees a
/// project are left alone, so a restart never starts a pile of old ones.
async fn start_new_worktrees(state: &Arc<AppState>) {
    static SEEN: OnceLock<Mutex<HashMap<String, HashSet<std::path::PathBuf>>>> = OnceLock::new();
    let seen = SEEN.get_or_init(|| Mutex::new(HashMap::new()));
    let ids: Vec<String> = state
        .config
        .lock()
        .await
        .dev_projects
        .iter()
        .map(|p| p.id.clone())
        .collect();
    for id in ids {
        let Ok(ctx) = ProjectCtx::load(state, &id).await else {
            continue;
        };
        let current: HashSet<std::path::PathBuf> = ctx
            .worktrees
            .iter()
            .filter(|w| !w.prunable)
            .map(|w| w.path.clone())
            .collect();
        let new: Vec<std::path::PathBuf> = {
            let mut seen = seen.lock().await;
            let Some(known) = seen.get_mut(&id) else {
                seen.insert(id.clone(), current);
                continue;
            };
            let new = current.difference(known).cloned().collect();
            *known = current;
            new
        };
        if ctx.dev.start != orca_core::dev::schema::StartPolicy::OnCreate {
            continue;
        }
        for path in new {
            let Some(name) = ctx.names.iter().find(|(p, _)| *p == path).map(|(_, n)| n.clone()) else {
                continue;
            };
            let opts = deploy::UpOptions {
                source: Some("auto".into()),
                ..Default::default()
            };
            match deploy::up(state.clone(), id.clone(), name.clone(), opts).await {
                Ok(_) => tracing::info!("Started new worktree '{name}' of '{id}' (start: on-create)"),
                Err(e) => tracing::warn!("Could not start new worktree '{name}' of '{id}': {e:#}"),
            }
        }
    }
}

/// Count requests per instance from the gateway's access log since `since`.
async fn scan_gateway(state: &AppState, cursor: &mut LogCursor) -> anyhow::Result<()> {
    let requested = cursor.new_hosts().await;
    if requested.is_empty() {
        return Ok(());
    }
    let hosts: HashMap<String, (String, String)> = {
        let cfg = state.config.lock().await;
        cfg.gateway
            .routes
            .iter()
            .filter_map(|r| {
                let owner = r.owner.as_deref()?.strip_prefix("dev:")?;
                // Host-process routes are owned by "dev:<p>:<i>#host".
                let owner = owner.split('#').next().unwrap_or(owner);
                let (p, i) = owner.split_once(':')?;
                Some((r.hostname.clone(), (p.to_string(), i.to_string())))
            })
            .collect()
    };
    if hosts.is_empty() {
        return Ok(());
    }
    for (p, i) in owners(&requested, &hosts) {
        touch(&p, &i).await;
    }
    Ok(())
}

/// Start sleeping instances whose URL was requested since `since`.
async fn wake_requested(state: &Arc<AppState>, cursor: &mut LogCursor) -> anyhow::Result<()> {
    // Always advance, so requests seen while nothing sleeps never wake anything later.
    let requested = cursor.new_hosts().await;
    if requested.is_empty() {
        return Ok(());
    }
    let sleeping: HashMap<String, (String, String)> = {
        let cfg = state.config.lock().await;
        cfg.gateway
            .routes
            .iter()
            .filter(|r| r.sleeping)
            .filter_map(|r| {
                let owner = r.owner.as_deref()?.strip_prefix("dev:")?;
                let (p, i) = owner.split_once(':')?;
                Some((r.hostname.clone(), (p.to_string(), i.to_string())))
            })
            .collect()
    };
    for (project, instance) in owners(&requested, &sleeping) {
        if jobs::running_for(&project, &instance).await.is_some() {
            continue;
        }
        tracing::info!("waking {project}/{instance}: its URL was requested");
        touch(&project, &instance).await;
        let opts = deploy::UpOptions {
            build: Some(false),
            source: Some("wake".into()),
            ..Default::default()
        };
        if let Err(e) = deploy::up(state.clone(), project.clone(), instance.clone(), opts).await {
            tracing::warn!("could not wake {project}/{instance}: {e:#}");
        }
    }
    Ok(())
}

fn owners(requested: &HashSet<String>, hosts: &HashMap<String, (String, String)>) -> HashSet<(String, String)> {
    requested.iter().filter_map(|h| hosts.get(h).cloned()).collect()
}

/// Reads the gateway access log incrementally: each call returns the hosts
/// requested since the previous one. Starts at the end of the file, and from
/// the top again when Caddy rolls it over.
#[derive(Default)]
struct LogCursor {
    offset: Option<u64>,
}

/// Most bytes read per call; a burst beyond this is picked up next time.
const MAX_READ: u64 = 4 * 1024 * 1024;

impl LogCursor {
    async fn new_hosts(&mut self) -> HashSet<String> {
        let path = crate::gateway::access_log_path();
        let Ok(len) = tokio::fs::metadata(&path).await.map(|m| m.len()) else {
            // No log yet: whatever appears later is new.
            self.offset = Some(0);
            return HashSet::new();
        };
        let start = match self.offset {
            None => len,
            Some(o) if o <= len => o,
            Some(_) => 0, // rolled over
        };
        if start == len {
            self.offset = Some(len);
            return HashSet::new();
        }
        let Ok(bytes) = read_range(&path, start, (len - start).min(MAX_READ)).await else {
            return HashSet::new();
        };
        // Only whole lines; a half-written last line waits for the next call.
        let used = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
        self.offset = Some(start + used as u64);
        hosts_in(&bytes[..used])
    }
}

async fn read_range(path: &std::path::Path, start: u64, len: u64) -> std::io::Result<Vec<u8>> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    let mut f = tokio::fs::File::open(path).await?;
    f.seek(std::io::SeekFrom::Start(start)).await?;
    let mut buf = Vec::with_capacity(len as usize);
    f.take(len).read_to_end(&mut buf).await?;
    Ok(buf)
}

/// Request hosts (without port) in Caddy JSON access-log lines.
fn hosts_in(bytes: &[u8]) -> HashSet<String> {
    String::from_utf8_lossy(bytes)
        .lines()
        .filter_map(|line| {
            let v: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
            let host = v.pointer("/request/host")?.as_str()?;
            Some(host.split(':').next().unwrap_or(host).to_string())
        })
        .collect()
}

async fn stop_idle(state: &Arc<AppState>) -> anyhow::Result<()> {
    let projects: Vec<(String, std::path::PathBuf)> = state
        .config
        .lock()
        .await
        .dev_projects
        .iter()
        .map(|p| (p.id.clone(), p.root.clone()))
        .collect();
    for (id, root) in projects {
        // Only projects that set `idle_stop` need the full context (git,
        // containers); this runs every minute whether anyone looks or not.
        let wants_idle_stop = OrcaYaml::load(&root)
            .ok()
            .and_then(|y| y.dev)
            .is_some_and(|d| d.instance.idle_stop.is_some());
        if !wants_idle_stop {
            continue;
        }
        let Ok(ctx) = ProjectCtx::load(state, &id).await else {
            continue;
        };
        let Some(idle) = ctx.dev.instance.idle_stop_duration().ok().flatten() else {
            continue;
        };
        let view = super::project::build_view(state, &ctx, false).await;
        for inst in view
            .instances
            .iter()
            .filter(|i| i.status == "running" || i.status == "partial")
        {
            if jobs::running_for(&id, &inst.name).await.is_some() {
                continue;
            }
            let started_at = inst
                .last_started
                .as_deref()
                .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                .map(|d| d.with_timezone(&Utc));
            let last = [last_seen(&id, &inst.name).await, started_at, Some(started())]
                .into_iter()
                .flatten()
                .max()
                .unwrap_or_else(Utc::now);
            let quiet = Utc::now() - last;
            if quiet.to_std().unwrap_or_default() < idle {
                continue;
            }
            tracing::info!(
                "stopping idle instance {id}/{} (no use for {} min)",
                inst.name,
                quiet.num_minutes()
            );
            {
                let mut cfg = state.config.lock().await;
                if let Some(p) = cfg.dev_projects.iter_mut().find(|p| p.id == id)
                    && let Some(s) = p.instance_by_path_mut(&inst.path)
                {
                    s.idle_stopped_at = Some(Utc::now().to_rfc3339());
                }
                let _ = cfg.save();
            }
            deploy::down(state.clone(), id.clone(), inst.name.clone(), deploy::DownMode::Sleep).await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_from_access_lines() {
        let log = concat!(
            r#"{"level":"info","logger":"http.log.access","request":{"host":"web-a-shop.localhost:8443"}}"#,
            "\n",
            "not json\n",
            r#"{"request":{"host":"api-a-shop.localhost"}}"#,
            "\n"
        );
        let hosts = hosts_in(log.as_bytes());
        assert!(hosts.contains("web-a-shop.localhost"));
        assert!(hosts.contains("api-a-shop.localhost"));
        assert_eq!(hosts.len(), 2);
    }
}
