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

/// Validate a WSL distro name. Must be safe as an argv to `wsl.exe` and
/// usable as a Windows filesystem fragment (wsl stores distros under
/// `%LOCALAPPDATA%\Packages\...`).
fn validate_distro_name(name: &str) -> anyhow::Result<()> {
    if name.is_empty() || name.len() > 64 {
        anyhow::bail!("WSL distro name must be 1..=64 characters");
    }
    if name.starts_with('-') || name.starts_with('.') {
        anyhow::bail!("WSL distro name must not start with '-' or '.'");
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
    {
        anyhow::bail!("WSL distro name must contain only ASCII alphanumerics, '-', and '_'");
    }
    Ok(())
}

/// Validate machine-config resources before templating `.wslconfig`.
fn validate_resources(config: &MachineConfig) -> anyhow::Result<()> {
    if config.cpus == 0 {
        anyhow::bail!("cpus must be >= 1");
    }
    if config.memory_mb < 1024 {
        anyhow::bail!("memory_mb must be >= 1024");
    }
    Ok(())
}

impl MachineManager for WindowsBackend {
    async fn create(&self, config: MachineConfig) -> anyhow::Result<MachineInfo> {
        validate_distro_name(&config.name)?;
        validate_resources(&config)?;

        // Strategy: install Ubuntu-24.04 first, then export & re-import under
        // the requested `config.name`. Without the export/import dance,
        // `wsl --install -d Ubuntu-24.04` creates a distro literally named
        // "Ubuntu-24.04" — so every subsequent `wsl_exec(distro_name, ...)`
        // targets a distro that doesn't exist.
        let distro_name = config.name.clone();

        // Check if distro already exists
        let existing = self.list().await?;
        if existing.iter().any(|m| m.name == distro_name) {
            anyhow::bail!("WSL2 distro '{distro_name}' already exists");
        }

        tracing::info!("Installing WSL2 base image...");

        // 1. Install the Ubuntu base image with its default name. Use
        //    `--no-launch` so no user provisioning runs (we'd prefer the
        //    root user anyway — see #3 below).
        let base_already_installed = existing.iter().any(|m| m.name == "Ubuntu-24.04" || m.name == "Ubuntu");
        let base_name = "Ubuntu-24.04";
        if !base_already_installed {
            let output = Command::new("wsl.exe")
                .args(["--install", "-d", base_name, "--no-launch"])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .output()
                .await?;

            if !output.status.success() {
                // Fall back to the versionless name for older wsl.exe.
                let output2 = Command::new("wsl.exe")
                    .args(["--install", "-d", "Ubuntu", "--no-launch"])
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .output()
                    .await?;
                if !output2.status.success() {
                    let stderr = String::from_utf8_lossy(&output2.stderr);
                    anyhow::bail!("Failed to install WSL2 base distro: {stderr}");
                }
            }
        }

        // 2. Export the installed base to a tarball, then import under
        //    `config.name` into a distro-specific data dir, then delete the
        //    base. The user ends up with a distro that carries exactly the
        //    requested name.
        let temp_dir = std::env::temp_dir();
        let tar_path = temp_dir.join(format!("orca-wsl-{distro_name}.tar"));
        let dest_dir = dirs::data_dir()
            .ok_or_else(|| anyhow::anyhow!("cannot resolve data_dir"))?
            .join("orca")
            .join("wsl")
            .join(&distro_name);
        tokio::fs::create_dir_all(&dest_dir).await?;

        let export = Command::new("wsl.exe")
            .args([
                "--export",
                base_name,
                tar_path
                    .to_str()
                    .ok_or_else(|| anyhow::anyhow!("invalid tarball path"))?,
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .await?;
        if !export.status.success() {
            let stderr = String::from_utf8_lossy(&export.stderr);
            anyhow::bail!("Failed to export WSL base image: {stderr}");
        }

        let import = Command::new("wsl.exe")
            .args([
                "--import",
                &distro_name,
                dest_dir.to_str().ok_or_else(|| anyhow::anyhow!("invalid dest dir"))?,
                tar_path
                    .to_str()
                    .ok_or_else(|| anyhow::anyhow!("invalid tarball path"))?,
                "--version",
                "2",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .await?;
        // Best-effort cleanup of the tarball.
        let _ = tokio::fs::remove_file(&tar_path).await;
        if !import.status.success() {
            let stderr = String::from_utf8_lossy(&import.stderr);
            anyhow::bail!("Failed to import WSL distro: {stderr}");
        }

        // Configure memory and CPU limits via .wslconfig (merging with any
        // existing user config).
        self.configure_wsl_resources(&config).await?;

        // 3. Provision. All subsequent commands MUST run as root — the
        //    default user created by Ubuntu can't apt-get install or edit
        //    /etc/*. wsl_exec now always uses `--user root`.
        wsl_exec(&distro_name, "echo 'Distro started'").await?;

        // Install container runtime
        let runtime_install = match config.runtime {
            RuntimeKind::Podman => "set -euo pipefail; apt-get update -qq && apt-get install -y -qq podman",
            RuntimeKind::Docker => {
                // curl|sh with pipefail so a failing curl aborts instead of
                // silently running an empty installer.
                "set -euo pipefail; curl -fsSL https://get.docker.com -o /tmp/get-docker.sh && sh /tmp/get-docker.sh && rm -f /tmp/get-docker.sh"
            }
        };
        wsl_exec(&distro_name, runtime_install).await?;

        // Set up host.docker.internal DNS
        wsl_exec(
            &distro_name,
            r#"set -euo pipefail
HOST_IP=$(awk '/nameserver/{print $2; exit}' /etc/resolv.conf)
if ! grep -q host.docker.internal /etc/hosts; then
    echo "$HOST_IP host.docker.internal" >> /etc/hosts
fi"#,
        )
        .await?;

        // Configure Docker daemon for DNS and port forwarding. Write via
        // `tee` reading from stdin so we don't have to wrestle with
        // indented-heredoc terminator rules (the previous form used a
        // non-tabbed heredoc whose closing `EOF` was indented, which made
        // bash consume the rest of the command as heredoc content).
        let daemon_json = r#"{
  "iptables": true,
  "ip-forward": true,
  "dns": ["8.8.8.8", "8.8.4.4"]
}"#;
        let write_cmd = format!(
            "set -euo pipefail; mkdir -p /etc/docker && cat > /etc/docker/daemon.json <<'ORCA_EOF'\n{daemon_json}\nORCA_EOF"
        );
        wsl_exec(&distro_name, &write_cmd).await?;

        self.inspect(&distro_name).await
    }

    async fn start(&self, name: &str) -> anyhow::Result<()> {
        validate_distro_name(name)?;
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
        validate_distro_name(name)?;
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
        validate_distro_name(name)?;
        // Log any stop failure instead of swallowing it silently so a
        // stuck/crashing stop path is visible in the daemon log.
        if let Err(e) = self.stop(name).await {
            tracing::warn!("WSL delete: stop('{name}') failed (continuing): {e}");
        }

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
        // wsl.exe --list emits UTF-16LE by default; setting WSL_UTF8=1
        // makes it emit UTF-8 so our lossy-UTF-8 decoder actually sees
        // the distro names. Without this the output is all replacement
        // characters and every parse fails.
        let output = Command::new("wsl.exe")
            .env("WSL_UTF8", "1")
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
                    "Installing" | "Starting" => MachineState::Starting,
                    "Stopping" | "Uninstalling" => MachineState::Stopping,
                    other => {
                        tracing::debug!("WSL distro '{name}' has unrecognised state '{other}'");
                        MachineState::Error
                    }
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
    /// Write Orca's WSL resource settings into the user's `.wslconfig`
    /// while PRESERVING any existing settings under other sections or keys.
    /// Previously we overwrote the entire file, wiping out user-authored
    /// `[experimental]` blocks, custom kernels, etc.
    async fn configure_wsl_resources(&self, config: &MachineConfig) -> anyhow::Result<()> {
        let home = dirs::home_dir().ok_or_else(|| anyhow::anyhow!("cannot resolve home dir"))?;
        let wslconfig_path = home.join(".wslconfig");

        // Read existing, split into sections. Very small parser — enough
        // for typical `.wslconfig` files that are a handful of flat
        // `key=value` pairs under `[wsl2]` and maybe `[experimental]`.
        let existing = tokio::fs::read_to_string(&wslconfig_path).await.unwrap_or_default();

        #[derive(Default)]
        struct Section {
            name: String,
            entries: Vec<(String, String)>,
        }
        let mut sections: Vec<Section> = Vec::new();
        let mut current = Section {
            name: String::new(),
            entries: Vec::new(),
        };
        for line in existing.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with(';') {
                continue;
            }
            if let Some(rest) = trimmed.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
                if !current.name.is_empty() || !current.entries.is_empty() {
                    sections.push(std::mem::take(&mut current));
                }
                current.name = rest.to_string();
            } else if let Some((k, v)) = trimmed.split_once('=') {
                current.entries.push((k.trim().to_string(), v.trim().to_string()));
            }
        }
        if !current.name.is_empty() || !current.entries.is_empty() {
            sections.push(current);
        }

        // Upsert keys we own under [wsl2]. Leave other sections alone.
        let wsl2 = sections.iter_mut().find(|s| s.name == "wsl2");
        let ours = [
            ("memory".to_string(), format!("{}MB", config.memory_mb)),
            ("processors".to_string(), config.cpus.to_string()),
            ("swap".to_string(), "0".to_string()),
            ("networkingMode".to_string(), "mirrored".to_string()),
            ("dnsTunneling".to_string(), "true".to_string()),
            ("autoProxy".to_string(), "true".to_string()),
        ];
        match wsl2 {
            Some(sec) => {
                for (k, v) in ours {
                    if let Some(existing) = sec.entries.iter_mut().find(|(ek, _)| ek == &k) {
                        existing.1 = v;
                    } else {
                        sec.entries.push((k, v));
                    }
                }
            }
            None => {
                sections.push(Section {
                    name: "wsl2".to_string(),
                    entries: ours.to_vec(),
                });
            }
        }

        // Serialise back.
        let mut out = String::new();
        for s in sections {
            if !s.name.is_empty() {
                out.push_str(&format!("[{}]\n", s.name));
            }
            for (k, v) in s.entries {
                out.push_str(&format!("{k}={v}\n"));
            }
            out.push('\n');
        }

        // Write atomically: temp sibling + rename.
        let tmp = wslconfig_path.with_extension("wslconfig.orca-new");
        tokio::fs::write(&tmp, out).await?;
        tokio::fs::rename(&tmp, &wslconfig_path).await?;
        Ok(())
    }
}

/// Execute a command inside a WSL2 distro AS ROOT. All of Orca's
/// provisioning steps (apt-get install, writing /etc/*, systemd edits)
/// require root; running as the default user silently fails.
async fn wsl_exec(distro: &str, command: &str) -> anyhow::Result<String> {
    let output = Command::new("wsl.exe")
        .env("WSL_UTF8", "1")
        .args(["-d", distro, "--user", "root", "--", "bash", "-c", command])
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
