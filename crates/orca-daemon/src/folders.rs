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
    // A file (a compose file or anything else dropped on the window) stands for its folder.
    let path = if path.is_file() {
        path.parent().map(Path::to_path_buf).unwrap_or(path)
    } else {
        path
    };
    if !path.is_dir() {
        return Err(ApiError::bad_request(format!("'{p}' is not a folder")));
    }
    Ok(path)
}

/// The compose project name Compose gives a folder: lowercased, only
/// letters, digits, `-` and `_`, not starting with `-` or `_`.
pub fn project_name(dir: &Path) -> anyhow::Result<String> {
    let name: String = dir
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    let name = name.trim_start_matches(['-', '_']).to_string();
    if name.is_empty() {
        anyhow::bail!(
            "Compose can't name a project after the folder '{}'. Rename it to start with a letter or digit.",
            dir.file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default()
        );
    }
    Ok(name)
}

/// `POST /folders/inspect`: what Orca would start from a folder.
pub async fn inspect(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PathBody>,
) -> Result<impl IntoResponse, ApiError> {
    let dir = folder(&body.path)?;
    let dir_str = dir.to_string_lossy().to_string();
    let name = project_name(&dir).map_err(|e| ApiError::bad_request(e.to_string()))?;
    let orca_yaml = ["orca.yaml", "orca.yml"].iter().any(|f| dir.join(f).is_file());
    let git = dir.join(".git").exists();

    // orca.yaml's `compose:` list, else the files Compose finds by itself.
    let mut error = None;
    let listed = crate::api::orca_yaml_compose_files(&dir).unwrap_or_else(|e| {
        error = Some(e.to_string());
        None
    });
    let config = listed.as_ref().map(|l| l.join(","));
    let compose_files: Vec<String> = match &listed {
        Some(files) => files
            .iter()
            .map(|f| {
                Path::new(f)
                    .strip_prefix(&dir)
                    .map(|r| r.to_string_lossy().to_string())
                    .unwrap_or_else(|_| f.clone())
            })
            .collect(),
        None => COMPOSE_FILE_NAMES
            .iter()
            .filter(|f| dir.join(f).is_file())
            .map(|f| f.to_string())
            .collect(),
    };

    // A stack with this name: from this folder (already running), or from
    // another folder with the same name, which starting this one would replace.
    let (mut stack, mut conflict) = (None, None);
    if let Ok(containers) = state.rt().await.list_containers(true).await {
        for s in compose::extract_projects(&containers) {
            let from = s.working_dir.as_deref().and_then(|w| Path::new(w).canonicalize().ok());
            if from.as_deref() == Some(dir.as_path()) {
                stack = Some(s.name);
            } else if s.name == name {
                conflict = s.working_dir.clone();
            }
        }
    }

    let (mut services, mut profiles) = (Vec::new(), Vec::new());
    if !compose_files.is_empty() && error.is_none() {
        match crate::stack_profiles::load_model(&state, &name, &dir_str, config.as_deref()).await {
            Ok(model) => {
                services = model.services.keys().cloned().collect();
                profiles = model_profiles(&model);
            }
            Err(e) => error = Some(e.to_string()),
        }
    }

    Ok(Json(serde_json::json!({
        "path": dir_str,
        // For people: `~/code/shop` rather than the full home path.
        "display_path": dirs::home_dir()
            .and_then(|h| dir.strip_prefix(&h).ok().map(|r| format!("~/{}", r.display())))
            .unwrap_or_else(|| dir_str.clone()),
        "name": name,
        "compose_files": compose_files,
        "orca_yaml": orca_yaml,
        "git": git,
        "services": services,
        "profiles": profiles,
        "stack": stack,
        "conflict": conflict,
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
    // Check the file's own structure only: variables from an .env that
    // doesn't exist yet, or another file next to it, aren't its problem.
    let dir_str = dir.to_string_lossy().to_string();
    let file_str = file.to_string_lossy().to_string();
    let args = ["config", "-q", "--no-interpolate"].map(String::from);
    match state.rt().await.compose_args(&dir_str, Some(&file_str), &args).await {
        Ok(out) if !out.success => {
            let _ = std::fs::remove_file(&file);
            Err(ApiError::bad_request(format!("Not saved: {}", out.stderr.trim())))
        }
        // Valid, or Compose couldn't run to check it: keep the file.
        _ => Ok(Json(serde_json::json!({ "path": file_str }))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_like_compose() {
        assert_eq!(project_name(Path::new("/x/My Shop.v2")).unwrap(), "myshopv2");
        assert_eq!(project_name(Path::new("/x/shop-api_1")).unwrap(), "shop-api_1");
        assert_eq!(project_name(Path::new("/x/_shop")).unwrap(), "shop");
        assert!(project_name(Path::new("/x/日本")).is_err());
    }
}
