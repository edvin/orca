//! Container image management.

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

#[trait_variant::make(Send)]
pub trait ImageManager {
    async fn list(&self) -> anyhow::Result<Vec<Image>>;
    async fn pull(
        &self,
        reference: &str,
    ) -> anyhow::Result<tokio::sync::mpsc::Receiver<PullProgress>>;
    async fn remove(&self, id: &str, force: bool) -> anyhow::Result<()>;
    async fn inspect(&self, id: &str) -> anyhow::Result<Image>;
    async fn prune(&self) -> anyhow::Result<u64>;
}
