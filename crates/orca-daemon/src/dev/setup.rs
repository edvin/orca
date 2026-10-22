//! Project setup: what the wizard and the orca.yaml editor need.
//! Analyses the compose file, writes `orca.yaml`, adds the agent snippet,
//! and adopts data from an existing `docker compose up`.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use orca_core::dev::compose_model::{NON_HTTP_PORTS, suggest_shared};
use orca_core::dev::schema::{DevConfig, Expose, OrcaYaml, minimal_dev_value};
use orca_core::dev::{hostnames, tenancy};
use orca_core::runtime::ContainerRuntime;
use serde::{Deserialize, Serialize};

use super::ops;
use super::project::ProjectCtx;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
pub struct SetupAnalysis {
    pub orca_yaml: YamlFile,
    /// The current `dev:` config, or Orca's suggestion when there is none.
    pub dev: DevConfig,
    pub source: &'static str,
    pub services: Vec<ServiceInfo>,
    pub migrations: Vec<MigrationHint>,
    pub adoption: Option<Adoption>,
    pub agents_file: AgentsFile,
    pub compose_files: Vec<PathBuf>,
    pub hostnames: HostnameAdvice,
}

/// What the hostname picker needs to recommend a pattern.
#[derive(Debug, Clone, Serialize)]
pub struct HostnameAdvice {
    /// "flat" or "nested".
    pub recommended: &'static str,
    /// Env vars that set a cookie domain; nested keeps them per instance.
    pub cookie_vars: Vec<EnvRef>,
    pub domain: String,
    /// DNS names of the gateway's custom certificate, when it uses one.
    pub cert_names: Option<Vec<String>>,
}

/// The env value that scopes a cookie to one instance under the nested pattern.
pub const NESTED_COOKIE_DOMAIN: &str = ".{instance}.{project}.{domain}";

#[derive(Debug, Clone, Serialize)]
pub struct YamlFile {
    pub path: PathBuf,
    pub exists: bool,
    pub text: String,
    pub has_dev: bool,
    pub has_comments: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServiceInfo {
    pub name: String,
    pub image: Option<String>,
    pub built: bool,
    pub ports: Vec<PortInfo>,
    pub volumes: Vec<String>,
    pub depends_on: Vec<String>,
    pub suggested_shared: bool,
    pub reason: String,
    pub kind: Option<tenancy::TenancyKind>,
    pub shared_db: Option<String>,
    /// Env vars in other services that point at this one.
    pub referenced_by: Vec<EnvRef>,
    /// What own-database mode would change in other services' env, shown
    /// with an example worktree name.
    pub own_database_rewrites: Vec<EnvRewrite>,
    pub profiles: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PortInfo {
    pub target: u16,
    pub published: Option<String>,
    /// "browser" or "host", Orca's guess.
    pub suggested: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct EnvRef {
    pub service: String,
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct EnvRewrite {
    pub service: String,
    pub key: String,
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct MigrationHint {
    pub service: String,
    pub command: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Adoption {
    /// Compose project of the existing stack.
    pub project: String,
    pub containers: Vec<String>,
    pub volumes: Vec<String>,
    pub running: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentsFile {
    pub path: PathBuf,
    pub exists: bool,
    pub has_snippet: bool,
}

const SNIPPET_START: &str = "<!-- orca:dev -->";
const SNIPPET_END: &str = "<!-- /orca:dev -->";

fn agents_file(root: &Path) -> AgentsFile {
    // Prefer an existing CLAUDE.md, then AGENTS.md; create AGENTS.md otherwise.
    let path = ["CLAUDE.md", "AGENTS.md"]
        .iter()
        .map(|f| root.join(f))
        .find(|p| p.exists())
        .unwrap_or_else(|| root.join("AGENTS.md"));
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    AgentsFile {
        exists: path.exists(),
        has_snippet: text.contains(SNIPPET_START),
        path,
    }
}

pub async fn analyse(state: &AppState, project_id: &str) -> Result<SetupAnalysis> {
    let ctx = ProjectCtx::load(state, project_id).await?;
    let root = ctx.project.root.clone();
    let yaml_path = root.join("orca.yaml");
    let text = std::fs::read_to_string(&yaml_path).unwrap_or_default();
    let files = ctx.root_compose_files()?;
    let (model, _) = ops::resolve_model(state, &root, &ctx.shared_cp(), &files).await?;

    let suggestions = suggest_shared(&model);
    let mut services = Vec::new();
    for (name, svc) in &model.services {
        let sug = suggestions.iter().find(|s| s.service == *name);
        let kind = tenancy::detect_kind(svc);
        let shared_db = kind.and_then(|k| tenancy::detect_shared_database(k, svc));
        let own_database_rewrites: Vec<EnvRewrite> = match (kind, &shared_db) {
            (Some(k), Some(db)) => {
                let example = if k == tenancy::TenancyKind::Redis {
                    "1".to_string()
                } else {
                    tenancy::tenant_for(k, db, "feature")
                };
                model
                    .services
                    .iter()
                    .filter(|(other, _)| *other != name)
                    .flat_map(|(other, o)| {
                        tenancy::rewrite_env(&o.environment, name, k, db, &example)
                            .into_iter()
                            .map(move |(key, from, to)| EnvRewrite {
                                service: other.clone(),
                                key,
                                from,
                                to,
                            })
                    })
                    .collect()
            }
            _ => Vec::new(),
        };
        let referenced_by = model
            .services
            .iter()
            .filter(|(other, _)| *other != name)
            .flat_map(|(other, o)| {
                o.environment.iter().filter_map(move |(k, v)| {
                    let v = v.as_ref()?;
                    references_host(v, name).then(|| EnvRef {
                        service: other.clone(),
                        key: k.clone(),
                        value: v.clone(),
                    })
                })
            })
            .collect();
        services.push(ServiceInfo {
            name: name.clone(),
            image: svc.image.clone(),
            built: svc.is_built(),
            ports: svc
                .ports
                .iter()
                .map(|p| PortInfo {
                    target: p.target,
                    published: p.published.clone(),
                    suggested: if NON_HTTP_PORTS.contains(&p.target) {
                        "host"
                    } else {
                        "browser"
                    },
                })
                .collect(),
            volumes: svc_volumes(&files, name),
            depends_on: svc.depends_on.keys().cloned().collect(),
            suggested_shared: sug.is_some_and(|s| s.shared),
            reason: sug.map(|s| s.reason.clone()).unwrap_or_default(),
            kind,
            shared_db,
            referenced_by,
            own_database_rewrites,
            profiles: svc.profiles.clone(),
        });
    }

    let cookie_vars: Vec<EnvRef> = model
        .services
        .iter()
        .flat_map(|(svc, def)| {
            def.environment
                .iter()
                .filter(|(k, _)| hostnames::is_cookie_domain_var(k))
                .map(|(k, v)| EnvRef {
                    service: svc.clone(),
                    key: k.clone(),
                    value: v.clone().unwrap_or_default(),
                })
        })
        .collect();
    let (dev, source) = if ctx.has_dev {
        (ctx.dev.clone(), "orca.yaml")
    } else {
        let mut dev = suggested_config(&model, &services);
        if !cookie_vars.is_empty() {
            use_nested_hostnames(&mut dev, &cookie_vars);
        }
        (dev, "suggested")
    };
    let (domain, cert_names) = {
        let cfg = state.config.lock().await;
        (
            cfg.gateway.domain.clone(),
            super::hostcheck::custom_cert_names(&cfg.gateway),
        )
    };
    let hostnames = HostnameAdvice {
        recommended: if cookie_vars.is_empty() { "flat" } else { "nested" },
        cookie_vars,
        domain,
        cert_names,
    };

    Ok(SetupAnalysis {
        orca_yaml: YamlFile {
            path: yaml_path.clone(),
            exists: yaml_path.exists(),
            has_comments: text.lines().any(|l| l.trim_start().starts_with('#')),
            text,
            has_dev: ctx.has_dev,
            error: ctx.yaml_error.clone(),
        },
        dev,
        source,
        migrations: detect_migrations(&root, &model),
        adoption: find_adoption(state, &root, &ctx.shared_cp()).await,
        agents_file: agents_file(&root),
        compose_files: files,
        services,
        hostnames,
    })
}

/// Switch to nested hostnames and scope each cookie-domain var to the
/// instance, so services of one instance share cookies but instances don't.
fn use_nested_hostnames(dev: &mut DevConfig, cookie_vars: &[EnvRef]) {
    dev.naming.hostname = hostnames::NESTED.to_string();
    for v in cookie_vars {
        dev.instance
            .env
            .entry(v.service.clone())
            .or_default()
            .insert(v.key.clone(), NESTED_COOKIE_DOMAIN.to_string());
    }
}

/// Named volumes a service mounts, read from the raw compose file (the
/// typed model keeps volumes out to stay small).
fn svc_volumes(files: &[PathBuf], service: &str) -> Vec<String> {
    let mut out = Vec::new();
    for f in files {
        let Ok(text) = std::fs::read_to_string(f) else { continue };
        let Ok(v) = serde_yaml::from_str::<serde_yaml::Value>(&text) else {
            continue;
        };
        let Some(vols) = v
            .get("services")
            .and_then(|s| s.get(service))
            .and_then(|s| s.get("volumes"))
            .and_then(|v| v.as_sequence())
        else {
            continue;
        };
        for vol in vols {
            let src = match vol {
                serde_yaml::Value::String(s) => s.split(':').next().unwrap_or_default().to_string(),
                serde_yaml::Value::Mapping(_) => vol
                    .get("source")
                    .and_then(|s| s.as_str())
                    .unwrap_or_default()
                    .to_string(),
                _ => continue,
            };
            if !src.is_empty() && !src.starts_with('.') && !src.starts_with('/') && !src.starts_with('~') {
                out.push(src);
            }
        }
    }
    out
}

/// Whether an env value points at `host` (a URL host or `host:port`).
fn references_host(v: &str, host: &str) -> bool {
    let after_scheme = v.split_once("://").map(|(_, r)| r).unwrap_or(v);
    let authority = after_scheme.split(['/', '?']).next().unwrap_or_default();
    let hostport = authority.rsplit('@').next().unwrap_or(authority);
    let h = hostport.split(':').next().unwrap_or(hostport);
    h == host
}

/// Orca's starting point for a project without a `dev:` section.
fn suggested_config(model: &orca_core::dev::ComposeModel, services: &[ServiceInfo]) -> DevConfig {
    let mut dev = DevConfig::default();
    for s in services.iter().filter(|s| s.suggested_shared) {
        dev.shared.insert(s.name.clone(), Default::default());
    }
    for s in services.iter().filter(|s| !s.suggested_shared) {
        let Some(svc) = model.services.get(&s.name) else {
            continue;
        };
        let published: Vec<&orca_core::dev::compose_model::Port> =
            svc.ports.iter().filter(|p| p.published.is_some()).collect();
        if let Some(http) = published.iter().find(|p| !NON_HTTP_PORTS.contains(&p.target)) {
            dev.instance.expose.insert(s.name.clone(), Expose::Port(http.target));
        }
        let host: Vec<u16> = published
            .iter()
            .filter(|p| NON_HTTP_PORTS.contains(&p.target))
            .map(|p| p.target)
            .collect();
        if !host.is_empty() {
            dev.instance.host_ports.insert(s.name.clone(), host);
        }
    }
    dev
}

/// Migration commands found in the repo, mapped to the service whose build
/// context contains them.
fn detect_migrations(root: &Path, model: &orca_core::dev::ComposeModel) -> Vec<MigrationHint> {
    let built: Vec<(String, PathBuf)> = model
        .services
        .iter()
        .filter_map(|(name, svc)| {
            let ctx = svc.build.as_ref()?.get("context")?.as_str()?;
            Some((name.clone(), PathBuf::from(ctx)))
        })
        .collect();
    let service_for = |dir: &Path| -> Option<String> {
        built
            .iter()
            .filter(|(_, ctx)| dir.starts_with(ctx))
            .max_by_key(|(_, ctx)| ctx.components().count())
            .or_else(|| built.first())
            .map(|(n, _)| n.clone())
    };
    let mut dirs = vec![root.to_path_buf()];
    for (_, ctx) in &built {
        if ctx.starts_with(root) && !dirs.contains(ctx) {
            dirs.push(ctx.clone());
        }
    }
    let mut out = Vec::new();
    let mut push = |dir: &Path, command: String, source: String| {
        if let Some(service) = service_for(dir)
            && !out
                .iter()
                .any(|m: &MigrationHint| m.service == service && m.command == command)
        {
            out.push(MigrationHint {
                service,
                command,
                source,
            });
        }
    };
    for dir in &dirs {
        if let Ok(pkg) = std::fs::read_to_string(dir.join("package.json"))
            && let Ok(v) = serde_json::from_str::<serde_json::Value>(&pkg)
            && let Some(scripts) = v.get("scripts").and_then(|s| s.as_object())
        {
            let runner = if dir.join("pnpm-lock.yaml").exists() {
                "pnpm"
            } else if dir.join("yarn.lock").exists() {
                "yarn"
            } else {
                "npm run"
            };
            for name in scripts.keys().filter(|k| k.contains("migrate")) {
                push(dir, format!("{runner} {name}"), "package.json".into());
            }
        }
        if dir.join("prisma/schema.prisma").exists() {
            push(dir, "npx prisma migrate deploy".into(), "prisma/schema.prisma".into());
        }
        if dir.join("alembic.ini").exists() {
            push(dir, "alembic upgrade head".into(), "alembic.ini".into());
        }
        if dir.join("manage.py").exists() {
            push(dir, "python manage.py migrate".into(), "manage.py".into());
        }
        if dir.join("bin/rails").exists() && dir.join("db/migrate").exists() {
            push(dir, "bin/rails db:migrate".into(), "db/migrate".into());
        }
        if dir.join("knexfile.js").exists() || dir.join("knexfile.ts").exists() {
            push(dir, "npx knex migrate:latest".into(), "knexfile".into());
        }
    }
    out
}

/// An existing compose stack from this checkout (plain `docker compose up`)
/// whose data the shared stack could take over.
async fn find_adoption(state: &AppState, root: &Path, shared_cp: &str) -> Option<Adoption> {
    let containers = state.rt().await.list_containers(true).await.ok()?;
    let root_s = root.to_string_lossy().to_string();
    let mine: Vec<_> = containers
        .iter()
        .filter(|c| {
            c.labels.get("com.docker.compose.project.working_dir") == Some(&root_s)
                && !c.labels.contains_key(orca_core::dev::LABEL_PROJECT)
        })
        .collect();
    let project = mine.first()?.labels.get("com.docker.compose.project")?.clone();
    if project == shared_cp {
        return None;
    }
    let rt = state.rt().await;
    let mut filters = std::collections::HashMap::new();
    filters.insert(
        "label".to_string(),
        vec![format!("com.docker.compose.project={project}")],
    );
    let volumes = rt
        .docker
        .list_volumes(Some(bollard::volume::ListVolumesOptions { filters }))
        .await
        .ok()
        .and_then(|r| r.volumes)
        .unwrap_or_default()
        .into_iter()
        .map(|v| v.name)
        .collect();
    Some(Adoption {
        running: mine
            .iter()
            .any(|c| c.state == orca_core::runtime::ContainerState::Running),
        containers: mine.iter().map(|c| c.name.clone()).collect(),
        volumes,
        project,
    })
}

#[derive(Debug, Clone, Deserialize)]
pub struct WriteRequest {
    /// Raw orca.yaml text (YAML view). Wins over `dev`.
    pub text: Option<String>,
    /// Structured config (form view); replaces the `dev:` section only.
    pub dev: Option<DevConfig>,
    /// Also add `orca.local.yaml` to .gitignore.
    #[serde(default)]
    pub gitignore_local: bool,
    /// Return the text without writing it.
    #[serde(default)]
    pub dry_run: bool,
}

/// Write orca.yaml in the main checkout. With `dev`, other top-level keys
/// (gateway, links, build targets) are kept.
pub async fn write(state: &AppState, project_id: &str, req: WriteRequest) -> Result<(PathBuf, String)> {
    let ctx = ProjectCtx::load(state, project_id).await?;
    let path = ctx.project.root.join("orca.yaml");
    let text = match (req.text, req.dev) {
        (Some(t), _) => {
            OrcaYaml::parse(&t)?;
            t
        }
        (None, Some(dev)) => {
            let existing = std::fs::read_to_string(&path).unwrap_or_default();
            let mut doc: serde_yaml::Value = if existing.trim().is_empty() {
                serde_yaml::Value::Mapping(Default::default())
            } else {
                serde_yaml::from_str(&existing).context("the existing orca.yaml is not valid YAML")?
            };
            let map = doc
                .as_mapping_mut()
                .ok_or_else(|| anyhow::anyhow!("orca.yaml must be a mapping at the top level"))?;
            map.insert("dev".into(), minimal_dev_value(&dev));
            let body = serde_yaml::to_string(&doc)?;
            format!("# Orca project settings. Edit here or in Orca's Projects page.\n{body}")
        }
        (None, None) => anyhow::bail!("nothing to write"),
    };
    if req.dry_run {
        return Ok((path, text));
    }
    std::fs::write(&path, &text).with_context(|| format!("could not write {}", path.display()))?;
    if req.gitignore_local {
        ensure_gitignore(&ctx.project.root, "orca.local.yaml")?;
    }
    Ok((path, text))
}

fn ensure_gitignore(root: &Path, entry: &str) -> Result<()> {
    let path = root.join(".gitignore");
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    if text.lines().any(|l| l.trim() == entry) {
        return Ok(());
    }
    let mut new = text;
    if !new.is_empty() && !new.ends_with('\n') {
        new.push('\n');
    }
    new.push_str(entry);
    new.push('\n');
    std::fs::write(&path, new)?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct Validation {
    pub ok: bool,
    pub error: Option<String>,
    /// 1-based line of the error, when YAML says where.
    pub line: Option<usize>,
    pub dev: Option<DevConfig>,
    /// Things that are allowed but will likely cause trouble.
    pub warnings: Vec<String>,
}

/// Parse orca.yaml text and report the first problem with its line.
pub fn validate(text: &str) -> Validation {
    match serde_yaml::from_str::<OrcaYaml>(text) {
        Ok(y) => {
            let pattern = y.dev.as_ref().map(|d| d.naming.hostname.clone()).unwrap_or_default();
            // Render once with example values so typos in the pattern show here.
            let error = y.dev.as_ref().and_then(|d| {
                hostnames::render(
                    &d.naming.hostname,
                    "project",
                    "feature",
                    "web",
                    "localhost",
                    Path::new("/w"),
                )
                .err()
                .map(|e| format!("naming.hostname: {e}"))
            });
            Validation {
                ok: error.is_none(),
                error,
                line: None,
                warnings: {
                    let mut w = if y.dev.is_some() {
                        hostnames::pattern_warnings(&pattern)
                    } else {
                        Vec::new()
                    };
                    w.extend(orca_core::dev::schema::project_warnings(text));
                    w
                },
                dev: y.dev,
            }
        }
        Err(e) => Validation {
            ok: false,
            line: e.location().map(|l| l.line()),
            error: Some(e.to_string()),
            dev: None,
            warnings: Vec::new(),
        },
    }
}

/// The text Orca adds to CLAUDE.md / AGENTS.md so agents use their instance.
pub fn snippet(project: &str) -> String {
    format!(
        "{SNIPPET_START}\n## Running the app (Orca)\n\n\
This repo runs with Orca worktree instances. Each git worktree gets its own running copy of the app; \
databases and other infrastructure (`{project}`'s shared services) run once and are shared.\n\n\
- `orca up` starts or rebuilds this worktree's instance. Run it before testing.\n\
- URLs, ports and connection strings for this instance are in `.orca/env` (load with `eval $(orca env)`).\n\
- `orca status` shows the URLs and service states; `orca logs -f` follows logs.\n\
- `orca down` stops the instance when you're done.\n\
- Orca's MCP server has the same operations (`instance_up`, `instance_status`, …); pass this worktree's path.\n\
{SNIPPET_END}\n"
    )
}

pub async fn add_snippet(state: &AppState, project_id: &str) -> Result<PathBuf> {
    let ctx = ProjectCtx::load(state, project_id).await?;
    let file = agents_file(&ctx.project.root);
    let text = std::fs::read_to_string(&file.path).unwrap_or_default();
    let snip = snippet(&ctx.project.id);
    let new = if let (Some(a), Some(b)) = (text.find(SNIPPET_START), text.find(SNIPPET_END)) {
        format!("{}{}{}", &text[..a], snip.trim_end(), &text[b + SNIPPET_END.len()..])
    } else if text.is_empty() {
        snip
    } else {
        format!("{}{}\n{snip}", text, if text.ends_with('\n') { "" } else { "\n" })
    };
    std::fs::write(&file.path, new)?;
    Ok(file.path)
}

/// Take over an existing stack's data: stop its containers (volumes stay)
/// and run the shared stack under its compose project name.
pub async fn adopt(state: &AppState, project_id: &str, project: &str) -> Result<()> {
    let ctx = ProjectCtx::load(state, project_id).await?;
    let found = find_adoption(state, &ctx.project.root, &ctx.shared_cp())
        .await
        .ok_or_else(|| anyhow::anyhow!("no existing compose stack found for this checkout"))?;
    if found.project != project {
        anyhow::bail!("expected stack '{}', found '{}'", project, found.project);
    }
    ops::compose_ok(
        state,
        &ctx.project.root,
        &["-p".into(), project.to_string(), "down".into()],
        None,
    )
    .await?;
    let mut cfg = state.config.lock().await;
    if let Some(p) = cfg.dev_projects.iter_mut().find(|p| p.id == project_id) {
        p.shared_project = Some(project.to_string());
    }
    cfg.save()?;
    Ok(())
}
