//! k3s-based Kubernetes cluster management.
//!
//! Handles k3s installation, lifecycle, and Kubernetes API access
//! via the `kube` crate. Works on all platforms — the k3s binary
//! runs inside the machine (native on Linux, Lima VM on macOS,
//! WSL2 on Windows).

use std::path::PathBuf;
use std::process::Stdio;

use kube::api::{Api, DeleteParams, ListParams, Patch, PatchParams};
use kube::Client;
use tokio::process::Command;

use orca_core::kubernetes::*;

/// k3s-based Kubernetes manager.
pub struct K3sManager {
    /// Override kubeconfig path (if None, uses default k3s location).
    kubeconfig_override: Option<PathBuf>,
    /// Cached kube client (re-created on failure).
    client: tokio::sync::Mutex<Option<Client>>,
}

impl K3sManager {
    pub fn new() -> Self {
        Self {
            kubeconfig_override: None,
            client: tokio::sync::Mutex::new(None),
        }
    }

    /// Create a K3sManager that uses a specific kubeconfig file.
    /// Useful for k3d clusters and testing.
    pub fn with_kubeconfig(path: PathBuf) -> Self {
        Self {
            kubeconfig_override: Some(path),
            client: tokio::sync::Mutex::new(None),
        }
    }

    /// Create from KUBECONFIG environment variable, falling back to default.
    pub fn from_env() -> Self {
        if let Ok(path) = std::env::var("KUBECONFIG") {
            Self::with_kubeconfig(PathBuf::from(path))
        } else {
            Self::new()
        }
    }

    /// Get the kubeconfig path (public for testing).
    pub fn kubeconfig_path_for_test(&self) -> PathBuf {
        self.kubeconfig_path()
    }

    /// Find the kubectl binary — prefer `k3s kubectl`, fall back to `kubectl`.
    /// Returns (binary, optional prefix args) so callers can use Command::new safely.
    fn kubectl_bin(&self) -> String {
        // Check for k3s first (direct install)
        if std::process::Command::new("k3s")
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok()
        {
            return "k3s kubectl".to_string();
        }
        "kubectl".to_string()
    }

    /// Build a Command for kubectl, handling the "k3s kubectl" case properly.
    fn kubectl_command(&self) -> Command {
        let bin = self.kubectl_bin();
        if bin.starts_with("k3s ") {
            let mut cmd = Command::new("k3s");
            cmd.arg("kubectl");
            cmd
        } else {
            Command::new("kubectl")
        }
    }

    fn kubeconfig_path(&self) -> PathBuf {
        if let Some(path) = &self.kubeconfig_override {
            return path.clone();
        }
        // Check KUBECONFIG env var
        if let Ok(path) = std::env::var("KUBECONFIG") {
            return PathBuf::from(path);
        }
        // Check all possible locations — works on any platform
        let mut candidates = Vec::new();
        // Windows: %USERPROFILE%\.kube\...
        if let Ok(profile) = std::env::var("USERPROFILE") {
            let base = PathBuf::from(profile).join(".kube");
            candidates.push(base.join("orca-k3s-config"));
            candidates.push(base.join("config"));
        }
        // Unix: ~/.kube/...
        if let Some(home) = dirs::home_dir() {
            let base = home.join(".kube");
            candidates.push(base.join("orca-k3s-config"));
            candidates.push(base.join("config"));
        }
        // Linux native k3s
        candidates.push(PathBuf::from("/etc/rancher/k3s/k3s.yaml"));

        for path in &candidates {
            if path.exists() {
                return path.clone();
            }
        }
        // Fallback (won't exist but gives a meaningful path)
        candidates.into_iter().last().unwrap_or_else(|| PathBuf::from("/etc/rancher/k3s/k3s.yaml"))
    }

    async fn get_client(&self) -> anyhow::Result<Client> {
        let mut cached = self.client.lock().await;
        if let Some(client) = cached.as_ref() {
            return Ok(client.clone());
        }

        let kubeconfig_path = self.kubeconfig_path();
        tracing::info!("K8s get_client: loading kubeconfig from {}", kubeconfig_path.display());
        if !kubeconfig_path.exists() {
            anyhow::bail!("Kubernetes not enabled — kubeconfig not found at {}", kubeconfig_path.display());
        }

        let kubeconfig = kube::config::Kubeconfig::read_from(&kubeconfig_path)
            .map_err(|e| { tracing::warn!("K8s: failed to parse kubeconfig: {e}"); e })?;
        let config = kube::Config::from_custom_kubeconfig(
            kubeconfig,
            &kube::config::KubeConfigOptions::default(),
        )
        .await
        .map_err(|e| { tracing::warn!("K8s: failed to create config from kubeconfig: {e}"); e })?;
        let client = Client::try_from(config)
            .map_err(|e| { tracing::warn!("K8s: failed to create client: {e}"); e })?;
        tracing::info!("K8s: client created successfully");
        *cached = Some(client.clone());
        Ok(client)
    }

    async fn is_k3s_installed(&self) -> bool {
        // Try native k3s first
        if Command::new("k3s")
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .is_ok_and(|s| s.success())
        {
            return true;
        }
        // On Windows, check inside WSL2
        #[cfg(target_os = "windows")]
        {
            if Command::new("wsl")
                .args(["-u", "root", "--", "which", "k3s"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .await
                .is_ok_and(|s| s.success())
            {
                return true;
            }
        }
        // Also check if kubectl is available (works for any k8s install)
        Command::new("kubectl")
            .arg("version")
            .args(["--client", "--short"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .is_ok_and(|s| s.success())
    }

    async fn install_k3s(&self) -> anyhow::Result<()> {
        tracing::info!("Installing k3s...");

        let output = Command::new("sh")
            .args([
                "-c",
                "curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC='server --write-kubeconfig-mode=644 --disable=metrics-server' sh -",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .await?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            anyhow::bail!("Failed to install k3s: {stderr}");
        }

        tracing::info!("k3s installed successfully");
        Ok(())
    }

    /// Enable k3s with step-by-step progress log returned as a string.
    pub async fn enable_with_progress(&self) -> anyhow::Result<String> {
        let mut log = String::new();

        // Platform check
        if cfg!(target_os = "windows") {
            log.push_str("Platform: Windows\n\n");
            log.push_str("Installing k3s inside WSL2... (use the streaming endpoint for live progress)\n");
            return Ok(log);
        }

        if cfg!(target_os = "macos") {
            log.push_str("Platform: macOS\n\n");

            if std::path::Path::new("/Applications/Docker.app").exists() {
                log.push_str("Docker Desktop detected.\n\n");
                log.push_str("Docker Desktop includes built-in Kubernetes support:\n");
                log.push_str("  1. Open Docker Desktop\n");
                log.push_str("  2. Go to Settings → Kubernetes\n");
                log.push_str("  3. Check 'Enable Kubernetes'\n");
                log.push_str("  4. Click 'Apply & Restart'\n\n");
                log.push_str("Once enabled, Orca Desktop will detect the cluster automatically.\n");
                return Ok(log);
            }

            log.push_str("k3s requires Linux. Set up a Lima VM first via System Health,\n");
            log.push_str("then Orca Desktop can install k3s inside it.\n");
            return Ok(log);
        }

        // Step 1: Check/install k3s (Linux)
        if !self.is_k3s_installed().await {
            log.push_str(">>> Downloading and installing k3s...\n");
            log.push_str("    This downloads the k3s binary (~60MB)\n\n");

            let output = Command::new("sh")
                .args([
                    "-c",
                    "curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC='server --write-kubeconfig-mode=644 --disable=metrics-server' sh - 2>&1",
                ])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .output()
                .await?;

            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            if !stdout.trim().is_empty() {
                log.push_str(&format!("{}\n", stdout.trim()));
            }
            if !stderr.trim().is_empty() {
                log.push_str(&format!("{}\n", stderr.trim()));
            }

            if !output.status.success() {
                log.push_str("\n>>> k3s installation failed\n");
                anyhow::bail!("{log}");
            }
            log.push_str("\n>>> k3s binary installed\n\n");
        } else {
            log.push_str(">>> k3s is already installed\n\n");
        }

        // Step 2: Start k3s
        log.push_str(">>> Starting k3s server...\n");
        let systemd_result = Command::new("systemctl")
            .args(["start", "k3s"])
            .output()
            .await;

        match &systemd_result {
            Ok(o) if o.status.success() => {
                log.push_str("    Started via systemd\n\n");
            }
            _ => {
                log.push_str("    systemd not available, starting directly...\n");
                Command::new("k3s")
                    .args(["server", "--write-kubeconfig-mode=644", "--disable=metrics-server"])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()?;
                log.push_str("    k3s server process spawned\n\n");
            }
        }

        // Step 3: Wait for cluster readiness
        log.push_str(">>> Waiting for cluster to become ready...\n");
        for i in 0..60 {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;

            if !self.kubeconfig_path().exists() {
                if i % 10 == 9 {
                    log.push_str(&format!("    Waiting for kubeconfig... ({i}s)\n"));
                }
                continue;
            }

            if let Ok(client) = self.get_client().await {
                match client.apiserver_version().await {
                    Ok(ver) => {
                        log.push_str(&format!("    API server ready — Kubernetes v{}.{}\n\n", ver.major, ver.minor));

                        // Step 4: Enable Traefik dashboard
                        log.push_str(">>> Enabling Traefik dashboard...\n");
                        match self.enable_traefik_dashboard().await {
                            Ok(_) => log.push_str("    Dashboard available at http://127.0.0.1:9000/dashboard/\n\n"),
                            Err(e) => log.push_str(&format!("    Dashboard setup failed (non-critical): {e}\n\n")),
                        }

                        log.push_str(">>> Kubernetes cluster is ready\n");
                        return Ok(log);
                    }
                    Err(_) => {
                        if i % 10 == 9 {
                            log.push_str(&format!("    Waiting for API server... ({i}s)\n"));
                        }
                    }
                }
            }
        }

        log.push_str("\n>>> Timed out waiting for API server (60s)\n");
        anyhow::bail!("{log}")
    }

    /// Enable k3s with streaming progress via a channel.
    pub async fn enable_streaming(&self, tx: tokio::sync::mpsc::Sender<String>) -> anyhow::Result<()> {
        use crate::environment::run_cmd_streaming;

        let send = |msg: String| {
            let tx = tx.clone();
            async move { let _ = tx.send(msg).await; }
        };

        // Platform check
        // Use runtime detection — the daemon may be a Windows binary
        // managing Docker/k3s inside WSL2
        let platform = if cfg!(target_os = "macos") {
            "macos"
        } else if cfg!(target_os = "windows") {
            "windows"
        } else if cfg!(target_os = "linux") {
            // Could be native Linux OR WSL2
            "linux"
        } else {
            // Runtime fallback: check for WSL
            if std::env::var("WSL_DISTRO_NAME").is_ok() || std::path::Path::new("/proc/sys/fs/binfmt_misc/WSLInterop").exists() {
                "linux"
            } else {
                "unsupported"
            }
        };

        send(format!("Platform: {platform}")).await;

        if platform == "macos" {
            send("".into()).await;

            // Check if Docker Desktop is installed — it has built-in K8s
            if std::path::Path::new("/Applications/Docker.app").exists() {
                send("Docker Desktop detected.".into()).await;
                send("".into()).await;
                send("Docker Desktop includes built-in Kubernetes support:".into()).await;
                send("  1. Open Docker Desktop".into()).await;
                send("  2. Go to Settings → Kubernetes".into()).await;
                send("  3. Check 'Enable Kubernetes'".into()).await;
                send("  4. Click 'Apply & Restart'".into()).await;
                send("".into()).await;
                send("Once enabled, Orca Desktop will detect the cluster automatically.".into()).await;
                anyhow::bail!("Enable Kubernetes via Docker Desktop settings");
            }

            // Check if Lima is available — install k3s inside the Lima VM
            send("Checking for Lima VM...".into()).await;
            match crate::environment::run_cmd("limactl", &["list", "--format", "{{.Name}}"]).await {
                Ok(vms) => {
                    let vm_name = vms.lines().find(|l| !l.trim().is_empty());
                    if let Some(vm) = vm_name {
                        send(format!("Found Lima VM: {vm}")).await;
                        send("Installing k3s inside the Lima VM...".into()).await;
                        send("".into()).await;

                        // Install k3s inside the Lima VM
                        let install_result = crate::environment::run_cmd_streaming(
                            "limactl", &["shell", vm, "sudo", "sh", "-c",
                                "curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC='server --write-kubeconfig-mode=644 --disable=metrics-server' sh -"
                            ], &tx
                        ).await;

                        match install_result {
                            Ok(_) => {
                                send("\n>>> k3s installed in Lima VM".into()).await;

                                // Copy kubeconfig from VM
                                send(">>> Copying kubeconfig...".into()).await;
                                match crate::environment::run_cmd(
                                    "limactl", &["shell", vm, "sudo", "cat", "/etc/rancher/k3s/k3s.yaml"]
                                ).await {
                                    Ok(kubeconfig) => {
                                        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
                                        let kube_dir = format!("{home}/.kube");
                                        let _ = std::fs::create_dir_all(&kube_dir);
                                        let default_path = format!("{kube_dir}/config");
                                        let kube_path = if std::path::Path::new(&default_path).exists() {
                                            let alt = format!("{kube_dir}/orca-k3s-config");
                                            send(format!("Existing kubeconfig found, writing to {alt}")).await;
                                            alt
                                        } else {
                                            default_path
                                        };
                                        // Replace localhost with the Lima VM IP
                                        let fixed = kubeconfig.replace("127.0.0.1", "localhost");
                                        std::fs::write(&kube_path, &fixed)
                                            .map_err(|e| anyhow::anyhow!("Failed to write kubeconfig: {e}"))?;
                                        send(format!("Kubeconfig written to {kube_path}")).await;
                                    }
                                    Err(e) => {
                                        send(format!("Warning: could not copy kubeconfig: {e}")).await;
                                    }
                                }

                                send("".into()).await;
                                send(">>> Waiting for cluster to become ready...".into()).await;
                                for i in 0..60 {
                                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                                    if let Ok(output) = crate::environment::run_cmd(
                                        "limactl", &["shell", vm, "sudo", "k3s", "kubectl", "get", "nodes"]
                                    ).await {
                                        if output.contains("Ready") {
                                            send(format!("    Cluster ready!\n\n{output}")).await;
                                            send("".into()).await;
                                            send(">>> Kubernetes is ready in your Lima VM.".into()).await;
                                            return Ok(());
                                        }
                                    }
                                    if i % 5 == 4 {
                                        send(format!("    Waiting... ({i}s)")).await;
                                    }
                                }
                                anyhow::bail!("k3s installed but cluster didn't become ready within 120s");
                            }
                            Err(e) => {
                                send(format!("\nk3s installation failed: {e}")).await;
                                anyhow::bail!("Failed to install k3s in Lima VM: {e}");
                            }
                        }
                    } else {
                        send("No Lima VM found.".into()).await;
                        send("".into()).await;
                        send("To use Kubernetes on macOS, you need either:".into()).await;
                        send("  1. Docker Desktop (has built-in Kubernetes)".into()).await;
                        send("  2. A Lima VM (created via System Health setup)".into()).await;
                        send("".into()).await;
                        send("Set up a container runtime first via System Health, then try again.".into()).await;
                        anyhow::bail!("No container runtime VM found. Set up Docker first via System Health.");
                    }
                }
                Err(_) => {
                    send("Lima is not installed.".into()).await;
                    send("".into()).await;
                    send("To use Kubernetes on macOS, you need either:".into()).await;
                    send("  1. Docker Desktop (has built-in Kubernetes)".into()).await;
                    send("  2. Lima + Docker (set up via System Health)".into()).await;
                    send("".into()).await;
                    send("Set up a container runtime first, then try again.".into()).await;
                    anyhow::bail!("No container runtime available. Set up Docker first via System Health.");
                }
            }
        }

        if platform == "unsupported" {
            // Detect Windows at runtime (cfg! is compile-time, but daemon may be cross-compiled)
            send("".into()).await;
            send("Unsupported platform for automatic k3s installation.".into()).await;
            send("Install k3s manually: curl -sfL https://get.k3s.io | sudo sh -".into()).await;
            anyhow::bail!("Unsupported platform");
        }

        // Windows: install k3s inside WSL2
        #[cfg(target_os = "windows")]
        {
            send("".into()).await;
            send(">>> Installing Kubernetes (k3s) inside WSL2...".into()).await;
            send("".into()).await;

            // Check WSL is available
            send(">>> Checking WSL2...".into()).await;
            let wsl_check = Command::new("wsl")
                .args(["--status"])
                .output()
                .await;

            if wsl_check.is_err() || !wsl_check.as_ref().unwrap().status.success() {
                send("WSL2 is not installed or not running.".into()).await;
                send("".into()).await;
                send("Install WSL2 first:".into()).await;
                send("  wsl --install".into()).await;
                send("Then restart your computer and try again.".into()).await;
                anyhow::bail!("WSL2 is not available. Run 'wsl --install' first.");
            }
            send("    WSL2 is available".into()).await;

            // Check if k3s is already installed
            let k3s_check = Command::new("wsl")
                .args(["-u", "root", "--", "which", "k3s"])
                .output()
                .await;

            let k3s_installed = k3s_check.map(|o| o.status.success()).unwrap_or(false);

            if !k3s_installed {
                send("".into()).await;
                send(">>> Downloading and installing k3s in WSL2...".into()).await;
                send("    This downloads the k3s binary (~60MB)\n".into()).await;

                let install_result = run_cmd_streaming("wsl", &[
                    "-u", "root", "--", "sh", "-c",
                    "curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC='server --write-kubeconfig-mode=644 --disable=metrics-server' sh -"
                ], &tx).await;

                match install_result {
                    Ok(_) => send("\n>>> k3s installed in WSL2\n".into()).await,
                    Err(e) => {
                        send(format!("\n>>> k3s installation failed: {e}")).await;
                        anyhow::bail!("Failed to install k3s in WSL2: {e}");
                    }
                }
            } else {
                send(">>> k3s is already installed in WSL2\n".into()).await;

                // Make sure k3s service is running
                send(">>> Starting k3s service...".into()).await;
                let _ = Command::new("wsl")
                    .args(["-u", "root", "--", "sh", "-c", "systemctl start k3s 2>/dev/null || k3s server --write-kubeconfig-mode=644 --disable=metrics-server &"])
                    .output()
                    .await;
            }

            // Copy kubeconfig from WSL2
            send(">>> Copying kubeconfig from WSL2...".into()).await;
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;

            let kubeconfig_result = Command::new("wsl")
                .args(["-u", "root", "--", "cat", "/etc/rancher/k3s/k3s.yaml"])
                .output()
                .await;

            match kubeconfig_result {
                Ok(output) if output.status.success() => {
                    let kubeconfig = String::from_utf8_lossy(&output.stdout).to_string();
                    let home = std::env::var("USERPROFILE").unwrap_or_else(|_| std::env::var("HOME").unwrap_or_else(|_| "C:\\Users\\Default".into()));
                    let kube_dir = format!("{home}\\.kube");
                    let _ = std::fs::create_dir_all(&kube_dir);
                    let default_path = format!("{kube_dir}\\config");
                    let kube_path = if std::path::Path::new(&default_path).exists() {
                        let alt = format!("{kube_dir}\\orca-k3s-config");
                        send(format!("    Existing kubeconfig found, writing to {alt}")).await;
                        alt
                    } else {
                        default_path
                    };
                    std::fs::write(&kube_path, &kubeconfig)
                        .map_err(|e| anyhow::anyhow!("Failed to write kubeconfig: {e}"))?;
                    send(format!("    Kubeconfig written to {kube_path}")).await;
                }
                _ => {
                    send("    Warning: could not copy kubeconfig yet (cluster may still be starting)".into()).await;
                }
            }

            // Wait for cluster readiness
            send("".into()).await;
            send(">>> Waiting for cluster to become ready...".into()).await;
            for i in 0..60 {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                if let Ok(output) = Command::new("wsl")
                    .args(["-u", "root", "--", "k3s", "kubectl", "get", "nodes"])
                    .output()
                    .await
                {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    if stdout.contains("Ready") {
                        send(format!("    Cluster ready!\n\n{stdout}")).await;
                        send("".into()).await;
                        send(">>> Kubernetes is ready in WSL2.".into()).await;
                        return Ok(());
                    }
                }
                if i % 5 == 4 {
                    send(format!("    Waiting... ({}s)", i * 2)).await;
                }
            }
            anyhow::bail!("k3s installed but cluster didn't become ready within 120s");
        }

        // Step 1: Check/install k3s
        if !self.is_k3s_installed().await {
            send("".into()).await;
            send(">>> Downloading and installing k3s...".into()).await;
            send("    This downloads the k3s binary (~60MB)\n".into()).await;

            let result = run_cmd_streaming("sudo", &[
                "-n", "sh", "-c",
                "curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC='server --write-kubeconfig-mode=644 --disable=metrics-server' sh -"
            ], &tx).await;

            match result {
                Ok(_) => send("\n>>> k3s binary installed\n".into()).await,
                Err(e) => {
                    send(format!("\n>>> k3s installation failed: {e}")).await;
                    send("".into()).await;
                    send("This may require sudo access. Try manually:".into()).await;
                    send("  curl -sfL https://get.k3s.io | sudo sh -".into()).await;
                    send("Then restart Orca Desktop.".into()).await;
                    anyhow::bail!("k3s installation failed: {e}");
                }
            }
        } else {
            send(">>> k3s is already installed\n".into()).await;
        }

        // Step 2: Start k3s
        send(">>> Starting k3s server...".into()).await;
        let systemd_result = Command::new("systemctl")
            .args(["start", "k3s"])
            .output()
            .await;

        match &systemd_result {
            Ok(o) if o.status.success() => {
                send("    Started via systemd\n".into()).await;
            }
            _ => {
                send("    systemd not available, starting directly...".into()).await;
                match Command::new("k3s")
                    .args(["server", "--write-kubeconfig-mode=644", "--disable=metrics-server"])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                {
                    Ok(_) => send("    k3s server process spawned\n".into()).await,
                    Err(e) => {
                        send(format!("    Failed to start k3s: {e}")).await;
                        anyhow::bail!("Failed to start k3s: {e}");
                    }
                }
            }
        }

        // Step 3: Wait for cluster readiness
        send(">>> Waiting for cluster to become ready...".into()).await;
        for i in 0..120 {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;

            if !self.kubeconfig_path().exists() {
                if i % 5 == 4 {
                    send(format!("    Waiting for kubeconfig... ({i}s)")).await;
                }
                continue;
            }

            if let Ok(client) = self.get_client().await {
                match client.apiserver_version().await {
                    Ok(ver) => {
                        send(format!("    API server ready — Kubernetes v{}.{}\n", ver.major, ver.minor)).await;

                        // Step 4: Enable Traefik dashboard
                        send(">>> Enabling Traefik dashboard...".into()).await;
                        match self.enable_traefik_dashboard().await {
                            Ok(_) => send("    Dashboard available at http://127.0.0.1:9000/dashboard/\n".into()).await,
                            Err(e) => send(format!("    Dashboard setup failed (non-critical): {e}\n")).await,
                        }

                        send(">>> Kubernetes cluster is ready".into()).await;
                        return Ok(());
                    }
                    Err(_) => {
                        if i % 5 == 4 {
                            send(format!("    Waiting for API server... ({i}s)")).await;
                        }
                    }
                }
            }
        }

        send(">>> Timed out waiting for API server (120s)".into()).await;
        anyhow::bail!("k3s started but API server didn't become ready within 120 seconds")
    }
}

impl K8sManager for K3sManager {
    async fn enable(&self) -> anyhow::Result<()> {
        if !self.is_k3s_installed().await {
            self.install_k3s().await?;
        }

        // Start k3s via systemd if available, otherwise direct
        let systemd_result = Command::new("systemctl")
            .args(["start", "k3s"])
            .status()
            .await;

        if systemd_result.is_err() || !systemd_result.as_ref().is_ok_and(|s| s.success()) {
            // Fallback: start k3s directly in background
            Command::new("k3s")
                .args(["server", "--write-kubeconfig-mode=644", "--disable=metrics-server"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()?;
        }

        // Wait for k3s to become ready
        for _ in 0..60 {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            if self.kubeconfig_path().exists() {
                if let Ok(client) = self.get_client().await {
                    if let Ok(_) = client.apiserver_version().await.map(|_| ()) {
                        tracing::info!("k3s cluster is ready");

                        // Enable Traefik dashboard
                        self.enable_traefik_dashboard().await.ok();

                        return Ok(());
                    }
                }
            }
        }

        anyhow::bail!("k3s started but API server didn't become ready within 60 seconds")
    }

    async fn disable(&self) -> anyhow::Result<()> {
        // Try systemd first
        let _ = Command::new("systemctl")
            .args(["stop", "k3s"])
            .status()
            .await;

        // Also try k3s-killall.sh which k3s installs
        let _ = Command::new("sh")
            .args(["-c", "/usr/local/bin/k3s-killall.sh 2>/dev/null || true"])
            .status()
            .await;

        Ok(())
    }

    async fn reset(&self) -> anyhow::Result<()> {
        self.disable().await?;

        // k3s-uninstall.sh removes everything
        let output = Command::new("sh")
            .args(["-c", "/usr/local/bin/k3s-uninstall.sh 2>/dev/null || true"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .await?;

        tracing::info!("k3s reset: {}", String::from_utf8_lossy(&output.stderr));

        // Re-enable
        self.enable().await
    }

    async fn status(&self) -> anyhow::Result<ClusterStatus> {
        let kubeconfig_path = self.kubeconfig_path();
        let kubeconfig_exists = kubeconfig_path.exists();
        tracing::info!("K8s status: kubeconfig path={}, exists={}", kubeconfig_path.display(), kubeconfig_exists);

        // Log all candidate paths for debugging
        {
            let mut candidates = Vec::new();
            if let Ok(profile) = std::env::var("USERPROFILE") {
                let base = PathBuf::from(&profile).join(".kube");
                candidates.push(("USERPROFILE orca-k3s", base.join("orca-k3s-config")));
                candidates.push(("USERPROFILE config", base.join("config")));
            }
            if let Some(home) = dirs::home_dir() {
                let base = home.join(".kube");
                candidates.push(("HOME orca-k3s", base.join("orca-k3s-config")));
                candidates.push(("HOME config", base.join("config")));
            }
            candidates.push(("k3s default", PathBuf::from("/etc/rancher/k3s/k3s.yaml")));
            for (label, path) in &candidates {
                tracing::info!("  K8s candidate [{}]: {} (exists={})", label, path.display(), path.exists());
            }
        }

        if !kubeconfig_exists {
            // Check if k3s is installed (for direct installs)
            let installed = self.is_k3s_installed().await;
            tracing::info!("K8s status: no kubeconfig found, is_k3s_installed={}", installed);
            return Ok(ClusterStatus {
                enabled: installed,
                running: false,
                version: None,
                node_name: None,
                node_status: None,
                pods_running: 0,
                pods_total: 0,
                traefik_dashboard: None,
                error: Some(format!("Kubeconfig not found at {}", kubeconfig_path.display())),
            });
        }

        let client = match self.get_client().await {
            Ok(c) => c,
            Err(e) => {
                let err_msg = format!("Kubeconfig found at {} but client creation failed: {e}", kubeconfig_path.display());
                tracing::warn!("K8s status: {}", err_msg);
                return Ok(ClusterStatus {
                    enabled: true,
                    running: false,
                    version: None,
                    node_name: None,
                    node_status: None,
                    pods_running: 0,
                    pods_total: 0,
                    traefik_dashboard: None,
                    error: Some(err_msg),
                });
            }
        };

        // On Windows, always use WSL commands — port forwarding to k3s is unreliable
        #[cfg(target_os = "windows")]
        {
            tracing::info!("K8s status: checking via WSL kubectl...");
            // Ensure k3s is running
            let _ = Command::new("wsl")
                .args(["-u", "root", "--", "bash", "-c",
                    "systemctl start k3s 2>/dev/null || service k3s start 2>/dev/null || true"])
                .output()
                .await;

            if let Ok(output) = Command::new("wsl")
                .args(["-u", "root", "--", "k3s", "kubectl", "get", "nodes", "-o", "jsonpath={.items[0].metadata.name},{.items[0].status.conditions[?(@.type==\"Ready\")].status},{range .items[0].status.nodeInfo}{.kubeletVersion}{end}"])
                .output()
                .await
            {
                let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !text.is_empty() && output.status.success() {
                    let parts: Vec<&str> = text.split(',').collect();
                    let wsl_node_name = parts.first().unwrap_or(&"").to_string();
                    let wsl_ready = parts.get(1).map(|s| *s == "True").unwrap_or(false);
                    let wsl_version = parts.get(2).unwrap_or(&"").to_string();
                    tracing::info!("K8s via WSL: node={}, ready={}, version={}", wsl_node_name, wsl_ready, wsl_version);

                    // Get pod counts
                    let (pods_r, pods_t) = if let Ok(pod_out) = Command::new("wsl")
                        .args(["-u", "root", "--", "k3s", "kubectl", "get", "pods", "-A", "--no-headers"])
                        .output()
                        .await
                    {
                        let pod_text = String::from_utf8_lossy(&pod_out.stdout);
                        (pod_text.lines().filter(|l| l.contains("Running")).count() as u32,
                         pod_text.lines().count() as u32)
                    } else { (0, 0) };

                    return Ok(ClusterStatus {
                        enabled: true,
                        running: wsl_ready,
                        version: if wsl_version.is_empty() { None } else { Some(wsl_version) },
                        node_name: if wsl_node_name.is_empty() { None } else { Some(wsl_node_name) },
                        node_status: if wsl_ready { Some("Ready".to_string()) } else { Some("NotReady".to_string()) },
                        pods_running: pods_r,
                        pods_total: pods_t,
                        traefik_dashboard: if wsl_ready { Some("http://127.0.0.1:9000/dashboard/".to_string()) } else { None },
                        error: None,
                    });
                }
            }
            // WSL kubectl failed — k3s not installed or WSL not available
            return Ok(ClusterStatus {
                enabled: self.is_k3s_installed().await,
                running: false,
                version: None, node_name: None, node_status: None,
                pods_running: 0, pods_total: 0, traefik_dashboard: None,
                error: Some("Could not reach k3s via WSL".to_string()),
            });
        }

        // Non-Windows: use the kube client directly
        #[cfg(not(target_os = "windows"))]
        {
            let api_result = client.apiserver_version().await;
            let running = api_result.is_ok();
            match &api_result {
                Ok(ver) => tracing::info!("K8s status: API server reachable, version {}.{}", ver.major, ver.minor),
                Err(e) => tracing::info!("K8s status: API server not reachable: {e}"),
            }

            let version = if running {
                client.apiserver_version().await.ok().map(|v| format!("v{}.{}", v.major, v.minor))
            } else { None };

            let (node_name, node_status) = if running {
                let nodes: Api<k8s_openapi::api::core::v1::Node> = Api::all(client.clone());
                nodes.list(&ListParams::default()).await.ok()
                    .and_then(|list| list.items.first().map(|n| {
                        let name = n.metadata.name.clone().unwrap_or_default();
                        let status = n.status.as_ref()
                            .and_then(|s| s.conditions.as_ref())
                            .and_then(|conds| conds.iter().find(|c| c.type_ == "Ready")
                                .map(|c| if c.status == "True" { "Ready".to_string() } else { "NotReady".to_string() }))
                            .unwrap_or_else(|| "Unknown".to_string());
                        (name, status)
                    }))
                    .map(|(n, s)| (Some(n), Some(s)))
                    .unwrap_or((None, None))
            } else { (None, None) };

            let (pods_running, pods_total) = if running {
                let pods: Api<k8s_openapi::api::core::v1::Pod> = Api::all(client.clone());
                pods.list(&ListParams::default()).await.ok()
                    .map(|list| {
                        let total = list.items.len() as u32;
                        let r = list.items.iter()
                            .filter(|p| p.status.as_ref().and_then(|s| s.phase.as_deref()) == Some("Running"))
                            .count() as u32;
                        (r, total)
                    })
                    .unwrap_or((0, 0))
            } else { (0, 0) };

            return Ok(ClusterStatus {
                enabled: true, running, version, node_name, node_status,
                pods_running, pods_total,
                traefik_dashboard: if running { Some("http://127.0.0.1:9000/dashboard/".to_string()) } else { None },
                error: if !running { Some(format!("API server at {} not reachable", kubeconfig_path.display())) } else { None },
            });
        }
    }

    async fn kubeconfig(&self) -> anyhow::Result<String> {
        let path = self.kubeconfig_path();
        if !path.exists() {
            anyhow::bail!("Kubernetes not enabled");
        }
        Ok(tokio::fs::read_to_string(&path).await?)
    }

    async fn install_kubeconfig(&self) -> anyhow::Result<PathBuf> {
        let source = self.kubeconfig().await?;
        // Replace 127.0.0.1:6443 server address if needed
        let kubeconfig = source.replace("127.0.0.1", "127.0.0.1");

        let dest = dirs::home_dir()
            .unwrap_or_default()
            .join(".kube");
        tokio::fs::create_dir_all(&dest).await?;

        let dest_file = dest.join("config");

        // If no existing kubeconfig, just write ours
        if !dest_file.exists() {
            tokio::fs::write(&dest_file, &kubeconfig).await?;
            tracing::info!("Wrote kubeconfig to {}", dest_file.display());
        } else {
            // Write as a separate file and let the user merge
            let orca_config = dest.join("orca-k3s-config");
            tokio::fs::write(&orca_config, &kubeconfig).await?;
            tracing::info!(
                "Wrote k3s kubeconfig to {}. Set KUBECONFIG={}:{} to use both.",
                orca_config.display(),
                dest_file.display(),
                orca_config.display()
            );
        }

        Ok(dest_file)
    }

    // --- WSL kubectl helper (Windows) ---

    #[cfg(target_os = "windows")]
    async fn wsl_kubectl_json(&self, args: &[&str]) -> anyhow::Result<serde_json::Value> {
        let mut cmd_args = vec!["-u", "root", "--", "k3s", "kubectl"];
        cmd_args.extend_from_slice(args);
        cmd_args.extend_from_slice(&["-o", "json"]);
        let output = Command::new("wsl")
            .args(&cmd_args)
            .output()
            .await?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            anyhow::bail!("kubectl failed: {stderr}");
        }
        Ok(serde_json::from_slice(&output.stdout)?)
    }

    // --- Workload queries ---

    async fn list_namespaces(&self) -> anyhow::Result<Vec<Namespace>> {
        #[cfg(target_os = "windows")]
        {
            let json = self.wsl_kubectl_json(&["get", "namespaces"]).await?;
            let items = json["items"].as_array().unwrap_or(&vec![]);
            return Ok(items.iter().map(|ns| {
                Namespace {
                    name: ns["metadata"]["name"].as_str().unwrap_or("").to_string(),
                    status: ns["status"]["phase"].as_str().unwrap_or("Active").to_string(),
                    age: ns["metadata"]["creationTimestamp"].as_str().unwrap_or("").to_string(),
                }
            }).collect());
        }

        #[cfg(not(target_os = "windows"))]
        {
            let client = self.get_client().await?;
            let api: Api<k8s_openapi::api::core::v1::Namespace> = Api::all(client.clone());
            let list = api.list(&ListParams::default()).await?;
            Ok(list.items.iter().map(|ns| {
                let name = ns.metadata.name.clone().unwrap_or_default();
                let status = ns.status.as_ref().and_then(|s| s.phase.clone()).unwrap_or_else(|| "Active".to_string());
                let age = format_k8s_age(&ns.metadata.creation_timestamp);
                Namespace { name, status, age }
            }).collect())
        }
    }

    async fn list_pods(&self, namespace: &str) -> anyhow::Result<Vec<Pod>> {
        #[cfg(target_os = "windows")]
        {
            let json = self.wsl_kubectl_json(&["get", "pods", "-n", namespace]).await?;
            let items = json["items"].as_array().unwrap_or(&vec![]);
            return Ok(items.iter().map(|p| {
                let name = p["metadata"]["name"].as_str().unwrap_or("").to_string();
                let phase = p["status"]["phase"].as_str().unwrap_or("Unknown").to_string();
                let containers: Vec<_> = p["spec"]["containers"].as_array()
                    .map(|c| c.iter().filter_map(|c| c["name"].as_str().map(|s| s.to_string())).collect())
                    .unwrap_or_default();
                let ready = p["status"]["containerStatuses"].as_array()
                    .map(|cs| cs.iter().filter(|c| c["ready"].as_bool().unwrap_or(false)).count() as u32)
                    .unwrap_or(0);
                let total = containers.len() as u32;
                let restarts = p["status"]["containerStatuses"].as_array()
                    .map(|cs| cs.iter().map(|c| c["restartCount"].as_u64().unwrap_or(0) as u32).sum())
                    .unwrap_or(0);
                let image = p["spec"]["containers"].as_array()
                    .and_then(|c| c.first())
                    .and_then(|c| c["image"].as_str())
                    .unwrap_or("").to_string();
                let age = p["metadata"]["creationTimestamp"].as_str().unwrap_or("").to_string();
                Pod {
                    name, namespace: namespace.to_string(), status: phase,
                    ready, total, restarts, image, age,
                    node: p["spec"]["nodeName"].as_str().unwrap_or("").to_string(),
                }
            }).collect());
        }

        #[cfg(not(target_os = "windows"))]
        {
            let client = self.get_client().await?;
            let api: Api<k8s_openapi::api::core::v1::Pod> = Api::namespaced(client.clone(), namespace);
            let list = api.list(&ListParams::default()).await?;
            Ok(list.items.iter().map(|p| k8s_pod_to_pod(p, namespace)).collect())
        }
    }

    async fn list_deployments(&self, namespace: &str) -> anyhow::Result<Vec<Deployment>> {
        #[cfg(target_os = "windows")]
        {
            let json = self.wsl_kubectl_json(&["get", "deployments", "-n", namespace]).await?;
            let items = json["items"].as_array().unwrap_or(&vec![]);
            return Ok(items.iter().map(|d| {
                let name = d["metadata"]["name"].as_str().unwrap_or("").to_string();
                let replicas_ready = d["status"]["readyReplicas"].as_u64().unwrap_or(0) as u32;
                let replicas_desired = d["spec"]["replicas"].as_u64().unwrap_or(1) as u32;
                let age = d["metadata"]["creationTimestamp"].as_str().unwrap_or("").to_string();
                let images = d["spec"]["template"]["spec"]["containers"].as_array()
                    .map(|cs| cs.iter().filter_map(|c| c["image"].as_str().map(|s| s.to_string())).collect())
                    .unwrap_or_default();
                Deployment { name, namespace: namespace.to_string(), replicas_ready, replicas_desired, age, images }
            }).collect());
        }

        #[cfg(not(target_os = "windows"))]
        {
            let client = self.get_client().await?;
            let api: Api<k8s_openapi::api::apps::v1::Deployment> =
                Api::namespaced(client.clone(), namespace);
            let list = api.list(&ListParams::default()).await?;

            Ok(list
                .items
                .iter()
                .map(|d| {
                    let name = d.metadata.name.clone().unwrap_or_default();
                    let status = d.status.as_ref();
                    let replicas_ready = status.and_then(|s| s.ready_replicas).unwrap_or(0) as u32;
                    let replicas_desired = d
                        .spec
                        .as_ref()
                        .and_then(|s| s.replicas)
                        .unwrap_or(1) as u32;
                    let age = format_k8s_age(&d.metadata.creation_timestamp);
                    let images = d
                        .spec
                        .as_ref()
                        .and_then(|s| s.template.spec.as_ref())
                        .map(|spec| {
                            spec.containers
                                .iter()
                                .filter_map(|c| c.image.clone())
                                .collect()
                        })
                        .unwrap_or_default();

                    Deployment {
                        name,
                        namespace: namespace.to_string(),
                        replicas_ready,
                        replicas_desired,
                        age,
                        images,
                    }
                })
                .collect())
        }
    }

    async fn list_services(&self, namespace: &str) -> anyhow::Result<Vec<Service>> {
        #[cfg(target_os = "windows")]
        {
            let json = self.wsl_kubectl_json(&["get", "services", "-n", namespace]).await?;
            let items = json["items"].as_array().unwrap_or(&vec![]);
            return Ok(items.iter().map(|s| {
                let ports = s["spec"]["ports"].as_array()
                    .map(|ps| ps.iter().map(|p| ServicePort {
                        name: p["name"].as_str().map(|s| s.to_string()),
                        port: p["port"].as_i64().unwrap_or(0) as i32,
                        target_port: p["targetPort"].as_i64()
                            .map(|i| i.to_string())
                            .or_else(|| p["targetPort"].as_str().map(|s| s.to_string()))
                            .unwrap_or_default(),
                        node_port: p["nodePort"].as_i64().map(|n| n as i32),
                        protocol: p["protocol"].as_str().unwrap_or("TCP").to_string(),
                    }).collect())
                    .unwrap_or_default();
                let external_ip = s["status"]["loadBalancer"]["ingress"].as_array()
                    .and_then(|ing| ing.first())
                    .and_then(|i| i["ip"].as_str())
                    .map(|s| s.to_string());
                Service {
                    name: s["metadata"]["name"].as_str().unwrap_or("").to_string(),
                    namespace: namespace.to_string(),
                    service_type: s["spec"]["type"].as_str().unwrap_or("ClusterIP").to_string(),
                    cluster_ip: s["spec"]["clusterIP"].as_str().map(|s| s.to_string()),
                    external_ip,
                    ports,
                    age: s["metadata"]["creationTimestamp"].as_str().unwrap_or("").to_string(),
                }
            }).collect());
        }

        #[cfg(not(target_os = "windows"))]
        {
            let client = self.get_client().await?;
            let api: Api<k8s_openapi::api::core::v1::Service> =
                Api::namespaced(client.clone(), namespace);
            let list = api.list(&ListParams::default()).await?;

            Ok(list
                .items
                .iter()
                .map(|s| {
                    let spec = s.spec.as_ref();
                    let ports = spec
                        .and_then(|sp| sp.ports.as_ref())
                        .map(|ports| {
                            ports
                                .iter()
                                .map(|p| ServicePort {
                                    name: p.name.clone(),
                                    port: p.port,
                                    target_port: p
                                        .target_port
                                        .as_ref()
                                        .map(|tp| match tp {
                                            k8s_openapi::apimachinery::pkg::util::intstr::IntOrString::Int(i) => i.to_string(),
                                            k8s_openapi::apimachinery::pkg::util::intstr::IntOrString::String(s) => s.clone(),
                                        })
                                        .unwrap_or_default(),
                                    node_port: p.node_port,
                                    protocol: p.protocol.clone().unwrap_or_else(|| "TCP".to_string()),
                                })
                                .collect()
                        })
                        .unwrap_or_default();

                    Service {
                        name: s.metadata.name.clone().unwrap_or_default(),
                        namespace: namespace.to_string(),
                        service_type: spec
                            .and_then(|sp| sp.type_.clone())
                            .unwrap_or_else(|| "ClusterIP".to_string()),
                        cluster_ip: spec.and_then(|sp| sp.cluster_ip.clone()),
                        external_ip: s
                            .status
                            .as_ref()
                            .and_then(|st| st.load_balancer.as_ref())
                            .and_then(|lb| lb.ingress.as_ref())
                            .and_then(|ing| ing.first())
                            .and_then(|i| i.ip.clone()),
                        ports,
                        age: format_k8s_age(&s.metadata.creation_timestamp),
                    }
                })
                .collect())
        }
    }

    async fn list_ingresses(&self, namespace: &str) -> anyhow::Result<Vec<Ingress>> {
        #[cfg(target_os = "windows")]
        {
            let json = self.wsl_kubectl_json(&["get", "ingresses", "-n", namespace]).await?;
            let items = json["items"].as_array().unwrap_or(&vec![]);
            return Ok(items.iter().map(|i| {
                let hosts = i["spec"]["rules"].as_array()
                    .map(|rules| rules.iter().filter_map(|r| r["host"].as_str().map(|s| s.to_string())).collect())
                    .unwrap_or_default();
                let address = i["status"]["loadBalancer"]["ingress"].as_array()
                    .and_then(|ing| ing.first())
                    .and_then(|i| i["ip"].as_str())
                    .map(|s| s.to_string());
                Ingress {
                    name: i["metadata"]["name"].as_str().unwrap_or("").to_string(),
                    namespace: namespace.to_string(),
                    hosts,
                    address,
                    age: i["metadata"]["creationTimestamp"].as_str().unwrap_or("").to_string(),
                }
            }).collect());
        }

        #[cfg(not(target_os = "windows"))]
        {
            let client = self.get_client().await?;
            let api: Api<k8s_openapi::api::networking::v1::Ingress> =
                Api::namespaced(client.clone(), namespace);
            let list = api.list(&ListParams::default()).await?;

            Ok(list
                .items
                .iter()
                .map(|i| {
                    let hosts = i
                        .spec
                        .as_ref()
                        .and_then(|s| s.rules.as_ref())
                        .map(|rules| {
                            rules
                                .iter()
                                .filter_map(|r| r.host.clone())
                                .collect()
                        })
                        .unwrap_or_default();

                    let address = i
                        .status
                        .as_ref()
                        .and_then(|s| s.load_balancer.as_ref())
                        .and_then(|lb| lb.ingress.as_ref())
                        .and_then(|ing| ing.first())
                        .and_then(|i| i.ip.clone());

                    Ingress {
                        name: i.metadata.name.clone().unwrap_or_default(),
                        namespace: namespace.to_string(),
                        hosts,
                        address,
                        age: format_k8s_age(&i.metadata.creation_timestamp),
                    }
                })
                .collect())
        }
    }

    async fn list_pvcs(&self, namespace: &str) -> anyhow::Result<Vec<PersistentVolumeClaim>> {
        #[cfg(target_os = "windows")]
        {
            let json = self.wsl_kubectl_json(&["get", "pvc", "-n", namespace]).await?;
            let items = json["items"].as_array().unwrap_or(&vec![]);
            return Ok(items.iter().map(|pvc| {
                let access_modes = pvc["spec"]["accessModes"].as_array()
                    .map(|modes| modes.iter().filter_map(|m| m.as_str().map(|s| s.to_string())).collect())
                    .unwrap_or_default();
                PersistentVolumeClaim {
                    name: pvc["metadata"]["name"].as_str().unwrap_or("").to_string(),
                    namespace: namespace.to_string(),
                    status: pvc["status"]["phase"].as_str().unwrap_or("Pending").to_string(),
                    volume: pvc["spec"]["volumeName"].as_str().map(|s| s.to_string()),
                    capacity: pvc["status"]["capacity"]["storage"].as_str().map(|s| s.to_string()),
                    access_modes,
                    storage_class: pvc["spec"]["storageClassName"].as_str().map(|s| s.to_string()),
                    age: pvc["metadata"]["creationTimestamp"].as_str().unwrap_or("").to_string(),
                }
            }).collect());
        }

        #[cfg(not(target_os = "windows"))]
        {
            let client = self.get_client().await?;
            let api: Api<k8s_openapi::api::core::v1::PersistentVolumeClaim> =
                Api::namespaced(client.clone(), namespace);
            let list = api.list(&ListParams::default()).await?;

            Ok(list
                .items
                .iter()
                .map(|pvc| {
                    let spec = pvc.spec.as_ref();
                    let status = pvc.status.as_ref();

                    PersistentVolumeClaim {
                        name: pvc.metadata.name.clone().unwrap_or_default(),
                        namespace: namespace.to_string(),
                        status: status
                            .and_then(|s| s.phase.clone())
                            .unwrap_or_else(|| "Pending".to_string()),
                        volume: spec.and_then(|s| s.volume_name.clone()),
                        capacity: status
                            .and_then(|s| s.capacity.as_ref())
                            .and_then(|c| c.get("storage"))
                            .map(|q| q.0.clone()),
                        access_modes: spec
                            .and_then(|s| s.access_modes.clone())
                            .unwrap_or_default(),
                        storage_class: spec.and_then(|s| s.storage_class_name.clone()),
                        age: format_k8s_age(&pvc.metadata.creation_timestamp),
                    }
                })
                .collect())
        }
    }

    async fn list_pvs(&self) -> anyhow::Result<Vec<PersistentVolume>> {
        #[cfg(target_os = "windows")]
        {
            let json = self.wsl_kubectl_json(&["get", "pv"]).await?;
            let items = json["items"].as_array().unwrap_or(&vec![]);
            return Ok(items.iter().map(|pv| {
                let access_modes = pv["spec"]["accessModes"].as_array()
                    .map(|modes| modes.iter().filter_map(|m| m.as_str().map(|s| s.to_string())).collect())
                    .unwrap_or_default();
                let claim = pv["spec"]["claimRef"].as_object().map(|cr| {
                    format!("{}/{}",
                        cr.get("namespace").and_then(|v| v.as_str()).unwrap_or("default"),
                        cr.get("name").and_then(|v| v.as_str()).unwrap_or(""))
                });
                PersistentVolume {
                    name: pv["metadata"]["name"].as_str().unwrap_or("").to_string(),
                    capacity: pv["spec"]["capacity"]["storage"].as_str().map(|s| s.to_string()),
                    access_modes,
                    reclaim_policy: pv["spec"]["persistentVolumeReclaimPolicy"].as_str().map(|s| s.to_string()),
                    status: pv["status"]["phase"].as_str().unwrap_or("Available").to_string(),
                    claim,
                    storage_class: pv["spec"]["storageClassName"].as_str().map(|s| s.to_string()),
                    age: pv["metadata"]["creationTimestamp"].as_str().unwrap_or("").to_string(),
                }
            }).collect());
        }

        #[cfg(not(target_os = "windows"))]
        {
            let client = self.get_client().await?;
            let api: Api<k8s_openapi::api::core::v1::PersistentVolume> = Api::all(client.clone());
            let list = api.list(&ListParams::default()).await?;

            Ok(list
                .items
                .iter()
                .map(|pv| {
                    let spec = pv.spec.as_ref();
                    let status = pv.status.as_ref();

                    PersistentVolume {
                        name: pv.metadata.name.clone().unwrap_or_default(),
                        capacity: spec
                            .and_then(|s| s.capacity.as_ref())
                            .and_then(|c| c.get("storage"))
                            .map(|q| q.0.clone()),
                        access_modes: spec
                            .and_then(|s| s.access_modes.clone())
                            .unwrap_or_default(),
                        reclaim_policy: spec.and_then(|s| s.persistent_volume_reclaim_policy.clone()),
                        status: status
                            .and_then(|s| s.phase.clone())
                            .unwrap_or_else(|| "Available".to_string()),
                        claim: spec
                            .and_then(|s| s.claim_ref.as_ref())
                            .map(|cr| {
                                format!(
                                    "{}/{}",
                                    cr.namespace.as_deref().unwrap_or("default"),
                                    cr.name.as_deref().unwrap_or("")
                                )
                            }),
                        storage_class: spec.and_then(|s| s.storage_class_name.clone()),
                        age: format_k8s_age(&pv.metadata.creation_timestamp),
                    }
                })
                .collect())
        }
    }

    // --- Workload actions ---

    async fn delete_pod(&self, namespace: &str, name: &str) -> anyhow::Result<()> {
        #[cfg(target_os = "windows")]
        {
            let output = Command::new("wsl")
                .args(["-u", "root", "--", "k3s", "kubectl", "delete", "pod", name, "-n", namespace])
                .output()
                .await?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                anyhow::bail!("kubectl delete pod failed: {stderr}");
            }
            return Ok(());
        }

        #[cfg(not(target_os = "windows"))]
        {
            let client = self.get_client().await?;
            let api: Api<k8s_openapi::api::core::v1::Pod> =
                Api::namespaced(client.clone(), namespace);
            api.delete(name, &DeleteParams::default()).await?;
            Ok(())
        }
    }

    async fn scale_deployment(
        &self,
        namespace: &str,
        name: &str,
        replicas: u32,
    ) -> anyhow::Result<()> {
        #[cfg(target_os = "windows")]
        {
            let replicas_arg = format!("--replicas={replicas}");
            let dep_arg = format!("deployment/{name}");
            let output = Command::new("wsl")
                .args(["-u", "root", "--", "k3s", "kubectl", "scale", &dep_arg, &replicas_arg, "-n", namespace])
                .output()
                .await?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                anyhow::bail!("kubectl scale failed: {stderr}");
            }
            return Ok(());
        }

        #[cfg(not(target_os = "windows"))]
        {
            let client = self.get_client().await?;
            let api: Api<k8s_openapi::api::apps::v1::Deployment> =
                Api::namespaced(client.clone(), namespace);

            let patch = serde_json::json!({
                "spec": {
                    "replicas": replicas
                }
            });
            api.patch(name, &PatchParams::apply("orca"), &Patch::Merge(&patch))
                .await?;
            Ok(())
        }
    }

    async fn restart_deployment(&self, namespace: &str, name: &str) -> anyhow::Result<()> {
        #[cfg(target_os = "windows")]
        {
            let dep_arg = format!("deployment/{name}");
            let output = Command::new("wsl")
                .args(["-u", "root", "--", "k3s", "kubectl", "rollout", "restart", &dep_arg, "-n", namespace])
                .output()
                .await?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                anyhow::bail!("kubectl rollout restart failed: {stderr}");
            }
            return Ok(());
        }

        #[cfg(not(target_os = "windows"))]
        {
            let client = self.get_client().await?;
            let api: Api<k8s_openapi::api::apps::v1::Deployment> =
                Api::namespaced(client.clone(), namespace);

            // Trigger a rollout restart by updating an annotation
            let now = chrono::Utc::now().to_rfc3339();
            let patch = serde_json::json!({
                "spec": {
                    "template": {
                        "metadata": {
                            "annotations": {
                                "orca.dev/restartedAt": now
                            }
                        }
                    }
                }
            });
            api.patch(name, &PatchParams::apply("orca"), &Patch::Merge(&patch))
                .await?;
            Ok(())
        }
    }

    async fn delete_pvc(&self, namespace: &str, name: &str) -> anyhow::Result<()> {
        #[cfg(target_os = "windows")]
        {
            let output = Command::new("wsl")
                .args(["-u", "root", "--", "k3s", "kubectl", "delete", "pvc", name, "-n", namespace])
                .output()
                .await?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                anyhow::bail!("kubectl delete pvc failed: {stderr}");
            }
            return Ok(());
        }

        #[cfg(not(target_os = "windows"))]
        {
            let client = self.get_client().await?;
            let api: Api<k8s_openapi::api::core::v1::PersistentVolumeClaim> =
                Api::namespaced(client.clone(), namespace);
            api.delete(name, &DeleteParams::default()).await?;
            Ok(())
        }
    }

    async fn pod_logs(
        &self,
        namespace: &str,
        name: &str,
        container: Option<&str>,
        tail: Option<u32>,
    ) -> anyhow::Result<Vec<String>> {
        #[cfg(target_os = "windows")]
        {
            let mut cmd_args = vec!["-u", "root", "--", "k3s", "kubectl", "logs", name, "-n", namespace];
            let container_arg;
            if let Some(c) = container {
                container_arg = format!("--container={c}");
                cmd_args.push(&container_arg);
            }
            let tail_arg;
            if let Some(t) = tail {
                tail_arg = format!("--tail={t}");
                cmd_args.push(&tail_arg);
            }
            let output = Command::new("wsl")
                .args(&cmd_args)
                .output()
                .await?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                anyhow::bail!("kubectl logs failed: {stderr}");
            }
            let stdout = String::from_utf8_lossy(&output.stdout);
            return Ok(stdout.lines().map(|l| l.to_string()).collect());
        }

        #[cfg(not(target_os = "windows"))]
        {
            let client = self.get_client().await?;
            let api: Api<k8s_openapi::api::core::v1::Pod> =
                Api::namespaced(client.clone(), namespace);

            let mut params = kube::api::LogParams {
                tail_lines: tail.map(|t| t as i64),
                ..Default::default()
            };
            if let Some(c) = container {
                params.container = Some(c.to_string());
            }

            let logs = api.logs(name, &params).await?;
            Ok(logs.lines().map(|l| l.to_string()).collect())
        }
    }

    async fn apply_yaml(&self, yaml: &str) -> anyhow::Result<String> {
        #[cfg(target_os = "windows")]
        {
            let mut child = Command::new("wsl")
                .args(["-u", "root", "--", "k3s", "kubectl", "apply", "-f", "-"])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()?;

            if let Some(mut stdin) = child.stdin.take() {
                use tokio::io::AsyncWriteExt;
                stdin.write_all(yaml.as_bytes()).await?;
            }

            let output = child.wait_with_output().await?;
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);

            return if output.status.success() {
                Ok(stdout.to_string())
            } else {
                anyhow::bail!("{stderr}")
            };
        }

        #[cfg(not(target_os = "windows"))]
        {
            let mut child = self.kubectl_command()
                .args(["apply", "-f", "-"])
                .env("KUBECONFIG", self.kubeconfig_path())
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()?;

            if let Some(mut stdin) = child.stdin.take() {
                use tokio::io::AsyncWriteExt;
                stdin.write_all(yaml.as_bytes()).await?;
            }

            let output = child.wait_with_output().await?;
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);

            if output.status.success() {
                Ok(stdout.to_string())
            } else {
                anyhow::bail!("{stderr}")
            }
        }
    }

    async fn delete_yaml(&self, yaml: &str) -> anyhow::Result<String> {
        #[cfg(target_os = "windows")]
        {
            let mut child = Command::new("wsl")
                .args(["-u", "root", "--", "k3s", "kubectl", "delete", "-f", "-"])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()?;

            if let Some(mut stdin) = child.stdin.take() {
                use tokio::io::AsyncWriteExt;
                stdin.write_all(yaml.as_bytes()).await?;
            }

            let output = child.wait_with_output().await?;
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);

            return if output.status.success() {
                Ok(stdout.to_string())
            } else {
                anyhow::bail!("{stderr}")
            };
        }

        #[cfg(not(target_os = "windows"))]
        {
            let mut child = self.kubectl_command()
                .args(["delete", "-f", "-"])
                .env("KUBECONFIG", self.kubeconfig_path())
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()?;

            if let Some(mut stdin) = child.stdin.take() {
                use tokio::io::AsyncWriteExt;
                stdin.write_all(yaml.as_bytes()).await?;
            }

            let output = child.wait_with_output().await?;
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);

            if output.status.success() {
                Ok(stdout.to_string())
            } else {
                anyhow::bail!("{stderr}")
            }
        }
    }
}

impl K3sManager {
    /// Enable the Traefik dashboard by patching the Traefik deployment.
    async fn enable_traefik_dashboard(&self) -> anyhow::Result<()> {
        // Expose Traefik dashboard via IngressRoute
        let dashboard_yaml = r#"
apiVersion: traefik.io/v1alpha1
kind: IngressRoute
metadata:
  name: traefik-dashboard
  namespace: kube-system
spec:
  entryPoints:
    - web
  routes:
    - match: PathPrefix(`/dashboard`) || PathPrefix(`/api`)
      kind: Rule
      services:
        - name: api@internal
          kind: TraefikService
"#;

        // Apply via kubectl since Traefik CRDs might not be in k8s-openapi
        let _ = self.apply_yaml(dashboard_yaml).await;
        Ok(())
    }
}

// --- Helper functions ---

fn k8s_pod_to_pod(p: &k8s_openapi::api::core::v1::Pod, namespace: &str) -> Pod {
    let status = p.status.as_ref();
    let spec = p.spec.as_ref();

    let phase = status
        .and_then(|s| s.phase.clone())
        .unwrap_or_else(|| "Unknown".to_string());

    let container_statuses = status
        .and_then(|s| s.container_statuses.clone())
        .unwrap_or_default();

    let ready_count = container_statuses.iter().filter(|c| c.ready).count();
    let total_count = container_statuses.len();

    let restarts: u32 = container_statuses
        .iter()
        .map(|c| c.restart_count as u32)
        .sum();

    let containers = container_statuses
        .iter()
        .map(|cs| {
            let state = if let Some(s) = &cs.state {
                if s.running.is_some() {
                    "Running"
                } else if s.waiting.is_some() {
                    "Waiting"
                } else if s.terminated.is_some() {
                    "Terminated"
                } else {
                    "Unknown"
                }
            } else {
                "Unknown"
            };

            PodContainer {
                name: cs.name.clone(),
                image: cs.image.clone(),
                ready: cs.ready,
                restart_count: cs.restart_count as u32,
                state: state.to_string(),
            }
        })
        .collect();

    Pod {
        name: p.metadata.name.clone().unwrap_or_default(),
        namespace: namespace.to_string(),
        status: phase,
        ready: format!("{ready_count}/{total_count}"),
        restarts,
        age: format_k8s_age(&p.metadata.creation_timestamp),
        node: spec.and_then(|s| s.node_name.clone()),
        ip: status.and_then(|s| s.pod_ip.clone()),
        containers,
    }
}

fn format_k8s_age(
    timestamp: &Option<k8s_openapi::apimachinery::pkg::apis::meta::v1::Time>,
) -> String {
    match timestamp {
        Some(t) => {
            let now = chrono::Utc::now();
            let created = t.0;
            let duration = now.signed_duration_since(created);

            if duration.num_days() > 0 {
                format!("{}d", duration.num_days())
            } else if duration.num_hours() > 0 {
                format!("{}h", duration.num_hours())
            } else if duration.num_minutes() > 0 {
                format!("{}m", duration.num_minutes())
            } else {
                format!("{}s", duration.num_seconds())
            }
        }
        None => "Unknown".to_string(),
    }
}
