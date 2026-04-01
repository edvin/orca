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

#[derive(Debug, Deserialize)]
pub struct Container {
    pub id: String,
    pub name: String,
    pub image: String,
    pub state: String,
    pub ports: Vec<PortMapping>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct PortMapping {
    pub host_port: u16,
    pub container_port: u16,
    pub protocol: String,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct Image {
    pub id: String,
    pub repo_tags: Vec<String>,
    pub size_bytes: u64,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
pub struct PruneResult {
    pub images_deleted: Vec<String>,
    pub space_reclaimed: u64,
}

#[derive(Debug, Deserialize)]
pub struct ComposeProject {
    pub name: String,
    pub status: String,
    pub services: Vec<ComposeService>,
    pub working_dir: Option<String>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct ComposeService {
    pub name: String,
    pub container_name: String,
    pub image: String,
    pub state: String,
}

#[derive(Debug, Deserialize)]
pub struct ClusterStatus {
    pub enabled: bool,
    pub running: bool,
    #[serde(default)]
    #[allow(dead_code)]
    pub installed: bool,
    pub version: Option<String>,
    pub node_name: Option<String>,
    pub node_status: Option<String>,
    pub pods_running: u32,
    pub pods_total: u32,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct MachineInfo {
    pub name: String,
    pub state: String,
    pub config: MachineConfig,
    pub backend: String,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct MachineConfig {
    pub name: String,
    pub cpus: u32,
    pub memory_mb: u64,
    pub disk_gb: u64,
    pub runtime: String,
}

#[derive(Debug, Deserialize)]
pub struct ExecResult {
    pub exit_code: i32,
    pub output: String,
}

impl DaemonClient {
    /// Create a new client. If `token` is provided it will be used for auth;
    /// otherwise the token is read from the Orca config file.
    pub fn new(base_url: &str, token: Option<String>) -> Self {
        let token = token.or_else(|| orca_core::config::OrcaConfig::load().ok().and_then(|c| c.api_token));

        let mut headers = reqwest::header::HeaderMap::new();
        if let Some(t) = token
            && let Ok(val) = reqwest::header::HeaderValue::from_str(&format!("Bearer {t}"))
        {
            headers.insert(reqwest::header::AUTHORIZATION, val);
        }

        let http = reqwest::Client::builder()
            .default_headers(headers)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());

        Self {
            base_url: base_url.to_string(),
            http,
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}/api/v1{}", self.base_url, path)
    }

    // --- Health ---

    pub async fn health(&self) -> anyhow::Result<HealthResponse> {
        let resp = self.http.get(self.url("/health")).send().await?;
        check_status(&resp)?;
        Ok(resp.json().await?)
    }

    // --- Containers ---

    pub async fn list_containers(&self) -> anyhow::Result<Vec<Container>> {
        let resp = self.http.get(self.url("/containers")).send().await?;
        check_status(&resp)?;
        Ok(resp.json().await?)
    }

    pub async fn start_container(&self, id: &str) -> anyhow::Result<()> {
        let resp = self
            .http
            .post(self.url(&format!("/containers/{id}/start")))
            .send()
            .await?;
        check_status(&resp)?;
        Ok(())
    }

    pub async fn stop_container(&self, id: &str) -> anyhow::Result<()> {
        let resp = self
            .http
            .post(self.url(&format!("/containers/{id}/stop")))
            .send()
            .await?;
        check_status(&resp)?;
        Ok(())
    }

    #[allow(dead_code)]
    pub async fn remove_container(&self, id: &str) -> anyhow::Result<()> {
        let resp = self.http.delete(self.url(&format!("/containers/{id}"))).send().await?;
        check_status(&resp)?;
        Ok(())
    }

    pub async fn container_logs(&self, id: &str, tail: Option<u32>) -> anyhow::Result<Vec<String>> {
        let mut url = format!("{}/api/v1/containers/{id}/logs?follow=false", self.base_url);
        if let Some(n) = tail {
            url.push_str(&format!("&tail={n}"));
        }
        let resp = self.http.get(&url).send().await?;
        check_status(&resp)?;
        // The logs endpoint is SSE — read the body as text and extract data lines.
        let body = resp.text().await?;
        let lines: Vec<String> = body
            .lines()
            .filter_map(|line| line.strip_prefix("data:"))
            .map(|s| s.to_string())
            .collect();
        Ok(lines)
    }

    pub async fn exec_container(&self, id: &str, command: Vec<String>) -> anyhow::Result<ExecResult> {
        let resp = self
            .http
            .post(self.url(&format!("/containers/{id}/exec")))
            .json(&serde_json::json!({ "command": command }))
            .send()
            .await?;
        check_status(&resp)?;
        Ok(resp.json().await?)
    }

    // --- Images ---

    pub async fn list_images(&self) -> anyhow::Result<Vec<Image>> {
        let resp = self.http.get(self.url("/images")).send().await?;
        check_status(&resp)?;
        Ok(resp.json().await?)
    }

    pub async fn pull_image(&self, reference: &str) -> anyhow::Result<String> {
        let resp = self
            .http
            .post(self.url("/images/pull"))
            .json(&serde_json::json!({ "reference": reference }))
            .send()
            .await?;
        check_status(&resp)?;
        // SSE stream — collect all progress lines and return final body
        Ok(resp.text().await?)
    }

    pub async fn remove_image(&self, id: &str) -> anyhow::Result<()> {
        let resp = self.http.delete(self.url(&format!("/images/{id}"))).send().await?;
        check_status(&resp)?;
        Ok(())
    }

    pub async fn prune_images(&self) -> anyhow::Result<PruneResult> {
        let resp = self.http.post(self.url("/images/prune")).send().await?;
        check_status(&resp)?;
        Ok(resp.json().await?)
    }

    // --- Stacks ---

    pub async fn list_stacks(&self) -> anyhow::Result<Vec<ComposeProject>> {
        let resp = self.http.get(self.url("/stacks")).send().await?;
        check_status(&resp)?;
        Ok(resp.json().await?)
    }

    pub async fn stack_up(&self, name: &str) -> anyhow::Result<()> {
        let resp = self.http.post(self.url(&format!("/stacks/{name}/up"))).send().await?;
        check_status(&resp)?;
        Ok(())
    }

    pub async fn stack_down(&self, name: &str) -> anyhow::Result<()> {
        let resp = self.http.post(self.url(&format!("/stacks/{name}/down"))).send().await?;
        check_status(&resp)?;
        Ok(())
    }

    // --- Kubernetes ---

    pub async fn k8s_status(&self) -> anyhow::Result<ClusterStatus> {
        let resp = self.http.get(self.url("/k8s/status")).send().await?;
        check_status(&resp)?;
        Ok(resp.json().await?)
    }

    pub async fn k8s_enable(&self) -> anyhow::Result<()> {
        let resp = self.http.post(self.url("/k8s/enable")).send().await?;
        check_status(&resp)?;
        Ok(())
    }

    pub async fn k8s_disable(&self) -> anyhow::Result<()> {
        let resp = self.http.post(self.url("/k8s/disable")).send().await?;
        check_status(&resp)?;
        Ok(())
    }

    // --- Machines ---

    pub async fn list_machines(&self) -> anyhow::Result<Vec<MachineInfo>> {
        let resp = self.http.get(self.url("/machines")).send().await?;
        check_status(&resp)?;
        Ok(resp.json().await?)
    }

    pub async fn start_machine(&self, name: &str) -> anyhow::Result<()> {
        let resp = self
            .http
            .post(self.url(&format!("/machines/{name}/start")))
            .send()
            .await?;
        check_status(&resp)?;
        Ok(())
    }

    pub async fn stop_machine(&self, name: &str) -> anyhow::Result<()> {
        let resp = self
            .http
            .post(self.url(&format!("/machines/{name}/stop")))
            .send()
            .await?;
        check_status(&resp)?;
        Ok(())
    }

    // --- Gateway ---

    pub async fn gateway_status(&self) -> anyhow::Result<serde_json::Value> {
        let resp = self.http.get(self.url("/gateway/status")).send().await?;
        check_status(&resp)?;
        Ok(resp.json().await?)
    }

    pub async fn gateway_start(&self) -> anyhow::Result<serde_json::Value> {
        let resp = self.http.post(self.url("/gateway/start")).send().await?;
        check_status(&resp)?;
        Ok(resp.json().await?)
    }

    pub async fn gateway_stop(&self) -> anyhow::Result<()> {
        let resp = self.http.post(self.url("/gateway/stop")).send().await?;
        check_status(&resp)?;
        Ok(())
    }

    pub async fn gateway_routes(&self) -> anyhow::Result<Vec<serde_json::Value>> {
        let resp = self.http.get(self.url("/gateway/routes")).send().await?;
        check_status(&resp)?;
        Ok(resp.json().await?)
    }

    pub async fn gateway_add_route(
        &self,
        hostname: &str,
        container: &str,
        port: u16,
    ) -> anyhow::Result<serde_json::Value> {
        let resp = self
            .http
            .post(self.url("/gateway/routes"))
            .json(&serde_json::json!({
                "hostname": hostname,
                "container_name": container,
                "port": port,
            }))
            .send()
            .await?;
        check_status(&resp)?;
        Ok(resp.json().await?)
    }

    pub async fn gateway_remove_route(&self, hostname: &str) -> anyhow::Result<()> {
        let resp = self
            .http
            .delete(self.url(&format!("/gateway/routes/{hostname}")))
            .send()
            .await?;
        check_status(&resp)?;
        Ok(())
    }

    pub async fn gateway_get_config(&self) -> anyhow::Result<serde_json::Value> {
        let resp = self.http.get(self.url("/gateway/config")).send().await?;
        check_status(&resp)?;
        Ok(resp.json().await?)
    }

    pub async fn gateway_update_config(&self, config: &serde_json::Value) -> anyhow::Result<()> {
        let resp = self.http.put(self.url("/gateway/config")).json(config).send().await?;
        check_status(&resp)?;
        Ok(())
    }

    // --- CA ---

    pub async fn ca_certificate(&self) -> anyhow::Result<String> {
        // The /ca/certificate endpoint doesn't require auth and returns plain text PEM.
        let url = format!("{}/api/v1/ca/certificate", self.base_url);
        let resp = reqwest::Client::new().get(&url).send().await?;
        check_status(&resp)?;
        Ok(resp.text().await?)
    }

    pub async fn ca_info(&self) -> anyhow::Result<serde_json::Value> {
        let resp = self.http.get(self.url("/ca/info")).send().await?;
        check_status(&resp)?;
        Ok(resp.json().await?)
    }

    // --- Templates ---

    pub async fn list_templates(&self) -> anyhow::Result<Vec<serde_json::Value>> {
        let resp = self.http.get(self.url("/templates")).send().await?;
        check_status(&resp)?;
        Ok(resp.json().await?)
    }

    // --- Deploy ---

    pub async fn deploy_stack(&self, path: &str) -> anyhow::Result<serde_json::Value> {
        let resp = self
            .http
            .post(self.url("/stacks/deploy"))
            .json(&serde_json::json!({ "path": path }))
            .send()
            .await?;
        check_status(&resp)?;
        Ok(resp.json().await?)
    }

    pub async fn deploy_template(&self, id: &str) -> anyhow::Result<serde_json::Value> {
        let resp = self
            .http
            .post(self.url(&format!("/templates/{id}/deploy")))
            .json(&serde_json::json!({}))
            .send()
            .await?;
        check_status(&resp)?;
        Ok(resp.json().await?)
    }
}

fn check_status(resp: &reqwest::Response) -> anyhow::Result<()> {
    if !resp.status().is_success() && !resp.status().is_informational() {
        anyhow::bail!(
            "API request failed: {} {}",
            resp.status().as_u16(),
            resp.status().canonical_reason().unwrap_or("Unknown")
        );
    }
    Ok(())
}
