//! Daemon lifecycle management — start/stop the orca-daemon process.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;

use tokio::process::{Child, Command};

/// Manages the daemon process lifecycle.
pub struct DaemonManager {
    child: Mutex<Option<Child>>,
}

impl DaemonManager {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
        }
    }

    /// Start the daemon if not already running.
    /// If a daemon is running but has a different version, restart it.
    pub async fn start(&self) -> Result<(), String> {
        // Check if daemon is already responding
        if self.health_check().await {
            // Verify version matches this app
            let expected_version = env!("CARGO_PKG_VERSION");
            match self.daemon_version().await {
                Some(v) if v == expected_version => {
                    tracing::info!("Orca daemon already running (v{v})");
                    return Ok(());
                }
                Some(v) => {
                    tracing::info!("Daemon version mismatch: running v{v}, app is v{expected_version} — restarting");
                    self.stop();
                    // Wait for old daemon to fully exit
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                }
                None => {
                    tracing::info!("Orca daemon already running (version unknown)");
                    return Ok(());
                }
            }
        }

        let daemon_path = find_daemon_binary();
        tracing::info!("Starting orca-daemon from: {}", daemon_path);

        let mut cmd = Command::new(&daemon_path);
        cmd.stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);

        // On Windows, prevent the daemon from opening a visible console window
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }

        let child = cmd.spawn()
            .map_err(|e| format!("Failed to start daemon: {e}"))?;

        *self.child.lock().map_err(|e| format!("Lock poisoned: {e}"))? = Some(child);

        // Wait for daemon to become ready
        for _ in 0..30 {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            if self.health_check().await {
                tracing::info!("Orca daemon is ready");
                return Ok(());
            }
        }

        Err("Daemon started but failed to respond within 7.5 seconds".into())
    }

    /// Stop the daemon process (fire-and-forget).
    pub fn stop(&self) {
        if let Some(mut child) = self.child.lock().ok().and_then(|mut guard| guard.take()) {
            tracing::info!("Stopping orca-daemon");
            let _ = child.start_kill();
            // Brief sleep to give the process time to exit
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
    }

    /// Stop the daemon and wait for the process to fully exit.
    /// Important on Windows where the binary file is locked while the process runs.
    pub async fn stop_and_wait(&self) {
        if let Some(mut child) = self.child.lock().ok().and_then(|mut guard| guard.take()) {
            tracing::info!("Stopping orca-daemon and waiting for exit");
            let _ = child.start_kill();
            let _ = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                child.wait(),
            ).await;
            tracing::info!("orca-daemon stopped");
        }
    }

    /// Get the version of the running daemon, if available.
    async fn daemon_version(&self) -> Option<String> {
        let resp = reqwest::Client::new()
            .get("http://127.0.0.1:9477/api/v1/health")
            .timeout(std::time::Duration::from_secs(2))
            .send()
            .await
            .ok()?;
        let json: serde_json::Value = resp.json().await.ok()?;
        json["version"].as_str().map(|s| s.to_string())
    }

    async fn health_check(&self) -> bool {
        reqwest::Client::new()
            .get("http://127.0.0.1:9477/api/v1/health")
            .timeout(std::time::Duration::from_secs(2))
            .send()
            .await
            .is_ok()
    }
}

impl Drop for DaemonManager {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Find the daemon binary. Search order:
/// 1. Tauri sidecar location (bundled with the app)
/// 2. Next to the current executable
/// 3. Development build paths
/// 4. System PATH
pub fn find_daemon_binary() -> String {
    let bin_name = daemon_binary_name();

    // 1. Tauri sidecar: the binary is bundled alongside the app
    //    Tauri puts sidecars next to the exe with target triple suffix,
    //    but also copies without suffix
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            // Check with no suffix first (how Tauri 2 resolves externalBin)
            let sidecar = parent.join(bin_name);
            if sidecar.exists() {
                return sidecar.to_string_lossy().to_string();
            }

            // Check in a binaries/ subdirectory
            let sidecar_sub = parent.join("binaries").join(bin_name);
            if sidecar_sub.exists() {
                return sidecar_sub.to_string_lossy().to_string();
            }

            // Check Tauri resource directory patterns
            // On macOS: ../Resources/binaries/
            if let Some(grandparent) = parent.parent() {
                let macos_resource = grandparent.join("Resources").join("binaries").join(bin_name);
                if macos_resource.exists() {
                    return macos_resource.to_string_lossy().to_string();
                }
            }
        }
    }

    // 2. Development build paths
    let dev_paths = if cfg!(windows) {
        vec![
            PathBuf::from("./target/debug/orca-daemon.exe"),
            PathBuf::from("./target/release/orca-daemon.exe"),
        ]
    } else {
        vec![
            PathBuf::from("./target/debug/orca-daemon"),
            PathBuf::from("./target/release/orca-daemon"),
        ]
    };

    for path in &dev_paths {
        if path.exists() {
            return path.canonicalize()
                .map(|c| c.to_string_lossy().to_string())
                .unwrap_or_else(|_| path.to_string_lossy().to_string());
        }
    }

    // 3. Fall back to PATH
    bin_name.to_string()
}

fn daemon_binary_name() -> &'static str {
    if cfg!(windows) {
        "orca-daemon.exe"
    } else {
        "orca-daemon"
    }
}
