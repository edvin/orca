//! macOS backend for Orca.
//!
//! On macOS, containers run inside a lightweight Linux VM managed by Lima
//! (or vfkit). This backend handles:
//!
//! 1. VM lifecycle via `limactl` CLI (create, start, stop, delete)
//! 2. Container runtime communication via the Docker-compatible socket
//!    forwarded from inside the VM
//! 3. File sharing via virtiofs for near-native mount performance
//! 4. Port forwarding from VM to host
//!
//! The container runtime (Podman or Docker) runs inside the Lima VM.
//! Once the VM is running, we talk to it via the same bollard API as
//! the native backend — the only difference is how we get the socket.

mod vm;

use std::path::PathBuf;

/// macOS backend that manages a Lima VM with a container runtime inside.
pub struct MacOSBackend {
    /// Connection to the container runtime inside the VM.
    docker: bollard::Docker,
    /// Path to the forwarded socket on the host.
    socket_path: PathBuf,
    /// Lima instance name.
    vm_name: String,
}

impl MacOSBackend {
    /// Create a new backend, connecting to an existing Lima VM.
    /// The VM must already be running with a container runtime inside.
    pub fn connect(vm_name: &str) -> anyhow::Result<Self> {
        let socket_path = lima_socket_path(vm_name);

        if !socket_path.exists() {
            anyhow::bail!(
                "Lima VM '{vm_name}' socket not found at {}. \
                 Is the VM running? Try: limactl start {vm_name}",
                socket_path.display()
            );
        }

        let docker = bollard::Docker::connect_with_unix(
            socket_path.to_str().unwrap(),
            120,
            bollard::API_DEFAULT_VERSION,
        )?;

        Ok(Self {
            docker,
            socket_path,
            vm_name: vm_name.to_string(),
        })
    }

    /// Detect the runtime kind inside the VM.
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

/// Get the Docker socket path for a Lima VM.
/// Lima forwards the socket to ~/.lima/<name>/sock/docker.sock
fn lima_socket_path(vm_name: &str) -> PathBuf {
    let home = dirs::home_dir().unwrap_or_default();
    home.join(".lima")
        .join(vm_name)
        .join("sock")
        .join("docker.sock")
}
