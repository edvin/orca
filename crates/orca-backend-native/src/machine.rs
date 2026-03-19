use std::path::PathBuf;

use orca_core::machine::*;

use crate::NativeBackend;

/// On native Linux, there's no VM to manage.
/// The "machine" is the host itself — always running.
impl MachineManager for NativeBackend {
    async fn create(&self, _config: MachineConfig) -> anyhow::Result<MachineInfo> {
        anyhow::bail!("Cannot create machines on native Linux — the host is the machine. Configure the container runtime directly.")
    }

    async fn start(&self, _name: &str) -> anyhow::Result<()> {
        tracing::info!("Native machine is always running");
        Ok(())
    }

    async fn stop(&self, _name: &str) -> anyhow::Result<()> {
        anyhow::bail!("Cannot stop the native machine — it's your host system")
    }

    async fn kill(&self, _name: &str) -> anyhow::Result<()> {
        anyhow::bail!("Cannot kill the native machine — it's your host system")
    }

    async fn delete(&self, _name: &str) -> anyhow::Result<()> {
        anyhow::bail!("Cannot delete the native machine")
    }

    async fn inspect(&self, _name: &str) -> anyhow::Result<MachineInfo> {
        Ok(self.native_info().await)
    }

    async fn list(&self) -> anyhow::Result<Vec<MachineInfo>> {
        Ok(vec![self.native_info().await])
    }

    async fn runtime_socket(&self, _name: &str) -> anyhow::Result<PathBuf> {
        Ok(self.socket_path.clone())
    }
}

impl NativeBackend {
    async fn native_info(&self) -> MachineInfo {
        let runtime = self.detect_runtime().await;
        MachineInfo {
            name: "native".into(),
            state: MachineState::Running,
            config: MachineConfig {
                name: "native".into(),
                cpus: num_cpus(),
                memory_mb: total_memory_mb(),
                disk_gb: 0, // not meaningful for native
                runtime,
                mounts: vec![],
            },
            backend: MachineBackend::Native,
        }
    }
}

fn num_cpus() -> u32 {
    std::thread::available_parallelism()
        .map(|p| p.get() as u32)
        .unwrap_or(1)
}

fn total_memory_mb() -> u64 {
    // Linux: /proc/meminfo
    if let Ok(contents) = std::fs::read_to_string("/proc/meminfo") {
        if let Some(kb) = contents
            .lines()
            .find(|l| l.starts_with("MemTotal:"))
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|kb| kb.parse::<u64>().ok())
        {
            return kb / 1024;
        }
    }

    // Windows: use PowerShell
    #[cfg(target_os = "windows")]
    {
        if let Ok(output) = std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command",
                "(Get-CimInstance Win32_OperatingSystem).TotalVisibleMemorySize"])
            .output()
        {
            if let Ok(s) = String::from_utf8(output.stdout) {
                if let Ok(kb) = s.trim().parse::<u64>() {
                    return kb / 1024;
                }
            }
        }
    }

    0
}
