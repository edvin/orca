use std::sync::Arc;

use tokio::sync::broadcast;

use orca_backend_native::NativeBackend;
use orca_core::config::OrcaConfig;
use orca_core::event::Event;

/// Shared application state for the daemon.
pub struct AppState {
    pub config: OrcaConfig,
    pub backend: Arc<NativeBackend>,
    pub events_tx: broadcast::Sender<Event>,
}

impl AppState {
    pub fn new(
        config: OrcaConfig,
        backend: Arc<NativeBackend>,
        events_tx: broadcast::Sender<Event>,
    ) -> Self {
        Self {
            config,
            backend,
            events_tx,
        }
    }
}
