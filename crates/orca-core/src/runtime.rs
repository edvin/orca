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
    /// Memory limit in bytes (0 = unlimited).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_limit: Option<u64>,
    /// CPU cores limit (e.g. 0.5, 2.0; 0 = unlimited).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu_limit: Option<f64>,
    /// Restart policy name: "no", "always", "unless-stopped", "on-failure".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restart_policy: Option<String>,
    /// Health check status: "healthy", "unhealthy", "starting", "none".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub health_status: Option<String>,
    /// Recent health check log entries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub health_log: Option<Vec<HealthLogEntry>>,
    /// Number of times the container has been restarted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restart_count: Option<i64>,
}

/// A single health check log entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthLogEntry {
    pub output: String,
    pub exit_code: i64,
    pub started_at: String,
    pub finished_at: String,
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
    /// Override the image's entrypoint. Use vec![""] to clear it entirely.
    pub entrypoint: Option<Vec<String>>,
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
    /// Request GPU access (--gpus all). Requires NVIDIA Container Toolkit.
    #[serde(default)]
    pub gpu: bool,
    /// Run as specific user (e.g., "1000:1000"). Maps to Docker's --user flag.
    #[serde(default)]
    pub user: Option<String>,
    /// Extra /etc/hosts entries (e.g., "host.docker.internal:host-gateway").
    #[serde(default)]
    pub extra_hosts: Vec<String>,
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

/// Options for updating a container's resource limits.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContainerUpdateOpts {
    /// Memory limit in bytes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_limit: Option<u64>,
    /// Memory+swap limit in bytes (-1 for unlimited).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_swap: Option<i64>,
    /// CPU cores limit (e.g. 0.5, 2.0). Converted to NanoCPUs internally.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu_limit: Option<f64>,
    /// Restart policy: "no", "always", "unless-stopped", "on-failure".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restart_policy: Option<String>,
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
    async fn update_container(&self, id: &str, opts: ContainerUpdateOpts) -> anyhow::Result<()>;
    async fn rename_container(&self, id: &str, new_name: &str) -> anyhow::Result<()>;

    // Exec
    async fn exec(&self, opts: ExecOpts) -> anyhow::Result<ExecResult>;
}

/// Result from executing a command inside a container.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecResult {
    pub exit_code: i32,
    pub output: String,
}
