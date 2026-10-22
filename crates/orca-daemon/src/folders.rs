//! Opening a project folder: what's in it before Orca starts it, and a
//! first compose file for a folder that has none. Never overwrites a file.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use axum::response::IntoResponse;
use orca_core::compose;
use orca_core::dev::override_gen::model_profiles;
use orca_core::runtime::ContainerRuntime;
use serde::Deserialize;

use crate::api::{ApiError, COMPOSE_FILE_NAMES};
use crate::state::AppState;

#[derive(Deserialize)]
pub struct PathBody {
    path: String,
}

/// An absolute folder that exists, with symlinks resolved.
fn folder(p: &str) -> Result<PathBuf, ApiError> {
    let path = Path::new(p.trim());
    if !path.is_absolute() {
        return Err(ApiError::bad_request(format!("'{p}' is not an absolute path")));
    }
    let path = path
        .canonicalize()
        .map_err(|e| ApiError::bad_request(format!("'{p}' can't be read: {e}")))?;
    if !path.is_dir() {
        return Err(ApiError::bad_request(format!("'{p}' is not a folder")));
    }
    Ok(path)
}

/// The compose project name Compose gives a folder.
pub fn project_name(dir: &Path) -> String {
    dir.file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect()
}

/// `POST /folders/inspect`: what Orca would start from a folder.
pub async fn inspect(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PathBody>,
) -> Result<impl IntoResponse, ApiError> {
    let dir = folder(&body.path)?;
    let dir_str = dir.to_string_lossy().to_string();
    let name = project_name(&dir);
    let compose_files: Vec<&str> = COMPOSE_FILE_NAMES
        .iter()
        .copied()
        .filter(|f| dir.join(f).is_file())
        .collect();
    let orca_yaml = ["orca.yaml", "orca.yml"].iter().any(|f| dir.join(f).is_file());
    let git = dir.join(".git").exists();

    // Already running (or stopped) as a stack, from this folder?
    let stack = match state.rt().await.list_containers(true).await {
        Ok(containers) => compose::extract_projects(&containers)
            .into_iter()
            .find(|s| {
                s.working_dir
                    .as_deref()
                    .and_then(|w| Path::new(w).canonicalize().ok())
                    .as_deref()
                    == Some(dir.as_path())
            })
            .map(|s| s.name),
        Err(_) => None,
    };

    let (mut services, mut profiles, mut error) = (Vec::new(), Vec::new(), None);
    if !compose_files.is_empty() {
        match crate::stack_profiles::load_model(&state, &name, &dir_str, None).await {
            Ok(model) => {
                services = model.services.keys().cloned().collect();
                profiles = model_profiles(&model);
            }
            Err(e) => error = Some(e.to_string()),
        }
    }

    Ok(Json(serde_json::json!({
        "path": dir_str,
        "name": name,
        "compose_files": compose_files,
        "orca_yaml": orca_yaml,
        "git": git,
        "services": services,
        "profiles": profiles,
        "stack": stack,
        "error": error,
    })))
}

#[derive(Deserialize)]
pub struct CreateBody {
    path: String,
    content: String,
}

/// `POST /folders/compose`: write a first `compose.yaml` into a folder that
/// has no compose file. Checked with `compose config` first; nothing is left
/// behind when it's invalid.
pub async fn create_compose(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateBody>,
) -> Result<impl IntoResponse, ApiError> {
    let dir = folder(&body.path)?;
    if let Some(existing) = COMPOSE_FILE_NAMES.iter().find(|f| dir.join(f).is_file()) {
        return Err(ApiError::bad_request(format!(
            "This folder already has {existing}. Orca won't overwrite it; open the folder to start it."
        )));
    }
    if body.content.trim().is_empty() || body.content.len() > 1024 * 1024 {
        return Err(ApiError::bad_request("The compose file is empty or too large"));
    }
    let file = dir.join("compose.yaml");
    {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&file)
            .map_err(|e| ApiError::bad_request(format!("Can't create {}: {e}", file.display())))?;
        f.write_all(body.content.as_bytes())
            .map_err(|e| ApiError::bad_request(format!("Can't write {}: {e}", file.display())))?;
    }
    let dir_str = dir.to_string_lossy().to_string();
    let check = state
        .rt()
        .await
        .compose_args(&dir_str, None, &["config".to_string(), "-q".to_string()])
        .await;
    match check {
        Ok(out) if out.success => Ok(Json(serde_json::json!({ "path": file.to_string_lossy() }))),
        other => {
            let _ = std::fs::remove_file(&file);
            let why = match other {
                Ok(out) => out.stderr.trim().to_string(),
                Err(e) => e.to_string(),
            };
            Err(ApiError::bad_request(format!("Not saved: {why}")))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_like_compose() {
        assert_eq!(project_name(Path::new("/x/My Shop.v2")), "myshopv2");
        assert_eq!(project_name(Path::new("/x/shop-api_1")), "shop-api_1");
    }
}
