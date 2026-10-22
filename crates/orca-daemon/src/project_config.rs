//! `orca.yaml` of every compose project Orca can see.
//!
//! Compose labels its containers with the project's folder
//! (`com.docker.compose.project.working_dir`), so a project gets its
//! `orca.yaml` (routes, links, builds, hooks) applied however it was
//! started: from Orca, from its stacks folder, or with plain
//! `docker compose up` in a checkout. Files are re-read when they change.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use orca_core::dev::OrcaYaml;
use orca_core::runtime::{Container, ContainerState};

const PROJECT_LABEL: &str = "com.docker.compose.project";
const WORKING_DIR_LABEL: &str = "com.docker.compose.project.working_dir";
const SERVICE_LABEL: &str = "com.docker.compose.service";

/// A compose project with an `orca.yaml` next to it.
pub struct Project {
    /// The compose project name.
    pub name: String,
    pub dir: PathBuf,
    pub yaml: OrcaYaml,
    /// The project's containers, running or not.
    pub containers: Vec<Container>,
}

impl Project {
    pub fn running(&self) -> bool {
        self.containers.iter().any(|c| c.state == ContainerState::Running)
    }

    /// The container of `service`, a running one if there is one.
    pub fn container_of(&self, service: &str) -> Option<&Container> {
        let mut of_service = self
            .containers
            .iter()
            .filter(|c| c.labels.get(SERVICE_LABEL).map(String::as_str) == Some(service));
        let first = of_service.next()?;
        if first.state == ContainerState::Running {
            return Some(first);
        }
        of_service.find(|c| c.state == ContainerState::Running).or(Some(first))
    }
}

/// Compose projects among `containers` that have an `orca.yaml`. Worktree
/// instances and their shared stacks are left out: `dev:` configures those.
pub fn discover(containers: &[Container]) -> Vec<Project> {
    let mut by_project: BTreeMap<&str, (Option<&str>, Vec<&Container>, bool)> = BTreeMap::new();
    for c in containers {
        let Some(name) = c.labels.get(PROJECT_LABEL) else {
            continue;
        };
        let entry = by_project.entry(name).or_default();
        if entry.0.is_none() {
            entry.0 = c.labels.get(WORKING_DIR_LABEL).map(String::as_str);
        }
        entry.1.push(c);
        entry.2 |= c.labels.keys().any(|k| k.starts_with("orca.dev."));
    }
    by_project
        .into_iter()
        .filter(|(_, (_, _, dev))| !dev)
        .filter_map(|(name, (dir, containers, _))| {
            let dir = PathBuf::from(dir?);
            let yaml = load_cached(&dir)?;
            Some(Project {
                name: name.to_string(),
                dir,
                yaml,
                containers: containers.into_iter().cloned().collect(),
            })
        })
        .collect()
}

/// `orca.yaml` (with `orca.local.yaml`) in `dir`, re-read only when either
/// file changes. `None` without an `orca.yaml` or when it doesn't parse.
fn load_cached(dir: &Path) -> Option<OrcaYaml> {
    type Stamp = (Option<SystemTime>, Option<SystemTime>);
    type Cache = HashMap<PathBuf, (Stamp, Option<OrcaYaml>)>;
    static CACHE: Mutex<Option<Cache>> = Mutex::new(None);

    let mtime = |f: &str| std::fs::metadata(dir.join(f)).and_then(|m| m.modified()).ok();
    let stamp = (mtime("orca.yaml"), mtime("orca.local.yaml"));
    stamp.0?;
    let mut cache = CACHE.lock().unwrap();
    let cache = cache.get_or_insert_with(HashMap::new);
    if let Some((seen, yaml)) = cache.get(dir)
        && *seen == stamp
    {
        return yaml.clone();
    }
    let yaml = match OrcaYaml::load(dir) {
        Ok(y) => Some(y),
        Err(e) => {
            tracing::warn!("{}: {e:#}", dir.join("orca.yaml").display());
            None
        }
    };
    cache.insert(dir.to_path_buf(), (stamp, yaml.clone()));
    yaml
}

/// A hostname from `orca.yaml` or a label with `{domain}` filled in, and the
/// gateway's domain added when it has no dot (`app` → `app.localhost`).
pub fn qualify_hostname(host: &str, domain: &str) -> String {
    let host = host.trim().replace("{domain}", domain).to_lowercase();
    if host.contains('.') {
        host
    } else {
        format!("{host}.{domain}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn container(project: &str, service: &str, dir: &str, running: bool) -> Container {
        serde_json::from_value(serde_json::json!({
            "id": format!("{project}-{service}"),
            "name": format!("{project}-{service}-1"),
            "image": "img",
            "state": if running { "Running" } else { "Exited" },
            "ports": [],
            "labels": { PROJECT_LABEL: project, SERVICE_LABEL: service, WORKING_DIR_LABEL: dir },
            "created_at": "",
        }))
        .unwrap()
    }

    #[test]
    fn finds_projects_with_an_orca_yaml_and_skips_the_rest() {
        let with = tempfile::tempdir().unwrap();
        std::fs::write(
            with.path().join("orca.yaml"),
            "gateway:\n  - {hostname: shop, service: web, port: 3000}\n",
        )
        .unwrap();
        let without = tempfile::tempdir().unwrap();
        let (w, wo) = (with.path().to_str().unwrap(), without.path().to_str().unwrap());
        let mut instance = container("shop-feature", "web", w, true);
        instance.labels.insert("orca.dev.project".into(), "shop".into());

        let found = discover(&[
            container("shop", "web", w, true),
            container("shop", "db", w, false),
            container("other", "web", wo, true),
            instance,
        ]);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "shop");
        assert_eq!(found[0].yaml.gateway[0].service, "web");
        assert_eq!(found[0].container_of("web").unwrap().name, "shop-web-1");
        assert!(found[0].running());
    }

    #[test]
    fn qualifies_bare_hostnames() {
        assert_eq!(qualify_hostname("app", "localhost"), "app.localhost");
        assert_eq!(qualify_hostname("api.{domain}", "dev.test"), "api.dev.test");
        assert_eq!(qualify_hostname("Shop.Example.com", "x"), "shop.example.com");
    }
}
