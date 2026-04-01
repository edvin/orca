//! Gateway manager — manages a Caddy reverse proxy container for hostname-based routing.

use std::collections::HashMap;

use anyhow::{Context, Result};
use orca_core::config::{GatewayConfig, GatewayTlsMode};
use orca_core::network::NetworkManager;
use orca_core::runtime::{ContainerCreateOpts, ContainerRuntime, ContainerState, PortMapping, VolumeMount};

use crate::state::AppState;

const CADDY_IMAGE: &str = "caddy:2-alpine";
const CADDY_CONTAINER: &str = "orca-gateway";
const CADDY_ADMIN_PORT: u16 = 2019;

/// Check if the gateway ports are available.
pub fn check_port_availability(http_port: u16, https_port: u16) -> Vec<String> {
    let mut conflicts = Vec::new();
    if std::net::TcpListener::bind(("0.0.0.0", http_port)).is_err() {
        conflicts.push(format!("Port {} (HTTP) is already in use", http_port));
    }
    if std::net::TcpListener::bind(("0.0.0.0", https_port)).is_err() {
        conflicts.push(format!("Port {} (HTTPS) is already in use", https_port));
    }
    conflicts
}

/// Check if the gateway container is running.
pub async fn is_running(state: &AppState) -> Result<bool> {
    let rt = state.rt().await;
    let containers = rt.list_containers(true).await?;
    Ok(containers
        .iter()
        .any(|c| c.name == CADDY_CONTAINER && c.state == ContainerState::Running))
}

/// Get the container ID of the gateway container (if it exists).
pub async fn container_id(state: &AppState) -> Result<Option<String>> {
    let rt = state.rt().await;
    let containers = rt.list_containers(true).await?;
    Ok(containers
        .iter()
        .find(|c| c.name == CADDY_CONTAINER)
        .map(|c| c.id.clone()))
}

/// Start the gateway container.
pub async fn start(state: &AppState, config: &GatewayConfig) -> Result<String> {
    let rt = state.rt().await;

    // Remove any existing stopped container first
    let containers = rt
        .list_containers(true)
        .await
        .context("Failed to list containers while checking for existing gateway")?;
    if let Some(existing) = containers.iter().find(|c| c.name == CADDY_CONTAINER) {
        if existing.state != ContainerState::Running {
            let _ = rt.remove_container(&existing.id, true).await;
        } else {
            return Ok(existing.id.clone());
        }
    }

    // Check port availability (warn, don't block — Docker may handle it on some platforms)
    let conflicts = check_port_availability(config.http_port, config.https_port);
    if !conflicts.is_empty() {
        tracing::warn!("Port conflicts detected: {}", conflicts.join(", "));
    }

    // Pull the Caddy image if not present
    pull_if_needed(state, CADDY_IMAGE)
        .await
        .context("Could not download caddy:2-alpine. Check your internet connection")?;

    // Prepare the certs directory
    let certs_dir = certs_dir();
    std::fs::create_dir_all(&certs_dir)?;

    // Generate certs for all routes + root domain if in OrcaCa mode
    if matches!(config.tls_mode, GatewayTlsMode::OrcaCa) {
        generate_cert_for_hostname(&config.domain)?;
        for route in &config.routes {
            if route.enabled {
                generate_cert_for_hostname(&route.hostname)?;
            }
        }
    }

    let opts = ContainerCreateOpts {
        image: CADDY_IMAGE.to_string(),
        name: Some(CADDY_CONTAINER.to_string()),
        command: vec![
            "caddy".to_string(),
            "run".to_string(),
            "--config".to_string(),
            "/etc/caddy/caddy.json".to_string(),
        ],
        entrypoint: None,
        env: HashMap::new(),
        ports: vec![
            PortMapping {
                host_ip: None,
                host_port: config.http_port,
                container_port: 80,
                protocol: "tcp".to_string(),
            },
            PortMapping {
                host_ip: None,
                host_port: config.https_port,
                container_port: 443,
                protocol: "tcp".to_string(),
            },
            PortMapping {
                host_ip: Some("127.0.0.1".to_string()),
                host_port: CADDY_ADMIN_PORT,
                container_port: CADDY_ADMIN_PORT,
                protocol: "tcp".to_string(),
            },
        ],
        volumes: vec![VolumeMount {
            source: to_docker_mount_path(&certs_dir),
            target: "/certs".to_string(),
            read_only: true,
        }],
        labels: {
            let mut labels = HashMap::new();
            labels.insert("orca.managed".to_string(), "true".to_string());
            labels.insert("orca.role".to_string(), "gateway".to_string());
            labels
        },
        restart_policy: Some("unless-stopped".to_string()),
        network: None,
        detach: true,
        remove_on_exit: false,
        cpu_limit: None,
        memory_limit: None,
        memory_swap: None,
        gpu: false,
        user: None,
    };

    let id = rt
        .create_container(opts)
        .await
        .context("Failed to create gateway container")?;

    // Generate the landing page
    let _ = write_landing_page(config);

    // Write the initial Caddy config file into the container
    let caddy_json = build_caddy_config(config);
    write_caddy_config_to_container(state, &id, &caddy_json)
        .await
        .context("Failed to write Caddy config into container")?;

    rt.start_container(&id)
        .await
        .context("Failed to start gateway container")?;

    // Wait for Caddy admin API to be ready
    wait_for_caddy_ready()
        .await
        .context("Gateway container started but Caddy admin API is not responding. Check daemon logs")?;

    // Push config via admin API
    push_caddy_config(config)
        .await
        .context("Gateway started but failed to push Caddy configuration")?;

    Ok(id)
}

/// Stop and remove the gateway container.
pub async fn stop(state: &AppState) -> Result<()> {
    let rt = state.rt().await;
    let containers = rt.list_containers(true).await?;
    if let Some(existing) = containers.iter().find(|c| c.name == CADDY_CONTAINER) {
        if existing.state == ContainerState::Running {
            let _ = rt.stop_container(&existing.id, 10).await;
        }
        rt.remove_container(&existing.id, true).await?;
    }
    Ok(())
}

/// Generate and push Caddy JSON config via the admin API.
pub async fn apply_config(config: &GatewayConfig) -> Result<()> {
    // Generate certs for all enabled routes + root domain
    if matches!(config.tls_mode, GatewayTlsMode::OrcaCa) {
        generate_cert_for_hostname(&config.domain)?;
        for route in &config.routes {
            if route.enabled {
                generate_cert_for_hostname(&route.hostname)?;
            }
        }
    } else if matches!(config.tls_mode, GatewayTlsMode::Custom) {
        // Write user-provided cert/key PEM to files so Caddy can read them
        write_custom_cert_files(config)?;
    }
    // Regenerate the landing page
    let _ = write_landing_page(config);
    push_caddy_config(config).await
}

/// Connect gateway to a container's Docker networks.
pub async fn ensure_network_connectivity(state: &AppState, container_name: &str) -> Result<()> {
    let rt = state.rt().await;

    // Find the target container
    let containers = rt.list_containers(true).await?;
    let target = containers
        .iter()
        .find(|c| c.name == container_name || c.id.starts_with(container_name));

    let target = match target {
        Some(t) => t,
        None => return Ok(()), // Container not found, skip silently
    };

    // Inspect the target container to get its networks
    let docker = &rt.docker;
    let inspect = docker
        .inspect_container(&target.id, None)
        .await
        .context("Failed to inspect target container")?;

    let networks = inspect.network_settings.as_ref().and_then(|ns| ns.networks.as_ref());

    if let Some(networks) = networks {
        // Find the gateway container
        let gateway = containers.iter().find(|c| c.name == CADDY_CONTAINER);
        let gateway = match gateway {
            Some(g) => g,
            None => return Ok(()),
        };

        // Inspect gateway to see which networks it's on
        let gw_inspect = docker
            .inspect_container(&gateway.id, None)
            .await
            .context("Failed to inspect gateway container")?;

        let gw_networks: Vec<String> = gw_inspect
            .network_settings
            .as_ref()
            .and_then(|ns| ns.networks.as_ref())
            .map(|n| n.keys().cloned().collect())
            .unwrap_or_default();

        for net_name in networks.keys() {
            // Skip the default bridge — container-to-container DNS doesn't work there
            if net_name == "bridge" {
                continue;
            }
            if !gw_networks.contains(net_name) {
                tracing::info!("Connecting gateway to network '{net_name}'");
                if let Err(e) = rt.connect(net_name, CADDY_CONTAINER).await {
                    tracing::warn!("Failed to connect gateway to network '{net_name}': {e}");
                }
            }
        }
    }

    Ok(())
}

// --- Internal helpers ---

/// Convert a host path to a Docker-compatible mount path.
/// On Windows, `C:\Users\foo\bar` becomes `/mnt/c/Users/foo/bar` for WSL-based Docker.
fn to_docker_mount_path(path: &std::path::Path) -> String {
    let s = path.to_string_lossy();
    #[cfg(target_os = "windows")]
    {
        // Convert Windows path like C:\Users\foo to /mnt/c/Users/foo
        if s.len() >= 3 && s.as_bytes()[1] == b':' {
            let drive = s.as_bytes()[0].to_ascii_lowercase() as char;
            let rest = s[2..].replace('\\', "/");
            return format!("/mnt/{drive}{rest}");
        }
        // Already a unix-style path or relative
        return s.replace('\\', "/");
    }
    #[cfg(not(target_os = "windows"))]
    {
        s.to_string()
    }
}

fn certs_dir() -> std::path::PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("orca")
        .join("ca")
        .join("certs")
}

fn ca_dir() -> std::path::PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("orca")
        .join("ca")
}

/// Write user-provided custom cert/key PEM content to files in the certs directory.
fn write_custom_cert_files(config: &GatewayConfig) -> Result<()> {
    let dir = certs_dir();
    std::fs::create_dir_all(&dir)?;

    if let Some(cert_pem) = &config.custom_cert.as_deref().filter(|s| !s.trim().is_empty()) {
        std::fs::write(dir.join("cert.pem"), cert_pem)?;
        tracing::info!("Wrote custom certificate to {}", dir.join("cert.pem").display());
    }
    if let Some(key_pem) = &config.custom_key.as_deref().filter(|s| !s.trim().is_empty()) {
        let key_path = dir.join("key.pem");
        std::fs::write(&key_path, key_pem)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o600));
        }
        tracing::info!("Wrote custom private key to {}", key_path.display());
    }
    Ok(())
}

/// Generate a TLS certificate for a hostname, signed by the Orca CA.
fn generate_cert_for_hostname(hostname: &str) -> Result<()> {
    let certs = certs_dir();
    std::fs::create_dir_all(&certs)?;

    let cert_path = certs.join(format!("{hostname}.pem"));
    let key_path = certs.join(format!("{hostname}-key.pem"));

    // Skip if already exists
    if cert_path.exists() && key_path.exists() {
        return Ok(());
    }

    // Load the CA
    let ca_d = ca_dir();
    let ca_cert_path = ca_d.join("ca.pem");
    let ca_key_path = ca_d.join("ca-key.pem");

    // Ensure CA exists (reuse the function pattern from api.rs)
    let (ca_cert_pem, ca_key_pem) = if ca_cert_path.exists() && ca_key_path.exists() {
        (
            std::fs::read_to_string(&ca_cert_path)?,
            std::fs::read_to_string(&ca_key_path)?,
        )
    } else {
        // Create the CA if it doesn't exist
        tracing::info!("Generating new Orca root CA for gateway certs");
        std::fs::create_dir_all(&ca_d)?;

        let mut params = rcgen::CertificateParams::new(Vec::<String>::new()).expect("Failed to create CA params");
        params
            .distinguished_name
            .push(rcgen::DnType::CommonName, "Orca Desktop CA");
        params
            .distinguished_name
            .push(rcgen::DnType::OrganizationName, "Orca Desktop");
        params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        params.key_usages = vec![rcgen::KeyUsagePurpose::KeyCertSign, rcgen::KeyUsagePurpose::CrlSign];

        let now = time::OffsetDateTime::now_utc();
        params.not_before = now;
        params.not_after = now + time::Duration::days(365 * 10);

        let key_pair = rcgen::KeyPair::generate().expect("Failed to generate CA key pair");
        let cert = params
            .self_signed(&key_pair)
            .expect("Failed to self-sign CA certificate");

        let cert_pem = cert.pem();
        let key_pem = key_pair.serialize_pem();

        std::fs::write(&ca_cert_path, &cert_pem)?;
        std::fs::write(&ca_key_path, &key_pem)?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&ca_key_path, std::fs::Permissions::from_mode(0o600));
        }

        (cert_pem, key_pem)
    };

    let ca_key = rcgen::KeyPair::from_pem(&ca_key_pem).context("Failed to parse CA key")?;
    let ca_params = rcgen::CertificateParams::from_ca_cert_pem(&ca_cert_pem).context("Failed to parse CA cert")?;
    let ca_cert = ca_params
        .self_signed(&ca_key)
        .context("Failed to reconstruct CA certificate")?;

    // Build leaf certificate
    let mut san_types: Vec<rcgen::SanType> = vec![rcgen::SanType::DnsName(
        hostname.to_string().try_into().context("Invalid DNS name")?,
    )];
    // Also add localhost and 127.0.0.1
    if hostname != "localhost" {
        san_types.push(rcgen::SanType::DnsName("localhost".to_string().try_into().unwrap()));
    }
    san_types.push(rcgen::SanType::IpAddress(std::net::IpAddr::V4(
        std::net::Ipv4Addr::new(127, 0, 0, 1),
    )));

    let mut leaf_params =
        rcgen::CertificateParams::new(Vec::<String>::new()).context("Failed to create leaf params")?;
    leaf_params.distinguished_name.push(rcgen::DnType::CommonName, hostname);
    leaf_params.subject_alt_names = san_types;

    let now = time::OffsetDateTime::now_utc();
    leaf_params.not_before = now;
    leaf_params.not_after = now + time::Duration::days(365);

    let leaf_key = rcgen::KeyPair::generate().context("Failed to generate leaf key")?;
    let leaf_cert = leaf_params
        .signed_by(&leaf_key, &ca_cert, &ca_key)
        .context("Failed to sign leaf certificate")?;

    std::fs::write(&cert_path, leaf_cert.pem())?;
    std::fs::write(&key_path, leaf_key.serialize_pem())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o600));
    }

    tracing::info!("Generated TLS certificate for {hostname}");
    Ok(())
}

/// Build the Caddy JSON configuration from gateway config.
fn build_caddy_config(config: &GatewayConfig) -> String {
    let enabled_routes: Vec<&orca_core::config::GatewayRoute> = config.routes.iter().filter(|r| r.enabled).collect();

    // Build route objects
    let routes: Vec<serde_json::Value> = enabled_routes
        .iter()
        .map(|route| {
            serde_json::json!({
                "match": [{"host": [route.hostname.clone()]}],
                "handle": [{
                    "handler": "reverse_proxy",
                    "upstreams": [{"dial": format!("{}:{}", route.container_name, route.port)}]
                }]
            })
        })
        .collect();

    // Build TLS certificates list
    let mut load_files: Vec<serde_json::Value> = enabled_routes
        .iter()
        .map(|route| match config.tls_mode {
            GatewayTlsMode::OrcaCa => serde_json::json!({
                "certificate": format!("/certs/{}.pem", route.hostname),
                "key": format!("/certs/{}-key.pem", route.hostname),
            }),
            GatewayTlsMode::Custom => {
                let cert = config.custom_cert.as_deref().unwrap_or("/certs/cert.pem");
                let key = config.custom_key.as_deref().unwrap_or("/certs/key.pem");
                serde_json::json!({
                    "certificate": cert,
                    "key": key,
                })
            }
        })
        .collect();

    let mut caddy = serde_json::json!({
        "admin": {
            "listen": format!("0.0.0.0:{CADDY_ADMIN_PORT}")
        },
        "apps": {
            "http": {
                "servers": {}
            }
        }
    });

    // Landing page fallback route (served when no hostname matches or at root domain)
    let landing_route = serde_json::json!({
        "handle": [{
            "handler": "file_server",
            "root": "/certs",
            "index_names": ["index.html"]
        }]
    });

    // Add a cert for the root domain so the landing page works over HTTPS
    if matches!(config.tls_mode, GatewayTlsMode::OrcaCa) {
        load_files.push(serde_json::json!({
            "certificate": format!("/certs/{}.pem", config.domain),
            "key": format!("/certs/{}-key.pem", config.domain),
        }));
    }

    // HTTPS server: reverse proxy routes + landing page fallback
    let mut all_routes = routes;
    all_routes.push(landing_route);

    caddy["apps"]["http"]["servers"]["gateway"] = serde_json::json!({
        "listen": [":443"],
        "routes": all_routes,
        "tls_connection_policies": [{}]
    });

    // HTTP → HTTPS redirect
    caddy["apps"]["http"]["servers"]["http_redirect"] = serde_json::json!({
        "listen": [":80"],
        "routes": [{
            "handle": [{
                "handler": "static_response",
                "headers": {"Location": ["https://{http.request.host}{http.request.uri}"]},
                "status_code": 301
            }]
        }]
    });

    if !load_files.is_empty() {
        caddy["apps"]["tls"] = serde_json::json!({
            "certificates": {
                "load_files": load_files
            }
        });
    }

    serde_json::to_string_pretty(&caddy).unwrap_or_default()
}

/// Write the Caddy config file into the container using exec.
async fn write_caddy_config_to_container(state: &AppState, container_id: &str, config_json: &str) -> Result<()> {
    let rt = state.rt().await;

    // Create the config directory
    rt.exec(orca_core::runtime::ExecOpts {
        container: container_id.to_string(),
        command: vec!["mkdir".to_string(), "-p".to_string(), "/etc/caddy".to_string()],
        interactive: false,
        tty: false,
        env: HashMap::new(),
        workdir: None,
    })
    .await?;

    // Write config using sh -c and printf
    let escaped = config_json.replace('\\', "\\\\").replace('\'', "'\\''");
    rt.exec(orca_core::runtime::ExecOpts {
        container: container_id.to_string(),
        command: vec![
            "sh".to_string(),
            "-c".to_string(),
            format!("printf '%s' '{escaped}' > /etc/caddy/caddy.json"),
        ],
        interactive: false,
        tty: false,
        env: HashMap::new(),
        workdir: None,
    })
    .await?;

    Ok(())
}

/// Wait for the Caddy admin API to be ready.
async fn wait_for_caddy_ready() -> Result<()> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()?;

    for attempt in 1..=20 {
        match client
            .get(format!("http://127.0.0.1:{CADDY_ADMIN_PORT}/config/"))
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() || resp.status().as_u16() == 404 => {
                tracing::info!("Caddy admin API ready (attempt {attempt})");
                return Ok(());
            }
            Ok(resp) => {
                tracing::debug!("Caddy admin API attempt {attempt}/20: HTTP {}", resp.status());
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }
            Err(e) => {
                tracing::debug!("Caddy admin API attempt {attempt}/20: connection error: {e}");
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }
        }
    }

    anyhow::bail!("Caddy admin API did not become ready within 10 seconds")
}

/// Push Caddy config via the admin API.
async fn push_caddy_config(config: &GatewayConfig) -> Result<()> {
    let caddy_json = build_caddy_config(config);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()?;

    let resp = client
        .post(format!("http://127.0.0.1:{CADDY_ADMIN_PORT}/load"))
        .header("Content-Type", "application/json")
        .body(caddy_json)
        .send()
        .await
        .context("Failed to push config to Caddy")?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!(
            "Caddy config push failed (HTTP {}): {}",
            status,
            if body.is_empty() {
                "empty response".to_string()
            } else {
                body
            }
        );
    }

    tracing::info!("Caddy config updated successfully");
    Ok(())
}

/// Generate the Gateway landing page HTML.
/// This page is served at the root domain and shows all registered apps.
fn generate_landing_page(config: &GatewayConfig) -> String {
    let enabled_routes: Vec<&orca_core::config::GatewayRoute> = config.routes.iter().filter(|r| r.enabled).collect();
    let domain = &config.domain;
    let scheme = if matches!(config.tls_mode, GatewayTlsMode::Custom) || !config.routes.is_empty() {
        "https"
    } else {
        "http"
    };

    let port_suffix = if config.https_port == 443 {
        String::new()
    } else {
        format!(":{}", config.https_port)
    };

    let mut app_cards = String::new();
    for route in &enabled_routes {
        let url = format!("{scheme}://{}.{domain}{port_suffix}", route.hostname);
        let initial = route.hostname.chars().next().unwrap_or('?').to_uppercase().to_string();
        let display_name = route
            .hostname
            .replace('-', " ")
            .split_whitespace()
            .map(|w| {
                let mut c = w.chars();
                match c.next() {
                    None => String::new(),
                    Some(f) => f.to_uppercase().to_string() + c.as_str(),
                }
            })
            .collect::<Vec<_>>()
            .join(" ");

        app_cards.push_str(&format!(
            r#"
      <a href="{url}" class="app-card">
        <div class="app-icon">{initial}</div>
        <div class="app-info">
          <div class="app-name">{display_name}</div>
          <div class="app-host">{hostname}.{domain}{port_suffix}</div>
          <div class="app-target">{container} :{port}</div>
        </div>
        <div class="app-arrow">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        </div>
      </a>"#,
            url = url,
            initial = initial,
            display_name = display_name,
            hostname = route.hostname,
            domain = domain,
            port_suffix = port_suffix,
            container = route.container_name,
            port = route.port,
        ));
    }

    let count = enabled_routes.len();
    let count_label = if count == 1 { "service" } else { "services" };

    format!(
        r##"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Orca Gateway</title>
<style>
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  body {{
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
    background: #0a0e14;
    color: #e6edf3;
    min-height: 100vh;
    overflow-x: hidden;
    -webkit-font-smoothing: antialiased;
  }}
  .bg {{ position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 0; pointer-events: none; }}
  .orb {{
    position: absolute; border-radius: 50%; filter: blur(80px); opacity: 0.5;
    animation: drift 20s ease-in-out infinite alternate;
  }}
  .orb-1 {{
    width: 600px; height: 600px; top: -15%; left: 30%;
    background: radial-gradient(circle, rgba(31, 111, 235, 0.2) 0%, transparent 70%);
  }}
  .orb-2 {{
    width: 500px; height: 500px; bottom: -10%; right: 15%;
    background: radial-gradient(circle, rgba(163, 113, 247, 0.15) 0%, transparent 70%);
    animation-delay: -7s; animation-direction: alternate-reverse;
  }}
  .orb-3 {{
    width: 400px; height: 400px; top: 40%; left: -5%;
    background: radial-gradient(circle, rgba(63, 185, 80, 0.12) 0%, transparent 70%);
    animation-delay: -3s;
  }}
  @keyframes drift {{
    0% {{ transform: translate(0, 0) scale(1); }}
    100% {{ transform: translate(40px, -30px) scale(1.15); }}
  }}
  .container {{
    position: relative; z-index: 1;
    max-width: 720px; margin: 0 auto; padding: 60px 24px 40px;
  }}
  .header {{
    text-align: center; margin-bottom: 48px;
  }}
  .logo {{
    width: 64px; height: 64px; margin: 0 auto 20px;
    background: linear-gradient(135deg, rgba(88, 166, 255, 0.15), rgba(163, 113, 247, 0.15));
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 18px; display: flex; align-items: center; justify-content: center;
    box-shadow: 0 8px 32px rgba(0,0,0,0.3);
    animation: float 6s ease-in-out infinite;
  }}
  @keyframes float {{
    0%, 100% {{ transform: translateY(0); }}
    50% {{ transform: translateY(-6px); }}
  }}
  .logo svg {{ width: 32px; height: 32px; }}
  h1 {{
    font-size: 28px; font-weight: 700; letter-spacing: -0.5px; margin-bottom: 8px;
    background: linear-gradient(135deg, #ffffff 0%, #58a6ff 60%, #a371f7 100%);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
  }}
  .subtitle {{ color: #6e7681; font-size: 14px; }}
  .stats {{
    display: flex; justify-content: center; gap: 32px; margin-top: 20px;
  }}
  .stat {{ text-align: center; }}
  .stat-value {{ font-size: 20px; font-weight: 700; color: #e6edf3; }}
  .stat-label {{ font-size: 11px; color: #484f58; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 2px; }}
  .apps {{ display: flex; flex-direction: column; gap: 8px; }}
  .app-card {{
    display: flex; align-items: center; gap: 16px;
    padding: 16px 20px; border-radius: 14px;
    background: rgba(22, 27, 34, 0.6);
    border: 1px solid rgba(255, 255, 255, 0.06);
    text-decoration: none; color: inherit;
    transition: all 0.2s ease;
    backdrop-filter: blur(12px);
  }}
  .app-card:hover {{
    border-color: rgba(88, 166, 255, 0.3);
    background: rgba(22, 27, 34, 0.8);
    transform: translateY(-2px);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(88, 166, 255, 0.1);
  }}
  .app-icon {{
    width: 44px; height: 44px; border-radius: 12px;
    background: linear-gradient(135deg, rgba(88, 166, 255, 0.12), rgba(163, 113, 247, 0.12));
    border: 1px solid rgba(255, 255, 255, 0.06);
    display: flex; align-items: center; justify-content: center;
    font-size: 18px; font-weight: 700; color: #58a6ff; flex-shrink: 0;
    transition: all 0.2s;
  }}
  .app-card:hover .app-icon {{
    background: linear-gradient(135deg, rgba(88, 166, 255, 0.2), rgba(163, 113, 247, 0.2));
    border-color: rgba(88, 166, 255, 0.2);
    transform: scale(1.05);
  }}
  .app-info {{ flex: 1; min-width: 0; }}
  .app-name {{ font-size: 15px; font-weight: 600; color: #e6edf3; margin-bottom: 2px; }}
  .app-host {{
    font-size: 13px; color: #58a6ff; font-family: "SF Mono", "Fira Code", monospace;
  }}
  .app-target {{
    font-size: 11px; color: #484f58; margin-top: 2px;
    font-family: "SF Mono", "Fira Code", monospace;
  }}
  .app-arrow {{
    color: #30363d; flex-shrink: 0; transition: all 0.2s;
  }}
  .app-card:hover .app-arrow {{
    color: #58a6ff; transform: translateX(3px);
  }}
  .empty {{
    text-align: center; padding: 48px 20px;
    background: rgba(22, 27, 34, 0.4); border-radius: 14px;
    border: 1px dashed rgba(255, 255, 255, 0.08);
  }}
  .empty-title {{ font-size: 16px; font-weight: 600; margin-bottom: 6px; }}
  .empty-desc {{ font-size: 13px; color: #6e7681; line-height: 1.6; }}
  .footer {{
    text-align: center; margin-top: 48px; padding-top: 24px;
    border-top: 1px solid rgba(255, 255, 255, 0.04);
    color: #30363d; font-size: 12px;
  }}
  .footer a {{ color: #484f58; text-decoration: none; }}
  .footer a:hover {{ color: #8b949e; }}
  .tls-badge {{
    display: inline-flex; align-items: center; gap: 4px;
    font-size: 10px; font-weight: 600; color: #3fb950; text-transform: uppercase;
    letter-spacing: 0.5px; background: rgba(63, 185, 80, 0.1);
    padding: 2px 8px; border-radius: 6px; margin-left: 8px;
    border: 1px solid rgba(63, 185, 80, 0.15);
  }}
  @media (max-width: 500px) {{
    .container {{ padding: 40px 16px 24px; }}
    h1 {{ font-size: 22px; }}
    .app-card {{ padding: 12px 14px; gap: 12px; }}
    .app-icon {{ width: 36px; height: 36px; font-size: 15px; border-radius: 10px; }}
  }}
</style>
</head>
<body>
<div class="bg">
  <div class="orb orb-1"></div>
  <div class="orb orb-2"></div>
  <div class="orb orb-3"></div>
</div>
<div class="container">
  <div class="header">
    <div class="logo">
      <svg viewBox="0 0 24 24" fill="none" stroke="#58a6ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <line x1="2" y1="12" x2="22" y2="12"/>
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
      </svg>
    </div>
    <h1>Orca Gateway</h1>
    <div class="subtitle">*.{domain}{port_suffix}<span class="tls-badge"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg> TLS</span></div>
    <div class="stats">
      <div class="stat">
        <div class="stat-value">{count}</div>
        <div class="stat-label">{count_label}</div>
      </div>
      <div class="stat">
        <div class="stat-value">{domain}</div>
        <div class="stat-label">Domain</div>
      </div>
    </div>
  </div>
  <div class="apps">
    {app_cards}{empty_state}
  </div>
  <div class="footer">
    Powered by <a href="https://orca-desktop.com">Orca Desktop</a>
  </div>
</div>
</body>
</html>"##,
        domain = domain,
        port_suffix = port_suffix,
        count = count,
        count_label = count_label,
        app_cards = app_cards,
        empty_state = if enabled_routes.is_empty() {
            r#"
    <div class="empty">
      <div class="empty-title">No services registered</div>
      <div class="empty-desc">Deploy an app template or click "Expose via Gateway" on any container in Orca Desktop.</div>
    </div>"#
        } else {
            ""
        },
    )
}

/// Write the landing page HTML to the certs volume (mounted in Caddy).
fn write_landing_page(config: &GatewayConfig) -> Result<()> {
    let html = generate_landing_page(config);
    let dir = certs_dir();
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join("index.html"), html)?;
    Ok(())
}

/// Pull an image if it's not already present.
async fn pull_if_needed(state: &AppState, image: &str) -> Result<()> {
    let rt = state.rt().await;
    let docker = &rt.docker;

    // Check if image exists
    if docker.inspect_image(image).await.is_ok() {
        return Ok(());
    }

    tracing::info!("Pulling image {image}...");
    use bollard::image::CreateImageOptions;
    let options = CreateImageOptions {
        from_image: image,
        ..Default::default()
    };
    let stream = docker.create_image(Some(options), None, None);
    let items: Vec<_> = tokio_stream::StreamExt::collect(stream).await;
    for item in items {
        item.map_err(|e| anyhow::anyhow!("Pull error: {e}"))?;
    }
    tracing::info!("Image {image} pulled successfully");
    Ok(())
}
