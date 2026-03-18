use std::process::Stdio;
use tokio::process::Command;
use orca_core::environment::*;

/// Detect the current platform.
fn detect_platform() -> String {
    if cfg!(target_os = "linux") {
        "linux".to_string()
    } else if cfg!(target_os = "macos") {
        "macos".to_string()
    } else if cfg!(target_os = "windows") {
        "windows".to_string()
    } else {
        "unknown".to_string()
    }
}

/// Run a command and capture its stdout. Returns Ok(stdout) on success.
async fn run_cmd(program: &str, args: &[&str]) -> Result<String, String> {
    let result = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| e.to_string())?;

    if result.status.success() {
        Ok(String::from_utf8_lossy(&result.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&result.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("exit code {}", result.status.code().unwrap_or(-1))
        } else {
            stderr
        })
    }
}

async fn check_docker_installed() -> HealthCheck {
    match run_cmd("docker", &["--version"]).await {
        Ok(version) => HealthCheck {
            name: "Docker Runtime".to_string(),
            description: "Docker CLI is installed".to_string(),
            status: CheckStatus::Pass,
            fix_action: None,
            details: Some(version),
        },
        Err(e) => HealthCheck {
            name: "Docker Runtime".to_string(),
            description: "Docker CLI is installed".to_string(),
            status: CheckStatus::Fail,
            fix_action: Some(if cfg!(target_os = "linux") {
                "install_docker_linux".to_string()
            } else {
                "install_docker".to_string()
            }),
            details: Some(format!("Not found: {e}")),
        },
    }
}

async fn check_podman_installed() -> HealthCheck {
    match run_cmd("podman", &["--version"]).await {
        Ok(version) => HealthCheck {
            name: "Podman Runtime".to_string(),
            description: "Podman CLI is installed".to_string(),
            status: CheckStatus::Pass,
            fix_action: None,
            details: Some(version),
        },
        Err(e) => HealthCheck {
            name: "Podman Runtime".to_string(),
            description: "Podman CLI is installed (alternative to Docker)".to_string(),
            status: CheckStatus::Warning,
            fix_action: Some("install_podman_linux".to_string()),
            details: Some(format!("Not found: {e}")),
        },
    }
}

async fn check_docker_socket() -> HealthCheck {
    let sock = std::path::Path::new("/var/run/docker.sock");
    if sock.exists() {
        HealthCheck {
            name: "Docker Socket".to_string(),
            description: "Docker daemon socket exists at /var/run/docker.sock".to_string(),
            status: CheckStatus::Pass,
            fix_action: None,
            details: Some("/var/run/docker.sock".to_string()),
        }
    } else {
        HealthCheck {
            name: "Docker Socket".to_string(),
            description: "Docker daemon socket at /var/run/docker.sock".to_string(),
            status: CheckStatus::Fail,
            fix_action: Some("start_docker".to_string()),
            details: Some("Socket not found — Docker daemon may not be running".to_string()),
        }
    }
}

async fn check_docker_running() -> HealthCheck {
    match run_cmd("docker", &["info", "--format", "{{.ServerVersion}}"]).await {
        Ok(version) => HealthCheck {
            name: "Docker Daemon".to_string(),
            description: "Docker daemon is running and responsive".to_string(),
            status: CheckStatus::Pass,
            fix_action: None,
            details: Some(format!("Server version: {version}")),
        },
        Err(e) => HealthCheck {
            name: "Docker Daemon".to_string(),
            description: "Docker daemon is running and responsive".to_string(),
            status: CheckStatus::Fail,
            fix_action: Some("start_docker".to_string()),
            details: Some(format!("Daemon not responding: {e}")),
        },
    }
}

async fn check_docker_group() -> HealthCheck {
    // Check if current user is in the docker group
    match run_cmd("id", &["-nG"]).await {
        Ok(groups) => {
            let in_group = groups.split_whitespace().any(|g| g == "docker");
            if in_group {
                HealthCheck {
                    name: "Docker Group".to_string(),
                    description: "Current user is in the docker group".to_string(),
                    status: CheckStatus::Pass,
                    fix_action: None,
                    details: Some("User is in the docker group".to_string()),
                }
            } else {
                // Check if running as root (root doesn't need docker group)
                let is_root = std::env::var("USER")
                    .map(|u| u == "root")
                    .unwrap_or(false);
                if is_root {
                    HealthCheck {
                        name: "Docker Group".to_string(),
                        description: "Current user is in the docker group".to_string(),
                        status: CheckStatus::Pass,
                        fix_action: None,
                        details: Some("Running as root (group membership not needed)".to_string()),
                    }
                } else {
                    HealthCheck {
                        name: "Docker Group".to_string(),
                        description: "Current user is in the docker group (required for rootless Docker)".to_string(),
                        status: CheckStatus::Warning,
                        fix_action: Some("add_docker_group".to_string()),
                        details: Some("User is not in the docker group — you may need to use sudo".to_string()),
                    }
                }
            }
        }
        Err(e) => HealthCheck {
            name: "Docker Group".to_string(),
            description: "Current user is in the docker group".to_string(),
            status: CheckStatus::Warning,
            fix_action: None,
            details: Some(format!("Could not check groups: {e}")),
        },
    }
}

async fn check_lima_installed() -> HealthCheck {
    match run_cmd("limactl", &["--version"]).await {
        Ok(version) => HealthCheck {
            name: "Lima".to_string(),
            description: "Lima VM manager is installed (used for running Linux containers on macOS)".to_string(),
            status: CheckStatus::Pass,
            fix_action: None,
            details: Some(version),
        },
        Err(e) => HealthCheck {
            name: "Lima".to_string(),
            description: "Lima VM manager (used for running Linux containers on macOS)".to_string(),
            status: CheckStatus::Warning,
            fix_action: Some("install_lima".to_string()),
            details: Some(format!("Not found: {e}")),
        },
    }
}

async fn check_brew_installed() -> HealthCheck {
    match run_cmd("brew", &["--version"]).await {
        Ok(version) => HealthCheck {
            name: "Homebrew".to_string(),
            description: "Homebrew package manager is installed".to_string(),
            status: CheckStatus::Pass,
            fix_action: None,
            details: Some(version.lines().next().unwrap_or(&version).to_string()),
        },
        Err(e) => HealthCheck {
            name: "Homebrew".to_string(),
            description: "Homebrew package manager (needed to install dependencies)".to_string(),
            status: CheckStatus::Warning,
            fix_action: None,
            details: Some(format!("Not found: {e}")),
        },
    }
}

async fn check_wsl2_enabled() -> HealthCheck {
    match run_cmd("wsl", &["--status"]).await {
        Ok(output) => {
            let has_wsl2 = output.contains("2") || output.to_lowercase().contains("wsl 2");
            if has_wsl2 {
                HealthCheck {
                    name: "WSL2".to_string(),
                    description: "Windows Subsystem for Linux 2 is enabled".to_string(),
                    status: CheckStatus::Pass,
                    fix_action: None,
                    details: Some(output.lines().next().unwrap_or(&output).to_string()),
                }
            } else {
                HealthCheck {
                    name: "WSL2".to_string(),
                    description: "Windows Subsystem for Linux 2 is required for containers".to_string(),
                    status: CheckStatus::Fail,
                    fix_action: Some("enable_wsl2".to_string()),
                    details: Some("WSL2 does not appear to be active".to_string()),
                }
            }
        }
        Err(e) => HealthCheck {
            name: "WSL2".to_string(),
            description: "Windows Subsystem for Linux 2 is required for containers".to_string(),
            status: CheckStatus::Fail,
            fix_action: Some("enable_wsl2".to_string()),
            details: Some(format!("WSL not available: {e}")),
        },
    }
}

async fn check_docker_desktop() -> HealthCheck {
    // Check if Docker Desktop is installed by looking for its specific markers
    #[cfg(target_os = "macos")]
    let desktop_installed = std::path::Path::new("/Applications/Docker.app").exists();

    #[cfg(target_os = "windows")]
    let desktop_installed = std::path::Path::new(
        &format!(
            "{}\\Docker\\Docker\\Docker Desktop.exe",
            std::env::var("ProgramFiles").unwrap_or_default()
        ),
    )
    .exists();

    #[cfg(target_os = "linux")]
    let desktop_installed = {
        // Docker Desktop on Linux installs to /opt/docker-desktop
        std::path::Path::new("/opt/docker-desktop").exists()
    };

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    let desktop_installed = false;

    if desktop_installed {
        HealthCheck {
            name: "Docker Desktop".to_string(),
            description: "Docker Desktop is installed".to_string(),
            status: CheckStatus::Pass,
            fix_action: None,
            details: Some(
                "Docker Desktop detected — Orca can work alongside it using the same Docker daemon"
                    .to_string(),
            ),
        }
    } else {
        HealthCheck {
            name: "Docker Desktop".to_string(),
            description: "Docker Desktop (optional — not required if Docker/Podman CLI is installed)".to_string(),
            status: CheckStatus::Warning,
            fix_action: None,
            details: Some("Docker Desktop not detected (this is fine if you have Docker or Podman CLI)".to_string()),
        }
    }
}

/// Run all environment checks for the current platform.
pub async fn check_environment() -> EnvironmentStatus {
    let platform = detect_platform();
    let mut checks = Vec::new();

    match platform.as_str() {
        "linux" => {
            checks.push(check_docker_installed().await);
            checks.push(check_podman_installed().await);
            checks.push(check_docker_socket().await);
            checks.push(check_docker_running().await);
            checks.push(check_docker_group().await);
        }
        "macos" => {
            checks.push(check_docker_installed().await);
            checks.push(check_lima_installed().await);
            checks.push(check_brew_installed().await);
            checks.push(check_docker_desktop().await);
        }
        "windows" => {
            checks.push(check_wsl2_enabled().await);
            checks.push(check_docker_installed().await);
            checks.push(check_docker_desktop().await);
        }
        _ => {}
    }

    // Environment is ready if at least one runtime check passes
    let ready = checks.iter().any(|c| {
        c.name.contains("Runtime") && c.status == CheckStatus::Pass
    });

    let suggested = if checks
        .iter()
        .any(|c| c.name == "Podman Runtime" && c.status == CheckStatus::Pass)
    {
        "podman"
    } else {
        "docker"
    };

    EnvironmentStatus {
        ready,
        platform,
        checks,
        suggested_runtime: suggested.to_string(),
    }
}

/// Run an automated fix action.
pub async fn run_fix(action: &str) -> anyhow::Result<String> {
    match action {
        "install_podman_linux" => {
            // Detect package manager and install
            if let Ok(_) = run_cmd("apt", &["--version"]).await {
                let output =
                    run_cmd("sudo", &["apt", "install", "-y", "podman"]).await
                        .map_err(|e| anyhow::anyhow!("apt install failed: {e}"))?;
                Ok(format!("Installed podman via apt:\n{output}"))
            } else if let Ok(_) = run_cmd("dnf", &["--version"]).await {
                let output =
                    run_cmd("sudo", &["dnf", "install", "-y", "podman"]).await
                        .map_err(|e| anyhow::anyhow!("dnf install failed: {e}"))?;
                Ok(format!("Installed podman via dnf:\n{output}"))
            } else if let Ok(_) = run_cmd("pacman", &["--version"]).await {
                let output =
                    run_cmd("sudo", &["pacman", "-S", "--noconfirm", "podman"]).await
                        .map_err(|e| anyhow::anyhow!("pacman install failed: {e}"))?;
                Ok(format!("Installed podman via pacman:\n{output}"))
            } else {
                anyhow::bail!(
                    "Could not detect package manager (tried apt, dnf, pacman). \
                     Please install podman manually."
                )
            }
        }
        "install_docker_linux" => {
            // Use the official Docker install script
            let output = run_cmd("sh", &["-c", "curl -fsSL https://get.docker.com | sh"])
                .await
                .map_err(|e| anyhow::anyhow!("Docker install script failed: {e}"))?;
            Ok(format!("Docker installed:\n{output}"))
        }
        "start_docker" => {
            let output = run_cmd("sudo", &["systemctl", "start", "docker"])
                .await
                .map_err(|e| anyhow::anyhow!("Failed to start Docker: {e}"))?;
            Ok(format!(
                "Docker daemon started.{}",
                if output.is_empty() {
                    String::new()
                } else {
                    format!("\n{output}")
                }
            ))
        }
        "add_docker_group" => {
            let user = std::env::var("USER").unwrap_or_else(|_| "unknown".to_string());
            let output = run_cmd("sudo", &["usermod", "-aG", "docker", &user])
                .await
                .map_err(|e| anyhow::anyhow!("Failed to add user to docker group: {e}"))?;
            Ok(format!(
                "Added {user} to docker group. You may need to log out and back in for this to take effect.{}",
                if output.is_empty() { String::new() } else { format!("\n{output}") }
            ))
        }
        "install_lima" => {
            let output = run_cmd("brew", &["install", "lima"])
                .await
                .map_err(|e| anyhow::anyhow!("brew install lima failed: {e}"))?;
            Ok(format!("Lima installed:\n{output}"))
        }
        "enable_wsl2" => {
            let output = run_cmd("wsl", &["--install"])
                .await
                .map_err(|e| anyhow::anyhow!("WSL install failed: {e}"))?;
            Ok(format!(
                "WSL2 installation initiated. A restart may be required.\n{output}"
            ))
        }
        _ => anyhow::bail!("Unknown fix action: {action}"),
    }
}
