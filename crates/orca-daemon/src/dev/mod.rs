//! Worktree dev instances: REST API under `/api/v1/dev`.
//!
//! A registered git repo (project) runs one instance per worktree, with
//! infrastructure in a shared stack. See `orca_core::dev` for the planning
//! logic; this module does the I/O and keeps state.

pub mod activity;
pub mod data;
pub mod deploy;
pub mod hostcheck;
pub mod jobs;
pub mod ops;
pub mod project;
pub mod setup;

use std::path::PathBuf;
use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
};
use orca_core::dev::{DevProject, OrcaYaml};
use serde::Deserialize;

use crate::state::AppState;
use project::ProjectCtx;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/dev/projects", get(list_projects).post(add_project))
        .route("/dev/projects/{id}", get(get_project).delete(remove_project))
        .route("/dev/projects/{id}/setup", get(setup_analysis))
        .route("/dev/projects/{id}/orca-yaml", axum::routing::put(write_orca_yaml))
        .route("/dev/projects/{id}/orca-yaml/validate", post(validate_orca_yaml))
        .route("/dev/projects/{id}/agents-snippet", post(add_agents_snippet))
        .route("/dev/projects/{id}/adopt", post(adopt_stack))
        .route("/dev/projects/{id}/shared/up", post(shared_up))
        .route("/dev/projects/{id}/shared/down", post(shared_down))
        .route(
            "/dev/projects/{id}/instances/{name}",
            axum::routing::put(update_instance),
        )
        .route("/dev/projects/{id}/instances/{name}/plan", get(instance_plan))
        .route("/dev/projects/{id}/instances/{name}/up", post(instance_up))
        .route("/dev/projects/{id}/instances/{name}/down", post(instance_down))
        .route("/dev/projects/{id}/instances/{name}/remove", post(instance_remove))
        .route("/dev/projects/{id}/instances/{name}/logs", get(instance_logs))
        .route("/dev/projects/{id}/instances/{name}/data", get(instance_data))
        .route(
            "/dev/projects/{id}/instances/{name}/host-routes/{service}",
            post(add_host_route).delete(remove_host_route),
        )
        .route(
            "/dev/projects/{id}/instances/{name}/data/{service}/reset",
            post(instance_data_reset),
        )
        .route("/dev/jobs", get(list_jobs))
        .route("/dev/jobs/{id}", get(get_job))
        .route("/dev/resolve", post(resolve))
        .route("/dev/candidates", get(candidates))
}

/// Errors as `{"error": "..."}` with a status code.
pub struct DevError(StatusCode, String);

impl DevError {
    fn bad(msg: impl Into<String>) -> Self {
        DevError(StatusCode::BAD_REQUEST, msg.into())
    }
}

impl From<anyhow::Error> for DevError {
    fn from(e: anyhow::Error) -> Self {
        // Most failures here are about the user's project, not the daemon.
        DevError(StatusCode::BAD_REQUEST, format!("{e:#}"))
    }
}

impl IntoResponse for DevError {
    fn into_response(self) -> axum::response::Response {
        (self.0, Json(serde_json::json!({ "error": self.1 }))).into_response()
    }
}

type R<T> = Result<T, DevError>;

#[derive(Deserialize, Default)]
struct DetailQuery {
    /// Include git details (dirty, commits ahead). Slower.
    #[serde(default)]
    details: bool,
}

async fn list_projects(State(state): State<Arc<AppState>>, Query(q): Query<DetailQuery>) -> R<impl IntoResponse> {
    let ids: Vec<String> = state
        .config
        .lock()
        .await
        .dev_projects
        .iter()
        .map(|p| p.id.clone())
        .collect();
    let mut out = Vec::new();
    for id in ids {
        match ProjectCtx::load(&state, &id).await {
            Ok(ctx) => {
                out.push(serde_json::to_value(project::build_view(&state, &ctx, q.details).await).unwrap_or_default())
            }
            Err(e) => {
                let root = {
                    let cfg = state.config.lock().await;
                    cfg.dev_projects.iter().find(|p| p.id == id).map(|p| p.root.clone())
                };
                out.push(serde_json::json!({ "id": id, "root": root, "errors": [format!("{e:#}")], "instances": [], "shared": [] }));
            }
        }
    }
    Ok(Json(out))
}

async fn get_project(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(q): Query<DetailQuery>,
) -> R<impl IntoResponse> {
    let ctx = ProjectCtx::load(&state, &id).await?;
    Ok(Json(project::build_view(&state, &ctx, q.details).await))
}

#[derive(Deserialize)]
struct AddProject {
    path: String,
}

async fn add_project(State(state): State<Arc<AppState>>, Json(body): Json<AddProject>) -> R<impl IntoResponse> {
    let given = PathBuf::from(body.path.trim());
    if !given.is_absolute() {
        return Err(DevError::bad("path must be absolute"));
    }
    if !given.is_dir() {
        return Err(DevError::bad(format!("{} is not a folder", given.display())));
    }
    let root = ops::main_root(&given).await?;
    let yaml = OrcaYaml::load(&root).unwrap_or_default();
    // Make sure there is something to run before registering.
    ops::compose_files(&root, yaml.compose.as_ref().map(|c| c.to_vec()))?;

    let base = yaml
        .project
        .as_deref()
        .and_then(orca_core::dev::naming::slugify)
        .or_else(|| {
            root.file_name()
                .and_then(|n| orca_core::dev::naming::slugify(&n.to_string_lossy()))
        })
        .unwrap_or_else(|| "project".to_string());

    let mut cfg = state.config.lock().await;
    if let Some(existing) = cfg.dev_projects.iter().find(|p| ops::canonical(&p.root) == root) {
        return Ok((
            StatusCode::OK,
            Json(serde_json::json!({ "id": existing.id, "root": existing.root, "existing": true })),
        ));
    }
    let taken: Vec<String> = cfg.dev_projects.iter().map(|p| p.id.clone()).collect();
    let id = orca_core::dev::naming::unique_name(&base, &taken);
    cfg.dev_projects.push(DevProject {
        id: id.clone(),
        root: root.clone(),
        added_at: chrono::Utc::now().to_rfc3339(),
        shared_project: None,
        instances: Vec::new(),
    });
    cfg.save()?;
    Ok((
        StatusCode::CREATED,
        Json(serde_json::json!({ "id": id, "root": root, "existing": false })),
    ))
}

async fn remove_project(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> R<impl IntoResponse> {
    // Refuse while anything runs, so nothing is left without an owner.
    if let Ok(ctx) = ProjectCtx::load(&state, &id).await {
        let view = project::build_view(&state, &ctx, false).await;
        let running: Vec<&str> = view
            .instances
            .iter()
            .filter(|i| !i.services.is_empty())
            .map(|i| i.name.as_str())
            .collect();
        if !running.is_empty() || view.shared.iter().any(|s| s.status != "not_started") {
            return Err(DevError::bad(format!(
                "stop everything in '{id}' first (instances with containers: {}{})",
                if running.is_empty() {
                    "none".to_string()
                } else {
                    running.join(", ")
                },
                if view.shared.iter().any(|s| s.status != "not_started") {
                    "; shared services are up"
                } else {
                    ""
                }
            )));
        }
    }
    let mut cfg = state.config.lock().await;
    let before = cfg.dev_projects.len();
    cfg.dev_projects.retain(|p| p.id != id);
    if cfg.dev_projects.len() == before {
        return Err(DevError(
            StatusCode::NOT_FOUND,
            format!("project '{id}' is not registered"),
        ));
    }
    cfg.save()?;
    Ok(StatusCode::NO_CONTENT)
}

async fn job_response(job: jobs::JobHandle) -> impl IntoResponse {
    (StatusCode::ACCEPTED, Json(job.snapshot().await))
}

async fn shared_up(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> R<impl IntoResponse> {
    Ok(job_response(deploy::shared_up(state, id).await?).await)
}

async fn shared_down(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> R<impl IntoResponse> {
    Ok(job_response(deploy::shared_down(state, id).await?).await)
}

#[derive(Deserialize)]
struct PlanQuery {
    preset: Option<String>,
    /// Data modes to preview: `postgres:own-database,redis:shared`.
    data: Option<String>,
}

fn parse_modes(s: &str) -> R<std::collections::BTreeMap<String, orca_core::dev::DataMode>> {
    let mut out = std::collections::BTreeMap::new();
    for part in s.split(',').filter(|p| !p.is_empty()) {
        let (svc, mode) = part
            .split_once(':')
            .ok_or_else(|| DevError::bad(format!("bad data mode '{part}', expected service:mode")))?;
        let mode: orca_core::dev::DataMode = serde_json::from_value(serde_json::Value::String(mode.to_string()))
            .map_err(|_| DevError::bad(format!("unknown data mode '{mode}'")))?;
        out.insert(svc.to_string(), mode);
    }
    Ok(out)
}

async fn instance_plan(
    State(state): State<Arc<AppState>>,
    Path((id, name)): Path<(String, String)>,
    Query(q): Query<PlanQuery>,
) -> R<impl IntoResponse> {
    activity::touch(&id, &name).await;
    let preset = q.preset.filter(|p| !p.is_empty());
    let modes = q.data.as_deref().map(parse_modes).transpose()?;
    Ok(Json(
        deploy::plan_view(&state, &id, &name, preset.as_deref(), modes.as_ref()).await?,
    ))
}

async fn instance_up(
    State(state): State<Arc<AppState>>,
    Path((id, name)): Path<(String, String)>,
    body: Option<Json<deploy::UpOptions>>,
) -> R<impl IntoResponse> {
    let opts = body.map(|b| b.0).unwrap_or_default();
    activity::touch(&id, &name).await;
    Ok(job_response(deploy::up(state, id, name, opts).await?).await)
}

async fn instance_down(
    State(state): State<Arc<AppState>>,
    Path((id, name)): Path<(String, String)>,
) -> R<impl IntoResponse> {
    Ok(job_response(deploy::down(state, id, name, deploy::DownMode::Stop).await?).await)
}

async fn instance_remove(
    State(state): State<Arc<AppState>>,
    Path((id, name)): Path<(String, String)>,
) -> R<impl IntoResponse> {
    Ok(job_response(deploy::down(state, id, name, deploy::DownMode::Remove).await?).await)
}

async fn update_instance(
    State(state): State<Arc<AppState>>,
    Path((id, name)): Path<(String, String)>,
    Json(body): Json<deploy::InstanceSettings>,
) -> R<impl IntoResponse> {
    let final_name = deploy::update_settings(&state, &id, &name, body).await?;
    Ok(Json(serde_json::json!({ "name": final_name })))
}

#[derive(Deserialize)]
struct LogsQuery {
    service: Option<String>,
    tail: Option<u32>,
    since: Option<String>,
}

async fn instance_logs(
    State(state): State<Arc<AppState>>,
    Path((id, name)): Path<(String, String)>,
    Query(q): Query<LogsQuery>,
) -> R<impl IntoResponse> {
    activity::touch(&id, &name).await;
    let tail = q.tail.unwrap_or(300).min(5000);
    let text = deploy::logs(&state, &id, &name, q.service.as_deref(), tail, q.since.as_deref()).await?;
    Ok(Json(serde_json::json!({ "logs": text })))
}

#[derive(Deserialize)]
struct JobsQuery {
    project: Option<String>,
}

async fn list_jobs(Query(q): Query<JobsQuery>) -> impl IntoResponse {
    Json(jobs::list(q.project.as_deref()).await)
}

async fn get_job(Path(id): Path<String>) -> R<impl IntoResponse> {
    jobs::get(&id)
        .await
        .map(Json)
        .ok_or_else(|| DevError(StatusCode::NOT_FOUND, format!("job '{id}' not found")))
}

#[derive(Deserialize)]
struct ResolveBody {
    path: String,
}

async fn resolve(State(state): State<Arc<AppState>>, Json(body): Json<ResolveBody>) -> R<impl IntoResponse> {
    let (project, instance, worktree) = deploy::resolve_path(&state, std::path::Path::new(&body.path)).await?;
    // The CLI resolves on every command, so this marks the instance as used.
    activity::touch(&project, &instance).await;
    Ok(Json(
        serde_json::json!({ "project": project, "instance": instance, "worktree": worktree }),
    ))
}

/// Git repos that have compose stacks running but aren't registered yet,
/// so the UI can offer them with one click.
async fn candidates(State(state): State<Arc<AppState>>) -> R<impl IntoResponse> {
    use orca_core::runtime::ContainerRuntime;
    let containers = state.rt().await.list_containers(true).await.map_err(DevError::from)?;
    let registered: Vec<PathBuf> = state
        .config
        .lock()
        .await
        .dev_projects
        .iter()
        .map(|p| ops::canonical(&p.root))
        .collect();
    let mut dirs: std::collections::BTreeMap<String, std::collections::BTreeSet<String>> = Default::default();
    for c in &containers {
        // Orca's own instances are already accounted for.
        if c.labels.contains_key(orca_core::dev::LABEL_PROJECT) {
            continue;
        }
        if let (Some(dir), Some(p)) = (
            c.labels.get("com.docker.compose.project.working_dir"),
            c.labels.get("com.docker.compose.project"),
        ) {
            dirs.entry(dir.clone()).or_default().insert(p.clone());
        }
    }
    let mut out: Vec<serde_json::Value> = Vec::new();
    let mut seen: Vec<PathBuf> = Vec::new();
    for (dir, stacks) in dirs {
        let path = PathBuf::from(&dir);
        if !path.is_dir() {
            continue;
        }
        let Ok(root) = ops::main_root(&path).await else {
            continue;
        };
        if registered.contains(&root) || seen.contains(&root) {
            continue;
        }
        seen.push(root.clone());
        // An orca.yaml with a `dev:` section is ready for worktree instances.
        let has_dev = OrcaYaml::load(&root).is_ok_and(|y| y.dev.is_some());
        out.push(serde_json::json!({
            "root": root,
            "name": root.file_name().map(|n| n.to_string_lossy().to_string()),
            "stacks": stacks,
            "has_dev": has_dev,
        }));
    }
    Ok(Json(out))
}

async fn instance_data(
    State(state): State<Arc<AppState>>,
    Path((id, name)): Path<(String, String)>,
) -> R<impl IntoResponse> {
    Ok(Json(deploy::data_info(&state, &id, &name).await?))
}

async fn instance_data_reset(
    State(state): State<Arc<AppState>>,
    Path((id, name, service)): Path<(String, String, String)>,
) -> R<impl IntoResponse> {
    Ok(job_response(deploy::data_reset(state, id, name, service).await?).await)
}

async fn setup_analysis(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> R<impl IntoResponse> {
    Ok(Json(setup::analyse(&state, &id).await?))
}

async fn write_orca_yaml(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<setup::WriteRequest>,
) -> R<impl IntoResponse> {
    let (path, text) = setup::write(&state, &id, req).await?;
    Ok(Json(serde_json::json!({ "path": path, "text": text })))
}

#[derive(Deserialize)]
struct ValidateBody {
    text: String,
    /// Also dry-run this instance with the config.
    instance: Option<String>,
}

async fn validate_orca_yaml(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<ValidateBody>,
) -> R<impl IntoResponse> {
    let v = setup::validate(&body.text);
    let mut plan = None;
    let mut plan_error = None;
    if let (true, Some(dev), Some(name)) = (v.ok, v.dev.clone(), body.instance) {
        match deploy::plan_view_with(&state, &id, &name, None, None, Some(&dev)).await {
            Ok(p) => plan = Some(p),
            Err(e) => plan_error = Some(format!("{e:#}")),
        }
    }
    Ok(Json(
        serde_json::json!({ "validation": v, "plan": plan, "plan_error": plan_error }),
    ))
}

async fn add_agents_snippet(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> R<impl IntoResponse> {
    let path = setup::add_snippet(&state, &id).await?;
    Ok(Json(serde_json::json!({ "path": path })))
}

#[derive(Deserialize)]
struct AdoptBody {
    project: String,
}

async fn adopt_stack(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<AdoptBody>,
) -> R<impl IntoResponse> {
    setup::adopt(&state, &id, &body.project).await?;
    Ok(Json(serde_json::json!({ "shared_project": body.project })))
}

async fn add_host_route(
    State(state): State<Arc<AppState>>,
    Path((id, name, service)): Path<(String, String, String)>,
) -> R<impl IntoResponse> {
    activity::touch(&id, &name).await;
    Ok(Json(deploy::add_host_route(&state, &id, &name, &service).await?))
}

async fn remove_host_route(
    State(state): State<Arc<AppState>>,
    Path((id, name, service)): Path<(String, String, String)>,
) -> R<impl IntoResponse> {
    deploy::remove_host_route(&state, &id, &name, &service).await?;
    Ok(StatusCode::NO_CONTENT)
}
