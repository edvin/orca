//! Data modes: deciding each shared service's mode for an instance, and
//! creating, resetting and dropping instance databases in shared servers.

use orca_backend_common::wsl::OnEngine;
use std::collections::{BTreeMap, BTreeSet};

use anyhow::{Context, Result};
use orca_core::dev::override_gen::OwnDatabase;
use orca_core::dev::schema::{DataMode, DevConfig, Seed, render_template};
use orca_core::dev::tenancy::{self, TenancyKind};
use orca_core::dev::{ComposeModel, DevInstanceState, DevProject};
use orca_core::runtime::{Container, ContainerRuntime, ContainerState, RuntimeKind};
use serde::Serialize;

use super::jobs::JobHandle;
use crate::state::AppState;

/// What the UI needs to offer data choices for one shared service.
#[derive(Debug, Clone, Serialize)]
pub struct DataChoice {
    pub service: String,
    pub mode: DataMode,
    /// The project's default from orca.yaml.
    pub default_mode: DataMode,
    pub kind: Option<TenancyKind>,
    pub shared_db: Option<String>,
    /// This instance's database, once it has one.
    pub tenant: Option<String>,
    pub supports_own_database: bool,
    /// Why own-database isn't available, when it isn't.
    pub own_database_note: Option<String>,
}

/// Each shared service's effective mode: explicit choice for this start,
/// then the instance's saved choice, then the project default.
pub fn effective_modes(
    shared: &BTreeSet<String>,
    dev: &DevConfig,
    state: Option<&DevInstanceState>,
    requested: Option<&BTreeMap<String, DataMode>>,
) -> BTreeMap<String, DataMode> {
    shared
        .iter()
        .map(|svc| {
            let mode = requested
                .and_then(|r| r.get(svc).copied())
                .or_else(|| state.and_then(|s| s.data_modes.get(svc).copied()))
                .or_else(|| dev.shared.get(svc).map(|s| s.data))
                .unwrap_or_default();
            (svc.clone(), mode)
        })
        .collect()
}

/// The database everyone shares in `svc`: orca.yaml's `database:`, else
/// what the image's environment says.
pub fn shared_database(dev: &DevConfig, model: &ComposeModel, svc: &str) -> Option<String> {
    if let Some(db) = dev.shared.get(svc).and_then(|s| s.database.clone()) {
        return Some(db);
    }
    let def = model.services.get(svc)?;
    let kind = tenancy::detect_kind(def)?;
    tenancy::detect_shared_database(kind, def)
}

/// Data choices for the Start dialog and Data tab.
pub fn choices(
    shared: &BTreeSet<String>,
    dev: &DevConfig,
    model: &ComposeModel,
    modes: &BTreeMap<String, DataMode>,
    state: Option<&DevInstanceState>,
) -> Vec<DataChoice> {
    shared
        .iter()
        .map(|svc| {
            let def = model.services.get(svc);
            let kind = def.and_then(tenancy::detect_kind);
            let shared_db = shared_database(dev, model, svc);
            let (supports, note) = match (kind, &shared_db) {
                (Some(_), Some(_)) => (true, None),
                (Some(k), None) => (
                    false,
                    Some(format!(
                        "Orca can't tell which {} database the app uses; set `database:` for {svc} in orca.yaml",
                        k.label()
                    )),
                ),
                (None, _) => (
                    false,
                    Some(format!(
                        "Orca can create separate databases in Postgres, MySQL, MongoDB, Redis and RabbitMQ (a vhost); {} isn't one of them. Use Own server instead.",
                        def.and_then(|d| d.image.clone()).unwrap_or_else(|| svc.clone())
                    )),
                ),
            };
            DataChoice {
                service: svc.clone(),
                mode: modes.get(svc).copied().unwrap_or_default(),
                default_mode: dev.shared.get(svc).map(|s| s.data).unwrap_or_default(),
                kind,
                shared_db,
                tenant: state.and_then(|s| s.tenants.get(svc).cloned()),
                supports_own_database: supports,
                own_database_note: note,
            }
        })
        .collect()
}

/// Work out the own-database details for an instance: kind, shared db and
/// the tenant name (reusing a remembered one).
pub fn own_databases(
    project: &DevProject,
    instance: &str,
    dev: &DevConfig,
    model: &ComposeModel,
    modes: &BTreeMap<String, DataMode>,
    state: Option<&DevInstanceState>,
) -> Result<BTreeMap<String, OwnDatabase>> {
    let mut out = BTreeMap::new();
    for (svc, mode) in modes {
        if *mode != DataMode::OwnDatabase {
            continue;
        }
        let def = model
            .services
            .get(svc)
            .ok_or_else(|| anyhow::anyhow!("shared service '{svc}' is not in this worktree's compose file"))?;
        let kind = tenancy::detect_kind(def).ok_or_else(|| {
            anyhow::anyhow!(
                "{svc} can't have a separate database per instance (Orca supports Postgres, MySQL, MongoDB, Redis and RabbitMQ). \
                 Choose Shared data or Own server for it."
            )
        })?;
        let shared_db = shared_database(dev, model, svc)
            .ok_or_else(|| anyhow::anyhow!("set `database:` for {svc} in orca.yaml so Orca knows what to copy"))?;
        let tenant = match state.and_then(|s| s.tenants.get(svc)) {
            Some(t) => t.clone(),
            None if kind == TenancyKind::Redis => {
                let taken: Vec<u32> = project
                    .instances
                    .iter()
                    .filter(|i| state.is_none_or(|s| s.path != i.path))
                    .filter_map(|i| i.tenants.get(svc)?.parse().ok())
                    .collect();
                tenancy::redis_index(&taken)?.to_string()
            }
            None => {
                let template = dev
                    .shared
                    .get(svc)
                    .and_then(|s| s.own_database.as_ref())
                    .and_then(|o| o.name.clone());
                match template {
                    Some(t) => {
                        let mut vars = BTreeMap::new();
                        vars.insert("database".to_string(), shared_db.clone());
                        vars.insert("instance".to_string(), instance.to_string());
                        vars.insert("project".to_string(), project.id.clone());
                        let name = render_template(&t, &vars)?;
                        tenancy::tenant_name(&name, "").trim_end_matches('_').to_string()
                    }
                    None => tenancy::tenant_for(kind, &shared_db, instance),
                }
            }
        };
        out.insert(
            svc.clone(),
            OwnDatabase {
                kind,
                shared_db,
                tenant,
            },
        );
    }
    Ok(out)
}

/// The running container of a shared service.
pub async fn shared_container(state: &AppState, shared_cp: &str, service: &str) -> Result<Option<Container>> {
    let containers = state.rt().await.list_containers(true).await?;
    Ok(containers.into_iter().find(|c| {
        c.labels.get("com.docker.compose.project").map(String::as_str) == Some(shared_cp)
            && c.labels.get("com.docker.compose.service").map(String::as_str) == Some(service)
    }))
}

/// Run `sh -c cmd` in a container and return stdout.
pub async fn exec_sh(state: &AppState, container: &str, cmd: &str) -> Result<String> {
    let program = match state.rt().await.detect_runtime().await {
        RuntimeKind::Podman => "podman",
        RuntimeKind::Docker => "docker",
    };
    let out = super::ops::runtime_cli(state, program)
        .await
        .args(["exec", container, "sh", "-c", cmd])
        .on_engine()
        .output()
        .await
        .with_context(|| format!("could not run {program} exec"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let line = err
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("command failed");
        anyhow::bail!("{}", line.trim());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

async fn running_shared(state: &AppState, shared_cp: &str, svc: &str) -> Result<Container> {
    match shared_container(state, shared_cp, svc).await? {
        Some(c) if c.state == ContainerState::Running => Ok(c),
        _ => anyhow::bail!("shared {svc} is not running; start the shared services first"),
    }
}

/// Make sure each own database exists. Returns the services whose database
/// was created now (their `after_own_database` hooks should run).
pub async fn ensure_tenants(
    state: &AppState,
    shared_cp: &str,
    dev: &DevConfig,
    own: &BTreeMap<String, OwnDatabase>,
    job: &JobHandle,
) -> Result<Vec<String>> {
    let mut created = Vec::new();
    for (svc, db) in own {
        let c = running_shared(state, shared_cp, svc).await?;
        let exists = exec_sh(state, &c.id, &tenancy::exists_cmd(db.kind, &db.tenant)?).await? == "yes";
        // Redis indexes always "exist"; treat a never-recorded one as new.
        if exists && db.kind != TenancyKind::Redis {
            job.log(format!("{svc}: database {} already exists", db.tenant)).await;
            continue;
        }
        let seed = dev
            .shared
            .get(svc)
            .and_then(|s| s.own_database.as_ref())
            .map(|o| o.seed)
            .unwrap_or_default();
        let copies = !matches!(db.kind, TenancyKind::Redis | TenancyKind::Rabbitmq);
        let clone_from = (seed == Seed::CloneMain && copies).then_some(db.shared_db.as_str());
        job.log(format!(
            "{svc}: creating database {}{}",
            db.tenant,
            clone_from.map(|s| format!(" as a copy of {s}")).unwrap_or_default()
        ))
        .await;
        exec_sh(state, &c.id, &tenancy::create_cmd(db.kind, &db.tenant, clone_from)?)
            .await
            .with_context(|| format!("could not create database {} in {svc}", db.tenant))?;
        created.push(svc.clone());
    }
    Ok(created)
}

pub async fn drop_tenant(state: &AppState, shared_cp: &str, svc: &str, kind: TenancyKind, tenant: &str) -> Result<()> {
    let c = running_shared(state, shared_cp, svc).await?;
    exec_sh(state, &c.id, &tenancy::drop_cmd(kind, tenant)?).await?;
    Ok(())
}

/// Size in bytes (or key count for Redis); `None` when it can't be read.
pub async fn tenant_size(state: &AppState, shared_cp: &str, svc: &str, kind: TenancyKind, tenant: &str) -> Option<u64> {
    let c = running_shared(state, shared_cp, svc).await.ok()?;
    exec_sh(state, &c.id, &tenancy::size_cmd(kind, tenant).ok()?)
        .await
        .ok()?
        .trim()
        .parse()
        .ok()
}
