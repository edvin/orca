//! Compose project awareness — detects and groups containers by compose project,
//! and provides compose CLI operations (up/down/restart).

use serde::{Deserialize, Serialize};

use crate::runtime::{Container, ContainerState};

/// A compose project (stack) is a group of containers that share
/// the `com.docker.compose.project` label.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComposeProject {
    pub name: String,
    pub working_dir: Option<String>,
    pub config_file: Option<String>,
    pub services: Vec<ComposeService>,
    pub status: ProjectStatus,
}

/// A single service within a compose project.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComposeService {
    pub name: String,
    pub container_id: String,
    pub container_name: String,
    pub image: String,
    pub state: ContainerState,
    pub ports: Vec<crate::runtime::PortMapping>,
}

/// Overall status of a compose project, derived from its services.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProjectStatus {
    /// All services are running.
    Running,
    /// Some services running, some not.
    Partial,
    /// All services are stopped/exited.
    Stopped,
    /// No services found (shouldn't happen).
    Empty,
}

/// Output from a compose CLI operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComposeOutput {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

const LABEL_PROJECT: &str = "com.docker.compose.project";
const LABEL_SERVICE: &str = "com.docker.compose.service";
const LABEL_WORKING_DIR: &str = "com.docker.compose.project.working_dir";
const LABEL_CONFIG_FILES: &str = "com.docker.compose.project.config_files";

/// Extract compose projects from a list of containers.
/// Containers without compose labels are ignored.
pub fn extract_projects(containers: &[Container]) -> Vec<ComposeProject> {
    let mut projects: std::collections::BTreeMap<String, Vec<&Container>> =
        std::collections::BTreeMap::new();

    for c in containers {
        if let Some(project_name) = c.labels.get(LABEL_PROJECT) {
            projects
                .entry(project_name.clone())
                .or_default()
                .push(c);
        }
    }

    projects
        .into_iter()
        .map(|(name, containers)| {
            let working_dir = containers
                .first()
                .and_then(|c| c.labels.get(LABEL_WORKING_DIR).cloned());
            let config_file = containers
                .first()
                .and_then(|c| c.labels.get(LABEL_CONFIG_FILES).cloned());

            let services: Vec<ComposeService> = containers
                .iter()
                .map(|c| {
                    let service_name = c
                        .labels
                        .get(LABEL_SERVICE)
                        .cloned()
                        .unwrap_or_else(|| c.name.clone());

                    ComposeService {
                        name: service_name,
                        container_id: c.id.clone(),
                        container_name: c.name.clone(),
                        image: c.image.clone(),
                        state: c.state,
                        ports: c.ports.clone(),
                    }
                })
                .collect();

            let running_count = services
                .iter()
                .filter(|s| s.state == ContainerState::Running)
                .count();
            let total = services.len();

            let status = if total == 0 {
                ProjectStatus::Empty
            } else if running_count == total {
                ProjectStatus::Running
            } else if running_count == 0 {
                ProjectStatus::Stopped
            } else {
                ProjectStatus::Partial
            };

            ComposeProject {
                name,
                working_dir,
                config_file,
                services,
                status,
            }
        })
        .collect()
}

/// Trait for running compose CLI operations.
#[trait_variant::make(Send)]
pub trait ComposeRunner {
    /// Run `docker compose up -d` in the project directory.
    async fn compose_up(&self, working_dir: &str, config_file: Option<&str>) -> anyhow::Result<ComposeOutput>;

    /// Run `docker compose down` in the project directory.
    async fn compose_down(&self, working_dir: &str, config_file: Option<&str>) -> anyhow::Result<ComposeOutput>;

    /// Run `docker compose restart` in the project directory.
    async fn compose_restart(&self, working_dir: &str, config_file: Option<&str>) -> anyhow::Result<ComposeOutput>;

    /// Run `docker compose pull` in the project directory.
    async fn compose_pull(&self, working_dir: &str, config_file: Option<&str>) -> anyhow::Result<ComposeOutput>;
}
