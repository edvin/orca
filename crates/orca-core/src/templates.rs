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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_setup_step_type_defaults_to_info() {
        let json = r#"{"title":"test","description":"desc"}"#;
        let step: SetupStep = serde_json::from_str(json).unwrap();
        assert_eq!(step.step_type, "info");
        assert!(step.url.is_none());
        assert!(step.action.is_none());
    }

    #[test]
    fn test_setup_step_link_type() {
        let json = r#"{"title":"Open","description":"desc","type":"link","url":"http://localhost:8080"}"#;
        let step: SetupStep = serde_json::from_str(json).unwrap();
        assert_eq!(step.step_type, "link");
        assert_eq!(step.url.unwrap(), "http://localhost:8080");
    }

    #[test]
    fn test_setup_step_action_type() {
        let json =
            r#"{"title":"Restart","description":"desc","type":"action","action":"restart_service","service":"web"}"#;
        let step: SetupStep = serde_json::from_str(json).unwrap();
        assert_eq!(step.step_type, "action");
        assert_eq!(step.action.unwrap(), "restart_service");
        assert_eq!(step.service.unwrap(), "web");
    }

    #[test]
    fn test_setup_step_exec_with_command() {
        let json = r#"{"title":"Run","description":"desc","type":"action","action":"exec","command":["sh","-c","echo hello"]}"#;
        let step: SetupStep = serde_json::from_str(json).unwrap();
        let cmd = step.command.unwrap();
        assert_eq!(cmd, vec!["sh", "-c", "echo hello"]);
    }

    #[test]
    fn test_setup_step_set_env_type() {
        let json = r#"{"title":"API Key","description":"Enter key","type":"set_env","env_key":"API_KEY","label":"Your API key"}"#;
        let step: SetupStep = serde_json::from_str(json).unwrap();
        assert_eq!(step.step_type, "set_env");
        assert_eq!(step.env_key.unwrap(), "API_KEY");
        assert_eq!(step.label.unwrap(), "Your API key");
    }

    #[test]
    fn test_gateway_route_template_basic() {
        let json = r#"{"hostname":"app","service":"frontend","port":3000}"#;
        let route: GatewayRouteTemplate = serde_json::from_str(json).unwrap();
        assert_eq!(route.hostname, "app");
        assert_eq!(route.service, "frontend");
        assert_eq!(route.port, 3000);
        assert!(route.path.is_none());
    }

    #[test]
    fn test_gateway_route_template_with_path() {
        let json = r#"{"hostname":"app","service":"frontend","port":3000,"path":"/api/*"}"#;
        let route: GatewayRouteTemplate = serde_json::from_str(json).unwrap();
        assert_eq!(route.path.unwrap(), "/api/*");
    }

    #[test]
    fn test_gateway_route_template_without_path_omits_field() {
        let route = GatewayRouteTemplate {
            hostname: "app".to_string(),
            service: "frontend".to_string(),
            port: 3000,
            path: None,
        };
        let json = serde_json::to_string(&route).unwrap();
        assert!(!json.contains("path"), "path should be omitted when None");
    }

    #[test]
    fn test_setup_guide_serialization_roundtrip() {
        let guide = SetupGuide {
            title: "Getting Started".to_string(),
            steps: vec![
                SetupStep {
                    title: "Step 1".to_string(),
                    description: "Do something".to_string(),
                    step_type: "info".to_string(),
                    url: None,
                    action: None,
                    service: None,
                    command: None,
                    env_key: None,
                    label: None,
                },
                SetupStep {
                    title: "Step 2".to_string(),
                    description: "Open browser".to_string(),
                    step_type: "link".to_string(),
                    url: Some("http://localhost:8080".to_string()),
                    action: None,
                    service: None,
                    command: None,
                    env_key: None,
                    label: None,
                },
            ],
        };
        let json = serde_json::to_string(&guide).unwrap();
        let restored: SetupGuide = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.title, "Getting Started");
        assert_eq!(restored.steps.len(), 2);
        assert_eq!(restored.steps[0].step_type, "info");
        assert_eq!(restored.steps[1].step_type, "link");
        assert_eq!(restored.steps[1].url.as_deref(), Some("http://localhost:8080"));
    }

    #[test]
    fn test_generated_value_random_hex() {
        let json = r#"{"type":"random_hex","length":32}"#;
        let val: GeneratedValue = serde_json::from_str(json).unwrap();
        assert!(matches!(val, GeneratedValue::RandomHex { length: Some(32) }));
    }

    #[test]
    fn test_generated_value_user_input() {
        let json = r#"{"type":"user_input","label":"API Key","placeholder":"sk-...","required":true,"secret":true}"#;
        let val: GeneratedValue = serde_json::from_str(json).unwrap();
        match val {
            GeneratedValue::UserInput {
                label,
                placeholder,
                required,
                secret,
            } => {
                assert_eq!(label, "API Key");
                assert_eq!(placeholder.unwrap(), "sk-...");
                assert!(required);
                assert!(secret);
            }
            _ => panic!("Expected UserInput variant"),
        }
    }

    #[test]
    fn test_generated_value_lan_ip() {
        let json = r#"{"type":"lan_ip"}"#;
        let val: GeneratedValue = serde_json::from_str(json).unwrap();
        assert!(matches!(val, GeneratedValue::LanIp));
    }

    #[test]
    fn test_app_template_minimal_deserialization() {
        let json = r#"{
            "id": "test-app",
            "name": "Test App",
            "description": "A test application",
            "icon": "<svg></svg>",
            "category": "Development",
            "image": "test:latest",
            "default_ports": ["8080:8080"],
            "default_env": ["FOO=bar"],
            "default_volumes": [],
            "restart_policy": "unless-stopped",
            "notes": "Test notes"
        }"#;
        let template: AppTemplate = serde_json::from_str(json).unwrap();
        assert_eq!(template.id, "test-app");
        assert_eq!(template.name, "Test App");
        assert_eq!(template.category, "Development");
        assert!(!template.is_builtin);
        assert!(template.compose_yaml.is_none());
        assert!(template.setup_guide.is_none());
        assert!(template.gateway_routes.is_none());
        assert!(template.links.is_none());
    }

    #[test]
    fn test_app_template_with_gateway_routes() {
        let json = r#"{
            "id": "test-app",
            "name": "Test App",
            "description": "desc",
            "icon": "",
            "category": "Web",
            "image": "",
            "default_ports": [],
            "default_env": [],
            "default_volumes": [],
            "restart_policy": "always",
            "notes": "",
            "gateway_routes": [
                {"hostname": "app", "service": "frontend", "port": 3000},
                {"hostname": "app", "service": "backend", "port": 8080, "path": "/api/*"}
            ]
        }"#;
        let template: AppTemplate = serde_json::from_str(json).unwrap();
        let routes = template.gateway_routes.unwrap();
        assert_eq!(routes.len(), 2);
        assert_eq!(routes[0].service, "frontend");
        assert!(routes[0].path.is_none());
        assert_eq!(routes[1].path.as_deref(), Some("/api/*"));
    }

    #[test]
    fn test_templates_json_is_valid() {
        let content = include_str!("../../../docs/templates.json");
        let templates: Vec<AppTemplate> = serde_json::from_str(content).unwrap();
        assert!(
            templates.len() > 10,
            "Expected at least 10 templates, got {}",
            templates.len()
        );

        // Every template should have a non-empty id and name
        for t in &templates {
            assert!(!t.id.is_empty(), "Template id should not be empty");
            assert!(!t.name.is_empty(), "Template name should not be empty for id={}", t.id);
        }

        // Templates with compose_yaml should have non-empty content
        for t in &templates {
            if let Some(ref yaml) = t.compose_yaml {
                assert!(!yaml.is_empty(), "Template {} has empty compose_yaml", t.id);
            }
        }
    }

    #[test]
    fn test_template_link_group_deserialization() {
        let json = r#"{
            "group": "Frontend",
            "links": [
                {
                    "name": "Web App",
                    "urls": {"local": "webapp", "staging": "https://staging.example.com"}
                }
            ]
        }"#;
        let group: TemplateLinkGroup = serde_json::from_str(json).unwrap();
        assert_eq!(group.group, "Frontend");
        assert_eq!(group.links.len(), 1);
        assert_eq!(group.links[0].name, "Web App");
        assert_eq!(group.links[0].urls["local"], "webapp");
    }
}
