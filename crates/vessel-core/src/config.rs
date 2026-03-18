//! Global Vessel configuration.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::machine::MachineConfig;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VesselConfig {
    /// Where Vessel stores its data (VMs, caches, etc).
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

impl Default for VesselConfig {
    fn default() -> Self {
        let data_dir = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("~/.local/share"))
            .join("vessel");

        Self {
            data_dir,
            default_machine: MachineConfig::default(),
            start_on_login: false,
            show_tray_icon: true,
            telemetry: false,
        }
    }
}

impl VesselConfig {
    pub fn config_path() -> PathBuf {
        dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("~/.config"))
            .join("vessel")
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
