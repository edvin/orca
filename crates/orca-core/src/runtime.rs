//! Container runtime abstraction — wraps podman or docker.
//!
//! Commands are sent to whichever runtime is installed inside the machine.
//! The API surface is intentionally docker-compatible since podman mirrors it.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RuntimeKind {
    Podman,
    Docker,
}

/// A running or stopped container.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Container {
    pub id: String,
    pub name: String,
    pub image: String,
    pub state: ContainerState,
    pub ports: Vec<PortMapping>,
    pub labels: HashMap<String, String>,
    pub created_at: String,
    /// Debug info — populated from inspect for failed/exited containers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oom_killed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mounts: Option<Vec<ContainerMount>>,
}

/// A bind mount or volume mount on a container.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContainerMount {
    pub source: String,
    pub destination: String,
    pub mode: String,
    pub rw: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ContainerState {
    Created,
    Running,
    Paused,
    Restarting,
    Exited,
    Dead,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortMapping {
    pub host_ip: Option<String>,
    pub host_port: u16,
    pub container_port: u16,
    pub protocol: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContainerCreateOpts {
    pub image: String,
    pub name: Option<String>,
    pub command: Vec<String>,
    pub env: HashMap<String, String>,
    pub ports: Vec<PortMapping>,
    pub volumes: Vec<VolumeMount>,
    pub labels: HashMap<String, String>,
    pub restart_policy: Option<String>,
    pub network: Option<String>,
    pub detach: bool,
    pub remove_on_exit: bool,
    /// CPU cores limit (e.g., 0.5, 2.0).
    pub cpu_limit: Option<f64>,
    /// Memory limit in bytes.
    pub memory_limit: Option<u64>,
    /// Swap limit in bytes (-1 for unlimited).
    pub memory_swap: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VolumeMount {
    pub source: String,
    pub target: String,
    pub read_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecOpts {
    pub container: String,
    pub command: Vec<String>,
    pub interactive: bool,
    pub tty: bool,
    pub env: HashMap<String, String>,
    pub workdir: Option<String>,
}

/// Resource usage stats for a container.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContainerStats {
    pub container_id: String,
    pub cpu_percent: f64,
    pub memory_usage_bytes: u64,
    pub memory_limit_bytes: u64,
    pub network_rx_bytes: u64,
    pub network_tx_bytes: u64,
    pub block_read_bytes: u64,
    pub block_write_bytes: u64,
}

/// Trait for interacting with a container runtime.
/// Implementors talk to the runtime socket (podman or docker).
#[trait_variant::make(Send)]
pub trait ContainerRuntime {
    fn kind(&self) -> RuntimeKind;

    // Container operations
    async fn create_container(&self, opts: ContainerCreateOpts) -> anyhow::Result<String>;
    async fn start_container(&self, id: &str) -> anyhow::Result<()>;
    async fn stop_container(&self, id: &str, timeout_secs: u32) -> anyhow::Result<()>;
    async fn kill_container(&self, id: &str, signal: &str) -> anyhow::Result<()>;
    async fn remove_container(&self, id: &str, force: bool) -> anyhow::Result<()>;
    async fn inspect_container(&self, id: &str) -> anyhow::Result<Container>;
    async fn list_containers(&self, all: bool) -> anyhow::Result<Vec<Container>>;
    async fn container_logs(
        &self,
        id: &str,
        follow: bool,
        tail: Option<u32>,
    ) -> anyhow::Result<tokio::sync::mpsc::Receiver<String>>;
    async fn container_stats(&self, id: &str) -> anyhow::Result<ContainerStats>;

    // Exec
    async fn exec(&self, opts: ExecOpts) -> anyhow::Result<ExecResult>;
}

/// Result from executing a command inside a container.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecResult {
    pub exit_code: i32,
    pub output: String,
}
