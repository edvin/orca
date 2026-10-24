//! The landing page at the gateway's domain: every routed service as a
//! card, grouped by project, with whether it runs and for how long.
//!
//! Caddy serves it as a static file from the certs folder. It is rewritten
//! when routes change and on every container start or stop (only when its
//! content changed), and refreshes itself while it is open. Everything that
//! reaches it from routes, labels or orca.yaml is escaped: it is served to
//! anyone who can reach the gateway.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
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
    /// Its image, which picks an icon when the route sets none.
    pub image: Option<String>,
    /// A workspace project not set up on this machine yet, by key: its card
    /// offers to set it up in Orca.
    pub setup: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Status {
    Running,
    Starting,
    Unhealthy,
    Restarting,
    Paused,
    Stopped,
    /// A workspace project's service that isn't cloned yet.
    NotSetUp,
}

/// The last known state of each routed container, by name.
static STATES: Mutex<Option<HashMap<String, ServiceState>>> = Mutex::new(None);
/// What each project runs, for its group's details.
static DETAILS: Mutex<Option<Details>> = Mutex::new(None);
/// The page last written, to skip rewriting an unchanged one.
static WRITTEN: Mutex<Option<String>> = Mutex::new(None);

/// What the gateway sync knows besides the containers.
#[derive(Default)]
pub struct Context {
    /// The owner of a workspace project's routes → the project's key, for
    /// projects not cloned yet.
    pub not_set_up: HashMap<String, String>,
    /// The owner of a workspace project's routes → the project's folder.
    pub dirs: HashMap<String, PathBuf>,
    /// A project folder → its databases: (name, server, port on this computer).
    pub databases: HashMap<PathBuf, Vec<(String, String, Option<u16>)>>,
}

/// The projects behind the page's groups, shown when a group's details are
/// opened: their services and where to reach them, and their databases.
#[derive(Debug, Clone, Default)]
pub struct Details {
    /// Compose project → its containers.
    projects: BTreeMap<String, Vec<Service>>,
    /// Project folder → compose project.
    by_dir: HashMap<PathBuf, String>,
    /// Route owner → project folder (workspace projects).
    dirs: HashMap<String, PathBuf>,
    databases: HashMap<PathBuf, Vec<(String, String, Option<u16>)>>,
}

#[derive(Debug, Clone)]
struct Service {
    service: String,
    container: String,
    running: bool,
    /// (port inside, port on this computer).
    ports: Vec<(u16, Option<u16>)>,
}

/// Read the state of every routed container and rewrite the page if it
/// changed. Called by the gateway sync on container events.
///
/// `not_set_up` maps the owner of a workspace project's routes to the
/// project's key, for projects not cloned yet.
pub async fn refresh(docker: &bollard::Docker, config: &GatewayConfig, ctx: &Context) {
    let not_set_up = &ctx.not_set_up;
    let mut states = HashMap::new();
    let names: std::collections::BTreeSet<&str> = config.routes.iter().map(|r| r.container_name.as_str()).collect();
    // Workspace routes target network aliases (`one-crm-app`), which only
    // resolve to a container through its networks; looked up once, if needed.
    let mut aliases: Option<HashMap<String, String>> = None;
    for name in names {
        let info = match docker.inspect_container(name, None).await {
            Ok(info) => info,
            Err(_) => {
                if aliases.is_none() {
                    aliases = Some(alias_map(docker).await);
                }
                let Some(container) = aliases.as_ref().and_then(|m| m.get(name)) else {
                    // Nothing runs it: a workspace project not set up yet?
                    let setup = config
                        .routes
                        .iter()
                        .filter(|r| r.container_name == name)
                        .find_map(|r| not_set_up.get(r.owner.as_deref()?));
                    if let Some(key) = setup {
                        states.insert(
                            name.to_string(),
                            ServiceState {
                                status: Status::NotSetUp,
                                started_at: None,
                                project: None,
                                image: None,
                                setup: Some(key.clone()),
                            },
                        );
                    }
                    continue;
                };
                let Ok(info) = docker.inspect_container(container, None).await else {
                    continue;
                };
                info
            }
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
        let image = info.config.as_ref().and_then(|c| c.image.clone());
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
                image,
                setup: None,
            },
        );
    }
    *STATES.lock().unwrap() = Some(states);
    *DETAILS.lock().unwrap() = Some(details(docker, ctx).await);
    if let Err(e) = write(config) {
        tracing::warn!("landing page: {e}");
    }
}

/// Every compose project's containers, running or not.
async fn details(docker: &bollard::Docker, ctx: &Context) -> Details {
    let mut d = Details {
        dirs: ctx.dirs.clone(),
        databases: ctx.databases.clone(),
        ..Default::default()
    };
    let opts = bollard::container::ListContainersOptions::<String> {
        all: true,
        ..Default::default()
    };
    let Ok(list) = docker.list_containers(Some(opts)).await else {
        return d;
    };
    for c in list {
        let labels = c.labels.unwrap_or_default();
        let (Some(project), Some(service)) = (
            labels.get("com.docker.compose.project"),
            labels.get("com.docker.compose.service"),
        ) else {
            continue;
        };
        if let Some(dir) = labels.get("com.docker.compose.project.working_dir") {
            let dir = Path::new(dir);
            d.by_dir.insert(
                dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf()),
                project.clone(),
            );
        }
        let mut ports: Vec<(u16, Option<u16>)> = c
            .ports
            .unwrap_or_default()
            .into_iter()
            .filter(|p| p.ip.as_deref().is_none_or(|ip| !ip.contains(':')))
            .map(|p| (p.private_port, p.public_port))
            .collect();
        ports.sort();
        ports.dedup();
        let container = c
            .names
            .and_then(|n| n.first().map(|n| n.trim_start_matches('/').to_string()))
            .unwrap_or_default();
        d.projects.entry(project.clone()).or_default().push(Service {
            service: service.clone(),
            container,
            running: c.state.as_deref() == Some("running"),
            ports,
        });
    }
    for services in d.projects.values_mut() {
        services.sort_by(|a, b| a.service.cmp(&b.service));
    }
    d
}

/// Network alias → container name, for every container on a user network.
async fn alias_map(docker: &bollard::Docker) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Ok(list) = docker.list_containers::<String>(None).await else {
        return map;
    };
    for c in list {
        let Some(name) = c
            .names
            .and_then(|n| n.first().map(|n| n.trim_start_matches('/').to_string()))
        else {
            continue;
        };
        if name == crate::gateway::CADDY_CONTAINER {
            continue;
        }
        // The list leaves aliases out on some engines; inspect has them.
        let Ok(info) = docker.inspect_container(&name, None).await else {
            continue;
        };
        let nets = info.network_settings.and_then(|n| n.networks).unwrap_or_default();
        for ep in nets.into_values() {
            for a in ep.aliases.unwrap_or_default() {
                map.entry(a).or_insert_with(|| name.clone());
            }
        }
    }
    map
}

/// Where the page's icons are served, and the folder in the certs volume
/// they're written to (the only one the gateway serves besides the page).
pub const ICON_PATH: &str = "/_orca/icons/";
pub const ICON_DIR: &str = "landing-icons";

/// Write the page with the last known container states.
pub fn write(config: &GatewayConfig) -> std::io::Result<()> {
    let states = STATES.lock().unwrap().clone().unwrap_or_default();
    let details = DETAILS.lock().unwrap().clone().unwrap_or_default();
    let (html, icons) = externalize_icons(&render_with(config, &states, &details));
    let dir = crate::gateway::certs_dir().join(ICON_DIR);
    std::fs::create_dir_all(&dir)?;
    for (name, bytes) in &icons {
        let path = dir.join(name);
        if !path.exists() {
            std::fs::write(path, bytes)?;
        }
    }
    // Icons no route uses any more.
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            if !icons.iter().any(|(n, _)| e.file_name().to_string_lossy() == n.as_str()) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
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

/// A banner when the gateway's own certificate (a team's, for the domain)
/// expires within a month or has expired, so nobody is surprised by it.
fn cert_notice(config: &GatewayConfig) -> String {
    let Some((days, expires)) = crate::gateway::custom_cert_warning(config) else {
        return String::new();
    };
    let when = expires.format("%-d %B %Y");
    let text = match days {
        d if d < 0 => format!(
            "The certificate for *.{} expired on {when}: browsers warn on every page until it's renewed.",
            config.domain
        ),
        0 => format!("The certificate for *.{} expires today.", config.domain),
        1 => format!("The certificate for *.{} expires tomorrow, {when}.", config.domain),
        d => format!(
            "The certificate for *.{} expires in {d} days, on {when}.",
            config.domain
        ),
    };
    format!(
        r#"<div class="notice{}">{}</div>"#,
        if days < 0 { " bad" } else { "" },
        escape_html(&text)
    )
}

/// A workspace's shared-service route: owned by `workspace:<name>`, with no
/// project after it.
fn is_shared(r: &GatewayRoute) -> bool {
    r.owner
        .as_deref()
        .and_then(|o| o.strip_prefix("workspace:"))
        .is_some_and(|rest| !rest.contains(':'))
}

/// The page with each embedded image (`src="data:image/…;base64,…"`) moved
/// to a file under [`ICON_PATH`], named by its content: (page, files).
fn externalize_icons(html: &str) -> (String, Vec<(String, Vec<u8>)>) {
    use base64::Engine;
    let mut out = String::with_capacity(html.len() / 4);
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    let mut rest = html;
    while let Some(i) = rest.find(r#"src="data:image/"#) {
        let start = i + r#"src=""#.len();
        let Some(len) = rest[start..].find('"') else { break };
        let uri = &rest[start..start + len];
        let ext = match uri.split(';').next().unwrap_or("") {
            "data:image/svg+xml" => "svg",
            "data:image/png" => "png",
            "data:image/webp" => "webp",
            "data:image/jpeg" => "jpg",
            _ => "",
        };
        let bytes = uri
            .split_once(";base64,")
            .and_then(|(_, b)| base64::engine::general_purpose::STANDARD.decode(b).ok());
        out.push_str(&rest[..start]);
        match (ext, bytes) {
            ("", _) | (_, None) => out.push_str(uri),
            (ext, Some(bytes)) => {
                // FNV-1a of the content: the same icon is one file.
                let mut h: u64 = 0xcbf29ce484222325;
                for b in &bytes {
                    h = (h ^ *b as u64).wrapping_mul(0x100000001b3);
                }
                let name = format!("{h:016x}.{ext}");
                out.push_str(&format!("{ICON_PATH}{name}"));
                if !files.iter().any(|(n, _)| *n == name) {
                    files.push((name, bytes));
                }
            }
        }
        rest = &rest[start + len..];
    }
    out.push_str(rest);
    (out, files)
}

/// How many columns of the page a group of `cards` takes: its own count,
/// so small groups sit side by side, or "many" for a full row.
fn group_size(cards: usize) -> String {
    if cards >= 4 {
        "many".into()
    } else {
        cards.max(1).to_string()
    }
}

/// Whether a route's service runs: (class, label, running since).
fn route_status(
    r: &GatewayRoute,
    states: &HashMap<String, ServiceState>,
) -> (&'static str, &'static str, Option<String>) {
    if r.sleeping {
        return ("sleep", "Sleeping · starts when opened", None);
    }
    let Some(s) = states.get(&r.container_name) else {
        return ("off", "Not running", None);
    };
    match s.status {
        Status::Running => ("run", "Running", s.started_at.clone()),
        Status::Starting => ("warn", "Starting", s.started_at.clone()),
        Status::Unhealthy => ("bad", "Unhealthy", s.started_at.clone()),
        Status::Restarting => ("warn", "Restarting", None),
        Status::Paused => ("off", "Paused", None),
        Status::Stopped => ("off", "Stopped", None),
        Status::NotSetUp => ("setup", "Not set up · set it up in Orca", None),
    }
}

/// The section a route is shown under: its own group, else the project it
/// comes from.
fn route_group(r: &GatewayRoute, states: &HashMap<String, ServiceState>) -> String {
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
}

/// Each route's group and whether its service runs, as the landing page
/// last saw them, for the Gateway page in Orca.
pub fn route_states(config: &GatewayConfig) -> Vec<serde_json::Value> {
    let states = STATES.lock().unwrap().clone().unwrap_or_default();
    config
        .routes
        .iter()
        .map(|r| {
            let (state, label, since) = route_status(r, &states);
            serde_json::json!({
                "hostname": r.hostname,
                "path": r.path,
                "group": route_group(r, &states),
                "state": state,
                "label": label.split(" · ").next().unwrap_or(label),
                "since": since,
                "setup": states.get(&r.container_name).and_then(|s| s.setup.clone()),
            })
        })
        .collect()
}

/// Render the page.
#[cfg(test)]
pub fn render(config: &GatewayConfig, states: &HashMap<String, ServiceState>) -> String {
    render_with(config, states, &Details::default())
}

/// A project in a group's details: what to call it, an address of its for
/// the links into Orca, and its compose project once it has containers.
struct GroupProject {
    label: String,
    url: String,
    project: Option<String>,
    dir: Option<PathBuf>,
}

fn render_with(config: &GatewayConfig, states: &HashMap<String, ServiceState>, details: &Details) -> String {
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
    // Pattern and WebSocket-only routes aren't pages one could open.
    let visible: Vec<&GatewayRoute> = routes
        .iter()
        .copied()
        .filter(|r| !r.presentation.hidden && !r.is_pattern() && !r.websocket)
        .collect();

    let status_of = |r: &GatewayRoute| landing.show_status.then(|| route_status(r, states));
    // The route's own icon, else one its container's image picks.
    let icon_of = |r: &GatewayRoute| -> Option<String> {
        r.presentation
            .icon
            .as_deref()
            .and_then(orca_core::icons::src)
            .or_else(|| {
                let image = states.get(&r.container_name)?.image.as_deref()?;
                orca_core::icons::src(orca_core::icons::for_image(image)?)
            })
    };
    let route_card = |r: &GatewayRoute| -> Card {
        let host = full_host(&r.hostname);
        let path = r.path.as_deref().unwrap_or("").trim_end_matches('*');
        // A project not set up yet opens Orca at it, where one click sets it up.
        let setup = states.get(&r.container_name).and_then(|s| s.setup.as_deref());
        Card {
            title: r.presentation.title.clone().unwrap_or_else(|| default_title(r, &host)),
            description: r.presentation.description.clone(),
            url: Some(match setup {
                Some(key) => format!("orca://workspace?setup={}", urlencoding::encode(key)),
                None => format!("{scheme}://{host}{port_suffix}{path}"),
            }),
            display_url: format!("{host}{port_suffix}{path}"),
            icon: icon_of(r),
            target: landing
                .show_targets
                .then(|| format!("{} :{}", r.container_name, r.port)),
            status: status_of(r),
        }
    };
    let group_of = |r: &GatewayRoute| route_group(r, states);

    // Environments from `links:`; "local" first.
    let mut envs: Vec<String> = Vec::new();
    if !visible.is_empty()
        || !landing.links.is_empty()
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
    // The usual order, from development to production; others after them.
    let rank = |e: &str| {
        let e = e.to_ascii_lowercase();
        match e.as_str() {
            _ if e.starts_with("dev") => 0,
            "test" | "testing" | "qa" => 1,
            _ if e.starts_with("stag") || e == "preprod" || e == "eval" => 2,
            "prod" | "production" | "live" => 3,
            _ => 4,
        }
    };
    others.sort_by_key(|e| (rank(e), e.to_ascii_lowercase()));
    others.dedup();
    envs.extend(others);

    // Hostnames a local link points at: their route shows as that link.
    let link_host = |raw: &str| full_host(raw.split('/').next().unwrap_or(raw));
    let linked: std::collections::HashSet<String> = config
        .stack_links
        .iter()
        .flat_map(|g| g.links.iter().filter_map(|l| l.urls.get("local").map(|u| link_host(u))))
        .collect();

    // Each group's projects, for its details.
    let mut group_projects: HashMap<String, Vec<GroupProject>> = HashMap::new();
    for r in visible.iter().filter(|r| !is_shared(r)) {
        let owner = r.owner.as_deref().unwrap_or("");
        let dir = details.dirs.get(owner).cloned();
        let project = states
            .get(&r.container_name)
            .and_then(|s| s.project.clone())
            .or_else(|| dir.as_ref().and_then(|d| details.by_dir.get(d).cloned()));
        let label = project
            .clone()
            .or_else(|| owner.rsplit(':').next().filter(|k| !k.is_empty()).map(String::from))
            .unwrap_or_else(|| r.container_name.clone());
        let list = group_projects.entry(group_of(r)).or_default();
        if list.iter().any(|p| p.label == label) {
            continue;
        }
        let path = r.path.as_deref().unwrap_or("").trim_end_matches('*');
        list.push(GroupProject {
            label,
            url: format!("{scheme}://{}{port_suffix}{path}", full_host(&r.hostname)),
            project,
            dir,
        });
    }

    let mut shared_groups: std::collections::BTreeSet<String> = Default::default();
    let mut panels = String::new();
    for (i, env) in envs.iter().enumerate() {
        let is_local = env == "local";
        let mut sections: Vec<(String, Vec<Card>)> = Vec::new();
        if is_local && !landing.links.is_empty() {
            sections.push((
                "My links".into(),
                landing
                    .links
                    .iter()
                    .map(|l| Card {
                        title: l.title.clone(),
                        description: l.description.clone(),
                        url: Some(l.url.clone()),
                        display_url: l
                            .url
                            .trim_start_matches("https://")
                            .trim_start_matches("http://")
                            .trim_end_matches('/')
                            .to_string(),
                        icon: None,
                        target: None,
                        status: None,
                    })
                    .collect(),
            ));
        }
        for group in &config.stack_links {
            let cards: Vec<Card> = group
                .links
                .iter()
                // A link with no URL for this environment stays off its tab.
                .filter_map(|link| link.urls.get(env).map(|raw| (link, raw)))
                .map(|(link, raw)| match raw {
                    raw if is_local && !raw.contains("://") => {
                        let host = link_host(raw);
                        let rest = raw.split_once('/').map(|(_, p)| format!("/{p}")).unwrap_or_default();
                        let route = routes.iter().find(|r| full_host(&r.hostname) == host);
                        Card {
                            title: link.name.clone(),
                            description: None,
                            url: Some(format!("{scheme}://{host}{port_suffix}{rest}")),
                            display_url: format!("{host}{port_suffix}{rest}"),
                            icon: route.and_then(|r| icon_of(r)),
                            target: route
                                .filter(|_| landing.show_targets)
                                .map(|r| format!("{} :{}", r.container_name, r.port)),
                            status: route.and_then(|r| status_of(r)),
                        }
                    }
                    url => Card {
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
                })
                .collect();
            if !cards.is_empty() {
                sections.push((group.group.clone(), cards));
            }
        }
        if is_local {
            // A workspace's shared services (Mailpit, Grafana…): first, as a strip.
            for r in visible.iter().filter(|r| is_shared(r)) {
                shared_groups.insert(group_of(r));
            }
            let mut by_group: BTreeMap<String, Vec<Card>> = BTreeMap::new();
            for r in visible.iter().filter(|r| !linked.contains(&full_host(&r.hostname))) {
                by_group.entry(group_of(r)).or_default().push(route_card(r));
            }
            // Shared services go first, "Services" (routes with no project) last.
            let rest = by_group.remove("Services");
            let shared: Vec<(String, Vec<Card>)> = shared_groups
                .iter()
                .filter_map(|g| by_group.remove(g).map(|c| (g.clone(), c)))
                .collect();
            for (name, mut cards) in shared
                .into_iter()
                .chain(by_group)
                .chain(rest.map(|c| ("Services".to_string(), c)))
            {
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
                    let more = group_projects
                        .get(name)
                        .filter(|_| is_local && !shared_groups.contains(name))
                        .map(|projects| details_html(projects, details))
                        .unwrap_or_default();
                    format!(
                        r#"<section class="group{shared}" data-group="{group}" data-size="{size}"><div class="gh"><h2 role="button" tabindex="0" title="Fold or unfold">{group}</h2>{more}</div><div class="grid">{}</div></section>"#,
                        cards
                            .iter()
                            .enumerate()
                            .map(|(i, c)| card_html(c, i, name))
                            .collect::<String>(),
                        group = escape_html(name),
                        size = group_size(cards.len()),
                        shared = if shared_groups.contains(name) { " shared" } else { "" },
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
    // A few words after the domain, to leave the bar to the search box.
    let stats = if landing.show_status && !visible.is_empty() {
        format!(r#"<b>{running}</b> of {total} running"#, total = visible.len())
    } else {
        format!(
            "{total} {noun}",
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

    // A joined workspace's logo, beside the title.
    let logo = landing
        .logo
        .as_deref()
        .and_then(orca_core::icons::src)
        .map(|src| format!(r#"<img class="logo" src="{}" alt="">"#, escape_html(&src)))
        .unwrap_or_default();

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
            ("logo", &logo),
            ("subtitle", &escape_html(&subtitle)),
            ("search", &search),
            ("stats", &stats),
            ("notice", &cert_notice(config)),
            ("tabs", &tabs),
            ("panels", &panels),
        ],
    )
}

/// A group's details button and panel: per project, links into Orca, its
/// databases and its services with their addresses, each one click to copy.
fn details_html(projects: &[GroupProject], details: &Details) -> String {
    let link = |url: &str, action: &str, label: &str| {
        format!(
            r#"<a href="orca://app?do={action}&amp;url={}">{label}</a>"#,
            escape_html(&urlencoding::encode(url))
        )
    };
    let copy = |text: &str| format!(r#"<code data-copy="{0}" title="Copy">{0}</code>"#, escape_html(text));
    let mut body = String::new();
    for p in projects {
        let services = p.project.as_ref().and_then(|n| details.projects.get(n));
        let total = services.map_or(0, Vec::len);
        let up = services.map_or(0, |s| s.iter().filter(|s| s.running).count());
        let summary = match (total, up) {
            (0, _) => "Not started yet".to_string(),
            (t, u) if t == u => "Running".to_string(),
            (_, 0) => "Stopped".to_string(),
            (t, u) => format!("{u} of {t} running"),
        };
        let mut actions = String::new();
        if up < total || total == 0 {
            actions.push_str(&link(&p.url, "start", "Start"));
        }
        if up > 0 {
            actions.push_str(&link(&p.url, "stop", "Stop"));
        }
        actions.push_str(&link(&p.url, "open", "Open in Orca"));
        let mut rows = String::new();
        let dir = p.dir.clone().or_else(|| {
            let name = p.project.as_ref()?;
            details.by_dir.iter().find(|(_, n)| *n == name).map(|(d, _)| d.clone())
        });
        let dbs = dir.as_ref().and_then(|d| details.databases.get(d));
        for (name, server, port) in dbs.into_iter().flatten() {
            let at = port.map(|p| copy(&format!("127.0.0.1:{p}"))).unwrap_or_default();
            rows.push_str(&format!(
                r#"<div class="row"><span class="k db">{}</span><span class="v"><span class="note">on {}</span>{at}</span></div>"#,
                escape_html(name),
                escape_html(server),
            ));
        }
        for s in services.into_iter().flatten() {
            let mut addrs = String::new();
            for (inside, outside) in &s.ports {
                if let Some(o) = outside {
                    addrs.push_str(&copy(&format!("127.0.0.1:{o}")));
                }
                addrs.push_str(&copy(&format!("{}:{inside}", s.container)));
            }
            if s.ports.is_empty() {
                addrs.push_str(&copy(&s.container));
            }
            rows.push_str(&format!(
                r#"<div class="row"><span class="k"><i class="{on}"></i>{}</span><span class="v">{addrs}</span></div>"#,
                escape_html(&s.service),
                on = if s.running { "on" } else { "" },
            ));
        }
        body.push_str(&format!(
            r#"<div class="proj"><div class="ph"><b>{}</b><span class="pst">{}</span></div><div class="acts">{actions}</div>{rows}</div>"#,
            escape_html(&p.label),
            escape_html(&summary),
        ));
    }
    format!(
        r#"<button type="button" class="more" aria-expanded="false" title="Details: start or stop, addresses and ports" aria-label="Details"><svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg></button><div class="pop" hidden>{body}</div>"#
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
    // What "Running only" keeps: running, starting, unhealthy, sleeping, and
    // links with no service behind them.
    let state = c.status.as_ref().map(|(class, _, _)| *class).unwrap_or("none");
    let data = format!(
        r#" data-title="{}" data-q="{}" data-st="{state}""#,
        escape_html(&c.title),
        escape_html(&search)
    );
    match &c.url {
        // Orca's own link opens the app, not a tab.
        Some(url) if url.starts_with("orca://") => format!(
            r#"<a class="card setup" href="{}"{data}>{inner}</a>"#,
            escape_html(&sanitize_href(url))
        ),
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
pub(crate) fn default_title(r: &GatewayRoute, host: &str) -> String {
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
  -webkit-font-smoothing:antialiased;overflow-x:hidden}
.shell{max-width:1040px;margin:0 auto;padding:0 24px 48px}
header{position:sticky;top:0;z-index:5;margin:0 calc(50% - 50vw) 26px;padding:14px 24px;background:rgba(10,14,20,.8);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);border-bottom:1px solid rgba(255,255,255,.06)}
.top{display:flex;align-items:flex-start;gap:22px;max-width:992px;margin:0 auto}
.brand{min-width:0;flex-shrink:0;display:flex;align-items:center;gap:14px;min-height:42px}
.logo{display:block;height:26px;max-width:180px;object-fit:contain}
.logo+div{padding-left:14px;border-left:1px solid rgba(255,255,255,.1)}
.find{flex:1;min-width:0}
h1{font-size:19px;font-weight:800;letter-spacing:-.3px;white-space:nowrap;background:linear-gradient(135deg,#fff,#58a6ff 55%,#a371f7);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.sub{color:#8b949e;font-size:12px;margin-top:2px;white-space:nowrap}
.stats::before{content:'·';margin:0 6px;color:#484f58}.stats b{color:#3fb950;font-weight:600}
.tabs{display:flex;gap:4px;padding:3px;margin:0 auto 24px;width:fit-content;background:rgba(22,27,34,.5);border:1px solid rgba(255,255,255,.05);border-radius:12px}
.tab{background:none;border:1px solid transparent;border-radius:9px;padding:7px 18px;color:#8b949e;font:600 13px inherit;cursor:pointer}
.tab:hover{color:#e6edf3}.tab.active{background:rgba(88,166,255,.12);border-color:rgba(88,166,255,.25);color:#58a6ff}
.group{margin-bottom:28px;grid-column:1/-1;min-width:0}
/* Groups share rows: one taking as many of the page's columns as it has
   cards, so a project with one service doesn't take a whole row. */
.panel{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));column-gap:10px;grid-auto-flow:row dense}
.panel>.empty{grid-column:1/-1}
.group[data-size="1"]{grid-column:span 1}.group[data-size="2"]{grid-column:span 2}
.group[data-size="1"] .grid{grid-template-columns:minmax(0,1fr)}.group[data-size="2"] .grid{grid-template-columns:repeat(2,minmax(0,1fr))}
body.compact .panel{grid-template-columns:repeat(4,minmax(0,1fr))}
/* Shared services: a strip of chips, in either layout. */
.group.shared{grid-column:1/-1!important}
.group.shared .grid{display:flex;flex-wrap:wrap;gap:6px}
.group.shared .card{padding:5px 12px 5px 6px;gap:8px;align-items:center;border-radius:999px;position:static}
.group.shared .icon{width:24px;height:24px;border-radius:50%;font-size:11px}
.group.shared .body{display:flex;align-items:center;gap:8px;flex:none}
.group.shared .name{font-size:13px;white-space:nowrap}
.group.shared .desc,.group.shared .target,.group.shared .url,.group.shared .st span{display:none}
.group.shared .st{position:static;margin:0}
body.compact .group[data-size="3"]{grid-column:span 3}body.compact .group[data-size="3"] .grid{grid-template-columns:repeat(3,minmax(0,1fr))}
@media(max-width:900px){.panel,body.compact .panel{grid-template-columns:repeat(2,minmax(0,1fr))}body.compact .group[data-size="3"]{grid-column:1/-1}}
@media(max-width:640px){.panel,body.compact .panel{grid-template-columns:minmax(0,1fr)}.group[data-size]{grid-column:1/-1}}
.group h2{font-size:11px;font-weight:700;color:#8b949e;text-transform:uppercase;letter-spacing:1px;margin:0}
.gh{display:flex;align-items:center;gap:4px;margin:0 0 12px 2px;position:relative;min-width:0;min-height:20px}
.more{width:26px;height:20px;flex-shrink:0;display:grid;place-items:center;background:none;border:0;border-radius:6px;color:#6e7681;cursor:pointer;opacity:0;transition:opacity .15s}
.group:hover .more,.more:focus-visible,.more[aria-expanded="true"]{opacity:1}
.more:hover,.more[aria-expanded="true"]{color:#e6edf3;background:rgba(255,255,255,.07)}
.more svg{width:16px;height:16px;fill:currentColor}
@media(pointer:coarse){.more{opacity:1}}
.pop{position:absolute;top:calc(100% + 6px);left:0;z-index:6;width:460px;max-width:calc(100vw - 32px);max-height:min(70vh,560px);overflow:auto;padding:4px;border-radius:12px;background:#11161d;border:1px solid rgba(255,255,255,.1);box-shadow:0 18px 50px -12px rgba(0,0,0,.75)}
.pop.right{left:auto;right:0}
.proj{padding:10px 10px 8px}.proj+.proj{border-top:1px solid rgba(255,255,255,.06)}
.ph{display:flex;align-items:baseline;gap:8px}.ph b{font-size:13.5px;color:#e6edf3}.pst{font-size:12px;color:#8b949e}
.acts{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 8px}
.acts a{font-size:12px;font-weight:600;color:#58a6ff;text-decoration:none;padding:4px 10px;border:1px solid rgba(88,166,255,.25);border-radius:7px}
.acts a:hover{background:rgba(88,166,255,.1)}
.row{display:flex;gap:10px;align-items:baseline;padding:3px 0;font-size:12.5px}
.row .k{width:118px;flex-shrink:0;color:#c9d1d9;display:flex;align-items:center;gap:7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row .k i{width:6px;height:6px;border-radius:50%;background:#484f58;flex-shrink:0}.row .k i.on{background:#3fb950}
.row .k.db{color:#d2a8ff}.row .k.db::before{content:'';width:6px;height:6px;border-radius:2px;background:#a371f7;flex-shrink:0}
.row .v{display:flex;flex-wrap:wrap;gap:4px 6px;min-width:0;align-items:baseline}
.row .note{color:#8b949e;font-size:12px}
.row code{cursor:pointer;color:#a8b3bf;background:rgba(255,255,255,.05);overflow-wrap:anywhere}
.row code:hover{color:#e6edf3;background:rgba(88,166,255,.12)}.row code.copied{color:#3fb950;background:rgba(63,185,80,.14)}
a.card[data-st="off"] .icon{filter:grayscale(1);opacity:.5}a.card[data-st="off"] .url{color:#6e7681}
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
.st-run{color:#3fb950}.st-warn{color:#d29922}.st-bad{color:#f85149}.st-sleep{color:#a371f7}.st-off{color:#6e7681}.st-setup{color:#58a6ff}
.card.setup{border-style:dashed}.card.setup .icon{opacity:.55}.card.setup .url{color:#6e7681}
.empty{text-align:center;padding:56px 24px;border:1px dashed rgba(255,255,255,.08);border-radius:16px;background:rgba(22,27,34,.4)}
.empty h2{font-size:15px;color:#c9d1d9;margin-bottom:6px}.empty p{font-size:13px;color:#8b949e;line-height:1.6}
code{font:12px "SF Mono",ui-monospace,Menlo,monospace;background:rgba(88,166,255,.1);color:#58a6ff;padding:1px 5px;border-radius:4px}
footer{text-align:center;margin-top:44px;font-size:12px;color:#484f58}footer a{color:#6e7681;text-decoration:none}
[hidden]{display:none!important}
.search{position:relative;display:flex;align-items:center;gap:10px;padding:0 12px 0 14px;height:42px;border-radius:12px;
  background:rgba(13,17,23,.75);border:1px solid rgba(255,255,255,.09);box-shadow:0 10px 40px -12px rgba(0,0,0,.6);transition:border-color .15s,box-shadow .15s}
.search:focus-within{border-color:rgba(88,166,255,.55);box-shadow:0 0 0 4px rgba(88,166,255,.12),0 10px 40px -12px rgba(0,0,0,.6)}
.search svg{width:18px;height:18px;flex-shrink:0;fill:none;stroke:#6e7681;stroke-width:2;stroke-linecap:round}
.search:focus-within svg{stroke:#58a6ff}
.search input{flex:1;min-width:0;height:100%;background:none;border:0;outline:0;color:#e6edf3;font:15px inherit}
.search input::placeholder{color:#6e7681}
.search input::-webkit-search-cancel-button{-webkit-appearance:none}
.search kbd,.hint kbd{font:11px "SF Mono",ui-monospace,Menlo,monospace;color:#8b949e;border:1px solid rgba(255,255,255,.12);border-bottom-width:2px;border-radius:5px;padding:1px 6px;background:rgba(255,255,255,.03)}
.search:focus-within kbd,.search.typed kbd{display:none}
.hint{font-size:12.5px;color:#8b949e;display:flex;gap:16px;padding-left:4px;margin-top:6px;height:20px;align-items:center;white-space:nowrap;overflow:hidden}
@media(max-width:760px){.top{flex-wrap:wrap;gap:12px}.find{order:3;flex-basis:100%}.tools{margin-left:auto}}
.hint span{display:inline-flex;align-items:center;gap:6px}.hint b{color:#e6edf3;font-weight:600}
.card.sel{border-color:rgba(88,166,255,.7);box-shadow:0 0 0 3px rgba(88,166,255,.16);transform:translateY(-2px)}
mark{background:rgba(88,166,255,.22);color:#fff;border-radius:3px;padding:0 1px}
.nores{text-align:center;padding:40px 24px;border:1px dashed rgba(255,255,255,.08);border-radius:16px;color:#8b949e;font-size:13.5px;line-height:1.6}
.notice{margin:0 0 20px;padding:10px 14px;border-radius:10px;border:1px solid rgba(210,153,34,.35);background:rgba(210,153,34,.08);color:#e3b341;font-size:13px}
.notice.bad{border-color:rgba(248,81,73,.4);background:rgba(248,81,73,.08);color:#ff7b72}
.nores b{color:#e6edf3}.nores button{background:none;border:0;color:#58a6ff;font:inherit;cursor:pointer;padding:0}
.tools{display:flex;gap:6px;flex-shrink:0;align-items:center;height:42px}
.seg{display:flex;padding:2px;border:1px solid rgba(255,255,255,.08);border-radius:9px;background:rgba(22,27,34,.6)}
.seg button{width:30px;height:28px;display:grid;place-items:center;background:none;border:0;border-radius:7px;color:#8b949e;cursor:pointer}
.seg button svg{width:15px;height:15px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round}
.seg button:hover{color:#e6edf3}.seg button.on{background:rgba(88,166,255,.15);color:#58a6ff}
.chip{height:34px;padding:0 12px;border:1px solid rgba(255,255,255,.08);border-radius:9px;background:rgba(22,27,34,.6);color:#8b949e;font:600 12px inherit;cursor:pointer;white-space:nowrap}
.chip:hover{color:#e6edf3}.chip.on{color:#3fb950;border-color:rgba(63,185,80,.35);background:rgba(63,185,80,.08)}
.group h2{cursor:pointer;user-select:none;display:flex;align-items:center;gap:6px;width:fit-content;max-width:100%;white-space:nowrap;overflow:hidden}
.group h2::before{content:'';width:0;height:0;border:4px solid transparent;border-top:5px solid currentColor;border-bottom:0;opacity:.7;transition:transform .15s}
.group.folded h2::before{transform:rotate(-90deg)}
.group.folded h2::after{content:attr(data-n);font-weight:600;color:#6e7681;letter-spacing:0}
.group.folded .grid{display:none}.group.folded{margin-bottom:14px}
body.compact .grid{grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:6px}
body.compact .card{position:relative;padding:8px 26px 8px 10px;gap:10px;border-radius:10px;align-items:center}
body.compact .icon{width:28px;height:28px;border-radius:8px;font-size:13px}
body.compact .desc,body.compact .target,body.compact .st span{display:none}
body.compact .st{position:absolute;top:50%;right:11px;margin:-4px 0 0}
body.compact .name{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
body.compact .url{margin-top:1px;font-size:11px}
body.compact .group{margin-bottom:18px}body.compact .gh{margin-bottom:8px}
@media(pointer:coarse){.hint,.search kbd{display:none}}
@media(max-width:640px){.shell{padding:36px 16px 28px}h1{font-size:24px}.grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="shell">
<header><div class="top"><div class="brand">{logo}<div><h1>{title}</h1><p class="sub">{subtitle}<span class="stats" id="stats">{stats}</span></p></div></div><div class="find">{search}</div><div class="tools"><div class="seg" role="group" aria-label="Layout"><button type="button" data-view="cards" title="Cards" aria-label="Cards"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg></button><button type="button" data-view="compact" title="Compact" aria-label="Compact"><svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16"/></svg></button></div><button type="button" class="chip" id="runonly" aria-pressed="false" title="Hide what isn't running, except while you search">Running only</button></div></div></header>
<main id="content">{notice}{tabs}{panels}</main>
<div class="nores" id="nores" hidden></div>
<footer>Served by <a href="https://orca-desktop.com">Orca Desktop</a></footer>
</div>
<script>
(function(){
  var KEY='orca-landing-env';
  // Per browser: the layout, "Running only" and folded groups.
  function load(k,d){try{var v=localStorage.getItem(k);return v===null?d:v}catch(e){return d}}
  function save(k,v){try{localStorage.setItem(k,v)}catch(e){}}
  var view=load('orca-landing-view','cards'),runOnly=load('orca-landing-running','0')==='1',folded={};
  try{folded=JSON.parse(load('orca-landing-folded','{}'))||{}}catch(e){}
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
  function isUp(c){return /^(none|run|warn|bad|sleep)$/.test(c.getAttribute('data-st')||'none')}
  function apply(){
    var ts=terms(),best=-1,bestScore=-1;
    matches=[];
    // Searching looks through everything: folded groups and what isn't running.
    panel().querySelectorAll('.card').forEach(function(c){
      var s=ts.length?score(c,ts):0;
      c.hidden=s<0||(runOnly&&!ts.length&&!isUp(c));c.classList.remove('sel');mark(c,ts);
      if(s>=0&&ts.length&&c.tagName==='A'){matches.push(c);if(s>bestScore){bestScore=s;best=matches.length-1}}
    });
    panel().querySelectorAll('.group').forEach(function(g){
      var n=g.querySelectorAll('.card:not([hidden])').length,h=g.querySelector('h2');
      g.hidden=!n;
      var fold=!ts.length&&!!folded[g.getAttribute('data-group')];
      g.classList.toggle('folded',fold);
      g.setAttribute('data-size',fold?'1':n>=4?'many':String(n||1));
      if(h)h.setAttribute('data-n',n);
    });
    sel=ts.length?best:-1;
    if(box)box.classList.toggle('typed',!!q.value);
    render();
  }
  function setView(v){
    view=v==='compact'?'compact':'cards';
    document.body.classList.toggle('compact',view==='compact');
    document.querySelectorAll('.seg button').forEach(function(b){b.classList.toggle('on',b.getAttribute('data-view')===view)});
  }
  function setRunOnly(on){
    runOnly=on;
    var b=document.getElementById('runonly');
    if(b){b.classList.toggle('on',on);b.setAttribute('aria-pressed',on?'true':'false')}
  }
  document.querySelectorAll('.seg button').forEach(function(b){
    b.addEventListener('click',function(){setView(b.getAttribute('data-view'));save('orca-landing-view',view)});
  });
  var ro=document.getElementById('runonly');
  if(ro)ro.addEventListener('click',function(){setRunOnly(!runOnly);save('orca-landing-running',runOnly?'1':'0');apply()});
  // Fold a group by clicking its name; the page's refresh keeps it folded.
  document.addEventListener('click',function(e){
    var h=e.target.closest&&e.target.closest('.group h2');
    if(!h)return;
    var name=h.parentNode.getAttribute('data-group');
    if(folded[name])delete folded[name];else folded[name]=1;
    save('orca-landing-folded',JSON.stringify(folded));apply();
  });
  // A group's details: one open at a time, kept open through the refresh.
  var openGroup=null;
  function closePops(){
    document.querySelectorAll('.pop').forEach(function(p){p.hidden=true});
    document.querySelectorAll('.more').forEach(function(b){b.setAttribute('aria-expanded','false')});
    openGroup=null;
  }
  function openPop(b){
    closePops();
    var p=b.nextElementSibling;if(!p)return;
    p.hidden=false;b.setAttribute('aria-expanded','true');
    openGroup=b.closest('.group').getAttribute('data-group');
    p.classList.remove('right');
    if(p.getBoundingClientRect().right>window.innerWidth-12)p.classList.add('right');
  }
  document.addEventListener('click',function(e){
    var t=e.target.closest?e.target:null;if(!t)return;
    var b=t.closest('.more');
    if(b){if(b.getAttribute('aria-expanded')==='true')closePops();else openPop(b);return}
    var c=t.closest('[data-copy]');
    if(c){
      var done=function(){c.classList.add('copied');setTimeout(function(){c.classList.remove('copied')},1200)};
      if(navigator.clipboard)navigator.clipboard.writeText(c.getAttribute('data-copy')).then(done,function(){});
      return;
    }
    if(!t.closest('.pop'))closePops();
  });
  function reopen(){
    if(!openGroup)return;
    var name=openGroup,b=null;
    panel().querySelectorAll('.group').forEach(function(g){if(g.getAttribute('data-group')===name)b=g.querySelector('.more')});
    if(b)openPop(b);else openGroup=null;
  }
  document.addEventListener('keydown',function(e){
    if(e.key==='Escape'&&openGroup){closePops();return}
    var h=(e.key==='Enter'||e.key===' ')&&e.target.closest&&e.target.closest('.group h2');
    if(h){e.preventDefault();h.click()}
  });
  setView(view);setRunOnly(runOnly);
  function render(){
    matches.forEach(function(c,i){c.classList.toggle('sel',i===sel)});
    if(sel>=0&&matches[sel]&&matches[sel].scrollIntoView)matches[sel].scrollIntoView({block:'nearest'});
    var v=q?q.value.trim():'';
    if(hint)hint.textContent='';
    if(!v){
      // "Running only", and nothing runs.
      nores.hidden=!runOnly||!!panel().querySelector('.card:not([hidden])');
      if(!nores.hidden){
        nores.textContent='Nothing is running. ';
        var all=el('button','Show everything');
        all.addEventListener('click',function(){setRunOnly(false);save('orca-landing-running','0');apply()});
        nores.appendChild(all);
      }
      return;
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
  bind=function(){bound();document.querySelectorAll('.tab').forEach(function(t){t.addEventListener('click',apply)});apply();reopen()};
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
            websocket: false,
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
            image: None,
            setup: None,
        }
    }

    #[test]
    fn cards_get_built_in_and_image_icons() {
        let mut named = route("grafana.localhost", "grafana-1", 3000);
        named.presentation.icon = Some("grafana".into());
        let config = GatewayConfig {
            routes: vec![named, route("db.localhost", "db-1", 5432)],
            ..Default::default()
        };
        let states = HashMap::from([(
            "db-1".to_string(),
            ServiceState {
                image: Some("postgres:17".into()),
                ..running("2026-01-01T00:00:00Z", None)
            },
        )]);
        let html = render(&config, &states);
        assert_eq!(html.matches(r#"<img src="data:image/svg+xml;base64,"#).count(), 2);
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
        assert!(html.contains(
            r#"data-group="shop" data-size="2"><div class="gh"><h2 role="button" tabindex="0" title="Fold or unfold">shop</h2>"#
        ));
        assert!(
            html.contains(r#">tools</h2>"#),
            "label-less routes group by compose project"
        );
        assert!(html.contains("Database admin") && html.contains("Browse every database"));
        assert!(html.contains(r#"data-since="2026-10-22T10:00:00Z""#));
        assert!(html.contains("st-sleep"));
        assert!(
            html.contains(">Web · feat<"),
            "worktree cards read service · instance: {html}"
        );
        assert!(
            html.contains(r#"<span class="stats" id="stats"><b>2</b> of 3 running</span>"#),
            "{html}"
        );
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
        c.landing.title = Some("Acme dev".into());
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
        assert!(html.contains("<title>Acme dev</title>"));
        assert!(html.contains(r#"data-env="staging""#) && html.contains(">Staging<"));
        assert!(html.contains("Web App") && html.contains("https://staging.example.com"));
        assert!(!html.contains("storefront-1 :3000"), "targets hidden");
        assert!(!html.contains(r#"class="st st-"#), "status hidden");
        // The linked route shows once, as the link.
        assert_eq!(html.matches("https://storefront.localhost").count(), 1);
    }

    #[test]
    fn a_groups_details_link_into_orca_and_list_addresses() {
        let c = config(vec![route("shop", "shop-web-1", 80)]);
        let states = HashMap::from([("shop-web-1".to_string(), running("2026-10-24T08:00:00Z", Some("shop")))]);
        let dir = PathBuf::from("/code/shop");
        let details = Details {
            projects: BTreeMap::from([(
                "shop".to_string(),
                vec![
                    Service {
                        service: "redis".into(),
                        container: "shop-redis-1".into(),
                        running: false,
                        ports: vec![(6379, Some(20379))],
                    },
                    Service {
                        service: "web".into(),
                        container: "shop-web-1".into(),
                        running: true,
                        ports: vec![(80, None)],
                    },
                ],
            )]),
            by_dir: HashMap::from([(dir.clone(), "shop".to_string())]),
            dirs: HashMap::new(),
            databases: HashMap::from([(
                dir,
                vec![("shop".to_string(), "percona (Acme)".to_string(), Some(23306))],
            )]),
        };
        let html = render_with(&c, &states, &details);
        assert!(html.contains(r#"<span class="pst">1 of 2 running</span>"#), "{html}");
        assert!(
            html.contains(r#"href="orca://app?do=start&amp;url=https%3A%2F%2Fshop.localhost">Start</a>"#),
            "{html}"
        );
        assert!(html.contains(r#">Stop</a>"#) && html.contains(">Open in Orca</a>"));
        assert!(html.contains(r#"<code data-copy="127.0.0.1:20379" title="Copy">"#));
        assert!(html.contains(r#"data-copy="shop-redis-1:6379""#));
        assert!(html.contains(r#"<span class="k db">shop</span><span class="v"><span class="note">on percona (Acme)</span><code data-copy="127.0.0.1:23306""#));
        // Folded away until asked for.
        assert!(html.contains(r#"<div class="pop" hidden>"#));
    }

    #[test]
    fn groups_fold_and_cards_say_their_state() {
        let mut c = config(vec![route("x.localhost", "x", 80)]);
        c.landing.links = vec![orca_core::config::LandingLink {
            title: "<Board>".into(),
            url: "https://jira.example.com".into(),
            description: None,
        }];
        let states = HashMap::from([("x".to_string(), running("2026-10-24T08:00:00Z", Some("a&b")))]);
        let html = render(&c, &states);
        // Group names are escaped where they're attributes too.
        assert!(
            html.contains(
                r#"<section class="group" data-group="a&amp;b" data-size="1"><div class="gh"><h2 role="button""#
            ),
            "{html}"
        );
        assert!(html.contains(r#"data-st="run""#), "a running service");
        assert!(html.contains(r#"data-st="none""#), "a link with no service");
        assert!(html.contains(r#"id="runonly""#) && html.contains(r#"data-view="compact""#));
    }

    #[test]
    fn a_workspaces_shared_services_come_first_as_a_strip() {
        let mut shared = route("mail.local.acme.dev", "mailpit", 8025);
        shared.owner = Some("workspace:Acme".into());
        shared.presentation.group = Some("Shared services".into());
        let mut crm = route("crm.local.acme.dev", "crm-app", 80);
        crm.owner = Some("workspace:Acme:crm".into());
        crm.presentation.group = Some("Billing".into());
        let html = render(&config(vec![crm, shared]), &HashMap::new());
        let strip = html
            .find(r#"<section class="group shared" data-group="Shared services""#)
            .expect("a shared strip");
        assert!(
            strip < html.find(r#"data-group="Billing""#).unwrap(),
            "before the projects, though B < S"
        );
        assert!(
            html.contains(r#"<section class="group" data-group="Billing""#),
            "projects stay cards"
        );
    }

    #[test]
    fn a_certificate_about_to_expire_is_announced() {
        let pem = |days: i64| {
            let mut p = rcgen::CertificateParams::new(vec!["*.local.acme.dev".to_string()]).unwrap();
            p.not_after = time::OffsetDateTime::now_utc() + time::Duration::days(days) + time::Duration::hours(1);
            p.self_signed(&rcgen::KeyPair::generate().unwrap()).unwrap().pem()
        };
        let mut c = config(vec![route("x.local.acme.dev", "x", 80)]);
        c.domain = "local.acme.dev".into();
        c.tls_mode = GatewayTlsMode::Custom;
        c.custom_cert = Some(pem(200));
        assert!(!render(&c, &HashMap::new()).contains(r#"class="notice"#), "not yet");
        c.custom_cert = Some(pem(12));
        assert!(render(&c, &HashMap::new()).contains("The certificate for *.local.acme.dev expires in 12 days"));
        c.custom_cert = Some(pem(-3));
        let html = render(&c, &HashMap::new());
        assert!(html.contains(r#"<div class="notice bad">"#) && html.contains("expired on"));
    }

    #[test]
    fn icons_become_files_the_browser_caches() {
        let svg = "data:image/svg+xml;base64,PHN2Zy8+";
        let html = format!(
            r#"<img src="{svg}"><img src="{svg}"><img src="https://x.dev/a.png"><img src="data:image/gif;base64,R0lG">"#
        );
        let (page, files) = externalize_icons(&html);
        assert_eq!(files.len(), 1, "the same icon twice is one file");
        assert_eq!(files[0].1, b"<svg/>");
        let url = format!(r#"src="{ICON_PATH}{}""#, files[0].0);
        assert_eq!(page.matches(&url).count(), 2, "{page}");
        assert!(
            page.contains(r#"src="https://x.dev/a.png""#) && page.contains("data:image/gif"),
            "others stay"
        );
    }

    #[test]
    fn my_links_come_first() {
        let mut c = config(vec![route("x.localhost", "x", 80)]);
        c.landing.links = vec![orca_core::config::LandingLink {
            title: "Jira board".into(),
            url: "https://jira.example.com/board/7".into(),
            description: None,
        }];
        let html = render(&c, &HashMap::new());
        let mine = html.find(">My links</h2>").expect("a My links section");
        assert!(mine < html.find("x.localhost").unwrap(), "before the services");
        assert!(html.contains(r#"href="https://jira.example.com/board/7" target="_blank""#));
        assert!(html.contains("jira.example.com/board/7</p>"));

        // Links alone are enough for a page.
        c.routes.clear();
        assert!(render(&c, &HashMap::new()).contains("Jira board"));
    }

    #[test]
    fn a_project_not_set_up_offers_orca() {
        let c = config(vec![route("crm.localhost", "crm-app", 80)]);
        let states = HashMap::from([(
            "crm-app".to_string(),
            ServiceState {
                status: Status::NotSetUp,
                started_at: None,
                project: None,
                image: None,
                setup: Some("crm".into()),
            },
        )]);
        let html = render(&c, &states);
        assert!(
            html.contains(r#"<a class="card setup" href="orca://workspace?setup=crm""#),
            "{html}"
        );
        assert!(html.contains("Not set up · set it up in Orca"));
        assert!(html.contains("crm.localhost"), "the address it will have");
    }

    #[test]
    fn a_workspace_logo_sits_beside_the_title() {
        let mut c = config(vec![route("x.localhost", "x", 80)]);
        assert!(!render(&c, &HashMap::new()).contains(r#"class="logo""#));
        c.landing.logo = Some("data:image/svg+xml;base64,PHN2Zy8+".into());
        let html = render(&c, &HashMap::new());
        assert!(html.contains(
            r#"<div class="brand"><img class="logo" src="data:image/svg+xml;base64,PHN2Zy8+" alt=""><div><h1>"#
        ));
        c.landing.logo = Some(r#"https://acme.dev/logo.svg"><script>"#.into());
        assert!(render(&c, &HashMap::new()).contains(r#"src="https://acme.dev/logo.svg&quot;&gt;&lt;script&gt;""#));
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
        assert_eq!(local.matches("<section class=\"group\"").count(), 1, "{local}");
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
        assert!(page.contains(r#"placeholder="Find a service, or search Google""#));
        assert!(
            page.contains(r#"data-engine="Google" data-url="https://www.google.com/search?q={query}""#),
            "Google unless another engine is chosen"
        );
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

        c.landing.web_search = Some("none".into());
        let page = render(&c, &states);
        assert!(page.contains(r#"data-url="""#) && page.contains(r#"placeholder="Find a service""#));

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
            r(
                "billing.localhost",
                "billing-api-1",
                8000,
                "project:billing",
                Some("Billing"),
                Some("Invoices and payments"),
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
            image: Some("quay.io/keycloak/keycloak:26.0".into()),
            setup: None,
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
            (
                "billing-api-1".to_string(),
                ServiceState {
                    status: Status::Stopped,
                    started_at: None,
                    project: Some("billing".into()),
                    image: None,
                    setup: None,
                },
            ),
        ]);
        // Icons: the shop's own logo from its repo, the rest from images.
        let mut states = states;
        for (name, image) in [
            ("shop-mailpit-1", "axllent/mailpit:v1.24"),
            ("website-wordpress-1", "wordpress:6"),
            ("telemetry-grafana-1", "grafana/grafana:12.1"),
        ] {
            states.get_mut(name).unwrap().image = Some(image.into());
        }
        let shop = "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23e8590c'/%3E%3Cpath fill='none' stroke='%23fff' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round' d='M8 11h16l-1.5 11h-13z M12 11a4 4 0 0 1 8 0'/%3E%3C/svg%3E";
        for r in c.routes.iter_mut().filter(|r| {
            (r.owner.as_deref() == Some("project:shop")
                || r.owner.as_deref().is_some_and(|o| o.starts_with("dev:shop")))
                && r.container_name != "shop-mailpit-1"
        }) {
            r.presentation.icon = Some(shop.into());
        }
        let svc = |service: &str, container: &str, running: bool, ports: Vec<(u16, Option<u16>)>| Service {
            service: service.into(),
            container: container.into(),
            running,
            ports,
        };
        let shop_dir = PathBuf::from("/code/shop");
        let details = Details {
            projects: BTreeMap::from([
                (
                    "shop".to_string(),
                    vec![
                        svc("admin", "shop-admin-1", true, vec![(8080, None)]),
                        svc("mailpit", "shop-mailpit-1", true, vec![(8025, None)]),
                        svc("redis", "shop-redis-1", true, vec![(6379, Some(16379))]),
                        svc("web", "shop-web-1", true, vec![(3000, None)]),
                        svc("worker", "shop-worker-1", false, vec![]),
                    ],
                ),
                (
                    "billing".to_string(),
                    vec![
                        svc("api", "billing-api-1", false, vec![]),
                        svc("queue", "billing-queue-1", false, vec![]),
                    ],
                ),
            ]),
            by_dir: HashMap::from([(shop_dir.clone(), "shop".to_string())]),
            dirs: HashMap::new(),
            databases: HashMap::from([(
                shop_dir,
                vec![("shop".to_string(), "MySQL 8.4".to_string(), Some(13306))],
            )]),
        };
        std::fs::write(out, render_with(&c, &states, &details)).unwrap();
    }
}
