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
    MachineStarted {
        name: String,
    },
    MachineStopped {
        name: String,
    },
    MachineError {
        name: String,
        error: String,
    },

    // Container events
    ContainerCreated {
        id: String,
        name: String,
    },
    ContainerStarted {
        id: String,
        name: String,
    },
    ContainerStopped {
        id: String,
        name: String,
    },
    ContainerRemoved {
        id: String,
        name: String,
    },
    ContainerDied {
        id: String,
        name: String,
        exit_code: i32,
        #[serde(default)]
        oom_killed: bool,
    },

    // Image events
    ImagePulled {
        id: String,
        reference: String,
    },
    ImageRemoved {
        id: String,
    },

    // Volume events
    VolumeCreated {
        name: String,
    },
    VolumeRemoved {
        name: String,
    },

    // Build events
    BuildStarted {
        id: String,
        tag: String,
    },
    BuildCompleted {
        id: String,
        tag: String,
        success: bool,
    },

    /// Forward-compat catch-all for events emitted by newer daemons that
    /// older clients don't recognize. Keeps deserialization non-fatal
    /// across version skew.
    #[serde(other)]
    Unknown,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_kind_serializes_as_tagged_enum() {
        let kind = EventKind::ContainerStarted {
            id: "abc123".into(),
            name: "web-1".into(),
        };
        let json = serde_json::to_value(&kind).unwrap();

        // serde(tag = "type", content = "data") produces {"type": "...", "data": {...}}
        assert_eq!(json["type"], "ContainerStarted");
        assert_eq!(json["data"]["id"], "abc123");
        assert_eq!(json["data"]["name"], "web-1");
    }

    #[test]
    fn event_kind_machine_started_serialization() {
        let kind = EventKind::MachineStarted { name: "default".into() };
        let json = serde_json::to_value(&kind).unwrap();
        assert_eq!(json["type"], "MachineStarted");
        assert_eq!(json["data"]["name"], "default");
    }

    #[test]
    fn event_kind_container_died_includes_exit_code() {
        let kind = EventKind::ContainerDied {
            id: "def456".into(),
            name: "worker-1".into(),
            exit_code: 137,
            oom_killed: true,
        };
        let json = serde_json::to_value(&kind).unwrap();
        assert_eq!(json["type"], "ContainerDied");
        assert_eq!(json["data"]["exit_code"], 137);
        assert_eq!(json["data"]["oom_killed"], true);
    }

    #[test]
    fn event_kind_container_died_defaults_oom_killed() {
        let json = r#"{"type":"ContainerDied","data":{"id":"def456","name":"worker-1","exit_code":137}}"#;
        let kind: EventKind = serde_json::from_str(json).unwrap();
        let restored = serde_json::to_value(kind).unwrap();
        assert_eq!(restored["data"]["oom_killed"], false);
    }

    #[test]
    fn event_kind_roundtrip() {
        let original = EventKind::ImagePulled {
            id: "sha256:abc".into(),
            reference: "nginx:latest".into(),
        };
        let json_str = serde_json::to_string(&original).unwrap();
        let restored: EventKind = serde_json::from_str(&json_str).unwrap();

        // Verify via re-serialization (PartialEq not derived)
        let json_restored = serde_json::to_string(&restored).unwrap();
        assert_eq!(json_str, json_restored);
    }

    #[test]
    fn event_struct_serializes_with_timestamp() {
        let event = Event {
            timestamp: "2025-06-01T12:00:00Z".into(),
            kind: EventKind::VolumeCreated {
                name: "myvolume".into(),
            },
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["timestamp"], "2025-06-01T12:00:00Z");
        assert_eq!(json["kind"]["type"], "VolumeCreated");
        assert_eq!(json["kind"]["data"]["name"], "myvolume");
    }

    #[test]
    fn event_kind_machine_error_has_error_field() {
        let kind = EventKind::MachineError {
            name: "vm1".into(),
            error: "out of memory".into(),
        };
        let json = serde_json::to_value(&kind).unwrap();
        assert_eq!(json["type"], "MachineError");
        assert_eq!(json["data"]["error"], "out of memory");
    }
}
