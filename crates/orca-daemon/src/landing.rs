//! The landing page at the gateway's domain: every routed service as a
//! card, grouped by project, with whether it runs and for how long.
//!
//! Caddy serves it as a static file from the certs folder. It is rewritten
//! when routes change and on every container start or stop (only when its
//! content changed), and refreshes itself while it is open. Everything that
//! reaches it from routes, labels or orca.yaml is escaped: it is served to
//! anyone who can reach the gateway.

use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;

use orca_core::config::{GatewayConfig, GatewayRoute, GatewayTlsMode};

use crate::gateway::{escape_html, sanitize_href};

/// What a routed container is doing, for its card.
#[derive(Debug, Clone, PartialEq)]
pub struct ServiceState {
    pub status: Status,
    /// When it started (RFC 3339), for "up 3 h".
    pub started_at: Option<String>,
    /// Its compose project, to group cards by.
    pub project: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Status {
    Running,
    Starting,
    Unhealthy,
    Restarting,
    Paused,
    Stopped,
}

/// The last known state of each routed container, by name.
static STATES: Mutex<Option<HashMap<String, ServiceState>>> = Mutex::new(None);
/// The page last written, to skip rewriting an unchanged one.
static WRITTEN: Mutex<Option<String>> = Mutex::new(None);

/// Read the state of every routed container and rewrite the page if it
/// changed. Called by the gateway sync on container events.
pub async fn refresh(docker: &bollard::Docker, config: &GatewayConfig) {
    let mut states = HashMap::new();
    let names: std::collections::BTreeSet<&str> = config.routes.iter().map(|r| r.container_name.as_str()).collect();
    for name in names {
        let Ok(info) = docker.inspect_container(name, None).await else {
            continue;
        };
        let state = info.state.unwrap_or_default();
        let health = state
            .health
            .and_then(|h| h.status)
            .map(|s| format!("{s:?}").to_lowercase());
        let status = match state.status.map(|s| format!("{s:?}").to_lowercase()).as_deref() {
            Some("running") => match health.as_deref() {
                Some("unhealthy") => Status::Unhealthy,
                Some("starting") => Status::Starting,
                _ => Status::Running,
            },
            Some("restarting") => Status::Restarting,
            Some("paused") => Status::Paused,
            _ => Status::Stopped,
        };
        let project = info
            .config
            .and_then(|c| c.labels)
            .and_then(|l| l.get("com.docker.compose.project").cloned());
        states.insert(
            name.to_string(),
            ServiceState {
                status,
                started_at: state.started_at.filter(|_| status != Status::Stopped),
                project,
            },
        );
    }
    *STATES.lock().unwrap() = Some(states);
    if let Err(e) = write(config) {
        tracing::warn!("landing page: {e}");
    }
}

/// Write the page with the last known container states.
pub fn write(config: &GatewayConfig) -> std::io::Result<()> {
    let states = STATES.lock().unwrap().clone().unwrap_or_default();
    let html = render(config, &states);
    let mut written = WRITTEN.lock().unwrap();
    if written.as_deref() == Some(html.as_str()) {
        return Ok(());
    }
    let dir = crate::gateway::certs_dir();
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join("index.html"), &html)?;
    *written = Some(html);
    Ok(())
}

/// One card on the page.
struct Card {
    title: String,
    description: Option<String>,
    url: Option<String>,
    display_url: String,
    icon: Option<String>,
    target: Option<String>,
    /// `None` when the page doesn't show status, or the card has no service.
    status: Option<(&'static str, &'static str, Option<String>)>,
}

/// Render the page.
pub fn render(config: &GatewayConfig, states: &HashMap<String, ServiceState>) -> String {
    let domain = &config.domain;
    let landing = &config.landing;
    let scheme = if matches!(config.tls_mode, GatewayTlsMode::Custom) || !config.routes.is_empty() {
        "https"
    } else {
        "http"
    };
    let port_suffix = if config.https_port == 443 {
        String::new()
    } else {
        format!(":{}", config.https_port)
    };
    let full_host = |h: &str| {
        if h.contains('.') {
            h.to_string()
        } else {
            format!("{h}.{domain}")
        }
    };
    let routes: Vec<&GatewayRoute> = config.routes.iter().filter(|r| r.enabled).collect();
    let visible: Vec<&GatewayRoute> = routes.iter().copied().filter(|r| !r.presentation.hidden).collect();

    let status_of = |r: &GatewayRoute| -> Option<(&'static str, &'static str, Option<String>)> {
        if !landing.show_status {
            return None;
        }
        if r.sleeping {
            return Some(("sleep", "Sleeping · starts when opened", None));
        }
        let Some(s) = states.get(&r.container_name) else {
            return Some(("off", "Not running", None));
        };
        Some(match s.status {
            Status::Running => ("run", "Running", s.started_at.clone()),
            Status::Starting => ("warn", "Starting", s.started_at.clone()),
            Status::Unhealthy => ("bad", "Unhealthy", s.started_at.clone()),
            Status::Restarting => ("warn", "Restarting", None),
            Status::Paused => ("off", "Paused", None),
            Status::Stopped => ("off", "Stopped", None),
        })
    };
    let route_card = |r: &GatewayRoute| -> Card {
        let host = full_host(&r.hostname);
        let path = r.path.as_deref().unwrap_or("").trim_end_matches('*');
        Card {
            title: r.presentation.title.clone().unwrap_or_else(|| default_title(r, &host)),
            description: r.presentation.description.clone(),
            url: Some(format!("{scheme}://{host}{port_suffix}{path}")),
            display_url: format!("{host}{port_suffix}{path}"),
            icon: r.presentation.icon.clone(),
            target: landing
                .show_targets
                .then(|| format!("{} :{}", r.container_name, r.port)),
            status: status_of(r),
        }
    };
    // The section a route's card is shown under: its own group, else the
    // project it comes from.
    let group_of = |r: &GatewayRoute| -> String {
        if let Some(g) = &r.presentation.group {
            return g.clone();
        }
        let owner = r.owner.as_deref().unwrap_or("");
        for prefix in ["project:", "stack:"] {
            if let Some(p) = owner.strip_prefix(prefix) {
                return p.to_string();
            }
        }
        if let Some(rest) = owner.strip_prefix("dev:") {
            return rest.split(':').next().unwrap_or(rest).to_string();
        }
        states
            .get(&r.container_name)
            .and_then(|s| s.project.clone())
            .unwrap_or_else(|| "Services".to_string())
    };

    // Environments from `links:`; "local" first.
    let mut envs: Vec<String> = Vec::new();
    if !visible.is_empty()
        || config
            .stack_links
            .iter()
            .any(|g| g.links.iter().any(|l| l.urls.contains_key("local")))
    {
        envs.push("local".into());
    }
    let mut others: Vec<String> = config
        .stack_links
        .iter()
        .flat_map(|g| g.links.iter().flat_map(|l| l.urls.keys().cloned()))
        .filter(|e| e != "local")
        .collect();
    others.sort();
    others.dedup();
    envs.extend(others);

    // Hostnames a local link points at: their route shows as that link.
    let link_host = |raw: &str| full_host(raw.split('/').next().unwrap_or(raw));
    let linked: std::collections::HashSet<String> = config
        .stack_links
        .iter()
        .flat_map(|g| g.links.iter().filter_map(|l| l.urls.get("local").map(|u| link_host(u))))
        .collect();

    let mut panels = String::new();
    for (i, env) in envs.iter().enumerate() {
        let is_local = env == "local";
        let mut sections: Vec<(String, Vec<Card>)> = Vec::new();
        for group in &config.stack_links {
            let cards: Vec<Card> = group
                .links
                .iter()
                .map(|link| match link.urls.get(env) {
                    Some(raw) if is_local && !raw.contains("://") => {
                        let host = link_host(raw);
                        let rest = raw.split_once('/').map(|(_, p)| format!("/{p}")).unwrap_or_default();
                        let route = routes.iter().find(|r| full_host(&r.hostname) == host);
                        Card {
                            title: link.name.clone(),
                            description: None,
                            url: Some(format!("{scheme}://{host}{port_suffix}{rest}")),
                            display_url: format!("{host}{port_suffix}{rest}"),
                            icon: route.and_then(|r| r.presentation.icon.clone()),
                            target: route
                                .filter(|_| landing.show_targets)
                                .map(|r| format!("{} :{}", r.container_name, r.port)),
                            status: route.and_then(|r| status_of(r)),
                        }
                    }
                    Some(url) => Card {
                        title: link.name.clone(),
                        description: None,
                        url: Some(url.clone()),
                        display_url: url
                            .trim_start_matches("https://")
                            .trim_start_matches("http://")
                            .to_string(),
                        icon: None,
                        target: None,
                        status: None,
                    },
                    None => Card {
                        title: link.name.clone(),
                        description: None,
                        url: None,
                        display_url: "Not set for this environment".into(),
                        icon: None,
                        target: None,
                        status: None,
                    },
                })
                .collect();
            if !cards.is_empty() {
                sections.push((group.group.clone(), cards));
            }
        }
        if is_local {
            let mut by_group: BTreeMap<String, Vec<Card>> = BTreeMap::new();
            for r in visible.iter().filter(|r| !linked.contains(&full_host(&r.hostname))) {
                by_group.entry(group_of(r)).or_default().push(route_card(r));
            }
            // "Services" (routes with no project) goes last.
            let rest = by_group.remove("Services");
            for (name, mut cards) in by_group.into_iter().chain(rest.map(|c| ("Services".to_string(), c))) {
                cards.sort_by_key(|a| a.title.to_lowercase());
                // A project whose links group has its name shows as one section.
                match sections.iter_mut().find(|(n, _)| n.eq_ignore_ascii_case(&name)) {
                    Some((_, existing)) => existing.extend(cards),
                    None => sections.push((name, cards)),
                }
            }
        }
        let body = if sections.is_empty() {
            empty_state(is_local)
        } else {
            sections
                .iter()
                .map(|(name, cards)| {
                    format!(
                        r#"<section class="group"><h2>{}</h2><div class="grid">{}</div></section>"#,
                        escape_html(name),
                        cards
                            .iter()
                            .enumerate()
                            .map(|(i, c)| card_html(c, i, name))
                            .collect::<String>()
                    )
                })
                .collect()
        };
        panels.push_str(&format!(
            r#"<div class="panel" data-env="{env}"{hidden}>{body}</div>"#,
            env = escape_html(env),
            hidden = if i == 0 { "" } else { " hidden" },
        ));
    }
    if envs.is_empty() {
        panels = empty_state(true);
    }
    let tabs = if envs.len() > 1 {
        let buttons: String = envs
            .iter()
            .enumerate()
            .map(|(i, e)| {
                format!(
                    r#"<button class="tab{active}" data-env="{env}">{label}</button>"#,
                    active = if i == 0 { " active" } else { "" },
                    env = escape_html(e),
                    label = escape_html(&capitalize(e)),
                )
            })
            .collect();
        format!(r#"<nav class="tabs">{buttons}</nav>"#)
    } else {
        String::new()
    };

    let running = visible
        .iter()
        .filter(|r| {
            states
                .get(&r.container_name)
                .is_some_and(|s| matches!(s.status, Status::Running | Status::Starting | Status::Unhealthy))
        })
        .count();
    let stats = if landing.show_status && !visible.is_empty() {
        format!(
            r#"<div class="stat"><b>{running}</b><span>running</span></div><div class="stat"><b>{total}</b><span>{noun}</span></div>"#,
            total = visible.len(),
            noun = if visible.len() == 1 { "service" } else { "services" },
        )
    } else {
        format!(
            r#"<div class="stat"><b>{total}</b><span>{noun}</span></div>"#,
            total = visible.len(),
            noun = if visible.len() == 1 { "service" } else { "services" },
        )
    };
    let title = landing
        .title
        .clone()
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| "Orca Gateway".into());
    let subtitle = landing
        .subtitle
        .clone()
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| format!("*.{domain}{port_suffix}"));

    let search = if landing.search {
        let web = landing.web_search_target();
        let placeholder = match &web {
            Some((name, _)) => format!("Find a service, or search {name}"),
            None => "Find a service".to_string(),
        };
        let (engine, url) = web.unwrap_or_default();
        format!(
            r#"<div class="search" id="search" data-engine="{engine}" data-url="{url}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input id="q" type="search" placeholder="{placeholder}" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="{placeholder}" aria-describedby="hint" aria-controls="content"><kbd>/</kbd></div><p class="hint" id="hint" aria-live="polite"></p>"#,
            engine = escape_html(&engine),
            url = escape_html(&url),
            placeholder = escape_html(&placeholder),
        )
    } else {
        String::new()
    };

    fill(
        PAGE,
        &[
            ("title", &escape_html(&title)),
            ("subtitle", &escape_html(&subtitle)),
            ("search", &search),
            ("stats", &stats),
            ("tabs", &tabs),
            ("panels", &panels),
        ],
    )
}

/// Put values into the template's `{name}` placeholders in one pass, so text
/// that came from a value (a title containing `{panels}`) is never filled.
fn fill(template: &str, values: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(template.len() + values.iter().map(|(_, v)| v.len()).sum::<usize>());
    let mut rest = template;
    while let Some(i) = rest.find('{') {
        out.push_str(&rest[..i]);
        let at = &rest[i..];
        match values.iter().find(|(k, _)| at.starts_with(&format!("{{{k}}}"))) {
            Some((k, v)) => {
                out.push_str(v);
                rest = &at[k.len() + 2..];
            }
            None => {
                out.push('{');
                rest = &at[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn card_html(c: &Card, i: usize, group: &str) -> String {
    const ACCENTS: [&str; 6] = ["#58a6ff", "#3fb950", "#a371f7", "#d29922", "#f85149", "#79c0ff"];
    let accent = ACCENTS[i % ACCENTS.len()];
    let icon = match c
        .icon
        .as_deref()
        .filter(|u| u.starts_with("https://") || u.starts_with("data:image/"))
    {
        Some(src) => format!(r#"<img src="{}" alt="">"#, escape_html(src)),
        None => escape_html(&c.title.chars().next().unwrap_or('?').to_uppercase().to_string()),
    };
    let status = match &c.status {
        Some((class, label, since)) => format!(
            r#"<span class="st st-{class}"><i></i><span{since}>{label}</span></span>"#,
            since = since
                .as_deref()
                .map(|s| format!(r#" data-since="{}""#, escape_html(s)))
                .unwrap_or_default(),
        ),
        None => String::new(),
    };
    let description = c
        .description
        .as_deref()
        .map(|d| format!(r#"<p class="desc">{}</p>"#, escape_html(d)))
        .unwrap_or_default();
    let target = c
        .target
        .as_deref()
        .map(|t| format!(r#"<p class="target">{}</p>"#, escape_html(t)))
        .unwrap_or_default();
    let inner = format!(
        r#"<div class="icon" style="color:{accent};background:{accent}1a">{icon}</div><div class="body"><div class="name">{title}</div>{status}{description}<p class="url">{url}</p>{target}</div>"#,
        title = escape_html(&c.title),
        url = escape_html(&c.display_url),
    );
    // What the search box matches: everything the card shows, and its group.
    let search = [
        Some(c.title.as_str()),
        Some(c.display_url.as_str()),
        c.description.as_deref(),
        c.target.as_deref(),
        c.status.as_ref().map(|(_, label, _)| *label),
        Some(group),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" ")
    .to_lowercase();
    let data = format!(
        r#" data-title="{}" data-q="{}""#,
        escape_html(&c.title),
        escape_html(&search)
    );
    match &c.url {
        Some(url) => format!(
            r#"<a class="card" href="{}" target="_blank" rel="noopener"{data}>{inner}</a>"#,
            escape_html(&sanitize_href(url))
        ),
        None => format!(r#"<div class="card off"{data}>{inner}</div>"#),
    }
}

fn empty_state(local: bool) -> String {
    let text = if local {
        "Give a service a hostname on Orca's Gateway page, with an <code>orca.route</code> label, or in the project's <code>orca.yaml</code>."
    } else {
        "Add links for this environment in a project's <code>orca.yaml</code>."
    };
    format!(r#"<div class="empty"><h2>Nothing here yet</h2><p>{text}</p></div>"#)
}

/// A card's title when the route sets none. A worktree instance's
/// hostname carries its instance and project (`web-feature-x-shop`), so it
/// becomes "Web · feature-x"; others come from the hostname.
fn default_title(r: &GatewayRoute, host: &str) -> String {
    let Some(rest) = r.owner.as_deref().and_then(|o| o.strip_prefix("dev:")) else {
        return title_from_host(host);
    };
    let (project, instance) = rest.split_once(':').unwrap_or((rest, ""));
    let label = host.split('.').next().unwrap_or(host);
    let service = label
        .strip_suffix(&format!("-{project}"))
        .unwrap_or(label)
        .strip_suffix(&format!("-{instance}"))
        .unwrap_or(label);
    let service = if service.is_empty() { label } else { service };
    if instance.is_empty() {
        title_from_host(service)
    } else {
        format!("{} · {instance}", title_from_host(service))
    }
}

/// `my-cool-app.localhost` → "My Cool App".
fn title_from_host(host: &str) -> String {
    host.split('.')
        .next()
        .unwrap_or(host)
        .split(['-', '_'])
        .filter(|w| !w.is_empty())
        .map(capitalize)
        .collect::<Vec<_>>()
        .join(" ")
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        None => String::new(),
        Some(f) => f.to_uppercase().to_string() + c.as_str(),
    }
}

/// The page. Placeholders are `{name}`; everything else is literal, so the
/// CSS and script need no escaping. No animation runs while it sits open.
const PAGE: &str = r##"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:#e6edf3;min-height:100vh;
  background:radial-gradient(900px 500px at 20% -10%,rgba(31,111,235,.16),transparent 70%),radial-gradient(700px 500px at 100% 100%,rgba(163,113,247,.10),transparent 70%),#0a0e14;
  -webkit-font-smoothing:antialiased}
.shell{max-width:960px;margin:0 auto;padding:56px 24px 48px}
header{text-align:center;margin-bottom:36px}
h1{font-size:30px;font-weight:800;letter-spacing:-.5px;background:linear-gradient(135deg,#fff,#58a6ff 55%,#a371f7);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.sub{color:#8b949e;font-size:14px;margin-top:8px}
.stats{display:flex;justify-content:center;gap:8px;margin-top:20px;flex-wrap:wrap}
.stat{background:rgba(22,27,34,.6);border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:8px 18px;display:flex;align-items:baseline;gap:6px}
.stat b{font-size:17px}.stat span{font-size:11px;color:#8b949e;text-transform:uppercase;letter-spacing:.6px}
.tabs{display:flex;gap:4px;padding:3px;margin:0 auto 24px;width:fit-content;background:rgba(22,27,34,.5);border:1px solid rgba(255,255,255,.05);border-radius:12px}
.tab{background:none;border:1px solid transparent;border-radius:9px;padding:7px 18px;color:#8b949e;font:600 13px inherit;cursor:pointer}
.tab:hover{color:#e6edf3}.tab.active{background:rgba(88,166,255,.12);border-color:rgba(88,166,255,.25);color:#58a6ff}
.group{margin-bottom:28px}
.group h2{font-size:11px;font-weight:700;color:#8b949e;text-transform:uppercase;letter-spacing:1px;margin:0 0 12px 2px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px}
.card{display:flex;gap:14px;align-items:flex-start;padding:16px;border-radius:14px;background:rgba(22,27,34,.7);border:1px solid rgba(255,255,255,.06);color:inherit;text-decoration:none;transition:border-color .15s,transform .15s}
a.card:hover{border-color:rgba(88,166,255,.35);transform:translateY(-2px)}
a.card:focus-visible{outline:2px solid #58a6ff;outline-offset:2px}
.card.off{opacity:.55}
.icon{width:44px;height:44px;border-radius:12px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;overflow:hidden}
.icon img{width:100%;height:100%;object-fit:cover}
.body{min-width:0;flex:1}
.name{font-size:14px;font-weight:600;overflow-wrap:anywhere}
.desc{font-size:12.5px;color:#a8b3bf;margin-top:3px;line-height:1.45}
.url{font:12px "SF Mono",ui-monospace,Menlo,monospace;color:#58a6ff;margin-top:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.target{font:11px "SF Mono",ui-monospace,Menlo,monospace;color:#6e7681;margin-top:3px}
.st{display:flex;align-items:center;gap:5px;font-size:11.5px;font-weight:600;margin-top:3px}
.st i{width:7px;height:7px;border-radius:50%;background:currentColor}
.st-run{color:#3fb950}.st-warn{color:#d29922}.st-bad{color:#f85149}.st-sleep{color:#a371f7}.st-off{color:#6e7681}
.empty{text-align:center;padding:56px 24px;border:1px dashed rgba(255,255,255,.08);border-radius:16px;background:rgba(22,27,34,.4)}
.empty h2{font-size:15px;color:#c9d1d9;margin-bottom:6px}.empty p{font-size:13px;color:#8b949e;line-height:1.6}
code{font:12px "SF Mono",ui-monospace,Menlo,monospace;background:rgba(88,166,255,.1);color:#58a6ff;padding:1px 5px;border-radius:4px}
footer{text-align:center;margin-top:44px;font-size:12px;color:#484f58}footer a{color:#6e7681;text-decoration:none}
[hidden]{display:none!important}
.search{position:relative;max-width:580px;margin:26px auto 0;display:flex;align-items:center;gap:10px;padding:0 14px 0 16px;height:52px;border-radius:16px;
  background:rgba(13,17,23,.75);border:1px solid rgba(255,255,255,.09);box-shadow:0 10px 40px -12px rgba(0,0,0,.6);transition:border-color .15s,box-shadow .15s}
.search:focus-within{border-color:rgba(88,166,255,.55);box-shadow:0 0 0 4px rgba(88,166,255,.12),0 10px 40px -12px rgba(0,0,0,.6)}
.search svg{width:18px;height:18px;flex-shrink:0;fill:none;stroke:#6e7681;stroke-width:2;stroke-linecap:round}
.search:focus-within svg{stroke:#58a6ff}
.search input{flex:1;min-width:0;height:100%;background:none;border:0;outline:0;color:#e6edf3;font:16px inherit}
.search input::placeholder{color:#6e7681}
.search input::-webkit-search-cancel-button{-webkit-appearance:none}
.search kbd,.hint kbd{font:11px "SF Mono",ui-monospace,Menlo,monospace;color:#8b949e;border:1px solid rgba(255,255,255,.12);border-bottom-width:2px;border-radius:5px;padding:1px 6px;background:rgba(255,255,255,.03)}
.search:focus-within kbd,.search.typed kbd{display:none}
.hint{min-height:20px;margin-top:10px;font-size:12.5px;color:#8b949e;display:flex;justify-content:center;gap:16px;flex-wrap:wrap}
.hint span{display:inline-flex;align-items:center;gap:6px}.hint b{color:#e6edf3;font-weight:600}
.card.sel{border-color:rgba(88,166,255,.7);box-shadow:0 0 0 3px rgba(88,166,255,.16);transform:translateY(-2px)}
mark{background:rgba(88,166,255,.22);color:#fff;border-radius:3px;padding:0 1px}
.nores{text-align:center;padding:40px 24px;border:1px dashed rgba(255,255,255,.08);border-radius:16px;color:#8b949e;font-size:13.5px;line-height:1.6}
.nores b{color:#e6edf3}
@media(pointer:coarse){.hint,.search kbd{display:none}}
@media(max-width:640px){.shell{padding:36px 16px 28px}h1{font-size:24px}.grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="shell">
<header><h1>{title}</h1><p class="sub">{subtitle}</p>{search}<div class="stats" id="stats">{stats}</div></header>
<main id="content">{tabs}{panels}</main>
<div class="nores" id="nores" hidden></div>
<footer>Served by <a href="https://orca-desktop.com">Orca Desktop</a></footer>
</div>
<script>
(function(){
  var KEY='orca-landing-env';
  function since(iso){
    var s=Math.max(0,(Date.now()-Date.parse(iso))/1000);
    if(s<60)return 'Up just now';
    var m=Math.floor(s/60),h=Math.floor(m/60),d=Math.floor(h/24);
    if(d>0)return 'Up '+d+' d '+(h%24)+' h';
    if(h>0)return 'Up '+h+' h '+(m%60)+' min';
    return 'Up '+m+' min';
  }
  function uptimes(){
    document.querySelectorAll('[data-since]').forEach(function(el){
      var label=el.getAttribute('data-label')||el.textContent;
      el.setAttribute('data-label',label);
      el.textContent=label==='Running'?since(el.getAttribute('data-since')):label+' · '+since(el.getAttribute('data-since')).replace('Up ','');
    });
  }
  function show(env){
    var tabs=document.querySelectorAll('.tab');
    if(!tabs.length)return;
    var found=false;
    tabs.forEach(function(t){var on=t.dataset.env===env;t.classList.toggle('active',on);found=found||on});
    if(!found){env=tabs[0].dataset.env;tabs[0].classList.add('active')}
    document.querySelectorAll('.panel').forEach(function(p){p.hidden=p.dataset.env!==env});
  }
  function bind(){
    document.querySelectorAll('.tab').forEach(function(t){
      t.addEventListener('click',function(){try{sessionStorage.setItem(KEY,t.dataset.env)}catch(e){}show(t.dataset.env)});
    });
    try{show(sessionStorage.getItem(KEY))}catch(e){}
    uptimes();
  }
  // Keep the page current while it's open: fetch it again and swap the
  // parts that change. Nothing runs while the tab is in the background.
  function refresh(){
    if(document.hidden)return;
    fetch(location.pathname,{cache:'no-store'}).then(function(r){return r.ok?r.text():null}).then(function(html){
      if(!html)return;
      var doc=new DOMParser().parseFromString(html,'text/html');
      ['content','stats'].forEach(function(id){var n=doc.getElementById(id);if(n)document.getElementById(id).innerHTML=n.innerHTML});
      bind();
    }).catch(function(){});
  }
  // The search box: narrows the cards as you type, Enter opens the best
  // match, a hostname goes straight there, anything else searches the web
  // when an engine is set. "/" or Ctrl/Cmd+K jumps to it.
  var q=document.getElementById('q'),box=document.getElementById('search'),hint=document.getElementById('hint'),nores=document.getElementById('nores');
  var engine=box?box.getAttribute('data-engine'):'',engineUrl=box?box.getAttribute('data-url'):'';
  var matches=[],sel=-1;
  function panel(){return document.querySelector('.panel:not([hidden])')||document.getElementById('content')}
  function terms(){return q?q.value.toLowerCase().trim().split(/\s+/).filter(Boolean):[]}
  function score(card,ts){
    var hay=card.getAttribute('data-q')||'',title=(card.getAttribute('data-title')||'').toLowerCase(),total=0;
    for(var i=0;i<ts.length;i++){
      var t=ts[i];
      if(hay.indexOf(t)<0)return -1;
      total+=title.indexOf(t)===0?4:(' '+title).indexOf(' '+t)>=0?3:title.indexOf(t)>=0?2:1;
    }
    return total;
  }
  function mark(card,ts){
    var name=card.querySelector('.name'),t=card.getAttribute('data-title');
    if(!name||t===null)return;
    var i=ts.length?t.toLowerCase().indexOf(ts[0]):-1;
    name.textContent='';
    if(i<0){name.textContent=t;return}
    var m=document.createElement('mark');m.textContent=t.slice(i,i+ts[0].length);
    name.appendChild(document.createTextNode(t.slice(0,i)));name.appendChild(m);name.appendChild(document.createTextNode(t.slice(i+ts[0].length)));
  }
  function isUrl(v){return /^https?:\/\/\S+$/i.test(v)||/^(localhost|[\w-]+(\.[\w-]+)+)(:\d+)?(\/\S*)?$/i.test(v)}
  function action(web){
    var v=q.value.trim();
    if(!v)return null;
    if(!web&&sel>=0&&matches[sel])return {href:matches[sel].href,label:'Open',what:matches[sel].getAttribute('data-title')};
    if(!web&&isUrl(v))return {href:/^https?:\/\//i.test(v)?v:'https://'+v,label:'Go to',what:v};
    if(engineUrl)return {href:engineUrl.split('{query}').join(encodeURIComponent(v)),label:'Search '+engine+' for',what:v};
    return null;
  }
  function el(tag,text,cls){var e=document.createElement(tag);if(cls)e.className=cls;if(text)e.textContent=text;return e}
  function line(keys,a){
    var s=el('span');keys.forEach(function(k){s.appendChild(el('kbd',k))});
    s.appendChild(document.createTextNode(' '+a.label+' '));s.appendChild(el('b',a.what));return s;
  }
  function apply(){
    if(!q)return;
    var ts=terms(),best=-1,bestScore=-1;
    matches=[];
    panel().querySelectorAll('.card').forEach(function(c){
      var s=ts.length?score(c,ts):0;
      c.hidden=s<0;c.classList.remove('sel');mark(c,ts);
      if(s>=0&&ts.length&&c.tagName==='A'){matches.push(c);if(s>bestScore){bestScore=s;best=matches.length-1}}
    });
    panel().querySelectorAll('.group').forEach(function(g){g.hidden=!g.querySelector('.card:not([hidden])')});
    sel=ts.length?best:-1;
    box.classList.toggle('typed',!!q.value);
    render();
  }
  function render(){
    matches.forEach(function(c,i){c.classList.toggle('sel',i===sel)});
    if(sel>=0&&matches[sel]&&matches[sel].scrollIntoView)matches[sel].scrollIntoView({block:'nearest'});
    hint.textContent='';
    var v=q.value.trim();
    if(!v){
      if(engineUrl){hint.appendChild(el('span','Type to find a service or search '+engine))}
      nores.hidden=true;return;
    }
    var a=action(false),w=engineUrl?action(true):null;
    if(a)hint.appendChild(line(['↵'],a));
    if(w&&a&&a.href!==w.href)hint.appendChild(line(['⇧','↵'],w));
    if(matches.length>1)hint.appendChild(el('span',matches.length+' services · ↑↓ to choose'));
    nores.hidden=!!panel().querySelector('.card:not([hidden])');
    if(!nores.hidden){
      nores.textContent='';nores.appendChild(document.createTextNode('No service matches '));nores.appendChild(el('b','“'+v+'”'));
      if(!a)nores.appendChild(document.createTextNode('. Clear the search with Esc.'));
    }
  }
  if(q){
    q.addEventListener('input',apply);
    q.addEventListener('keydown',function(e){
      if(e.key==='ArrowDown'||e.key==='ArrowUp'){
        if(!matches.length)return;
        e.preventDefault();
        sel=(sel+(e.key==='ArrowDown'?1:-1)+matches.length)%matches.length;render();
      }else if(e.key==='Enter'){
        var a=action(e.shiftKey);
        if(!a)return;
        e.preventDefault();
        if(e.metaKey||e.ctrlKey)window.open(a.href,'_blank','noopener');else location.href=a.href;
      }else if(e.key==='Escape'){
        if(q.value){q.value='';apply()}else q.blur();
      }
    });
    document.addEventListener('keydown',function(e){
      var typing=/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement&&document.activeElement.tagName);
      if((e.key==='/'&&!typing)||(e.key==='k'&&(e.metaKey||e.ctrlKey))){e.preventDefault();q.focus();q.select()}
    });
    // Ready to type when the page opens, except on touch screens, where it
    // would pop up the keyboard.
    if(!(window.matchMedia&&matchMedia('(pointer:coarse)').matches))q.focus();
    apply();
  }
  // The page swaps in fresh cards and tabs every 20 s: search them again.
  var bound=bind;
  bind=function(){bound();document.querySelectorAll('.tab').forEach(function(t){t.addEventListener('click',apply)});apply()};
  bind();
  setInterval(refresh,20000);
  setInterval(function(){if(!document.hidden)uptimes()},60000);
  document.addEventListener('visibilitychange',function(){if(!document.hidden)refresh()});
})();
</script>
</body>
</html>
"##;

#[cfg(test)]
mod tests {
    use super::*;
    use orca_core::config::{EnvironmentLink, RoutePresentation, StackLinkGroup};

    fn route(host: &str, container: &str, port: u16) -> GatewayRoute {
        GatewayRoute {
            hostname: host.into(),
            container_name: container.into(),
            port,
            enabled: true,
            path: None,
            owner: None,
            sleeping: false,
            presentation: RoutePresentation::default(),
        }
    }

    fn config(routes: Vec<GatewayRoute>) -> GatewayConfig {
        GatewayConfig {
            domain: "localhost".into(),
            routes,
            ..Default::default()
        }
    }

    fn running(since: &str, project: Option<&str>) -> ServiceState {
        ServiceState {
            status: Status::Running,
            started_at: Some(since.into()),
            project: project.map(Into::into),
        }
    }

    #[test]
    fn full_hostnames_are_not_given_the_domain_twice() {
        let html = render(
            &config(vec![route("mailpit.localhost", "mailpit-1", 8025)]),
            &HashMap::new(),
        );
        assert!(html.contains("https://mailpit.localhost\""), "{html}");
        assert!(!html.contains("mailpit.localhost.localhost"));
        // Bare names still get it.
        let html = render(&config(vec![route("app", "app-1", 3000)]), &HashMap::new());
        assert!(html.contains("https://app.localhost\""));
    }

    #[test]
    fn cards_show_status_uptime_and_group_by_project() {
        let mut shop = route("shop.localhost", "shop-web-1", 3000);
        shop.owner = Some("project:shop".into());
        let mut db = route("adminer.localhost", "adminer", 8080);
        db.presentation.title = Some("Database admin".into());
        db.presentation.description = Some("Browse every database".into());
        let mut sleepy = route("web-feat-shop.localhost", "feat-web-1", 3000);
        sleepy.sleeping = true;
        sleepy.owner = Some("dev:shop:feat".into());
        let states = HashMap::from([
            ("shop-web-1".to_string(), running("2026-10-22T10:00:00Z", Some("shop"))),
            ("adminer".to_string(), running("2026-10-22T09:00:00Z", Some("tools"))),
        ]);
        let html = render(&config(vec![shop, db, sleepy]), &states);
        assert!(html.contains(r#"<h2>shop</h2>"#));
        assert!(
            html.contains(r#"<h2>tools</h2>"#),
            "label-less routes group by compose project"
        );
        assert!(html.contains("Database admin") && html.contains("Browse every database"));
        assert!(html.contains(r#"data-since="2026-10-22T10:00:00Z""#));
        assert!(html.contains("st-sleep"));
        assert!(
            html.contains(">Web · feat<"),
            "worktree cards read service · instance: {html}"
        );
        assert!(html.contains("<b>2</b><span>running</span>"));
    }

    #[test]
    fn hidden_and_disabled_routes_stay_off_the_page() {
        let mut hidden = route("secret.localhost", "secret-1", 80);
        hidden.presentation.hidden = true;
        let mut off = route("off.localhost", "off-1", 80);
        off.enabled = false;
        let html = render(
            &config(vec![hidden, off, route("shown.localhost", "shown-1", 80)]),
            &HashMap::new(),
        );
        assert!(!html.contains("secret") && !html.contains("off.localhost"));
        assert!(html.contains("Shown"));
    }

    #[test]
    fn page_settings_and_links_per_environment() {
        let mut c = config(vec![route("storefront.localhost", "storefront-1", 3000)]);
        c.landing.title = Some("group.one dev".into());
        c.landing.show_targets = false;
        c.landing.show_status = false;
        c.stack_links = vec![StackLinkGroup {
            stack: "shop".into(),
            group: "Shop".into(),
            links: vec![EnvironmentLink {
                name: "Web App".into(),
                urls: [("local", "storefront"), ("staging", "https://staging.example.com")]
                    .into_iter()
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .collect(),
            }],
        }];
        let html = render(&c, &HashMap::new());
        assert!(html.contains("<title>group.one dev</title>"));
        assert!(html.contains(r#"data-env="staging""#) && html.contains(">Staging<"));
        assert!(html.contains("Web App") && html.contains("https://staging.example.com"));
        assert!(!html.contains("storefront-1 :3000"), "targets hidden");
        assert!(!html.contains(r#"class="st st-"#), "status hidden");
        // The linked route shows once, as the link.
        assert_eq!(html.matches("https://storefront.localhost").count(), 1);
    }

    #[test]
    fn a_title_cannot_pull_in_other_parts_of_the_page() {
        let mut c = config(vec![route("x.localhost", "x", 80)]);
        c.landing.title = Some("{panels}".into());
        let html = render(&c, &HashMap::new());
        assert!(html.contains("<title>{panels}</title>"));
    }

    #[test]
    fn user_text_is_escaped_and_unsafe_urls_dropped() {
        let mut r = route("x.localhost", "x", 80);
        r.presentation.title = Some("<script>alert(1)</script>".into());
        r.presentation.icon = Some("javascript:alert(1)".into());
        let html = render(&config(vec![r]), &HashMap::new());
        assert!(!html.contains("<script>alert"));
        assert!(!html.contains("javascript:"));
    }

    #[test]
    fn a_links_group_named_like_the_project_is_one_section() {
        let mut shop = route("admin.localhost", "shop-admin-1", 8080);
        shop.owner = Some("project:shop".into());
        let mut c = config(vec![shop]);
        c.stack_links = vec![StackLinkGroup {
            stack: "shop".into(),
            group: "Shop".into(),
            links: vec![EnvironmentLink {
                name: "Docs".into(),
                urls: [("staging", "https://docs.example.com")]
                    .into_iter()
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .collect(),
            }],
        }];
        let html = render(&c, &HashMap::new());
        let local = html
            .split(r#"<div class="panel" data-env="local""#)
            .nth(1)
            .unwrap()
            .split(r#"<div class="panel""#)
            .next()
            .unwrap();
        assert_eq!(local.matches("<h2>").count(), 1, "{local}");
    }

    #[test]
    fn search_box_and_card_search_text() {
        let mut r = route("shop.localhost", "shop-web-1", 3000);
        r.presentation.title = Some("Storefront".into());
        r.presentation.description = Some("The customer-facing <shop>".into());
        r.owner = Some("project:shop".into());
        let mut c = config(vec![r]);
        let states = HashMap::from([("shop-web-1".to_string(), running("2026-01-01T00:00:00Z", Some("shop")))]);

        let page = render(&c, &states);
        assert!(page.contains(r#"id="q""#), "search box on by default");
        assert!(page.contains(r#"placeholder="Find a service""#));
        assert!(page.contains(r#"data-url="""#), "no web search unless chosen");
        // The card can be found by title, hostname, description, container, status and group.
        assert!(
            page.contains(
                r#"data-q="storefront shop.localhost the customer-facing &lt;shop&gt; shop-web-1 :3000 running shop""#
            ),
            "{page}"
        );

        c.landing.web_search = Some("duckduckgo".into());
        let page = render(&c, &states);
        assert!(page.contains(r#"data-engine="DuckDuckGo" data-url="https://duckduckgo.com/?q={query}""#));
        assert!(page.contains("or search DuckDuckGo"));

        c.landing.web_search = Some("https://intranet.example/find?q={query}".into());
        assert!(render(&c, &states).contains(r#"data-engine="intranet.example""#));

        // Something that isn't a usable search URL is left out.
        c.landing.web_search = Some("javascript:alert(1)//{query}".into());
        assert!(render(&c, &states).contains(r#"data-url="""#));

        c.landing.search = false;
        assert!(!render(&c, &states).contains(r#"id="q""#));
    }

    /// Writes a realistic demo page for the website's screenshots:
    /// `ORCA_LANDING_DEMO=/tmp/landing.html cargo test -p orca-daemon landing_demo -- --ignored`
    #[test]
    #[ignore]
    fn landing_demo() {
        let Ok(out) = std::env::var("ORCA_LANDING_DEMO") else {
            return;
        };
        let ago = |mins: i64| (chrono::Utc::now() - chrono::Duration::minutes(mins)).to_rfc3339();
        let r = |host: &str, container: &str, port: u16, owner: &str, title: Option<&str>, desc: Option<&str>| {
            let mut x = route(host, container, port);
            x.owner = Some(owner.into());
            x.presentation.title = title.map(Into::into);
            x.presentation.description = desc.map(Into::into);
            x
        };
        let mut feat = r(
            "web-feature-checkout-shop.localhost",
            "shop-feature-checkout-web-1",
            3000,
            "dev:shop:feature-checkout",
            None,
            None,
        );
        feat.sleeping = false;
        let mut idle = r(
            "web-fix-tax-shop.localhost",
            "shop-fix-tax-web-1",
            3000,
            "dev:shop:fix-tax",
            None,
            None,
        );
        idle.sleeping = true;
        let mut c = config(vec![
            r(
                "shop.localhost",
                "shop-web-1",
                3000,
                "project:shop",
                Some("Storefront"),
                Some("The customer-facing shop"),
            ),
            r(
                "admin.localhost",
                "shop-admin-1",
                8080,
                "project:shop",
                Some("Admin"),
                Some("Orders, products and customers"),
            ),
            r(
                "mail.localhost",
                "shop-mailpit-1",
                8025,
                "project:shop",
                Some("Mailpit"),
                Some("Every email the shop sends"),
            ),
            feat,
            idle,
            r(
                "website.localhost",
                "website-wordpress-1",
                80,
                "stack:website",
                Some("Website"),
                Some("The marketing site, on WordPress"),
            ),
            r(
                "grafana.localhost",
                "telemetry-grafana-1",
                3000,
                "label:telemetry-grafana-1",
                Some("Grafana"),
                Some("Dashboards and alerts"),
            ),
            r(
                "sso.localhost",
                "sso-keycloak-1",
                8080,
                "project:sso",
                Some("Keycloak"),
                Some("Single sign-on for every app"),
            ),
        ]);
        c.landing.title = Some("Acme dev".into());
        c.landing.web_search = Some("google".into());
        c.stack_links = vec![StackLinkGroup {
            stack: "shop".into(),
            group: "Environments".into(),
            links: vec![
                EnvironmentLink {
                    name: "Storefront".into(),
                    urls: [
                        ("local", "shop"),
                        ("staging", "https://staging.shop.example.com"),
                        ("production", "https://shop.example.com"),
                    ]
                    .into_iter()
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .collect(),
                },
                EnvironmentLink {
                    name: "API docs".into(),
                    urls: [
                        ("local", "shop/api/docs"),
                        ("staging", "https://staging.shop.example.com/api/docs"),
                    ]
                    .into_iter()
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .collect(),
                },
            ],
        }];
        let unhealthy = ServiceState {
            status: Status::Unhealthy,
            started_at: Some(ago(12)),
            project: Some("sso".into()),
        };
        let states = HashMap::from([
            ("shop-web-1".to_string(), running(&ago(185), Some("shop"))),
            ("shop-admin-1".to_string(), running(&ago(185), Some("shop"))),
            ("shop-mailpit-1".to_string(), running(&ago(185), Some("shop"))),
            (
                "shop-feature-checkout-web-1".to_string(),
                running(&ago(42), Some("shop-feature-checkout")),
            ),
            (
                "website-wordpress-1".to_string(),
                running(&ago(60 * 26), Some("website")),
            ),
            (
                "telemetry-grafana-1".to_string(),
                running(&ago(60 * 74), Some("telemetry")),
            ),
            ("sso-keycloak-1".to_string(), unhealthy),
        ]);
        std::fs::write(out, render(&c, &states)).unwrap();
    }
}
