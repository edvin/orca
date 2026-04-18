use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// A build target defined in orca.yaml.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildTarget {
    pub name: String,
    pub context: String,
    #[serde(default = "default_dockerfile")]
    pub dockerfile: String,
    pub tag: String,
    #[serde(default)]
    pub args: HashMap<String, String>,
    /// The stack directory where this target was found.
    #[serde(default)]
    pub stack_dir: String,
}

fn default_dockerfile() -> String {
    "Dockerfile".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildRecord {
    pub id: String,
    pub status: BuildStatus,
    pub tag: String,
    pub context_path: String,
    pub dockerfile: String,
    #[serde(default)]
    pub build_args: HashMap<String, String>,
    pub started_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_secs: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default)]
    pub log_lines: u64,
    #[serde(default)]
    pub source: BuildSource,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum BuildStatus {
    #[default]
    InProgress,
    Success,
    Failed,
    Cancelled,
    /// Forward-compat catch-all for states a newer daemon can emit but
    /// older clients don't know about.
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum BuildSource {
    #[default]
    Manual,
    FileWatch,
    Scheduled,
    Webhook,
    Url,
    External,
    /// Forward-compat catch-all for sources a newer daemon can emit but
    /// older clients don't know about.
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheAnalysis {
    pub total_steps: u32,
    pub cached_steps: u32,
}
