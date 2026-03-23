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

/// Validate that a string is a safe Kubernetes resource name
/// (alphanumeric, hyphens, dots; 1-253 chars).
fn validate_k8s_name(name: &str) -> anyhow::Result<()> {
    if name.is_empty() || name.len() > 253 {
        anyhow::bail!("Invalid Kubernetes name: length");
    }
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.') {
        anyhow::bail!("Invalid Kubernetes name: {name}");
    }
    Ok(())
}

/// Extract the `kind` field from a YAML string without a full parser.
fn extract_yaml_kind(yaml: &str) -> Option<String> {
    for line in yaml.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("kind:") {
            return Some(
                trimmed
                    .trim_start_matches("kind:")
                    .trim()
                    .trim_matches('"')
                    .trim_matches('\'')
                    .to_string(),
            );
        }
    }
    None
}

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
    /// Always uses --context orca to avoid connecting to the user's remote clusters.
    fn kubectl_command(&self) -> Command {
        let bin = self.kubectl_bin();
        let mut cmd = if bin.starts_with("k3s ") {
            let mut c = Command::new("k3s");
            c.arg("kubectl");
            c
        } else {
            let mut c = Command::new("kubectl");
            c.env("PATH", Self::extended_path());
            // Use our context (k3s kubectl doesn't need this — it only has one context)
            c.arg("--context").arg(Self::CONTEXT_NAME);
            c
        };
        cmd
    }

    /// Our context name in ~/.kube/config
    const CONTEXT_NAME: &'static str = "orca";

    /// Extended PATH that includes common binary locations.
    /// macOS app bundles have a minimal PATH that misses /opt/homebrew/bin.
    fn extended_path() -> String {
        let current = std::env::var("PATH").unwrap_or_default();
        format!("/usr/local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/sbin:{current}")
    }

    fn kubeconfig_path(&self) -> PathBuf {
        if let Some(path) = &self.kubeconfig_override {
            return path.clone();
        }
        if let Ok(path) = std::env::var("KUBECONFIG") {
            return PathBuf::from(path);
        }

        // Standard kubeconfig path — we merge our "orca" context into it
        // on all platforms. We only connect if it has our context.

        // Windows
        if let Ok(profile) = std::env::var("USERPROFILE") {
            let p = PathBuf::from(profile).join(".kube").join("config");
            if p.exists() { return p; }
        }
        // Unix
        if let Some(home) = dirs::home_dir() {
            let p = home.join(".kube").join("config");
            if p.exists() { return p; }
        }
        // Linux native k3s (direct install, not merged yet)
        if PathBuf::from("/etc/rancher/k3s/k3s.yaml").exists() {
            return PathBuf::from("/etc/rancher/k3s/k3s.yaml");
        }
        // Fallback — standard path (won't exist = K8s not enabled)
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("/root"))
            .join(".kube").join("config")
    }

    /// Merge k3s kubeconfig into ~/.kube/config as the "orca" context.
    /// Uses kubectl config commands to safely modify the kubeconfig.
    fn merge_kubeconfig_context() -> anyhow::Result<()> {
        let k3s_config = "/etc/rancher/k3s/k3s.yaml";
        let k3s_content = std::fs::read_to_string(k3s_config)?;

        // Extract server URL from k3s config (usually https://127.0.0.1:6443)
        let server = k3s_content.lines()
            .find(|l| l.trim().starts_with("server:"))
            .and_then(|l| l.split_once(':').map(|(_, v)| v.trim().trim_matches('"').to_string()))
            .unwrap_or_else(|| "https://127.0.0.1:6443".to_string());
        // The split_once on ':' only splits at the first colon, we need the full URL
        let server = k3s_content.lines()
            .find(|l| l.trim().starts_with("server:"))
            .map(|l| l.trim().trim_start_matches("server:").trim().trim_matches('"').to_string())
            .unwrap_or_else(|| "https://127.0.0.1:6443".to_string());

        // Extract certificate-authority-data and client certs from k3s config
        let ca_data = k3s_content.lines()
            .find(|l| l.trim().starts_with("certificate-authority-data:"))
            .map(|l| l.trim().trim_start_matches("certificate-authority-data:").trim().to_string());
        let client_cert = k3s_content.lines()
            .find(|l| l.trim().starts_with("client-certificate-data:"))
            .map(|l| l.trim().trim_start_matches("client-certificate-data:").trim().to_string());
        let client_key = k3s_content.lines()
            .find(|l| l.trim().starts_with("client-key-data:"))
            .map(|l| l.trim().trim_start_matches("client-key-data:").trim().to_string());

        // Ensure ~/.kube directory exists
        if let Some(home) = dirs::home_dir() {
            let _ = std::fs::create_dir_all(home.join(".kube"));
        }

        // Use kubectl config commands to add our context
        // Set cluster
        let mut cmd = std::process::Command::new("kubectl");
        cmd.env("PATH", Self::extended_path());
        cmd.args(["config", "set-cluster", "orca", &format!("--server={server}")]);
        if let Some(ca) = &ca_data {
            // Write CA to a temp approach: embed directly
            cmd.arg("--embed-certs=true");
            // Actually, set-cluster with --certificate-authority needs a file, but we have base64 data.
            // Use the simpler approach: set via config set
        }
        let _ = cmd.output();

        // Set certificate-authority-data directly via config set
        if let Some(ca) = &ca_data {
            let _ = std::process::Command::new("kubectl")
                .env("PATH", Self::extended_path())
                .args(["config", "set", "clusters.orca.certificate-authority-data", ca])
                .output();
        }

        // Set user credentials
        if let Some(cert) = &client_cert {
            let _ = std::process::Command::new("kubectl")
                .env("PATH", Self::extended_path())
                .args(["config", "set", "users.orca.client-certificate-data", cert])
                .output();
        }
        if let Some(key) = &client_key {
            let _ = std::process::Command::new("kubectl")
                .env("PATH", Self::extended_path())
                .args(["config", "set", "users.orca.client-key-data", key])
                .output();
        }

        // Set context
        let _ = std::process::Command::new("kubectl")
            .env("PATH", Self::extended_path())
            .args(["config", "set-context", "orca", "--cluster=orca", "--user=orca"])
            .output();

        tracing::info!("Merged k3s config into ~/.kube/config as 'orca' context (server={server})");
        Ok(())
    }

    /// Check if our "orca" context exists in the kubeconfig
    fn has_orca_context(&self) -> bool {
        let path = self.kubeconfig_path();
        if !path.exists() { return false; }
        let filename = path.file_name().and_then(|f| f.to_str()).unwrap_or("");
        // k3s.yaml is always ours (direct install, not yet merged)
        if filename == "k3s.yaml" {
            return true;
        }
        // Check for our "orca" context in the kubeconfig
        if let Ok(contents) = std::fs::read_to_string(&path) {
            return contents.contains("name: orca");
        }
        false
    }

    async fn get_client(&self) -> anyhow::Result<Client> {
        let mut cached = self.client.lock().await;
        if let Some(client) = cached.as_ref() {
            return Ok(client.clone());
        }

        let kubeconfig_path = self.kubeconfig_path();
        tracing::info!("K8s get_client: loading kubeconfig from {}", kubeconfig_path.display());
        if !kubeconfig_path.exists() {
            anyhow::bail!("Kubernetes not enabled — no kubeconfig found");
        }
        if !self.has_orca_context() {
            anyhow::bail!("Kubernetes not enabled — no 'orca' context in kubeconfig. Enable Kubernetes from the Orca UI.");
        }

        let kubeconfig = kube::config::Kubeconfig::read_from(&kubeconfig_path)
            .map_err(|e| { tracing::warn!("K8s: failed to parse kubeconfig: {e}"); e })?;

        // Use our "orca" context, or default for k3s.yaml (direct install)
        let filename = kubeconfig_path.file_name().and_then(|f| f.to_str()).unwrap_or("");
        let kube_opts = if filename == "k3s.yaml" {
            // Direct k3s install — uses "default" context
            kube::config::KubeConfigOptions::default()
        } else {
            // Standard ~/.kube/config — use our "orca" context
            kube::config::KubeConfigOptions {
                context: Some(Self::CONTEXT_NAME.to_string()),
                ..Default::default()
            }
        };

        // Try to create a client from kubeconfig with our specific context
        let config = match kube::Config::from_custom_kubeconfig(
            kubeconfig.clone(),
            &kube_opts,
        ).await {
            Ok(config) => config,
            Err(e) => {
                let err_str = e.to_string();
                if err_str.contains("auth exec") || err_str.contains("No such file") {
                    // Exec-based auth failed (Docker Desktop, cloud providers)
                    // Try inferring config from the cluster/user data directly
                    tracing::warn!("K8s: exec auth failed ({e}), trying in-cluster or default config");
                    // Try the default config which handles more auth methods
                    kube::Config::infer().await
                        .map_err(|e2| { tracing::warn!("K8s: infer config also failed: {e2}"); e })?
                } else {
                    tracing::warn!("K8s: failed to create config from kubeconfig: {e}");
                    return Err(e.into());
                }
            }
        };

        let client = Client::try_from(config)
            .map_err(|e| { tracing::warn!("K8s: failed to create client: {e}"); e })?;
        tracing::info!("K8s: client created successfully");
        *cached = Some(client.clone());
        Ok(client)
    }

    /// Fallback: get cluster status via kubectl CLI when kube client fails
    /// (e.g., Docker Desktop exec-based auth on macOS).
    async fn status_via_kubectl(&self) -> anyhow::Result<ClusterStatus> {
        let mut cmd = self.kubectl_command();
        cmd.args(["get", "nodes", "-o",
            "jsonpath={.items[0].metadata.name},{.items[0].status.conditions[?(@.type==\"Ready\")].status},{range .items[0].status.nodeInfo}{.kubeletVersion}{end}"]);
        let output = cmd.output().await;

        if let Ok(output) = output {
            let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !text.is_empty() && output.status.success() {
                let parts: Vec<&str> = text.split(',').collect();
                let node_name = parts.first().unwrap_or(&"").to_string();
                let ready = parts.get(1).map(|s| *s == "True").unwrap_or(false);
                let version = parts.get(2).unwrap_or(&"").to_string();
                tracing::info!("K8s via kubectl CLI: node={node_name}, ready={ready}, version={version}");

                // Get pod counts
                let mut pod_cmd = self.kubectl_command();
                pod_cmd.args(["get", "pods", "-A", "--no-headers"]);
                let (pods_r, pods_t) = if let Ok(pod_out) = pod_cmd.output().await {
                    let pod_text = String::from_utf8_lossy(&pod_out.stdout);
                    (pod_text.lines().filter(|l| l.contains("Running")).count() as u32,
                     pod_text.lines().count() as u32)
                } else { (0, 0) };

                return Ok(ClusterStatus {
                    enabled: true,
                    running: ready,
                    version: if version.is_empty() { None } else { Some(version) },
                    node_name: if node_name.is_empty() { None } else { Some(node_name) },
                    node_status: if ready { Some("Ready".to_string()) } else { Some("NotReady".to_string()) },
                    pods_running: pods_r,
                    pods_total: pods_t,
                    traefik_dashboard: None,
                    error: None,
                });
            }
        }

        Ok(ClusterStatus {
            enabled: true,
            running: false,
            version: None, node_name: None, node_status: None,
            pods_running: 0, pods_total: 0, traefik_dashboard: None,
            error: Some("Kubernetes detected but not reachable — check your cluster".to_string()),
        })
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

        // Step 2b: Merge k3s kubeconfig into ~/.kube/config as "orca" context
        for _ in 0..10 {
            if std::path::Path::new("/etc/rancher/k3s/k3s.yaml").exists() {
                match Self::merge_kubeconfig_context() {
                    Ok(()) => {
                        log.push_str(">>> Added 'orca' context to ~/.kube/config\n");
                        log.push_str("    Use: kubectl --context orca get pods\n\n");
                        break;
                    }
                    Err(e) => tracing::debug!("Failed to merge kubeconfig: {e}"),
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
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
                                        let config_path = format!("{kube_dir}/config");

                                        // k3s config has server: https://127.0.0.1:6443
                                        // Lima VZ forwards ports, so localhost:6443 works on the host
                                        let fixed = kubeconfig.replace("127.0.0.1", "localhost");

                                        // Use kubectl config set commands for reliable merge
                                        // This avoids issues with KUBECONFIG merge + rename
                                        let tmp_path = format!("{kube_dir}/.orca-k3s-temp");
                                        std::fs::write(&tmp_path, &fixed)
                                            .map_err(|e| anyhow::anyhow!("Failed to write temp kubeconfig: {e}"))?;

                                        // Extract certs from the k3s config and set them on our "orca" context
                                        let _ = std::process::Command::new("kubectl")
                                            .env("PATH", Self::extended_path())
                                            .args(["--kubeconfig", &tmp_path, "config", "view", "--raw", "-o", "json"])
                                            .output()
                                            .and_then(|o| {
                                                if o.status.success() {
                                                    if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&o.stdout) {
                                                        let server = v["clusters"][0]["cluster"]["server"].as_str().unwrap_or("https://localhost:6443");
                                                        let ca = v["clusters"][0]["cluster"]["certificate-authority-data"].as_str().unwrap_or("");
                                                        let cert = v["users"][0]["user"]["client-certificate-data"].as_str().unwrap_or("");
                                                        let key = v["users"][0]["user"]["client-key-data"].as_str().unwrap_or("");

                                                        let _ = std::process::Command::new("kubectl").env("PATH", Self::extended_path()).args(["config", "set-cluster", "orca", &format!("--server={server}")]).output();
                                                        let _ = std::process::Command::new("kubectl").env("PATH", Self::extended_path()).args(["config", "set", "clusters.orca.certificate-authority-data", ca]).output();
                                                        let _ = std::process::Command::new("kubectl").env("PATH", Self::extended_path()).args(["config", "set", "users.orca.client-certificate-data", cert]).output();
                                                        let _ = std::process::Command::new("kubectl").env("PATH", Self::extended_path()).args(["config", "set", "users.orca.client-key-data", key]).output();
                                                        let _ = std::process::Command::new("kubectl").env("PATH", Self::extended_path()).args(["config", "set-context", "orca", "--cluster=orca", "--user=orca"]).output();
                                                    }
                                                }
                                                Ok(o)
                                            });
                                        let _ = std::fs::remove_file(&tmp_path);

                                        // Verify the context was created
                                        let verify = std::process::Command::new("kubectl")
                                            .env("PATH", Self::extended_path())
                                            .args(["--context", "orca", "cluster-info"])
                                            .output();
                                        match verify {
                                            Ok(o) if o.status.success() => {
                                                send("Added 'orca' context to ~/.kube/config".into()).await;
                                                send("Use: kubectl --context orca get pods".into()).await;
                                            }
                                            _ => {
                                                send("Warning: 'orca' context may not be properly configured".into()).await;
                                                tracing::warn!("kubectl --context orca cluster-info failed after kubeconfig merge");
                                            }
                                        }

                                        // Clear cached K8s client so status check uses the new config
                                        *self.client.lock().await = None;
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

                    // Write k3s config as temp file, then merge as "orca" context
                    let tmp_path = format!("{kube_dir}\\orca-k3s-temp");
                    std::fs::write(&tmp_path, &kubeconfig)
                        .map_err(|e| anyhow::anyhow!("Failed to write temp kubeconfig: {e}"))?;

                    // Merge into ~/.kube/config using KUBECONFIG env trick
                    let config_path = format!("{kube_dir}\\config");
                    let merge_env = if std::path::Path::new(&config_path).exists() {
                        format!("{tmp_path};{config_path}")
                    } else {
                        tmp_path.clone()
                    };

                    // Flatten merged config and rename default context to "orca"
                    let _ = std::process::Command::new("kubectl")
                        .env("PATH", Self::extended_path())
                        .env("KUBECONFIG", &merge_env)
                        .args(["config", "view", "--flatten"])
                        .output()
                        .and_then(|o| {
                            if o.status.success() {
                                std::fs::write(&config_path, &o.stdout)?;
                            }
                            Ok(o)
                        });

                    // Rename the k3s default context/cluster/user to "orca"
                    let _ = std::process::Command::new("kubectl")
                        .env("PATH", Self::extended_path())
                        .args(["config", "rename-context", "default", "orca"])
                        .output();

                    // Clean up temp file
                    let _ = std::fs::remove_file(&tmp_path);

                    send(format!("    Added 'orca' context to {config_path}")).await;
                    send("    Use: kubectl --context orca get pods".into()).await;
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
        let has_context = self.has_orca_context();
        tracing::info!("K8s status: kubeconfig={}, has_orca_context={}", kubeconfig_path.display(), has_context);

        // If the kubeconfig doesn't exist or doesn't have our context, K8s isn't enabled
        if !kubeconfig_path.exists() || !has_context {
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
                tracing::warn!("K8s status: kube client failed ({e}), trying kubectl CLI fallback");
                // Fall back to kubectl CLI — handles exec-based auth (Docker Desktop, GKE, etc.)
                return self.status_via_kubectl().await;
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
                        traefik_dashboard: None, // Not accessible from Windows (WSL2 port forwarding)
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
                error: if !running { Some("Kubernetes API server not reachable".to_string()) } else { None },
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

        // Merge into ~/.kube/config as "orca" context
        let tmp_file = dest.join(".orca-k3s-temp");
        tokio::fs::write(&tmp_file, &kubeconfig).await?;
        let sep = if cfg!(target_os = "windows") { ";" } else { ":" };
        let merge_env = if dest_file.exists() {
            format!("{}{sep}{}", tmp_file.display(), dest_file.display())
        } else {
            tmp_file.display().to_string()
        };
        let _ = std::process::Command::new("kubectl")
            .env("PATH", Self::extended_path())
            .env("KUBECONFIG", &merge_env)
            .args(["config", "view", "--flatten"])
            .output()
            .and_then(|o| { if o.status.success() { std::fs::write(&dest_file, &o.stdout)?; } Ok(o) });
        let _ = std::process::Command::new("kubectl")
            .env("PATH", Self::extended_path())
            .args(["config", "rename-context", "default", "orca"])
            .output();
        let _ = tokio::fs::remove_file(&tmp_file).await;
        tracing::info!("Merged k3s kubeconfig as 'orca' context in {}", dest_file.display());

        Ok(dest_file)
    }

    // --- Workload queries ---

    async fn list_namespaces(&self) -> anyhow::Result<Vec<Namespace>> {
        #[cfg(target_os = "windows")]
        {
            let json = self.wsl_kubectl_json(&["get", "namespaces"]).await?;
            let empty_vec = vec![];
            let items = json["items"].as_array().unwrap_or(&empty_vec);
            return Ok(items.iter().map(|ns: &serde_json::Value| {
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
            let empty_vec = vec![];
            let items = json["items"].as_array().unwrap_or(&empty_vec);
            return Ok(items.iter().map(|p: &serde_json::Value| {
                let name = p["metadata"]["name"].as_str().unwrap_or("").to_string();
                let phase = p["status"]["phase"].as_str().unwrap_or("Unknown").to_string();

                let empty_containers: Vec<serde_json::Value> = vec![];
                let container_statuses = p["status"]["containerStatuses"]
                    .as_array()
                    .unwrap_or(&empty_containers);

                let ready_count = container_statuses
                    .iter()
                    .filter(|c: &&serde_json::Value| c["ready"].as_bool().unwrap_or(false))
                    .count();

                let spec_containers = p["spec"]["containers"]
                    .as_array()
                    .unwrap_or(&empty_containers);
                let total_count = spec_containers.len();

                let restarts: u32 = container_statuses
                    .iter()
                    .map(|c: &serde_json::Value| c["restartCount"].as_u64().unwrap_or(0) as u32)
                    .sum();

                let containers: Vec<PodContainer> = container_statuses
                    .iter()
                    .map(|cs: &serde_json::Value| {
                        let state = if cs["state"]["running"].is_object() {
                            "Running"
                        } else if cs["state"]["waiting"].is_object() {
                            "Waiting"
                        } else if cs["state"]["terminated"].is_object() {
                            "Terminated"
                        } else {
                            "Unknown"
                        };
                        PodContainer {
                            name: cs["name"].as_str().unwrap_or("").to_string(),
                            image: cs["image"].as_str().unwrap_or("").to_string(),
                            ready: cs["ready"].as_bool().unwrap_or(false),
                            restart_count: cs["restartCount"].as_u64().unwrap_or(0) as u32,
                            state: state.to_string(),
                        }
                    })
                    .collect();

                let age = p["metadata"]["creationTimestamp"].as_str().unwrap_or("").to_string();
                Pod {
                    name,
                    namespace: namespace.to_string(),
                    status: phase,
                    ready: format!("{ready_count}/{total_count}"),
                    restarts,
                    age,
                    node: p["spec"]["nodeName"].as_str().map(|s: &str| s.to_string()),
                    ip: p["status"]["podIP"].as_str().map(|s: &str| s.to_string()),
                    containers,
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
            let empty_vec = vec![];
            let items = json["items"].as_array().unwrap_or(&empty_vec);
            return Ok(items.iter().map(|d: &serde_json::Value| {
                let name = d["metadata"]["name"].as_str().unwrap_or("").to_string();
                let replicas_ready = d["status"]["readyReplicas"].as_u64().unwrap_or(0) as u32;
                let replicas_desired = d["spec"]["replicas"].as_u64().unwrap_or(1) as u32;
                let age = d["metadata"]["creationTimestamp"].as_str().unwrap_or("").to_string();
                let empty_containers: Vec<serde_json::Value> = vec![];
                let images: Vec<String> = d["spec"]["template"]["spec"]["containers"].as_array()
                    .unwrap_or(&empty_containers)
                    .iter()
                    .filter_map(|c: &serde_json::Value| c["image"].as_str().map(|s: &str| s.to_string()))
                    .collect();
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
            let empty_vec = vec![];
            let items = json["items"].as_array().unwrap_or(&empty_vec);
            return Ok(items.iter().map(|svc: &serde_json::Value| {
                let empty_ports: Vec<serde_json::Value> = vec![];
                let ports: Vec<ServicePort> = svc["spec"]["ports"].as_array()
                    .unwrap_or(&empty_ports)
                    .iter()
                    .map(|p: &serde_json::Value| ServicePort {
                        name: p["name"].as_str().map(|s: &str| s.to_string()),
                        port: p["port"].as_i64().unwrap_or(0) as i32,
                        target_port: p["targetPort"].as_i64()
                            .map(|i: i64| i.to_string())
                            .or_else(|| p["targetPort"].as_str().map(|s: &str| s.to_string()))
                            .unwrap_or_default(),
                        node_port: p["nodePort"].as_i64().map(|n: i64| n as i32),
                        protocol: p["protocol"].as_str().unwrap_or("TCP").to_string(),
                    })
                    .collect();
                let external_ip = svc["status"]["loadBalancer"]["ingress"].as_array()
                    .and_then(|ing: &Vec<serde_json::Value>| ing.first())
                    .and_then(|i: &serde_json::Value| i["ip"].as_str())
                    .map(|s: &str| s.to_string());
                Service {
                    name: svc["metadata"]["name"].as_str().unwrap_or("").to_string(),
                    namespace: namespace.to_string(),
                    service_type: svc["spec"]["type"].as_str().unwrap_or("ClusterIP").to_string(),
                    cluster_ip: svc["spec"]["clusterIP"].as_str().map(|s: &str| s.to_string()),
                    external_ip,
                    ports,
                    age: svc["metadata"]["creationTimestamp"].as_str().unwrap_or("").to_string(),
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
            let empty_vec = vec![];
            let items = json["items"].as_array().unwrap_or(&empty_vec);
            return Ok(items.iter().map(|ing: &serde_json::Value| {
                let empty_rules: Vec<serde_json::Value> = vec![];
                let hosts: Vec<String> = ing["spec"]["rules"].as_array()
                    .unwrap_or(&empty_rules)
                    .iter()
                    .filter_map(|r: &serde_json::Value| r["host"].as_str().map(|s: &str| s.to_string()))
                    .collect();
                let address = ing["status"]["loadBalancer"]["ingress"].as_array()
                    .and_then(|arr: &Vec<serde_json::Value>| arr.first())
                    .and_then(|i: &serde_json::Value| i["ip"].as_str())
                    .map(|s: &str| s.to_string());
                Ingress {
                    name: ing["metadata"]["name"].as_str().unwrap_or("").to_string(),
                    namespace: namespace.to_string(),
                    hosts,
                    address,
                    age: ing["metadata"]["creationTimestamp"].as_str().unwrap_or("").to_string(),
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
            let empty_vec = vec![];
            let items = json["items"].as_array().unwrap_or(&empty_vec);
            return Ok(items.iter().map(|pvc: &serde_json::Value| {
                let empty_modes: Vec<serde_json::Value> = vec![];
                let access_modes: Vec<String> = pvc["spec"]["accessModes"].as_array()
                    .unwrap_or(&empty_modes)
                    .iter()
                    .filter_map(|m: &serde_json::Value| m.as_str().map(|s: &str| s.to_string()))
                    .collect();
                PersistentVolumeClaim {
                    name: pvc["metadata"]["name"].as_str().unwrap_or("").to_string(),
                    namespace: namespace.to_string(),
                    status: pvc["status"]["phase"].as_str().unwrap_or("Pending").to_string(),
                    volume: pvc["spec"]["volumeName"].as_str().map(|s: &str| s.to_string()),
                    capacity: pvc["status"]["capacity"]["storage"].as_str().map(|s: &str| s.to_string()),
                    access_modes,
                    storage_class: pvc["spec"]["storageClassName"].as_str().map(|s: &str| s.to_string()),
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
            let empty_vec = vec![];
            let items = json["items"].as_array().unwrap_or(&empty_vec);
            return Ok(items.iter().map(|pv: &serde_json::Value| {
                let empty_modes: Vec<serde_json::Value> = vec![];
                let access_modes: Vec<String> = pv["spec"]["accessModes"].as_array()
                    .unwrap_or(&empty_modes)
                    .iter()
                    .filter_map(|m: &serde_json::Value| m.as_str().map(|s: &str| s.to_string()))
                    .collect();
                let claim = pv["spec"]["claimRef"].as_object().map(|cr: &serde_json::Map<String, serde_json::Value>| {
                    format!("{}/{}",
                        cr.get("namespace").and_then(|v: &serde_json::Value| v.as_str()).unwrap_or("default"),
                        cr.get("name").and_then(|v: &serde_json::Value| v.as_str()).unwrap_or(""))
                });
                PersistentVolume {
                    name: pv["metadata"]["name"].as_str().unwrap_or("").to_string(),
                    capacity: pv["spec"]["capacity"]["storage"].as_str().map(|s: &str| s.to_string()),
                    access_modes,
                    reclaim_policy: pv["spec"]["persistentVolumeReclaimPolicy"].as_str().map(|s: &str| s.to_string()),
                    status: pv["status"]["phase"].as_str().unwrap_or("Available").to_string(),
                    claim,
                    storage_class: pv["spec"]["storageClassName"].as_str().map(|s: &str| s.to_string()),
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
        validate_k8s_name(namespace)?;
        validate_k8s_name(name)?;
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
        validate_k8s_name(namespace)?;
        validate_k8s_name(name)?;
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
        validate_k8s_name(namespace)?;
        validate_k8s_name(name)?;
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
        validate_k8s_name(namespace)?;
        validate_k8s_name(name)?;
        if let Some(c) = container { validate_k8s_name(c)?; }
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
        // Validate YAML size
        if yaml.len() > 1_000_000 {
            anyhow::bail!("YAML too large (max 1MB)");
        }

        // Validate resource kind against allowlist
        if let Some(kind) = extract_yaml_kind(yaml) {
            const ALLOWED_KINDS: &[&str] = &[
                "Pod", "Service", "ConfigMap", "Secret", "Deployment", "DaemonSet",
                "StatefulSet", "ReplicaSet", "Job", "CronJob", "Ingress",
                "PersistentVolumeClaim", "Namespace", "HorizontalPodAutoscaler",
                "ServiceAccount", "Role", "RoleBinding", "NetworkPolicy",
                "IngressRoute", "Middleware", "HelmChartConfig",
            ];
            if !ALLOWED_KINDS.contains(&kind.as_str()) {
                anyhow::bail!(
                    "Resource kind '{}' is not allowed. Allowed kinds: {}",
                    kind,
                    ALLOWED_KINDS.join(", ")
                );
            }
        }

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

    async fn list_events(&self, namespace: &str) -> anyhow::Result<Vec<K8sEvent>> {
        validate_k8s_name(namespace)?;
        #[cfg(target_os = "windows")]
        {
            let json = self.wsl_kubectl_json(&["get", "events", "-n", namespace]).await?;
            let empty_vec = vec![];
            let items = json["items"].as_array().unwrap_or(&empty_vec);
            return Ok(items.iter().map(|e: &serde_json::Value| {
                let involved = &e["involvedObject"];
                let kind = involved["kind"].as_str().unwrap_or("");
                let obj_name = involved["name"].as_str().unwrap_or("");
                K8sEvent {
                    event_type: e["type"].as_str().unwrap_or("Normal").to_string(),
                    reason: e["reason"].as_str().unwrap_or("").to_string(),
                    object: format!("{kind}/{obj_name}"),
                    message: e["message"].as_str().unwrap_or("").to_string(),
                    age: e["metadata"]["creationTimestamp"].as_str().unwrap_or("").to_string(),
                    count: e["count"].as_u64().unwrap_or(1) as u32,
                }
            }).collect());
        }

        #[cfg(not(target_os = "windows"))]
        {
            let client = self.get_client().await?;
            let api: Api<k8s_openapi::api::core::v1::Event> = Api::namespaced(client.clone(), namespace);
            let list = api.list(&ListParams::default()).await?;
            Ok(list.items.iter().map(|e| {
                let involved = e.involved_object.clone();
                let kind = involved.kind.unwrap_or_default();
                let obj_name = involved.name.unwrap_or_default();
                K8sEvent {
                    event_type: e.type_.clone().unwrap_or_else(|| "Normal".to_string()),
                    reason: e.reason.clone().unwrap_or_default(),
                    object: format!("{kind}/{obj_name}"),
                    message: e.message.clone().unwrap_or_default(),
                    age: format_k8s_age(&e.metadata.creation_timestamp),
                    count: e.count.unwrap_or(1) as u32,
                }
            }).collect())
        }
    }

    async fn create_namespace(&self, name: &str) -> anyhow::Result<()> {
        validate_k8s_name(name)?;
        #[cfg(target_os = "windows")]
        {
            let output = Command::new("wsl")
                .args(["-u", "root", "--", "k3s", "kubectl", "create", "namespace", name])
                .output()
                .await?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                anyhow::bail!("Failed to create namespace: {stderr}");
            }
            return Ok(());
        }

        #[cfg(not(target_os = "windows"))]
        {
            let client = self.get_client().await?;
            let api: Api<k8s_openapi::api::core::v1::Namespace> = Api::all(client.clone());
            let ns = serde_json::json!({
                "apiVersion": "v1",
                "kind": "Namespace",
                "metadata": { "name": name }
            });
            let data: k8s_openapi::api::core::v1::Namespace = serde_json::from_value(ns)?;
            api.create(&kube::api::PostParams::default(), &data).await?;
            Ok(())
        }
    }

    async fn delete_namespace(&self, name: &str) -> anyhow::Result<()> {
        validate_k8s_name(name)?;
        #[cfg(target_os = "windows")]
        {
            let output = Command::new("wsl")
                .args(["-u", "root", "--", "k3s", "kubectl", "delete", "namespace", name])
                .output()
                .await?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                anyhow::bail!("Failed to delete namespace: {stderr}");
            }
            return Ok(());
        }

        #[cfg(not(target_os = "windows"))]
        {
            let client = self.get_client().await?;
            let api: Api<k8s_openapi::api::core::v1::Namespace> = Api::all(client.clone());
            api.delete(name, &DeleteParams::default()).await?;
            Ok(())
        }
    }

    async fn list_configmaps(&self, namespace: &str) -> anyhow::Result<Vec<K8sConfigMap>> {
        validate_k8s_name(namespace)?;
        #[cfg(target_os = "windows")]
        {
            let json = self.wsl_kubectl_json(&["get", "configmaps", "-n", namespace]).await?;
            let empty_vec = vec![];
            let items = json["items"].as_array().unwrap_or(&empty_vec);
            return Ok(items.iter().map(|cm: &serde_json::Value| {
                let data_obj = cm["data"].as_object();
                let keys: Vec<String> = data_obj.map(|d| d.keys().cloned().collect()).unwrap_or_default();
                let data: std::collections::HashMap<String, String> = data_obj
                    .map(|d| d.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string())).collect())
                    .unwrap_or_default();
                K8sConfigMap {
                    name: cm["metadata"]["name"].as_str().unwrap_or("").to_string(),
                    namespace: namespace.to_string(),
                    keys,
                    data,
                    age: cm["metadata"]["creationTimestamp"].as_str().unwrap_or("").to_string(),
                }
            }).collect());
        }

        #[cfg(not(target_os = "windows"))]
        {
            let client = self.get_client().await?;
            let api: Api<k8s_openapi::api::core::v1::ConfigMap> = Api::namespaced(client.clone(), namespace);
            let list = api.list(&ListParams::default()).await?;
            Ok(list.items.iter().map(|cm| {
                let btree_data = cm.data.clone().unwrap_or_default();
                let keys: Vec<String> = btree_data.keys().cloned().collect();
                let data: std::collections::HashMap<String, String> = btree_data.into_iter().collect();
                K8sConfigMap {
                    name: cm.metadata.name.clone().unwrap_or_default(),
                    namespace: namespace.to_string(),
                    keys,
                    data,
                    age: format_k8s_age(&cm.metadata.creation_timestamp),
                }
            }).collect())
        }
    }

    async fn list_secrets(&self, namespace: &str) -> anyhow::Result<Vec<K8sSecret>> {
        #[cfg(target_os = "windows")]
        {
            let json = self.wsl_kubectl_json(&["get", "secrets", "-n", namespace]).await?;
            let empty_vec = vec![];
            let items = json["items"].as_array().unwrap_or(&empty_vec);
            return Ok(items.iter().map(|s: &serde_json::Value| {
                let data_obj = s["data"].as_object();
                let keys: Vec<String> = data_obj.map(|d| d.keys().cloned().collect()).unwrap_or_default();
                let data: std::collections::HashMap<String, String> = data_obj
                    .map(|d| d.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string())).collect())
                    .unwrap_or_default();
                K8sSecret {
                    name: s["metadata"]["name"].as_str().unwrap_or("").to_string(),
                    namespace: namespace.to_string(),
                    secret_type: s["type"].as_str().unwrap_or("Opaque").to_string(),
                    keys,
                    data,
                    age: s["metadata"]["creationTimestamp"].as_str().unwrap_or("").to_string(),
                }
            }).collect());
        }

        #[cfg(not(target_os = "windows"))]
        {
            use k8s_openapi::ByteString;
            let client = self.get_client().await?;
            let api: Api<k8s_openapi::api::core::v1::Secret> = Api::namespaced(client.clone(), namespace);
            let list = api.list(&ListParams::default()).await?;
            Ok(list.items.iter().map(|s| {
                let raw_data = s.data.clone().unwrap_or_default();
                let keys: Vec<String> = raw_data.keys().cloned().collect();
                // Return base64-encoded values (frontend will decode for reveal)
                let data: std::collections::HashMap<String, String> = raw_data
                    .iter()
                    .map(|(k, ByteString(v))| {
                        use base64::Engine;
                        (k.clone(), base64::engine::general_purpose::STANDARD.encode(v))
                    })
                    .collect();
                K8sSecret {
                    name: s.metadata.name.clone().unwrap_or_default(),
                    namespace: namespace.to_string(),
                    secret_type: s.type_.clone().unwrap_or_else(|| "Opaque".to_string()),
                    keys,
                    data,
                    age: format_k8s_age(&s.metadata.creation_timestamp),
                }
            }).collect())
        }
    }

    async fn list_pod_metrics(&self, namespace: &str) -> anyhow::Result<Vec<PodMetrics>> {
        // kubectl top does NOT support -o json, so we parse text output
        #[cfg(target_os = "windows")]
        let output = {
            Command::new("wsl")
                .args(["-u", "root", "--", "k3s", "kubectl", "top", "pods", "-n", namespace, "--no-headers"])
                .output()
                .await?
        };

        #[cfg(not(target_os = "windows"))]
        let output = {
            self.kubectl_command()
                .args(["top", "pods", "-n", namespace, "--no-headers"])
                .env("KUBECONFIG", self.kubeconfig_path())
                .output()
                .await?
        };

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            // Metrics server not installed is a common case, return empty
            if stderr.contains("Metrics API not available") || stderr.contains("metrics") || stderr.contains("not found") {
                return Ok(vec![]);
            }
            anyhow::bail!("kubectl top pods failed: {stderr}");
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let metrics: Vec<PodMetrics> = stdout
            .lines()
            .filter(|l| !l.trim().is_empty())
            .filter_map(|line| {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 3 {
                    Some(PodMetrics {
                        name: parts[0].to_string(),
                        cpu: parts[1].to_string(),
                        memory: parts[2].to_string(),
                    })
                } else {
                    None
                }
            })
            .collect();

        Ok(metrics)
    }

    async fn rollout_history(&self, namespace: &str, name: &str) -> anyhow::Result<Vec<RolloutRevision>> {
        let dep_arg = format!("deployment/{name}");

        #[cfg(target_os = "windows")]
        let output = {
            Command::new("wsl")
                .args(["-u", "root", "--", "k3s", "kubectl", "rollout", "history", &dep_arg, "-n", namespace])
                .output()
                .await?
        };

        #[cfg(not(target_os = "windows"))]
        let output = {
            self.kubectl_command()
                .args(["rollout", "history", &dep_arg, "-n", namespace])
                .env("KUBECONFIG", self.kubeconfig_path())
                .output()
                .await?
        };

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            anyhow::bail!("kubectl rollout history failed: {stderr}");
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        // Output format:
        // deployment.apps/name
        // REVISION  CHANGE-CAUSE
        // 1         <none>
        // 2         kubectl set image...
        let revisions: Vec<RolloutRevision> = stdout
            .lines()
            .skip(1) // skip header line "deployment.apps/..."
            .filter(|l| !l.trim().is_empty() && !l.starts_with("REVISION"))
            .filter_map(|line| {
                let parts: Vec<&str> = line.splitn(2, char::is_whitespace).collect();
                let rev_str = parts.first()?.trim();
                let revision: u32 = rev_str.parse().ok()?;
                let change_cause = parts.get(1)
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty() && s != "<none>");
                Some(RolloutRevision { revision, change_cause })
            })
            .collect();

        Ok(revisions)
    }

    async fn rollout_undo(&self, namespace: &str, name: &str, revision: Option<u32>) -> anyhow::Result<String> {
        let dep_arg = format!("deployment/{name}");

        #[cfg(target_os = "windows")]
        let output = {
            let mut args: Vec<&str> = vec!["-u", "root", "--", "k3s", "kubectl", "rollout", "undo", &dep_arg, "-n", namespace];
            let rev_arg;
            if let Some(rev) = revision {
                rev_arg = format!("--to-revision={rev}");
                args.push(&rev_arg);
            }
            Command::new("wsl")
                .args(&args)
                .output()
                .await?
        };

        #[cfg(not(target_os = "windows"))]
        let output = {
            let mut cmd = self.kubectl_command();
            cmd.args(["rollout", "undo", &dep_arg, "-n", namespace])
                .env("KUBECONFIG", self.kubeconfig_path());
            if let Some(rev) = revision {
                cmd.arg(format!("--to-revision={rev}"));
            }
            cmd.output().await?
        };

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            anyhow::bail!("kubectl rollout undo failed: {stderr}");
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        Ok(stdout.trim().to_string())
    }

    async fn list_jobs(&self, namespace: &str) -> anyhow::Result<Vec<Job>> {
        #[cfg(target_os = "windows")]
        {
            let json = self.wsl_kubectl_json(&["get", "jobs", "-n", namespace]).await?;
            let empty_vec = vec![];
            let items = json["items"].as_array().unwrap_or(&empty_vec);
            return Ok(items.iter().map(|j: &serde_json::Value| {
                let name = j["metadata"]["name"].as_str().unwrap_or("").to_string();
                let succeeded = j["status"]["succeeded"].as_u64().unwrap_or(0) as u32;
                let failed = j["status"]["failed"].as_u64().unwrap_or(0) as u32;
                let active = j["status"]["active"].as_u64().unwrap_or(0) as u32;
                let completions_desired = j["spec"]["completions"].as_u64().unwrap_or(1) as u32;
                let status = if succeeded >= completions_desired {
                    "Succeeded"
                } else if failed > 0 && active == 0 {
                    "Failed"
                } else {
                    "Active"
                }.to_string();
                let completions = format!("{succeeded}/{completions_desired}");
                let start_time = j["status"]["startTime"].as_str().map(|s: &str| s.to_string());
                let completion_time = j["status"]["completionTime"].as_str();
                let duration = match (j["status"]["startTime"].as_str(), completion_time) {
                    (Some(start), Some(end)) => format_duration_between(start, end),
                    (Some(start), None) => format_duration_since(start),
                    _ => String::new(),
                };
                Job {
                    name,
                    namespace: namespace.to_string(),
                    status,
                    completions,
                    duration,
                    start_time,
                    created_at: j["metadata"]["creationTimestamp"].as_str().unwrap_or("").to_string(),
                }
            }).collect());
        }

        #[cfg(not(target_os = "windows"))]
        {
            let client = self.get_client().await?;
            let api: Api<k8s_openapi::api::batch::v1::Job> = Api::namespaced(client.clone(), namespace);
            let list = api.list(&ListParams::default()).await?;
            Ok(list.items.iter().map(|j| {
                let name = j.metadata.name.clone().unwrap_or_default();
                let status_ref = j.status.as_ref();
                let succeeded = status_ref.and_then(|s| s.succeeded).unwrap_or(0) as u32;
                let failed = status_ref.and_then(|s| s.failed).unwrap_or(0) as u32;
                let active = status_ref.and_then(|s| s.active).unwrap_or(0) as u32;
                let completions_desired = j.spec.as_ref().and_then(|s| s.completions).unwrap_or(1) as u32;
                let status_str = if succeeded >= completions_desired {
                    "Succeeded"
                } else if failed > 0 && active == 0 {
                    "Failed"
                } else {
                    "Active"
                }.to_string();
                let completions = format!("{succeeded}/{completions_desired}");
                let start_time_ts = status_ref.and_then(|s| s.start_time.as_ref());
                let completion_time_ts = status_ref.and_then(|s| s.completion_time.as_ref());
                let duration = match (start_time_ts, completion_time_ts) {
                    (Some(start), Some(end)) => {
                        let dur = end.0.signed_duration_since(start.0);
                        format_chrono_duration(dur)
                    }
                    (Some(start), None) => {
                        let dur = chrono::Utc::now().signed_duration_since(start.0);
                        format_chrono_duration(dur)
                    }
                    _ => String::new(),
                };
                let start_time = start_time_ts.map(|t| t.0.to_rfc3339());
                Job {
                    name,
                    namespace: namespace.to_string(),
                    status: status_str,
                    completions,
                    duration,
                    start_time,
                    created_at: format_k8s_age(&j.metadata.creation_timestamp),
                }
            }).collect())
        }
    }

    async fn list_cronjobs(&self, namespace: &str) -> anyhow::Result<Vec<CronJob>> {
        #[cfg(target_os = "windows")]
        {
            let json = self.wsl_kubectl_json(&["get", "cronjobs", "-n", namespace]).await?;
            let empty_vec = vec![];
            let items = json["items"].as_array().unwrap_or(&empty_vec);
            return Ok(items.iter().map(|cj: &serde_json::Value| {
                let name = cj["metadata"]["name"].as_str().unwrap_or("").to_string();
                let schedule = cj["spec"]["schedule"].as_str().unwrap_or("").to_string();
                let suspend = cj["spec"]["suspend"].as_bool().unwrap_or(false);
                let empty_arr: Vec<serde_json::Value> = vec![];
                let active = cj["status"]["active"].as_array().unwrap_or(&empty_arr).len() as u32;
                let last_schedule = cj["status"]["lastScheduleTime"].as_str().map(|s: &str| s.to_string());
                CronJob {
                    name,
                    namespace: namespace.to_string(),
                    schedule,
                    suspend,
                    active,
                    last_schedule,
                    created_at: cj["metadata"]["creationTimestamp"].as_str().unwrap_or("").to_string(),
                }
            }).collect());
        }

        #[cfg(not(target_os = "windows"))]
        {
            let client = self.get_client().await?;
            let api: Api<k8s_openapi::api::batch::v1::CronJob> = Api::namespaced(client.clone(), namespace);
            let list = api.list(&ListParams::default()).await?;
            Ok(list.items.iter().map(|cj| {
                let name = cj.metadata.name.clone().unwrap_or_default();
                let spec = cj.spec.as_ref();
                let schedule = spec.map(|s| s.schedule.clone()).unwrap_or_default();
                let suspend = spec.and_then(|s| s.suspend).unwrap_or(false);
                let status_ref = cj.status.as_ref();
                let active = status_ref.and_then(|s| s.active.as_ref()).map(|a| a.len() as u32).unwrap_or(0);
                let last_schedule = status_ref
                    .and_then(|s| s.last_schedule_time.as_ref())
                    .map(|t| t.0.to_rfc3339());
                CronJob {
                    name,
                    namespace: namespace.to_string(),
                    schedule,
                    suspend,
                    active,
                    last_schedule,
                    created_at: format_k8s_age(&cj.metadata.creation_timestamp),
                }
            }).collect())
        }
    }

    async fn list_daemonsets(&self, namespace: &str) -> anyhow::Result<Vec<DaemonSet>> {
        #[cfg(target_os = "windows")]
        {
            let json = self.wsl_kubectl_json(&["get", "daemonsets", "-n", namespace]).await?;
            let empty_vec = vec![];
            let items = json["items"].as_array().unwrap_or(&empty_vec);
            return Ok(items.iter().map(|d: &serde_json::Value| {
                let name = d["metadata"]["name"].as_str().unwrap_or("").to_string();
                let desired = d["status"]["desiredNumberScheduled"].as_i64().unwrap_or(0) as i32;
                let current = d["status"]["currentNumberScheduled"].as_i64().unwrap_or(0) as i32;
                let ready = d["status"]["numberReady"].as_i64().unwrap_or(0) as i32;
                let node_selector = d["spec"]["template"]["spec"]["nodeSelector"].as_object()
                    .map(|m| m.iter().map(|(k, v)| format!("{k}={}", v.as_str().unwrap_or(""))).collect::<Vec<_>>().join(", "));
                let empty_containers: Vec<serde_json::Value> = vec![];
                let images: Vec<String> = d["spec"]["template"]["spec"]["containers"].as_array()
                    .unwrap_or(&empty_containers)
                    .iter()
                    .filter_map(|c: &serde_json::Value| c["image"].as_str().map(|s: &str| s.to_string()))
                    .collect();
                DaemonSet {
                    name,
                    namespace: namespace.to_string(),
                    desired,
                    current,
                    ready,
                    node_selector,
                    images,
                    created_at: d["metadata"]["creationTimestamp"].as_str().unwrap_or("").to_string(),
                }
            }).collect());
        }

        #[cfg(not(target_os = "windows"))]
        {
            let client = self.get_client().await?;
            let api: Api<k8s_openapi::api::apps::v1::DaemonSet> =
                Api::namespaced(client.clone(), namespace);
            let list = api.list(&ListParams::default()).await?;
            Ok(list.items.iter().map(|d| {
                let name = d.metadata.name.clone().unwrap_or_default();
                let status = d.status.as_ref();
                let desired = status.map(|s| s.desired_number_scheduled).unwrap_or(0);
                let current = status.map(|s| s.current_number_scheduled).unwrap_or(0);
                let ready = status.map(|s| s.number_ready).unwrap_or(0);
                let node_selector = d.spec.as_ref()
                    .and_then(|s| s.template.spec.as_ref())
                    .and_then(|s| s.node_selector.as_ref())
                    .map(|m| m.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(", "));
                let images = d.spec.as_ref()
                    .and_then(|s| s.template.spec.as_ref())
                    .map(|spec| spec.containers.iter().filter_map(|c| c.image.clone()).collect())
                    .unwrap_or_default();
                DaemonSet {
                    name,
                    namespace: namespace.to_string(),
                    desired,
                    current,
                    ready,
                    node_selector,
                    images,
                    created_at: format_k8s_age(&d.metadata.creation_timestamp),
                }
            }).collect())
        }
    }

    async fn list_statefulsets(&self, namespace: &str) -> anyhow::Result<Vec<StatefulSet>> {
        #[cfg(target_os = "windows")]
        {
            let json = self.wsl_kubectl_json(&["get", "statefulsets", "-n", namespace]).await?;
            let empty_vec = vec![];
            let items = json["items"].as_array().unwrap_or(&empty_vec);
            return Ok(items.iter().map(|s: &serde_json::Value| {
                let name = s["metadata"]["name"].as_str().unwrap_or("").to_string();
                let replicas = s["spec"]["replicas"].as_i64().unwrap_or(1) as i32;
                let ready_count = s["status"]["readyReplicas"].as_i64().unwrap_or(0) as i32;
                let ready = format!("{ready_count}/{replicas}");
                let empty_containers: Vec<serde_json::Value> = vec![];
                let images: Vec<String> = s["spec"]["template"]["spec"]["containers"].as_array()
                    .unwrap_or(&empty_containers)
                    .iter()
                    .filter_map(|c: &serde_json::Value| c["image"].as_str().map(|s: &str| s.to_string()))
                    .collect();
                StatefulSet {
                    name,
                    namespace: namespace.to_string(),
                    ready,
                    replicas,
                    images,
                    created_at: s["metadata"]["creationTimestamp"].as_str().unwrap_or("").to_string(),
                }
            }).collect());
        }

        #[cfg(not(target_os = "windows"))]
        {
            let client = self.get_client().await?;
            let api: Api<k8s_openapi::api::apps::v1::StatefulSet> =
                Api::namespaced(client.clone(), namespace);
            let list = api.list(&ListParams::default()).await?;
            Ok(list.items.iter().map(|s| {
                let name = s.metadata.name.clone().unwrap_or_default();
                let replicas = s.spec.as_ref().and_then(|sp| sp.replicas).unwrap_or(1);
                let ready_count = s.status.as_ref().and_then(|st| st.ready_replicas).unwrap_or(0);
                let ready = format!("{ready_count}/{replicas}");
                let images = s.spec.as_ref()
                    .and_then(|sp| sp.template.spec.as_ref())
                    .map(|spec| spec.containers.iter().filter_map(|c| c.image.clone()).collect())
                    .unwrap_or_default();
                StatefulSet {
                    name,
                    namespace: namespace.to_string(),
                    ready,
                    replicas,
                    images,
                    created_at: format_k8s_age(&s.metadata.creation_timestamp),
                }
            }).collect())
        }
    }

    async fn list_replicasets(&self, namespace: &str) -> anyhow::Result<Vec<ReplicaSet>> {
        #[cfg(target_os = "windows")]
        {
            let json = self.wsl_kubectl_json(&["get", "replicasets", "-n", namespace]).await?;
            let empty_vec = vec![];
            let items = json["items"].as_array().unwrap_or(&empty_vec);
            return Ok(items.iter().map(|r: &serde_json::Value| {
                let name = r["metadata"]["name"].as_str().unwrap_or("").to_string();
                let desired = r["spec"]["replicas"].as_i64().unwrap_or(0) as i32;
                let current = r["status"]["replicas"].as_i64().unwrap_or(0) as i32;
                let ready = r["status"]["readyReplicas"].as_i64().unwrap_or(0) as i32;
                let empty_containers: Vec<serde_json::Value> = vec![];
                let images: Vec<String> = r["spec"]["template"]["spec"]["containers"].as_array()
                    .unwrap_or(&empty_containers)
                    .iter()
                    .filter_map(|c: &serde_json::Value| c["image"].as_str().map(|s: &str| s.to_string()))
                    .collect();
                let empty_refs: Vec<serde_json::Value> = vec![];
                let owner = r["metadata"]["ownerReferences"].as_array()
                    .unwrap_or(&empty_refs)
                    .first()
                    .and_then(|o| o["name"].as_str())
                    .map(|s| s.to_string());
                ReplicaSet {
                    name,
                    namespace: namespace.to_string(),
                    desired,
                    current,
                    ready,
                    images,
                    owner,
                    created_at: r["metadata"]["creationTimestamp"].as_str().unwrap_or("").to_string(),
                }
            }).collect());
        }

        #[cfg(not(target_os = "windows"))]
        {
            let client = self.get_client().await?;
            let api: Api<k8s_openapi::api::apps::v1::ReplicaSet> =
                Api::namespaced(client.clone(), namespace);
            let list = api.list(&ListParams::default()).await?;
            Ok(list.items.iter().map(|r| {
                let name = r.metadata.name.clone().unwrap_or_default();
                let desired = r.spec.as_ref().and_then(|sp| sp.replicas).unwrap_or(0);
                let current = r.status.as_ref().map(|st| st.replicas).unwrap_or(0);
                let ready = r.status.as_ref().and_then(|st| st.ready_replicas).unwrap_or(0);
                let images = r.spec.as_ref()
                    .and_then(|sp| sp.template.as_ref())
                    .and_then(|t| t.spec.as_ref())
                    .map(|spec| spec.containers.iter().filter_map(|c| c.image.clone()).collect())
                    .unwrap_or_default();
                let owner = r.metadata.owner_references.as_ref()
                    .and_then(|refs| refs.first())
                    .map(|o| o.name.clone());
                ReplicaSet {
                    name,
                    namespace: namespace.to_string(),
                    desired,
                    current,
                    ready,
                    images,
                    owner,
                    created_at: format_k8s_age(&r.metadata.creation_timestamp),
                }
            }).collect())
        }
    }

    async fn scale_statefulset(
        &self,
        namespace: &str,
        name: &str,
        replicas: u32,
    ) -> anyhow::Result<()> {
        #[cfg(target_os = "windows")]
        {
            let replicas_arg = format!("--replicas={replicas}");
            let sts_arg = format!("statefulset/{name}");
            let output = Command::new("wsl")
                .args(["-u", "root", "--", "k3s", "kubectl", "scale", &sts_arg, &replicas_arg, "-n", namespace])
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
            let api: Api<k8s_openapi::api::apps::v1::StatefulSet> =
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

    async fn restart_statefulset(&self, namespace: &str, name: &str) -> anyhow::Result<()> {
        validate_k8s_name(namespace)?;
        validate_k8s_name(name)?;
        #[cfg(target_os = "windows")]
        {
            let sts_arg = format!("statefulset/{name}");
            let output = Command::new("wsl")
                .args(["-u", "root", "--", "k3s", "kubectl", "rollout", "restart", &sts_arg, "-n", namespace])
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
            let api: Api<k8s_openapi::api::apps::v1::StatefulSet> =
                Api::namespaced(client.clone(), namespace);
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

    async fn delete_daemonset(&self, namespace: &str, name: &str) -> anyhow::Result<()> {
        validate_k8s_name(namespace)?;
        validate_k8s_name(name)?;
        #[cfg(target_os = "windows")]
        {
            let output = Command::new("wsl")
                .args(["-u", "root", "--", "k3s", "kubectl", "delete", "daemonset", name, "-n", namespace])
                .output()
                .await?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                anyhow::bail!("kubectl delete daemonset failed: {stderr}");
            }
            return Ok(());
        }

        #[cfg(not(target_os = "windows"))]
        {
            let client = self.get_client().await?;
            let api: Api<k8s_openapi::api::apps::v1::DaemonSet> =
                Api::namespaced(client.clone(), namespace);
            api.delete(name, &DeleteParams::default()).await?;
            Ok(())
        }
    }

    async fn delete_statefulset(&self, namespace: &str, name: &str) -> anyhow::Result<()> {
        validate_k8s_name(namespace)?;
        validate_k8s_name(name)?;
        #[cfg(target_os = "windows")]
        {
            let output = Command::new("wsl")
                .args(["-u", "root", "--", "k3s", "kubectl", "delete", "statefulset", name, "-n", namespace])
                .output()
                .await?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                anyhow::bail!("kubectl delete statefulset failed: {stderr}");
            }
            return Ok(());
        }

        #[cfg(not(target_os = "windows"))]
        {
            let client = self.get_client().await?;
            let api: Api<k8s_openapi::api::apps::v1::StatefulSet> =
                Api::namespaced(client.clone(), namespace);
            api.delete(name, &DeleteParams::default()).await?;
            Ok(())
        }
    }

    async fn delete_replicaset(&self, namespace: &str, name: &str) -> anyhow::Result<()> {
        validate_k8s_name(namespace)?;
        validate_k8s_name(name)?;
        #[cfg(target_os = "windows")]
        {
            let output = Command::new("wsl")
                .args(["-u", "root", "--", "k3s", "kubectl", "delete", "replicaset", name, "-n", namespace])
                .output()
                .await?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                anyhow::bail!("kubectl delete replicaset failed: {stderr}");
            }
            return Ok(());
        }

        #[cfg(not(target_os = "windows"))]
        {
            let client = self.get_client().await?;
            let api: Api<k8s_openapi::api::apps::v1::ReplicaSet> =
                Api::namespaced(client.clone(), namespace);
            api.delete(name, &DeleteParams::default()).await?;
            Ok(())
        }
    }

    async fn trigger_cronjob(&self, namespace: &str, name: &str) -> anyhow::Result<String> {
        validate_k8s_name(name)?;
        validate_k8s_name(namespace)?;
        let job_name = format!("{name}-manual-{}", chrono::Utc::now().format("%s"));

        #[cfg(target_os = "windows")]
        let output = {
            Command::new("wsl")
                .args(["-u", "root", "--", "k3s", "kubectl", "create", "job", &job_name,
                       &format!("--from=cronjob/{name}"), "-n", namespace])
                .output()
                .await?
        };

        #[cfg(not(target_os = "windows"))]
        let output = {
            self.kubectl_command()
                .args(["create", "job", &job_name, &format!("--from=cronjob/{name}"), "-n", namespace])
                .env("KUBECONFIG", self.kubeconfig_path())
                .output()
                .await?
        };

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            anyhow::bail!("kubectl create job failed: {stderr}");
        }
        Ok(job_name)
    }

    async fn delete_job(&self, namespace: &str, name: &str) -> anyhow::Result<()> {
        validate_k8s_name(name)?;
        validate_k8s_name(namespace)?;

        #[cfg(target_os = "windows")]
        {
            let output = Command::new("wsl")
                .args(["-u", "root", "--", "k3s", "kubectl", "delete", "job", name, "-n", namespace])
                .output()
                .await?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                anyhow::bail!("kubectl delete job failed: {stderr}");
            }
            return Ok(());
        }

        #[cfg(not(target_os = "windows"))]
        {
            let client = self.get_client().await?;
            let api: Api<k8s_openapi::api::batch::v1::Job> = Api::namespaced(client.clone(), namespace);
            api.delete(name, &DeleteParams::default()).await?;
            Ok(())
        }
    }

    async fn delete_cronjob(&self, namespace: &str, name: &str) -> anyhow::Result<()> {
        validate_k8s_name(name)?;
        validate_k8s_name(namespace)?;

        #[cfg(target_os = "windows")]
        {
            let output = Command::new("wsl")
                .args(["-u", "root", "--", "k3s", "kubectl", "delete", "cronjob", name, "-n", namespace])
                .output()
                .await?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                anyhow::bail!("kubectl delete cronjob failed: {stderr}");
            }
            return Ok(());
        }

        #[cfg(not(target_os = "windows"))]
        {
            let client = self.get_client().await?;
            let api: Api<k8s_openapi::api::batch::v1::CronJob> = Api::namespaced(client.clone(), namespace);
            api.delete(name, &DeleteParams::default()).await?;
            Ok(())
        }
    }

    async fn suspend_cronjob(&self, namespace: &str, name: &str, suspend: bool) -> anyhow::Result<()> {
        validate_k8s_name(name)?;
        validate_k8s_name(namespace)?;

        #[cfg(target_os = "windows")]
        {
            let patch_json = format!(r#"{{"spec":{{"suspend":{suspend}}}}}"#);
            let output = Command::new("wsl")
                .args(["-u", "root", "--", "k3s", "kubectl", "patch", "cronjob", name,
                       "-n", namespace, "--type", "merge", "-p", &patch_json])
                .output()
                .await?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                anyhow::bail!("kubectl patch cronjob failed: {stderr}");
            }
            return Ok(());
        }

        #[cfg(not(target_os = "windows"))]
        {
            let client = self.get_client().await?;
            let api: Api<k8s_openapi::api::batch::v1::CronJob> = Api::namespaced(client.clone(), namespace);
            let patch = serde_json::json!({ "spec": { "suspend": suspend } });
            api.patch(name, &PatchParams::default(), &Patch::Merge(patch)).await?;
            Ok(())
        }
    }

    async fn create_secret(
        &self,
        namespace: &str,
        name: &str,
        data: std::collections::HashMap<String, String>,
        secret_type: Option<&str>,
    ) -> anyhow::Result<()> {
        validate_k8s_name(namespace)?;
        validate_k8s_name(name)?;
        let stype = secret_type.unwrap_or("Opaque");

        #[cfg(target_os = "windows")]
        {
            let mut args: Vec<String> = vec![
                "-u".into(), "root".into(), "--".into(),
                "k3s".into(), "kubectl".into(), "create".into(), "secret".into(), "generic".into(),
                name.to_string(), "-n".into(), namespace.to_string(),
                "--type".into(), stype.to_string(),
            ];
            for (k, v) in &data {
                args.push(format!("--from-literal={k}={v}"));
            }
            let output = Command::new("wsl")
                .args(&args)
                .output()
                .await?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                anyhow::bail!("kubectl create secret failed: {stderr}");
            }
            return Ok(());
        }

        #[cfg(not(target_os = "windows"))]
        {
            use k8s_openapi::ByteString;
            let client = self.get_client().await?;
            let api: Api<k8s_openapi::api::core::v1::Secret> =
                Api::namespaced(client.clone(), namespace);
            let secret_data: std::collections::BTreeMap<String, ByteString> = data
                .iter()
                .map(|(k, v)| (k.clone(), ByteString(v.as_bytes().to_vec())))
                .collect();
            let secret = serde_json::from_value::<k8s_openapi::api::core::v1::Secret>(serde_json::json!({
                "apiVersion": "v1",
                "kind": "Secret",
                "metadata": { "name": name, "namespace": namespace },
                "type": stype,
            }))?;
            let mut secret = secret;
            secret.data = Some(secret_data);
            api.create(&kube::api::PostParams::default(), &secret).await?;
            Ok(())
        }
    }

    async fn delete_secret(&self, namespace: &str, name: &str) -> anyhow::Result<()> {
        validate_k8s_name(namespace)?;
        validate_k8s_name(name)?;

        #[cfg(target_os = "windows")]
        {
            let output = Command::new("wsl")
                .args(["-u", "root", "--", "k3s", "kubectl", "delete", "secret", name, "-n", namespace])
                .output()
                .await?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                anyhow::bail!("kubectl delete secret failed: {stderr}");
            }
            return Ok(());
        }

        #[cfg(not(target_os = "windows"))]
        {
            let client = self.get_client().await?;
            let api: Api<k8s_openapi::api::core::v1::Secret> =
                Api::namespaced(client.clone(), namespace);
            api.delete(name, &DeleteParams::default()).await?;
            Ok(())
        }
    }

    async fn update_secret(
        &self,
        namespace: &str,
        name: &str,
        data: std::collections::HashMap<String, String>,
    ) -> anyhow::Result<()> {
        validate_k8s_name(namespace)?;
        validate_k8s_name(name)?;

        #[cfg(target_os = "windows")]
        {
            // Delete and recreate on Windows
            let _ = Command::new("wsl")
                .args(["-u", "root", "--", "k3s", "kubectl", "delete", "secret", name, "-n", namespace])
                .output()
                .await?;
            let mut args: Vec<String> = vec![
                "-u".into(), "root".into(), "--".into(),
                "k3s".into(), "kubectl".into(), "create".into(), "secret".into(), "generic".into(),
                name.to_string(), "-n".into(), namespace.to_string(),
            ];
            for (k, v) in &data {
                args.push(format!("--from-literal={k}={v}"));
            }
            let output = Command::new("wsl")
                .args(&args)
                .output()
                .await?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                anyhow::bail!("kubectl create secret (update) failed: {stderr}");
            }
            return Ok(());
        }

        #[cfg(not(target_os = "windows"))]
        {
            use k8s_openapi::ByteString;
            let client = self.get_client().await?;
            let api: Api<k8s_openapi::api::core::v1::Secret> =
                Api::namespaced(client.clone(), namespace);
            let secret_data: std::collections::BTreeMap<String, ByteString> = data
                .iter()
                .map(|(k, v)| (k.clone(), ByteString(v.as_bytes().to_vec())))
                .collect();
            let patch = serde_json::json!({
                "data": secret_data.iter().map(|(k, ByteString(v))| {
                    use base64::Engine;
                    (k.clone(), serde_json::Value::String(base64::engine::general_purpose::STANDARD.encode(v)))
                }).collect::<serde_json::Map<String, serde_json::Value>>()
            });
            api.patch(name, &PatchParams::apply("orca"), &Patch::Merge(&patch)).await?;
            Ok(())
        }
    }

    async fn create_pvc(
        &self,
        namespace: &str,
        name: &str,
        storage_class: &str,
        size: &str,
        access_modes: Vec<String>,
    ) -> anyhow::Result<()> {
        validate_k8s_name(namespace)?;
        validate_k8s_name(name)?;

        #[cfg(target_os = "windows")]
        {
            let pvc_yaml = format!(
                "apiVersion: v1\nkind: PersistentVolumeClaim\nmetadata:\n  name: {name}\n  namespace: {namespace}\nspec:\n  accessModes:\n{modes}\n  storageClassName: {storage_class}\n  resources:\n    requests:\n      storage: {size}",
                modes = access_modes.iter().map(|m| format!("    - {m}")).collect::<Vec<_>>().join("\n"),
            );
            self.apply_yaml(&pvc_yaml).await?;
            return Ok(());
        }

        #[cfg(not(target_os = "windows"))]
        {
            let client = self.get_client().await?;
            let api: Api<k8s_openapi::api::core::v1::PersistentVolumeClaim> =
                Api::namespaced(client.clone(), namespace);
            let pvc_json = serde_json::json!({
                "apiVersion": "v1",
                "kind": "PersistentVolumeClaim",
                "metadata": { "name": name, "namespace": namespace },
                "spec": {
                    "accessModes": access_modes,
                    "storageClassName": storage_class,
                    "resources": {
                        "requests": {
                            "storage": size
                        }
                    }
                }
            });
            let pvc: k8s_openapi::api::core::v1::PersistentVolumeClaim = serde_json::from_value(pvc_json)?;
            api.create(&kube::api::PostParams::default(), &pvc).await?;
            Ok(())
        }
    }

    async fn list_hpas(&self, namespace: &str) -> anyhow::Result<Vec<HorizontalPodAutoscaler>> {
        validate_k8s_name(namespace)?;
        #[cfg(target_os = "windows")]
        {
            let json = self.wsl_kubectl_json(&["get", "hpa", "-n", namespace]).await?;
            let empty_vec = vec![];
            let items = json["items"].as_array().unwrap_or(&empty_vec);
            return Ok(items.iter().map(|h: &serde_json::Value| {
                let spec = &h["spec"];
                let status = &h["status"];
                let scale_ref = &spec["scaleTargetRef"];
                let reference = format!("{}/{}",
                    scale_ref["kind"].as_str().unwrap_or(""),
                    scale_ref["name"].as_str().unwrap_or(""));
                let target_cpu = spec["metrics"].as_array()
                    .and_then(|metrics| metrics.iter().find(|m| m["type"].as_str() == Some("Resource") && m["resource"]["name"].as_str() == Some("cpu")))
                    .and_then(|m| m["resource"]["target"]["averageUtilization"].as_i64())
                    .map(|v| format!("{v}%"));
                let current_cpu = status["currentMetrics"].as_array()
                    .and_then(|metrics| metrics.iter().find(|m| m["type"].as_str() == Some("Resource") && m["resource"]["name"].as_str() == Some("cpu")))
                    .and_then(|m| m["resource"]["current"]["averageUtilization"].as_i64())
                    .map(|v| format!("{v}%"));
                HorizontalPodAutoscaler {
                    name: h["metadata"]["name"].as_str().unwrap_or("").to_string(),
                    namespace: namespace.to_string(),
                    reference,
                    min_replicas: spec["minReplicas"].as_i64().unwrap_or(1) as i32,
                    max_replicas: spec["maxReplicas"].as_i64().unwrap_or(1) as i32,
                    current_replicas: status["currentReplicas"].as_i64().unwrap_or(0) as i32,
                    target_cpu,
                    current_cpu,
                    created_at: h["metadata"]["creationTimestamp"].as_str().unwrap_or("").to_string(),
                }
            }).collect());
        }

        #[cfg(not(target_os = "windows"))]
        {
            let client = self.get_client().await?;
            let api: Api<k8s_openapi::api::autoscaling::v2::HorizontalPodAutoscaler> =
                Api::namespaced(client.clone(), namespace);
            let list = api.list(&ListParams::default()).await?;
            Ok(list.items.iter().map(|h| {
                let spec = h.spec.as_ref();
                let status = h.status.as_ref();
                let scale_ref = spec.map(|s| &s.scale_target_ref);
                let reference = scale_ref
                    .map(|r| format!("{}/{}", r.kind, r.name))
                    .unwrap_or_default();
                let target_cpu = spec
                    .and_then(|s| s.metrics.as_ref())
                    .and_then(|metrics| metrics.iter().find(|m| {
                        m.type_ == "Resource" && m.resource.as_ref().map(|r| r.name.as_str()) == Some("cpu")
                    }))
                    .and_then(|m| m.resource.as_ref())
                    .and_then(|r| r.target.average_utilization)
                    .map(|v| format!("{v}%"));
                let current_cpu = status
                    .and_then(|s| s.current_metrics.as_ref())
                    .and_then(|metrics| metrics.iter().find(|m| {
                        m.type_ == "Resource" && m.resource.as_ref().map(|r| r.name.as_str()) == Some("cpu")
                    }))
                    .and_then(|m| m.resource.as_ref())
                    .and_then(|r| r.current.average_utilization)
                    .map(|v| format!("{v}%"));
                HorizontalPodAutoscaler {
                    name: h.metadata.name.clone().unwrap_or_default(),
                    namespace: namespace.to_string(),
                    reference,
                    min_replicas: spec.and_then(|s| s.min_replicas).unwrap_or(1),
                    max_replicas: spec.map(|s| s.max_replicas).unwrap_or(1),
                    current_replicas: status.map(|s| s.current_replicas).flatten().unwrap_or(0),
                    target_cpu,
                    current_cpu,
                    created_at: format_k8s_age(&h.metadata.creation_timestamp),
                }
            }).collect())
        }
    }

    async fn create_hpa(
        &self,
        namespace: &str,
        name: &str,
        deployment: &str,
        min: i32,
        max: i32,
        cpu_target: i32,
    ) -> anyhow::Result<()> {
        validate_k8s_name(namespace)?;
        validate_k8s_name(name)?;
        validate_k8s_name(deployment)?;

        let min_str = min.to_string();
        let max_str = max.to_string();
        let cpu_str = cpu_target.to_string();

        #[cfg(target_os = "windows")]
        {
            let output = Command::new("wsl")
                .args(["-u", "root", "--", "k3s", "kubectl", "autoscale", "deployment",
                       deployment, &format!("--name={name}"),
                       &format!("--min={min_str}"), &format!("--max={max_str}"),
                       &format!("--cpu-percent={cpu_str}"), "-n", namespace])
                .output()
                .await?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                anyhow::bail!("kubectl autoscale failed: {stderr}");
            }
            return Ok(());
        }

        #[cfg(not(target_os = "windows"))]
        {
            let output = self.kubectl_command()
                .args(["autoscale", "deployment", deployment,
                       &format!("--name={name}"),
                       &format!("--min={min_str}"), &format!("--max={max_str}"),
                       &format!("--cpu-percent={cpu_str}"), "-n", namespace])
                .env("KUBECONFIG", self.kubeconfig_path())
                .output()
                .await?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                anyhow::bail!("kubectl autoscale failed: {stderr}");
            }
            Ok(())
        }
    }

    async fn delete_hpa(&self, namespace: &str, name: &str) -> anyhow::Result<()> {
        validate_k8s_name(namespace)?;
        validate_k8s_name(name)?;
        #[cfg(target_os = "windows")]
        {
            let output = Command::new("wsl")
                .args(["-u", "root", "--", "k3s", "kubectl", "delete", "hpa", name, "-n", namespace])
                .output()
                .await?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                anyhow::bail!("kubectl delete hpa failed: {stderr}");
            }
            return Ok(());
        }

        #[cfg(not(target_os = "windows"))]
        {
            let client = self.get_client().await?;
            let api: Api<k8s_openapi::api::autoscaling::v2::HorizontalPodAutoscaler> =
                Api::namespaced(client.clone(), namespace);
            api.delete(name, &DeleteParams::default()).await?;
            Ok(())
        }
    }

    async fn list_network_policies(&self, namespace: &str) -> anyhow::Result<Vec<NetworkPolicy>> {
        validate_k8s_name(namespace)?;
        #[cfg(target_os = "windows")]
        {
            let json = self.wsl_kubectl_json(&["get", "networkpolicies", "-n", namespace]).await?;
            let empty_vec = vec![];
            let items = json["items"].as_array().unwrap_or(&empty_vec);
            return Ok(items.iter().map(|np: &serde_json::Value| {
                let pod_selector = np["spec"]["podSelector"]["matchLabels"]
                    .as_object()
                    .map(|m| m.iter().map(|(k, v)| format!("{k}={}", v.as_str().unwrap_or(""))).collect::<Vec<_>>().join(", "))
                    .unwrap_or_else(|| "(all pods)".to_string());
                let empty_arr: Vec<serde_json::Value> = vec![];
                let policy_types: Vec<String> = np["spec"]["policyTypes"]
                    .as_array()
                    .unwrap_or(&empty_arr)
                    .iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect();
                NetworkPolicy {
                    name: np["metadata"]["name"].as_str().unwrap_or("").to_string(),
                    namespace: namespace.to_string(),
                    pod_selector,
                    policy_types,
                    created_at: np["metadata"]["creationTimestamp"].as_str().unwrap_or("").to_string(),
                }
            }).collect());
        }

        #[cfg(not(target_os = "windows"))]
        {
            let client = self.get_client().await?;
            let api: Api<k8s_openapi::api::networking::v1::NetworkPolicy> =
                Api::namespaced(client.clone(), namespace);
            let list = api.list(&ListParams::default()).await?;
            Ok(list.items.iter().map(|np| {
                let pod_selector = np.spec.as_ref()
                    .and_then(|s| s.pod_selector.match_labels.as_ref())
                    .map(|m| m.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(", "))
                    .unwrap_or_else(|| "(all pods)".to_string());
                let policy_types = np.spec.as_ref()
                    .and_then(|s| s.policy_types.clone())
                    .unwrap_or_default();
                NetworkPolicy {
                    name: np.metadata.name.clone().unwrap_or_default(),
                    namespace: namespace.to_string(),
                    pod_selector,
                    policy_types,
                    created_at: format_k8s_age(&np.metadata.creation_timestamp),
                }
            }).collect())
        }
    }

    async fn delete_network_policy(&self, namespace: &str, name: &str) -> anyhow::Result<()> {
        validate_k8s_name(namespace)?;
        validate_k8s_name(name)?;
        #[cfg(target_os = "windows")]
        {
            let output = Command::new("wsl")
                .args(["-u", "root", "--", "k3s", "kubectl", "delete", "networkpolicy", name, "-n", namespace])
                .output()
                .await?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                anyhow::bail!("kubectl delete networkpolicy failed: {stderr}");
            }
            return Ok(());
        }

        #[cfg(not(target_os = "windows"))]
        {
            let client = self.get_client().await?;
            let api: Api<k8s_openapi::api::networking::v1::NetworkPolicy> =
                Api::namespaced(client.clone(), namespace);
            api.delete(name, &DeleteParams::default()).await?;
            Ok(())
        }
    }

    async fn list_storage_classes(&self) -> anyhow::Result<Vec<StorageClass>> {
        #[cfg(target_os = "windows")]
        {
            let json = self.wsl_kubectl_json(&["get", "storageclasses"]).await?;
            let empty_vec = vec![];
            let items = json["items"].as_array().unwrap_or(&empty_vec);
            return Ok(items.iter().map(|sc: &serde_json::Value| {
                let annotations = sc["metadata"]["annotations"].as_object();
                let is_default = annotations
                    .map(|a| {
                        a.get("storageclass.kubernetes.io/is-default-class")
                            .or_else(|| a.get("storageclass.beta.kubernetes.io/is-default-class"))
                            .and_then(|v| v.as_str())
                            .map(|v| v == "true")
                            .unwrap_or(false)
                    })
                    .unwrap_or(false);
                StorageClass {
                    name: sc["metadata"]["name"].as_str().unwrap_or("").to_string(),
                    provisioner: sc["provisioner"].as_str().unwrap_or("").to_string(),
                    reclaim_policy: sc["reclaimPolicy"].as_str().unwrap_or("Delete").to_string(),
                    volume_binding_mode: sc["volumeBindingMode"].as_str().unwrap_or("Immediate").to_string(),
                    is_default,
                    created_at: sc["metadata"]["creationTimestamp"].as_str().unwrap_or("").to_string(),
                }
            }).collect());
        }

        #[cfg(not(target_os = "windows"))]
        {
            let client = self.get_client().await?;
            let api: Api<k8s_openapi::api::storage::v1::StorageClass> = Api::all(client.clone());
            let list = api.list(&ListParams::default()).await?;
            Ok(list.items.iter().map(|sc| {
                let is_default = sc.metadata.annotations.as_ref()
                    .map(|a| {
                        a.get("storageclass.kubernetes.io/is-default-class")
                            .or_else(|| a.get("storageclass.beta.kubernetes.io/is-default-class"))
                            .map(|v| v == "true")
                            .unwrap_or(false)
                    })
                    .unwrap_or(false);
                StorageClass {
                    name: sc.metadata.name.clone().unwrap_or_default(),
                    provisioner: sc.provisioner.clone(),
                    reclaim_policy: sc.reclaim_policy.clone().unwrap_or_else(|| "Delete".to_string()),
                    volume_binding_mode: sc.volume_binding_mode.clone().unwrap_or_else(|| "Immediate".to_string()),
                    is_default,
                    created_at: format_k8s_age(&sc.metadata.creation_timestamp),
                }
            }).collect())
        }
    }

    async fn list_crds(&self) -> anyhow::Result<Vec<CustomResourceDefinition>> {
        #[cfg(target_os = "windows")]
        {
            let json = self.wsl_kubectl_json(&["get", "crds"]).await?;
            let empty_vec = vec![];
            let items = json["items"].as_array().unwrap_or(&empty_vec);
            return Ok(items.iter().map(|crd: &serde_json::Value| {
                let names = &crd["spec"]["names"];
                let empty_arr: Vec<serde_json::Value> = vec![];
                let versions: Vec<String> = crd["spec"]["versions"]
                    .as_array()
                    .unwrap_or(&empty_arr)
                    .iter()
                    .filter_map(|v| v["name"].as_str().map(|s| s.to_string()))
                    .collect();
                CustomResourceDefinition {
                    name: crd["metadata"]["name"].as_str().unwrap_or("").to_string(),
                    group: crd["spec"]["group"].as_str().unwrap_or("").to_string(),
                    kind: names["kind"].as_str().unwrap_or("").to_string(),
                    scope: crd["spec"]["scope"].as_str().unwrap_or("Namespaced").to_string(),
                    versions,
                    created_at: crd["metadata"]["creationTimestamp"].as_str().unwrap_or("").to_string(),
                }
            }).collect());
        }

        #[cfg(not(target_os = "windows"))]
        {
            let client = self.get_client().await?;
            let api: Api<k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition> =
                Api::all(client.clone());
            let list = api.list(&ListParams::default()).await?;
            Ok(list.items.iter().map(|crd| {
                let spec = &crd.spec;
                let versions: Vec<String> = spec.versions.iter()
                    .map(|v| v.name.clone())
                    .collect();
                CustomResourceDefinition {
                    name: crd.metadata.name.clone().unwrap_or_default(),
                    group: spec.group.clone(),
                    kind: spec.names.kind.clone(),
                    scope: spec.scope.clone(),
                    versions,
                    created_at: format_k8s_age(&crd.metadata.creation_timestamp),
                }
            }).collect())
        }
    }
}

// --- Helm functions (not part of K8sManager trait) ---

impl K3sManager {
    /// List installed Helm releases across all namespaces.
    pub async fn helm_list(&self) -> anyhow::Result<Vec<HelmRelease>> {
        // Check if helm is available
        #[cfg(target_os = "windows")]
        let output = {
            Command::new("wsl")
                .args(["-u", "root", "--", "helm", "list", "-A", "-o", "json"])
                .output()
                .await?
        };

        #[cfg(not(target_os = "windows"))]
        let output = {
            let mut cmd = Command::new("helm");
            cmd.args(["list", "-A", "-o", "json"]);
            if self.kubeconfig_path().exists() {
                cmd.env("KUBECONFIG", self.kubeconfig_path());
            }
            cmd.output().await?
        };

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            anyhow::bail!("helm list failed: {stderr}");
        }

        let releases: Vec<serde_json::Value> = serde_json::from_slice(&output.stdout)?;
        Ok(releases.iter().map(|r| HelmRelease {
            name: r["name"].as_str().unwrap_or("").to_string(),
            namespace: r["namespace"].as_str().unwrap_or("").to_string(),
            chart: r["chart"].as_str().unwrap_or("").to_string(),
            status: r["status"].as_str().unwrap_or("").to_string(),
            revision: r["revision"].as_str().unwrap_or("").to_string(),
            updated: r["updated"].as_str().unwrap_or("").to_string(),
            app_version: r["app_version"].as_str().unwrap_or("").to_string(),
        }).collect())
    }

    /// Uninstall a Helm release.
    pub async fn helm_uninstall(&self, name: &str, namespace: &str) -> anyhow::Result<String> {
        #[cfg(target_os = "windows")]
        let output = {
            Command::new("wsl")
                .args(["-u", "root", "--", "helm", "uninstall", name, "-n", namespace])
                .output()
                .await?
        };

        #[cfg(not(target_os = "windows"))]
        let output = {
            let mut cmd = Command::new("helm");
            cmd.args(["uninstall", name, "-n", namespace]);
            if self.kubeconfig_path().exists() {
                cmd.env("KUBECONFIG", self.kubeconfig_path());
            }
            cmd.output().await?
        };

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            anyhow::bail!("helm uninstall failed: {stderr}");
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        Ok(stdout.trim().to_string())
    }

    /// Install a Helm chart.
    pub async fn helm_install(
        &self,
        release_name: &str,
        chart: &str,
        namespace: &str,
        set_values: Option<&[String]>,
    ) -> anyhow::Result<String> {
        #[cfg(target_os = "windows")]
        let output = {
            let mut args = vec![
                "-u".to_string(), "root".to_string(), "--".to_string(),
                "helm".to_string(), "install".to_string(),
                release_name.to_string(), chart.to_string(),
                "-n".to_string(), namespace.to_string(),
                "--create-namespace".to_string(),
            ];
            if let Some(vals) = set_values {
                for v in vals {
                    args.push("--set".to_string());
                    args.push(v.to_string());
                }
            }
            Command::new("wsl")
                .args(&args)
                .output()
                .await?
        };

        #[cfg(not(target_os = "windows"))]
        let output = {
            let mut cmd = Command::new("helm");
            cmd.args(["install", release_name, chart, "-n", namespace, "--create-namespace"]);
            if let Some(vals) = set_values {
                for v in vals {
                    cmd.args(["--set", v]);
                }
            }
            if self.kubeconfig_path().exists() {
                cmd.env("KUBECONFIG", self.kubeconfig_path());
            }
            cmd.output().await?
        };

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            anyhow::bail!("helm install failed: {stderr}");
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        Ok(stdout.trim().to_string())
    }

    /// Check if helm CLI is available.
    pub async fn helm_available(&self) -> bool {
        #[cfg(target_os = "windows")]
        {
            Command::new("wsl")
                .args(["-u", "root", "--", "which", "helm"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .await
                .is_ok_and(|s| s.success())
        }

        #[cfg(not(target_os = "windows"))]
        {
            Command::new("helm")
                .arg("version")
                .args(["--short"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .await
                .is_ok_and(|s| s.success())
        }
    }
}

impl K3sManager {
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

/// Format a chrono::Duration into a human-readable string (e.g. "2h30m").
#[allow(dead_code)]
fn format_chrono_duration(dur: chrono::Duration) -> String {
    let secs = dur.num_seconds().unsigned_abs();
    if secs < 60 {
        format!("{secs}s")
    } else if secs < 3600 {
        format!("{}m{}s", secs / 60, secs % 60)
    } else if secs < 86400 {
        format!("{}h{}m", secs / 3600, (secs % 3600) / 60)
    } else {
        format!("{}d{}h", secs / 86400, (secs % 86400) / 3600)
    }
}

/// Parse two RFC 3339 timestamps and return a human-readable duration.
#[allow(dead_code)]
fn format_duration_between(start: &str, end: &str) -> String {
    let Ok(s) = chrono::DateTime::parse_from_rfc3339(start) else { return String::new() };
    let Ok(e) = chrono::DateTime::parse_from_rfc3339(end) else { return String::new() };
    format_chrono_duration(e.signed_duration_since(s))
}

/// Parse an RFC 3339 timestamp and return duration since now.
#[allow(dead_code)]
fn format_duration_since(start: &str) -> String {
    let Ok(s) = chrono::DateTime::parse_from_rfc3339(start) else { return String::new() };
    format_chrono_duration(chrono::Utc::now().signed_duration_since(s))
}
