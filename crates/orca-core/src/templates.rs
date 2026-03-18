use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
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
}
