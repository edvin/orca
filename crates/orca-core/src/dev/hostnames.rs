//! Instance hostnames: the two built-in patterns, rendering a pattern into
//! a valid hostname, and checking hostnames against a certificate.
//!
//! The default pattern is flat (`web-feat-x-shop.localhost`): every hostname
//! is one label below the gateway domain, so a single wildcard certificate
//! (`*.local.example.dev`) covers all of them. The nested pattern
//! (`web.feat-x.shop.localhost`) gives each instance its own parent domain,
//! which apps that share cookies between services need.

use std::collections::BTreeMap;
use std::path::Path;

use super::naming;
use super::schema::render_template;

/// `web-feat-x-shop.localhost`: works with wildcard certificates.
pub const FLAT: &str = "{service}-{instance}-{project}.{domain}";
/// `web.feat-x.shop.localhost`: one cookie scope per instance.
pub const NESTED: &str = "{service}.{instance}.{project}.{domain}";

const MAX_LABEL: usize = 63;
const MAX_NAME: usize = 253;

/// Which built-in pattern a template is, if any.
pub fn style_of(template: &str) -> &'static str {
    match template.trim() {
        FLAT => "flat",
        NESTED => "nested",
        _ => "custom",
    }
}

/// Render `template` for one service of one instance.
///
/// Service names are slugified (compose allows `my_service`, DNS doesn't).
/// When a label comes out longer than 63 characters the instance part is
/// shortened first, keeping a hash of the full name so it stays unique;
/// any label still too long is shortened the same way.
pub fn render(
    template: &str,
    project: &str,
    instance: &str,
    service: &str,
    domain: &str,
    worktree: &Path,
) -> anyhow::Result<String> {
    let service = naming::slugify(service).unwrap_or_else(|| service.to_string());
    let vars = |instance: &str| {
        let mut v = BTreeMap::new();
        v.insert("project".to_string(), project.to_string());
        v.insert("instance".to_string(), instance.to_string());
        v.insert("service".to_string(), service.clone());
        v.insert("domain".to_string(), domain.to_string());
        v.insert("worktree".to_string(), worktree.to_string_lossy().to_string());
        v
    };
    let full = render_template(template, &vars(instance))?;
    let over = longest_label(&full).saturating_sub(MAX_LABEL);
    let h = if over == 0 || !template.contains("{instance}") {
        full
    } else {
        // Shorten the instance just enough, plus room for "-<hash>".
        let keep = instance.len().saturating_sub(over + 7);
        let short = if keep == 0 {
            hash(instance)
        } else {
            format!("{}-{}", instance[..keep].trim_end_matches('-'), hash(instance))
        };
        render_template(template, &vars(&short))?
    };
    let h = h
        .split('.')
        .map(|l| {
            if l.len() <= MAX_LABEL {
                l.to_string()
            } else {
                format!("{}-{}", l[..MAX_LABEL - 7].trim_end_matches('-'), hash(l))
            }
        })
        .collect::<Vec<_>>()
        .join(".");
    validate(&h)?;
    Ok(h)
}

fn longest_label(h: &str) -> usize {
    h.split('.').map(str::len).max().unwrap_or(0)
}

/// A hostname a user typed or a pattern produced.
pub fn validate(h: &str) -> anyhow::Result<()> {
    let ok = !h.is_empty()
        && h.len() <= MAX_NAME
        && h.split('.').all(|l| {
            !l.is_empty()
                && l.len() <= MAX_LABEL
                && !l.starts_with('-')
                && !l.ends_with('-')
                && l.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        });
    if ok {
        Ok(())
    } else {
        anyhow::bail!("'{h}' is not a valid hostname (lowercase letters, digits, '-' and '.')")
    }
}

/// Problems with a pattern that don't make it invalid but will bite: names
/// that collide between instances or services.
pub fn pattern_warnings(template: &str) -> Vec<String> {
    let mut out = Vec::new();
    if !template.contains("{instance}") {
        out.push(
            "The hostname pattern has no {instance}, so every worktree gets the same hostnames and only one can be reached at a time."
                .to_string(),
        );
    }
    if !template.contains("{service}") {
        out.push(
            "The hostname pattern has no {service}, so services with a URL share one hostname; use expose paths to split them."
                .to_string(),
        );
    }
    out
}

/// Whether a certificate for `names` (as listed in its subject alternative
/// names) is valid for `host`. Wildcards match exactly one label.
pub fn cert_covers(names: &[String], host: &str) -> bool {
    names.iter().any(|n| {
        let n = n.to_ascii_lowercase();
        match n.strip_prefix("*.") {
            Some(base) => host
                .split_once('.')
                .is_some_and(|(first, rest)| !first.is_empty() && rest == base),
            None => n == host,
        }
    })
}

/// Env var names that set a cookie domain. Apps that use one share cookies
/// between services, which only stays per-instance with nested hostnames.
pub fn is_cookie_domain_var(name: &str) -> bool {
    let n = name.to_ascii_uppercase();
    n.contains("COOKIE_DOMAIN") || n == "SESSION_DOMAIN" || n.ends_with("_SESSION_DOMAIN")
}

/// 6 hex characters of FNV-1a.
fn hash(s: &str) -> String {
    let mut h: u32 = 0x811c9dc5;
    for b in s.bytes() {
        h ^= u32::from(b);
        h = h.wrapping_mul(0x01000193);
    }
    format!("{:06x}", h & 0xff_ffff)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(t: &str, inst: &str, svc: &str) -> String {
        render(t, "shop", inst, svc, "localhost", Path::new("/w")).unwrap()
    }

    #[test]
    fn flat_and_nested() {
        assert_eq!(r(FLAT, "feat-x", "web"), "web-feat-x-shop.localhost");
        assert_eq!(r(NESTED, "feat-x", "web"), "web.feat-x.shop.localhost");
        assert_eq!(style_of(FLAT), "flat");
        assert_eq!(style_of(" {service}.{instance}.{project}.{domain} "), "nested");
        assert_eq!(style_of("{service}.x"), "custom");
    }

    #[test]
    fn service_names_become_dns_safe() {
        assert_eq!(r(FLAT, "a", "my_service"), "my-service-a-shop.localhost");
    }

    #[test]
    fn long_names_shorten_the_instance_and_stay_unique() {
        let a = "claude-refactor-the-billing-module-into-a";
        let b = "claude-refactor-the-billing-module-into-b";
        let ha = r(FLAT, a, "frontend-web");
        let hb = r(FLAT, b, "frontend-web");
        assert_ne!(ha, hb);
        let label = ha.split('.').next().unwrap();
        assert!(label.len() <= 63, "{ha}");
        assert!(label.starts_with("frontend-web-claude-refactor"), "{ha}");
        assert!(label.ends_with("-shop"), "{ha}");
        // Nested keeps each label short enough on its own.
        assert_eq!(r(NESTED, a, "web"), format!("web.{a}.shop.localhost"));
    }

    #[test]
    fn labels_without_the_instance_are_shortened_too() {
        let svc = "s".repeat(70);
        let h = r("{service}.{instance}.{domain}", "a", &svc);
        assert!(h.split('.').all(|l| l.len() <= 63), "{h}");
    }

    #[test]
    fn pattern_warnings_catch_collisions() {
        assert!(pattern_warnings(FLAT).is_empty());
        assert_eq!(pattern_warnings("{service}.{project}.{domain}").len(), 1);
        assert_eq!(pattern_warnings("app.{domain}").len(), 2);
    }

    #[test]
    fn wildcards_cover_one_label() {
        let names = vec!["*.local.acme.dev".to_string(), "local.acme.dev".to_string()];
        assert!(cert_covers(&names, "web-feat-shop.local.acme.dev"));
        assert!(cert_covers(&names, "local.acme.dev"));
        assert!(!cert_covers(&names, "web.feat.shop.local.acme.dev"));
        assert!(!cert_covers(&names, "other.dev"));
    }

    #[test]
    fn cookie_domain_vars() {
        for v in [
            "COOKIE_DOMAIN",
            "SESSION_COOKIE_DOMAIN",
            "session_domain",
            "APP_SESSION_DOMAIN",
        ] {
            assert!(is_cookie_domain_var(v), "{v}");
        }
        assert!(!is_cookie_domain_var("DOMAIN"));
        assert!(!is_cookie_domain_var("SESSION_DRIVER"));
    }
}
