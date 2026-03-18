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
