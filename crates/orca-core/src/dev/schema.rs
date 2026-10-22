//! `orca.yaml`: a project's Orca configuration, next to its compose file.
//!
//! `gateway:`, `links:`, `builds:` and `hooks:` apply to the project as a
//! compose stack, wherever it was started from; `dev:` configures worktree
//! instances. Every field is optional, and an entry that doesn't parse is
//! skipped rather than failing the whole file.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Deserializer, Serialize};

/// Default hostname pattern for exposed services (flat, so one wildcard
/// certificate covers every instance; see [`super::hostnames`]).
pub const DEFAULT_HOSTNAME_TEMPLATE: &str = super::hostnames::FLAT;

/// `orca.yaml`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct OrcaYaml {
    /// Project name; defaults to the main checkout's folder name.
    pub project: Option<String>,
    /// Compose file(s); defaults to compose's own discovery.
    pub compose: Option<ComposeFiles>,
    pub dev: Option<DevConfig>,
    /// Gateway routes to the project's services:
    /// `- {hostname: app, service: web, port: 3000, path: /api/*}`.
    /// A hostname without a dot gets the gateway's domain.
    #[serde(deserialize_with = "lenient_list", skip_serializing_if = "Vec::is_empty")]
    pub gateway: Vec<crate::templates::GatewayRouteTemplate>,
    /// Environment links by group:
    /// `Storefront: [{name: Web App, local: app, staging: https://…}]`.
    #[serde(
        deserialize_with = "lenient_links",
        serialize_with = "serialize_links",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub links: Vec<LinkGroup>,
    /// Build targets: `- {name, context, dockerfile, tag, args}`.
    #[serde(deserialize_with = "lenient_list", skip_serializing_if = "Vec::is_empty")]
    pub builds: Vec<BuildSpec>,
    /// Commands run after the stack comes up.
    #[serde(skip_serializing_if = "ProjectHooks::is_empty")]
    pub hooks: ProjectHooks,
}

/// A group of environment links (`links:` in `orca.yaml`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LinkGroup {
    pub group: String,
    pub links: Vec<Link>,
}

/// One link: a name and a URL per environment. `local` names a gateway
/// hostname; the others are full URLs.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Link {
    pub name: String,
    pub urls: BTreeMap<String, String>,
}

/// A build target in `orca.yaml`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct BuildSpec {
    pub name: String,
    pub context: String,
    #[serde(default = "default_dockerfile")]
    pub dockerfile: String,
    pub tag: String,
    /// Build args; numbers and booleans are taken as text.
    #[serde(default, deserialize_with = "scalar_map")]
    pub args: BTreeMap<String, String>,
}

fn default_dockerfile() -> String {
    "Dockerfile".into()
}

/// `hooks:` at the top of `orca.yaml`, for the stack itself.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct ProjectHooks {
    /// `"service: command"` entries run after every `up` started from Orca.
    pub after_up: Vec<String>,
}

impl ProjectHooks {
    fn is_empty(&self) -> bool {
        self.after_up.is_empty()
    }
}

/// A list whose entries that don't parse are left out.
fn lenient_list<'de, D, T>(d: D) -> Result<Vec<T>, D::Error>
where
    D: Deserializer<'de>,
    T: serde::de::DeserializeOwned,
{
    let value = serde_yaml::Value::deserialize(d)?;
    Ok(value
        .as_sequence()
        .map(|items| {
            items
                .iter()
                .filter_map(|i| serde_yaml::from_value(i.clone()).ok())
                .collect()
        })
        .unwrap_or_default())
}

/// `links:` keeps the file's group order; links without a name or any URL
/// are left out, and so are groups left empty.
fn lenient_links<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<LinkGroup>, D::Error> {
    let value = serde_yaml::Value::deserialize(d)?;
    let Some(groups) = value.as_mapping() else {
        return Ok(Vec::new());
    };
    Ok(groups
        .iter()
        .filter_map(|(group, items)| {
            let links: Vec<Link> = items
                .as_sequence()?
                .iter()
                .filter_map(|item| {
                    let map = item.as_mapping()?;
                    let name = item.get("name")?.as_str()?.to_string();
                    let urls: BTreeMap<String, String> = map
                        .iter()
                        .filter_map(|(k, v)| Some((k.as_str()?.to_string(), v.as_str()?.to_string())))
                        .filter(|(k, _)| k != "name")
                        .collect();
                    (!name.is_empty() && !urls.is_empty()).then_some(Link { name, urls })
                })
                .collect();
            let group = group.as_str()?.to_string();
            (!links.is_empty()).then_some(LinkGroup { group, links })
        })
        .collect())
}

fn serialize_links<S: serde::Serializer>(groups: &[LinkGroup], s: S) -> Result<S::Ok, S::Error> {
    use serde::ser::SerializeMap;
    let mut map = s.serialize_map(Some(groups.len()))?;
    for g in groups {
        let links: Vec<BTreeMap<&str, &str>> = g
            .links
            .iter()
            .map(|l| {
                let mut m: BTreeMap<&str, &str> = l.urls.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
                m.insert("name", &l.name);
                m
            })
            .collect();
        map.serialize_entry(&g.group, &links)?;
    }
    map.end()
}

/// A map whose scalar values (text, numbers, booleans) are kept as text.
fn scalar_map<'de, D: Deserializer<'de>>(d: D) -> Result<BTreeMap<String, String>, D::Error> {
    let value = serde_yaml::Value::deserialize(d)?;
    Ok(value
        .as_mapping()
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| {
                    let v = match v {
                        serde_yaml::Value::String(s) => s.clone(),
                        serde_yaml::Value::Number(n) => n.to_string(),
                        serde_yaml::Value::Bool(b) => b.to_string(),
                        _ => return None,
                    };
                    Some((k.as_str()?.to_string(), v))
                })
                .collect()
        })
        .unwrap_or_default())
}

/// `compose: a.yaml` or `compose: [a.yaml, b.yaml]`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum ComposeFiles {
    One(String),
    Many(Vec<String>),
}

impl ComposeFiles {
    pub fn to_vec(&self) -> Vec<String> {
        match self {
            ComposeFiles::One(f) => vec![f.clone()],
            ComposeFiles::Many(v) => v.clone(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct DevConfig {
    pub naming: Naming,
    pub start: StartPolicy,
    /// Compose project name of the shared stack; default `<project>-shared`.
    /// Set to an existing project's name to keep using its data volumes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shared_project: Option<String>,
    /// Services that run once per project. `mailpit:` and `mailpit: {}` both work.
    #[serde(deserialize_with = "de_nullable_map")]
    pub shared: BTreeMap<String, SharedService>,
    pub instance: InstanceConfig,
}

impl DevConfig {
    pub fn shared_names(&self) -> BTreeSet<String> {
        self.shared.keys().cloned().collect()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Naming {
    pub instance: InstanceNameSource,
    pub hostname: String,
}

impl Default for Naming {
    fn default() -> Self {
        Self {
            instance: InstanceNameSource::default(),
            hostname: DEFAULT_HOSTNAME_TEMPLATE.to_string(),
        }
    }
}

/// Where instance names come from.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InstanceNameSource {
    #[default]
    Branch,
    Folder,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum StartPolicy {
    #[default]
    Manual,
    OnCreate,
}

/// How much data an instance shares with the others, per shared service.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum DataMode {
    /// Use the same database as everyone else.
    #[default]
    Shared,
    /// A separate database inside the shared server.
    OwnDatabase,
    /// A private copy of the service inside the instance stack.
    OwnServer,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct SharedService {
    /// Default data mode for new instances.
    pub data: DataMode,
    /// Database shared-data instances use (for `{db.<service>}`).
    pub database: Option<String>,
    /// Settings for the own-database mode.
    pub own_database: Option<OwnDatabaseConfig>,
    /// Port on the host for reaching the shared service.
    pub host_port: Option<u16>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct OwnDatabaseConfig {
    /// Database name template; default `{database}_{instance}`.
    pub name: Option<String>,
    /// How a new instance database starts out.
    pub seed: Seed,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Seed {
    /// A copy of the shared database at the moment it's created.
    #[default]
    CloneMain,
    /// Empty; migrations or seed hooks fill it.
    Empty,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct InstanceConfig {
    /// Extra environment per service; values are templates.
    pub env: BTreeMap<String, BTreeMap<String, String>>,
    /// HTTP services reached through the gateway.
    pub expose: BTreeMap<String, Expose>,
    /// Container ports published on the host, assigned per instance.
    pub host_ports: BTreeMap<String, Vec<u16>>,
    pub hooks: Hooks,
    /// Stop an instance after this long without use (`30m`, `2h`). Off when unset.
    pub idle_stop: Option<String>,
    /// Most instances of this project that may run at once (default 6).
    pub max_running: Option<u32>,
    pub limits: Option<Limits>,
}

/// Default cap on running instances per project.
pub const DEFAULT_MAX_RUNNING: u32 = 6;

impl InstanceConfig {
    pub fn idle_stop_duration(&self) -> anyhow::Result<Option<std::time::Duration>> {
        match self.idle_stop.as_deref().map(str::trim) {
            None | Some("") | Some("off") | Some("never") => Ok(None),
            Some(s) => parse_duration(s)
                .map(Some)
                .ok_or_else(|| anyhow::anyhow!("idle_stop '{s}' is not a duration like 30m, 2h or 1h30m")),
        }
    }
}

/// `90s`, `30m`, `2h`, `1h30m` → Duration.
pub fn parse_duration(s: &str) -> Option<std::time::Duration> {
    let mut total = 0u64;
    let mut num = String::new();
    let mut any = false;
    for c in s.trim().chars() {
        if c.is_ascii_digit() {
            num.push(c);
            continue;
        }
        let n: u64 = num.parse().ok()?;
        num.clear();
        total += n * match c {
            's' => 1,
            'm' => 60,
            'h' => 3600,
            'd' => 86400,
            _ => return None,
        };
        any = true;
    }
    if !num.is_empty() || !any {
        return None;
    }
    Some(std::time::Duration::from_secs(total))
}

/// `web: 3000` or `web: { port: 3000, host: web, path: /api }`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum Expose {
    Port(u16),
    Full {
        port: u16,
        /// Serve under another service's hostname (same origin).
        #[serde(default)]
        host: Option<String>,
        #[serde(default)]
        path: Option<String>,
    },
}

impl Expose {
    pub fn port(&self) -> u16 {
        match self {
            Expose::Port(p) | Expose::Full { port: p, .. } => *p,
        }
    }
    pub fn host(&self) -> Option<&str> {
        match self {
            Expose::Port(_) => None,
            Expose::Full { host, .. } => host.as_deref(),
        }
    }
    pub fn path(&self) -> Option<&str> {
        match self {
            Expose::Port(_) => None,
            Expose::Full { path, .. } => path.as_deref(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Hooks {
    /// `"service: command"` entries run after every start.
    pub after_up: Vec<String>,
    /// Run when an instance gets its own database (own-database mode).
    pub after_own_database: Vec<String>,
}

/// Parse a `"service: command"` hook entry.
pub fn parse_hook(entry: &str) -> anyhow::Result<(String, String)> {
    let (svc, cmd) = entry
        .split_once(':')
        .ok_or_else(|| anyhow::anyhow!("hook '{entry}' must look like 'service: command'"))?;
    let (svc, cmd) = (svc.trim(), cmd.trim());
    if svc.is_empty() || cmd.is_empty() {
        anyhow::bail!("hook '{entry}' must look like 'service: command'");
    }
    Ok((svc.to_string(), cmd.to_string()))
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Limits {
    pub memory: Option<String>,
    pub cpus: Option<serde_yaml::Value>,
}

impl Limits {
    pub fn cpus_string(&self) -> Option<String> {
        match self.cpus.as_ref()? {
            serde_yaml::Value::Number(n) => Some(n.to_string()),
            serde_yaml::Value::String(s) => Some(s.clone()),
            _ => None,
        }
    }
}

fn de_nullable_map<'de, D>(d: D) -> Result<BTreeMap<String, SharedService>, D::Error>
where
    D: Deserializer<'de>,
{
    let raw: Option<BTreeMap<String, Option<SharedService>>> = Option::deserialize(d)?;
    Ok(raw
        .unwrap_or_default()
        .into_iter()
        .map(|(k, v)| (k, v.unwrap_or_default()))
        .collect())
}

impl OrcaYaml {
    pub fn parse(text: &str) -> anyhow::Result<Self> {
        if text.trim().is_empty() {
            return Ok(Self::default());
        }
        serde_yaml::from_str(text).map_err(|e| anyhow::anyhow!("orca.yaml is not valid: {e}"))
    }

    /// Read `orca.yaml` from a directory, merging `orca.local.yaml` on top.
    /// A missing file is not an error.
    pub fn load(dir: &std::path::Path) -> anyhow::Result<Self> {
        let base = read_yaml_value(&dir.join("orca.yaml"))?;
        let local = read_yaml_value(&dir.join("orca.local.yaml"))?;
        let merged = match (base, local) {
            (Some(mut b), Some(l)) => {
                merge_yaml(&mut b, l);
                b
            }
            (Some(b), None) => b,
            (None, Some(l)) => l,
            (None, None) => return Ok(Self::default()),
        };
        serde_yaml::from_value(merged).map_err(|e| anyhow::anyhow!("orca.yaml is not valid: {e}"))
    }
}

/// Entries in `gateway:`, `builds:`, `links:` and `hooks:` that would be
/// skipped, one message each, for the editor: reading the file leaves them
/// out instead of failing.
pub fn project_warnings(text: &str) -> Vec<String> {
    let Ok(value) = serde_yaml::from_str::<serde_yaml::Value>(text) else {
        return Vec::new();
    };
    let mut warnings = Vec::new();
    let items = |key: &str| {
        value
            .get(key)
            .and_then(|v| v.as_sequence())
            .cloned()
            .unwrap_or_default()
    };
    for (i, item) in items("gateway").into_iter().enumerate() {
        if let Err(e) = serde_yaml::from_value::<crate::templates::GatewayRouteTemplate>(item) {
            warnings.push(format!(
                "gateway entry {} is skipped: {e} (needs hostname, service and port)",
                i + 1
            ));
        }
    }
    for (i, item) in items("builds").into_iter().enumerate() {
        if let Err(e) = serde_yaml::from_value::<BuildSpec>(item) {
            warnings.push(format!(
                "builds entry {} is skipped: {e} (needs name, context and tag)",
                i + 1
            ));
        }
    }
    if let Some(groups) = value.get("links").and_then(|v| v.as_mapping()) {
        for (group, links) in groups {
            let group = group.as_str().unwrap_or("?");
            for (i, link) in links.as_sequence().into_iter().flatten().enumerate() {
                let named = link.get("name").and_then(|n| n.as_str()).is_some_and(|n| !n.is_empty());
                let urls = link.as_mapping().is_some_and(|m| {
                    m.iter()
                        .any(|(k, v)| k.as_str() != Some("name") && v.as_str().is_some())
                });
                if !named || !urls {
                    warnings.push(format!(
                        "links.{group} entry {} is skipped: it needs a name and at least one URL",
                        i + 1
                    ));
                }
            }
        }
    }
    let instance = value.get("dev").and_then(|d| d.get("instance"));
    if instance.is_some_and(|i| i.get("presets").is_some() || i.get("default_preset").is_some()) {
        warnings.push(
            "dev.instance.presets is no longer used: put optional services behind compose profiles \
             (profiles: [search]) and pick the profiles when starting an instance"
                .into(),
        );
    }
    let hooks = value
        .get("hooks")
        .and_then(|h| h.get("after_up"))
        .and_then(|v| v.as_sequence())
        .cloned()
        .unwrap_or_default();
    for hook in hooks {
        match hook.as_str() {
            Some(h) => {
                if let Err(e) = parse_hook(h) {
                    warnings.push(format!("hooks.after_up: {e}"));
                }
            }
            None => warnings.push("hooks.after_up entries must be text like \"service: command\"".to_string()),
        }
    }
    warnings
}

fn read_yaml_value(path: &std::path::Path) -> anyhow::Result<Option<serde_yaml::Value>> {
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(path)?;
    if text.trim().is_empty() {
        return Ok(None);
    }
    let v: serde_yaml::Value =
        serde_yaml::from_str(&text).map_err(|e| anyhow::anyhow!("{} is not valid YAML: {e}", path.display()))?;
    Ok(Some(v))
}

/// Deep-merge maps; anything else in `over` replaces `base`.
fn merge_yaml(base: &mut serde_yaml::Value, over: serde_yaml::Value) {
    match (base, over) {
        (serde_yaml::Value::Mapping(b), serde_yaml::Value::Mapping(o)) => {
            for (k, v) in o {
                match b.get_mut(&k) {
                    Some(existing) => merge_yaml(existing, v),
                    None => {
                        b.insert(k, v);
                    }
                }
            }
        }
        (b, o) => *b = o,
    }
}

/// `dev:` as YAML with every default left out, so the file Orca writes
/// only says what differs from the defaults.
pub fn minimal_dev_value(dev: &DevConfig) -> serde_yaml::Value {
    use serde_yaml::Value;
    let mut v = serde_yaml::to_value(dev).unwrap_or(Value::Null);
    let defaults = serde_yaml::to_value(DevConfig::default()).unwrap_or(Value::Null);
    prune(&mut v, &defaults);
    // Each shared service is compared with a default service, and stays
    // listed even when nothing about it differs (`redis: {}`).
    let svc_default = serde_yaml::to_value(SharedService::default()).unwrap_or(Value::Null);
    if !dev.shared.is_empty()
        && let Value::Mapping(root) = &mut v
    {
        let shared = root
            .entry("shared".into())
            .or_insert_with(|| Value::Mapping(Default::default()));
        if let Value::Mapping(services) = shared {
            for name in dev.shared.keys() {
                let entry = services
                    .entry(name.clone().into())
                    .or_insert_with(|| Value::Mapping(Default::default()));
                prune(entry, &svc_default);
                if entry.is_null() {
                    *entry = Value::Mapping(Default::default());
                }
            }
        }
    }
    v
}

/// Remove nulls, empty collections and values equal to the default.
fn prune(v: &mut serde_yaml::Value, default: &serde_yaml::Value) {
    use serde_yaml::Value;
    let Value::Mapping(m) = v else { return };
    let keys: Vec<Value> = m.keys().cloned().collect();
    for k in keys {
        let d = default.get(&k).cloned().unwrap_or(Value::Null);
        if let Some(child) = m.get_mut(&k) {
            prune(child, &d);
        }
        let drop = match m.get(&k) {
            Some(Value::Null) => true,
            Some(Value::Mapping(x)) => x.is_empty(),
            Some(Value::Sequence(x)) => x.is_empty(),
            Some(other) => !d.is_null() && *other == d,
            None => false,
        };
        if drop {
            m.remove(&k);
        }
    }
}

/// Fill `{name}` placeholders from `vars`. Unknown names are an error so a
/// typo in `orca.yaml` is reported instead of silently producing a bad value.
pub fn render_template(template: &str, vars: &BTreeMap<String, String>) -> anyhow::Result<String> {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let end = after
            .find('}')
            .ok_or_else(|| anyhow::anyhow!("unclosed '{{' in '{template}'"))?;
        let key = after[..end].trim();
        let value = vars.get(key).ok_or_else(|| {
            let known: Vec<&str> = vars.keys().map(String::as_str).collect();
            anyhow::anyhow!(
                "unknown variable {{{key}}} in '{template}' (known: {})",
                known.join(", ")
            )
        })?;
        out.push_str(value);
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

#[cfg(test)]
mod tests {

    #[test]
    fn project_keys_read_leniently_and_warn() {
        let text = r#"
gateway:
  - {hostname: app, service: web, port: 3000}
  - {hostname: broken, service: web}
links:
  Storefront:
    - {name: Web, local: app, staging: "https://staging.test"}
    - {local: app}
builds:
  - {name: web, context: ., tag: "web:dev", args: {NODE: 20, DEBUG: true}}
hooks:
  after_up: ["web: npm run migrate", "no colon here"]
dev: {}
"#;
        let y = OrcaYaml::parse(text).unwrap();
        assert_eq!(y.gateway.len(), 1);
        assert_eq!(y.links[0].group, "Storefront");
        assert_eq!(y.links[0].links.len(), 1);
        assert_eq!(y.links[0].links[0].urls["staging"], "https://staging.test");
        assert_eq!(y.builds[0].args["NODE"], "20");
        assert_eq!(y.builds[0].dockerfile, "Dockerfile");
        assert_eq!(y.hooks.after_up.len(), 2);
        assert!(y.dev.is_some());

        let w = project_warnings(text);
        assert_eq!(w.len(), 3, "{w:?}");
        assert!(w[0].starts_with("gateway entry 2"));
        assert!(w[1].starts_with("links.Storefront entry 2"));
        assert!(w[2].starts_with("hooks.after_up"));
    }

    #[test]
    fn project_keys_survive_a_round_trip() {
        let text = "links:\n  B: [{name: x, local: b}]\n  A: [{name: y, local: a}]\n";
        let y = OrcaYaml::parse(text).unwrap();
        let again = OrcaYaml::parse(&serde_yaml::to_string(&y).unwrap()).unwrap();
        assert_eq!(y, again);
        assert_eq!(again.links[0].group, "B", "group order is kept");
    }

    use super::*;

    const FULL: &str = r#"
project: myapp
compose: compose.yaml
gateway:
  - hostname: legacy
    service: web
    port: 80
dev:
  naming:
    instance: folder
    hostname: "{instance}-{service}.myapp.localhost"
  start: on-create
  shared:
    postgres:
      data: shared
      database: myapp
      host_port: 5432
    redis:
      data: own-database
    mailpit:
  instance:
    env:
      api:
        DATABASE_URL: "postgres://app:app@postgres:5432/{db.postgres}"
    expose:
      web: 3000
      api: { port: 8080, host: web, path: /api }
    host_ports:
      api: [9229]
    hooks:
      after_up: ["api: npm run seed"]
    idle_stop: 2h
    limits: { memory: 2g, cpus: 2 }
"#;

    #[test]
    fn parses_full_example() {
        let y = OrcaYaml::parse(FULL).unwrap();
        assert_eq!(y.project.as_deref(), Some("myapp"));
        let dev = y.dev.unwrap();
        assert_eq!(dev.naming.instance, InstanceNameSource::Folder);
        assert_eq!(dev.start, StartPolicy::OnCreate);
        assert_eq!(dev.shared.len(), 3);
        assert_eq!(dev.shared["redis"].data, DataMode::OwnDatabase);
        assert_eq!(dev.shared["mailpit"], SharedService::default());
        assert_eq!(dev.instance.expose["web"].port(), 3000);
        assert_eq!(dev.instance.expose["api"].host(), Some("web"));
        assert_eq!(dev.instance.expose["api"].path(), Some("/api"));
        assert_eq!(dev.instance.host_ports["api"], vec![9229]);
        assert_eq!(dev.instance.limits.unwrap().cpus_string().as_deref(), Some("2"));
    }

    #[test]
    fn empty_and_missing_dev_are_fine() {
        assert_eq!(OrcaYaml::parse("").unwrap(), OrcaYaml::default());
        let y = OrcaYaml::parse("project: x\n").unwrap();
        assert!(y.dev.is_none());
        let y = OrcaYaml::parse("dev: {}\n").unwrap();
        assert_eq!(y.dev.unwrap().naming.hostname, DEFAULT_HOSTNAME_TEMPLATE);
    }

    #[test]
    fn compose_accepts_list() {
        let y = OrcaYaml::parse("compose: [a.yaml, b.yaml]\n").unwrap();
        assert_eq!(y.compose.unwrap().to_vec(), vec!["a.yaml", "b.yaml"]);
    }

    #[test]
    fn local_file_merges_on_top() {
        let dir = tempdir();
        std::fs::write(dir.join("orca.yaml"), FULL).unwrap();
        std::fs::write(dir.join("orca.local.yaml"), "dev:\n  instance:\n    idle_stop: 30m\n").unwrap();
        let y = OrcaYaml::load(&dir).unwrap();
        let dev = y.dev.unwrap();
        assert_eq!(dev.instance.idle_stop.as_deref(), Some("30m"));
        // Untouched keys survive the merge.
        assert_eq!(dev.instance.host_ports["api"], vec![9229]);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn template_renders_and_rejects_unknown() {
        let mut vars = BTreeMap::new();
        vars.insert("service".to_string(), "web".to_string());
        vars.insert("instance".to_string(), "feat".to_string());
        assert_eq!(render_template("{service}.{instance}.x", &vars).unwrap(), "web.feat.x");
        assert_eq!(render_template("plain", &vars).unwrap(), "plain");
        let err = render_template("{nope}", &vars).unwrap_err().to_string();
        assert!(err.contains("unknown variable {nope}"), "{err}");
        assert!(render_template("{service", &vars).is_err());
    }

    #[test]
    fn hook_parsing() {
        assert_eq!(
            parse_hook("api: npm run db:migrate").unwrap(),
            ("api".to_string(), "npm run db:migrate".to_string())
        );
        assert!(parse_hook("no colon").is_err());
        assert!(parse_hook(": cmd").is_err());
    }

    fn tempdir() -> std::path::PathBuf {
        let mut bytes = [0u8; 8];
        getrandom::getrandom(&mut bytes).unwrap();
        let name: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        let dir = std::env::temp_dir().join(format!("orca-dev-test-{name}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn minimal_yaml_leaves_out_defaults() {
        let y = OrcaYaml::parse(
            "dev:\n  shared:\n    postgres:\n      data: own-database\n      database: myapp\n    redis:\n  instance:\n    host_ports:\n      api: [9229]\n",
        )
        .unwrap();
        let v = minimal_dev_value(&y.dev.unwrap());
        let text = serde_yaml::to_string(&v).unwrap();
        assert!(!text.contains("naming"), "{text}");
        assert!(!text.contains("start"), "{text}");
        assert!(text.contains("own-database"), "{text}");
        assert!(text.contains("redis: {}"), "{text}");
        assert!(text.contains("9229"), "{text}");
        assert!(!text.contains("hooks"), "{text}");
        // And it parses back to the same config.
        let back: DevConfig = serde_yaml::from_value(v).unwrap();
        assert_eq!(back.shared["postgres"].data, DataMode::OwnDatabase);
        assert!(back.shared.contains_key("redis"));
    }

    #[test]
    fn durations() {
        assert_eq!(parse_duration("30m").unwrap().as_secs(), 1800);
        assert_eq!(parse_duration("1h30m").unwrap().as_secs(), 5400);
        assert_eq!(parse_duration("90s").unwrap().as_secs(), 90);
        assert!(parse_duration("30").is_none());
        assert!(parse_duration("abc").is_none());
        let mut i = InstanceConfig::default();
        assert!(i.idle_stop_duration().unwrap().is_none());
        i.idle_stop = Some("off".into());
        assert!(i.idle_stop_duration().unwrap().is_none());
        i.idle_stop = Some("2h".into());
        assert_eq!(i.idle_stop_duration().unwrap().unwrap().as_secs(), 7200);
        i.idle_stop = Some("soon".into());
        assert!(i.idle_stop_duration().is_err());
    }

    #[test]
    fn retired_presets_are_ignored_with_a_warning() {
        let text = "dev:\n  instance:\n    presets:\n      api: [api]\n    default_preset: api\n";
        assert!(OrcaYaml::parse(text).unwrap().dev.is_some());
        assert!(project_warnings(text).iter().any(|w| w.contains("compose profiles")));
    }
}
