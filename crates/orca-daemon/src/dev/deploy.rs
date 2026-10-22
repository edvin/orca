//! Starting, stopping and removing instances and the shared stack.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use bollard::network::{ConnectNetworkOptions, DisconnectNetworkOptions, InspectNetworkOptions, ListNetworksOptions};
use bollard::secret::EndpointSettings;
use orca_core::dev::override_gen::{self, InstanceInput, InstancePlan, OwnDatabase, SharedPlan};
use orca_core::dev::schema::{DataMode, parse_hook};
use orca_core::dev::{self as core_dev, DevInstanceState, OrcaYaml, PortAssignment};
use orca_core::runtime::ContainerRuntime;
use serde::{Deserialize, Serialize};

use super::data::{self, DataChoice};
use super::jobs::{JobHandle, Locks};
use super::ops;
use super::project::ProjectCtx;
use crate::state::AppState;

#[derive(Debug, Clone, Default, Deserialize)]
pub struct UpOptions {
    /// Compose profiles to run (saved for next time); `None` keeps the last.
    pub profiles: Option<Vec<String>>,
    /// Rebuild images from the worktree's code (default true).
    pub build: Option<bool>,
    /// Who asked: "ui", "cli" or "mcp".
    pub source: Option<String>,
    /// Data mode per shared service for this start (saved for next time).
    pub data_modes: Option<BTreeMap<String, DataMode>>,
}

/// Everything needed to deploy one instance, computed without side effects
/// except (optionally) persisting port assignments.
pub struct Prepared {
    pub ctx: ProjectCtx,
    pub name: String,
    pub worktree: PathBuf,
    pub files: Vec<PathBuf>,
    pub plan: InstancePlan,
    pub resolved_mode: bool,
    /// Full `compose config` JSON (used in resolved mode).
    pub raw_config: serde_json::Value,
    /// Services this instance shares (own-server ones removed).
    pub shared: std::collections::BTreeSet<String>,
    pub instance_dev: core_dev::DevConfig,
    pub own_databases: BTreeMap<String, OwnDatabase>,
    pub own_servers: std::collections::BTreeSet<String>,
    pub data: Vec<DataChoice>,
    /// Compose profiles this start runs.
    pub profiles: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlanView {
    pub instance: String,
    pub worktree: PathBuf,
    pub compose_project: String,
    pub compose_files: Vec<PathBuf>,
    pub resolved_mode: bool,
    pub shared_services: Vec<String>,
    pub plan: InstancePlan,
    /// The profiles this plan runs.
    pub active_profiles: Vec<String>,
    /// Data choices per shared service (all of them, own-server included).
    pub data: Vec<DataChoice>,
}

/// Tell the UI an instance operation finished (Activity + notifications).
#[allow(clippy::too_many_arguments)]
pub fn emit(
    state: &AppState,
    project: &str,
    instance: &str,
    action: &str,
    succeeded: bool,
    source: &str,
    message: Option<String>,
    url: Option<String>,
) {
    let _ = state.events_tx.send(orca_core::event::Event {
        timestamp: chrono::Utc::now().to_rfc3339(),
        kind: orca_core::event::EventKind::DevInstance {
            project: project.to_string(),
            instance: instance.to_string(),
            action: action.to_string(),
            succeeded,
            source: source.to_string(),
            message,
            url,
        },
    });
}

fn owner(project: &str, instance: &str) -> String {
    format!("dev:{project}:{instance}")
}

fn shared_dir(project: &str) -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("orca")
        .join("dev")
        .join(project)
}

/// Load config, resolve compose, assign ports and plan. With `persist`,
/// the instance's state (name, ports) is saved.
pub async fn prepare(
    state: &AppState,
    project_id: &str,
    name: &str,
    profiles: Option<&[String]>,
    requested_modes: Option<&BTreeMap<String, DataMode>>,
    persist: bool,
) -> Result<Prepared> {
    prepare_with(state, project_id, name, profiles, requested_modes, persist, None).await
}

/// [`prepare`] with an optional `dev:` config that replaces orca.yaml on
/// disk, for dry-running edits in the orca.yaml editor.
pub async fn prepare_with(
    state: &AppState,
    project_id: &str,
    name: &str,
    profiles: Option<&[String]>,
    requested_modes: Option<&BTreeMap<String, DataMode>>,
    persist: bool,
    dev_override: Option<&core_dev::DevConfig>,
) -> Result<Prepared> {
    let mut ctx = ProjectCtx::load(state, project_id).await?;
    if let Some(d) = dev_override {
        ctx.dev = d.clone();
        ctx.has_dev = true;
        ctx.yaml_error = None;
    }
    if let Some(e) = &ctx.yaml_error {
        anyhow::bail!("{e}");
    }
    let worktree = ctx.path_of(name)?;
    if !worktree.exists() {
        anyhow::bail!("the worktree folder {} no longer exists", worktree.display());
    }
    let (shared_all, _) = ctx.shared(state).await?;

    // Per-instance settings come from the worktree's own orca.yaml, so a
    // branch can add services or env without touching main.
    let wt_yaml = OrcaYaml::load(&worktree).with_context(|| format!("orca.yaml in {}", worktree.display()))?;
    let instance_dev = match dev_override {
        Some(d) => d.clone(),
        None => wt_yaml.dev.clone().unwrap_or_else(|| ctx.dev.clone()),
    };
    let files = ops::compose_files(&worktree, wt_yaml.compose.as_ref().map(|c| c.to_vec()))?;
    let cp = core_dev::instance_compose_project(&ctx.project.id, name);
    let (model, raw_config) = ops::resolve_model(state, &worktree, &cp, &files).await?;

    let existing_state = ctx.project.instance_by_path(&worktree).cloned();

    // Data modes: own-server services leave the shared set and run in the
    // instance; own-database ones get a database of their own.
    let modes = data::effective_modes(&shared_all, &ctx.dev, existing_state.as_ref(), requested_modes);
    let own_servers: std::collections::BTreeSet<String> = modes
        .iter()
        .filter(|(_, m)| **m == DataMode::OwnServer)
        .map(|(s, _)| s.clone())
        .collect();
    let shared: std::collections::BTreeSet<String> = shared_all.difference(&own_servers).cloned().collect();
    let own_dbs = data::own_databases(&ctx.project, name, &ctx.dev, &model, &modes, existing_state.as_ref())?;
    let data_choices = data::choices(&shared_all, &ctx.dev, &model, &modes, existing_state.as_ref());
    let mut shared_dbs = ctx.shared_databases();
    for svc in &shared {
        if let Some(db) = data::shared_database(&ctx.dev, &model, svc) {
            shared_dbs.entry(svc.clone()).or_insert(db);
        }
    }
    let shared_endpoints: BTreeMap<String, String> = shared
        .iter()
        .filter_map(|svc| {
            let host_port = ctx.dev.shared.get(svc).and_then(|s| s.host_port).or_else(|| {
                model
                    .services
                    .get(svc)?
                    .ports
                    .iter()
                    .find_map(|p| p.published.as_ref()?.parse().ok())
            })?;
            Some((svc.clone(), format!("localhost:{host_port}")))
        })
        .collect();

    let profiles: Vec<String> = match profiles {
        Some(p) => p.to_vec(),
        None => existing_state.as_ref().map(|s| s.profiles.clone()).unwrap_or_default(),
    };

    // Assign host ports under the project lock so two instances never get
    // the same one.
    let _lock = Locks::get().lock("ports").await;
    let needed = override_gen::required_host_ports(&model, &instance_dev, &shared, &profiles)?;
    let ports: Vec<PortAssignment> = {
        let cfg = state.config.lock().await;
        let mine = existing_state.as_ref().map(|s| s.ports.clone()).unwrap_or_default();
        let mut taken: Vec<u16> = cfg
            .dev_projects
            .iter()
            .flat_map(|p| p.instances.iter())
            .filter(|i| i.path != worktree)
            .flat_map(|i| i.ports.iter().map(|a| a.host_port))
            .chain(
                cfg.dev_projects
                    .iter()
                    .flat_map(|p| p.instances.iter())
                    .flat_map(|i| i.host_services.values().copied()),
            )
            .collect();
        let mut out = Vec::new();
        for (svc, port) in needed {
            let a = core_dev::state::assign_port(&mine, &svc, port, &taken, |p| {
                // A port we already hold may be in use by our own running
                // container; that's fine.
                mine.iter().any(|m| m.host_port == p) || ops::port_is_free(p)
            })?;
            taken.push(a.host_port);
            out.push(a);
        }
        out
    };

    let gw = state.config.lock().await.gateway.clone();
    let (domain, https_port) = (gw.domain.clone(), gw.https_port);
    let overrides = existing_state
        .as_ref()
        .map(|s| s.hostname_overrides.clone())
        .unwrap_or_default();
    let mut plan = override_gen::plan_instance(&InstanceInput {
        project: &ctx.project.id,
        instance: name,
        worktree: &worktree,
        model: &model,
        dev: &instance_dev,
        shared: &shared,
        shared_databases: &shared_dbs,
        own_databases: &own_dbs,
        own_servers: &own_servers,
        shared_endpoints: &shared_endpoints,
        profiles: &profiles,
        hostname_overrides: &overrides,
        domain: &domain,
        https_port,
        ports: &ports,
    })?;
    plan.warnings.extend(orca_core::dev::hostnames::pattern_warnings(
        &instance_dev.naming.hostname,
    ));
    plan.warnings.extend(super::hostcheck::route_warnings(
        &gw,
        &owner(&ctx.project.id, name),
        &plan.routes,
    ));

    if persist {
        let mut cfg = state.config.lock().await;
        if let Some(p) = cfg.dev_projects.iter_mut().find(|p| p.id == ctx.project.id) {
            if p.instance_by_path(&worktree).is_none() {
                p.instances.push(DevInstanceState {
                    path: worktree.clone(),
                    name: name.to_string(),
                    ..Default::default()
                });
            }
            let s = p.instance_by_path_mut(&worktree).expect("just inserted");
            s.ports = ports.clone();
            if let Some(req) = requested_modes {
                // Only remember choices that differ from the project default.
                s.data_modes = req
                    .iter()
                    .filter(|(svc, m)| ctx.dev.shared.get(*svc).map(|x| x.data).unwrap_or_default() != **m)
                    .map(|(k, v)| (k.clone(), *v))
                    .collect();
            }
            for (svc, own) in &own_dbs {
                s.tenants.insert(svc.clone(), own.tenant.clone());
            }
        }
        cfg.save()?;
    }

    let resolved_mode = !ops::supports_override_tags(state).await;
    Ok(Prepared {
        ctx,
        name: name.to_string(),
        worktree,
        files,
        plan,
        resolved_mode,
        raw_config,
        shared,
        instance_dev,
        own_databases: own_dbs,
        own_servers,
        data: data_choices,
        profiles,
    })
}

pub async fn plan_view(
    state: &AppState,
    project_id: &str,
    name: &str,
    profiles: Option<&[String]>,
    modes: Option<&BTreeMap<String, DataMode>>,
) -> Result<PlanView> {
    plan_view_with(state, project_id, name, profiles, modes, None).await
}

pub async fn plan_view_with(
    state: &AppState,
    project_id: &str,
    name: &str,
    profiles: Option<&[String]>,
    modes: Option<&BTreeMap<String, DataMode>>,
    dev_override: Option<&core_dev::DevConfig>,
) -> Result<PlanView> {
    let p = prepare_with(state, project_id, name, profiles, modes, false, dev_override).await?;
    Ok(PlanView {
        instance: p.name.clone(),
        worktree: p.worktree.clone(),
        compose_project: p.plan.compose_project.clone(),
        compose_files: p.files.clone(),
        resolved_mode: p.resolved_mode,
        shared_services: p.shared.iter().cloned().collect(),
        active_profiles: p.profiles.clone(),
        data: p.data,
        plan: p.plan,
    })
}

/// Write `.orca/` and return the compose args that select the instance's files.
fn write_instance_files(p: &Prepared) -> Result<Vec<String>> {
    let dir = p.worktree.join(core_dev::ORCA_DIR);
    std::fs::create_dir_all(&dir).with_context(|| format!("could not create {}", dir.display()))?;
    // Self-ignoring folder: nothing Orca writes ever shows up in git.
    std::fs::write(dir.join(".gitignore"), "# Generated by Orca\n*\n")?;
    std::fs::write(dir.join(core_dev::ENV_FILE), &p.plan.env_file)?;
    let info = serde_json::json!({
        "project": p.ctx.project.id,
        "instance": p.name,
        "compose_project": p.plan.compose_project,
        "worktree": p.worktree,
        "services": p.plan.running_services,
        "routes": p.plan.routes,
        "host_ports": p.plan.host_ports,
        "resolved_mode": p.resolved_mode,
    });
    std::fs::write(dir.join(core_dev::INSTANCE_FILE), serde_json::to_string_pretty(&info)?)?;

    let mut args = vec![
        "-p".to_string(),
        p.plan.compose_project.clone(),
        "--project-directory".to_string(),
        p.worktree.to_string_lossy().to_string(),
    ];
    if p.resolved_mode {
        let mut raw = p.raw_config.clone();
        override_gen::apply_resolved(&mut raw, &p.plan.edits, &p.plan.running_services);
        let path = dir.join(core_dev::RESOLVED_FILE);
        std::fs::write(&path, serde_json::to_string_pretty(&raw)?)?;
        let _ = std::fs::remove_file(dir.join(core_dev::OVERRIDE_FILE));
        args.extend(["-f".into(), path.to_string_lossy().to_string()]);
    } else {
        let path = dir.join(core_dev::OVERRIDE_FILE);
        std::fs::write(&path, &p.plan.override_yaml)?;
        let _ = std::fs::remove_file(dir.join(core_dev::RESOLVED_FILE));
        for f in &p.files {
            args.extend(["-f".into(), f.to_string_lossy().to_string()]);
        }
        args.extend(["-f".into(), path.to_string_lossy().to_string()]);
    }
    Ok(args)
}

// --- Shared stack ------------------------------------------------------------

async fn plan_shared(state: &AppState, ctx: &ProjectCtx) -> Result<Option<(SharedPlan, Vec<String>)>> {
    let (shared, _) = ctx.shared(state).await?;
    if shared.is_empty() {
        return Ok(None);
    }
    let files = ctx.root_compose_files()?;
    let cp = ctx.shared_cp();
    let (model, raw) = ops::resolve_model(state, &ctx.project.root, &cp, &files).await?;
    let plan = override_gen::plan_shared(&ctx.project.id, &cp, &model, &ctx.dev, &shared)?;
    if plan.services.is_empty() {
        return Ok(None);
    }
    let dir = shared_dir(&ctx.project.id);
    std::fs::create_dir_all(&dir)?;
    let mut args = vec![
        "-p".to_string(),
        cp,
        "--project-directory".to_string(),
        ctx.project.root.to_string_lossy().to_string(),
    ];
    if ops::supports_override_tags(state).await {
        let path = dir.join("shared.override.yaml");
        std::fs::write(&path, &plan.override_yaml)?;
        for f in &files {
            args.extend(["-f".into(), f.to_string_lossy().to_string()]);
        }
        args.extend(["-f".into(), path.to_string_lossy().to_string()]);
    } else {
        let mut raw = raw;
        override_gen::apply_resolved(&mut raw, &plan.edits, &plan.services);
        let path = dir.join("shared.resolved.yaml");
        std::fs::write(&path, serde_json::to_string_pretty(&raw)?)?;
        args.extend(["-f".into(), path.to_string_lossy().to_string()]);
    }
    Ok(Some((plan, args)))
}

/// Bring the shared stack up and wait until its services are healthy.
async fn ensure_shared(state: &AppState, ctx: &ProjectCtx, job: &JobHandle) -> Result<Option<String>> {
    let _lock = Locks::get().lock(&format!("shared:{}", ctx.project.id)).await;
    let Some((plan, mut args)) = plan_shared(state, ctx).await? else {
        return Ok(None);
    };
    for w in &plan.warnings {
        job.log(format!("warning: {w}")).await;
    }
    args.extend([
        "up".into(),
        "-d".into(),
        "--wait".into(),
        "--wait-timeout".into(),
        "180".into(),
    ]);
    args.extend(plan.services.iter().cloned());
    ops::compose_ok(state, &ctx.project.root, &args, Some(job))
        .await
        .context("shared services did not start")?;
    Ok(Some(plan.services.join(", ")))
}

pub async fn shared_up(state: Arc<AppState>, project_id: String) -> Result<JobHandle> {
    let job = JobHandle::create(
        &project_id,
        None,
        "shared_up",
        &[
            ("shared", "Start shared services"),
            ("wire", "Reconnect running instances"),
        ],
    )
    .await;
    let j = job.clone();
    tokio::spawn(async move {
        let r: Result<()> = async {
            let ctx = ProjectCtx::load(&state, &project_id).await?;
            j.start("shared").await;
            let started = ensure_shared(&state, &ctx, &j).await?;
            j.done("shared", started).await;
            j.start("wire").await;
            let n = rewire_all(&state, &ctx, &j).await?;
            j.done("wire", Some(format!("{n} instance(s)"))).await;
            Ok(())
        }
        .await;
        match r {
            Ok(()) => j.succeed(None).await,
            Err(e) => j.fail(&e).await,
        }
    });
    Ok(job)
}

pub async fn shared_down(state: Arc<AppState>, project_id: String) -> Result<JobHandle> {
    let job = JobHandle::create(&project_id, None, "shared_down", &[("stop", "Stop shared services")]).await;
    let j = job.clone();
    tokio::spawn(async move {
        let r: Result<()> = async {
            let ctx = ProjectCtx::load(&state, &project_id).await?;
            j.start("stop").await;
            let cp = ctx.shared_cp();
            ops::compose_ok(&state, &ctx.project.root, &["-p".into(), cp, "down".into()], Some(&j)).await?;
            j.done("stop", Some("data volumes kept".into())).await;
            Ok(())
        }
        .await;
        match r {
            Ok(()) => j.succeed(None).await,
            Err(e) => j.fail(&e).await,
        }
    });
    Ok(job)
}

// --- Network wiring ------------------------------------------------------------

/// Networks created by a compose project.
async fn project_networks(state: &AppState, compose_project: &str) -> Result<Vec<String>> {
    let rt = state.rt().await;
    let mut filters = std::collections::HashMap::new();
    filters.insert(
        "label".to_string(),
        vec![format!("com.docker.compose.project={compose_project}")],
    );
    let nets = rt.docker.list_networks(Some(ListNetworksOptions { filters })).await?;
    Ok(nets.into_iter().filter_map(|n| n.name).collect())
}

async fn network_members(state: &AppState, network: &str) -> Result<Vec<String>> {
    let rt = state.rt().await;
    let net = rt
        .docker
        .inspect_network(network, None::<InspectNetworkOptions<String>>)
        .await?;
    Ok(net.containers.map(|c| c.into_keys().collect()).unwrap_or_default())
}

/// Attach every shared container to the instance's networks under its
/// service name, so the app reaches `postgres` as usual.
async fn wire_shared(
    state: &AppState,
    shared_cp: &str,
    skip: &std::collections::BTreeSet<String>,
    networks: &[String],
    job: Option<&JobHandle>,
) -> Result<usize> {
    let rt = state.rt().await;
    let containers = rt.list_containers(false).await?;
    let shared: Vec<_> = containers
        .iter()
        .filter(|c| c.labels.get("com.docker.compose.project").map(String::as_str) == Some(shared_cp))
        // An instance running its own copy of a service must not also see
        // the shared one under the same name.
        .filter(|c| {
            c.labels
                .get("com.docker.compose.service")
                .is_none_or(|s| !skip.contains(s))
        })
        .collect();
    let mut connected = 0;
    for net in networks {
        let members = network_members(state, net).await.unwrap_or_default();
        for c in &shared {
            if members.iter().any(|m| m == &c.id) {
                continue;
            }
            let Some(service) = c.labels.get("com.docker.compose.service") else {
                continue;
            };
            rt.docker
                .connect_network(
                    net,
                    ConnectNetworkOptions {
                        container: c.id.clone(),
                        endpoint_config: EndpointSettings {
                            aliases: Some(vec![service.clone()]),
                            ..Default::default()
                        },
                    },
                )
                .await
                .with_context(|| format!("could not connect {service} to {net}"))?;
            if let Some(j) = job {
                j.log(format!("connected shared '{service}' to network {net}")).await;
            }
            connected += 1;
        }
    }
    Ok(connected)
}

/// Re-attach shared services to every running instance (after the shared
/// stack was recreated).
async fn rewire_all(state: &AppState, ctx: &ProjectCtx, job: &JobHandle) -> Result<usize> {
    let mut n = 0;
    let (shared_all, _) = ctx.shared(state).await?;
    for (path, name) in &ctx.names {
        let cp = core_dev::instance_compose_project(&ctx.project.id, name);
        let nets = project_networks(state, &cp).await?;
        if nets.is_empty() {
            continue;
        }
        let modes = data::effective_modes(&shared_all, &ctx.dev, ctx.project.instance_by_path(path), None);
        let skip = modes
            .iter()
            .filter(|(_, m)| **m == DataMode::OwnServer)
            .map(|(s, _)| s.clone())
            .collect();
        wire_shared(state, &ctx.shared_cp(), &skip, &nets, Some(job)).await?;
        n += 1;
    }
    Ok(n)
}

/// Detach containers from other stacks (shared services, the gateway) so
/// `compose down` can remove the instance's networks.
async fn detach_foreign(state: &AppState, compose_project: &str) -> Result<()> {
    let rt = state.rt().await;
    let containers = rt.list_containers(true).await?;
    for net in project_networks(state, compose_project).await? {
        for member in network_members(state, &net).await.unwrap_or_default() {
            let own = containers
                .iter()
                .find(|c| c.id == member)
                .and_then(|c| c.labels.get("com.docker.compose.project"))
                .is_some_and(|p| p == compose_project);
            if !own {
                let _ = rt
                    .docker
                    .disconnect_network(
                        &net,
                        DisconnectNetworkOptions {
                            container: member.clone(),
                            force: true,
                        },
                    )
                    .await;
            }
        }
    }
    Ok(())
}

// --- Gateway -------------------------------------------------------------------

/// Replace the instance's gateway routes with the planned ones. Routes that
/// someone else owns keep their hostname; ours is skipped with a warning.
async fn register_routes(
    state: &AppState,
    project: &str,
    instance: &str,
    plan: &InstancePlan,
    job: &JobHandle,
) -> Result<usize> {
    let me = owner(project, instance);
    let gw_config = {
        let mut cfg = state.config.lock().await;
        cfg.gateway.routes.retain(|r| r.owner.as_deref() != Some(me.as_str()));
        let mut added = 0;
        for r in &plan.routes {
            if let Some(other) = cfg
                .gateway
                .routes
                .iter()
                .find(|x| x.hostname == r.hostname && x.path == r.path)
            {
                job.log(format!(
                    "warning: {} is already used by {}, so {} gets no URL; give it its own hostname in this instance's Settings",
                    r.hostname,
                    super::hostcheck::describe_owner(other.owner.as_deref()),
                    r.service
                ))
                .await;
                continue;
            }
            cfg.gateway.routes.push(orca_core::config::GatewayRoute {
                hostname: r.hostname.clone(),
                container_name: r.container_name.clone(),
                port: r.port,
                enabled: true,
                path: r.path.clone(),
                owner: Some(me.clone()),
                sleeping: false,
                presentation: Default::default(),
            });
            added += 1;
        }
        cfg.save()?;
        let _ = added;
        cfg.gateway.clone()
    };

    let ours: Vec<_> = gw_config
        .routes
        .iter()
        .filter(|r| r.owner.as_deref() == Some(me.as_str()))
        .cloned()
        .collect();
    if ours.is_empty() {
        if crate::gateway::is_running(state).await.unwrap_or(false) {
            crate::gateway::apply_config(&gw_config).await?;
        }
        return Ok(0);
    }
    if !crate::gateway::is_running(state).await.unwrap_or(false) {
        job.log("starting the gateway").await;
        crate::gateway::start(state, &gw_config)
            .await
            .context("could not start the gateway")?;
    }
    crate::gateway::apply_config(&gw_config).await?;
    for r in &ours {
        if let Err(e) = crate::gateway::ensure_network_connectivity(state, &r.container_name).await {
            job.log(format!("warning: gateway could not reach {}: {e}", r.container_name))
                .await;
        }
    }
    Ok(ours.len())
}

/// Point the instance's routes at the "waking up" page.
async fn sleep_routes(state: &AppState, project: &str, instance: &str) -> Result<usize> {
    let me = owner(project, instance);
    let host = format!("{me}#host");
    let gw = {
        let mut cfg = state.config.lock().await;
        cfg.gateway.routes.retain(|r| r.owner.as_deref() != Some(host.as_str()));
        let mut n = 0;
        for r in cfg
            .gateway
            .routes
            .iter_mut()
            .filter(|r| r.owner.as_deref() == Some(me.as_str()))
        {
            r.sleeping = true;
            n += 1;
        }
        cfg.save()?;
        (n, cfg.gateway.clone())
    };
    if crate::gateway::is_running(state).await.unwrap_or(false) {
        crate::gateway::apply_config(&gw.1).await?;
    }
    Ok(gw.0)
}

async fn unregister_routes(state: &AppState, project: &str, instance: &str) -> Result<usize> {
    let me = owner(project, instance);
    let host = format!("{me}#host");
    let (removed, gw_config) = {
        let mut cfg = state.config.lock().await;
        let before = cfg.gateway.routes.len();
        cfg.gateway
            .routes
            .retain(|r| r.owner.as_deref() != Some(me.as_str()) && r.owner.as_deref() != Some(host.as_str()));
        let removed = before - cfg.gateway.routes.len();
        if removed > 0 {
            cfg.save()?;
        }
        (removed, cfg.gateway.clone())
    };
    if removed > 0 && crate::gateway::is_running(state).await.unwrap_or(false) {
        crate::gateway::apply_config(&gw_config).await?;
    }
    Ok(removed)
}

// --- Instance lifecycle ----------------------------------------------------------

const UP_STEPS: &[(&str, &str)] = &[
    ("check", "Read compose files and orca.yaml"),
    ("shared", "Start shared services"),
    ("data", "Prepare data"),
    ("plan", "Generate override and env"),
    ("create", "Build images and create containers"),
    ("wire", "Connect shared services"),
    ("start", "Start containers"),
    ("routes", "Register gateway routes"),
    ("hooks", "Run after_up hooks"),
];

pub async fn up(state: Arc<AppState>, project_id: String, name: String, opts: UpOptions) -> Result<JobHandle> {
    if let Some(id) = super::jobs::running_for(&project_id, &name).await {
        anyhow::bail!("instance '{name}' is busy (job {id})");
    }
    check_running_cap(&state, &project_id, &name).await?;
    let job = JobHandle::create(&project_id, Some(&name), "up", UP_STEPS).await;
    let j = job.clone();
    tokio::spawn(async move {
        let _guard = Locks::get().lock(&format!("instance:{project_id}:{name}")).await;
        let source = opts.source.clone().unwrap_or_else(|| "ui".into());
        match run_up(&state, &project_id, &name, &opts, &j).await {
            Ok(result) => {
                let url = result["urls"]
                    .get(0)
                    .and_then(|u| u["url"].as_str())
                    .map(str::to_string);
                emit(&state, &project_id, &name, "up", true, &source, None, url);
                j.succeed(Some(result)).await
            }
            Err(e) => {
                tracing::warn!("dev up {project_id}/{name} failed: {e:#}");
                emit(
                    &state,
                    &project_id,
                    &name,
                    "up",
                    false,
                    &source,
                    Some(format!("{e:#}")),
                    None,
                );
                j.fail(&e).await
            }
        }
    });
    Ok(job)
}

async fn run_up(
    state: &AppState,
    project_id: &str,
    name: &str,
    opts: &UpOptions,
    j: &JobHandle,
) -> Result<serde_json::Value> {
    j.start("check").await;
    let p = prepare(
        state,
        project_id,
        name,
        opts.profiles.as_deref(),
        opts.data_modes.as_ref(),
        true,
    )
    .await?;
    for w in &p.plan.warnings {
        j.log(format!("warning: {w}")).await;
    }
    let files: Vec<String> = p
        .files
        .iter()
        .map(|f| {
            f.file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default()
        })
        .collect();
    j.done(
        "check",
        Some(format!(
            "{}{}",
            files.join(", "),
            if p.resolved_mode {
                " (older Compose: using a resolved file)"
            } else {
                ""
            }
        )),
    )
    .await;

    j.start("shared").await;
    match ensure_shared(state, &p.ctx, j).await? {
        Some(s) => j.done("shared", Some(s)).await,
        None => j.skip("shared", "no shared services").await,
    }

    j.start("data").await;
    let created = if p.own_databases.is_empty() {
        let shared_list: Vec<&str> = p.shared.iter().map(String::as_str).collect();
        let detail = match (shared_list.is_empty(), p.own_servers.is_empty()) {
            (true, true) => "nothing shared".to_string(),
            (false, true) => format!("shared data: {}", shared_list.join(", ")),
            (_, false) => format!(
                "own server: {}",
                p.own_servers.iter().cloned().collect::<Vec<_>>().join(", ")
            ),
        };
        j.skip("data", &detail).await;
        Vec::new()
    } else {
        let created = data::ensure_tenants(state, &p.ctx.shared_cp(), &p.ctx.dev, &p.own_databases, j).await?;
        let names: Vec<String> = p
            .own_databases
            .iter()
            .map(|(s, d)| format!("{s}: {}", d.tenant))
            .collect();
        j.done(
            "data",
            Some(format!(
                "{}{}",
                names.join(", "),
                if created.is_empty() { "" } else { " (new)" }
            )),
        )
        .await;
        created
    };

    j.start("plan").await;
    let base_args = write_instance_files(&p)?;
    j.done(
        "plan",
        Some(format!(
            "{} service(s), {} route(s), {} host port(s)",
            p.plan.running_services.len(),
            p.plan.routes.len(),
            p.plan.host_ports.len()
        )),
    )
    .await;

    // Create first, wire shared services in, then start: the app must be
    // able to resolve `postgres` the moment it boots.
    j.start("create").await;
    let mut args = base_args.clone();
    args.extend(["up".into(), "--no-start".into()]);
    if opts.build.unwrap_or(true) {
        args.push("--build".into());
    }
    args.extend(p.plan.services.iter().cloned());
    ops::compose_ok(state, &p.worktree, &args, Some(j)).await?;
    j.done("create", None).await;

    j.start("wire").await;
    if p.shared.is_empty() {
        j.skip("wire", "nothing shared").await;
    } else {
        let mut nets = project_networks(state, &p.plan.compose_project).await?;
        if nets.is_empty() {
            nets = p.plan.networks.clone();
        }
        let n = wire_shared(state, &p.ctx.shared_cp(), &p.own_servers, &nets, Some(j)).await?;
        j.done("wire", Some(format!("{n} new connection(s)"))).await;
    }

    j.start("start").await;
    let mut args = base_args.clone();
    args.extend(["up".into(), "-d".into()]);
    args.extend(p.plan.services.iter().cloned());
    ops::compose_ok(state, &p.worktree, &args, Some(j)).await?;
    j.done("start", Some(p.plan.running_services.join(", "))).await;

    // Services of profiles no longer picked: stop them, if they ran before.
    if !p.plan.left_out.is_empty() {
        let cp = &p.plan.compose_project;
        let running_before = state.rt().await.list_containers(false).await?.into_iter().any(|c| {
            c.labels.get("com.docker.compose.project") == Some(cp)
                && c.labels
                    .get("com.docker.compose.service")
                    .is_some_and(|s| p.plan.left_out.contains(s))
        });
        if running_before {
            let mut args = base_args.clone();
            args.extend(["rm".into(), "-sf".into()]);
            args.extend(p.plan.left_out.iter().cloned());
            ops::compose_ok(state, &p.worktree, &args, Some(j)).await?;
        }
    }

    j.start("routes").await;
    let n = register_routes(state, project_id, name, &p.plan, j).await?;
    if n == 0 {
        j.skip("routes", "nothing to open in a browser").await;
    } else {
        j.done("routes", Some(format!("{n} route(s)"))).await;
    }

    j.start("hooks").await;
    let mut hooks: Vec<String> = Vec::new();
    if !created.is_empty() {
        hooks.extend(p.instance_dev.instance.hooks.after_own_database.iter().cloned());
    }
    hooks.extend(p.instance_dev.instance.hooks.after_up.iter().cloned());
    let hooks = &hooks;
    if hooks.is_empty() {
        j.skip("hooks", "none configured").await;
    } else {
        for h in hooks {
            let (svc, cmd) = parse_hook(h)?;
            if !p.plan.running_services.contains(&svc) {
                j.log(format!("skipping hook for '{svc}': its profile isn't running"))
                    .await;
                continue;
            }
            let mut args = base_args.clone();
            args.extend([
                "exec".into(),
                "-T".into(),
                svc.clone(),
                "sh".into(),
                "-c".into(),
                cmd.clone(),
            ]);
            ops::compose_ok(state, &p.worktree, &args, Some(j))
                .await
                .with_context(|| format!("hook '{h}' failed"))?;
        }
        j.done("hooks", Some(format!("{} hook(s)", hooks.len()))).await;
    }

    // Remember who started it and when.
    {
        let mut cfg = state.config.lock().await;
        if let Some(proj) = cfg.dev_projects.iter_mut().find(|x| x.id == project_id)
            && let Some(s) = proj.instance_by_path_mut(&p.worktree)
        {
            s.last_started = Some(chrono::Utc::now().to_rfc3339());
            s.idle_stopped_at = None;
            s.started_by = Some(opts.source.clone().unwrap_or_else(|| "ui".into()));
            s.profiles = p.profiles.clone();
        }
        cfg.save()?;
    }

    Ok(serde_json::json!({
        "compose_project": p.plan.compose_project,
        "urls": p.plan.routes.iter().map(|r| {
            let path = r.path.as_deref().map(|x| x.trim_end_matches('*').trim_end_matches('/')).unwrap_or("");
            serde_json::json!({"service": r.service, "url": format!("{}{path}", r.url)})
        }).collect::<Vec<_>>(),
        "host_ports": p.plan.host_ports,
        "env_file": p.worktree.join(core_dev::ORCA_DIR).join(core_dev::ENV_FILE),
        "warnings": p.plan.warnings,
    }))
}

/// How an instance is taken down.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DownMode {
    /// Stop it; routes are removed.
    Stop,
    /// Stop it and delete everything it owns.
    Remove,
    /// Stop it for being idle; its URLs show a "waking up" page and a
    /// request starts it again.
    Sleep,
}

pub async fn down(state: Arc<AppState>, project_id: String, name: String, mode: DownMode) -> Result<JobHandle> {
    let remove = mode == DownMode::Remove;
    if let Some(id) = super::jobs::running_for(&project_id, &name).await {
        anyhow::bail!("instance '{name}' is busy (job {id})");
    }
    let steps: &[(&str, &str)] = if remove {
        &[
            ("stop", "Stop and remove containers and volumes"),
            ("routes", "Remove gateway routes"),
            ("cleanup", "Remove images, ports and generated files"),
        ]
    } else {
        &[
            ("stop", "Stop and remove containers"),
            ("routes", "Remove gateway routes"),
        ]
    };
    let job = JobHandle::create(&project_id, Some(&name), if remove { "remove" } else { "down" }, steps).await;
    let j = job.clone();
    tokio::spawn(async move {
        let _guard = Locks::get().lock(&format!("instance:{project_id}:{name}")).await;
        let r: Result<()> = async {
            let ctx = ProjectCtx::load(&state, &project_id).await?;
            let path = ctx.path_of(&name)?;
            let cp = core_dev::instance_compose_project(&project_id, &name);
            let dir = if path.exists() {
                path.clone()
            } else {
                ctx.project.root.clone()
            };

            j.start("stop").await;
            detach_foreign(&state, &cp).await?;
            let mut args = vec!["-p".to_string(), cp.clone(), "down".to_string()];
            if remove {
                args.push("-v".into());
            }
            ops::compose_ok(&state, &dir, &args, Some(&j)).await?;
            j.done("stop", None).await;

            j.start("routes").await;
            if mode == DownMode::Sleep {
                let n = sleep_routes(&state, &project_id, &name).await?;
                j.done("routes", Some(format!("{n} waiting for a request"))).await;
            } else {
                let n = unregister_routes(&state, &project_id, &name).await?;
                j.done("routes", Some(format!("{n} removed"))).await;
            }

            if remove {
                j.start("cleanup").await;
                // Drop the instance's own databases in shared servers.
                let tenants = ctx
                    .project
                    .instance_by_path(&path)
                    .map(|s| s.tenants.clone())
                    .unwrap_or_default();
                if !tenants.is_empty() {
                    let files = ctx.root_compose_files()?;
                    let model = ops::resolve_model_cached(&state, &ctx.project.root, &ctx.shared_cp(), &files).await?;
                    for (svc, tenant) in &tenants {
                        let Some(kind) = model.services.get(svc).and_then(orca_core::dev::tenancy::detect_kind) else {
                            continue;
                        };
                        match data::drop_tenant(&state, &ctx.shared_cp(), svc, kind, tenant).await {
                            Ok(()) => j.log(format!("dropped {svc} database {tenant}")).await,
                            Err(e) => j.log(format!("could not drop {svc} database {tenant}: {e}")).await,
                        }
                    }
                }
                remove_images(&state, &cp, &j).await;
                {
                    let mut cfg = state.config.lock().await;
                    if let Some(proj) = cfg.dev_projects.iter_mut().find(|x| x.id == project_id) {
                        proj.instances.retain(|i| i.path != path);
                    }
                    cfg.save()?;
                }
                let orca_dir = path.join(core_dev::ORCA_DIR);
                if orca_dir.exists() {
                    let _ = std::fs::remove_dir_all(&orca_dir);
                }
                j.done("cleanup", None).await;
            }
            Ok(())
        }
        .await;
        let action = match mode {
            DownMode::Remove => "remove",
            DownMode::Stop => "down",
            DownMode::Sleep => "idle_stop",
        };
        let source = if mode == DownMode::Sleep { "orca" } else { "ui" };
        match r {
            Ok(()) => {
                emit(&state, &project_id, &name, action, true, source, None, None);
                j.succeed(None).await
            }
            Err(e) => {
                emit(
                    &state,
                    &project_id,
                    &name,
                    action,
                    false,
                    source,
                    Some(format!("{e:#}")),
                    None,
                );
                j.fail(&e).await
            }
        }
    });
    Ok(job)
}

/// Remove images Orca tagged for this instance (`<compose project>-<service>`).
async fn remove_images(state: &AppState, compose_project: &str, job: &JobHandle) {
    let rt = state.rt().await;
    let Ok(images) = rt.docker.list_images::<String>(None).await else {
        return;
    };
    let prefix = format!("{compose_project}-");
    for img in images {
        for tag in img.repo_tags.iter().filter(|t| t.starts_with(&prefix)) {
            match rt.docker.remove_image(tag, None, None).await {
                Ok(_) => job.log(format!("removed image {tag}")).await,
                Err(e) => job.log(format!("could not remove image {tag}: {e}")).await,
            }
        }
    }
}

/// Recent logs of an instance (all services, or one).
pub async fn logs(
    state: &AppState,
    project_id: &str,
    name: &str,
    service: Option<&str>,
    tail: u32,
    since: Option<&str>,
) -> Result<String> {
    let ctx = ProjectCtx::load(state, project_id).await?;
    let path = ctx.path_of(name)?;
    let dir = if path.exists() { path } else { ctx.project.root.clone() };
    let cp = core_dev::instance_compose_project(project_id, name);
    let mut args = vec![
        "-p".to_string(),
        cp,
        "logs".to_string(),
        "--no-color".to_string(),
        "--timestamps".to_string(),
        "--tail".to_string(),
        tail.to_string(),
    ];
    if let Some(s) = since {
        args.extend(["--since".into(), s.to_string()]);
    }
    if let Some(s) = service {
        args.push(s.to_string());
    }
    let run = ops::compose(state, &dir, &args, None).await?;
    Ok(run.stdout)
}

/// Update per-instance settings (rename, hostname overrides, profiles).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct InstanceSettings {
    pub name: Option<String>,
    pub hostname_overrides: Option<BTreeMap<String, String>>,
    pub profiles: Option<Vec<String>>,
    /// New data modes. Takes effect on the next start.
    pub data_modes: Option<BTreeMap<String, DataMode>>,
    /// When leaving own-database mode: delete that database (else keep it
    /// for when the instance switches back).
    #[serde(default)]
    pub drop_data: bool,
}

pub async fn update_settings(state: &AppState, project_id: &str, name: &str, s: InstanceSettings) -> Result<String> {
    let ctx = ProjectCtx::load(state, project_id).await?;
    let path = ctx.path_of(name)?;
    let cp = core_dev::instance_compose_project(project_id, name);

    if let Some(new) = &s.name
        && new != name
    {
        core_dev::naming::validate_name(new)?;
        if ctx.names.iter().any(|(_, n)| n == new) {
            anyhow::bail!("another instance is already called '{new}'");
        }
        let rt = state.rt().await;
        let has_containers = rt
            .list_containers(true)
            .await?
            .iter()
            .any(|c| c.labels.get("com.docker.compose.project") == Some(&cp));
        if has_containers {
            anyhow::bail!("stop '{name}' before renaming it: its containers are named after the instance");
        }
    }
    if let Some(ov) = &s.hostname_overrides {
        for h in ov.values() {
            override_gen::validate_hostname(h)?;
        }
    }

    let mut cfg = state.config.lock().await;
    let proj = cfg
        .dev_projects
        .iter_mut()
        .find(|p| p.id == project_id)
        .ok_or_else(|| anyhow::anyhow!("project '{project_id}' is not registered"))?;
    if proj.instance_by_path(&path).is_none() {
        proj.instances.push(DevInstanceState {
            path: path.clone(),
            name: name.to_string(),
            ..Default::default()
        });
    }
    let inst = proj.instance_by_path_mut(&path).expect("just inserted");
    if let Some(new) = s.name {
        inst.name = new;
    }
    if let Some(ov) = s.hostname_overrides {
        inst.hostname_overrides = ov.into_iter().filter(|(_, v)| !v.trim().is_empty()).collect();
    }
    if let Some(p) = s.profiles {
        inst.profiles = p.into_iter().filter(|p| !p.is_empty()).collect();
    }
    let mut to_drop: Vec<(String, String)> = Vec::new();
    if let Some(modes) = s.data_modes {
        for (svc, mode) in &modes {
            if *mode != DataMode::OwnDatabase
                && let Some(t) = inst.tenants.get(svc).cloned()
                && s.drop_data
            {
                to_drop.push((svc.clone(), t));
                inst.tenants.remove(svc);
            }
        }
        let defaults: BTreeMap<String, DataMode> = ctx.dev.shared.iter().map(|(k, v)| (k.clone(), v.data)).collect();
        inst.data_modes = modes
            .into_iter()
            .filter(|(svc, m)| defaults.get(svc).copied().unwrap_or_default() != *m)
            .collect();
    }
    let final_name = inst.name.clone();
    cfg.save()?;
    drop(cfg);

    // Drop databases the user chose to delete; needs the shared server up.
    if !to_drop.is_empty() {
        let files = ops::compose_files(&path, None).or_else(|_| ctx.root_compose_files())?;
        let (model, _) = ops::resolve_model(state, &path, &cp, &files).await?;
        for (svc, tenant) in to_drop {
            let kind = model
                .services
                .get(&svc)
                .and_then(orca_core::dev::tenancy::detect_kind)
                .ok_or_else(|| anyhow::anyhow!("can't tell what kind of server {svc} is"))?;
            data::drop_tenant(state, &ctx.shared_cp(), &svc, kind, &tenant).await?;
        }
    }
    Ok(final_name)
}

/// Resolve the project and instance a path belongs to.
pub async fn resolve_path(state: &AppState, path: &Path) -> Result<(String, String, PathBuf)> {
    let wt = ops::worktree_root(path)
        .await
        .map_err(|_| anyhow::anyhow!("{} is not inside a git repository", path.display()))?;
    let root = ops::main_root(path).await?;
    let project_id = {
        let cfg = state.config.lock().await;
        cfg.dev_projects
            .iter()
            .find(|p| ops::canonical(&p.root) == root)
            .map(|p| p.id.clone())
    }
    .ok_or_else(|| {
        anyhow::anyhow!(
            "this repository ({}) is not registered with Orca. Add it in Orca's Projects page, or run `orca projects add {}`",
            root.display(),
            root.display()
        )
    })?;
    let ctx = ProjectCtx::load(state, &project_id).await?;
    let name = ctx
        .name_of(&wt)
        .ok_or_else(|| anyhow::anyhow!("{} is not a worktree git knows about", wt.display()))?;
    Ok((project_id, name, wt))
}

/// Per shared service: mode, this instance's database and its size.
#[derive(Debug, Clone, Serialize)]
pub struct DataInfo {
    #[serde(flatten)]
    pub choice: DataChoice,
    pub size: Option<u64>,
    pub shared_size: Option<u64>,
}

pub async fn data_info(state: &AppState, project_id: &str, name: &str) -> Result<Vec<DataInfo>> {
    let p = prepare(state, project_id, name, None, None, false).await?;
    let shared_cp = p.ctx.shared_cp();
    let mut out = Vec::new();
    for c in p.data {
        let (size, shared_size) = match (c.kind, &c.tenant, &c.shared_db) {
            (Some(kind), tenant, Some(shared_db)) => {
                let size = match tenant {
                    Some(t) if c.mode == DataMode::OwnDatabase => {
                        data::tenant_size(state, &shared_cp, &c.service, kind, t).await
                    }
                    _ => None,
                };
                (
                    size,
                    data::tenant_size(state, &shared_cp, &c.service, kind, shared_db).await,
                )
            }
            _ => (None, None),
        };
        out.push(DataInfo {
            choice: c,
            size,
            shared_size,
        });
    }
    Ok(out)
}

/// Drop this instance's database in a shared service and create it again
/// from the shared one.
pub async fn data_reset(state: Arc<AppState>, project_id: String, name: String, service: String) -> Result<JobHandle> {
    if let Some(id) = super::jobs::running_for(&project_id, &name).await {
        anyhow::bail!("instance '{name}' is busy (job {id})");
    }
    let job = JobHandle::create(
        &project_id,
        Some(&name),
        "data_reset",
        &[
            ("drop", "Delete this instance's database"),
            ("create", "Create it again"),
        ],
    )
    .await;
    let j = job.clone();
    tokio::spawn(async move {
        let _guard = Locks::get().lock(&format!("instance:{project_id}:{name}")).await;
        let r: Result<()> = async {
            let p = prepare(&state, &project_id, &name, None, None, false).await?;
            let own = p
                .own_databases
                .get(&service)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("{name} doesn't have its own {service} database"))?;
            j.start("drop").await;
            data::drop_tenant(&state, &p.ctx.shared_cp(), &service, own.kind, &own.tenant).await?;
            j.done("drop", Some(own.tenant.clone())).await;
            j.start("create").await;
            let mut one = BTreeMap::new();
            one.insert(service.clone(), own.clone());
            data::ensure_tenants(&state, &p.ctx.shared_cp(), &p.ctx.dev, &one, &j).await?;
            j.done("create", Some(format!("copied from {}", own.shared_db))).await;
            Ok(())
        }
        .await;
        match r {
            Ok(()) => j.succeed(None).await,
            Err(e) => j.fail(&e).await,
        }
    });
    Ok(job)
}

/// Refuse to start one more instance than the project allows, naming the
/// running ones so the user knows what to stop.
async fn check_running_cap(state: &AppState, project_id: &str, name: &str) -> Result<()> {
    let ctx = ProjectCtx::load(state, project_id).await?;
    let cap = ctx
        .dev
        .instance
        .max_running
        .unwrap_or(orca_core::dev::schema::DEFAULT_MAX_RUNNING) as usize;
    let containers = state.rt().await.list_containers(false).await?;
    let mut running: Vec<String> = containers
        .iter()
        .filter(|c| c.labels.get(core_dev::LABEL_PROJECT).map(String::as_str) == Some(project_id))
        .filter(|c| c.labels.get(core_dev::LABEL_ROLE).map(String::as_str) == Some("instance"))
        .filter_map(|c| c.labels.get(core_dev::LABEL_INSTANCE).cloned())
        .collect();
    running.sort();
    running.dedup();
    if running.iter().any(|r| r == name) || running.len() < cap {
        return Ok(());
    }
    anyhow::bail!(
        "{project_id} already runs {} instances ({}), the most allowed. Stop one first, or raise dev.instance.max_running in orca.yaml.",
        running.len(),
        running.join(", ")
    )
}

#[derive(Debug, Clone, Serialize)]
pub struct HostRoute {
    pub service: String,
    pub port: u16,
    pub hostname: String,
    pub url: String,
}

/// Route a service that runs as a process on the host (a dev server started
/// with `orca run --serve`) through the gateway, on a port kept stable for
/// this worktree.
pub async fn add_host_route(state: &AppState, project_id: &str, name: &str, service: &str) -> Result<HostRoute> {
    let ctx = ProjectCtx::load(state, project_id).await?;
    let path = ctx.path_of(name)?;
    if core_dev::naming::slugify(service).as_deref() != Some(service) {
        anyhow::bail!("'{service}' is not a valid service name");
    }
    let _lock = Locks::get().lock("ports").await;
    let (port, gw) = {
        let mut cfg = state.config.lock().await;
        let taken: Vec<u16> = cfg
            .dev_projects
            .iter()
            .flat_map(|p| p.instances.iter())
            .flat_map(|i| {
                i.ports
                    .iter()
                    .map(|a| a.host_port)
                    .chain(i.host_services.values().copied())
            })
            .collect();
        let proj = cfg
            .dev_projects
            .iter_mut()
            .find(|p| p.id == project_id)
            .ok_or_else(|| anyhow::anyhow!("project '{project_id}' is not registered"))?;
        if proj.instance_by_path(&path).is_none() {
            proj.instances.push(DevInstanceState {
                path: path.clone(),
                name: name.to_string(),
                ..Default::default()
            });
        }
        let inst = proj.instance_by_path_mut(&path).expect("just inserted");
        let port = match inst.host_services.get(service) {
            Some(p) if ops::port_is_free(*p) => *p,
            _ => {
                let p = core_dev::PORT_RANGE
                    .clone()
                    .find(|p| !taken.contains(p) && ops::port_is_free(*p))
                    .ok_or_else(|| anyhow::anyhow!("no free host port left"))?;
                inst.host_services.insert(service.to_string(), p);
                p
            }
        };
        cfg.save()?;
        (port, cfg.gateway.clone())
    };

    let st = ctx.project.instance_by_path(&path).cloned().unwrap_or_default();
    let hostname = match st.hostname_overrides.get(service) {
        Some(h) => h.clone(),
        None => {
            orca_core::dev::hostnames::render(&ctx.dev.naming.hostname, project_id, name, service, &gw.domain, &path)?
        }
    };
    override_gen::validate_hostname(&hostname)?;
    let me = owner(project_id, name);
    let owner = format!("{me}#host");
    let gw_config = {
        let mut cfg = state.config.lock().await;
        cfg.gateway
            .routes
            .retain(|r| !(r.owner.as_deref() == Some(owner.as_str()) && r.hostname == hostname));
        // The instance's own container for this service steps aside while the
        // host server runs (`orca run --serve` starts the instance first);
        // `remove_host_route` turns its route back on.
        for r in cfg.gateway.routes.iter_mut() {
            if r.hostname == hostname && r.path.is_none() && r.owner.as_deref() == Some(me.as_str()) {
                r.enabled = false;
            }
        }
        if let Some(other) = cfg
            .gateway
            .routes
            .iter()
            .find(|r| r.hostname == hostname && r.path.is_none() && r.enabled)
        {
            anyhow::bail!(
                "{hostname} is already routed to {}; stop that first or set a hostname override for {service}",
                other.container_name
            );
        }
        cfg.gateway.routes.push(orca_core::config::GatewayRoute {
            hostname: hostname.clone(),
            container_name: "host.docker.internal".into(),
            port,
            enabled: true,
            path: None,
            owner: Some(owner),
            sleeping: false,
            presentation: Default::default(),
        });
        cfg.save()?;
        cfg.gateway.clone()
    };
    if !crate::gateway::is_running(state).await.unwrap_or(false) {
        crate::gateway::start(state, &gw_config)
            .await
            .context("could not start the gateway")?;
    } else {
        crate::gateway::ensure_host_alias(state, &gw_config)
            .await
            .context("could not restart the gateway")?;
    }
    crate::gateway::apply_config(&gw_config).await?;
    let url = if gw_config.https_port == 443 {
        format!("https://{hostname}")
    } else {
        format!("https://{hostname}:{}", gw_config.https_port)
    };
    Ok(HostRoute {
        service: service.to_string(),
        port,
        hostname,
        url,
    })
}

pub async fn remove_host_route(state: &AppState, project_id: &str, name: &str, service: &str) -> Result<()> {
    let me = owner(project_id, name);
    let owner = format!("{me}#host");
    let ctx = ProjectCtx::load(state, project_id).await?;
    let path = ctx.path_of(name)?;
    let port = ctx
        .project
        .instance_by_path(&path)
        .and_then(|s| s.host_services.get(service).copied());
    let gw = {
        let mut cfg = state.config.lock().await;
        let removed: Vec<String> = cfg
            .gateway
            .routes
            .iter()
            .filter(|r| r.owner.as_deref() == Some(owner.as_str()) && Some(r.port) == port)
            .map(|r| r.hostname.clone())
            .collect();
        cfg.gateway
            .routes
            .retain(|r| !(r.owner.as_deref() == Some(owner.as_str()) && Some(r.port) == port));
        for r in cfg.gateway.routes.iter_mut() {
            if r.owner.as_deref() == Some(me.as_str()) && removed.contains(&r.hostname) {
                r.enabled = true;
            }
        }
        cfg.save()?;
        cfg.gateway.clone()
    };
    if crate::gateway::is_running(state).await.unwrap_or(false) {
        crate::gateway::apply_config(&gw).await?;
    }
    Ok(())
}
