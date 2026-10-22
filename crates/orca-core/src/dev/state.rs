//! What Orca remembers about registered projects and their instances.
//! Stored in the main Orca config file.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::schema::DataMode;

/// A git repo registered with Orca.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DevProject {
    /// Slug used in compose project names and URLs (`myapp`).
    pub id: String,
    /// Path of the main working tree (the original clone).
    pub root: PathBuf,
    pub added_at: String,
    /// Compose project of the shared stack when it took over an existing
    /// stack's data (adoption); `None` uses `<id>-shared`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shared_project: Option<String>,
    #[serde(default)]
    pub instances: Vec<DevInstanceState>,
}

/// Per-worktree choices and assignments. Created the first time an instance
/// is configured or started; a worktree without one shows as "not deployed".
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DevInstanceState {
    /// Worktree path. The stable identity of the instance.
    pub path: PathBuf,
    /// Instance name, fixed once chosen so URLs don't move when a branch is
    /// renamed. Changed only by an explicit rename.
    pub name: String,
    /// Service → hostname, replacing the pattern for that service.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub hostname_overrides: BTreeMap<String, String>,
    /// Compose profiles this instance runs, besides the services without one.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub profiles: Vec<String>,
    /// Shared service → data mode, overriding the project default.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub data_modes: BTreeMap<String, DataMode>,
    /// Shared service → this instance's database in it (own-database mode).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub tenants: BTreeMap<String, String>,
    /// Host ports handed out to this instance.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ports: Vec<PortAssignment>,
    /// Who last started it ("ui", "cli", "mcp").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_started: Option<String>,
    /// Services run as processes on the host (`orca run --serve`): service →
    /// host port, kept stable for the worktree.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub host_services: BTreeMap<String, u16>,
    /// Set when Orca stopped the instance for being idle; cleared on start.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idle_stopped_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PortAssignment {
    pub service: String,
    pub container_port: u16,
    pub host_port: u16,
}

impl DevProject {
    pub fn instance_by_path(&self, path: &Path) -> Option<&DevInstanceState> {
        self.instances.iter().find(|i| i.path == path)
    }

    pub fn instance_by_path_mut(&mut self, path: &Path) -> Option<&mut DevInstanceState> {
        self.instances.iter_mut().find(|i| i.path == path)
    }
}

/// Pick a free host port for `service:container_port`, reusing an existing
/// assignment when there is one. `taken` holds every port already handed out
/// by Orca; `is_free` checks the OS (another program may hold the port).
pub fn assign_port(
    existing: &[PortAssignment],
    service: &str,
    container_port: u16,
    taken: &[u16],
    is_free: impl Fn(u16) -> bool,
) -> anyhow::Result<PortAssignment> {
    if let Some(a) = existing
        .iter()
        .find(|a| a.service == service && a.container_port == container_port)
        && is_free(a.host_port)
    {
        return Ok(a.clone());
    }
    let host_port = super::PORT_RANGE
        .clone()
        .find(|p| !taken.contains(p) && is_free(*p))
        .ok_or_else(|| {
            anyhow::anyhow!(
                "no free host port left in {}-{}",
                super::PORT_RANGE.start(),
                super::PORT_RANGE.end()
            )
        })?;
    Ok(PortAssignment {
        service: service.to_string(),
        container_port,
        host_port,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reuses_existing_port_when_free() {
        let existing = vec![PortAssignment {
            service: "api".into(),
            container_port: 9229,
            host_port: 41005,
        }];
        let a = assign_port(&existing, "api", 9229, &[41005], |_| true).unwrap();
        assert_eq!(a.host_port, 41005);
    }

    #[test]
    fn reassigns_when_existing_port_is_busy() {
        let existing = vec![PortAssignment {
            service: "api".into(),
            container_port: 9229,
            host_port: 41000,
        }];
        let a = assign_port(&existing, "api", 9229, &[41000], |p| p != 41000).unwrap();
        assert_eq!(a.host_port, 41001);
    }

    #[test]
    fn skips_taken_ports() {
        let a = assign_port(&[], "db", 5432, &[41000, 41001], |_| true).unwrap();
        assert_eq!(a.host_port, 41002);
    }

    #[test]
    fn state_roundtrip_omits_empty_fields() {
        let p = DevProject {
            id: "myapp".into(),
            root: "/code/myapp".into(),
            added_at: "2026-10-14T00:00:00Z".into(),
            shared_project: None,
            instances: vec![DevInstanceState {
                path: "/code/myapp-feat".into(),
                name: "feat".into(),
                ..Default::default()
            }],
        };
        let json = serde_json::to_string(&p).unwrap();
        assert!(!json.contains("hostname_overrides"), "{json}");
        let back: DevProject = serde_json::from_str(&json).unwrap();
        assert_eq!(back.instances[0].name, "feat");
    }
}
