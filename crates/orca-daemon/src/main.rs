use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::Router;
use axum::middleware;
use clap::Parser;
use tokio::sync::broadcast;
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

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
        .with_env_filter(EnvFilter::from_default_env().add_directive("orca=debug".parse()?))
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

    let native = orca_backend_native::NativeBackend::connect()?;
    let runtime = Arc::new(native.runtime);
    let runtime_kind = runtime.detect_runtime().await;
    tracing::info!("Connected to {runtime_kind:?} runtime");

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
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
