use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageSearchResult {
    pub name: String,
    pub description: String,
    pub stars: u64,
    pub official: bool,
    pub pulls: Option<String>,
}

pub async fn search_docker_hub(
    query: &str,
    limit: u32,
) -> anyhow::Result<Vec<ImageSearchResult>> {
    let url = format!(
        "https://hub.docker.com/v2/search/repositories/?query={}&page_size={}",
        urlencoding::encode(query),
        limit
    );

    let resp = reqwest::Client::new()
        .get(&url)
        .send()
        .await?
        .json::<serde_json::Value>()
        .await?;

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
                        stars: item
                            .get("star_count")
                            .and_then(|s| s.as_u64())
                            .unwrap_or(0),
                        official: item
                            .get("is_official")
                            .and_then(|o| o.as_bool())
                            .unwrap_or(false),
                        pulls: item
                            .get("pull_count")
                            .and_then(|p| p.as_u64())
                            .map(format_pulls),
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
