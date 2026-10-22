//! Checks that instance URLs will actually open: the hostnames resolve to
//! this machine, aren't taken by another route, and are covered by the
//! gateway's certificate.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use orca_core::config::{GatewayConfig, GatewayTlsMode};
use orca_core::dev::hostnames;
use orca_core::dev::override_gen::PlannedRoute;
use serde::Serialize;
use tokio::sync::Mutex;

/// Whether instance hostnames resolve to this machine for programs that use
/// the system resolver (CLI tools, scripts, Safari). Chrome and Firefox
/// resolve `*.localhost` themselves, so they work even when this fails.
#[derive(Debug, Clone, Serialize)]
pub struct DnsCheck {
    pub ok: bool,
    /// The name that was looked up.
    pub host: String,
    /// What it resolved to, when it resolved.
    pub addresses: Vec<String>,
    /// What's wrong, in words, when `ok` is false.
    pub problem: Option<String>,
}

/// The gateway's custom certificate's DNS names, when it uses one.
pub fn custom_cert_names(gw: &GatewayConfig) -> Option<Vec<String>> {
    if !matches!(gw.tls_mode, GatewayTlsMode::Custom) {
        return None;
    }
    let pem = gw.custom_cert.as_deref().filter(|s| !s.trim().is_empty())?;
    let params = rcgen::CertificateParams::from_ca_cert_pem(pem).ok()?;
    Some(
        params
            .subject_alt_names
            .iter()
            .filter_map(|s| match s {
                rcgen::SanType::DnsName(n) => Some(n.as_str().to_string()),
                _ => None,
            })
            .collect(),
    )
}

/// "worktree instance feat-x", "the shop stack", "a manual route".
pub fn describe_owner(owner: Option<&str>) -> String {
    let Some(owner) = owner else {
        return "a manual route".into();
    };
    if let Some(rest) = owner.strip_prefix("dev:") {
        let rest = rest.split('#').next().unwrap_or(rest);
        if let Some((project, instance)) = rest.split_once(':') {
            return format!("worktree instance {instance} of {project}");
        }
    }
    if let Some(stack) = owner.strip_prefix("stack:") {
        return format!("the {stack} stack");
    }
    owner.to_string()
}

/// Problems with an instance's planned routes, as plan warnings.
pub fn route_warnings(gw: &GatewayConfig, me: &str, routes: &[PlannedRoute]) -> Vec<String> {
    let mut out = Vec::new();
    for r in routes {
        if let Some(other) = gw
            .routes
            .iter()
            .find(|x| x.hostname == r.hostname && x.path == r.path && x.owner.as_deref() != Some(me))
        {
            out.push(format!(
                "{} is already used by {}, so {} won't get a URL. Give {} its own hostname in this instance's Settings.",
                r.hostname,
                describe_owner(other.owner.as_deref()),
                r.service,
                r.service
            ));
        }
    }
    if let Some(names) = custom_cert_names(gw) {
        let mut uncovered: Vec<&str> = routes
            .iter()
            .map(|r| r.hostname.as_str())
            .filter(|h| !hostnames::cert_covers(&names, h))
            .collect();
        uncovered.dedup();
        if !uncovered.is_empty() {
            out.push(format!(
                "The gateway's certificate ({}) doesn't cover {}; browsers will show a certificate error. \
                 A wildcard only covers one level, so use the flat hostname pattern or a matching certificate.",
                names.join(", "),
                uncovered.join(", ")
            ));
        }
    }
    out
}

type Cache = Mutex<HashMap<String, (Instant, DnsCheck)>>;

fn cache() -> &'static Cache {
    static C: OnceLock<Cache> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Look `host` up through the system resolver; cached for a minute.
pub async fn dns_check(host: &str) -> DnsCheck {
    if let Some((at, c)) = cache().lock().await.get(host)
        && at.elapsed() < Duration::from_secs(60)
    {
        return c.clone();
    }
    let lookup = tokio::time::timeout(Duration::from_secs(3), tokio::net::lookup_host((host, 443))).await;
    let addrs: Vec<IpAddr> = match lookup {
        Ok(Ok(it)) => it.map(|a| a.ip()).collect(),
        _ => Vec::new(),
    };
    let check = judge(host, &addrs);
    cache()
        .lock()
        .await
        .insert(host.to_string(), (Instant::now(), check.clone()));
    check
}

fn judge(host: &str, addrs: &[IpAddr]) -> DnsCheck {
    let problem = if addrs.is_empty() {
        // Chrome and Firefox resolve *.localhost themselves.
        let who = if host.ends_with(".localhost") {
            "scripts, CLI tools and Safari can't open instance URLs (Chrome and Firefox still can)"
        } else {
            "instance URLs won't open"
        };
        Some(format!(
            "{host} doesn't resolve on this computer, so {who}. \
             Use a gateway domain that points to 127.0.0.1, such as local.yourcompany.dev."
        ))
    } else if !addrs.iter().any(IpAddr::is_loopback) {
        Some(format!(
            "{host} resolves to {}, not this computer. Point the domain's wildcard record at 127.0.0.1.",
            addrs.iter().map(ToString::to_string).collect::<Vec<_>>().join(", ")
        ))
    } else {
        None
    };
    DnsCheck {
        ok: problem.is_none(),
        host: host.to_string(),
        addresses: addrs.iter().map(ToString::to_string).collect(),
        problem,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owners_in_words() {
        assert_eq!(describe_owner(None), "a manual route");
        assert_eq!(
            describe_owner(Some("dev:shop:feat-x")),
            "worktree instance feat-x of shop"
        );
        assert_eq!(
            describe_owner(Some("dev:shop:feat-x#host")),
            "worktree instance feat-x of shop"
        );
        assert_eq!(describe_owner(Some("stack:shop")), "the shop stack");
    }

    #[test]
    fn judging_lookups() {
        assert!(judge("a.localhost", &["127.0.0.1".parse().unwrap()]).ok);
        assert!(judge("a.localhost", &["::1".parse().unwrap()]).ok);
        let none = judge("a.localhost", &[]);
        assert!(!none.ok && none.problem.unwrap().contains("doesn't resolve"));
        let elsewhere = judge("a.example.dev", &["93.184.216.34".parse().unwrap()]);
        assert!(elsewhere.problem.unwrap().contains("not this computer"));
    }

    #[test]
    fn uncovered_hostnames_are_reported() {
        let route = |h: &str| PlannedRoute {
            service: "web".into(),
            hostname: h.into(),
            port: 80,
            path: None,
            url: format!("https://{h}"),
            container_name: "c".into(),
        };
        let mut gw: GatewayConfig = serde_json::from_value(serde_json::json!({})).unwrap();
        gw.routes.push(orca_core::config::GatewayRoute {
            hostname: "web-a-shop.localhost".into(),
            container_name: "x".into(),
            port: 80,
            enabled: true,
            path: None,
            owner: Some("dev:shop:other".into()),
            sleeping: false,
            presentation: Default::default(),
        });
        let w = route_warnings(&gw, "dev:shop:a", &[route("web-a-shop.localhost")]);
        assert_eq!(w.len(), 1);
        assert!(w[0].contains("worktree instance other"), "{w:?}");
        // Our own routes are not a conflict.
        assert!(route_warnings(&gw, "dev:shop:other", &[route("web-a-shop.localhost")]).is_empty());
    }
}
