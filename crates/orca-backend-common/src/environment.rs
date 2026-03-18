use std::process::Stdio;
use tokio::process::Command;
use orca_core::environment::*;
use serde::Deserialize as SerdeDeserialize;

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

// ==================== System Health ====================

/// Check if Docker/Podman is currently reachable.
pub async fn check_docker_connection() -> bool {
    Command::new("docker")
        .args(["info"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .is_ok_and(|s| s.success())
}

/// JSON shape returned by `docker system df --format '{{json .}}'`.
#[derive(SerdeDeserialize)]
#[serde(rename_all = "PascalCase")]
struct DockerDfRow {
    #[serde(rename = "Type")]
    type_name: String,
    size: String,
    reclaimable: String,
}

/// Parse a Docker human-readable size string (e.g. "1.234GB", "45.6kB") into bytes.
fn parse_docker_size(s: &str) -> u64 {
    let s = s.trim();
    // Find where the numeric part ends and the unit begins
    let (num_str, unit) = match s.find(|c: char| c.is_alphabetic()) {
        Some(idx) => (&s[..idx], s[idx..].to_uppercase()),
        None => return s.parse::<u64>().unwrap_or(0),
    };
    let num: f64 = num_str.parse().unwrap_or(0.0);
    let multiplier: f64 = match unit.as_str() {
        "B" => 1.0,
        "KB" => 1_000.0,
        "MB" => 1_000_000.0,
        "GB" => 1_000_000_000.0,
        "TB" => 1_000_000_000_000.0,
        "KIB" => 1_024.0,
        "MIB" => 1_048_576.0,
        "GIB" => 1_073_741_824.0,
        "TIB" => 1_099_511_627_776.0,
        _ => 1.0,
    };
    (num * multiplier) as u64
}

/// Parse reclaimable string like "1.234GB (45%)" — extract just the size portion.
fn parse_reclaimable_size(s: &str) -> u64 {
    // Strip any parenthesized percentage at the end
    let size_part = if let Some(idx) = s.find('(') {
        s[..idx].trim()
    } else {
        s.trim()
    };
    parse_docker_size(size_part)
}

/// Get Docker disk usage (docker system df).
pub async fn get_disk_usage() -> Option<DiskUsage> {
    let output = Command::new("docker")
        .args(["system", "df", "--format", "{{json .}}"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .await
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut images_size: u64 = 0;
    let mut containers_size: u64 = 0;
    let mut volumes_size: u64 = 0;
    let mut build_cache_size: u64 = 0;
    let mut total_reclaimable: u64 = 0;

    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(row) = serde_json::from_str::<DockerDfRow>(line) {
            let size = parse_docker_size(&row.size);
            let reclaimable = parse_reclaimable_size(&row.reclaimable);
            match row.type_name.as_str() {
                "Images" => images_size = size,
                "Containers" => containers_size = size,
                "Volumes" | "Local Volumes" => volumes_size = size,
                "Build Cache" => build_cache_size = size,
                _ => {}
            }
            total_reclaimable += reclaimable;
        }
    }

    let total = images_size + containers_size + volumes_size + build_cache_size;

    Some(DiskUsage {
        images_size_bytes: images_size,
        containers_size_bytes: containers_size,
        volumes_size_bytes: volumes_size,
        build_cache_size_bytes: build_cache_size,
        total_size_bytes: total,
        reclaimable_bytes: total_reclaimable,
    })
}

/// Parse a value in kB from /proc/meminfo.
fn parse_meminfo_kb(meminfo: &str, key: &str) -> Option<u64> {
    for line in meminfo.lines() {
        if line.starts_with(key) {
            // Format: "MemTotal:       16384000 kB"
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 2 {
                return parts[1].parse::<u64>().ok();
            }
        }
    }
    None
}

/// Get system resource info.
pub async fn get_system_resources() -> Option<SystemResources> {
    let cpu_count = std::thread::available_parallelism()
        .map(|p| p.get() as u32)
        .unwrap_or(1);

    // Memory from /proc/meminfo (Linux)
    let (memory_total, memory_available) = if cfg!(target_os = "linux") {
        if let Ok(meminfo) = std::fs::read_to_string("/proc/meminfo") {
            let total = parse_meminfo_kb(&meminfo, "MemTotal:")
                .map(|kb| kb * 1024)
                .unwrap_or(0);
            let available = parse_meminfo_kb(&meminfo, "MemAvailable:")
                .map(|kb| kb * 1024)
                .unwrap_or(0);
            (total, available)
        } else {
            (0, 0)
        }
    } else {
        // Fallback: try to get from `free` command
        match run_cmd("free", &["-b"]).await {
            Ok(output) => {
                let mut total = 0u64;
                let mut available = 0u64;
                for line in output.lines() {
                    if line.starts_with("Mem:") {
                        let parts: Vec<&str> = line.split_whitespace().collect();
                        if parts.len() >= 7 {
                            total = parts[1].parse().unwrap_or(0);
                            available = parts[6].parse().unwrap_or(0);
                        }
                    }
                }
                (total, available)
            }
            Err(_) => (0, 0),
        }
    };

    // Disk usage: parse `df` output for the root filesystem
    let (disk_total, disk_free) = match run_cmd("df", &["-B1", "/"]).await {
        Ok(output) => {
            // Second line has: Filesystem 1B-blocks Used Available Use% Mounted
            let mut total = 0u64;
            let mut free = 0u64;
            for (i, line) in output.lines().enumerate() {
                if i == 0 {
                    continue; // header
                }
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 4 {
                    total = parts[1].parse().unwrap_or(0);
                    free = parts[3].parse().unwrap_or(0);
                }
                break;
            }
            (total, free)
        }
        Err(_) => (0, 0),
    };

    let disk_usage_percent = if disk_total > 0 {
        ((disk_total - disk_free) as f64 / disk_total as f64) * 100.0
    } else {
        0.0
    };

    Some(SystemResources {
        cpu_count,
        memory_total_bytes: memory_total,
        memory_available_bytes: memory_available,
        disk_total_bytes: disk_total,
        disk_free_bytes: disk_free,
        disk_usage_percent,
    })
}

/// Full system health check.
pub async fn check_system_health() -> SystemHealth {
    let connected = check_docker_connection().await;

    let version = if connected {
        run_cmd("docker", &["version", "--format", "{{.Server.Version}}"])
            .await
            .ok()
    } else {
        None
    };

    let disk = if connected {
        get_disk_usage().await
    } else {
        None
    };

    let resources = get_system_resources().await;

    let mut warnings = Vec::new();
    if !connected {
        warnings.push("Docker is not running or not reachable".to_string());
    }
    if let Some(ref res) = resources {
        if res.disk_usage_percent > 90.0 {
            warnings.push("Disk usage is above 90% — consider pruning images".to_string());
        }
        if res.memory_available_bytes < 512 * 1024 * 1024 {
            warnings.push("Less than 512MB memory available".to_string());
        }
    }
    if let Some(ref du) = disk {
        if du.reclaimable_bytes > 5 * 1024 * 1024 * 1024 {
            let gb = du.reclaimable_bytes / (1024 * 1024 * 1024);
            warnings.push(format!(
                "{gb}GB of Docker storage is reclaimable — consider pruning"
            ));
        }
    }

    SystemHealth {
        docker_connected: connected,
        docker_version: version,
        disk_usage: disk,
        system_resources: resources,
        warnings,
    }
}
