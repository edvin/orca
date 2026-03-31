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

impl MachineManager for WindowsBackend {
    async fn create(&self, config: MachineConfig) -> anyhow::Result<MachineInfo> {
        // Strategy: Use wsl --install -d Ubuntu-24.04 for a pre-built distro.
        // This is much simpler than importing a custom rootfs — no tarball needed,
        // downloads directly from Microsoft's servers, and gives us a full Ubuntu with apt.

        let distro_name = &config.name;

        // Check if distro already exists
        let existing = self.list().await?;
        if existing.iter().any(|m| m.name == *distro_name) {
            anyhow::bail!("WSL2 distro '{distro_name}' already exists");
        }

        // Install Ubuntu as the base distro
        // wsl --install -d Ubuntu-24.04 --no-launch
        tracing::info!("Installing WSL2 distro '{distro_name}'...");
        let output = Command::new("wsl.exe")
            .args(["--install", "-d", "Ubuntu-24.04", "--no-launch"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .await?;

        if !output.status.success() {
            // Fallback: try without version
            let output2 = Command::new("wsl.exe")
                .args(["--install", "-d", "Ubuntu", "--no-launch"])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .output()
                .await?;

            if !output2.status.success() {
                let stderr = String::from_utf8_lossy(&output2.stderr);
                anyhow::bail!("Failed to install WSL2 distro: {stderr}");
            }
        }

        // Configure memory and CPU limits via .wslconfig
        // (WSL2 uses a global config, not per-distro — this is a limitation)
        self.configure_wsl_resources(&config).await?;

        // Start the distro and install container runtime
        wsl_exec(distro_name, "echo 'Distro started'").await?;

        // Install container runtime
        let runtime_install = match config.runtime {
            RuntimeKind::Podman => "apt-get update -qq && apt-get install -y -qq podman",
            RuntimeKind::Docker => "curl -fsSL https://get.docker.com | sh",
        };
        wsl_exec(distro_name, runtime_install).await?;

        // Set up host.docker.internal DNS
        // WSL2 provides the host IP via /etc/resolv.conf nameserver
        wsl_exec(
            distro_name,
            r#"HOST_IP=$(cat /etc/resolv.conf | grep nameserver | awk '{print $2}')
            if ! grep -q host.docker.internal /etc/hosts; then
                echo "$HOST_IP host.docker.internal" >> /etc/hosts
            fi"#,
        )
        .await?;

        // Configure Docker daemon for DNS and port forwarding
        wsl_exec(
            distro_name,
            r#"mkdir -p /etc/docker
            cat > /etc/docker/daemon.json << 'EOF'
            {
                "iptables": true,
                "ip-forward": true,
                "dns": ["8.8.8.8", "8.8.4.4"]
            }
            EOF"#,
        )
        .await?;

        self.inspect(distro_name).await
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
        let wslconfig_path = dirs::home_dir().unwrap_or_default().join(".wslconfig");

        // Enable mirrored networking for automatic port forwarding to host
        // and DNS resolution. Requires Windows 11 22H2+.
        let content = format!(
            "[wsl2]\n\
             memory={memory}MB\n\
             processors={cpus}\n\
             swap=0\n\
             networkingMode=mirrored\n\
             dnsTunneling=true\n\
             autoProxy=true\n",
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
