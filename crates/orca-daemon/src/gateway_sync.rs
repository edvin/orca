//! Keeps the gateway in step with the containers around it:
//!
//! - **Routes from labels.** A container can ask for gateway routes in its
//!   own labels (`orca.route…`, or Traefik's `traefik.http.routers…`), so an
//!   app declares its hostnames in its own compose file. They are added while
//!   the container exists (running or stopped) and removed with it, owned by
//!   `label:<container>`.
//! - **Hostnames inside containers.** The gateway joins every routed
//!   container's networks with every routed hostname as a network alias, so
//!   a backend reaches `https://oidc.<domain>` through the gateway just as a
//!   browser does (OIDC issuer URLs, server-to-server calls by public name).
//!
//! Runs on container start/stop events and whenever routes change.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use bollard::models::EndpointSettings;
use bollard::network::{ConnectNetworkOptions, DisconnectNetworkOptions};
use orca_core::config::{EnvironmentLink, GatewayRoute, RoutePresentation, StackLinkGroup};
use orca_core::event::EventKind;
use orca_core::runtime::{ContainerRuntime, ContainerState};
use tokio::sync::Notify;
use tokio::sync::broadcast::error::{RecvError, TryRecvError};

use crate::state::AppState;

/// Owner prefix of routes that come from container labels.
pub const LABEL_OWNER_PREFIX: &str = "label:";

static ROUTES_CHANGED: Notify = Notify::const_new();

/// Routes from labels or orca.yaml left out because their hostname was
/// taken, for the Gateway page: (who asked, hostname with path, who has it).
static CONFLICTS: std::sync::Mutex<Vec<(String, String, String)>> = std::sync::Mutex::new(Vec::new());

/// Labels and orca.yaml files asking for a hostname another route already uses.
pub fn label_conflicts() -> Vec<serde_json::Value> {
    CONFLICTS
        .lock()
        .unwrap()
        .iter()
        .map(|(container, hostname, taken_by)| {
            serde_json::json!({ "container": container, "hostname": hostname, "taken_by": taken_by })
        })
        .collect()
}

/// Ask for a sync after the gateway's routes changed.
pub fn routes_changed() {
    ROUTES_CHANGED.notify_one();
}

pub fn spawn(state: Arc<AppState>) {
    tokio::spawn(async move {
        let mut events = state.events_tx.subscribe();
        loop {
            if let Err(e) = sync(&state).await {
                tracing::warn!("gateway sync: {e:#}");
            }
            // Wait for a container to start or go away, or for routes to change.
            loop {
                tokio::select! {
                    event = events.recv() => match event {
                        Ok(e) if matches!(
                            e.kind,
                            EventKind::ContainerStarted { .. }
                                | EventKind::ContainerStopped { .. }
                                | EventKind::ContainerDied { .. }
                                | EventKind::ContainerRemoved { .. }
                        ) => break,
                        Ok(_) => {}
                        Err(RecvError::Lagged(_)) => break,
                        Err(RecvError::Closed) => return,
                    },
                    _ = ROUTES_CHANGED.notified() => break,
                }
            }
            // A stack starting is a burst of events: sync once for all of it.
            tokio::time::sleep(Duration::from_millis(500)).await;
            while let Ok(_) | Err(TryRecvError::Lagged(_)) = events.try_recv() {}
        }
    });
}

async fn sync(state: &AppState) -> Result<()> {
    sync_label_routes(state).await?;
    sync_networks(state).await?;
    // The landing page shows which services run: refresh it on every
    // container start and stop (it's only rewritten when it changed).
    if crate::gateway::is_running(state).await.unwrap_or(false) {
        let (gateway, workspace) = {
            let cfg = state.config.lock().await;
            (cfg.gateway.clone(), cfg.workspace.clone())
        };
        let mut ctx = crate::landing::Context {
            not_set_up: workspace.as_ref().map(crate::workspace::not_set_up).unwrap_or_default(),
            dirs: workspace
                .as_ref()
                .map(crate::workspace::project_dirs)
                .unwrap_or_default(),
            ..Default::default()
        };
        for server in crate::databases::servers_with(state, false).await {
            for db in server.databases {
                if let Some(dir) = db.dir {
                    let dir = std::path::PathBuf::from(dir);
                    let dir = dir.canonicalize().unwrap_or(dir);
                    ctx.databases
                        .entry(dir)
                        .or_default()
                        .push((db.name, server.label.clone(), server.port));
                }
            }
        }
        crate::landing::refresh(&state.rt().await.docker, &gateway, &ctx).await;
    }
    Ok(())
}

/// Owner prefix of routes from a compose project's `orca.yaml`.
pub const PROJECT_OWNER_PREFIX: &str = "project:";

/// Routes this sync keeps current: from labels and from `orca.yaml`.
fn is_synced_route(r: &GatewayRoute) -> bool {
    r.owner
        .as_deref()
        .is_some_and(|o| o.starts_with(LABEL_OWNER_PREFIX) || o.starts_with(PROJECT_OWNER_PREFIX))
}

/// Where a route this sync manages comes from, to tell people where to
/// change it; `None` for routes managed elsewhere or added by hand.
pub fn managed_source(r: &GatewayRoute) -> Option<String> {
    let owner = r.owner.as_deref()?;
    if let Some(c) = owner.strip_prefix(LABEL_OWNER_PREFIX) {
        Some(format!("the labels on {c}"))
    } else {
        owner
            .strip_prefix(PROJECT_OWNER_PREFIX)
            .map(|p| format!("the orca.yaml of compose project {p}"))
    }
}

async fn sync_label_routes(state: &AppState) -> Result<()> {
    let rt = state.rt().await;
    let mut all = rt.list_containers(true).await?;
    all.sort_by(|a, b| a.name.cmp(&b.name));
    let domain = state.config.lock().await.gateway.domain.clone();
    let projects = crate::project_config::discover(&all);

    // From each project's orca.yaml, then from labels: while its containers
    // exist, running or stopped, so a stopped app keeps its card and its
    // address says it isn't running. Running ones first, so they keep a
    // hostname two projects ask for.
    let mut wanted: Vec<GatewayRoute> = Vec::new();
    let workspace = state.config.lock().await.workspace.clone();
    let mut projects_in_order: Vec<_> = projects.iter().collect();
    projects_in_order.sort_by_key(|p| !p.running());
    for p in projects_in_order {
        // A workspace project's own icon, for its routes that set none.
        let ws_icon = workspace
            .as_ref()
            .filter(|_| p.yaml.gateway.iter().any(|r| r.presentation.icon.is_none()))
            .and_then(|w| crate::workspace::project_icon(w, &p.dir));
        // And its group, so a product's projects show together.
        let ws_group = workspace
            .as_ref()
            .filter(|_| p.yaml.gateway.iter().any(|r| r.presentation.group.is_none()))
            .and_then(|w| crate::workspace::project_group(w, &p.dir));
        for r in &p.yaml.gateway {
            let Some(c) = p.container_of(&r.service) else {
                continue;
            };
            wanted.push(GatewayRoute {
                hostname: crate::project_config::qualify_hostname(&r.hostname, &domain),
                container_name: c.name.clone(),
                port: r.port,
                enabled: true,
                path: r.path.clone(),
                owner: Some(format!("{PROJECT_OWNER_PREFIX}{}", p.name)),
                sleeping: false,
                websocket: false,
                presentation: {
                    let mut pr = with_icon(r.presentation.clone(), Some(&p.dir));
                    if pr.icon.is_none() {
                        pr.icon = ws_icon.clone();
                    }
                    if pr.group.is_none() {
                        pr.group = ws_group.clone();
                    }
                    pr
                },
            });
        }
    }
    let mut labelled: Vec<_> = all.iter().collect();
    labelled.sort_by_key(|c| c.state != ContainerState::Running);
    for c in labelled {
        // Worktree instances get their routes from `orca.yaml`, and their
        // compose labels are copied into every instance; the gateway is ours.
        if c.labels.contains_key(orca_core::dev::LABEL_PROJECT) || c.labels.contains_key("orca.role") {
            continue;
        }
        let asks = label_routes(&c.labels, &domain);
        if asks.is_empty() {
            continue;
        }
        let own_port = if asks.iter().any(|a| a.port.is_none()) {
            exposed_port(&rt.docker, &c.id).await
        } else {
            None
        };
        for a in asks {
            wanted.push(GatewayRoute {
                hostname: a.hostname,
                container_name: c.name.clone(),
                port: a.port.or(own_port).unwrap_or(80),
                enabled: true,
                path: a.path,
                owner: Some(format!("{LABEL_OWNER_PREFIX}{}", c.name)),
                sleeping: false,
                websocket: false,
                presentation: with_icon(
                    a.presentation,
                    c.labels
                        .get("com.docker.compose.project.working_dir")
                        .map(std::path::Path::new),
                ),
            });
        }
    }

    // Links from each project's orca.yaml, running or not.
    let wanted_links: Vec<StackLinkGroup> = projects
        .iter()
        .flat_map(|p| {
            p.yaml.links.iter().map(|g| StackLinkGroup {
                stack: p.name.clone(),
                group: g.group.clone(),
                links: g
                    .links
                    .iter()
                    .map(|l| EnvironmentLink {
                        name: l.name.clone(),
                        urls: l.urls.clone().into_iter().collect(),
                    })
                    .collect(),
            })
        })
        .collect();
    let with_links: HashSet<&str> = projects
        .iter()
        .filter(|p| !p.yaml.links.is_empty())
        .map(|p| p.name.as_str())
        .collect();
    // Routes an earlier deploy registered from the same orca.yaml give way.
    let superseded: HashSet<String> = projects
        .iter()
        .filter(|p| !p.yaml.gateway.is_empty())
        .map(|p| format!("stack:{}", p.name))
        .collect();

    let changed = {
        let mut cfg = state.config.lock().await;
        let mut dirty = false;
        let before = cfg.gateway.routes.len();
        cfg.gateway
            .routes
            .retain(|r| !r.owner.as_ref().is_some_and(|o| superseded.contains(o)));
        dirty |= cfg.gateway.routes.len() != before;

        // A workspace's route for one of its projects (`workspace:<name>:<project>`)
        // only stands in until the project's own orca.yaml or labels route
        // that hostname: then it gives way.
        let project_of_workspace = |r: &GatewayRoute| {
            r.owner
                .as_deref()
                .is_some_and(|o| o.starts_with("workspace:") && o.matches(':').count() >= 2)
        };
        let wanted_keys: HashSet<(String, Option<String>)> =
            wanted.iter().map(|r| (r.hostname.clone(), r.path.clone())).collect();
        let before = cfg.gateway.routes.len();
        cfg.gateway
            .routes
            .retain(|r| !(project_of_workspace(r) && wanted_keys.contains(&(r.hostname.clone(), r.path.clone()))));
        dirty |= cfg.gateway.routes.len() != before;

        // Routes added by hand, by stacks, by worktree instances or by the
        // workspace win; then orca.yaml over labels, and of two asking for
        // one hostname the first.
        let mut taken: HashMap<(String, Option<String>), String> = cfg
            .gateway
            .routes
            .iter()
            .filter(|r| !is_synced_route(r))
            .map(|r| {
                let by = match r.owner.as_deref() {
                    Some(o) if o.starts_with("dev:") => "a worktree instance".to_string(),
                    Some(o) if o.starts_with("stack:") => format!("stack {}", &o["stack:".len()..]),
                    Some(o) if o.starts_with("workspace:") => format!("workspace {}", &o["workspace:".len()..]),
                    _ => format!("a route to {}", r.container_name),
                };
                ((r.hostname.clone(), r.path.clone()), by)
            })
            .collect();
        let mut conflicts = Vec::new();
        wanted.retain(|r| {
            let key = (r.hostname.clone(), r.path.clone());
            let source = managed_source(r).unwrap_or_default();
            let asker = match r.owner.as_deref().and_then(|o| o.strip_prefix(PROJECT_OWNER_PREFIX)) {
                Some(p) => format!("orca.yaml of {p}"),
                None => r.container_name.clone(),
            };
            if let Some(by) = taken.get(&key) {
                let host = format!("{}{}", r.hostname, r.path.as_deref().unwrap_or(""));
                conflicts.push((asker, host, by.clone()));
                return false;
            }
            taken.insert(key, source);
            true
        });
        *CONFLICTS.lock().unwrap() = conflicts;
        // A route paused on the Gateway page stays paused.
        for r in &mut wanted {
            if let Some(old) = cfg
                .gateway
                .routes
                .iter()
                .find(|o| is_synced_route(o) && o.owner == r.owner && o.hostname == r.hostname && o.path == r.path)
            {
                r.enabled = old.enabled;
            }
        }
        let key = |r: &GatewayRoute| {
            (
                r.hostname.clone(),
                r.path.clone(),
                r.container_name.clone(),
                r.port,
                r.owner.clone(),
            )
        };
        let have: Vec<_> = cfg
            .gateway
            .routes
            .iter()
            .filter(|r| is_synced_route(r))
            .map(key)
            .collect();
        if have != wanted.iter().map(key).collect::<Vec<_>>() {
            tracing::info!("Routes from labels and orca.yaml: {}", wanted.len());
            cfg.gateway.routes.retain(|r| !is_synced_route(r));
            cfg.gateway.routes.extend(wanted);
            dirty = true;
        }

        let have_links: Vec<&StackLinkGroup> = cfg
            .gateway
            .stack_links
            .iter()
            .filter(|g| with_links.contains(g.stack.as_str()))
            .collect();
        let same_links = have_links.len() == wanted_links.len()
            && have_links.iter().zip(&wanted_links).all(|(a, b)| {
                a.stack == b.stack
                    && a.group == b.group
                    && a.links.len() == b.links.len()
                    && a.links
                        .iter()
                        .zip(&b.links)
                        .all(|(x, y)| x.name == y.name && x.urls == y.urls)
            });
        if !same_links {
            cfg.gateway
                .stack_links
                .retain(|g| !with_links.contains(g.stack.as_str()));
            cfg.gateway.stack_links.extend(wanted_links);
            dirty = true;
        }

        if dirty {
            cfg.save()?;
            Some(cfg.gateway.clone())
        } else {
            None
        }
    };
    if let Some(gw) = changed
        && crate::gateway::is_running(state).await.unwrap_or(false)
    {
        crate::gateway::apply_config(&gw).await?;
    }
    Ok(())
}

/// The port a container listens on when a label doesn't say: the only port
/// it exposes. `None` when it exposes none or several.
async fn exposed_port(docker: &bollard::Docker, id: &str) -> Option<u16> {
    let info = docker.inspect_container(id, None).await.ok()?;
    let exposed = info.config?.exposed_ports?;
    let mut tcp = exposed
        .keys()
        .filter_map(|k| k.strip_suffix("/tcp").and_then(|p| p.parse::<u16>().ok()));
    let port = tcp.next()?;
    tcp.next().is_none().then_some(port)
}

/// Join the gateway to every routed container's networks, carrying every
/// routed hostname as an alias. Docker can't change the aliases of a
/// connected container, so a network whose aliases are out of date is left
/// and joined again.
async fn sync_networks(state: &AppState) -> Result<()> {
    let rt = state.rt().await;
    let routes: Vec<GatewayRoute> = state
        .config
        .lock()
        .await
        .gateway
        .routes
        .iter()
        .filter(|r| r.enabled)
        .cloned()
        .collect();
    let Ok(gateway) = rt.docker.inspect_container(crate::gateway::CADDY_CONTAINER, None).await else {
        return Ok(());
    };
    if !gateway.state.as_ref().and_then(|s| s.running).unwrap_or(false) {
        return Ok(());
    }

    let aliases: BTreeSet<String> = routes
        .iter()
        .map(|r| r.hostname.clone())
        .filter(|h| !h.is_empty() && h.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-'))
        .collect();

    let mut networks: BTreeSet<String> = BTreeSet::new();
    let names: BTreeSet<&str> = routes.iter().map(|r| r.container_name.as_str()).collect();
    for name in names {
        let Ok(info) = rt.docker.inspect_container(name, None).await else {
            continue;
        };
        if let Some(nets) = info.network_settings.and_then(|n| n.networks) {
            networks.extend(nets.into_keys());
        }
    }
    // A workspace's network too: its routes target aliases on it (like
    // `one-crm-app:80`), not containers the gateway could look up.
    if let Some(net) = state
        .config
        .lock()
        .await
        .workspace
        .as_ref()
        .and_then(|w| w.network.clone())
    {
        networks.insert(net);
    }
    // The default bridge has no DNS (and no aliases); host and none aren't networks to join.
    networks.retain(|n| !matches!(n.as_str(), "bridge" | "host" | "none"));

    let joined: HashMap<String, BTreeSet<String>> = gateway
        .network_settings
        .and_then(|n| n.networks)
        .unwrap_or_default()
        .into_iter()
        .map(|(net, ep)| {
            // Our aliases are hostnames, so they have a dot; Docker adds the
            // container's own name and ID without one.
            let hostnames = ep.aliases.unwrap_or_default().into_iter().filter(|a| a.contains('.'));
            (net, hostnames.collect())
        })
        .collect();

    for net in networks {
        match joined.get(&net) {
            Some(have) if *have == aliases => continue,
            Some(_) => {
                let leave = DisconnectNetworkOptions {
                    container: crate::gateway::CADDY_CONTAINER,
                    force: false,
                };
                if let Err(e) = rt.docker.disconnect_network(&net, leave).await {
                    tracing::warn!("gateway could not leave network '{net}' to update its hostnames: {e}");
                    continue;
                }
            }
            None => tracing::info!("Connecting gateway to network '{net}'"),
        }
        let join = ConnectNetworkOptions {
            container: crate::gateway::CADDY_CONTAINER,
            endpoint_config: EndpointSettings {
                aliases: Some(aliases.iter().cloned().collect()),
                ..Default::default()
            },
        };
        if let Err(e) = rt.docker.connect_network(&net, join).await {
            tracing::warn!("gateway could not join network '{net}': {e}");
        }
    }
    Ok(())
}

/// A route a container asks for in its labels.
#[derive(Debug, PartialEq)]
struct Ask {
    hostname: String,
    /// `None`: the port the container exposes.
    port: Option<u16>,
    /// A Caddy path matcher (`/api*`), like a route's `path`.
    path: Option<String>,
    /// How it appears on the landing page.
    presentation: RoutePresentation,
}

/// Routes asked for in Orca's own labels and in Traefik's.
///
/// ```yaml
/// labels:
///   orca.route: app              # app.<domain>, on the port the image exposes
///   orca.route.port: "8080"
///   orca.route.api: api.{domain} # more routes, each with its own name
///   orca.route.api.port: "3000"
///   orca.route.api.path: /v1*
///   orca.route.title: Storefront # on the landing page; also .description,
///                                # .group, .icon (an image URL) and .hidden
/// ```
///
/// A hostname without a dot gets `.<domain>`; `{domain}` is replaced.
fn label_routes(labels: &HashMap<String, String>, domain: &str) -> Vec<Ask> {
    let mut asks = orca_label_routes(labels, domain);
    if labels.get("traefik.enable").map(|v| v.trim()) != Some("false") {
        asks.extend(traefik_label_routes(labels));
    }
    asks
}

/// One named route's labels; the unnamed route is "".
#[derive(Default)]
struct RouteLabels<'a> {
    host: Option<&'a str>,
    port: Option<&'a str>,
    path: Option<&'a str>,
    presentation: RoutePresentation,
}

/// Attributes a route label can have after its name.
const ROUTE_ATTRS: &[&str] = &["port", "path", "title", "description", "group", "icon", "hidden"];

/// A route's `icon:` as the gateway keeps it: a built-in name, a URL, or a
/// repo file read in (paths are relative to `base`, the project folder). One
/// that can't be used is left out, and the card shows the image's icon or
/// an initial.
pub(crate) fn with_icon(mut p: RoutePresentation, base: Option<&std::path::Path>) -> RoutePresentation {
    if let Some(spec) = p.icon.take() {
        match orca_core::icons::resolve(&spec, base) {
            Ok(icon) => p.icon = Some(icon),
            Err(e) => tracing::debug!("{e}"),
        }
    }
    p
}

fn orca_label_routes(labels: &HashMap<String, String>, domain: &str) -> Vec<Ask> {
    let mut routes: std::collections::BTreeMap<&str, RouteLabels> = Default::default();
    for (key, value) in labels {
        let Some(rest) = key.strip_prefix("orca.route") else {
            continue;
        };
        let (name, attr) = match rest.strip_prefix('.') {
            None if rest.is_empty() => ("", None),
            None => continue, // orca.routes, orca.router…
            Some(attr) if ROUTE_ATTRS.contains(&attr) => ("", Some(attr)),
            Some(r) => match r.rsplit_once('.') {
                Some((name, attr)) if ROUTE_ATTRS.contains(&attr) => (name, Some(attr)),
                Some(_) => continue,
                None => (r, None),
            },
        };
        let entry = routes.entry(name).or_default();
        let text = || Some(value.trim().to_string()).filter(|v| !v.is_empty());
        match attr {
            None => entry.host = Some(value),
            Some("port") => entry.port = Some(value),
            Some("path") => entry.path = Some(value),
            Some("title") => entry.presentation.title = text(),
            Some("description") => entry.presentation.description = text(),
            Some("group") => entry.presentation.group = text(),
            Some("icon") => entry.presentation.icon = text(),
            _ => entry.presentation.hidden = matches!(value.trim(), "true" | "yes" | "1"),
        }
    }
    routes
        .into_values()
        .filter_map(
            |RouteLabels {
                 host,
                 port,
                 path,
                 presentation,
             }| {
                let host = host?.trim().replace("{domain}", domain);
                if host.is_empty() {
                    return None;
                }
                let hostname = if host.contains('.') {
                    host
                } else {
                    format!("{host}.{domain}")
                };
                Some(Ask {
                    hostname: hostname.to_lowercase(),
                    port: port.and_then(|p| p.trim().parse().ok()),
                    path: path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty()),
                    presentation,
                })
            },
        )
        .collect()
}

fn traefik_label_routes(labels: &HashMap<String, String>) -> Vec<Ask> {
    const ROUTERS: &str = "traefik.http.routers.";
    const SERVICES: &str = "traefik.http.services.";
    const PORT: &str = ".loadbalancer.server.port";
    let service_ports: HashMap<&str, u16> = labels
        .iter()
        .filter_map(|(k, v)| {
            let name = k.strip_prefix(SERVICES)?.strip_suffix(PORT)?;
            Some((name, v.trim().parse().ok()?))
        })
        .collect();
    let mut routers: Vec<(&str, &str)> = labels
        .iter()
        .filter_map(|(k, v)| Some((k.strip_prefix(ROUTERS)?.strip_suffix(".rule")?, v.as_str())))
        .collect();
    routers.sort();

    let mut asks = Vec::new();
    for (router, rule) in routers {
        let port = match labels.get(&format!("{ROUTERS}{router}.service")) {
            Some(service) => service_ports.get(service.as_str()).copied(),
            // Traefik uses the only service when a router names none.
            None if service_ports.len() == 1 => service_ports.values().next().copied(),
            None => None,
        };
        let path = rule_args(rule, "PathPrefix")
            .into_iter()
            .next()
            .map(|p| format!("{}*", p.trim_end_matches('/')))
            .or_else(|| rule_args(rule, "Path").into_iter().next());
        for host in rule_args(rule, "Host") {
            asks.push(Ask {
                hostname: host.to_lowercase(),
                port,
                path: path.clone(),
                presentation: RoutePresentation::default(),
            });
        }
    }
    asks
}

/// The arguments of every `matcher(...)` in a Traefik rule:
/// ``Host(`a.test`, `b.test`) || Host(`c.test`)`` gives a.test, b.test, c.test.
/// `HostRegexp` and `PathRegexp` don't count as `Host` and `Path`.
fn rule_args(rule: &str, matcher: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = rule;
    while let Some(i) = rest.find(matcher) {
        let before_ok = rest[..i].chars().next_back().is_none_or(|c| !c.is_ascii_alphanumeric());
        let after = &rest[i + matcher.len()..];
        rest = after;
        let Some(args) = after.strip_prefix('(') else {
            continue;
        };
        let Some(end) = args.find(')') else {
            break;
        };
        if before_ok {
            out.extend(
                args[..end]
                    .split(',')
                    .map(|a| a.trim().trim_matches(|c| c == '`' || c == '"' || c == '\'').to_string())
                    .filter(|a| !a.is_empty()),
            );
        }
        rest = &args[end..];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn orca_labels_name_routes_and_fill_in_the_domain() {
        let l = labels(&[
            ("orca.route", "app"),
            ("orca.route.port", "8080"),
            ("orca.route.api", "api.{domain}"),
            ("orca.route.api.port", "3000"),
            ("orca.route.api.path", "/v1*"),
            ("orca.route.admin", "Admin.Example.test"),
            ("orca.routes", "ignored"),
        ]);
        let mut asks = label_routes(&l, "local.test");
        asks.sort_by(|a, b| a.hostname.cmp(&b.hostname));
        assert_eq!(
            asks,
            vec![
                Ask {
                    hostname: "admin.example.test".into(),
                    port: None,
                    path: None,
                    presentation: Default::default()
                },
                Ask {
                    hostname: "api.local.test".into(),
                    port: Some(3000),
                    path: Some("/v1*".into()),
                    presentation: Default::default()
                },
                Ask {
                    hostname: "app.local.test".into(),
                    port: Some(8080),
                    path: None,
                    presentation: Default::default()
                },
            ]
        );
    }

    #[test]
    fn labels_set_how_a_route_appears_on_the_landing_page() {
        let l = labels(&[
            ("orca.route", "shop"),
            ("orca.route.title", "Storefront"),
            ("orca.route.group", "Shop"),
            ("orca.route.admin", "admin"),
            ("orca.route.admin.hidden", "true"),
            ("orca.route.admin.description", "Back office"),
        ]);
        let mut asks = label_routes(&l, "x");
        asks.sort_by(|a, b| a.hostname.cmp(&b.hostname));
        assert!(asks[0].presentation.hidden);
        assert_eq!(asks[0].presentation.description.as_deref(), Some("Back office"));
        assert_eq!(asks[1].presentation.title.as_deref(), Some("Storefront"));
        assert_eq!(asks[1].presentation.group.as_deref(), Some("Shop"));
    }

    #[test]
    fn a_port_or_path_without_a_hostname_asks_for_nothing() {
        let l = labels(&[("orca.route.port", "8080"), ("orca.route.api.path", "/v1*")]);
        assert!(label_routes(&l, "local.test").is_empty());
    }

    #[test]
    fn traefik_routers_with_their_service_ports() {
        let l = labels(&[
            ("traefik.enable", "true"),
            (
                "traefik.http.routers.web.rule",
                "Host(`shop.test`) || Host(`www.shop.test`)",
            ),
            ("traefik.http.routers.web.service", "front"),
            (
                "traefik.http.routers.api.rule",
                "Host(`shop.test`) && PathPrefix(`/api/`)",
            ),
            ("traefik.http.routers.api.service", "back"),
            ("traefik.http.services.front.loadbalancer.server.port", "3000"),
            ("traefik.http.services.back.loadbalancer.server.port", "8080"),
        ]);
        let asks = label_routes(&l, "local.test");
        assert_eq!(
            asks,
            vec![
                Ask {
                    hostname: "shop.test".into(),
                    port: Some(8080),
                    path: Some("/api*".into()),
                    presentation: Default::default()
                },
                Ask {
                    hostname: "shop.test".into(),
                    port: Some(3000),
                    path: None,
                    presentation: Default::default()
                },
                Ask {
                    hostname: "www.shop.test".into(),
                    port: Some(3000),
                    path: None,
                    presentation: Default::default()
                },
            ]
        );
    }

    #[test]
    fn traefik_router_without_service_uses_the_only_one() {
        let l = labels(&[
            ("traefik.http.routers.app.rule", "Host(`app.test`)"),
            ("traefik.http.services.app.loadbalancer.server.port", "9000"),
        ]);
        assert_eq!(label_routes(&l, "x")[0].port, Some(9000));
    }

    #[test]
    fn traefik_disabled_or_regexp_rules_ask_for_nothing() {
        let off = labels(&[
            ("traefik.enable", "false"),
            ("traefik.http.routers.a.rule", "Host(`a.test`)"),
        ]);
        assert!(label_routes(&off, "x").is_empty());
        let regexp = labels(&[("traefik.http.routers.a.rule", "HostRegexp(`{sub:[a-z]+}.a.test`)")]);
        assert!(label_routes(&regexp, "x").is_empty());
    }
}
