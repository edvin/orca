//! The gateway's recent requests, newest first, from Caddy's access log: what
//! `just logs` on a shared dev proxy showed, with the reason a request
//! failed when Caddy logged one ("nothing answers to one-crm-app").

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};

use orca_core::config::GatewayConfig;
use orca_core::runtime::ContainerRuntime;
use serde::Serialize;

use crate::state::AppState;

/// How much of the end of the access log is read: thousands of requests.
const TAIL_BYTES: u64 = 4 * 1024 * 1024;
/// Gateway log lines searched for why a request failed.
const ERROR_LINES: u32 = 2000;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Request {
    /// Unix time, seconds.
    pub at: f64,
    pub method: String,
    pub host: String,
    pub uri: String,
    pub status: u16,
    pub ms: f64,
    pub size: u64,
    /// The route's title and group, when one matches.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub route: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    /// What Caddy logged for a failed request.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The error in plain words.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

#[derive(Debug, Default)]
pub struct Filter {
    pub limit: usize,
    /// Only errors: status 400 and up, or no response.
    pub problems: bool,
    /// Words that must all appear in the host, path, route or group.
    pub query: Option<String>,
    /// Include the landing page's own requests (it refreshes itself).
    pub landing: bool,
}

pub async fn recent(state: &AppState, gateway: &GatewayConfig, filter: &Filter) -> Vec<Request> {
    let lines = tail_lines(&crate::gateway::access_log_path(), TAIL_BYTES);
    let mut out = parse(&lines, gateway, filter);
    if out.iter().any(|r| r.status >= 500 || r.status == 0) {
        let errors = gateway_errors(state).await;
        explain(&mut out, &errors);
    }
    out
}

/// The access log's last lines, newest first.
fn tail_lines(path: &std::path::Path, bytes: u64) -> Vec<String> {
    let Ok(mut f) = std::fs::File::open(path) else {
        return Vec::new();
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(bytes);
    if f.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let mut buf = String::new();
    let _ = f.read_to_string(&mut buf);
    let mut lines: Vec<String> = buf.lines().map(str::to_string).collect();
    // The first line may be cut off in the middle.
    if start > 0 && !lines.is_empty() {
        lines.remove(0);
    }
    lines.reverse();
    lines
}

fn parse(lines: &[String], gateway: &GatewayConfig, filter: &Filter) -> Vec<Request> {
    let terms: Vec<String> = filter
        .query
        .as_deref()
        .unwrap_or("")
        .to_lowercase()
        .split_whitespace()
        .map(str::to_string)
        .collect();
    let domain = gateway.domain.to_lowercase();
    let mut out = Vec::new();
    for line in lines {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if v["logger"] != "http.log.access" {
            continue;
        }
        let req = &v["request"];
        let host = req["host"]
            .as_str()
            .unwrap_or("")
            .split(':')
            .next()
            .unwrap_or("")
            .to_lowercase();
        let uri = req["uri"].as_str().unwrap_or("").to_string();
        if !filter.landing && host == domain {
            continue;
        }
        // The "isn't running" page asking whether its app is up yet.
        if uri.contains("_orca_wait=1") {
            continue;
        }
        let status = v["status"].as_u64().unwrap_or(0) as u16;
        if filter.problems && status != 0 && status < 400 {
            continue;
        }
        let (route, group) = route_for(gateway, &host, &uri).unzip();
        let r = Request {
            at: v["ts"].as_f64().unwrap_or(0.0),
            method: req["method"].as_str().unwrap_or("").to_string(),
            host,
            uri,
            status,
            ms: (v["duration"].as_f64().unwrap_or(0.0) * 1000.0 * 10.0).round() / 10.0,
            size: v["size"].as_u64().unwrap_or(0),
            route,
            group: group.flatten(),
            error: None,
            hint: None,
        };
        if !terms.is_empty() {
            let hay = format!(
                "{} {} {} {} {}",
                r.host,
                r.uri,
                r.route.as_deref().unwrap_or(""),
                r.group.as_deref().unwrap_or(""),
                r.status
            )
            .to_lowercase();
            if !terms.iter().all(|t| hay.contains(t)) {
                continue;
            }
        }
        out.push(r);
        if out.len() >= filter.limit {
            break;
        }
    }
    out
}

/// The route a request went to, longest path first: (title, group).
fn route_for(gateway: &GatewayConfig, host: &str, uri: &str) -> Option<(String, Option<String>)> {
    let full = |h: &str| {
        if h.contains('.') {
            h.to_lowercase()
        } else {
            format!("{}.{}", h.to_lowercase(), gateway.domain.to_lowercase())
        }
    };
    gateway
        .routes
        .iter()
        .filter(|r| r.enabled && full(&r.hostname) == host)
        .filter(|r| {
            r.path
                .as_deref()
                .is_none_or(|p| uri.starts_with(p.trim_end_matches('*')))
        })
        .max_by_key(|r| r.path.as_deref().map(str::len).unwrap_or(0))
        .map(|r| {
            (
                r.presentation.title.clone().unwrap_or_else(|| r.container_name.clone()),
                r.presentation.group.clone(),
            )
        })
}

/// Why requests failed, from the gateway's own log: (host, uri) → [(ts, message)].
async fn gateway_errors(state: &AppState) -> HashMap<(String, String), Vec<(f64, String)>> {
    let mut map: HashMap<(String, String), Vec<(f64, String)>> = HashMap::new();
    let rt = state.rt().await;
    let Ok(mut rx) = rt
        .container_logs(crate::gateway::CADDY_CONTAINER, false, Some(ERROR_LINES))
        .await
    else {
        return map;
    };
    while let Some(line) = rx.recv().await {
        let Some(start) = line.find('{') else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line[start..].trim()) else {
            continue;
        };
        if !v["logger"].as_str().is_some_and(|l| l.starts_with("http.log.error")) {
            continue;
        }
        let host = v["request"]["host"]
            .as_str()
            .unwrap_or("")
            .split(':')
            .next()
            .unwrap_or("")
            .to_lowercase();
        let uri = v["request"]["uri"].as_str().unwrap_or("").to_string();
        let msg = v["error"].as_str().or(v["msg"].as_str()).unwrap_or("").to_string();
        map.entry((host, uri))
            .or_default()
            .push((v["ts"].as_f64().unwrap_or(0.0), msg));
    }
    map
}

/// Attach the gateway's error, and what it means, to each failed request.
fn explain(requests: &mut [Request], errors: &HashMap<(String, String), Vec<(f64, String)>>) {
    for r in requests.iter_mut().filter(|r| r.status >= 500 || r.status == 0) {
        let Some(list) = errors.get(&(r.host.clone(), r.uri.clone())) else {
            continue;
        };
        // Logged when the request ended, so within its duration of it.
        if let Some((_, msg)) = list
            .iter()
            .filter(|(ts, _)| (ts - r.at).abs() < 2.0 + r.ms / 1000.0)
            .min_by(|a, b| (a.0 - r.at).abs().total_cmp(&(b.0 - r.at).abs()))
        {
            r.hint = hint(msg);
            r.error = Some(msg.clone());
        }
    }
}

/// A gateway error in plain words, for the ones that come up every day.
pub fn hint(error: &str) -> Option<String> {
    let e = error.to_lowercase();
    // "dial tcp: lookup one-crm-app on 127.0.0.11:53: no such host"
    let target = e
        .split("lookup ")
        .nth(1)
        .and_then(|s| s.split([' ', ':']).next())
        .or_else(|| e.split("dial tcp ").nth(1).and_then(|s| s.split(':').next()))
        .filter(|t| !t.is_empty())
        .map(str::to_string);
    let who = target.as_deref().unwrap_or("The service");
    let text = if e.contains("no such host") {
        format!(
            "Nothing on the gateway's networks answers to {who}: its container isn't running, or isn't on a network the gateway joined."
        )
    } else if e.contains("connection refused") {
        format!(
            "{who} runs but doesn't accept connections on that port: it's still starting, or it listens on another port."
        )
    } else if e.contains("timeout") || e.contains("deadline exceeded") {
        format!("{who} didn't answer in time.")
    } else if e.contains("eof") || e.contains("connection reset") {
        format!("{who} closed the connection before answering, often because it crashed or restarted.")
    } else {
        return None;
    };
    Some(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use orca_core::config::{GatewayRoute, RoutePresentation};

    fn gw() -> GatewayConfig {
        let route = |h: &str, path: Option<&str>, title: &str| GatewayRoute {
            hostname: h.into(),
            container_name: "x".into(),
            port: 80,
            enabled: true,
            path: path.map(Into::into),
            owner: None,
            sleeping: false,
            websocket: false,
            presentation: RoutePresentation {
                title: Some(title.into()),
                group: Some("crm".into()),
                ..Default::default()
            },
        };
        GatewayConfig {
            domain: "local.acme.dev".into(),
            routes: vec![
                route("crm.local.acme.dev", None, "CRM"),
                route("crm.local.acme.dev", Some("/api/*"), "CRM API"),
            ],
            ..Default::default()
        }
    }

    fn line(ts: f64, host: &str, uri: &str, status: u16) -> String {
        serde_json::json!({
            "level": "info", "ts": ts, "logger": "http.log.access", "msg": "handled request",
            "request": {"method": "GET", "host": host, "uri": uri},
            "duration": 0.0123, "size": 512, "status": status
        })
        .to_string()
    }

    #[test]
    fn reads_requests_and_their_routes() {
        let lines = vec![
            line(3.0, "crm.local.acme.dev", "/api/users", 502),
            line(2.0, "local.acme.dev", "/", 200),
            line(1.0, "crm.local.acme.dev:443", "/", 200),
            line(0.5, "crm.local.acme.dev", "/orders?_orca_wait=1", 502),
            "not json".into(),
        ];
        let all = parse(
            &lines,
            &gw(),
            &Filter {
                limit: 10,
                ..Default::default()
            },
        );
        assert_eq!(
            all.len(),
            2,
            "the landing page's own requests, and the down page's checks, are left out"
        );
        assert_eq!(
            (all[0].route.as_deref(), all[0].status, all[0].ms),
            (Some("CRM API"), 502, 12.3)
        );
        assert_eq!(
            (all[1].route.as_deref(), all[1].host.as_str()),
            (Some("CRM"), "crm.local.acme.dev")
        );

        let problems = parse(
            &lines,
            &gw(),
            &Filter {
                limit: 10,
                problems: true,
                ..Default::default()
            },
        );
        assert_eq!(problems.len(), 1);
        let found = parse(
            &lines,
            &gw(),
            &Filter {
                limit: 10,
                query: Some("crm 502".into()),
                ..Default::default()
            },
        );
        assert_eq!(found.len(), 1);
    }

    #[test]
    fn explains_failures() {
        let mut reqs = parse(
            &[line(10.0, "crm.local.acme.dev", "/", 502)],
            &gw(),
            &Filter {
                limit: 5,
                ..Default::default()
            },
        );
        let errors = HashMap::from([(
            ("crm.local.acme.dev".to_string(), "/".to_string()),
            vec![(
                10.01,
                "dial tcp: lookup one-crm-app on 127.0.0.11:53: no such host".to_string(),
            )],
        )]);
        explain(&mut reqs, &errors);
        assert!(
            reqs[0]
                .hint
                .as_deref()
                .unwrap()
                .starts_with("Nothing on the gateway's networks answers to one-crm-app")
        );
        assert!(
            hint("dial tcp 172.18.0.5:8080: connect: connection refused")
                .unwrap()
                .contains("doesn't accept connections")
        );
        assert_eq!(hint("something else"), None);
    }

    #[test]
    fn tail_reads_newest_first() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("access.log");
        std::fs::write(&p, "first\nsecond\nthird\n").unwrap();
        assert_eq!(tail_lines(&p, 1000), ["third", "second", "first"]);
        // A cut first line is dropped.
        assert_eq!(tail_lines(&p, 9), ["third"]);
        assert!(tail_lines(&dir.path().join("none"), 10).is_empty());
    }
}
