//! WSL2 distro management — create, start, stop, delete distros on Windows.
//!
//! Uses `wsl.exe` CLI for lifecycle management and `wsl -d <distro> -- <cmd>`
//! for running commands inside the distro.

use std::path::PathBuf;
use std::process::Stdio;

use tokio::process::Command;

use orca_core::machine::*;
use orca_core::runtime::RuntimeKind;

use crate::WindowsBackend;

const DEFAULT_DISTRO: &str = "orca";

impl MachineManager for WindowsBackend {
    async fn create(&self, config: MachineConfig) -> anyhow::Result<MachineInfo> {
        // Import a minimal Linux rootfs as a WSL2 distro
        // The rootfs tarball should be bundled with Orca or downloaded
        let install_path = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("C:\\Users\\Default\\AppData\\Local"))
            .join("Orca")
            .join(&config.name);

        tokio::fs::create_dir_all(&install_path).await?;

        // For now, assume the distro is already imported or use wsl --install
        let output = Command::new("wsl.exe")
            .args([
                "--import",
                &config.name,
                install_path.to_str().unwrap(),
                "orca-rootfs.tar.gz", // TODO: bundle this or download it
                "--version",
                "2",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .await?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            anyhow::bail!("Failed to create WSL2 distro: {stderr}");
        }

        // Configure memory and CPU limits via .wslconfig
        // (WSL2 uses a global config, not per-distro — this is a limitation)
        self.configure_wsl_resources(&config).await?;

        // Install container runtime inside the distro
        let runtime_script = match config.runtime {
            RuntimeKind::Podman => {
                "apt-get update -qq && apt-get install -y -qq podman && \
                 podman system service --time=0 unix:///var/run/docker.sock &"
            }
            RuntimeKind::Docker => {
                "curl -fsSL https://get.docker.com | sh && \
                 dockerd &"
            }
        };

        wsl_exec(&config.name, runtime_script).await?;

        self.inspect(&config.name).await
    }

    async fn start(&self, name: &str) -> anyhow::Result<()> {
        // WSL2 distros start on first access — just run a dummy command
        wsl_exec(name, "echo started").await?;

        // Start the container runtime
        wsl_exec(
            name,
            "if command -v dockerd &>/dev/null; then \
                nohup dockerd &>/dev/null & \
             elif command -v podman &>/dev/null; then \
                nohup podman system service --time=0 unix:///var/run/docker.sock &>/dev/null & \
             fi",
        )
        .await?;

        Ok(())
    }

    async fn stop(&self, name: &str) -> anyhow::Result<()> {
        let output = Command::new("wsl.exe")
            .args(["--terminate", name])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .await?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            anyhow::bail!("Failed to stop WSL2 distro '{name}': {stderr}");
        }
        Ok(())
    }

    async fn kill(&self, name: &str) -> anyhow::Result<()> {
        self.stop(name).await
    }

    async fn delete(&self, name: &str) -> anyhow::Result<()> {
        let output = Command::new("wsl.exe")
            .args(["--unregister", name])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .await?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            anyhow::bail!("Failed to delete WSL2 distro '{name}': {stderr}");
        }
        Ok(())
    }

    async fn inspect(&self, name: &str) -> anyhow::Result<MachineInfo> {
        let machines = self.list().await?;
        machines
            .into_iter()
            .find(|m| m.name == name)
            .ok_or_else(|| anyhow::anyhow!("WSL2 distro '{name}' not found"))
    }

    async fn list(&self) -> anyhow::Result<Vec<MachineInfo>> {
        let output = Command::new("wsl.exe")
            .args(["--list", "--verbose"])
            .stdout(Stdio::piped())
            .output()
            .await?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut machines = Vec::new();

        // Parse wsl.exe --list --verbose output:
        //   NAME   STATE   VERSION
        // * Ubuntu Running 2
        //   orca   Stopped 2
        for line in stdout.lines().skip(1) {
            let line = line.trim().trim_start_matches('*').trim();
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 3 {
                let name = parts[0].to_string();
                let state = match parts[1] {
                    "Running" => MachineState::Running,
                    "Stopped" => MachineState::Stopped,
                    _ => MachineState::Error,
                };
                let version: u32 = parts[2].parse().unwrap_or(2);

                // Only show WSL2 distros
                if version == 2 {
                    machines.push(MachineInfo {
                        name: name.clone(),
                        state,
                        config: MachineConfig {
                            name,
                            cpus: 0,      // WSL2 doesn't expose per-distro CPU info
                            memory_mb: 0, // set via .wslconfig globally
                            disk_gb: 0,
                            runtime: RuntimeKind::Docker,
                            mounts: vec![],
                        },
                        backend: MachineBackend::Wsl2,
                    });
                }
            }
        }

        Ok(machines)
    }

    async fn runtime_socket(&self, _name: &str) -> anyhow::Result<PathBuf> {
        // On Windows, we connect via TCP or named pipe
        // The socket inside WSL2 is forwarded via socat or wsl-vpnkit
        Ok(PathBuf::from("\\\\.\\pipe\\orca-docker"))
    }
}

impl WindowsBackend {
    async fn configure_wsl_resources(&self, config: &MachineConfig) -> anyhow::Result<()> {
        let wslconfig_path = dirs::home_dir()
            .unwrap_or_default()
            .join(".wslconfig");

        let content = format!(
            "[wsl2]\nmemory={memory}MB\nprocessors={cpus}\nswap=0\n",
            memory = config.memory_mb,
            cpus = config.cpus,
        );

        tokio::fs::write(&wslconfig_path, content).await?;
        Ok(())
    }
}

/// Execute a command inside a WSL2 distro.
async fn wsl_exec(distro: &str, command: &str) -> anyhow::Result<String> {
    let output = Command::new("wsl.exe")
        .args(["-d", distro, "--", "bash", "-c", command])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("WSL exec failed: {stderr}");
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}
