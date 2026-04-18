use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageSearchResult {
    pub name: String,
    pub description: String,
    pub stars: u64,
    pub official: bool,
    pub pulls: Option<String>,
}

/// Shared reqwest client with a 15s timeout. Without a timeout a slow or
/// hung Docker Hub search would block the request forever and accumulate
/// connections on every retry.
fn hub_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .expect("reqwest client build")
    })
}

pub async fn search_docker_hub(query: &str, limit: u32) -> anyhow::Result<Vec<ImageSearchResult>> {
    // Clamp limit to a sane upper bound. Docker Hub rejects large page_size
    // values and an attacker-chosen 10M would hammer upstream for no reason.
    let limit = limit.min(100);

    let url = format!(
        "https://hub.docker.com/v2/search/repositories/?query={}&page_size={}",
        urlencoding::encode(query),
        limit
    );

    // Cap response body to 2 MiB to avoid unbounded memory growth if
    // upstream (or a hijacked endpoint) serves a huge response.
    const MAX_BYTES: usize = 2 * 1024 * 1024;
    let response = hub_client().get(&url).send().await?;
    let mut stream = response.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        let bytes = chunk?;
        if buf.len() + bytes.len() > MAX_BYTES {
            anyhow::bail!("Docker Hub response exceeded {} bytes", MAX_BYTES);
        }
        buf.extend_from_slice(&bytes);
    }
    let resp: serde_json::Value = serde_json::from_slice(&buf)?;

    let results = resp
        .get("results")
        .and_then(|r| r.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    Some(ImageSearchResult {
                        name: item.get("repo_name")?.as_str()?.to_string(),
                        description: item
                            .get("short_description")
                            .and_then(|d| d.as_str())
                            .unwrap_or("")
                            .to_string(),
                        stars: item.get("star_count").and_then(|s| s.as_u64()).unwrap_or(0),
                        official: item.get("is_official").and_then(|o| o.as_bool()).unwrap_or(false),
                        pulls: item.get("pull_count").and_then(|p| p.as_u64()).map(format_pulls),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(results)
}

fn format_pulls(count: u64) -> String {
    if count >= 1_000_000_000 {
        format!("{}B+", count / 1_000_000_000)
    } else if count >= 1_000_000 {
        format!("{}M+", count / 1_000_000)
    } else if count >= 1_000 {
        format!("{}K+", count / 1_000)
    } else {
        count.to_string()
    }
}
