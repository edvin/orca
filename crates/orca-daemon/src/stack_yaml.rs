//! A stack's `orca.yaml` on its page: what Orca read from it and applied,
//! a starting file when there is none, and saving it.

use std::path::Path;
use std::sync::Arc;

use axum::Json;
use axum::extract::{Path as UrlPath, State};
use axum::response::IntoResponse;
use orca_core::dev::OrcaYaml;
use orca_core::runtime::{Container, ContainerRuntime, ContainerState};
use serde::Deserialize;

use crate::api::ApiError;
use crate::state::AppState;

const REFERENCE_URL: &str = "https://orca-desktop.com/docs/orca-yaml/";

/// GET /stacks/{name}/orca-yaml
pub async fn get(
    State(state): State<Arc<AppState>>,
    UrlPath(name): UrlPath<String>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(report(&state, &name).await?))
}

#[derive(Deserialize)]
pub struct SaveBody {
    text: String,
}

/// PUT /stacks/{name}/orca-yaml: write `orca.yaml` next to the compose file.
pub async fn save(
    State(state): State<Arc<AppState>>,
    UrlPath(name): UrlPath<String>,
    Json(body): Json<SaveBody>,
) -> Result<impl IntoResponse, ApiError> {
    let v = crate::dev::setup::validate(&body.text);
    if let Some(error) = v.error {
        let at = v.line.map(|l| format!(" (line {l})")).unwrap_or_default();
        return Err(ApiError::bad_request(format!("Not saved: {error}{at}")));
    }
    let (dir, _) = crate::api::resolve_stack_dir(&state, &name).await?;
    let path = Path::new(&dir).join("orca.yaml");
    std::fs::write(&path, &body.text).map_err(|e| anyhow::anyhow!("Could not write {}: {e}", path.display()))?;
    // Apply it now rather than on the next container event.
    crate::gateway_sync::routes_changed();
    Ok(Json(report(&state, &name).await?))
}

#[derive(Deserialize)]
pub struct ValidateBody {
    text: String,
}

/// POST /orca-yaml/validate: problems in `orca.yaml` text, for editors.
pub async fn validate(Json(body): Json<ValidateBody>) -> impl IntoResponse {
    Json(crate::dev::setup::validate(&body.text))
}

async fn report(state: &AppState, name: &str) -> Result<serde_json::Value, ApiError> {
    let (dir, _) = crate::api::resolve_stack_dir(state, name).await?;
    let dir = Path::new(&dir);
    let path = dir.join("orca.yaml");
    let containers: Vec<Container> = state
        .rt()
        .await
        .list_containers(true)
        .await?
        .into_iter()
        .filter(|c| c.labels.get("com.docker.compose.project").map(String::as_str) == Some(name))
        .collect();
    let service_names: Vec<String> = {
        let mut s: Vec<String> = containers
            .iter()
            .filter_map(|c| c.labels.get("com.docker.compose.service").cloned())
            .collect();
        s.sort();
        s.dedup();
        s
    };

    let services = describe_services(state, &containers).await;

    let Ok(text) = std::fs::read_to_string(&path) else {
        return Ok(serde_json::json!({
            "path": path,
            "exists": false,
            "reference": REFERENCE_URL,
            "suggestion": suggestion(name, &services),
            "services": services,
            "domain": state.config.lock().await.gateway.domain.clone(),
        }));
    };

    let (yaml, error) = match OrcaYaml::load(dir) {
        Ok(y) => (y, None),
        Err(e) => (OrcaYaml::default(), Some(format!("{e:#}"))),
    };
    let (domain, routes) = {
        let cfg = state.config.lock().await;
        (cfg.gateway.domain.clone(), cfg.gateway.routes.clone())
    };
    let conflicts = crate::gateway_sync::label_conflicts();
    let asker = format!("orca.yaml of {name}");
    let owner = format!("{}{name}", crate::gateway_sync::PROJECT_OWNER_PREFIX);
    let route_status: Vec<serde_json::Value> = yaml
        .gateway
        .iter()
        .map(|r| {
            let hostname = crate::project_config::qualify_hostname(&r.hostname, &domain);
            let shown = format!("{hostname}{}", r.path.as_deref().unwrap_or(""));
            let applied = routes
                .iter()
                .find(|g| g.owner.as_deref() == Some(owner.as_str()) && g.hostname == hostname && g.path == r.path);
            let blocked = conflicts
                .iter()
                .find(|c| c["container"] == asker && c["hostname"] == shown);
            let running = containers.iter().any(|c| {
                c.state == ContainerState::Running && c.labels.get("com.docker.compose.service") == Some(&r.service)
            });
            let (status, detail) = match (applied, blocked) {
                (Some(g), _) if !g.enabled => ("paused", "Paused on the Gateway page".to_string()),
                (Some(_), _) => ("active", String::new()),
                (None, Some(c)) => (
                    "blocked",
                    format!("{} already uses it", c["taken_by"].as_str().unwrap_or("another route")),
                ),
                (None, None) if !service_names.contains(&r.service) => {
                    ("unknown", format!("This stack has no service '{}'", r.service))
                }
                (None, None) if !running => ("waiting", format!("Applied once '{}' runs", r.service)),
                (None, None) => ("waiting", "Applying…".to_string()),
            };
            serde_json::json!({
                "hostname": hostname,
                "path": r.path,
                "service": r.service,
                "port": r.port,
                "status": status,
                "detail": detail,
            })
        })
        .collect();

    Ok(serde_json::json!({
        "path": path,
        "exists": true,
        "reference": REFERENCE_URL,
        "text": text,
        "local_override": dir.join("orca.local.yaml").exists(),
        "error": error,
        "warnings": orca_core::dev::schema::project_warnings(&text),
        "routes": route_status,
        "links": yaml.links.iter().map(|g| serde_json::json!({ "group": g.group, "count": g.links.len() })).collect::<Vec<_>>(),
        "builds": yaml.builds.iter().map(|b| b.name.clone()).collect::<Vec<_>>(),
        "hooks": yaml.hooks.after_up,
        "has_dev": yaml.dev.is_some(),
        "services": services,
        "domain": domain,
    }))
}

/// Ports that look like a web app or UI, in order of preference.
const WEB_PORTS: &[u16] = &[
    80, 8080, 3000, 5173, 8000, 4200, 5000, 8081, 3001, 8888, 9000, 4000, 1080, 8025, 8123, 15672, 9001,
];

/// A service of the stack, for the editor's dropdowns.
#[derive(serde::Serialize)]
struct Service {
    name: String,
    image: String,
    /// Ports it listens on inside its container: exposed or published.
    ports: Vec<u16>,
}

async fn describe_services(state: &AppState, containers: &[Container]) -> Vec<Service> {
    let rt = state.rt().await;
    let mut out: Vec<Service> = Vec::new();
    for c in containers {
        let Some(service) = c.labels.get("com.docker.compose.service") else {
            continue;
        };
        if out.iter().any(|s| &s.name == service) {
            continue;
        }
        let mut ports: Vec<u16> = c.ports.iter().map(|p| p.container_port).collect();
        if let Ok(info) = rt.docker.inspect_container(&c.id, None).await
            && let Some(exposed) = info.config.and_then(|cfg| cfg.exposed_ports)
        {
            ports.extend(
                exposed
                    .keys()
                    .filter_map(|k| k.strip_suffix("/tcp")?.parse::<u16>().ok()),
            );
        }
        ports.sort();
        ports.dedup();
        out.push(Service {
            name: service.clone(),
            image: c.image.clone(),
            ports,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Soketi (or another Pusher-protocol server) in the stack: browsers using
/// Laravel Echo / pusher-js connect to `/app/<key>` on the page's own host.
fn pusher_service(services: &[Service]) -> Option<&Service> {
    services.iter().find(|s| s.image.contains("soketi"))
}

/// A first `orca.yaml` for a running stack: a route for each service that
/// looks like a web app (and Soketi's `/app/*` under the main one), and the
/// other sections commented out as examples.
fn suggestion(name: &str, services: &[Service]) -> String {
    let pusher = pusher_service(services);
    let web: Vec<(String, u16)> = services
        .iter()
        .filter(|s| pusher.is_none_or(|p| p.name != s.name))
        .filter_map(|s| Some((s.name.clone(), *WEB_PORTS.iter().find(|p| s.ports.contains(p))?)))
        .collect();
    let slug = |s: &str| {
        s.to_lowercase()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect::<String>()
            .trim_matches('-')
            .to_string()
    };
    let routes = if web.is_empty() {
        format!(
            "# No service here looks like a web app. Add a route like this:\n# gateway:\n#   - hostname: {}\n#     service: web\n#     port: 3000\n",
            slug(name)
        )
    } else {
        let mut out = String::from("gateway:\n");
        for (service, port) in &web {
            // One web service gets the stack's name; several get one each.
            let host = if web.len() == 1 {
                slug(name)
            } else {
                format!("{}-{}", slug(service), slug(name))
            };
            out.push_str(&format!(
                "  - hostname: {host}\n    service: {service}\n    port: {port}\n"
            ));
        }
        if let Some(p) = pusher {
            let host = if web.len() == 1 {
                slug(name)
            } else {
                format!("{}-{}", slug(&web[0].0), slug(name))
            };
            let port = if p.ports.contains(&6001) {
                6001
            } else {
                p.ports.first().copied().unwrap_or(6001)
            };
            out.push_str(&format!(
                "  # Pusher clients (Laravel Echo) connect to /app/ on the page's own host.\n  - hostname: {host}\n    service: {}\n    port: {port}\n    path: /app/*\n",
                p.name
            ));
        }
        out
    };
    format!(
        "# orca.yaml: how Orca runs this project. Orca reads it whenever the
# stack runs, however it was started. Reference: {REFERENCE_URL}

# Routes through the Orca gateway: https://<hostname>.<domain>
{routes}
# Links to this app in other environments, shown on the Gateway page.
# links:
#   {group}:
#     - name: Web app
#       local: {local}
#       staging: https://staging.example.com
#       production: https://www.example.com

# Commands run after every start from Orca, as \"service: command\".
# Make them safe to repeat.
# hooks:
#   after_up:
#     - \"web: npm run migrate\"

# Build targets shown on the Builds page.
# builds:
#   - name: web
#     context: .
#     tag: {local}:dev

# To run each git worktree as its own copy of the app, add this project
# on the Worktrees page: it writes a dev: section here.
",
        group = name,
        local = slug(name),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn svc(name: &str, image: &str, ports: &[u16]) -> Service {
        Service {
            name: name.into(),
            image: image.into(),
            ports: ports.to_vec(),
        }
    }

    #[test]
    fn suggestion_routes_pusher_path_on_the_app_host() {
        let services = [
            svc("soketi", "quay.io/soketi/soketi:1.6", &[6001, 9601]),
            svc("web", "shop-web", &[80]),
        ];
        let text = suggestion("My Shop", &services);
        let yaml = OrcaYaml::parse(&text).unwrap();
        let routes: Vec<_> = yaml
            .gateway
            .iter()
            .map(|r| (r.hostname.as_str(), r.service.as_str(), r.port, r.path.as_deref()))
            .collect();
        assert_eq!(
            routes,
            vec![
                ("my-shop", "web", 80, None),
                ("my-shop", "soketi", 6001, Some("/app/*"))
            ]
        );
    }

    #[test]
    fn suggestion_without_web_service_is_all_comments() {
        let text = suggestion("db", &[svc("postgres", "postgres:16", &[5432])]);
        assert!(OrcaYaml::parse(&text).unwrap().gateway.is_empty());
    }
}
