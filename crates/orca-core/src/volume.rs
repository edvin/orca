//! Named volume management.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Volume {
    pub name: String,
    pub driver: String,
    pub mountpoint: String,
    pub labels: HashMap<String, String>,
    pub created_at: String,
}

#[trait_variant::make(Send)]
pub trait VolumeManager {
    async fn list(&self) -> anyhow::Result<Vec<Volume>>;
    async fn create(&self, name: &str, labels: HashMap<String, String>) -> anyhow::Result<Volume>;
    async fn remove(&self, name: &str, force: bool) -> anyhow::Result<()>;
    async fn inspect(&self, name: &str) -> anyhow::Result<Volume>;
    async fn prune(&self) -> anyhow::Result<u64>;
}
