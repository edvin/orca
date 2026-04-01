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
    /// Optional post-deploy setup guide shown to the user after deployment.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup_guide: Option<SetupGuide>,
    /// Gateway routes to auto-register when deploying this template.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gateway_routes: Option<Vec<GatewayRouteTemplate>>,
    /// Environment links to register when deploying this template.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub links: Option<Vec<TemplateLinkGroup>>,
}

/// A group of environment links declared in a template.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplateLinkGroup {
    pub group: String,
    pub links: Vec<crate::config::EnvironmentLink>,
}

/// A gateway route declared in a template or orca.yaml.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewayRouteTemplate {
    pub hostname: String,
    pub service: String,
    pub port: u16,
}

/// A post-deploy setup guide with step-by-step instructions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetupGuide {
    pub title: String,
    pub steps: Vec<SetupStep>,
}

/// A single step in a setup guide.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetupStep {
    pub title: String,
    pub description: String,
    /// Step type: "info" (default), "link", "action", "set_env"
    #[serde(rename = "type", default = "default_step_type")]
    pub step_type: String,
    /// URL to open in system browser (for "link" type).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Action to execute (for "action" type): "view_logs", "restart_service", "exec"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    /// Service name within the compose stack (for service-specific actions).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service: Option<String>,
    /// Command to run inside the container (for "exec" action).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<Vec<String>>,
    /// Environment variable key (for "set_env" type).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env_key: Option<String>,
    /// Display label for input fields.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

fn default_step_type() -> String {
    "info".to_string()
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
