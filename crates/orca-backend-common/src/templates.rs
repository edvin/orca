use orca_core::templates::AppTemplate;

/// Community catalog URL — hosted on GitHub Pages, updated via PRs.
const CATALOG_URL: &str = "https://orca-desktop.com/templates.json";

/// Cache duration: 1 hour.
const CACHE_MAX_AGE_SECS: u64 = 3600;

/// Path to cached community templates.
fn community_cache_path() -> std::path::PathBuf {
    let config_dir = dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    config_dir.join("orca").join("community-templates.json")
}

/// Path to user-created templates.
fn user_templates_path() -> std::path::PathBuf {
    let config_dir = dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    config_dir.join("orca").join("templates.json")
}

/// Fetch community templates from the online catalog.
/// Cached locally for 1 hour. Falls back to cache if offline.
pub async fn fetch_community_templates() -> Vec<AppTemplate> {
    let cache_path = community_cache_path();

    // Check if cache is fresh enough
    let cache_fresh = cache_path.exists() && cache_path.metadata()
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.elapsed().ok())
        .map(|age: std::time::Duration| age.as_secs() < CACHE_MAX_AGE_SECS)
        .unwrap_or(false);

    if cache_fresh {
        if let Ok(data) = std::fs::read_to_string(&cache_path) {
            if let Ok(templates) = serde_json::from_str::<Vec<AppTemplate>>(&data) {
                return templates;
            }
        }
    }

    // Cache is stale or missing — fetch from the web
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    match client.get(CATALOG_URL).send().await {
        Ok(resp) if resp.status().is_success() => {
            if let Ok(body) = resp.text().await {
                if let Ok(templates) = serde_json::from_str::<Vec<AppTemplate>>(&body) {
                    let _ = std::fs::write(&cache_path, &body);
                    return templates;
                }
            }
        }
        _ => {}
    }

    // Fall back to stale cache
    if cache_path.exists() {
        if let Ok(data) = std::fs::read_to_string(&cache_path) {
            return serde_json::from_str(&data).unwrap_or_default();
        }
    }

    vec![]
}

/// Load user-defined templates from disk.
pub fn load_user_templates() -> Vec<AppTemplate> {
    let path = user_templates_path();
    if !path.exists() {
        return vec![];
    }
    match std::fs::read_to_string(&path) {
        Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
        Err(_) => vec![],
    }
}

/// Save user-defined templates to disk.
pub fn save_user_templates(templates: &[AppTemplate]) -> anyhow::Result<()> {
    let path = user_templates_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let data = serde_json::to_string_pretty(templates)?;
    std::fs::write(&path, data)?;
    Ok(())
}

/// Generate a random alphanumeric token for services that need one.
pub fn generate_token() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let mut state = seed as u64 | 1;
    let chars: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    (0..32)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            chars[(state as usize) % chars.len()] as char
        })
        .collect()
}

/// Get all templates (community catalog + user-defined).
/// Community templates are loaded from the local cache (fetched async by the daemon).
/// Passwords containing "changeme" are replaced with generated tokens.
pub fn all_templates() -> Vec<AppTemplate> {
    let mut templates = Vec::new();

    // Load cached community templates
    let cache_path = community_cache_path();
    if cache_path.exists() {
        if let Ok(data) = std::fs::read_to_string(&cache_path) {
            if let Ok(community) = serde_json::from_str::<Vec<AppTemplate>>(&data) {
                templates.extend(community);
            }
        }
    }

    // Add user templates (skip duplicates by id)
    for t in load_user_templates() {
        if !templates.iter().any(|existing| existing.id == t.id) {
            templates.push(t);
        }
    }

    // Replace placeholder passwords with generated ones
    for t in &mut templates {
        let pw = generate_token();
        let short_pw = &pw[..16];
        for env in &mut t.default_env {
            if env.contains("changeme") {
                *env = env.replace("changeme", short_pw);
            }
        }
        t.notes = t.notes.replace("changeme", short_pw);
    }

    templates
}
