//! Databases for projects. A project's `orca.yaml` says what it needs
//! (`requires: database: {engine: mysql, version: ">=8.0"}`), and before its
//! stack starts Orca gives it a database and a user of its own on, in order:
//!
//! 1. the workspace's server for that engine, when one matches;
//! 2. the project's own compose service (`replaces: db`), when there's none;
//! 3. a server Orca runs itself, one per engine and version.
//!
//! The connection goes into the project's `.env`. When a server stands in for
//! the project's own service, an override keeps that service from starting,
//! without touching the project's compose file.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};
use orca_core::config::{DatabaseOwner, OrcaDatabaseServer};
use orca_core::databases::{self as db, Connection, DatabaseRequirement, Engine};
use orca_core::dev::schema::OrcaYaml;
use orca_core::runtime::{ContainerCreateOpts, ContainerRuntime, ContainerState, PortMapping, VolumeMount};
use orca_core::workspace::WorkspaceFile;
use serde::Serialize;

use crate::state::AppState;

/// The override that keeps a replaced service from starting, in the
/// project's `.orca/` folder (which ignores itself in git).
pub const OVERRIDE_FILE: &str = "databases.override.yaml";
/// The label on the servers Orca runs itself.
pub const SERVER_LABEL: &str = "orca.database-server";

/// Where one of a project's databases comes from.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Source {
    /// The workspace's server `key`, a service in its shared stack.
    Workspace {
        key: String,
        engine: Engine,
        version: Option<String>,
        service: String,
    },
    /// A server Orca runs itself.
    Orca {
        id: String,
        engine: Engine,
        version: String,
    },
    /// The project's own compose service, as without Orca.
    Own { service: Option<String>, why: String },
}

impl Source {
    /// The id its users and databases are kept under.
    pub fn server_id(&self) -> Option<String> {
        match self {
            Source::Workspace { key, .. } => Some(format!("workspace:{key}")),
            Source::Orca { id, .. } => Some(format!("orca:{id}")),
            Source::Own { .. } => None,
        }
    }
}

/// A project's database, decided.
#[derive(Debug, Clone, Serialize)]
pub struct Plan {
    pub requirement: DatabaseRequirement,
    pub source: Source,
    pub database: String,
    pub user: String,
}

/// What a project's `requires:` resolves to; an `Err` explains a requirement
/// nothing can meet.
pub async fn plan(state: &AppState, project: &str, dir: &Path) -> Vec<Result<Plan, String>> {
    let yaml = OrcaYaml::load(dir).unwrap_or_default();
    if yaml.requires.is_empty() {
        return Vec::new();
    }
    let workspace = workspace_for(state, dir).await;
    let mut out = Vec::new();
    let owners = state.config.lock().await.databases.databases.clone();
    for req in yaml.requires.all() {
        let resolved = resolve(state, project, req, workspace.as_ref()).await.and_then(|p| {
            // Another project's database by the same name stays theirs.
            let other = p
                .source
                .server_id()
                .and_then(|id| owners.get(&id)?.get(&p.database))
                .filter(|o| !same_dir(Path::new(&o.dir), dir));
            match other {
                Some(o) => Err(format!(
                    "its database {} on {} is already used by the project in {}: give it a `name:` of its own in orca.yaml",
                    p.database,
                    describe(&p.source),
                    o.dir
                )),
                None => Ok(p),
            }
        });
        out.push(resolved);
    }
    out
}

/// The joined workspace's file and folder, and the key of the project in
/// `dir` when it's one of its projects.
struct WorkspaceCtx {
    file: WorkspaceFile,
    dir: PathBuf,
    project: Option<String>,
}

async fn workspace_for(state: &AppState, dir: &Path) -> Option<WorkspaceCtx> {
    let ws = state.config.lock().await.workspace.clone()?;
    let ws_dir = PathBuf::from(&ws.path);
    let file = WorkspaceFile::load(&ws_dir).ok()?;
    let here = dir.canonicalize().ok();
    let project = file
        .projects
        .keys()
        .find(|k| file.project_dir(&ws_dir, k).canonicalize().ok() == here)
        .cloned();
    Some(WorkspaceCtx {
        file,
        dir: ws_dir,
        project,
    })
}

async fn resolve(
    state: &AppState,
    project: &str,
    req: &DatabaseRequirement,
    ws: Option<&WorkspaceCtx>,
) -> Result<Plan, String> {
    let database = req.name.clone().unwrap_or_else(|| db::ident(project, 63));
    // Named after the database when the project names it, so two projects
    // in folders of the same name don't share a user.
    let user = db::user_name(req.name.as_deref().unwrap_or(project), req.engine);
    let plan = |source: Source| Plan {
        requirement: req.clone(),
        source,
        database: database.clone(),
        user: user.clone(),
    };
    let wants = |r: &DatabaseRequirement| {
        format!(
            "{}{}",
            r.engine.name(),
            r.version.as_deref().map(|v| format!(" {v}")).unwrap_or_default()
        )
    };

    // The workspace's choice for this project, when it made one.
    let choice = ws.and_then(|w| {
        w.project
            .as_ref()
            .and_then(|k| w.file.projects.get(k)?.database.clone())
    });
    if choice.as_deref() == Some("own") {
        return Ok(plan(Source::Own {
            service: req.replaces.clone(),
            why: "the workspace file says `database: own` for it".into(),
        }));
    }
    // A database Orca already made for it stays where it is, so a server
    // added later never leaves its data behind; only the workspace file's
    // explicit choice moves it.
    if choice.is_none()
        && let Some(source) = existing(state, project, &database, req, ws).await
    {
        return Ok(plan(source));
    }
    if let Some(ws) = ws {
        let servers: Vec<(&String, &db::DatabaseServer)> = match &choice {
            Some(key) => ws.file.databases.get_key_value(key).into_iter().collect(),
            None => ws.file.databases.iter().collect(),
        };
        for (key, server) in servers {
            let version = match &server.version {
                Some(v) => Some(v.clone()),
                None => running_version(state, ws, &server.service).await,
            };
            if req.accepts(server.engine, version.as_deref()) {
                return Ok(plan(Source::Workspace {
                    key: key.clone(),
                    engine: server.engine,
                    version,
                    service: server.service.clone(),
                }));
            }
            if choice.is_some() {
                return Err(format!(
                    "needs {}; the workspace's {key} is {} {}",
                    wants(req),
                    server.engine.name(),
                    version.unwrap_or_default()
                ));
            }
        }
    }
    if let Some(service) = &req.replaces {
        return Ok(plan(Source::Own {
            service: Some(service.clone()),
            why: format!("no shared {} server here, so its own {service} runs", req.engine.name()),
        }));
    }
    match req.orca_version() {
        Some(version) => Ok(plan(Source::Orca {
            id: format!("{}-{}", req.engine.id(), version.replace('.', "-")),
            engine: req.engine,
            version: version.to_string(),
        })),
        None => Err(format!("needs {}; no server for it is available", wants(req))),
    }
}

/// The server this project's database is already on, when it still exists
/// and still suits the requirement.
async fn existing(
    state: &AppState,
    project: &str,
    database: &str,
    req: &DatabaseRequirement,
    ws: Option<&WorkspaceCtx>,
) -> Option<Source> {
    let dbs = state.config.lock().await.databases.clone();
    for (server, owners) in &dbs.databases {
        if !owners.get(database).is_some_and(|o| o.project == project) {
            continue;
        }
        if let Some(id) = server.strip_prefix("orca:") {
            let s = dbs.servers.get(id)?;
            if req.accepts(s.engine, Some(&s.version)) {
                return Some(Source::Orca {
                    id: id.to_string(),
                    engine: s.engine,
                    version: s.version.clone(),
                });
            }
        } else if let Some(key) = server.strip_prefix("workspace:") {
            let ws = ws?;
            let s = ws.file.databases.get(key)?;
            let version = match &s.version {
                Some(v) => Some(v.clone()),
                None => running_version(state, ws, &s.service).await,
            };
            if req.accepts(s.engine, version.as_deref()) {
                return Some(Source::Workspace {
                    key: key.to_string(),
                    engine: s.engine,
                    version,
                    service: s.service.clone(),
                });
            }
        }
    }
    None
}

/// The version of a workspace server's running image, when it runs.
async fn running_version(state: &AppState, ws: &WorkspaceCtx, service: &str) -> Option<String> {
    let c = workspace_container(state, ws, service).await?;
    db::image_version(&c.image)
}

async fn workspace_container(
    state: &AppState,
    ws: &WorkspaceCtx,
    service: &str,
) -> Option<orca_core::runtime::Container> {
    let project = crate::workspace::shared_name(&ws.file, &ws.dir);
    crate::dev::data::shared_container(state, &project, service)
        .await
        .ok()
        .flatten()
}

/// Make the project's databases ready before its stack starts: servers
/// running, databases and users created, `.env` written. Returns the compose
/// files to start it with when a server stands in for one of its services.
pub async fn prepare(
    state: &AppState,
    project: &str,
    dir: &Path,
    compose_files: Option<&str>,
    log: &(dyn Fn(String) + Send + Sync),
) -> Result<Option<String>> {
    let plans = plan(state, project, dir).await;
    let env_name = env_file(state, dir).await;
    if plans.is_empty() {
        // Only when orca.yaml really has no `requires:` any more: one with a
        // mistake in it isn't a reason to move the project's data.
        if !mentions_requires(dir) {
            restore_env(dir, &env_name, None)?;
        }
        unset_compose_file(dir)?;
        return Ok(None);
    }
    let plans: Vec<Plan> = plans
        .into_iter()
        .collect::<std::result::Result<_, _>>()
        .map_err(|e| anyhow::anyhow!("{project}'s database: {e}"))?;
    if plans.iter().filter(|p| p.requirement.env.is_empty()).count() > 1 {
        anyhow::bail!("{project}'s databases would all set DATABASE_URL: give each one its own `env:` in orca.yaml");
    }
    let mut replaced = Vec::new();
    let mut uses_server = false;
    for p in plans {
        let Some(server_id) = p.source.server_id() else {
            if let Source::Own { why, .. } = &p.source {
                log(format!("Database: {why}."));
                // Back to the project's own database: its settings too.
                restore_env(dir, &env_name, Some(&p.requirement.env_keys()))?;
            }
            continue;
        };
        let (container, engine, host) = ensure_server(state, &p.source, log).await?;
        // A shared server whose version wasn't known until it started.
        if let Source::Workspace {
            version: None, service, ..
        } = &p.source
            && let Some(ws) = workspace_for(state, dir).await
            && let Some(v) = running_version(state, &ws, service).await
            && !p.requirement.accepts(engine, Some(&v))
        {
            anyhow::bail!(
                "{project} needs {} {}, and {} runs {v}",
                engine.name(),
                p.requirement.version.as_deref().unwrap_or(""),
                describe(&p.source)
            );
        }
        join_db_network(state, &container).await?;
        uses_server = true;
        let password = user_password(state, &server_id, &p.user).await?;
        log(format!(
            "Database: {} for {} on {}",
            p.database,
            p.user,
            describe(&p.source)
        ));
        crate::dev::data::exec_sh(
            state,
            &container,
            &db::provision_cmd(engine, &p.database, &p.user, &password, &p.requirement.privileges)?,
        )
        .await
        .with_context(|| format!("couldn't create {} on {}", p.database, describe(&p.source)))?;
        remember(state, &server_id, &p, project, dir).await?;
        let conn = Connection {
            engine,
            host,
            port: engine.port(),
            database: p.database.clone(),
            user: p.user.clone(),
            password,
        };
        let env = p.requirement.env_values(&conn);
        let changed = write_env(dir, &env_name, &env)?;
        if !changed.is_empty() && tracked_by_git(dir, &env_name) {
            log(format!(
                "Database: {env_name} is tracked by git, and now holds a generated password: keep it out of commits"
            ));
        }
        if !changed.is_empty() {
            log(format!(
                "Database: {} set in {env_name}; what they held before is put back if {project} stops using the database server",
                changed.join(", ")
            ));
        }
        if let Some(svc) = &p.requirement.replaces {
            replaced.push(Replaced {
                service: svc.clone(),
                from: describe(&p.source),
                env,
            });
        }
    }
    if !uses_server {
        unset_compose_file(dir)?;
        return Ok(None);
    }
    let files = match compose_files {
        Some(f) => f
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>(),
        None => crate::dev::ops::compose_files(dir, None)?
            .into_iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect(),
    };
    let override_path = write_override(state, dir, &files, &replaced).await?;
    // A replaced service still running from before stops; its data stays
    // in its volume, for an import.
    let rt = state.rt().await;
    for c in rt.list_containers(false).await.unwrap_or_default() {
        let label = |k: &str| c.labels.get(k).map(String::as_str);
        if label("com.docker.compose.project") == Some(project)
            && replaced
                .iter()
                .any(|r| Some(r.service.as_str()) == label("com.docker.compose.service"))
        {
            log(format!(
                "Database: stopping {}, which the shared server stands in for; its data stays in its volume",
                c.name
            ));
            let _ = rt.stop_container(&c.id, 20).await;
        }
    }
    if env_name == ".env" {
        set_compose_file(dir, &files)?;
    }
    let path = override_path.to_string_lossy().to_string();
    Ok(Some(
        files
            .into_iter()
            .filter(|f| !f.ends_with(OVERRIDE_FILE))
            .chain([path])
            .collect::<Vec<_>>()
            .join(","),
    ))
}

pub fn describe(source: &Source) -> String {
    match source {
        Source::Workspace { key, engine, .. } => format!("the workspace's {key} ({})", engine.name()),
        Source::Orca { engine, version, .. } => format!("Orca's {} {version}", engine.name()),
        Source::Own { service, .. } => match service {
            Some(s) => format!("the project's own {s}"),
            None => "the project itself".into(),
        },
    }
}

pub fn container_name(id: &str) -> String {
    format!("orca-{id}")
}

/// The server running and answering: its container, engine, and the name
/// the project's services reach it by.
async fn ensure_server(
    state: &AppState,
    source: &Source,
    log: &(dyn Fn(String) + Send + Sync),
) -> Result<(String, Engine, String)> {
    match source {
        Source::Workspace {
            service, engine, key, ..
        } => {
            let ws = {
                let cfg = state.config.lock().await;
                cfg.workspace.clone().context("no workspace joined")?
            };
            let ws_dir = PathBuf::from(&ws.path);
            let file = WorkspaceFile::load(&ws_dir)?;
            let ctx = WorkspaceCtx {
                file,
                dir: ws_dir.clone(),
                project: None,
            };
            let running = workspace_container(state, &ctx, service)
                .await
                .is_some_and(|c| c.state == ContainerState::Running);
            if !running {
                log(format!("Starting the workspace's {key}"));
                crate::workspace::start_shared_services(state, &ctx.file, &ws_dir, std::slice::from_ref(service))
                    .await?;
            }
            let c = workspace_container(state, &ctx, service)
                .await
                .with_context(|| format!("the workspace's {key} didn't start"))?;
            wait_ready(state, &c.id, *engine).await?;
            Ok((c.id, *engine, c.name))
        }
        Source::Orca { id, engine, version } => {
            let name = container_name(id);
            ensure_orca_server(state, id, *engine, version, log).await?;
            wait_ready(state, &name, *engine).await?;
            Ok((name.clone(), *engine, name))
        }
        Source::Own { .. } => anyhow::bail!("the project runs its own database"),
    }
}

/// Create or start one of Orca's own servers.
async fn ensure_orca_server(
    state: &AppState,
    id: &str,
    engine: Engine,
    version: &str,
    log: &(dyn Fn(String) + Send + Sync),
) -> Result<()> {
    let name = container_name(id);
    let rt = state.rt().await;
    let existing = rt.list_containers(true).await?.into_iter().find(|c| c.name == name);
    if let Some(c) = existing {
        if c.state != ContainerState::Running {
            log(format!("Starting Orca's {} {version}", engine.name()));
            rt.start_container(&c.id).await?;
        }
        return Ok(());
    }
    let server = {
        let mut cfg = state.config.lock().await;
        let taken: Vec<u16> = cfg.databases.servers.values().map(|s| s.port).collect();
        let server = cfg
            .databases
            .servers
            .entry(id.to_string())
            .or_insert_with(|| OrcaDatabaseServer {
                engine,
                version: version.to_string(),
                root_password: secret(),
                port: free_port(engine.port() + 10_000, &taken),
            })
            .clone();
        cfg.save()?;
        server
    };
    let image = engine.image(version);
    log(format!("Getting {image}"));
    crate::gateway::pull_if_needed(state, &image).await?;
    log(format!(
        "Starting Orca's {} {version} on port {}",
        engine.name(),
        server.port
    ));
    let data_dir = match engine {
        Engine::Postgres => "/var/lib/postgresql/data",
        _ => "/var/lib/mysql",
    };
    let opts = ContainerCreateOpts {
        image,
        name: Some(name.clone()),
        command: vec![],
        entrypoint: None,
        env: db::server_env(engine, &server.root_password).into_iter().collect(),
        ports: vec![PortMapping {
            host_ip: Some("127.0.0.1".into()),
            host_port: server.port,
            container_port: engine.port(),
            protocol: "tcp".into(),
        }],
        volumes: vec![VolumeMount {
            source: format!("orca-{id}-data"),
            target: data_dir.into(),
            read_only: false,
        }],
        labels: [
            ("orca.managed".to_string(), "true".to_string()),
            (SERVER_LABEL.to_string(), id.to_string()),
        ]
        .into_iter()
        .collect(),
        network: None,
        detach: true,
        remove_on_exit: false,
        cpu_limit: None,
        memory_limit: None,
        memory_swap: None,
        gpu: false,
        user: None,
        extra_hosts: vec![],
        // Back after a restart of the machine, like the projects using it.
        restart_policy: Some("unless-stopped".into()),
    };
    let cid = match rt.create_container(opts).await {
        Ok(cid) => cid,
        // Another project starting at the same time made it first.
        Err(e) => match rt.list_containers(true).await?.into_iter().find(|c| c.name == name) {
            Some(c) => c.id,
            None => return Err(e).context("couldn't create the database server"),
        },
    };
    rt.start_container(&cid).await?;
    Ok(())
}

/// A database server takes a few seconds to accept connections after it
/// starts, longer the first time.
async fn wait_ready(state: &AppState, container: &str, engine: Engine) -> Result<()> {
    let probe = match engine {
        Engine::Postgres => r#"pg_isready -q -U "${POSTGRES_USER:-postgres}""#.to_string(),
        _ => r#"$(command -v mysqladmin || command -v mariadb-admin) ping -uroot -p"${MYSQL_ROOT_PASSWORD:-$MARIADB_ROOT_PASSWORD}" --silent"#.to_string(),
    };
    let mut last = String::new();
    for _ in 0..90 {
        match crate::dev::data::exec_sh(state, container, &probe).await {
            Ok(_) => {
                // MySQL answers ping during its first start's temporary server.
                if crate::dev::data::exec_sh(state, container, &db::list_cmd(engine))
                    .await
                    .is_ok()
                {
                    return Ok(());
                }
            }
            Err(e) => last = e.to_string(),
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    anyhow::bail!("the database server didn't become ready in 90 seconds: {last}")
}

/// A project's own server answering, without logging in as its admin
/// (whose password it may not know).
async fn wait_alive(state: &AppState, container: &str, engine: Engine) -> Result<()> {
    let probe = match engine {
        Engine::Postgres => r#"pg_isready -q -U "${POSTGRES_USER:-postgres}""#,
        // ping exits 0 once the server answers, even when the login fails.
        _ => {
            r#"$(command -v mysqladmin || command -v mariadb-admin) ping -uping --silent >/dev/null 2>&1 || $(command -v mysqladmin || command -v mariadb-admin) ping --silent"#
        }
    };
    for _ in 0..90 {
        if crate::dev::data::exec_sh(state, container, probe).await.is_ok() {
            // The first start runs a temporary server before the real one.
            tokio::time::sleep(Duration::from_secs(2)).await;
            if crate::dev::data::exec_sh(state, container, probe).await.is_ok() {
                return Ok(());
            }
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    anyhow::bail!("{container} didn't start answering in 90 seconds")
}

fn free_port(from: u16, taken: &[u16]) -> u16 {
    (from..from.saturating_add(200))
        .find(|p| !taken.contains(p) && std::net::TcpListener::bind(("127.0.0.1", *p)).is_ok())
        .unwrap_or(from)
}

fn secret() -> String {
    use rand::RngCore;
    let mut b = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// The user's password on a server, made the first time.
async fn user_password(state: &AppState, server: &str, user: &str) -> Result<String> {
    let mut cfg = state.config.lock().await;
    let pw = cfg
        .databases
        .users
        .entry(server.to_string())
        .or_default()
        .entry(user.to_string())
        .or_insert_with(secret)
        .clone();
    cfg.save()?;
    Ok(pw)
}

async fn remember(state: &AppState, server: &str, p: &Plan, project: &str, dir: &Path) -> Result<()> {
    let mut cfg = state.config.lock().await;
    cfg.databases.databases.entry(server.to_string()).or_default().insert(
        p.database.clone(),
        DatabaseOwner {
            project: project.to_string(),
            dir: dir.to_string_lossy().to_string(),
            user: p.user.clone(),
            seed: p.requirement.seed.clone(),
        },
    );
    cfg.save()?;
    Ok(())
}

/// The env file a project's settings go in: the workspace's `env.file` for
/// it, else `.env`.
async fn env_file(state: &AppState, dir: &Path) -> String {
    workspace_for(state, dir)
        .await
        .and_then(|w| {
            let key = w.project.as_ref()?;
            Some(w.file.projects.get(key)?.env.as_ref()?.file().to_string())
        })
        .unwrap_or_else(|| ".env".into())
}

/// The values Orca replaced in a project's env file, to put back when it
/// goes back to its own database: key → its earlier value (none when it
/// wasn't set).
const ENV_BEFORE_FILE: &str = "databases.env-before.json";

fn env_before(dir: &Path) -> BTreeMap<String, Option<String>> {
    std::fs::read_to_string(dir.join(".orca").join(ENV_BEFORE_FILE))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_env_before(dir: &Path, before: &BTreeMap<String, Option<String>>) -> Result<()> {
    let orca_dir = dir.join(".orca");
    let path = orca_dir.join(ENV_BEFORE_FILE);
    if before.is_empty() {
        let _ = std::fs::remove_file(path);
        return Ok(());
    }
    std::fs::create_dir_all(&orca_dir)?;
    let ignore = orca_dir.join(".gitignore");
    if !ignore.exists() {
        std::fs::write(&ignore, "*\n")?;
    }
    write_private(&path, &serde_json::to_string_pretty(before)?)
}

/// Write a file that may hold passwords: readable by its owner only when
/// it's new, keeping the mode of one that exists (an app container may
/// read a mounted `.env` as another user), and through a symlink.
fn write_private(path: &Path, text: &str) -> Result<()> {
    let path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let mode = std::fs::metadata(&path).ok().map(|m| m.permissions());
    let tmp = path.with_extension("orca-tmp");
    std::fs::write(&tmp, text)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = mode.unwrap_or_else(|| std::fs::Permissions::from_mode(0o600));
        let _ = std::fs::set_permissions(&tmp, perms);
    }
    #[cfg(not(unix))]
    let _ = mode;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

/// Set `values` in the env file, keeping what each key held before the
/// first time Orca sets it. Returns the keys whose value changed.
fn write_env(dir: &Path, file: &str, values: &BTreeMap<String, String>) -> Result<Vec<String>> {
    let path = dir.join(file);
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let mut before = env_before(dir);
    let mut changed = Vec::new();
    for (k, v) in values {
        // Set but empty counts as set: it's put back empty.
        let had = orca_core::workspace::env_value(&text, k).or_else(|| {
            text.lines()
                .map(|l| l.trim_start().trim_start_matches("export ").trim_start())
                .any(|l| l.split_once('=').is_some_and(|(key, _)| key.trim() == k))
                .then(String::new)
        });
        if had.as_ref() != Some(v) {
            changed.push(k.clone());
            before.entry(k.clone()).or_insert(had);
        }
    }
    if changed.is_empty() {
        return Ok(changed);
    }
    save_env_before(dir, &before)?;
    write_private(&path, &orca_core::workspace::set_env_values(&text, values))?;
    Ok(changed)
}

/// Put back the values Orca replaced (only `keys`, when given).
fn restore_env(dir: &Path, file: &str, keys: Option<&[String]>) -> Result<()> {
    let mut before = env_before(dir);
    let back: BTreeMap<String, Option<String>> = before
        .iter()
        .filter(|(k, _)| keys.is_none_or(|ks| ks.contains(k)))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    if back.is_empty() {
        return Ok(());
    }
    let path = dir.join(file);
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let set: BTreeMap<String, String> = back.iter().filter_map(|(k, v)| Some((k.clone(), v.clone()?))).collect();
    let mut updated = orca_core::workspace::set_env_values(&text, &set);
    let unset: Vec<&String> = back.iter().filter(|(_, v)| v.is_none()).map(|(k, _)| k).collect();
    if !unset.is_empty() {
        let mut out: Vec<&str> = updated
            .lines()
            .filter(|l| {
                let l = l.trim_start();
                let l = l.strip_prefix("export ").unwrap_or(l);
                !l.split_once('=')
                    .is_some_and(|(k, _)| unset.iter().any(|u| u.as_str() == k.trim()))
            })
            .collect();
        out.push("");
        updated = out.join(if updated.contains("\r\n") { "\r\n" } else { "\n" });
    }
    write_private(&path, &updated)?;
    for k in back.keys() {
        before.remove(k);
    }
    save_env_before(dir, &before)
}

/// Whether the project's orca.yaml has a `requires:` key, valid or not.
fn mentions_requires(dir: &Path) -> bool {
    ["orca.yaml", "orca.yml", "orca.local.yaml"].iter().any(|f| {
        std::fs::read_to_string(dir.join(f))
            .ok()
            .and_then(|t| serde_yaml::from_str::<serde_yaml::Value>(&t).ok())
            .is_some_and(|v| v.get("requires").is_some())
    })
}

fn tracked_by_git(dir: &Path, file: &str) -> bool {
    std::process::Command::new("git")
        .args(["ls-files", "--error-unmatch", "--", file])
        .current_dir(dir)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

fn same_dir(a: &Path, b: &Path) -> bool {
    let canon = |p: &Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    canon(a) == canon(b)
}

/// The network every database server is on, and every service of a
/// project using one: `docker compose up` in a terminal reaches it too.
pub const DB_NETWORK: &str = "orca-databases";

async fn join_db_network(state: &AppState, container: &str) -> Result<()> {
    use orca_core::network::NetworkManager;
    let rt = state.rt().await;
    let net = match NetworkManager::inspect(rt.as_ref(), DB_NETWORK).await {
        Ok(n) => n,
        Err(_) => NetworkManager::create(rt.as_ref(), DB_NETWORK, "bridge")
            .await
            .context("couldn't create the databases' network")?,
    };
    let _ = net;
    let joined = rt
        .docker
        .inspect_container(container, None)
        .await
        .ok()
        .and_then(|i| i.network_settings.and_then(|n| n.networks))
        .is_some_and(|n| n.contains_key(DB_NETWORK));
    if !joined {
        NetworkManager::connect(rt.as_ref(), DB_NETWORK, container).await?;
    }
    Ok(())
}

/// Where `COMPOSE_FILE` in `.env` points at the override, so a
/// `docker compose up` in a terminal (or a justfile's) leaves the replaced
/// services out too.
const OVERRIDE_ENTRY: &str = ".orca/databases.override.yaml";
/// The comment above a `COMPOSE_FILE` Orca added, so it can take it out again.
pub(crate) const COMPOSE_FILE_NOTE: &str =
    "# Added by Orca: the database server's settings (.orca/databases.override.yaml).";

fn compose_sep() -> char {
    if cfg!(windows) { ';' } else { ':' }
}

/// Points `.env`'s `COMPOSE_FILE` at the project's compose files and the
/// override, keeping a `COMPOSE_FILE` the project set itself.
fn set_compose_file(dir: &Path, files: &[String]) -> Result<()> {
    let path = dir.join(".env");
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let sep = compose_sep();
    let rel = |f: &str| {
        Path::new(f)
            .strip_prefix(dir)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| f.to_string())
    };
    let mut list: Vec<String> = files
        .iter()
        .map(|f| rel(f))
        .filter(|f| !f.ends_with(OVERRIDE_FILE))
        .collect();
    list.push(OVERRIDE_ENTRY.to_string());
    let value = list.join(&sep.to_string());
    let has_key = text.lines().any(|l| {
        let l = l.trim_start();
        l.strip_prefix("export ")
            .unwrap_or(l)
            .trim_start()
            .starts_with("COMPOSE_FILE=")
    });
    let updated = if has_key {
        orca_core::workspace::set_env_values(&text, &BTreeMap::from([("COMPOSE_FILE".to_string(), value)]))
    } else {
        let nl = if text.contains("\r\n") { "\r\n" } else { "\n" };
        let mut t = text.clone();
        if !t.is_empty() && !t.ends_with('\n') {
            t.push_str(nl);
        }
        t.push_str(&format!("{nl}{COMPOSE_FILE_NOTE}{nl}COMPOSE_FILE={value}{nl}"));
        t
    };
    if updated != text {
        std::fs::write(&path, updated)?;
    }
    Ok(())
}

/// Takes the override back out of `.env`'s `COMPOSE_FILE`, and the whole
/// setting when Orca added it.
fn unset_compose_file(dir: &Path) -> Result<()> {
    let path = dir.join(".env");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Ok(());
    };
    if !text.contains(OVERRIDE_ENTRY) {
        return Ok(());
    }
    let sep = compose_sep();
    let lines: Vec<&str> = text.lines().collect();
    let mut out: Vec<String> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let unexported = line.trim_start();
        let unexported = unexported.strip_prefix("export ").unwrap_or(unexported).trim_start();
        let Some(v) = unexported.strip_prefix("COMPOSE_FILE=") else {
            out.push(line.to_string());
            continue;
        };
        if i > 0 && lines[i - 1].trim() == COMPOSE_FILE_NOTE {
            out.pop();
            if out.last().is_some_and(|l| l.trim().is_empty()) {
                out.pop();
            }
            continue;
        }
        let kept: Vec<&str> = v
            .trim()
            .trim_matches(['"', '\''])
            .split(sep)
            .filter(|f| !f.is_empty() && *f != OVERRIDE_ENTRY)
            .collect();
        out.push(format!("COMPOSE_FILE={}", kept.join(&sep.to_string())));
    }
    let nl = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut updated = out.join(nl);
    updated.push_str(nl);
    std::fs::write(&path, updated)?;
    Ok(())
}

/// A project service a server stands in for, and the connection that
/// replaces it.
struct Replaced {
    service: String,
    from: String,
    env: BTreeMap<String, String>,
}

/// The override that leaves the replaced services out: a profile nobody
/// turns on, their place in other services' `depends_on` dropped, and the
/// connection set on those services (in case their compose file sets it
/// directly rather than from `.env`).
async fn write_override(state: &AppState, dir: &Path, files: &[String], replaced: &[Replaced]) -> Result<PathBuf> {
    let names: Vec<&str> = replaced.iter().map(|r| r.service.as_str()).collect();
    let mut yaml = String::from(
        "# Written by Orca before each start: these services' databases come from\n\
         # a database server, so they don't start. To run them again, remove\n\
         # `requires:` from orca.yaml (or set `database: own` in the workspace).\n\
         services:\n",
    );
    for r in replaced {
        yaml.push_str(&format!(
            "  # Its database is on {}.\n  {}:\n    profiles: [orca-replaced]\n",
            r.from,
            serde_json::to_string(&r.service)?
        ));
    }
    for (svc, info) in services_of(state, dir, files).await {
        if names.contains(&svc.as_str()) {
            continue;
        }
        let mut block = String::new();
        let lost: Vec<&String> = info.depends_on.keys().filter(|d| names.contains(&d.as_str())).collect();
        if !lost.is_empty() {
            let kept: Vec<(&String, &serde_json::Value)> = info
                .depends_on
                .iter()
                .filter(|(d, _)| !names.contains(&d.as_str()))
                .collect();
            if kept.is_empty() {
                block.push_str("    depends_on: !reset []\n");
            } else {
                // The ones that stay, with their conditions (service_healthy…).
                block.push_str("    depends_on: !override\n");
                for (d, cond) in kept {
                    block.push_str(&format!(
                        "      {}: {}\n",
                        serde_json::to_string(d)?,
                        serde_json::to_string(cond)?
                    ));
                }
            }
            let env: BTreeMap<&String, &String> = replaced
                .iter()
                .filter(|r| info.depends_on.contains_key(&r.service))
                .flat_map(|r| r.env.iter())
                .collect();
            if !env.is_empty() {
                block.push_str("    environment:\n");
                for (k, v) in env {
                    // JSON strings are valid YAML, and quote anything a value holds.
                    block.push_str(&format!("      {k}: {}\n", serde_json::to_string(v)?));
                }
            }
        }
        // On the servers' network too, so the database's name resolves
        // however the project is started.
        if let Some(networks) = &info.networks {
            block.push_str("    networks:\n");
            for n in networks.iter().filter(|n| n.as_str() != DB_NETWORK) {
                block.push_str(&format!("      {}: {{}}\n", serde_json::to_string(n)?));
            }
            block.push_str(&format!("      {DB_NETWORK}: {{}}\n"));
        }
        if !block.is_empty() {
            yaml.push_str(&format!("  {}:\n{block}", serde_json::to_string(&svc)?));
        }
    }
    yaml.push_str(&format!(
        "networks:\n  {DB_NETWORK}:\n    name: {DB_NETWORK}\n    external: true\n"
    ));
    let orca_dir = dir.join(".orca");
    std::fs::create_dir_all(&orca_dir)?;
    let ignore = orca_dir.join(".gitignore");
    if !ignore.exists() {
        std::fs::write(&ignore, "*\n")?;
    }
    let path = orca_dir.join(OVERRIDE_FILE);
    std::fs::write(&path, yaml)?;
    Ok(path)
}

/// A service as compose resolves it: what it depends on (with each
/// dependency's condition), and its networks (none when it shares another's
/// network stack, `network_mode`).
struct ServiceInfo {
    depends_on: BTreeMap<String, serde_json::Value>,
    networks: Option<Vec<String>>,
}

/// Every service of the project's compose files, in every profile (one
/// switched on later depends on the database too).
async fn services_of(state: &AppState, dir: &Path, files: &[String]) -> BTreeMap<String, ServiceInfo> {
    let mut args = vec!["compose".to_string()];
    for f in files.iter().filter(|f| !f.ends_with(OVERRIDE_FILE)) {
        args.extend(["-f".into(), f.clone()]);
    }
    args.extend(["--profile".into(), "*".into()]);
    args.extend(["config".into(), "--format".into(), "json".into()]);
    let program = match state.rt().await.detect_runtime().await {
        orca_core::runtime::RuntimeKind::Podman => "podman",
        orca_core::runtime::RuntimeKind::Docker => "docker",
    };
    let out = crate::dev::ops::runtime_cli(state, program)
        .await
        .current_dir(dir)
        .args(&args)
        .output()
        .await;
    let v = match out {
        Ok(o) if o.status.success() => serde_json::from_slice::<serde_json::Value>(&o.stdout).ok(),
        Ok(o) => {
            tracing::warn!(
                "databases: couldn't read {}'s compose files: {}",
                dir.display(),
                String::from_utf8_lossy(&o.stderr).lines().last().unwrap_or("")
            );
            None
        }
        Err(e) => {
            tracing::warn!("databases: couldn't run compose config in {}: {e}", dir.display());
            None
        }
    };
    let Some(v) = v else {
        return BTreeMap::new();
    };
    v["services"]
        .as_object()
        .map(|services| {
            services
                .iter()
                .map(|(name, s)| {
                    let depends_on = match &s["depends_on"] {
                        serde_json::Value::Object(m) => m.clone().into_iter().collect(),
                        serde_json::Value::Array(a) => a
                            .iter()
                            .filter_map(|d| d.as_str())
                            .map(|d| (d.to_string(), serde_json::json!({"condition": "service_started"})))
                            .collect(),
                        _ => BTreeMap::new(),
                    };
                    let networks = if s.get("network_mode").is_some_and(|m| !m.is_null()) {
                        None
                    } else {
                        Some(match &s["networks"] {
                            serde_json::Value::Object(m) => m.keys().cloned().collect(),
                            serde_json::Value::Array(a) => {
                                a.iter().filter_map(|n| n.as_str().map(String::from)).collect()
                            }
                            _ => vec!["default".to_string()],
                        })
                    };
                    (name.clone(), ServiceInfo { depends_on, networks })
                })
                .collect()
        })
        .unwrap_or_default()
}

// ---- The Databases page ----

/// Every server Orca knows of, and the databases on it.
#[derive(Debug, Serialize)]
pub struct ServerInfo {
    pub id: String,
    pub source: &'static str,
    pub label: String,
    pub engine: Engine,
    pub version: Option<String>,
    pub running: bool,
    pub container: Option<String>,
    /// Its port on this computer, for database tools.
    pub port: Option<u16>,
    pub databases: Vec<DatabaseInfo>,
}

#[derive(Debug, Serialize)]
pub struct DatabaseInfo {
    pub name: String,
    pub size: Option<u64>,
    pub project: Option<String>,
    pub dir: Option<String>,
    pub user: Option<String>,
    pub seed: Option<String>,
    pub snapshots: usize,
}

pub async fn servers(state: &AppState) -> Vec<ServerInfo> {
    servers_with(state, true).await
}

/// The servers, and with `sizes` each database's size, which asks each
/// server (a second or two).
pub async fn servers_with(state: &AppState, sizes: bool) -> Vec<ServerInfo> {
    let (dbstate, ws) = {
        let cfg = state.config.lock().await;
        (cfg.databases.clone(), cfg.workspace.clone())
    };
    let containers = state.rt().await.list_containers(true).await.unwrap_or_default();
    let mut out = Vec::new();

    if let Some(ws) = ws
        && let Ok(file) = WorkspaceFile::load(Path::new(&ws.path))
    {
        let ctx = WorkspaceCtx {
            file,
            dir: PathBuf::from(&ws.path),
            project: None,
        };
        for (key, server) in &ctx.file.databases {
            let c = workspace_container(state, &ctx, &server.service).await;
            let port = c.as_ref().and_then(|c| {
                c.ports
                    .iter()
                    .find(|p| p.container_port == server.engine.port() && p.host_port != 0)
                    .map(|p| p.host_port)
            });
            out.push(ServerInfo {
                id: format!("workspace:{key}"),
                source: "workspace",
                label: format!("{} ({})", key, ws.name),
                engine: server.engine,
                version: server
                    .version
                    .clone()
                    .or_else(|| c.as_ref().and_then(|c| db::image_version(&c.image))),
                running: c.as_ref().is_some_and(|c| c.state == ContainerState::Running),
                container: c.map(|c| c.name),
                port,
                databases: Vec::new(),
            });
        }
    }
    for (id, s) in &dbstate.servers {
        let name = container_name(id);
        let c = containers.iter().find(|c| c.name == name);
        out.push(ServerInfo {
            id: format!("orca:{id}"),
            source: "orca",
            label: format!("{} {}", s.engine.name(), s.version),
            engine: s.engine,
            version: Some(s.version.clone()),
            running: c.is_some_and(|c| c.state == ContainerState::Running),
            container: c.map(|c| c.name.clone()),
            port: Some(s.port),
            databases: Vec::new(),
        });
    }

    for server in &mut out {
        let owners = dbstate.databases.get(&server.id).cloned().unwrap_or_default();
        let sizes = match (&server.container, server.running && sizes) {
            (Some(c), true) => crate::dev::data::exec_sh(state, c, &db::list_cmd(server.engine))
                .await
                .map(|text| {
                    text.lines()
                        .filter_map(|l| {
                            let (n, s) = l.split_once('\t')?;
                            Some((n.trim().to_string(), s.trim().parse::<u64>().ok()))
                        })
                        .collect::<BTreeMap<_, _>>()
                })
                .unwrap_or_default(),
            _ => BTreeMap::new(),
        };
        let mut names: Vec<String> = owners.keys().cloned().chain(sizes.keys().cloned()).collect();
        names.sort();
        names.dedup();
        server.databases = names
            .into_iter()
            .map(|name| {
                let owner = owners.get(&name);
                DatabaseInfo {
                    snapshots: snapshots(&server.id, &name).len(),
                    size: sizes.get(&name).copied().flatten(),
                    project: owner.map(|o| o.project.clone()),
                    dir: owner.map(|o| o.dir.clone()),
                    user: owner.map(|o| o.user.clone()),
                    seed: owner.and_then(|o| o.seed.clone()),
                    name,
                }
            })
            .collect();
    }
    out
}

/// A server's running container and engine, by id.
pub async fn server_container(state: &AppState, server: &str) -> Result<(String, Engine)> {
    let info = servers(state)
        .await
        .into_iter()
        .find(|s| s.id == server)
        .with_context(|| format!("no database server {server}"))?;
    match (info.container, info.running) {
        (Some(c), true) => Ok((c, info.engine)),
        _ => anyhow::bail!("{} isn't running; start it first", info.label),
    }
}

/// How to connect to a database: from the project's containers, and from
/// this computer (for database tools).
pub async fn connection(state: &AppState, server: &str, database: &str) -> Result<serde_json::Value> {
    let info = servers(state)
        .await
        .into_iter()
        .find(|s| s.id == server)
        .with_context(|| format!("no database server {server}"))?;
    let owner = info.databases.iter().find(|d| d.name == database);
    let user = owner.and_then(|d| d.user.clone());
    let password = match &user {
        Some(u) => state
            .config
            .lock()
            .await
            .databases
            .users
            .get(server)
            .and_then(|m| m.get(u))
            .cloned(),
        None => None,
    };
    let conn = |host: &str, port: u16| {
        Connection {
            engine: info.engine,
            host: host.into(),
            port,
            database: database.into(),
            user: user.clone().unwrap_or_default(),
            password: password.clone().unwrap_or_default(),
        }
        .url()
    };
    Ok(serde_json::json!({
        "engine": info.engine,
        "database": database,
        "user": user,
        "password": password,
        "inside": info.container.as_deref().map(|c| conn(c, info.engine.port())),
        "outside": info.port.map(|p| conn("127.0.0.1", p)),
        "host_port": info.port,
    }))
}

// ---- Reset and snapshots ----

/// Server ids (`workspace:mysql`, `orca:mysql-8-4`) and database names come
/// from the API and become folder names: only safe ones.
fn check_ids(server: &str, database: &str) -> Result<()> {
    let (kind, id) = server.split_once(':').unwrap_or(("", ""));
    let id_ok = !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if !matches!(kind, "workspace" | "orca") || !id_ok {
        anyhow::bail!("'{server}' isn't a database server");
    }
    if !db::safe_name(database) {
        anyhow::bail!("'{database}' isn't a database name");
    }
    Ok(())
}

/// Only databases Orca made for a project can be reset, restored or
/// imported into: not the server's own, nor another tool's.
async fn check_orca_made(state: &AppState, server: &str, database: &str) -> Result<()> {
    let known = state
        .config
        .lock()
        .await
        .databases
        .databases
        .get(server)
        .is_some_and(|m| m.contains_key(database));
    if !known {
        anyhow::bail!("{database} on {server} isn't a database Orca made for a project");
    }
    Ok(())
}

fn snapshot_dir(server: &str, database: &str) -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("orca")
        .join("database-snapshots")
        .join(server.replace(':', "-"))
        .join(database)
}

#[derive(Debug, Serialize)]
pub struct Snapshot {
    pub name: String,
    pub bytes: u64,
    /// Unix seconds.
    pub at: u64,
}

pub fn snapshots(server: &str, database: &str) -> Vec<Snapshot> {
    if check_ids(server, database).is_err() {
        return Vec::new();
    }
    let mut out: Vec<Snapshot> = std::fs::read_dir(snapshot_dir(server, database))
        .map(|d| {
            d.flatten()
                .filter(|e| e.file_name().to_string_lossy().ends_with(".sql.gz"))
                .filter_map(|e| {
                    let m = e.metadata().ok()?;
                    Some(Snapshot {
                        name: e.file_name().to_string_lossy().to_string(),
                        bytes: m.len(),
                        at: m.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort_by_key(|s| std::cmp::Reverse(s.at));
    out
}

fn check_snapshot_name(name: &str) -> Result<()> {
    if name.contains('/') || name.contains('\\') || name.starts_with('.') || !name.ends_with(".sql.gz") {
        anyhow::bail!("'{name}' isn't a snapshot");
    }
    Ok(())
}

async fn exec_program(state: &AppState) -> &'static str {
    match state.rt().await.detect_runtime().await {
        orca_core::runtime::RuntimeKind::Podman => "podman",
        orca_core::runtime::RuntimeKind::Docker => "docker",
    }
}

/// Dump the database, compressed, into its snapshot folder.
pub async fn snapshot(state: &AppState, server: &str, database: &str, label: Option<&str>) -> Result<Snapshot> {
    check_ids(server, database)?;
    let (container, engine) = server_container(state, server).await?;
    let dir = snapshot_dir(server, database);
    std::fs::create_dir_all(&dir)?;
    let stamp = chrono::Local::now().format("%Y-%m-%d-%H%M%S").to_string();
    let label = label
        .map(|l| db::ident(l, 40))
        .filter(|l| !l.is_empty())
        .map(|l| format!("-{l}"))
        .unwrap_or_default();
    let name = format!("{stamp}{label}.sql.gz");
    let path = dir.join(&name);
    let cmd = through_file(&db::dump_cmd(engine, database)?, "gzip -c");
    let out = crate::dev::ops::runtime_cli(state, exec_program(state).await)
        .await
        .args(["exec", &container, "sh", "-c", &cmd])
        .output()
        .await
        .context("couldn't run the dump")?;
    if !out.status.success() {
        anyhow::bail!(
            "the dump failed: {}",
            String::from_utf8_lossy(&out.stderr)
                .lines()
                .last()
                .unwrap_or("no output")
        );
    }
    std::fs::write(&path, &out.stdout)?;
    Ok(Snapshot {
        name,
        bytes: out.stdout.len() as u64,
        at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    })
}

/// A dump, then what reads it: written to a file in the container first,
/// so a failed or empty dump fails the whole command in any `sh` (dash has
/// no pipefail), rather than the reader's success hiding it.
fn through_file(dump: &str, then: &str) -> String {
    format!(
        r#"t=/tmp/orca-dump.$$; trap 'rm -f "$t"' EXIT; {dump} > "$t" || exit 1; [ -s "$t" ] || {{ echo "the dump is empty" >&2; exit 1; }}; {then} "$t""#
    )
}

/// Empty the database and load a snapshot into it.
pub async fn restore(state: &AppState, server: &str, database: &str, snapshot: &str) -> Result<()> {
    check_ids(server, database)?;
    check_snapshot_name(snapshot)?;
    let path = snapshot_dir(server, database).join(snapshot);
    let bytes = std::fs::read(&path).with_context(|| format!("no snapshot {snapshot}"))?;
    check_orca_made(state, server, database).await?;
    let (container, engine) = server_container(state, server).await?;
    let user = owner_user(state, server, database).await;
    // What's there now can be had back, or nothing is changed.
    self::snapshot(state, server, database, Some("before-restore"))
        .await
        .context("couldn't take a snapshot of what's there first, so nothing was changed")?;
    crate::dev::data::exec_sh(state, &container, &db::reset_cmd(engine, database, &user)?).await?;
    // Postgres loads as the project's user, so what it creates is theirs.
    let cmd = match engine {
        Engine::Postgres => format!(
            r#"{{ echo 'SET ROLE "{user}";'; gunzip -c; }} | {}"#,
            db::restore_cmd(engine, database)?
        ),
        _ => format!("gunzip -c | {}", db::restore_cmd(engine, database)?),
    };
    let mut child = crate::dev::ops::runtime_cli(state, exec_program(state).await)
        .await
        .args(["exec", "-i", &container, "sh", "-c", &cmd])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .context("couldn't run the restore")?;
    {
        use tokio::io::AsyncWriteExt;
        let mut stdin = child.stdin.take().context("no stdin")?;
        stdin.write_all(&bytes).await?;
    }
    let out = child.wait_with_output().await?;
    if !out.status.success() {
        anyhow::bail!(
            "the restore failed: {}",
            String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("")
        );
    }
    Ok(())
}

pub fn delete_snapshot(server: &str, database: &str, snapshot: &str) -> Result<()> {
    check_ids(server, database)?;
    check_snapshot_name(snapshot)?;
    std::fs::remove_file(snapshot_dir(server, database).join(snapshot))?;
    Ok(())
}

async fn owner_user(state: &AppState, server: &str, database: &str) -> String {
    state
        .config
        .lock()
        .await
        .databases
        .databases
        .get(server)
        .and_then(|m| m.get(database))
        .map(|o| o.user.clone())
        .unwrap_or_else(|| database.to_string())
}

/// Drop the database and create it again, empty; then run the project's
/// seed command, when it has one. Returns what the seed printed.
pub async fn reset(state: &AppState, server: &str, database: &str) -> Result<Option<String>> {
    check_ids(server, database)?;
    check_orca_made(state, server, database).await?;
    let (container, engine) = server_container(state, server).await?;
    let user = owner_user(state, server, database).await;
    crate::dev::data::exec_sh(state, &container, &db::reset_cmd(engine, database, &user)?).await?;
    // The databases it made itself go too, so the seed starts from nothing.
    if makes_own(state, server, database).await {
        let listed = crate::dev::data::exec_sh(state, &container, &db::list_cmd(engine))
            .await
            .unwrap_or_default();
        let prefix = format!("{database}_");
        for name in listed.lines().filter_map(|l| l.split('\t').next()) {
            if name.starts_with(&prefix) && is_db_name(name) {
                crate::dev::data::exec_sh(state, &container, &db::drop_cmd(engine, name)?).await?;
            }
        }
    }
    let owner = state
        .config
        .lock()
        .await
        .databases
        .databases
        .get(server)
        .and_then(|m| m.get(database))
        .cloned();
    let Some(seed) = owner.as_ref().and_then(|o| o.seed.clone()) else {
        return Ok(None);
    };
    let dir = owner.map(|o| o.dir).unwrap_or_default();
    let out = tokio::process::Command::new("sh")
        .args(["-c", &seed])
        .current_dir(&dir)
        .env("PATH", crate::dev::ops::cli_path())
        .output()
        .await
        .with_context(|| format!("couldn't run `{seed}`"))?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    if !out.status.success() {
        anyhow::bail!("`{seed}` failed:\n{}", tail(&text, 20));
    }
    Ok(Some(tail(&text, 20)))
}

fn tail(text: &str, lines: usize) -> String {
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

/// Stop or start one of Orca's own servers.
pub async fn set_running(state: &AppState, id: &str, run: bool) -> Result<()> {
    let name = container_name(id);
    let rt = state.rt().await;
    let c = rt
        .list_containers(true)
        .await?
        .into_iter()
        .find(|c| c.name == name)
        .with_context(|| format!("Orca doesn't run a server {id}"))?;
    if run {
        rt.start_container(&c.id).await
    } else {
        rt.stop_container(&c.id, 20).await
    }
}

// ---- Projects' own database containers ----

/// A project's own database container: what a move onto a shared server
/// starts from.
#[derive(Debug, Serialize)]
pub struct OwnService {
    /// The compose project, and its folder.
    pub project: String,
    pub dir: Option<String>,
    pub service: String,
    pub container: String,
    pub running: bool,
    pub image: String,
    pub engine: Engine,
    pub version: Option<String>,
    /// The database in it, from the image's environment, when it names one.
    pub database: Option<String>,
    /// Volumes holding its data.
    pub volumes: Vec<String>,
    /// What the project's orca.yaml says about it: required, and whether
    /// this is the service it `replaces`.
    pub required: bool,
    pub replaced: bool,
    /// Where the project's required database comes from now.
    pub now_from: Option<String>,
}

/// The engine a database image runs, from its name.
pub fn engine_of_image(image: &str) -> Option<Engine> {
    let base = image.rsplit('/').next().unwrap_or(image).to_lowercase();
    let base = base.split([':', '@']).next().unwrap_or(&base).to_string();
    if base.contains("mariadb") {
        Some(Engine::Mariadb)
    } else if base.contains("mysql") || base.contains("percona") {
        Some(Engine::Mysql)
    } else if ["postgres", "postgis", "timescaledb", "pgvector"]
        .iter()
        .any(|k| base.contains(k))
    {
        Some(Engine::Postgres)
    } else {
        None
    }
}

/// Every compose project's own MySQL, MariaDB and PostgreSQL containers,
/// running or stopped. Servers Orca or a workspace provide aren't included.
pub async fn own_services(state: &AppState) -> Vec<OwnService> {
    let rt = state.rt().await;
    let containers = rt.list_containers(true).await.unwrap_or_default();
    let ws_shared = match state.config.lock().await.workspace.clone() {
        Some(ws) => WorkspaceFile::load(Path::new(&ws.path))
            .ok()
            .map(|f| crate::workspace::shared_name(&f, Path::new(&ws.path))),
        None => None,
    };
    let mut out = Vec::new();
    for c in &containers {
        let Some(project) = c.labels.get("com.docker.compose.project").cloned() else {
            continue;
        };
        let Some(service) = c.labels.get("com.docker.compose.service").cloned() else {
            continue;
        };
        if c.labels.contains_key(SERVER_LABEL) || Some(&project) == ws_shared.as_ref() {
            continue;
        }
        let Some(engine) = engine_of_image(&c.image) else {
            continue;
        };
        let info = rt.docker.inspect_container(&c.id, None).await.ok();
        let env: BTreeMap<String, String> = info
            .as_ref()
            .and_then(|i| i.config.as_ref())
            .and_then(|c| c.env.clone())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|e| e.split_once('=').map(|(k, v)| (k.to_string(), v.to_string())))
            .collect();
        let volumes: Vec<String> = info
            .as_ref()
            .and_then(|i| i.mounts.clone())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|m| m.name.or(m.source))
            .collect();
        let database = match engine {
            Engine::Postgres => env
                .get("POSTGRES_DB")
                .or(env.get("POSTGRES_USER"))
                .cloned()
                .or(Some("postgres".into())),
            _ => env.get("MYSQL_DATABASE").or(env.get("MARIADB_DATABASE")).cloned(),
        };
        let dir = c.labels.get("com.docker.compose.project.working_dir").cloned();
        let (required, replaced, now_from) = match &dir {
            Some(d) => {
                let yaml = OrcaYaml::load(Path::new(d)).unwrap_or_default();
                let reqs = yaml.requires.all();
                let replaced = reqs.iter().any(|r| r.replaces.as_deref() == Some(service.as_str()));
                let now = if reqs.is_empty() {
                    None
                } else {
                    plan(state, &project, Path::new(d))
                        .await
                        .into_iter()
                        .flatten()
                        .find(|p| p.requirement.engine == engine || p.requirement.replaces.as_deref() == Some(&service))
                        .map(|p| describe(&p.source))
                };
                (!reqs.is_empty(), replaced, now)
            }
            None => (false, false, None),
        };
        out.push(OwnService {
            project,
            dir,
            service,
            container: c.name.clone(),
            running: c.state == ContainerState::Running,
            version: db::image_version(&c.image),
            image: c.image.clone(),
            engine,
            database,
            volumes,
            required,
            replaced,
            now_from,
        });
    }
    out.sort_by(|a, b| (&a.project, &a.service).cmp(&(&b.project, &b.service)));
    out
}

/// The `sed` arguments that make a MySQL-family dump load into the other
/// one: MariaDB 11's collations and its "sandbox mode" first line, which
/// MySQL rejects; MySQL 8's collation, which older MariaDB lacks.
fn crossing(from: Engine, to: Engine) -> Option<&'static str> {
    match (from, to) {
        (Engine::Mariadb, Engine::Mysql) => Some(
            r#"-e '/enable the sandbox mode/d' -e 's/utf8mb4_uca1400_[a-z0-9_]*/utf8mb4_0900_ai_ci/g' -e 's/utf8mb3_uca1400_[a-z0-9_]*/utf8mb3_general_ci/g'"#,
        ),
        (Engine::Mysql, Engine::Mariadb) => Some(
            r#"-e 's/utf8mb4_0900_[a-z0-9_]*/utf8mb4_unicode_520_ci/g' -e 's#/\*!80016 DEFAULT ENCRYPTION=.N. \*/##g'"#,
        ),
        _ => None,
    }
}

/// What an import did.
#[derive(Debug, Serialize)]
pub struct Imported {
    pub from: String,
    pub database: String,
    /// A snapshot of what the target held before, to go back to.
    pub snapshot_before: Option<String>,
    pub bytes: u64,
    /// The project's own `<name>_…` databases that came along.
    pub others: Vec<String>,
}

/// Copy a database from a project's own container into a database Orca
/// made on a shared or Orca server, replacing what's there (after a
/// snapshot of it). A stopped source container is started for the copy and
/// stopped again.
pub async fn import(
    state: &AppState,
    server: &str,
    database: &str,
    source_container: &str,
    source_database: Option<&str>,
) -> Result<Imported> {
    check_ids(server, database)?;
    check_orca_made(state, server, database).await?;
    let source = own_services(state)
        .await
        .into_iter()
        .find(|s| s.container == source_container)
        .with_context(|| {
            format!("'{source_container}' isn't a project's own database container (see find_database_services)")
        })?;
    let (target, engine) = server_container(state, server).await?;
    let same_family = matches!((source.engine, engine), (Engine::Postgres, Engine::Postgres))
        || (source.engine != Engine::Postgres && engine != Engine::Postgres);
    if !same_family {
        anyhow::bail!(
            "{} is {}, and {server} is {}: an import needs the same engine",
            source_container,
            source.engine.name(),
            engine.name()
        );
    }
    let from_db = source_database
        .map(str::to_string)
        .or(source.database.clone())
        .with_context(|| format!("{source_container} doesn't say which database it holds: give source_database"))?;
    if !is_db_name(&from_db) {
        anyhow::bail!("'{from_db}' isn't a database name");
    }

    let rt = state.rt().await;
    let started = !source.running;
    if started {
        rt.start_container(&source.container)
            .await
            .context("couldn't start the source container")?;
        wait_alive(state, &source.container, source.engine).await?;
    }
    let result = async {
        // What's there now can be had back.
        let before = Some(
            snapshot(state, server, database, Some("before-import"))
                .await
                .context("couldn't take a snapshot of what's there first, so nothing was changed")?
                .name,
        );
        // The source can be read, before the target is emptied.
        crate::dev::data::exec_sh(state, &source.container, &source_check_cmd(source.engine, &from_db))
            .await
            .with_context(|| format!("couldn't read {from_db} in {}", source.container))?;
        let user = owner_user(state, server, database).await;
        crate::dev::data::exec_sh(state, &target, &db::reset_cmd(engine, database, &user)?).await?;
        copy_database(state, &source, &from_db, &target, engine, database, &user).await?;

        // The databases a project makes itself (`<name>_tenant`, with
        // `privileges: [create]`) come along, under the new name.
        let mut others = Vec::new();
        if makes_own(state, server, database).await {
            let listed =
                crate::dev::data::exec_sh(state, &source.container, &source_family_cmd(source.engine, &from_db))
                    .await
                    .unwrap_or_default();
            for name in listed.lines().map(str::trim) {
                let Some(suffix) = name.strip_prefix(&format!("{from_db}_")) else {
                    continue;
                };
                let to = format!("{database}_{suffix}");
                if suffix.is_empty() || !is_db_name(name) || !is_db_name(&to) {
                    continue;
                }
                crate::dev::data::exec_sh(state, &target, &db::reset_cmd(engine, &to, &user)?).await?;
                copy_database(state, &source, name, &target, engine, &to, &user).await?;
                others.push(to);
            }
        }
        let size = servers_with(state, true)
            .await
            .into_iter()
            .find(|s| s.id == server)
            .and_then(|s| s.databases.into_iter().find(|d| d.name == database))
            .and_then(|d| d.size)
            .unwrap_or(0);
        Ok(Imported {
            from: format!("{}/{from_db}", source.container),
            database: database.to_string(),
            snapshot_before: before,
            bytes: size,
            others,
        })
    }
    .await;
    if started {
        let _ = rt.stop_container(&source.container, 20).await;
    }
    result
}

fn is_db_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// The login a project's own MySQL or MariaDB container can be read with:
/// its admin when the container knows the password, else the app's own
/// user, which can read its database (images started with a random root
/// password are common). Sets `$U` and `$P`.
const SOURCE_LOGIN: &str = r#"if [ -n "${MYSQL_ROOT_PASSWORD:-$MARIADB_ROOT_PASSWORD}" ]; then U=root; P="${MYSQL_ROOT_PASSWORD:-$MARIADB_ROOT_PASSWORD}"; else U="${MYSQL_USER:-${MARIADB_USER:-root}}"; P="${MYSQL_PASSWORD:-$MARIADB_PASSWORD}"; fi"#;

/// Fails unless the source container's database can be read.
fn source_check_cmd(engine: Engine, db: &str) -> String {
    match engine {
        Engine::Postgres => format!(r#"psql -U "${{POSTGRES_USER:-postgres}}" -d "{db}" -tAc 'SELECT 1' >/dev/null"#),
        _ => format!(
            r#"{SOURCE_LOGIN}; $(command -v mysql || command -v mariadb) -u"$U" ${{P:+-p"$P"}} -e 'SELECT 1' "{db}" >/dev/null"#
        ),
    }
}

/// Lists the source container's databases named `<db>_…`.
fn source_family_cmd(engine: Engine, db: &str) -> String {
    let pattern = db.replace('_', "\\\\_");
    match engine {
        Engine::Postgres => format!(
            r#"psql -U "${{POSTGRES_USER:-postgres}}" -tAc "SELECT datname FROM pg_database WHERE datname LIKE '{pattern}\\_%'""#
        ),
        _ => format!(
            r#"{SOURCE_LOGIN}; $(command -v mysql || command -v mariadb) -u"$U" ${{P:+-p"$P"}} -N -B -e "SHOW DATABASES LIKE '{pattern}\\_%'""#
        ),
    }
}

/// Stream one database from a project's own container into an (empty)
/// database on a server.
async fn copy_database(
    state: &AppState,
    source: &OwnService,
    from_db: &str,
    target: &str,
    engine: Engine,
    database: &str,
    user: &str,
) -> Result<()> {
    let program = exec_program(state).await;
    let dump = match source.engine {
        Engine::Postgres => format!(r#"pg_dump -U "${{POSTGRES_USER:-postgres}}" --no-owner --no-acl -d "{from_db}""#),
        // With its stored routines; their DEFINER is left out, as the user
        // it names doesn't exist on the new server.
        _ => format!(
            r#"{SOURCE_LOGIN}; $(command -v mysqldump || command -v mariadb-dump) -u"$U" ${{P:+-p"$P"}} --single-transaction --no-tablespaces --triggers --routines "{from_db}""#
        ),
    };
    let load = match engine {
        Engine::Postgres => format!(
            r#"{{ echo 'SET ROLE "{user}";'; cat; }} | {}"#,
            db::restore_cmd(engine, database)?
        ),
        _ => db::restore_cmd(engine, database)?,
    };
    // Between MariaDB and MySQL, the dump is translated on the way.
    let dump = match source.engine {
        Engine::Postgres => through_file(&dump, "cat"),
        _ => through_file(
            &dump,
            &format!(
                "sed -e 's/DEFINER=`[^`]*`@`[^`]*`//g' {}",
                crossing(source.engine, engine).unwrap_or_default()
            ),
        ),
    };
    let mut src = crate::dev::ops::runtime_cli(state, program)
        .await
        .args(["exec", &source.container, "sh", "-c", &dump])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .context("couldn't run the dump")?;
    let pipe: std::process::Stdio = src.stdout.take().context("no dump output")?.try_into()?;
    let dst = crate::dev::ops::runtime_cli(state, program)
        .await
        .args(["exec", "-i", target, "sh", "-c", &load])
        .stdin(pipe)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .context("couldn't run the restore")?;
    let (src_out, dst_out) = tokio::join!(src.wait_with_output(), dst.wait_with_output());
    let (src_out, dst_out) = (src_out?, dst_out?);
    if !src_out.status.success() {
        anyhow::bail!(
            "the dump of {from_db} from {} failed: {}",
            source.container,
            String::from_utf8_lossy(&src_out.stderr).lines().last().unwrap_or("")
        );
    }
    if !dst_out.status.success() {
        anyhow::bail!(
            "loading into {database} failed: {}",
            String::from_utf8_lossy(&dst_out.stderr).lines().last().unwrap_or("")
        );
    }
    Ok(())
}

/// Whether the project may make databases of its own named `<database>_…`
/// (`privileges: [create]`): they go with it on import, and on reset.
async fn makes_own(state: &AppState, server: &str, database: &str) -> bool {
    let owner = state
        .config
        .lock()
        .await
        .databases
        .databases
        .get(server)
        .and_then(|m| m.get(database))
        .cloned();
    let Some(owner) = owner else {
        return false;
    };
    let Ok(yaml) = OrcaYaml::load(Path::new(&owner.dir)) else {
        return false;
    };
    yaml.requires.all().iter().any(|r| {
        r.privileges.contains(&db::Privilege::Create)
            && r.name.clone().unwrap_or_else(|| db::ident(&owner.project, 63)) == database
    })
}

// ---- API ----

use std::sync::Arc;

use axum::extract::{Path as UrlPath, State};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};

use crate::api::ApiError;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/databases", get(overview))
        .route("/databases/own-services", get(get_own_services))
        .route("/databases/servers/{server}/start", post(start_server))
        .route("/databases/servers/{server}/stop", post(stop_server))
        .route("/databases/{server}/{database}/connection", get(get_connection))
        .route("/databases/{server}/{database}/reset", post(post_reset))
        .route(
            "/databases/{server}/{database}/snapshots",
            get(get_snapshots).post(post_snapshot),
        )
        .route(
            "/databases/{server}/{database}/snapshots/{snapshot}",
            axum::routing::delete(delete_snapshot_route),
        )
        .route(
            "/databases/{server}/{database}/snapshots/{snapshot}/restore",
            post(post_restore),
        )
        .route("/databases/{server}/{database}/import", post(post_import))
}

/// A project whose `orca.yaml` requires databases, and where each comes from.
#[derive(Debug, Serialize)]
pub struct ProjectNeeds {
    pub project: String,
    pub dir: String,
    pub running: bool,
    pub databases: Vec<serde_json::Value>,
}

/// Every project Orca knows of (stacks, and the workspace's cloned projects)
/// that requires a database.
pub async fn needs(state: &AppState) -> Vec<ProjectNeeds> {
    let containers = state.rt().await.list_containers(true).await.unwrap_or_default();
    let stacks = orca_core::compose::extract_projects(&containers);
    let mut dirs: Vec<(PathBuf, bool)> = stacks
        .iter()
        .filter_map(|s| {
            let dir = PathBuf::from(s.working_dir.as_deref()?);
            let running = s.services.iter().any(|x| x.state == ContainerState::Running);
            Some((dir, running))
        })
        .collect();
    if let Some(ws) = state.config.lock().await.workspace.clone()
        && let Ok(file) = WorkspaceFile::load(Path::new(&ws.path))
    {
        for key in file.projects.keys() {
            let d = file.project_dir(Path::new(&ws.path), key);
            if d.is_dir() {
                dirs.push((d, false));
            }
        }
    }
    let mut seen = std::collections::BTreeSet::new();
    let mut out = Vec::new();
    for (dir, running) in dirs {
        let Ok(canon) = dir.canonicalize() else { continue };
        if !seen.insert(canon.clone()) {
            continue;
        }
        let yaml = OrcaYaml::load(&canon).unwrap_or_default();
        if yaml.requires.is_empty() {
            continue;
        }
        let Ok(project) = crate::folders::project_name(&canon) else {
            continue;
        };
        let databases = plan(state, &project, &canon)
            .await
            .into_iter()
            .map(|p| match p {
                Ok(p) => serde_json::json!({
                    "engine": p.requirement.engine,
                    "version": p.requirement.version,
                    "database": p.database,
                    "user": p.user,
                    "server": p.source.server_id(),
                    "source": p.source,
                    "from": describe(&p.source),
                    "replaces": p.requirement.replaces,
                }),
                Err(e) => serde_json::json!({ "error": e }),
            })
            .collect();
        out.push(ProjectNeeds {
            project,
            dir: canon.to_string_lossy().to_string(),
            running: running
                || stacks.iter().any(|s| {
                    s.working_dir
                        .as_deref()
                        .map(PathBuf::from)
                        .and_then(|d| d.canonicalize().ok())
                        .as_ref()
                        == Some(&canon)
                        && s.services.iter().any(|x| x.state == ContainerState::Running)
                }),
            databases,
        });
    }
    out
}

#[derive(serde::Deserialize, Default)]
struct OverviewQuery {
    /// Leave out sizes (fast, for summaries elsewhere in the app).
    #[serde(default)]
    quick: bool,
}

async fn overview(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(q): axum::extract::Query<OverviewQuery>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(serde_json::json!({
        "servers": servers_with(&state, !q.quick).await,
        "projects": needs(&state).await,
        "snapshot_dir": dirs::data_dir().unwrap_or_default().join("orca").join("database-snapshots"),
    })))
}

fn orca_id(server: &str) -> Result<&str, ApiError> {
    server
        .strip_prefix("orca:")
        .ok_or_else(|| ApiError::bad_request("Only servers Orca runs itself can be started or stopped here"))
}

async fn start_server(
    State(state): State<Arc<AppState>>,
    UrlPath(server): UrlPath<String>,
) -> Result<impl IntoResponse, ApiError> {
    set_running(&state, orca_id(&server)?, true).await?;
    Ok(Json(serde_json::json!({ "running": true })))
}

async fn stop_server(
    State(state): State<Arc<AppState>>,
    UrlPath(server): UrlPath<String>,
) -> Result<impl IntoResponse, ApiError> {
    set_running(&state, orca_id(&server)?, false).await?;
    Ok(Json(serde_json::json!({ "running": false })))
}

async fn get_connection(
    State(state): State<Arc<AppState>>,
    UrlPath((server, database)): UrlPath<(String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(connection(&state, &server, &database).await?))
}

async fn post_reset(
    State(state): State<Arc<AppState>>,
    UrlPath((server, database)): UrlPath<(String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    let seeded = reset(&state, &server, &database).await?;
    Ok(Json(serde_json::json!({ "reset": true, "seed_output": seeded })))
}

async fn get_snapshots(UrlPath((server, database)): UrlPath<(String, String)>) -> impl IntoResponse {
    Json(snapshots(&server, &database))
}

#[derive(serde::Deserialize, Default)]
struct SnapshotBody {
    #[serde(default)]
    label: Option<String>,
}

async fn post_snapshot(
    State(state): State<Arc<AppState>>,
    UrlPath((server, database)): UrlPath<(String, String)>,
    body: Option<Json<SnapshotBody>>,
) -> Result<impl IntoResponse, ApiError> {
    let label = body.and_then(|b| b.0.label);
    Ok(Json(snapshot(&state, &server, &database, label.as_deref()).await?))
}

async fn post_restore(
    State(state): State<Arc<AppState>>,
    UrlPath((server, database, snap)): UrlPath<(String, String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    restore(&state, &server, &database, &snap).await?;
    Ok(Json(serde_json::json!({ "restored": snap })))
}

async fn delete_snapshot_route(
    UrlPath((server, database, snap)): UrlPath<(String, String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    delete_snapshot(&server, &database, &snap)?;
    Ok(Json(serde_json::json!({ "deleted": snap })))
}

async fn get_own_services(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(own_services(&state).await)
}

#[derive(serde::Deserialize)]
struct ImportBody {
    /// The project's own database container to copy from.
    container: String,
    /// The database in it; read from the container's environment when unset.
    #[serde(default)]
    database: Option<String>,
}

async fn post_import(
    State(state): State<Arc<AppState>>,
    UrlPath((server, database)): UrlPath<(String, String)>,
    Json(body): Json<ImportBody>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(
        import(&state, &server, &database, &body.container, body.database.as_deref()).await?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compose_file_in_env_is_added_and_taken_out_again() {
        let dir = tempfile::tempdir().unwrap();
        let env = dir.path().join(".env");
        let original = "APP_NAME=shop\nDB_HOST=db\n";
        std::fs::write(&env, original).unwrap();
        let main = dir.path().join("docker-compose.yml").to_string_lossy().to_string();
        set_compose_file(dir.path(), std::slice::from_ref(&main)).unwrap();
        let text = std::fs::read_to_string(&env).unwrap();
        assert!(
            text.contains("COMPOSE_FILE=docker-compose.yml:.orca/databases.override.yaml"),
            "{text}"
        );
        // Again, as on every start: unchanged.
        set_compose_file(dir.path(), &[main, OVERRIDE_ENTRY.into()]).unwrap();
        assert_eq!(std::fs::read_to_string(&env).unwrap(), text);
        unset_compose_file(dir.path()).unwrap();
        assert_eq!(std::fs::read_to_string(&env).unwrap(), original);

        // The project's own COMPOSE_FILE is kept.
        std::fs::write(&env, "COMPOSE_FILE=a.yml:b.yml\n").unwrap();
        set_compose_file(dir.path(), &["a.yml".into(), "b.yml".into()]).unwrap();
        assert_eq!(
            std::fs::read_to_string(&env).unwrap(),
            "COMPOSE_FILE=a.yml:b.yml:.orca/databases.override.yaml\n"
        );
        unset_compose_file(dir.path()).unwrap();
        assert_eq!(std::fs::read_to_string(&env).unwrap(), "COMPOSE_FILE=a.yml:b.yml\n");
    }

    #[test]
    fn ids_from_the_api_are_checked() {
        assert!(check_ids("workspace:mysql", "onecrm").is_ok());
        assert!(check_ids("orca:postgres-17", "shop_test").is_ok());
        assert!(check_ids("orca:../../etc", "x").is_err());
        assert!(check_ids("other:mysql", "x").is_err());
        assert!(check_ids("orca:mysql-8-4", "../x").is_err());
        assert!(snapshots("orca:..", "x").is_empty());
        assert!(check_snapshot_name("2026-10-24-120000.sql.gz").is_ok());
        assert!(check_snapshot_name("../a.sql.gz").is_err() && check_snapshot_name("a.txt").is_err());
    }

    #[test]
    fn mariadb_and_mysql_dumps_are_translated() {
        assert!(crossing(Engine::Mariadb, Engine::Mysql).unwrap().contains("uca1400"));
        assert!(crossing(Engine::Mysql, Engine::Mariadb).unwrap().contains("0900"));
        assert_eq!(crossing(Engine::Mysql, Engine::Mysql), None);
        assert_eq!(crossing(Engine::Postgres, Engine::Postgres), None);
    }

    #[test]
    fn database_images_are_recognised() {
        assert_eq!(engine_of_image("mysql:8.0"), Some(Engine::Mysql));
        assert_eq!(engine_of_image("docker.io/library/mariadb:11"), Some(Engine::Mariadb));
        assert_eq!(engine_of_image("percona:8"), Some(Engine::Mysql));
        assert_eq!(engine_of_image("postgis/postgis:16-3.4"), Some(Engine::Postgres));
        assert_eq!(engine_of_image("redis:7"), None);
        assert_eq!(engine_of_image("ghcr.io/umami-software/umami:postgresql-v2"), None);
    }

    #[test]
    fn sources_name_their_server() {
        let w = Source::Workspace {
            key: "mysql".into(),
            engine: Engine::Mysql,
            version: None,
            service: "mysql".into(),
        };
        assert_eq!(w.server_id().as_deref(), Some("workspace:mysql"));
        let o = Source::Orca {
            id: "postgres-17".into(),
            engine: Engine::Postgres,
            version: "17".into(),
        };
        assert_eq!(o.server_id().as_deref(), Some("orca:postgres-17"));
        assert_eq!(container_name("postgres-17"), "orca-postgres-17");
        assert_eq!(
            Source::Own {
                service: Some("db".into()),
                why: String::new()
            }
            .server_id(),
            None
        );
    }
}
