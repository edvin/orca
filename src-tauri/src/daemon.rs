//! Daemon lifecycle management — start/stop the orca-daemon process.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::process::{Child, Command};

/// Restarts allowed within [`RESTART_WINDOW`] before the watchdog gives up and
/// leaves it to the user (the connection screen's Start button).
const MAX_RESTARTS: usize = 3;
/// The daemon's port, which the CLI, the MCP server and this app all use.
pub const PORT: u16 = 9477;
const RESTART_WINDOW: Duration = Duration::from_secs(600);

/// Manages the daemon process lifecycle.
pub struct DaemonManager {
    child: Mutex<Option<Child>>,
    /// Serializes `start()`: two overlapping starts would each spawn a daemon,
    /// and storing the second child drops (and so kills) the first.
    start_lock: tokio::sync::Mutex<()>,
}

impl DaemonManager {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
            start_lock: tokio::sync::Mutex::new(()),
        }
    }

    /// Restart the daemon this app started if it exits on its own (crash,
    /// OOM, killed). The only place that restarts after a crash; the
    /// frontend just shows the state.
    ///
    /// Leaves alone: deliberate stops (`stop()` takes the child first, so
    /// there is nothing to watch), a daemon this app didn't start (a dev
    /// daemon, one from an earlier app session), and a port that something
    /// else already answers on.
    pub fn spawn_watchdog(self: &Arc<Self>) {
        let dm = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let mut restarts: VecDeque<Instant> = VecDeque::new();
            loop {
                tokio::time::sleep(Duration::from_secs(5)).await;
                let exited = {
                    let Ok(mut guard) = dm.child.lock() else { continue };
                    match guard.as_mut().map(|c| c.try_wait()) {
                        Some(Ok(Some(status))) => {
                            guard.take();
                            Some(status)
                        }
                        _ => None,
                    }
                };
                let Some(status) = exited else { continue };
                tracing::warn!("orca-daemon exited unexpectedly ({status})");

                if dm.health_check().await {
                    tracing::info!("Another daemon is answering on the port; not restarting");
                    continue;
                }
                let now = Instant::now();
                while restarts
                    .front()
                    .is_some_and(|t| now.duration_since(*t) > RESTART_WINDOW)
                {
                    restarts.pop_front();
                }
                if restarts.len() >= MAX_RESTARTS {
                    tracing::error!(
                        "orca-daemon exited {MAX_RESTARTS} times in {} min; not restarting again",
                        RESTART_WINDOW.as_secs() / 60
                    );
                    continue;
                }
                restarts.push_back(now);
                tracing::info!("Restarting orca-daemon");
                if let Err(e) = dm.start().await {
                    tracing::error!("Restarting orca-daemon failed: {e}");
                }
            }
        });
    }

    /// Start the daemon if not already running.
    /// If a daemon is running but has a different version, restart it.
    pub async fn start(&self) -> Result<(), String> {
        let _serial = self.start_lock.lock().await;
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
                    self.kill_existing_daemon().await;
                }
                None => {
                    tracing::info!(
                        "Orca daemon already running (version unknown) — restarting to ensure correct version"
                    );
                    self.kill_existing_daemon().await;
                }
            }
        }

        // Twice at most: an older daemon that holds the port without
        // answering is quit, and the start tried again.
        for attempt in 0..2 {
            let Err(e) = self.spawn_and_wait().await else {
                return Ok(());
            };
            tracing::warn!("{e}");
            if !self.child_exited() {
                return Err(format!(
                    "The daemon is running but hasn't answered yet. It may still be starting: click Retry connection in a moment. Its log is {}",
                    log_path().display()
                ));
            }
            match port_holder(PORT) {
                Some(h) if is_daemon(&h.name) && attempt == 0 => {
                    tracing::warn!(
                        "An older daemon (PID {}) holds port {PORT} without answering; quitting it",
                        h.pid
                    );
                    quit_process(h.pid).await;
                }
                Some(h) => {
                    return Err(format!(
                        "Port {PORT} is in use by {} (PID {}), so Orca's daemon can't start.",
                        h.name, h.pid
                    ));
                }
                None => {
                    return Err(match last_log_line() {
                        Some(line) => format!("The daemon stopped right after starting: {line}"),
                        None => e,
                    });
                }
            }
        }
        Err(format!("Port {PORT} is still in use after quitting the older daemon"))
    }

    /// Whether the daemon this app started has exited.
    fn child_exited(&self) -> bool {
        self.child
            .lock()
            .ok()
            .and_then(|mut guard| guard.as_mut().map(|c| c.try_wait().ok().flatten().is_some()))
            .unwrap_or(true)
    }

    /// Start the daemon process and wait up to 7.5 seconds for it to answer.
    async fn spawn_and_wait(&self) -> Result<(), String> {
        let daemon_path = find_daemon_binary();
        tracing::info!("Starting orca-daemon from: {}", daemon_path);

        // Log daemon output to a file for debugging
        let log_path = log_path();
        let log_dir = log_path.parent().map(|p| p.to_path_buf()).unwrap_or_default();
        let _ = std::fs::create_dir_all(&log_dir);
        // Keep the previous run's log: after a crash it says why.
        let _ = std::fs::rename(&log_path, log_dir.join("daemon.prev.log"));
        let log_file = std::fs::File::create(&log_path)
            .map(Stdio::from)
            .unwrap_or_else(|_| Stdio::null());
        let err_file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .map(Stdio::from)
            .unwrap_or_else(|_| Stdio::null());
        tracing::info!("Daemon log: {}", log_path.display());

        let mut cmd = Command::new(&daemon_path);
        cmd.stdout(log_file).stderr(err_file).kill_on_drop(true);

        // On Windows, prevent the daemon from opening a visible console window
        #[cfg(target_os = "windows")]
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

        let child = cmd.spawn().map_err(|e| format!("Failed to start daemon: {e}"))?;

        *self.child.lock().map_err(|e| format!("Lock poisoned: {e}"))? = Some(child);

        // Wait for daemon to become ready. It usually is within ~100 ms, so
        // check often rather than making every launch wait a full 250 ms.
        for _ in 0..150 {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
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
            let _ = tokio::time::timeout(std::time::Duration::from_secs(5), child.wait()).await;
            tracing::info!("orca-daemon stopped");
        }
    }

    /// Kill any existing daemon process — even one spawned by a previous app version.
    async fn kill_existing_daemon(&self) {
        // First try our tracked child
        self.stop();

        // Also kill by process name (catches daemons from previous app installs)
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            let _ = std::process::Command::new("taskkill")
                .args(["/f", "/im", "orca-daemon.exe"])
                .creation_flags(0x08000000) // CREATE_NO_WINDOW
                .output();
        }
        #[cfg(not(target_os = "windows"))]
        {
            // Match the process name exactly, NOT the command line. Using
            // `-f` would also kill `cargo run --bin orca-daemon`, editor
            // sessions viewing the code, log tails, etc.
            let _ = std::process::Command::new("pkill").args(["-x", "orca-daemon"]).output();
        }

        // Wait for the process to fully exit and release the port
        for _ in 0..10 {
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            if !self.health_check().await {
                tracing::info!("Old daemon has exited");
                return;
            }
        }
        tracing::warn!("Old daemon may still be running after kill attempts");
    }

    /// Get the version of the running daemon, if available.
    async fn daemon_version(&self) -> Option<String> {
        let resp = local_client()
            .get("http://127.0.0.1:9477/api/v1/health")
            .timeout(std::time::Duration::from_secs(2))
            .send()
            .await
            .ok()?;
        let json: serde_json::Value = resp.json().await.ok()?;
        json["version"].as_str().map(|s| s.to_string())
    }

    async fn health_check(&self) -> bool {
        // Be strict: verify the endpoint returned 2xx AND a valid JSON body
        // with a "status" field of "ok". This prevents false-positives when
        // an unrelated process binds port 9477.
        let resp = match local_client()
            .get("http://127.0.0.1:9477/api/v1/health")
            .timeout(std::time::Duration::from_secs(2))
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => r,
            _ => return false,
        };
        match resp.json::<serde_json::Value>().await {
            Ok(json) => json.get("status").and_then(|v| v.as_str()) == Some("ok"),
            Err(_) => false,
        }
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
    //    Tauri puts sidecars next to the exe with target triple suffix
    let sidecar_name = if cfg!(target_os = "windows") {
        format!(
            "orca-daemon-{}.exe",
            std::env::consts::ARCH.replace("x86_64", "x86_64-pc-windows-msvc")
        )
    } else if cfg!(target_os = "macos") {
        format!("orca-daemon-{}-apple-darwin", std::env::consts::ARCH)
    } else {
        format!("orca-daemon-{}-unknown-linux-gnu", std::env::consts::ARCH)
    };

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            // Check with target triple suffix (Tauri sidecar convention)
            let sidecar_triple = parent.join(&sidecar_name);
            if sidecar_triple.exists() {
                return sidecar_triple.to_string_lossy().to_string();
            }

            // Check without suffix
            let sidecar = parent.join(bin_name);
            if sidecar.exists() {
                return sidecar.to_string_lossy().to_string();
            }

            // Check in a binaries/ subdirectory
            let sidecar_sub = parent.join("binaries").join(bin_name);
            if sidecar_sub.exists() {
                return sidecar_sub.to_string_lossy().to_string();
            }
            let sidecar_sub_triple = parent.join("binaries").join(&sidecar_name);
            if sidecar_sub_triple.exists() {
                return sidecar_sub_triple.to_string_lossy().to_string();
            }

            // Check Tauri resource directory patterns
            // On macOS: ../Resources/binaries/
            if let Some(grandparent) = parent.parent() {
                for name in &[bin_name, sidecar_name.as_str()] {
                    let macos_resource = grandparent.join("Resources").join("binaries").join(name);
                    if macos_resource.exists() {
                        return macos_resource.to_string_lossy().to_string();
                    }
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
            return path
                .canonicalize()
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

/// The daemon's log, beside Orca's config.
fn log_path() -> PathBuf {
    orca_core::config::OrcaConfig::config_path()
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("daemon.log")
}

/// The daemon log's last line, which says why it stopped.
fn last_log_line() -> Option<String> {
    let text = std::fs::read_to_string(log_path()).ok()?;
    text.lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .map(|l| l.trim().to_string())
}

/// A program listening on a port.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct PortHolder {
    pub pid: u32,
    pub name: String,
}

fn is_daemon(name: &str) -> bool {
    name.eq_ignore_ascii_case("orca-daemon") || name.eq_ignore_ascii_case("orca-daemon.exe")
}

/// The program listening on `port` on this computer, if one is.
pub fn port_holder(port: u16) -> Option<PortHolder> {
    #[cfg(not(windows))]
    {
        // Apps start with a short PATH; lsof is in /usr/sbin on macOS.
        let lsof = if std::path::Path::new("/usr/sbin/lsof").exists() {
            "/usr/sbin/lsof"
        } else {
            "lsof"
        };
        let out = std::process::Command::new(lsof)
            .args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-Fpc"])
            .output()
            .ok()?;
        parse_lsof(&String::from_utf8_lossy(&out.stdout))
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let out = std::process::Command::new("netstat")
            .args(["-ano", "-p", "TCP"])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .output()
            .ok()?;
        let pid = parse_netstat(&String::from_utf8_lossy(&out.stdout), port)?;
        let out = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .creation_flags(0x08000000)
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        let name = text
            .split(',')
            .next()
            .unwrap_or_default()
            .trim()
            .trim_matches('"')
            .to_string();
        Some(PortHolder {
            pid,
            name: if name.is_empty() || name.starts_with("INFO") {
                format!("process {pid}")
            } else {
                name
            },
        })
    }
}

/// `lsof -Fpc` output: `p<pid>`, then `c<command>`.
#[cfg_attr(windows, allow(dead_code))]
fn parse_lsof(text: &str) -> Option<PortHolder> {
    let mut pid = None;
    for line in text.lines() {
        if let Some(p) = line.strip_prefix('p') {
            pid = p.trim().parse().ok();
        } else if let (Some(name), Some(pid)) = (line.strip_prefix('c'), pid) {
            return Some(PortHolder {
                pid,
                name: name.trim().to_string(),
            });
        }
    }
    None
}

/// The PID listening on `port` in `netstat -ano` output.
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_netstat(text: &str, port: u16) -> Option<u32> {
    text.lines().find_map(|line| {
        let cols: Vec<&str> = line.split_whitespace().collect();
        match cols.as_slice() {
            [proto, local, _, state, pid]
                if proto.eq_ignore_ascii_case("TCP")
                    && state.eq_ignore_ascii_case("LISTENING")
                    && local.ends_with(&format!(":{port}")) =>
            {
                pid.parse().ok()
            }
            _ => None,
        }
    })
}

/// Ask a process to quit, and make it if it hasn't within three seconds.
pub async fn quit_process(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F"])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .output();
    }
    #[cfg(not(windows))]
    {
        let pid = pid.to_string();
        let _ = std::process::Command::new("kill").args(["-TERM", &pid]).output();
        for _ in 0..30 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let alive = std::process::Command::new("kill")
                .args(["-0", &pid])
                .output()
                .is_ok_and(|o| o.status.success());
            if !alive {
                return;
            }
        }
        let _ = std::process::Command::new("kill").args(["-KILL", &pid]).output();
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

/// One client for the local daemon's health checks, reused across calls.
fn local_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

#[cfg(test)]
mod tests {
    #[test]
    fn port_holder_from_lsof() {
        assert_eq!(
            super::parse_lsof("p4242\ncorca-daemon\nf12\n"),
            Some(super::PortHolder {
                pid: 4242,
                name: "orca-daemon".into()
            })
        );
        assert_eq!(super::parse_lsof(""), None);
    }

    #[test]
    fn port_holder_from_netstat() {
        let text = "\nActive Connections\n\n  Proto  Local Address          Foreign Address        State           PID\n  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1012\n  TCP    127.0.0.1:9477         0.0.0.0:0              LISTENING       5120\n  TCP    127.0.0.1:9477         127.0.0.1:50000        ESTABLISHED     5120\n";
        assert_eq!(super::parse_netstat(text, 9477), Some(5120));
        assert_eq!(super::parse_netstat(text, 19477), None);
    }
}
