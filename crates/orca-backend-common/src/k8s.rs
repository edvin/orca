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
    /// Cached kube client (created on first use).
    client: tokio::sync::OnceCell<Client>,
}

impl K3sManager {
    pub fn new() -> Self {
        Self {
            kubeconfig_override: None,
            client: tokio::sync::OnceCell::new(),
        }
    }

    /// Create a K3sManager that uses a specific kubeconfig file.
    /// Useful for k3d clusters and testing.
    pub fn with_kubeconfig(path: PathBuf) -> Self {
        Self {
            kubeconfig_override: Some(path),
            client: tokio::sync::OnceCell::new(),
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

    fn kubeconfig_path(&self) -> PathBuf {
        if let Some(path) = &self.kubeconfig_override {
            return path.clone();
        }
        // Check KUBECONFIG env var
        if let Ok(path) = std::env::var("KUBECONFIG") {
            return PathBuf::from(path);
        }
        // Default k3s location
        PathBuf::from("/etc/rancher/k3s/k3s.yaml")
    }

    async fn get_client(&self) -> anyhow::Result<&Client> {
        self.client
            .get_or_try_init(|| async {
                let kubeconfig_path = self.kubeconfig_path();
                if !kubeconfig_path.exists() {
                    anyhow::bail!("Kubernetes not enabled — kubeconfig not found");
                }

                let kubeconfig = kube::config::Kubeconfig::read_from(&kubeconfig_path)?;
                let config = kube::Config::from_custom_kubeconfig(
                    kubeconfig,
                    &kube::config::KubeConfigOptions::default(),
                )
                .await?;
                Ok(Client::try_from(config)?)
            })
            .await
    }

    async fn is_k3s_installed(&self) -> bool {
        Command::new("k3s")
            .arg("--version")
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

        // Step 1: Check/install k3s
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
        let kubeconfig_exists = self.kubeconfig_path().exists();

        if !kubeconfig_exists {
            // Check if k3s is installed (for direct installs)
            let installed = self.is_k3s_installed().await;
            return Ok(ClusterStatus {
                enabled: installed,
                running: false,
                version: None,
                node_name: None,
                node_status: None,
                pods_running: 0,
                pods_total: 0,
                traefik_dashboard: None,
            });
        }

        let client = match self.get_client().await {
            Ok(c) => c,
            Err(_) => {
                return Ok(ClusterStatus {
                    enabled: true,
                    running: false,
                    version: None,
                    node_name: None,
                    node_status: None,
                    pods_running: 0,
                    pods_total: 0,
                    traefik_dashboard: None,
                });
            }
        };

        let running = client.apiserver_version().await.map(|_| ()).is_ok();

        // Get version
        let version = if running {
            client
                .apiserver_version()
                .await
                .ok()
                .map(|v| format!("v{}.{}", v.major, v.minor))
        } else {
            None
        };

        // Get node info
        let (node_name, node_status) = if running {
            let nodes: Api<k8s_openapi::api::core::v1::Node> = Api::all(client.clone());
            nodes
                .list(&ListParams::default())
                .await
                .ok()
                .and_then(|list| {
                    list.items.first().map(|n| {
                        let name = n.metadata.name.clone().unwrap_or_default();
                        let status = n
                            .status
                            .as_ref()
                            .and_then(|s| s.conditions.as_ref())
                            .and_then(|conds| {
                                conds
                                    .iter()
                                    .find(|c| c.type_ == "Ready")
                                    .map(|c| {
                                        if c.status == "True" {
                                            "Ready".to_string()
                                        } else {
                                            "NotReady".to_string()
                                        }
                                    })
                            })
                            .unwrap_or_else(|| "Unknown".to_string());
                        (name, status)
                    })
                })
                .map(|(n, s)| (Some(n), Some(s)))
                .unwrap_or((None, None))
        } else {
            (None, None)
        };

        // Count pods
        let (pods_running, pods_total) = if running {
            let pods: Api<k8s_openapi::api::core::v1::Pod> = Api::all(client.clone());
            pods.list(&ListParams::default())
                .await
                .ok()
                .map(|list| {
                    let total = list.items.len() as u32;
                    let running = list
                        .items
                        .iter()
                        .filter(|p| {
                            p.status
                                .as_ref()
                                .and_then(|s| s.phase.as_deref())
                                == Some("Running")
                        })
                        .count() as u32;
                    (running, total)
                })
                .unwrap_or((0, 0))
        } else {
            (0, 0)
        };

        Ok(ClusterStatus {
            enabled: true,
            running,
            version,
            node_name,
            node_status,
            pods_running,
            pods_total,
            traefik_dashboard: if running {
                Some("http://127.0.0.1:9000/dashboard/".to_string())
            } else {
                None
            },
        })
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

    // --- Workload queries ---

    async fn list_namespaces(&self) -> anyhow::Result<Vec<Namespace>> {
        let client = self.get_client().await?;
        let api: Api<k8s_openapi::api::core::v1::Namespace> = Api::all(client.clone());
        let list = api.list(&ListParams::default()).await?;

        Ok(list
            .items
            .iter()
            .map(|ns| {
                let name = ns.metadata.name.clone().unwrap_or_default();
                let status = ns
                    .status
                    .as_ref()
                    .and_then(|s| s.phase.clone())
                    .unwrap_or_else(|| "Active".to_string());
                let age = format_k8s_age(&ns.metadata.creation_timestamp);
                Namespace { name, status, age }
            })
            .collect())
    }

    async fn list_pods(&self, namespace: &str) -> anyhow::Result<Vec<Pod>> {
        let client = self.get_client().await?;
        let api: Api<k8s_openapi::api::core::v1::Pod> = Api::namespaced(client.clone(), namespace);
        let list = api.list(&ListParams::default()).await?;

        Ok(list.items.iter().map(|p| k8s_pod_to_pod(p, namespace)).collect())
    }

    async fn list_deployments(&self, namespace: &str) -> anyhow::Result<Vec<Deployment>> {
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

    async fn list_services(&self, namespace: &str) -> anyhow::Result<Vec<Service>> {
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

    async fn list_ingresses(&self, namespace: &str) -> anyhow::Result<Vec<Ingress>> {
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

    async fn list_pvcs(&self, namespace: &str) -> anyhow::Result<Vec<PersistentVolumeClaim>> {
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

    async fn list_pvs(&self) -> anyhow::Result<Vec<PersistentVolume>> {
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

    // --- Workload actions ---

    async fn delete_pod(&self, namespace: &str, name: &str) -> anyhow::Result<()> {
        let client = self.get_client().await?;
        let api: Api<k8s_openapi::api::core::v1::Pod> =
            Api::namespaced(client.clone(), namespace);
        api.delete(name, &DeleteParams::default()).await?;
        Ok(())
    }

    async fn scale_deployment(
        &self,
        namespace: &str,
        name: &str,
        replicas: u32,
    ) -> anyhow::Result<()> {
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

    async fn restart_deployment(&self, namespace: &str, name: &str) -> anyhow::Result<()> {
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

    async fn delete_pvc(&self, namespace: &str, name: &str) -> anyhow::Result<()> {
        let client = self.get_client().await?;
        let api: Api<k8s_openapi::api::core::v1::PersistentVolumeClaim> =
            Api::namespaced(client.clone(), namespace);
        api.delete(name, &DeleteParams::default()).await?;
        Ok(())
    }

    async fn pod_logs(
        &self,
        namespace: &str,
        name: &str,
        container: Option<&str>,
        tail: Option<u32>,
    ) -> anyhow::Result<Vec<String>> {
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

    async fn apply_yaml(&self, yaml: &str) -> anyhow::Result<String> {
        let kubectl = self.kubectl_bin();
        let output = Command::new("sh")
            .args(["-c", &format!("echo '{}' | {} apply -f -", yaml.replace('\'', "'\\''"), kubectl)])
            .env("KUBECONFIG", self.kubeconfig_path())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .await?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);

        if output.status.success() {
            Ok(stdout.to_string())
        } else {
            anyhow::bail!("{stderr}")
        }
    }

    async fn delete_yaml(&self, yaml: &str) -> anyhow::Result<String> {
        let kubectl = self.kubectl_bin();
        let output = Command::new("sh")
            .args(["-c", &format!("echo '{}' | {} delete -f -", yaml.replace('\'', "'\\''"), kubectl)])
            .env("KUBECONFIG", self.kubeconfig_path())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .await?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);

        if output.status.success() {
            Ok(stdout.to_string())
        } else {
            anyhow::bail!("{stderr}")
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
