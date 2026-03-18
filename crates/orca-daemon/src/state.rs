use std::sync::Arc;

use tokio::sync::broadcast;

use orca_backend_common::BollardRuntime;
use orca_core::config::OrcaConfig;
use orca_core::event::Event;

/// Shared application state for the daemon.
/// Uses BollardRuntime directly for container operations — this works
/// for all platforms since the bollard API is the same regardless of
/// whether the runtime is native, in a Lima VM, or in WSL2.
pub struct AppState {
    pub config: OrcaConfig,
    pub runtime: Arc<BollardRuntime>,
    pub events_tx: broadcast::Sender<Event>,
}

impl AppState {
    pub fn new(
        config: OrcaConfig,
        runtime: Arc<BollardRuntime>,
        events_tx: broadcast::Sender<Event>,
    ) -> Self {
        Self {
            config,
            runtime,
            events_tx,
        }
    }
}
