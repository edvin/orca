//! HTTP client for talking to the Orca daemon.

use serde::Deserialize;

pub struct DaemonClient {
    base_url: String,
    http: reqwest::Client,
}

#[derive(Debug, Deserialize)]
pub struct HealthResponse {
    pub status: String,
    pub version: String,
}

impl DaemonClient {
    pub fn new(base_url: &str) -> Self {
        Self {
            base_url: base_url.to_string(),
            http: reqwest::Client::new(),
        }
    }

    pub async fn health(&self) -> anyhow::Result<HealthResponse> {
        let resp = self
            .http
            .get(format!("{}/api/v1/health", self.base_url))
            .send()
            .await?
            .json()
            .await?;
        Ok(resp)
    }
}
