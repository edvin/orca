//! A workspace: one git repo with an `orca-workspace.yaml` that sets up a
//! team's whole local environment. The shared services everyone uses, the
//! Docker network projects meet on, the gateway's domain and certificate,
//! and the list of projects a developer can set up with one click (or by
//! asking their AI tool).
//!
//! The file holds no secrets: `.env` values are references into the team's
//! secret manager (Passbolt, 1Password…), and each developer fills them in
//! on their own machine, by hand or through that manager's CLI.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const FILE_NAMES: &[&str] = &["orca-workspace.yaml", "orca-workspace.yml"];

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct WorkspaceFile {
    /// Shown in Orca, e.g. "group.one".
    pub name: String,
    /// One line about the workspace.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// A Docker network every project joins (created when missing), e.g.
    /// `local-dev`. Gateway routes can target network aliases on it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gateway: Option<WorkspaceGateway>,
    /// Services everyone shares (mail catcher, dashboards, queues…).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shared: Option<SharedServices>,
    /// Gateway routes to the shared services (or anything else on the network).
    pub routes: Vec<WorkspaceRoute>,
    /// Where projects are cloned, `~` allowed. Default: next to the workspace.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clone_into: Option<String>,
    /// The secret managers `env.secrets` references point into.
    pub secrets: SecretProviders,
    /// Image registries projects pull from, e.g. `registry.example.com:5000`:
    /// Orca checks you're logged in to each.
    pub registries: Vec<String>,
    pub projects: BTreeMap<String, WorkspaceProject>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct WorkspaceGateway {
    /// The domain hostnames get, e.g. `local.groupone.dev`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    /// A certificate for `*.<domain>`, paths relative to the workspace.
    /// Without one, Orca's own certificate authority signs the names.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub certificate: Option<CertificateFiles>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct CertificateFiles {
    /// PEM certificate (with its chain).
    pub cert: String,
    /// PEM private key.
    pub key: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct SharedServices {
    /// The compose file with the shared services, relative to the workspace.
    pub compose: String,
    /// Compose project name; the workspace folder's name when unset.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// A hostname routed to `alias:port` on the workspace network.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct WorkspaceRoute {
    /// `mail` (gets the workspace domain) or a full hostname.
    pub hostname: String,
    /// `alias:port`, the network alias (or container name) and its port.
    pub target: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Card title on the landing page.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

impl WorkspaceRoute {
    /// The target split into (host, port).
    pub fn target(&self) -> Option<(&str, u16)> {
        let (host, port) = self.target.rsplit_once(':')?;
        let port = port.parse().ok()?;
        (!host.is_empty() && valid_dns_name(host)).then_some((host, port))
    }
}

/// The secret managers a workspace uses. Each `env.secrets` value is a
/// reference in one of them: `passbolt:<resource id>`, or 1Password's own
/// `op://vault/item/field`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct SecretProviders {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub passbolt: Option<PassboltConfig>,
    #[serde(rename = "1password", skip_serializing_if = "Option::is_none")]
    pub onepassword: Option<OnePasswordConfig>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct PassboltConfig {
    /// e.g. `https://passbolt.example.com`
    pub url: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct OnePasswordConfig {
    /// The account, when developers have several, e.g. `team.1password.com`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
}

/// One `env.secrets` value, parsed.
#[derive(Debug, Clone, PartialEq)]
pub enum SecretRef {
    /// A Passbolt resource id.
    Passbolt(String),
    /// A 1Password secret reference, `op://vault/item/field`.
    OnePassword(String),
}

impl SecretRef {
    pub fn parse(s: &str) -> anyhow::Result<Self> {
        let s = s.trim();
        if let Some(id) = s.strip_prefix("passbolt:") {
            if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
                anyhow::bail!("'{s}' is not a Passbolt resource id (passbolt:<uuid>)");
            }
            return Ok(Self::Passbolt(id.to_string()));
        }
        if let Some(path) = s.strip_prefix("op://") {
            let parts: Vec<&str> = path.split('/').collect();
            if parts.len() < 3 || parts.iter().any(|p| p.is_empty()) {
                anyhow::bail!("'{s}' is not a 1Password reference (op://vault/item/field)");
            }
            return Ok(Self::OnePassword(s.to_string()));
        }
        anyhow::bail!("'{s}' isn't a secret reference: use passbolt:<id> or op://vault/item/field")
    }

    /// Which provider it belongs to, as named under `secrets:`.
    pub fn provider(&self) -> &'static str {
        match self {
            Self::Passbolt(_) => "passbolt",
            Self::OnePassword(_) => "1password",
        }
    }
}

impl PassboltConfig {
    /// The page for one password, to open in the browser.
    pub fn link(&self, resource: &str) -> String {
        format!("{}/app/passwords/view/{resource}", self.url.trim_end_matches('/'))
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct WorkspaceProject {
    /// What to `git clone`.
    pub repo: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Folder under `clone_into`; the project's key when unset.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Branch to check out after cloning; the repo's default when unset.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// Shared services this project needs; started before it.
    pub uses: Vec<String>,
    /// Run once in the project folder after cloning and creating `.env`,
    /// e.g. `just setup`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub setup: Option<String>,
    /// Gateway routes, until the project's own orca.yaml has them.
    pub routes: Vec<WorkspaceRoute>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<ProjectEnv>,
    /// Also add it to Projects, so each git worktree can run side by side.
    pub worktrees: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct ProjectEnv {
    /// The file to create, relative to the project. Default `.env`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    /// The template it starts from, e.g. `.env.example`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    /// Variables whose value lives in a secret manager: NAME → reference
    /// (`passbolt:<id>`, `op://vault/item/field`).
    pub secrets: BTreeMap<String, String>,
}

impl ProjectEnv {
    pub fn file(&self) -> &str {
        self.file.as_deref().unwrap_or(".env")
    }
}

impl WorkspaceFile {
    pub fn parse(text: &str) -> anyhow::Result<Self> {
        let file: WorkspaceFile = serde_yaml::from_str(text)?;
        file.validate()?;
        Ok(file)
    }

    /// The file in a workspace folder.
    pub fn find(dir: &Path) -> Option<PathBuf> {
        FILE_NAMES.iter().map(|f| dir.join(f)).find(|p| p.is_file())
    }

    pub fn load(dir: &Path) -> anyhow::Result<Self> {
        let path = Self::find(dir).ok_or_else(|| anyhow::anyhow!("{} has no {}", dir.display(), FILE_NAMES[0]))?;
        Self::parse(&std::fs::read_to_string(&path)?).map_err(|e| anyhow::anyhow!("{}: {e}", path.display()))
    }

    /// Everything that would make Orca act wrongly, said plainly.
    pub fn validate(&self) -> anyhow::Result<()> {
        if self.name.trim().is_empty() {
            anyhow::bail!("`name` is missing");
        }
        if let Some(n) = &self.network
            && !valid_dns_name(n)
        {
            anyhow::bail!("network '{n}' is not a valid Docker network name");
        }
        if let Some(d) = self.gateway.as_ref().and_then(|g| g.domain.as_deref())
            && (d.is_empty() || !d.split('.').all(valid_dns_name))
        {
            anyhow::bail!("gateway domain '{d}' is not a valid domain");
        }
        if let Some(c) = self.gateway.as_ref().and_then(|g| g.certificate.as_ref()) {
            for p in [&c.cert, &c.key] {
                relative_path(p).map_err(|e| anyhow::anyhow!("gateway certificate: {e}"))?;
            }
        }
        if let Some(s) = &self.shared {
            relative_path(&s.compose).map_err(|e| anyhow::anyhow!("shared.compose: {e}"))?;
        }
        if let Some(p) = &self.secrets.passbolt
            && !p.url.starts_with("https://")
        {
            anyhow::bail!("secrets.passbolt.url must start with https://");
        }
        for r in &self.routes {
            check_route(r).map_err(|e| anyhow::anyhow!("routes: {e}"))?;
        }
        for (key, p) in &self.projects {
            if !valid_dns_name(key) {
                anyhow::bail!("project '{key}': use letters, digits and dashes");
            }
            if p.repo.trim().is_empty() {
                anyhow::bail!("project '{key}': `repo` is missing");
            }
            if p.repo.starts_with('-') {
                anyhow::bail!("project '{key}': `repo` can't start with '-'");
            }
            if let Some(b) = &p.branch
                && (b.starts_with('-') || b.trim().is_empty())
            {
                anyhow::bail!("project '{key}': invalid branch '{b}'");
            }
            if let Some(path) = &p.path {
                relative_path(path).map_err(|e| anyhow::anyhow!("project '{key}' path: {e}"))?;
            }
            for r in &p.routes {
                check_route(r).map_err(|e| anyhow::anyhow!("project '{key}' routes: {e}"))?;
            }
            if let Some(env) = &p.env {
                relative_path(env.file()).map_err(|e| anyhow::anyhow!("project '{key}' env.file: {e}"))?;
                if let Some(from) = &env.from {
                    relative_path(from).map_err(|e| anyhow::anyhow!("project '{key}' env.from: {e}"))?;
                }
                for (var, reference) in &env.secrets {
                    if !valid_env_name(var) {
                        anyhow::bail!("project '{key}': '{var}' is not a valid variable name");
                    }
                    let r = SecretRef::parse(reference).map_err(|e| anyhow::anyhow!("project '{key}' {var}: {e}"))?;
                    let declared = match &r {
                        SecretRef::Passbolt(_) => self.secrets.passbolt.is_some(),
                        SecretRef::OnePassword(_) => self.secrets.onepassword.is_some(),
                    };
                    if !declared {
                        anyhow::bail!(
                            "project '{key}' {var} uses {}, but the workspace's `secrets:` doesn't set it up",
                            r.provider()
                        );
                    }
                }
            }
            for u in &p.uses {
                if u.trim().is_empty() {
                    anyhow::bail!("project '{key}': empty entry in `uses`");
                }
            }
        }
        Ok(())
    }

    /// Where a project is (or will be) cloned, given the workspace folder.
    pub fn project_dir(&self, workspace_dir: &Path, key: &str) -> PathBuf {
        let root = match self.clone_into.as_deref() {
            Some(c) => expand_home(c, workspace_dir),
            None => workspace_dir
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| workspace_dir.to_path_buf()),
        };
        let sub = self
            .projects
            .get(key)
            .and_then(|p| p.path.clone())
            .unwrap_or_else(|| key.to_string());
        root.join(sub)
    }
}

fn check_route(r: &WorkspaceRoute) -> anyhow::Result<()> {
    if r.hostname.is_empty() || !r.hostname.split('.').all(valid_dns_name) {
        anyhow::bail!("'{}' is not a valid hostname", r.hostname);
    }
    if r.target().is_none() {
        anyhow::bail!("'{}': target must be alias:port, like mailpit:8025", r.target);
    }
    if let Some(p) = &r.path
        && !p.starts_with('/')
    {
        anyhow::bail!("'{}': path must start with /", r.hostname);
    }
    Ok(())
}

/// `~/code`, an absolute path, or a path relative to the workspace.
fn expand_home(p: &str, workspace_dir: &Path) -> PathBuf {
    if let Some(rest) = p.strip_prefix("~/") {
        return dirs::home_dir().unwrap_or_default().join(rest);
    }
    let path = Path::new(p);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        workspace_dir.join(path)
    }
}

/// A path inside the workspace or project: relative, no `..`.
fn relative_path(p: &str) -> anyhow::Result<()> {
    let path = Path::new(p);
    if p.is_empty() || path.is_absolute() || path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        anyhow::bail!("'{p}' must be a path inside the folder");
    }
    Ok(())
}

fn valid_dns_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 63
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        && !s.starts_with('-')
}

fn valid_env_name(s: &str) -> bool {
    !s.is_empty()
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        && !s.starts_with(|c: char| c.is_ascii_digit())
}

/// Turn an HAProxy config (devproxy's) into workspace routes: every
/// `hdr(host)` rule that sends a hostname to a backend whose `server` is
/// `alias:port`. Hostnames under `domain` are shortened to their label.
pub fn routes_from_haproxy(cfg: &str, domain: Option<&str>) -> Vec<WorkspaceRoute> {
    let mut acls: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut uses: Vec<(String, String)> = Vec::new();
    let mut servers: BTreeMap<String, String> = BTreeMap::new();
    let mut backend: Option<String> = None;
    for raw in cfg.lines() {
        let line = raw.split('#').next().unwrap_or("").trim();
        let words: Vec<&str> = line.split_whitespace().collect();
        match words.as_slice() {
            ["backend", name, ..] => backend = Some(name.to_string()),
            ["frontend", ..] | ["listen", ..] | ["defaults", ..] | ["global", ..] => backend = None,
            ["acl", name, rest @ ..]
                if rest.iter().any(|w| {
                    w.starts_with("hdr(host)") || w.starts_with("hdr_dom(host)") || w.starts_with("hdr_beg(host)")
                }) =>
            {
                let hosts = rest
                    .iter()
                    .skip_while(|w| !w.starts_with("hdr"))
                    .skip(1)
                    .filter(|w| !w.starts_with('-'));
                acls.entry(name.to_string())
                    .or_default()
                    .extend(hosts.map(|h| h.to_lowercase()));
            }
            ["use_backend", target, "if", conds @ ..] => {
                for c in conds.iter().filter(|c| !matches!(**c, "or" | "||" | "!")) {
                    uses.push((c.to_string(), target.to_string()));
                }
            }
            ["server", _name, addr, ..] if backend.is_some() => {
                servers
                    .entry(backend.clone().unwrap())
                    .or_insert_with(|| addr.to_string());
            }
            _ => {}
        }
    }
    let mut out: Vec<WorkspaceRoute> = Vec::new();
    for (acl, target_backend) in uses {
        let (Some(hosts), Some(addr)) = (acls.get(&acl), servers.get(&target_backend)) else {
            continue;
        };
        let target = if addr.contains(':') {
            addr.clone()
        } else {
            format!("{addr}:80")
        };
        for host in hosts {
            let hostname = match domain.and_then(|d| host.strip_suffix(&format!(".{d}"))) {
                Some(label) => label.to_string(),
                None => host.clone(),
            };
            let route = WorkspaceRoute {
                hostname,
                target: target.clone(),
                ..Default::default()
            };
            if check_route(&route).is_ok() && !out.iter().any(|r| r.hostname == route.hostname) {
                out.push(route);
            }
        }
    }
    out
}

/// The value a `.env` file gives `name`, unquoted; `None` when unset or empty.
pub fn env_value(text: &str, name: &str) -> Option<String> {
    text.lines().rev().find_map(|line| {
        let l = line.trim_start();
        let l = l.strip_prefix("export ").unwrap_or(l);
        let (k, v) = l.split_once('=')?;
        if k.trim() != name {
            return None;
        }
        let v = v.trim();
        let v = match v.chars().next() {
            // A quoted value ends at its closing quote; a comment may follow.
            Some(q @ ('"' | '\'')) => v[1..].find(q).map(|end| v[1..1 + end].to_string()).unwrap_or_default(),
            _ => v.split(" #").next().unwrap_or(v).trim().to_string(),
        };
        (!v.is_empty()).then_some(v)
    })
}

/// Set variables in a `.env` text: replace each `NAME=` line (keeping its
/// place and any `export`), or add it at the end. Values are quoted when
/// they need to be.
pub fn set_env_values(text: &str, values: &BTreeMap<String, String>) -> String {
    let quote = |v: &str| {
        if v.chars().any(|c| c.is_whitespace() || "#\"'$`\\".contains(c)) {
            format!(
                "\"{}\"",
                v.replace('\\', "\\\\")
                    .replace('"', "\\\"")
                    .replace('$', "\\$")
                    .replace('`', "\\`")
            )
        } else {
            v.to_string()
        }
    };
    let mut done = std::collections::BTreeSet::new();
    let mut out: Vec<String> = text
        .lines()
        .map(|line| {
            let l = line.trim_start();
            let (export, rest) = match l.strip_prefix("export ") {
                Some(r) => ("export ", r),
                None => ("", l),
            };
            if let Some((k, _)) = rest.split_once('=')
                && let Some(v) = values.get(k.trim())
            {
                done.insert(k.trim().to_string());
                return format!("{export}{}={}", k.trim(), quote(v));
            }
            line.to_string()
        })
        .collect();
    for (k, v) in values {
        if !done.contains(k) {
            out.push(format!("{k}={}", quote(v)));
        }
    }
    let mut s = out.join("\n");
    s.push('\n');
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_values_are_read_and_written_in_place() {
        let text = "# db\nDB_HOST=mysql\nexport DB_PASSWORD=\nAPI_KEY=\"\" # fill me\n";
        assert_eq!(env_value(text, "DB_HOST").as_deref(), Some("mysql"));
        assert_eq!(env_value(text, "DB_PASSWORD"), None);
        assert_eq!(env_value(text, "API_KEY"), None);
        let values = BTreeMap::from([
            ("DB_PASSWORD".to_string(), "p@ss w#rd\"$x".to_string()),
            ("NEW_TOKEN".to_string(), "abc".to_string()),
        ]);
        let out = set_env_values(text, &values);
        assert!(
            out.starts_with("# db\nDB_HOST=mysql\nexport DB_PASSWORD=\"p@ss w#rd\\\"\\$x\"\n"),
            "{out}"
        );
        assert!(out.ends_with("NEW_TOKEN=abc\n"));
        assert_eq!(env_value(&out, "NEW_TOKEN").as_deref(), Some("abc"));
    }

    const EXAMPLE: &str = r#"
name: group.one
network: local-dev
gateway:
  domain: local.groupone.dev
  certificate: { cert: certs/wildcard.crt, key: certs/wildcard.key }
shared:
  compose: compose.yaml
routes:
  - { hostname: mail, target: "mailpit:8025", title: Mailpit }
secrets:
  passbolt: { url: https://passbolt.example.com }
  1password: {}
clone_into: ~/code/group.one
projects:
  onecrm:
    repo: git@git.example.com:crm/onecrm.git
    description: CRM
    uses: [mailpit, temporal]
    setup: just setup
    routes:
      - { hostname: one-crm, target: "one-crm-app:80" }
    env:
      from: .env.example
      secrets:
        DB_PASSWORD: passbolt:7f3c91a2-1111-2222-3333-444455556666
        STRIPE_SECRET: op://Dev/Stripe/secret
"#;

    #[test]
    fn a_full_workspace_parses() {
        let w = WorkspaceFile::parse(EXAMPLE).unwrap();
        assert_eq!(w.network.as_deref(), Some("local-dev"));
        let p = &w.projects["onecrm"];
        assert_eq!(p.routes[0].target(), Some(("one-crm-app", 80)));
        assert_eq!(p.env.as_ref().unwrap().file(), ".env");
        assert_eq!(
            w.secrets.passbolt.as_ref().unwrap().link("7f3c"),
            "https://passbolt.example.com/app/passwords/view/7f3c"
        );
        assert!(
            w.project_dir(Path::new("/x/ws"), "onecrm")
                .ends_with("code/group.one/onecrm")
        );
    }

    #[test]
    fn mistakes_are_named() {
        let bad = |from: &str, to: &str| {
            WorkspaceFile::parse(&EXAMPLE.replace(from, to))
                .unwrap_err()
                .to_string()
        };
        assert!(bad("cert: certs/wildcard.crt", "cert: ../../etc/passwd").contains("inside the folder"));
        assert!(bad("target: \"mailpit:8025\"", "target: mailpit").contains("alias:port"));
        assert!(bad("url: https://", "url: http://").contains("https"));
        assert!(bad("DB_PASSWORD", "DB-PASSWORD").contains("variable name"));
        assert!(bad("op://Dev/Stripe/secret", "op://Dev/Stripe").contains("1Password reference"));
        assert!(bad("passbolt:7f3c", "vault:7f3c").contains("isn't a secret reference"));
        assert!(bad("  1password: {}\n", "").contains("doesn't set it up"));
        assert!(bad("repo: git@", "repo: --upload-pack=x git@").contains("can't start"));
        assert!(bad("description: CRM", "descripton: CRM").contains("unknown field"));
    }

    #[test]
    fn devproxy_haproxy_config_becomes_routes() {
        let cfg = r#"
frontend https
    bind *:443 ssl crt /certs/wildcard.pem
    acl host_crm hdr(host) -i one-crm.local.groupone.dev
    acl host_mail hdr(host) -i mail.local.groupone.dev mailpit.local.groupone.dev
    use_backend crm if host_crm
    use_backend mailpit if host_mail
backend crm
    server one-crm-app one-crm-app:80 resolvers docker init-addr last,none
backend mailpit
    server mailpit mailpit:8025 check
"#;
        let routes = routes_from_haproxy(cfg, Some("local.groupone.dev"));
        let pairs: Vec<(&str, &str)> = routes
            .iter()
            .map(|r| (r.hostname.as_str(), r.target.as_str()))
            .collect();
        assert_eq!(
            pairs,
            vec![
                ("one-crm", "one-crm-app:80"),
                ("mail", "mailpit:8025"),
                ("mailpit", "mailpit:8025")
            ]
        );
    }
}
