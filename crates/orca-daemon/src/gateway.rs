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
    let mut enabled_routes: Vec<&orca_core::config::GatewayRoute> =
        config.routes.iter().filter(|r| r.enabled).collect();

    // Sort routes so path-specific routes come before hostname-only routes.
    // This ensures /ws/* matches before a catch-all for the same hostname.
    enabled_routes.sort_by(|a, b| {
        let a_has_path = a.path.is_some();
        let b_has_path = b.path.is_some();
        b_has_path.cmp(&a_has_path).then_with(|| a.hostname.cmp(&b.hostname))
    });

    // Build route objects
    let routes: Vec<serde_json::Value> = enabled_routes
        .iter()
        .map(|route| {
            let match_rule = if let Some(path) = &route.path {
                serde_json::json!([{"host": [route.hostname.clone()]}, {"path": [path]}])
            } else {
                serde_json::json!([{"host": [route.hostname.clone()]}])
            };
            serde_json::json!({
                "match": match_rule,
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

    let accent_colors = ["#58a6ff", "#3fb950", "#a371f7", "#d29922", "#f85149", "#79c0ff"];

    // Collect all unique environment names from stack_links
    let mut env_names = std::collections::BTreeSet::new();
    for group in &config.stack_links {
        for link in &group.links {
            for env in link.urls.keys() {
                env_names.insert(env.clone());
            }
        }
    }
    // Always include "local" if there are gateway routes
    if !enabled_routes.is_empty() {
        env_names.insert("local".to_string());
    }

    let mut ordered_envs: Vec<String> = Vec::new();
    if env_names.remove("local") {
        ordered_envs.push("local".to_string());
    }
    ordered_envs.extend(env_names);

    let default_env = ordered_envs.first().cloned().unwrap_or_else(|| "local".to_string());
    let has_envs = !ordered_envs.is_empty();

    // Build tab buttons
    let mut tab_buttons = String::new();
    for env in &ordered_envs {
        let active = if *env == default_env { " active" } else { "" };
        let label = capitalize(env);
        tab_buttons.push_str(&format!(
            r#"<button class="env-tab{active}" data-env="{env}" onclick="switchEnv(this,'{env}')">{label}</button>"#,
        ));
    }

    // Find which gateway routes are referenced in stack_links (for "local" env)
    let mut referenced_hostnames = std::collections::HashSet::new();
    for group in &config.stack_links {
        for link in &group.links {
            if let Some(raw_url) = link.urls.get("local") {
                // The local URL might be just a hostname or hostname.domain
                let hostname = raw_url.split('.').next().unwrap_or(raw_url);
                referenced_hostnames.insert(hostname.to_string());
                // Also store the full value in case it's already the hostname
                referenced_hostnames.insert(raw_url.clone());
            }
        }
    }

    // Build environment-specific content panels
    let mut env_panels = String::new();
    let mut color_idx: usize = 0;

    for env in &ordered_envs {
        let display = if *env == default_env { "block" } else { "none" };
        let is_local = env == "local";
        let mut panel_content = String::new();
        let mut has_content = false;

        // Stack link groups
        for group in &config.stack_links {
            let mut cards_html = String::new();
            let mut group_has_cards = false;

            for link in &group.links {
                let (url_opt, is_placeholder) = if let Some(raw_url) = link.urls.get(env) {
                    let url = if is_local && !raw_url.contains("://") {
                        let hostname = if raw_url.contains('.') {
                            raw_url.to_string()
                        } else {
                            format!("{raw_url}.{domain}")
                        };
                        format!("{scheme}://{hostname}{port_suffix}")
                    } else {
                        raw_url.clone()
                    };
                    (Some(url), false)
                } else {
                    (None, true)
                };

                let color = accent_colors[color_idx % accent_colors.len()];
                color_idx += 1;

                let initial = link.name.chars().next().unwrap_or('?').to_uppercase().to_string();

                // Find container info from gateway routes (for local env)
                let container_info = if is_local {
                    if let Some(raw_url) = link.urls.get("local") {
                        let h = raw_url.split('.').next().unwrap_or(raw_url);
                        enabled_routes
                            .iter()
                            .find(|r| r.hostname == h)
                            .map(|r| format!("{} :{}", r.container_name, r.port))
                    } else {
                        None
                    }
                } else {
                    None
                };

                let display_url = if let Some(ref url) = url_opt {
                    // Show a shorter version for display
                    url.replace("https://", "").replace("http://", "")
                } else {
                    "Not configured".to_string()
                };

                if is_placeholder {
                    cards_html.push_str(&format!(
                        r##"<div class="card card-disabled">
                          <div class="card-icon" style="background:linear-gradient(135deg,{color}18,{color}08);color:{color}60">{initial}</div>
                          <div class="card-body">
                            <div class="card-name">{name}</div>
                            <div class="card-url" style="color:#484f58;font-style:italic">{display_url}</div>
                          </div>
                        </div>"##,
                        color = color,
                        initial = initial,
                        name = link.name,
                        display_url = display_url,
                    ));
                } else if let Some(ref url) = url_opt {
                    let container_line = if let Some(ref info) = container_info {
                        format!(r#"<div class="card-target">{info}</div>"#)
                    } else {
                        String::new()
                    };
                    cards_html.push_str(&format!(
                        r##"<a href="{url}" target="_blank" rel="noopener" class="card">
                          <div class="card-icon" style="background:linear-gradient(135deg,{color}22,{color}0a);color:{color}">{initial}</div>
                          <div class="card-body">
                            <div class="card-name">{name}</div>
                            <div class="card-url">{display_url}</div>
                            {container_line}
                          </div>
                          <div class="card-arrow"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></div>
                        </a>"##,
                        url = url,
                        color = color,
                        initial = initial,
                        name = link.name,
                        display_url = display_url,
                        container_line = container_line,
                    ));
                }

                group_has_cards = true;
            }

            if group_has_cards {
                has_content = true;
                let stack_label = if group.stack.is_empty() {
                    String::new()
                } else {
                    format!(r#" <span class="group-stack">{}</span>"#, group.stack)
                };
                panel_content.push_str(&format!(
                    r#"<div class="group-section">
                      <div class="group-header"><span class="group-line"></span><span class="group-name">{group_name}{stack_label}</span><span class="group-line"></span></div>
                      <div class="card-grid">{cards_html}</div>
                    </div>"#,
                    group_name = group.group,
                    stack_label = stack_label,
                    cards_html = cards_html,
                ));
            }
        }

        // Ungrouped gateway routes (only shown in "local" env)
        if is_local {
            let ungrouped_routes: Vec<_> = enabled_routes
                .iter()
                .filter(|r| !referenced_hostnames.contains(&r.hostname))
                .collect();

            if !ungrouped_routes.is_empty() {
                has_content = true;
                let mut cards_html = String::new();
                for route in &ungrouped_routes {
                    let url = format!("{scheme}://{}.{domain}{port_suffix}", route.hostname);
                    let color = accent_colors[color_idx % accent_colors.len()];
                    color_idx += 1;

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
                    let display_url = format!("{}.{domain}{port_suffix}", route.hostname);

                    cards_html.push_str(&format!(
                        r##"<a href="{url}" target="_blank" rel="noopener" class="card">
                          <div class="card-icon" style="background:linear-gradient(135deg,{color}22,{color}0a);color:{color}">{initial}</div>
                          <div class="card-body">
                            <div class="card-name">{display_name}</div>
                            <div class="card-url">{display_url}</div>
                            <div class="card-target">{container} :{port}</div>
                          </div>
                          <div class="card-arrow"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></div>
                        </a>"##,
                        url = url,
                        color = color,
                        initial = initial,
                        display_name = display_name,
                        display_url = display_url,
                        container = route.container_name,
                        port = route.port,
                    ));
                }

                panel_content.push_str(&format!(
                    r#"<div class="group-section">
                      <div class="group-header"><span class="group-line"></span><span class="group-name">Services</span><span class="group-line"></span></div>
                      <div class="card-grid">{cards_html}</div>
                    </div>"#,
                    cards_html = cards_html,
                ));
            }
        }

        // Empty state for this environment
        if !has_content {
            let env_label = capitalize(env);
            panel_content.push_str(&format!(
                r##"<div class="empty-state">
                  <div class="empty-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#30363d" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="8" y1="12" x2="16" y2="12"/></svg></div>
                  <div class="empty-title">No {env_label} links configured</div>
                  <div class="empty-desc">Add them to your <code>orca.yaml</code> stack links.</div>
                </div>"##,
                env_label = env_label,
            ));
        }

        env_panels.push_str(&format!(
            r#"<div class="env-panel" data-env="{env}" style="display:{display}">{panel_content}</div>"#,
            env = env,
            display = display,
            panel_content = panel_content,
        ));
    }

    // If there are no envs at all, show a simple empty state with gateway routes
    let main_content = if !has_envs && enabled_routes.is_empty() {
        r##"<div class="empty-state">
          <div class="empty-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#30363d" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="8" y1="12" x2="16" y2="12"/></svg></div>
          <div class="empty-title">No services registered</div>
          <div class="empty-desc">Deploy an app template or click &ldquo;Expose via Gateway&rdquo; on any container.</div>
        </div>"##
            .to_string()
    } else if !has_envs {
        // Only gateway routes, no stack_links — build a simple card grid
        let mut cards_html = String::new();
        for (i, route) in enabled_routes.iter().enumerate() {
            let url = format!("{scheme}://{}.{domain}{port_suffix}", route.hostname);
            let color = accent_colors[i % accent_colors.len()];
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
            let display_url = format!("{}.{domain}{port_suffix}", route.hostname);

            cards_html.push_str(&format!(
                r##"<a href="{url}" target="_blank" rel="noopener" class="card">
                  <div class="card-icon" style="background:linear-gradient(135deg,{color}22,{color}0a);color:{color}">{initial}</div>
                  <div class="card-body">
                    <div class="card-name">{display_name}</div>
                    <div class="card-url">{display_url}</div>
                    <div class="card-target">{container} :{port}</div>
                  </div>
                  <div class="card-arrow"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></div>
                </a>"##,
                url = url,
                color = color,
                initial = initial,
                display_name = display_name,
                display_url = display_url,
                container = route.container_name,
                port = route.port,
            ));
        }
        format!(
            r#"<div class="group-section">
              <div class="group-header"><span class="group-line"></span><span class="group-name">Services</span><span class="group-line"></span></div>
              <div class="card-grid">{cards_html}</div>
            </div>"#,
            cards_html = cards_html,
        )
    } else {
        format!(
            r#"{tab_bar}{env_panels}"#,
            tab_bar = if ordered_envs.len() > 1 {
                format!(
                    r#"<div class="env-tabs">{tab_buttons}</div>"#,
                    tab_buttons = tab_buttons
                )
            } else {
                String::new()
            },
            env_panels = env_panels,
        )
    };

    let count = enabled_routes.len();
    let count_label = if count == 1 { "route" } else { "routes" };

    format!(
        r##"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Orca Gateway</title>
<style>
  *{{margin:0;padding:0;box-sizing:border-box}}
  body{{
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
    background:#0a0e14;color:#e6edf3;min-height:100vh;overflow-x:hidden;
    -webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;
  }}

  /* --- Animated background orbs --- */
  .bg{{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden}}
  .orb{{position:absolute;border-radius:50%;filter:blur(100px);opacity:.45;will-change:transform}}
  .orb-1{{
    width:700px;height:700px;top:-18%;left:25%;
    background:radial-gradient(circle,rgba(31,111,235,.22) 0%,transparent 70%);
    animation:drift1 22s ease-in-out infinite alternate;
  }}
  .orb-2{{
    width:550px;height:550px;bottom:-12%;right:10%;
    background:radial-gradient(circle,rgba(163,113,247,.18) 0%,transparent 70%);
    animation:drift2 26s ease-in-out infinite alternate;
  }}
  .orb-3{{
    width:450px;height:450px;top:45%;left:-8%;
    background:radial-gradient(circle,rgba(63,185,80,.14) 0%,transparent 70%);
    animation:drift3 20s ease-in-out infinite alternate;
  }}
  .orb-4{{
    width:350px;height:350px;top:10%;right:-5%;
    background:radial-gradient(circle,rgba(210,153,34,.10) 0%,transparent 70%);
    animation:drift4 24s ease-in-out infinite alternate;
  }}
  @keyframes drift1{{0%{{transform:translate(0,0) scale(1)}}100%{{transform:translate(50px,-40px) scale(1.15)}}}}
  @keyframes drift2{{0%{{transform:translate(0,0) scale(1)}}100%{{transform:translate(-40px,35px) scale(1.1)}}}}
  @keyframes drift3{{0%{{transform:translate(0,0) scale(1)}}100%{{transform:translate(30px,-25px) scale(1.2)}}}}
  @keyframes drift4{{0%{{transform:translate(0,0) scale(1)}}100%{{transform:translate(-20px,30px) scale(1.12)}}}}

  /* --- Layout --- */
  .shell{{position:relative;z-index:1;max-width:880px;margin:0 auto;padding:56px 28px 48px}}

  /* --- Header --- */
  .hdr{{text-align:center;margin-bottom:44px}}
  .logo{{
    width:68px;height:68px;margin:0 auto 22px;
    background:linear-gradient(135deg,rgba(88,166,255,.12),rgba(163,113,247,.12));
    border:1px solid rgba(255,255,255,.07);border-radius:20px;
    display:flex;align-items:center;justify-content:center;
    box-shadow:0 8px 40px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.04);
    animation:float 6s ease-in-out infinite;
    backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);
  }}
  @keyframes float{{0%,100%{{transform:translateY(0)}}50%{{transform:translateY(-7px)}}}}
  .logo svg{{width:34px;height:34px;opacity:.9}}
  h1{{
    font-size:30px;font-weight:800;letter-spacing:-.6px;margin-bottom:10px;
    background:linear-gradient(135deg,#fff 0%,#58a6ff 50%,#a371f7 100%);
    -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;
  }}
  .sub{{color:#6e7681;font-size:14px;display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap}}
  .tls-badge{{
    display:inline-flex;align-items:center;gap:3px;
    font-size:10px;font-weight:700;color:#3fb950;text-transform:uppercase;letter-spacing:.6px;
    background:rgba(63,185,80,.08);padding:3px 8px;border-radius:6px;
    border:1px solid rgba(63,185,80,.12);
  }}

  /* --- Stats bar --- */
  .stats{{
    display:flex;justify-content:center;gap:6px;margin-top:22px;flex-wrap:wrap;
  }}
  .stat{{
    background:rgba(22,27,34,.5);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
    border:1px solid rgba(255,255,255,.05);border-radius:10px;
    padding:10px 20px;text-align:center;min-width:100px;
    transition:border-color .2s;
  }}
  .stat:hover{{border-color:rgba(88,166,255,.15)}}
  .stat-v{{font-size:18px;font-weight:700;color:#e6edf3}}
  .stat-l{{font-size:10px;color:#484f58;text-transform:uppercase;letter-spacing:.6px;margin-top:3px}}

  /* --- Environment tabs --- */
  .env-tabs{{
    display:flex;gap:4px;margin-bottom:20px;padding:3px;
    background:rgba(22,27,34,.4);border-radius:12px;border:1px solid rgba(255,255,255,.04);
    width:fit-content;
  }}
  .env-tab{{
    background:transparent;border:1px solid transparent;border-radius:9px;
    padding:7px 18px;color:#8b949e;cursor:pointer;
    font-size:13px;font-weight:600;text-transform:capitalize;
    transition:all .2s;font-family:inherit;
  }}
  .env-tab:hover{{color:#e6edf3}}
  .env-tab.active{{
    background:rgba(88,166,255,.12);color:#58a6ff;
    border-color:rgba(88,166,255,.2);box-shadow:0 2px 8px rgba(88,166,255,.08);
  }}

  /* --- Group sections --- */
  .group-section{{margin-bottom:28px}}
  .group-header{{
    display:flex;align-items:center;gap:12px;margin-bottom:14px;
  }}
  .group-line{{flex:1;height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,.06),transparent)}}
  .group-name{{
    font-size:11px;font-weight:700;color:#484f58;text-transform:uppercase;
    letter-spacing:1px;white-space:nowrap;
  }}
  .group-stack{{
    font-weight:400;color:#30363d;font-size:10px;letter-spacing:.5px;
  }}

  /* --- Card grid --- */
  .card-grid{{
    display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px;
  }}

  /* --- Cards --- */
  .card{{
    display:flex;align-items:center;gap:14px;
    padding:16px 18px;border-radius:14px;
    background:rgba(22,27,34,.55);
    border:1px solid rgba(255,255,255,.05);
    text-decoration:none;color:inherit;
    transition:transform .2s,box-shadow .2s,border-color .2s,background .2s;
    backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);
    position:relative;overflow:hidden;
  }}
  a.card:hover{{
    border-color:rgba(88,166,255,.25);
    background:rgba(22,27,34,.75);
    transform:translateY(-3px);
    box-shadow:0 12px 40px rgba(0,0,0,.35),0 0 0 1px rgba(88,166,255,.08);
  }}
  .card::after{{
    content:'';position:absolute;inset:0;border-radius:14px;opacity:0;
    background:linear-gradient(135deg,rgba(88,166,255,.04),transparent 60%);
    transition:opacity .2s;pointer-events:none;
  }}
  a.card:hover::after{{opacity:1}}
  .card-disabled{{opacity:.5;cursor:default}}

  .card-icon{{
    width:46px;height:46px;border-radius:13px;flex-shrink:0;
    display:flex;align-items:center;justify-content:center;
    font-size:19px;font-weight:800;
    border:1px solid rgba(255,255,255,.04);
    transition:transform .2s,border-color .2s;
  }}
  a.card:hover .card-icon{{transform:scale(1.08);border-color:rgba(255,255,255,.08)}}

  .card-body{{flex:1;min-width:0}}
  .card-name{{font-size:14px;font-weight:600;color:#e6edf3;margin-bottom:3px}}
  .card-url{{
    font-size:12px;color:#58a6ff;
    font-family:"SF Mono","Fira Code","Cascadia Code",monospace;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  }}
  .card-target{{
    font-size:10px;color:#3d4450;margin-top:3px;
    font-family:"SF Mono","Fira Code","Cascadia Code",monospace;
  }}
  .card-arrow{{
    color:#21262d;flex-shrink:0;transition:all .2s;
  }}
  a.card:hover .card-arrow{{color:#58a6ff;transform:translateX(3px)}}

  /* --- Empty state --- */
  .empty-state{{
    text-align:center;padding:56px 24px;
    background:rgba(22,27,34,.35);border-radius:16px;
    border:1px dashed rgba(255,255,255,.06);
  }}
  .empty-icon{{margin-bottom:14px;opacity:.6}}
  .empty-title{{font-size:15px;font-weight:600;margin-bottom:6px;color:#8b949e}}
  .empty-desc{{font-size:13px;color:#484f58;line-height:1.6}}
  .empty-desc code{{
    background:rgba(88,166,255,.08);color:#58a6ff;padding:2px 6px;
    border-radius:4px;font-size:12px;font-family:"SF Mono","Fira Code",monospace;
  }}

  /* --- Footer --- */
  .ftr{{
    text-align:center;margin-top:52px;padding-top:28px;
    border-top:1px solid rgba(255,255,255,.03);
    color:#21262d;font-size:12px;
  }}
  .ftr a{{color:#30363d;text-decoration:none;transition:color .2s}}
  .ftr a:hover{{color:#8b949e}}

  /* --- Transitions for env switching --- */
  .env-panel{{transition:opacity .2s ease}}

  /* --- Responsive --- */
  @media(max-width:640px){{
    .shell{{padding:36px 16px 28px}}
    h1{{font-size:24px}}
    .card-grid{{grid-template-columns:1fr}}
    .card{{padding:14px 14px;gap:12px}}
    .card-icon{{width:40px;height:40px;font-size:16px;border-radius:11px}}
    .stats{{gap:4px}}
    .stat{{padding:8px 14px;min-width:80px}}
    .stat-v{{font-size:16px}}
    .env-tabs{{flex-wrap:wrap}}
  }}
  @media(min-width:641px) and (max-width:900px){{
    .card-grid{{grid-template-columns:repeat(2,1fr)}}
  }}
</style>
</head>
<body>
<div class="bg">
  <div class="orb orb-1"></div>
  <div class="orb orb-2"></div>
  <div class="orb orb-3"></div>
  <div class="orb orb-4"></div>
</div>
<div class="shell">
  <div class="hdr">
    <div class="logo">
      <svg viewBox="0 0 24 24" fill="none" stroke="#58a6ff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <line x1="2" y1="12" x2="22" y2="12"/>
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
      </svg>
    </div>
    <h1>Orca Gateway</h1>
    <div class="sub">
      <span>*.{domain}{port_suffix}</span>
      <span class="tls-badge"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>TLS</span>
    </div>
    <div class="stats">
      <div class="stat">
        <div class="stat-v">{count}</div>
        <div class="stat-l">{count_label}</div>
      </div>
      <div class="stat">
        <div class="stat-v">{domain}</div>
        <div class="stat-l">Domain</div>
      </div>
    </div>
  </div>
  {main_content}
  <div class="ftr">
    Powered by <a href="https://orca-desktop.com">Orca Desktop</a>
  </div>
</div>
<script>
function switchEnv(btn,env){{
  document.querySelectorAll('.env-tab').forEach(function(t){{t.classList.remove('active')}});
  btn.classList.add('active');
  document.querySelectorAll('.env-panel').forEach(function(p){{
    if(p.getAttribute('data-env')===env){{p.style.display='block';p.style.opacity='0';setTimeout(function(){{p.style.opacity='1'}},10)}}
    else{{p.style.display='none'}}
  }});
}}
</script>
</body>
</html>"##,
        domain = domain,
        port_suffix = port_suffix,
        count = count,
        count_label = count_label,
        main_content = main_content,
    )
}

/// Generate the environment links HTML section for the landing page.
/// Kept for API compatibility — now integrated into generate_landing_page.
#[allow(dead_code)]
fn generate_env_links_html(_config: &GatewayConfig, _scheme: &str, _port_suffix: &str) -> String {
    // Environment links are now integrated directly into generate_landing_page.
    // This function is retained so callers outside this module don't break.
    String::new()
}

/// Capitalize the first letter of a string.
fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        None => String::new(),
        Some(f) => f.to_uppercase().to_string() + c.as_str(),
    }
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
