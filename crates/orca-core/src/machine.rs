//! Machine management — abstracts over the VM/environment where containers run.
//!
//! On Linux this can be native (no VM), on macOS it's Lima/vfkit,
//! on Windows it's WSL2.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::runtime::RuntimeKind;

/// Configuration for creating a new machine.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MachineConfig {
    pub name: String,
    pub cpus: u32,
    pub memory_mb: u64,
    pub disk_gb: u64,
    pub runtime: RuntimeKind,
    /// Directories on the host to mount into the machine.
    pub mounts: Vec<MountConfig>,
}

impl Default for MachineConfig {
    fn default() -> Self {
        Self {
            name: "default".into(),
            cpus: 2,
            memory_mb: 4096,
            disk_gb: 60,
            runtime: RuntimeKind::Podman,
            mounts: vec![MountConfig {
                host_path: dirs::home_dir().unwrap_or_default(),
                guest_path: PathBuf::from("/home/user"),
                writable: true,
            }],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MountConfig {
    pub host_path: PathBuf,
    pub guest_path: PathBuf,
    pub writable: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MachineState {
    Stopped,
    Starting,
    Running,
    Stopping,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MachineInfo {
    pub name: String,
    pub state: MachineState,
    pub config: MachineConfig,
    pub backend: MachineBackend,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MachineBackend {
    /// Direct host execution (Linux).
    Native,
    /// Lima VM (macOS).
    Lima,
    /// Apple Virtualization.framework via vfkit (macOS).
    Vfkit,
    /// WSL2 distribution (Windows).
    Wsl2,
}

/// Trait for managing the machine lifecycle.
/// Each platform provides its own implementation.
#[trait_variant::make(Send)]
pub trait MachineManager {
    /// Create a new machine with the given config.
    async fn create(&self, config: MachineConfig) -> anyhow::Result<MachineInfo>;

    /// Start a stopped machine.
    async fn start(&self, name: &str) -> anyhow::Result<()>;

    /// Stop a running machine gracefully.
    async fn stop(&self, name: &str) -> anyhow::Result<()>;

    /// Force-stop a machine.
    async fn kill(&self, name: &str) -> anyhow::Result<()>;

    /// Delete a machine and its resources.
    async fn delete(&self, name: &str) -> anyhow::Result<()>;

    /// Get info about a specific machine.
    async fn inspect(&self, name: &str) -> anyhow::Result<MachineInfo>;

    /// List all machines.
    async fn list(&self) -> anyhow::Result<Vec<MachineInfo>>;

    /// Get the socket path for communicating with the container runtime
    /// inside this machine.
    async fn runtime_socket(&self, name: &str) -> anyhow::Result<PathBuf>;
}
