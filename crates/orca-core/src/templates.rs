use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AppTemplate {
    pub id: String,
    pub name: String,
    pub description: String,
    pub icon: String,
    pub category: String,
    pub image: String,
    pub default_ports: Vec<String>,
    pub default_env: Vec<String>,
    pub default_volumes: Vec<String>,
    pub restart_policy: String,
    pub notes: String,
    /// Whether this is a builtin template (read-only) or user-created.
    #[serde(default)]
    pub is_builtin: bool,
    /// Optional docker-compose YAML content. When set, deploys as a compose stack
    /// instead of a single container.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compose_yaml: Option<String>,
    /// Environment variables to generate and write to .env file.
    /// Keys are var names, values describe how to generate them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generated_env: Option<std::collections::HashMap<String, GeneratedValue>>,
    /// Files to generate in the stack directory.
    /// Keys are relative paths, values describe how to generate them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generated_files: Option<std::collections::HashMap<String, GeneratedValue>>,
}

/// Describes how to generate a value for an env var or file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum GeneratedValue {
    /// Random hex string of given length.
    #[serde(rename = "random_hex")]
    RandomHex { length: Option<usize> },
    /// Random base64 string of given length.
    #[serde(rename = "random_base64")]
    RandomBase64 { length: Option<usize> },
    /// Auto-detect LAN IP address.
    #[serde(rename = "lan_ip")]
    LanIp,
    /// Prompt the user for input during deploy.
    #[serde(rename = "user_input")]
    UserInput {
        label: String,
        #[serde(default)]
        placeholder: Option<String>,
        #[serde(default)]
        required: bool,
        #[serde(default)]
        secret: bool,
    },
    /// Generate a self-signed TLS certificate.
    #[serde(rename = "self_signed_cert")]
    SelfSignedCert {
        #[serde(default)]
        subject: Option<String>,
    },
    /// Generate the private key for a self-signed TLS certificate.
    #[serde(rename = "self_signed_key")]
    SelfSignedKey,
}
