use serde::{Deserialize, Serialize};

/// Overall environment health status.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvironmentStatus {
    /// Can we run containers right now?
    pub ready: bool,
    /// "linux", "macos", or "windows"
    pub platform: String,
    /// Individual health checks.
    pub checks: Vec<HealthCheck>,
    /// Recommended container runtime: "podman" or "docker".
    pub suggested_runtime: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthCheck {
    pub name: String,
    pub description: String,
    pub status: CheckStatus,
    /// Identifier for an automated fix, if available.
    pub fix_action: Option<String>,
    /// Human-readable details (version info, error messages, etc).
    pub details: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum CheckStatus {
    Pass,
    Warning,
    Fail,
}

/// System-level health metrics.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemHealth {
    pub docker_connected: bool,
    pub docker_version: Option<String>,
    pub disk_usage: Option<DiskUsage>,
    pub system_resources: Option<SystemResources>,
    pub warnings: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gpu: Option<GpuInfo>,
    /// Operating system name (e.g., "linux", "windows").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub os: Option<String>,
    /// CPU architecture (e.g., "x86_64", "aarch64").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GpuInfo {
    pub name: String,
    pub memory_used_mb: u64,
    pub memory_total_mb: u64,
    pub utilization_percent: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiskUsage {
    pub images_size_bytes: u64,
    pub containers_size_bytes: u64,
    pub volumes_size_bytes: u64,
    pub build_cache_size_bytes: u64,
    pub total_size_bytes: u64,
    pub reclaimable_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemResources {
    pub cpu_count: u32,
    pub memory_total_bytes: u64,
    pub memory_available_bytes: u64,
    pub disk_total_bytes: u64,
    pub disk_free_bytes: u64,
    pub disk_usage_percent: f64,
}
