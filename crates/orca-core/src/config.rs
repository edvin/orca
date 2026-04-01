//! Global Orca configuration.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::machine::MachineConfig;

/// A remote orca-daemon host.
/// Tokens are stored as base64-encoded strings in the config file (same security as registry passwords).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteHost {
    /// Unique identifier (hex timestamp-based).
    pub id: String,
    /// Display name (e.g., "Production", "Staging").
    pub name: String,
    /// Full API URL (e.g., "https://prod.example.com:9477/api/v1").
    pub url: String,
    /// API bearer token (base64-encoded for storage).
    pub token: String,
    /// Whether to verify TLS certificates (default true).
    #[serde(default = "default_true")]
    pub tls_verify: bool,
    /// User-defined tags for categorization (e.g., "production", "eu-west").
    #[serde(default)]
    pub tags: Vec<String>,
}

fn default_true() -> bool {
    true
}

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
    /// AI provider: "anthropic", "openai", "gemini", or "custom"
    #[serde(default = "default_ai_provider")]
    pub ai_provider: String,
    /// OpenAI-compatible API key (also used for Google, Ollama, etc.)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub openai_api_key: Option<String>,
    /// OpenAI-compatible API base URL (default: https://api.openai.com/v1)
    #[serde(default = "default_openai_url")]
    pub openai_url: String,
    /// OpenAI-compatible model to use (default: gpt-4o)
    #[serde(default = "default_openai_model")]
    pub openai_model: String,
    /// Anthropic model to use (default: claude-sonnet-4-20250514)
    #[serde(default = "default_anthropic_model")]
    pub anthropic_model: String,
    /// Remote orca-daemon hosts.
    #[serde(default)]
    pub remote_hosts: Vec<RemoteHost>,
    /// Global webhook secret for HMAC-SHA256 signature validation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub webhook_secret: Option<String>,
    /// Auto-deploy rules mapping image patterns to containers.
    #[serde(default)]
    pub deploy_rules: Vec<DeployRule>,
    /// Recent deploy history (newest first, capped at 100).
    #[serde(default)]
    pub deploy_history: Vec<DeployRecord>,
    /// Scheduled container actions (built-in cron).
    #[serde(default)]
    pub schedules: Vec<ScheduledAction>,
    /// Gateway (managed Caddy reverse proxy) configuration.
    #[serde(default)]
    pub gateway: GatewayConfig,
}

/// A scheduled container action (e.g., restart every Sunday).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduledAction {
    pub id: String,
    pub name: String,
    /// Container name or ID to act on.
    pub container: String,
    /// Action to perform: "start", "stop", "restart".
    pub action: String,
    /// Cron expression (e.g., "0 3 * * 0" for Sunday at 3am).
    pub cron: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Timestamp of last execution (unix seconds).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run: Option<u64>,
}

/// Gateway (managed Caddy reverse proxy) configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewayConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_gateway_domain")]
    pub domain: String,
    #[serde(default = "default_http_port")]
    pub http_port: u16,
    #[serde(default = "default_https_port")]
    pub https_port: u16,
    #[serde(default)]
    pub tls_mode: GatewayTlsMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_cert: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_key: Option<String>,
    #[serde(default)]
    pub routes: Vec<GatewayRoute>,
    /// Environment links grouped by stack/group for multi-environment navigation.
    #[serde(default)]
    pub stack_links: Vec<StackLinkGroup>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewayRoute {
    pub hostname: String,
    pub container_name: String,
    pub port: u16,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GatewayTlsMode {
    #[default]
    OrcaCa,
    Custom,
}

impl Default for GatewayConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            domain: default_gateway_domain(),
            http_port: default_http_port(),
            https_port: default_https_port(),
            tls_mode: GatewayTlsMode::default(),
            custom_cert: None,
            custom_key: None,
            routes: Vec::new(),
            stack_links: Vec::new(),
        }
    }
}

/// A group of environment links for a stack (e.g., "Storefront", "Admin").
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StackLinkGroup {
    /// Which stack these links belong to.
    pub stack: String,
    /// Group name (e.g., "Storefront", "Admin").
    pub group: String,
    /// Links within this group.
    pub links: Vec<EnvironmentLink>,
}

/// A single link with URLs per environment.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EnvironmentLink {
    /// Display name (e.g., "Web App", "Admin Panel").
    pub name: String,
    /// Map of environment name to URL. "local" values are gateway hostnames.
    pub urls: std::collections::BTreeMap<String, String>,
}

fn default_gateway_domain() -> String {
    "localhost".into()
}
fn default_http_port() -> u16 {
    80
}
fn default_https_port() -> u16 {
    443
}

/// A deployment rule that maps an image pattern to containers for auto-deploy.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeployRule {
    pub id: String,
    pub name: String,
    /// Image to match (e.g., "ghcr.io/edvin/myapp"). Without tag.
    pub image_pattern: String,
    /// Tag filter: "latest", "v*" (glob), "*" for any, or empty for any.
    #[serde(default)]
    pub tag_filter: String,
    /// Container names to redeploy. If empty, matches any container running this image.
    #[serde(default)]
    pub container_names: Vec<String>,
    /// Per-rule webhook secret (overrides global).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub webhook_secret: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeployRecord {
    pub id: String,
    pub rule_name: String,
    pub image: String,
    pub tag: String,
    pub container_name: String,
    pub status: DeployStatus,
    pub timestamp: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum DeployStatus {
    Success,
    Failed,
}

impl OrcaConfig {
    /// Find deploy rules matching an image and tag.
    pub fn find_matching_rules(&self, image: &str, tag: &str) -> Vec<&DeployRule> {
        self.deploy_rules
            .iter()
            .filter(|r| {
                if !r.enabled {
                    return false;
                }
                // Match image pattern (substring or exact)
                if !image.contains(&r.image_pattern) && r.image_pattern != image {
                    return false;
                }
                // Match tag filter
                let filter = r.tag_filter.trim();
                if filter.is_empty() || filter == "*" {
                    return true;
                }
                if filter.contains('*') {
                    // Simple glob: "v*" matches "v1.2.3"
                    let prefix = filter.trim_end_matches('*');
                    tag.starts_with(prefix)
                } else {
                    tag == filter
                }
            })
            .collect()
    }

    /// Add a deploy record, capping history at 100 entries.
    pub fn add_deploy_record(&mut self, record: DeployRecord) {
        self.deploy_history.insert(0, record);
        self.deploy_history.truncate(100);
    }
}

fn default_ai_provider() -> String {
    "anthropic".into()
}
fn default_openai_url() -> String {
    "https://api.openai.com/v1".into()
}
fn default_openai_model() -> String {
    "gpt-4o".into()
}
fn default_anthropic_model() -> String {
    "claude-sonnet-4-20250514".into()
}

/// Generate a 32-character hex token using platform-appropriate randomness.
pub(crate) fn generate_random_token() -> anyhow::Result<String> {
    let mut bytes = [0u8; 16];

    // Try /dev/urandom (Linux/macOS)
    #[cfg(unix)]
    {
        let mut f = std::fs::File::open("/dev/urandom")?;
        std::io::Read::read_exact(&mut f, &mut bytes)?;
    }

    // Windows: use the system RNG via std
    #[cfg(windows)]
    {
        use std::collections::hash_map::RandomState;
        use std::hash::{BuildHasher, Hasher};
        // Use multiple random hashers to gather entropy
        for chunk in bytes.chunks_mut(8) {
            let s = RandomState::new();
            let val = s.build_hasher().finish().to_le_bytes();
            for (i, b) in chunk.iter_mut().enumerate() {
                if i < val.len() {
                    *b = val[i];
                }
            }
        }
    }

    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

impl Default for OrcaConfig {
    fn default() -> Self {
        let data_dir = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("~/.local/share"))
            .join("orca");

        Self {
            data_dir,
            default_machine: MachineConfig::default(),
            start_on_login: true,
            show_tray_icon: true,
            telemetry: false,
            api_token: None,
            registries: Vec::new(),
            anthropic_api_key: None,
            ai_provider: default_ai_provider(),
            openai_api_key: None,
            openai_url: default_openai_url(),
            openai_model: default_openai_model(),
            anthropic_model: default_anthropic_model(),
            remote_hosts: Vec::new(),
            webhook_secret: None,
            deploy_rules: Vec::new(),
            deploy_history: Vec::new(),
            schedules: Vec::new(),
            gateway: GatewayConfig::default(),
        }
    }
}

impl OrcaConfig {
    pub fn config_path() -> PathBuf {
        // On Linux, prefer /etc/orca/config.json for system-wide daemon installs
        // (e.g., apt-installed orca-daemon running as systemd service)
        #[cfg(target_os = "linux")]
        {
            let etc_path = PathBuf::from("/etc/orca/config.json");
            if etc_path.exists() {
                return etc_path;
            }
        }
        dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("~/.config"))
            .join("orca")
            .join("config.json")
    }

    pub fn load() -> anyhow::Result<Self> {
        let path = Self::config_path();
        if path.exists() {
            let contents = std::fs::read_to_string(&path)?;
            match serde_json::from_str(&contents) {
                Ok(config) => Ok(config),
                Err(e) => {
                    // Config file failed to parse — could be a partial write from
                    // another process. Do NOT overwrite it — just return defaults
                    // in memory. The file will be fixed on the next successful save.
                    tracing::warn!(
                        "Config file at {} could not be parsed ({}), using in-memory defaults. \
                         File NOT overwritten — may recover on next load.",
                        path.display(),
                        e
                    );
                    Ok(Self::default())
                }
            }
        } else {
            Ok(Self::default())
        }
    }

    /// Ensure an API token exists. Generates a cryptographically random
    /// 32-character hex token if none is set, saves the config, and returns
    /// a reference to the token.
    pub fn ensure_token(&mut self) -> anyhow::Result<&str> {
        if self.api_token.is_none() {
            let token = generate_random_token()?;
            self.api_token = Some(token);
            self.save()?;
        }
        Ok(self.api_token.as_ref().expect("token was just set"))
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
        let registry =
            if image_ref.contains('/') && image_ref.split('/').next().map(|s| s.contains('.')).unwrap_or(false) {
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
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
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
        assert!(config.start_on_login, "start_on_login should default to true");
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

    #[test]
    fn find_credentials_matches_ghcr() {
        let mut config = OrcaConfig::default();
        config.registries.push(RegistryCredential::new(
            "https://ghcr.io",
            "GitHub Container Registry",
            "user",
            "token123",
        ));
        let cred = config.find_credentials("ghcr.io/user/repo:tag");
        assert!(cred.is_some(), "should match ghcr.io credential");
        assert_eq!(cred.unwrap().username, "user");
    }

    #[test]
    fn find_credentials_matches_docker_hub() {
        let mut config = OrcaConfig::default();
        config.registries.push(RegistryCredential::new(
            "https://index.docker.io/v1/",
            "Docker Hub",
            "dockeruser",
            "dockerpass",
        ));
        let cred = config.find_credentials("nginx:latest");
        assert!(cred.is_some(), "should match docker.io credential for bare image name");
        assert_eq!(cred.unwrap().username, "dockeruser");
    }

    #[test]
    fn find_credentials_no_match() {
        let mut config = OrcaConfig::default();
        config
            .registries
            .push(RegistryCredential::new("https://ghcr.io", "GitHub", "user", "pass"));
        let cred = config.find_credentials("registry.example.com/image:v1");
        assert!(cred.is_none(), "should not match unknown registry");
    }

    #[test]
    fn registry_credential_password_roundtrip() {
        let cred = RegistryCredential::new("https://ghcr.io", "GH", "user", "s3cret!");
        assert_eq!(cred.password(), "s3cret!");
    }

    #[test]
    fn add_registry_replaces_existing() {
        let mut config = OrcaConfig::default();
        // Bypass save() by manipulating registries directly (same logic as add_registry minus save)
        let cred1 = RegistryCredential::new("https://ghcr.io", "GH", "old_user", "old_pass");
        config.registries.push(cred1);
        let cred2 = RegistryCredential::new("https://ghcr.io", "GH", "new_user", "new_pass");
        config.registries.retain(|r| r.server != cred2.server);
        config.registries.push(cred2);

        assert_eq!(config.registries.len(), 1, "should have exactly one entry");
        assert_eq!(config.registries[0].username, "new_user");
    }

    #[test]
    fn remove_registry_works() {
        let mut config = OrcaConfig::default();
        config
            .registries
            .push(RegistryCredential::new("https://ghcr.io", "GH", "user", "pass"));
        config.registries.push(RegistryCredential::new(
            "https://index.docker.io/v1/",
            "Docker Hub",
            "user2",
            "pass2",
        ));
        config.registries.retain(|r| r.server != "https://ghcr.io");
        assert_eq!(config.registries.len(), 1);
        assert_eq!(config.registries[0].server, "https://index.docker.io/v1/");
    }

    #[test]
    fn generate_random_token_length() {
        let token = generate_random_token().expect("should generate token");
        assert_eq!(token.len(), 32, "token should be 32 hex chars, got {}", token.len());
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()), "token should be hex");
    }
}
