use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{
        IntoResponse,
        sse::{Event as SseEvent, KeepAlive, Sse},
    },
    routing::{delete, get, post},
};
use serde::{Deserialize, Serialize};
use orca_core::compose::{self, ComposeRunner};
use orca_core::image::ImageManager;
use orca_core::machine::MachineManager;
use orca_core::network::NetworkManager;
use orca_core::runtime::{ContainerRuntime, ContainerStats};
use orca_core::volume::VolumeManager;

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
        .route("/events", get(events_stream))
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
        .route("/containers/{id}/logs", get(container_logs_sse))
        .route("/containers/{id}/exec", post(exec_container))
        // Images
        .route("/images", get(list_images))
        .route("/images/{id}", get(inspect_image))
        .route("/images/{id}", delete(remove_image))
        .route("/images/pull", post(pull_image))
        // Volumes
        .route("/volumes", get(list_volumes))
        .route("/volumes/{name}", get(inspect_volume))
        .route("/volumes/{name}", delete(remove_volume))
        // Networks
        .route("/networks", get(list_networks))
        .route("/networks/{name}", get(inspect_network))
        // Stacks (compose projects)
        .route("/stacks", get(list_stacks))
        .route("/stacks/{name}", get(get_stack))
        .route("/stacks/{name}/start", post(start_stack))
        .route("/stacks/{name}/stop", post(stop_stack))
        .route("/stacks/{name}/restart", post(restart_stack))
        .route("/stacks/{name}/up", post(compose_up))
        .route("/stacks/{name}/down", post(compose_down))
        .route("/stacks/{name}/pull", post(compose_pull))
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

// --- Events (SSE) ---

async fn events_stream(
    State(state): State<Arc<AppState>>,
) -> Sse<impl tokio_stream::Stream<Item = Result<SseEvent, Infallible>>> {
    let mut rx = state.events_tx.subscribe();

    let stream = async_stream::stream! {
        while let Ok(event) = rx.recv().await {
            if let Ok(json) = serde_json::to_string(&event) {
                yield Ok(SseEvent::default()
                    .event(event_type_name(&event.kind))
                    .data(json));
            }
        }
    };

    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keepalive"),
    )
}

fn event_type_name(kind: &orca_core::event::EventKind) -> &'static str {
    use orca_core::event::EventKind::*;
    match kind {
        ContainerCreated { .. } => "container.created",
        ContainerStarted { .. } => "container.started",
        ContainerStopped { .. } => "container.stopped",
        ContainerRemoved { .. } => "container.removed",
        ContainerDied { .. } => "container.died",
        MachineStarted { .. } => "machine.started",
        MachineStopped { .. } => "machine.stopped",
        MachineError { .. } => "machine.error",
        ImagePulled { .. } => "image.pulled",
        ImageRemoved { .. } => "image.removed",
        VolumeCreated { .. } => "volume.created",
        VolumeRemoved { .. } => "volume.removed",
    }
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

// --- Container Exec ---

#[derive(Deserialize)]
struct ExecRequest {
    command: Vec<String>,
    #[serde(default)]
    workdir: Option<String>,
    #[serde(default)]
    env: Option<std::collections::HashMap<String, String>>,
}

async fn exec_container(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<ExecRequest>,
) -> Result<impl IntoResponse, ApiError> {
    use orca_core::runtime::ExecOpts;

    let opts = ExecOpts {
        container: id,
        command: body.command,
        interactive: false,
        tty: false,
        env: body.env.unwrap_or_default(),
        workdir: body.workdir,
    };

    let result = state.backend.exec(opts).await?;
    Ok(Json(result))
}

// --- Container Logs (SSE) ---

#[derive(Deserialize)]
struct LogsQuery {
    tail: Option<u32>,
    follow: Option<bool>,
}

async fn container_logs_sse(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<LogsQuery>,
) -> Result<Sse<impl tokio_stream::Stream<Item = Result<SseEvent, Infallible>>>, ApiError> {
    let follow = query.follow.unwrap_or(true);
    let tail = query.tail.or(Some(200));

    let mut rx = state.backend.container_logs(&id, follow, tail).await?;

    let stream = async_stream::stream! {
        while let Some(line) = rx.recv().await {
            yield Ok(SseEvent::default().data(line));
        }
    };

    Ok(Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keepalive"),
    ))
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

#[derive(Deserialize)]
struct PullRequest {
    reference: String,
}

async fn pull_image(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PullRequest>,
) -> Result<Sse<impl tokio_stream::Stream<Item = Result<SseEvent, Infallible>>>, ApiError> {
    let mut rx = ImageManager::pull(state.backend.as_ref(), &body.reference).await?;

    let stream = async_stream::stream! {
        while let Some(progress) = rx.recv().await {
            if let Ok(json) = serde_json::to_string(&progress) {
                yield Ok(SseEvent::default().data(json));
            }
        }
        // Signal completion
        yield Ok(SseEvent::default().event("done").data("{}"));
    };

    Ok(Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keepalive"),
    ))
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

// --- Stacks (Compose Projects) ---

async fn get_stacks(
    state: &AppState,
) -> Result<Vec<compose::ComposeProject>, ApiError> {
    let containers = state.backend.list_containers(true).await?;
    Ok(compose::extract_projects(&containers))
}

async fn list_stacks(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, ApiError> {
    let stacks = get_stacks(&state).await?;
    Ok(Json(stacks))
}

async fn get_stack(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let stacks = get_stacks(&state).await?;
    let stack = stacks
        .into_iter()
        .find(|s| s.name == name)
        .ok_or_else(|| anyhow::anyhow!("Stack '{name}' not found"))?;
    Ok(Json(stack))
}

async fn start_stack(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let stacks = get_stacks(&state).await?;
    let stack = stacks
        .iter()
        .find(|s| s.name == name)
        .ok_or_else(|| anyhow::anyhow!("Stack '{name}' not found"))?;

    let mut errors = Vec::new();
    for service in &stack.services {
        if service.state != orca_core::runtime::ContainerState::Running {
            if let Err(e) = state.backend.start_container(&service.container_id).await {
                errors.push(format!("{}: {e}", service.name));
            }
        }
    }

    if errors.is_empty() {
        Ok(StatusCode::NO_CONTENT.into_response())
    } else {
        Ok((
            StatusCode::MULTI_STATUS,
            Json(serde_json::json!({
                "partial_errors": errors,
            })),
        )
            .into_response())
    }
}

async fn stop_stack(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let stacks = get_stacks(&state).await?;
    let stack = stacks
        .iter()
        .find(|s| s.name == name)
        .ok_or_else(|| anyhow::anyhow!("Stack '{name}' not found"))?;

    let mut errors = Vec::new();
    for service in &stack.services {
        if service.state == orca_core::runtime::ContainerState::Running {
            if let Err(e) = state.backend.stop_container(&service.container_id, 10).await {
                errors.push(format!("{}: {e}", service.name));
            }
        }
    }

    if errors.is_empty() {
        Ok(StatusCode::NO_CONTENT.into_response())
    } else {
        Ok((
            StatusCode::MULTI_STATUS,
            Json(serde_json::json!({
                "partial_errors": errors,
            })),
        )
            .into_response())
    }
}

async fn restart_stack(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let stacks = get_stacks(&state).await?;
    let stack = stacks
        .iter()
        .find(|s| s.name == name)
        .ok_or_else(|| anyhow::anyhow!("Stack '{name}' not found"))?;

    let mut errors = Vec::new();
    // Stop all running
    for service in &stack.services {
        if service.state == orca_core::runtime::ContainerState::Running {
            if let Err(e) = state.backend.stop_container(&service.container_id, 10).await {
                errors.push(format!("stop {}: {e}", service.name));
            }
        }
    }
    // Start all
    for service in &stack.services {
        if let Err(e) = state.backend.start_container(&service.container_id).await {
            errors.push(format!("start {}: {e}", service.name));
        }
    }

    if errors.is_empty() {
        Ok(StatusCode::NO_CONTENT.into_response())
    } else {
        Ok((
            StatusCode::MULTI_STATUS,
            Json(serde_json::json!({
                "partial_errors": errors,
            })),
        )
            .into_response())
    }
}

// --- Compose CLI operations ---

/// Resolve a stack by name and return its working_dir + config_file.
async fn resolve_stack_dir(
    state: &AppState,
    name: &str,
) -> Result<(String, Option<String>), ApiError> {
    let stacks = get_stacks(state).await?;
    let stack = stacks
        .into_iter()
        .find(|s| s.name == name)
        .ok_or_else(|| anyhow::anyhow!("Stack '{name}' not found"))?;

    let working_dir = stack
        .working_dir
        .ok_or_else(|| anyhow::anyhow!("Stack '{name}' has no working directory"))?;

    Ok((working_dir, stack.config_file))
}

async fn compose_up(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let (dir, config) = resolve_stack_dir(&state, &name).await?;
    let output = state
        .backend
        .compose_up(&dir, config.as_deref())
        .await?;
    Ok(Json(output))
}

async fn compose_down(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let (dir, config) = resolve_stack_dir(&state, &name).await?;
    let output = state
        .backend
        .compose_down(&dir, config.as_deref())
        .await?;
    Ok(Json(output))
}

async fn compose_pull(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let (dir, config) = resolve_stack_dir(&state, &name).await?;
    let output = state
        .backend
        .compose_pull(&dir, config.as_deref())
        .await?;
    Ok(Json(output))
}
