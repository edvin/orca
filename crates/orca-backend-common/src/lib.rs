//! Shared bollard-based container runtime logic.
//!
//! All Orca backends (native, macOS, Windows) talk to Docker/Podman
//! through the same Docker-compatible API. This crate provides the
//! shared implementation so each backend only needs to handle
//! platform-specific VM/machine management.

pub mod compose;
pub mod containers;
pub mod environment;
pub mod events;
pub mod export;
pub mod images;
pub mod k8s;
pub mod networks;
pub mod search;
pub mod templates;
pub mod volumes;

/// Shared container runtime client backed by bollard.
/// Each platform backend embeds this and delegates trait impls to it.
pub struct BollardRuntime {
    pub docker: bollard::Docker,
}

impl BollardRuntime {
    pub fn new(docker: bollard::Docker) -> Self {
        Self { docker }
    }

    /// Detect whether we're talking to Docker or Podman.
    pub async fn detect_runtime(&self) -> orca_core::runtime::RuntimeKind {
        if let Ok(version) = self.docker.version().await
            && let Some(components) = version.components
        {
            for c in &components {
                if c.name.to_lowercase().contains("podman") {
                    return orca_core::runtime::RuntimeKind::Podman;
                }
            }
        }
        orca_core::runtime::RuntimeKind::Docker
    }
}
