mod compose;
mod containers;
mod events;
mod images;
mod volumes;
mod networks;
mod machine;

use std::path::PathBuf;

/// Native Linux backend that talks to Docker/Podman over a Unix socket.
///
/// On Linux there's no VM — we communicate directly with the container
/// runtime daemon on the host.
pub struct NativeBackend {
    docker: bollard::Docker,
    socket_path: PathBuf,
}

impl NativeBackend {
    /// Connect using default socket detection.
    /// Tries Docker socket first, then Podman.
    pub fn connect() -> anyhow::Result<Self> {
        // Try Docker first
        let docker_sock = PathBuf::from("/var/run/docker.sock");
        if docker_sock.exists() {
            tracing::info!("Connecting to Docker socket at {}", docker_sock.display());
            let docker = bollard::Docker::connect_with_unix_defaults()?;
            return Ok(Self {
                docker,
                socket_path: docker_sock,
            });
        }

        // Try rootless Podman
        if let Ok(uid) = std::env::var("UID") {
            let podman_sock = PathBuf::from(format!("/run/user/{uid}/podman/podman.sock"));
            if podman_sock.exists() {
                tracing::info!("Connecting to Podman socket at {}", podman_sock.display());
                let docker = bollard::Docker::connect_with_unix(
                    podman_sock.to_str().unwrap(),
                    120,
                    bollard::API_DEFAULT_VERSION,
                )?;
                return Ok(Self {
                    docker,
                    socket_path: podman_sock,
                });
            }
        }

        // Try rootful Podman
        let podman_sock = PathBuf::from("/run/podman/podman.sock");
        if podman_sock.exists() {
            tracing::info!("Connecting to Podman socket at {}", podman_sock.display());
            let docker = bollard::Docker::connect_with_unix(
                podman_sock.to_str().unwrap(),
                120,
                bollard::API_DEFAULT_VERSION,
            )?;
            return Ok(Self {
                docker,
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

    /// Connect to a specific socket path.
    pub fn connect_with_socket(path: &str) -> anyhow::Result<Self> {
        let docker =
            bollard::Docker::connect_with_unix(path, 120, bollard::API_DEFAULT_VERSION)?;
        Ok(Self {
            docker,
            socket_path: PathBuf::from(path),
        })
    }

    /// Detect whether we're talking to Docker or Podman.
    pub async fn detect_runtime(&self) -> vessel_core::runtime::RuntimeKind {
        if let Ok(version) = self.docker.version().await {
            if let Some(components) = version.components {
                for c in &components {
                    if c.name.to_lowercase().contains("podman") {
                        return vessel_core::runtime::RuntimeKind::Podman;
                    }
                }
            }
        }
        vessel_core::runtime::RuntimeKind::Docker
    }
}
