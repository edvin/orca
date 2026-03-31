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
    let mut projects: std::collections::BTreeMap<String, Vec<&Container>> = std::collections::BTreeMap::new();

    for c in containers {
        if let Some(project_name) = c.labels.get(LABEL_PROJECT) {
            projects.entry(project_name.clone()).or_default().push(c);
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
                    let service_name = c.labels.get(LABEL_SERVICE).cloned().unwrap_or_else(|| c.name.clone());

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

            let running_count = services.iter().filter(|s| s.state == ContainerState::Running).count();
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// Helper: build a Container with compose labels.
    fn make_container(
        id: &str,
        name: &str,
        image: &str,
        state: ContainerState,
        project: Option<&str>,
        service: Option<&str>,
        working_dir: Option<&str>,
        config_file: Option<&str>,
    ) -> Container {
        let mut labels = HashMap::new();
        if let Some(p) = project {
            labels.insert("com.docker.compose.project".into(), p.into());
        }
        if let Some(s) = service {
            labels.insert("com.docker.compose.service".into(), s.into());
        }
        if let Some(w) = working_dir {
            labels.insert("com.docker.compose.project.working_dir".into(), w.into());
        }
        if let Some(c) = config_file {
            labels.insert("com.docker.compose.project.config_files".into(), c.into());
        }

        Container {
            id: id.into(),
            name: name.into(),
            image: image.into(),
            state,
            ports: vec![],
            labels,
            created_at: "2025-01-01T00:00:00Z".into(),
            exit_code: None,
            error: None,
            oom_killed: None,
            started_at: None,
            finished_at: None,
            command: None,
            env: None,
            mounts: None,
        }
    }

    /// Shorthand: compose-labeled container with common defaults.
    fn compose_container(id: &str, project: &str, service: &str, state: ContainerState) -> Container {
        make_container(
            id,
            &format!("{}-{}-1", project, service),
            &format!("{}:latest", service),
            state,
            Some(project),
            Some(service),
            Some(&format!("/home/user/{}", project)),
            Some(&format!("/home/user/{}/docker-compose.yml", project)),
        )
    }

    #[test]
    fn empty_container_list_returns_empty_projects() {
        let projects = extract_projects(&[]);
        assert!(projects.is_empty());
    }

    #[test]
    fn containers_without_compose_labels_are_ignored() {
        let containers = vec![
            make_container(
                "c1",
                "nginx",
                "nginx:latest",
                ContainerState::Running,
                None,
                None,
                None,
                None,
            ),
            make_container(
                "c2",
                "redis",
                "redis:latest",
                ContainerState::Running,
                None,
                None,
                None,
                None,
            ),
        ];
        let projects = extract_projects(&containers);
        assert!(projects.is_empty());
    }

    #[test]
    fn containers_with_same_project_are_grouped() {
        let containers = vec![
            compose_container("c1", "myapp", "web", ContainerState::Running),
            compose_container("c2", "myapp", "db", ContainerState::Running),
        ];
        let projects = extract_projects(&containers);
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].name, "myapp");
        assert_eq!(projects[0].services.len(), 2);
    }

    #[test]
    fn multiple_projects_are_separated() {
        let containers = vec![
            compose_container("c1", "app1", "web", ContainerState::Running),
            compose_container("c2", "app2", "api", ContainerState::Exited),
        ];
        let projects = extract_projects(&containers);
        assert_eq!(projects.len(), 2);
        // BTreeMap ensures alphabetical order
        assert_eq!(projects[0].name, "app1");
        assert_eq!(projects[1].name, "app2");
    }

    #[test]
    fn status_running_when_all_services_running() {
        let containers = vec![
            compose_container("c1", "proj", "web", ContainerState::Running),
            compose_container("c2", "proj", "db", ContainerState::Running),
            compose_container("c3", "proj", "cache", ContainerState::Running),
        ];
        let projects = extract_projects(&containers);
        assert_eq!(projects[0].status, ProjectStatus::Running);
    }

    #[test]
    fn status_partial_when_some_running() {
        let containers = vec![
            compose_container("c1", "proj", "web", ContainerState::Running),
            compose_container("c2", "proj", "db", ContainerState::Exited),
        ];
        let projects = extract_projects(&containers);
        assert_eq!(projects[0].status, ProjectStatus::Partial);
    }

    #[test]
    fn status_stopped_when_none_running() {
        let containers = vec![
            compose_container("c1", "proj", "web", ContainerState::Exited),
            compose_container("c2", "proj", "db", ContainerState::Exited),
        ];
        let projects = extract_projects(&containers);
        assert_eq!(projects[0].status, ProjectStatus::Stopped);
    }

    #[test]
    fn working_dir_and_config_file_extracted_from_labels() {
        let containers = vec![compose_container("c1", "myproj", "web", ContainerState::Running)];
        let projects = extract_projects(&containers);
        assert_eq!(projects[0].working_dir.as_deref(), Some("/home/user/myproj"));
        assert_eq!(
            projects[0].config_file.as_deref(),
            Some("/home/user/myproj/docker-compose.yml")
        );
    }

    #[test]
    fn working_dir_none_when_label_missing() {
        let containers = vec![make_container(
            "c1",
            "web-1",
            "nginx:latest",
            ContainerState::Running,
            Some("proj"),
            Some("web"),
            None,
            None,
        )];
        let projects = extract_projects(&containers);
        assert!(projects[0].working_dir.is_none());
        assert!(projects[0].config_file.is_none());
    }

    #[test]
    fn service_names_extracted_from_label() {
        let containers = vec![
            compose_container("c1", "proj", "frontend", ContainerState::Running),
            compose_container("c2", "proj", "backend", ContainerState::Running),
        ];
        let projects = extract_projects(&containers);
        let service_names: Vec<&str> = projects[0].services.iter().map(|s| s.name.as_str()).collect();
        assert!(service_names.contains(&"frontend"));
        assert!(service_names.contains(&"backend"));
    }

    #[test]
    fn service_name_falls_back_to_container_name_without_label() {
        let containers = vec![make_container(
            "c1",
            "my-container",
            "nginx:latest",
            ContainerState::Running,
            Some("proj"),
            None,
            None,
            None,
        )];
        let projects = extract_projects(&containers);
        assert_eq!(projects[0].services[0].name, "my-container");
    }

    #[test]
    fn mixed_compose_and_standalone_containers() {
        let containers = vec![
            compose_container("c1", "proj", "web", ContainerState::Running),
            make_container(
                "c2",
                "standalone",
                "redis:latest",
                ContainerState::Running,
                None,
                None,
                None,
                None,
            ),
            compose_container("c3", "proj", "db", ContainerState::Running),
        ];
        let projects = extract_projects(&containers);
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].services.len(), 2);
    }

    #[test]
    fn service_fields_match_container_data() {
        let containers = vec![compose_container("abc123", "proj", "web", ContainerState::Running)];
        let projects = extract_projects(&containers);
        let svc = &projects[0].services[0];
        assert_eq!(svc.container_id, "abc123");
        assert_eq!(svc.container_name, "proj-web-1");
        assert_eq!(svc.image, "web:latest");
        assert_eq!(svc.state, ContainerState::Running);
    }
}
