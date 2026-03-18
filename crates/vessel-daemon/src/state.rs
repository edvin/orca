use std::sync::Arc;

use vessel_backend_native::NativeBackend;
use vessel_core::config::VesselConfig;

/// Shared application state for the daemon.
pub struct AppState {
    pub config: VesselConfig,
    pub backend: Arc<NativeBackend>,
}

impl AppState {
    pub fn new(config: VesselConfig, backend: Arc<NativeBackend>) -> Self {
        Self { config, backend }
    }
}
