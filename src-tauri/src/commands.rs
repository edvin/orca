//! Tauri commands — callable from the frontend via `invoke()`.
//! These proxy to the Orca daemon's HTTP API.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, RwLock};

use serde::Deserialize;
use tauri::Manager;

use crate::daemon;

/// Active port-forward tunnels, keyed by "namespace/service/port".
/// Each entry holds a tokio task handle that is aborted on drop.
struct TunnelHandle(tokio::task::JoinHandle<()>);

impl Drop for TunnelHandle {
    fn drop(&mut self) {
        self.0.abort();
    }
}

static PORT_FORWARDS: OnceLock<Mutex<HashMap<String, TunnelHandle>>> = OnceLock::new();

fn port_forward_map() -> &'static Mutex<HashMap<String, TunnelHandle>> {
    PORT_FORWARDS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Active log stream subscriptions, keyed by container ID.
/// Each entry holds a tokio task handle that is aborted on unsubscribe/drop.
struct LogStreamHandle(tokio::task::JoinHandle<()>);

impl Drop for LogStreamHandle {
    fn drop(&mut self) {
        self.0.abort();
    }
}

static LOG_STREAMS: OnceLock<Mutex<HashMap<String, LogStreamHandle>>> = OnceLock::new();

fn log_stream_map() -> &'static Mutex<HashMap<String, LogStreamHandle>> {
    LOG_STREAMS.get_or_init(|| Mutex::new(HashMap::new()))
}

const LOCAL_DAEMON_BASE: &str = "http://127.0.0.1:9477";

/// Override for the daemon URL when a remote host is selected.
/// Contains (base_url, token, tls_verify) when a remote host is active, None for local.
/// base_url is scheme://host:port — /api/v1 is always appended by daemon_url().
static DAEMON_URL_OVERRIDE: RwLock<Option<(String, String, bool)>> = RwLock::new(None);

/// Normalize a daemon URL to just scheme://host:port (strip any /api/v1 suffix).
fn normalize_daemon_url(url: &str) -> String {
    url.trim_end_matches('/')
        .trim_end_matches("/api/v1")
        .trim_end_matches('/')
        .to_string()
}

/// Returns the currently active daemon API URL (always ends with /api/v1).
fn daemon_url() -> String {
    if let Ok(guard) = DAEMON_URL_OVERRIDE.read() {
        if let Some((base, _, _)) = guard.as_ref() {
            return format!("{}/api/v1", normalize_daemon_url(base));
        }
    }
    format!("{LOCAL_DAEMON_BASE}/api/v1")
}

/// Returns the API token for the active host.
/// For remote hosts, returns the remote token; for local, reads from config.
fn active_api_token() -> Option<String> {
    if let Ok(guard) = DAEMON_URL_OVERRIDE.read() {
        if let Some((_, token, _)) = guard.as_ref() {
            return Some(token.clone());
        }
    }
    load_api_token()
}

/// Cached API token — loaded once from config, reused for local requests.
static API_TOKEN: OnceLock<Option<String>> = OnceLock::new();

/// Build a reqwest client with the API auth token pre-configured.
/// Uses active_api_token() which returns the remote token when a remote host is selected.
fn authed_client() -> reqwest::Client {
    authed_client_with_timeout(30)
}

/// Build an authed client with a custom timeout (in seconds).
/// Use this for long-running operations (image pull, K8s enable, AI queries, etc.)
/// Pass 0 for no timeout (useful for SSE streaming connections).
fn authed_client_with_timeout(timeout_secs: u64) -> reqwest::Client {
    let mut builder = reqwest::Client::builder().connect_timeout(std::time::Duration::from_secs(5));

    if timeout_secs > 0 {
        builder = builder.timeout(std::time::Duration::from_secs(timeout_secs));
    }

    // Check if we should skip TLS verification for the active remote host
    if let Ok(guard) = DAEMON_URL_OVERRIDE.read() {
        if let Some((_, _, tls_verify)) = guard.as_ref() {
            if !tls_verify {
                builder = builder.danger_accept_invalid_certs(true);
            }
        }
    }

    let mut headers = reqwest::header::HeaderMap::new();
    if let Some(token) = active_api_token() {
        if let Ok(val) = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}")) {
            headers.insert(reqwest::header::AUTHORIZATION, val);
        }
    }
    builder
        .default_headers(headers)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// Read the API token from the Orca config file (cached after first read).
fn load_api_token() -> Option<String> {
    API_TOKEN
        .get_or_init(|| orca_core::config::OrcaConfig::load().ok()?.api_token)
        .clone()
}

fn client() -> reqwest::Client {
    authed_client()
}

async fn get_json<T: for<'de> Deserialize<'de>>(path: &str) -> Result<T, String> {
    let base = daemon_url();
    let resp = client()
        .get(format!("{base}{path}"))
        .send()
        .await
        .map_err(|e| format!("Daemon connection failed: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(body);
    }

    resp.json::<T>().await.map_err(|e| format!("Invalid response: {e}"))
}

async fn post_empty(path: &str) -> Result<(), String> {
    let base = daemon_url();
    let resp = client()
        .post(format!("{base}{path}"))
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
    let base = daemon_url();
    let resp = client()
        .post(format!("{base}{path}"))
        .send()
        .await
        .map_err(|e| format!("Daemon connection failed: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(body);
    }

    resp.json().await.map_err(|e| format!("Invalid response: {e}"))
}

async fn patch_json(path: &str, body: &serde_json::Value) -> Result<serde_json::Value, String> {
    let base = daemon_url();
    let resp = client()
        .patch(format!("{base}{path}"))
        .json(body)
        .send()
        .await
        .map_err(|e| format!("Daemon connection failed: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(body);
    }

    resp.json().await.map_err(|e| format!("Invalid response: {e}"))
}

async fn delete(path: &str) -> Result<(), String> {
    let base = daemon_url();
    let resp = client()
        .delete(format!("{base}{path}"))
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
    let base = daemon_url();
    client()
        .post(format!("{base}/containers/{id}/exec"))
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
pub async fn rename_container(id: String, name: String) -> Result<(), String> {
    let base = daemon_url();
    let resp = client()
        .post(format!("{base}/containers/{id}/rename"))
        .json(&serde_json::json!({ "name": name }))
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

#[tauri::command]
pub async fn update_container(
    id: String,
    memory_limit: Option<String>,
    cpu_limit: Option<f64>,
    restart_policy: Option<String>,
) -> Result<serde_json::Value, String> {
    let base = daemon_url();
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
        .post(format!("{base}/containers/{id}/update"))
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
pub async fn container_logs(id: String, tail: Option<u32>) -> Result<Vec<String>, String> {
    let base = daemon_url();
    // Fetch logs as SSE, collect lines (non-streaming for Tauri command).
    // For follow mode we'd use Tauri events, but batch fetch is fine for initial view.
    let resp = client()
        .get(format!(
            "{base}/containers/{id}/logs?follow=false&tail={}",
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

/// Subscribe to live log streaming for a container via SSE.
/// Spawns a background task that emits "container-log-line" events.
#[tauri::command]
pub async fn subscribe_container_logs(app: tauri::AppHandle, id: String, tail: Option<u32>) -> Result<(), String> {
    use futures_util::StreamExt;
    use tauri::Emitter;

    // Abort any existing subscription for this container
    {
        let mut map = log_stream_map().lock().unwrap();
        map.remove(&id);
    }

    let base = daemon_url();
    let container_id = id.clone();
    let tail_n = tail.unwrap_or(500);

    let handle = tokio::spawn(async move {
        // Use no timeout for streaming
        let stream_client = authed_client_with_timeout(0);

        let resp = match stream_client
            .get(format!(
                "{base}/containers/{container_id}/logs?follow=true&tail={tail_n}"
            ))
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                let _ = app.emit(
                    "container-log-line",
                    serde_json::json!({
                        "containerId": container_id,
                        "line": format!("Error connecting to log stream: {e}"),
                    }),
                );
                return;
            }
        };

        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            let _ = app.emit(
                "container-log-line",
                serde_json::json!({
                    "containerId": container_id,
                    "line": format!("Log stream error: {body}"),
                }),
            );
            return;
        }

        let mut stream = resp.bytes_stream();
        let mut buffer = String::new();

        while let Some(chunk) = stream.next().await {
            let chunk = match chunk {
                Ok(c) => c,
                Err(_) => break,
            };
            buffer.push_str(&String::from_utf8_lossy(&chunk));

            while let Some(pos) = buffer.find('\n') {
                let line = buffer[..pos].trim().to_string();
                buffer = buffer[pos + 1..].to_string();

                if let Some(data) = line.strip_prefix("data:") {
                    let _ = app.emit(
                        "container-log-line",
                        serde_json::json!({
                            "containerId": container_id,
                            "line": data.to_string(),
                        }),
                    );
                }
            }
        }
    });

    let mut map = log_stream_map().lock().unwrap();
    map.insert(id, LogStreamHandle(handle));

    Ok(())
}

/// Unsubscribe from live log streaming for a container.
/// Aborts the background SSE task.
#[tauri::command]
pub async fn unsubscribe_container_logs(id: String) -> Result<(), String> {
    let mut map = log_stream_map().lock().unwrap();
    map.remove(&id); // Drop aborts the task
    Ok(())
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
    user: Option<String>,
) -> Result<serde_json::Value, String> {
    let base = daemon_url();
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
    if let Some(u) = user {
        if !u.is_empty() {
            body["user"] = serde_json::json!(u);
        }
    }

    // Create the container
    let create_resp = client()
        .post(format!("{base}/containers"))
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
pub async fn add_registry(server: String, name: String, username: String, password: String) -> Result<(), String> {
    let base = daemon_url();
    let resp = client()
        .post(format!("{base}/registries"))
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
    get_json(&format!("/images/search?q={}&limit=20", urlencoding::encode(&query))).await
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
    let base = daemon_url();
    let mut body = serde_json::json!({ "reference": reference });
    if let (Some(user), Some(pass)) = (username, password) {
        body["auth"] = serde_json::json!({
            "username": user,
            "password": pass,
        });
    }

    // Image pulls can take a long time — use extended timeout
    // Must use active_api_token() (not load_api_token()) to support remote hosts
    let pull_client = authed_client_with_timeout(600);

    let resp = pull_client
        .post(format!("{base}/images/pull"))
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

/// Streaming image pull — emits "pull-progress" events to the frontend as layers download.
#[tauri::command]
pub async fn pull_image_stream(
    app: tauri::AppHandle,
    reference: String,
    username: Option<String>,
    password: Option<String>,
) -> Result<(), String> {
    use tauri::Emitter;

    let base = daemon_url();
    let mut body = serde_json::json!({ "reference": reference });
    if let (Some(user), Some(pass)) = (username, password) {
        body["auth"] = serde_json::json!({ "username": user, "password": pass });
    }

    let pull_client = authed_client_with_timeout(600);

    let resp = pull_client
        .post(format!("{base}/images/pull"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Pull failed: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        let _ = app.emit("pull-progress", serde_json::json!({ "event": "error", "error": body }));
        return Err(body);
    }

    // Stream SSE events to frontend
    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();

    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Stream error: {e}"))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        // Process complete lines
        while let Some(pos) = buffer.find('\n') {
            let line = buffer[..pos].trim().to_string();
            buffer = buffer[pos + 1..].to_string();

            if let Some(data) = line.strip_prefix("data:") {
                if let Ok(event) = serde_json::from_str::<serde_json::Value>(data.trim()) {
                    let _ = app.emit(
                        "pull-progress",
                        serde_json::json!({
                            "event": "progress",
                            "layer": event.get("layer").and_then(|v| v.as_str()).unwrap_or(""),
                            "status": event.get("status").and_then(|v| v.as_str()).unwrap_or(""),
                            "current": event.get("current").and_then(|v| v.as_u64()).unwrap_or(0),
                            "total": event.get("total").and_then(|v| v.as_u64()).unwrap_or(0),
                        }),
                    );
                }
            } else if line.starts_with("event: done") {
                let _ = app.emit("pull-progress", serde_json::json!({ "event": "done" }));
            }
        }
    }

    // Final done event
    let _ = app.emit("pull-progress", serde_json::json!({ "event": "done" }));
    Ok(())
}

#[tauri::command]
pub async fn remove_image(id: String) -> Result<(), String> {
    delete(&format!("/images/{id}")).await
}

#[tauri::command]
pub async fn batch_delete_images(ids: Vec<String>, force: bool) -> Result<serde_json::Value, String> {
    let base = daemon_url();
    client()
        .post(format!("{base}/images/batch-delete"))
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
    let base = daemon_url();
    let resp = client()
        .post(format!("{base}/images/{}/tag", urlencoding::encode(&source)))
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
    let base = daemon_url();
    let resp = client()
        .post(format!("{base}/images/build"))
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
pub async fn create_volume(
    name: String,
    driver: Option<String>,
    labels: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    let base = daemon_url();
    client()
        .post(format!("{base}/volumes"))
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

#[tauri::command]
pub async fn volume_sizes() -> Result<serde_json::Value, String> {
    get_json("/volumes/sizes").await
}

// --- Container File Browsing ---

#[tauri::command]
pub async fn container_list_files(id: String, path: Option<String>) -> Result<serde_json::Value, String> {
    let encoded_id = urlencoding::encode(&id);
    let path_param = path
        .map(|p| format!("?path={}", urlencoding::encode(&p)))
        .unwrap_or_default();
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
    let base = daemon_url();
    client()
        .post(format!("{base}/containers/{}/commit", urlencoding::encode(&id)))
        .json(&serde_json::json!({ "repo": repo, "tag": tag.unwrap_or_else(|| "latest".into()) }))
        .send()
        .await
        .map_err(|e| format!("{e}"))?
        .json()
        .await
        .map_err(|e| format!("{e}"))
}

// --- Images (inspect) ---

#[tauri::command]
pub async fn inspect_image(id: String) -> Result<serde_json::Value, String> {
    get_json(&format!("/images/{id}")).await
}

#[tauri::command]
pub async fn image_history(id: String) -> Result<serde_json::Value, String> {
    get_json(&format!("/images/{}/history", urlencoding::encode(&id))).await
}

#[tauri::command]
pub async fn image_list_files(id: String, path: Option<String>) -> Result<serde_json::Value, String> {
    let encoded_id = urlencoding::encode(&id);
    let path_param = path
        .map(|p| format!("?path={}", urlencoding::encode(&p)))
        .unwrap_or_default();
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
    let base = daemon_url();
    client()
        .post(format!("{base}/images/import"))
        .json(&serde_json::json!({ "path": path }))
        .timeout(std::time::Duration::from_secs(300))
        .send()
        .await
        .map_err(|e| format!("{e}"))?
        .json()
        .await
        .map_err(|e| format!("{e}"))
}

// --- Container Export (tar) ---

#[tauri::command]
pub async fn export_container_tar(id: String, path: String) -> Result<serde_json::Value, String> {
    let base = daemon_url();
    let encoded = urlencoding::encode(&id);
    let client = authed_client_with_timeout(600);
    let resp = client
        .get(format!("{base}/containers/{encoded}/export/tar"))
        .query(&[("path", &path)])
        .send()
        .await
        .map_err(|e| format!("Export failed: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Export failed: {body}"));
    }

    resp.json().await.map_err(|e| format!("Invalid response: {e}"))
}

// --- Image Save (tar) ---

#[tauri::command]
pub async fn save_image_tar(id: String, path: String) -> Result<serde_json::Value, String> {
    let base = daemon_url();
    let encoded = urlencoding::encode(&id);
    let client = authed_client_with_timeout(600);
    let resp = client
        .get(format!("{base}/images/{encoded}/save"))
        .query(&[("path", &path)])
        .send()
        .await
        .map_err(|e| format!("Save failed: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Save failed: {body}"));
    }

    resp.json().await.map_err(|e| format!("Invalid response: {e}"))
}

// --- Image Scanning ---

#[tauri::command]
pub async fn scan_image(id: String) -> Result<serde_json::Value, String> {
    let base = daemon_url();
    // Trivy scans can take a while — use a longer timeout
    let client = authed_client_with_timeout(600);

    let encoded = urlencoding::encode(&id);
    let resp = client
        .get(format!("{base}/images/{encoded}/scan"))
        .send()
        .await
        .map_err(|e| format!("Scan failed: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Scan failed: {body}"));
    }

    resp.json().await.map_err(|e| format!("Invalid scan response: {e}"))
}

// --- Networks ---

#[tauri::command]
pub async fn list_networks() -> Result<serde_json::Value, String> {
    get_json("/networks").await
}

#[tauri::command]
pub async fn create_network(name: String, driver: Option<String>) -> Result<serde_json::Value, String> {
    let base = daemon_url();
    client()
        .post(format!("{base}/networks"))
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
pub async fn compose_deploy_path(path: String) -> Result<serde_json::Value, String> {
    let base = daemon_url();
    let resp = authed_client_with_timeout(120)
        .post(format!("{base}/stacks/deploy"))
        .json(&serde_json::json!({ "path": path }))
        .send()
        .await
        .map_err(|e| format!("{e}"))?;
    if !resp.status().is_success() {
        return Err(resp.text().await.unwrap_or_default());
    }
    resp.json().await.map_err(|e| format!("{e}"))
}

#[tauri::command]
pub async fn validate_compose(path: String) -> Result<serde_json::Value, String> {
    let base = daemon_url();
    let resp = authed_client()
        .post(format!("{base}/stacks/validate"))
        .json(&serde_json::json!({ "path": path }))
        .send()
        .await
        .map_err(|e| format!("{e}"))?;
    if !resp.status().is_success() {
        return Err(resp.text().await.unwrap_or_default());
    }
    resp.json().await.map_err(|e| format!("{e}"))
}

#[tauri::command]
pub async fn compose_down(name: String) -> Result<serde_json::Value, String> {
    post_json(&format!("/stacks/{name}/down")).await
}

#[tauri::command]
pub async fn compose_pull(name: String) -> Result<serde_json::Value, String> {
    post_json(&format!("/stacks/{name}/pull")).await
}

#[tauri::command]
pub async fn update_stack_env(name: String, key: String, value: String) -> Result<(), String> {
    patch_json(
        &format!("/stacks/{name}/env"),
        &serde_json::json!({ "key": key, "value": value }),
    )
    .await?;
    Ok(())
}

// --- Events ---

/// Subscribe to daemon events. Returns recent events and triggers
/// Tauri event emissions for real-time updates.
#[tauri::command]
pub async fn subscribe_events(app: tauri::AppHandle) -> Result<(), String> {
    let base = daemon_url();
    use tauri::Emitter;

    let resp = client()
        .get(format!("{base}/events"))
        .send()
        .await
        .map_err(|e| format!("Failed to connect to event stream: {e}"))?;

    tokio::spawn(async move {
        use tokio::io::AsyncBufReadExt;
        use tokio_stream::StreamExt;

        let stream = resp.bytes_stream();
        let mapped = stream.map(|r| r.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e)));
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
    let base = daemon_url();
    // K8s setup can take several minutes — use a long timeout
    let long_client = authed_client_with_timeout(600);

    long_client
        .post(format!("{base}/k8s/enable"))
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
pub async fn k8s_start() -> Result<(), String> {
    post_empty("/k8s/start").await
}

#[tauri::command]
pub async fn k8s_reset() -> Result<(), String> {
    post_empty("/k8s/reset").await
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
pub async fn k8s_scale_deployment(namespace: String, name: String, replicas: u32) -> Result<(), String> {
    let base = daemon_url();
    let resp = client()
        .post(format!("{base}/k8s/deployments/{namespace}/{name}/scale"))
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
        let _base = daemon_url();
        String::new()
    } else {
        format!("?{}", query_parts.join("&"))
    };

    get_json(&format!("/k8s/pods/{namespace}/{name}/logs{query}")).await
}

#[tauri::command]
pub async fn k8s_apply_yaml(yaml: String) -> Result<serde_json::Value, String> {
    let base = daemon_url();
    client()
        .post(format!("{base}/k8s/apply"))
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
    "pod",
    "pods",
    "service",
    "services",
    "svc",
    "deployment",
    "deployments",
    "deploy",
    "statefulset",
    "statefulsets",
    "sts",
    "daemonset",
    "daemonsets",
    "ds",
    "replicaset",
    "replicasets",
    "rs",
    "job",
    "jobs",
    "cronjob",
    "cronjobs",
    "cj",
    "configmap",
    "configmaps",
    "cm",
    "secret",
    "secrets",
    "ingress",
    "ingresses",
    "ing",
    "persistentvolumeclaim",
    "persistentvolumeclaims",
    "pvc",
    "persistentvolume",
    "persistentvolumes",
    "pv",
    "namespace",
    "namespaces",
    "ns",
    "node",
    "nodes",
    "serviceaccount",
    "serviceaccounts",
    "sa",
    "role",
    "roles",
    "rolebinding",
    "rolebindings",
    "clusterrole",
    "clusterroles",
    "clusterrolebinding",
    "clusterrolebindings",
    "networkpolicy",
    "networkpolicies",
    "netpol",
    "horizontalpodautoscaler",
    "horizontalpodautoscalers",
    "hpa",
    "endpoint",
    "endpoints",
    "ep",
    "event",
    "events",
    "ev",
    "storageclass",
    "storageclasses",
    "sc",
    "customresourcedefinition",
    "customresourcedefinitions",
    "crd",
    "crds",
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

    let base = daemon_url();
    let resp = client()
        .get(format!("{base}/k8s/yaml/{kind}/{namespace}/{name}"))
        .send()
        .await
        .map_err(|e| format!("Failed to get YAML: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(body);
    }

    resp.text().await.map_err(|e| format!("Failed to read response: {e}"))
}

#[tauri::command]
pub async fn k8s_events(namespace: String) -> Result<serde_json::Value, String> {
    validate_k8s_name(&namespace)?;
    get_json(&format!("/k8s/events/{namespace}")).await
}

#[tauri::command]
pub async fn k8s_create_namespace(name: String) -> Result<(), String> {
    let base = daemon_url();
    validate_k8s_name(&name)?;
    let resp = client()
        .post(format!("{base}/k8s/namespaces"))
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
pub async fn k8s_create_secret(
    namespace: String,
    name: String,
    data: serde_json::Value,
    secret_type: Option<String>,
) -> Result<(), String> {
    let base = daemon_url();
    validate_k8s_name(&namespace)?;
    validate_k8s_name(&name)?;
    let resp = client()
        .post(format!("{base}/k8s/secrets/{namespace}"))
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
    let base = daemon_url();
    validate_k8s_name(&namespace)?;
    validate_k8s_name(&name)?;
    let resp = client()
        .put(format!("{base}/k8s/secrets/{namespace}/{name}"))
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
pub async fn k8s_create_pvc(
    namespace: String,
    name: String,
    storage_class: String,
    size: String,
    access_modes: Vec<String>,
) -> Result<(), String> {
    let base = daemon_url();
    validate_k8s_name(&namespace)?;
    validate_k8s_name(&name)?;
    let resp = client()
        .post(format!("{base}/k8s/pvcs/{namespace}"))
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
pub async fn k8s_rollout_history(namespace: String, name: String) -> Result<serde_json::Value, String> {
    get_json(&format!("/k8s/deployments/{namespace}/{name}/history")).await
}

#[tauri::command]
pub async fn k8s_rollout_undo(
    namespace: String,
    name: String,
    revision: Option<u32>,
) -> Result<serde_json::Value, String> {
    let base = daemon_url();
    client()
        .post(format!("{base}/k8s/deployments/{namespace}/{name}/rollback"))
        .json(&serde_json::json!({ "revision": revision }))
        .send()
        .await
        .map_err(|e| format!("Rollback failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Invalid response: {e}"))
}

// --- K8s DaemonSets / StatefulSets / ReplicaSets ---

#[tauri::command]
pub async fn k8s_daemonsets(namespace: String) -> Result<serde_json::Value, String> {
    validate_k8s_name(&namespace)?;
    get_json(&format!("/k8s/daemonsets/{namespace}")).await
}

#[tauri::command]
pub async fn k8s_statefulsets(namespace: String) -> Result<serde_json::Value, String> {
    validate_k8s_name(&namespace)?;
    get_json(&format!("/k8s/statefulsets/{namespace}")).await
}

#[tauri::command]
pub async fn k8s_replicasets(namespace: String) -> Result<serde_json::Value, String> {
    validate_k8s_name(&namespace)?;
    get_json(&format!("/k8s/replicasets/{namespace}")).await
}

#[tauri::command]
pub async fn k8s_scale_statefulset(namespace: String, name: String, replicas: u32) -> Result<(), String> {
    let base = daemon_url();
    let resp = client()
        .post(format!("{base}/k8s/statefulsets/{namespace}/{name}/scale"))
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
pub async fn k8s_restart_statefulset(namespace: String, name: String) -> Result<(), String> {
    post_empty(&format!("/k8s/statefulsets/{namespace}/{name}/restart")).await
}

#[tauri::command]
pub async fn k8s_delete_daemonset(namespace: String, name: String) -> Result<(), String> {
    validate_k8s_name(&namespace)?;
    validate_k8s_name(&name)?;
    delete(&format!("/k8s/daemonsets/{namespace}/{name}")).await
}

#[tauri::command]
pub async fn k8s_delete_statefulset(namespace: String, name: String) -> Result<(), String> {
    validate_k8s_name(&namespace)?;
    validate_k8s_name(&name)?;
    delete(&format!("/k8s/statefulsets/{namespace}/{name}")).await
}

#[tauri::command]
pub async fn k8s_delete_replicaset(namespace: String, name: String) -> Result<(), String> {
    validate_k8s_name(&namespace)?;
    validate_k8s_name(&name)?;
    delete(&format!("/k8s/replicasets/{namespace}/{name}")).await
}

// --- K8s HPAs, Network Policies, Storage Classes, CRDs ---

#[tauri::command]
pub async fn k8s_hpas(namespace: String) -> Result<serde_json::Value, String> {
    validate_k8s_name(&namespace)?;
    get_json(&format!("/k8s/hpas/{namespace}")).await
}

#[tauri::command]
pub async fn k8s_create_hpa(
    namespace: String,
    name: String,
    deployment: String,
    min: i32,
    max: i32,
    cpu_target: i32,
) -> Result<serde_json::Value, String> {
    let base = daemon_url();
    validate_k8s_name(&namespace)?;
    validate_k8s_name(&name)?;
    validate_k8s_name(&deployment)?;
    client()
        .post(format!("{base}/k8s/hpas/{namespace}"))
        .json(&serde_json::json!({
            "name": name,
            "deployment": deployment,
            "min": min,
            "max": max,
            "cpu_target": cpu_target,
        }))
        .send()
        .await
        .map_err(|e| format!("Create HPA failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Invalid response: {e}"))
}

#[tauri::command]
pub async fn k8s_delete_hpa(namespace: String, name: String) -> Result<(), String> {
    validate_k8s_name(&namespace)?;
    validate_k8s_name(&name)?;
    delete(&format!("/k8s/hpas/{namespace}/{name}")).await
}

#[tauri::command]
pub async fn k8s_network_policies(namespace: String) -> Result<serde_json::Value, String> {
    validate_k8s_name(&namespace)?;
    get_json(&format!("/k8s/network-policies/{namespace}")).await
}

#[tauri::command]
pub async fn k8s_delete_network_policy(namespace: String, name: String) -> Result<(), String> {
    validate_k8s_name(&namespace)?;
    validate_k8s_name(&name)?;
    delete(&format!("/k8s/network-policies/{namespace}/{name}")).await
}

#[tauri::command]
pub async fn k8s_storage_classes() -> Result<serde_json::Value, String> {
    get_json("/k8s/storage-classes").await
}

#[tauri::command]
pub async fn k8s_crds() -> Result<serde_json::Value, String> {
    get_json("/k8s/crds").await
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
    let base = daemon_url();
    validate_k8s_name(&namespace)?;
    validate_k8s_name(&name)?;
    client()
        .post(format!("{base}/k8s/cronjobs/{namespace}/{name}/trigger"))
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
    let base = daemon_url();
    validate_k8s_name(&namespace)?;
    validate_k8s_name(&name)?;
    client()
        .put(format!("{base}/k8s/cronjobs/{namespace}/{name}/suspend"))
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
    let base = daemon_url();
    client()
        .post(format!("{base}/k8s/helm/uninstall"))
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
    let base = daemon_url();
    client()
        .post(format!("{base}/k8s/helm/install"))
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

// --- K8s Port Forwarding (WebSocket tunnel) ---

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
    let address: &str = if expose.unwrap_or(false) {
        "0.0.0.0"
    } else {
        "127.0.0.1"
    };

    {
        let map = port_forward_map().lock().map_err(|e| format!("{e}"))?;
        if map.contains_key(&key) {
            return Ok(serde_json::json!({ "status": "already_running", "port": local }));
        }
    }

    // Build the WebSocket tunnel URL from the daemon URL
    let base_url = daemon_url();
    let token = active_api_token().unwrap_or_default();
    let ws_base = base_url.replace("https://", "wss://").replace("http://", "ws://");
    let target_host = format!("{service}.{namespace}.svc.cluster.local");

    let tls_verify = DAEMON_URL_OVERRIDE
        .read()
        .map(|g| g.as_ref().map(|(_, _, v)| *v).unwrap_or(true))
        .unwrap_or(true);

    // Bind local TCP listener
    let listener = tokio::net::TcpListener::bind((address, local))
        .await
        .map_err(|e| format!("Failed to bind port {local}: {e}"))?;

    let task = tokio::spawn(async move {
        loop {
            let (tcp_stream, _) = match listener.accept().await {
                Ok(conn) => conn,
                Err(_) => break,
            };
            let url = format!(
                "{ws_base}/tunnel?host={}&port={}&token={}",
                urlencoding::encode(&target_host),
                port,
                urlencoding::encode(&token),
            );
            let tls_v = tls_verify;
            tokio::spawn(async move {
                if let Err(e) = proxy_tcp_to_ws(tcp_stream, &url, tls_v).await {
                    tracing::warn!("Tunnel proxy error: {e}");
                }
            });
        }
    });

    port_forward_map()
        .lock()
        .map_err(|e| format!("{e}"))?
        .insert(key, TunnelHandle(task));

    Ok(serde_json::json!({ "status": "started", "port": local, "mode": "tunnel" }))
}

/// Proxy a single TCP connection bidirectionally through a WebSocket tunnel.
async fn proxy_tcp_to_ws(tcp_stream: tokio::net::TcpStream, ws_url: &str, _tls_verify: bool) -> Result<(), String> {
    use futures_util::{SinkExt as _, StreamExt as _};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio_tungstenite::tungstenite::Message as WsMessage;

    let (ws_stream, _) = tokio_tungstenite::connect_async(ws_url)
        .await
        .map_err(|e| format!("WebSocket connect failed: {e}"))?;

    let (mut ws_sender, mut ws_receiver) = ws_stream.split();
    let (mut tcp_read, mut tcp_write) = tcp_stream.into_split();

    // TCP → WebSocket
    let tcp_to_ws = tokio::spawn(async move {
        let mut buf = vec![0u8; 32768];
        loop {
            match tcp_read.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => {
                    if ws_sender
                        .send(WsMessage::Binary(buf[..n].to_vec().into()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = ws_sender.close().await;
    });

    // WebSocket → TCP
    let ws_to_tcp = tokio::spawn(async move {
        while let Some(Ok(msg)) = ws_receiver.next().await {
            match msg {
                WsMessage::Binary(data) => {
                    if tcp_write.write_all(&data).await.is_err() {
                        break;
                    }
                }
                WsMessage::Close(_) => break,
                _ => {}
            }
        }
    });

    tokio::select! {
        _ = tcp_to_ws => {},
        _ = ws_to_tcp => {},
    }
    Ok(())
}

#[tauri::command]
pub async fn k8s_stop_port_forward(namespace: String, service: String, port: u16) -> Result<(), String> {
    validate_k8s_name(&namespace)?;
    validate_k8s_name(&service)?;
    let key = format!("{namespace}/{service}/{port}");
    let mut map = port_forward_map().lock().map_err(|e| format!("{e}"))?;
    map.remove(&key); // Drop triggers task.abort()
    Ok(())
}

#[tauri::command]
pub async fn k8s_list_port_forwards() -> Result<serde_json::Value, String> {
    let map = port_forward_map().lock().map_err(|e| format!("{e}"))?;
    let forwards: Vec<serde_json::Value> = map
        .keys()
        .map(|k| {
            let parts: Vec<&str> = k.split('/').collect();
            serde_json::json!({
                "namespace": parts.first().unwrap_or(&""),
                "service": parts.get(1).unwrap_or(&""),
                "port": parts.get(2).unwrap_or(&""),
            })
        })
        .collect();
    Ok(serde_json::json!(forwards))
}

// --- System Health ---

#[tauri::command]
pub async fn system_health() -> Result<serde_json::Value, String> {
    get_json("/system/health").await
}

#[tauri::command]
pub async fn host_uid() -> Result<serde_json::Value, String> {
    get_json("/system/host-uid").await
}

// --- Environment ---

#[tauri::command]
pub async fn env_status() -> Result<serde_json::Value, String> {
    get_json("/environment/status").await
}

#[tauri::command]
pub async fn env_fix(action: String) -> Result<serde_json::Value, String> {
    let base = daemon_url();
    // Fix actions can take minutes (install Homebrew, Lima, Docker, etc.)
    let long_client = authed_client_with_timeout(600);
    long_client
        .post(format!("{base}/environment/fix"))
        .json(&serde_json::json!({ "action": action }))
        .send()
        .await
        .map_err(|e| format!("Fix action failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Invalid response: {e}"))
}

/// Streaming fix action — emits "env-fix-line" events via Tauri as each line arrives.
/// Returns immediately; frontend listens for events.
#[tauri::command]
pub async fn env_fix_stream(app: tauri::AppHandle, action: String) -> Result<(), String> {
    let base = daemon_url();
    use tauri::Emitter;

    let client = authed_client_with_timeout(600);

    // Spawn the SSE reader in a background task
    tokio::spawn(async move {
        let resp = match client
            .post(format!("{base}/environment/fix-stream"))
            .json(&serde_json::json!({ "action": action }))
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                let _ = app.emit("env-fix-line", format!("Connection error: {e}"));
                let _ = app.emit("env-fix-done", "error");
                return;
            }
        };

        use futures_util::StreamExt;
        let mut stream = resp.bytes_stream();
        let mut buffer = String::new();

        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(bytes) => {
                    buffer.push_str(&String::from_utf8_lossy(&bytes));
                    // Process complete SSE lines
                    while let Some(newline_pos) = buffer.find('\n') {
                        let line = buffer[..newline_pos].to_string();
                        buffer = buffer[newline_pos + 1..].to_string();

                        if let Some(data) = line.strip_prefix("data: ") {
                            if data == "[DONE]" {
                                let _ = app.emit("env-fix-done", "success");
                                return;
                            } else if data == "[ERROR]" {
                                let _ = app.emit("env-fix-done", "error");
                                return;
                            } else {
                                let _ = app.emit("env-fix-line", data.to_string());
                            }
                        }
                    }
                }
                Err(e) => {
                    let _ = app.emit("env-fix-line", format!("Stream error: {e}"));
                    let _ = app.emit("env-fix-done", "error");
                    return;
                }
            }
        }
        // Stream ended without [DONE]
        let _ = app.emit("env-fix-done", "success");
    });

    Ok(())
}

// --- Templates ---

#[tauri::command]
pub async fn list_templates() -> Result<serde_json::Value, String> {
    get_json("/templates").await
}

#[tauri::command]
pub async fn refresh_templates() -> Result<serde_json::Value, String> {
    let base = daemon_url();
    let resp = client()
        .post(format!("{base}/templates/refresh"))
        .send()
        .await
        .map_err(|e| format!("{e}"))?;
    resp.json().await.map_err(|e| format!("{e}"))
}

#[tauri::command]
pub async fn deploy_template(
    id: String,
    name: Option<String>,
    ports: Option<Vec<String>>,
    env: Option<Vec<String>>,
    volumes: Option<Vec<String>>,
    compose_yaml: Option<String>,
) -> Result<serde_json::Value, String> {
    let base = daemon_url();
    let resp = client()
        .post(format!("{base}/templates/{id}/deploy"))
        .json(&serde_json::json!({
            "name": name,
            "ports": ports,
            "env": env,
            "volumes": volumes,
            "compose_yaml": compose_yaml,
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

    resp.json().await.map_err(|e| format!("Invalid response: {e}"))
}

/// Build an authed reqwest client for a specific host (does NOT use the global override).
fn client_for_host(url: &str, token: &str, tls_verify: bool, timeout_secs: u64) -> reqwest::Client {
    let mut builder = reqwest::Client::builder().connect_timeout(std::time::Duration::from_secs(5));

    if timeout_secs > 0 {
        builder = builder.timeout(std::time::Duration::from_secs(timeout_secs));
    }

    if !tls_verify {
        builder = builder.danger_accept_invalid_certs(true);
    }

    let mut headers = reqwest::header::HeaderMap::new();
    if let Ok(val) = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}")) {
        headers.insert(reqwest::header::AUTHORIZATION, val);
    }
    let _ = url; // url is used by caller, not embedded in client
    builder
        .default_headers(headers)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

#[tauri::command]
pub async fn deploy_template_to_hosts(
    id: String,
    name: Option<String>,
    ports: Option<Vec<String>>,
    env: Option<Vec<String>>,
    volumes: Option<Vec<String>>,
    compose_yaml: Option<String>,
    host_ids: Vec<String>,
) -> Result<serde_json::Value, String> {
    let config = orca_core::config::OrcaConfig::load().map_err(|e| format!("{e}"))?;
    let body = serde_json::json!({
        "name": name,
        "ports": ports,
        "env": env,
        "volumes": volumes,
        "compose_yaml": compose_yaml,
    });

    let mut results: Vec<serde_json::Value> = Vec::new();

    for host_id in &host_ids {
        if host_id == "__local__" {
            // Deploy to local daemon
            let base_url = format!("{LOCAL_DAEMON_BASE}/api/v1");
            let token = load_api_token().unwrap_or_default();
            let http = client_for_host(LOCAL_DAEMON_BASE, &token, true, 120);

            // Pull image first
            let pull_result = http
                .post(format!("{base_url}/images/pull"))
                .json(&serde_json::json!({ "reference": &id }))
                .send()
                .await;
            let _pull_ok = pull_result.map(|r| r.status().is_success()).unwrap_or(false);

            let resp = http
                .post(format!("{base_url}/templates/{id}/deploy"))
                .json(&body)
                .send()
                .await;
            match resp {
                Ok(r) if r.status().is_success() => {
                    let data: serde_json::Value = r.json().await.unwrap_or(serde_json::json!({}));
                    results.push(serde_json::json!({
                        "host_id": "__local__",
                        "host_name": "Local",
                        "success": true,
                        "result": data,
                    }));
                }
                Ok(r) => {
                    let body_text = r.text().await.unwrap_or_default();
                    let msg = serde_json::from_str::<serde_json::Value>(&body_text)
                        .ok()
                        .and_then(|v| v.get("error").and_then(|e| e.as_str().map(String::from)))
                        .unwrap_or(body_text);
                    results.push(serde_json::json!({
                        "host_id": "__local__",
                        "host_name": "Local",
                        "success": false,
                        "error": msg,
                    }));
                }
                Err(e) => {
                    results.push(serde_json::json!({
                        "host_id": "__local__",
                        "host_name": "Local",
                        "success": false,
                        "error": format!("{e}"),
                    }));
                }
            }
        } else {
            // Deploy to a remote host
            let host = config.remote_hosts.iter().find(|h| &h.id == host_id);
            let Some(host) = host else {
                results.push(serde_json::json!({
                    "host_id": host_id,
                    "host_name": "Unknown",
                    "success": false,
                    "error": "Host not found in config",
                }));
                continue;
            };
            let base_url = format!("{}/api/v1", normalize_daemon_url(&host.url));
            let http = client_for_host(&host.url, &host.token, host.tls_verify, 120);

            // Pull image first (best effort)
            let _pull = http
                .post(format!("{base_url}/images/pull"))
                .json(&serde_json::json!({ "reference": &id }))
                .send()
                .await;

            let resp = http
                .post(format!("{base_url}/templates/{id}/deploy"))
                .json(&body)
                .send()
                .await;
            match resp {
                Ok(r) if r.status().is_success() => {
                    let data: serde_json::Value = r.json().await.unwrap_or(serde_json::json!({}));
                    results.push(serde_json::json!({
                        "host_id": host.id,
                        "host_name": host.name,
                        "success": true,
                        "result": data,
                    }));
                }
                Ok(r) => {
                    let body_text = r.text().await.unwrap_or_default();
                    let msg = serde_json::from_str::<serde_json::Value>(&body_text)
                        .ok()
                        .and_then(|v| v.get("error").and_then(|e| e.as_str().map(String::from)))
                        .unwrap_or(body_text);
                    results.push(serde_json::json!({
                        "host_id": host.id,
                        "host_name": host.name,
                        "success": false,
                        "error": msg,
                    }));
                }
                Err(e) => {
                    results.push(serde_json::json!({
                        "host_id": host.id,
                        "host_name": host.name,
                        "success": false,
                        "error": format!("{e}"),
                    }));
                }
            }
        }
    }

    let successes = results.iter().filter(|r| r["success"].as_bool() == Some(true)).count();
    let failures = results.len() - successes;
    Ok(serde_json::json!({
        "results": results,
        "total": results.len(),
        "successes": successes,
        "failures": failures,
    }))
}

#[tauri::command]
pub async fn save_user_template(template: serde_json::Value) -> Result<serde_json::Value, String> {
    let base = daemon_url();
    client()
        .post(format!("{base}/templates/user"))
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
    let base = daemon_url();
    client()
        .delete(format!("{base}/templates/user?id={id}"))
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
    let base = daemon_url();
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
    let ai_client = authed_client_with_timeout(300);

    let resp = ai_client
        .post(format!("{base}/ai/ask"))
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

    resp.json().await.map_err(|e| format!("Invalid response: {e}"))
}

// --- WSL2 Config (Windows) ---

#[tauri::command]
pub async fn get_wsl_config() -> Result<serde_json::Value, String> {
    let userprofile =
        std::env::var("USERPROFILE").map_err(|_| "USERPROFILE environment variable not set".to_string())?;
    let config_path = std::path::Path::new(&userprofile).join(".wslconfig");

    let mut memory = String::new();
    let mut processors = String::new();
    let mut swap = String::new();

    if config_path.exists() {
        let content = std::fs::read_to_string(&config_path).map_err(|e| format!("Failed to read .wslconfig: {e}"))?;

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
    if val.is_empty() {
        return Ok(());
    }
    if val.contains('\n') || val.contains('\r') || val.contains('=') || val.contains('[') {
        return Err(format!("Invalid value: {val}"));
    }
    if allow_unit {
        // e.g. "4GB", "512MB", "2"
        let numeric_end = val.find(|c: char| !c.is_ascii_digit()).unwrap_or(val.len());
        if numeric_end == 0 {
            return Err(format!("Invalid value: {val}"));
        }
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

    let userprofile =
        std::env::var("USERPROFILE").map_err(|_| "USERPROFILE environment variable not set".to_string())?;
    let config_path = std::path::Path::new(&userprofile).join(".wslconfig");

    // Read existing config and preserve non-wsl2 sections
    let existing = if config_path.exists() {
        std::fs::read_to_string(&config_path).map_err(|e| format!("Failed to read .wslconfig: {e}"))?
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
pub async fn save_general_settings(start_on_login: bool, show_tray_icon: bool, telemetry: bool) -> Result<(), String> {
    let base = daemon_url();
    let resp = client()
        .post(format!("{base}/settings/general"))
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

// --- Lima VM Settings ---

#[tauri::command]
pub async fn get_lima_settings() -> Result<serde_json::Value, String> {
    get_json("/settings/lima").await
}

#[tauri::command]
pub async fn save_lima_settings(
    name: String,
    cpus: u32,
    memory_gib: u32,
    disk_gib: u32,
) -> Result<serde_json::Value, String> {
    let base = daemon_url();
    let long_client = authed_client_with_timeout(600);
    long_client
        .post(format!("{base}/settings/lima"))
        .json(&serde_json::json!({ "name": name, "cpus": cpus, "memory_gib": memory_gib, "disk_gib": disk_gib }))
        .send()
        .await
        .map_err(|e| format!("Lima settings failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Invalid response: {e}"))
}

#[tauri::command]
pub async fn save_ai_settings(
    provider: String,
    api_key: String,
    model: String,
    url: Option<String>,
) -> Result<(), String> {
    let base = daemon_url();
    let resp = client()
        .post(format!("{base}/settings/ai"))
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
pub async fn get_ca_certificate() -> Result<String, String> {
    let base = daemon_url();
    let resp = reqwest::Client::new()
        .get(format!("{base}/ca/certificate"))
        .send()
        .await
        .map_err(|e| format!("Failed to fetch CA certificate: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Daemon returned status {}", resp.status()));
    }
    resp.text()
        .await
        .map_err(|e| format!("Failed to read CA certificate: {e}"))
}

#[tauri::command]
pub async fn get_ca_info() -> Result<serde_json::Value, String> {
    get_json("/ca/info").await
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
    // For file paths, only allow temp directory.
    // Canonicalize both paths to handle Windows UNC prefixes (\\?\)
    let canonical = std::fs::canonicalize(&path).map_err(|e| format!("Invalid path: {e}"))?;
    let temp_dir = std::fs::canonicalize(std::env::temp_dir()).unwrap_or_else(|_| std::env::temp_dir());
    if !canonical.starts_with(&temp_dir) {
        return Err(format!(
            "Access denied: only temp directory files can be opened (got: {}, temp: {})",
            canonical.display(),
            temp_dir.display()
        ));
    }
    open::that(&path).map_err(|e| format!("Failed to open file: {e}"))
}

#[tauri::command]
pub async fn reconnect_runtime() -> Result<serde_json::Value, String> {
    let base = daemon_url();
    client()
        .post(format!("{base}/settings/reconnect"))
        .send()
        .await
        .map_err(|e| format!("Reconnect failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Invalid response: {e}"))
}

#[tauri::command]
pub async fn cleanup(scope: String) -> Result<serde_json::Value, String> {
    let base = daemon_url();
    const ALLOWED_SCOPES: &[&str] = &["containers", "images", "volumes", "networks", "build_cache", "all"];
    if !ALLOWED_SCOPES.contains(&scope.as_str()) {
        return Err(format!("Invalid cleanup scope: {scope}"));
    }
    client()
        .post(format!("{base}/settings/cleanup"))
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
    let fname = p.file_name().and_then(|f| f.to_str()).unwrap_or("");
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
    let fname = p.file_name().and_then(|f| f.to_str()).unwrap_or("");
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

#[tauri::command]
pub async fn check_ports(ports: Vec<u16>) -> Result<serde_json::Value, String> {
    // Skip port check for remote hosts — we can't check remote ports from here
    if DAEMON_URL_OVERRIDE.read().map(|g| g.is_some()).unwrap_or(false) {
        return Ok(serde_json::json!({ "conflicts": [] }));
    }
    let mut conflicts = Vec::new();
    for port in &ports {
        // Try to bind — if it fails, the port is in use
        match std::net::TcpListener::bind(("127.0.0.1", *port)) {
            Ok(_) => {} // Port is available (listener drops immediately)
            Err(_) => conflicts.push(*port),
        }
    }
    Ok(serde_json::json!({ "conflicts": conflicts }))
}

// --- Remote Host Management ---

#[tauri::command]
pub async fn list_remote_hosts() -> Result<Vec<serde_json::Value>, String> {
    let config = orca_core::config::OrcaConfig::load().map_err(|e| format!("{e}"))?;
    Ok(config
        .remote_hosts
        .iter()
        .map(|h| {
            serde_json::json!({
                "id": h.id,
                "name": h.name,
                "url": h.url,
                "tls_verify": h.tls_verify,
                "tags": h.tags,
            })
        })
        .collect())
}

#[tauri::command]
pub async fn add_remote_host(
    name: String,
    url: String,
    token: String,
    tls_verify: bool,
    tags: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    let mut config = orca_core::config::OrcaConfig::load().map_err(|e| format!("{e}"))?;
    // Generate a unique ID from timestamp + simple hash
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let id = format!("{:x}{:04x}", now.as_millis(), now.subsec_nanos() & 0xFFFF);
    // Normalize URL: store just scheme://host:port (daemon_url() appends /api/v1)
    let url = normalize_daemon_url(&url);
    config.remote_hosts.push(orca_core::config::RemoteHost {
        id: id.clone(),
        name,
        url,
        token,
        tls_verify,
        tags: tags.unwrap_or_default(),
    });
    config.save().map_err(|e| format!("{e}"))?;
    Ok(serde_json::json!({ "id": id }))
}

#[tauri::command]
pub async fn update_remote_host(
    id: String,
    name: String,
    url: String,
    token: String,
    tls_verify: bool,
    tags: Option<Vec<String>>,
) -> Result<(), String> {
    let mut config = orca_core::config::OrcaConfig::load().map_err(|e| format!("{e}"))?;
    let host = config
        .remote_hosts
        .iter_mut()
        .find(|h| h.id == id)
        .ok_or("Host not found")?;
    // Normalize URL: store just scheme://host:port (daemon_url() appends /api/v1)
    let url = normalize_daemon_url(&url);
    host.name = name;
    host.url = url;
    // If token is "__KEEP__", preserve the existing token
    if token != "__KEEP__" {
        host.token = token;
    }
    host.tls_verify = tls_verify;
    if let Some(t) = tags {
        host.tags = t;
    }
    config.save().map_err(|e| format!("{e}"))?;

    // If this host is currently active, update the override
    if let Ok(guard) = DAEMON_URL_OVERRIDE.read() {
        if guard.is_some() {
            drop(guard);
            // Re-apply the override with updated values
            let host = config.remote_hosts.iter().find(|h| h.id == id).unwrap();
            if let Ok(mut w) = DAEMON_URL_OVERRIDE.write() {
                *w = Some((host.url.clone(), host.token.clone(), host.tls_verify));
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn remove_remote_host(id: String) -> Result<(), String> {
    let mut config = orca_core::config::OrcaConfig::load().map_err(|e| format!("{e}"))?;
    // Find the URL of the host being removed before we drop it
    let removed_url = config.remote_hosts.iter().find(|h| h.id == id).map(|h| h.url.clone());
    config.remote_hosts.retain(|h| h.id != id);
    config.save().map_err(|e| format!("{e}"))?;
    // Only switch back to local if the removed host was the active one
    if let Some(removed_url) = removed_url {
        if let Ok(mut guard) = DAEMON_URL_OVERRIDE.write() {
            if let Some((active_url, _, _)) = guard.as_ref() {
                if *active_url == removed_url {
                    *guard = None;
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn switch_host(id: Option<String>) -> Result<serde_json::Value, String> {
    if let Some(id) = id {
        let config = orca_core::config::OrcaConfig::load().map_err(|e| format!("{e}"))?;
        let host = config
            .remote_hosts
            .iter()
            .find(|h| h.id == id)
            .ok_or("Host not found")?;
        let mut guard = DAEMON_URL_OVERRIDE.write().map_err(|e| format!("{e}"))?;
        *guard = Some((host.url.clone(), host.token.clone(), host.tls_verify));
        Ok(serde_json::json!({ "host": host.name, "url": host.url }))
    } else {
        let mut guard = DAEMON_URL_OVERRIDE.write().map_err(|e| format!("{e}"))?;
        *guard = None;
        Ok(serde_json::json!({ "host": "Local", "url": LOCAL_DAEMON_BASE }))
    }
}

#[tauri::command]
pub async fn get_active_host() -> Result<serde_json::Value, String> {
    if let Ok(guard) = DAEMON_URL_OVERRIDE.read() {
        if let Some((url, _, _)) = guard.as_ref() {
            // Find the matching host name from config
            if let Ok(config) = orca_core::config::OrcaConfig::load() {
                if let Some(host) = config.remote_hosts.iter().find(|h| &h.url == url) {
                    return Ok(serde_json::json!({
                        "id": host.id,
                        "name": host.name,
                        "url": host.url,
                        "is_remote": true,
                    }));
                }
            }
            return Ok(serde_json::json!({
                "id": null,
                "name": "Remote",
                "url": url,
                "is_remote": true,
            }));
        }
    }
    Ok(serde_json::json!({
        "id": null,
        "name": "Local",
        "url": LOCAL_DAEMON_BASE,
        "is_remote": false,
    }))
}

#[tauri::command]
pub async fn test_remote_host(url: String, token: String, tls_verify: bool) -> Result<serde_json::Value, String> {
    // Normalize to scheme://host:port then append /api/v1
    let base = format!("{}/api/v1", normalize_daemon_url(&url));

    let mut builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .connect_timeout(std::time::Duration::from_secs(5));
    if !tls_verify {
        builder = builder.danger_accept_invalid_certs(true);
    }
    let client = builder.build().unwrap_or_else(|_| reqwest::Client::new());
    // Test connectivity (health endpoint — no auth required)
    let health_resp = client
        .get(format!("{base}/health"))
        .send()
        .await
        .map_err(|e| format!("Connection failed: {e}"))?;
    let health: serde_json::Value = health_resp.json().await.map_err(|e| format!("Invalid response: {e}"))?;

    // Test authentication (containers endpoint — requires valid token)
    let auth_resp = client
        .get(format!("{base}/containers"))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| format!("Auth test failed: {e}"))?;

    let auth_ok = auth_resp.status().is_success();
    let version = health.get("version").and_then(|v| v.as_str()).unwrap_or("unknown");

    if !auth_ok {
        return Err(format!(
            "Connected to daemon v{version}, but authentication failed. Check your API token."
        ));
    }

    Ok(serde_json::json!({
        "status": "ok",
        "version": version,
        "authenticated": true,
    }))
}

/// Probe a host (local or remote) to gather health, container, and image data.
/// For remote hosts, pass the host ID. For local, pass None.
#[tauri::command]
pub async fn probe_host(host_id: Option<String>) -> Result<serde_json::Value, String> {
    let (url, token, tls_verify) = if let Some(ref id) = host_id {
        let config = orca_core::config::OrcaConfig::load().map_err(|e| format!("{e}"))?;
        let host = config
            .remote_hosts
            .iter()
            .find(|h| h.id == *id)
            .ok_or("Host not found")?;
        (host.url.clone(), host.token.clone(), host.tls_verify)
    } else {
        // Local host
        let token = load_api_token().unwrap_or_default();
        (LOCAL_DAEMON_BASE.to_string(), token, true)
    };

    let mut builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .connect_timeout(std::time::Duration::from_secs(5));
    if !tls_verify {
        builder = builder.danger_accept_invalid_certs(true);
    }
    let client = builder.build().unwrap_or_else(|_| reqwest::Client::new());

    // Health check
    let api_url = format!("{}/api/v1", normalize_daemon_url(&url));
    let health = client
        .get(format!("{api_url}/health"))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| format!("{e}"))?
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("{e}"))?;

    // System health (resources)
    let system = match client
        .get(format!("{url}/system/health"))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
    {
        Ok(resp) => resp.json::<serde_json::Value>().await.ok(),
        Err(_) => None,
    };

    // Container list
    let containers = match client
        .get(format!("{url}/containers"))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
    {
        Ok(resp) => resp.json::<Vec<serde_json::Value>>().await.ok(),
        Err(_) => None,
    };

    let running = containers.as_ref().map(|c| {
        c.iter()
            .filter(|c| c.get("state").and_then(|s| s.as_str()) == Some("Running"))
            .count()
    });
    let total = containers.as_ref().map(|c| c.len());

    // Images count
    let images_total = match client
        .get(format!("{url}/images"))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
    {
        Ok(resp) => resp.json::<Vec<serde_json::Value>>().await.ok().map(|v| v.len()),
        Err(_) => None,
    };

    Ok(serde_json::json!({
        "online": true,
        "version": health.get("version").and_then(|v| v.as_str()),
        "docker_connected": system.as_ref().and_then(|s| s.get("docker_connected").and_then(|v| v.as_bool())),
        "cpu_count": system.as_ref().and_then(|s| s["system_resources"]["cpu_count"].as_u64()),
        "memory_total": system.as_ref().and_then(|s| s["system_resources"]["memory_total_bytes"].as_u64()),
        "memory_available": system.as_ref().and_then(|s| s["system_resources"]["memory_available_bytes"].as_u64()),
        "disk_usage_percent": system.as_ref().and_then(|s| s["system_resources"]["disk_usage_percent"].as_f64()),
        "containers_running": running,
        "containers_total": total,
        "images_total": images_total,
        "os": system.as_ref().and_then(|s| s.get("os").and_then(|v| v.as_str())),
        "arch": system.as_ref().and_then(|s| s.get("arch").and_then(|v| v.as_str())),
    }))
}

/// Probe all configured hosts (local + remote) for health status.
/// Returns a lightweight list of { id, name, online, version } for fleet monitoring.
#[tauri::command]
pub async fn probe_all_hosts() -> Result<Vec<serde_json::Value>, String> {
    let config = orca_core::config::OrcaConfig::load().map_err(|e| format!("{e}"))?;

    // Two clients: one that verifies TLS, one that doesn't
    let verify_client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .connect_timeout(std::time::Duration::from_secs(3))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let noverify_client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .connect_timeout(std::time::Duration::from_secs(3))
        .danger_accept_invalid_certs(true)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let mut results = Vec::new();

    // Check local daemon (always verify — it's localhost)
    let local_token = load_api_token().unwrap_or_default();
    let local_result = verify_client
        .get(format!("{LOCAL_DAEMON_BASE}/api/v1/health"))
        .header("Authorization", format!("Bearer {local_token}"))
        .send()
        .await;
    let (local_online, local_version) = match local_result {
        Ok(resp) => {
            if let Ok(json) = resp.json::<serde_json::Value>().await {
                (true, json.get("version").and_then(|v| v.as_str()).map(String::from))
            } else {
                (true, None)
            }
        }
        Err(_) => (false, None),
    };
    results.push(serde_json::json!({
        "id": serde_json::Value::Null,
        "name": "Local",
        "online": local_online,
        "version": local_version,
    }));

    // Check each remote host, respecting tls_verify per host
    for host in &config.remote_hosts {
        let client = if host.tls_verify {
            &verify_client
        } else {
            &noverify_client
        };
        let resp = client
            .get(format!("{}/health", host.url))
            .header("Authorization", format!("Bearer {}", host.token))
            .send()
            .await;
        let (online, version) = match resp {
            Ok(r) => {
                if r.status().is_success() {
                    if let Ok(json) = r.json::<serde_json::Value>().await {
                        (true, json.get("version").and_then(|v| v.as_str()).map(String::from))
                    } else {
                        (true, None)
                    }
                } else {
                    (false, None)
                }
            }
            Err(_) => (false, None),
        };
        results.push(serde_json::json!({
            "id": host.id,
            "name": host.name,
            "online": online,
            "version": version,
        }));
    }

    Ok(results)
}

// --- Host Comparison ---

/// Compare two or more hosts side-by-side: fetch containers, images, and system health for each.
/// host_ids contains host IDs (or null for local).
#[tauri::command]
pub async fn compare_hosts(host_ids: Vec<Option<String>>) -> Result<serde_json::Value, String> {
    let config = orca_core::config::OrcaConfig::load().map_err(|e| format!("{e}"))?;
    let local_token = load_api_token().unwrap_or_default();

    let mut host_results = Vec::new();

    for host_id in &host_ids {
        let (url, token, tls_verify, name) = if let Some(id) = host_id {
            let host = config
                .remote_hosts
                .iter()
                .find(|h| h.id == *id)
                .ok_or_else(|| format!("Host not found: {id}"))?;
            (host.url.clone(), host.token.clone(), host.tls_verify, host.name.clone())
        } else {
            (
                LOCAL_DAEMON_BASE.to_string(),
                local_token.clone(),
                true,
                "Local".to_string(),
            )
        };

        let mut builder = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .connect_timeout(std::time::Duration::from_secs(5));
        if !tls_verify {
            builder = builder.danger_accept_invalid_certs(true);
        }
        let client = builder.build().unwrap_or_else(|_| reqwest::Client::new());
        let api_url = format!("{}/api/v1", normalize_daemon_url(&url));

        // Fetch containers
        let containers = match client
            .get(format!("{api_url}/containers"))
            .header("Authorization", format!("Bearer {token}"))
            .send()
            .await
        {
            Ok(resp) => resp
                .json::<serde_json::Value>()
                .await
                .ok()
                .unwrap_or(serde_json::json!([])),
            Err(_) => serde_json::json!([]),
        };

        // Fetch images
        let images = match client
            .get(format!("{api_url}/images"))
            .header("Authorization", format!("Bearer {token}"))
            .send()
            .await
        {
            Ok(resp) => resp
                .json::<serde_json::Value>()
                .await
                .ok()
                .unwrap_or(serde_json::json!([])),
            Err(_) => serde_json::json!([]),
        };

        // Fetch system health
        let health = match client
            .get(format!("{api_url}/system/health"))
            .header("Authorization", format!("Bearer {token}"))
            .send()
            .await
        {
            Ok(resp) => resp
                .json::<serde_json::Value>()
                .await
                .ok()
                .unwrap_or(serde_json::json!({})),
            Err(_) => serde_json::json!({}),
        };

        host_results.push(serde_json::json!({
            "id": host_id,
            "name": name,
            "containers": containers,
            "images": images,
            "health": health,
        }));
    }

    Ok(serde_json::json!({ "hosts": host_results }))
}

// --- Auto-Deploy Rules ---

#[tauri::command]
pub async fn list_deploy_rules() -> Result<serde_json::Value, String> {
    get_json("/deploy/rules").await
}

#[tauri::command]
pub async fn save_deploy_rule(
    id: Option<String>,
    name: String,
    image_pattern: String,
    tag_filter: Option<String>,
    container_names: Option<Vec<String>>,
    webhook_secret: Option<String>,
    enabled: Option<bool>,
) -> Result<serde_json::Value, String> {
    let base = daemon_url();
    let body = serde_json::json!({
        "id": id,
        "name": name,
        "image_pattern": image_pattern,
        "tag_filter": tag_filter.unwrap_or_default(),
        "container_names": container_names.unwrap_or_default(),
        "webhook_secret": webhook_secret,
        "enabled": enabled.unwrap_or(true),
    });
    let resp = client()
        .post(format!("{base}/deploy/rules"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("{e}"))?;
    if !resp.status().is_success() {
        return Err(resp.text().await.unwrap_or_default());
    }
    resp.json().await.map_err(|e| format!("{e}"))
}

#[tauri::command]
pub async fn delete_deploy_rule(id: String) -> Result<(), String> {
    delete(&format!("/deploy/rules/{id}")).await
}

#[tauri::command]
pub async fn list_deploy_history() -> Result<serde_json::Value, String> {
    get_json("/deploy/history").await
}

#[tauri::command]
pub async fn test_deploy_webhook(image: String, tag: String) -> Result<serde_json::Value, String> {
    let base = daemon_url();
    let resp = client()
        .post(format!("{base}/deploy/test"))
        .json(&serde_json::json!({ "image": image, "tag": tag }))
        .send()
        .await
        .map_err(|e| format!("{e}"))?;
    if !resp.status().is_success() {
        return Err(resp.text().await.unwrap_or_default());
    }
    resp.json().await.map_err(|e| format!("{e}"))
}

#[tauri::command]
pub async fn save_webhook_secret(secret: Option<String>) -> Result<(), String> {
    let base = daemon_url();
    let resp = client()
        .post(format!("{base}/deploy/webhook-secret"))
        .json(&serde_json::json!({ "secret": secret }))
        .send()
        .await
        .map_err(|e| format!("{e}"))?;
    if !resp.status().is_success() {
        return Err(resp.text().await.unwrap_or_default());
    }
    Ok(())
}

#[tauri::command]
pub async fn get_webhook_url() -> Result<String, String> {
    let base = daemon_url();
    Ok(format!("{base}/webhooks/github"))
}

/// Returns the base URL and auth token for the active daemon.
/// Used by frontend for direct fetch() calls (SSE streaming, etc.)
#[tauri::command]
pub async fn get_daemon_base() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "url": daemon_url(),
        "token": active_api_token().unwrap_or_default(),
    }))
}

/// Returns a WebSocket URL for the active daemon with the auth token as query param.
/// Converts http(s) to ws(s) and appends the given path + token.
#[tauri::command]
pub async fn get_daemon_ws_url(path: String) -> Result<String, String> {
    let base = daemon_url();
    let ws_base = base.replace("https://", "wss://").replace("http://", "ws://");
    let token = active_api_token().unwrap_or_default();
    Ok(format!("{ws_base}{path}?token={}", urlencoding::encode(&token)))
}

// --- Scheduled Actions ---

#[tauri::command]
pub async fn list_schedules() -> Result<serde_json::Value, String> {
    get_json("/schedules").await
}

#[tauri::command]
pub async fn save_schedule(
    id: Option<String>,
    name: String,
    container: String,
    action: String,
    cron: String,
    enabled: Option<bool>,
) -> Result<serde_json::Value, String> {
    let base = daemon_url();
    let body = serde_json::json!({
        "id": id,
        "name": name,
        "container": container,
        "action": action,
        "cron": cron,
        "enabled": enabled.unwrap_or(true),
    });
    let resp = client()
        .post(format!("{base}/schedules"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("{e}"))?;
    if !resp.status().is_success() {
        return Err(resp.text().await.unwrap_or_default());
    }
    resp.json().await.map_err(|e| format!("{e}"))
}

#[tauri::command]
pub async fn delete_schedule(id: String) -> Result<(), String> {
    delete(&format!("/schedules/{id}")).await
}

// --- Docker Hub Tag Autocomplete ---

#[tauri::command]
pub async fn fetch_image_tags(image: String) -> Result<Vec<String>, String> {
    let image = image.trim().to_string();
    if image.is_empty() {
        return Ok(vec![]);
    }

    // Determine namespace/repo for Docker Hub API
    let (namespace, repo) = if image.contains('/') {
        let parts: Vec<&str> = image.splitn(2, '/').collect();
        (parts[0].to_string(), parts[1].to_string())
    } else {
        ("library".to_string(), image.clone())
    };

    let url = format!(
        "https://hub.docker.com/v2/repositories/{}/{}/tags?page_size=20&ordering=last_updated",
        urlencoding::encode(&namespace),
        urlencoding::encode(&repo),
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("{e}"))?;

    let resp = client
        .get(&url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch tags: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Docker Hub returned {}", resp.status()));
    }

    let body: serde_json::Value = resp.json().await.map_err(|e| format!("{e}"))?;

    let tags: Vec<String> = body
        .get("results")
        .and_then(|r| r.as_array())
        .map(|results| {
            results
                .iter()
                .filter_map(|entry| entry.get("name").and_then(|n| n.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default();

    Ok(tags)
}

// --- Gateway ---

#[tauri::command]
pub async fn gateway_status() -> Result<serde_json::Value, String> {
    get_json("/gateway/status").await
}

#[tauri::command]
pub async fn gateway_start() -> Result<serde_json::Value, String> {
    let base = daemon_url();
    let resp = authed_client_with_timeout(120)
        .post(format!("{base}/gateway/start"))
        .send()
        .await
        .map_err(|e| format!("Daemon connection failed: {e}"))?;
    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(body);
    }
    resp.json().await.map_err(|e| format!("Invalid response: {e}"))
}

#[tauri::command]
pub async fn gateway_stop() -> Result<(), String> {
    post_empty("/gateway/stop").await
}

#[tauri::command]
pub async fn gateway_list_routes() -> Result<serde_json::Value, String> {
    get_json("/gateway/routes").await
}

#[tauri::command]
pub async fn gateway_add_route(
    hostname: String,
    container_name: String,
    port: u16,
    path: Option<String>,
) -> Result<serde_json::Value, String> {
    let base = daemon_url();
    let resp = client()
        .post(format!("{base}/gateway/routes"))
        .json(&serde_json::json!({
            "hostname": hostname,
            "container_name": container_name,
            "port": port,
            "path": path,
        }))
        .send()
        .await
        .map_err(|e| format!("Daemon connection failed: {e}"))?;
    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(body);
    }
    resp.json().await.map_err(|e| format!("Invalid response: {e}"))
}

#[tauri::command]
pub async fn gateway_remove_route(hostname: String) -> Result<(), String> {
    delete(&format!("/gateway/routes/{hostname}")).await
}

#[tauri::command]
pub async fn gateway_update_route(
    hostname: String,
    container_name: String,
    port: u16,
    enabled: bool,
) -> Result<(), String> {
    let base = daemon_url();
    let resp = client()
        .put(format!("{base}/gateway/routes/{hostname}"))
        .json(&serde_json::json!({
            "container_name": container_name,
            "port": port,
            "enabled": enabled,
        }))
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

#[tauri::command]
pub async fn gateway_check_ports(http_port: Option<u16>, https_port: Option<u16>) -> Result<serde_json::Value, String> {
    let hp = http_port.unwrap_or(80);
    let hp2 = https_port.unwrap_or(443);
    get_json(&format!("/gateway/port-check?http_port={hp}&https_port={hp2}")).await
}

#[tauri::command]
pub async fn gateway_get_config() -> Result<serde_json::Value, String> {
    get_json("/gateway/config").await
}

#[tauri::command]
pub async fn gateway_update_config(
    domain: String,
    http_port: u16,
    https_port: u16,
    tls_mode: String,
    custom_cert: Option<String>,
    custom_key: Option<String>,
) -> Result<(), String> {
    let base = daemon_url();
    let resp = client()
        .put(format!("{base}/gateway/config"))
        .json(&serde_json::json!({
            "domain": domain,
            "http_port": http_port,
            "https_port": https_port,
            "tls_mode": tls_mode,
            "custom_cert": custom_cert,
            "custom_key": custom_key,
        }))
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

#[tauri::command]
pub async fn gateway_get_links() -> Result<serde_json::Value, String> {
    get_json("/gateway/links").await
}

#[tauri::command]
pub async fn gateway_update_links(links: serde_json::Value) -> Result<(), String> {
    let base = daemon_url();
    let resp = client()
        .put(format!("{base}/gateway/links"))
        .json(&links)
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
