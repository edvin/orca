//! Tauri commands — callable from the frontend via `invoke()`.
//! These proxy to the Orca daemon's HTTP API.

use serde::Deserialize;

const DAEMON_URL: &str = "http://127.0.0.1:9477/api/v1";

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
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// Read the API token from the Orca config file.
fn load_api_token() -> Option<String> {
    let config = orca_core::config::OrcaConfig::load().ok()?;
    config.api_token
}

fn client() -> reqwest::Client {
    authed_client()
}

async fn get_json<T: for<'de> Deserialize<'de>>(path: &str) -> Result<T, String> {
    client()
        .get(format!("{DAEMON_URL}{path}"))
        .send()
        .await
        .map_err(|e| format!("Daemon connection failed: {e}"))?
        .json::<T>()
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
        Err(format!("Request failed: {body}"))
    }
}

async fn post_json(path: &str) -> Result<serde_json::Value, String> {
    client()
        .post(format!("{DAEMON_URL}{path}"))
        .send()
        .await
        .map_err(|e| format!("Daemon connection failed: {e}"))?
        .json()
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
        Err(format!("Request failed: {body}"))
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

    // Create the container
    let create_resp = client()
        .post(format!("{DAEMON_URL}/containers"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to create container: {e}"))?;

    if !create_resp.status().is_success() {
        let err_body = create_resp.text().await.unwrap_or_default();
        return Err(format!("Failed to create container: {err_body}"));
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

    let resp = client()
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
pub async fn build_image(
    context_path: String,
    dockerfile: Option<String>,
    tag: Option<String>,
) -> Result<serde_json::Value, String> {
    let resp = client()
        .post(format!("{DAEMON_URL}/images/build"))
        .json(&serde_json::json!({
            "context_path": context_path,
            "dockerfile": dockerfile,
            "tag": tag,
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

// --- Images (inspect) ---

#[tauri::command]
pub async fn inspect_image(id: String) -> Result<serde_json::Value, String> {
    get_json(&format!("/images/{id}")).await
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
    post_json("/k8s/enable").await
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
        Err(format!("Scale failed: {body}"))
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
