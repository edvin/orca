//! The Docker engine Orca uses, never Docker Desktop's:
//!
//! - **macOS**: Orca's own Lima VM, or another engine picked in Settings
//!   (OrbStack, Colima, …).
//! - **Windows**: Orca's own WSL distro, `orca` (see
//!   `orca_backend_common::wsl`).
//! - **Linux**: the system's Docker or Podman, or another socket picked in
//!   Settings.
//!
//! Docker Desktop's engine is Docker Desktop's to run, and Orca's VM settings,
//! networking fixes and Kubernetes only reach Orca's own. What is in Docker
//! Desktop can be brought over once (see `desktop`).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use orca_core::config::EngineChoice;
use serde::Serialize;

use crate::api::ApiError;
use crate::state::AppState;

/// What Docker Desktop's engine calls its operating system.
const DESKTOP_OS: &str = "Docker Desktop";

fn home() -> String {
    dirs::home_dir().map(|h| h.to_string_lossy().to_string()).unwrap_or_default()
}

/// Where an engine is reached.
#[derive(Debug, Clone, PartialEq)]
pub enum Endpoint {
    /// A unix socket.
    Unix(String),
    /// A Windows named pipe (`//./pipe/…`).
    Pipe(String),
    /// Plain TCP (`tcp://127.0.0.1:2375`): Docker that an earlier Orca set
    /// up in the user's own WSL distro.
    Tcp(String),
    /// Orca's engine on Windows: mutual TLS on 127.0.0.1:2376.
    OrcaWsl,
}

impl Endpoint {
    /// From `DOCKER_HOST`-style text: `unix://…`, `npipe://…`, `tcp://…`, or
    /// a bare socket path.
    pub fn parse(s: &str) -> Option<Self> {
        let s = s.trim();
        if let Some(p) = s.strip_prefix("unix://") {
            Some(Self::Unix(p.to_string()))
        } else if let Some(p) = s.strip_prefix("npipe://") {
            Some(Self::Pipe(p.replace('\\', "/")))
        } else if s.starts_with("tcp://") {
            Some(Self::Tcp(s.to_string()))
        } else if s.starts_with('/') {
            Some(Self::Unix(s.to_string()))
        } else {
            None
        }
    }

    /// How it reads in a log.
    pub fn shown(&self) -> String {
        match self {
            Self::Unix(p) | Self::Pipe(p) => p.clone(),
            Self::Tcp(a) => a.clone(),
            Self::OrcaWsl => orca_backend_common::wsl::address(),
        }
    }

    /// The `DOCKER_HOST` child CLIs get.
    fn host(&self) -> String {
        match self {
            Self::Unix(p) => format!("unix://{p}"),
            Self::Pipe(p) => format!("npipe://{p}"),
            Self::Tcp(a) => a.clone(),
            Self::OrcaWsl => orca_backend_common::wsl::address(),
        }
    }

    /// A client, waiting up to `timeout` seconds per request.
    pub fn client(&self, timeout: u64) -> anyhow::Result<bollard::Docker> {
        let v = bollard::API_DEFAULT_VERSION;
        Ok(match self {
            Self::Unix(p) => {
                #[cfg(unix)]
                {
                    bollard::Docker::connect_with_socket(p, timeout, v)?
                }
                #[cfg(not(unix))]
                {
                    anyhow::bail!("no unix sockets here: {p}")
                }
            }
            Self::Pipe(p) => {
                #[cfg(windows)]
                {
                    bollard::Docker::connect_with_named_pipe(p, timeout, v)?
                }
                #[cfg(not(windows))]
                {
                    anyhow::bail!("no named pipes here: {p}")
                }
            }
            Self::Tcp(a) => bollard::Docker::connect_with_http(a, timeout, v)?,
            Self::OrcaWsl => {
                #[cfg(windows)]
                {
                    orca_backend_common::wsl::client(timeout)?
                }
                #[cfg(not(windows))]
                {
                    anyhow::bail!("Orca's WSL engine is on Windows only")
                }
            }
        })
    }

    /// A client if an engine answers here.
    pub async fn ping(&self) -> Option<bollard::Docker> {
        if let Self::Unix(p) = self
            && !Path::new(p).exists()
        {
            return None;
        }
        let docker = self.client(120).ok()?;
        match tokio::time::timeout(Duration::from_secs(3), docker.ping()).await {
            Ok(Ok(_)) => Some(docker),
            _ => None,
        }
    }

    /// A runtime on `docker`, which child CLIs reach here too.
    pub fn runtime(&self, docker: bollard::Docker) -> Arc<orca_backend_common::BollardRuntime> {
        Arc::new(orca_backend_common::BollardRuntime::new(docker).with_host(self.host()))
    }
}

/// Orca's own VM's socket (macOS).
pub fn orca_socket() -> String {
    format!("{}/.lima/orca/sock/docker.sock", home())
}

/// Docker Desktop's engine, newest location first. `ORCA_DOCKER_DESKTOP_SOCKET`
/// stands another engine in for Docker Desktop, to try the move without it.
pub fn desktop_endpoints() -> Vec<Endpoint> {
    if let Ok(p) = std::env::var("ORCA_DOCKER_DESKTOP_SOCKET")
        && let Some(e) = Endpoint::parse(&p)
    {
        return vec![e];
    }
    let h = home();
    if cfg!(windows) {
        vec![
            Endpoint::Pipe("//./pipe/dockerDesktopLinuxEngine".into()),
            Endpoint::Pipe("//./pipe/docker_engine".into()),
        ]
    } else if cfg!(target_os = "macos") {
        vec![
            Endpoint::Unix(format!("{h}/.docker/run/docker.sock")),
            Endpoint::Unix(format!("{h}/.docker/desktop/docker.sock")),
            Endpoint::Unix(format!("{h}/Library/Containers/com.docker.docker/Data/docker.raw.sock")),
        ]
    } else {
        vec![Endpoint::Unix(format!("{h}/.docker/desktop/docker.sock"))]
    }
}

/// Whether `path` is Docker Desktop's socket or pipe, following links:
/// `/var/run/docker.sock` points at whichever engine set it up last.
pub fn is_desktop_socket(path: &str) -> bool {
    let path = path
        .strip_prefix("unix://")
        .or_else(|| path.strip_prefix("npipe://"))
        .unwrap_or(path);
    let real = std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path));
    let real = real.to_string_lossy().replace('\\', "/");
    let lower = real.to_ascii_lowercase();
    desktop_endpoints().iter().any(|e| match e {
        Endpoint::Unix(d) | Endpoint::Pipe(d) => {
            let d_real = std::fs::canonicalize(d).unwrap_or_else(|_| PathBuf::from(d));
            Path::new(path) == Path::new(d) || real == d_real.to_string_lossy().replace('\\', "/")
        }
        _ => false,
    }) || real.contains("/.docker/run/")
        || real.contains("/.docker/desktop/")
        || real.contains("/com.docker.docker/")
        || lower.ends_with("/pipe/docker_engine")
        || lower.ends_with("/pipe/dockerdesktoplinuxengine")
}

/// Whether a connected engine is Docker Desktop's, by its own account.
pub async fn is_desktop(docker: &bollard::Docker) -> bool {
    match tokio::time::timeout(Duration::from_secs(5), docker.info()).await {
        Ok(Ok(info)) => {
            info.operating_system.as_deref() == Some(DESKTOP_OS) || info.name.as_deref() == Some("docker-desktop")
        }
        _ => false,
    }
}

/// A client for the unix socket at `path` if an engine answers there.
pub async fn ping(path: &str) -> Option<bollard::Docker> {
    Endpoint::Unix(path.strip_prefix("unix://").unwrap_or(path).to_string())
        .ping()
        .await
}

/// Engines other than Orca's and Docker Desktop's that Orca knows where to
/// find, for Settings (and, on Linux, the order it tries them in).
pub fn known_engines() -> Vec<(&'static str, String)> {
    let h = home();
    if cfg!(target_os = "macos") {
        vec![
            ("OrbStack", format!("{h}/.orbstack/run/docker.sock")),
            ("Colima", format!("{h}/.colima/default/docker.sock")),
            ("Colima (docker)", format!("{h}/.colima/docker/docker.sock")),
            ("Rancher Desktop", format!("{h}/.rd/docker.sock")),
            ("Podman", format!("{h}/.local/share/containers/podman/machine/podman.sock")),
            ("Lima (default)", format!("{h}/.lima/default/sock/docker.sock")),
            ("Lima (colima)", format!("{h}/.lima/colima/sock/docker.sock")),
            ("Docker socket", "/var/run/docker.sock".to_string()),
        ]
    } else if cfg!(target_os = "linux") {
        let uid = {
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                std::fs::metadata("/proc/self").map(|m| m.uid()).unwrap_or(0)
            }
            #[cfg(not(unix))]
            {
                0
            }
        };
        let run = std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| format!("/run/user/{uid}"));
        vec![
            ("Docker", "/var/run/docker.sock".to_string()),
            ("Docker (rootless)", format!("{run}/docker.sock")),
            ("Podman", format!("{run}/podman/podman.sock")),
            ("Podman (root)", "/run/podman/podman.sock".to_string()),
        ]
    } else {
        Vec::new()
    }
}

/// The name a socket's engine goes by, for people to read.
pub fn engine_name(path: &str) -> String {
    let path = path.strip_prefix("unix://").unwrap_or(path);
    if path == orca_backend_common::wsl::address() || (cfg!(target_os = "macos") && path == orca_socket()) {
        return "Orca".into();
    }
    if path.ends_with("/.lima/docker/sock/docker.sock") {
        return "Orca".into();
    }
    if let Some(after) = path.split("/.lima/").nth(1)
        && let Some(vm) = after.split('/').next()
        && !["default", "colima"].contains(&vm)
    {
        return format!("Lima VM {vm}");
    }
    if is_desktop_socket(path) {
        return DESKTOP_OS.into();
    }
    known_engines()
        .into_iter()
        .find(|(_, p)| p == path)
        .map(|(n, _)| n.to_string())
        .unwrap_or_else(|| path.to_string())
}

/// The engine the CLI's current `docker context` points at, when it's a socket.
#[cfg(not(windows))]
fn context_socket() -> Option<String> {
    let out = std::process::Command::new("docker")
        .env("PATH", crate::dev::ops::cli_path())
        .args(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let host = String::from_utf8_lossy(&out.stdout).trim().to_string();
    host.strip_prefix("unix://").map(str::to_string)
}

/// An engine at `e`, if it answers and isn't Docker Desktop's.
async fn usable(e: &Endpoint, name: &str, log: &mut Vec<String>) -> Option<bollard::Docker> {
    if let Endpoint::Unix(p) | Endpoint::Pipe(p) = e
        && is_desktop_socket(p)
    {
        log.push(format!("{name} ({}) is Docker Desktop's engine, which Orca doesn't use", e.shown()));
        return None;
    }
    let Some(docker) = e.ping().await else {
        log.push(format!("{name} ({}) isn't answering", e.shown()));
        return None;
    };
    if is_desktop(&docker).await {
        log.push(format!("{name} ({}) is Docker Desktop's engine, which Orca doesn't use", e.shown()));
        return None;
    }
    log.push(format!("{name} ({}) answers", e.shown()));
    Some(docker)
}

/// Connect to the engine Orca uses, deciding it on the first start:
///
/// 1. `DOCKER_HOST` in the daemon's own environment, to run a daemon against
///    a chosen engine (as the demo recordings do).
/// 2. The engine picked in Settings (macOS and Linux), with no falling back
///    to another: one that isn't answering is reported as such.
/// 3. Orca's own engine: the Lima VM on macOS, the `orca` distro on
///    Windows, the system's Docker or Podman on Linux.
///
/// Docker Desktop's engine is never connected to.
pub async fn connect(
    choice: &mut Option<EngineChoice>,
    log: &mut Vec<String>,
) -> Option<(Arc<orca_backend_common::BollardRuntime>, String)> {
    // Not on Windows: there `docker` runs in Orca's distro, which never
    // sees the daemon's DOCKER_HOST, so the two would disagree.
    if !cfg!(windows)
        && let Ok(host) = std::env::var("DOCKER_HOST")
        && let Some(e) = Endpoint::parse(&host)
        && let Some(docker) = usable(&e, "DOCKER_HOST", log).await
    {
        #[cfg(target_os = "macos")]
        if let Endpoint::Unix(p) = &e {
            heal_if_orca_vm(p);
        }
        return Some((e.runtime(docker), format!("DOCKER_HOST ({})", e.shown())));
    }

    #[cfg(target_os = "macos")]
    if choice.is_none() {
        // Undecided stays undecided when nothing answers yet (OrbStack still
        // starting at login): the next start decides again.
        *choice = decide(log).await;
    }
    if let Some(EngineChoice::Socket { path, name }) = choice.clone() {
        if cfg!(windows) {
            log.push("Orca runs its own engine on Windows; ignoring the socket picked before".into());
        } else {
            let name = name.unwrap_or_else(|| engine_name(&path));
            let e = Endpoint::Unix(path.clone());
            return match usable(&e, &name, log).await {
                Some(docker) => Some((e.runtime(docker), format!("{name} ({path})"))),
                None => {
                    log.push(format!("Start {name}, or switch to Orca's engine in Settings."));
                    None
                }
            };
        }
    }
    own_engine(log).await
}

/// Orca's own engine: its Lima VM.
#[cfg(target_os = "macos")]
async fn own_engine(log: &mut Vec<String>) -> Option<(Arc<orca_backend_common::BollardRuntime>, String)> {
    log.push("Using Orca's engine (its Lima VM)".into());
    let rt = crate::connect_via_lima().await?;
    Some((rt, format!("Orca's VM ({})", orca_socket())))
}

/// Orca's own engine: its `orca` WSL distro. Briefly: the daemon must
/// answer the app within seconds, and a cold WSL can take longer; it keeps
/// trying in the background (see `main`).
#[cfg(windows)]
async fn own_engine(log: &mut Vec<String>) -> Option<(Arc<orca_backend_common::BollardRuntime>, String)> {
    use orca_backend_common::wsl;
    if !wsl::exists().await {
        log.push(format!(
            "Orca's engine isn't set up yet: System Health sets up its WSL distro, {}",
            wsl::DISTRO
        ));
        return None;
    }
    log.push(format!("Starting Orca's engine (WSL distro {})", wsl::DISTRO));
    let Some(docker) = wsl::connect(6).await else {
        log.push(format!(
            "Orca's engine isn't answering on {} yet. If it stays that way, repair it on System Health \
             (another program using port {} also stops it).",
            wsl::address(),
            wsl::PORT
        ));
        return None;
    };
    if let Some(ip) = wsl::windows_ip().await {
        crate::gateway::set_windows_host_ip(Some(ip));
    }
    log.push(format!("Orca's engine answers on {}", wsl::address()));
    Some((
        Endpoint::OrcaWsl.runtime(docker),
        format!("Orca's WSL distro ({})", wsl::address()),
    ))
}

/// The system's own engine (Linux): the CLI's context, then the usual
/// sockets, Docker Desktop's left out.
#[cfg(not(any(target_os = "macos", windows)))]
async fn own_engine(log: &mut Vec<String>) -> Option<(Arc<orca_backend_common::BollardRuntime>, String)> {
    let mut candidates: Vec<(String, String)> = context_socket()
        .into_iter()
        .map(|p| ("The docker context".to_string(), p))
        .collect();
    candidates.extend(known_engines().into_iter().map(|(n, p)| (n.to_string(), p)));
    for (name, path) in candidates {
        if !Path::new(&path).exists() {
            continue;
        }
        let e = Endpoint::Unix(path.clone());
        if let Some(docker) = usable(&e, &name, log).await {
            return Some((e.runtime(docker), format!("{name} ({path})")));
        }
    }
    None
}

/// The engine for a Mac Orca hasn't decided for yet (Orca before 0.66
/// picked whatever answered first): an existing Orca VM, else the engine that
/// would have been picked, unless that was Docker Desktop's.
#[cfg(target_os = "macos")]
async fn decide(log: &mut Vec<String>) -> Option<EngineChoice> {
    if crate::find_lima_vm().await.is_some() {
        log.push("Orca's VM exists: using it".into());
        return Some(EngineChoice::Orca);
    }
    let mut paths: Vec<String> = context_socket().into_iter().collect();
    paths.extend(known_engines().into_iter().map(|(_, p)| p));
    for path in paths {
        if is_desktop_socket(&path) {
            continue;
        }
        if let Some(docker) = ping(&path).await
            && !is_desktop(&docker).await
        {
            let name = engine_name(&path);
            log.push(format!("Keeping the engine Orca used before: {name} ({path})"));
            return Some(EngineChoice::Socket {
                path: path.clone(),
                name: Some(name),
            });
        }
    }
    log.push("No engine answers yet: Orca's VM is set up on System Health".into());
    None
}

/// Orca's VM self-heals (IP forwarding, SME mask, static usernet) on a
/// socket that turns out to be one of Orca's Lima VMs.
#[cfg(target_os = "macos")]
fn heal_if_orca_vm(path: &str) {
    if let Some(vm) = crate::lima_vm_from_socket(path) {
        tokio::spawn(async move {
            crate::ensure_ip_forward(&vm).await;
            crate::ensure_sme_masked(&vm).await;
            crate::ensure_static_usernet(&vm).await;
        });
    }
}

/// Whether the engine Orca would use answers, without connecting to it or
/// starting it: for System Health while the daemon's connection is down.
pub async fn reachable(choice: Option<&EngineChoice>) -> bool {
    let candidates = match choice {
        Some(EngineChoice::Socket { path, .. }) if !cfg!(windows) => vec![Endpoint::Unix(path.clone())],
        _ => own_endpoints(),
    };
    for e in candidates {
        if let Some(d) = e.ping().await
            && !is_desktop(&d).await
        {
            return true;
        }
    }
    false
}

/// Where Orca's own engine answers.
fn own_endpoints() -> Vec<Endpoint> {
    if cfg!(windows) {
        vec![Endpoint::OrcaWsl]
    } else if cfg!(target_os = "macos") {
        vec![
            Endpoint::Unix(orca_socket()),
            Endpoint::Unix(format!("{}/.lima/docker/sock/docker.sock", home())),
        ]
    } else {
        known_engines().into_iter().map(|(_, p)| Endpoint::Unix(p)).collect()
    }
}

/// Connect again (System Health's "Diagnose"), saying what was tried: the
/// engine Orca uses, and Docker Desktop's set aside.
pub async fn reconnect(state: &AppState) -> serde_json::Value {
    let mut log = vec!["Checking the engine Orca uses...".to_string(), String::new()];
    let mut choice = state.config.lock().await.engine.clone();
    let before = choice.clone();
    let connected = connect(&mut choice, &mut log).await;
    if choice != before {
        let mut cfg = state.config.lock().await;
        cfg.engine = choice;
        if let Err(e) = cfg.save() {
            log.push(format!("Could not save the engine choice: {e}"));
        }
    }
    for e in desktop_endpoints() {
        if e.ping().await.is_some() {
            log.push(format!(
                "Docker Desktop is running ({}). Orca doesn't use its engine: bring what's in it over on System Health.",
                e.shown()
            ));
            break;
        }
    }
    log.push(String::new());
    match connected {
        Some((rt, method)) => {
            let version = rt.server_version().await.ok().and_then(|v| v.version);
            state.swap_runtime(rt).await;
            let shown = version.as_deref().unwrap_or("(version unknown)");
            log.push(format!("Result: Docker {shown} is reachable via {method}."));
            log.push("Connected successfully — no restart needed.".to_string());
            serde_json::json!({ "connected": true, "method": method, "version": version, "log": log })
        }
        None => {
            log.push("Result: Orca's engine isn't reachable.".to_string());
            log.push("Action: set it up or repair it on System Health.".to_string());
            serde_json::json!({ "connected": false, "method": null, "version": null, "log": log })
        }
    }
}

// --- API ---------------------------------------------------------------------

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/engine", get(status).put(choose))
        .route("/engine/integration", get(integration).put(set_integration))
        .merge(crate::desktop::routes())
}

/// Windows: where `docker` uses Orca's engine besides Orca: PowerShell,
/// and one WSL distro. With the distros there are to pick from.
async fn integration(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let set = state.config.lock().await.wsl_integration.clone();
    #[cfg(windows)]
    {
        use orca_backend_common::wsl;
        let running = wsl::running_distros().await;
        let distros: Vec<serde_json::Value> = wsl::distros()
            .await
            .into_iter()
            .filter(|d| !d.eq_ignore_ascii_case(wsl::DISTRO) && !d.starts_with("docker-desktop"))
            .map(|d| serde_json::json!({ "name": d, "running": running.contains(&d) }))
            .collect();
        Json(serde_json::json!({
            "distro": set.distro,
            "powershell": set.powershell,
            "distros": distros,
            "docker_exe": wsl::docker_exe().await,
        }))
    }
    #[cfg(not(windows))]
    Json(serde_json::json!({ "distro": set.distro, "powershell": set.powershell, "distros": [], "docker_exe": null }))
}

#[derive(serde::Deserialize)]
#[cfg_attr(not(windows), allow(dead_code))]
struct SetIntegration {
    distro: Option<String>,
    powershell: bool,
}

/// Change where `docker` uses Orca's engine. Installs what's missing (a
/// Docker CLI), so it can take a minute; the steps come back as a log.
async fn set_integration(
    State(state): State<Arc<AppState>>,
    Json(want): Json<SetIntegration>,
) -> Result<Json<serde_json::Value>, ApiError> {
    #[cfg(not(windows))]
    {
        let _ = (state, want);
        Err(ApiError::bad_request("Only on Windows: elsewhere `docker` uses Orca's engine already."))
    }
    #[cfg(windows)]
    {
        use orca_backend_common::wsl;
        let log = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let l = log.clone();
        let say = move |m: String| l.lock().unwrap().push(m);
        let have = state.config.lock().await.wsl_integration.clone();
        if let Some(d) = &want.distro
            && !wsl::valid_distro_name(d)
        {
            return Err(ApiError::bad_request("Not a WSL distro name"));
        }
        if have.distro != want.distro {
            if let Some(old) = &have.distro {
                wsl::unintegrate(old).await.map_err(|e| ApiError::bad_request(format!("{e:#}")))?;
            }
            if let Some(new) = &want.distro {
                wsl::integrate(new, &say).await.map_err(|e| ApiError::bad_request(format!("{e:#}")))?;
            }
        }
        if have.powershell != want.powershell {
            if want.powershell {
                wsl::integrate_powershell(&say)
                    .await
                    .map_err(|e| ApiError::bad_request(format!("{e:#}")))?;
            } else {
                wsl::unintegrate_powershell().await.ok();
            }
        }
        {
            let mut cfg = state.config.lock().await;
            cfg.wsl_integration = orca_core::config::WslIntegration {
                distro: want.distro.clone(),
                powershell: want.powershell,
            };
            cfg.save()?;
        }
        let log = log.lock().unwrap().clone();
        Ok(Json(serde_json::json!({ "ok": true, "log": log })))
    }
}

#[derive(Serialize)]
struct Found {
    name: String,
    path: String,
    running: bool,
}

/// The engine in use, the choice, and the other engines on this computer.
async fn status(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let choice = state.config.lock().await.engine.clone();
    let host = state.rt().await.host.clone();
    let connected = state.rt().await.docker.ping().await.is_ok();
    let mut others = Vec::new();
    for (name, path) in known_engines() {
        if !Path::new(&path).exists() || is_desktop_socket(&path) {
            continue;
        }
        let running = match ping(&path).await {
            Some(d) => !is_desktop(&d).await,
            None => false,
        };
        // A `/var/run/docker.sock` link to another engine listed here is that engine.
        if path == "/var/run/docker.sock"
            && let Ok(real) = std::fs::canonicalize(&path)
            && others.iter().any(|f: &Found| Path::new(&f.path) == real)
        {
            continue;
        }
        others.push(Found {
            name: name.to_string(),
            path,
            running,
        });
    }
    #[cfg(target_os = "macos")]
    let orca_vm = crate::find_lima_vm()
        .await
        .map(|(name, status)| serde_json::json!({"name": name, "status": status}));
    #[cfg(windows)]
    let orca_vm = orca_backend_common::wsl::exists()
        .await
        .then(|| serde_json::json!({"name": orca_backend_common::wsl::DISTRO, "status": if connected { "Running" } else { "Stopped" }}));
    #[cfg(not(any(target_os = "macos", windows)))]
    let orca_vm: Option<serde_json::Value> = None;
    Json(serde_json::json!({
        "choice": choice.unwrap_or(EngineChoice::Orca),
        "connected": connected,
        "socket": host.as_deref().map(|h| h.trim_start_matches("unix://")),
        "name": host.as_deref().map(engine_name),
        // DOCKER_HOST only counts when the daemon is connected through it.
        "from_env": !cfg!(windows)
            && std::env::var("DOCKER_HOST").ok().and_then(|h| Endpoint::parse(&h)).map(|e| e.host())
                == host.clone(),
        "orca_vm": orca_vm,
        "others": others,
        "platform": if cfg!(windows) { "windows" } else if cfg!(target_os = "macos") { "macos" } else { "linux" },
    }))
}

/// Pick the engine and connect to it now.
async fn choose(
    State(state): State<Arc<AppState>>,
    Json(mut choice): Json<EngineChoice>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if let EngineChoice::Socket { path, name } = &mut choice {
        if cfg!(windows) {
            return Err(ApiError::bad_request("On Windows Orca runs its own engine, in its WSL distro."));
        }
        let p = path.trim().trim_start_matches("unix://").to_string();
        if p.is_empty() || !p.starts_with('/') {
            return Err(ApiError::bad_request("Give the engine's socket as a full path"));
        }
        if is_desktop_socket(&p) {
            return Err(ApiError::bad_request(
                "That is Docker Desktop's engine. Orca doesn't use it; bring what's in Docker Desktop over on System Health.",
            ));
        }
        let Some(docker) = ping(&p).await else {
            return Err(ApiError::bad_request(format!("No engine answers at {p}. Start it first.")));
        };
        if is_desktop(&docker).await {
            return Err(ApiError::bad_request("That is Docker Desktop's engine, which Orca doesn't use."));
        }
        if name.is_none() {
            *name = Some(engine_name(&p));
        }
        *path = p;
    }
    let mut log = Vec::new();
    let mut decided = Some(choice.clone());
    let connected = connect(&mut decided, &mut log).await;
    {
        let mut cfg = state.config.lock().await;
        cfg.engine = Some(choice.clone());
        cfg.save()?;
    }
    let ok = connected.is_some();
    if let Some((rt, _)) = connected {
        state.swap_runtime(rt).await;
    }
    Ok(Json(serde_json::json!({ "connected": ok, "choice": choice, "log": log })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(target_os = "macos")]
    fn docker_desktop_sockets_are_recognised() {
        let h = home();
        assert!(is_desktop_socket(&format!("{h}/.docker/run/docker.sock")));
        assert!(is_desktop_socket(&format!("unix://{h}/.docker/run/docker.sock")));
        assert!(is_desktop_socket(&format!(
            "{h}/Library/Containers/com.docker.docker/Data/docker.raw.sock"
        )));
        assert!(!is_desktop_socket(&orca_socket()));
        assert!(!is_desktop_socket(&format!("{h}/.orbstack/run/docker.sock")));
        assert!(!is_desktop_socket(&format!("{h}/.colima/default/docker.sock")));
    }

    #[test]
    fn docker_desktop_pipes_and_linux_socket_are_recognised() {
        assert!(is_desktop_socket("npipe:////./pipe/docker_engine"));
        assert!(is_desktop_socket("//./pipe/dockerDesktopLinuxEngine"));
        assert!(is_desktop_socket(&format!("{}/.docker/desktop/docker.sock", home())));
        assert!(!is_desktop_socket("/var/run/docker.sock.not-a-link"));
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn engines_go_by_their_names() {
        let h = home();
        assert_eq!(engine_name(&orca_socket()), "Orca");
        assert_eq!(engine_name(&format!("{h}/.orbstack/run/docker.sock")), "OrbStack");
        assert_eq!(engine_name(&format!("{h}/.docker/run/docker.sock")), "Docker Desktop");
        assert_eq!(engine_name(&format!("{h}/.lima/orca-demo/sock/docker.sock")), "Lima VM orca-demo");
        assert_eq!(engine_name("/tmp/x.sock"), "/tmp/x.sock");
    }

    #[test]
    fn endpoints_read_docker_host() {
        assert_eq!(Endpoint::parse("unix:///x.sock"), Some(Endpoint::Unix("/x.sock".into())));
        assert_eq!(
            Endpoint::parse(r"npipe://\\.\pipe\docker_engine"),
            Some(Endpoint::Pipe("//./pipe/docker_engine".into()))
        );
        assert_eq!(
            Endpoint::parse("tcp://127.0.0.1:2375"),
            Some(Endpoint::Tcp("tcp://127.0.0.1:2375".into()))
        );
        assert_eq!(Endpoint::parse("ssh://host"), None);
        assert_eq!(engine_name("tcp://127.0.0.1:2376"), "Orca");
    }

    #[test]
    fn choices_read_and_write_as_tagged_json() {
        let c: EngineChoice = serde_json::from_str(r#"{"kind":"socket","path":"/x.sock"}"#).unwrap();
        assert_eq!(
            c,
            EngineChoice::Socket {
                path: "/x.sock".into(),
                name: None
            }
        );
        assert_eq!(serde_json::to_string(&EngineChoice::Orca).unwrap(), r#"{"kind":"orca"}"#);
    }
}
