//! A stack's compose files, for the stack page's editor. Only the files
//! Compose itself recorded for the stack (its `config_files` label) can be
//! read or written, wherever the project lives.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path as UrlPath, State};
use axum::response::IntoResponse;
use serde::Deserialize;

use crate::api::{ApiError, resolve_stack_dir};
use crate::state::AppState;

/// The stack's compose files, in the order compose was given them.
async fn files_of(state: &AppState, name: &str) -> Result<Vec<String>, ApiError> {
    let (_, config) = resolve_stack_dir(state, name).await?;
    Ok(config
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|f| !f.is_empty())
        .map(String::from)
        .collect())
}

/// GET /stacks/{name}/compose-files
pub async fn get(
    State(state): State<Arc<AppState>>,
    UrlPath(name): UrlPath<String>,
) -> Result<impl IntoResponse, ApiError> {
    let files = files_of(&state, &name).await?;
    let out: Vec<serde_json::Value> = files
        .iter()
        .map(|path| match std::fs::read_to_string(path) {
            Ok(text) => serde_json::json!({ "path": path, "text": text }),
            Err(e) => serde_json::json!({ "path": path, "error": e.to_string() }),
        })
        .collect();
    Ok(Json(serde_json::json!({ "files": out })))
}

#[derive(Deserialize)]
pub struct SaveBody {
    path: String,
    text: String,
}

/// PUT /stacks/{name}/compose-files: write one of the stack's compose files.
pub async fn save(
    State(state): State<Arc<AppState>>,
    UrlPath(name): UrlPath<String>,
    Json(body): Json<SaveBody>,
) -> Result<impl IntoResponse, ApiError> {
    let files = files_of(&state, &name).await?;
    if !files.contains(&body.path) {
        return Err(ApiError::bad_request(format!(
            "'{}' is not one of the compose files of '{name}'",
            body.path
        )));
    }
    if body.text.trim().is_empty() {
        return Err(ApiError::bad_request("The compose file can't be empty".to_string()));
    }
    if let Err(e) = serde_yaml::from_str::<serde_yaml::Value>(&body.text) {
        return Err(ApiError::bad_request(format!("Not saved: the YAML is not valid ({e})")));
    }
    std::fs::write(&body.path, &body.text).map_err(|e| anyhow::anyhow!("Could not write {}: {e}", body.path))?;
    Ok(Json(serde_json::json!({ "path": body.path })))
}
