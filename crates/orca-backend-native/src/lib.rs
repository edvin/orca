mod machine;

use std::ops::Deref;
use std::path::PathBuf;

pub use orca_backend_common::BollardRuntime;

/// Native Linux/macOS backend that talks to Docker/Podman over a Unix socket.
///
/// On Linux there's no VM — we communicate directly with the container
/// runtime daemon on the host. On macOS we find the socket from Lima/Colima/Docker Desktop.
/// All container/image/volume/network operations are delegated to BollardRuntime via Deref.
pub struct NativeBackend {
    pub runtime: BollardRuntime,
    pub socket_path: PathBuf,
}

impl Deref for NativeBackend {
    type Target = BollardRuntime;
    fn deref(&self) -> &Self::Target {
        &self.runtime
    }
}

impl NativeBackend {
    /// Connect using default socket detection.
    /// Checks DOCKER_HOST, Docker context, standard paths, and Lima/Colima sockets.
    pub fn connect() -> anyhow::Result<Self> {
        // 1. Check DOCKER_HOST env var (set by `docker context use lima` etc.)
        if let Ok(host) = std::env::var("DOCKER_HOST") {
            if let Some(path) = host.strip_prefix("unix://") {
                let sock = PathBuf::from(path);
                if sock.exists() {
                    tracing::info!("Connecting to Docker via DOCKER_HOST: {}", sock.display());
                    let docker = bollard::Docker::connect_with_socket(
                        sock.to_str().unwrap_or(""), 120, bollard::API_DEFAULT_VERSION,
                    )?;
                    return Ok(Self { runtime: BollardRuntime::new(docker), socket_path: sock });
                }
            }
        }

        // 2. Check Docker context for the active socket path
        if let Ok(output) = std::process::Command::new("docker")
            .args(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"])
            .output()
        {
            if output.status.success() {
                let host = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if let Some(path) = host.strip_prefix("unix://") {
                    let sock = PathBuf::from(path);
                    if sock.exists() {
                        tracing::info!("Connecting to Docker via context: {}", sock.display());
                        let docker = bollard::Docker::connect_with_socket(
                            sock.to_str().unwrap_or(""), 120, bollard::API_DEFAULT_VERSION,
                        )?;
                        return Ok(Self { runtime: BollardRuntime::new(docker), socket_path: sock });
                    }
                }
            }
        }

        // 3. Check standard and platform-specific socket paths
        let mut candidates: Vec<PathBuf> = vec![
            PathBuf::from("/var/run/docker.sock"),
        ];

        if let Ok(home) = std::env::var("HOME") {
            // macOS Docker Desktop (various versions use different paths)
            candidates.push(PathBuf::from(format!("{home}/.docker/run/docker.sock")));
            candidates.push(PathBuf::from(format!("{home}/.docker/desktop/docker.sock")));
            candidates.push(PathBuf::from(format!("{home}/Library/Containers/com.docker.docker/Data/docker.raw.sock")));
            // Lima VMs
            for vm in &["orca", "docker", "default", "colima"] {
                candidates.push(PathBuf::from(format!("{home}/.lima/{vm}/sock/docker.sock")));
            }
            // Colima
            candidates.push(PathBuf::from(format!("{home}/.colima/default/docker.sock")));
            candidates.push(PathBuf::from(format!("{home}/.colima/docker/docker.sock")));
        }

        // Podman sockets
        if let Ok(uid) = std::env::var("UID") {
            candidates.push(PathBuf::from(format!("/run/user/{uid}/podman/podman.sock")));
        }
        candidates.push(PathBuf::from("/run/podman/podman.sock"));

        for sock in &candidates {
            if sock.exists() {
                tracing::info!("Connecting to Docker socket at {}", sock.display());
                let result = if sock == &PathBuf::from("/var/run/docker.sock") {
                    bollard::Docker::connect_with_socket_defaults()
                } else {
                    bollard::Docker::connect_with_socket(
                        sock.to_str().unwrap_or(""), 120, bollard::API_DEFAULT_VERSION,
                    )
                };
                match result {
                    Ok(docker) => {
                        return Ok(Self { runtime: BollardRuntime::new(docker), socket_path: sock.clone() });
                    }
                    Err(e) => {
                        tracing::debug!("Socket {} found but connection failed: {e}", sock.display());
                    }
                }
            }
        }

        let tried = candidates.iter().map(|p| format!("- {}", p.display())).collect::<Vec<_>>().join("\n");
        anyhow::bail!("No container runtime socket found. Looked for:\n{tried}")
    }

    pub fn connect_with_socket(path: &str) -> anyhow::Result<Self> {
        let docker =
            bollard::Docker::connect_with_socket(path, 120, bollard::API_DEFAULT_VERSION)?;
        Ok(Self {
            runtime: BollardRuntime::new(docker),
            socket_path: PathBuf::from(path),
        })
    }
}
