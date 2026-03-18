use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use tracing_subscriber::EnvFilter;

mod api;
mod state;

use state::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("vessel=debug".parse()?))
        .init();

    let config = vessel_core::config::VesselConfig::load()?;

    let backend = Arc::new(vessel_backend_native::NativeBackend::connect()?);
    let runtime_kind = backend.detect_runtime().await;
    tracing::info!("Connected to {runtime_kind:?} runtime");

    let state = Arc::new(AppState::new(config, backend));

    let app = Router::new()
        .nest("/api/v1", api::routes())
        .with_state(state);

    // TODO: On production, listen on a Unix socket instead of TCP.
    // TCP is convenient for development.
    let addr = SocketAddr::from(([127, 0, 0, 1], 9477));
    tracing::info!("Vessel daemon listening on {addr}");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
