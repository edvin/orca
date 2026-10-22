//! Keeps the gateway in step with the containers around it:
//!
//! - **Routes from labels.** A container can ask for gateway routes in its
//!   own labels (`orca.route…`, or Traefik's `traefik.http.routers…`), so an
//!   app declares its hostnames in its own compose file. They are added while
//!   the container runs and removed when it stops, owned by
//!   `label:<container>`.
//! - **Hostnames inside containers.** The gateway joins every routed
//!   container's networks with every routed hostname as a network alias, so
//!   a backend reaches `https://oidc.<domain>` through the gateway just as a
//!   browser does (OIDC issuer URLs, server-to-server calls by public name).
//!
//! Runs on container start/stop events and whenever routes change.

use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use bollard::models::EndpointSettings;
use bollard::network::{ConnectNetworkOptions, DisconnectNetworkOptions};
use orca_core::config::GatewayRoute;
use orca_core::event::EventKind;
use orca_core::runtime::ContainerRuntime;
use tokio::sync::Notify;
use tokio::sync::broadcast::error::{RecvError, TryRecvError};

use crate::state::AppState;

/// Owner prefix of routes that come from container labels.
pub const LABEL_OWNER_PREFIX: &str = "label:";

static ROUTES_CHANGED: Notify = Notify::const_new();

/// Label routes left out because their hostname was taken, for the Gateway
/// page: (container, hostname with path, who has it).
static CONFLICTS: std::sync::Mutex<Vec<(String, String, String)>> = std::sync::Mutex::new(Vec::new());

/// Containers whose labels ask for a hostname another route already uses.
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

/// The container a label route comes from, or `None` for other routes.
pub fn label_route_container(r: &GatewayRoute) -> Option<&str> {
    r.owner.as_deref()?.strip_prefix(LABEL_OWNER_PREFIX)
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
    sync_networks(state).await
}

fn is_label_route(r: &GatewayRoute) -> bool {
    r.owner.as_deref().is_some_and(|o| o.starts_with(LABEL_OWNER_PREFIX))
}

async fn sync_label_routes(state: &AppState) -> Result<()> {
    let rt = state.rt().await;
    let mut running = rt.list_containers(false).await?;
    running.sort_by(|a, b| a.name.cmp(&b.name));
    let domain = state.config.lock().await.gateway.domain.clone();

    let mut wanted: Vec<GatewayRoute> = Vec::new();
    for c in &running {
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
            });
        }
    }

    let changed = {
        let mut cfg = state.config.lock().await;
        // Routes added by hand, by stacks or by worktree instances win; of
        // two containers asking for the same hostname, the first by name does.
        let mut taken: HashMap<(String, Option<String>), String> = cfg
            .gateway
            .routes
            .iter()
            .filter(|r| !is_label_route(r))
            .map(|r| {
                let by = match r.owner.as_deref() {
                    Some(o) if o.starts_with("dev:") => "a worktree instance".to_string(),
                    Some(o) if o.starts_with("stack:") => format!("stack {}", &o["stack:".len()..]),
                    _ => format!("a route to {}", r.container_name),
                };
                ((r.hostname.clone(), r.path.clone()), by)
            })
            .collect();
        let mut conflicts = Vec::new();
        wanted.retain(|r| {
            let key = (r.hostname.clone(), r.path.clone());
            if let Some(by) = taken.get(&key) {
                let host = format!("{}{}", r.hostname, r.path.as_deref().unwrap_or(""));
                conflicts.push((r.container_name.clone(), host, by.clone()));
                return false;
            }
            taken.insert(key, format!("labels on {}", r.container_name));
            true
        });
        *CONFLICTS.lock().unwrap() = conflicts;
        // A label route paused on the Gateway page stays paused.
        for r in &mut wanted {
            if let Some(old) = cfg.gateway.routes.iter().find(|o| {
                is_label_route(o)
                    && o.hostname == r.hostname
                    && o.path == r.path
                    && o.container_name == r.container_name
            }) {
                r.enabled = old.enabled;
            }
        }
        let key = |r: &GatewayRoute| (r.hostname.clone(), r.path.clone(), r.container_name.clone(), r.port);
        let have: Vec<_> = cfg
            .gateway
            .routes
            .iter()
            .filter(|r| is_label_route(r))
            .map(key)
            .collect();
        if have == wanted.iter().map(key).collect::<Vec<_>>() {
            None
        } else {
            tracing::info!("Routes from container labels: {}", wanted.len());
            cfg.gateway.routes.retain(|r| !is_label_route(r));
            cfg.gateway.routes.extend(wanted);
            cfg.save()?;
            Some(cfg.gateway.clone())
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
            Some("port") => ("", Some("port")),
            Some("path") => ("", Some("path")),
            Some(r) => match r.rsplit_once('.') {
                Some((name, attr @ ("port" | "path"))) => (name, Some(attr)),
                Some(_) => continue,
                None => (r, None),
            },
        };
        let entry = routes.entry(name).or_default();
        match attr {
            None => entry.host = Some(value),
            Some("port") => entry.port = Some(value),
            _ => entry.path = Some(value),
        }
    }
    routes
        .into_values()
        .filter_map(|RouteLabels { host, port, path }| {
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
            })
        })
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
                    path: None
                },
                Ask {
                    hostname: "api.local.test".into(),
                    port: Some(3000),
                    path: Some("/v1*".into())
                },
                Ask {
                    hostname: "app.local.test".into(),
                    port: Some(8080),
                    path: None
                },
            ]
        );
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
                    path: Some("/api*".into())
                },
                Ask {
                    hostname: "shop.test".into(),
                    port: Some(3000),
                    path: None
                },
                Ask {
                    hostname: "www.shop.test".into(),
                    port: Some(3000),
                    path: None
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
