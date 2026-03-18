//! Container network management and port forwarding.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Network {
    pub id: String,
    pub name: String,
    pub driver: String,
    pub subnet: Option<String>,
    pub gateway: Option<String>,
    pub labels: HashMap<String, String>,
}

#[trait_variant::make(Send)]
pub trait NetworkManager {
    async fn list(&self) -> anyhow::Result<Vec<Network>>;
    async fn create(&self, name: &str, driver: &str) -> anyhow::Result<Network>;
    async fn remove(&self, name: &str) -> anyhow::Result<()>;
    async fn inspect(&self, name: &str) -> anyhow::Result<Network>;
    async fn connect(&self, network: &str, container: &str) -> anyhow::Result<()>;
    async fn disconnect(&self, network: &str, container: &str) -> anyhow::Result<()>;
}
