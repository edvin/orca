use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    Json, Router,
    extract::{Path, Query, Request, State},
    http::StatusCode,
    middleware::Next,
    response::{
        IntoResponse,
        sse::{Event as SseEvent, KeepAlive, Sse},
    },
    routing::{delete, get, post},
};
use serde::{Deserialize, Serialize};
use orca_core::compose::{self, ComposeRunner};
use orca_core::image::ImageManager;
use orca_core::kubernetes::K8sManager;
use orca_core::machine::{MachineBackend, MachineConfig, MachineInfo, MachineState};
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

/// Authentication middleware. Checks for a valid Bearer token on all
/// routes except /health. Uses constant-time comparison to prevent
/// timing attacks.
pub async fn auth_middleware(
    State(state): State<Arc<AppState>>,
    req: Request,
    next: Next,
) -> Result<axum::response::Response, StatusCode> {
    // Allow health endpoint without auth
    if req.uri().path() == "/api/v1/health" || req.uri().path() == "/health" {
        return Ok(next.run(req).await);
    }

    let auth_header = req
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok());

    let provided_token = match auth_header {
        Some(h) if h.starts_with("Bearer ") => &h[7..],
        _ => return Err(StatusCode::UNAUTHORIZED),
    };

    // Constant-time comparison to prevent timing attacks
    use subtle::ConstantTimeEq;
    let expected = state.api_token.as_bytes();
    let provided = provided_token.as_bytes();
    if expected.len() != provided.len() || expected.ct_eq(provided).unwrap_u8() != 1 {
        return Err(StatusCode::UNAUTHORIZED);
    }

    Ok(next.run(req).await)
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/health", get(health))
        .route("/events", get(events_stream))
        // Machines
        .route("/machines", get(list_machines))
        .route("/machines/{name}", get(inspect_machine))
        // Containers
        .route("/containers", get(list_containers).post(create_container))
        .route("/containers/{id}", get(inspect_container))
        .route("/containers/{id}/start", post(start_container))
        .route("/containers/{id}/stop", post(stop_container))
        .route("/containers/{id}/kill", post(kill_container))
        .route("/containers/{id}", delete(remove_container))
        .route("/containers/{id}/stats", get(container_stats))
        .route("/containers/{id}/logs", get(container_logs_sse))
        .route("/containers/{id}/exec", post(exec_container))
        .route("/containers/{id}/export/run", get(export_docker_run))
        .route("/containers/{id}/export/compose", get(export_compose))
        // Registries
        .route("/registries", get(list_registries).post(add_registry))
        .route("/registries/{server}", delete(remove_registry_handler))
        // Images
        .route("/images", get(list_images))
        .route("/images/{id}", get(inspect_image))
        .route("/images/{id}", delete(remove_image))
        .route("/images/pull", post(pull_image))
        .route("/images/build", post(build_image))
        .route("/images/prune", post(prune_images))
        .route("/images/batch-delete", post(batch_delete_images))
        .route("/images/search", get(search_images))
        .route("/images/{source}/tag", post(tag_image))
        // Volumes
        .route("/volumes", get(list_volumes).post(create_volume_handler))
        .route("/volumes/{name}", get(inspect_volume))
        .route("/volumes/{name}", delete(remove_volume))
        // Networks
        .route("/networks", get(list_networks).post(create_network_handler))
        .route("/networks/{name}", get(inspect_network))
        .route("/networks/{name}", delete(remove_network_handler))
        // Stacks (compose projects)
        .route("/stacks", get(list_stacks))
        .route("/stacks/{name}", get(get_stack))
        .route("/stacks/{name}/start", post(start_stack))
        .route("/stacks/{name}/stop", post(stop_stack))
        .route("/stacks/{name}/restart", post(restart_stack))
        .route("/stacks/{name}/up", post(compose_up))
        .route("/stacks/{name}/down", post(compose_down))
        .route("/stacks/{name}/pull", post(compose_pull))
        // Kubernetes
        .route("/k8s/status", get(k8s_status))
        .route("/k8s/enable", post(k8s_enable))
        .route("/k8s/disable", post(k8s_disable))
        .route("/k8s/reset", post(k8s_reset))
        .route("/k8s/kubeconfig", get(k8s_kubeconfig))
        .route("/k8s/namespaces", get(k8s_namespaces))
        .route("/k8s/pods/{namespace}", get(k8s_pods))
        .route("/k8s/deployments/{namespace}", get(k8s_deployments))
        .route("/k8s/services/{namespace}", get(k8s_services))
        .route("/k8s/ingresses/{namespace}", get(k8s_ingresses))
        .route("/k8s/pvcs/{namespace}", get(k8s_pvcs))
        .route("/k8s/pvs", get(k8s_pvs))
        .route("/k8s/pods/{namespace}/{name}", delete(k8s_delete_pod))
        .route("/k8s/deployments/{namespace}/{name}/scale", post(k8s_scale))
        .route("/k8s/deployments/{namespace}/{name}/restart", post(k8s_restart))
        .route("/k8s/pvcs/{namespace}/{name}", delete(k8s_delete_pvc))
        .route("/k8s/pods/{namespace}/{name}/logs", get(k8s_pod_logs))
        .route("/k8s/apply", post(k8s_apply))
        // Environment
        .route("/environment/status", get(env_status))
        .route("/environment/fix", post(env_fix))
        // System health
        .route("/system/health", get(system_health))
        // Templates
        .route("/templates", get(list_templates))
        .route("/templates/{id}/deploy", post(deploy_template))
        // AI
        .route("/ai/ask", post(ai_ask))
        // Agent APIs (MCP + OpenAI-compatible)
        .route("/agent/tools", get(agent_list_tools))
        .route("/agent/execute", post(agent_execute_tool))
        .route("/agent/openai/chat/completions", post(agent_openai_proxy))
        .route("/agent/mcp", post(agent_mcp))
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
    State(_state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(vec![native_machine_info()]))
}

async fn inspect_machine(
    State(_state): State<Arc<AppState>>,
    Path(_name): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(native_machine_info()))
}

fn native_machine_info() -> MachineInfo {
    let cpus = std::thread::available_parallelism()
        .map(|p| p.get() as u32)
        .unwrap_or(1);
    let memory_mb = std::fs::read_to_string("/proc/meminfo")
        .ok()
        .and_then(|c| {
            c.lines()
                .find(|l| l.starts_with("MemTotal:"))
                .and_then(|l| l.split_whitespace().nth(1)?.parse::<u64>().ok())
        })
        .map(|kb| kb / 1024)
        .unwrap_or(0);

    MachineInfo {
        name: "native".into(),
        state: MachineState::Running,
        config: MachineConfig {
            name: "native".into(),
            cpus,
            memory_mb,
            disk_gb: 0,
            runtime: orca_core::runtime::RuntimeKind::Docker,
            mounts: vec![],
        },
        backend: MachineBackend::Native,
    }
}

// --- Containers ---

async fn list_containers(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, ApiError> {
    let containers = state.runtime.list_containers(true).await?;
    Ok(Json(containers))
}

async fn inspect_container(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let container = state.runtime.inspect_container(&id).await?;
    Ok(Json(container))
}

async fn start_container(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    state.runtime.start_container(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn stop_container(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    state.runtime.stop_container(&id, 10).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn kill_container(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    state.runtime.kill_container(&id, "SIGKILL").await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn remove_container(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    state.runtime.remove_container(&id, false).await?;
    Ok(StatusCode::NO_CONTENT)
}

// --- Container Create ---

#[derive(Deserialize)]
struct CreateContainerRequest {
    image: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    command: Vec<String>,
    #[serde(default)]
    env: std::collections::HashMap<String, String>,
    #[serde(default)]
    ports: Vec<orca_core::runtime::PortMapping>,
    #[serde(default)]
    volumes: Vec<orca_core::runtime::VolumeMount>,
    #[serde(default)]
    labels: std::collections::HashMap<String, String>,
    #[serde(default)]
    restart_policy: Option<String>,
    #[serde(default)]
    network: Option<String>,
    /// CPU cores limit (e.g. 0.5, 2.0).
    #[serde(default)]
    cpu_limit: Option<f64>,
    /// Memory limit as a human-readable string (e.g. "512m", "1g") or raw bytes.
    #[serde(default)]
    memory_limit: Option<String>,
}

/// Parse a human-readable memory string (e.g. "512m", "1g", "256k") into bytes.
fn parse_memory_string(s: &str) -> anyhow::Result<u64> {
    let s = s.trim().to_lowercase();
    if s.is_empty() {
        anyhow::bail!("empty memory string");
    }

    // Try parsing as raw bytes first
    if let Ok(bytes) = s.parse::<u64>() {
        return Ok(bytes);
    }

    let (num_str, multiplier) = if let Some(n) = s.strip_suffix("gi") {
        (n, 1024u64 * 1024 * 1024)
    } else if let Some(n) = s.strip_suffix("mi") {
        (n, 1024u64 * 1024)
    } else if let Some(n) = s.strip_suffix("ki") {
        (n, 1024u64)
    } else if let Some(n) = s.strip_suffix('g') {
        (n, 1_000_000_000u64)
    } else if let Some(n) = s.strip_suffix('m') {
        (n, 1_000_000u64)
    } else if let Some(n) = s.strip_suffix('k') {
        (n, 1_000u64)
    } else if let Some(n) = s.strip_suffix('b') {
        (n, 1u64)
    } else {
        anyhow::bail!("invalid memory format: '{s}' (use e.g. 512m, 1g, 256k)");
    };

    let num: f64 = num_str
        .parse()
        .map_err(|_| anyhow::anyhow!("invalid number in memory string: '{s}'"))?;
    Ok((num * multiplier as f64) as u64)
}

async fn create_container(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateContainerRequest>,
) -> Result<impl IntoResponse, ApiError> {
    use orca_core::runtime::ContainerCreateOpts;

    let memory_limit = body
        .memory_limit
        .as_deref()
        .map(parse_memory_string)
        .transpose()?;

    let opts = ContainerCreateOpts {
        image: body.image,
        name: body.name,
        command: body.command,
        env: body.env,
        ports: body.ports,
        volumes: body.volumes,
        labels: body.labels,
        restart_policy: body.restart_policy,
        network: body.network,
        detach: true,
        remove_on_exit: false,
        cpu_limit: body.cpu_limit,
        memory_limit,
        memory_swap: None,
    };

    let id = state.runtime.create_container(opts).await?;

    Ok((
        StatusCode::CREATED,
        Json(serde_json::json!({ "id": id })),
    ))
}

async fn container_stats(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<ContainerStats>, ApiError> {
    let stats = state.runtime.container_stats(&id).await?;
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

    let result = state.runtime.exec(opts).await?;
    Ok(Json(result))
}

// --- Container Export ---

async fn export_docker_run(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let container = state.runtime.inspect_container(&id).await?;
    let cmd = orca_backend_common::export::container_to_docker_run(&container);
    Ok(Json(serde_json::json!({ "command": cmd })))
}

async fn export_compose(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let container = state.runtime.inspect_container(&id).await?;
    let project_name = container.name.replace('/', "").replace('-', "_");
    let yaml = orca_backend_common::export::containers_to_compose(&[container], &project_name);
    Ok(Json(serde_json::json!({ "yaml": yaml })))
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

    let mut rx = state.runtime.container_logs(&id, follow, tail).await?;

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
    let images = ImageManager::list(state.runtime.as_ref()).await?;
    Ok(Json(images))
}

async fn inspect_image(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let image = ImageManager::inspect(state.runtime.as_ref(), &id).await?;
    Ok(Json(image))
}

async fn remove_image(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    ImageManager::remove(state.runtime.as_ref(), &id, false).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct RegistryAuthRequest {
    username: String,
    password: String,
}

#[derive(Deserialize)]
struct PullRequest {
    reference: String,
    #[serde(default)]
    auth: Option<RegistryAuthRequest>,
}

async fn pull_image(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PullRequest>,
) -> Result<Sse<impl tokio_stream::Stream<Item = Result<SseEvent, Infallible>>>, ApiError> {
    let mut rx = if let Some(auth) = &body.auth {
        // Explicit auth provided in request
        let registry_auth = orca_core::image::RegistryAuth {
            username: auth.username.clone(),
            password: auth.password.clone(),
            server: None,
        };
        state
            .runtime
            .pull_with_auth(&body.reference, &registry_auth)
            .await?
    } else {
        // Auto-lookup saved credentials for this registry
        let config = state.config.lock().await;
        if let Some(cred) = config.find_credentials(&body.reference) {
            let registry_auth = orca_core::image::RegistryAuth {
                username: cred.username.clone(),
                password: cred.password(),
                server: Some(cred.server.clone()),
            };
            drop(config);
            state
                .runtime
                .pull_with_auth(&body.reference, &registry_auth)
                .await?
        } else {
            drop(config);
            ImageManager::pull(state.runtime.as_ref(), &body.reference).await?
        }
    };

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

#[derive(Deserialize)]
struct BuildRequest {
    context_path: String,
    dockerfile: Option<String>,
    tag: Option<String>,
}

async fn build_image(
    State(state): State<Arc<AppState>>,
    Json(body): Json<BuildRequest>,
) -> Result<Sse<impl tokio_stream::Stream<Item = Result<SseEvent, Infallible>>>, ApiError> {
    let mut rx = ImageManager::build(
        state.runtime.as_ref(),
        &body.context_path,
        body.dockerfile.as_deref(),
        body.tag.as_deref(),
    )
    .await?;

    let stream = async_stream::stream! {
        while let Some(progress) = rx.recv().await {
            if let Ok(json) = serde_json::to_string(&progress) {
                yield Ok(SseEvent::default().data(json));
            }
        }
        yield Ok(SseEvent::default().event("done").data("{}"));
    };

    Ok(Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keepalive"),
    ))
}

async fn prune_images(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, ApiError> {
    let result = ImageManager::prune(state.runtime.as_ref()).await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
struct BatchDeleteRequest {
    ids: Vec<String>,
    #[serde(default)]
    force: bool,
}

async fn batch_delete_images(
    State(state): State<Arc<AppState>>,
    Json(body): Json<BatchDeleteRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let mut deleted = Vec::new();
    let mut errors = Vec::new();

    for id in &body.ids {
        match ImageManager::remove(state.runtime.as_ref(), id, body.force).await {
            Ok(()) => deleted.push(id.clone()),
            Err(e) => errors.push(format!("{}: {e}", &id[..12.min(id.len())])),
        }
    }

    Ok(Json(serde_json::json!({
        "deleted": deleted,
        "errors": errors,
    })))
}

#[derive(Deserialize)]
struct TagRequest {
    repo: String,
    tag: String,
}

async fn tag_image(
    State(state): State<Arc<AppState>>,
    Path(source): Path<String>,
    Json(body): Json<TagRequest>,
) -> Result<impl IntoResponse, ApiError> {
    ImageManager::tag(state.runtime.as_ref(), &source, &body.repo, &body.tag).await?;
    Ok(StatusCode::NO_CONTENT)
}

// --- Registries ---

async fn list_registries(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, ApiError> {
    let config = state.config.lock().await;
    // Never return passwords to the frontend — mask them
    let masked: Vec<serde_json::Value> = config
        .registries
        .iter()
        .map(|r| {
            serde_json::json!({
                "server": r.server,
                "name": r.name,
                "username": r.username,
            })
        })
        .collect();
    Ok(Json(masked))
}

#[derive(Deserialize)]
struct AddRegistryRequest {
    server: String,
    name: String,
    username: String,
    password: String,
}

async fn add_registry(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AddRegistryRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let cred =
        orca_core::config::RegistryCredential::new(&body.server, &body.name, &body.username, &body.password);
    let mut config = state.config.lock().await;
    config.add_registry(cred)?;
    Ok(StatusCode::CREATED)
}

async fn remove_registry_handler(
    State(state): State<Arc<AppState>>,
    Path(server): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let decoded = urlencoding::decode(&server)
        .map(|s: std::borrow::Cow<'_, str>| s.into_owned())
        .unwrap_or(server);
    let mut config = state.config.lock().await;
    config.remove_registry(&decoded)?;
    Ok(StatusCode::NO_CONTENT)
}

// --- Image Search ---

#[derive(Deserialize)]
struct SearchQuery {
    q: String,
    #[serde(default = "default_search_limit")]
    limit: u32,
}

fn default_search_limit() -> u32 {
    20
}

async fn search_images(
    Query(query): Query<SearchQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let results = orca_backend_common::search::search_docker_hub(&query.q, query.limit).await?;
    Ok(Json(results))
}

// --- Volumes ---

async fn list_volumes(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, ApiError> {
    let volumes = VolumeManager::list(state.runtime.as_ref()).await?;
    Ok(Json(volumes))
}

async fn inspect_volume(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let volume = VolumeManager::inspect(state.runtime.as_ref(), &name).await?;
    Ok(Json(volume))
}

async fn remove_volume(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    VolumeManager::remove(state.runtime.as_ref(), &name, false).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct CreateVolumeRequest {
    name: String,
    #[serde(default = "default_local_driver")]
    driver: String,
    #[serde(default)]
    labels: serde_json::Value,
}

fn default_local_driver() -> String {
    "local".to_string()
}

async fn create_volume_handler(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateVolumeRequest>,
) -> Result<impl IntoResponse, ApiError> {
    // Accept labels as either Vec<String> (KEY=value) or HashMap
    let labels: std::collections::HashMap<String, String> = match &body.labels {
        serde_json::Value::Array(arr) => arr
            .iter()
            .filter_map(|v| v.as_str())
            .filter_map(|s| {
                let mut parts = s.splitn(2, '=');
                let key = parts.next()?.to_string();
                let val = parts.next().unwrap_or("").to_string();
                Some((key, val))
            })
            .collect(),
        serde_json::Value::Object(map) => map
            .iter()
            .map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string()))
            .collect(),
        _ => std::collections::HashMap::new(),
    };

    let volume = VolumeManager::create(state.runtime.as_ref(), &body.name, labels).await?;
    Ok((StatusCode::CREATED, Json(volume)))
}

// --- Networks ---

async fn list_networks(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, ApiError> {
    let networks = NetworkManager::list(state.runtime.as_ref()).await?;
    Ok(Json(networks))
}

async fn inspect_network(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let network = NetworkManager::inspect(state.runtime.as_ref(), &name).await?;
    Ok(Json(network))
}

#[derive(Deserialize)]
struct CreateNetworkRequest {
    name: String,
    #[serde(default = "default_bridge_driver")]
    driver: String,
}

fn default_bridge_driver() -> String {
    "bridge".to_string()
}

async fn create_network_handler(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateNetworkRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let network = NetworkManager::create(state.runtime.as_ref(), &body.name, &body.driver).await?;
    Ok((StatusCode::CREATED, Json(network)))
}

async fn remove_network_handler(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    NetworkManager::remove(state.runtime.as_ref(), &name).await?;
    Ok(StatusCode::NO_CONTENT)
}

// --- Stacks (Compose Projects) ---

async fn get_stacks(
    state: &AppState,
) -> Result<Vec<compose::ComposeProject>, ApiError> {
    let containers = state.runtime.list_containers(true).await?;
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
            if let Err(e) = state.runtime.start_container(&service.container_id).await {
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
            if let Err(e) = state.runtime.stop_container(&service.container_id, 10).await {
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
            if let Err(e) = state.runtime.stop_container(&service.container_id, 10).await {
                errors.push(format!("stop {}: {e}", service.name));
            }
        }
    }
    // Start all
    for service in &stack.services {
        if let Err(e) = state.runtime.start_container(&service.container_id).await {
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
        .runtime
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
        .runtime
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
        .runtime
        .compose_pull(&dir, config.as_deref())
        .await?;
    Ok(Json(output))
}

// --- Kubernetes ---

async fn k8s_status(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, ApiError> {
    let status = state.k8s.status().await?;
    Ok(Json(status))
}

async fn k8s_enable(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, ApiError> {
    state.k8s.enable().await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn k8s_disable(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, ApiError> {
    state.k8s.disable().await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn k8s_reset(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, ApiError> {
    state.k8s.reset().await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn k8s_kubeconfig(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, ApiError> {
    let kubeconfig = state.k8s.kubeconfig().await?;
    Ok(Json(serde_json::json!({ "kubeconfig": kubeconfig })))
}

async fn k8s_namespaces(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, ApiError> {
    let namespaces = state.k8s.list_namespaces().await?;
    Ok(Json(namespaces))
}

async fn k8s_pods(
    State(state): State<Arc<AppState>>,
    Path(namespace): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let pods = state.k8s.list_pods(&namespace).await?;
    Ok(Json(pods))
}

async fn k8s_deployments(
    State(state): State<Arc<AppState>>,
    Path(namespace): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let deployments = state.k8s.list_deployments(&namespace).await?;
    Ok(Json(deployments))
}

async fn k8s_services(
    State(state): State<Arc<AppState>>,
    Path(namespace): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let services = state.k8s.list_services(&namespace).await?;
    Ok(Json(services))
}

async fn k8s_ingresses(
    State(state): State<Arc<AppState>>,
    Path(namespace): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let ingresses = state.k8s.list_ingresses(&namespace).await?;
    Ok(Json(ingresses))
}

async fn k8s_pvcs(
    State(state): State<Arc<AppState>>,
    Path(namespace): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let pvcs = state.k8s.list_pvcs(&namespace).await?;
    Ok(Json(pvcs))
}

async fn k8s_pvs(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, ApiError> {
    let pvs = state.k8s.list_pvs().await?;
    Ok(Json(pvs))
}

async fn k8s_delete_pod(
    State(state): State<Arc<AppState>>,
    Path((namespace, name)): Path<(String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    state.k8s.delete_pod(&namespace, &name).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct ScaleRequest {
    replicas: u32,
}

async fn k8s_scale(
    State(state): State<Arc<AppState>>,
    Path((namespace, name)): Path<(String, String)>,
    Json(body): Json<ScaleRequest>,
) -> Result<impl IntoResponse, ApiError> {
    state
        .k8s
        .scale_deployment(&namespace, &name, body.replicas)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn k8s_restart(
    State(state): State<Arc<AppState>>,
    Path((namespace, name)): Path<(String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    state.k8s.restart_deployment(&namespace, &name).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn k8s_delete_pvc(
    State(state): State<Arc<AppState>>,
    Path((namespace, name)): Path<(String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    state.k8s.delete_pvc(&namespace, &name).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct PodLogsQuery {
    container: Option<String>,
    tail: Option<u32>,
}

async fn k8s_pod_logs(
    State(state): State<Arc<AppState>>,
    Path((namespace, name)): Path<(String, String)>,
    Query(query): Query<PodLogsQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let logs = state
        .k8s
        .pod_logs(&namespace, &name, query.container.as_deref(), query.tail)
        .await?;
    Ok(Json(logs))
}

#[derive(Deserialize)]
struct ApplyYamlRequest {
    yaml: String,
}

async fn k8s_apply(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ApplyYamlRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let output = state.k8s.apply_yaml(&body.yaml).await?;
    Ok(Json(serde_json::json!({ "output": output })))
}

// --- Environment ---

async fn env_status(
    State(_state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, ApiError> {
    let status = orca_backend_common::environment::check_environment().await;
    Ok(Json(status))
}

#[derive(Deserialize)]
struct FixRequest {
    action: String,
}

async fn env_fix(
    State(_state): State<Arc<AppState>>,
    Json(body): Json<FixRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let output = orca_backend_common::environment::run_fix(&body.action).await?;
    Ok(Json(serde_json::json!({ "output": output })))
}

// --- System Health ---

async fn system_health(
    State(_state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, ApiError> {
    let health = orca_backend_common::environment::check_system_health().await;
    Ok(Json(health))
}

// --- Templates ---

async fn list_templates() -> Json<Vec<orca_core::templates::AppTemplate>> {
    Json(orca_backend_common::templates::builtin_templates())
}

#[derive(Deserialize)]
struct DeployTemplateOverrides {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    ports: Option<Vec<String>>,
    #[serde(default)]
    env: Option<Vec<String>>,
    #[serde(default)]
    volumes: Option<Vec<String>>,
}

async fn deploy_template(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(overrides): Json<DeployTemplateOverrides>,
) -> Result<impl IntoResponse, ApiError> {
    use orca_core::runtime::ContainerCreateOpts;

    let templates = orca_backend_common::templates::builtin_templates();
    let template = templates
        .iter()
        .find(|t| t.id == id)
        .ok_or_else(|| anyhow::anyhow!("Template '{}' not found", id))?;

    let container_name = overrides
        .name
        .unwrap_or_else(|| format!("orca-{}", template.id));

    let ports_str = overrides.ports.unwrap_or_else(|| template.default_ports.clone());
    let ports: Vec<orca_core::runtime::PortMapping> = ports_str
        .iter()
        .filter_map(|s| {
            let parts: Vec<&str> = s.split(':').collect();
            if parts.len() == 2 {
                Some(orca_core::runtime::PortMapping {
                    host_ip: None,
                    host_port: parts[0].parse().ok()?,
                    container_port: parts[1].parse().ok()?,
                    protocol: "tcp".to_string(),
                })
            } else {
                None
            }
        })
        .collect();

    let env_list = overrides.env.unwrap_or_else(|| template.default_env.clone());
    let env: std::collections::HashMap<String, String> = env_list
        .iter()
        .filter_map(|s| {
            let mut parts = s.splitn(2, '=');
            let key = parts.next()?.to_string();
            let val = parts.next().unwrap_or("").to_string();
            Some((key, val))
        })
        .collect();

    let vol_list = overrides.volumes.unwrap_or_else(|| template.default_volumes.clone());
    let volumes: Vec<orca_core::runtime::VolumeMount> = vol_list
        .iter()
        .filter_map(|s| {
            let parts: Vec<&str> = s.splitn(2, ':').collect();
            if parts.len() == 2 {
                Some(orca_core::runtime::VolumeMount {
                    source: parts[0].to_string(),
                    target: parts[1].to_string(),
                    read_only: false,
                })
            } else {
                None
            }
        })
        .collect();

    let opts = ContainerCreateOpts {
        image: template.image.clone(),
        name: Some(container_name.clone()),
        command: vec![],
        env,
        ports,
        volumes,
        labels: std::collections::HashMap::new(),
        restart_policy: Some(template.restart_policy.clone()),
        network: None,
        detach: true,
        remove_on_exit: false,
        cpu_limit: None,
        memory_limit: None,
        memory_swap: None,
    };

    let container_id = state.runtime.create_container(opts).await?;

    // Start the container
    state.runtime.start_container(&container_id).await?;

    Ok((
        StatusCode::CREATED,
        Json(serde_json::json!({
            "id": container_id,
            "name": container_name,
            "notes": template.notes,
        })),
    ))
}

// --- AI Assistant ---

#[derive(Deserialize)]
struct AiAskRequest {
    query: String,
    #[serde(default)]
    context: Option<orca_core::ai::AiContext>,
}

async fn ai_ask(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AiAskRequest>,
) -> Result<impl IntoResponse, ApiError> {
    // Check for API key: env var first, then config
    let api_key = std::env::var("ANTHROPIC_API_KEY").ok().or_else(|| {
        let config = state.config.blocking_lock();
        config.anthropic_api_key.clone()
    });

    let api_key = match api_key {
        Some(key) if !key.is_empty() => key,
        _ => {
            return Ok(Json(orca_core::ai::AiResponse {
                answer: "No Anthropic API key configured. To enable AI features, set the \
                         ANTHROPIC_API_KEY environment variable or add it in Settings."
                    .to_string(),
                suggestions: vec![orca_core::ai::AiSuggestion {
                    label: "Open Settings".to_string(),
                    action: "navigate".to_string(),
                    detail: "settings".to_string(),
                }],
            }));
        }
    };

    // Build context-enriched prompt
    let mut system_prompt = String::from(
        "You are Orca AI, an assistant built into the Orca container management desktop app. \
         You help users with Docker containers, images, networking, volumes, and troubleshooting. \
         Keep responses concise and actionable. Use markdown formatting. \
         When suggesting fixes, be specific with commands. \
         You can suggest actions the user can take in the Orca UI."
    );

    let mut user_message = body.query.clone();

    if let Some(ctx) = &body.context {
        system_prompt.push_str("\n\nThe user is asking about a specific container context:");
        if let Some(name) = &ctx.container_name {
            system_prompt.push_str(&format!("\nContainer name: {name}"));
        }
        if let Some(image) = &ctx.image {
            system_prompt.push_str(&format!("\nImage: {image}"));
        }
        if let Some(exit_code) = ctx.exit_code {
            system_prompt.push_str(&format!("\nExit code: {exit_code}"));
        }
        if let Some(error) = &ctx.error {
            system_prompt.push_str(&format!("\nError: {error}"));
        }
        if let Some(logs) = &ctx.container_logs {
            // Truncate logs to last 50 lines to stay within token limits
            let log_lines: Vec<&str> = logs.lines().collect();
            let recent_logs: String = if log_lines.len() > 50 {
                log_lines[log_lines.len() - 50..].join("\n")
            } else {
                logs.clone()
            };
            system_prompt.push_str(&format!("\n\nRecent container logs:\n```\n{recent_logs}\n```"));
        }
    }

    // Call Claude API
    let http_client = reqwest::Client::new();
    let api_resp = http_client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", &api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&serde_json::json!({
            "model": "claude-sonnet-4-20250514",
            "max_tokens": 1024,
            "system": system_prompt,
            "messages": [
                { "role": "user", "content": user_message }
            ]
        }))
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("Failed to call Claude API: {e}"))?;

    if !api_resp.status().is_success() {
        let status = api_resp.status();
        let err_body = api_resp.text().await.unwrap_or_default();
        return Err(anyhow::anyhow!("Claude API error ({}): {}", status, err_body).into());
    }

    let resp_json: serde_json::Value = api_resp
        .json()
        .await
        .map_err(|e| anyhow::anyhow!("Failed to parse Claude API response: {e}"))?;

    let answer = resp_json["content"]
        .as_array()
        .and_then(|arr| arr.first())
        .and_then(|block| block["text"].as_str())
        .unwrap_or("No response received from AI.")
        .to_string();

    Ok(Json(orca_core::ai::AiResponse {
        answer,
        suggestions: vec![],
    }))
}

// --- Agent APIs (MCP + OpenAI-compatible) ---

/// List all available agent tools in OpenAI function calling format.
async fn agent_list_tools() -> Json<serde_json::Value> {
    let catalog = orca_core::agent_tools::tool_catalog();
    let tools: Vec<serde_json::Value> = catalog
        .iter()
        .map(|t| {
            serde_json::json!({
                "type": "function",
                "function": {
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.parameters,
                }
            })
        })
        .collect();
    Json(serde_json::json!({ "tools": tools }))
}

#[derive(Deserialize)]
struct AgentExecuteRequest {
    tool: String,
    #[serde(default)]
    arguments: serde_json::Value,
}

/// Execute a single agent tool directly.
async fn agent_execute_tool(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AgentExecuteRequest>,
) -> impl IntoResponse {
    match crate::agent::execute_tool(&state, &body.tool, body.arguments).await {
        Ok(result) => (
            StatusCode::OK,
            Json(serde_json::json!({ "result": result })),
        ),
        Err(err) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": err })),
        ),
    }
}

/// OpenAI-compatible chat completions endpoint that executes tool calls.
///
/// Accepts requests with tool_calls in messages (as OpenAI sends them)
/// and executes each tool call, returning results in OpenAI response format.
async fn agent_openai_proxy(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    // Extract tool calls from the last assistant message, or from top-level
    let tool_calls = body
        .get("messages")
        .and_then(|m| m.as_array())
        .and_then(|msgs| {
            msgs.iter()
                .rev()
                .find(|m| m.get("role").and_then(|r| r.as_str()) == Some("assistant"))
        })
        .and_then(|msg| msg.get("tool_calls"))
        .and_then(|tc| tc.as_array())
        .cloned();

    // Also support direct tool_calls at top level for simpler usage
    let tool_calls = tool_calls.or_else(|| {
        body.get("tool_calls")
            .and_then(|tc| tc.as_array())
            .cloned()
    });

    let tool_calls = match tool_calls {
        Some(tc) => tc,
        None => {
            // No tool calls — return the available tools so the caller can use them
            let catalog = orca_core::agent_tools::tool_catalog();
            let tools: Vec<serde_json::Value> = catalog
                .iter()
                .map(|t| {
                    serde_json::json!({
                        "type": "function",
                        "function": {
                            "name": t.name,
                            "description": t.description,
                            "parameters": t.parameters,
                        }
                    })
                })
                .collect();
            return (
                StatusCode::OK,
                Json(serde_json::json!({
                    "id": format!("chatcmpl-orca-{}", uuid_v4()),
                    "object": "chat.completion",
                    "choices": [{
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": "No tool calls found in request. Available tools returned.",
                        },
                        "finish_reason": "stop",
                    }],
                    "tools": tools,
                })),
            );
        }
    };

    // Execute each tool call
    let mut tool_results = Vec::new();
    for tc in &tool_calls {
        let tool_call_id = tc
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        let function = tc.get("function").cloned().unwrap_or_default();
        let name = function
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        let arguments: serde_json::Value = function
            .get("arguments")
            .and_then(|v| {
                // Arguments can be a JSON string or object
                if let Some(s) = v.as_str() {
                    serde_json::from_str(s).ok()
                } else {
                    Some(v.clone())
                }
            })
            .unwrap_or(serde_json::json!({}));

        let result = crate::agent::execute_tool(&state, name, arguments).await;

        tool_results.push(serde_json::json!({
            "role": "tool",
            "tool_call_id": tool_call_id,
            "content": match &result {
                Ok(v) => serde_json::to_string(v).unwrap_or_default(),
                Err(e) => serde_json::json!({ "error": e }).to_string(),
            },
        }));
    }

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "id": format!("chatcmpl-orca-{}", uuid_v4()),
            "object": "chat.completion",
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": null,
                },
                "finish_reason": "tool_calls",
            }],
            "tool_results": tool_results,
        })),
    )
}

/// MCP (Model Context Protocol) JSON-RPC endpoint.
///
/// Handles:
/// - `initialize` — server info
/// - `tools/list` — tool catalog in MCP format
/// - `tools/call` — execute a tool
async fn agent_mcp(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let jsonrpc = "2.0";
    let id = body.get("id").cloned().unwrap_or(serde_json::json!(null));
    let method = body
        .get("method")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    match method {
        "initialize" => Json(serde_json::json!({
            "jsonrpc": jsonrpc,
            "id": id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {
                    "tools": { "listChanged": false },
                },
                "serverInfo": {
                    "name": "orca-daemon",
                    "version": env!("CARGO_PKG_VERSION"),
                },
            }
        })),

        "tools/list" => {
            let catalog = orca_core::agent_tools::tool_catalog();
            let tools: Vec<serde_json::Value> = catalog
                .iter()
                .map(|t| {
                    serde_json::json!({
                        "name": t.name,
                        "description": t.description,
                        "inputSchema": t.parameters,
                    })
                })
                .collect();
            Json(serde_json::json!({
                "jsonrpc": jsonrpc,
                "id": id,
                "result": { "tools": tools }
            }))
        }

        "tools/call" => {
            let params = body.get("params").cloned().unwrap_or_default();
            let tool_name = params
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let arguments = params
                .get("arguments")
                .cloned()
                .unwrap_or(serde_json::json!({}));

            match crate::agent::execute_tool(&state, tool_name, arguments).await {
                Ok(result) => {
                    let text = serde_json::to_string_pretty(&result).unwrap_or_default();
                    Json(serde_json::json!({
                        "jsonrpc": jsonrpc,
                        "id": id,
                        "result": {
                            "content": [{
                                "type": "text",
                                "text": text,
                            }],
                            "isError": false,
                        }
                    }))
                }
                Err(err) => Json(serde_json::json!({
                    "jsonrpc": jsonrpc,
                    "id": id,
                    "result": {
                        "content": [{
                            "type": "text",
                            "text": err,
                        }],
                        "isError": true,
                    }
                })),
            }
        }

        _ => Json(serde_json::json!({
            "jsonrpc": jsonrpc,
            "id": id,
            "error": {
                "code": -32601,
                "message": format!("Method not found: {method}"),
            }
        })),
    }
}

/// Generate a simple UUID v4 (random) without pulling in the uuid crate.
fn uuid_v4() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{:032x}", nanos)
}
