use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::Router;
use axum::middleware;
use clap::Parser;
use tokio::sync::broadcast;
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

mod agent;
mod api;
mod build_manager;
mod gateway;
mod state;

use state::AppState;

#[derive(Parser)]
#[command(name = "orca-daemon", about = "Orca container management daemon")]
struct Args {
    /// Listen on a Unix socket instead of TCP.
    /// Pass "auto" to use the default path ($XDG_RUNTIME_DIR/orca-daemon.sock).
    #[arg(long, value_name = "PATH")]
    socket: Option<String>,

    /// TCP port to listen on (default: 9477, ignored if --socket is set).
    #[arg(long, default_value = "9477")]
    port: u16,

    /// Bind address for TCP mode.
    #[arg(long, default_value = "127.0.0.1")]
    bind: String,
}

fn default_socket_path() -> PathBuf {
    let runtime_dir = std::env::var("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/tmp"));
    runtime_dir.join("orca-daemon.sock")
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_ansi(false) // No ANSI colors — output goes to a log file
        .with_env_filter(
            EnvFilter::from_default_env()
                .add_directive("orca_daemon=debug".parse()?)
                .add_directive("orca_backend_common=debug".parse()?)
                .add_directive("orca_core=debug".parse()?),
        )
        .init();

    // Install the rustls `ring` crypto provider process-wide. rustls 0.23
    // does not pick a default provider on its own — every TLS connection
    // would otherwise panic the worker thread with
    //   "Could not automatically determine the process-level CryptoProvider"
    // the first time it tries to handshake (e.g. when the kube client
    // connects to the K8s API server). `install_default` is idempotent
    // when called from one place at startup, and returns Err if something
    // else already installed a provider — which we tolerate.
    let _ = rustls::crypto::ring::default_provider().install_default();

    let args = Args::parse();
    let mut config = orca_core::config::OrcaConfig::load()?;

    // Generate or load API token (mandatory)
    let token = config.ensure_token()?.to_string();
    let config_path = orca_core::config::OrcaConfig::config_path();
    tracing::info!("API token stored in {}", config_path.display());
    let api_token = token;

    // Warn if binding to a non-loopback address
    if args.bind != "127.0.0.1" && args.bind != "localhost" {
        tracing::warn!(
            "WARNING: Daemon binding to {} — the API will be network-accessible!",
            args.bind
        );
    }

    // Try to connect to container runtime, but don't fail if unavailable.
    // The daemon must start even without Docker/Podman so the GUI can
    // show the Environment page and help the user install prerequisites.
    let runtime = connect_runtime().await;

    // Start the Docker event listener. The inner broadcast::Receiver is
    // bound to whichever BollardRuntime we subscribed to. When
    // `reconnect_runtime` hot-swaps the runtime via `swap_runtime`, the
    // old inner channel closes — we must re-subscribe against the *new*
    // runtime to keep events flowing. The outer `loop` does exactly that.
    let (events_tx, _) = broadcast::channel(256);
    let k8s = Arc::new(orca_backend_common::k8s::K3sManager::from_env());
    let state = Arc::new(AppState::new(config, runtime, k8s, events_tx.clone(), api_token));

    {
        let state_for_events = state.clone();
        let events_tx_clone = events_tx.clone();
        tokio::spawn(async move {
            loop {
                let mut events_rx = state_for_events.rt().await.subscribe_events();
                // Wait for either an event on the current subscription or a
                // hot-swap notification. `Notify::notified` must be created
                // *before* we start waiting so we don't miss a swap that
                // happens between subscribe and the first `.notified().await`.
                let swap_notify = state_for_events.swap_notify.clone();
                loop {
                    let notified = swap_notify.notified();
                    tokio::select! {
                        event = events_rx.recv() => match event {
                            Ok(event) => { let _ = events_tx_clone.send(event); }
                            Err(_) => break,
                        },
                        _ = notified => break,
                    }
                }
                // Either the inner receiver closed or a swap was signalled.
                // Loop back and re-subscribe against the (possibly new)
                // runtime. No polling sleep needed.
            }
        });
    }

    // Start the scheduled actions runner (checks every 60 seconds)
    let scheduler_state = state.clone();
    tokio::spawn(async move {
        run_scheduler(scheduler_state).await;
    });

    let app = Router::new()
        .nest("/api/v1", api::routes())
        .layer(TraceLayer::new_for_http())
        .with_state(state.clone())
        .layer(middleware::from_fn_with_state(state, api::auth_middleware));

    #[cfg(unix)]
    if let Some(socket_arg) = args.socket {
        // Unix socket mode (Linux/macOS only)
        let socket_path = if socket_arg == "auto" {
            default_socket_path()
        } else {
            PathBuf::from(socket_arg)
        };

        if socket_path.exists() {
            std::fs::remove_file(&socket_path)?;
        }

        tracing::info!("Orca daemon listening on unix:{}", socket_path.display());

        let listener = tokio::net::UnixListener::bind(&socket_path)?;

        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o660))?;
        }

        axum::serve(listener, app).await?;

        let _ = std::fs::remove_file(&socket_path);
        return Ok(());
    }

    // TCP mode (default, works on all platforms)
    let addr: SocketAddr = format!("{}:{}", args.bind, args.port).parse()?;
    tracing::info!("Orca daemon listening on {addr}");
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            // Check if another daemon is already running
            let client = reqwest::Client::new();
            if let Ok(resp) = client
                .get(format!("http://{addr}/api/v1/health"))
                .timeout(std::time::Duration::from_secs(2))
                .send()
                .await
                && resp.status().is_success()
            {
                tracing::info!("Another Orca daemon is already running on {addr}");
                return Ok(());
            }
            anyhow::bail!(
                "Port {addr} is already in use by another process. \
                 Try a different port with --port or stop the other process."
            );
        }
        Err(e) => return Err(e.into()),
    };
    axum::serve(listener, app).await?;

    Ok(())
}

/// Connect to the container runtime, trying platform-appropriate methods.
async fn connect_runtime() -> Arc<orca_backend_common::BollardRuntime> {
    tracing::info!("Searching for container runtime...");

    // Log what socket paths we'll check
    let home = std::env::var("HOME").unwrap_or_default();
    if let Ok(host) = std::env::var("DOCKER_HOST") {
        tracing::info!("DOCKER_HOST is set: {host}");
    } else {
        tracing::info!("DOCKER_HOST is not set");
    }

    // Log Docker context
    let extended_path = format!(
        "/opt/homebrew/bin:/usr/local/bin:/opt/homebrew/sbin:/usr/local/sbin:{}",
        std::env::var("PATH").unwrap_or_default()
    );
    if let Ok(output) = std::process::Command::new("docker")
        .env("PATH", &extended_path)
        .args([
            "context",
            "inspect",
            "--format",
            "{{.Name}} -> {{.Endpoints.docker.Host}}",
        ])
        .output()
    {
        if output.status.success() {
            let ctx = String::from_utf8_lossy(&output.stdout).trim().to_string();
            tracing::info!("Docker context: {ctx}");
        } else {
            tracing::debug!("Docker context not available");
        }
    }

    // Log candidate socket paths
    let socket_candidates = vec![
        "/var/run/docker.sock".to_string(),
        format!("{home}/.docker/run/docker.sock"),
        format!("{home}/.docker/desktop/docker.sock"),
        format!("{home}/Library/Containers/com.docker.docker/Data/docker.raw.sock"),
        format!("{home}/.lima/orca/sock/docker.sock"),
        format!("{home}/.lima/docker/sock/docker.sock"),
        format!("{home}/.lima/default/sock/docker.sock"),
        format!("{home}/.lima/colima/sock/docker.sock"),
        format!("{home}/.colima/default/docker.sock"),
        format!("{home}/.colima/docker/docker.sock"),
    ];
    for path in &socket_candidates {
        let exists = std::path::Path::new(path).exists();
        tracing::info!("Socket {path}: {}", if exists { "exists" } else { "not found" });
    }

    // 1. Try native socket connection (Linux, macOS, or Docker Desktop on Windows)
    match orca_backend_native::NativeBackend::connect().await {
        Ok(native) => {
            let socket_path = native.socket_path.display().to_string();
            // On macOS the "native" socket is usually the Lima-forwarded
            // docker.sock, so this path connects to an already-running Lima VM
            // without going through connect_via_lima — where the
            // IPv4-forwarding self-heal lives. Run it here too, or a VM that is
            // simply up (the common case) never gets healed: only freshly
            // created or recovered VMs would.
            #[cfg(target_os = "macos")]
            {
                if let Some(vm) = lima_vm_from_socket(&socket_path) {
                    ensure_ip_forward(&vm).await;
                }
            }
            let rt = Arc::new(native.runtime);
            let kind = rt.detect_runtime().await;
            tracing::info!("Connected to {kind:?} runtime via socket: {socket_path}");
            return rt;
        }
        Err(e) => {
            tracing::warn!("Native socket connection failed: {e}");
        }
    }

    // 2. On macOS, try starting the Lima VM if it exists
    #[cfg(target_os = "macos")]
    {
        if let Some(rt) = connect_via_lima().await {
            return rt;
        }
    }

    // 3. On Windows, try connecting via TCP to Docker in WSL2
    #[cfg(target_os = "windows")]
    {
        // Try named pipe (Docker Desktop)
        if let Ok(docker) = bollard::Docker::connect_with_named_pipe_defaults() {
            if docker.ping().await.is_ok() {
                tracing::info!("Connected to Docker via Windows named pipe");
                return Arc::new(orca_backend_common::BollardRuntime::new(docker));
            }
        }

        // Try TCP on localhost:2375 (Docker in WSL2 with TCP listener)
        if let Ok(docker) =
            bollard::Docker::connect_with_http("http://localhost:2375", 120, bollard::API_DEFAULT_VERSION)
        {
            if docker.ping().await.is_ok() {
                tracing::info!("Connected to Docker via TCP (localhost:2375)");
                return Arc::new(orca_backend_common::BollardRuntime::new(docker));
            }
        }
    }

    // On Windows, try to start Docker inside WSL2 before giving up
    #[cfg(target_os = "windows")]
    {
        tracing::info!("Attempting to start Docker in WSL2...");
        // Configure TCP listener and start Docker service inside WSL
        let _ = tokio::process::Command::new("wsl")
            .args(["-u", "root", "--", "bash", "-c",
                "mkdir -p /etc/systemd/system/docker.service.d && \
                 echo -e '[Service]\\nExecStart=\\nExecStart=/usr/bin/dockerd -H fd:// -H tcp://127.0.0.1:2375 --containerd=/run/containerd/containerd.sock' > /etc/systemd/system/docker.service.d/override.conf && \
                 systemctl daemon-reload 2>/dev/null; \
                 service docker start"
            ])
            .output()
            .await;

        // Wait for Docker to start with TCP listener — retry every 2s for up to 15s
        for attempt in 1..=7 {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            tracing::info!("WSL2 Docker connection attempt {attempt}/7...");

            // Try TCP
            if let Ok(docker) =
                bollard::Docker::connect_with_http("http://localhost:2375", 120, bollard::API_DEFAULT_VERSION)
            {
                if docker.ping().await.is_ok() {
                    tracing::info!(
                        "Connected to Docker via TCP after starting WSL2 Docker service (attempt {attempt})"
                    );
                    return Arc::new(orca_backend_common::BollardRuntime::new(docker));
                }
            }

            // Try socket via WSL interop
            if let Ok(docker) = bollard::Docker::connect_with_local_defaults() {
                if docker.ping().await.is_ok() {
                    tracing::info!(
                        "Connected to Docker via socket after starting WSL2 Docker service (attempt {attempt})"
                    );
                    return Arc::new(orca_backend_common::BollardRuntime::new(docker));
                }
            }
        }

        tracing::warn!("Docker in WSL2 could not be started automatically after 7 attempts");
    }

    tracing::warn!("No container runtime available");
    tracing::warn!("Daemon will start without runtime — Environment page will guide setup");

    // Create a fallback connection that will error on use
    Arc::new(orca_backend_common::BollardRuntime::new(
        bollard::Docker::connect_with_local_defaults().unwrap_or_else(|_| {
            bollard::Docker::connect_with_defaults().unwrap_or_else(|_| {
                bollard::Docker::connect_with_http_defaults().expect("failed to create fallback Docker client")
            })
        }),
    ))
}

/// Common PATH extension for invoking Lima — Homebrew prefixes are not on
/// the default `launchd` PATH that Tauri inherits.
#[cfg(target_os = "macos")]
fn lima_path_env() -> String {
    format!(
        "/opt/homebrew/bin:/usr/local/bin:{}",
        std::env::var("PATH").unwrap_or_default()
    )
}

/// Find Orca's Lima VM and the status `limactl list` reports for it.
/// Returns (name, status) where status is one of "Running", "Stopped", "Broken",
/// or another Lima-defined string. Prefers "orca", then "docker" as fallback.
#[cfg(target_os = "macos")]
async fn find_lima_vm() -> Option<(&'static str, String)> {
    use tokio::process::Command;
    let out = Command::new("limactl")
        .env("PATH", lima_path_env())
        .args(["list", "--format", "{{.Name}}\t{{.Status}}"])
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut orca = None;
    let mut docker = None;
    for line in text.lines() {
        let mut it = line.split('\t');
        let name = it.next().unwrap_or("").trim();
        let status = it.next().unwrap_or("").trim().to_string();
        match name {
            "orca" => orca = Some(("orca", status)),
            "docker" => docker = Some(("docker", status)),
            _ => {}
        }
    }
    orca.or(docker)
}

/// Attempt to start the Lima VM. Captures stderr and returns it on failure
/// so callers can log the actual reason (stale pid file, disk lock,
/// "Broken" state, etc.) instead of a silent timeout.
#[cfg(target_os = "macos")]
async fn lima_start(name: &str) -> Result<(), String> {
    use tokio::process::Command;
    let out = Command::new("limactl")
        .env("PATH", lima_path_env())
        .args(["start", name])
        .output()
        .await
        .map_err(|e| format!("spawn failed: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        Err(if stderr.is_empty() { stdout } else { stderr })
    }
}

/// Force-stop the Lima VM and remove leftover unix sockets so a subsequent
/// `limactl start` can recover from a half-dead state. Lima itself usually
/// clears stale PID files, but the forwarded docker.sock and ha.sock files
/// are unix sockets created by the host agent — if the agent was killed by
/// a host reboot, they can persist with no listener and confuse Bollard.
#[cfg(target_os = "macos")]
async fn lima_force_recover(name: &str) {
    use tokio::process::Command;
    tracing::warn!("Lima VM '{name}': attempting force-stop recovery");
    match Command::new("limactl")
        .env("PATH", lima_path_env())
        .args(["stop", "--force", name])
        .output()
        .await
    {
        Ok(o) if o.status.success() => tracing::info!("Lima VM '{name}': force-stop succeeded"),
        Ok(o) => tracing::warn!(
            "Lima VM '{name}': force-stop returned {}: {}",
            o.status,
            String::from_utf8_lossy(&o.stderr).trim()
        ),
        Err(e) => tracing::warn!("Lima VM '{name}': force-stop spawn failed: {e}"),
    }

    let home = std::env::var("HOME").unwrap_or_default();
    // Unix socket files created by the host agent. Files in `~/.lima/<name>/`
    // such as `ha.pid`, `qemu.pid`, `lima.yaml`, `serial0.log`, `diffdisk`
    // are NOT touched — Lima manages those, and deleting the disk image
    // would lose the user's containers.
    for stale in &[
        format!("{home}/.lima/{name}/sock/docker.sock"),
        format!("{home}/.lima/{name}/ha.sock"),
    ] {
        if std::path::Path::new(stale).exists() {
            match std::fs::remove_file(stale) {
                Ok(_) => tracing::info!("Removed stale socket: {stale}"),
                Err(e) => tracing::debug!("Could not remove {stale}: {e}"),
            }
        }
    }
}

/// Deep clean: remove every ephemeral state file Lima writes during boot
/// (PID files, all sockets under `sock/`, log files). Preserves
/// `lima.yaml`, `diffdisk`, `basedisk`, `cidata.iso`, ssh keys — anything
/// that holds user data or VM identity. Used when tier-2 force-recover
/// wasn't enough.
#[cfg(target_os = "macos")]
fn lima_deep_clean(name: &str) {
    let home = std::env::var("HOME").unwrap_or_default();
    let dir = format!("{home}/.lima/{name}");

    // Remove the entire forwarded-socket directory — Lima recreates it on
    // start. Anything in there is host-managed runtime state.
    let sock_dir = format!("{dir}/sock");
    if std::path::Path::new(&sock_dir).exists() {
        match std::fs::remove_dir_all(&sock_dir) {
            Ok(_) => tracing::info!("Lima VM '{name}': removed stale sock/ directory"),
            Err(e) => tracing::debug!("Could not remove {sock_dir}: {e}"),
        }
    }

    // Individual ephemeral files. These are all re-created by lima on
    // boot — none of them hold user data. We deliberately do NOT touch
    // `lima.yaml`, `*disk*`, `cidata.iso`, or anything under `_config/`.
    let ephemerals = [
        "ha.pid",
        "qemu.pid",
        "ha.sock",
        "ha.stdout.log",
        "ha.stderr.log",
        "serial0.log",
        "serial0.sock",
        "serialv.log",
        "serialv.sock",
        "serialp.log",
        "serialp.sock",
        "vz-identifier",
    ];
    for name in &ephemerals {
        let p = format!("{dir}/{name}");
        if std::path::Path::new(&p).exists() {
            match std::fs::remove_file(&p) {
                Ok(_) => tracing::info!("Lima VM '{}': removed stale {name}", name),
                Err(e) => tracing::debug!("Could not remove {p}: {e}"),
            }
        }
    }
}

/// Poll for the Lima Docker socket and return a Bollard client once a
/// real `ping` succeeds. File existence alone is not enough — after a
/// host reboot the socket inode often lingers without a listener.
#[cfg(target_os = "macos")]
async fn wait_for_lima_docker(name: &str, attempts: u32) -> Option<bollard::Docker> {
    let home = std::env::var("HOME").unwrap_or_default();
    let socket = format!("{home}/.lima/{name}/sock/docker.sock");
    for attempt in 1..=attempts {
        if std::path::Path::new(&socket).exists()
            && let Ok(docker) = bollard::Docker::connect_with_socket(&socket, 120, bollard::API_DEFAULT_VERSION)
            && docker.ping().await.is_ok()
        {
            tracing::info!("Connected to Docker via Lima VM '{name}' (attempt {attempt}/{attempts})");
            return Some(docker);
        }
        if attempt < attempts {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    }
    None
}

/// Ensure IPv4 forwarding is enabled inside an already-running Lima VM.
///
/// dockerd enables this at daemon start, but our provisioning installs the
/// HWE kernel (which forces a reboot) and the auto-recovery paths below can
/// restart the VM into a kernel where `net.ipv4.ip_forward` reset to its
/// default of 0 before dockerd reapplied it. That breaks container
/// networking with "IPv4 forwarding is disabled. Networking will not work."
///
/// Newly created VMs get the same drop-in via the Lima provision script, so
/// this only matters for VMs created before that fix shipped. It's cheap and
/// idempotent, so we run it unconditionally once the VM is up. Best-effort:
/// a failure here is logged, not fatal — networking may already be fine.
#[cfg(target_os = "macos")]
async fn ensure_ip_forward(name: &str) {
    use tokio::process::Command;
    // Persist via a drop-in (survives reboot) and apply immediately (-w).
    let script = "echo 'net.ipv4.ip_forward=1' > /etc/sysctl.d/99-orca-forward.conf \
                  && sysctl -w net.ipv4.ip_forward=1";
    match Command::new("limactl")
        .env("PATH", lima_path_env())
        // No `--workdir`: matches the established `limactl shell <vm> sudo
        // sh -c …` pattern used elsewhere (k8s.rs, environment.rs). Lima is
        // brew-installed and unpinned, so we avoid depending on any flag that
        // a given Homebrew `lima` version might not have.
        .args(["shell", name, "sudo", "sh", "-c", script])
        .output()
        .await
    {
        Ok(o) if o.status.success() => {
            tracing::debug!("Lima VM '{name}': IPv4 forwarding ensured");
        }
        Ok(o) => tracing::warn!(
            "Lima VM '{name}': enabling IPv4 forwarding returned {}: {}",
            o.status,
            String::from_utf8_lossy(&o.stderr).trim()
        ),
        Err(e) => {
            tracing::warn!("Lima VM '{name}': enabling IPv4 forwarding failed to spawn: {e}")
        }
    }
}

/// Extract a Lima VM name from a forwarded docker socket path of the form
/// `~/.lima/<vm>/sock/docker.sock`. Returns `None` for non-Lima sockets
/// (Docker Desktop, Colima, …) so callers only self-heal actual Lima VMs.
#[cfg(target_os = "macos")]
fn lima_vm_from_socket(socket_path: &str) -> Option<String> {
    let after = socket_path.split("/.lima/").nth(1)?;
    let vm = after.split('/').next()?;
    (!vm.is_empty()).then(|| vm.to_string())
}

/// Apply VM-up side effects (currently: ensure IPv4 forwarding) and wrap the
/// Docker handle in a runtime. Funnels every success path in
/// `connect_via_lima` so the self-heal can't be forgotten on a new branch.
#[cfg(target_os = "macos")]
async fn finalize_lima_runtime(name: &str, docker: bollard::Docker) -> Arc<orca_backend_common::BollardRuntime> {
    ensure_ip_forward(name).await;
    Arc::new(orca_backend_common::BollardRuntime::new(docker))
}

/// Bring up Lima and return a working runtime. Handles the
/// post-host-reboot case: capture limactl errors, force-recover on
/// failure, then retry once.
#[cfg(target_os = "macos")]
async fn connect_via_lima() -> Option<Arc<orca_backend_common::BollardRuntime>> {
    let (name, status) = find_lima_vm().await?;
    tracing::info!("Found Lima VM '{name}' (status: {status})");

    let is_running = status == "Running";
    let was_reconfigured = reconcile_lima_config(name, is_running).await;

    // If the VM is already Running and we made no changes, just wait for
    // the socket — no need to invoke `limactl start`.
    if is_running && !was_reconfigured {
        if let Some(docker) = wait_for_lima_docker(name, 15).await {
            return Some(finalize_lima_runtime(name, docker).await);
        }
        // Running but socket isn't responsive — fall through to recovery.
        tracing::warn!("Lima VM '{name}' reports Running but Docker socket is unresponsive");
    } else {
        tracing::info!("Starting Lima VM '{name}'...");
    }

    match lima_start(name).await {
        Ok(()) => {
            if let Some(docker) = wait_for_lima_docker(name, 15).await {
                return Some(finalize_lima_runtime(name, docker).await);
            }
            tracing::warn!("Lima VM '{name}': start succeeded but Docker socket never became responsive");
        }
        Err(e) => {
            tracing::error!("Lima VM '{name}': start failed: {e}");
        }
    }

    // Tier 2: force-stop, remove the forwarded docker.sock + ha.sock,
    // retry. Handles the common "have to `lima delete orca` after boot"
    // symptom — usually a stale ha.pid + stale forwarded docker.sock.
    lima_force_recover(name).await;
    match lima_start(name).await {
        Ok(()) => {
            if let Some(docker) = wait_for_lima_docker(name, 15).await {
                tracing::info!("Lima VM '{name}': recovered after force-stop");
                return Some(finalize_lima_runtime(name, docker).await);
            }
            tracing::warn!("Lima VM '{name}': tier-2 start succeeded but socket still down");
        }
        Err(e) => {
            tracing::warn!("Lima VM '{name}': tier-2 start failed: {e}");
        }
    }

    // Tier 3: deep clean — remove every ephemeral state file Lima writes
    // on boot (PID files, sockets, serial logs). Preserves the disk image
    // and lima.yaml, so user data is safe. This is non-destructive but
    // gets us out of states where leftover artifacts from a hard host
    // shutdown confuse Lima into a "Broken" status.
    tracing::warn!("Lima VM '{name}': tier-2 recovery exhausted, deep-cleaning state files");
    lima_force_recover(name).await;
    lima_deep_clean(name);
    match lima_start(name).await {
        Ok(()) => {
            if let Some(docker) = wait_for_lima_docker(name, 15).await {
                tracing::info!("Lima VM '{name}': recovered after deep clean");
                return Some(finalize_lima_runtime(name, docker).await);
            }
            tracing::error!(
                "Lima VM '{name}': deep-clean start succeeded but Docker socket never came up. \
                 The disk image may be corrupt — use the Environment page's repair action."
            );
        }
        Err(e) => {
            tracing::error!(
                "Lima VM '{name}': deep-clean start failed: {e}. \
                 Open the Environment page and click the 'Repair Lima VM' fix."
            );
        }
    }
    None
}

/// Reconcile Lima VM config: ensure port forwarding, mounts, etc. match desired state.
/// Reads ~/.lima/<name>/lima.yaml, checks for required settings, applies fixes via `limactl edit --set`.
/// If the VM is running and changes are needed, it will be stopped and edited.
/// Returns true if changes were applied (caller should restart the VM).
#[cfg(target_os = "macos")]
async fn reconcile_lima_config(vm_name: &str, is_running: bool) -> bool {
    use tokio::process::Command;

    let home = std::env::var("HOME").unwrap_or_default();
    let lima_yaml_path = format!("{home}/.lima/{vm_name}/lima.yaml");
    let path_env = format!(
        "/opt/homebrew/bin:/usr/local/bin:{}",
        std::env::var("PATH").unwrap_or_default()
    );

    let yaml_content = match tokio::fs::read_to_string(&lima_yaml_path).await {
        Ok(c) => c,
        Err(e) => {
            tracing::debug!("Cannot read Lima config at {lima_yaml_path}: {e}");
            return false;
        }
    };

    // Define desired config patches and how to detect them.
    // Each entry: (description, check_fn, set_expression)
    let patches: Vec<(&str, bool, &str)> = vec![
        (
            "port forwarding (0.0.0.0 → host)",
            // Check: must have guestIP 0.0.0.0 with guestIPMustBeZero: true and NO ignore: true
            yaml_content.contains("guestIP: \"0.0.0.0\"")
                && yaml_content.contains("guestIPMustBeZero: true")
                && !yaml_content.contains("ignore: true"),
            r#".portForwards += [{"guestIP": "0.0.0.0", "guestIPMustBeZero": true, "guestPortRange": [1, 65535], "hostIP": "127.0.0.1", "proto": "tcp"}]"#,
        ),
        (
            "/Volumes mount",
            yaml_content.contains("/Volumes"),
            r#".mounts += [{"location": "/Volumes", "writable": true}]"#,
        ),
        (
            "/private mount",
            yaml_content.contains("/private"),
            r#".mounts += [{"location": "/private", "writable": true}]"#,
        ),
        (
            "HWE kernel provision script",
            yaml_content.contains("linux-generic-hwe"),
            r##".provision += [{"mode": "system", "script": "#!/bin/bash\nset -eu\nif ! dpkg -l linux-generic-hwe-24.04 2>/dev/null | grep -q ^ii; then\n  apt-get update -qq && apt-get install -y -qq linux-generic-hwe-24.04\nfi\n"}]"##,
        ),
    ];

    // Also check if we need to remove the broken `ignore: true` rule
    let has_ignore_rule = yaml_content.contains("ignore: true");

    let mut needed: Vec<(&str, &str)> = Vec::new();
    for (desc, present, set_expr) in &patches {
        if !present {
            needed.push((desc, set_expr));
        }
    }

    if needed.is_empty() && !has_ignore_rule {
        tracing::debug!("Lima VM '{vm_name}' config is up to date");
        return false;
    }

    tracing::info!("Lima VM '{vm_name}' config needs updates:");
    for (desc, _) in &needed {
        tracing::info!("  - Missing: {desc}");
    }
    if has_ignore_rule {
        tracing::info!("  - Removing broken 'ignore: true' port forwarding rule");
    }

    // If running, stop first — limactl edit requires a stopped VM. Try a
    // graceful stop, but fall back to --force if the VM is wedged: a
    // half-stopped VM still has a lima.yaml lock and the subsequent
    // `limactl edit` would fail too.
    if is_running {
        tracing::info!("Stopping Lima VM '{vm_name}' to apply config updates...");
        let stop_ok = matches!(
            Command::new("limactl")
                .env("PATH", &path_env)
                .args(["stop", vm_name])
                .output()
                .await,
            Ok(o) if o.status.success()
        );
        if !stop_ok {
            tracing::warn!("Lima VM '{vm_name}': graceful stop failed, forcing");
            let _ = Command::new("limactl")
                .env("PATH", &path_env)
                .args(["stop", "--force", vm_name])
                .output()
                .await;
        }
    }

    // Remove the broken ignore rule if present
    if has_ignore_rule {
        // Filter out the portForward entry that has ignore: true
        let _ = Command::new("limactl")
            .env("PATH", &path_env)
            .args([
                "edit",
                vm_name,
                "--set",
                r#".portForwards = [.portForwards[] | select(.ignore != true)]"#,
            ])
            .output()
            .await;
        tracing::info!("Removed 'ignore: true' port forwarding rule");
    }

    // Apply each missing patch
    for (desc, set_expr) in &needed {
        let output = Command::new("limactl")
            .env("PATH", &path_env)
            .args(["edit", vm_name, "--set", set_expr])
            .output()
            .await;
        match output {
            Ok(o) if o.status.success() => {
                tracing::info!("Applied: {desc}");
            }
            Ok(o) => {
                let stderr = String::from_utf8_lossy(&o.stderr);
                tracing::warn!("Failed to apply {desc}: {stderr}");
            }
            Err(e) => {
                tracing::warn!("Failed to run limactl edit for {desc}: {e}");
            }
        }
    }

    // The VM will be started by the caller (the existing start logic)
    tracing::info!("Lima VM '{vm_name}' config updated — VM will be started next");
    true
}

/// Background scheduler that runs scheduled container actions.
/// Checks every 60 seconds if any schedule is due.
async fn run_scheduler(state: Arc<state::AppState>) {
    use cron::Schedule;
    use std::str::FromStr;

    tracing::info!("Scheduler started");

    // Track schedules whose build tasks are still running so we don't spawn
    // a second build for the same schedule while the first is in-flight.
    // Without this guard, a build taking longer than the 60-second poll
    // interval would pile up on each tick.
    let in_flight_builds: Arc<tokio::sync::Mutex<std::collections::HashSet<String>>> =
        Arc::new(tokio::sync::Mutex::new(std::collections::HashSet::new()));

    loop {
        tokio::time::sleep(std::time::Duration::from_secs(60)).await;

        // Snapshot schedules from the in-memory config so we don't stall
        // a tokio worker on disk I/O and so we see the same view of
        // schedules other handlers are mutating through `state.config`.
        let schedules = state.config.lock().await.schedules.clone();

        let now = chrono::Utc::now();

        for schedule in &schedules {
            if !schedule.enabled {
                continue;
            }

            let cron_schedule = match Schedule::from_str(&schedule.cron) {
                Ok(s) => s,
                Err(e) => {
                    tracing::warn!(
                        "Invalid cron expression '{}' for schedule '{}': {e}",
                        schedule.cron,
                        schedule.name
                    );
                    continue;
                }
            };

            // Check if the schedule should have fired in the last 60 seconds
            let last_run = schedule
                .last_run
                .map(|ts| chrono::DateTime::<chrono::Utc>::from_timestamp(ts as i64, 0).unwrap_or_default());

            let should_run = cron_schedule
                .after(&(now - chrono::Duration::seconds(61)))
                .take(1)
                .any(|next| next <= now && last_run.map(|lr| next > lr).unwrap_or(true));

            if !should_run {
                continue;
            }

            tracing::info!(
                "Scheduler: executing '{}' — {:?} on '{}'",
                schedule.name,
                schedule.action,
                schedule.container
            );

            if schedule.action == orca_core::config::ScheduledActionKind::Build {
                // Skip if a previous build for this schedule is still
                // running. This is cheap — we re-check on every tick.
                {
                    let in_flight = in_flight_builds.lock().await;
                    if in_flight.contains(&schedule.id) {
                        tracing::info!("Scheduler: skipping '{}' — previous build still running", schedule.name);
                        continue;
                    }
                }
                // Handle build action: trigger a build target from orca.yaml
                if let Some(ref target_name) = schedule.build_target {
                    tracing::info!(
                        "Scheduler: triggering build target '{target_name}' for '{}'",
                        schedule.name
                    );
                    // Scan stack directories for build targets. Both the
                    // directory listing and the per-file reads are
                    // synchronous stdlib calls, so do them off the tokio
                    // worker pool to avoid stalling unrelated tasks.
                    let target_name_owned = target_name.clone();
                    let found: Option<(String, String, String, std::collections::HashMap<String, String>)> =
                        tokio::task::spawn_blocking(move || {
                            let base = dirs::config_dir()
                                .unwrap_or_else(|| std::path::PathBuf::from("."))
                                .join("orca")
                                .join("stacks");
                            let mut found = None;
                            if let Ok(entries) = std::fs::read_dir(&base) {
                                for entry in entries.flatten() {
                                    let path = entry.path();
                                    if path.is_dir() {
                                        let yaml_path = path.join("orca.yaml");
                                        if yaml_path.exists()
                                            && let Ok(content) = std::fs::read_to_string(&yaml_path)
                                            && let Ok(yaml) = serde_yaml::from_str::<serde_yaml::Value>(&content)
                                            && let Some(builds) = yaml.get("builds").and_then(|v| v.as_sequence())
                                        {
                                            for item in builds {
                                                if item.get("name").and_then(|v| v.as_str())
                                                    == Some(target_name_owned.as_str())
                                                {
                                                    let ctx =
                                                        item.get("context").and_then(|v| v.as_str()).unwrap_or(".");
                                                    let tag = item.get("tag").and_then(|v| v.as_str()).unwrap_or("");
                                                    let dockerfile = item
                                                        .get("dockerfile")
                                                        .and_then(|v| v.as_str())
                                                        .unwrap_or("Dockerfile");
                                                    let mut args = std::collections::HashMap::new();
                                                    if let Some(args_map) =
                                                        item.get("args").and_then(|v| v.as_mapping())
                                                    {
                                                        for (k, v) in args_map {
                                                            if let (Some(key), Some(val)) = (k.as_str(), v.as_str()) {
                                                                args.insert(key.to_string(), val.to_string());
                                                            }
                                                        }
                                                    }
                                                    let context_path = if ctx.starts_with('/') {
                                                        std::path::PathBuf::from(ctx)
                                                    } else {
                                                        path.join(ctx)
                                                    };
                                                    found = Some((
                                                        context_path.to_string_lossy().to_string(),
                                                        tag.to_string(),
                                                        dockerfile.to_string(),
                                                        args,
                                                    ));
                                                    break;
                                                }
                                            }
                                        }
                                        if found.is_some() {
                                            break;
                                        }
                                    }
                                }
                            }
                            found
                        })
                        .await
                        .unwrap_or(None);
                    if let Some((context_path, tag, dockerfile, args)) = found {
                        let record = crate::build_manager::start_build(
                            &tag,
                            &context_path,
                            &dockerfile,
                            args,
                            orca_core::build::BuildSource::Scheduled,
                        )
                        .await;
                        let build_id = record.id.clone();
                        let rt = state.rt().await;
                        let events_tx = state.events_tx.clone();
                        // Mark this schedule as in-flight BEFORE spawning so
                        // the next scheduler tick sees it immediately.
                        in_flight_builds.lock().await.insert(schedule.id.clone());
                        let schedule_id = schedule.id.clone();
                        let in_flight_clone = in_flight_builds.clone();
                        tokio::spawn(async move {
                            use orca_core::image::ImageManager;
                            match ImageManager::build(
                                rt.as_ref(),
                                &context_path,
                                Some(dockerfile.as_str()),
                                Some(tag.as_str()),
                                Some(std::collections::HashMap::new()),
                            )
                            .await
                            {
                                Ok(mut rx) => {
                                    let mut had_error = false;
                                    let mut error_msg: Option<String> = None;
                                    let mut image_id: Option<String> = None;
                                    while let Some(progress) = rx.recv().await {
                                        let line = progress.stream.trim_end();
                                        if !line.is_empty() {
                                            crate::build_manager::append_log(&build_id, line);
                                        }
                                        if let Some(ref err) = progress.error {
                                            had_error = true;
                                            error_msg = Some(err.clone());
                                        }
                                        if let Some(id) = progress.stream.trim().strip_prefix("Successfully built ") {
                                            image_id = Some(id.trim().to_string());
                                        }
                                    }
                                    let status = if had_error {
                                        orca_core::build::BuildStatus::Failed
                                    } else {
                                        orca_core::build::BuildStatus::Success
                                    };
                                    crate::build_manager::update_build(&build_id, status.clone(), image_id, error_msg)
                                        .await;
                                    let _ = events_tx.send(orca_core::event::Event {
                                        timestamp: chrono::Utc::now().to_rfc3339(),
                                        kind: orca_core::event::EventKind::BuildCompleted {
                                            id: build_id,
                                            tag,
                                            success: status == orca_core::build::BuildStatus::Success,
                                        },
                                    });
                                }
                                Err(e) => {
                                    crate::build_manager::update_build(
                                        &build_id,
                                        orca_core::build::BuildStatus::Failed,
                                        None,
                                        Some(e.to_string()),
                                    )
                                    .await;
                                    let _ = events_tx.send(orca_core::event::Event {
                                        timestamp: chrono::Utc::now().to_rfc3339(),
                                        kind: orca_core::event::EventKind::BuildCompleted {
                                            id: build_id,
                                            tag,
                                            success: false,
                                        },
                                    });
                                }
                            }
                            // Always clear the in-flight marker so the next
                            // scheduler tick will spawn another build.
                            in_flight_clone.lock().await.remove(&schedule_id);
                        });
                        tracing::info!("Scheduler: build '{}' started", schedule.name);
                    } else {
                        tracing::warn!("Scheduler: build target '{target_name}' not found in any orca.yaml");
                    }
                } else {
                    tracing::warn!("Scheduler: build action without build_target in '{}'", schedule.name);
                }
            } else {
                use orca_core::config::ScheduledActionKind;
                use orca_core::runtime::ContainerRuntime;
                let rt = state.rt().await;
                let result = match schedule.action {
                    ScheduledActionKind::Start => rt.as_ref().start_container(&schedule.container).await,
                    ScheduledActionKind::Stop => rt.as_ref().stop_container(&schedule.container, 10).await,
                    ScheduledActionKind::Restart => {
                        let _ = rt.as_ref().stop_container(&schedule.container, 10).await;
                        rt.as_ref().start_container(&schedule.container).await
                    }
                    ScheduledActionKind::Build => {
                        // Handled in the `if schedule.action == Build` branch above.
                        tracing::warn!("Scheduler: unexpected Build reached action dispatch");
                        continue;
                    }
                    ScheduledActionKind::Unknown => {
                        tracing::warn!("Unknown schedule action in '{}'", schedule.name);
                        continue;
                    }
                };

                match result {
                    Ok(_) => tracing::info!("Scheduler: '{}' completed successfully", schedule.name),
                    Err(e) => tracing::error!("Scheduler: '{}' failed: {e}", schedule.name),
                }
            }

            // Update last_run timestamp through the shared config lock so
            // we don't race with handlers that are mutating other fields.
            {
                let mut cfg = state.config.lock().await;
                if let Some(s) = cfg.schedules.iter_mut().find(|s| s.id == schedule.id) {
                    s.last_run = Some(now.timestamp() as u64);
                }
                if let Err(e) = cfg.save() {
                    tracing::error!("Scheduler: failed to save last_run for '{}': {e}", schedule.name);
                }
            }
        }
    }
}
