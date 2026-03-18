use vessel_core::config::VesselConfig;

/// Shared application state for the daemon.
pub struct AppState {
    pub config: VesselConfig,
    // TODO: Add MachineManager, ContainerRuntime, etc.
    // These will be trait objects selected based on the current platform.
}

impl AppState {
    pub fn new(config: VesselConfig) -> Self {
        Self { config }
    }
}
