//! Tauri commands — callable from the frontend via `invoke()`.
//! These proxy to the Orca daemon's HTTP API.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, RwLock};

use serde::Deserialize;
use tauri::Manager;

use crate::daemon;

/// A rustls certificate verifier that accepts any certificate. Used ONLY
/// when the user has explicitly opted a remote host into "skip TLS verify"
/// (e.g. self-signed-cert lab setups).
#[derive(Debug)]
struct DangerousNoopCertVerifier {
    supported: rustls::crypto::WebPkiSupportedAlgorithms,
}

impl DangerousNoopCertVerifier {
    fn new() -> Self {
        // Use the ring provider's algorithm list; installing a process-wide
        // CryptoProvider is not required as long as we build a ClientConfig
        // that carries its own provider via `builder_with_provider`.
        let provider = rustls::crypto::ring::default_provider();
        Self {
            supported: provider.signature_verification_algorithms,
        }
    }
}

impl rustls::client::danger::ServerCertVerifier for DangerousNoopCertVerifier {
    fn verify_server_cert(
        &self,
        _end: &rustls::pki_types::CertificateDer<'_>,
        _ints: &[rustls::pki_types::CertificateDer<'_>],
        _sn: &rustls::pki_types::ServerName<'_>,
        _ocsp: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        m: &[u8],
        c: &rustls::pki_types::CertificateDer<'_>,
        s: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(m, c, s, &self.supported)
    }

    fn verify_tls13_signature(
        &self,
        m: &[u8],
        c: &rustls::pki_types::CertificateDer<'_>,
        s: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(m, c, s, &self.supported)
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.supported.supported_schemes()
    }
}

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

/// Rewrite `docker-desktop://` URLs to `orca://` URLs in output text.
fn rewrite_docker_desktop_urls(text: &str) -> String {
    text.replace("docker-desktop://dashboard/build/", "orca://build/")
        .replace("docker-desktop://", "orca://")
}

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

async fn get_text(path: &str) -> Result<String, String> {
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

    resp.text().await.map_err(|e| format!("Invalid response: {e}"))
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
    get_json(&format!("/containers/{}", urlencoding::encode(&id))).await
}

#[tauri::command]
pub async fn container_stats(id: String) -> Result<serde_json::Value, String> {
    get_json(&format!("/containers/{}/stats", urlencoding::encode(&id))).await
}

#[tauri::command]
pub async fn start_container(id: String) -> Result<(), String> {
    post_empty(&format!("/containers/{}/start", urlencoding::encode(&id))).await
}

#[tauri::command]
pub async fn stop_container(id: String) -> Result<(), String> {
    post_empty(&format!("/containers/{}/stop", urlencoding::encode(&id))).await
}

#[tauri::command]
pub async fn exec_container(
    id: String,
    command: Vec<String>,
    workdir: Option<String>,
) -> Result<serde_json::Value, String> {
    let base = daemon_url();
    client()
        .post(format!("{base}/containers/{}/exec", urlencoding::encode(&id)))
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
    delete(&format!("/containers/{}", urlencoding::encode(&id))).await
}

#[tauri::command]
pub async fn rename_container(id: String, name: String) -> Result<(), String> {
    let base = daemon_url();
    let resp = client()
        .post(format!("{base}/containers/{}/rename", urlencoding::encode(&id)))
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
        .post(format!("{base}/containers/{}/update", urlencoding::encode(&id)))
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
    let resp: serde_json::Value = get_json(&format!("/containers/{}/export/run", urlencoding::encode(&id))).await?;
    resp.get("command")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "Missing command in response".to_string())
}

#[tauri::command]
pub async fn export_compose(id: String) -> Result<String, String> {
    let resp: serde_json::Value = get_json(&format!("/containers/{}/export/compose", urlencoding::encode(&id))).await?;
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
            "{base}/containers/{}/logs?follow=false&tail={}",
            urlencoding::encode(&id),
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
        let mut map = log_stream_map().lock().map_err(|e| format!("Lock poisoned: {e}"))?;
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
                "{base}/containers/{}/logs?follow=true&tail={tail_n}",
                urlencoding::encode(&container_id),
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

    let mut map = log_stream_map().lock().map_err(|e| format!("Lock poisoned: {e}"))?;
    map.insert(id, LogStreamHandle(handle));

    Ok(())
}

/// Unsubscribe from live log streaming for a container.
/// Aborts the background SSE task.
#[tauri::command]
pub async fn unsubscribe_container_logs(id: String) -> Result<(), String> {
    let mut map = log_stream_map().lock().map_err(|e| format!("Lock poisoned: {e}"))?;
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

    // Start the container. URL-encode the id to match the rest of this
    // file — in the wild container names can contain characters (like
    // `/`) that would otherwise create spurious extra path segments.
    post_empty(&format!("/containers/{}/start", urlencoding::encode(container_id))).await?;

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
    delete(&format!("/images/{}", urlencoding::encode(&id))).await
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
                v.get("stream")
                    .and_then(|s| s.as_str())
                    .map(|s| rewrite_docker_desktop_urls(s))
            }
        })
        .collect();

    let has_error = logs.iter().any(|l| l.starts_with("ERROR:"));
    Ok(serde_json::json!({
        "success": !has_error,
        "logs": logs,
    }))
}

// --- Builds ---

#[tauri::command]
pub async fn list_builds() -> Result<serde_json::Value, String> {
    get_json("/builds").await
}

#[tauri::command]
pub async fn get_build(id: String) -> Result<serde_json::Value, String> {
    get_json(&format!("/builds/{}", urlencoding::encode(&id))).await
}

#[tauri::command]
pub async fn get_build_logs(id: String) -> Result<String, String> {
    get_text(&format!("/builds/{}/logs", urlencoding::encode(&id))).await
}

#[tauri::command]
pub async fn delete_build(id: String) -> Result<(), String> {
    delete(&format!("/builds/{}", urlencoding::encode(&id))).await
}

#[tauri::command]
pub async fn get_build_stats() -> Result<serde_json::Value, String> {
    get_json("/builds/stats").await
}

#[tauri::command]
pub async fn build_from_url(source_url: String, tag: Option<String>) -> Result<serde_json::Value, String> {
    let base = daemon_url();
    let resp = client()
        .post(format!("{base}/builds/from-url"))
        .json(&serde_json::json!({
            "source_url": source_url,
            "tag": tag,
        }))
        .send()
        .await
        .map_err(|e| format!("Build from URL failed: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(body);
    }

    resp.json().await.map_err(|e| format!("Invalid response: {e}"))
}

#[tauri::command]
pub async fn compare_builds(id1: String, id2: String) -> Result<serde_json::Value, String> {
    let base = daemon_url();
    let body = serde_json::json!({ "id1": id1, "id2": id2 });
    let resp = client()
        .post(format!("{base}/builds/compare"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Daemon connection failed: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(body);
    }

    resp.json().await.map_err(|e| format!("Invalid response: {e}"))
}

// --- Build Targets ---

#[tauri::command]
pub async fn list_build_targets() -> Result<serde_json::Value, String> {
    get_json("/builds/targets").await
}

#[tauri::command]
pub async fn start_build_target(name: String) -> Result<serde_json::Value, String> {
    post_json(&format!("/builds/targets/{}", urlencoding::encode(&name))).await
}

// --- Volumes ---

#[tauri::command]
pub async fn list_volumes() -> Result<serde_json::Value, String> {
    get_json("/volumes").await
}

#[tauri::command]
pub async fn remove_volume(name: String) -> Result<(), String> {
    delete(&format!("/volumes/{}", urlencoding::encode(&name))).await
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
    get_json(&format!("/volumes/{}/files{query}", urlencoding::encode(&name))).await
}

#[tauri::command]
pub async fn volume_read_file(name: String, path: String) -> Result<serde_json::Value, String> {
    get_json(&format!(
        "/volumes/{}/file?path={}",
        urlencoding::encode(&name),
        urlencoding::encode(&path)
    ))
    .await
}

#[tauri::command]
pub async fn volume_containers(name: String) -> Result<serde_json::Value, String> {
    get_json(&format!("/volumes/{}/containers", urlencoding::encode(&name))).await
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
    get_json(&format!("/images/{}", urlencoding::encode(&id))).await
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
    delete(&format!("/networks/{}", urlencoding::encode(&name))).await
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
    get_json(&format!("/stacks/{}", urlencoding::encode(&name))).await
}

#[tauri::command]
pub async fn start_stack(name: String) -> Result<(), String> {
    post_empty(&format!("/stacks/{}/start", urlencoding::encode(&name))).await
}

#[tauri::command]
pub async fn stop_stack(name: String) -> Result<(), String> {
    post_empty(&format!("/stacks/{}/stop", urlencoding::encode(&name))).await
}

#[tauri::command]
pub async fn restart_stack(name: String) -> Result<(), String> {
    post_empty(&format!("/stacks/{}/restart", urlencoding::encode(&name))).await
}

#[tauri::command]
pub async fn compose_up(name: String) -> Result<serde_json::Value, String> {
    post_json(&format!("/stacks/{}/up", urlencoding::encode(&name))).await
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
    post_json(&format!("/stacks/{}/down", urlencoding::encode(&name))).await
}

#[tauri::command]
pub async fn compose_pull(name: String) -> Result<serde_json::Value, String> {
    post_json(&format!("/stacks/{}/pull", urlencoding::encode(&name))).await
}

#[tauri::command]
pub async fn update_stack_env(name: String, key: String, value: String) -> Result<(), String> {
    patch_json(
        &format!("/stacks/{}/env", urlencoding::encode(&name)),
        &serde_json::json!({ "key": key, "value": value }),
    )
    .await?;
    Ok(())
}

// --- Events ---

static EVENT_SUBSCRIPTION: OnceLock<Mutex<Option<tokio::task::JoinHandle<()>>>> = OnceLock::new();

fn event_subscription_slot() -> &'static Mutex<Option<tokio::task::JoinHandle<()>>> {
    EVENT_SUBSCRIPTION.get_or_init(|| Mutex::new(None))
}

/// Subscribe to daemon events. Idempotent: repeated calls cancel the
/// previous streaming task before starting a new one, and the SSE stream
/// uses a zero-timeout client so it isn't killed after 30 s.
#[tauri::command]
pub async fn subscribe_events(app: tauri::AppHandle) -> Result<(), String> {
    let base = daemon_url();
    use tauri::Emitter;

    // Cancel any previous subscription task.
    if let Ok(mut slot) = event_subscription_slot().lock()
        && let Some(prev) = slot.take()
    {
        prev.abort();
    }

    // SSE streams must not be time-limited — the default 30 s client would
    // abort the stream mid-session.
    let resp = authed_client_with_timeout(0)
        .get(format!("{base}/events"))
        .send()
        .await
        .map_err(|e| format!("Failed to connect to event stream: {e}"))?;

    let handle = tokio::spawn(async move {
        use tokio::io::AsyncBufReadExt;
        use tokio_stream::StreamExt;

        let stream = resp.bytes_stream();
        let mapped = stream.map(|r| r.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e)));
        let reader = tokio_util::io::StreamReader::new(mapped);
        let mut lines = reader.lines();

        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(data) = line.strip_prefix("data:")
                && let Ok(event) = serde_json::from_str::<serde_json::Value>(data)
            {
                let _ = app.emit("orca-event", &event);
            }
        }
        // Stream ended — signal so the frontend can reconnect.
        let _ = app.emit("orca-event-stream-closed", ());
    });

    if let Ok(mut slot) = event_subscription_slot().lock() {
        *slot = Some(handle);
    }

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
    validate_k8s_name(&namespace)?;
    get_json(&format!("/k8s/pods/{}", urlencoding::encode(&namespace))).await
}

#[tauri::command]
pub async fn k8s_deployments(namespace: String) -> Result<serde_json::Value, String> {
    validate_k8s_name(&namespace)?;
    get_json(&format!("/k8s/deployments/{}", urlencoding::encode(&namespace))).await
}

#[tauri::command]
pub async fn k8s_services(namespace: String) -> Result<serde_json::Value, String> {
    validate_k8s_name(&namespace)?;
    get_json(&format!("/k8s/services/{}", urlencoding::encode(&namespace))).await
}

#[tauri::command]
pub async fn k8s_ingresses(namespace: String) -> Result<serde_json::Value, String> {
    validate_k8s_name(&namespace)?;
    get_json(&format!("/k8s/ingresses/{}", urlencoding::encode(&namespace))).await
}

#[tauri::command]
pub async fn k8s_pvcs(namespace: String) -> Result<serde_json::Value, String> {
    validate_k8s_name(&namespace)?;
    get_json(&format!("/k8s/pvcs/{}", urlencoding::encode(&namespace))).await
}

#[tauri::command]
pub async fn k8s_pvs() -> Result<serde_json::Value, String> {
    get_json("/k8s/pvs").await
}

#[tauri::command]
pub async fn k8s_delete_pod(namespace: String, name: String) -> Result<(), String> {
    validate_k8s_name(&namespace)?;
    validate_k8s_name(&name)?;
    delete(&format!(
        "/k8s/pods/{}/{}",
        urlencoding::encode(&namespace),
        urlencoding::encode(&name)
    ))
    .await
}

#[tauri::command]
pub async fn k8s_delete_pvc(namespace: String, name: String) -> Result<(), String> {
    validate_k8s_name(&namespace)?;
    validate_k8s_name(&name)?;
    delete(&format!(
        "/k8s/pvcs/{}/{}",
        urlencoding::encode(&namespace),
        urlencoding::encode(&name)
    ))
    .await
}

#[tauri::command]
pub async fn k8s_scale_deployment(namespace: String, name: String, replicas: u32) -> Result<(), String> {
    validate_k8s_name(&namespace)?;
    validate_k8s_name(&name)?;
    let base = daemon_url();
    let resp = client()
        .post(format!(
            "{base}/k8s/deployments/{}/{}/scale",
            urlencoding::encode(&namespace),
            urlencoding::encode(&name)
        ))
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
    validate_k8s_name(&namespace)?;
    validate_k8s_name(&name)?;
    post_empty(&format!(
        "/k8s/deployments/{}/{}/restart",
        urlencoding::encode(&namespace),
        urlencoding::encode(&name)
    ))
    .await
}

#[tauri::command]
pub async fn k8s_pod_logs(
    namespace: String,
    name: String,
    container: Option<String>,
    tail: Option<u32>,
) -> Result<Vec<String>, String> {
    validate_k8s_name(&namespace)?;
    validate_k8s_name(&name)?;
    let mut query_parts = Vec::new();
    if let Some(c) = &container {
        // Encode the container name — it becomes a query-string value and
        // could otherwise splice extra parameters.
        query_parts.push(format!("container={}", urlencoding::encode(c)));
    }
    if let Some(t) = tail {
        query_parts.push(format!("tail={t}"));
    }
    let query = if query_parts.is_empty() {
        String::new()
    } else {
        format!("?{}", query_parts.join("&"))
    };

    get_json(&format!(
        "/k8s/pods/{}/{}/logs{query}",
        urlencoding::encode(&namespace),
        urlencoding::encode(&name)
    ))
    .await
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
    if name == "." || name == ".." {
        return Err("Invalid Kubernetes name: reserved".into());
    }
    if name.starts_with('-') || name.starts_with('.') || name.ends_with('-') || name.ends_with('.') {
        return Err("Kubernetes name must not begin or end with '-' or '.'".into());
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
        .get(format!(
            "{base}/k8s/yaml/{}/{}/{}",
            urlencoding::encode(&kind),
            urlencoding::encode(&namespace),
            urlencoding::encode(&name)
        ))
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
    get_json(&format!("/k8s/events/{}", urlencoding::encode(&namespace))).await
}

#[tauri::command]
pub async fn k8s_create_namespace(name: String) -> Result<(), String> {
    validate_k8s_name(&name)?;
    let base = daemon_url();
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
    delete(&format!("/k8s/namespaces/{}", urlencoding::encode(&name))).await
}

#[tauri::command]
pub async fn k8s_configmaps(namespace: String) -> Result<serde_json::Value, String> {
    validate_k8s_name(&namespace)?;
    get_json(&format!("/k8s/configmaps/{}", urlencoding::encode(&namespace))).await
}

#[tauri::command]
pub async fn k8s_secrets(namespace: String) -> Result<serde_json::Value, String> {
    validate_k8s_name(&namespace)?;
    get_json(&format!("/k8s/secrets/{}", urlencoding::encode(&namespace))).await
}

#[tauri::command]
pub async fn k8s_create_secret(
    namespace: String,
    name: String,
    data: serde_json::Value,
    secret_type: Option<String>,
) -> Result<(), String> {
    validate_k8s_name(&namespace)?;
    validate_k8s_name(&name)?;
    let base = daemon_url();
    let resp = client()
        .post(format!("{base}/k8s/secrets/{}", urlencoding::encode(&namespace)))
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
    delete(&format!(
        "/k8s/secrets/{}/{}",
        urlencoding::encode(&namespace),
        urlencoding::encode(&name)
    ))
    .await
}

#[tauri::command]
pub async fn k8s_update_secret(namespace: String, name: String, data: serde_json::Value) -> Result<(), String> {
    validate_k8s_name(&namespace)?;
    validate_k8s_name(&name)?;
    let base = daemon_url();
    let resp = client()
        .put(format!(
            "{base}/k8s/secrets/{}/{}",
            urlencoding::encode(&namespace),
            urlencoding::encode(&name)
        ))
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
    validate_k8s_name(&namespace)?;
    validate_k8s_name(&name)?;
    let base = daemon_url();
    let resp = client()
        .post(format!("{base}/k8s/pvcs/{}", urlencoding::encode(&namespace)))
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
    validate_k8s_name(&namespace)?;
    get_json(&format!("/k8s/metrics/{}", urlencoding::encode(&namespace))).await
}

#[tauri::command]
pub async fn k8s_rollout_history(namespace: String, name: String) -> Result<serde_json::Value, String> {
    validate_k8s_name(&namespace)?;
    validate_k8s_name(&name)?;
    get_json(&format!(
        "/k8s/deployments/{}/{}/history",
        urlencoding::encode(&namespace),
        urlencoding::encode(&name)
    ))
    .await
}

#[tauri::command]
pub async fn k8s_rollout_undo(
    namespace: String,
    name: String,
    revision: Option<u32>,
) -> Result<serde_json::Value, String> {
    validate_k8s_name(&namespace)?;
    validate_k8s_name(&name)?;
    let base = daemon_url();
    client()
        .post(format!(
            "{base}/k8s/deployments/{}/{}/rollback",
            urlencoding::encode(&namespace),
            urlencoding::encode(&name)
        ))
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
    get_json(&format!("/k8s/daemonsets/{}", urlencoding::encode(&namespace))).await
}

#[tauri::command]
pub async fn k8s_statefulsets(namespace: String) -> Result<serde_json::Value, String> {
    validate_k8s_name(&namespace)?;
    get_json(&format!("/k8s/statefulsets/{}", urlencoding::encode(&namespace))).await
}

#[tauri::command]
pub async fn k8s_replicasets(namespace: String) -> Result<serde_json::Value, String> {
    validate_k8s_name(&namespace)?;
    get_json(&format!("/k8s/replicasets/{}", urlencoding::encode(&namespace))).await
}

#[tauri::command]
pub async fn k8s_scale_statefulset(namespace: String, name: String, replicas: u32) -> Result<(), String> {
    validate_k8s_name(&namespace)?;
    validate_k8s_name(&name)?;
    let base = daemon_url();
    let resp = client()
        .post(format!(
            "{base}/k8s/statefulsets/{}/{}/scale",
            urlencoding::encode(&namespace),
            urlencoding::encode(&name)
        ))
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
    validate_k8s_name(&namespace)?;
    validate_k8s_name(&name)?;
    post_empty(&format!(
        "/k8s/statefulsets/{}/{}/restart",
        urlencoding::encode(&namespace),
        urlencoding::encode(&name)
    ))
    .await
}

#[tauri::command]
pub async fn k8s_delete_daemonset(namespace: String, name: String) -> Result<(), String> {
    validate_k8s_name(&namespace)?;
    validate_k8s_name(&name)?;
    delete(&format!(
        "/k8s/daemonsets/{}/{}",
        urlencoding::encode(&namespace),
        urlencoding::encode(&name)
    ))
    .await
}

#[tauri::command]
pub async fn k8s_delete_statefulset(namespace: String, name: String) -> Result<(), String> {
    validate_k8s_name(&namespace)?;
    validate_k8s_name(&name)?;
    delete(&format!(
        "/k8s/statefulsets/{}/{}",
        urlencoding::encode(&namespace),
        urlencoding::encode(&name)
    ))
    .await
}

#[tauri::command]
pub async fn k8s_delete_replicaset(namespace: String, name: String) -> Result<(), String> {
    validate_k8s_name(&namespace)?;
    validate_k8s_name(&name)?;
    delete(&format!(
        "/k8s/replicasets/{}/{}",
        urlencoding::encode(&namespace),
        urlencoding::encode(&name)
    ))
    .await
}

// --- K8s HPAs, Network Policies, Storage Classes, CRDs ---

#[tauri::command]
pub async fn k8s_hpas(namespace: String) -> Result<serde_json::Value, String> {
    validate_k8s_name(&namespace)?;
    get_json(&format!("/k8s/hpas/{}", urlencoding::encode(&namespace))).await
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
    validate_k8s_name(&namespace)?;
    validate_k8s_name(&name)?;
    validate_k8s_name(&deployment)?;
    let base = daemon_url();
    client()
        .post(format!("{base}/k8s/hpas/{}", urlencoding::encode(&namespace)))
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
    delete(&format!(
        "/k8s/hpas/{}/{}",
        urlencoding::encode(&namespace),
        urlencoding::encode(&name)
    ))
    .await
}

#[tauri::command]
pub async fn k8s_network_policies(namespace: String) -> Result<serde_json::Value, String> {
    validate_k8s_name(&namespace)?;
    get_json(&format!("/k8s/network-policies/{}", urlencoding::encode(&namespace))).await
}

#[tauri::command]
pub async fn k8s_delete_network_policy(namespace: String, name: String) -> Result<(), String> {
    validate_k8s_name(&namespace)?;
    validate_k8s_name(&name)?;
    delete(&format!(
        "/k8s/network-policies/{}/{}",
        urlencoding::encode(&namespace),
        urlencoding::encode(&name)
    ))
    .await
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
    get_json(&format!("/k8s/jobs/{}", urlencoding::encode(&namespace))).await
}

#[tauri::command]
pub async fn k8s_cronjobs(namespace: String) -> Result<serde_json::Value, String> {
    validate_k8s_name(&namespace)?;
    get_json(&format!("/k8s/cronjobs/{}", urlencoding::encode(&namespace))).await
}

#[tauri::command]
pub async fn k8s_trigger_cronjob(namespace: String, name: String) -> Result<serde_json::Value, String> {
    validate_k8s_name(&namespace)?;
    validate_k8s_name(&name)?;
    let base = daemon_url();
    client()
        .post(format!(
            "{base}/k8s/cronjobs/{}/{}/trigger",
            urlencoding::encode(&namespace),
            urlencoding::encode(&name)
        ))
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
    delete(&format!(
        "/k8s/jobs/{}/{}",
        urlencoding::encode(&namespace),
        urlencoding::encode(&name)
    ))
    .await
}

#[tauri::command]
pub async fn k8s_delete_cronjob(namespace: String, name: String) -> Result<(), String> {
    validate_k8s_name(&namespace)?;
    validate_k8s_name(&name)?;
    delete(&format!(
        "/k8s/cronjobs/{}/{}",
        urlencoding::encode(&namespace),
        urlencoding::encode(&name)
    ))
    .await
}

#[tauri::command]
pub async fn k8s_suspend_cronjob(namespace: String, name: String, suspend: bool) -> Result<serde_json::Value, String> {
    validate_k8s_name(&namespace)?;
    validate_k8s_name(&name)?;
    let base = daemon_url();
    client()
        .put(format!(
            "{base}/k8s/cronjobs/{}/{}/suspend",
            urlencoding::encode(&namespace),
            urlencoding::encode(&name)
        ))
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
    validate_k8s_name(&name)?;
    validate_k8s_name(&namespace)?;
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

fn validate_helm_chart(chart: &str) -> Result<(), String> {
    if chart.is_empty() || chart.len() > 512 {
        return Err("Invalid Helm chart: length".into());
    }
    if chart.starts_with('-') {
        return Err("Helm chart must not begin with '-'".into());
    }
    if chart.contains('\n') || chart.contains('\0') {
        return Err("Helm chart contains invalid characters".into());
    }
    // Reject path-traversal shapes: local chart paths are not a
    // supported use-case — a chart reference is either an OCI URL
    // (`oci://...`) or a `repo/chart` form. Allowing `..` or `/`-prefixed
    // inputs lets a caller pass e.g. `../../etc/passwd` into helm's
    // argv, which is both confusing and dangerous.
    if chart.contains("..") {
        return Err("Helm chart must not contain '..'".into());
    }
    if chart.starts_with('/') {
        return Err("Helm chart must not be an absolute path".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn k8s_helm_install(
    release_name: String,
    chart: String,
    namespace: String,
    set_values: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    validate_k8s_name(&release_name)?;
    validate_k8s_name(&namespace)?;
    validate_helm_chart(&chart)?;
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
async fn proxy_tcp_to_ws(tcp_stream: tokio::net::TcpStream, ws_url: &str, tls_verify: bool) -> Result<(), String> {
    use futures_util::{SinkExt as _, StreamExt as _};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio_tungstenite::tungstenite::Message as WsMessage;

    // Honor the per-host tls_verify flag. When disabled (user opted in to
    // self-signed), pass a rustls config that accepts invalid certs; when
    // enabled, use the normal verifier.
    let (ws_stream, _) = if tls_verify {
        tokio_tungstenite::connect_async(ws_url)
            .await
            .map_err(|e| format!("WebSocket connect failed: {e}"))?
    } else {
        use tokio_tungstenite::Connector;
        let config = std::sync::Arc::new(
            rustls::ClientConfig::builder_with_provider(std::sync::Arc::new(rustls::crypto::ring::default_provider()))
                .with_safe_default_protocol_versions()
                .map_err(|e| format!("rustls builder failed: {e}"))?
                .dangerous()
                .with_custom_certificate_verifier(std::sync::Arc::new(DangerousNoopCertVerifier::new()))
                .with_no_client_auth(),
        );
        tokio_tungstenite::connect_async_tls_with_config(ws_url, None, false, Some(Connector::Rustls(config)))
            .await
            .map_err(|e| format!("WebSocket connect failed: {e}"))?
    };

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

// --- Docker Desktop Migration ---

#[tauri::command]
pub async fn docker_desktop_status() -> Result<serde_json::Value, String> {
    get_json("/environment/docker-desktop-status").await
}

#[tauri::command]
pub async fn switch_to_orca_runtime() -> Result<serde_json::Value, String> {
    post_json("/environment/switch-to-orca").await
}

#[tauri::command]
pub async fn stop_docker_desktop() -> Result<serde_json::Value, String> {
    post_json("/environment/stop-docker-desktop").await
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
        .post(format!("{base}/templates/{}/deploy", urlencoding::encode(&id)))
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
                .post(format!("{base_url}/templates/{}/deploy", urlencoding::encode(&id)))
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
                .post(format!("{base_url}/templates/{}/deploy", urlencoding::encode(&id)))
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
        .delete(format!("{base}/templates/user"))
        .query(&[("id", &id)])
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

    // Filesystem reads can block for seconds on slow disks / NFS;
    // dispatch to `spawn_blocking` so we don't park a tokio worker.
    let (memory, processors, swap) = tokio::task::spawn_blocking(move || -> Result<_, String> {
        let mut memory = String::new();
        let mut processors = String::new();
        let mut swap = String::new();

        if config_path.exists() {
            let content =
                std::fs::read_to_string(&config_path).map_err(|e| format!("Failed to read .wslconfig: {e}"))?;

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

        Ok((memory, processors, swap))
    })
    .await
    .map_err(|e| format!("spawn_blocking join failed: {e}"))??;

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

    tokio::task::spawn_blocking(move || -> Result<(), String> {
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
    })
    .await
    .map_err(|e| format!("spawn_blocking join failed: {e}"))??;

    Ok(())
}

// --- General Settings ---

/// Read intercept_docker_desktop_urls directly from config file (no daemon needed).
/// Used by the deep link handler which may fire before the daemon is connected.
#[tauri::command]
pub async fn get_intercept_docker_urls() -> Result<bool, String> {
    let config = orca_core::config::OrcaConfig::load().map_err(|e| format!("{e}"))?;
    Ok(config.intercept_docker_desktop_urls)
}

#[tauri::command]
pub async fn get_general_settings() -> Result<serde_json::Value, String> {
    get_json("/settings/general").await
}

#[tauri::command]
pub async fn save_general_settings(
    start_on_login: bool,
    show_tray_icon: bool,
    telemetry: bool,
    intercept_docker_desktop_urls: bool,
) -> Result<(), String> {
    let base = daemon_url();
    let resp = client()
        .post(format!("{base}/settings/general"))
        .json(&serde_json::json!({
            "start_on_login": start_on_login,
            "show_tray_icon": show_tray_icon,
            "telemetry": telemetry,
            "intercept_docker_desktop_urls": intercept_docker_desktop_urls,
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

    // Read only the last 64 KiB of the log. A long-running daemon can
    // grow `daemon.log` to many MB; slurping the whole file into memory
    // on every settings-panel refresh is wasteful and blocks the tokio
    // worker. Seek to `len - 64KiB` and parse from there.
    const TAIL_BYTES: u64 = 64 * 1024;
    let log_path_clone = log_path.clone();
    let log_tail = tokio::task::spawn_blocking(move || -> String {
        use std::io::{Read, Seek, SeekFrom};
        let mut file = match std::fs::File::open(&log_path_clone) {
            Ok(f) => f,
            Err(_) => return String::new(),
        };
        let len = file.metadata().map(|m| m.len()).unwrap_or(0);
        let start = len.saturating_sub(TAIL_BYTES);
        if file.seek(SeekFrom::Start(start)).is_err() {
            return String::new();
        }
        let mut buf = Vec::with_capacity(TAIL_BYTES as usize);
        if file.read_to_end(&mut buf).is_err() {
            return String::new();
        }
        let text = String::from_utf8_lossy(&buf);
        // If we seeked into the middle of a line, drop the partial
        // leading line so the user doesn't see a mangled entry.
        let trimmed: &str = if start > 0 {
            match text.find('\n') {
                Some(pos) => &text[pos + 1..],
                None => &text,
            }
        } else {
            &text
        };
        // Keep at most the last 100 lines — matches previous behaviour.
        trimmed
            .lines()
            .rev()
            .take(100)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n")
    })
    .await
    .unwrap_or_default();

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

/// Bound on content that any frontend can write via `write_temp_file`.
const MAX_TEMP_FILE_BYTES: usize = 16 * 1024 * 1024;

#[tauri::command]
pub async fn write_temp_file(name: String, content: String) -> Result<String, String> {
    if content.len() > MAX_TEMP_FILE_BYTES {
        return Err(format!(
            "File too large ({} > {MAX_TEMP_FILE_BYTES} bytes)",
            content.len()
        ));
    }
    let orca_tmp = orca_temp_dir();
    std::fs::create_dir_all(&orca_tmp).map_err(|e| format!("Failed to create temp dir: {e}"))?;
    // Sanitize: use only the filename component, reject path traversal.
    let safe_name = std::path::Path::new(&name)
        .file_name()
        .ok_or("Invalid filename")?
        .to_str()
        .ok_or("Invalid filename encoding")?;
    if safe_name.starts_with('.') || safe_name.is_empty() || safe_name.len() > 255 {
        return Err("Invalid filename".into());
    }
    let path = orca_tmp.join(safe_name);
    // Open with create_new so we never follow a symlink or clobber a file
    // already in the temp dir.
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = match opts.open(&path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            // Overwrite existing file we own: remove first, then create_new.
            let _ = std::fs::remove_file(&path);
            opts.open(&path).map_err(|e| format!("Failed to open temp file: {e}"))?
        }
        Err(e) => return Err(format!("Failed to open temp file: {e}")),
    };
    use std::io::Write;
    f.write_all(content.as_bytes())
        .map_err(|e| format!("Failed to write temp file: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// A per-app namespaced subdirectory of the system temp dir. Isolates our
/// files from anything else so `write_temp_file` can never clobber
/// unrelated files (e.g., files a user or another application placed in
/// `/tmp`).
fn orca_temp_dir() -> std::path::PathBuf {
    std::env::temp_dir().join("orca-desktop")
}

#[tauri::command]
pub async fn open_file_in_browser(path: String) -> Result<(), String> {
    // Allow URLs only with http/https schemes. Reject anything else so
    // malicious content can't trigger `file://` / custom-handler opens.
    if path.starts_with("http://") || path.starts_with("https://") {
        return open::that(&path).map_err(|e| format!("Failed to open URL: {e}"));
    }
    // For file paths, restrict to OUR per-app temp subdirectory — the
    // previous check of just the system temp dir was too permissive because
    // any other process can drop files there.
    let canonical = std::fs::canonicalize(&path).map_err(|e| format!("Invalid path: {e}"))?;
    let orca_tmp = match std::fs::canonicalize(orca_temp_dir()) {
        Ok(p) => p,
        Err(_) => return Err("Orca temp dir not initialised".to_string()),
    };
    if !canonical.starts_with(&orca_tmp) {
        return Err(format!(
            "Access denied: only Orca temp files can be opened (got: {}, expected under: {})",
            canonical.display(),
            orca_tmp.display()
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

/// The only directory the frontend is allowed to read from / write to via
/// `read_file` / `save_compose_file`. Without this confinement, any
/// JS-reachable call could read or write arbitrary YAML-extensioned files
/// anywhere on disk — a symlink or well-crafted path could then target
/// cron files, SSH configs, etc.
fn stacks_base_dir() -> std::path::PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("orca")
        .join("stacks")
}

/// Expose the resolved absolute stacks directory path to the frontend.
/// Previously the Compose Wizard hard-coded `~/.config/orca/stacks` and
/// that tilde was never expanded — every Save Only call was rejected by
/// `validate_compose_path` with "Path must be absolute".
#[tauri::command]
pub async fn get_stacks_dir() -> Result<String, String> {
    let p = stacks_base_dir();
    // Ensure the directory exists so callers can canonicalize immediately.
    std::fs::create_dir_all(&p).map_err(|e| format!("Failed to create stacks dir: {e}"))?;
    Ok(p.to_string_lossy().to_string())
}

fn validate_compose_path(path: &str) -> Result<std::path::PathBuf, String> {
    let p = std::path::Path::new(path);
    let fname = p.file_name().and_then(|f| f.to_str()).unwrap_or("");
    if !(fname.ends_with(".yml") || fname.ends_with(".yaml")) {
        return Err("Only .yml/.yaml files can be read or written".to_string());
    }
    if path.contains("..") {
        return Err("Path must not contain '..'".to_string());
    }
    // Require an absolute path; relative paths depend on CWD and are easy
    // to abuse.
    if !p.is_absolute() {
        return Err("Path must be absolute".into());
    }

    // Canonicalize the base FIRST without modifying the filesystem.
    let base = stacks_base_dir();
    let base_canonical = match std::fs::canonicalize(&base) {
        Ok(c) => c,
        Err(_) => {
            std::fs::create_dir_all(&base).map_err(|e| format!("Failed to create stacks dir: {e}"))?;
            std::fs::canonicalize(&base).map_err(|e| format!("Failed to canonicalize stacks dir: {e}"))?
        }
    };

    // Containment check BEFORE any mkdir on the user-supplied path. We
    // canonicalize the nearest existing ancestor (not the user path's
    // parent), then join the remaining unresolved tail, and check the
    // lexical prefix. Only once that passes do we ensure the parent
    // directory exists for save operations.
    let mut existing = p.to_path_buf();
    let mut tail = std::path::PathBuf::new();
    loop {
        if existing.exists() {
            break;
        }
        match existing.file_name() {
            Some(f) => {
                let mut new_tail = std::path::PathBuf::from(f);
                new_tail.push(&tail);
                tail = new_tail;
            }
            None => return Err("Invalid path".into()),
        }
        if !existing.pop() {
            return Err("Invalid path".into());
        }
    }
    let existing_canonical = std::fs::canonicalize(&existing).map_err(|e| format!("Invalid path: {e}"))?;
    let pb = existing_canonical.join(&tail);
    if !pb.starts_with(&base_canonical) {
        return Err(format!(
            "Access denied: path must be inside {}",
            base_canonical.display()
        ));
    }

    // Safe to create missing parent dirs now.
    if let Some(parent) = pb.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to ensure parent dir: {e}"))?;
    }
    Ok(pb)
}

/// Open a file without following symlinks (Unix). On non-Unix, fall back
/// to a regular open — which follows symlinks, but the only current
/// non-Unix Orca target is Windows + WSL, where the stacks dir is under
/// `$APPDATA` and symlink attacks are less practical.
fn open_no_follow_read(path: &std::path::Path) -> std::io::Result<std::fs::File> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)
    }
    #[cfg(not(unix))]
    {
        std::fs::OpenOptions::new().read(true).open(path)
    }
}

fn open_no_follow_write(path: &std::path::Path) -> std::io::Result<std::fs::File> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)
    }
    #[cfg(not(unix))]
    {
        std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(path)
    }
}

#[tauri::command]
pub async fn read_file(path: String) -> Result<String, String> {
    let pb = validate_compose_path(&path)?;
    tokio::task::spawn_blocking(move || {
        use std::io::Read;
        let mut f = open_no_follow_read(&pb).map_err(|e| format!("Failed to open file: {e}"))?;
        let mut buf = String::new();
        f.read_to_string(&mut buf)
            .map_err(|e| format!("Failed to read file: {e}"))?;
        Ok::<_, String>(buf)
    })
    .await
    .map_err(|e| format!("read_file task panicked: {e}"))?
}

#[tauri::command]
pub async fn save_compose_file(path: String, content: String) -> Result<(), String> {
    let pb = validate_compose_path(&path)?;
    // Basic validation: content must not be empty and must be bounded.
    if content.trim().is_empty() {
        return Err("Content cannot be empty".to_string());
    }
    if content.len() > 10 * 1024 * 1024 {
        return Err("Compose file too large (max 10 MiB)".to_string());
    }
    tokio::task::spawn_blocking(move || {
        use std::io::Write;
        let mut f = open_no_follow_write(&pb).map_err(|e| format!("Failed to open file: {e}"))?;
        f.write_all(content.as_bytes())
            .map_err(|e| format!("Failed to save compose file: {e}"))?;
        Ok::<_, String>(())
    })
    .await
    .map_err(|e| format!("save_compose_file task panicked: {e}"))?
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
    let original_url = {
        let host = config
            .remote_hosts
            .iter()
            .find(|h| h.id == id)
            .ok_or("Host not found")?;
        host.url.clone()
    };
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
    let new_url = host.url.clone();
    let new_token = host.token.clone();
    let new_tls = host.tls_verify;
    config.save().map_err(|e| format!("{e}"))?;

    // Only refresh the active-host override if THIS host is the one currently
    // active — compare by the pre-edit URL so changes to name/tags of an
    // inactive host don't silently switch the active target.
    if let Ok(guard) = DAEMON_URL_OVERRIDE.read() {
        let is_active = guard.as_ref().map(|(u, _, _)| u == &original_url).unwrap_or(false);
        drop(guard);
        if is_active && let Ok(mut w) = DAEMON_URL_OVERRIDE.write() {
            *w = Some((new_url, new_token, new_tls));
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
        .get(format!("{api_url}/system/health"))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
    {
        Ok(resp) => resp.json::<serde_json::Value>().await.ok(),
        Err(_) => None,
    };

    // Container list
    let containers = match client
        .get(format!("{api_url}/containers"))
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
        .get(format!("{api_url}/images"))
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
        let api_url = format!("{}/api/v1", normalize_daemon_url(&host.url));
        let resp = client
            .get(format!("{api_url}/health"))
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
    delete(&format!("/deploy/rules/{}", urlencoding::encode(&id))).await
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
    // Reject paths containing '?' or '#' — those could let a malicious caller
    // override the appended `?token=...` query string or inject a fragment.
    if path.contains('?') || path.contains('#') {
        return Err("Invalid path: must not contain '?' or '#'".to_string());
    }
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
    build_target: Option<String>,
) -> Result<serde_json::Value, String> {
    let base = daemon_url();
    let body = serde_json::json!({
        "id": id,
        "name": name,
        "container": container,
        "action": action,
        "cron": cron,
        "enabled": enabled.unwrap_or(true),
        "build_target": build_target,
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
    delete(&format!("/schedules/{}", urlencoding::encode(&id))).await
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
    delete(&format!("/gateway/routes/{}", urlencoding::encode(&hostname))).await
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
        .put(format!("{base}/gateway/routes/{}", urlencoding::encode(&hostname)))
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

#[tauri::command]
pub async fn gateway_dismiss_suggestion(key: String) -> Result<(), String> {
    let base = daemon_url();
    let resp = client()
        .post(format!("{base}/gateway/dismiss-suggestion"))
        .json(&serde_json::json!({ "key": key }))
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
pub async fn gateway_clear_dismissed() -> Result<(), String> {
    post_empty("/gateway/clear-dismissed").await
}

#[tauri::command]
pub async fn gateway_get_dismissed() -> Result<serde_json::Value, String> {
    get_json("/gateway/dismissed-suggestions").await
}

#[tauri::command]
pub async fn gateway_traefik_status() -> Result<serde_json::Value, String> {
    get_json("/gateway/traefik-status").await
}

#[tauri::command]
pub async fn gateway_set_traefik_mode(
    mode: String,
    traefik_http_port: Option<u16>,
    traefik_https_port: Option<u16>,
) -> Result<serde_json::Value, String> {
    let base = daemon_url();
    let resp = client()
        .put(format!("{base}/gateway/traefik-mode"))
        .json(&serde_json::json!({
            "mode": mode,
            "traefik_http_port": traefik_http_port,
            "traefik_https_port": traefik_https_port,
        }))
        .send()
        .await
        .map_err(|e| format!("Daemon connection failed: {e}"))?;
    if resp.status().is_success() {
        resp.json().await.map_err(|e| format!("Invalid response: {e}"))
    } else {
        let body = resp.text().await.unwrap_or_default();
        Err(body)
    }
}
