use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{delete, get, post},
};
use serde::Serialize;

use vessel_core::image::ImageManager;
use vessel_core::machine::MachineManager;
use vessel_core::network::NetworkManager;
use vessel_core::runtime::{ContainerRuntime, ContainerStats};
use vessel_core::volume::VolumeManager;

use crate::state::AppState;

/// Simple API error that maps anyhow errors to JSON 500 responses.
struct ApiError(anyhow::Error);

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        #[derive(Serialize)]
        struct ErrorBody {
            error: String,
        }
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorBody {
                error: self.0.to_string(),
            }),
        )
            .into_response()
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(err: anyhow::Error) -> Self {
        Self(err)
    }
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/health", get(health))
        // Machines
        .route("/machines", get(list_machines))
        .route("/machines/{name}", get(inspect_machine))
        // Containers
        .route("/containers", get(list_containers))
        .route("/containers/{id}", get(inspect_container))
        .route("/containers/{id}/start", post(start_container))
        .route("/containers/{id}/stop", post(stop_container))
        .route("/containers/{id}/kill", post(kill_container))
        .route("/containers/{id}", delete(remove_container))
        .route("/containers/{id}/stats", get(container_stats))
        // Images
        .route("/images", get(list_images))
        .route("/images/{id}", get(inspect_image))
        .route("/images/{id}", delete(remove_image))
        // Volumes
        .route("/volumes", get(list_volumes))
        .route("/volumes/{name}", get(inspect_volume))
        .route("/volumes/{name}", delete(remove_volume))
        // Networks
        .route("/networks", get(list_networks))
        .route("/networks/{name}", get(inspect_network))
}

// --- Health ---

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
    version: &'static str,
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
    })
}

// --- Machines ---

async fn list_machines(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, ApiError> {
    let machines = MachineManager::list(state.backend.as_ref()).await?;
    Ok(Json(machines))
}

async fn inspect_machine(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let machine = MachineManager::inspect(state.backend.as_ref(), &name).await?;
    Ok(Json(machine))
}

// --- Containers ---

async fn list_containers(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, ApiError> {
    let containers = state.backend.list_containers(true).await?;
    Ok(Json(containers))
}

async fn inspect_container(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let container = state.backend.inspect_container(&id).await?;
    Ok(Json(container))
}

async fn start_container(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    state.backend.start_container(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn stop_container(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    state.backend.stop_container(&id, 10).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn kill_container(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    state.backend.kill_container(&id, "SIGKILL").await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn remove_container(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    state.backend.remove_container(&id, false).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn container_stats(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<ContainerStats>, ApiError> {
    let stats = state.backend.container_stats(&id).await?;
    Ok(Json(stats))
}

// --- Images ---

async fn list_images(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, ApiError> {
    let images = ImageManager::list(state.backend.as_ref()).await?;
    Ok(Json(images))
}

async fn inspect_image(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let image = ImageManager::inspect(state.backend.as_ref(), &id).await?;
    Ok(Json(image))
}

async fn remove_image(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    ImageManager::remove(state.backend.as_ref(), &id, false).await?;
    Ok(StatusCode::NO_CONTENT)
}

// --- Volumes ---

async fn list_volumes(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, ApiError> {
    let volumes = VolumeManager::list(state.backend.as_ref()).await?;
    Ok(Json(volumes))
}

async fn inspect_volume(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let volume = VolumeManager::inspect(state.backend.as_ref(), &name).await?;
    Ok(Json(volume))
}

async fn remove_volume(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    VolumeManager::remove(state.backend.as_ref(), &name, false).await?;
    Ok(StatusCode::NO_CONTENT)
}

// --- Networks ---

async fn list_networks(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, ApiError> {
    let networks = NetworkManager::list(state.backend.as_ref()).await?;
    Ok(Json(networks))
}

async fn inspect_network(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let network = NetworkManager::inspect(state.backend.as_ref(), &name).await?;
    Ok(Json(network))
}
