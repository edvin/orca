//! A joined workspace (see `orca_core::workspace`): cloning it, applying its
//! network, gateway domain and certificate, shared services and routes, and
//! setting up its projects (clone, `.env` with secrets, setup command,
//! start). Long steps run as jobs the app and AI tools can follow.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use anyhow::{Context, Result};
use axum::extract::{Path as UrlPath, State};
use axum::response::IntoResponse;
use axum::routing::{get, post, put};
use axum::{Json, Router};
use orca_core::config::{GatewayRoute, GatewayTlsMode, RoutePresentation, WorkspaceRef};
use orca_core::runtime::{ContainerRuntime, ContainerState};
use orca_core::workspace::{self as schema, SecretRef, WorkspaceFile, WorkspaceRoute};
use serde::Deserialize;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::api::ApiError;
use crate::dev::jobs::JobHandle;
use crate::state::AppState;

/// Owner of the workspace's own routes; a project's are `workspace:<name>:<project>`.
const OWNER: &str = "workspace:";

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/workspace", get(status))
        .route("/workspace/join", post(join))
        .route("/workspace/update", post(update))
        .route("/workspace/leave", post(leave))
        .route("/workspace/import-haproxy", post(import_haproxy))
        .route("/workspace/projects/{key}/setup", post(setup))
        .route("/workspace/projects/{key}/env", put(set_env))
        .route("/workspace/projects/{key}/secrets", post(fetch_secrets))
}

/// 202 with the job, for the caller to follow.
async fn accepted(job: JobHandle) -> axum::response::Response {
    (axum::http::StatusCode::ACCEPTED, Json(job.snapshot().await)).into_response()
}

/// The joined workspace, its parsed file and its folder.
async fn current(state: &AppState) -> Result<(WorkspaceRef, WorkspaceFile, PathBuf), ApiError> {
    let ws = state
        .config
        .lock()
        .await
        .workspace
        .clone()
        .ok_or_else(|| ApiError::bad_request("No workspace joined yet"))?;
    let dir = PathBuf::from(&ws.path);
    let file = WorkspaceFile::load(&dir).map_err(|e| ApiError::bad_request(e.to_string()))?;
    Ok((ws, file, dir))
}

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

/// `git`, never prompting: credentials come from the developer's SSH agent
/// or credential helper, and a first-time host key is accepted as `ssh`
/// does when you type "yes".
fn git() -> Command {
    let mut cmd = Command::new("git");
    cmd.env("PATH", crate::dev::ops::cli_path())
        .env("GIT_TERMINAL_PROMPT", "0")
        .args(["-c", "protocol.ext.allow=never"])
        .stdin(Stdio::null());
    if std::env::var_os("GIT_SSH_COMMAND").is_none() {
        cmd.env(
            "GIT_SSH_COMMAND",
            "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
        );
    }
    cmd
}

/// Run a command, every output line into the job's log.
async fn run_logged(job: &JobHandle, mut cmd: Command, shown: &str) -> Result<()> {
    job.log(format!("$ {shown}")).await;
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("could not run `{shown}`"))?;
    let (out, err) = (child.stdout.take().expect("piped"), child.stderr.take().expect("piped"));
    let (j1, j2) = (job.clone(), job.clone());
    let t1 = tokio::spawn(async move {
        let mut lines = BufReader::new(out).lines();
        while let Ok(Some(l)) = lines.next_line().await {
            j1.log(l).await;
        }
    });
    let t2 = tokio::spawn(async move {
        let mut tail = Vec::new();
        let mut lines = BufReader::new(err).lines();
        while let Ok(Some(l)) = lines.next_line().await {
            j2.log(l.clone()).await;
            tail.push(l);
            if tail.len() > 8 {
                tail.remove(0);
            }
        }
        tail.join("\n")
    });
    let status = child.wait().await?;
    let _ = t1.await;
    let tail = t2.await.unwrap_or_default();
    if !status.success() {
        anyhow::bail!(
            "`{shown}` failed{}",
            if tail.is_empty() {
                String::new()
            } else {
                format!(":\n{tail}")
            }
        );
    }
    Ok(())
}

/// A shell command from the workspace file (`setup: just setup`), in `dir`.
fn shell(command: &str, dir: &Path) -> Command {
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.args(["/C", command]);
        c
    } else {
        let mut c = Command::new("sh");
        c.args(["-c", command]);
        c
    };
    cmd.current_dir(dir)
        .env("PATH", crate::dev::ops::cli_path())
        .stdin(Stdio::null());
    cmd
}

/// The folder a repo URL clones into by default: `~/code/<name>`.
fn default_clone_dir(repo: &str) -> PathBuf {
    let name = repo
        .trim_end_matches('/')
        .rsplit(['/', ':'])
        .next()
        .unwrap_or("workspace")
        .trim_end_matches(".git");
    home()
        .join("code")
        .join(if name.is_empty() { "workspace" } else { name })
}

#[derive(Deserialize)]
struct JoinBody {
    /// A git URL, or the path of a folder that already has the workspace file.
    repo: String,
    /// Where to clone it; `~/code/<repo name>` when unset.
    #[serde(default)]
    folder: Option<String>,
}

/// POST /workspace/join: clone the workspace and apply it.
async fn join(State(state): State<Arc<AppState>>, Json(body): Json<JoinBody>) -> Result<impl IntoResponse, ApiError> {
    let repo = body.repo.trim().to_string();
    if repo.is_empty() || repo.starts_with('-') {
        return Err(ApiError::bad_request("Give the workspace's git URL"));
    }
    let local = Path::new(&repo);
    let (dir, clone) = if local.is_absolute() && local.is_dir() {
        (local.to_path_buf(), false)
    } else {
        let dir = body
            .folder
            .as_deref()
            .map(|f| {
                f.strip_prefix("~/")
                    .map(|r| home().join(r))
                    .unwrap_or_else(|| PathBuf::from(f))
            })
            .unwrap_or_else(|| default_clone_dir(&repo));
        if !dir.is_absolute() {
            return Err(ApiError::bad_request("The folder must be an absolute path"));
        }
        let exists = dir.exists();
        if exists
            && WorkspaceFile::find(&dir).is_none()
            && std::fs::read_dir(&dir).map(|mut d| d.next().is_some()).unwrap_or(false)
        {
            return Err(ApiError::bad_request(format!(
                "{} already exists and isn't this workspace. Choose another folder.",
                dir.display()
            )));
        }
        let clone = !exists || WorkspaceFile::find(&dir).is_none();
        (dir, clone)
    };

    let job = JobHandle::create(
        "workspace",
        None,
        "join",
        &[
            ("clone", "Get the workspace"),
            ("network", "Create the shared network"),
            ("gateway", "Set up the gateway"),
            ("shared", "Start the shared services"),
            ("routes", "Add the routes"),
        ],
    )
    .await;
    let j = job.clone();
    tokio::spawn(async move {
        let r: Result<()> = async {
            j.start("clone").await;
            if clone {
                if let Some(parent) = dir.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                let mut cmd = git();
                cmd.arg("clone").arg("--").arg(&repo).arg(&dir);
                run_logged(&j, cmd, &format!("git clone {repo} {}", dir.display())).await?;
                j.done("clone", Some(dir.display().to_string())).await;
            } else {
                j.done("clone", Some(format!("Using {}", dir.display()))).await;
            }
            let file = WorkspaceFile::load(&dir)?;
            {
                let mut cfg = state.config.lock().await;
                cfg.workspace = Some(WorkspaceRef {
                    repo: repo.clone(),
                    path: dir.to_string_lossy().to_string(),
                    name: file.name.clone(),
                    network: file.network.clone(),
                    setup_done: Vec::new(),
                });
                cfg.save()?;
            }
            apply(&state, &j, &file, &dir).await
        }
        .await;
        match r {
            Ok(()) => j.succeed(None).await,
            Err(e) => j.fail(&e).await,
        }
    });
    Ok(accepted(job).await)
}

/// POST /workspace/update: pull the workspace and apply it again.
async fn update(State(state): State<Arc<AppState>>) -> Result<impl IntoResponse, ApiError> {
    let (_, _, dir) = current(&state).await?;
    let job = JobHandle::create(
        "workspace",
        None,
        "update",
        &[
            ("clone", "Get the latest workspace"),
            ("network", "Create the shared network"),
            ("gateway", "Set up the gateway"),
            ("shared", "Start the shared services"),
            ("routes", "Add the routes"),
        ],
    )
    .await;
    let j = job.clone();
    tokio::spawn(async move {
        let r: Result<()> = async {
            j.start("clone").await;
            let mut cmd = git();
            cmd.arg("-C").arg(&dir).args(["pull", "--ff-only"]);
            run_logged(&j, cmd, "git pull --ff-only").await?;
            j.done("clone", None).await;
            let file = WorkspaceFile::load(&dir)?;
            {
                let mut cfg = state.config.lock().await;
                if let Some(ws) = cfg.workspace.as_mut() {
                    ws.name = file.name.clone();
                    ws.network = file.network.clone();
                }
                cfg.save()?;
            }
            apply(&state, &j, &file, &dir).await
        }
        .await;
        match r {
            Ok(()) => j.succeed(None).await,
            Err(e) => j.fail(&e).await,
        }
    });
    Ok(accepted(job).await)
}

/// Make this machine match the workspace file: network, gateway, shared
/// services, routes. Safe to run again.
async fn apply(state: &AppState, job: &JobHandle, file: &WorkspaceFile, dir: &Path) -> Result<()> {
    job.start("network").await;
    match &file.network {
        Some(net) => {
            ensure_network(state, net).await?;
            job.done("network", Some(net.clone())).await;
        }
        None => job.skip("network", "None in the workspace file").await,
    }

    job.start("gateway").await;
    let gateway = {
        let mut cfg = state.config.lock().await;
        let gw = &mut cfg.gateway;
        if let Some(g) = &file.gateway {
            if let Some(domain) = &g.domain {
                gw.domain = domain.clone();
            }
            match &g.certificate {
                Some(c) => {
                    let read = |p: &str| {
                        std::fs::read_to_string(dir.join(p))
                            .with_context(|| format!("can't read the certificate file {p}"))
                    };
                    gw.custom_cert = Some(read(&c.cert)?);
                    gw.custom_key = Some(read(&c.key)?);
                    gw.tls_mode = GatewayTlsMode::Custom;
                }
                None => gw.tls_mode = GatewayTlsMode::OrcaCa,
            }
        }
        gw.enabled = true;
        cfg.save()?;
        cfg.gateway.clone()
    };
    if crate::gateway::is_running(state).await.unwrap_or(false) {
        crate::gateway::stop(state).await?;
    }
    crate::gateway::start(state, &gateway)
        .await
        .context("the gateway didn't start; is another program using ports 80 or 443?")?;
    job.done("gateway", Some(format!("*.{}", gateway.domain))).await;

    job.start("shared").await;
    match &file.shared {
        Some(shared) => {
            let compose = dir.join(&shared.compose);
            if !compose.is_file() {
                anyhow::bail!("{} doesn't exist", compose.display());
            }
            let name = shared_name(file, dir);
            let args: Vec<String> = ["-p", &name, "-f", &compose.to_string_lossy(), "up", "-d"]
                .iter()
                .map(|s| s.to_string())
                .collect();
            crate::dev::ops::compose(state, dir, &args, Some(job))
                .await
                .and_then(|r| {
                    if r.success {
                        Ok(())
                    } else {
                        anyhow::bail!("starting the shared services failed:\n{}", r.stderr_tail)
                    }
                })?;
            job.done("shared", Some(name)).await;
        }
        None => job.skip("shared", "None in the workspace file").await,
    }

    job.start("routes").await;
    let n = sync_routes(state, file).await?;
    job.done("routes", Some(format!("{n} routes"))).await;
    Ok(())
}

fn shared_name(file: &WorkspaceFile, dir: &Path) -> String {
    file.shared
        .as_ref()
        .and_then(|s| s.name.clone())
        .or_else(|| crate::folders::project_name(dir).ok())
        .unwrap_or_else(|| "workspace".into())
}

async fn ensure_network(state: &AppState, name: &str) -> Result<()> {
    let rt = state.rt().await;
    if rt.docker.inspect_network::<String>(name, None).await.is_ok() {
        return Ok(());
    }
    orca_core::network::NetworkManager::create(rt.as_ref(), name, "bridge")
        .await
        .map(|_| ())
}

/// Replace the workspace's routes with what its file says now.
async fn sync_routes(state: &AppState, file: &WorkspaceFile) -> Result<usize> {
    let to_route = |r: &WorkspaceRoute, owner: String, group: &str| -> Option<GatewayRoute> {
        let (host, port) = r.target()?;
        Some(GatewayRoute {
            hostname: r.hostname.clone(),
            container_name: host.to_string(),
            port,
            enabled: true,
            path: r.path.clone(),
            owner: Some(owner),
            sleeping: false,
            presentation: RoutePresentation {
                title: r.title.clone(),
                group: Some(group.to_string()),
                ..Default::default()
            },
        })
    };
    let mut wanted: Vec<GatewayRoute> = file
        .routes
        .iter()
        .filter_map(|r| to_route(r, format!("{OWNER}{}", file.name), "Shared services"))
        .collect();
    for (key, p) in &file.projects {
        wanted.extend(
            p.routes
                .iter()
                .filter_map(|r| to_route(r, format!("{OWNER}{}:{key}", file.name), key)),
        );
    }
    let n = wanted.len();
    {
        let mut cfg = state.config.lock().await;
        cfg.gateway
            .routes
            .retain(|r| !r.owner.as_deref().is_some_and(|o| o.starts_with(OWNER)));
        // A hostname someone added by hand or a worktree uses stays theirs.
        let taken: std::collections::HashSet<(String, Option<String>)> = cfg
            .gateway
            .routes
            .iter()
            .map(|r| (r.hostname.clone(), r.path.clone()))
            .collect();
        cfg.gateway.routes.extend(
            wanted
                .into_iter()
                .filter(|r| !taken.contains(&(r.hostname.clone(), r.path.clone()))),
        );
        cfg.save()?;
    }
    crate::gateway_sync::routes_changed();
    Ok(n)
}

/// POST /workspace/leave: forget the workspace and remove its routes. The
/// clone, projects and running services stay.
async fn leave(State(state): State<Arc<AppState>>) -> Result<impl IntoResponse, ApiError> {
    {
        let mut cfg = state.config.lock().await;
        cfg.workspace = None;
        cfg.gateway
            .routes
            .retain(|r| !r.owner.as_deref().is_some_and(|o| o.starts_with(OWNER)));
        cfg.save().map_err(|e| anyhow::anyhow!("Failed to save config: {e}"))?;
    }
    crate::gateway_sync::routes_changed();
    Ok(Json(serde_json::json!({ "left": true })))
}

/// Whether `docker login` was done for a registry (or a credential helper covers it).
fn registry_logged_in(host: &str) -> bool {
    let path = home().join(".docker").join("config.json");
    let Ok(v) = std::fs::read_to_string(path)
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).map_err(std::io::Error::other))
    else {
        return false;
    };
    let has = |k: &str| {
        v.get(k)
            .and_then(|o| o.as_object())
            .is_some_and(|o| o.keys().any(|h| h.trim_start_matches("https://").starts_with(host)))
    };
    has("auths") || has("credHelpers")
}

/// The secrets a project's `.env` needs, and which are filled.
fn secrets_of(file: &WorkspaceFile, key: &str, project_dir: &Path) -> Vec<crate::secrets::SecretInfo> {
    let Some(env) = file.projects.get(key).and_then(|p| p.env.as_ref()) else {
        return Vec::new();
    };
    let text = std::fs::read_to_string(project_dir.join(env.file())).unwrap_or_default();
    env.secrets
        .iter()
        .filter_map(|(name, reference)| {
            let r = SecretRef::parse(reference).ok()?;
            Some(crate::secrets::SecretInfo {
                name: name.clone(),
                provider: r.provider(),
                reference: reference.clone(),
                link: crate::secrets::link(&r, &file.secrets),
                filled: schema::env_value(&text, name).is_some(),
            })
        })
        .collect()
}

/// GET /workspace: the workspace and every project's state.
async fn status(State(state): State<Arc<AppState>>) -> Result<impl IntoResponse, ApiError> {
    let Some(ws) = state.config.lock().await.workspace.clone() else {
        return Ok(Json(serde_json::json!({ "joined": false })));
    };
    let dir = PathBuf::from(&ws.path);
    let file = match WorkspaceFile::load(&dir) {
        Ok(f) => f,
        Err(e) => {
            return Ok(Json(serde_json::json!({
                "joined": true, "name": ws.name, "repo": ws.repo, "path": ws.path, "error": e.to_string(),
            })));
        }
    };
    let (domain, port_suffix) = {
        let cfg = state.config.lock().await;
        let p = if cfg.gateway.https_port == 443 {
            String::new()
        } else {
            format!(":{}", cfg.gateway.https_port)
        };
        (cfg.gateway.domain.clone(), p)
    };
    let url = |r: &WorkspaceRoute| {
        let host = crate::project_config::qualify_hostname(&r.hostname, &domain);
        format!(
            "https://{host}{port_suffix}{}",
            r.path.as_deref().unwrap_or("").trim_end_matches('*')
        )
    };

    let stacks = match state.rt().await.list_containers(true).await {
        Ok(c) => orca_core::compose::extract_projects(&c),
        Err(_) => Vec::new(),
    };
    let stack_in = |d: &Path| {
        let d = d.canonicalize().ok()?;
        stacks.iter().find(|s| {
            s.working_dir
                .as_deref()
                .and_then(|w| Path::new(w).canonicalize().ok())
                .as_deref()
                == Some(d.as_path())
        })
    };
    let shared_name = shared_name(&file, &dir);
    let shared = stacks.iter().find(|s| s.name == shared_name).map(|s| {
        let running = s.services.iter().filter(|x| x.state == ContainerState::Running).count();
        serde_json::json!({ "name": s.name, "running": running, "total": s.services.len() })
    });

    let projects: Vec<serde_json::Value> = file
        .projects
        .iter()
        .map(|(key, p)| {
            let pdir = file.project_dir(&dir, key);
            let stack = stack_in(&pdir);
            let running = stack.is_some_and(|s| s.services.iter().any(|x| x.state == ContainerState::Running));
            serde_json::json!({
                "key": key,
                "description": p.description,
                "repo": p.repo,
                "dir": pdir,
                "cloned": pdir.is_dir(),
                "set_up": ws.setup_done.contains(key),
                "stack": stack.map(|s| s.name.clone()),
                "running": running,
                "uses": p.uses,
                "setup": p.setup,
                "urls": p.routes.iter().map(&url).collect::<Vec<_>>(),
                "secrets": secrets_of(&file, key, &pdir),
                "worktrees": p.worktrees,
            })
        })
        .collect();

    Ok(Json(serde_json::json!({
        "joined": true,
        "name": file.name,
        "description": file.description,
        "repo": ws.repo,
        "path": ws.path,
        "network": file.network,
        "domain": domain,
        "certificate": if file.gateway.as_ref().is_some_and(|g| g.certificate.is_some()) { "workspace" } else { "orca" },
        "shared": shared,
        "shared_urls": file.routes.iter().map(|r| serde_json::json!({ "title": r.title.clone().unwrap_or_else(|| r.hostname.clone()), "url": url(r) })).collect::<Vec<_>>(),
        "registries": file.registries.iter().map(|h| serde_json::json!({ "host": h, "logged_in": registry_logged_in(h) })).collect::<Vec<_>>(),
        "secret_clis": crate::secrets::cli_status(),
        "providers": {
            "passbolt": file.secrets.passbolt.as_ref().map(|p| p.url.clone()),
            "1password": file.secrets.onepassword.is_some(),
        },
        "projects": projects,
    })))
}

#[derive(Deserialize, Default)]
struct SetupBody {
    /// Run the setup command again even if it ran before.
    #[serde(default)]
    rerun_setup: bool,
}

/// POST /workspace/projects/{key}/setup: clone, `.env`, secrets, setup
/// command, shared services, start. Stops before starting when secrets are
/// still missing, and says which.
async fn setup(
    State(state): State<Arc<AppState>>,
    UrlPath(key): UrlPath<String>,
    body: Option<Json<SetupBody>>,
) -> Result<impl IntoResponse, ApiError> {
    let (_, file, dir) = current(&state).await?;
    let Some(project) = file.projects.get(&key).cloned() else {
        return Err(ApiError::bad_request(format!("The workspace has no project '{key}'")));
    };
    let rerun = body.map(|b| b.rerun_setup).unwrap_or(false);
    let pdir = file.project_dir(&dir, &key);
    let job = JobHandle::create(
        "workspace",
        Some(&key),
        "setup",
        &[
            ("clone", "Clone the repository"),
            ("env", "Create the .env file"),
            ("secrets", "Fill in secrets"),
            ("setup", "Run the setup command"),
            ("shared", "Start the shared services it uses"),
            ("start", "Start the project"),
        ],
    )
    .await;
    let j = job.clone();
    tokio::spawn(async move {
        let r: Result<serde_json::Value> = async {
            j.start("clone").await;
            if pdir.is_dir() {
                j.done("clone", Some(format!("Already in {}", pdir.display()))).await;
            } else {
                if let Some(parent) = pdir.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                let mut cmd = git();
                cmd.arg("clone");
                if let Some(b) = &project.branch {
                    cmd.args(["--branch", b]);
                }
                cmd.arg("--").arg(&project.repo).arg(&pdir);
                run_logged(&j, cmd, &format!("git clone {} {}", project.repo, pdir.display())).await?;
                j.done("clone", Some(pdir.display().to_string())).await;
            }

            j.start("env").await;
            let mut missing: Vec<String> = Vec::new();
            match &project.env {
                Some(env) => {
                    let target = pdir.join(env.file());
                    if !target.exists() {
                        let text = match &env.from {
                            Some(from) => std::fs::read_to_string(pdir.join(from))
                                .with_context(|| format!("{from} doesn't exist"))?,
                            None => String::new(),
                        };
                        std::fs::write(&target, text)?;
                        j.done(
                            "env",
                            Some(format!(
                                "Created {} from {}",
                                env.file(),
                                env.from.as_deref().unwrap_or("nothing")
                            )),
                        )
                        .await;
                    } else {
                        j.done("env", Some(format!("{} already exists", env.file()))).await;
                    }
                    if !git_ignored(&pdir, env.file()).await {
                        j.log(format!(
                            "Warning: {} isn't in .gitignore; don't commit it, it will hold secrets.",
                            env.file()
                        ))
                        .await;
                    }

                    j.start("secrets").await;
                    let (filled, failed) = fill_secrets(&file, &key, &pdir).await?;
                    for (name, why) in &failed {
                        j.log(format!("{name}: {why}")).await;
                    }
                    missing = secrets_of(&file, &key, &pdir)
                        .into_iter()
                        .filter(|s| !s.filled)
                        .map(|s| s.name)
                        .collect();
                    if missing.is_empty() {
                        j.done(
                            "secrets",
                            Some(if filled.is_empty() {
                                "All filled in".into()
                            } else {
                                format!("Filled in {}", filled.join(", "))
                            }),
                        )
                        .await;
                    } else {
                        j.skip("secrets", &format!("Fill in by hand: {}", missing.join(", ")))
                            .await;
                    }
                }
                None => {
                    j.skip("env", "None in the workspace file").await;
                    j.skip("secrets", "None needed").await;
                }
            }
            if !missing.is_empty() {
                for step in ["setup", "shared", "start"] {
                    j.skip(step, "Waiting for the missing secrets").await;
                }
                return Ok(serde_json::json!({ "missing_secrets": missing }));
            }

            j.start("setup").await;
            let done_before = state
                .config
                .lock()
                .await
                .workspace
                .as_ref()
                .is_some_and(|w| w.setup_done.contains(&key));
            match &project.setup {
                Some(cmd) if !done_before || rerun => {
                    run_logged(&j, shell(cmd, &pdir), cmd).await?;
                    let mut cfg = state.config.lock().await;
                    if let Some(ws) = cfg.workspace.as_mut()
                        && !ws.setup_done.contains(&key)
                    {
                        ws.setup_done.push(key.clone());
                    }
                    cfg.save()?;
                    j.done("setup", None).await;
                }
                Some(_) => j.skip("setup", "Ran before").await,
                None => j.skip("setup", "None in the workspace file").await,
            }

            j.start("shared").await;
            match (&file.shared, project.uses.is_empty()) {
                (Some(shared), false) => {
                    let compose = dir.join(&shared.compose);
                    let mut args: Vec<String> = vec![
                        "-p".into(),
                        shared_name(&file, &dir),
                        "-f".into(),
                        compose.to_string_lossy().to_string(),
                        "up".into(),
                        "-d".into(),
                    ];
                    args.extend(project.uses.iter().cloned());
                    let r = crate::dev::ops::compose(&state, &dir, &args, Some(&j)).await?;
                    if !r.success {
                        anyhow::bail!("starting {} failed:\n{}", project.uses.join(", "), r.stderr_tail);
                    }
                    j.done("shared", Some(project.uses.join(", "))).await;
                }
                _ => j.skip("shared", "Uses none").await,
            }

            j.start("start").await;
            let stack = crate::api::deploy_folder(&state, &pdir).await?;
            if project.worktrees {
                let _ = crate::agent::api(
                    &state,
                    "POST",
                    "/dev/projects",
                    Some(serde_json::json!({ "path": pdir })),
                )
                .await;
            }
            j.done("start", Some(stack.clone())).await;
            let domain = state.config.lock().await.gateway.domain.clone();
            let urls: Vec<String> = project
                .routes
                .iter()
                .map(|r| {
                    format!(
                        "https://{}{}",
                        crate::project_config::qualify_hostname(&r.hostname, &domain),
                        r.path.as_deref().unwrap_or("")
                    )
                })
                .collect();
            Ok(serde_json::json!({ "stack": stack, "urls": urls, "dir": pdir }))
        }
        .await;
        match r {
            Ok(v) => j.succeed(Some(v)).await,
            Err(e) => j.fail(&e).await,
        }
    });
    Ok(accepted(job).await)
}

async fn git_ignored(dir: &Path, file: &str) -> bool {
    let mut cmd = git();
    cmd.arg("-C").arg(dir).args(["check-ignore", "-q", "--", file]);
    cmd.status().await.map(|s| s.success()).unwrap_or(false)
}

/// Fetch every unfilled secret whose provider's CLI is here; write them to
/// the project's `.env`. Returns (filled, [(name, why not)]).
async fn fill_secrets(file: &WorkspaceFile, key: &str, pdir: &Path) -> Result<(Vec<String>, Vec<(String, String)>)> {
    let Some(env) = file.projects.get(key).and_then(|p| p.env.as_ref()) else {
        return Ok((Vec::new(), Vec::new()));
    };
    let clis = crate::secrets::cli_status();
    let mut values = BTreeMap::new();
    let mut failed = Vec::new();
    for s in secrets_of(file, key, pdir).into_iter().filter(|s| !s.filled) {
        let Ok(r) = SecretRef::parse(&s.reference) else {
            continue;
        };
        let ready = match r {
            SecretRef::Passbolt(_) => clis.passbolt,
            SecretRef::OnePassword(_) => clis.onepassword,
        };
        if !ready {
            continue;
        }
        match crate::secrets::fetch(&r, &file.secrets).await {
            Ok(v) if !v.is_empty() => {
                values.insert(s.name.clone(), v);
            }
            Ok(_) => failed.push((s.name.clone(), "empty in the secret manager".into())),
            Err(e) => failed.push((s.name.clone(), e.to_string())),
        }
    }
    if !values.is_empty() {
        write_env(&pdir.join(env.file()), &values)?;
    }
    Ok((values.into_keys().collect(), failed))
}

fn write_env(path: &Path, values: &BTreeMap<String, String>) -> Result<()> {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let new = schema::set_env_values(&text, values);
    let tmp = path.with_extension("orca-tmp");
    {
        use std::io::Write;
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        opts.open(&tmp)?.write_all(new.as_bytes())?;
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[derive(Deserialize)]
struct EnvBody {
    values: BTreeMap<String, String>,
}

/// PUT /workspace/projects/{key}/env: fill in secrets by hand. Only the
/// variables the workspace lists as secrets can be set this way.
async fn set_env(
    State(state): State<Arc<AppState>>,
    UrlPath(key): UrlPath<String>,
    Json(body): Json<EnvBody>,
) -> Result<impl IntoResponse, ApiError> {
    let (_, file, dir) = current(&state).await?;
    let env = file
        .projects
        .get(&key)
        .and_then(|p| p.env.clone())
        .ok_or_else(|| ApiError::bad_request(format!("'{key}' has no env in the workspace file")))?;
    if let Some(bad) = body.values.keys().find(|k| !env.secrets.contains_key(*k)) {
        return Err(ApiError::bad_request(format!("{bad} isn't one of {key}'s secrets")));
    }
    let values: BTreeMap<String, String> = body.values.into_iter().filter(|(_, v)| !v.is_empty()).collect();
    if values.values().any(|v| v.contains('\n')) {
        return Err(ApiError::bad_request("A value can't span several lines"));
    }
    let pdir = file.project_dir(&dir, &key);
    if !pdir.is_dir() {
        return Err(ApiError::bad_request(format!("'{key}' isn't cloned yet")));
    }
    write_env(&pdir.join(env.file()), &values).map_err(|e| anyhow::anyhow!("Could not write {}: {e}", env.file()))?;
    Ok(Json(serde_json::json!({ "secrets": secrets_of(&file, &key, &pdir) })))
}

/// POST /workspace/projects/{key}/secrets: fill in what the secret
/// managers' CLIs on this machine can fetch.
async fn fetch_secrets(
    State(state): State<Arc<AppState>>,
    UrlPath(key): UrlPath<String>,
) -> Result<impl IntoResponse, ApiError> {
    let (_, file, dir) = current(&state).await?;
    let pdir = file.project_dir(&dir, &key);
    let (filled, failed) = fill_secrets(&file, &key, &pdir).await?;
    Ok(Json(serde_json::json!({
        "filled": filled,
        "failed": failed.into_iter().map(|(n, e)| serde_json::json!({ "name": n, "error": e })).collect::<Vec<_>>(),
        "secrets": secrets_of(&file, &key, &pdir),
    })))
}

#[derive(Deserialize)]
struct ImportBody {
    text: String,
    #[serde(default)]
    domain: Option<String>,
}

/// POST /workspace/import-haproxy: routes for the workspace file from an
/// HAProxy config (devproxy's), as YAML to paste.
async fn import_haproxy(Json(body): Json<ImportBody>) -> Result<impl IntoResponse, ApiError> {
    let import = schema::routes_from_haproxy(&body.text, body.domain.as_deref());
    let mut yaml = serde_yaml::to_string(&serde_json::json!({ "routes": import.routes })).unwrap_or_default();
    if !import.skipped.is_empty() {
        yaml.push_str("\n# Not imported: these rules need a look by hand (WebSocket special cases,\n# hostname patterns, several conditions).\n");
        for line in &import.skipped {
            yaml.push_str(&format!("#   {line}\n"));
        }
    }
    Ok(Json(
        serde_json::json!({ "routes": import.routes, "skipped": import.skipped, "yaml": yaml }),
    ))
}

/// At startup: bring a joined workspace up to date (fast-forward only, never
/// touching local changes) and refresh its routes.
pub fn spawn(state: Arc<AppState>) {
    tokio::spawn(async move {
        let Some(ws) = state.config.lock().await.workspace.clone() else {
            return;
        };
        let dir = PathBuf::from(&ws.path);
        let mut cmd = git();
        cmd.arg("-C").arg(&dir).args(["pull", "--ff-only", "--quiet"]);
        if let Ok(out) = cmd.output().await
            && !out.status.success()
        {
            tracing::info!(
                "workspace: git pull skipped: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            );
        }
        match WorkspaceFile::load(&dir) {
            Ok(file) => {
                if let Err(e) = sync_routes(&state, &file).await {
                    tracing::warn!("workspace: routes not updated: {e}");
                }
            }
            Err(e) => tracing::warn!("workspace: {e}"),
        }
    });
}

#[cfg(test)]
mod tests {
    #[test]
    fn clone_folder_from_repo_url() {
        let d = super::default_clone_dir("git@git.example.com:devops/dev-workspace.git");
        assert!(d.ends_with("code/dev-workspace"));
        assert!(super::default_clone_dir("https://git.example.com/a/b/").ends_with("code/b"));
    }
}
