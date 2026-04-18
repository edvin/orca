use orca_core::templates::AppTemplate;

/// Community catalog URL — hosted on GitHub Pages, updated via PRs.
const CATALOG_URL: &str = "https://orca-desktop.com/templates.json";

/// Cache duration: 1 hour.
const CACHE_MAX_AGE_SECS: u64 = 3600;

/// Max accepted community-template catalog body size (2 MiB). Anything
/// bigger is almost certainly an error or attack; we log and discard it.
const MAX_CATALOG_BYTES: usize = 2 * 1024 * 1024;

/// Path to cached community templates.
fn community_cache_path() -> std::path::PathBuf {
    let config_dir = dirs::config_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    config_dir.join("orca").join("community-templates.json")
}

/// Path to user-created templates.
fn user_templates_path() -> std::path::PathBuf {
    let config_dir = dirs::config_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    config_dir.join("orca").join("templates.json")
}

/// Delete the cache file to force a re-fetch on next request.
pub async fn invalidate_cache() {
    let _ = tokio::fs::remove_file(community_cache_path()).await;
}

/// Fetch community templates from the online catalog.
/// Cached locally for 1 hour. Falls back to cache if offline.
pub async fn fetch_community_templates() -> Vec<AppTemplate> {
    let cache_path = community_cache_path();

    // Check if cache is fresh enough
    let cache_fresh = match tokio::fs::metadata(&cache_path).await {
        Ok(m) => m
            .modified()
            .ok()
            .and_then(|t| t.elapsed().ok())
            .map(|age: std::time::Duration| age.as_secs() < CACHE_MAX_AGE_SECS)
            .unwrap_or(false),
        Err(_) => false,
    };

    if cache_fresh
        && let Ok(data) = tokio::fs::read_to_string(&cache_path).await
        && let Ok(templates) = serde_json::from_str::<Vec<AppTemplate>>(&data)
    {
        return templates;
    }

    // Cache is stale or missing — fetch from the web, streaming with a cap.
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    if let Ok(resp) = client.get(CATALOG_URL).send().await
        && resp.status().is_success()
    {
        use futures_util::StreamExt;
        let mut stream = resp.bytes_stream();
        let mut buf: Vec<u8> = Vec::new();
        let mut over_cap = false;
        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(bytes) => {
                    if buf.len() + bytes.len() > MAX_CATALOG_BYTES {
                        over_cap = true;
                        break;
                    }
                    buf.extend_from_slice(&bytes);
                }
                Err(e) => {
                    tracing::warn!("error streaming community template catalog: {e}");
                    break;
                }
            }
        }
        if over_cap {
            tracing::warn!(
                "community template catalog exceeded {} bytes; refusing to process",
                MAX_CATALOG_BYTES
            );
            return vec![];
        }
        if let Ok(body) = std::str::from_utf8(&buf)
            && let Ok(templates) = serde_json::from_str::<Vec<AppTemplate>>(body)
        {
            let _ = tokio::fs::write(&cache_path, body).await;
            return templates;
        }
    }

    // Fall back to stale cache
    if let Ok(data) = tokio::fs::read_to_string(&cache_path).await {
        return serde_json::from_str(&data).unwrap_or_default();
    }

    vec![]
}

/// Load user-defined templates from disk.
pub async fn load_user_templates() -> Vec<AppTemplate> {
    let path = user_templates_path();
    match tokio::fs::read_to_string(&path).await {
        Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
        Err(_) => vec![],
    }
}

/// Save user-defined templates to disk.
pub async fn save_user_templates(templates: &[AppTemplate]) -> anyhow::Result<()> {
    let path = user_templates_path();
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let data = serde_json::to_string_pretty(templates)?;
    tokio::fs::write(&path, data).await?;
    Ok(())
}

/// Generate a 32-character random alphanumeric token using the OS CSPRNG.
/// Used to fill in placeholder passwords for templated services, so this
/// must be cryptographically secure.
pub fn generate_token() -> String {
    use rand::Rng;
    use rand::distributions::Alphanumeric;
    rand::rngs::OsRng
        .sample_iter(&Alphanumeric)
        .take(32)
        .map(char::from)
        .collect()
}

/// Get all templates (community catalog + user-defined).
/// Community templates are loaded from the local cache (fetched async by the daemon).
/// Passwords containing "changeme" are replaced with generated tokens.
pub async fn all_templates() -> Vec<AppTemplate> {
    let mut templates = Vec::new();

    // Load cached community templates
    let cache_path = community_cache_path();
    if let Ok(data) = tokio::fs::read_to_string(&cache_path).await
        && let Ok(community) = serde_json::from_str::<Vec<AppTemplate>>(&data)
    {
        templates.extend(community);
    }

    // Add user templates (skip duplicates by id)
    for t in load_user_templates().await {
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
