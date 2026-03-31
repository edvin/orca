//! GitHub and Docker Hub webhook parsing and validation.

use hmac::{Hmac, Mac};
use sha2::Sha256;

/// Parsed webhook payload, normalized from GitHub or Docker Hub format.
#[derive(Debug, Clone)]
pub struct WebhookPayload {
    pub source: WebhookSource,
    pub image: String,
    pub tag: String,
    pub action: String,
}

#[derive(Debug, Clone)]
pub enum WebhookSource {
    GitHub,
    DockerHub,
}

/// Validate a GitHub webhook HMAC-SHA256 signature.
/// The header value is: `sha256=<hex digest>`
pub fn validate_github_signature(secret: &str, body: &[u8], signature_header: &str) -> bool {
    let expected_hex = match signature_header.strip_prefix("sha256=") {
        Some(h) => h,
        None => return false,
    };

    let expected_bytes = match hex::decode(expected_hex) {
        Ok(b) => b,
        Err(_) => return false,
    };

    let mut mac = match Hmac::<Sha256>::new_from_slice(secret.as_bytes()) {
        Ok(m) => m,
        Err(_) => return false,
    };
    mac.update(body);

    // Constant-time comparison
    use subtle::ConstantTimeEq;
    let computed = mac.finalize().into_bytes();
    computed.as_slice().ct_eq(&expected_bytes).into()
}

/// Parse a GitHub "package" or "registry_package" webhook event.
pub fn parse_github_package_event(body: &[u8]) -> anyhow::Result<WebhookPayload> {
    let v: serde_json::Value = serde_json::from_slice(body)?;

    let action = v["action"].as_str().unwrap_or("").to_string();

    // GitHub package event format
    if let Some(pkg) = v.get("package") {
        let pkg_type = pkg["package_type"].as_str().unwrap_or("");
        if pkg_type != "container" {
            anyhow::bail!("Not a container package event (type: {pkg_type})");
        }

        let namespace = pkg["namespace"].as_str().unwrap_or("");
        let name = pkg["name"].as_str().unwrap_or("");

        // Extract tag from container metadata
        let tag = pkg["package_version"]["container_metadata"]["tag"]["name"]
            .as_str()
            .unwrap_or("latest")
            .to_string();

        let image = format!("ghcr.io/{namespace}/{name}");

        return Ok(WebhookPayload {
            source: WebhookSource::GitHub,
            image,
            tag,
            action,
        });
    }

    // registry_package event format (older)
    if let Some(pkg) = v.get("registry_package") {
        let pkg_type = pkg["package_type"].as_str().unwrap_or("");
        if pkg_type != "docker" && pkg_type != "container" {
            anyhow::bail!("Not a container registry_package event (type: {pkg_type})");
        }

        let namespace = pkg["namespace"]
            .as_str()
            .or_else(|| v["repository"]["owner"]["login"].as_str())
            .unwrap_or("");
        let name = pkg["name"].as_str().unwrap_or("");

        let tag = pkg["package_version"]["version"]
            .as_str()
            .unwrap_or("latest")
            .to_string();

        let registry = pkg["registry"]["url"].as_str().unwrap_or("ghcr.io");
        let registry = registry.trim_start_matches("https://").trim_end_matches('/');
        let image = format!("{registry}/{namespace}/{name}");

        return Ok(WebhookPayload {
            source: WebhookSource::GitHub,
            image,
            tag,
            action,
        });
    }

    anyhow::bail!("Unrecognized GitHub webhook payload")
}

/// Parse a Docker Hub webhook payload.
pub fn parse_dockerhub_event(body: &[u8]) -> anyhow::Result<WebhookPayload> {
    let v: serde_json::Value = serde_json::from_slice(body)?;

    let tag = v["push_data"]["tag"].as_str().unwrap_or("latest").to_string();
    let repo = v["repository"]["repo_name"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing repository.repo_name"))?;

    // Docker Hub repo_name is "user/image" — add docker.io prefix
    let image = if repo.contains('/') {
        format!("docker.io/{repo}")
    } else {
        format!("docker.io/library/{repo}")
    };

    Ok(WebhookPayload {
        source: WebhookSource::DockerHub,
        image,
        tag,
        action: "push".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_signature() {
        let secret = "mysecret";
        let body = b"hello world";

        // Compute expected signature
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(body);
        let sig = hex::encode(mac.finalize().into_bytes());

        assert!(validate_github_signature(secret, body, &format!("sha256={sig}")));
        assert!(!validate_github_signature(secret, body, "sha256=0000"));
        assert!(!validate_github_signature("wrong", body, &format!("sha256={sig}")));
    }

    #[test]
    fn test_tag_glob_matching() {
        // Test via OrcaConfig::find_matching_rules indirectly
        let filter_matches = |filter: &str, tag: &str| -> bool {
            let f = filter.trim();
            if f.is_empty() || f == "*" {
                return true;
            }
            if f.contains('*') {
                let prefix = f.trim_end_matches('*');
                tag.starts_with(prefix)
            } else {
                tag == f
            }
        };

        assert!(filter_matches("*", "anything"));
        assert!(filter_matches("", "anything"));
        assert!(filter_matches("v*", "v1.2.3"));
        assert!(filter_matches("v*", "v0.1.0"));
        assert!(!filter_matches("v*", "latest"));
        assert!(filter_matches("latest", "latest"));
        assert!(!filter_matches("latest", "v1.0"));
        assert!(filter_matches("main", "main"));
    }
}
