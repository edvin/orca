//! Container image management.

use std::collections::HashMap;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Image {
    pub id: String,
    pub repo_tags: Vec<String>,
    pub size_bytes: u64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PullProgress {
    pub layer: String,
    pub status: String,
    pub current: u64,
    pub total: u64,
}

/// Progress event from an image build.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildProgress {
    pub stream: String,
    #[serde(default)]
    pub error: Option<String>,
}

/// Result of an image build.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildResult {
    pub image_id: Option<String>,
    pub success: bool,
    pub logs: Vec<String>,
}

/// Result of an image tag operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TagResult {
    pub success: bool,
}

/// Result of a prune operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PruneResult {
    pub images_deleted: Vec<String>,
    pub space_reclaimed: u64,
}

/// Credentials for authenticating with a container registry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegistryAuth {
    pub username: String,
    pub password: String,
    pub server: Option<String>,
}

#[trait_variant::make(Send)]
pub trait ImageManager {
    async fn list(&self) -> anyhow::Result<Vec<Image>>;
    async fn pull(
        &self,
        reference: &str,
    ) -> anyhow::Result<tokio::sync::mpsc::Receiver<PullProgress>>;
    async fn remove(&self, id: &str, force: bool) -> anyhow::Result<()>;
    async fn inspect(&self, id: &str) -> anyhow::Result<Image>;
    async fn prune(&self) -> anyhow::Result<PruneResult>;
    async fn tag(&self, source: &str, repo: &str, tag: &str) -> anyhow::Result<()>;
    async fn build(
        &self,
        context_path: &str,
        dockerfile: Option<&str>,
        tag: Option<&str>,
        build_args: Option<HashMap<String, String>>,
    ) -> anyhow::Result<tokio::sync::mpsc::Receiver<BuildProgress>>;
}
