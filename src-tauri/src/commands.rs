//! Tauri commands — callable from the frontend via `invoke()`.
//! These proxy to the Vessel daemon's HTTP API.

use serde::Deserialize;

const DAEMON_URL: &str = "http://127.0.0.1:9477/api/v1";

fn client() -> reqwest::Client {
    reqwest::Client::new()
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

// --- Images ---

#[tauri::command]
pub async fn list_images() -> Result<serde_json::Value, String> {
    get_json("/images").await
}

#[tauri::command]
pub async fn pull_image(reference: String) -> Result<serde_json::Value, String> {
    let resp = client()
        .post(format!("{DAEMON_URL}/images/pull"))
        .json(&serde_json::json!({ "reference": reference }))
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

// --- Volumes ---

#[tauri::command]
pub async fn list_volumes() -> Result<serde_json::Value, String> {
    get_json("/volumes").await
}

#[tauri::command]
pub async fn remove_volume(name: String) -> Result<(), String> {
    delete(&format!("/volumes/{name}")).await
}

// --- Networks ---

#[tauri::command]
pub async fn list_networks() -> Result<serde_json::Value, String> {
    get_json("/networks").await
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
        let stream = resp.bytes_stream();
        let reader = tokio_util::io::StreamReader::new(
            stream.map(|r| r.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))),
        );
        let mut lines = reader.lines();

        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(data) = line.strip_prefix("data:") {
                if let Ok(event) = serde_json::from_str::<serde_json::Value>(data) {
                    let _ = app.emit("vessel-event", &event);
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
