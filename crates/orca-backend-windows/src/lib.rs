//! Windows backend for Orca.
//!
//! On Windows, containers run inside a dedicated WSL2 distribution.
//! This backend handles:
//!
//! 1. WSL2 distro lifecycle via `wsl.exe` CLI
//! 2. Container runtime communication via named pipe or TCP forwarding
//!    from the WSL2 instance
//! 3. File sharing via WSL2's built-in 9P/virtiofs mount
//! 4. Port forwarding from WSL2 to Windows host
//!
//! Architecture:
//! - We create/import a minimal Linux distro into WSL2 ("orca")
//! - Install Docker or Podman inside it
//! - Forward the Docker socket to a Windows named pipe or localhost TCP
//! - All container operations go through the forwarded socket via bollard

mod wsl;

use std::path::PathBuf;

/// Windows backend that manages a WSL2 distro with a container runtime inside.
pub struct WindowsBackend {
    /// Connection to the container runtime inside WSL2.
    docker: bollard::Docker,
    /// WSL2 distro name.
    distro_name: String,
}

impl WindowsBackend {
    /// Connect to the container runtime in an existing WSL2 distro.
    /// On Windows, bollard can connect via TCP (forwarded from WSL2).
    pub fn connect(distro_name: &str) -> anyhow::Result<Self> {
        // The daemon inside WSL2 forwards to localhost:2375
        // or via a named pipe at //./pipe/orca-docker
        let docker = bollard::Docker::connect_with_local_defaults()?;

        Ok(Self {
            docker,
            distro_name: distro_name.to_string(),
        })
    }

    /// Connect via explicit TCP address (used when WSL2 forwards the socket).
    pub fn connect_tcp(_addr: &str) -> anyhow::Result<Self> {
        let docker = bollard::Docker::connect_with_http_defaults()?;

        Ok(Self {
            docker,
            distro_name: "orca".to_string(),
        })
    }

    /// Detect the runtime kind inside the WSL2 distro.
    pub async fn detect_runtime(&self) -> orca_core::runtime::RuntimeKind {
        if let Ok(version) = self.docker.version().await {
            if let Some(components) = version.components {
                for c in &components {
                    if c.name.to_lowercase().contains("podman") {
                        return orca_core::runtime::RuntimeKind::Podman;
                    }
                }
            }
        }
        orca_core::runtime::RuntimeKind::Docker
    }
}
