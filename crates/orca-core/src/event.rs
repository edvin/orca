//! Event system for real-time updates to the GUI.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    pub timestamp: String,
    pub kind: EventKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum EventKind {
    // Machine events
    MachineStarted { name: String },
    MachineStopped { name: String },
    MachineError { name: String, error: String },

    // Container events
    ContainerCreated { id: String, name: String },
    ContainerStarted { id: String, name: String },
    ContainerStopped { id: String, name: String },
    ContainerRemoved { id: String, name: String },
    ContainerDied { id: String, name: String, exit_code: i32 },

    // Image events
    ImagePulled { id: String, reference: String },
    ImageRemoved { id: String },

    // Volume events
    VolumeCreated { name: String },
    VolumeRemoved { name: String },
}
