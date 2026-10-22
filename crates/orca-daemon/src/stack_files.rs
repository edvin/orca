//! A stack's compose files, for the stack page's editor. Only the files
//! Compose itself recorded for the stack (its `config_files` label) can be
//! read or written, and only YAML files inside the stack's folder.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path as UrlPath, State};
use axum::response::IntoResponse;
use serde::Deserialize;

use crate::api::{ApiError, resolve_stack_dir};
use crate::state::AppState;

/// The stack's compose files, in the order compose was given them. The
/// list comes from container labels, which an image can set too, so only
/// `.yml`/`.yaml` files inside the stack's own folder are offered.
async fn files_of(state: &AppState, name: &str) -> Result<Vec<String>, ApiError> {
    let (dir, config) = resolve_stack_dir(state, name).await?;
    let dir = std::fs::canonicalize(&dir).unwrap_or_else(|_| dir.into());
    Ok(config
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|f| is_compose_file_in(&dir, f))
        .map(String::from)
        .collect())
}

fn is_compose_file_in(dir: &std::path::Path, file: &str) -> bool {
    let p = std::path::Path::new(file);
    let yaml = matches!(p.extension().and_then(|e| e.to_str()), Some("yml" | "yaml"));
    yaml && std::fs::canonicalize(p).is_ok_and(|real| real.starts_with(dir) && real.is_file())
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

#[cfg(test)]
mod tests {
    #[test]
    fn only_yaml_files_inside_the_stack_folder() {
        let d = std::env::temp_dir().join(format!("orca-stackfiles-{}", std::process::id()));
        std::fs::create_dir_all(d.join("sub")).unwrap();
        let d = d.canonicalize().unwrap();
        for f in ["compose.yaml", "sub/dev.yml", "notes.txt"] {
            std::fs::write(d.join(f), "x").unwrap();
        }
        let ok = |f: &str| super::is_compose_file_in(&d, &d.join(f).to_string_lossy());
        assert!(ok("compose.yaml") && ok("sub/dev.yml"));
        assert!(!ok("notes.txt") && !ok("missing.yaml") && !ok("../outside.yaml"));
        std::fs::remove_dir_all(&d).ok();
    }
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
