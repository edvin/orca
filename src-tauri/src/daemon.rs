//! Daemon lifecycle management — start/stop the orca-daemon process.

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
    /// Looks for orca-daemon next to the current executable, or in PATH.
    /// After the daemon starts, its API token will be available in the
    /// shared config file (~/.config/orca/config.json) and is read by
    /// the commands module on each request.
    pub async fn start(&self) -> Result<(), String> {
        // Check if daemon is already responding
        if self.health_check().await {
            tracing::info!("Orca daemon already running");
            return Ok(());
        }

        let daemon_path = find_daemon_binary();
        tracing::info!("Starting orca-daemon from: {}", daemon_path);

        let child = Command::new(&daemon_path)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("Failed to start daemon: {e}"))?;

        *self.child.lock().map_err(|e| format!("Lock poisoned: {e}"))? = Some(child);

        // Wait for daemon to become ready
        for _ in 0..20 {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            if self.health_check().await {
                tracing::info!("Orca daemon is ready");
                // The daemon generates an API token on first start and saves
                // it to the config file. The commands module reads it from
                // there for each request.
                return Ok(());
            }
        }

        Err("Daemon started but failed to respond within 5 seconds".into())
    }

    /// Stop the daemon process.
    pub fn stop(&self) {
        if let Some(mut child) = self.child.lock().ok().and_then(|mut guard| guard.take()) {
            tracing::info!("Stopping orca-daemon");
            // kill_on_drop handles cleanup, but let's be explicit
            let _ = child.start_kill();
        }
    }

    async fn health_check(&self) -> bool {
        reqwest::Client::new()
            .get("http://127.0.0.1:9477/api/v1/health")
            .timeout(std::time::Duration::from_secs(1))
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

/// Find the daemon binary — check next to current exe first, then PATH.
fn find_daemon_binary() -> String {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let sibling = parent.join("orca-daemon");
            if sibling.exists() {
                return sibling.to_string_lossy().to_string();
            }
        }
    }
    "orca-daemon".to_string()
}
