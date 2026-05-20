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

/// Open a Bollard client at `path` and verify it actually responds. After
/// a host reboot the socket file often lingers from the previous session
/// with no listener — file existence is not proof that Docker is up.
async fn try_socket(path: &str) -> Option<bollard::Docker> {
    let docker = if path == "/var/run/docker.sock" {
        bollard::Docker::connect_with_socket_defaults().ok()?
    } else {
        bollard::Docker::connect_with_socket(path, 120, bollard::API_DEFAULT_VERSION).ok()?
    };
    // Short timeout — bollard's default would let us hang on a dead
    // socket. 2s is plenty for a local unix socket ping.
    match tokio::time::timeout(std::time::Duration::from_secs(2), docker.ping()).await {
        Ok(Ok(_)) => Some(docker),
        Ok(Err(e)) => {
            tracing::debug!("Socket {path} exists but ping failed: {e}");
            None
        }
        Err(_) => {
            tracing::debug!("Socket {path} exists but ping timed out");
            None
        }
    }
}

impl NativeBackend {
    /// Connect using default socket detection.
    /// Checks DOCKER_HOST, Docker context, standard paths, and Lima/Colima sockets.
    /// Each candidate is **ping-verified** before being accepted — file existence
    /// alone is not enough, since unix-socket files persist across host reboots
    /// even when the listener (Docker Desktop, Lima hostagent, etc.) is gone.
    pub async fn connect() -> anyhow::Result<Self> {
        // 1. Check DOCKER_HOST env var (set by `docker context use lima` etc.)
        if let Ok(host) = std::env::var("DOCKER_HOST")
            && let Some(path) = host.strip_prefix("unix://")
        {
            let sock = PathBuf::from(path);
            if sock.exists()
                && let Some(docker) = try_socket(path).await
            {
                tracing::info!("Connected to Docker via DOCKER_HOST: {}", sock.display());
                return Ok(Self {
                    runtime: BollardRuntime::new(docker),
                    socket_path: sock,
                });
            }
        }

        // 2. Check Docker context for the active socket path
        if let Ok(output) = std::process::Command::new("docker")
            .args(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"])
            .output()
            && output.status.success()
        {
            let host = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if let Some(path) = host.strip_prefix("unix://") {
                let sock = PathBuf::from(path);
                if sock.exists()
                    && let Some(docker) = try_socket(path).await
                {
                    tracing::info!("Connected to Docker via context: {}", sock.display());
                    return Ok(Self {
                        runtime: BollardRuntime::new(docker),
                        socket_path: sock,
                    });
                }
            }
        }

        // 3. Check standard and platform-specific socket paths
        let mut candidates: Vec<PathBuf> = vec![PathBuf::from("/var/run/docker.sock")];

        if let Ok(home) = std::env::var("HOME") {
            // macOS Docker Desktop (various versions use different paths)
            candidates.push(PathBuf::from(format!("{home}/.docker/run/docker.sock")));
            candidates.push(PathBuf::from(format!("{home}/.docker/desktop/docker.sock")));
            candidates.push(PathBuf::from(format!(
                "{home}/Library/Containers/com.docker.docker/Data/docker.raw.sock"
            )));
            // Lima VMs
            for vm in &["orca", "docker", "default", "colima"] {
                candidates.push(PathBuf::from(format!("{home}/.lima/{vm}/sock/docker.sock")));
            }
            // Colima
            candidates.push(PathBuf::from(format!("{home}/.colima/default/docker.sock")));
            candidates.push(PathBuf::from(format!("{home}/.colima/docker/docker.sock")));
        }

        // Podman sockets. Use the real UID from libc::getuid() — the
        // `$UID` env var is only exported by interactive shells, so a
        // daemon launched from systemd/launchd or any non-shell context
        // would silently skip the rootless Podman socket lookup.
        #[cfg(unix)]
        {
            // SAFETY: `getuid(2)` is always safe to call and cannot fail.
            let uid = unsafe { libc::getuid() };
            candidates.push(PathBuf::from(format!("/run/user/{uid}/podman/podman.sock")));
        }
        candidates.push(PathBuf::from("/run/podman/podman.sock"));

        for sock in &candidates {
            if !sock.exists() {
                continue;
            }
            let path_str = match sock.to_str() {
                Some(s) => s,
                None => continue,
            };
            if let Some(docker) = try_socket(path_str).await {
                tracing::info!("Connected to Docker socket at {}", sock.display());
                return Ok(Self {
                    runtime: BollardRuntime::new(docker),
                    socket_path: sock.clone(),
                });
            }
            tracing::debug!("Socket {} present but unresponsive — skipping", sock.display());
        }

        let tried = candidates
            .iter()
            .map(|p| format!("- {}", p.display()))
            .collect::<Vec<_>>()
            .join("\n");
        anyhow::bail!("No responsive container runtime socket found. Looked for:\n{tried}")
    }

    pub fn connect_with_socket(path: &str) -> anyhow::Result<Self> {
        let docker = bollard::Docker::connect_with_socket(path, 120, bollard::API_DEFAULT_VERSION)?;
        Ok(Self {
            runtime: BollardRuntime::new(docker),
            socket_path: PathBuf::from(path),
        })
    }
}
