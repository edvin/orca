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
    /// Whether to intercept docker-desktop:// URLs and handle them in Orca.
    #[serde(default = "default_true")]
    pub intercept_docker_desktop_urls: bool,
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
    /// For action="build": name of an orca.yaml build target to execute.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build_target: Option<String>,
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
    /// How the gateway and Traefik coexist.
    #[serde(default)]
    pub traefik_mode: TraefikIntegrationMode,
    /// Traefik HTTP port (for separate_ports / gateway_proxies_traefik modes).
    #[serde(default = "default_traefik_http")]
    pub traefik_http_port: u16,
    /// Traefik HTTPS port (for separate_ports / gateway_proxies_traefik modes).
    #[serde(default = "default_traefik_https")]
    pub traefik_https_port: u16,
    /// Dismissed route suggestions (container_name:port combos).
    #[serde(default)]
    pub dismissed_suggestions: Vec<String>,
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

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TraefikIntegrationMode {
    #[default]
    GatewayOnly,
    SeparatePorts,
    GatewayProxiesTraefik,
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
            traefik_mode: TraefikIntegrationMode::default(),
            traefik_http_port: default_traefik_http(),
            traefik_https_port: default_traefik_https(),
            dismissed_suggestions: Vec::new(),
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

fn default_traefik_http() -> u16 {
    30080
}
fn default_traefik_https() -> u16 {
    30443
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

/// Extract the registry host from an image reference.
/// `ghcr.io/user/repo:tag` -> `ghcr.io`
/// `registry:5000/foo/bar` -> `registry:5000`
/// `nginx:latest` -> `docker.io`
/// `localhost/foo` -> `localhost`
fn extract_registry_host(image_ref: &str) -> String {
    let first = image_ref.split('/').next().unwrap_or(image_ref);
    // A registry host must contain `.`, `:` (port), or be literally `localhost`.
    // Bare `nginx` or `library/nginx` means Docker Hub.
    if image_ref.contains('/') && (first.contains('.') || first.contains(':') || first == "localhost") {
        first.to_string()
    } else {
        "docker.io".to_string()
    }
}

impl OrcaConfig {
    /// Find deploy rules matching an image and tag.
    ///
    /// Image matching is strict to avoid silent cross-rule triggering:
    /// * Exact match: pattern `ghcr.io/user/app` matches only
    ///   `ghcr.io/user/app`.
    /// * Registry-stripped match: pattern `user/app` matches `ghcr.io/user/app`
    ///   only when the stripped prefix is a valid registry host (contains
    ///   `.`, `:`, or is literally `localhost`). This prevents
    ///   `pattern="user/app"` from matching `image="evil/user/app"` where
    ///   `evil` is a Docker Hub namespace, not a registry host.
    ///
    /// No substring matching — that was a silent cross-image footgun.
    pub fn find_matching_rules(&self, image: &str, tag: &str) -> Vec<&DeployRule> {
        self.deploy_rules
            .iter()
            .filter(|r| {
                if !r.enabled {
                    return false;
                }
                let pattern = r.image_pattern.trim();
                if pattern.is_empty() {
                    return false;
                }

                let image_matches = if image == pattern {
                    true
                } else {
                    // Strip leading registry host if present, then compare
                    // the rest exactly. The prefix MUST look like a
                    // registry host for the strip to happen.
                    match image.split_once('/') {
                        Some((first, rest)) => {
                            let is_registry_host = first.contains('.') || first.contains(':') || first == "localhost";
                            is_registry_host && rest == pattern
                        }
                        None => false,
                    }
                };
                if !image_matches {
                    return false;
                }

                // Tag filter: empty or "*" matches any, "prefix*" glob, else exact.
                let filter = r.tag_filter.trim();
                if filter.is_empty() || filter == "*" {
                    return true;
                }
                if let Some(prefix) = filter.strip_suffix('*') {
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

/// Generate a 32-character hex token using the OS cryptographic RNG.
/// Uses `/dev/urandom` on Unix, `BCryptGenRandom` on Windows (via `getrandom`).
pub(crate) fn generate_random_token() -> anyhow::Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|e| anyhow::anyhow!("failed to read OS RNG: {e}"))?;
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
            intercept_docker_desktop_urls: true,
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

    /// Load config from disk. Returns an error on parse failure so callers
    /// cannot accidentally overwrite a corrupt-but-recoverable file with
    /// defaults. Use [`load_or_default`] for callers that explicitly want
    /// defaults on missing-or-broken.
    pub fn load() -> anyhow::Result<Self> {
        let path = Self::config_path();
        if !path.exists() {
            return Ok(Self::default());
        }
        let contents = std::fs::read_to_string(&path)?;
        let cfg: Self = serde_json::from_str(&contents)
            .map_err(|e| anyhow::anyhow!("config at {} is not valid JSON: {e}", path.display()))?;
        Self::warn_insecure_perms(&path);
        Ok(cfg)
    }

    /// Like [`load`] but returns defaults on missing or unparseable file.
    /// Used in contexts where we must not fail startup, logging warnings.
    pub fn load_or_default() -> Self {
        match Self::load() {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!("falling back to in-memory default config: {e}");
                Self::default()
            }
        }
    }

    /// Warn if the config file on disk has overly-permissive permissions or
    /// ownership on Unix. The file contains the API token and other secrets.
    #[cfg(unix)]
    fn warn_insecure_perms(path: &std::path::Path) {
        use std::os::unix::fs::MetadataExt;
        if let Ok(md) = std::fs::metadata(path) {
            let mode = md.mode() & 0o777;
            if mode & 0o077 != 0 {
                tracing::warn!(
                    "config file {} has insecure permissions {:o}. Expected 0600. \
                     Run: chmod 600 {}",
                    path.display(),
                    mode,
                    path.display()
                );
            }
        }
    }

    #[cfg(not(unix))]
    fn warn_insecure_perms(_path: &std::path::Path) {}

    /// Ensure an API token exists. Generates a cryptographically random
    /// 32-character hex token if none is set, saves the config, and returns
    /// a reference to the token.
    pub fn ensure_token(&mut self) -> anyhow::Result<&str> {
        if self.api_token.is_none() {
            let token = generate_random_token()?;
            self.api_token = Some(token);
            self.save()?;
        }
        self.api_token
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("api_token not set after ensure_token"))
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
    /// "registry:5000/img" -> look for "registry:5000"
    ///
    /// Matching is host-exact (after scheme/path normalization). We never
    /// substring-match — `example.com` must never match
    /// `evil.example.com.typosquat.io`.
    pub fn find_credentials(&self, image_ref: &str) -> Option<&RegistryCredential> {
        let registry = extract_registry_host(image_ref);

        self.registries.iter().find(|r| {
            let normalized = r
                .server
                .split("://")
                .nth(1)
                .unwrap_or(&r.server)
                .trim_end_matches('/')
                .split('/')
                .next()
                .unwrap_or("");
            if normalized.eq_ignore_ascii_case(&registry) {
                return true;
            }
            // Docker Hub has several canonical names.
            let docker_hub_aliases = ["docker.io", "index.docker.io", "registry-1.docker.io"];
            if docker_hub_aliases.iter().any(|a| a.eq_ignore_ascii_case(&registry))
                && docker_hub_aliases.iter().any(|a| a.eq_ignore_ascii_case(normalized))
            {
                return true;
            }
            false
        })
    }

    /// Persist the config atomically: write to a temp file alongside the target,
    /// fsync it, set 0600 perms on Unix, then rename over the destination.
    /// This prevents truncation/corruption if the process is killed mid-write
    /// and reduces the window for concurrent-writer lost updates.
    pub fn save(&self) -> anyhow::Result<()> {
        let path = Self::config_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let contents = serde_json::to_string_pretty(self)?;

        // Write to a unique temp file in the same directory so rename is atomic.
        let parent = path
            .parent()
            .ok_or_else(|| anyhow::anyhow!("invalid config path: no parent"))?;
        let mut rng_bytes = [0u8; 8];
        getrandom::getrandom(&mut rng_bytes)
            .map_err(|e| anyhow::anyhow!("failed to read OS RNG for temp suffix: {e}"))?;
        let suffix: String = rng_bytes.iter().map(|b| format!("{b:02x}")).collect();
        let tmp_path = parent.join(format!(
            ".{}.tmp.{}",
            path.file_name().and_then(|n| n.to_str()).unwrap_or("config.json"),
            suffix
        ));

        // Open with create_new (O_EXCL) so we never follow symlinks.
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp_path)?;
        use std::io::Write;
        f.write_all(contents.as_bytes())?;
        f.sync_all()?;
        drop(f);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Err(e) = std::fs::set_permissions(&tmp_path, std::fs::Permissions::from_mode(0o600)) {
                tracing::warn!("failed to set 0600 on {}: {}", tmp_path.display(), e);
            }
        }

        if let Err(e) = std::fs::rename(&tmp_path, &path) {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(e.into());
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

    // ---- Gateway config tests ----

    #[test]
    fn test_gateway_config_default() {
        let config = GatewayConfig::default();
        assert_eq!(config.domain, "localhost");
        assert_eq!(config.http_port, 80);
        assert_eq!(config.https_port, 443);
        assert!(!config.enabled);
        assert!(config.routes.is_empty());
        assert!(config.stack_links.is_empty());
        assert!(config.custom_cert.is_none());
        assert!(config.custom_key.is_none());
    }

    #[test]
    fn test_gateway_route_serialization_roundtrip() {
        let route = GatewayRoute {
            hostname: "myapp".to_string(),
            container_name: "myapp-frontend-1".to_string(),
            port: 3000,
            enabled: true,
            path: None,
        };
        let json = serde_json::to_string(&route).expect("serialize");
        let restored: GatewayRoute = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(restored.hostname, "myapp");
        assert_eq!(restored.container_name, "myapp-frontend-1");
        assert_eq!(restored.port, 3000);
        assert!(restored.enabled);
        assert!(restored.path.is_none());
    }

    #[test]
    fn test_gateway_route_with_path_serialization() {
        let route = GatewayRoute {
            hostname: "myapp".to_string(),
            container_name: "myapp-backend-1".to_string(),
            port: 8080,
            enabled: true,
            path: Some("/api/*".to_string()),
        };
        let json = serde_json::to_string(&route).expect("serialize");
        let restored: GatewayRoute = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(restored.path, Some("/api/*".to_string()));
    }

    #[test]
    fn test_gateway_route_without_path_omits_field() {
        let route = GatewayRoute {
            hostname: "myapp".to_string(),
            container_name: "myapp-1".to_string(),
            port: 3000,
            enabled: true,
            path: None,
        };
        let json = serde_json::to_string(&route).expect("serialize");
        assert!(
            !json.contains("\"path\""),
            "JSON should not contain 'path' field when None, got: {}",
            json
        );
    }

    #[test]
    fn test_gateway_route_enabled_defaults_to_true() {
        // Deserialize JSON without "enabled" field — should default to true
        let json = r#"{"hostname":"app","container_name":"app-1","port":3000}"#;
        let route: GatewayRoute = serde_json::from_str(json).expect("deserialize");
        assert!(route.enabled, "enabled should default to true");
    }

    #[test]
    fn test_gateway_config_backward_compatible() {
        // Serialize a default config, remove the gateway field, then deserialize.
        // This simulates upgrading from an older config that lacks the gateway key.
        let original = OrcaConfig::default();
        let mut val: serde_json::Value = serde_json::to_value(&original).expect("serialize to value");
        val.as_object_mut().unwrap().remove("gateway");
        let restored: OrcaConfig = serde_json::from_value(val).expect("deserialize without gateway");
        assert_eq!(restored.gateway.domain, "localhost");
        assert_eq!(restored.gateway.http_port, 80);
        assert_eq!(restored.gateway.https_port, 443);
        assert!(!restored.gateway.enabled);
        assert!(restored.gateway.routes.is_empty());
    }

    #[test]
    fn test_stack_link_group_serialization() {
        let group = StackLinkGroup {
            stack: "mystack".to_string(),
            group: "Frontend".to_string(),
            links: vec![EnvironmentLink {
                name: "Web App".to_string(),
                urls: {
                    let mut m = std::collections::BTreeMap::new();
                    m.insert("local".to_string(), "webapp".to_string());
                    m.insert("staging".to_string(), "https://staging.example.com".to_string());
                    m
                },
            }],
        };
        let json = serde_json::to_string(&group).expect("serialize");
        let restored: StackLinkGroup = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(restored.stack, "mystack");
        assert_eq!(restored.group, "Frontend");
        assert_eq!(restored.links.len(), 1);
        assert_eq!(restored.links[0].name, "Web App");
        assert_eq!(restored.links[0].urls.len(), 2);
        assert_eq!(restored.links[0].urls["local"], "webapp");
        assert_eq!(restored.links[0].urls["staging"], "https://staging.example.com");
    }

    #[test]
    fn test_environment_link_empty_urls() {
        let link = EnvironmentLink {
            name: "Empty".to_string(),
            urls: std::collections::BTreeMap::new(),
        };
        let json = serde_json::to_string(&link).expect("serialize");
        let restored: EnvironmentLink = serde_json::from_str(&json).expect("deserialize");
        assert!(restored.urls.is_empty());
    }

    #[test]
    fn test_gateway_tls_mode_serialization() {
        let orca_ca = GatewayTlsMode::OrcaCa;
        let json = serde_json::to_string(&orca_ca).expect("serialize");
        assert_eq!(json, r#""orca_ca""#);

        let custom = GatewayTlsMode::Custom;
        let json = serde_json::to_string(&custom).expect("serialize");
        assert_eq!(json, r#""custom""#);

        // Roundtrip
        let restored: GatewayTlsMode = serde_json::from_str(r#""orca_ca""#).expect("deserialize");
        assert!(matches!(restored, GatewayTlsMode::OrcaCa));
        let restored: GatewayTlsMode = serde_json::from_str(r#""custom""#).expect("deserialize");
        assert!(matches!(restored, GatewayTlsMode::Custom));
    }

    // ---- Deploy rules tests ----

    #[test]
    fn test_find_matching_rules_exact_image() {
        let mut config = OrcaConfig::default();
        config.deploy_rules.push(DeployRule {
            id: "1".to_string(),
            name: "Test".to_string(),
            image_pattern: "ghcr.io/user/app".to_string(),
            tag_filter: "*".to_string(),
            container_names: vec![],
            webhook_secret: None,
            enabled: true,
        });
        let matches = config.find_matching_rules("ghcr.io/user/app", "latest");
        assert_eq!(matches.len(), 1);
    }

    #[test]
    fn test_find_matching_rules_tag_glob() {
        let mut config = OrcaConfig::default();
        config.deploy_rules.push(DeployRule {
            id: "1".to_string(),
            name: "Test".to_string(),
            image_pattern: "ghcr.io/user/app".to_string(),
            tag_filter: "v*".to_string(),
            container_names: vec![],
            webhook_secret: None,
            enabled: true,
        });
        assert_eq!(config.find_matching_rules("ghcr.io/user/app", "v1.2.3").len(), 1);
        assert_eq!(config.find_matching_rules("ghcr.io/user/app", "latest").len(), 0);
    }

    #[test]
    fn test_find_matching_rules_disabled_excluded() {
        let mut config = OrcaConfig::default();
        config.deploy_rules.push(DeployRule {
            id: "1".to_string(),
            name: "Disabled".to_string(),
            image_pattern: "ghcr.io/user/app".to_string(),
            tag_filter: "*".to_string(),
            container_names: vec![],
            webhook_secret: None,
            enabled: false,
        });
        assert!(config.find_matching_rules("ghcr.io/user/app", "latest").is_empty());
    }

    #[test]
    fn test_find_matching_rules_empty_tag_filter_matches_all() {
        let mut config = OrcaConfig::default();
        config.deploy_rules.push(DeployRule {
            id: "1".to_string(),
            name: "Test".to_string(),
            image_pattern: "myapp".to_string(),
            tag_filter: "".to_string(),
            container_names: vec![],
            webhook_secret: None,
            enabled: true,
        });
        assert_eq!(config.find_matching_rules("myapp", "anything").len(), 1);
    }

    #[test]
    fn test_add_deploy_record_caps_at_100() {
        let mut config = OrcaConfig::default();
        for i in 0..110 {
            config.add_deploy_record(DeployRecord {
                id: format!("{i}"),
                rule_name: "test".to_string(),
                image: "img".to_string(),
                tag: "latest".to_string(),
                container_name: "c".to_string(),
                status: DeployStatus::Success,
                timestamp: "2024-01-01".to_string(),
                error: None,
            });
        }
        assert_eq!(config.deploy_history.len(), 100);
        // Most recent should be first
        assert_eq!(config.deploy_history[0].id, "109");
    }
}
