use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    Json, Router,
    extract::{Path, Query, Request, State},
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    http::StatusCode,
    middleware::Next,
    response::{
        IntoResponse,
        sse::{Event as SseEvent, KeepAlive, Sse},
    },
    routing::{delete, get, post, put},
};
use futures::{SinkExt, StreamExt as FuturesStreamExt};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
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
        let mut response = next.run(req).await;
        response.headers_mut().insert(
            "x-orca-version",
            axum::http::HeaderValue::from_static(env!("CARGO_PKG_VERSION")),
        );
        return Ok(response);
    }

    // Allow webhook endpoints — they validate via HMAC signature
    if req.uri().path().contains("/webhooks/") {
        return Ok(next.run(req).await);
    }

    // Allow WebSocket endpoints — they do their own auth via query param
    if req.uri().path().ends_with("/terminal") || req.uri().path().ends_with("/enable-stream") || req.uri().path().ends_with("/tunnel") {
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

    let mut response = next.run(req).await;
    // Add daemon version header so the UI can detect version mismatches
    response.headers_mut().insert(
        "x-orca-version",
        axum::http::HeaderValue::from_static(env!("CARGO_PKG_VERSION")),
    );
    Ok(response)
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
        .route("/containers/{id}/update", post(update_container))
        .route("/containers/{id}/exec", post(exec_container))
        .route("/containers/{id}/terminal", get(container_terminal_ws))
        .route("/containers/{id}/export/run", get(export_docker_run))
        .route("/containers/{id}/export/compose", get(export_compose))
        .route("/containers/{id}/files", get(container_list_files))
        .route("/containers/{id}/file", get(container_read_file))
        .route("/containers/{id}/commit", post(commit_container))
        .route("/containers/{id}/export/tar", get(export_container_tar))
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
        .route("/images/{id}/files", get(image_list_files))
        .route("/images/{id}/file", get(image_read_file))
        .route("/images/import", post(import_image))
        .route("/images/{id}/save", get(save_image_tar))
        .route("/images/{id}/scan", get(scan_image))
        .route("/images/{id}/history", get(image_history))
        // Volumes
        .route("/volumes", get(list_volumes).post(create_volume_handler))
        .route("/volumes/{name}", get(inspect_volume))
        .route("/volumes/{name}", delete(remove_volume))
        .route("/volumes/{name}/files", get(volume_list_files))
        .route("/volumes/{name}/file", get(volume_read_file))
        .route("/volumes/{name}/containers", get(volume_containers))
        // Networks
        .route("/networks", get(list_networks).post(create_network_handler))
        .route("/networks/topology", get(network_topology))
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
        .route("/k8s/enable-stream", get(k8s_enable_ws))
        .route("/k8s/disable", post(k8s_disable))
        .route("/k8s/reset", post(k8s_reset))
        .route("/k8s/kubeconfig", get(k8s_kubeconfig))
        .route("/k8s/namespaces", get(k8s_namespaces))
        .route("/k8s/pods/{namespace}", get(k8s_pods))
        .route("/k8s/deployments/{namespace}", get(k8s_deployments))
        .route("/k8s/services/{namespace}", get(k8s_services))
        .route("/k8s/ingresses/{namespace}", get(k8s_ingresses))
        .route("/k8s/pvcs/{namespace}", get(k8s_pvcs).post(k8s_create_pvc))
        .route("/k8s/pvs", get(k8s_pvs))
        .route("/k8s/pods/{namespace}/{name}", delete(k8s_delete_pod))
        .route("/k8s/deployments/{namespace}/{name}/scale", post(k8s_scale))
        .route("/k8s/deployments/{namespace}/{name}/restart", post(k8s_restart))
        .route("/k8s/pvcs/{namespace}/{name}", delete(k8s_delete_pvc))
        .route("/k8s/pods/{namespace}/{name}/logs", get(k8s_pod_logs))
        .route("/k8s/apply", post(k8s_apply))
        .route("/k8s/yaml/{kind}/{namespace}/{name}", get(k8s_get_yaml))
        .route("/k8s/events/{namespace}", get(k8s_events))
        // TCP tunnel (WebSocket-based port forwarding for remote hosts)
        .route("/tunnel", get(tunnel_ws))
        // Webhooks (HMAC-authenticated, no bearer token)
        .route("/webhooks/github", post(webhook_github))
        .route("/webhooks/dockerhub", post(webhook_dockerhub))
        // Auto-deploy rules
        .route("/deploy/rules", get(list_deploy_rules).post(save_deploy_rule))
        .route("/deploy/rules/{id}", delete(delete_deploy_rule))
        .route("/deploy/history", get(list_deploy_history))
        .route("/deploy/test", post(test_deploy_rule))
        .route("/deploy/webhook-secret", post(save_webhook_secret))
        // Scheduled actions
        .route("/schedules", get(list_schedules).post(save_schedule))
        .route("/schedules/{id}", delete(delete_schedule))
        .route("/k8s/namespaces", post(k8s_create_namespace))
        .route("/k8s/namespaces/{name}", delete(k8s_delete_namespace))
        .route("/k8s/configmaps/{namespace}", get(k8s_configmaps))
        .route("/k8s/secrets/{namespace}", get(k8s_secrets).post(k8s_create_secret))
        .route("/k8s/secrets/{namespace}/{name}", delete(k8s_delete_secret).put(k8s_update_secret))
        .route("/k8s/metrics/{namespace}", get(k8s_pod_metrics))
        .route("/k8s/deployments/{namespace}/{name}/history", get(k8s_rollout_history))
        .route("/k8s/deployments/{namespace}/{name}/rollback", post(k8s_rollout_undo))
        .route("/k8s/helm/releases", get(k8s_helm_list))
        .route("/k8s/helm/uninstall", post(k8s_helm_uninstall))
        .route("/k8s/helm/available", get(k8s_helm_available))
        .route("/k8s/helm/install", post(k8s_helm_install))
        .route("/k8s/daemonsets/{namespace}", get(k8s_daemonsets))
        .route("/k8s/statefulsets/{namespace}", get(k8s_statefulsets))
        .route("/k8s/replicasets/{namespace}", get(k8s_replicasets))
        .route("/k8s/statefulsets/{namespace}/{name}/scale", post(k8s_scale_statefulset))
        .route("/k8s/statefulsets/{namespace}/{name}/restart", post(k8s_restart_statefulset))
        .route("/k8s/daemonsets/{namespace}/{name}", delete(k8s_delete_daemonset))
        .route("/k8s/statefulsets/{namespace}/{name}", delete(k8s_delete_statefulset))
        .route("/k8s/replicasets/{namespace}/{name}", delete(k8s_delete_replicaset))
        .route("/k8s/jobs/{namespace}", get(k8s_jobs))
        .route("/k8s/cronjobs/{namespace}", get(k8s_cronjobs))
        .route("/k8s/cronjobs/{namespace}/{name}/trigger", post(k8s_trigger_cronjob))
        .route("/k8s/jobs/{namespace}/{name}", delete(k8s_delete_job))
        .route("/k8s/cronjobs/{namespace}/{name}", delete(k8s_delete_cronjob))
        .route("/k8s/cronjobs/{namespace}/{name}/suspend", put(k8s_suspend_cronjob))
        .route("/k8s/hpas/{namespace}", get(k8s_hpas).post(k8s_create_hpa))
        .route("/k8s/hpas/{namespace}/{name}", delete(k8s_delete_hpa))
        .route("/k8s/network-policies/{namespace}", get(k8s_network_policies))
        .route("/k8s/network-policies/{namespace}/{name}", delete(k8s_delete_network_policy))
        .route("/k8s/storage-classes", get(k8s_storage_classes))
        .route("/k8s/crds", get(k8s_crds))
        .route("/k8s/pods/{namespace}/{name}/terminal", get(k8s_pod_terminal_ws))
        // Environment
        .route("/environment/status", get(env_status))
        .route("/environment/fix", post(env_fix))
        .route("/environment/fix-stream", post(env_fix_stream))
        // System health
        .route("/system/health", get(system_health))
        .route("/system/host-uid", get(host_uid))
        // Templates
        .route("/templates", get(list_templates))
        .route("/templates/refresh", post(refresh_templates))
        .route("/templates/user", post(save_user_template).delete(delete_user_template))
        .route("/templates/{id}/deploy", post(deploy_template))
        // AI
        .route("/ai/ask", post(ai_ask))
        .route("/settings/general", get(get_general_settings).post(save_general_settings))
        .route("/settings/ai", post(save_ai_settings))
        .route("/settings/ai", get(get_ai_settings))
        .route("/settings/ai/models", get(list_ai_models))
        .route("/settings/cleanup", post(cleanup))
        .route("/settings/reconnect", post(reconnect_runtime))
        .route("/settings/lima", get(get_lima_settings).post(save_lima_settings))
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
    let containers = state.rt().await.list_containers(true).await?;
    Ok(Json(containers))
}

async fn inspect_container(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let container = state.rt().await.inspect_container(&id).await?;
    Ok(Json(container))
}

async fn start_container(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    state.rt().await.start_container(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn stop_container(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    state.rt().await.stop_container(&id, 10).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn kill_container(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    state.rt().await.kill_container(&id, "SIGKILL").await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn remove_container(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    state.rt().await.remove_container(&id, false).await?;
    Ok(StatusCode::NO_CONTENT)
}

// --- Container Update (resource limits) ---

#[derive(Deserialize)]
struct UpdateContainerRequest {
    /// Memory limit as human-readable string (e.g. "512m", "1g") or raw bytes, or null to clear.
    #[serde(default)]
    memory_limit: Option<String>,
    /// CPU cores limit (e.g. 0.5, 2.0), or null to clear.
    #[serde(default)]
    cpu_limit: Option<f64>,
    /// Restart policy: "no", "always", "unless-stopped", "on-failure".
    #[serde(default)]
    restart_policy: Option<String>,
}

async fn update_container(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<UpdateContainerRequest>,
) -> Result<impl IntoResponse, ApiError> {
    use orca_core::runtime::ContainerUpdateOpts;

    let memory_limit = body
        .memory_limit
        .as_deref()
        .map(parse_memory_string)
        .transpose()?;

    // If memory limit is set but no swap specified, set swap to 2x memory
    // (Docker default behavior when --memory-swap is not explicitly set)
    let memory_swap = memory_limit.map(|m| (m * 2) as i64);

    let opts = ContainerUpdateOpts {
        memory_limit,
        memory_swap,
        cpu_limit: body.cpu_limit,
        restart_policy: body.restart_policy,
    };

    state.rt().await.update_container(&id, opts).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
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
    /// Run as specific user (e.g., "1000:1000"). Maps to Docker's --user flag.
    #[serde(default)]
    user: Option<String>,
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
        entrypoint: None,
        remove_on_exit: false,
        cpu_limit: body.cpu_limit,
        memory_limit,
        memory_swap: None,
        gpu: false,
        user: body.user,
    };

    let id = state.rt().await.create_container(opts).await?;

    Ok((
        StatusCode::CREATED,
        Json(serde_json::json!({ "id": id })),
    ))
}

async fn container_stats(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<ContainerStats>, ApiError> {
    let stats = state.rt().await.container_stats(&id).await?;
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

    let result = state.rt().await.exec(opts).await?;
    Ok(Json(result))
}

// --- Interactive Terminal WebSocket ---

async fn container_terminal_ws(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
    ws: WebSocketUpgrade,
) -> Result<impl IntoResponse, StatusCode> {
    // WebSocket upgrades bypass the auth middleware (GET that upgrades),
    // so we check the token from a query parameter instead.
    let token = params.get("token").map(|s| s.as_str()).unwrap_or("");
    use subtle::ConstantTimeEq;
    if !state.api_token.is_empty()
        && (state.api_token.len() != token.len()
            || state.api_token.as_bytes().ct_eq(token.as_bytes()).unwrap_u8() != 1)
    {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(ws.on_upgrade(move |socket| handle_terminal(socket, state, id)))
}

async fn handle_terminal(socket: WebSocket, state: Arc<AppState>, container_id: String) {
    use bollard::exec::{CreateExecOptions, ResizeExecOptions, StartExecOptions, StartExecResults};

    // Create exec with TTY
    let exec = match state.rt().await.docker.create_exec(
        &container_id,
        CreateExecOptions {
            cmd: Some(vec![
                "sh".to_string(),
                "-c".to_string(),
                "if command -v bash > /dev/null 2>&1; then exec bash; else exec sh; fi"
                    .to_string(),
            ]),
            attach_stdin: Some(true),
            attach_stdout: Some(true),
            attach_stderr: Some(true),
            tty: Some(true),
            env: Some(vec!["TERM=xterm-256color".to_string(), "COLORTERM=truecolor".to_string()]),
            ..Default::default()
        },
    )
    .await
    {
        Ok(e) => e,
        Err(e) => {
            let (mut ws_sender, _) = socket.split();
            let _ = ws_sender
                .send(Message::Text(format!("\r\nFailed to create exec: {e}\r\n").into()))
                .await;
            return;
        }
    };

    let exec_id = exec.id.clone();

    // Start exec with TTY attached
    let start_opts = Some(StartExecOptions {
        detach: false,
        tty: true,
        ..Default::default()
    });

    match state.rt().await.docker.start_exec(&exec_id, start_opts).await {
        Ok(StartExecResults::Attached {
            mut output,
            mut input,
        }) => {
            let (mut ws_sender, mut ws_receiver) = socket.split();

            // Container stdout/stderr -> WebSocket
            let output_task = tokio::spawn(async move {
                use futures::stream::StreamExt;
                while let Some(Ok(log_output)) = output.next().await {
                    let bytes = log_output.into_bytes();
                    if ws_sender.send(Message::Binary(bytes.to_vec().into())).await.is_err() {
                        break;
                    }
                }
            });

            // WebSocket input -> Container stdin (+ resize handling)
            let exec_id_for_input = exec.id.clone();
            let docker = state.rt().await.docker.clone();
            let input_task = tokio::spawn(async move {
                while let Some(Ok(msg)) = ws_receiver.next().await {
                    match msg {
                        Message::Text(text) => {
                            // Check for resize message (JSON with cols/rows)
                            if let Ok(resize) = serde_json::from_str::<serde_json::Value>(&text) {
                                if let (Some(cols), Some(rows)) = (
                                    resize.get("cols").and_then(|c| c.as_u64()),
                                    resize.get("rows").and_then(|r| r.as_u64()),
                                ) {
                                    let _ = docker
                                        .resize_exec(
                                            &exec_id_for_input,
                                            ResizeExecOptions {
                                                width: cols as u16,
                                                height: rows as u16,
                                            },
                                        )
                                        .await;
                                    continue;
                                }
                            }
                            if input.write_all(text.as_bytes()).await.is_err() {
                                break;
                            }
                        }
                        Message::Binary(data) => {
                            if input.write_all(&data).await.is_err() {
                                break;
                            }
                        }
                        Message::Close(_) => break,
                        _ => {}
                    }
                }
            });

            // Wait for either task to complete
            tokio::select! {
                _ = output_task => {}
                _ = input_task => {}
            }
        }
        Ok(StartExecResults::Detached) => {
            let (mut ws_sender, _) = socket.split();
            let _ = ws_sender
                .send(Message::Text("\r\nExec started in detached mode\r\n".into()))
                .await;
        }
        Err(e) => {
            let (mut ws_sender, _) = socket.split();
            let _ = ws_sender
                .send(Message::Text(
                    format!("\r\nFailed to start exec: {e}\r\n").into(),
                ))
                .await;
        }
    }
}

// --- Container Export ---

async fn export_docker_run(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let container = state.rt().await.inspect_container(&id).await?;
    let cmd = orca_backend_common::export::container_to_docker_run(&container);
    Ok(Json(serde_json::json!({ "command": cmd })))
}

async fn export_compose(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let container = state.rt().await.inspect_container(&id).await?;
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

    let mut rx = state.rt().await.container_logs(&id, follow, tail).await?;

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
    let images = ImageManager::list(state.rt().await.as_ref()).await?;
    Ok(Json(images))
}

async fn inspect_image(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    // Return raw Docker inspect data (includes RootFS, Config, etc.)
    let raw = state.rt().await.docker.inspect_image(&id).await
        .map_err(|e| anyhow::anyhow!("Failed to inspect image: {e}"))?;
    Ok(Json(raw))
}

async fn image_history(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    tracing::debug!("image_history: id={id}");
    let history = state.rt().await.docker.image_history(&id).await
        .map_err(|e| {
            tracing::error!("image_history failed for {id}: {e}");
            anyhow::anyhow!("Failed to get image history: {e}")
        })?;
    tracing::debug!("image_history: got {} layers for {id}", history.len());
    Ok(Json(history))
}

async fn remove_image(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    ImageManager::remove(state.rt().await.as_ref(), &id, false).await?;
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
        state.rt().await
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
            state.rt().await
                .pull_with_auth(&body.reference, &registry_auth)
                .await?
        } else {
            drop(config);
            ImageManager::pull(state.rt().await.as_ref(), &body.reference).await?
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
    #[serde(default)]
    build_args: Option<HashMap<String, String>>,
}

async fn build_image(
    State(state): State<Arc<AppState>>,
    Json(body): Json<BuildRequest>,
) -> Result<Sse<impl tokio_stream::Stream<Item = Result<SseEvent, Infallible>>>, ApiError> {
    let mut rx = ImageManager::build(
        state.rt().await.as_ref(),
        &body.context_path,
        body.dockerfile.as_deref(),
        body.tag.as_deref(),
        body.build_args,
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
    let result = ImageManager::prune(state.rt().await.as_ref()).await?;
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
        match ImageManager::remove(state.rt().await.as_ref(), id, body.force).await {
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
    ImageManager::tag(state.rt().await.as_ref(), &source, &body.repo, &body.tag).await?;
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
    let volumes = VolumeManager::list(state.rt().await.as_ref()).await?;
    Ok(Json(volumes))
}

async fn inspect_volume(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let volume = VolumeManager::inspect(state.rt().await.as_ref(), &name).await?;
    Ok(Json(volume))
}

async fn remove_volume(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    VolumeManager::remove(state.rt().await.as_ref(), &name, false).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[allow(dead_code)]
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

    let volume = VolumeManager::create(state.rt().await.as_ref(), &body.name, labels).await?;
    Ok((StatusCode::CREATED, Json(volume)))
}

// --- Volume File Browsing ---

/// Ensure a helper image (e.g. alpine:latest) is available locally, pulling if needed.
async fn ensure_image(state: &Arc<AppState>, image: &str) -> Result<(), ApiError> {
    if state.rt().await.docker.inspect_image(image).await.is_ok() {
        return Ok(());
    }
    use bollard::image::CreateImageOptions;
    use futures::StreamExt;

    let (name, tag) = image.rsplit_once(':').unwrap_or((image, "latest"));
    let opts = CreateImageOptions {
        from_image: name,
        tag,
        ..Default::default()
    };
    let mut stream = state.rt().await.docker.create_image(Some(opts), None, None);
    while let Some(result) = stream.next().await {
        result.map_err(|e| anyhow::anyhow!("Failed to pull {image}: {e}"))?;
    }
    Ok(())
}

#[derive(Deserialize)]
struct VolumeFilesQuery {
    #[serde(default)]
    path: Option<String>,
}

async fn volume_list_files(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
    Query(query): Query<VolumeFilesQuery>,
) -> Result<impl IntoResponse, ApiError> {
    use orca_core::runtime::{ContainerCreateOpts, VolumeMount};

    let subpath = query.path.unwrap_or_default();
    let sanitized: String = subpath
        .split('/')
        .filter(|c| !c.is_empty() && *c != "." && *c != "..")
        .collect::<Vec<_>>()
        .join("/");
    let data_path = if sanitized.is_empty() {
        "/data".to_string()
    } else {
        format!("/data/{}", sanitized)
    };

    // Ensure alpine is available
    ensure_image(&state, "alpine:latest").await?;

    // Create a temporary container to list files
    let opts = ContainerCreateOpts {
        image: "alpine:latest".to_string(),
        name: None,
        command: vec![
            "ls".to_string(),
            "-la".to_string(),
            data_path.clone(),
        ],
        env: HashMap::new(),
        ports: vec![],
        volumes: vec![VolumeMount {
            source: name.clone(),
            target: "/data".to_string(),
            read_only: true,
        }],
        labels: HashMap::new(),
        restart_policy: None,
        network: None,
        detach: false,
        entrypoint: None,
        remove_on_exit: false,
        cpu_limit: None,
        memory_limit: None,
        memory_swap: None,
        gpu: false,
        user: None,
    };

    let id = state.rt().await.create_container(opts).await?;
    state.rt().await.start_container(&id).await?;

    // Wait for container to finish
    {
        use bollard::container::WaitContainerOptions;
        use futures::StreamExt;
        let wait_opts = WaitContainerOptions { condition: "not-running" };
        let _ = tokio::time::timeout(
            Duration::from_secs(10),
            state.rt().await.docker.wait_container(&id, Some(wait_opts)).next(),
        ).await;
    }

    // Collect logs
    let log_rx = state.rt().await.container_logs(&id, false, Some(1000)).await?;
    let mut lines = Vec::new();
    let mut rx = log_rx;
    while let Some(line) = rx.recv().await {
        lines.push(line);
    }

    // Check exit code
    let exit_code = match state.rt().await.inspect_container(&id).await {
        Ok(info) => info.exit_code,
        Err(_) => None,
    };

    // Clean up
    let _ = state.rt().await.remove_container(&id, true).await;

    // If the container exited with non-zero, return an error
    if let Some(code) = exit_code {
        if code != 0 {
            // Lines likely contain stderr/error output
            let stderr = lines.join("\n");
            let msg = if stderr.is_empty() {
                format!("Command failed with exit code {code}")
            } else {
                format!("Command failed with exit code {code}: {stderr}")
            };
            return Err(anyhow::anyhow!("{msg}").into());
        }
    }

    // Parse ls -la output into structured data
    let mut entries = Vec::new();
    for line in &lines {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("total") {
            continue;
        }
        // ls -la columns: permissions links owner group size month day time/year name...
        let parts: Vec<&str> = trimmed.split_whitespace().collect();
        if parts.len() >= 9 {
            let permissions = parts[0];
            let is_dir = permissions.starts_with('d');
            let size_str = parts[4];
            let modified = format!("{} {} {}", parts[5], parts[6], parts[7]);
            let name_part = parts[8..].join(" ");
            if name_part == "." || name_part == ".." {
                continue;
            }
            entries.push(serde_json::json!({
                "name": name_part,
                "size": size_str,
                "permissions": permissions,
                "modified": modified,
                "is_dir": is_dir,
            }));
        }
    }

    // Empty entries is valid — directory might just be empty (only . and ..)
    Ok(Json(serde_json::json!({ "entries": entries, "path": sanitized })))
}

async fn volume_read_file(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
    Query(query): Query<VolumeFilesQuery>,
) -> Result<impl IntoResponse, ApiError> {
    use orca_core::runtime::{ContainerCreateOpts, VolumeMount};

    let file_path = query.path.unwrap_or_default();
    let sanitized: String = file_path
        .split('/')
        .filter(|c| !c.is_empty() && *c != "." && *c != "..")
        .collect::<Vec<_>>()
        .join("/");
    let data_path = format!("/data/{}", sanitized);

    ensure_image(&state, "alpine:latest").await?;

    let opts = ContainerCreateOpts {
        image: "alpine:latest".to_string(),
        name: None,
        command: vec!["cat".to_string(), data_path],
        env: HashMap::new(),
        ports: vec![],
        volumes: vec![VolumeMount {
            source: name.clone(),
            target: "/data".to_string(),
            read_only: true,
        }],
        labels: HashMap::new(),
        restart_policy: None,
        network: None,
        detach: false,
        entrypoint: None,
        remove_on_exit: false,
        cpu_limit: None,
        memory_limit: None,
        memory_swap: None,
        gpu: false,
        user: None,
    };

    let id = state.rt().await.create_container(opts).await?;
    state.rt().await.start_container(&id).await?;

    // Wait for container to finish
    {
        use bollard::container::WaitContainerOptions;
        use futures::StreamExt;
        let wait_opts = WaitContainerOptions { condition: "not-running" };
        let _ = tokio::time::timeout(
            Duration::from_secs(10),
            state.rt().await.docker.wait_container(&id, Some(wait_opts)).next(),
        ).await;
    }

    let log_rx = state.rt().await.container_logs(&id, false, Some(10000)).await?;
    let mut lines = Vec::new();
    let mut rx = log_rx;
    while let Some(line) = rx.recv().await {
        lines.push(line);
    }

    let _ = state.rt().await.remove_container(&id, true).await;

    Ok(Json(serde_json::json!({ "content": lines.join("\n") })))
}

// --- Image File Browsing ---

async fn image_list_files(
    State(state): State<Arc<AppState>>,
    Path(image_id): Path<String>,
    Query(query): Query<VolumeFilesQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let image_ref = resolve_image_ref(&state, &image_id).await?;

    let subpath = query.path.unwrap_or_default();
    let sanitized: String = subpath
        .split('/')
        .filter(|c| !c.is_empty() && *c != "." && *c != "..")
        .collect::<Vec<_>>()
        .join("/");
    let browse_path = if sanitized.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", sanitized)
    };

    let lines = run_in_image(&state.rt().await.docker, &image_ref,
        vec!["ls", "-la", &browse_path]).await?;

    let mut entries = Vec::new();
    for line in &lines {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("total") {
            continue;
        }
        // ls -la columns: permissions links owner group size month day time/year name...
        let parts: Vec<&str> = trimmed.split_whitespace().collect();
        if parts.len() >= 9 {
            let permissions = parts[0];
            let is_dir = permissions.starts_with('d');
            let size_str = parts[4];
            let modified = format!("{} {} {}", parts[5], parts[6], parts[7]);
            let name_part = parts[8..].join(" ");
            if name_part == "." || name_part == ".." {
                continue;
            }
            // Strip symlink targets (e.g. "bin -> usr/bin")
            let display_name = if let Some(arrow) = name_part.find(" -> ") {
                &name_part[..arrow]
            } else {
                &name_part
            };
            let is_link = permissions.starts_with('l');
            entries.push(serde_json::json!({
                "name": display_name,
                "size": size_str,
                "permissions": permissions,
                "modified": &modified,
                "is_dir": is_dir || is_link,
                "link_target": if is_link { name_part.find(" -> ").map(|i| &name_part[i+4..]) } else { None },
            }));
        }
    }

    Ok(Json(serde_json::json!({ "entries": entries, "path": sanitized })))
}

async fn image_read_file(
    State(state): State<Arc<AppState>>,
    Path(image_id): Path<String>,
    Query(query): Query<VolumeFilesQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let image_ref = resolve_image_ref(&state, &image_id).await?;

    let file_path = query.path.unwrap_or_default();
    let sanitized: String = file_path
        .split('/')
        .filter(|c| !c.is_empty() && *c != "." && *c != "..")
        .collect::<Vec<_>>()
        .join("/");
    let full_path = format!("/{}", sanitized);

    let lines = run_in_image(&state.rt().await.docker, &image_ref,
        vec!["cat", &full_path]).await?;

    Ok(Json(serde_json::json!({ "content": lines.join("\n") })))
}

/// Run a command inside an image by creating a temporary container,
/// waiting for it to finish, collecting output, and cleaning up.
async fn run_in_image(
    docker: &bollard::Docker,
    image: &str,
    cmd: Vec<&str>,
) -> anyhow::Result<Vec<String>> {
    use bollard::container::{Config, CreateContainerOptions, LogsOptions, WaitContainerOptions};
    use bollard::models::ContainerWaitResponse;
    use futures::StreamExt;

    // Use /bin/sh -c to run the command, bypassing the image's entrypoint
    let shell_cmd = cmd.iter().map(|s| shell_escape(s)).collect::<Vec<_>>().join(" ");
    tracing::debug!("run_in_image: image={image}, cmd={shell_cmd}");
    let config = Config {
        image: Some(image.to_string()),
        entrypoint: Some(vec!["/bin/sh".to_string(), "-c".to_string(), shell_cmd.clone()]),
        cmd: Some(vec![]),
        ..Default::default()
    };

    let container = docker
        .create_container(None::<CreateContainerOptions<String>>, config)
        .await
        .map_err(|e| {
            tracing::error!("run_in_image: failed to create container for {image}: {e}");
            anyhow::anyhow!("Failed to create container: {e}")
        })?;

    let id = &container.id;

    docker.start_container::<String>(id, None).await
        .map_err(|e| {
            tracing::error!("run_in_image: failed to start container {id}: {e}");
            anyhow::anyhow!("Failed to start container: {e}")
        })?;

    // Wait for the container to finish (max 10 seconds)
    let wait_opts = WaitContainerOptions { condition: "not-running" };
    let wait_result = tokio::time::timeout(
        Duration::from_secs(10),
        docker.wait_container(id, Some(wait_opts)).next(),
    ).await;

    let exit_code = match wait_result {
        Ok(Some(Ok(ContainerWaitResponse { status_code, .. }))) => Some(status_code),
        _ => None,
    };

    // Collect stdout
    let stdout_opts = LogsOptions::<String> {
        stdout: true,
        stderr: false,
        ..Default::default()
    };
    let mut stdout_lines = Vec::new();
    let mut stream = docker.logs(id, Some(stdout_opts));
    while let Some(Ok(output)) = stream.next().await {
        let text = output.to_string();
        for line in text.lines() {
            if !line.is_empty() {
                stdout_lines.push(line.to_string());
            }
        }
    }

    // Collect stderr
    let stderr_opts = LogsOptions::<String> {
        stdout: false,
        stderr: true,
        ..Default::default()
    };
    let mut stderr_lines = Vec::new();
    let mut stream = docker.logs(id, Some(stderr_opts));
    while let Some(Ok(output)) = stream.next().await {
        let text = output.to_string();
        for line in text.lines() {
            if !line.is_empty() {
                stderr_lines.push(line.to_string());
            }
        }
    }

    // Clean up
    let _ = docker.remove_container(id, Some(bollard::container::RemoveContainerOptions {
        force: true,
        ..Default::default()
    })).await;

    // If the container exited with non-zero, return an error with stderr
    if let Some(code) = exit_code {
        if code != 0 {
            let stderr = stderr_lines.join("\n");
            let msg = if stderr.is_empty() {
                format!("Command failed with exit code {code}")
            } else {
                format!("Command failed with exit code {code}: {stderr}")
            };
            return Err(anyhow::anyhow!("{msg}"));
        }
    }

    Ok(stdout_lines)
}

/// Simple shell escaping for arguments.
fn shell_escape(s: &str) -> String {
    if s.chars().all(|c| c.is_alphanumeric() || c == '/' || c == '.' || c == '-' || c == '_') {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

// --- Container File Browsing ---

async fn container_list_files(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<VolumeFilesQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let subpath = query.path.unwrap_or_default();
    let sanitized: String = subpath
        .split('/')
        .filter(|c| !c.is_empty() && *c != "." && *c != "..")
        .collect::<Vec<_>>()
        .join("/");
    let browse_path = if sanitized.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", sanitized)
    };

    let lines = run_in_container(&state.rt().await.docker, &id,
        vec!["ls", "-la", &browse_path]).await?;

    let mut entries = Vec::new();
    for line in &lines {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("total") {
            continue;
        }
        let parts: Vec<&str> = trimmed.split_whitespace().collect();
        if parts.len() >= 9 {
            let permissions = parts[0];
            let is_dir = permissions.starts_with('d');
            let size_str = parts[4];
            let modified = format!("{} {} {}", parts[5], parts[6], parts[7]);
            let name_part = parts[8..].join(" ");
            if name_part == "." || name_part == ".." {
                continue;
            }
            let display_name = if let Some(arrow) = name_part.find(" -> ") {
                &name_part[..arrow]
            } else {
                &name_part
            };
            let is_link = permissions.starts_with('l');
            entries.push(serde_json::json!({
                "name": display_name,
                "size": size_str,
                "permissions": permissions,
                "modified": &modified,
                "is_dir": is_dir || is_link,
                "link_target": if is_link { name_part.find(" -> ").map(|i| &name_part[i+4..]) } else { None },
            }));
        }
    }

    Ok(Json(serde_json::json!({ "entries": entries, "path": sanitized })))
}

async fn container_read_file(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<VolumeFilesQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let file_path = query.path.unwrap_or_default();
    let sanitized: String = file_path
        .split('/')
        .filter(|c| !c.is_empty() && *c != "." && *c != "..")
        .collect::<Vec<_>>()
        .join("/");
    let full_path = format!("/{}", sanitized);

    let lines = run_in_container(&state.rt().await.docker, &id,
        vec!["cat", &full_path]).await?;

    Ok(Json(serde_json::json!({ "content": lines.join("\n") })))
}

/// Run a command inside a running container using docker exec,
/// collecting stdout and returning lines.
async fn run_in_container(
    docker: &bollard::Docker,
    container_id: &str,
    cmd: Vec<&str>,
) -> anyhow::Result<Vec<String>> {
    use bollard::exec::{CreateExecOptions, StartExecResults};
    use futures::StreamExt;

    let exec = docker.create_exec(container_id, CreateExecOptions {
        cmd: Some(cmd.iter().map(|s| s.to_string()).collect()),
        attach_stdout: Some(true),
        attach_stderr: Some(true),
        ..Default::default()
    }).await.map_err(|e| anyhow::anyhow!("Failed to create exec: {e}"))?;

    let output = docker.start_exec(&exec.id, None).await
        .map_err(|e| anyhow::anyhow!("Failed to start exec: {e}"))?;

    let mut stdout_lines = Vec::new();
    let mut stderr_lines = Vec::new();

    if let StartExecResults::Attached { mut output, .. } = output {
        while let Some(Ok(msg)) = output.next().await {
            let is_stderr = matches!(msg, bollard::container::LogOutput::StdErr { .. });
            let text = msg.to_string();
            for line in text.lines() {
                if !line.is_empty() {
                    if is_stderr {
                        stderr_lines.push(line.to_string());
                    } else {
                        stdout_lines.push(line.to_string());
                    }
                }
            }
        }
    }

    // Check exit code
    let inspect = docker.inspect_exec(&exec.id).await
        .map_err(|e| anyhow::anyhow!("Failed to inspect exec: {e}"))?;

    if let Some(code) = inspect.exit_code {
        if code != 0 {
            let stderr = stderr_lines.join("\n");
            let msg = if stderr.is_empty() {
                format!("Command failed with exit code {code}")
            } else {
                format!("Command failed with exit code {code}: {stderr}")
            };
            return Err(anyhow::anyhow!("{msg}"));
        }
    }

    Ok(stdout_lines)
}

// --- Container Commit ---

#[derive(Deserialize)]
struct CommitRequest {
    repo: String,
    #[serde(default)]
    tag: Option<String>,
}

async fn commit_container(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<CommitRequest>,
) -> Result<impl IntoResponse, ApiError> {
    use bollard::image::CommitContainerOptions;
    use bollard::container::Config;

    let tag_value = body.tag.unwrap_or_else(|| "latest".into());
    let options = CommitContainerOptions {
        container: id.clone(),
        repo: body.repo.clone(),
        tag: tag_value.clone(),
        comment: String::new(),
        author: String::new(),
        pause: true,
        changes: None,
    };
    let config = Config::<String> {
        ..Default::default()
    };
    let result = state.rt().await.docker.commit_container(options, config).await
        .map_err(|e| anyhow::anyhow!("Commit failed: {e}"))?;

    Ok(Json(serde_json::json!({ "id": result.id.unwrap_or_default() })))
}

// --- Image Import ---

#[derive(Deserialize)]
struct ImportImageRequest {
    path: String,
}

async fn import_image(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ImportImageRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let file = tokio::fs::read(&body.path).await
        .map_err(|e| anyhow::anyhow!("Failed to read file: {e}"))?;
    let mut stream = state.rt().await.docker.import_image(
        bollard::image::ImportImageOptions { quiet: false },
        file.into(),
        None,
    );
    use futures::StreamExt;
    let mut messages = Vec::new();
    while let Some(result) = stream.next().await {
        match result {
            Ok(info) => if let Some(status) = info.status { messages.push(status); },
            Err(e) => messages.push(format!("Error: {e}")),
        }
    }
    Ok(Json(serde_json::json!({ "messages": messages })))
}

// --- Container Export (tar) ---

#[derive(Deserialize)]
struct ExportContainerQuery {
    path: String,
}

async fn export_container_tar(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<ExportContainerQuery>,
) -> Result<impl IntoResponse, ApiError> {
    use futures::StreamExt;
    use tokio::io::AsyncWriteExt;

    let docker = &state.rt().await.docker;
    let mut stream = docker.export_container(&id);
    let mut file = tokio::fs::File::create(&query.path).await
        .map_err(|e| anyhow::anyhow!("Failed to create file: {e}"))?;

    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| anyhow::anyhow!("Export stream error: {e}"))?;
        file.write_all(&bytes).await
            .map_err(|e| anyhow::anyhow!("Failed to write file: {e}"))?;
    }
    file.flush().await.map_err(|e| anyhow::anyhow!("Failed to flush file: {e}"))?;

    Ok(Json(serde_json::json!({ "ok": true })))
}

// --- Image Save (tar) ---

#[derive(Deserialize)]
struct SaveImageQuery {
    path: String,
}

async fn save_image_tar(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<SaveImageQuery>,
) -> Result<impl IntoResponse, ApiError> {
    use futures::StreamExt;
    use tokio::io::AsyncWriteExt;

    let image_ref = resolve_image_ref(&state, &id).await?;
    let docker = &state.rt().await.docker;
    let mut stream = docker.export_image(&image_ref);
    let mut file = tokio::fs::File::create(&query.path).await
        .map_err(|e| anyhow::anyhow!("Failed to create file: {e}"))?;

    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| anyhow::anyhow!("Export stream error: {e}"))?;
        file.write_all(&bytes).await
            .map_err(|e| anyhow::anyhow!("Failed to write file: {e}"))?;
    }
    file.flush().await.map_err(|e| anyhow::anyhow!("Failed to flush file: {e}"))?;

    Ok(Json(serde_json::json!({ "ok": true })))
}

/// Resolve an image ID to a usable reference (repo:tag or full sha).
async fn resolve_image_ref(state: &AppState, id: &str) -> anyhow::Result<String> {
    let images: Vec<orca_core::image::Image> = ImageManager::list(state.rt().await.as_ref()).await?;
    if let Some(img) = images.iter().find(|i| i.id == id || i.id.contains(id)) {
        // Prefer a repo:tag if available
        if let Some(tag) = img.repo_tags.first() {
            if tag != "<none>:<none>" {
                return Ok(tag.clone());
            }
        }
        Ok(img.id.clone())
    } else {
        Ok(id.to_string())
    }
}

/// Scan an image for vulnerabilities using Trivy (run as a container).
async fn scan_image(
    State(state): State<Arc<AppState>>,
    Path(image_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    use bollard::container::{Config, CreateContainerOptions, LogsOptions, WaitContainerOptions};
    use bollard::models::{HostConfig, Mount, MountTypeEnum};
    use futures::StreamExt;

    tracing::info!("scan_image: starting scan for {image_id}");
    let image_ref = resolve_image_ref(&state, &image_id).await?;
    let docker = &state.rt().await.docker;

    // The Docker socket to mount into the Trivy container.
    // Inside a Lima/Colima VM, Docker's socket is always at /var/run/docker.sock
    // even though the *host* accesses it via ~/.lima/orca/sock/docker.sock.
    // We must use the in-VM path since the container runs inside the VM.
    let socket_path = "/var/run/docker.sock".to_string();
    tracing::debug!("scan_image: mounting docker socket at {socket_path}");

    // Run Trivy as a container with access to the Docker socket
    let config = Config {
        image: Some("ghcr.io/aquasecurity/trivy:latest".to_string()),
        cmd: Some(vec![
            "image".to_string(),
            "--format".to_string(),
            "json".to_string(),
            "--quiet".to_string(),
            image_ref.clone(),
        ]),
        host_config: Some(HostConfig {
            mounts: Some(vec![Mount {
                target: Some("/var/run/docker.sock".to_string()),
                source: Some(socket_path),
                typ: Some(MountTypeEnum::BIND),
                read_only: Some(true),
                ..Default::default()
            }]),
            ..Default::default()
        }),
        ..Default::default()
    };

    let container = match docker
        .create_container(None::<CreateContainerOptions<String>>, config.clone())
        .await
    {
        Ok(c) => c,
        Err(e) => {
            let err_str = e.to_string();
            if err_str.contains("404") || err_str.contains("No such image") {
                // Auto-pull the Trivy image
                use bollard::image::CreateImageOptions;
                tracing::info!("scan_image: pulling ghcr.io/aquasecurity/trivy:latest...");
                let pull_opts = CreateImageOptions {
                    from_image: "ghcr.io/aquasecurity/trivy",
                    tag: "latest",
                    platform: "linux/amd64", // Trivy works best on amd64, even on Apple Silicon via emulation
                    ..Default::default()
                };
                let mut pull_stream = docker.create_image(Some(pull_opts), None, None);
                while let Some(result) = pull_stream.next().await {
                    match result {
                        Ok(info) => {
                            if let Some(status) = &info.status {
                                tracing::debug!("scan_image pull: {status}");
                            }
                        }
                        Err(e) => {
                            tracing::error!("scan_image: pull error: {e}");
                            return Err(anyhow::anyhow!("Failed to pull Trivy image: {e}").into());
                        }
                    }
                }
                tracing::info!("scan_image: pull complete, retrying container creation");

                // Retry container creation
                docker
                    .create_container(None::<CreateContainerOptions<String>>, config)
                    .await
                    .map_err(|e2| {
                        tracing::error!("scan_image: still can't create container after pull: {e2}");
                        anyhow::anyhow!(
                            "Failed to create Trivy container after pulling image: {e2}"
                        )
                    })?
            } else {
                return Err(anyhow::anyhow!(
                    "Failed to start Trivy scanner: {e}"
                ).into());
            }
        }
    };

    let id = &container.id;

    docker.start_container::<String>(id, None).await
        .map_err(|e| {
            tracing::error!("scan_image: failed to start Trivy container: {e}");
            anyhow::anyhow!("Failed to start Trivy container: {e}")
        })?;

    // Trivy scans can take a while — wait up to 5 minutes
    let wait_opts = WaitContainerOptions { condition: "not-running" };
    let _ = tokio::time::timeout(
        Duration::from_secs(300),
        docker.wait_container(id, Some(wait_opts)).next(),
    ).await;

    // Collect stdout and stderr
    let log_opts_out = LogsOptions::<String> {
        stdout: true,
        stderr: false,
        ..Default::default()
    };
    let log_opts_err = LogsOptions::<String> {
        stdout: false,
        stderr: true,
        ..Default::default()
    };

    let mut stdout = String::new();
    let mut stream = docker.logs(id, Some(log_opts_out));
    while let Some(Ok(chunk)) = stream.next().await {
        stdout.push_str(&chunk.to_string());
    }

    let mut stderr = String::new();
    let mut stream = docker.logs(id, Some(log_opts_err));
    while let Some(Ok(chunk)) = stream.next().await {
        stderr.push_str(&chunk.to_string());
    }

    // Clean up
    let _ = docker.remove_container(id, Some(bollard::container::RemoveContainerOptions {
        force: true,
        ..Default::default()
    })).await;

    // If no stdout, return error with stderr details
    if stdout.trim().is_empty() {
        let detail = if stderr.trim().is_empty() {
            "Trivy produced no output. The image may not exist or the Docker socket may not be accessible.".to_string()
        } else {
            format!("Trivy error:\n{}", stderr.trim())
        };
        return Ok(Json(serde_json::json!({
            "error": detail,
            "total": 0, "critical": 0, "high": 0, "medium": 0, "low": 0,
        })));
    }

    // Parse the Trivy JSON output
    let trivy_results: serde_json::Value = match serde_json::from_str(&stdout) {
        Ok(v) => v,
        Err(e) => {
            return Ok(Json(serde_json::json!({
                "error": format!("Failed to parse Trivy output: {e}\n\nRaw output (first 500 chars):\n{}", &stdout[..stdout.len().min(500)]),
                "total": 0, "critical": 0, "high": 0, "medium": 0, "low": 0,
            })));
        }
    };

    // Count vulnerabilities by severity
    let mut critical = 0u64;
    let mut high = 0u64;
    let mut medium = 0u64;
    let mut low = 0u64;

    if let Some(results) = trivy_results.get("Results").and_then(|r| r.as_array()) {
        for result in results {
            if let Some(vulns) = result.get("Vulnerabilities").and_then(|v| v.as_array()) {
                for vuln in vulns {
                    match vuln.get("Severity").and_then(|s| s.as_str()) {
                        Some("CRITICAL") => critical += 1,
                        Some("HIGH") => high += 1,
                        Some("MEDIUM") => medium += 1,
                        Some("LOW") | Some("UNKNOWN") => low += 1,
                        _ => low += 1,
                    }
                }
            }
        }
    }

    let total = critical + high + medium + low;

    Ok(Json(serde_json::json!({
        "total": total,
        "critical": critical,
        "high": high,
        "medium": medium,
        "low": low,
        "results": trivy_results.get("Results").cloned().unwrap_or(serde_json::json!([])),
    })))
}

async fn volume_containers(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let containers = state.rt().await.list_containers(true).await?;
    let using_volume: Vec<_> = containers
        .into_iter()
        .filter(|c| {
            c.mounts.as_ref().map_or(false, |mounts| {
                mounts.iter().any(|m| m.source == name || m.source.ends_with(&format!("/{name}")))
            })
        })
        .collect();

    Ok(Json(using_volume))
}

// --- Networks ---

async fn list_networks(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, ApiError> {
    let networks = NetworkManager::list(state.rt().await.as_ref()).await?;
    Ok(Json(networks))
}

async fn inspect_network(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let network = NetworkManager::inspect(state.rt().await.as_ref(), &name).await?;
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
    let network = NetworkManager::create(state.rt().await.as_ref(), &body.name, &body.driver).await?;
    Ok((StatusCode::CREATED, Json(network)))
}

async fn remove_network_handler(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    NetworkManager::remove(state.rt().await.as_ref(), &name).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn network_topology(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, ApiError> {
    let networks = state.rt().await.docker.list_networks::<String>(None).await
        .map_err(|e| ApiError(anyhow::anyhow!("Failed to list networks: {e}")))?;

    let mut topology = Vec::new();
    for net in &networks {
        let net_name = net.name.clone().unwrap_or_default();
        let net_id = net.id.clone().unwrap_or_default();
        let driver = net.driver.clone().unwrap_or_default();

        let (subnet, gateway) = net
            .ipam
            .as_ref()
            .and_then(|ipam| ipam.config.as_ref())
            .and_then(|configs: &Vec<_>| configs.first())
            .map(|c| (c.subnet.clone(), c.gateway.clone()))
            .unwrap_or((None, None));

        // Inspect the network to get connected containers (list doesn't include them)
        let mut containers = Vec::new();
        if let Ok(detail) = state.rt().await.docker.inspect_network::<String>(&net_id, None).await {
            if let Some(ref cmap) = detail.containers {
                for (cid, endpoint) in cmap {
                    let cname = endpoint.name.clone()
                        .unwrap_or_else(|| cid[..12.min(cid.len())].to_string());
                    let ip = endpoint.ipv4_address.clone()
                        .unwrap_or_default();
                    containers.push(serde_json::json!({
                        "id": cid,
                        "name": cname,
                        "ip": ip,
                    }));
                }
            }
        }

        topology.push(serde_json::json!({
            "id": net_id,
            "name": net_name,
            "driver": driver,
            "subnet": subnet,
            "gateway": gateway,
            "containers": containers,
        }));
    }

    Ok(Json(topology))
}

// --- Stacks (Compose Projects) ---

async fn get_stacks(
    state: &AppState,
) -> Result<Vec<compose::ComposeProject>, ApiError> {
    let containers = state.rt().await.list_containers(true).await?;
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
            if let Err(e) = state.rt().await.start_container(&service.container_id).await {
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
            if let Err(e) = state.rt().await.stop_container(&service.container_id, 10).await {
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
            if let Err(e) = state.rt().await.stop_container(&service.container_id, 10).await {
                errors.push(format!("stop {}: {e}", service.name));
            }
        }
    }
    // Start all
    for service in &stack.services {
        if let Err(e) = state.rt().await.start_container(&service.container_id).await {
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
    let output = state.rt().await
        .compose_up(&dir, config.as_deref())
        .await?;
    Ok(Json(output))
}

async fn compose_down(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let (dir, config) = resolve_stack_dir(&state, &name).await?;
    let output = state.rt().await
        .compose_down(&dir, config.as_deref())
        .await?;
    Ok(Json(output))
}

async fn compose_pull(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let (dir, config) = resolve_stack_dir(&state, &name).await?;
    let output = state.rt().await
        .compose_pull(&dir, config.as_deref())
        .await?;
    Ok(Json(output))
}

// --- Kubernetes ---

async fn k8s_status(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, ApiError> {
    // Timeout prevents hanging when kubeconfig points to unreachable cluster
    match tokio::time::timeout(
        Duration::from_secs(10),
        state.k8s.status(),
    ).await {
        Ok(result) => Ok(Json(result?)),
        Err(_) => {
            tracing::warn!("K8s status timed out after 10s");
            Ok(Json(orca_core::kubernetes::ClusterStatus {
                enabled: false,
                running: false,
                version: None, node_name: None, node_status: None,
                pods_running: 0, pods_total: 0, traefik_dashboard: None,
                error: Some("Kubernetes status check timed out".to_string()),
            }))
        }
    }
}

async fn k8s_enable(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, ApiError> {
    let log = state.k8s.enable_with_progress().await?;
    Ok(Json(serde_json::json!({ "output": log })))
}

async fn k8s_enable_ws(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
    ws: WebSocketUpgrade,
) -> Result<impl IntoResponse, StatusCode> {
    // Auth check (same as terminal WS)
    let token = params.get("token").map(|s| s.as_str()).unwrap_or("");
    use subtle::ConstantTimeEq;
    if !state.api_token.is_empty()
        && (state.api_token.len() != token.len()
            || state.api_token.as_bytes().ct_eq(token.as_bytes()).unwrap_u8() != 1)
    {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(ws.on_upgrade(move |socket| handle_k8s_enable(socket, state)))
}

async fn handle_k8s_enable(mut socket: WebSocket, state: Arc<AppState>) {
    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(100);
    let k8s = state.k8s.clone();

    // Spawn the enable task
    tokio::spawn(async move {
        match k8s.enable_streaming(tx.clone()).await {
            Ok(_) => { let _ = tx.send("[DONE]".into()).await; }
            Err(e) => {
                for line in e.to_string().lines() {
                    let _ = tx.send(line.to_string()).await;
                }
                let _ = tx.send("[ERROR]".into()).await;
            }
        }
    });

    // Forward progress lines to WebSocket
    while let Some(line) = rx.recv().await {
        if socket.send(Message::Text(line.into())).await.is_err() {
            break;
        }
    }
    let _ = socket.close().await;
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

async fn k8s_get_yaml(
    State(state): State<Arc<AppState>>,
    Path((kind, namespace, name)): Path<(String, String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    let yaml = state.k8s.get_resource_yaml(&kind, &name, &namespace).await?;
    Ok(yaml)
}

async fn k8s_events(
    State(state): State<Arc<AppState>>,
    Path(namespace): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let events = state.k8s.list_events(&namespace).await?;
    Ok(Json(events))
}

#[derive(Deserialize)]
struct CreateNamespaceRequest {
    name: String,
}

async fn k8s_create_namespace(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateNamespaceRequest>,
) -> Result<impl IntoResponse, ApiError> {
    state.k8s.create_namespace(&body.name).await?;
    Ok(StatusCode::CREATED)
}

async fn k8s_delete_namespace(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    state.k8s.delete_namespace(&name).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn k8s_configmaps(
    State(state): State<Arc<AppState>>,
    Path(namespace): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let cms = state.k8s.list_configmaps(&namespace).await?;
    Ok(Json(cms))
}

async fn k8s_secrets(
    State(state): State<Arc<AppState>>,
    Path(namespace): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let secrets = state.k8s.list_secrets(&namespace).await?;
    Ok(Json(secrets))
}

#[derive(Deserialize)]
struct CreateSecretRequest {
    name: String,
    data: HashMap<String, String>,
    #[serde(default)]
    secret_type: Option<String>,
}

async fn k8s_create_secret(
    State(state): State<Arc<AppState>>,
    Path(namespace): Path<String>,
    Json(body): Json<CreateSecretRequest>,
) -> Result<impl IntoResponse, ApiError> {
    state
        .k8s
        .create_secret(&namespace, &body.name, body.data, body.secret_type.as_deref())
        .await?;
    Ok(StatusCode::CREATED)
}

async fn k8s_delete_secret(
    State(state): State<Arc<AppState>>,
    Path((namespace, name)): Path<(String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    state.k8s.delete_secret(&namespace, &name).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct UpdateSecretRequest {
    data: HashMap<String, String>,
}

async fn k8s_update_secret(
    State(state): State<Arc<AppState>>,
    Path((namespace, name)): Path<(String, String)>,
    Json(body): Json<UpdateSecretRequest>,
) -> Result<impl IntoResponse, ApiError> {
    state.k8s.update_secret(&namespace, &name, body.data).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct CreatePvcRequest {
    name: String,
    storage_class: String,
    size: String,
    access_modes: Vec<String>,
}

async fn k8s_create_pvc(
    State(state): State<Arc<AppState>>,
    Path(namespace): Path<String>,
    Json(body): Json<CreatePvcRequest>,
) -> Result<impl IntoResponse, ApiError> {
    state
        .k8s
        .create_pvc(&namespace, &body.name, &body.storage_class, &body.size, body.access_modes)
        .await?;
    Ok(StatusCode::CREATED)
}

async fn k8s_pod_metrics(
    State(state): State<Arc<AppState>>,
    Path(namespace): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let metrics = state.k8s.list_pod_metrics(&namespace).await?;
    Ok(Json(metrics))
}

async fn k8s_rollout_history(
    State(state): State<Arc<AppState>>,
    Path((namespace, name)): Path<(String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    let history = state.k8s.rollout_history(&namespace, &name).await?;
    Ok(Json(history))
}

#[derive(Deserialize)]
struct RollbackRequest {
    revision: Option<u32>,
}

async fn k8s_rollout_undo(
    State(state): State<Arc<AppState>>,
    Path((namespace, name)): Path<(String, String)>,
    Json(body): Json<RollbackRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let result = state.k8s.rollout_undo(&namespace, &name, body.revision).await?;
    Ok(Json(serde_json::json!({ "output": result })))
}

// --- DaemonSets / StatefulSets / ReplicaSets ---

async fn k8s_daemonsets(
    State(state): State<Arc<AppState>>,
    Path(namespace): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let items = state.k8s.list_daemonsets(&namespace).await?;
    Ok(Json(items))
}

async fn k8s_statefulsets(
    State(state): State<Arc<AppState>>,
    Path(namespace): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let items = state.k8s.list_statefulsets(&namespace).await?;
    Ok(Json(items))
}

async fn k8s_replicasets(
    State(state): State<Arc<AppState>>,
    Path(namespace): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let items = state.k8s.list_replicasets(&namespace).await?;
    Ok(Json(items))
}

async fn k8s_scale_statefulset(
    State(state): State<Arc<AppState>>,
    Path((namespace, name)): Path<(String, String)>,
    Json(body): Json<ScaleRequest>,
) -> Result<impl IntoResponse, ApiError> {
    state
        .k8s
        .scale_statefulset(&namespace, &name, body.replicas)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn k8s_restart_statefulset(
    State(state): State<Arc<AppState>>,
    Path((namespace, name)): Path<(String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    state.k8s.restart_statefulset(&namespace, &name).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn k8s_delete_daemonset(
    State(state): State<Arc<AppState>>,
    Path((namespace, name)): Path<(String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    state.k8s.delete_daemonset(&namespace, &name).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn k8s_delete_statefulset(
    State(state): State<Arc<AppState>>,
    Path((namespace, name)): Path<(String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    state.k8s.delete_statefulset(&namespace, &name).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn k8s_delete_replicaset(
    State(state): State<Arc<AppState>>,
    Path((namespace, name)): Path<(String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    state.k8s.delete_replicaset(&namespace, &name).await?;
    Ok(StatusCode::NO_CONTENT)
}

// --- Jobs / CronJobs ---

async fn k8s_jobs(
    State(state): State<Arc<AppState>>,
    Path(namespace): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let jobs = state.k8s.list_jobs(&namespace).await?;
    Ok(Json(jobs))
}

async fn k8s_cronjobs(
    State(state): State<Arc<AppState>>,
    Path(namespace): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let cronjobs = state.k8s.list_cronjobs(&namespace).await?;
    Ok(Json(cronjobs))
}

async fn k8s_trigger_cronjob(
    State(state): State<Arc<AppState>>,
    Path((namespace, name)): Path<(String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    let job_name = state.k8s.trigger_cronjob(&namespace, &name).await?;
    Ok(Json(serde_json::json!({ "job": job_name })))
}

async fn k8s_delete_job(
    State(state): State<Arc<AppState>>,
    Path((namespace, name)): Path<(String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    state.k8s.delete_job(&namespace, &name).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn k8s_delete_cronjob(
    State(state): State<Arc<AppState>>,
    Path((namespace, name)): Path<(String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    state.k8s.delete_cronjob(&namespace, &name).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct SuspendCronJobRequest {
    suspend: bool,
}

async fn k8s_suspend_cronjob(
    State(state): State<Arc<AppState>>,
    Path((namespace, name)): Path<(String, String)>,
    Json(body): Json<SuspendCronJobRequest>,
) -> Result<impl IntoResponse, ApiError> {
    state.k8s.suspend_cronjob(&namespace, &name, body.suspend).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

// --- HPAs, Network Policies, Storage Classes, CRDs ---

async fn k8s_hpas(
    State(state): State<Arc<AppState>>,
    Path(namespace): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let hpas = state.k8s.list_hpas(&namespace).await?;
    Ok(Json(hpas))
}

#[derive(Deserialize)]
struct CreateHpaRequest {
    name: String,
    deployment: String,
    min: i32,
    max: i32,
    cpu_target: i32,
}

async fn k8s_create_hpa(
    State(state): State<Arc<AppState>>,
    Path(namespace): Path<String>,
    Json(body): Json<CreateHpaRequest>,
) -> Result<impl IntoResponse, ApiError> {
    state.k8s.create_hpa(&namespace, &body.name, &body.deployment, body.min, body.max, body.cpu_target).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn k8s_delete_hpa(
    State(state): State<Arc<AppState>>,
    Path((namespace, name)): Path<(String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    state.k8s.delete_hpa(&namespace, &name).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn k8s_network_policies(
    State(state): State<Arc<AppState>>,
    Path(namespace): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let policies = state.k8s.list_network_policies(&namespace).await?;
    Ok(Json(policies))
}

async fn k8s_delete_network_policy(
    State(state): State<Arc<AppState>>,
    Path((namespace, name)): Path<(String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    state.k8s.delete_network_policy(&namespace, &name).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn k8s_storage_classes(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, ApiError> {
    let classes = state.k8s.list_storage_classes().await?;
    Ok(Json(classes))
}

async fn k8s_crds(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, ApiError> {
    let crds = state.k8s.list_crds().await?;
    Ok(Json(crds))
}

async fn k8s_helm_list(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, ApiError> {
    let releases = state.k8s.helm_list().await?;
    Ok(Json(releases))
}

#[derive(Deserialize)]
struct HelmUninstallRequest {
    name: String,
    namespace: String,
}

async fn k8s_helm_uninstall(
    State(state): State<Arc<AppState>>,
    Json(body): Json<HelmUninstallRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let result = state.k8s.helm_uninstall(&body.name, &body.namespace).await?;
    Ok(Json(serde_json::json!({ "output": result })))
}

async fn k8s_helm_available(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, ApiError> {
    let available = state.k8s.helm_available().await;
    Ok(Json(serde_json::json!({ "available": available })))
}

// --- Helm Install ---

#[derive(Deserialize)]
struct HelmInstallRequest {
    release_name: String,
    chart: String,
    namespace: String,
    set_values: Option<Vec<String>>,
}

async fn k8s_helm_install(
    State(state): State<Arc<AppState>>,
    Json(body): Json<HelmInstallRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let result = state
        .k8s
        .helm_install(&body.release_name, &body.chart, &body.namespace, body.set_values.as_deref())
        .await?;
    Ok(Json(serde_json::json!({ "output": result })))
}

// --- K8s Pod Terminal WebSocket ---

async fn k8s_pod_terminal_ws(
    State(state): State<Arc<AppState>>,
    Path((namespace, name)): Path<(String, String)>,
    Query(params): Query<HashMap<String, String>>,
    ws: WebSocketUpgrade,
) -> Result<impl IntoResponse, StatusCode> {
    // Auth via query param (same as container terminal)
    let token = params.get("token").map(|s| s.as_str()).unwrap_or("");
    use subtle::ConstantTimeEq;
    if !state.api_token.is_empty()
        && (state.api_token.len() != token.len()
            || state.api_token.as_bytes().ct_eq(token.as_bytes()).unwrap_u8() != 1)
    {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(ws.on_upgrade(move |socket| handle_k8s_pod_terminal(socket, namespace, name)))
}

async fn handle_k8s_pod_terminal(socket: WebSocket, namespace: String, name: String) {
    use tokio::process::Command as TokioCommand;

    // Spawn kubectl exec process
    #[cfg(target_os = "windows")]
    let child_result = {
        TokioCommand::new("wsl")
            .env("TERM", "xterm-256color")
            .env("COLORTERM", "truecolor")
            .args(["-u", "root", "--", "k3s", "kubectl", "exec", "-it", &name, "-n", &namespace, "--", "sh"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
    };

    #[cfg(not(target_os = "windows"))]
    let child_result = {
        let path = std::env::var("PATH").unwrap_or_default();
        TokioCommand::new("kubectl")
            .env("PATH", format!("/usr/local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:{path}"))
            .env("TERM", "xterm-256color")
            .env("COLORTERM", "truecolor")
            .args(["--context", "orca", "exec", "-it", &name, "-n", &namespace, "--", "sh"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
    };

    let mut child = match child_result {
        Ok(c) => c,
        Err(e) => {
            let (mut ws_sender, _) = socket.split();
            let _ = ws_sender
                .send(Message::Text(format!("\r\nFailed to spawn kubectl: {e}\r\n").into()))
                .await;
            return;
        }
    };

    let mut stdin = match child.stdin.take() {
        Some(s) => s,
        None => {
            let (mut ws_sender, _) = socket.split();
            let _ = ws_sender
                .send(Message::Text("\r\nFailed to capture stdin\r\n".into()))
                .await;
            return;
        }
    };
    let mut stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            let (mut ws_sender, _) = socket.split();
            let _ = ws_sender
                .send(Message::Text("\r\nFailed to capture stdout\r\n".into()))
                .await;
            return;
        }
    };
    let mut stderr = match child.stderr.take() {
        Some(s) => s,
        None => {
            let (mut ws_sender, _) = socket.split();
            let _ = ws_sender
                .send(Message::Text("\r\nFailed to capture stderr\r\n".into()))
                .await;
            return;
        }
    };

    let (mut ws_sender, mut ws_receiver) = socket.split();
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(64);

    // Stdout -> channel
    let tx_stdout = tx.clone();
    let stdout_task = tokio::spawn(async move {
        let mut buf = [0u8; 4096];
        loop {
            match stdout.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => {
                    if tx_stdout.send(buf[..n].to_vec()).await.is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    // Stderr -> channel
    let tx_stderr = tx.clone();
    let stderr_task = tokio::spawn(async move {
        let mut buf = [0u8; 4096];
        loop {
            match stderr.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => {
                    if tx_stderr.send(buf[..n].to_vec()).await.is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    // Channel -> WebSocket
    let output_task = tokio::spawn(async move {
        while let Some(data) = rx.recv().await {
            if ws_sender.send(Message::Binary(data.into())).await.is_err() {
                break;
            }
        }
    });

    // WebSocket -> stdin
    let input_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = ws_receiver.next().await {
            match msg {
                Message::Text(text) => {
                    // Ignore resize JSON messages (kubectl exec doesn't support dynamic resize)
                    if text.starts_with('{') {
                        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) {
                            if val.get("cols").is_some() && val.get("rows").is_some() {
                                continue;
                            }
                        }
                    }
                    if stdin.write_all(text.as_bytes()).await.is_err() {
                        break;
                    }
                }
                Message::Binary(data) => {
                    if stdin.write_all(&data).await.is_err() {
                        break;
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    tokio::select! {
        _ = output_task => {}
        _ = input_task => {}
        _ = stdout_task => {}
        _ = stderr_task => {}
        _ = child.wait() => {}
    }
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
    tracing::info!("env_fix: action={}", body.action);
    let output = orca_backend_common::environment::run_fix(&body.action).await?;
    tracing::info!("env_fix: completed, output_len={}", output.len());
    Ok(Json(serde_json::json!({ "output": output })))
}

async fn env_fix_stream(
    Json(body): Json<FixRequest>,
) -> impl IntoResponse {
    tracing::info!("env_fix_stream: action={}", body.action);
    use axum::response::sse::{Event, Sse};
    use tokio_stream::wrappers::ReceiverStream;
    use futures::StreamExt;

    let (tx, rx) = tokio::sync::mpsc::channel::<String>(100);
    let action = body.action.clone();

    tokio::spawn(async move {
        tracing::info!("env_fix_stream: spawned task for action={action}");
        match orca_backend_common::environment::run_fix_streaming(&action, tx.clone()).await {
            Ok(_) => {
                tracing::info!("env_fix_stream: action={action} completed successfully");
                let _ = tx.send("[DONE]".into()).await;
            }
            Err(e) => {
                tracing::error!("env_fix_stream: action={action} failed: {e}");
                for line in e.to_string().lines() {
                    let _ = tx.send(line.to_string()).await;
                }
                let _ = tx.send("[ERROR]".into()).await;
            }
        }
    });

    let stream = ReceiverStream::new(rx).map(|line| {
        Ok::<_, std::convert::Infallible>(Event::default().data(line))
    });

    Sse::new(stream)
}

// --- System Health ---

async fn system_health(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, ApiError> {
    let mut health = orca_backend_common::environment::check_system_health().await;

    // Check the daemon's ACTUAL Docker connection (what the app uses)
    if let Ok(version) = state.rt().await.docker.version().await {
        health.docker_connected = true;
        health.docker_version = version.version;
        health.os = version.os;
        health.arch = version.arch;
        health.warnings.retain(|w| !w.contains("not running") && !w.contains("not reachable") && !w.contains("Restart"));
    } else {
        // The daemon's connection is dead. Docker might still be running
        // (e.g. in WSL) but the daemon can't reach it.
        health.docker_connected = false;

        // Check if Docker is available via other means
        let connected = try_docker_connection().await;
        if let Some((version, _)) = connected {
            health.docker_version = Some(version);
            // Docker IS running but daemon can't connect — show as disconnected
            // with a clear warning
            health.warnings.retain(|w| !w.contains("not running") && !w.contains("not reachable"));
            health.warnings.push("Docker is running but Orca is disconnected. Click 'Restart Docker' to reconnect.".to_string());
        }
    }

    Ok(Json(health))
}

/// Returns the host UID:GID so the frontend can offer "Run as host user" for bind mounts.
async fn host_uid() -> Json<serde_json::Value> {
    let platform = std::env::consts::OS;

    #[cfg(unix)]
    {
        // Safe: getuid/getgid are always-safe POSIX calls
        let uid = nix_uid();
        let gid = nix_gid();
        Json(serde_json::json!({
            "uid": uid,
            "gid": gid,
            "user": format!("{uid}:{gid}"),
            "platform": platform,
        }))
    }
    #[cfg(not(unix))]
    {
        Json(serde_json::json!({
            "uid": null,
            "gid": null,
            "user": null,
            "platform": platform,
        }))
    }
}

#[cfg(unix)]
fn nix_uid() -> u32 {
    std::process::Command::new("id")
        .arg("-u")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0)
}

#[cfg(unix)]
fn nix_gid() -> u32 {
    std::process::Command::new("id")
        .arg("-g")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0)
}

/// Try to connect to Docker via various methods. Returns (version, method) on success.
async fn try_docker_connection() -> Option<(String, &'static str)> {
    // Try local defaults (Unix socket on Linux/macOS, named pipe on Windows)
    if let Ok(docker) = bollard::Docker::connect_with_local_defaults() {
        if let Ok(ver) = docker.version().await {
            return Some((ver.version.unwrap_or_default(), "local"));
        }
    }

    // On Windows, try TCP to WSL Docker
    #[cfg(target_os = "windows")]
    {
        if let Ok(docker) = bollard::Docker::connect_with_named_pipe_defaults() {
            if let Ok(ver) = docker.version().await {
                return Some((ver.version.unwrap_or_default(), "pipe"));
            }
        }
        if let Ok(docker) = bollard::Docker::connect_with_http(
            "http://localhost:2375", 120, bollard::API_DEFAULT_VERSION
        ) {
            if let Ok(ver) = docker.version().await {
                return Some((ver.version.unwrap_or_default(), "tcp"));
            }
        }
    }

    None
}

// --- Templates ---

async fn list_templates() -> Json<Vec<orca_core::templates::AppTemplate>> {
    // Trigger community template fetch (cached for 1 hour)
    let _ = orca_backend_common::templates::fetch_community_templates().await;
    Json(orca_backend_common::templates::all_templates())
}

/// Force-refresh the community template catalog (ignores cache).
async fn refresh_templates() -> Result<impl IntoResponse, ApiError> {
    orca_backend_common::templates::invalidate_cache();
    let _ = orca_backend_common::templates::fetch_community_templates().await;
    let templates = orca_backend_common::templates::all_templates();
    Ok(Json(serde_json::json!({ "count": templates.len() })))
}

async fn save_user_template(
    Json(template): Json<orca_core::templates::AppTemplate>,
) -> Result<impl IntoResponse, ApiError> {
    let mut user_templates = orca_backend_common::templates::load_user_templates();
    // Update existing or add new
    if let Some(existing) = user_templates.iter_mut().find(|t| t.id == template.id) {
        *existing = template;
    } else {
        let mut t = template;
        t.is_builtin = false;
        user_templates.push(t);
    }
    orca_backend_common::templates::save_user_templates(&user_templates)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
struct DeleteTemplateParams {
    id: String,
}

async fn delete_user_template(
    Query(params): Query<DeleteTemplateParams>,
) -> Result<impl IntoResponse, ApiError> {
    let mut user_templates = orca_backend_common::templates::load_user_templates();
    let before = user_templates.len();
    user_templates.retain(|t| t.id != params.id);
    if user_templates.len() == before {
        return Err(anyhow::anyhow!("User template '{}' not found", params.id).into());
    }
    orca_backend_common::templates::save_user_templates(&user_templates)?;
    Ok(Json(serde_json::json!({ "ok": true })))
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

    let templates = orca_backend_common::templates::all_templates();
    let template = templates
        .iter()
        .find(|t| t.id == id)
        .ok_or_else(|| anyhow::anyhow!("Template '{}' not found", id))?;

    let container_name = overrides
        .name
        .unwrap_or_else(|| template.id.clone());

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
        entrypoint: None,
        remove_on_exit: false,
        cpu_limit: None,
        memory_limit: None,
        memory_swap: None,
        gpu: false,
        user: None,
    };

    // Pull the image if not already available
    ensure_image(&state, &template.image).await?;

    let container_id = state.rt().await.create_container(opts).await?;

    // Start the container
    state.rt().await.start_container(&container_id).await?;

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
struct AiChatMessage {
    role: String,
    content: String,
}

#[derive(Deserialize)]
struct AiAskRequest {
    query: String,
    #[serde(default)]
    context: Option<orca_core::ai::AiContext>,
    #[serde(default)]
    history: Vec<AiChatMessage>,
}

async fn ai_ask(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AiAskRequest>,
) -> Result<impl IntoResponse, ApiError> {
    // Read provider settings from config
    let (provider, api_key, model, openai_url) = {
        let config = state.config.lock().await;
        let provider = config.ai_provider.clone();
        let url = config.openai_url.clone();
        let (key, model) = match provider.as_str() {
            "anthropic" => {
                let key = std::env::var("ANTHROPIC_API_KEY")
                    .ok()
                    .or_else(|| config.anthropic_api_key.clone());
                (key, config.anthropic_model.clone())
            }
            "gemini" => {
                let key = std::env::var("GOOGLE_API_KEY")
                    .ok()
                    .or_else(|| config.openai_api_key.clone());
                (key, config.openai_model.clone())
            }
            // "openai", "custom", or anything else
            _ => {
                let key = std::env::var("OPENAI_API_KEY")
                    .ok()
                    .or_else(|| config.openai_api_key.clone());
                (key, config.openai_model.clone())
            }
        };
        (provider, key, model, url)
    };

    tracing::info!("AI ask: provider={}, model={}, url={}, has_key={}", provider, model, openai_url, api_key.is_some());

    let api_key = match api_key {
        Some(key) if !key.is_empty() => key,
        _ => {
            let provider_name = match provider.as_str() {
                "anthropic" => "Anthropic",
                "gemini" => "Google Gemini",
                "custom" => "Custom provider",
                _ => "OpenAI",
            };
            return Ok(Json(orca_core::ai::AiResponse {
                answer: format!(
                    "No {provider_name} API key configured. To enable AI features, set the \
                     appropriate API key environment variable or configure it in Settings."
                ),
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
        "You are the AI assistant built into Orca Desktop, an open source container management app. \
         You help users with Docker containers, images, networking, volumes, and troubleshooting. \
         Keep responses concise and actionable. Use markdown formatting.\n\n\
         IMPORTANT: You have tools available to interact with the Docker environment directly. \
         When a user asks you to list containers, check logs, inspect images, manage networks, etc., \
         USE your tools to get real data — do NOT make up responses or say you cannot do it. \
         Always prefer using tools over suggesting CLI commands the user has to run themselves. \
         After calling tools, summarize the results in a helpful way.\n\n\
         When the user refers to a container, image, or resource by a partial name, \
         use your tools to find matches. If exactly one match is found, act on it directly \
         without asking for confirmation. Only ask to disambiguate when there are multiple matches. \
         Be decisive and action-oriented — the user expects you to just do it."
    );

    let user_message = body.query.clone();
    let history = body.history;

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
            let log_lines: Vec<&str> = logs.lines().collect();
            let recent_logs: String = if log_lines.len() > 50 {
                log_lines[log_lines.len() - 50..].join("\n")
            } else {
                logs.clone()
            };
            system_prompt.push_str(&format!("\n\nRecent container logs:\n```\n{recent_logs}\n```"));
        }
    }

    let http_client = reqwest::Client::new();

    // Build tool definitions for the LLM
    let catalog = orca_core::agent_tools::tool_catalog();
    let anthropic_tools: Vec<serde_json::Value> = catalog.iter().map(|t| {
        serde_json::json!({
            "name": t.name,
            "description": t.description,
            "input_schema": t.parameters,
        })
    }).collect();
    let openai_tools: Vec<serde_json::Value> = catalog.iter().map(|t| {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": t.name,
                "description": t.description,
                "parameters": t.parameters,
            }
        })
    }).collect();

    // Build conversation history for multi-turn support
    let prior_messages: Vec<(String, String)> = history.iter()
        .map(|m| (
            if m.role == "ai" { "assistant".to_string() } else { m.role.clone() },
            m.content.clone(),
        ))
        .collect();

    let answer = if provider == "anthropic" {
        call_anthropic_with_tools(&http_client, &api_key, &model, &system_prompt, &user_message, &anthropic_tools, &state, &prior_messages).await?
    } else {
        // OpenAI-compatible API (OpenAI, Gemini, Custom)
        let base_url = match provider.as_str() {
            "gemini" => "https://generativelanguage.googleapis.com/v1beta/openai".to_string(),
            "custom" => openai_url.clone(),
            _ => openai_url.clone(), // "openai"
        };
        call_openai_with_tools(&http_client, &api_key, &model, &base_url, &system_prompt, &user_message, &openai_tools, &state, &prior_messages).await?
    };

    Ok(Json(orca_core::ai::AiResponse {
        answer,
        suggestions: vec![],
    }))
}

// --- General Settings ---

#[derive(Deserialize)]
struct GeneralSettingsRequest {
    start_on_login: bool,
    show_tray_icon: bool,
    telemetry: bool,
}

async fn get_general_settings(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, ApiError> {
    let config = state.config.lock().await;
    Ok(Json(serde_json::json!({
        "start_on_login": config.start_on_login,
        "show_tray_icon": config.show_tray_icon,
        "telemetry": config.telemetry,
    })))
}

async fn save_general_settings(
    State(state): State<Arc<AppState>>,
    Json(body): Json<GeneralSettingsRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let mut config = state.config.lock().await;
    config.start_on_login = body.start_on_login;
    config.show_tray_icon = body.show_tray_icon;
    config.telemetry = body.telemetry;
    config.save().map_err(|e| anyhow::anyhow!("Failed to save config: {e}"))?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

// --- Lima VM Settings ---

#[derive(Deserialize)]
struct LimaSettingsRequest {
    name: String,
    cpus: u32,
    memory_gib: u32,
    disk_gib: u32,
}

async fn get_lima_settings() -> Result<impl IntoResponse, ApiError> {
    let output = tokio::process::Command::new("limactl")
        .args(["list", "--json"])
        .env("PATH", format!("/opt/homebrew/bin:/usr/local/bin:{}", std::env::var("PATH").unwrap_or_default()))
        .output()
        .await
        .map_err(|e| anyhow::anyhow!("limactl failed: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    // limactl list --json outputs one JSON object per line (NDJSON)
    let vms: Vec<serde_json::Value> = stdout
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();

    let vm = vms.iter().find(|v| {
        v["name"].as_str() == Some("orca") || v["name"].as_str() == Some("docker")
    });

    if let Some(vm) = vm {
        Ok(Json(serde_json::json!({
            "available": true,
            "name": vm["name"],
            "status": vm["status"],
            "cpus": vm["cpus"],
            "memory": vm["memory"],
            "disk": vm["disk"],
        })))
    } else {
        Ok(Json(serde_json::json!({ "available": false })))
    }
}

async fn save_lima_settings(
    Json(body): Json<LimaSettingsRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let path_env = format!("/opt/homebrew/bin:/usr/local/bin:{}", std::env::var("PATH").unwrap_or_default());

    // Stop the VM
    let _ = tokio::process::Command::new("limactl")
        .args(["stop", &body.name])
        .env("PATH", &path_env)
        .output()
        .await;

    // Use limactl edit with --set to change resources
    let set_expr = format!(
        ".cpus = {} | .memory = \"{}GiB\" | .disk = \"{}GiB\"",
        body.cpus, body.memory_gib, body.disk_gib
    );
    let edit_output = tokio::process::Command::new("limactl")
        .args(["edit", &body.name, "--set", &set_expr])
        .env("PATH", &path_env)
        .output()
        .await
        .map_err(|e| anyhow::anyhow!("limactl edit failed: {e}"))?;

    if !edit_output.status.success() {
        let stderr = String::from_utf8_lossy(&edit_output.stderr);
        return Err(anyhow::anyhow!("limactl edit failed: {stderr}").into());
    }

    // Start the VM
    let start_output = tokio::process::Command::new("limactl")
        .args(["start", &body.name])
        .env("PATH", &path_env)
        .output()
        .await
        .map_err(|e| anyhow::anyhow!("limactl start failed: {e}"))?;

    if !start_output.status.success() {
        let stderr = String::from_utf8_lossy(&start_output.stderr);
        return Err(anyhow::anyhow!("VM started with errors: {stderr}").into());
    }

    Ok(Json(serde_json::json!({ "status": "ok" })))
}

// --- TCP Tunnel (WebSocket-based port forwarding) ---

#[derive(Deserialize)]
struct TunnelParams {
    host: String,
    port: u16,
    token: String,
}

async fn tunnel_ws(
    State(state): State<Arc<AppState>>,
    Query(params): Query<TunnelParams>,
    ws: WebSocketUpgrade,
) -> Result<impl IntoResponse, StatusCode> {
    // Auth via query param (WebSocket can't send headers in browser)
    use subtle::ConstantTimeEq;
    let token = &params.token;
    if state.api_token.is_empty()
        || state.api_token.len() != token.len()
        || state.api_token.as_bytes().ct_eq(token.as_bytes()).unwrap_u8() != 1
    {
        return Err(StatusCode::UNAUTHORIZED);
    }

    // Basic validation
    if params.port == 0 {
        return Err(StatusCode::BAD_REQUEST);
    }

    tracing::info!("Tunnel: opening connection to {}:{}", params.host, params.port);
    Ok(ws.on_upgrade(move |socket| handle_tunnel(socket, params.host, params.port)))
}

async fn handle_tunnel(socket: WebSocket, host: String, port: u16) {
    // Connect to the target TCP service
    let tcp_stream = match tokio::net::TcpStream::connect((&*host, port)).await {
        Ok(s) => {
            tracing::info!("Tunnel: connected to {host}:{port}");
            s
        }
        Err(e) => {
            tracing::warn!("Tunnel: failed to connect to {host}:{port}: {e}");
            let (mut sender, _) = socket.split();
            let _ = sender.send(Message::Close(Some(axum::extract::ws::CloseFrame {
                code: 1011,
                reason: format!("Cannot connect to {host}:{port}: {e}").into(),
            }))).await;
            return;
        }
    };

    let (mut tcp_read, mut tcp_write) = tcp_stream.into_split();
    let (mut ws_sender, mut ws_receiver) = socket.split();

    // TCP → WebSocket
    let tcp_to_ws = tokio::spawn(async move {
        let mut buf = vec![0u8; 32768];
        loop {
            match tcp_read.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => {
                    if ws_sender.send(Message::Binary(buf[..n].to_vec().into())).await.is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = ws_sender.close().await;
    });

    // WebSocket → TCP
    let ws_to_tcp = tokio::spawn(async move {
        while let Some(Ok(msg)) = ws_receiver.next().await {
            match msg {
                Message::Binary(data) => {
                    if tcp_write.write_all(&data).await.is_err() {
                        break;
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    tokio::select! {
        _ = tcp_to_ws => {},
        _ = ws_to_tcp => {},
    }
    tracing::info!("Tunnel: closed connection to {host}:{port}");
}

// --- Webhooks & Auto-Deploy ---

async fn webhook_github(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    body: axum::body::Bytes,
) -> Result<impl IntoResponse, ApiError> {
    let config = orca_core::config::OrcaConfig::load()?;

    // Validate signature if a webhook secret is configured
    if let Some(ref global_secret) = config.webhook_secret {
        let sig = headers.get("x-hub-signature-256")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if !orca_core::webhook::validate_github_signature(global_secret, &body, sig) {
            // Try per-rule secrets
            let any_valid = config.deploy_rules.iter().any(|r| {
                r.webhook_secret.as_ref().map(|s|
                    orca_core::webhook::validate_github_signature(s, &body, sig)
                ).unwrap_or(false)
            });
            if !any_valid {
                return Err(anyhow::anyhow!("Invalid webhook signature").into());
            }
        }
    }

    let event_type = headers.get("x-github-event")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    if event_type != "package" && event_type != "registry_package" {
        // Not a package event — acknowledge but skip
        return Ok(Json(serde_json::json!({ "accepted": true, "skipped": true, "reason": format!("event type '{event_type}' not handled") })));
    }

    let payload = orca_core::webhook::parse_github_package_event(&body)
        .map_err(|e| anyhow::anyhow!("Failed to parse webhook: {e}"))?;

    if payload.action != "published" && payload.action != "updated" {
        return Ok(Json(serde_json::json!({ "accepted": true, "skipped": true, "reason": format!("action '{}' not handled", payload.action) })));
    }

    let rules = config.find_matching_rules(&payload.image, &payload.tag);
    let matched = rules.len();

    if matched > 0 {
        tracing::info!("Webhook: {} rule(s) matched for {}:{}", matched, payload.image, payload.tag);
        let image_ref = format!("{}:{}", payload.image, payload.tag);
        let rules: Vec<orca_core::config::DeployRule> = rules.into_iter().cloned().collect();
        let state = state.clone();
        tokio::spawn(async move {
            execute_auto_deploy(&state, &image_ref, &rules).await;
        });
    } else {
        tracing::info!("Webhook: no matching rules for {}:{}", payload.image, payload.tag);
    }

    Ok(Json(serde_json::json!({ "accepted": true, "matched_rules": matched })))
}

async fn webhook_dockerhub(
    State(state): State<Arc<AppState>>,
    body: axum::body::Bytes,
) -> Result<impl IntoResponse, ApiError> {
    let payload = orca_core::webhook::parse_dockerhub_event(&body)
        .map_err(|e| anyhow::anyhow!("Failed to parse Docker Hub webhook: {e}"))?;

    let config = orca_core::config::OrcaConfig::load()?;
    let rules = config.find_matching_rules(&payload.image, &payload.tag);
    let matched = rules.len();

    if matched > 0 {
        tracing::info!("Docker Hub webhook: {} rule(s) matched for {}:{}", matched, payload.image, payload.tag);
        let image_ref = format!("{}:{}", payload.image, payload.tag);
        let rules: Vec<orca_core::config::DeployRule> = rules.into_iter().cloned().collect();
        let state = state.clone();
        tokio::spawn(async move {
            execute_auto_deploy(&state, &image_ref, &rules).await;
        });
    }

    Ok(Json(serde_json::json!({ "accepted": true, "matched_rules": matched })))
}

/// Execute auto-deploy for matched rules: pull image, stop old container, start new one.
async fn execute_auto_deploy(state: &Arc<AppState>, image_ref: &str, rules: &[orca_core::config::DeployRule]) {
    use bollard::container::ListContainersOptions;
    use orca_core::config::{DeployRecord, DeployStatus};

    // Pull the new image
    tracing::info!("Auto-deploy: pulling {image_ref}...");
    if let Err(e) = pull_image_blocking(&state.rt().await.docker, image_ref).await {
        tracing::error!("Auto-deploy: failed to pull {image_ref}: {e}");
        // Record failure for all rules
        if let Ok(mut config) = orca_core::config::OrcaConfig::load() {
            for rule in rules {
                config.add_deploy_record(DeployRecord {
                    id: format!("{:x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis()),
                    rule_name: rule.name.clone(),
                    image: image_ref.to_string(),
                    tag: image_ref.split(':').nth(1).unwrap_or("latest").to_string(),
                    container_name: "N/A".to_string(),
                    status: DeployStatus::Failed,
                    timestamp: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| format!("{}", d.as_secs())).unwrap_or_default(),
                    error: Some(format!("Pull failed: {e}")),
                });
            }
            let _ = config.save();
        }
        return;
    }
    tracing::info!("Auto-deploy: pulled {image_ref}");

    // Find and redeploy matching containers
    let containers = state.rt().await.docker.list_containers(Some(ListContainersOptions::<String> {
        all: true,
        ..Default::default()
    })).await.unwrap_or_default();

    for rule in rules {
        let target_containers: Vec<_> = containers.iter().filter(|c| {
            let c_image = c.image.as_deref().unwrap_or("");
            let c_name = c.names.as_ref()
                .and_then(|names| names.first())
                .map(|n| n.trim_start_matches('/'))
                .unwrap_or("");

            // Match by container name if specified, otherwise by image
            if !rule.container_names.is_empty() {
                rule.container_names.iter().any(|n| n == c_name)
            } else {
                c_image.contains(&rule.image_pattern)
            }
        }).collect();

        for container in target_containers {
            let c_id = container.id.as_deref().unwrap_or("");
            let c_name = container.names.as_ref()
                .and_then(|names| names.first())
                .map(|n| n.trim_start_matches('/').to_string())
                .unwrap_or_else(|| c_id[..12].to_string());

            tracing::info!("Auto-deploy: redeploying container '{c_name}' with {image_ref}");

            match redeploy_container(&state.rt().await.docker, c_id, image_ref).await {
                Ok(new_id) => {
                    tracing::info!("Auto-deploy: container '{c_name}' redeployed as {}", &new_id[..12]);
                    if let Ok(mut config) = orca_core::config::OrcaConfig::load() {
                        config.add_deploy_record(DeployRecord {
                            id: format!("{:x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis()),
                            rule_name: rule.name.clone(),
                            image: image_ref.to_string(),
                            tag: image_ref.split(':').nth(1).unwrap_or("latest").to_string(),
                            container_name: c_name.clone(),
                            status: DeployStatus::Success,
                            timestamp: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| format!("{}", d.as_secs())).unwrap_or_default(),
                            error: None,
                        });
                        let _ = config.save();
                    }
                }
                Err(e) => {
                    tracing::error!("Auto-deploy: failed to redeploy '{c_name}': {e}");
                    if let Ok(mut config) = orca_core::config::OrcaConfig::load() {
                        config.add_deploy_record(DeployRecord {
                            id: format!("{:x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis()),
                            rule_name: rule.name.clone(),
                            image: image_ref.to_string(),
                            tag: image_ref.split(':').nth(1).unwrap_or("latest").to_string(),
                            container_name: c_name.clone(),
                            status: DeployStatus::Failed,
                            timestamp: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| format!("{}", d.as_secs())).unwrap_or_default(),
                            error: Some(format!("{e}")),
                        });
                        let _ = config.save();
                    }
                }
            }
        }
    }
}

/// Pull an image and wait for completion.
async fn pull_image_blocking(docker: &bollard::Docker, image_ref: &str) -> anyhow::Result<()> {
    use bollard::image::CreateImageOptions;

    let options = CreateImageOptions {
        from_image: image_ref,
        ..Default::default()
    };
    let stream = docker.create_image(Some(options), None, None);
    let items: Vec<_> = tokio_stream::StreamExt::collect(stream).await;
    for item in items {
        item.map_err(|e| anyhow::anyhow!("Pull error: {e}"))?;
    }
    Ok(())
}

/// Redeploy a container: inspect → stop → remove → create new with same config + new image → start.
async fn redeploy_container(docker: &bollard::Docker, container_id: &str, new_image: &str) -> anyhow::Result<String> {
    use bollard::container::{Config, CreateContainerOptions, StopContainerOptions, RemoveContainerOptions};
    use bollard::models::HostConfig;

    // Inspect the running container
    let info = docker.inspect_container(container_id, None).await
        .map_err(|e| anyhow::anyhow!("Failed to inspect container: {e}"))?;

    let old_config = info.config.ok_or_else(|| anyhow::anyhow!("No config found"))?;
    let old_host_config = info.host_config.unwrap_or_default();
    let container_name = info.name.unwrap_or_default().trim_start_matches('/').to_string();

    // Stop the old container
    let _ = docker.stop_container(container_id, Some(StopContainerOptions { t: 10 })).await;

    // Remove the old container
    docker.remove_container(container_id, Some(RemoveContainerOptions {
        force: true,
        ..Default::default()
    })).await.map_err(|e| anyhow::anyhow!("Failed to remove old container: {e}"))?;

    // Create new container with same config but updated image
    let new_config = Config {
        image: Some(new_image.to_string()),
        cmd: old_config.cmd,
        env: old_config.env,
        entrypoint: old_config.entrypoint,
        exposed_ports: old_config.exposed_ports,
        labels: old_config.labels,
        user: old_config.user,
        working_dir: old_config.working_dir,
        host_config: Some(HostConfig {
            binds: old_host_config.binds,
            port_bindings: old_host_config.port_bindings,
            network_mode: old_host_config.network_mode,
            restart_policy: old_host_config.restart_policy,
            memory: old_host_config.memory,
            nano_cpus: old_host_config.nano_cpus,
            ..Default::default()
        }),
        ..Default::default()
    };

    let create_opts = if container_name.is_empty() {
        None
    } else {
        Some(CreateContainerOptions { name: container_name.as_str(), platform: None })
    };

    let created = docker.create_container(create_opts, new_config).await
        .map_err(|e| anyhow::anyhow!("Failed to create new container: {e}"))?;

    // Start the new container
    docker.start_container::<String>(&created.id, None).await
        .map_err(|e| anyhow::anyhow!("Failed to start new container: {e}"))?;

    Ok(created.id)
}

// --- Deploy Rules CRUD ---

#[derive(Deserialize)]
struct SaveDeployRuleRequest {
    id: Option<String>,
    name: String,
    image_pattern: String,
    #[serde(default)]
    tag_filter: String,
    #[serde(default)]
    container_names: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    webhook_secret: Option<String>,
    #[serde(default = "default_true_value")]
    enabled: bool,
}

fn default_true_value() -> bool { true }

async fn list_deploy_rules() -> Result<impl IntoResponse, ApiError> {
    let config = orca_core::config::OrcaConfig::load()?;
    // Don't expose webhook secrets to the frontend
    let rules: Vec<serde_json::Value> = config.deploy_rules.iter().map(|r| {
        serde_json::json!({
            "id": r.id,
            "name": r.name,
            "image_pattern": r.image_pattern,
            "tag_filter": r.tag_filter,
            "container_names": r.container_names,
            "has_secret": r.webhook_secret.is_some(),
            "enabled": r.enabled,
        })
    }).collect();
    Ok(Json(rules))
}

async fn save_deploy_rule(
    Json(body): Json<SaveDeployRuleRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let mut config = orca_core::config::OrcaConfig::load()?;
    let id = body.id.unwrap_or_else(|| {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default();
        format!("{:x}{:04x}", now.as_millis(), now.subsec_nanos() & 0xFFFF)
    });

    // Update existing or add new
    if let Some(existing) = config.deploy_rules.iter_mut().find(|r| r.id == id) {
        existing.name = body.name;
        existing.image_pattern = body.image_pattern;
        existing.tag_filter = body.tag_filter;
        existing.container_names = body.container_names;
        if body.webhook_secret.is_some() {
            existing.webhook_secret = body.webhook_secret;
        }
        existing.enabled = body.enabled;
    } else {
        config.deploy_rules.push(orca_core::config::DeployRule {
            id: id.clone(),
            name: body.name,
            image_pattern: body.image_pattern,
            tag_filter: body.tag_filter,
            container_names: body.container_names,
            webhook_secret: body.webhook_secret,
            enabled: body.enabled,
        });
    }

    config.save()?;
    Ok(Json(serde_json::json!({ "id": id })))
}

async fn delete_deploy_rule(
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let mut config = orca_core::config::OrcaConfig::load()?;
    config.deploy_rules.retain(|r| r.id != id);
    config.save()?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_deploy_history() -> Result<impl IntoResponse, ApiError> {
    let config = orca_core::config::OrcaConfig::load()?;
    Ok(Json(config.deploy_history))
}

#[derive(Deserialize)]
struct TestDeployRequest {
    image: String,
    tag: String,
}

/// Simulate a webhook — find matching rules and return what would be deployed (dry run).
async fn test_deploy_rule(
    Json(body): Json<TestDeployRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let config = orca_core::config::OrcaConfig::load()?;
    let rules = config.find_matching_rules(&body.image, &body.tag);
    let matches: Vec<serde_json::Value> = rules.iter().map(|r| {
        serde_json::json!({
            "rule_name": r.name,
            "image_pattern": r.image_pattern,
            "tag_filter": r.tag_filter,
            "container_names": r.container_names,
        })
    }).collect();
    Ok(Json(serde_json::json!({
        "image": body.image,
        "tag": body.tag,
        "matched_rules": matches,
        "would_deploy": !matches.is_empty(),
    })))
}

#[derive(Deserialize)]
struct WebhookSecretRequest {
    secret: Option<String>,
}

async fn save_webhook_secret(
    Json(body): Json<WebhookSecretRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let mut config = orca_core::config::OrcaConfig::load()?;
    config.webhook_secret = body.secret;
    config.save()?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

// --- Scheduled Actions ---

async fn list_schedules() -> Result<impl IntoResponse, ApiError> {
    let config = orca_core::config::OrcaConfig::load()?;
    Ok(Json(serde_json::to_value(&config.schedules).unwrap_or_default()))
}

#[derive(Deserialize)]
struct SaveScheduleRequest {
    id: Option<String>,
    name: String,
    container: String,
    action: String,
    cron: String,
    #[serde(default = "default_true_value")]
    enabled: bool,
}

async fn save_schedule(
    Json(body): Json<SaveScheduleRequest>,
) -> Result<impl IntoResponse, ApiError> {
    // Validate cron expression
    use std::str::FromStr;
    cron::Schedule::from_str(&body.cron)
        .map_err(|e| anyhow::anyhow!("Invalid cron expression: {e}"))?;

    let mut config = orca_core::config::OrcaConfig::load()?;
    let id = body.id.unwrap_or_else(|| {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default();
        format!("{:x}{:04x}", now.as_millis(), now.subsec_nanos() & 0xFFFF)
    });

    if let Some(existing) = config.schedules.iter_mut().find(|s| s.id == id) {
        existing.name = body.name;
        existing.container = body.container;
        existing.action = body.action;
        existing.cron = body.cron;
        existing.enabled = body.enabled;
    } else {
        config.schedules.push(orca_core::config::ScheduledAction {
            id: id.clone(),
            name: body.name,
            container: body.container,
            action: body.action,
            cron: body.cron,
            enabled: body.enabled,
            last_run: None,
        });
    }

    config.save()?;
    Ok(Json(serde_json::json!({ "id": id })))
}

async fn delete_schedule(
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let mut config = orca_core::config::OrcaConfig::load()?;
    config.schedules.retain(|s| s.id != id);
    config.save()?;
    Ok(StatusCode::NO_CONTENT)
}

// --- AI Settings ---

#[derive(Deserialize)]
struct AiSettingsRequest {
    provider: String,
    api_key: String,
    model: String,
    #[serde(default)]
    url: Option<String>,
}

/// Call Anthropic Claude API with tool use support
async fn call_anthropic_with_tools(
    client: &reqwest::Client,
    api_key: &str,
    model: &str,
    system_prompt: &str,
    user_message: &str,
    tools: &[serde_json::Value],
    state: &Arc<AppState>,
    history: &[(String, String)],
) -> Result<String, ApiError> {
    let mut messages: Vec<serde_json::Value> = history.iter()
        .map(|(role, content)| serde_json::json!({ "role": role, "content": content }))
        .collect();
    messages.push(serde_json::json!({ "role": "user", "content": user_message }));

    // Tool-calling loop (max 5 rounds to prevent runaway)
    for _ in 0..5 {
        let api_resp = client
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&serde_json::json!({
                "model": model,
                "max_tokens": 4096,
                "system": system_prompt,
                "tools": tools,
                "messages": messages,
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

        let stop_reason = resp_json["stop_reason"].as_str().unwrap_or("");
        let content = resp_json["content"].as_array().cloned().unwrap_or_default();

        if stop_reason == "tool_use" {
            // Process tool calls
            messages.push(serde_json::json!({ "role": "assistant", "content": content }));

            let mut tool_results = Vec::new();
            for block in &content {
                if block["type"].as_str() == Some("tool_use") {
                    let tool_name = block["name"].as_str().unwrap_or("");
                    let tool_id = block["id"].as_str().unwrap_or("");
                    let tool_input = block["input"].clone();

                    let result = match crate::agent::execute_tool(state, tool_name, tool_input).await {
                        Ok(v) => serde_json::json!({
                            "type": "tool_result",
                            "tool_use_id": tool_id,
                            "content": serde_json::to_string_pretty(&v).unwrap_or_default(),
                        }),
                        Err(e) => serde_json::json!({
                            "type": "tool_result",
                            "tool_use_id": tool_id,
                            "content": format!("Error: {e}"),
                            "is_error": true,
                        }),
                    };
                    tool_results.push(result);
                }
            }

            messages.push(serde_json::json!({ "role": "user", "content": tool_results }));
        } else {
            // Final text response — extract all text blocks
            let text: String = content.iter()
                .filter(|b| b["type"].as_str() == Some("text"))
                .filter_map(|b| b["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n");
            return Ok(if text.is_empty() { "No response received from AI.".to_string() } else { text });
        }
    }

    Ok("Tool calling limit reached. Please try a simpler question.".to_string())
}

/// Call OpenAI-compatible API with tool use support
async fn call_openai_with_tools(
    client: &reqwest::Client,
    api_key: &str,
    model: &str,
    base_url: &str,
    system_prompt: &str,
    user_message: &str,
    tools: &[serde_json::Value],
    state: &Arc<AppState>,
    history: &[(String, String)],
) -> Result<String, ApiError> {
    let mut messages: Vec<serde_json::Value> = vec![
        serde_json::json!({ "role": "system", "content": system_prompt }),
    ];
    for (role, content) in history {
        messages.push(serde_json::json!({ "role": role, "content": content }));
    }
    messages.push(serde_json::json!({ "role": "user", "content": user_message }));
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    tracing::info!("OpenAI-compatible API call: url={}, model={}, tools={}, history_msgs={}", url, model, tools.len(), history.len());

    for round in 0..5 {
        let mut body = serde_json::json!({
            "model": model,
            "max_tokens": 4096,
            "messages": messages,
        });
        if !tools.is_empty() {
            body["tools"] = serde_json::json!(tools);
        }
        let api_resp = client
            .post(&url)
            .header("Authorization", format!("Bearer {api_key}"))
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("Failed to call OpenAI API: {e}"))?;

        let status = api_resp.status();
        tracing::info!("OpenAI API response: status={}, round={}", status, round);

        if !status.is_success() {
            let err_body = api_resp.text().await.unwrap_or_default();
            tracing::warn!("OpenAI API error: status={}, body={}", status, &err_body[..err_body.len().min(500)]);
            return Err(anyhow::anyhow!("OpenAI API error ({}): {}", status, err_body).into());
        }

        let resp_json: serde_json::Value = api_resp
            .json()
            .await
            .map_err(|e| anyhow::anyhow!("Failed to parse OpenAI API response: {e}"))?;

        let choice = resp_json["choices"].as_array()
            .and_then(|arr| arr.first())
            .cloned()
            .unwrap_or_default();

        let finish_reason = choice["finish_reason"].as_str().unwrap_or("");
        let message = &choice["message"];

        if finish_reason == "tool_calls" || message.get("tool_calls").is_some() {
            let tool_calls = message["tool_calls"].as_array().cloned().unwrap_or_default();
            if tool_calls.is_empty() {
                // No actual tool calls, treat as final response
                return Ok(message["content"].as_str().unwrap_or("No response received from AI.").to_string());
            }

            // Add assistant message with tool calls
            messages.push(message.clone());

            // Execute each tool call
            for tc in &tool_calls {
                let fn_name = tc["function"]["name"].as_str().unwrap_or("");
                let fn_args: serde_json::Value = tc["function"]["arguments"]
                    .as_str()
                    .and_then(|s| serde_json::from_str(s).ok())
                    .unwrap_or_default();
                let tc_id = tc["id"].as_str().unwrap_or("");

                let result = match crate::agent::execute_tool(state, fn_name, fn_args).await {
                    Ok(v) => serde_json::to_string_pretty(&v).unwrap_or_default(),
                    Err(e) => format!("Error: {e}"),
                };

                messages.push(serde_json::json!({
                    "role": "tool",
                    "tool_call_id": tc_id,
                    "content": result,
                }));
            }
        } else {
            return Ok(message["content"].as_str().unwrap_or("No response received from AI.").to_string());
        }
    }

    Ok("Tool calling limit reached. Please try a simpler question.".to_string())
}

/// List available models for the current AI provider
async fn list_ai_models(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, ApiError> {
    let (provider, api_key, base_url) = {
        let config = state.config.lock().await;
        let provider = config.ai_provider.clone();
        let key = match provider.as_str() {
            "anthropic" => config.anthropic_api_key.clone(),
            _ => config.openai_api_key.clone(),
        };
        let url = match provider.as_str() {
            "gemini" => "https://generativelanguage.googleapis.com/v1beta/openai".to_string(),
            _ => config.openai_url.clone(),
        };
        (provider, key, url)
    };

    let api_key = match api_key {
        Some(k) if !k.is_empty() => k,
        _ => return Ok(Json(serde_json::json!({ "models": Vec::<String>::new() }))),
    };

    let client = reqwest::Client::new();

    let models: Vec<String> = match provider.as_str() {
        "anthropic" => {
            // Anthropic doesn't have a models list endpoint — return known models
            vec![
                "claude-sonnet-4-20250514".into(),
                "claude-opus-4-20250514".into(),
                "claude-haiku-4-20250414".into(),
                "claude-3-5-sonnet-20241022".into(),
                "claude-3-5-haiku-20241022".into(),
            ]
        }
        _ => {
            // OpenAI-compatible /models endpoint (works for OpenAI, Gemini, Ollama, etc.)
            match client
                .get(format!("{}/models", base_url.trim_end_matches('/')))
                .header("Authorization", format!("Bearer {api_key}"))
                .send()
                .await
            {
                Ok(resp) if resp.status().is_success() => {
                    let json: serde_json::Value = resp.json().await.unwrap_or_default();
                    json["data"]
                        .as_array()
                        .map(|arr| {
                            let mut ids: Vec<String> = arr
                                .iter()
                                .filter_map(|m| m["id"].as_str().map(String::from))
                                .collect();
                            ids.sort();
                            ids
                        })
                        .unwrap_or_default()
                }
                _ => vec![],
            }
        }
    };

    Ok(Json(serde_json::json!({ "models": models })))
}

async fn save_ai_settings(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AiSettingsRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let mut config = state.config.lock().await;
    config.ai_provider = body.provider.clone();
    match body.provider.as_str() {
        "anthropic" => {
            if !body.api_key.is_empty() {
                config.anthropic_api_key = Some(body.api_key);
            }
            config.anthropic_model = body.model;
        }
        _ => {
            // openai, gemini, custom — all use the openai_* fields
            if !body.api_key.is_empty() {
                config.openai_api_key = Some(body.api_key);
            }
            config.openai_model = body.model;
            if let Some(url) = body.url {
                if !url.is_empty() {
                    config.openai_url = url;
                }
            }
        }
    }
    config.save().map_err(|e| anyhow::anyhow!("Failed to save config: {e}"))?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn get_ai_settings(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, ApiError> {
    let config = state.config.lock().await;
    Ok(Json(serde_json::json!({
        "provider": config.ai_provider,
        "has_anthropic_key": config.anthropic_api_key.as_ref().map(|k| !k.is_empty()).unwrap_or(false),
        "has_openai_key": config.openai_api_key.as_ref().map(|k| !k.is_empty()).unwrap_or(false),
        "anthropic_model": config.anthropic_model,
        "openai_model": config.openai_model,
        "openai_url": config.openai_url,
    })))
}

// --- Cleanup ---

#[derive(Deserialize)]
struct CleanupRequest {
    /// What to clean up: "config", "vms", "templates", "all",
    /// or Docker resource scopes: "containers", "images", "volumes", "networks", "build_cache"
    #[serde(default)]
    scope: String,
}

async fn cleanup(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CleanupRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let mut log = Vec::new();
    let scope = body.scope.as_str();

    // Stop and delete Lima VMs (macOS)
    if scope == "vms" || scope == "all" {
        #[cfg(target_os = "macos")]
        {
            use std::process::Stdio;
            log.push("Stopping Lima VMs...".to_string());
            let output = tokio::process::Command::new("limactl")
                .args(["list", "--json"])
                .stdout(Stdio::piped())
                .output()
                .await;

            if let Ok(out) = output {
                let stdout = String::from_utf8_lossy(&out.stdout);
                for line in stdout.lines() {
                    if let Ok(vm) = serde_json::from_str::<serde_json::Value>(line) {
                        if let Some(name) = vm.get("name").and_then(|n| n.as_str()) {
                            log.push(format!("  Stopping VM '{name}'..."));
                            let _ = tokio::process::Command::new("limactl")
                                .args(["stop", name])
                                .output()
                                .await;
                            log.push(format!("  Deleting VM '{name}'..."));
                            let _ = tokio::process::Command::new("limactl")
                                .args(["delete", name])
                                .output()
                                .await;
                        }
                    }
                }
            }
        }

        // Remove Docker TCP override (Windows/WSL)
        #[cfg(target_os = "windows")]
        {
            log.push("Removing Docker TCP override from WSL...".to_string());
            let _ = tokio::process::Command::new("wsl")
                .args(["-u", "root", "--", "rm", "-f",
                    "/etc/systemd/system/docker.service.d/override.conf"])
                .output().await;
            let _ = tokio::process::Command::new("wsl")
                .args(["-u", "root", "--", "systemctl", "daemon-reload"])
                .output().await;
            log.push("  Done".to_string());
        }
    }

    // Remove user templates
    if scope == "templates" || scope == "all" {
        let config_dir = orca_core::config::OrcaConfig::config_path()
            .parent().map(|p| p.to_path_buf()).unwrap_or_default();
        let templates_path = config_dir.join("templates.json");
        if templates_path.exists() {
            let _ = std::fs::remove_file(&templates_path);
            log.push("Removed user templates".to_string());
        }
    }

    // Remove config
    if scope == "config" || scope == "all" {
        let config_path = orca_core::config::OrcaConfig::config_path()
            .parent().map(|p| p.to_path_buf()).unwrap_or_default();
        if config_path.exists() {
            log.push(format!("Removing config at {}", config_path.display()));
            let _ = std::fs::remove_dir_all(&config_path);
        }
    }

    // Docker resource pruning: stopped containers
    if scope == "containers" {
        let containers = state.rt().await.list_containers(true).await?;
        let mut removed = 0u64;
        for c in &containers {
            if matches!(c.state, orca_core::runtime::ContainerState::Exited | orca_core::runtime::ContainerState::Dead | orca_core::runtime::ContainerState::Created) {
                if let Err(e) = state.rt().await.remove_container(&c.id, true).await {
                    log.push(format!("Failed to remove container {}: {e}", &c.id[..12.min(c.id.len())]));
                } else {
                    removed += 1;
                }
            }
        }
        log.push(format!("Removed {removed} stopped container(s)"));
    }

    // Docker resource pruning: images
    if scope == "images" {
        match ImageManager::prune(state.rt().await.as_ref()).await {
            Ok(result) => {
                let count = result.images_deleted.len();
                let bytes = result.space_reclaimed;
                log.push(format!("Removed {count} image(s), reclaimed {bytes} bytes"));
            }
            Err(e) => log.push(format!("Failed to prune images: {e}")),
        }
    }

    // Docker resource pruning: volumes
    if scope == "volumes" {
        match VolumeManager::prune(state.rt().await.as_ref()).await {
            Ok(bytes) => log.push(format!("Pruned volumes, reclaimed {bytes} bytes")),
            Err(e) => log.push(format!("Failed to prune volumes: {e}")),
        }
    }

    // Docker resource pruning: networks
    if scope == "networks" {
        match state.rt().await.docker.prune_networks::<String>(None).await {
            Ok(result) => {
                let count = result.networks_deleted.map(|n| n.len()).unwrap_or(0);
                log.push(format!("Removed {count} unused network(s)"));
            }
            Err(e) => log.push(format!("Failed to prune networks: {e}")),
        }
    }

    // Docker resource pruning: build cache (via CLI since bollard doesn't expose this)
    if scope == "build_cache" {
        use std::process::Stdio;
        let runtime_cmd = if state.rt().await.kind() == orca_core::runtime::RuntimeKind::Podman {
            "podman"
        } else {
            "docker"
        };
        match tokio::process::Command::new(runtime_cmd)
            .args(["builder", "prune", "-f"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .await
        {
            Ok(output) => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                if output.status.success() {
                    let reclaimed_line = stdout.lines()
                        .find(|l| l.contains("reclaimed") || l.contains("Total:"))
                        .unwrap_or("Build cache cleared");
                    log.push(reclaimed_line.to_string());
                } else {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    log.push(format!("Build cache prune failed: {stderr}"));
                }
            }
            Err(e) => log.push(format!("Failed to run build cache prune: {e}")),
        }
    }

    if log.is_empty() {
        log.push("Nothing to clean up".to_string());
    }

    Ok(Json(serde_json::json!({ "log": log })))
}

// --- Runtime Reconnect ---

/// Helper: extend PATH with common macOS binary locations.
fn extended_path() -> String {
    format!(
        "/opt/homebrew/bin:/usr/local/bin:/opt/homebrew/sbin:/usr/local/sbin:{}",
        std::env::var("PATH").unwrap_or_default()
    )
}

/// Try to ping a Docker socket and return the server version + client on success.
async fn try_socket_ping(socket_path: &str) -> Option<(String, bollard::Docker)> {
    let docker = bollard::Docker::connect_with_socket(
        socket_path, 120, bollard::API_DEFAULT_VERSION,
    ).ok()?;
    let ver = docker.version().await.ok()?;
    ver.version.map(|v| (v, docker))
}

async fn reconnect_runtime(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, ApiError> {
    let mut log = Vec::new();
    let mut connected_version: Option<String> = None;
    let mut connected_method: Option<String> = None;
    let mut connected_docker: Option<bollard::Docker> = None;

    log.push("Checking Docker connectivity...".to_string());
    log.push("".to_string());

    // 1. Check DOCKER_HOST env var
    match std::env::var("DOCKER_HOST") {
        Ok(host) => {
            log.push(format!("DOCKER_HOST: {host}"));
            if let Some(path) = host.strip_prefix("unix://") {
                let exists = std::path::Path::new(path).exists();
                if exists {
                    match try_socket_ping(path).await {
                        Some((v, docker_client)) => {
                            log.push(format!("  Socket exists \u{2713} \u{2192} Docker {v} \u{2713}"));
                            connected_version = Some(v.clone());
                            connected_method = Some(format!("DOCKER_HOST ({path})"));
                            connected_docker = Some(docker_client);
                        }
                        None => log.push("  Socket exists but ping failed".to_string()),
                    }
                } else {
                    log.push(format!("  Socket {path}: not found"));
                }
            }
        }
        Err(_) => log.push("DOCKER_HOST: not set".to_string()),
    }

    // 2. Check Docker context
    let extended = extended_path();
    match tokio::process::Command::new("docker")
        .env("PATH", &extended)
        .args(["context", "inspect", "--format", "{{.Name}} \u{2192} {{.Endpoints.docker.Host}}"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .await
    {
        Ok(out) if out.status.success() => {
            let ctx = String::from_utf8_lossy(&out.stdout).trim().to_string();
            log.push(format!("Docker context: {ctx}"));
            // Try to extract socket path from context
            if let Some(uri) = ctx.split('\u{2192}').nth(1) {
                let uri = uri.trim();
                if let Some(path) = uri.strip_prefix("unix://") {
                    let exists = std::path::Path::new(path).exists();
                    if exists && connected_version.is_none() {
                        if let Some((v, _docker_client)) = try_socket_ping(path).await {
                            log.push(format!("  Context socket: found \u{2713} \u{2192} Docker {v} \u{2713}"));
                            connected_version = Some(v);
                            connected_method = Some(format!("Docker context ({path})"));
                        } else {
                            log.push("  Context socket: found but ping failed".to_string());
                        }
                    } else if !exists {
                        log.push(format!("  Context socket {path}: not found (stale context?)"));
                    }
                }
            }
        }
        _ => log.push("Docker context: not available".to_string()),
    }
    log.push("".to_string());

    // 3. Check all known socket paths
    let home = std::env::var("HOME").unwrap_or_default();
    let socket_candidates: Vec<(&str, String)> = vec![
        ("Standard Docker", "/var/run/docker.sock".to_string()),
        ("Docker Desktop", format!("{home}/.docker/run/docker.sock")),
        ("Docker Desktop (alt)", format!("{home}/.docker/desktop/docker.sock")),
        ("Docker Desktop (legacy)", format!("{home}/Library/Containers/com.docker.docker/Data/docker.raw.sock")),
        ("Lima VM 'orca'", format!("{home}/.lima/orca/sock/docker.sock")),
        ("Lima VM 'docker'", format!("{home}/.lima/docker/sock/docker.sock")),
        ("Lima VM 'default'", format!("{home}/.lima/default/sock/docker.sock")),
        ("Lima VM 'colima'", format!("{home}/.lima/colima/sock/docker.sock")),
        ("Colima default", format!("{home}/.colima/default/docker.sock")),
        ("Colima docker", format!("{home}/.colima/docker/docker.sock")),
    ];

    // Podman sockets
    let mut podman_candidates: Vec<(&str, String)> = Vec::new();
    if let Ok(uid) = std::env::var("UID").or_else(|_| {
        // UID isn't always set; try id -u
        std::process::Command::new("id").arg("-u").output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .map_err(|e| e.to_string())
    }) {
        podman_candidates.push(("Podman (user)", format!("/run/user/{uid}/podman/podman.sock")));
    }
    podman_candidates.push(("Podman (root)", "/run/podman/podman.sock".to_string()));

    for (label, path) in socket_candidates.iter().chain(podman_candidates.iter()) {
        let exists = std::path::Path::new(path).exists();
        if exists {
            match try_socket_ping(path).await {
                Some((v, docker_client)) => {
                    log.push(format!("Socket {path}: found \u{2713} \u{2192} Docker {v} \u{2713}"));
                    if connected_version.is_none() {
                        connected_version = Some(v.clone());
                        connected_method = Some(format!("{label} ({path})"));
                        connected_docker = Some(docker_client);
                    }
                }
                None => log.push(format!("Socket {path}: found but ping failed")),
            }
        } else {
            log.push(format!("Socket {path}: not found"));
        }
    }
    log.push("".to_string());

    // 4. On macOS, check Lima VMs and try to start if needed
    #[cfg(target_os = "macos")]
    if connected_version.is_none() {
        // Check Lima VMs
        match tokio::process::Command::new("limactl")
            .env("PATH", &extended)
            .args(["list", "--format", "{{.Name}} {{.Status}} {{.Memory}} {{.CPUs}}"])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output()
            .await
        {
            Ok(out) if out.status.success() => {
                let text = String::from_utf8_lossy(&out.stdout);
                for line in text.lines() {
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    if parts.len() >= 2 {
                        let name = parts[0];
                        let status = parts[1];
                        let extra = if parts.len() >= 4 {
                            format!(" ({}, {} CPUs)", parts[2], parts[3])
                        } else {
                            String::new()
                        };
                        log.push(format!("Lima VM '{name}': {status}{extra}"));

                        if status != "Running" && (name == "orca" || name == "docker") {
                            log.push(format!("  Starting Lima VM '{name}'..."));
                            match tokio::process::Command::new("limactl")
                                .env("PATH", &extended)
                                .args(["start", name])
                                .stdout(std::process::Stdio::piped())
                                .stderr(std::process::Stdio::piped())
                                .output()
                                .await
                            {
                                Ok(r) if r.status.success() => {
                                    log.push(format!("  Lima VM '{name}' started successfully"));
                                    // Wait for socket to appear
                                    let socket = format!("{home}/.lima/{name}/sock/docker.sock");
                                    for attempt in 1..=15 {
                                        if std::path::Path::new(&socket).exists() {
                                            if let Some((v, docker_client)) = try_socket_ping(&socket).await {
                                                log.push(format!("  Socket ready \u{2713} \u{2192} Docker {v} \u{2713} (attempt {attempt})"));
                                                connected_version = Some(v.clone());
                                                connected_method = Some(format!("Lima VM '{name}' ({socket})"));
                                                connected_docker = Some(docker_client);
                                                break;
                                            }
                                        }
                                        if attempt <= 14 {
                                            tokio::time::sleep(Duration::from_secs(2)).await;
                                        }
                                    }
                                    if connected_version.is_none() {
                                        log.push(format!("  Socket not available after 30s"));
                                    }
                                }
                                Ok(r) => {
                                    let err = String::from_utf8_lossy(&r.stderr).trim().to_string();
                                    log.push(format!("  Failed to start: {err}"));
                                }
                                Err(e) => log.push(format!("  Failed to start: {e}")),
                            }
                            if connected_version.is_some() {
                                break;
                            }
                        }
                    }
                }
            }
            Ok(_) => log.push("Lima: limactl returned an error".to_string()),
            Err(_) => log.push("Lima: limactl not found".to_string()),
        }
        log.push("".to_string());
    }

    // Windows-specific checks
    #[cfg(target_os = "windows")]
    {
        log.push("Method: Windows named pipe".to_string());
        match bollard::Docker::connect_with_named_pipe_defaults() {
            Ok(docker) => {
                match docker.version().await {
                    Ok(ver) => {
                        let v = ver.version.unwrap_or_default();
                        log.push(format!("  Connected! Docker {v}"));
                        if connected_version.is_none() {
                            connected_version = Some(v);
                            connected_method = Some("Windows named pipe".to_string());
                        }
                    }
                    Err(e) => log.push(format!("  Pipe exists but ping failed: {e}")),
                }
            }
            Err(e) => log.push(format!("  Not available: {e}")),
        }

        log.push("".to_string());
        log.push("Method: TCP localhost:2375".to_string());
        match bollard::Docker::connect_with_http(
            "http://localhost:2375", 120, bollard::API_DEFAULT_VERSION
        ) {
            Ok(docker) => {
                match docker.version().await {
                    Ok(ver) => {
                        let v = ver.version.unwrap_or_default();
                        log.push(format!("  Connected! Docker {v}"));
                        if connected_version.is_none() {
                            connected_version = Some(v);
                            connected_method = Some("TCP localhost:2375".to_string());
                        }
                    }
                    Err(e) => log.push(format!("  TCP connection failed: {e}")),
                }
            }
            Err(e) => log.push(format!("  Not available: {e}")),
        }

        if connected_version.is_none() {
            log.push("".to_string());
            log.push("Method: Docker via WSL CLI".to_string());
            match tokio::process::Command::new("wsl")
                .args(["docker", "version", "--format", "{{.Server.Version}}"])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .output()
                .await
            {
                Ok(out) if out.status.success() => {
                    let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    log.push(format!("  Docker {v} is running in WSL"));
                    log.push("  Attempting to configure TCP listener...".to_string());

                    let configure_result = tokio::process::Command::new("wsl")
                        .args(["-u", "root", "--", "bash", "-c",
                            "mkdir -p /etc/systemd/system/docker.service.d && \
                             echo -e '[Service]\\nExecStart=\\nExecStart=/usr/bin/dockerd -H fd:// -H tcp://0.0.0.0:2375 --containerd=/run/containerd/containerd.sock' \
                             > /etc/systemd/system/docker.service.d/override.conf && \
                             systemctl daemon-reload && service docker restart"])
                        .output()
                        .await;

                    match configure_result {
                        Ok(r) if r.status.success() => {
                            log.push("  TCP listener configured and Docker restarted!".to_string());
                            tokio::time::sleep(Duration::from_secs(3)).await;
                            if let Ok(docker) = bollard::Docker::connect_with_http(
                                "http://localhost:2375", 120, bollard::API_DEFAULT_VERSION
                            ) {
                                if let Ok(ver) = docker.version().await {
                                    let v2 = ver.version.unwrap_or_default();
                                    log.push(format!("  Connected via TCP! Docker {v2}"));
                                    connected_version = Some(v2);
                                    connected_method = Some("TCP (auto-configured WSL)".to_string());
                                }
                            }
                            if connected_version.is_none() {
                                log.push("  TCP configured but connection still failing.".to_string());
                            }
                        }
                        _ => {
                            log.push("  Failed to auto-configure TCP listener.".to_string());
                        }
                    }
                }
                Ok(out) => {
                    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
                    log.push(format!("  Docker not running in WSL: {err}"));
                }
                Err(e) => log.push(format!("  WSL not available: {e}")),
            }
        }
    }

    // Hot-swap the runtime if we found a working connection
    if let Some(docker) = connected_docker {
        let new_runtime = Arc::new(orca_backend_common::BollardRuntime::new(docker));
        state.swap_runtime(new_runtime).await;
        log.push("".to_string());
        log.push("\u{2713} Runtime connection updated — Docker is now connected.".to_string());
    }

    // Summary
    log.push("".to_string());
    if let (Some(version), Some(method)) = (&connected_version, &connected_method) {
        log.push(format!("Result: Docker {version} is reachable via {method}."));
        log.push("Connected successfully — no restart needed.".to_string());
        Ok(Json(serde_json::json!({
            "connected": true,
            "method": method,
            "version": version,
            "log": log,
        })))
    } else {
        log.push("Result: No working Docker connection found.".to_string());
        log.push("Action: Install a container runtime via System Health, then restart Orca.".to_string());
        Ok(Json(serde_json::json!({
            "connected": false,
            "method": serde_json::Value::Null,
            "version": serde_json::Value::Null,
            "log": log,
        })))
    }
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
