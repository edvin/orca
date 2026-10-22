//! Planning an instance (or the shared stack) and generating its compose override.
//!
//! Planning produces a list of [`Edit`]s against the user's compose model.
//! The edits render two ways:
//! - as a commented override file using `!reset` / `!override` (Compose
//!   2.24.4+), which is what users see in `.orca/compose.override.yaml`;
//! - applied to the full `docker compose config` JSON, for older Compose
//!   versions that lack those tags ("resolved mode").
//!
//! Either way the user's own compose files are never modified.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::compose_model::{ComposeModel, NON_HTTP_PORTS};
use super::schema::{DevConfig, render_template};
use super::state::PortAssignment;
use super::yaml_out::{self, Node};
use super::{LABEL_INSTANCE, LABEL_PROJECT, LABEL_ROLE, LABEL_WORKTREE};

/// One change to one service (or a top-level volume/network).
#[derive(Debug, Clone, PartialEq)]
pub struct Edit {
    pub target: EditTarget,
    pub field: String,
    pub op: EditOp,
    /// Why the change is made; becomes a comment in the override file.
    pub why: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum EditTarget {
    Service(String),
    Volume(String),
    Network(String),
}

#[derive(Debug, Clone, PartialEq)]
pub enum EditOp {
    /// Plain value; compose replaces scalars and merges maps/lists with the base.
    Set(Value),
    /// `!reset`: remove whatever the base file had.
    Reset(Value),
    /// `!override`: replace the base value entirely.
    Override(Value),
}

/// Inputs for planning one instance.
pub struct InstanceInput<'a> {
    pub project: &'a str,
    pub instance: &'a str,
    pub worktree: &'a Path,
    /// `docker compose -p <project>-<instance> config` of the worktree.
    pub model: &'a ComposeModel,
    /// The worktree's own `dev:` config (per-instance settings).
    pub dev: &'a DevConfig,
    /// Shared service names, from the primary checkout's config.
    pub shared: &'a BTreeSet<String>,
    /// `database:` of each shared service, for `{db.<service>}`.
    pub shared_databases: &'a BTreeMap<String, String>,
    /// Shared services this instance uses in own-database mode.
    pub own_databases: &'a BTreeMap<String, OwnDatabase>,
    /// Shared services this instance runs privately (own-server mode). The
    /// caller has already removed them from `shared`.
    pub own_servers: &'a BTreeSet<String>,
    /// `localhost:<port>` of shared services published on the host.
    pub shared_endpoints: &'a BTreeMap<String, String>,
    /// Compose profiles to run, besides the services without one.
    pub profiles: &'a [String],
    pub hostname_overrides: &'a BTreeMap<String, String>,
    pub domain: &'a str,
    pub https_port: u16,
    /// Host ports already assigned (see [`required_host_ports`]).
    pub ports: &'a [PortAssignment],
}

/// An instance's own database inside a shared server.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OwnDatabase {
    pub kind: super::tenancy::TenancyKind,
    /// The database everyone else uses (`myapp`, or `0` for Redis).
    pub shared_db: String,
    /// This instance's database (`myapp_feat`, or a Redis index).
    pub tenant: String,
}

/// One environment variable as a service will see it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EnvVar {
    pub key: String,
    pub value: String,
    /// "compose" (from your files) or "orca" (added or changed by Orca).
    pub source: String,
    /// Why Orca set it, when it did.
    pub why: Option<String>,
}

/// A gateway route the instance needs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlannedRoute {
    pub service: String,
    pub hostname: String,
    pub port: u16,
    pub path: Option<String>,
    pub url: String,
    /// Container the gateway dials (`<compose project>-<service>-1`).
    pub container_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstancePlan {
    pub compose_project: String,
    /// Services passed to `compose up`: those without a profile and those in
    /// the chosen profiles. Their per-instance dependencies start too, even
    /// behind another profile.
    pub services: Vec<String>,
    /// Everything that will run in this instance, dependencies included.
    pub running_services: Vec<String>,
    /// Per-instance services that won't run: behind a profile not picked.
    pub left_out: Vec<String>,
    /// The compose file's profiles, with the per-instance services in each.
    pub profiles: Vec<ProfileInfo>,
    pub routes: Vec<PlannedRoute>,
    pub host_ports: Vec<PortAssignment>,
    /// Resolved names of the networks the instance's services use; shared
    /// containers are attached to each.
    pub networks: Vec<String>,
    pub warnings: Vec<String>,
    #[serde(skip)]
    pub edits: Vec<Edit>,
    pub override_yaml: String,
    pub env_file: String,
    /// Environment per running service, with Orca's changes marked.
    pub service_env: BTreeMap<String, Vec<EnvVar>>,
    pub own_databases: BTreeMap<String, OwnDatabase>,
    pub own_servers: Vec<String>,
}

/// A compose profile and the services behind it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProfileInfo {
    pub name: String,
    pub services: Vec<String>,
}

/// Which services the instance runs: every per-instance service without a
/// compose profile, plus those in `profiles`. Returns (requested, running).
pub fn select_services(
    model: &ComposeModel,
    shared: &BTreeSet<String>,
    profiles: &[String],
) -> (Vec<String>, Vec<String>) {
    let requested: Vec<String> = model
        .services
        .iter()
        .filter(|(n, s)| {
            !shared.contains(*n) && (s.profiles.is_empty() || s.profiles.iter().any(|p| profiles.contains(p)))
        })
        .map(|(n, _)| n.clone())
        .collect();

    // Close over per-instance dependencies: compose starts them too.
    let mut running: BTreeSet<String> = requested.iter().cloned().collect();
    let mut queue: Vec<String> = requested.clone();
    while let Some(s) = queue.pop() {
        if let Some(svc) = model.services.get(&s) {
            for dep in svc.depends_on.keys() {
                if !shared.contains(dep) && running.insert(dep.clone()) {
                    queue.push(dep.clone());
                }
            }
        }
    }
    (requested, running.into_iter().collect())
}

/// The profiles the compose file defines, in order of first appearance.
pub fn model_profiles(model: &ComposeModel) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for s in model.services.values() {
        for p in &s.profiles {
            if !out.contains(p) {
                out.push(p.clone());
            }
        }
    }
    out
}

/// How a per-instance service port is reached when `orca.yaml` doesn't say.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Reach {
    Gateway(u16),
    HostPort(u16),
}

/// Decide, per service, which ports go through the gateway and which get a
/// host port. Explicit `expose` / `host_ports` entries win; otherwise the
/// base file's published ports are sorted by whether they look like HTTP.
fn reach_for(model: &ComposeModel, dev: &DevConfig, service: &str) -> Vec<Reach> {
    let explicit_expose = dev.instance.expose.get(service);
    let explicit_ports = dev.instance.host_ports.get(service);
    if explicit_expose.is_some() || explicit_ports.is_some() {
        let mut out = Vec::new();
        if let Some(e) = explicit_expose {
            out.push(Reach::Gateway(e.port()));
        }
        for p in explicit_ports.into_iter().flatten() {
            out.push(Reach::HostPort(*p));
        }
        return out;
    }
    let Some(svc) = model.services.get(service) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut has_gateway = false;
    for port in svc.ports.iter().filter(|p| p.published.is_some()) {
        if port.protocol.as_deref().is_some_and(|p| p != "tcp") {
            continue;
        }
        if !has_gateway && !NON_HTTP_PORTS.contains(&port.target) {
            out.push(Reach::Gateway(port.target));
            has_gateway = true;
        } else {
            out.push(Reach::HostPort(port.target));
        }
    }
    out
}

/// The `(service, container port)` pairs that need a host port, so the
/// caller can assign them before planning.
pub fn required_host_ports(
    model: &ComposeModel,
    dev: &DevConfig,
    shared: &BTreeSet<String>,
    profiles: &[String],
) -> anyhow::Result<Vec<(String, u16)>> {
    let (_, running) = select_services(model, shared, profiles);
    let mut out = Vec::new();
    for s in &running {
        for r in reach_for(model, dev, s) {
            if let Reach::HostPort(p) = r {
                out.push((s.clone(), p));
            }
        }
    }
    Ok(out)
}

fn url_for(hostname: &str, https_port: u16) -> String {
    if https_port == 443 {
        format!("https://{hostname}")
    } else {
        format!("https://{hostname}:{https_port}")
    }
}

/// Lowercase DNS name check for rendered hostnames.
pub fn validate_hostname(h: &str) -> anyhow::Result<()> {
    super::hostnames::validate(h)
}

pub fn plan_instance(input: &InstanceInput<'_>) -> anyhow::Result<InstancePlan> {
    let model = input.model;
    let dev = input.dev;
    let shared = input.shared;
    let cp = super::instance_compose_project(input.project, input.instance);
    let mut warnings = Vec::new();

    for s in shared {
        if !model.services.contains_key(s) {
            warnings.push(format!("Shared service '{s}' is not in this worktree's compose file."));
        }
    }

    let (services, running) = select_services(model, shared, input.profiles);
    let known = model_profiles(model);
    for p in input.profiles.iter().filter(|p| !known.contains(p)) {
        warnings.push(format!("Profile '{p}' is not in the compose file any more."));
    }

    // Cross-stack references can't work: compose would pull the shared
    // service into this instance's project.
    for name in &running {
        let svc = &model.services[name];
        if let Some(target) = svc.network_mode_service()
            && shared.contains(target)
        {
            anyhow::bail!(
                "'{name}' uses network_mode: service:{target}, but '{target}' is shared. \
                 Services that share a network namespace must run in the same stack: make '{target}' per-instance."
            );
        }
        for target in svc.volumes_from_services() {
            if shared.contains(target) {
                anyhow::bail!(
                    "'{name}' uses volumes_from: {target}, but '{target}' is shared. Make '{target}' per-instance."
                );
            }
        }
        for target in svc.link_services() {
            if shared.contains(target) {
                warnings.push(format!(
                    "'{name}' has a legacy link to shared service '{target}'; it is removed and '{target}' is reached by name instead."
                ));
            }
        }
    }

    // --- Routes and host ports -------------------------------------------
    let mut base_vars = BTreeMap::new();
    base_vars.insert("project".to_string(), input.project.to_string());
    base_vars.insert("instance".to_string(), input.instance.to_string());
    base_vars.insert("domain".to_string(), input.domain.to_string());
    base_vars.insert("worktree".to_string(), input.worktree.to_string_lossy().to_string());

    let hostname_of = |service: &str| -> anyhow::Result<String> {
        if let Some(h) = input.hostname_overrides.get(service) {
            validate_hostname(h)?;
            return Ok(h.clone());
        }
        super::hostnames::render(
            &dev.naming.hostname,
            input.project,
            input.instance,
            service,
            input.domain,
            input.worktree,
        )
        .map_err(|e| anyhow::anyhow!("{e}; check naming.hostname in orca.yaml ('{}')", dev.naming.hostname))
    };

    let mut routes = Vec::new();
    let mut host_ports = Vec::new();
    for name in &running {
        for reach in reach_for(model, dev, name) {
            match reach {
                Reach::Gateway(port) => {
                    let expose = dev.instance.expose.get(name);
                    let host_service = expose.and_then(|e| e.host()).unwrap_or(name);
                    let hostname = hostname_of(host_service)?;
                    let path = expose.and_then(|e| e.path()).map(|p| {
                        let p = if p.starts_with('/') {
                            p.to_string()
                        } else {
                            format!("/{p}")
                        };
                        if p.ends_with('*') { p } else { format!("{p}*") }
                    });
                    routes.push(PlannedRoute {
                        service: name.clone(),
                        url: url_for(&hostname, input.https_port),
                        hostname,
                        port,
                        path,
                        container_name: format!("{cp}-{name}-1"),
                    });
                }
                Reach::HostPort(port) => {
                    let a = input
                        .ports
                        .iter()
                        .find(|a| a.service == *name && a.container_port == port)
                        .ok_or_else(|| anyhow::anyhow!("no host port assigned for {name}:{port}"))?;
                    host_ports.push(a.clone());
                }
            }
        }
    }
    for svc in input.hostname_overrides.keys() {
        if !routes.iter().any(|r| r.service == *svc) {
            warnings.push(format!(
                "Hostname override for '{svc}' is unused: it has no browser-reachable port."
            ));
        }
    }

    // --- Template variables for env ---------------------------------------
    let mut vars = base_vars.clone();
    // URLs are known for every per-instance service, not just the ones this
    // profiles start, so env templates don't break when fewer run.
    for name in model.services.keys().filter(|n| !shared.contains(*n)) {
        if reach_for(model, dev, name)
            .iter()
            .any(|r| matches!(r, Reach::Gateway(_)))
        {
            let expose = dev.instance.expose.get(name);
            let host_service = expose.and_then(|e| e.host()).unwrap_or(name);
            let path = expose
                .and_then(|e| e.path())
                .map(|p| format!("/{}", p.trim_matches(['/', '*'])))
                .unwrap_or_default();
            let url = url_for(&hostname_of(host_service)?, input.https_port);
            vars.insert(format!("url.{name}"), format!("{url}{path}"));
        }
    }
    for a in &host_ports {
        vars.insert(
            format!("port.{}.{}", a.service, a.container_port),
            a.host_port.to_string(),
        );
    }
    for (svc, db) in input.shared_databases {
        vars.insert(format!("db.{svc}"), db.clone());
    }
    for (svc, own) in input.own_databases {
        vars.insert(format!("db.{svc}"), own.tenant.clone());
    }

    // --- Edits --------------------------------------------------------------
    let mut edits = Vec::new();
    let all_hostnames: BTreeSet<&str> = routes.iter().map(|r| r.hostname.as_str()).collect();

    for name in &running {
        let svc = &model.services[name];
        let t = || EditTarget::Service(name.clone());

        if svc.is_built() {
            edits.push(Edit {
                target: t(),
                field: "image".into(),
                op: EditOp::Set(json!(format!("{cp}-{name}"))),
                why: Some("own image tag, so instances never overwrite each other's build".into()),
            });
        }
        if svc.container_name.is_some() {
            edits.push(Edit {
                target: t(),
                field: "container_name".into(),
                op: EditOp::Reset(Value::Null),
                why: Some("a fixed name would clash between instances".into()),
            });
        }

        let mine: Vec<&PortAssignment> = host_ports.iter().filter(|a| a.service == *name).collect();
        let port_strings: Vec<Value> = mine
            .iter()
            .map(|a| json!(format!("127.0.0.1:{}:{}", a.host_port, a.container_port)))
            .collect();
        let has_routes = routes.iter().any(|r| r.service == *name);
        if !svc.ports.is_empty() {
            if port_strings.is_empty() {
                edits.push(Edit {
                    target: t(),
                    field: "ports".into(),
                    op: EditOp::Reset(json!([])),
                    why: Some(if has_routes {
                        "reached through the gateway instead".into()
                    } else {
                        "fixed host ports would clash between instances".into()
                    }),
                });
            } else {
                edits.push(Edit {
                    target: t(),
                    field: "ports".into(),
                    op: EditOp::Override(Value::Array(port_strings)),
                    why: Some("host ports assigned to this instance".into()),
                });
            }
        } else if !port_strings.is_empty() {
            edits.push(Edit {
                target: t(),
                field: "ports".into(),
                op: EditOp::Set(Value::Array(port_strings)),
                why: Some("host ports assigned to this instance".into()),
            });
        }

        let shared_deps: Vec<&String> = svc.depends_on.keys().filter(|d| shared.contains(*d)).collect();
        if !shared_deps.is_empty() {
            let kept: serde_json::Map<String, Value> = svc
                .depends_on
                .iter()
                .filter(|(d, _)| !shared.contains(*d))
                .map(|(d, spec)| {
                    let mut m = serde_json::Map::new();
                    m.insert(
                        "condition".into(),
                        json!(spec.condition.clone().unwrap_or_else(|| "service_started".into())),
                    );
                    if let Some(r) = spec.required {
                        m.insert("required".into(), json!(r));
                    }
                    (d.clone(), Value::Object(m))
                })
                .collect();
            let names = shared_deps.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ");
            let why = format!("{names} shared; Orca waits for it before starting this instance");
            edits.push(Edit {
                target: t(),
                field: "depends_on".into(),
                op: if kept.is_empty() {
                    EditOp::Reset(Value::Null)
                } else {
                    EditOp::Override(Value::Object(kept))
                },
                why: Some(why),
            });
        }
        if svc.link_services().iter().any(|l| shared.contains(*l)) {
            edits.push(Edit {
                target: t(),
                field: "links".into(),
                op: EditOp::Reset(json!([])),
                why: Some("links to shared services can't cross stacks".into()),
            });
        }

        // Own-database mode: point connection strings at this instance's
        // database. Explicit dev.instance.env entries win over rewrites.
        let mut env_map = serde_json::Map::new();
        let mut env_why: Vec<String> = Vec::new();
        for (shared_svc, own) in input.own_databases {
            let changes =
                super::tenancy::rewrite_env(&svc.environment, shared_svc, own.kind, &own.shared_db, &own.tenant);
            if !changes.is_empty() {
                env_why.push(format!(
                    "own {shared_svc} database for this instance (was {})",
                    own.shared_db
                ));
            }
            for (k, _old, new) in changes {
                env_map.insert(k, json!(new));
            }
        }
        if let Some(env) = dev.instance.env.get(name) {
            let before = env_map.len();
            for (k, v) in env {
                let rendered =
                    render_template(v, &vars).map_err(|e| anyhow::anyhow!("dev.instance.env.{name}.{k}: {e}"))?;
                env_map.insert(k.clone(), json!(rendered));
            }
            if env_map.len() > before || !env.is_empty() {
                env_why.push("dev.instance.env in orca.yaml".into());
            }
        }
        if !env_map.is_empty() {
            edits.push(Edit {
                target: t(),
                field: "environment".into(),
                op: EditOp::Set(Value::Object(env_map)),
                why: Some(env_why.join("; ")),
            });
        }

        if !all_hostnames.is_empty() {
            edits.push(Edit {
                target: t(),
                field: "extra_hosts".into(),
                op: EditOp::Set(Value::Array(
                    all_hostnames
                        .iter()
                        .map(|h| json!(format!("{h}:host-gateway")))
                        .collect(),
                )),
                why: Some("*.localhost would otherwise point at the container itself".into()),
            });
        }

        let mut labels = serde_json::Map::new();
        labels.insert(LABEL_PROJECT.into(), json!(input.project));
        labels.insert(LABEL_INSTANCE.into(), json!(input.instance));
        labels.insert(LABEL_ROLE.into(), json!("instance"));
        labels.insert(LABEL_WORKTREE.into(), json!(input.worktree.to_string_lossy()));
        edits.push(Edit {
            target: t(),
            field: "labels".into(),
            op: EditOp::Set(Value::Object(labels)),
            why: Some("lets Orca find this instance's containers".into()),
        });

        if let Some(limits) = &dev.instance.limits {
            let mut l = serde_json::Map::new();
            if let Some(m) = &limits.memory {
                l.insert("memory".into(), json!(m));
            }
            if let Some(c) = limits.cpus_string() {
                l.insert("cpus".into(), json!(c));
            }
            if !l.is_empty() {
                edits.push(Edit {
                    target: t(),
                    field: "deploy".into(),
                    op: EditOp::Set(json!({"resources": {"limits": l}})),
                    why: Some("dev.instance.limits in orca.yaml".into()),
                });
            }
        }
    }

    // Volumes and networks with fixed names would be shared by accident.
    for (key, vol) in &model.volumes {
        if vol.external == Some(true) {
            warnings.push(format!(
                "Volume '{key}' is external, so every instance uses the same one."
            ));
            continue;
        }
        if let Some(n) = &vol.name
            && !n.starts_with(&format!("{cp}_"))
        {
            edits.push(Edit {
                target: EditTarget::Volume(key.clone()),
                field: "name".into(),
                op: EditOp::Set(json!(format!("{cp}_{key}"))),
                why: Some(format!("was '{n}', which every instance would share")),
            });
        }
    }
    let mut networks = Vec::new();
    let used_networks: BTreeSet<&String> = running
        .iter()
        .filter(|n| model.services[*n].network_mode.is_none())
        .flat_map(|n| model.services[n].networks.keys())
        .collect();
    for (key, net) in &model.networks {
        if net.external == Some(true) {
            warnings.push(format!(
                "Network '{key}' is external, so every instance joins the same one."
            ));
            continue;
        }
        let resolved = match &net.name {
            Some(n) if !n.starts_with(&format!("{cp}_")) => {
                edits.push(Edit {
                    target: EditTarget::Network(key.clone()),
                    field: "name".into(),
                    op: EditOp::Set(json!(format!("{cp}_{key}"))),
                    why: Some(format!("was '{n}', which every instance would share")),
                });
                format!("{cp}_{key}")
            }
            Some(n) => n.clone(),
            None => format!("{cp}_{key}"),
        };
        if used_networks.contains(key) {
            networks.push(resolved);
        }
    }

    let header = [
        "Generated by Orca for instance '{instance}' of '{project}'. Do not edit: changes are overwritten.",
        "Change orca.yaml or the instance settings in Orca instead.",
    ];
    let header: Vec<String> = header
        .iter()
        .map(|h| {
            h.replace("{instance}", input.instance)
                .replace("{project}", input.project)
        })
        .collect();
    let header_refs: Vec<&str> = header.iter().map(String::as_str).collect();
    let override_yaml = render_override(&edits, &header_refs);

    let env_file = render_env_file(input, &cp, &routes, &host_ports);
    let service_env = service_env(model, &running, &edits);

    let left_out = model
        .services
        .keys()
        .filter(|n| !shared.contains(*n) && !running.contains(*n))
        .cloned()
        .collect();
    let profiles = model_profiles(model)
        .into_iter()
        .map(|name| ProfileInfo {
            services: model
                .services
                .iter()
                .filter(|(n, s)| !shared.contains(*n) && s.profiles.contains(&name))
                .map(|(n, _)| n.clone())
                .collect(),
            name,
        })
        .collect();

    Ok(InstancePlan {
        compose_project: cp,
        services,
        running_services: running,
        left_out,
        profiles,
        routes,
        host_ports,
        networks,
        warnings,
        edits,
        override_yaml,
        env_file,
        service_env,
        own_databases: input.own_databases.clone(),
        own_servers: input.own_servers.iter().cloned().collect(),
    })
}

/// Env var name part: `api-gateway` → `API_GATEWAY`.
fn env_key(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_uppercase()
            } else {
                '_'
            }
        })
        .collect()
}

fn render_env_file(input: &InstanceInput<'_>, cp: &str, routes: &[PlannedRoute], ports: &[PortAssignment]) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "# Generated by Orca for instance '{}' of '{}'. Do not edit.\n",
        input.instance, input.project
    ));
    out.push_str("# Load with `eval $(orca env)` or your tool's dotenv support.\n");
    out.push_str(&format!("ORCA_PROJECT={}\n", input.project));
    out.push_str(&format!("ORCA_INSTANCE={}\n", input.instance));
    out.push_str(&format!("ORCA_COMPOSE_PROJECT={cp}\n"));
    let mut seen = BTreeSet::new();
    for r in routes {
        if seen.insert(&r.service) {
            let url = match &r.path {
                Some(p) => format!("{}{}", r.url, p.trim_end_matches('*').trim_end_matches('/')),
                None => r.url.clone(),
            };
            out.push_str(&format!("ORCA_URL_{}={url}\n", env_key(&r.service)));
        }
    }
    for a in ports {
        out.push_str(&format!(
            "ORCA_PORT_{}_{}={}\n",
            env_key(&a.service),
            a.container_port,
            a.host_port
        ));
    }
    // Databases this instance uses, and where shared services listen on the
    // host, so tests running outside containers can connect.
    let mut dbs: BTreeMap<&String, &String> = input.shared_databases.iter().collect();
    for (svc, own) in input.own_databases {
        dbs.insert(svc, &own.tenant);
    }
    for (svc, db) in dbs {
        if !input.own_servers.contains(svc) {
            out.push_str(&format!("ORCA_DB_{}={db}\n", env_key(svc)));
        }
    }
    for (svc, endpoint) in input.shared_endpoints {
        if !input.own_servers.contains(svc) {
            out.push_str(&format!("ORCA_SHARED_{}={endpoint}\n", env_key(svc)));
        }
    }
    out
}

/// Each running service's environment as it will be: the compose file's
/// values with Orca's edits applied and marked.
fn service_env(model: &ComposeModel, running: &[String], edits: &[Edit]) -> BTreeMap<String, Vec<EnvVar>> {
    let mut out = BTreeMap::new();
    for name in running {
        let Some(svc) = model.services.get(name) else { continue };
        let mut vars: BTreeMap<String, EnvVar> = svc
            .environment
            .iter()
            .map(|(k, v)| {
                (
                    k.clone(),
                    EnvVar {
                        key: k.clone(),
                        value: v.clone().unwrap_or_default(),
                        source: "compose".into(),
                        why: None,
                    },
                )
            })
            .collect();
        for e in edits {
            if e.target != EditTarget::Service(name.clone()) || e.field != "environment" {
                continue;
            }
            if let EditOp::Set(Value::Object(m)) = &e.op {
                for (k, v) in m {
                    vars.insert(
                        k.clone(),
                        EnvVar {
                            key: k.clone(),
                            value: v.as_str().unwrap_or_default().to_string(),
                            source: "orca".into(),
                            why: e.why.clone(),
                        },
                    );
                }
            }
        }
        out.insert(name.clone(), vars.into_values().collect());
    }
    out
}

/// Render edits as a commented override file.
pub fn render_override(edits: &[Edit], header: &[&str]) -> String {
    let mut root = Node::map();
    for e in edits {
        let (section, name) = match &e.target {
            EditTarget::Service(s) => ("services", s),
            EditTarget::Volume(v) => ("volumes", v),
            EditTarget::Network(n) => ("networks", n),
        };
        let node = match &e.op {
            EditOp::Set(v) => Node::from_json(v),
            EditOp::Reset(v) => Node::tagged("!reset", Node::from_json(v)),
            EditOp::Override(v) => Node::tagged("!override", Node::from_json(v)),
        };
        root.child(section)
            .child(name)
            .push(e.field.clone(), node, e.why.as_deref());
    }
    if root.is_empty_map() {
        root.push("services", Node::map(), Some("nothing to change for this instance"));
    }
    yaml_out::render(&root, header)
}

/// Apply edits to the full `docker compose config` JSON (resolved mode),
/// dropping services that don't belong in this stack.
pub fn apply_resolved(config: &mut Value, edits: &[Edit], keep_services: &[String]) {
    if let Some(services) = config.get_mut("services").and_then(Value::as_object_mut) {
        services.retain(|name, _| keep_services.contains(name));
    }
    for e in edits {
        let (section, name) = match &e.target {
            EditTarget::Service(s) => ("services", s),
            EditTarget::Volume(v) => ("volumes", v),
            EditTarget::Network(n) => ("networks", n),
        };
        let Some(obj) = config
            .get_mut(section)
            .and_then(|s| s.get_mut(name))
            .and_then(Value::as_object_mut)
        else {
            continue;
        };
        match &e.op {
            EditOp::Reset(_) => {
                obj.remove(&e.field);
            }
            EditOp::Override(v) => {
                obj.insert(e.field.clone(), v.clone());
            }
            EditOp::Set(v) => match (obj.get_mut(&e.field), v) {
                (Some(Value::Object(existing)), Value::Object(new)) => {
                    for (k, val) in new {
                        existing.insert(k.clone(), val.clone());
                    }
                }
                (Some(Value::Array(existing)), Value::Array(new)) => existing.extend(new.iter().cloned()),
                _ => {
                    obj.insert(e.field.clone(), v.clone());
                }
            },
        }
    }
}

/// Plan for the project's shared stack.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SharedPlan {
    pub compose_project: String,
    pub services: Vec<String>,
    pub warnings: Vec<String>,
    #[serde(skip)]
    pub edits: Vec<Edit>,
    pub override_yaml: String,
}

/// Plan the shared stack: only the shared services, labelled, with any
/// dependency on a per-instance service removed.
pub fn plan_shared(
    project: &str,
    compose_project: &str,
    model: &ComposeModel,
    dev: &DevConfig,
    shared: &BTreeSet<String>,
) -> anyhow::Result<SharedPlan> {
    let cp = compose_project.to_string();
    let mut warnings = Vec::new();
    let mut edits = Vec::new();
    let mut services = Vec::new();
    for name in shared {
        let Some(svc) = model.services.get(name) else {
            warnings.push(format!("Shared service '{name}' is not in the compose file."));
            continue;
        };
        services.push(name.clone());
        let t = || EditTarget::Service(name.clone());
        let instance_deps: Vec<&String> = svc.depends_on.keys().filter(|d| !shared.contains(*d)).collect();
        if !instance_deps.is_empty() {
            let kept: serde_json::Map<String, Value> = svc
                .depends_on
                .iter()
                .filter(|(d, _)| shared.contains(*d))
                .map(|(d, spec)| {
                    (
                        d.clone(),
                        json!({"condition": spec.condition.clone().unwrap_or_else(|| "service_started".into())}),
                    )
                })
                .collect();
            let names = instance_deps.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ");
            warnings.push(format!(
                "Shared service '{name}' depends on {names}, which run per instance; that dependency is dropped."
            ));
            edits.push(Edit {
                target: t(),
                field: "depends_on".into(),
                op: if kept.is_empty() {
                    EditOp::Reset(Value::Null)
                } else {
                    EditOp::Override(Value::Object(kept))
                },
                why: Some(format!("{names} run per instance, not in the shared stack")),
            });
        }
        if let Some(host_port) = dev.shared.get(name).and_then(|s| s.host_port) {
            match svc.ports.first() {
                Some(p) => edits.push(Edit {
                    target: t(),
                    field: "ports".into(),
                    op: EditOp::Override(json!([format!("{host_port}:{}", p.target)])),
                    why: Some("host_port from orca.yaml".into()),
                }),
                None => warnings.push(format!(
                    "Shared service '{name}' has host_port {host_port} but no container port to publish."
                )),
            }
        }
        let mut labels = serde_json::Map::new();
        labels.insert(LABEL_PROJECT.into(), json!(project));
        labels.insert(LABEL_ROLE.into(), json!("shared"));
        edits.push(Edit {
            target: t(),
            field: "labels".into(),
            op: EditOp::Set(Value::Object(labels)),
            why: None,
        });
    }
    let header = format!("Generated by Orca for the shared services of '{project}'. Do not edit.");
    let override_yaml = render_override(&edits, &[header.as_str()]);
    Ok(SharedPlan {
        compose_project: cp,
        services,
        warnings,
        edits,
        override_yaml,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dev::compose_model::tests::SAMPLE;
    use crate::dev::schema::OrcaYaml;

    static NO_OWN_DBS: BTreeMap<String, OwnDatabase> = BTreeMap::new();
    static NO_OWN_SERVERS: BTreeSet<String> = BTreeSet::new();
    static NO_ENDPOINTS: BTreeMap<String, String> = BTreeMap::new();

    fn shared() -> BTreeSet<String> {
        ["postgres".to_string(), "redis".to_string()].into_iter().collect()
    }

    fn input<'a>(
        model: &'a ComposeModel,
        dev: &'a DevConfig,
        shared: &'a BTreeSet<String>,
        dbs: &'a BTreeMap<String, String>,
        overrides: &'a BTreeMap<String, String>,
        ports: &'a [PortAssignment],
    ) -> InstanceInput<'a> {
        InstanceInput {
            project: "myapp",
            instance: "feat",
            worktree: Path::new("/code/myapp-feat"),
            model,
            dev,
            shared,
            shared_databases: dbs,
            own_databases: &NO_OWN_DBS,
            own_servers: &NO_OWN_SERVERS,
            shared_endpoints: &NO_ENDPOINTS,
            profiles: &[],
            hostname_overrides: overrides,
            domain: "localhost",
            https_port: 443,
            ports,
        }
    }

    fn assign(model: &ComposeModel, dev: &DevConfig, shared: &BTreeSet<String>) -> Vec<PortAssignment> {
        required_host_ports(model, dev, shared, &[])
            .unwrap()
            .into_iter()
            .enumerate()
            .map(|(i, (service, container_port))| PortAssignment {
                service,
                container_port,
                host_port: 41000 + i as u16,
            })
            .collect()
    }

    #[test]
    fn default_plan_isolates_everything() {
        let model = ComposeModel::parse(SAMPLE).unwrap();
        let dev = DevConfig::default();
        let shared = shared();
        let ports = assign(&model, &dev, &shared);
        let (dbs, ov) = (BTreeMap::new(), BTreeMap::new());
        let plan = plan_instance(&input(&model, &dev, &shared, &dbs, &ov, &ports)).unwrap();

        assert_eq!(plan.compose_project, "myapp-feat");
        assert_eq!(plan.services, vec!["api", "web", "worker"]);
        // api: 8080 is HTTP → gateway, 9229 is a debugger → host port.
        let api_route = plan.routes.iter().find(|r| r.service == "api").unwrap();
        assert_eq!(api_route.hostname, "api-feat-myapp.localhost");
        assert_eq!(api_route.port, 8080);
        assert_eq!(api_route.container_name, "myapp-feat-api-1");
        let web_route = plan.routes.iter().find(|r| r.service == "web").unwrap();
        assert_eq!(web_route.url, "https://web-feat-myapp.localhost");
        assert_eq!(web_route.port, 80);
        assert_eq!(
            plan.host_ports,
            vec![PortAssignment {
                service: "api".into(),
                container_port: 9229,
                host_port: 41000
            }]
        );
        assert_eq!(plan.networks, vec!["myapp-feat_default"]);

        let y = &plan.override_yaml;
        assert!(y.contains("image: \"myapp-feat-api\""), "{y}");
        assert!(y.contains("container_name: !reset null"), "{y}");
        assert!(y.contains("ports: !override"), "{y}");
        assert!(y.contains("\"127.0.0.1:41000:9229\""), "{y}");
        assert!(y.contains("depends_on: !override"), "{y}");
        assert!(y.contains("postgres shared"), "{y}");
        // worker only depended on redis (shared) → reset.
        assert!(y.contains("worker:\n    depends_on: !reset null"), "{y}");
        assert!(
            y.contains("ports: !reset []  # reached through the gateway instead"),
            "{y}"
        );
        assert!(y.contains("\"web-feat-myapp.localhost:host-gateway\""), "{y}");
        // Shared services are never touched in the instance override.
        assert!(!y.contains("  postgres:"), "{y}");

        // The override is valid YAML that a parser accepts (tags included).
        let _: serde_yaml::Value = serde_yaml::from_str(y).unwrap();

        assert!(
            plan.env_file
                .contains("ORCA_URL_WEB=https://web-feat-myapp.localhost\n")
        );
        assert!(plan.env_file.contains("ORCA_PORT_API_9229=41000\n"));
    }

    #[test]
    fn explicit_config_profiles_env_and_overrides() {
        let model = ComposeModel::parse(SAMPLE).unwrap();
        let y = OrcaYaml::parse(
            r#"
dev:
  naming:
    hostname: "{instance}-{service}.{project}.{domain}"
  instance:
    env:
      api:
        DATABASE_URL: "postgres://app:app@postgres:5432/{db.postgres}"
        PUBLIC_URL: "{url.web}"
        DEBUG_PORT: "{port.api.9229}"
    expose:
      web: 80
      api: { port: 8080, host: web, path: /api }
    host_ports:
      api: [9229]
    limits: { memory: 1g, cpus: 1.5 }
"#,
        )
        .unwrap();
        let dev = y.dev.unwrap();
        let shared = shared();
        let ports = assign(&model, &dev, &shared);
        let mut dbs = BTreeMap::new();
        dbs.insert("postgres".to_string(), "myapp".to_string());
        let mut ov = BTreeMap::new();
        ov.insert("web".to_string(), "auth.localhost".to_string());
        let plan = plan_instance(&input(&model, &dev, &shared, &dbs, &ov, &ports)).unwrap();

        // No profiles in the file → everything; api's route lives on web's host.
        let api = plan.routes.iter().find(|r| r.service == "api").unwrap();
        assert_eq!(api.hostname, "auth.localhost");
        assert_eq!(api.path.as_deref(), Some("/api*"));
        let y = &plan.override_yaml;
        assert!(
            y.contains("DATABASE_URL: \"postgres://app:app@postgres:5432/myapp\""),
            "{y}"
        );
        assert!(y.contains("PUBLIC_URL: \"https://auth.localhost\""), "{y}");
        assert!(y.contains("DEBUG_PORT: \"41000\""), "{y}");
        assert!(y.contains("memory: \"1g\""), "{y}");
        assert!(y.contains("cpus: \"1.5\""), "{y}");
        assert!(
            plan.env_file.contains("ORCA_URL_API=https://auth.localhost/api\n"),
            "{}",
            plan.env_file
        );

        // web behind a profile: left out until the profile is picked.
        let mut profiled = model.clone();
        profiled.services.get_mut("web").unwrap().profiles = vec!["ui".into()];
        let ports = assign(&profiled, &dev, &shared);
        let plan = plan_instance(&input(&profiled, &dev, &shared, &dbs, &ov, &ports)).unwrap();
        assert_eq!(plan.services, vec!["api", "worker"]);
        assert!(!plan.routes.iter().any(|r| r.service == "web"));
        assert!(
            plan.warnings
                .iter()
                .any(|w| w.contains("Hostname override for 'web' is unused"))
        );
        let ui = vec!["ui".to_string(), "gone".to_string()];
        let mut i = input(&profiled, &dev, &shared, &dbs, &ov, &ports);
        i.profiles = &ui;
        let plan = plan_instance(&i).unwrap();
        assert_eq!(plan.services, vec!["api", "web", "worker"]);
        assert!(plan.warnings.iter().any(|w| w.contains("Profile 'gone'")));
        assert_eq!(model_profiles(&profiled), vec!["ui"]);
        assert!(plan.left_out.is_empty());
        assert_eq!(
            plan.profiles,
            vec![ProfileInfo {
                name: "ui".into(),
                services: vec!["web".into()]
            }]
        );
    }

    #[test]
    fn template_errors_are_clear() {
        let model = ComposeModel::parse(SAMPLE).unwrap();
        let shared = shared();
        let y = OrcaYaml::parse("dev:\n  instance:\n    env:\n      api:\n        X: \"{db.mysql}\"\n").unwrap();
        let dev = y.dev.unwrap();
        let ports = assign(&model, &dev, &shared);
        let (dbs, ov) = (BTreeMap::new(), BTreeMap::new());
        let err = plan_instance(&input(&model, &dev, &shared, &dbs, &ov, &ports))
            .unwrap_err()
            .to_string();
        assert!(err.contains("dev.instance.env.api.X"), "{err}");
        assert!(err.contains("{db.mysql}"), "{err}");
    }

    #[test]
    fn network_mode_on_shared_service_is_refused() {
        let mut model = ComposeModel::parse(SAMPLE).unwrap();
        model.services.get_mut("web").unwrap().network_mode = Some("service:postgres".into());
        let dev = DevConfig::default();
        let shared = shared();
        let ports = assign(&model, &dev, &shared);
        let (dbs, ov) = (BTreeMap::new(), BTreeMap::new());
        let err = plan_instance(&input(&model, &dev, &shared, &dbs, &ov, &ports))
            .unwrap_err()
            .to_string();
        assert!(err.contains("network_mode: service:postgres"), "{err}");
    }

    #[test]
    fn fixed_volume_names_are_namespaced() {
        let mut model = ComposeModel::parse(SAMPLE).unwrap();
        model.volumes.insert(
            "cache".into(),
            crate::dev::compose_model::Volume {
                name: Some("fixed-cache".into()),
                external: None,
            },
        );
        let dev = DevConfig::default();
        let shared = shared();
        let ports = assign(&model, &dev, &shared);
        let (dbs, ov) = (BTreeMap::new(), BTreeMap::new());
        let plan = plan_instance(&input(&model, &dev, &shared, &dbs, &ov, &ports)).unwrap();
        assert!(
            plan.override_yaml
                .contains("volumes:\n  cache:\n    name: \"myapp-feat_cache\"")
        );
    }

    #[test]
    fn resolved_mode_applies_edits() {
        let model = ComposeModel::parse(SAMPLE).unwrap();
        let dev = DevConfig::default();
        let shared = shared();
        let ports = assign(&model, &dev, &shared);
        let (dbs, ov) = (BTreeMap::new(), BTreeMap::new());
        let plan = plan_instance(&input(&model, &dev, &shared, &dbs, &ov, &ports)).unwrap();
        let mut raw: Value = serde_json::from_str(SAMPLE).unwrap();
        apply_resolved(&mut raw, &plan.edits, &plan.running_services);
        let services = raw["services"].as_object().unwrap();
        assert!(!services.contains_key("postgres"));
        let api = &services["api"];
        assert!(api.get("container_name").is_none());
        assert_eq!(api["image"], "myapp-feat-api");
        assert_eq!(api["ports"], json!(["127.0.0.1:41000:9229"]));
        assert!(api["depends_on"].get("postgres").is_none());
        assert!(api["depends_on"].get("worker").is_some());
        assert_eq!(
            api["environment"]["DATABASE_URL"],
            "postgres://app:app@postgres:5432/myapp"
        );
        assert!(services["worker"].get("depends_on").is_none());
    }

    #[test]
    fn shared_plan_labels_and_host_port() {
        let model = ComposeModel::parse(SAMPLE).unwrap();
        let y = OrcaYaml::parse("dev:\n  shared:\n    postgres:\n      host_port: 15432\n    redis:\n").unwrap();
        let dev = y.dev.unwrap();
        let plan = plan_shared("myapp", "myapp-shared", &model, &dev, &dev.shared_names()).unwrap();
        assert_eq!(plan.compose_project, "myapp-shared");
        assert_eq!(plan.services, vec!["postgres", "redis"]);
        assert!(plan.override_yaml.contains("\"15432:5432\""), "{}", plan.override_yaml);
        assert!(plan.override_yaml.contains("orca.dev.role: \"shared\""));
    }

    #[test]
    fn own_database_rewrites_connection_strings() {
        let model = ComposeModel::parse(SAMPLE).unwrap();
        let dev = DevConfig::default();
        let shared = shared();
        let ports = assign(&model, &dev, &shared);
        let (dbs, ov) = (BTreeMap::new(), BTreeMap::new());
        let mut own = BTreeMap::new();
        own.insert(
            "postgres".to_string(),
            OwnDatabase {
                kind: crate::dev::tenancy::TenancyKind::Postgres,
                shared_db: "myapp".into(),
                tenant: "myapp_feat".into(),
            },
        );
        let mut i = input(&model, &dev, &shared, &dbs, &ov, &ports);
        i.own_databases = &own;
        let plan = plan_instance(&i).unwrap();
        let y = &plan.override_yaml;
        assert!(
            y.contains("DATABASE_URL: \"postgres://app:app@postgres:5432/myapp_feat\""),
            "{y}"
        );
        assert!(y.contains("own postgres database for this instance (was myapp)"), "{y}");
        assert!(
            plan.env_file.contains("ORCA_DB_POSTGRES=myapp_feat\n"),
            "{}",
            plan.env_file
        );
        let api_env = &plan.service_env["api"];
        let db = api_env.iter().find(|v| v.key == "DATABASE_URL").unwrap();
        assert_eq!(db.source, "orca");
    }

    #[test]
    fn own_server_runs_privately_with_a_host_port() {
        let model = ComposeModel::parse(SAMPLE).unwrap();
        let dev = DevConfig::default();
        // The caller removes own-server services from the shared set.
        let shared: BTreeSet<String> = ["redis".to_string()].into_iter().collect();
        let own_servers: BTreeSet<String> = ["postgres".to_string()].into_iter().collect();
        let ports = assign(&model, &dev, &shared);
        let (dbs, ov) = (BTreeMap::new(), BTreeMap::new());
        let mut i = input(&model, &dev, &shared, &dbs, &ov, &ports);
        i.own_servers = &own_servers;
        let plan = plan_instance(&i).unwrap();
        assert!(plan.running_services.contains(&"postgres".to_string()));
        assert!(
            plan.host_ports
                .iter()
                .any(|a| a.service == "postgres" && a.container_port == 5432)
        );
        // api now depends on its own postgres, so the dependency is kept.
        assert!(
            !plan.override_yaml.contains("postgres shared"),
            "{}",
            plan.override_yaml
        );
        assert_eq!(plan.own_servers, vec!["postgres"]);
    }
}
