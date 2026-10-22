//! Loading a registered project and building the views the UI and CLI read.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use anyhow::Result;
use orca_core::dev::compose_model::{Suggestion, suggest_shared};
use orca_core::dev::schema::InstanceNameSource;
use orca_core::dev::{self as core_dev, DevConfig, DevInstanceState, DevProject, OrcaYaml, PortAssignment, Worktree};
use orca_core::runtime::{Container, ContainerRuntime, ContainerState};
use serde::Serialize;

use super::{jobs, ops};
use crate::state::AppState;

/// A project with its config and worktrees loaded.
pub struct ProjectCtx {
    pub project: DevProject,
    /// `orca.yaml` of the main checkout (shared services come from here).
    pub yaml: OrcaYaml,
    pub yaml_error: Option<String>,
    pub dev: DevConfig,
    pub has_dev: bool,
    pub worktrees: Vec<Worktree>,
    /// Worktree path → instance name, for every worktree and every
    /// remembered instance whose worktree is gone.
    pub names: Vec<(PathBuf, String)>,
}

impl ProjectCtx {
    pub async fn load(state: &AppState, id: &str) -> Result<Self> {
        let project = {
            let cfg = state.config.lock().await;
            cfg.dev_projects
                .iter()
                .find(|p| p.id == id)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("project '{id}' is not registered"))?
        };
        let (yaml, yaml_error) = match OrcaYaml::load(&project.root) {
            Ok(y) => (y, None),
            Err(e) => (OrcaYaml::default(), Some(e.to_string())),
        };
        let has_dev = yaml.dev.is_some();
        let dev = yaml.dev.clone().unwrap_or_default();
        let worktrees = ops::list_worktrees(&project.root).await?;
        let names = instance_names(&project, &worktrees, dev.naming.instance);
        Ok(Self {
            project,
            yaml,
            yaml_error,
            dev,
            has_dev,
            worktrees,
            names,
        })
    }

    pub fn path_of(&self, name: &str) -> Result<PathBuf> {
        self.names
            .iter()
            .find(|(_, n)| n == name)
            .map(|(p, _)| p.clone())
            .ok_or_else(|| anyhow::anyhow!("no instance '{name}' in project '{}'", self.project.id))
    }

    pub fn name_of(&self, path: &Path) -> Option<String> {
        self.names.iter().find(|(p, _)| p == path).map(|(_, n)| n.clone())
    }

    pub fn worktree(&self, path: &Path) -> Option<&Worktree> {
        self.worktrees.iter().find(|w| w.path == path)
    }

    pub fn main_branch(&self) -> Option<String> {
        self.worktrees.iter().find(|w| w.is_main).and_then(|w| w.branch.clone())
    }

    /// Compose project name of the shared stack.
    pub fn shared_cp(&self) -> String {
        self.dev
            .shared_project
            .clone()
            .or_else(|| self.project.shared_project.clone())
            .unwrap_or_else(|| core_dev::shared_compose_project(&self.project.id))
    }

    pub fn root_compose_files(&self) -> Result<Vec<PathBuf>> {
        ops::compose_files(&self.project.root, self.yaml.compose.as_ref().map(|c| c.to_vec()))
    }

    /// Shared service names: from `orca.yaml` when it has a `dev:` section,
    /// otherwise Orca's suggestion from the main checkout's compose file.
    pub async fn shared(&self, state: &AppState) -> Result<(BTreeSet<String>, Vec<Suggestion>)> {
        if self.has_dev {
            return Ok((self.dev.shared_names(), Vec::new()));
        }
        let files = self.root_compose_files()?;
        let model = ops::resolve_model_cached(state, &self.project.root, &self.shared_cp(), &files).await?;
        let suggestions = suggest_shared(&model);
        let names = suggestions
            .iter()
            .filter(|s| s.shared)
            .map(|s| s.service.clone())
            .collect();
        Ok((names, suggestions))
    }

    /// `database:` per shared service, for `{db.<service>}`.
    pub fn shared_databases(&self) -> BTreeMap<String, String> {
        self.dev
            .shared
            .iter()
            .filter_map(|(k, v)| v.database.clone().map(|d| (k.clone(), d)))
            .collect()
    }
}

/// Stable instance names: remembered names first, then names derived from
/// the branch (or folder) for worktrees that were never configured.
pub fn instance_names(
    project: &DevProject,
    worktrees: &[Worktree],
    source: InstanceNameSource,
) -> Vec<(PathBuf, String)> {
    let mut taken: Vec<String> = project.instances.iter().map(|i| i.name.clone()).collect();
    let mut out = Vec::new();
    for wt in worktrees {
        if let Some(state) = project.instance_by_path(&wt.path) {
            out.push((wt.path.clone(), state.name.clone()));
            continue;
        }
        let raw = match (source, &wt.branch) {
            (InstanceNameSource::Branch, Some(b)) => b.clone(),
            _ => strip_project_prefix(&wt.folder_name(), &project.id),
        };
        let base = core_dev::naming::slugify(&raw)
            .or_else(|| core_dev::naming::slugify(&wt.folder_name()))
            .unwrap_or_else(|| "worktree".to_string());
        let name = core_dev::naming::unique_name(&base, &taken);
        taken.push(name.clone());
        out.push((wt.path.clone(), name));
    }
    // Remembered instances whose worktree is gone (orphans).
    for inst in &project.instances {
        if !worktrees.iter().any(|w| w.path == inst.path) {
            out.push((inst.path.clone(), inst.name.clone()));
        }
    }
    out
}

/// Worktree folders are often named `<project>-<topic>`; the instance is
/// already prefixed with the project, so `myapp-agent-x` becomes `agent-x`.
fn strip_project_prefix(folder: &str, project: &str) -> String {
    let lower = folder.to_lowercase();
    for sep in ['-', '_', '.'] {
        let prefix = format!("{project}{sep}");
        if lower.starts_with(&prefix) && lower.len() > prefix.len() {
            return folder[prefix.len()..].to_string();
        }
    }
    folder.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wt(path: &str, branch: Option<&str>, is_main: bool) -> Worktree {
        Worktree {
            path: path.into(),
            head: None,
            branch: branch.map(str::to_string),
            is_main,
            prunable: false,
            locked: false,
        }
    }

    fn project(instances: Vec<DevInstanceState>) -> DevProject {
        DevProject {
            id: "myapp".into(),
            root: "/c/myapp".into(),
            added_at: String::new(),
            shared_project: None,
            instances,
        }
    }

    #[test]
    fn names_from_branch_folder_and_memory() {
        let wts = vec![
            wt("/c/myapp", Some("main"), true),
            wt("/c/myapp-agent-x", None, false),
            wt("/c/other", Some("feat/auth"), false),
            wt("/c/myapp-feat", Some("feat/auth-v2"), false),
        ];
        let remembered = DevInstanceState {
            path: "/c/myapp-feat".into(),
            name: "auth2".into(),
            ..Default::default()
        };
        let gone = DevInstanceState {
            path: "/c/deleted".into(),
            name: "old".into(),
            ..Default::default()
        };
        let names = instance_names(&project(vec![remembered, gone]), &wts, InstanceNameSource::Branch);
        let n: Vec<&str> = names.iter().map(|(_, n)| n.as_str()).collect();
        assert_eq!(n, vec!["main", "agent-x", "feat-auth", "auth2", "old"]);
    }

    #[test]
    fn folder_naming_and_collisions() {
        let wts = vec![
            wt("/c/myapp", Some("main"), true),
            wt("/a/myapp_x", Some("one"), false),
            wt("/b/x", Some("two"), false),
        ];
        let names = instance_names(&project(vec![]), &wts, InstanceNameSource::Folder);
        let n: Vec<&str> = names.iter().map(|(_, n)| n.as_str()).collect();
        assert_eq!(n, vec!["myapp", "x", "x-2"]);
    }
}

// --- Views -----------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct ProjectView {
    pub id: String,
    pub root: PathBuf,
    pub main_branch: Option<String>,
    pub orca_yaml: YamlInfo,
    /// "orca.yaml" or "suggested".
    pub shared_source: &'static str,
    pub shared: Vec<SharedView>,
    pub instances: Vec<InstanceView>,
    pub gateway: GatewayInfo,
    /// Problems that stop the project from working (no compose file …).
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct YamlInfo {
    pub exists: bool,
    pub has_dev: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GatewayInfo {
    pub running: bool,
    pub domain: String,
    pub https_port: u16,
    /// Whether instance hostnames resolve to this machine.
    pub dns: super::hostcheck::DnsCheck,
    /// DNS names of the gateway's custom certificate, when it uses one.
    pub cert_names: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SharedView {
    pub name: String,
    /// Why Orca suggested it as shared (only when suggested).
    pub reason: Option<String>,
    pub image: Option<String>,
    /// "running", "stopped", "not_started".
    pub status: String,
    pub container_id: Option<String>,
    pub container_name: Option<String>,
    pub ports: Vec<orca_core::runtime::PortMapping>,
    pub data_mode: orca_core::dev::DataMode,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServiceView {
    pub name: String,
    pub state: ContainerState,
    pub container_id: String,
    pub container_name: String,
    pub image: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RouteView {
    pub service: Option<String>,
    pub hostname: String,
    pub path: Option<String>,
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct InstanceView {
    pub name: String,
    pub path: PathBuf,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub is_main: bool,
    /// The worktree folder is gone or git calls it prunable.
    pub orphaned: bool,
    pub dirty: bool,
    pub ahead: Option<u32>,
    /// The branch's remote branch was deleted (usually merged).
    pub upstream_gone: bool,
    /// not_deployed, starting, stopping, running, partial, stopped, failed, orphaned
    pub status: String,
    pub compose_project: String,
    pub services: Vec<ServiceView>,
    pub routes: Vec<RouteView>,
    pub ports: Vec<PortAssignment>,
    /// Compose profiles it runs, besides the services without one.
    pub profiles: Vec<String>,
    pub hostname_overrides: BTreeMap<String, String>,
    /// Data mode per shared service, where it differs from shared data.
    pub data_modes: BTreeMap<String, orca_core::dev::DataMode>,
    /// This instance's own databases (service → name).
    pub tenants: BTreeMap<String, String>,
    pub configured: bool,
    pub started_by: Option<String>,
    pub last_started: Option<String>,
    pub job_id: Option<String>,
    pub last_error: Option<String>,
}

fn label<'a>(c: &'a Container, k: &str) -> Option<&'a str> {
    c.labels.get(k).map(String::as_str)
}

pub async fn build_view(state: &AppState, ctx: &ProjectCtx, with_git_details: bool) -> ProjectView {
    let mut errors = Vec::new();
    let containers = state.rt().await.list_containers(true).await.unwrap_or_default();
    let mut by_project: HashMap<&str, Vec<&Container>> = HashMap::new();
    for c in &containers {
        if let Some(p) = label(c, "com.docker.compose.project") {
            by_project.entry(p).or_default().push(c);
        }
    }

    let (gw_domain, gw_port, routes_cfg, cert_names) = {
        let cfg = state.config.lock().await;
        (
            cfg.gateway.domain.clone(),
            cfg.gateway.https_port,
            cfg.gateway.routes.clone(),
            super::hostcheck::custom_cert_names(&cfg.gateway),
        )
    };
    // A name shaped like this project's instance hostnames.
    let dns_host = orca_core::dev::hostnames::render(
        &ctx.dev.naming.hostname,
        &ctx.project.id,
        "dns-check",
        "web",
        &gw_domain,
        &ctx.project.root,
    )
    .unwrap_or_else(|_| format!("orca-dns-check.{gw_domain}"));
    let dns = super::hostcheck::dns_check(&dns_host).await;
    let gw_running = crate::gateway::is_running(state).await.unwrap_or(false);

    // Shared services.
    let shared_cp = ctx.shared_cp();
    let (shared_names, suggestions) = match ctx.shared(state).await {
        Ok(v) => v,
        Err(e) => {
            errors.push(format!("{e:#}"));
            (BTreeSet::new(), Vec::new())
        }
    };
    let shared_containers = by_project.get(shared_cp.as_str()).cloned().unwrap_or_default();
    let shared: Vec<SharedView> = shared_names
        .iter()
        .map(|name| {
            let c = shared_containers
                .iter()
                .find(|c| label(c, "com.docker.compose.service") == Some(name));
            SharedView {
                name: name.clone(),
                reason: suggestions
                    .iter()
                    .find(|s| s.service == *name)
                    .map(|s| s.reason.clone()),
                image: c.map(|c| c.image.clone()),
                status: match c {
                    Some(c) if c.state == ContainerState::Running => "running",
                    Some(_) => "stopped",
                    None => "not_started",
                }
                .to_string(),
                container_id: c.map(|c| c.id.clone()),
                container_name: c.map(|c| c.name.clone()),
                ports: c.map(|c| c.ports.clone()).unwrap_or_default(),
                data_mode: ctx.dev.shared.get(name).map(|s| s.data).unwrap_or_default(),
            }
        })
        .collect();

    // Instances.
    let main_branch = ctx.main_branch();
    let gone = if with_git_details {
        ops::branches_with_gone_upstream(&ctx.project.root).await
    } else {
        Vec::new()
    };
    let mut instances = Vec::new();
    for (path, name) in &ctx.names {
        let wt = ctx.worktree(path);
        let st: Option<&DevInstanceState> = ctx.project.instance_by_path(path);
        let cp = core_dev::instance_compose_project(&ctx.project.id, name);
        let cs = by_project.get(cp.as_str()).cloned().unwrap_or_default();
        let services: Vec<ServiceView> = cs
            .iter()
            .map(|c| ServiceView {
                name: label(c, "com.docker.compose.service").unwrap_or(&c.name).to_string(),
                state: c.state,
                container_id: c.id.clone(),
                container_name: c.name.clone(),
                image: c.image.clone(),
            })
            .collect();
        let owner = format!("dev:{}:{name}", ctx.project.id);
        let routes: Vec<RouteView> = routes_cfg
            .iter()
            .filter(|r| r.owner.as_deref() == Some(owner.as_str()))
            .map(|r| RouteView {
                service: services
                    .iter()
                    .find(|s| s.container_name == r.container_name)
                    .map(|s| s.name.clone())
                    .or_else(|| {
                        r.container_name
                            .strip_prefix(&format!("{cp}-"))
                            .map(|s| s.trim_end_matches("-1").to_string())
                    }),
                hostname: r.hostname.clone(),
                path: r.path.clone(),
                url: if gw_port == 443 {
                    format!("https://{}", r.hostname)
                } else {
                    format!("https://{}:{gw_port}", r.hostname)
                },
            })
            .collect();

        let orphaned = wt.is_none_or(|w| w.prunable) || !path.exists();
        let job_id = jobs::running_for(&ctx.project.id, name).await;
        let last_job = jobs::list(Some(&ctx.project.id))
            .await
            .into_iter()
            .find(|j| j.instance.as_deref() == Some(name.as_str()));
        let last_error = last_job
            .as_ref()
            .filter(|j| j.status == jobs::JobStatus::Failed)
            .and_then(|j| j.error.clone());

        let running = services.iter().filter(|s| s.state == ContainerState::Running).count();
        let status = if let Some(j) = &job_id {
            let action = jobs::get(j).await.map(|j| j.action).unwrap_or_default();
            if action == "up" { "starting" } else { "stopping" }
        } else if orphaned {
            "orphaned"
        } else if !services.is_empty() && running == services.len() {
            "running"
        } else if running > 0 {
            "partial"
        } else if last_error.is_some() {
            "failed"
        } else if services.is_empty() && st.is_some_and(|s| s.idle_stopped_at.is_some()) {
            "idle_stopped"
        } else if !services.is_empty() || st.is_some_and(|s| s.last_started.is_some()) {
            "stopped"
        } else {
            "not_deployed"
        }
        .to_string();

        let (dirty, ahead) = if with_git_details && !orphaned {
            let dirty = ops::is_dirty(path).await;
            let ahead = match (&main_branch, wt.and_then(|w| w.branch.as_ref())) {
                (Some(base), Some(b)) if base != b => ops::commits_ahead(&ctx.project.root, base, b).await,
                _ => None,
            };
            (dirty, ahead)
        } else {
            (false, None)
        };

        instances.push(InstanceView {
            name: name.clone(),
            path: path.clone(),
            branch: wt.and_then(|w| w.branch.clone()),
            head: wt.and_then(|w| w.head.as_ref().map(|h| h.chars().take(8).collect())),
            is_main: wt.is_some_and(|w| w.is_main),
            orphaned,
            dirty,
            ahead,
            upstream_gone: wt.and_then(|w| w.branch.as_ref()).is_some_and(|b| gone.contains(b)),
            status,
            compose_project: cp,
            services,
            routes,
            ports: st.map(|s| s.ports.clone()).unwrap_or_default(),
            profiles: st.map(|s| s.profiles.clone()).unwrap_or_default(),
            hostname_overrides: st.map(|s| s.hostname_overrides.clone()).unwrap_or_default(),
            data_modes: shared_names
                .iter()
                .filter_map(|svc| {
                    let m = st
                        .and_then(|s| s.data_modes.get(svc).copied())
                        .or_else(|| ctx.dev.shared.get(svc).map(|x| x.data))
                        .unwrap_or_default();
                    (m != orca_core::dev::DataMode::Shared).then(|| (svc.clone(), m))
                })
                .collect(),
            tenants: st.map(|s| s.tenants.clone()).unwrap_or_default(),
            configured: st.is_some(),
            started_by: st.and_then(|s| s.started_by.clone()),
            last_started: st.and_then(|s| s.last_started.clone()),
            job_id,
            last_error,
        });
    }

    ProjectView {
        id: ctx.project.id.clone(),
        root: ctx.project.root.clone(),
        main_branch,
        orca_yaml: YamlInfo {
            exists: ctx.project.root.join("orca.yaml").exists(),
            has_dev: ctx.has_dev,
            error: ctx.yaml_error.clone(),
        },
        shared_source: if ctx.has_dev { "orca.yaml" } else { "suggested" },
        shared,
        instances,
        gateway: GatewayInfo {
            running: gw_running,
            domain: gw_domain,
            https_port: gw_port,
            dns,
            cert_names,
        },
        errors,
    }
}
