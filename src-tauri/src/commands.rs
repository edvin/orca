//! Tauri commands — callable from the frontend via `invoke()`.

use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct StatusInfo {
    pub daemon_running: bool,
    pub daemon_version: Option<String>,
    pub machine_name: Option<String>,
    pub machine_state: Option<String>,
    pub runtime: Option<String>,
}

#[tauri::command]
pub async fn get_status() -> Result<StatusInfo, String> {
    // TODO: Query the daemon
    Ok(StatusInfo {
        daemon_running: false,
        daemon_version: None,
        machine_name: None,
        machine_state: None,
        runtime: None,
    })
}

#[tauri::command]
pub async fn list_containers() -> Result<Vec<serde_json::Value>, String> {
    Ok(vec![])
}

#[tauri::command]
pub async fn list_images() -> Result<Vec<serde_json::Value>, String> {
    Ok(vec![])
}

#[tauri::command]
pub async fn list_volumes() -> Result<Vec<serde_json::Value>, String> {
    Ok(vec![])
}

#[tauri::command]
pub async fn get_machine_info() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "name": "default",
        "state": "stopped",
        "cpus": 2,
        "memory_mb": 4096,
        "disk_gb": 60,
        "runtime": "podman"
    }))
}
