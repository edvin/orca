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

/// A Kubernetes event.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct K8sEvent {
    /// Normal, Warning, etc.
    #[serde(rename = "type")]
    pub event_type: String,
    pub reason: String,
    pub object: String,
    pub message: String,
    pub age: String,
    pub count: u32,
}

/// A Kubernetes ConfigMap.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct K8sConfigMap {
    pub name: String,
    pub namespace: String,
    pub keys: Vec<String>,
    pub data: std::collections::HashMap<String, String>,
    pub age: String,
}

/// Pod resource metrics (from kubectl top).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PodMetrics {
    pub name: String,
    pub cpu: String,      // e.g. "50m", "250m"
    pub memory: String,   // e.g. "128Mi", "1Gi"
}

/// A rollout revision for a deployment.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RolloutRevision {
    pub revision: u32,
    pub change_cause: Option<String>,
}

/// A Kubernetes Job.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Job {
    pub name: String,
    pub namespace: String,
    pub status: String,       // "Active" | "Succeeded" | "Failed"
    pub completions: String,  // "1/1" format
    pub duration: String,
    pub start_time: Option<String>,
    pub created_at: String,
}

/// A Kubernetes CronJob.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CronJob {
    pub name: String,
    pub namespace: String,
    pub schedule: String,
    pub suspend: bool,
    pub active: u32,
    pub last_schedule: Option<String>,
    pub created_at: String,
}

/// A Kubernetes DaemonSet.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DaemonSet {
    pub name: String,
    pub namespace: String,
    pub desired: i32,
    pub current: i32,
    pub ready: i32,
    pub node_selector: Option<String>,
    pub images: Vec<String>,
    pub created_at: String,
}

/// A Kubernetes StatefulSet.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatefulSet {
    pub name: String,
    pub namespace: String,
    pub ready: String,  // "2/3" format
    pub replicas: i32,
    pub images: Vec<String>,
    pub created_at: String,
}

/// A Kubernetes ReplicaSet.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplicaSet {
    pub name: String,
    pub namespace: String,
    pub desired: i32,
    pub current: i32,
    pub ready: i32,
    pub images: Vec<String>,
    pub owner: Option<String>,
    pub created_at: String,
}

/// A Helm release.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HelmRelease {
    pub name: String,
    pub namespace: String,
    pub chart: String,
    pub status: String,
    pub revision: String,
    pub updated: String,
    pub app_version: String,
}

/// A Kubernetes Secret.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct K8sSecret {
    pub name: String,
    pub namespace: String,
    pub secret_type: String,
    pub keys: Vec<String>,
    /// base64-encoded values
    pub data: std::collections::HashMap<String, String>,
    pub age: String,
}

/// A Kubernetes Horizontal Pod Autoscaler.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HorizontalPodAutoscaler {
    pub name: String,
    pub namespace: String,
    pub reference: String,      // "Deployment/nginx"
    pub min_replicas: i32,
    pub max_replicas: i32,
    pub current_replicas: i32,
    pub target_cpu: Option<String>,   // "50%"
    pub current_cpu: Option<String>,  // "30%"
    pub created_at: String,
}

/// A Kubernetes Network Policy.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkPolicy {
    pub name: String,
    pub namespace: String,
    pub pod_selector: String,
    pub policy_types: Vec<String>,  // ["Ingress", "Egress"]
    pub created_at: String,
}

/// A Kubernetes Storage Class.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageClass {
    pub name: String,
    pub provisioner: String,
    pub reclaim_policy: String,
    pub volume_binding_mode: String,
    pub is_default: bool,
    pub created_at: String,
}

/// A Kubernetes Custom Resource Definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomResourceDefinition {
    pub name: String,
    pub group: String,
    pub kind: String,
    pub scope: String,  // "Namespaced" or "Cluster"
    pub versions: Vec<String>,
    pub created_at: String,
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

    /// List events in a namespace.
    async fn list_events(&self, namespace: &str) -> anyhow::Result<Vec<K8sEvent>>;

    /// Create a namespace.
    async fn create_namespace(&self, name: &str) -> anyhow::Result<()>;

    /// Delete a namespace.
    async fn delete_namespace(&self, name: &str) -> anyhow::Result<()>;

    /// List ConfigMaps in a namespace.
    async fn list_configmaps(&self, namespace: &str) -> anyhow::Result<Vec<K8sConfigMap>>;

    /// List Secrets in a namespace.
    async fn list_secrets(&self, namespace: &str) -> anyhow::Result<Vec<K8sSecret>>;

    /// Get pod resource metrics (kubectl top pods).
    async fn list_pod_metrics(&self, namespace: &str) -> anyhow::Result<Vec<PodMetrics>>;

    /// Get rollout history for a deployment.
    async fn rollout_history(&self, namespace: &str, name: &str) -> anyhow::Result<Vec<RolloutRevision>>;

    /// Rollback a deployment to a specific revision (or previous if None).
    async fn rollout_undo(&self, namespace: &str, name: &str, revision: Option<u32>) -> anyhow::Result<String>;

    /// List Jobs in a namespace.
    async fn list_jobs(&self, namespace: &str) -> anyhow::Result<Vec<Job>>;

    /// List CronJobs in a namespace.
    async fn list_cronjobs(&self, namespace: &str) -> anyhow::Result<Vec<CronJob>>;

    /// List DaemonSets in a namespace.
    async fn list_daemonsets(&self, namespace: &str) -> anyhow::Result<Vec<DaemonSet>>;

    /// List StatefulSets in a namespace.
    async fn list_statefulsets(&self, namespace: &str) -> anyhow::Result<Vec<StatefulSet>>;

    /// List ReplicaSets in a namespace.
    async fn list_replicasets(&self, namespace: &str) -> anyhow::Result<Vec<ReplicaSet>>;

    /// Scale a StatefulSet.
    async fn scale_statefulset(
        &self,
        namespace: &str,
        name: &str,
        replicas: u32,
    ) -> anyhow::Result<()>;

    /// Restart a StatefulSet.
    async fn restart_statefulset(&self, namespace: &str, name: &str) -> anyhow::Result<()>;

    /// Delete a DaemonSet.
    async fn delete_daemonset(&self, namespace: &str, name: &str) -> anyhow::Result<()>;

    /// Delete a StatefulSet.
    async fn delete_statefulset(&self, namespace: &str, name: &str) -> anyhow::Result<()>;

    /// Delete a ReplicaSet.
    async fn delete_replicaset(&self, namespace: &str, name: &str) -> anyhow::Result<()>;

    /// Manually trigger a CronJob (creates a Job from it).
    async fn trigger_cronjob(&self, namespace: &str, name: &str) -> anyhow::Result<String>;

    /// Delete a Job.
    async fn delete_job(&self, namespace: &str, name: &str) -> anyhow::Result<()>;

    /// Delete a CronJob.
    async fn delete_cronjob(&self, namespace: &str, name: &str) -> anyhow::Result<()>;

    /// Suspend or unsuspend a CronJob.
    async fn suspend_cronjob(&self, namespace: &str, name: &str, suspend: bool) -> anyhow::Result<()>;

    /// Create a Secret in a namespace.
    async fn create_secret(
        &self,
        namespace: &str,
        name: &str,
        data: std::collections::HashMap<String, String>,
        secret_type: Option<&str>,
    ) -> anyhow::Result<()>;

    /// Delete a Secret.
    async fn delete_secret(&self, namespace: &str, name: &str) -> anyhow::Result<()>;

    /// Update a Secret's data.
    async fn update_secret(
        &self,
        namespace: &str,
        name: &str,
        data: std::collections::HashMap<String, String>,
    ) -> anyhow::Result<()>;

    /// Create a PersistentVolumeClaim.
    async fn create_pvc(
        &self,
        namespace: &str,
        name: &str,
        storage_class: &str,
        size: &str,
        access_modes: Vec<String>,
    ) -> anyhow::Result<()>;

    /// List Horizontal Pod Autoscalers in a namespace.
    async fn list_hpas(&self, namespace: &str) -> anyhow::Result<Vec<HorizontalPodAutoscaler>>;

    /// Create a Horizontal Pod Autoscaler.
    async fn create_hpa(
        &self,
        namespace: &str,
        name: &str,
        deployment: &str,
        min: i32,
        max: i32,
        cpu_target: i32,
    ) -> anyhow::Result<()>;

    /// Delete a Horizontal Pod Autoscaler.
    async fn delete_hpa(&self, namespace: &str, name: &str) -> anyhow::Result<()>;

    /// List Network Policies in a namespace.
    async fn list_network_policies(&self, namespace: &str) -> anyhow::Result<Vec<NetworkPolicy>>;

    /// Delete a Network Policy.
    async fn delete_network_policy(&self, namespace: &str, name: &str) -> anyhow::Result<()>;

    /// List Storage Classes (cluster-scoped).
    async fn list_storage_classes(&self) -> anyhow::Result<Vec<StorageClass>>;

    /// List Custom Resource Definitions (cluster-scoped).
    async fn list_crds(&self) -> anyhow::Result<Vec<CustomResourceDefinition>>;
}
