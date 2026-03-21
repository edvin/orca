//! Kubernetes cluster management — k3s lifecycle and workload types.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Kubernetes cluster status.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClusterStatus {
    pub enabled: bool,
    pub running: bool,
    pub version: Option<String>,
    pub node_name: Option<String>,
    pub node_status: Option<String>,
    pub pods_running: u32,
    pub pods_total: u32,
    /// Traefik dashboard URL (if available).
    pub traefik_dashboard: Option<String>,
    /// Diagnostic error message when cluster can't be reached.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// A Kubernetes pod.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Pod {
    pub name: String,
    pub namespace: String,
    pub status: String,
    pub ready: String,
    pub restarts: u32,
    pub age: String,
    pub node: Option<String>,
    pub ip: Option<String>,
    pub containers: Vec<PodContainer>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PodContainer {
    pub name: String,
    pub image: String,
    pub ready: bool,
    pub restart_count: u32,
    pub state: String,
}

/// A Kubernetes deployment.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Deployment {
    pub name: String,
    pub namespace: String,
    pub replicas_ready: u32,
    pub replicas_desired: u32,
    pub age: String,
    pub images: Vec<String>,
}

/// A Kubernetes service.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Service {
    pub name: String,
    pub namespace: String,
    pub service_type: String,
    pub cluster_ip: Option<String>,
    pub external_ip: Option<String>,
    pub ports: Vec<ServicePort>,
    pub age: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServicePort {
    pub name: Option<String>,
    pub port: i32,
    pub target_port: String,
    pub node_port: Option<i32>,
    pub protocol: String,
}

/// A Kubernetes ingress rule.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Ingress {
    pub name: String,
    pub namespace: String,
    pub hosts: Vec<String>,
    pub address: Option<String>,
    pub age: String,
}

/// A Kubernetes namespace.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Namespace {
    pub name: String,
    pub status: String,
    pub age: String,
}

/// A Kubernetes persistent volume claim.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistentVolumeClaim {
    pub name: String,
    pub namespace: String,
    pub status: String,
    pub volume: Option<String>,
    pub capacity: Option<String>,
    pub access_modes: Vec<String>,
    pub storage_class: Option<String>,
    pub age: String,
}

/// A Kubernetes persistent volume.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistentVolume {
    pub name: String,
    pub capacity: Option<String>,
    pub access_modes: Vec<String>,
    pub reclaim_policy: Option<String>,
    pub status: String,
    pub claim: Option<String>,
    pub storage_class: Option<String>,
    pub age: String,
}

/// Trait for managing a Kubernetes cluster (k3s).
#[trait_variant::make(Send)]
pub trait K8sManager {
    /// Enable Kubernetes (install k3s if needed, start the cluster).
    async fn enable(&self) -> anyhow::Result<()>;

    /// Disable Kubernetes (stop k3s, optionally clean up).
    async fn disable(&self) -> anyhow::Result<()>;

    /// Reset the cluster (delete all workloads, start fresh).
    async fn reset(&self) -> anyhow::Result<()>;

    /// Get cluster status.
    async fn status(&self) -> anyhow::Result<ClusterStatus>;

    /// Get the kubeconfig for connecting to the cluster.
    async fn kubeconfig(&self) -> anyhow::Result<String>;

    /// Write kubeconfig to the user's ~/.kube/config (merging contexts).
    async fn install_kubeconfig(&self) -> anyhow::Result<PathBuf>;

    // --- Workload queries ---

    async fn list_namespaces(&self) -> anyhow::Result<Vec<Namespace>>;
    async fn list_pods(&self, namespace: &str) -> anyhow::Result<Vec<Pod>>;
    async fn list_deployments(&self, namespace: &str) -> anyhow::Result<Vec<Deployment>>;
    async fn list_services(&self, namespace: &str) -> anyhow::Result<Vec<Service>>;
    async fn list_ingresses(&self, namespace: &str) -> anyhow::Result<Vec<Ingress>>;
    async fn list_pvcs(&self, namespace: &str) -> anyhow::Result<Vec<PersistentVolumeClaim>>;
    async fn list_pvs(&self) -> anyhow::Result<Vec<PersistentVolume>>;

    // --- Workload actions ---

    async fn delete_pod(&self, namespace: &str, name: &str) -> anyhow::Result<()>;
    async fn scale_deployment(
        &self,
        namespace: &str,
        name: &str,
        replicas: u32,
    ) -> anyhow::Result<()>;
    async fn restart_deployment(&self, namespace: &str, name: &str) -> anyhow::Result<()>;
    async fn delete_pvc(&self, namespace: &str, name: &str) -> anyhow::Result<()>;

    /// Get pod logs (reuses the container log pattern).
    async fn pod_logs(
        &self,
        namespace: &str,
        name: &str,
        container: Option<&str>,
        tail: Option<u32>,
    ) -> anyhow::Result<Vec<String>>;

    /// Apply a YAML manifest.
    async fn apply_yaml(&self, yaml: &str) -> anyhow::Result<String>;

    /// Delete a resource by YAML manifest.
    async fn delete_yaml(&self, yaml: &str) -> anyhow::Result<String>;
}
