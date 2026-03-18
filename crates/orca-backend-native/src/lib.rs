mod machine;

use std::ops::Deref;
use std::path::PathBuf;

pub use orca_backend_common::BollardRuntime;

/// Native Linux backend that talks to Docker/Podman over a Unix socket.
///
/// On Linux there's no VM — we communicate directly with the container
/// runtime daemon on the host. All container/image/volume/network operations
/// are delegated to the embedded BollardRuntime via Deref.
pub struct NativeBackend {
    pub runtime: BollardRuntime,
    pub socket_path: PathBuf,
}

/// Deref to BollardRuntime so all trait impls (ContainerRuntime, ImageManager,
/// VolumeManager, NetworkManager, ComposeRunner) are automatically available.
impl Deref for NativeBackend {
    type Target = BollardRuntime;
    fn deref(&self) -> &Self::Target {
        &self.runtime
    }
}

impl NativeBackend {
    /// Connect using default socket detection.
    /// Tries Docker socket first, then Podman.
    pub fn connect() -> anyhow::Result<Self> {
        let docker_sock = PathBuf::from("/var/run/docker.sock");
        if docker_sock.exists() {
            tracing::info!("Connecting to Docker socket at {}", docker_sock.display());
            let docker = bollard::Docker::connect_with_unix_defaults()?;
            return Ok(Self {
                runtime: BollardRuntime::new(docker),
                socket_path: docker_sock,
            });
        }

        if let Ok(uid) = std::env::var("UID") {
            let podman_sock = PathBuf::from(format!("/run/user/{uid}/podman/podman.sock"));
            if podman_sock.exists() {
                tracing::info!("Connecting to Podman socket at {}", podman_sock.display());
                let docker = bollard::Docker::connect_with_unix(
                    podman_sock.to_str().ok_or_else(|| anyhow::anyhow!("Invalid socket path"))?,
                    120,
                    bollard::API_DEFAULT_VERSION,
                )?;
                return Ok(Self {
                    runtime: BollardRuntime::new(docker),
                    socket_path: podman_sock,
                });
            }
        }

        let podman_sock = PathBuf::from("/run/podman/podman.sock");
        if podman_sock.exists() {
            tracing::info!("Connecting to Podman socket at {}", podman_sock.display());
            let docker = bollard::Docker::connect_with_unix(
                podman_sock.to_str().ok_or_else(|| anyhow::anyhow!("Invalid socket path"))?,
                120,
                bollard::API_DEFAULT_VERSION,
            )?;
            return Ok(Self {
                runtime: BollardRuntime::new(docker),
                socket_path: podman_sock,
            });
        }

        anyhow::bail!(
            "No container runtime socket found. Looked for:\n\
             - /var/run/docker.sock\n\
             - /run/user/$UID/podman/podman.sock\n\
             - /run/podman/podman.sock"
        )
    }

    pub fn connect_with_socket(path: &str) -> anyhow::Result<Self> {
        let docker =
            bollard::Docker::connect_with_unix(path, 120, bollard::API_DEFAULT_VERSION)?;
        Ok(Self {
            runtime: BollardRuntime::new(docker),
            socket_path: PathBuf::from(path),
        })
    }
}
