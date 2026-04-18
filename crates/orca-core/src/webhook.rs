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

/// Maximum accepted webhook body size. Anything larger is rejected before
/// JSON parsing to prevent memory exhaustion.
pub const MAX_WEBHOOK_BODY_BYTES: usize = 1_048_576; // 1 MiB

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

/// Require at least one of the supplied secrets to successfully validate the
/// signature. Returns `Ok(())` only when a valid signature was found. An
/// empty `secrets` slice always errors — webhook handlers must reject
/// unsigned payloads rather than silently accept them.
pub fn require_valid_signature(
    secrets: &[&str],
    body: &[u8],
    signature_header: Option<&str>,
) -> Result<(), &'static str> {
    if secrets.is_empty() {
        return Err("webhook rejected: no signing secret configured");
    }
    let sig = signature_header.ok_or("webhook rejected: missing X-Hub-Signature-256 header")?;
    for s in secrets {
        if !s.is_empty() && validate_github_signature(s, body, sig) {
            return Ok(());
        }
    }
    Err("webhook rejected: signature did not match any configured secret")
}

/// Validate a Docker Hub callback token. Docker Hub webhooks don't include
/// an HMAC signature, so the only mechanism is a shared secret in the URL
/// path or an `X-Orca-Webhook-Token` header. The comparison is constant-time.
pub fn validate_dockerhub_token(expected: &str, provided: Option<&str>) -> bool {
    let provided = match provided {
        Some(p) if !p.is_empty() => p,
        _ => return false,
    };
    if expected.is_empty() {
        return false;
    }
    use subtle::ConstantTimeEq;
    provided.as_bytes().ct_eq(expected.as_bytes()).into()
}

/// A single OCI image path segment (namespace or name). Must not contain
/// `/` — that would let a crafted payload produce an image reference like
/// `ghcr.io/evil/target/name` that matches unintended rules.
fn is_valid_image_segment(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 255
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
}

/// A Docker Hub `repo_name` — either a single segment (`nginx`) or exactly
/// two segments joined by `/` (`user/app`). No deep paths.
fn is_valid_dockerhub_repo(s: &str) -> bool {
    if s.is_empty() || s.len() > 512 {
        return false;
    }
    let parts: Vec<&str> = s.split('/').collect();
    if parts.len() > 2 {
        return false;
    }
    parts.iter().all(|p| is_valid_image_segment(p))
}

fn is_valid_tag(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '+'))
}

/// Parse a GitHub "package" or "registry_package" webhook event.
///
/// The registry host in the payload is **ignored** for security: GitHub only
/// publishes images on `ghcr.io`, and trusting an attacker-controlled
/// registry URL would let a valid-looking webhook redirect pulls anywhere.
pub fn parse_github_package_event(body: &[u8]) -> anyhow::Result<WebhookPayload> {
    if body.len() > MAX_WEBHOOK_BODY_BYTES {
        anyhow::bail!("webhook body too large: {} bytes", body.len());
    }
    let v: serde_json::Value = serde_json::from_slice(body)?;

    let action = v["action"].as_str().unwrap_or("").to_string();

    // GitHub package event format
    if let Some(pkg) = v.get("package") {
        let pkg_type = pkg["package_type"].as_str().unwrap_or("");
        if pkg_type != "container" {
            anyhow::bail!("Not a container package event (type: {pkg_type})");
        }

        let namespace = pkg["namespace"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("package.namespace missing"))?;
        let name = pkg["name"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("package.name missing"))?;

        if !is_valid_image_segment(namespace) || !is_valid_image_segment(name) {
            anyhow::bail!("invalid namespace/name in webhook payload");
        }

        // Extract tag from container metadata
        let tag = pkg["package_version"]["container_metadata"]["tag"]["name"]
            .as_str()
            .unwrap_or("latest")
            .to_string();

        if !is_valid_tag(&tag) {
            anyhow::bail!("invalid tag in webhook payload");
        }

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
            .ok_or_else(|| anyhow::anyhow!("registry_package.namespace missing"))?;
        let name = pkg["name"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("registry_package.name missing"))?;

        if !is_valid_image_segment(namespace) || !is_valid_image_segment(name) {
            anyhow::bail!("invalid namespace/name in webhook payload");
        }

        let tag = pkg["package_version"]["version"]
            .as_str()
            .unwrap_or("latest")
            .to_string();

        if !is_valid_tag(&tag) {
            anyhow::bail!("invalid tag in webhook payload");
        }

        // NOTE: we intentionally do NOT read pkg["registry"]["url"] from the
        // payload. GitHub only publishes to ghcr.io; trusting the payload
        // here would let a valid webhook redirect pulls to any registry.
        let image = format!("ghcr.io/{namespace}/{name}");

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
    if body.len() > MAX_WEBHOOK_BODY_BYTES {
        anyhow::bail!("webhook body too large: {} bytes", body.len());
    }
    let v: serde_json::Value = serde_json::from_slice(body)?;

    let tag = v["push_data"]["tag"].as_str().unwrap_or("latest").to_string();
    let repo = v["repository"]["repo_name"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing repository.repo_name"))?;

    if !is_valid_tag(&tag) {
        anyhow::bail!("invalid tag in webhook payload");
    }
    if !is_valid_dockerhub_repo(repo) {
        anyhow::bail!("invalid repo name in webhook payload");
    }

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
