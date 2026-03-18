//! Global Orca configuration.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::machine::MachineConfig;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrcaConfig {
    /// Where Orca stores its data (VMs, caches, etc).
    pub data_dir: PathBuf,
    /// Default machine configuration for new machines.
    pub default_machine: MachineConfig,
    /// Whether to start the default machine on login.
    pub start_on_login: bool,
    /// Whether to show the system tray icon.
    pub show_tray_icon: bool,
    /// Telemetry opt-in (off by default, obviously).
    pub telemetry: bool,
}

impl Default for OrcaConfig {
    fn default() -> Self {
        let data_dir = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("~/.local/share"))
            .join("orca");

        Self {
            data_dir,
            default_machine: MachineConfig::default(),
            start_on_login: false,
            show_tray_icon: true,
            telemetry: false,
        }
    }
}

impl OrcaConfig {
    pub fn config_path() -> PathBuf {
        dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("~/.config"))
            .join("orca")
            .join("config.json")
    }

    pub fn load() -> anyhow::Result<Self> {
        let path = Self::config_path();
        if path.exists() {
            let contents = std::fs::read_to_string(&path)?;
            Ok(serde_json::from_str(&contents)?)
        } else {
            Ok(Self::default())
        }
    }

    pub fn save(&self) -> anyhow::Result<()> {
        let path = Self::config_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let contents = serde_json::to_string_pretty(self)?;
        std::fs::write(&path, contents)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_has_sensible_values() {
        let config = OrcaConfig::default();

        // Data dir should end with "orca"
        assert!(
            config.data_dir.ends_with("orca"),
            "data_dir should end with 'orca', got {:?}",
            config.data_dir
        );

        // Secure defaults
        assert!(!config.start_on_login, "start_on_login should default to false");
        assert!(config.show_tray_icon, "show_tray_icon should default to true");
        assert!(!config.telemetry, "telemetry should default to false");

        // Default machine should have reasonable resources
        let machine = &config.default_machine;
        assert!(machine.cpus >= 1, "default cpus should be at least 1");
        assert!(machine.memory_mb >= 1024, "default memory should be at least 1024 MB");
        assert!(machine.disk_gb >= 10, "default disk should be at least 10 GB");
    }

    #[test]
    fn config_serialization_roundtrip() {
        let original = OrcaConfig::default();
        let json = serde_json::to_string_pretty(&original).expect("serialize");
        let restored: OrcaConfig = serde_json::from_str(&json).expect("deserialize");

        assert_eq!(original.data_dir, restored.data_dir);
        assert_eq!(original.start_on_login, restored.start_on_login);
        assert_eq!(original.show_tray_icon, restored.show_tray_icon);
        assert_eq!(original.telemetry, restored.telemetry);
        assert_eq!(original.default_machine.name, restored.default_machine.name);
        assert_eq!(original.default_machine.cpus, restored.default_machine.cpus);
        assert_eq!(original.default_machine.memory_mb, restored.default_machine.memory_mb);
        assert_eq!(original.default_machine.disk_gb, restored.default_machine.disk_gb);
    }

    #[test]
    fn config_path_ends_with_expected_segments() {
        let path = OrcaConfig::config_path();
        assert!(
            path.ends_with("orca/config.json"),
            "config path should end with orca/config.json, got {:?}",
            path
        );
    }
}
