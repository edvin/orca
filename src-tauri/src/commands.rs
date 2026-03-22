//! Tauri commands — callable from the frontend via `invoke()`.
//! These proxy to the Orca daemon's HTTP API.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock, Mutex};

use serde::Deserialize;
use tauri::Manager;

use crate::daemon;

/// Active port-forward processes, keyed by "namespace/service/port"
static PORT_FORWARDS: OnceLock<Mutex<HashMap<String, std::process::Child>>> = OnceLock::new();

fn port_forward_map() -> &'static Mutex<HashMap<String, std::process::Child>> {
    PORT_FORWARDS.get_or_init(|| Mutex::new(HashMap::new()))
}

const DAEMON_URL: &str = "http://127.0.0.1:9477/api/v1";

/// Cached API token — loaded once from config, reused for all requests.
static API_TOKEN: OnceLock<Option<String>> = OnceLock::new();

/// Build a reqwest client with the API auth token pre-configured.
fn authed_client() -> reqwest::Client {
    let mut headers = reqwest::header::HeaderMap::new();
    if let Some(token) = load_api_token() {
        if let Ok(val) = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}")) {
            headers.insert(reqwest::header::AUTHORIZATION, val);
        }
    }
    reqwest::Client::builder()
        .default_headers(headers)
        .timeout(std::time::Duration::from_secs(30))
        .connect_timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// Read the API token from the Orca config file (cached after first read).
fn load_api_token() -> Option<String> {
    API_TOKEN.get_or_init(|| {
        orca_core::config::OrcaConfig::load().ok()?.api_token
    }).clone()
}

fn client() -> reqwest::Client {
    authed_client()
}

async fn get_json<T: for<'de> Deserialize<'de>>(path: &str) -> Result<T, String> {
    let resp = client()
        .get(format!("{DAEMON_URL}{path}"))
        .send()
        .await
        .map_err(|e| format!("Daemon connection failed: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(body);
    }

    resp.json::<T>()
        .await
        .map_err(|e| format!("Invalid response: {e}"))
}

async fn post_empty(path: &str) -> Result<(), String> {
    let resp = client()
        .post(format!("{DAEMON_URL}{path}"))
        .send()
        .await
        .map_err(|e| format!("Daemon connection failed: {e}"))?;

    if resp.status().is_success() {
        Ok(())
    } else {
        let body = resp.text().await.unwrap_or_default();
        Err(body)
    }
}

async fn post_json(path: &str) -> Result<serde_json::Value, String> {
    let resp = client()
        .post(format!("{DAEMON_URL}{path}"))
        .send()
        .await
        .map_err(|e| format!("Daemon connection failed: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(body);
    }

    resp.json()
        .await
        .map_err(|e| format!("Invalid response: {e}"))
}

async fn delete(path: &str) -> Result<(), String> {
    let resp = client()
        .delete(format!("{DAEMON_URL}{path}"))
        .send()
        .await
        .map_err(|e| format!("Daemon connection failed: {e}"))?;

    if resp.status().is_success() {
        Ok(())
    } else {
        let body = resp.text().await.unwrap_or_default();
        Err(body)
    }
}

// --- Status ---

#[tauri::command]
pub async fn get_status() -> Result<serde_json::Value, String> {
    match get_json::<serde_json::Value>("/health").await {
        Ok(health) => Ok(serde_json::json!({
            "daemon_running": true,
            "daemon_version": health.get("version").and_then(|v| v.as_str()).unwrap_or("unknown"),
        })),
        Err(_) => Ok(serde_json::json!({
            "daemon_running": false,
            "daemon_version": null,
        })),
    }
}

// --- Containers ---

#[tauri::command]
pub async fn list_containers() -> Result<serde_json::Value, String> {
    get_json("/containers").await
}

#[tauri::command]
pub async fn inspect_container(id: String) -> Result<serde_json::Value, String> {
    get_json(&format!("/containers/{id}")).await
}

#[tauri::command]
pub async fn container_stats(id: String) -> Result<serde_json::Value, String> {
    get_json(&format!("/containers/{id}/stats")).await
}

#[tauri::command]
pub async fn start_container(id: String) -> Result<(), String> {
    post_empty(&format!("/containers/{id}/start")).await
}

#[tauri::command]
pub async fn stop_container(id: String) -> Result<(), String> {
    post_empty(&format!("/containers/{id}/stop")).await
}

#[tauri::command]
pub async fn exec_container(
    id: String,
    command: Vec<String>,
    workdir: Option<String>,
) -> Result<serde_json::Value, String> {
    client()
        .post(format!("{DAEMON_URL}/containers/{id}/exec"))
        .json(&serde_json::json!({
            "command": command,
            "workdir": workdir,
        }))
        .send()
        .await
        .map_err(|e| format!("Exec failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Invalid response: {e}"))
}

#[tauri::command]
pub async fn remove_container(id: String) -> Result<(), String> {
    delete(&format!("/containers/{id}")).await
}

#[tauri::command]
pub async fn update_container(
    id: String,
    memory_limit: Option<String>,
    cpu_limit: Option<f64>,
    restart_policy: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut body = serde_json::json!({});
    if let Some(mem) = memory_limit {
        body["memory_limit"] = serde_json::json!(mem);
    }
    if let Some(cpu) = cpu_limit {
        body["cpu_limit"] = serde_json::json!(cpu);
    }
    if let Some(policy) = restart_policy {
        body["restart_policy"] = serde_json::json!(policy);
    }

    let resp = client()
        .post(format!("{DAEMON_URL}/containers/{id}/update"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("{e}"))?;

    if resp.status().is_success() {
        resp.json().await.map_err(|e| format!("{e}"))
    } else {
        let body = resp.text().await.unwrap_or_default();
        Err(body)
    }
}

// --- Container Export ---

#[tauri::command]
pub async fn export_docker_run(id: String) -> Result<String, String> {
    let resp: serde_json::Value = get_json(&format!("/containers/{id}/export/run")).await?;
    resp.get("command")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "Missing command in response".to_string())
}

#[tauri::command]
pub async fn export_compose(id: String) -> Result<String, String> {
    let resp: serde_json::Value = get_json(&format!("/containers/{id}/export/compose")).await?;
    resp.get("yaml")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "Missing yaml in response".to_string())
}

// --- Container Logs ---

#[tauri::command]
pub async fn container_logs(
    id: String,
    tail: Option<u32>,
) -> Result<Vec<String>, String> {
    // Fetch logs as SSE, collect lines (non-streaming for Tauri command).
    // For follow mode we'd use Tauri events, but batch fetch is fine for initial view.
    let resp = client()
        .get(format!(
            "{DAEMON_URL}/containers/{id}/logs?follow=false&tail={}",
            tail.unwrap_or(500)
        ))
        .send()
        .await
        .map_err(|e| format!("Daemon connection failed: {e}"))?
        .text()
        .await
        .map_err(|e| format!("Failed to read logs: {e}"))?;

    // Parse SSE format: lines starting with "data:" contain the log lines
    let lines: Vec<String> = resp
        .lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .map(|s| s.to_string())
        .collect();

    Ok(lines)
}

// --- Container Create & Run ---

#[tauri::command]
pub async fn create_and_run_container(
    image: String,
    name: Option<String>,
    command: Option<String>,
    env: Option<Vec<String>>,
    ports: Option<Vec<String>>,
    volumes: Option<Vec<String>>,
    restart_policy: Option<String>,
    cpu_limit: Option<f64>,
    memory_limit: Option<String>,
    gpu: Option<bool>,
    network: Option<String>,
) -> Result<serde_json::Value, String> {
    // Build the create request body
    let mut body = serde_json::json!({
        "image": image,
    });

    if let Some(n) = name {
        body["name"] = serde_json::json!(n);
    }
    if let Some(cmd) = command {
        // Split command string into parts
        let parts: Vec<&str> = cmd.split_whitespace().collect();
        if !parts.is_empty() {
            body["command"] = serde_json::json!(parts);
        }
    }
    if let Some(env_vars) = env {
        // Convert KEY=value strings to a map
        let env_map: serde_json::Map<String, serde_json::Value> = env_vars
            .iter()
            .filter_map(|s| {
                let mut parts = s.splitn(2, '=');
                let key = parts.next()?.to_string();
                let val = parts.next().unwrap_or("").to_string();
                Some((key, serde_json::json!(val)))
            })
            .collect();
        body["env"] = serde_json::json!(env_map);
    }
    if let Some(port_mappings) = ports {
        // Parse host:container format
        let parsed: Vec<serde_json::Value> = port_mappings
            .iter()
            .filter_map(|s| {
                let parts: Vec<&str> = s.split(':').collect();
                if parts.len() == 2 {
                    let host_port: u16 = parts[0].parse().ok()?;
                    let container_port: u16 = parts[1].parse().ok()?;
                    Some(serde_json::json!({
                        "host_port": host_port,
                        "container_port": container_port,
                        "protocol": "tcp"
                    }))
                } else {
                    None
                }
            })
            .collect();
        body["ports"] = serde_json::json!(parsed);
    }
    if let Some(vol_mounts) = volumes {
        // Parse host:container format
        let parsed: Vec<serde_json::Value> = vol_mounts
            .iter()
            .filter_map(|s| {
                let parts: Vec<&str> = s.splitn(2, ':').collect();
                if parts.len() == 2 {
                    Some(serde_json::json!({
                        "source": parts[0],
                        "target": parts[1],
                        "read_only": false
                    }))
                } else {
                    None
                }
            })
            .collect();
        body["volumes"] = serde_json::json!(parsed);
    }
    if let Some(policy) = restart_policy {
        body["restart_policy"] = serde_json::json!(policy);
    }
    if let Some(cpu) = cpu_limit {
        body["cpu_limit"] = serde_json::json!(cpu);
    }
    if let Some(mem) = memory_limit {
        body["memory_limit"] = serde_json::json!(mem);
    }
    if gpu.unwrap_or(false) {
        body["gpu"] = serde_json::json!(true);
    }
    if let Some(net) = network {
        if !net.is_empty() {
            body["network"] = serde_json::json!(net);
        }
    }

    // Create the container
    let create_resp = client()
        .post(format!("{DAEMON_URL}/containers"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to create container: {e}"))?;

    if !create_resp.status().is_success() {
        let err_body = create_resp.text().await.unwrap_or_default();
        return Err(err_body);
    }

    let create_result: serde_json::Value = create_resp
        .json()
        .await
        .map_err(|e| format!("Invalid create response: {e}"))?;

    let container_id = create_result
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "No container ID in response".to_string())?;

    // Start the container
    post_empty(&format!("/containers/{container_id}/start")).await?;

    Ok(create_result)
}

// --- Registries ---

#[tauri::command]
pub async fn list_registries() -> Result<serde_json::Value, String> {
    get_json("/registries").await
}

#[tauri::command]
pub async fn add_registry(
    server: String,
    name: String,
    username: String,
    password: String,
) -> Result<(), String> {
    let resp = client()
        .post(format!("{DAEMON_URL}/registries"))
        .json(&serde_json::json!({
            "server": server,
            "name": name,
            "username": username,
            "password": password,
        }))
        .send()
        .await
        .map_err(|e| format!("Failed to add registry: {e}"))?;

    if resp.status().is_success() {
        Ok(())
    } else {
        let body = resp.text().await.unwrap_or_default();
        Err(body)
    }
}

#[tauri::command]
pub async fn remove_registry(server: String) -> Result<(), String> {
    let encoded = urlencoding::encode(&server);
    delete(&format!("/registries/{encoded}")).await
}

#[tauri::command]
pub async fn search_images(query: String) -> Result<serde_json::Value, String> {
    get_json(&format!(
        "/images/search?q={}&limit=20",
        urlencoding::encode(&query)
    ))
    .await
}

// --- Images ---

#[tauri::command]
pub async fn list_images() -> Result<serde_json::Value, String> {
    get_json("/images").await
}

#[tauri::command]
pub async fn pull_image(
    reference: String,
    username: Option<String>,
    password: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut body = serde_json::json!({ "reference": reference });
    if let (Some(user), Some(pass)) = (username, password) {
        body["auth"] = serde_json::json!({
            "username": user,
            "password": pass,
        });
    }

    // Image pulls can take a long time — use extended timeout
    let pull_client = {
        let mut headers = reqwest::header::HeaderMap::new();
        if let Some(token) = load_api_token() {
            if let Ok(val) = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}")) {
                headers.insert(reqwest::header::AUTHORIZATION, val);
            }
        }
        reqwest::Client::builder()
            .default_headers(headers)
            .timeout(std::time::Duration::from_secs(600))
            .connect_timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    };

    let resp = pull_client
        .post(format!("{DAEMON_URL}/images/pull"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Pull failed: {e}"))?
        .text()
        .await
        .map_err(|e| format!("Failed to read pull response: {e}"))?;

    // Parse SSE events and return the last status
    let events: Vec<serde_json::Value> = resp
        .lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .filter_map(|s| serde_json::from_str(s).ok())
        .collect();

    Ok(serde_json::json!({
        "events": events,
        "success": true,
    }))
}

#[tauri::command]
pub async fn remove_image(id: String) -> Result<(), String> {
    delete(&format!("/images/{id}")).await
}

#[tauri::command]
pub async fn batch_delete_images(ids: Vec<String>, force: bool) -> Result<serde_json::Value, String> {
    client()
        .post(format!("{DAEMON_URL}/images/batch-delete"))
        .json(&serde_json::json!({ "ids": ids, "force": force }))
        .send()
        .await
        .map_err(|e| format!("Batch delete failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Invalid response: {e}"))
}

#[tauri::command]
pub async fn prune_images() -> Result<serde_json::Value, String> {
    post_json("/images/prune").await
}

#[tauri::command]
pub async fn tag_image(source: String, repo: String, tag: String) -> Result<(), String> {
    let resp = client()
        .post(format!(
            "{DAEMON_URL}/images/{}/tag",
            urlencoding::encode(&source)
        ))
        .json(&serde_json::json!({ "repo": repo, "tag": tag }))
        .send()
        .await
        .map_err(|e| format!("Tag failed: {e}"))?;
    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Tag failed: {text}"));
    }
    Ok(())
}

#[tauri::command]
pub async fn build_image(
    context_path: String,
    dockerfile: Option<String>,
    tag: Option<String>,
    build_args: Option<HashMap<String, String>>,
) -> Result<serde_json::Value, String> {
    let resp = client()
        .post(format!("{DAEMON_URL}/images/build"))
        .json(&serde_json::json!({
            "context_path": context_path,
            "dockerfile": dockerfile,
            "tag": tag,
            "build_args": build_args,
        }))
        .send()
        .await
        .map_err(|e| format!("Build failed: {e}"))?
        .text()
        .await
        .map_err(|e| format!("Failed to read build response: {e}"))?;

    // Parse SSE build log
    let logs: Vec<String> = resp
        .lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .filter_map(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        .filter_map(|v| {
            if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
                Some(format!("ERROR: {err}"))
            } else {
                v.get("stream").and_then(|s| s.as_str()).map(|s| s.to_string())
            }
        })
        .collect();

    let has_error = logs.iter().any(|l| l.starts_with("ERROR:"));
    Ok(serde_json::json!({
        "success": !has_error,
        "logs": logs,
    }))
}

// --- Volumes ---

#[tauri::command]
pub async fn list_volumes() -> Result<serde_json::Value, String> {
    get_json("/volumes").await
}

#[tauri::command]
pub async fn remove_volume(name: String) -> Result<(), String> {
    delete(&format!("/volumes/{name}")).await
}

#[tauri::command]
pub async fn create_volume(name: String, driver: Option<String>, labels: Option<Vec<String>>) -> Result<serde_json::Value, String> {
    client()
        .post(format!("{DAEMON_URL}/volumes"))
        .json(&serde_json::json!({
            "name": name,
            "driver": driver.unwrap_or_else(|| "local".to_string()),
            "labels": labels.unwrap_or_default(),
        }))
        .send()
        .await
        .map_err(|e| format!("Failed to create volume: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Invalid response: {e}"))
}

// --- Volume File Browsing ---

#[tauri::command]
pub async fn volume_list_files(name: String, path: Option<String>) -> Result<serde_json::Value, String> {
    let query = match &path {
        Some(p) => format!("?path={}", urlencoding::encode(p)),
        None => String::new(),
    };
    get_json(&format!("/volumes/{name}/files{query}")).await
}

#[tauri::command]
pub async fn volume_read_file(name: String, path: String) -> Result<serde_json::Value, String> {
    get_json(&format!("/volumes/{name}/file?path={}", urlencoding::encode(&path))).await
}

#[tauri::command]
pub async fn volume_containers(name: String) -> Result<serde_json::Value, String> {
    get_json(&format!("/volumes/{name}/containers")).await
}

// --- Container File Browsing ---

#[tauri::command]
pub async fn container_list_files(id: String, path: Option<String>) -> Result<serde_json::Value, String> {
    let encoded_id = urlencoding::encode(&id);
    let path_param = path.map(|p| format!("?path={}", urlencoding::encode(&p))).unwrap_or_default();
    get_json(&format!("/containers/{encoded_id}/files{path_param}")).await
}

#[tauri::command]
pub async fn container_read_file(id: String, path: String) -> Result<serde_json::Value, String> {
    let encoded_id = urlencoding::encode(&id);
    let encoded_path = urlencoding::encode(&path);
    get_json(&format!("/containers/{encoded_id}/file?path={encoded_path}")).await
}

// --- Container Commit ---

#[tauri::command]
pub async fn commit_container(id: String, repo: String, tag: Option<String>) -> Result<serde_json::Value, String> {
    client()
        .post(format!("{DAEMON_URL}/containers/{}/commit", urlencoding::encode(&id)))
        .json(&serde_json::json!({ "repo": repo, "tag": tag.unwrap_or_else(|| "latest".into()) }))
        .send().await.map_err(|e| format!("{e}"))?
        .json().await.map_err(|e| format!("{e}"))
}

// --- Images (inspect) ---

#[tauri::command]
pub async fn inspect_image(id: String) -> Result<serde_json::Value, String> {
    get_json(&format!("/images/{id}")).await
}

#[tauri::command]
pub async fn image_history(id: String) -> Result<serde_json::Value, String> {
    get_json(&format!("/images/{id}/history")).await
}

#[tauri::command]
pub async fn image_list_files(id: String, path: Option<String>) -> Result<serde_json::Value, String> {
    let encoded_id = urlencoding::encode(&id);
    let path_param = path.map(|p| format!("?path={}", urlencoding::encode(&p))).unwrap_or_default();
    get_json(&format!("/images/{encoded_id}/files{path_param}")).await
}

#[tauri::command]
pub async fn image_read_file(id: String, path: String) -> Result<serde_json::Value, String> {
    let encoded_id = urlencoding::encode(&id);
    let encoded_path = urlencoding::encode(&path);
    get_json(&format!("/images/{encoded_id}/file?path={encoded_path}")).await
}

// --- Image Import ---

#[tauri::command]
pub async fn import_image(path: String) -> Result<serde_json::Value, String> {
    client()
        .post(format!("{DAEMON_URL}/images/import"))
        .json(&serde_json::json!({ "path": path }))
        .timeout(std::time::Duration::from_secs(300))
        .send().await.map_err(|e| format!("{e}"))?
        .json().await.map_err(|e| format!("{e}"))
}

// --- Image Scanning ---

#[tauri::command]
pub async fn scan_image(id: String) -> Result<serde_json::Value, String> {
    // Trivy scans can take a while — use a longer timeout
    let client = {
        let mut headers = reqwest::header::HeaderMap::new();
        if let Some(token) = load_api_token() {
            if let Ok(val) = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}")) {
                headers.insert(reqwest::header::AUTHORIZATION, val);
            }
        }
        reqwest::Client::builder()
            .default_headers(headers)
            .timeout(std::time::Duration::from_secs(600))
            .connect_timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    };

    let encoded = urlencoding::encode(&id);
    let resp = client
        .get(format!("{DAEMON_URL}/images/{encoded}/scan"))
        .send()
        .await
        .map_err(|e| format!("Scan failed: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Scan failed: {body}"));
    }

    resp.json()
        .await
        .map_err(|e| format!("Invalid scan response: {e}"))
}

// --- Networks ---

#[tauri::command]
pub async fn list_networks() -> Result<serde_json::Value, String> {
    get_json("/networks").await
}

#[tauri::command]
pub async fn create_network(name: String, driver: Option<String>) -> Result<serde_json::Value, String> {
    client()
        .post(format!("{DAEMON_URL}/networks"))
        .json(&serde_json::json!({
            "name": name,
            "driver": driver.unwrap_or_else(|| "bridge".to_string()),
        }))
        .send()
        .await
        .map_err(|e| format!("Failed to create network: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Invalid response: {e}"))
}

#[tauri::command]
pub async fn remove_network(name: String) -> Result<(), String> {
    delete(&format!("/networks/{name}")).await
}

#[tauri::command]
pub async fn network_topology() -> Result<serde_json::Value, String> {
    get_json("/networks/topology").await
}

// --- Stacks (Compose Projects) ---

#[tauri::command]
pub async fn list_stacks() -> Result<serde_json::Value, String> {
    get_json("/stacks").await
}

#[tauri::command]
pub async fn get_stack(name: String) -> Result<serde_json::Value, String> {
    get_json(&format!("/stacks/{name}")).await
}

#[tauri::command]
pub async fn start_stack(name: String) -> Result<(), String> {
    post_empty(&format!("/stacks/{name}/start")).await
}

#[tauri::command]
pub async fn stop_stack(name: String) -> Result<(), String> {
    post_empty(&format!("/stacks/{name}/stop")).await
}

#[tauri::command]
pub async fn restart_stack(name: String) -> Result<(), String> {
    post_empty(&format!("/stacks/{name}/restart")).await
}

#[tauri::command]
pub async fn compose_up(name: String) -> Result<serde_json::Value, String> {
    post_json(&format!("/stacks/{name}/up")).await
}

#[tauri::command]
pub async fn compose_down(name: String) -> Result<serde_json::Value, String> {
    post_json(&format!("/stacks/{name}/down")).await
}

#[tauri::command]
pub async fn compose_pull(name: String) -> Result<serde_json::Value, String> {
    post_json(&format!("/stacks/{name}/pull")).await
}

// --- Events ---

/// Subscribe to daemon events. Returns recent events and triggers
/// Tauri event emissions for real-time updates.
#[tauri::command]
pub async fn subscribe_events(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Emitter;

    let resp = client()
        .get(format!("{DAEMON_URL}/events"))
        .send()
        .await
        .map_err(|e| format!("Failed to connect to event stream: {e}"))?;

    tokio::spawn(async move {
        use tokio::io::AsyncBufReadExt;
        use tokio_stream::StreamExt;

        let stream = resp.bytes_stream();
        let mapped = stream.map(|r| {
            r.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))
        });
        let reader = tokio_util::io::StreamReader::new(mapped);
        let mut lines = reader.lines();

        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(data) = line.strip_prefix("data:") {
                if let Ok(event) = serde_json::from_str::<serde_json::Value>(data) {
                    let _ = app.emit("orca-event", &event);
                }
            }
        }
    });

    Ok(())
}

// --- Machine ---

#[tauri::command]
pub async fn get_machine_info() -> Result<serde_json::Value, String> {
    let machines: Vec<serde_json::Value> = get_json("/machines").await?;
    machines
        .into_iter()
        .next()
        .ok_or_else(|| "No machine found".to_string())
}

// --- Kubernetes ---

#[tauri::command]
pub async fn k8s_status() -> Result<serde_json::Value, String> {
    get_json("/k8s/status").await
}

#[tauri::command]
pub async fn k8s_enable() -> Result<serde_json::Value, String> {
    // K8s setup can take several minutes — use a long timeout
    let long_client = {
        let mut headers = reqwest::header::HeaderMap::new();
        if let Some(token) = load_api_token() {
            if let Ok(val) = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}")) {
                headers.insert(reqwest::header::AUTHORIZATION, val);
            }
        }
        reqwest::Client::builder()
            .default_headers(headers)
            .timeout(std::time::Duration::from_secs(600))
            .connect_timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    };

    long_client
        .post(format!("{DAEMON_URL}/k8s/enable"))
        .send()
        .await
        .map_err(|e| format!("Daemon connection failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Invalid response: {e}"))
}

#[tauri::command]
pub async fn k8s_disable() -> Result<(), String> {
    post_empty("/k8s/disable").await
}

#[tauri::command]
pub async fn k8s_namespaces() -> Result<serde_json::Value, String> {
    get_json("/k8s/namespaces").await
}

#[tauri::command]
pub async fn k8s_pods(namespace: String) -> Result<serde_json::Value, String> {
    get_json(&format!("/k8s/pods/{namespace}")).await
}

#[tauri::command]
pub async fn k8s_deployments(namespace: String) -> Result<serde_json::Value, String> {
    get_json(&format!("/k8s/deployments/{namespace}")).await
}

#[tauri::command]
pub async fn k8s_services(namespace: String) -> Result<serde_json::Value, String> {
    get_json(&format!("/k8s/services/{namespace}")).await
}

#[tauri::command]
pub async fn k8s_ingresses(namespace: String) -> Result<serde_json::Value, String> {
    get_json(&format!("/k8s/ingresses/{namespace}")).await
}

#[tauri::command]
pub async fn k8s_pvcs(namespace: String) -> Result<serde_json::Value, String> {
    get_json(&format!("/k8s/pvcs/{namespace}")).await
}

#[tauri::command]
pub async fn k8s_pvs() -> Result<serde_json::Value, String> {
    get_json("/k8s/pvs").await
}

#[tauri::command]
pub async fn k8s_delete_pod(namespace: String, name: String) -> Result<(), String> {
    delete(&format!("/k8s/pods/{namespace}/{name}")).await
}

#[tauri::command]
pub async fn k8s_delete_pvc(namespace: String, name: String) -> Result<(), String> {
    delete(&format!("/k8s/pvcs/{namespace}/{name}")).await
}

#[tauri::command]
pub async fn k8s_scale_deployment(
    namespace: String,
    name: String,
    replicas: u32,
) -> Result<(), String> {
    let resp = client()
        .post(format!("{DAEMON_URL}/k8s/deployments/{namespace}/{name}/scale"))
        .json(&serde_json::json!({ "replicas": replicas }))
        .send()
        .await
        .map_err(|e| format!("Scale failed: {e}"))?;

    if resp.status().is_success() {
        Ok(())
    } else {
        let body = resp.text().await.unwrap_or_default();
        Err(body)
    }
}

#[tauri::command]
pub async fn k8s_restart_deployment(namespace: String, name: String) -> Result<(), String> {
    post_empty(&format!("/k8s/deployments/{namespace}/{name}/restart")).await
}

#[tauri::command]
pub async fn k8s_pod_logs(
    namespace: String,
    name: String,
    container: Option<String>,
    tail: Option<u32>,
) -> Result<Vec<String>, String> {
    let mut query_parts = Vec::new();
    if let Some(c) = &container {
        query_parts.push(format!("container={c}"));
    }
    if let Some(t) = tail {
        query_parts.push(format!("tail={t}"));
    }
    let query = if query_parts.is_empty() {
        String::new()
    } else {
        format!("?{}", query_parts.join("&"))
    };

    get_json(&format!("/k8s/pods/{namespace}/{name}/logs{query}")).await
}

#[tauri::command]
pub async fn k8s_apply_yaml(yaml: String) -> Result<serde_json::Value, String> {
    client()
        .post(format!("{DAEMON_URL}/k8s/apply"))
        .json(&serde_json::json!({ "yaml": yaml }))
        .send()
        .await
        .map_err(|e| format!("Apply failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Invalid response: {e}"))
}

fn validate_k8s_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 253 {
        return Err("Invalid Kubernetes name: length".into());
    }
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.') {
        return Err(format!("Invalid Kubernetes name: {name}"));
    }
    Ok(())
}

const ALLOWED_K8S_KINDS: &[&str] = &[
    "pod", "pods",
    "service", "services", "svc",
    "deployment", "deployments", "deploy",
    "statefulset", "statefulsets", "sts",
    "daemonset", "daemonsets", "ds",
    "replicaset", "replicasets", "rs",
    "job", "jobs",
    "cronjob", "cronjobs", "cj",
    "configmap", "configmaps", "cm",
    "secret", "secrets",
    "ingress", "ingresses", "ing",
    "persistentvolumeclaim", "persistentvolumeclaims", "pvc",
    "persistentvolume", "persistentvolumes", "pv",
    "namespace", "namespaces", "ns",
    "node", "nodes",
    "serviceaccount", "serviceaccounts", "sa",
    "role", "roles",
    "rolebinding", "rolebindings",
    "clusterrole", "clusterroles",
    "clusterrolebinding", "clusterrolebindings",
    "networkpolicy", "networkpolicies", "netpol",
    "horizontalpodautoscaler", "horizontalpodautoscalers", "hpa",
    "endpoint", "endpoints", "ep",
    "event", "events", "ev",
    "storageclass", "storageclasses", "sc",
];

fn validate_k8s_kind(kind: &str) -> Result<(), String> {
    if !ALLOWED_K8S_KINDS.contains(&kind.to_lowercase().as_str()) {
        return Err(format!("Invalid Kubernetes resource kind: {kind}"));
    }
    Ok(())
}

#[tauri::command]
pub async fn k8s_get_yaml(kind: String, name: String, namespace: String) -> Result<String, String> {
    validate_k8s_kind(&kind)?;
    validate_k8s_name(&name)?;
    validate_k8s_name(&namespace)?;

    let output = {
        #[cfg(target_os = "windows")]
        {
            let mut cmd = tokio::process::Command::new("wsl");
            cmd.args(["-u", "root", "--", "k3s", "kubectl", "get", &kind, &name, "-n", &namespace, "-o", "yaml"]);
            // Hide console window
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x08000000);
            }
            cmd.output().await.map_err(|e| format!("kubectl failed: {e}"))?
        }
        #[cfg(not(target_os = "windows"))]
        {
            tokio::process::Command::new("kubectl")
                .args(["get", &kind, &name, "-n", &namespace, "-o", "yaml"])
                .output()
                .await
                .map_err(|e| format!("kubectl failed: {e}"))?
        }
    };
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        return Err(if stderr.trim().is_empty() {
            format!("kubectl exited with code {}: {}", output.status, stdout)
        } else {
            stderr
        });
    }

    if stdout.trim().is_empty() {
        return Err(format!("kubectl returned no output for {} {}/{}", kind, namespace, name));
    }

    Ok(stdout)
}

#[tauri::command]
pub async fn k8s_events(namespace: String) -> Result<serde_json::Value, String> {
    validate_k8s_name(&namespace)?;
    get_json(&format!("/k8s/events/{namespace}")).await
}

#[tauri::command]
pub async fn k8s_create_namespace(name: String) -> Result<(), String> {
    validate_k8s_name(&name)?;
    let resp = client()
        .post(format!("{DAEMON_URL}/k8s/namespaces"))
        .json(&serde_json::json!({ "name": name }))
        .send()
        .await
        .map_err(|e| format!("Create namespace failed: {e}"))?;

    if resp.status().is_success() {
        Ok(())
    } else {
        let body = resp.text().await.unwrap_or_default();
        Err(body)
    }
}

#[tauri::command]
pub async fn k8s_delete_namespace(name: String) -> Result<(), String> {
    validate_k8s_name(&name)?;
    delete(&format!("/k8s/namespaces/{name}")).await
}

#[tauri::command]
pub async fn k8s_configmaps(namespace: String) -> Result<serde_json::Value, String> {
    get_json(&format!("/k8s/configmaps/{namespace}")).await
}

#[tauri::command]
pub async fn k8s_secrets(namespace: String) -> Result<serde_json::Value, String> {
    get_json(&format!("/k8s/secrets/{namespace}")).await
}

#[tauri::command]
pub async fn k8s_create_secret(namespace: String, name: String, data: serde_json::Value, secret_type: Option<String>) -> Result<(), String> {
    validate_k8s_name(&namespace)?;
    validate_k8s_name(&name)?;
    let resp = client()
        .post(format!("{DAEMON_URL}/k8s/secrets/{namespace}"))
        .json(&serde_json::json!({ "name": name, "data": data, "secret_type": secret_type }))
        .send()
        .await
        .map_err(|e| format!("Create secret failed: {e}"))?;
    if resp.status().is_success() {
        Ok(())
    } else {
        let body = resp.text().await.unwrap_or_default();
        Err(body)
    }
}

#[tauri::command]
pub async fn k8s_delete_secret(namespace: String, name: String) -> Result<(), String> {
    validate_k8s_name(&namespace)?;
    validate_k8s_name(&name)?;
    delete(&format!("/k8s/secrets/{namespace}/{name}")).await
}

#[tauri::command]
pub async fn k8s_update_secret(namespace: String, name: String, data: serde_json::Value) -> Result<(), String> {
    validate_k8s_name(&namespace)?;
    validate_k8s_name(&name)?;
    let resp = client()
        .put(format!("{DAEMON_URL}/k8s/secrets/{namespace}/{name}"))
        .json(&serde_json::json!({ "data": data }))
        .send()
        .await
        .map_err(|e| format!("Update secret failed: {e}"))?;
    if resp.status().is_success() {
        Ok(())
    } else {
        let body = resp.text().await.unwrap_or_default();
        Err(body)
    }
}

#[tauri::command]
pub async fn k8s_create_pvc(namespace: String, name: String, storage_class: String, size: String, access_modes: Vec<String>) -> Result<(), String> {
    validate_k8s_name(&namespace)?;
    validate_k8s_name(&name)?;
    let resp = client()
        .post(format!("{DAEMON_URL}/k8s/pvcs/{namespace}"))
        .json(&serde_json::json!({
            "name": name,
            "storage_class": storage_class,
            "size": size,
            "access_modes": access_modes,
        }))
        .send()
        .await
        .map_err(|e| format!("Create PVC failed: {e}"))?;
    if resp.status().is_success() {
        Ok(())
    } else {
        let body = resp.text().await.unwrap_or_default();
        Err(body)
    }
}

// --- K8s Metrics, Rollback, Helm ---

#[tauri::command]
pub async fn k8s_pod_metrics(namespace: String) -> Result<serde_json::Value, String> {
    get_json(&format!("/k8s/metrics/{namespace}")).await
}

#[tauri::command]
pub async fn k8s_rollout_history(
    namespace: String,
    name: String,
) -> Result<serde_json::Value, String> {
    get_json(&format!("/k8s/deployments/{namespace}/{name}/history")).await
}

#[tauri::command]
pub async fn k8s_rollout_undo(
    namespace: String,
    name: String,
    revision: Option<u32>,
) -> Result<serde_json::Value, String> {
    client()
        .post(format!("{DAEMON_URL}/k8s/deployments/{namespace}/{name}/rollback"))
        .json(&serde_json::json!({ "revision": revision }))
        .send()
        .await
        .map_err(|e| format!("Rollback failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Invalid response: {e}"))
}

// --- K8s Jobs / CronJobs ---

#[tauri::command]
pub async fn k8s_jobs(namespace: String) -> Result<serde_json::Value, String> {
    validate_k8s_name(&namespace)?;
    get_json(&format!("/k8s/jobs/{namespace}")).await
}

#[tauri::command]
pub async fn k8s_cronjobs(namespace: String) -> Result<serde_json::Value, String> {
    validate_k8s_name(&namespace)?;
    get_json(&format!("/k8s/cronjobs/{namespace}")).await
}

#[tauri::command]
pub async fn k8s_trigger_cronjob(namespace: String, name: String) -> Result<serde_json::Value, String> {
    validate_k8s_name(&namespace)?;
    validate_k8s_name(&name)?;
    client()
        .post(format!("{DAEMON_URL}/k8s/cronjobs/{namespace}/{name}/trigger"))
        .send()
        .await
        .map_err(|e| format!("Trigger failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Invalid response: {e}"))
}

#[tauri::command]
pub async fn k8s_delete_job(namespace: String, name: String) -> Result<(), String> {
    validate_k8s_name(&namespace)?;
    validate_k8s_name(&name)?;
    delete(&format!("/k8s/jobs/{namespace}/{name}")).await
}

#[tauri::command]
pub async fn k8s_delete_cronjob(namespace: String, name: String) -> Result<(), String> {
    validate_k8s_name(&namespace)?;
    validate_k8s_name(&name)?;
    delete(&format!("/k8s/cronjobs/{namespace}/{name}")).await
}

#[tauri::command]
pub async fn k8s_suspend_cronjob(namespace: String, name: String, suspend: bool) -> Result<serde_json::Value, String> {
    validate_k8s_name(&namespace)?;
    validate_k8s_name(&name)?;
    client()
        .put(format!("{DAEMON_URL}/k8s/cronjobs/{namespace}/{name}/suspend"))
        .json(&serde_json::json!({ "suspend": suspend }))
        .send()
        .await
        .map_err(|e| format!("Suspend failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Invalid response: {e}"))
}

#[tauri::command]
pub async fn k8s_helm_list() -> Result<serde_json::Value, String> {
    get_json("/k8s/helm/releases").await
}

#[tauri::command]
pub async fn k8s_helm_uninstall(name: String, namespace: String) -> Result<serde_json::Value, String> {
    client()
        .post(format!("{DAEMON_URL}/k8s/helm/uninstall"))
        .json(&serde_json::json!({ "name": name, "namespace": namespace }))
        .send()
        .await
        .map_err(|e| format!("Helm uninstall failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Invalid response: {e}"))
}

#[tauri::command]
pub async fn k8s_helm_available() -> Result<serde_json::Value, String> {
    get_json("/k8s/helm/available").await
}

#[tauri::command]
pub async fn k8s_helm_install(
    release_name: String,
    chart: String,
    namespace: String,
    set_values: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    client()
        .post(format!("{DAEMON_URL}/k8s/helm/install"))
        .json(&serde_json::json!({
            "release_name": release_name,
            "chart": chart,
            "namespace": namespace,
            "set_values": set_values,
        }))
        .send()
        .await
        .map_err(|e| format!("Helm install failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Invalid response: {e}"))
}

// --- K8s Port Forwarding ---

#[tauri::command]
pub async fn k8s_port_forward(
    namespace: String,
    service: String,
    port: u16,
    local_port: Option<u16>,
    expose: Option<bool>,
) -> Result<serde_json::Value, String> {
    validate_k8s_name(&namespace)?;
    validate_k8s_name(&service)?;
    let local = local_port.unwrap_or(port);
    let key = format!("{namespace}/{service}/{local}");
    let address = if expose.unwrap_or(false) { "0.0.0.0" } else { "127.0.0.1" };

    {
        let map = port_forward_map().lock().map_err(|e| format!("{e}"))?;
        if map.contains_key(&key) {
            return Ok(serde_json::json!({ "status": "already_running", "port": local }));
        }
    }

    let child = if cfg!(target_os = "windows") {
        let mut cmd = std::process::Command::new("wsl");
        cmd.args(["-u", "root", "--", "k3s", "kubectl", "port-forward",
                &format!("svc/{service}"), &format!("{local}:{port}"),
                "-n", &namespace, &format!("--address={address}")])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        cmd.spawn()
            .map_err(|e| format!("Failed to start port-forward: {e}"))?
    } else {
        std::process::Command::new("kubectl")
            .args(["port-forward", &format!("svc/{service}"),
                &format!("{local}:{port}"), "-n", &namespace, &format!("--address={address}")])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to start port-forward: {e}"))?
    };

    let pid = child.id();
    port_forward_map().lock().map_err(|e| format!("{e}"))?.insert(key, child);

    Ok(serde_json::json!({ "status": "started", "port": local, "pid": pid }))
}

#[tauri::command]
pub async fn k8s_stop_port_forward(
    namespace: String,
    service: String,
    port: u16,
) -> Result<(), String> {
    validate_k8s_name(&namespace)?;
    validate_k8s_name(&service)?;
    let key = format!("{namespace}/{service}/{port}");
    let mut map = port_forward_map().lock().map_err(|e| format!("{e}"))?;
    if let Some(mut child) = map.remove(&key) {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

#[tauri::command]
pub async fn k8s_list_port_forwards() -> Result<serde_json::Value, String> {
    let map = port_forward_map().lock().map_err(|e| format!("{e}"))?;
    let forwards: Vec<serde_json::Value> = map.keys().map(|k| {
        let parts: Vec<&str> = k.split('/').collect();
        serde_json::json!({
            "namespace": parts.first().unwrap_or(&""),
            "service": parts.get(1).unwrap_or(&""),
            "port": parts.get(2).unwrap_or(&""),
        })
    }).collect();
    Ok(serde_json::json!(forwards))
}

// --- System Health ---

#[tauri::command]
pub async fn system_health() -> Result<serde_json::Value, String> {
    get_json("/system/health").await
}

// --- Environment ---

#[tauri::command]
pub async fn env_status() -> Result<serde_json::Value, String> {
    get_json("/environment/status").await
}

#[tauri::command]
pub async fn env_fix(action: String) -> Result<serde_json::Value, String> {
    client()
        .post(format!("{DAEMON_URL}/environment/fix"))
        .json(&serde_json::json!({ "action": action }))
        .send()
        .await
        .map_err(|e| format!("Fix action failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Invalid response: {e}"))
}

// --- Templates ---

#[tauri::command]
pub async fn list_templates() -> Result<serde_json::Value, String> {
    get_json("/templates").await
}

#[tauri::command]
pub async fn deploy_template(
    id: String,
    name: Option<String>,
    ports: Option<Vec<String>>,
    env: Option<Vec<String>>,
    volumes: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    let resp = client()
        .post(format!("{DAEMON_URL}/templates/{id}/deploy"))
        .json(&serde_json::json!({
            "name": name,
            "ports": ports,
            "env": env,
            "volumes": volumes,
        }))
        .send()
        .await
        .map_err(|e| format!("Deploy failed: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        // Try to extract a readable error from Docker's JSON response
        let msg = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str().map(String::from)))
            .unwrap_or(body);
        return Err(msg);
    }

    resp.json()
        .await
        .map_err(|e| format!("Invalid response: {e}"))
}

#[tauri::command]
pub async fn save_user_template(template: serde_json::Value) -> Result<serde_json::Value, String> {
    client()
        .post(format!("{DAEMON_URL}/templates/user"))
        .json(&template)
        .send()
        .await
        .map_err(|e| format!("Save failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Invalid response: {e}"))
}

#[tauri::command]
pub async fn delete_user_template(id: String) -> Result<serde_json::Value, String> {
    client()
        .delete(format!("{DAEMON_URL}/templates/user?id={id}"))
        .send()
        .await
        .map_err(|e| format!("Delete failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Invalid response: {e}"))
}

// --- AI Assistant ---

#[tauri::command]
pub async fn ai_ask(
    query: String,
    context: Option<serde_json::Value>,
    history: Option<Vec<serde_json::Value>>,
) -> Result<serde_json::Value, String> {
    // Validate request size
    if let Some(ref ctx) = context {
        let ctx_str = serde_json::to_string(ctx).unwrap_or_default();
        if ctx_str.len() > 100_000 {
            return Err("Context too large (max 100KB)".into());
        }
    }
    if let Some(ref hist) = history {
        if hist.len() > 100 {
            return Err("History too long (max 100 messages)".into());
        }
        let hist_str = serde_json::to_string(hist).unwrap_or_default();
        if hist_str.len() > 500_000 {
            return Err("History too large (max 500KB)".into());
        }
    }

    // AI requests can be slow — local models need time to load into memory
    let ai_client = {
        let mut headers = reqwest::header::HeaderMap::new();
        if let Some(token) = load_api_token() {
            if let Ok(val) = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}")) {
                headers.insert(reqwest::header::AUTHORIZATION, val);
            }
        }
        reqwest::Client::builder()
            .default_headers(headers)
            .timeout(std::time::Duration::from_secs(300))
            .connect_timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    };

    let resp = ai_client
        .post(format!("{DAEMON_URL}/ai/ask"))
        .json(&serde_json::json!({
            "query": query,
            "context": context,
            "history": history.unwrap_or_default(),
        }))
        .send()
        .await
        .map_err(|e| format!("AI request failed: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("AI error: {body}"));
    }

    resp.json()
        .await
        .map_err(|e| format!("Invalid response: {e}"))
}

// --- WSL2 Config (Windows) ---

#[tauri::command]
pub async fn get_wsl_config() -> Result<serde_json::Value, String> {
    let userprofile = std::env::var("USERPROFILE")
        .map_err(|_| "USERPROFILE environment variable not set".to_string())?;
    let config_path = std::path::Path::new(&userprofile).join(".wslconfig");

    let mut memory = String::new();
    let mut processors = String::new();
    let mut swap = String::new();

    if config_path.exists() {
        let content = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read .wslconfig: {e}"))?;

        let mut in_wsl2_section = false;
        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.eq_ignore_ascii_case("[wsl2]") {
                in_wsl2_section = true;
                continue;
            }
            if trimmed.starts_with('[') {
                in_wsl2_section = false;
                continue;
            }
            if in_wsl2_section {
                if let Some((key, value)) = trimmed.split_once('=') {
                    let key = key.trim().to_lowercase();
                    let value = value.trim().to_string();
                    match key.as_str() {
                        "memory" => memory = value,
                        "processors" => processors = value,
                        "swap" => swap = value,
                        _ => {}
                    }
                }
            }
        }
    }

    Ok(serde_json::json!({
        "memory": memory,
        "processors": processors,
        "swap": swap,
    }))
}

fn validate_wsl_value(val: &str, allow_unit: bool) -> Result<(), String> {
    let val = val.trim();
    if val.is_empty() { return Ok(()); }
    if val.contains('\n') || val.contains('\r') || val.contains('=') || val.contains('[') {
        return Err(format!("Invalid value: {val}"));
    }
    if allow_unit {
        // e.g. "4GB", "512MB", "2"
        let numeric_end = val.find(|c: char| !c.is_ascii_digit()).unwrap_or(val.len());
        if numeric_end == 0 { return Err(format!("Invalid value: {val}")); }
        let unit = &val[numeric_end..];
        if !unit.is_empty() && !["GB", "MB", "KB", "TB"].contains(&unit.to_uppercase().as_str()) {
            return Err(format!("Invalid unit in: {val}"));
        }
    } else {
        if !val.chars().all(|c| c.is_ascii_digit()) {
            return Err(format!("Invalid value: {val}"));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn save_wsl_config(memory: String, processors: String, swap: String) -> Result<(), String> {
    // Validate inputs before writing to config file
    validate_wsl_value(&memory, true)?;
    validate_wsl_value(&processors, false)?;
    validate_wsl_value(&swap, true)?;

    let userprofile = std::env::var("USERPROFILE")
        .map_err(|_| "USERPROFILE environment variable not set".to_string())?;
    let config_path = std::path::Path::new(&userprofile).join(".wslconfig");

    // Read existing config and preserve non-wsl2 sections
    let existing = if config_path.exists() {
        std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read .wslconfig: {e}"))?
    } else {
        String::new()
    };

    let mut other_sections = String::new();
    let mut in_wsl2_section = false;
    for line in existing.lines() {
        let trimmed = line.trim();
        if trimmed.eq_ignore_ascii_case("[wsl2]") {
            in_wsl2_section = true;
            continue;
        }
        if trimmed.starts_with('[') {
            in_wsl2_section = false;
        }
        if !in_wsl2_section {
            other_sections.push_str(line);
            other_sections.push('\n');
        }
    }

    // Build new content with [wsl2] section first
    let mut content = String::from("[wsl2]\n");
    if !memory.is_empty() {
        content.push_str(&format!("memory={memory}\n"));
    }
    if !processors.is_empty() {
        content.push_str(&format!("processors={processors}\n"));
    }
    if !swap.is_empty() {
        content.push_str(&format!("swap={swap}\n"));
    }
    content.push('\n');
    content.push_str(other_sections.trim_start());

    std::fs::write(&config_path, content.trim_end_matches('\n'))
        .map_err(|e| format!("Failed to write .wslconfig: {e}"))?;

    Ok(())
}

// --- General Settings ---

#[tauri::command]
pub async fn get_general_settings() -> Result<serde_json::Value, String> {
    get_json("/settings/general").await
}

#[tauri::command]
pub async fn save_general_settings(
    start_on_login: bool,
    show_tray_icon: bool,
    telemetry: bool,
) -> Result<(), String> {
    let resp = client()
        .post(format!("{DAEMON_URL}/settings/general"))
        .json(&serde_json::json!({
            "start_on_login": start_on_login,
            "show_tray_icon": show_tray_icon,
            "telemetry": telemetry,
        }))
        .send()
        .await
        .map_err(|e| format!("Failed to save general settings: {e}"))?;

    if resp.status().is_success() {
        Ok(())
    } else {
        let body = resp.text().await.unwrap_or_default();
        Err(body)
    }
}

#[tauri::command]
pub async fn save_ai_settings(
    provider: String,
    api_key: String,
    model: String,
    url: Option<String>,
) -> Result<(), String> {
    let resp = client()
        .post(format!("{DAEMON_URL}/settings/ai"))
        .json(&serde_json::json!({
            "provider": provider,
            "api_key": api_key,
            "model": model,
            "url": url,
        }))
        .send()
        .await
        .map_err(|e| format!("Cannot reach daemon: {e}"))?;

    if resp.status().is_success() {
        Ok(())
    } else {
        let body = resp.text().await.unwrap_or_default();
        Err(body)
    }
}

#[tauri::command]
pub async fn get_ai_settings() -> Result<serde_json::Value, String> {
    get_json("/settings/ai").await
}

#[tauri::command]
pub async fn list_ai_models() -> Result<serde_json::Value, String> {
    get_json("/settings/ai/models").await
}

#[tauri::command]
pub async fn start_daemon(app: tauri::AppHandle) -> Result<String, String> {
    let dm = app.state::<Arc<daemon::DaemonManager>>();
    dm.start().await?;
    Ok("Daemon started".into())
}

#[tauri::command]
pub async fn stop_daemon(app: tauri::AppHandle) -> Result<String, String> {
    let dm = app.state::<Arc<daemon::DaemonManager>>();
    dm.stop_and_wait().await;
    Ok("Daemon stopped".into())
}

#[tauri::command]
pub async fn get_daemon_info() -> Result<serde_json::Value, String> {
    let log_path = orca_core::config::OrcaConfig::config_path()
        .parent()
        .map(|p| p.join("daemon.log"))
        .unwrap_or_default();
    let log_tail = std::fs::read_to_string(&log_path)
        .unwrap_or_default()
        .lines()
        .rev()
        .take(100)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");

    Ok(serde_json::json!({
        "binary_path": daemon::find_daemon_binary(),
        "port": 9477,
        "config_path": orca_core::config::OrcaConfig::config_path().to_string_lossy(),
        "log_path": log_path.to_string_lossy(),
        "log_tail": log_tail,
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

#[tauri::command]
pub async fn check_for_updates(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| format!("Updater not available: {e}"))?;

    match updater.check().await {
        Ok(Some(update)) => Ok(serde_json::json!({
            "available": true,
            "version": update.version,
            "body": update.body,
        })),
        Ok(None) => Ok(serde_json::json!({
            "available": false,
        })),
        Err(e) => Err(format!("Update check failed: {e}")),
    }
}

#[tauri::command]
pub async fn get_api_token() -> Result<String, String> {
    load_api_token().ok_or_else(|| "No API token configured".to_string())
}

#[tauri::command]
pub async fn write_temp_file(name: String, content: String) -> Result<String, String> {
    let dir = std::env::temp_dir();
    // Sanitize: use only the filename component, reject path traversal
    let safe_name = std::path::Path::new(&name)
        .file_name()
        .ok_or("Invalid filename")?
        .to_str()
        .ok_or("Invalid filename encoding")?;
    let path = dir.join(safe_name);
    std::fs::write(&path, &content).map_err(|e| format!("Failed to write temp file: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn open_file_in_browser(path: String) -> Result<(), String> {
    // Allow URLs
    if path.starts_with("http://") || path.starts_with("https://") {
        return open::that(&path).map_err(|e| format!("Failed to open URL: {e}"));
    }
    // For file paths, only allow temp directory
    let canonical = std::fs::canonicalize(&path)
        .map_err(|e| format!("Invalid path: {e}"))?;
    let temp_dir = std::env::temp_dir();
    if !canonical.starts_with(&temp_dir) {
        return Err("Access denied: only temp directory files can be opened".into());
    }
    open::that(&path).map_err(|e| format!("Failed to open file: {e}"))
}

#[tauri::command]
pub async fn reconnect_runtime() -> Result<serde_json::Value, String> {
    client()
        .post(format!("{DAEMON_URL}/settings/reconnect"))
        .send()
        .await
        .map_err(|e| format!("Reconnect failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Invalid response: {e}"))
}

#[tauri::command]
pub async fn cleanup(scope: String) -> Result<serde_json::Value, String> {
    const ALLOWED_SCOPES: &[&str] = &["containers", "images", "volumes", "networks", "build_cache", "all"];
    if !ALLOWED_SCOPES.contains(&scope.as_str()) {
        return Err(format!("Invalid cleanup scope: {scope}"));
    }
    client()
        .post(format!("{DAEMON_URL}/settings/cleanup"))
        .json(&serde_json::json!({ "scope": scope }))
        .send()
        .await
        .map_err(|e| format!("Cleanup failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Invalid response: {e}"))
}

#[tauri::command]
pub async fn read_file(path: String) -> Result<String, String> {
    // Only allow reading YAML files (compose files, etc.)
    let p = std::path::Path::new(&path);
    let fname = p.file_name()
        .and_then(|f| f.to_str())
        .unwrap_or("");
    if !(fname.ends_with(".yml") || fname.ends_with(".yaml")) {
        return Err("Only .yml/.yaml files can be read".to_string());
    }
    tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("Failed to read file: {e}"))
}

#[tauri::command]
pub async fn save_compose_file(path: String, content: String) -> Result<(), String> {
    // Validate the path points to a compose/yaml file
    let p = std::path::Path::new(&path);
    let fname = p.file_name()
        .and_then(|f| f.to_str())
        .unwrap_or("");
    if !(fname.ends_with(".yml") || fname.ends_with(".yaml")) {
        return Err("Only .yml/.yaml files can be saved".to_string());
    }
    // Basic validation: content must not be empty
    if content.trim().is_empty() {
        return Err("Content cannot be empty".to_string());
    }
    tokio::fs::write(&path, &content)
        .await
        .map_err(|e| format!("Failed to save compose file: {e}"))
}
