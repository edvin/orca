use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AppTemplate {
    pub id: String,
    pub name: String,
    pub description: String,
    pub icon: String,
    pub category: String,
    pub image: String,
    pub default_ports: Vec<String>,
    pub default_env: Vec<String>,
    pub default_volumes: Vec<String>,
    pub restart_policy: String,
    pub notes: String,
    /// Whether this is a builtin template (read-only) or user-created.
    #[serde(default)]
    pub is_builtin: bool,
    /// Optional docker-compose YAML content. When set, deploys as a compose stack
    /// instead of a single container.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compose_yaml: Option<String>,
}
