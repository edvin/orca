use std::sync::Arc;

use tokio::sync::broadcast;

use vessel_backend_native::NativeBackend;
use vessel_core::config::VesselConfig;
use vessel_core::event::Event;

/// Shared application state for the daemon.
pub struct AppState {
    pub config: VesselConfig,
    pub backend: Arc<NativeBackend>,
    pub events_tx: broadcast::Sender<Event>,
}

impl AppState {
    pub fn new(
        config: VesselConfig,
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
