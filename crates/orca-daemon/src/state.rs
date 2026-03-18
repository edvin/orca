use std::sync::Arc;

use tokio::sync::broadcast;

use orca_backend_common::BollardRuntime;
use orca_backend_common::k8s::K3sManager;
use orca_core::config::OrcaConfig;
use orca_core::event::Event;

/// Shared application state for the daemon.
/// Uses BollardRuntime directly for container operations — this works
/// for all platforms since the bollard API is the same regardless of
/// whether the runtime is native, in a Lima VM, or in WSL2.
pub struct AppState {
    pub config: OrcaConfig,
    pub runtime: Arc<BollardRuntime>,
    pub k8s: Arc<K3sManager>,
    pub events_tx: broadcast::Sender<Event>,
}

impl AppState {
    pub fn new(
        config: OrcaConfig,
        runtime: Arc<BollardRuntime>,
        k8s: Arc<K3sManager>,
        events_tx: broadcast::Sender<Event>,
    ) -> Self {
        Self {
            config,
            runtime,
            k8s,
            events_tx,
        }
    }
}
