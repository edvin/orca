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
        .with_env_filter(EnvFilter::from_default_env()
            .add_directive("orca_daemon=debug".parse()?)
            .add_directive("orca_backend_common=debug".parse()?)
            .add_directive("orca_core=debug".parse()?)
        )
        .init();

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

    // Start the Docker event listener
    let (events_tx, _) = broadcast::channel(256);
    let mut events_rx = runtime.subscribe_events();
    let events_tx_clone = events_tx.clone();
    tokio::spawn(async move {
        while let Ok(event) = events_rx.recv().await {
            let _ = events_tx_clone.send(event);
        }
    });

    let k8s = Arc::new(orca_backend_common::k8s::K3sManager::from_env());
    let state = Arc::new(AppState::new(config, runtime, k8s, events_tx, api_token));

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
            {
                if resp.status().is_success() {
                    tracing::info!("Another Orca daemon is already running on {addr}");
                    return Ok(());
                }
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
    // 1. Try native socket connection (Linux, macOS, or Docker Desktop on Windows)
    match orca_backend_native::NativeBackend::connect() {
        Ok(native) => {
            let rt = Arc::new(native.runtime);
            let kind = rt.detect_runtime().await;
            tracing::info!("Connected to {kind:?} runtime via socket");
            return rt;
        }
        Err(e) => {
            tracing::debug!("Native socket connection failed: {e}");
        }
    }

    // 2. On macOS, try starting the Lima VM if it exists
    #[cfg(target_os = "macos")]
    {
        use tokio::process::Command;
        // Check if a Lima VM exists (orca or docker)
        if let Ok(output) = Command::new("limactl")
            .env("PATH", format!("/opt/homebrew/bin:/usr/local/bin:{}", std::env::var("PATH").unwrap_or_default()))
            .args(["list", "--format", "{{.Name}} {{.Status}}"])
            .output().await
        {
            let text = String::from_utf8_lossy(&output.stdout);
            let vm_name = if text.lines().any(|l| l.starts_with("orca ")) { Some("orca") }
                else if text.lines().any(|l| l.starts_with("docker ")) { Some("docker") }
                else { None };

            if let Some(name) = vm_name {
                let is_running = text.lines().any(|l| l.starts_with(name) && l.contains("Running"));
                if !is_running {
                    tracing::info!("Starting Lima VM '{name}'...");
                    let _ = Command::new("limactl")
                        .env("PATH", format!("/opt/homebrew/bin:/usr/local/bin:{}", std::env::var("PATH").unwrap_or_default()))
                        .args(["start", name])
                        .output().await;
                }

                // Wait for Docker socket to appear
                let home = std::env::var("HOME").unwrap_or_default();
                let socket = format!("{home}/.lima/{name}/sock/docker.sock");
                for attempt in 1..=15 {
                    if std::path::Path::new(&socket).exists() {
                        tracing::info!("Lima socket ready: {socket}");
                        if let Ok(docker) = bollard::Docker::connect_with_socket(&socket, 120, bollard::API_DEFAULT_VERSION) {
                            if docker.ping().await.is_ok() {
                                tracing::info!("Connected to Docker via Lima VM '{name}' (attempt {attempt})");
                                return Arc::new(orca_backend_common::BollardRuntime::new(docker));
                            }
                        }
                    }
                    if attempt <= 14 {
                        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    }
                }
                tracing::warn!("Lima VM '{name}' exists but Docker socket not available after 30s");
            }
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
        if let Ok(docker) = bollard::Docker::connect_with_http(
            "http://localhost:2375", 120, bollard::API_DEFAULT_VERSION
        ) {
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
                 echo -e '[Service]\\nExecStart=\\nExecStart=/usr/bin/dockerd -H fd:// -H tcp://0.0.0.0:2375 --containerd=/run/containerd/containerd.sock' > /etc/systemd/system/docker.service.d/override.conf && \
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
            if let Ok(docker) = bollard::Docker::connect_with_http(
                "http://localhost:2375", 120, bollard::API_DEFAULT_VERSION
            ) {
                if docker.ping().await.is_ok() {
                    tracing::info!("Connected to Docker via TCP after starting WSL2 Docker service (attempt {attempt})");
                    return Arc::new(orca_backend_common::BollardRuntime::new(docker));
                }
            }

            // Try socket via WSL interop
            if let Ok(docker) = bollard::Docker::connect_with_local_defaults() {
                if docker.ping().await.is_ok() {
                    tracing::info!("Connected to Docker via socket after starting WSL2 Docker service (attempt {attempt})");
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
        bollard::Docker::connect_with_local_defaults()
            .unwrap_or_else(|_| bollard::Docker::connect_with_defaults().unwrap_or_else(|_| {
                bollard::Docker::connect_with_http_defaults()
                    .expect("failed to create fallback Docker client")
            }))
    ))
}
