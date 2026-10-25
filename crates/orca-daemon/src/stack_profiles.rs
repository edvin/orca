//! Compose profiles of a stack: which optional services run. The choice is
//! remembered per stack on this machine and used whenever Orca starts it,
//! so each developer runs the parts of a project they need.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path as UrlPath, State};
use axum::response::IntoResponse;
use orca_core::compose::{ComposeOutput, ComposeRunner};
use orca_core::dev::ComposeModel;
use orca_core::dev::override_gen::model_profiles;
use orca_core::runtime::{ContainerRuntime, ContainerState};
use serde::Deserialize;

use crate::api::{ApiError, resolve_stack_dir};
use crate::state::AppState;

/// The compose file with every profile enabled, so all services are listed.
pub(crate) async fn load_model(
    state: &AppState,
    name: &str,
    dir: &str,
    config: Option<&str>,
) -> anyhow::Result<ComposeModel> {
    let args: Vec<String> = ["-p", name, "--profile", "*", "config", "--format", "json"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    let out = state.rt().await.compose_args(dir, config, &args).await?;
    if !out.success {
        anyhow::bail!("compose could not read the stack: {}", out.stderr.trim());
    }
    ComposeModel::parse(&out.stdout)
}

/// Services that run with `profiles` active: those without a profile and
/// those in one of them.
fn enabled<'a>(model: &'a ComposeModel, profiles: &[String]) -> Vec<&'a String> {
    model
        .services
        .iter()
        .filter(|(_, s)| s.profiles.is_empty() || s.profiles.iter().any(|p| profiles.contains(p)))
        .map(|(n, _)| n)
        .collect()
}

/// `compose up -d` with the stack's remembered profiles.
pub async fn up(state: &AppState, name: &str, dir: &str, config: Option<&str>) -> anyhow::Result<ComposeOutput> {
    // The databases its orca.yaml requires: made before it starts, and a
    // server that stands in for one of its services keeps that one out.
    let with_databases = crate::databases::prepare(state, name, std::path::Path::new(dir), config, &|m| {
        tracing::info!("{name}: {m}")
    })
    .await?;
    // Without a server now, the override it was started with last time
    // (kept in its containers' labels) is left out.
    let without_override = config.map(|c| {
        c.split(',')
            .filter(|f| !f.trim().ends_with(crate::databases::OVERRIDE_FILE))
            .collect::<Vec<_>>()
            .join(",")
    });
    let config = with_databases
        .as_deref()
        .or(without_override.as_deref().filter(|c| !c.is_empty()));
    let profiles = state.config.lock().await.stack_profiles.get(name).cloned();
    let output = match profiles {
        // Never chosen: whatever compose runs by default.
        None if with_databases.is_none() => state.rt().await.compose_up(dir, config).await?,
        profiles => {
            let mut args = vec!["-p".to_string(), name.to_string()];
            for p in profiles.iter().flatten() {
                args.extend(["--profile".into(), p.clone()]);
            }
            args.extend(["up".into(), "-d".into()]);
            state.rt().await.compose_args(dir, config, &args).await?
        }
    };
    Ok(output)
}

async fn report(state: &AppState, name: &str) -> Result<serde_json::Value, ApiError> {
    let (dir, config) = resolve_stack_dir(state, name).await?;
    let model = load_model(state, name, &dir, config.as_deref()).await?;
    let containers: Vec<_> = state
        .rt()
        .await
        .list_containers(true)
        .await?
        .into_iter()
        .filter(|c| c.labels.get("com.docker.compose.project").map(String::as_str) == Some(name))
        .collect();
    let state_of = |service: &str| {
        containers
            .iter()
            .find(|c| c.labels.get("com.docker.compose.service").map(String::as_str) == Some(service))
            .map(|c| c.state)
    };
    let is_running = |service: &str| matches!(state_of(service), Some(ContainerState::Running));

    let names = model_profiles(&model);
    let remembered = state.config.lock().await.stack_profiles.get(name).cloned();
    // Not chosen in Orca yet: the profiles whose services run now.
    let active = remembered.clone().unwrap_or_else(|| {
        names
            .iter()
            .filter(|p| {
                model
                    .services
                    .iter()
                    .any(|(n, s)| s.profiles.contains(p) && is_running(n))
            })
            .cloned()
            .collect()
    });

    let services: Vec<serde_json::Value> = model
        .services
        .iter()
        .map(|(n, s)| {
            serde_json::json!({
                "name": n,
                "image": s.image,
                "profiles": s.profiles,
                "depends_on": s.depends_on.keys().collect::<Vec<_>>(),
                "state": state_of(n),
            })
        })
        .collect();
    let profiles: Vec<serde_json::Value> = names
        .iter()
        .map(|p| {
            let members: Vec<&String> = model
                .services
                .iter()
                .filter(|(_, s)| s.profiles.contains(p))
                .map(|(n, _)| n)
                .collect();
            serde_json::json!({ "name": p, "services": members })
        })
        .collect();
    Ok(serde_json::json!({
        "profiles": profiles,
        "services": services,
        "active": active,
        "remembered": remembered.is_some(),
        "running": containers.iter().any(|c| matches!(c.state, ContainerState::Running)),
    }))
}

/// GET /stacks/{name}/profiles
pub async fn get(
    State(state): State<Arc<AppState>>,
    UrlPath(name): UrlPath<String>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(report(&state, &name).await?))
}

#[derive(Deserialize)]
pub struct SetBody {
    profiles: Vec<String>,
    /// Start what the new choice adds and stop what it leaves out, when the
    /// stack runs. Otherwise the choice applies on the next start.
    #[serde(default)]
    apply: bool,
}

/// PUT /stacks/{name}/profiles: remember the profiles to run, and apply them.
pub async fn set(
    State(state): State<Arc<AppState>>,
    UrlPath(name): UrlPath<String>,
    Json(body): Json<SetBody>,
) -> Result<impl IntoResponse, ApiError> {
    let (dir, config) = resolve_stack_dir(&state, &name).await?;
    let model = load_model(&state, &name, &dir, config.as_deref()).await?;
    let known = model_profiles(&model);
    if let Some(p) = body.profiles.iter().find(|p| !known.contains(p)) {
        return Err(ApiError::bad_request(format!("'{name}' has no profile '{p}'")));
    }
    {
        let mut cfg = state.config.lock().await;
        cfg.stack_profiles.insert(name.clone(), body.profiles.clone());
        cfg.save()?;
    }

    let mut output: Option<ComposeOutput> = None;
    if body.apply {
        let rt = state.rt().await;
        let containers: Vec<_> = rt
            .list_containers(true)
            .await?
            .into_iter()
            .filter(|c| c.labels.get("com.docker.compose.project").map(String::as_str) == Some(name.as_str()))
            .collect();
        if containers.iter().any(|c| matches!(c.state, ContainerState::Running)) {
            let mut out = up(&state, &name, &dir, config.as_deref()).await?;
            let on = enabled(&model, &body.profiles);
            let off: Vec<String> = model
                .services
                .keys()
                .filter(|s| !on.contains(s))
                .filter(|s| {
                    containers
                        .iter()
                        .any(|c| c.labels.get("com.docker.compose.service") == Some(*s))
                })
                .cloned()
                .collect();
            if out.success && !off.is_empty() {
                let mut args = vec!["-p".to_string(), name.clone(), "rm".into(), "-sf".into()];
                args.extend(off);
                let rm = rt.compose_args(&dir, config.as_deref(), &args).await?;
                out.success = rm.success;
                out.stdout.push_str(&rm.stdout);
                out.stderr.push_str(&rm.stderr);
            }
            output = Some(out);
        }
    }
    let mut body = report(&state, &name).await?;
    body["output"] = serde_json::to_value(&output).map_err(anyhow::Error::from)?;
    Ok(Json(body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enabled_services_follow_profiles() {
        let mut model = ComposeModel::default();
        for (n, p) in [
            ("web", vec![]),
            ("search", vec!["search"]),
            ("kibana", vec!["search", "debug"]),
        ] {
            model.services.insert(
                n.into(),
                orca_core::dev::compose_model::Service {
                    profiles: p.into_iter().map(String::from).collect(),
                    ..Default::default()
                },
            );
        }
        assert_eq!(enabled(&model, &[]), vec!["web"]);
        assert_eq!(enabled(&model, &["debug".into()]), vec!["kibana", "web"]);
        assert_eq!(enabled(&model, &["search".into()]), vec!["kibana", "search", "web"]);
    }
}
