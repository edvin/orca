//! Global Orca configuration.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::machine::MachineConfig;

/// Saved registry credentials.
/// Passwords are stored as base64-encoded strings in the config file.
/// This is NOT encryption — it simply avoids plaintext passwords in the JSON.
/// In production, OS keychain integration (e.g., libsecret / macOS Keychain) should be used.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegistryCredential {
    /// Registry URL (e.g., "https://ghcr.io", "https://index.docker.io/v1/")
    pub server: String,
    /// Display name (e.g., "GitHub Container Registry")
    pub name: String,
    pub username: String,
    /// Base64-encoded password (not truly encrypted, but not plaintext)
    pub password_b64: String,
}

impl RegistryCredential {
    pub fn new(server: &str, name: &str, username: &str, password: &str) -> Self {
        use base64::Engine;
        Self {
            server: server.to_string(),
            name: name.to_string(),
            username: username.to_string(),
            password_b64: base64::engine::general_purpose::STANDARD.encode(password),
        }
    }

    pub fn password(&self) -> String {
        use base64::Engine;
        String::from_utf8(
            base64::engine::general_purpose::STANDARD
                .decode(&self.password_b64)
                .unwrap_or_default(),
        )
        .unwrap_or_default()
    }
}

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
    /// API authentication token. Auto-generated on first daemon start.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_token: Option<String>,
    /// Saved registry credentials (passwords are base64-encoded, not encrypted).
    #[serde(default)]
    pub registries: Vec<RegistryCredential>,
    /// Anthropic API key for AI assistant features.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anthropic_api_key: Option<String>,
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
            api_token: None,
            registries: Vec::new(),
            anthropic_api_key: None,
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

    /// Ensure an API token exists. Generates a cryptographically random
    /// 32-character hex token if none is set, saves the config, and returns
    /// a reference to the token.
    pub fn ensure_token(&mut self) -> anyhow::Result<&str> {
        if self.api_token.is_none() {
            let mut bytes = [0u8; 16];
            let mut f = std::fs::File::open("/dev/urandom")?;
            std::io::Read::read_exact(&mut f, &mut bytes)?;
            let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
            self.api_token = Some(token);
            self.save()?;
        }
        Ok(self.api_token.as_ref().unwrap())
    }

    pub fn add_registry(&mut self, cred: RegistryCredential) -> anyhow::Result<()> {
        // Replace if same server already exists
        self.registries.retain(|r| r.server != cred.server);
        self.registries.push(cred);
        self.save()
    }

    pub fn remove_registry(&mut self, server: &str) -> anyhow::Result<()> {
        self.registries.retain(|r| r.server != server);
        self.save()
    }

    /// Find credentials matching an image reference.
    /// "ghcr.io/user/repo:tag" -> look for "ghcr.io" or "https://ghcr.io"
    /// "nginx:latest" -> look for "docker.io" or "https://index.docker.io/v1/"
    pub fn find_credentials(&self, image_ref: &str) -> Option<&RegistryCredential> {
        let registry = if image_ref.contains('/')
            && image_ref
                .split('/')
                .next()
                .map(|s| s.contains('.'))
                .unwrap_or(false)
        {
            image_ref.split('/').next().unwrap_or("")
        } else {
            "docker.io"
        };

        self.registries.iter().find(|r| {
            let normalized = r
                .server
                .replace("https://", "")
                .replace("http://", "")
                .trim_end_matches('/')
                .to_string();
            normalized.contains(registry) || registry.contains(&normalized)
        })
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
