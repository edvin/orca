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
    let containers = rt.list_containers(true).await?;
    if let Some(existing) = containers.iter().find(|c| c.name == CADDY_CONTAINER) {
        if existing.state != ContainerState::Running {
            let _ = rt.remove_container(&existing.id, true).await;
        } else {
            return Ok(existing.id.clone());
        }
    }

    // Pull the Caddy image if not present
    pull_if_needed(state, CADDY_IMAGE).await?;

    // Prepare the certs directory
    let certs_dir = certs_dir();
    std::fs::create_dir_all(&certs_dir)?;

    // Generate certs for all routes if in OrcaCa mode
    if matches!(config.tls_mode, GatewayTlsMode::OrcaCa) {
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
            source: certs_dir.to_string_lossy().to_string(),
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

    let id = rt.create_container(opts).await?;

    // Write the initial Caddy config file into the container
    let caddy_json = build_caddy_config(config);
    write_caddy_config_to_container(state, &id, &caddy_json).await?;

    rt.start_container(&id).await?;

    // Wait for Caddy admin API to be ready
    wait_for_caddy_ready().await?;

    // Push config via admin API
    push_caddy_config(config).await?;

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
    // Generate certs for all enabled routes
    if matches!(config.tls_mode, GatewayTlsMode::OrcaCa) {
        for route in &config.routes {
            if route.enabled {
                generate_cert_for_hostname(&route.hostname)?;
            }
        }
    }
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
    let load_files: Vec<serde_json::Value> = enabled_routes
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

    if !routes.is_empty() {
        caddy["apps"]["http"]["servers"]["gateway"] = serde_json::json!({
            "listen": [":443"],
            "routes": routes,
            "tls_connection_policies": [{}]
        });

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
            _ => {
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
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("Caddy config push failed: {body}");
    }

    tracing::info!("Caddy config updated successfully");
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
