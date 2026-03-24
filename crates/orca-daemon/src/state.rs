use std::sync::Arc;

use tokio::sync::{Mutex, RwLock, broadcast};

use orca_backend_common::BollardRuntime;
use orca_backend_common::k8s::K3sManager;
use orca_core::config::OrcaConfig;
use orca_core::event::Event;

/// Shared application state for the daemon.
///
/// The runtime is wrapped in RwLock so it can be hot-swapped when
/// reconnecting to Docker without restarting the daemon.
pub struct AppState {
    pub config: Mutex<OrcaConfig>,
    pub runtime: RwLock<Arc<BollardRuntime>>,
    pub k8s: Arc<K3sManager>,
    pub events_tx: broadcast::Sender<Event>,
    /// API authentication token. Empty string means auth is disabled (--no-auth).
    pub api_token: String,
}

impl AppState {
    pub fn new(
        config: OrcaConfig,
        runtime: Arc<BollardRuntime>,
        k8s: Arc<K3sManager>,
        events_tx: broadcast::Sender<Event>,
        api_token: String,
    ) -> Self {
        Self {
            config: Mutex::new(config),
            runtime: RwLock::new(runtime),
            k8s,
            events_tx,
            api_token,
        }
    }

    /// Get the current runtime (read lock — fast, concurrent).
    pub async fn rt(&self) -> Arc<BollardRuntime> {
        self.runtime.read().await.clone()
    }

    /// Swap the runtime with a new connection (write lock — exclusive).
    pub async fn swap_runtime(&self, new_runtime: Arc<BollardRuntime>) {
        let mut guard = self.runtime.write().await;
        *guard = new_runtime;
        tracing::info!("Runtime connection hot-swapped successfully");
    }
}
