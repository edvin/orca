//! Gateway manager — manages a Caddy reverse proxy container for hostname-based routing.

use std::collections::HashMap;

use anyhow::{Context, Result};
use orca_core::config::{GatewayConfig, GatewayTlsMode};
use orca_core::network::NetworkManager;
use orca_core::runtime::{ContainerCreateOpts, ContainerRuntime, ContainerState, PortMapping, VolumeMount};

use crate::state::AppState;

const CADDY_IMAGE: &str = "caddy:2-alpine";
pub const CADDY_CONTAINER: &str = "orca-gateway";
/// Caddy's admin API port inside the gateway container.
const CADDY_ADMIN_PORT: u16 = 2019;

/// The port on this computer that reaches the gateway's admin API: 2019, or
/// `ORCA_GATEWAY_ADMIN_PORT` so two Orcas on one computer (such as the video's
/// demo machine) don't share one.
fn admin_port() -> u16 {
    std::env::var("ORCA_GATEWAY_ADMIN_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(CADDY_ADMIN_PORT)
}

fn admin_url(path: &str) -> String {
    format!("http://127.0.0.1:{}{path}", admin_port())
}

/// Marks the Caddy config this Orca pushes (`@id` on the landing route), so
/// it never takes another Caddy on the admin port for its own gateway. It
/// follows the certificates folder, which is per user and per Orca.
fn instance_id() -> String {
    // FNV-1a: the same across Orca versions, unlike std's hasher.
    let mut h: u64 = 0xcbf29ce484222325;
    for b in certs_dir().to_string_lossy().bytes() {
        h = (h ^ b as u64).wrapping_mul(0x100000001b3);
    }
    format!("orca-gateway-{h:016x}")
}

/// Whose Caddy answers on the admin port.
#[derive(Debug, PartialEq)]
enum AdminOwner {
    /// This Orca's gateway.
    Ours,
    /// Another Orca's gateway, or a Caddy someone runs themselves.
    Other,
    /// A gateway started by an Orca from before the config was marked; it
    /// can only be this Orca's own, since it was already running.
    Unmarked,
}

async fn admin_owner(client: &reqwest::Client) -> Result<AdminOwner> {
    let ours = client.get(admin_url(&format!("/id/{}", instance_id()))).send().await?;
    if ours.status().is_success() {
        return Ok(AdminOwner::Ours);
    }
    let config = client
        .get(admin_url("/config/"))
        .send()
        .await?
        .text()
        .await
        .unwrap_or_default();
    // A marked config that isn't ours is another Orca's.
    Ok(if config.contains(r#""@id":"#) {
        AdminOwner::Other
    } else if config.contains("\"file_server\"") && config.contains("/certs") {
        AdminOwner::Unmarked
    } else {
        AdminOwner::Other
    })
}

fn admin_port_taken() -> anyhow::Error {
    anyhow::anyhow!(
        "Port {} on this computer is used by another Caddy server: another Orca's gateway, or one you run yourself. \
         Orca uses that port to configure its gateway. Stop the other one, then start the gateway again.",
        admin_port()
    )
}

/// HTML-entity-escape a user-supplied string for safe insertion into
/// the landing page's HTML. We render stack-link names, hostnames,
/// container names, and URLs into an `index.html` that's served to
/// every gateway user; anything not escaped here is a stored XSS sink.
pub(crate) fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

/// Validate a URL that's about to be rendered as an `href`. Returns the
/// original string if it parses as http/https/mailto; otherwise returns
/// `#` so a malformed or `javascript:` URL cannot become a clickable
/// script-execution sink on the landing page.
pub(crate) fn sanitize_href(url: &str) -> String {
    match reqwest::Url::parse(url) {
        Ok(parsed) => match parsed.scheme() {
            // orca: Orca's own links, such as orca://workspace?setup=crm.
            "http" | "https" | "mailto" | "orca" => url.to_string(),
            scheme => {
                tracing::warn!("gateway landing page: refusing URL with disallowed scheme '{scheme}' (url redacted)");
                "#".to_string()
            }
        },
        Err(e) => {
            tracing::warn!("gateway landing page: refusing unparseable URL: {e}");
            "#".to_string()
        }
    }
}

/// Check if the gateway ports are available.
/// Pass the current gateway config ports to exclude them from conflict detection
/// (the gateway itself holds those ports when running).
pub fn check_port_availability(
    http_port: u16,
    https_port: u16,
    current_http: Option<u16>,
    current_https: Option<u16>,
) -> Vec<String> {
    let mut conflicts = Vec::new();
    // Skip check if the gateway itself is using this port
    if Some(http_port) != current_http && std::net::TcpListener::bind(("0.0.0.0", http_port)).is_err() {
        conflicts.push(format!("Port {} (HTTP) is already in use", http_port));
    }
    if Some(https_port) != current_https && std::net::TcpListener::bind(("0.0.0.0", https_port)).is_err() {
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
    let conflicts = check_port_availability(config.http_port, config.https_port, None, None);
    if !conflicts.is_empty() {
        tracing::warn!("Port conflicts detected: {}", conflicts.join(", "));
    }

    // Nothing of ours is running, so whatever answers on the admin port
    // belongs to someone else, and would be sent this gateway's config.
    let probe = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()?;
    if probe.get(admin_url("/config/")).send().await.is_ok() {
        return Err(admin_port_taken());
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
                generate_cert_for_hostname(&orca_core::config::certificate_name(&route.hostname))?;
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
            "/certs/caddy.json".to_string(),
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
                host_port: admin_port(),
                container_port: CADDY_ADMIN_PORT,
                protocol: "tcp".to_string(),
            },
        ],
        volumes: vec![VolumeMount {
            source: to_docker_mount_path(&certs_dir),
            target: "/certs".to_string(),
            read_only: false,
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
        extra_hosts: host_alias(rt.host.as_deref()),
    };

    let id = rt
        .create_container(opts)
        .await
        .context("Failed to create gateway container")?;

    // Generate the landing page and write Caddy config to the mounted volume
    // (writing to the volume works before the container starts, unlike docker exec)
    let _ = write_landing_page(config);
    // Caddy loads this config as it starts, so the certificate files it
    // names must be there already.
    prepare_certs(config)?;
    let caddy_json = build_caddy_config(config, &[]);
    let config_path = certs_dir.join("caddy.json");
    std::fs::write(&config_path, &caddy_json).context("Failed to write Caddy config to certs volume")?;

    rt.start_container(&id)
        .await
        .context("Failed to start gateway container")?;

    // Wait for Caddy admin API to be ready
    wait_for_caddy_ready()
        .await
        .context("Gateway container started but Caddy admin API is not responding. Check daemon logs")?;

    // Push config via admin API (overrides the file-based config with the same content,
    // but ensures Caddy has loaded it properly)
    push_caddy_config(config)
        .await
        .context("Gateway started but failed to push Caddy configuration")?;
    // Join the routed containers' networks under the routed hostnames.
    crate::gateway_sync::routes_changed();

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

/// At daemon start, a gateway left running by the previous Orca still has
/// the config that version pushed; give it this version's, so the landing
/// page it serves and the routes behind it match.
pub fn resync_on_start(state: std::sync::Arc<AppState>) {
    tokio::spawn(async move {
        if !is_running(&state).await.unwrap_or(false) {
            return;
        }
        let config = state.config.lock().await.gateway.clone();
        // Kubernetes ingress routes, when the gateway proxies Traefik, are
        // part of its config too.
        let result = if config.traefik_mode == orca_core::config::TraefikIntegrationMode::GatewayProxiesTraefik {
            let k8s_routes = crate::api::build_k8s_proxy_routes(&state.k8s, config.traefik_http_port).await;
            match prepare_certs(&config) {
                Ok(()) => {
                    let _ = write_landing_page(&config);
                    let pushed = push_caddy_config_with_k8s(&config, &k8s_routes).await;
                    crate::gateway_sync::routes_changed();
                    pushed
                }
                Err(e) => Err(e),
            }
        } else {
            apply_config(&config).await
        };
        if let Err(e) = result {
            tracing::warn!("gateway: couldn't update the running gateway's config: {e:#}");
        }
    });
}

/// Generate and push Caddy JSON config via the admin API.
pub async fn apply_config(config: &GatewayConfig) -> Result<()> {
    prepare_certs(config)?;
    // Regenerate the landing page
    let _ = write_landing_page(config);
    let pushed = push_caddy_config(config).await;
    // Routes may have changed: join new networks, update hostname aliases.
    crate::gateway_sync::routes_changed();
    pushed
}

/// The certificate files the Caddy config points at: Orca CA ones for the
/// domain and every route, or the custom certificate and key.
fn prepare_certs(config: &GatewayConfig) -> Result<()> {
    if matches!(config.tls_mode, GatewayTlsMode::OrcaCa) {
        generate_cert_for_hostname(&config.domain)?;
        for route in &config.routes {
            if route.enabled {
                generate_cert_for_hostname(&orca_core::config::certificate_name(&route.hostname))?;
            }
        }
    } else if matches!(config.tls_mode, GatewayTlsMode::Custom) {
        // Write user-provided cert/key PEM to files so Caddy can read them
        write_custom_cert_files(config)?;
        // Routes it doesn't cover (your own `app.localhost` next to a
        // workspace's certificate) get the Orca CA's, as without one.
        for route in config
            .routes
            .iter()
            .filter(|r| r.enabled && !custom_cert_covers(config, &r.hostname))
        {
            generate_cert_for_hostname(&orca_core::config::certificate_name(&route.hostname))?;
        }
    }
    Ok(())
}

/// When the custom certificate stops being valid: the first one in its PEM,
/// which is the server's own (the chain follows it).
pub fn custom_cert_expiry(config: &GatewayConfig) -> Option<chrono::DateTime<chrono::Utc>> {
    if !matches!(config.tls_mode, GatewayTlsMode::Custom) {
        return None;
    }
    cert_expiry(config.custom_cert.as_deref()?)
}

pub fn cert_expiry(pem: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    let (_, pem) = x509_parser::pem::parse_x509_pem(pem.as_bytes()).ok()?;
    let cert = pem.parse_x509().ok()?;
    chrono::DateTime::from_timestamp(cert.validity().not_after.timestamp(), 0)
}

/// Days until the custom certificate expires (negative once it has), when
/// that's within `CERT_WARN_DAYS`.
pub fn custom_cert_warning(config: &GatewayConfig) -> Option<(i64, chrono::DateTime<chrono::Utc>)> {
    let expires = custom_cert_expiry(config)?;
    let days = (expires - chrono::Utc::now()).num_days();
    (days <= CERT_WARN_DAYS).then_some((days, expires))
}

/// Whether this computer trusts Orca's certificate authority, judged by
/// verifying a certificate it signed; `None` where Orca can't tell.
pub async fn ca_trusted() -> Option<bool> {
    generate_cert_for_hostname("localhost").ok()?;
    let leaf = certs_dir().join("localhost.pem");
    let mut cmd = if cfg!(target_os = "macos") {
        let mut c = tokio::process::Command::new("/usr/bin/security");
        c.arg("verify-cert")
            .arg("-c")
            .arg(&leaf)
            .args(["-p", "ssl", "-s", "localhost", "-L", "-q"]);
        c
    } else if cfg!(target_os = "linux") {
        let mut c = tokio::process::Command::new("openssl");
        c.args(["verify", "-CApath", "/etc/ssl/certs"]).arg(&leaf);
        c
    } else {
        return None;
    };
    cmd.stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let status = tokio::time::timeout(std::time::Duration::from_secs(10), cmd.status())
        .await
        .ok()?
        .ok()?;
    Some(status.success())
}

/// How long before a custom certificate expires Orca starts saying so.
pub const CERT_WARN_DAYS: i64 = 30;

/// Whether a custom certificate, which is for `*.<domain>` and the domain,
/// covers a route's hostname. A wildcard covers one label only.
pub(crate) fn custom_cert_covers(config: &GatewayConfig, hostname: &str) -> bool {
    let host = hostname.to_ascii_lowercase();
    let domain = config.domain.to_ascii_lowercase();
    !host.contains('.')
        || host == domain
        || host
            .strip_suffix(&format!(".{domain}"))
            .is_some_and(|label| !label.contains('.'))
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

/// Gateway access log, in the certs dir (the only folder mounted into the
/// gateway). Caddy rolls it at 10 MB and keeps two old files.
const ACCESS_LOG: &str = "access.log";

pub fn access_log_path() -> std::path::PathBuf {
    certs_dir().join(ACCESS_LOG)
}

pub(crate) fn certs_dir() -> std::path::PathBuf {
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
/// Hard upper bound on accepted cert/key PEM input so a misbehaving
/// caller can't force an unbounded write.
const MAX_CUSTOM_PEM_BYTES: usize = 64 * 1024;

fn write_custom_cert_files(config: &GatewayConfig) -> Result<()> {
    let dir = certs_dir();
    std::fs::create_dir_all(&dir)?;

    if let Some(cert_pem) = &config.custom_cert.as_deref().filter(|s| !s.trim().is_empty()) {
        if cert_pem.len() > MAX_CUSTOM_PEM_BYTES {
            anyhow::bail!("custom certificate PEM exceeds {MAX_CUSTOM_PEM_BYTES} byte limit");
        }
        // Parse the PEM to ensure we're writing a syntactically valid
        // certificate rather than an arbitrary filesystem path or junk.
        rcgen::CertificateParams::from_ca_cert_pem(cert_pem)
            .map_err(|e| anyhow::anyhow!("custom certificate is not a valid PEM: {e}"))?;
        std::fs::write(dir.join("cert.pem"), cert_pem)?;
        tracing::info!("Wrote custom certificate to {}", dir.join("cert.pem").display());
    }
    if let Some(key_pem) = &config.custom_key.as_deref().filter(|s| !s.trim().is_empty()) {
        if key_pem.len() > MAX_CUSTOM_PEM_BYTES {
            anyhow::bail!("custom key PEM exceeds {MAX_CUSTOM_PEM_BYTES} byte limit");
        }
        rcgen::KeyPair::from_pem(key_pem).map_err(|e| anyhow::anyhow!("custom key is not a valid PEM: {e}"))?;
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
/// A certificate's file name: its hostname, with a wildcard spelled out
/// (`*` isn't allowed in Windows file names).
fn cert_file_stem(name: &str) -> String {
    name.replace('*', "_wildcard")
}

fn generate_cert_for_hostname(hostname: &str) -> Result<()> {
    // Defense in depth: the API layer validates gateway hostnames before
    // they reach this function, but we re-check here so an internal caller
    // can't accidentally reach the filesystem join with `../`.
    if hostname.is_empty() || hostname.len() > 253 {
        anyhow::bail!("invalid hostname length");
    }
    for (i, label) in hostname.split('.').enumerate() {
        // `*.local.example.dev`: a wildcard certificate, for pattern routes.
        if i == 0 && label == "*" {
            continue;
        }
        if label.is_empty() || label.len() > 63 {
            anyhow::bail!("invalid hostname label length");
        }
        if label.starts_with('-') || label.ends_with('-') {
            anyhow::bail!("hostname label must not start or end with '-'");
        }
        if !label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            anyhow::bail!("hostname contains invalid characters");
        }
    }

    let certs = certs_dir();
    std::fs::create_dir_all(&certs)?;

    let stem = cert_file_stem(hostname);
    let cert_path = certs.join(format!("{stem}.pem"));
    let key_path = certs.join(format!("{stem}-key.pem"));

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

        let mut params = rcgen::CertificateParams::new(Vec::<String>::new())
            .map_err(|e| anyhow::anyhow!("Failed to create CA params: {e}"))?;
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

        let key_pair =
            rcgen::KeyPair::generate().map_err(|e| anyhow::anyhow!("Failed to generate CA key pair: {e}"))?;
        let cert = params
            .self_signed(&key_pair)
            .map_err(|e| anyhow::anyhow!("Failed to self-sign CA certificate: {e}"))?;

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

/// Recreate a running gateway that predates [`host_alias`], so host dev
/// servers become reachable without the user restarting it by hand.
pub async fn ensure_host_alias(state: &AppState, config: &GatewayConfig) -> Result<()> {
    let rt = state.rt().await;
    let want = host_alias(rt.host.as_deref());
    if want.is_empty() {
        return Ok(());
    }
    let Ok(info) = rt.docker.inspect_container(CADDY_CONTAINER, None).await else {
        return Ok(());
    };
    let have = info.host_config.and_then(|h| h.extra_hosts).unwrap_or_default();
    if want.iter().all(|w| have.contains(w)) {
        return Ok(());
    }
    tracing::info!("Recreating the gateway so it can reach host dev servers");
    stop(state).await?;
    start(state, config).await?;
    for route in config.routes.iter().filter(|r| r.enabled) {
        if let Err(e) = ensure_network_connectivity(state, &route.container_name).await {
            tracing::warn!("gateway could not reach {}: {e}", route.container_name);
        }
    }
    Ok(())
}

/// `/etc/hosts` entry that lets the gateway reach this computer as
/// `host.docker.internal` (host dev servers, Traefik).
///
/// Linux: `host-gateway` is the host. In a Lima VM `host-gateway` is the VM,
/// and the name comes from Lima's DNS, which never answers its AAAA query: Go
/// (Caddy) waits for both and fails with "i/o timeout". The Mac is at Lima's
/// fixed user-network gateway, so pin that. Docker Desktop resolves the name
/// itself.
fn host_alias(docker_host: Option<&str>) -> Vec<String> {
    if cfg!(target_os = "linux") {
        vec!["host.docker.internal:host-gateway".to_string()]
    } else if docker_host.is_some_and(|h| h.contains("/.lima/")) {
        vec!["host.docker.internal:192.168.5.2".to_string()]
    } else {
        vec![]
    }
}

/// Get the upstream host address for reaching Traefik from the Caddy container.
pub fn traefik_upstream_host() -> &'static str {
    if cfg!(target_os = "macos") || cfg!(target_os = "windows") {
        "host.docker.internal"
    } else {
        "172.17.0.1" // Docker bridge gateway on Linux
    }
}

/// Build the Caddy JSON configuration from gateway config.
/// `k8s_routes` is an optional list of (hostname, upstream) pairs for K8s ingress proxying.
fn build_caddy_config(config: &GatewayConfig, k8s_routes: &[(String, String)]) -> String {
    let mut enabled_routes: Vec<&orca_core::config::GatewayRoute> =
        config.routes.iter().filter(|r| r.enabled).collect();

    // Caddy takes the first route that matches, so the most specific come
    // first: WebSocket-only routes (they only match upgrades), then exact
    // hostnames before patterns, then routes with a path before those
    // without, so /api/* wins over the rest of the same hostname, and a
    // longer path before a shorter one (/api/admin/* before /api/*).
    // Among patterns, the one that fixes more of the hostname wins:
    // `*-docs.example.dev` before `*.example.dev`.
    let fixed = |r: &orca_core::config::GatewayRoute| std::cmp::Reverse(r.hostname.replace('*', "").len());
    let path_len = |r: &orca_core::config::GatewayRoute| {
        std::cmp::Reverse(r.path.as_deref().map_or(0, |p| p.trim_end_matches('*').len()))
    };
    enabled_routes.sort_by(|a, b| {
        (
            !a.websocket,
            a.is_pattern(),
            fixed(a),
            a.path.is_none(),
            path_len(a),
            &a.hostname,
            &a.path,
        )
            .cmp(&(
                !b.websocket,
                b.is_pattern(),
                fixed(b),
                b.path.is_none(),
                path_len(b),
                &b.hostname,
                &b.path,
            ))
    });

    // Build route objects
    let mut routes: Vec<serde_json::Value> = enabled_routes
        .iter()
        .map(|route| {
            // One matcher set: everything in it must match (separate sets
            // would be alternatives, sending a whole hostname to a path route).
            let mut matcher = serde_json::Map::new();
            if route.is_pattern() {
                let re = orca_core::config::host_pattern_regex(&route.hostname);
                matcher.insert(
                    "expression".into(),
                    serde_json::json!(format!("{{http.request.host}}.matches(r'{re}')")),
                );
            } else {
                matcher.insert("host".into(), serde_json::json!([route.hostname.clone()]));
            }
            if let Some(path) = &route.path {
                matcher.insert("path".into(), serde_json::json!([path]));
            }
            if route.websocket {
                matcher.insert(
                    "header_regexp".into(),
                    serde_json::json!({ "Upgrade": { "pattern": "(?i)^websocket$" } }),
                );
            }
            let match_rule = serde_json::json!([matcher]);
            let handle = if route.sleeping {
                // Idle-stopped worktree instance: show a page that reloads
                // itself; Orca sees the request and starts the instance.
                serde_json::json!([{
                    "handler": "static_response",
                    "status_code": 503,
                    "headers": {
                        "Content-Type": ["text/html; charset=utf-8"],
                        "Cache-Control": ["no-store"],
                        "Retry-After": ["3"]
                    },
                    "body": wake_page(route)
                }])
            } else {
                serde_json::json!([{
                    "handler": "reverse_proxy",
                    "upstreams": [{"dial": format!("{}:{}", route.container_name, route.port)}]
                }])
            };
            serde_json::json!({ "match": match_rule, "handle": handle })
        })
        .collect();

    // When a route's service doesn't answer (stopped, or still starting), a
    // page that says so, offers to start it in Orca and reloads once it's
    // up, instead of an empty 502.
    let down = "{http.error.status_code} >= 502 && {http.error.status_code} <= 504";
    let error_routes: Vec<serde_json::Value> = enabled_routes
        .iter()
        .filter(|r| !r.websocket && !r.sleeping)
        .map(|route| {
            let mut matcher = serde_json::Map::new();
            let expression = if route.is_pattern() {
                let re = orca_core::config::host_pattern_regex(&route.hostname);
                format!("{{http.request.host}}.matches(r'{re}') && {down}")
            } else {
                matcher.insert("host".into(), serde_json::json!([route.hostname.clone()]));
                down.to_string()
            };
            matcher.insert("expression".into(), serde_json::json!(expression));
            if let Some(path) = &route.path {
                matcher.insert("path".into(), serde_json::json!([path]));
            }
            serde_json::json!({
                "match": [matcher],
                "handle": [{
                    "handler": "static_response",
                    "status_code": "{http.error.status_code}",
                    "headers": {
                        "Content-Type": ["text/html; charset=utf-8"],
                        "Cache-Control": ["no-store"]
                    },
                    "body": down_page(route, config)
                }]
            })
        })
        .collect();

    // Add K8s ingress routes (when in gateway_proxies_traefik mode)
    for (hostname, upstream) in k8s_routes {
        routes.push(serde_json::json!({
            "match": [{"host": [hostname.clone()]}],
            "handle": [{
                "handler": "reverse_proxy",
                "upstreams": [{"dial": upstream.clone()}]
            }]
        }));
    }

    // Build TLS certificates list
    let mut load_files: Vec<serde_json::Value> = enabled_routes
        .iter()
        .map(|route| match config.tls_mode {
            GatewayTlsMode::OrcaCa | GatewayTlsMode::Unknown => {
                let stem = cert_file_stem(&orca_core::config::certificate_name(&route.hostname));
                serde_json::json!({
                    "certificate": format!("/certs/{stem}.pem"),
                    "key": format!("/certs/{stem}-key.pem"),
                })
            }
            GatewayTlsMode::Custom if !custom_cert_covers(config, &route.hostname) => {
                let stem = cert_file_stem(&orca_core::config::certificate_name(&route.hostname));
                serde_json::json!({
                    "certificate": format!("/certs/{stem}.pem"),
                    "key": format!("/certs/{stem}-key.pem"),
                })
            }
            GatewayTlsMode::Custom => {
                // The custom_cert/custom_key fields hold PEM *content*, not a
                // path. `write_custom_cert_files` writes that content to
                // fixed locations inside the certs volume; always reference
                // those files so Caddy doesn't try to parse a PEM blob as a
                // path or read from an arbitrary filesystem location.
                serde_json::json!({
                    "certificate": "/certs/cert.pem",
                    "key": "/certs/key.pem",
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
    // Every path gets index.html: /certs also holds private keys, the Caddy
    // config and the access log, none of which may be served.
    let landing_route = serde_json::json!({
        "@id": instance_id(),
        "handle": [
            {"handler": "rewrite", "uri": "/index.html"},
            {"handler": "file_server", "root": "/certs"}
        ]
    });

    // Add a cert for the root domain so the landing page works over HTTPS
    if matches!(config.tls_mode, GatewayTlsMode::OrcaCa) {
        load_files.push(serde_json::json!({
            "certificate": format!("/certs/{}.pem", config.domain),
            "key": format!("/certs/{}-key.pem", config.domain),
        }));
    }

    // The landing page's icons, as files the browser caches instead of data
    // inside the page it fetches again every 20 s. Only their own folder.
    let icons_route = serde_json::json!({
        "match": [{"path": [format!("{}*", crate::landing::ICON_PATH)]}],
        "handle": [
            // An SVG opened on its own must not run script on this origin.
            {"handler": "headers", "response": {"set": {
                "Cache-Control": ["public, max-age=604800, immutable"],
                "Content-Security-Policy": ["default-src 'none'; style-src 'unsafe-inline'; sandbox"],
                "X-Content-Type-Options": ["nosniff"]
            }}},
            {"handler": "rewrite", "strip_path_prefix": crate::landing::ICON_PATH.trim_end_matches('/')},
            {"handler": "file_server", "root": format!("/certs/{}", crate::landing::ICON_DIR)}
        ]
    });

    // HTTPS server: reverse proxy routes + landing page fallback
    let mut all_routes = routes;
    all_routes.push(icons_route);
    all_routes.push(landing_route);

    caddy["apps"]["http"]["servers"]["gateway"] = serde_json::json!({
        "listen": [":443"],
        "routes": all_routes,
        "errors": {"routes": error_routes},
        "tls_connection_policies": [{}],
        // Access log lets Orca tell which worktree instances are in use
        // (idle stop, wake on request); written to ACCESS_LOG below.
        "logs": {}
    });
    // Access lines go to a rotated file instead of the container output,
    // which Docker would otherwise keep growing for the container's life.
    caddy["logging"] = serde_json::json!({
        "logs": {
            "default": {"exclude": ["http.log.access", "http.log.error"]},
            // Errors a route's "isn't running" page answered are logged at
            // debug level; the Requests tab reads them to say why it failed.
            "errors": {"include": ["http.log.error"], "level": "DEBUG"},
            "access": {
                "include": ["http.log.access"],
                "encoder": {"format": "json"},
                "writer": {
                    "output": "file",
                    "filename": format!("/certs/{ACCESS_LOG}"),
                    "roll_size_mb": 10,
                    "roll_keep": 2,
                    // Caddy runs as root in the container; the daemon reads this.
                    "mode": "0644"
                }
            }
        }
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

/// Text for a page Caddy serves as a static response: HTML-escaped, and
/// with `{` and `}` as entities, since Caddy fills in `{placeholders}` in
/// those bodies (a route title must not pull in request data or files).
fn page_text(s: &str) -> String {
    escape_html(s).replace('{', "&#123;").replace('}', "&#125;")
}

/// The page shown while an idle-stopped instance starts again.
fn wake_page(route: &orca_core::config::GatewayRoute) -> String {
    let name = route
        .owner
        .as_deref()
        .and_then(|o| o.strip_prefix("dev:"))
        .map(|o| o.split('#').next().unwrap_or(o).replace(':', " / "))
        .unwrap_or_else(|| route.hostname.clone());
    let name = page_text(&name);
    format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="3"><title>Starting {name}</title>
<style>body{{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0e14;color:#e6edf3;font:15px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}}
.box{{text-align:center;max-width:460px;padding:24px}}.spin{{width:28px;height:28px;margin:0 auto 18px;border:3px solid rgba(88,166,255,.25);border-top-color:#58a6ff;border-radius:50%;animation:s .8s linear infinite}}
@keyframes s{{to{{transform:rotate(360deg)}}}}h1{{font-size:18px;font-weight:600;margin:0 0 8px}}p{{color:#8b949e;line-height:1.5;margin:0}}</style></head>
<body><div class="box"><div class="spin"></div><h1>Starting {name}</h1><p>Orca stopped this worktree instance while it was unused. It is starting again; this page reloads by itself.</p></div></body></html>"#
    )
}

/// The page for a route whose service doesn't answer: its name, a button
/// that starts it in Orca, and the app as soon as it answers. The container
/// and port only when the landing page shows them too.
fn down_page(route: &orca_core::config::GatewayRoute, config: &GatewayConfig) -> String {
    let domain = &config.domain;
    let host = if route.hostname.contains('.') {
        route.hostname.clone()
    } else {
        format!("{}.{domain}", route.hostname)
    };
    let name = route
        .presentation
        .title
        .clone()
        .unwrap_or_else(|| crate::landing::default_title(route, &host));
    let name = page_text(&name);
    let at = if config.landing.show_targets {
        format!(
            "Nothing answers at <code>{}</code>. ",
            page_text(&format!("{}:{}", route.container_name, route.port))
        )
    } else {
        String::new()
    };
    let port = if config.https_port == 443 {
        String::new()
    } else {
        format!(":{}", config.https_port)
    };
    let home = page_text(&format!("https://{}{port}/", domain.trim_start_matches("*.")));
    format!(
        r##"<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{name} isn't running</title>
<style>body{{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0e14;color:#e6edf3;font:15px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}}
.box{{text-align:center;max-width:460px;padding:24px}}.dot{{width:10px;height:10px;border-radius:50%;background:#6e7681;margin:0 auto 18px;box-shadow:0 0 0 6px rgba(110,118,129,.15)}}
h1{{font-size:20px;font-weight:600;margin:0 0 8px}}p{{color:#8b949e;line-height:1.55;margin:0 0 22px}}code{{font:12.5px "SF Mono",ui-monospace,Menlo,monospace;color:#a8b3bf}}
.btns{{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}}a{{text-decoration:none;font-weight:600;font-size:14px;border-radius:9px;padding:9px 18px}}
.go{{background:#58a6ff;color:#0a0e14}}.go:hover{{background:#79b8ff}}.alt{{color:#8b949e;border:1px solid rgba(255,255,255,.12)}}.alt:hover{{color:#e6edf3}}
.wait{{display:none;font-size:13px;color:#8b949e;margin-top:20px}}.wait.on{{display:block}}</style></head>
<body><div class="box"><div class="dot"></div><h1>{name} isn't running</h1><p>{at}Start it in Orca, and this page opens it as soon as it's up.</p>
<div class="btns"><a class="go" id="start" href="#">Start in Orca</a><a class="alt" href="{home}">All services</a></div><p class="wait" id="wait">Waiting for it to start…</p></div>
<script>(function(){{
var s=document.getElementById('start');s.href='orca://app?do=start&url='+encodeURIComponent(location.href);
s.addEventListener('click',function(){{document.getElementById('wait').classList.add('on')}});
// Asks with a marker the Requests tab leaves out; opens the page again
// with a plain GET once it answers, never resending a form.
var probe=new URL(location.href);probe.searchParams.set('_orca_wait','1');
function check(){{if(document.hidden)return;fetch(probe.href,{{cache:'no-store',redirect:'manual'}}).then(function(r){{if(r.status<502||r.status>504)location.href=location.href}}).catch(function(){{}})}}
setInterval(check,5000);
}})()</script></body></html>"##
    )
}

/// Wait for the Caddy admin API to be ready, with this gateway's config
/// (the one written to `caddy.json`) loaded.
async fn wait_for_caddy_ready() -> Result<()> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()?;

    let mut other = false;
    for attempt in 1..=20 {
        match admin_owner(&client).await {
            Ok(AdminOwner::Ours) => {
                tracing::info!("Caddy admin API ready (attempt {attempt})");
                return Ok(());
            }
            Ok(owner) => {
                other = true;
                tracing::debug!("Caddy admin API attempt {attempt}/20: answered by {owner:?}");
            }
            Err(e) => {
                tracing::debug!("Caddy admin API attempt {attempt}/20: connection error: {e}");
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }

    if other {
        return Err(admin_port_taken());
    }
    anyhow::bail!("Caddy admin API did not become ready within 10 seconds")
}

/// Push Caddy config via the admin API, optionally with K8s routes.
async fn push_caddy_config(config: &GatewayConfig) -> Result<()> {
    push_caddy_config_with_k8s(config, &[]).await
}

/// Push Caddy config via the admin API, with optional K8s routes.
pub async fn push_caddy_config_with_k8s(config: &GatewayConfig, k8s_routes: &[(String, String)]) -> Result<()> {
    let caddy_json = build_caddy_config(config, k8s_routes);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()?;

    // Never hand this gateway's routes to someone else's Caddy.
    if admin_owner(&client)
        .await
        .context("Failed to reach the gateway's Caddy")?
        == AdminOwner::Other
    {
        return Err(admin_port_taken());
    }

    // A certificate written a moment ago can take a moment to show up in
    // the container (the VM's file sharing), so a failed load is retried.
    let mut attempt = 1;
    loop {
        let resp = client
            .post(admin_url("/load"))
            .header("Content-Type", "application/json")
            .body(caddy_json.clone())
            .send()
            .await
            .context("Failed to push config to Caddy")?;
        if resp.status().is_success() {
            break;
        }
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if attempt < 3 && status == reqwest::StatusCode::BAD_REQUEST && body.contains("no such file") {
            tracing::debug!("Caddy config push attempt {attempt}: {body}");
            attempt += 1;
            tokio::time::sleep(std::time::Duration::from_millis(700)).await;
            continue;
        }
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

/// Write the landing page to the certs volume (Caddy serves it), with the
/// last known state of each service; see [`crate::landing`].
fn write_landing_page(config: &GatewayConfig) -> Result<()> {
    crate::landing::write(config)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use orca_core::config::*;

    #[test]
    fn host_alias_per_engine() {
        let lima = host_alias(Some("unix:///Users/me/.lima/orca/sock/docker.sock"));
        let desktop = host_alias(Some("unix:///Users/me/.docker/run/docker.sock"));
        if cfg!(target_os = "linux") {
            assert_eq!(lima, ["host.docker.internal:host-gateway"]);
            assert_eq!(desktop, ["host.docker.internal:host-gateway"]);
        } else {
            assert_eq!(lima, ["host.docker.internal:192.168.5.2"]);
            assert!(desktop.is_empty());
            assert!(host_alias(None).is_empty());
        }
    }

    fn make_config(routes: Vec<GatewayRoute>) -> GatewayConfig {
        GatewayConfig {
            domain: "localhost".to_string(),
            http_port: 80,
            https_port: 443,
            tls_mode: GatewayTlsMode::OrcaCa,
            routes,
            ..Default::default()
        }
    }

    #[test]
    fn the_down_page_keeps_caddy_placeholders_out() {
        let mut r = make_route("shop.localhost", "shop-web-1", 3000);
        r.presentation.title = Some("{file./certs/key.pem}{http.request.uri.query.x}".into());
        let mut c = make_config(vec![r.clone()]);
        let page = down_page(&r, &c);
        assert!(!page.contains("{file."), "{page}");
        assert!(!page.contains("{http."), "{page}");
        assert!(page.contains("&#123;file./certs/key.pem&#125;"));
        assert!(page.contains("<code>shop-web-1:3000</code>"));
        assert!(page.contains(r#"href="https://localhost/""#));

        // "Show container and port" off, and another HTTPS port.
        c.landing.show_targets = false;
        c.https_port = 8443;
        let page = down_page(&r, &c);
        assert!(!page.contains("shop-web-1"), "{page}");
        assert!(page.contains(r#"href="https://localhost:8443/""#));

        let mut w = r.clone();
        w.owner = Some("dev:{env.HOME}".into());
        assert!(!wake_page(&w).contains("{env."));
    }

    #[test]
    fn icons_cannot_run_script_and_handled_errors_stay_logged() {
        let caddy: serde_json::Value = serde_json::from_str(&build_caddy_config(
            &make_config(vec![make_route("a.localhost", "a", 80)]),
            &[],
        ))
        .unwrap();
        let routes = caddy["apps"]["http"]["servers"]["gateway"]["routes"]
            .as_array()
            .unwrap();
        let icons = routes
            .iter()
            .find(|r| {
                r["match"][0]["path"][0]
                    .as_str()
                    .is_some_and(|p| p.starts_with("/_orca/icons/"))
            })
            .unwrap();
        let set = &icons["handle"][0]["response"]["set"];
        assert!(set["Content-Security-Policy"][0].as_str().unwrap().contains("sandbox"));
        assert_eq!(set["X-Content-Type-Options"][0], "nosniff");
        let errors = &caddy["logging"]["logs"]["errors"];
        assert_eq!(errors["include"][0], "http.log.error");
        assert_eq!(errors["level"], "DEBUG");
        assert!(
            caddy["logging"]["logs"]["default"]["exclude"]
                .as_array()
                .unwrap()
                .contains(&serde_json::json!("http.log.error"))
        );
    }

    fn make_route(hostname: &str, container: &str, port: u16) -> GatewayRoute {
        GatewayRoute {
            hostname: hostname.to_string(),
            container_name: container.to_string(),
            port,
            enabled: true,
            path: None,
            owner: None,
            sleeping: false,
            websocket: false,
            presentation: Default::default(),
        }
    }

    fn make_route_with_path(hostname: &str, container: &str, port: u16, path: &str) -> GatewayRoute {
        GatewayRoute {
            hostname: hostname.to_string(),
            container_name: container.to_string(),
            port,
            enabled: true,
            path: Some(path.to_string()),
            owner: None,
            sleeping: false,
            websocket: false,
            presentation: Default::default(),
        }
    }

    // ---- build_caddy_config tests ----

    #[test]
    fn config_is_marked_as_this_orcas() {
        let caddy: serde_json::Value = serde_json::from_str(&build_caddy_config(&make_config(vec![]), &[])).unwrap();
        let routes = caddy["apps"]["http"]["servers"]["gateway"]["routes"]
            .as_array()
            .unwrap();
        let ids: Vec<_> = routes.iter().filter_map(|r| r["@id"].as_str()).collect();
        // Exactly one: Caddy refuses a config with an @id used twice.
        assert_eq!(ids, [instance_id()]);
        assert_eq!(instance_id(), instance_id());
    }

    #[test]
    fn test_build_caddy_config_empty_routes() {
        let config = make_config(vec![]);
        let json_str = build_caddy_config(&config, &[]);
        let caddy: serde_json::Value = serde_json::from_str(&json_str).expect("valid JSON");

        // Admin config should be present
        assert!(caddy["admin"]["listen"].as_str().unwrap().contains("2019"));

        // Should have the gateway server with the landing page fallback
        let gateway = &caddy["apps"]["http"]["servers"]["gateway"];
        assert!(
            gateway["listen"]
                .as_array()
                .unwrap()
                .contains(&serde_json::json!(":443"))
        );
        let routes = gateway["routes"].as_array().unwrap();
        // The landing page's icons and the page itself (no reverse_proxy routes)
        assert_eq!(routes.len(), 2);
        // Icons come only from their own folder: /certs holds private keys.
        assert_eq!(routes[0]["match"][0]["path"][0], "/_orca/icons/*");
        assert_eq!(routes[0]["handle"][2]["root"], "/certs/landing-icons");
        // The fallback only ever serves index.html.
        assert_eq!(routes[1]["handle"][0]["handler"], "rewrite");
        assert_eq!(routes[1]["handle"][0]["uri"], "/index.html");
        assert_eq!(routes[1]["handle"][1]["handler"], "file_server");
        // Access lines go to a rotated file, not the container output.
        let access = &caddy["logging"]["logs"]["access"];
        assert_eq!(access["writer"]["output"], "file");
        assert_eq!(access["writer"]["filename"], "/certs/access.log");
        assert_eq!(caddy["logging"]["logs"]["default"]["exclude"][0], "http.log.access");

        // HTTP redirect server should exist
        let redirect = &caddy["apps"]["http"]["servers"]["http_redirect"];
        assert!(
            redirect["listen"]
                .as_array()
                .unwrap()
                .contains(&serde_json::json!(":80"))
        );
    }

    #[test]
    fn test_build_caddy_config_single_route() {
        let config = make_config(vec![make_route("app", "frontend-1", 3000)]);
        let json_str = build_caddy_config(&config, &[]);
        let caddy: serde_json::Value = serde_json::from_str(&json_str).expect("valid JSON");

        let routes = caddy["apps"]["http"]["servers"]["gateway"]["routes"]
            .as_array()
            .unwrap();
        // One reverse_proxy route + one landing page fallback
        assert_eq!(routes.len(), 3, "the route, the icons, the landing page");

        // First route should be the reverse_proxy
        let first = &routes[0];
        assert_eq!(first["handle"][0]["handler"], "reverse_proxy");
        let dial = first["handle"][0]["upstreams"][0]["dial"].as_str().unwrap();
        assert_eq!(dial, "frontend-1:3000");

        // Host matcher
        let host_match = &first["match"][0]["host"][0];
        assert_eq!(host_match, "app");
    }

    #[test]
    fn test_build_caddy_config_path_routes_sorted_before_catchall() {
        let config = make_config(vec![
            make_route("app", "frontend-1", 3000),
            make_route_with_path("app", "backend-1", 8080, "/api/*"),
        ]);
        let json_str = build_caddy_config(&config, &[]);
        let caddy: serde_json::Value = serde_json::from_str(&json_str).expect("valid JSON");

        let routes = caddy["apps"]["http"]["servers"]["gateway"]["routes"]
            .as_array()
            .unwrap();
        // 2 reverse_proxy routes + 1 landing page fallback
        assert_eq!(routes.len(), 4);

        // The path route comes first, with host and path in one matcher set:
        // separate sets would be alternatives, and every request to the
        // hostname would go to the API.
        let first = &routes[0]["match"];
        assert_eq!(first.as_array().unwrap().len(), 1, "one matcher set: {first}");
        assert_eq!(first[0]["host"][0], "app");
        assert_eq!(first[0]["path"][0], "/api/*");

        let second = &routes[1]["match"];
        assert_eq!(second.as_array().unwrap().len(), 1);
        assert!(second[0].get("path").is_none(), "hostname-only route comes second");
    }

    #[test]
    fn pattern_and_websocket_routes() {
        let mut ws = make_route("app.localhost", "reverb-1", 8080);
        ws.websocket = true;
        let config = make_config(vec![
            make_route("*-shop.localhost", "shop-1", 80),
            make_route("shop.localhost", "shop-1", 80),
            ws,
        ]);
        let caddy: serde_json::Value = serde_json::from_str(&build_caddy_config(&config, &[])).unwrap();
        let routes = caddy["apps"]["http"]["servers"]["gateway"]["routes"]
            .as_array()
            .unwrap();
        // WebSocket first, then the exact hostname, then the pattern.
        assert_eq!(
            routes[0]["match"][0]["header_regexp"]["Upgrade"]["pattern"],
            "(?i)^websocket$"
        );
        assert_eq!(routes[1]["match"][0]["host"][0], "shop.localhost");
        let expr = routes[2]["match"][0]["expression"].as_str().unwrap();
        assert_eq!(
            expr,
            "{http.request.host}.matches(r'(?i)^[a-z0-9-]+-shop\\.localhost$')"
        );
    }

    #[test]
    fn longer_path_wins() {
        let mut api = make_route("app.localhost", "api-1", 80);
        api.path = Some("/api/*".into());
        let mut admin = make_route("app.localhost", "admin-1", 80);
        admin.path = Some("/api/admin/*".into());
        let config = make_config(vec![make_route("app.localhost", "web-1", 80), api, admin]);
        let caddy: serde_json::Value = serde_json::from_str(&build_caddy_config(&config, &[])).unwrap();
        let routes = caddy["apps"]["http"]["servers"]["gateway"]["routes"]
            .as_array()
            .unwrap();
        assert_eq!(routes[0]["match"][0]["path"][0], "/api/admin/*");
        assert_eq!(routes[1]["match"][0]["path"][0], "/api/*");
        assert!(routes[2]["match"][0].get("path").is_none());
    }

    #[test]
    fn test_build_caddy_config_custom_tls() {
        let config = GatewayConfig {
            domain: "example.com".to_string(),
            http_port: 80,
            https_port: 443,
            tls_mode: GatewayTlsMode::Custom,
            custom_cert: None,
            custom_key: None,
            routes: vec![make_route("app", "frontend-1", 3000)],
            ..Default::default()
        };
        let json_str = build_caddy_config(&config, &[]);
        let caddy: serde_json::Value = serde_json::from_str(&json_str).expect("valid JSON");

        // Custom TLS without explicit cert/key should default to /certs/cert.pem and /certs/key.pem
        let load_files = caddy["apps"]["tls"]["certificates"]["load_files"].as_array().unwrap();
        let cert_entry = &load_files[0];
        assert_eq!(cert_entry["certificate"], "/certs/cert.pem");
        assert_eq!(cert_entry["key"], "/certs/key.pem");
    }

    #[test]
    fn custom_cert_routes_it_doesnt_cover_get_orca_ca_certs() {
        // A workspace's certificate for *.local.acme.dev, next to your own
        // app.localhost: that one keeps a certificate Orca's CA signs.
        let config = GatewayConfig {
            domain: "local.acme.dev".to_string(),
            tls_mode: GatewayTlsMode::Custom,
            routes: vec![
                make_route("crm.local.acme.dev", "crm-1", 80),
                make_route("app.localhost", "app-1", 3000),
                make_route("api.crm.local.acme.dev", "api-1", 80),
                make_route("*-shop.local.acme.dev", "shop-1", 80),
            ],
            ..Default::default()
        };
        let caddy: serde_json::Value = serde_json::from_str(&build_caddy_config(&config, &[])).unwrap();
        let mut files: Vec<&str> = caddy["apps"]["tls"]["certificates"]["load_files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["certificate"].as_str().unwrap())
            .collect();
        files.sort();
        assert_eq!(
            files,
            [
                // Two labels deep: not covered by a wildcard.
                "/certs/api.crm.local.acme.dev.pem",
                "/certs/app.localhost.pem",
                "/certs/cert.pem",
                "/certs/cert.pem",
            ]
        );
        assert!(custom_cert_covers(&config, "LOCAL.ACME.DEV"));
    }

    #[test]
    fn test_build_caddy_config_custom_tls_ignores_field_values_for_path() {
        // custom_cert / custom_key now hold PEM *content*, not filesystem
        // paths. Regardless of the field values, Caddy must be pointed at
        // the fixed /certs/cert.pem and /certs/key.pem locations where
        // write_custom_cert_files() wrote the validated content.
        let config = GatewayConfig {
            domain: "example.com".to_string(),
            http_port: 80,
            https_port: 443,
            tls_mode: GatewayTlsMode::Custom,
            custom_cert: Some("-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----".to_string()),
            custom_key: Some("-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----".to_string()),
            routes: vec![make_route("app", "frontend-1", 3000)],
            ..Default::default()
        };
        let json_str = build_caddy_config(&config, &[]);
        let caddy: serde_json::Value = serde_json::from_str(&json_str).expect("valid JSON");

        let load_files = caddy["apps"]["tls"]["certificates"]["load_files"].as_array().unwrap();
        let cert_entry = &load_files[0];
        assert_eq!(cert_entry["certificate"], "/certs/cert.pem");
        assert_eq!(cert_entry["key"], "/certs/key.pem");
    }

    #[test]
    fn test_build_caddy_config_orca_ca_tls_uses_hostname_certs() {
        let config = make_config(vec![make_route("myapp", "container-1", 8080)]);
        let json_str = build_caddy_config(&config, &[]);
        let caddy: serde_json::Value = serde_json::from_str(&json_str).expect("valid JSON");

        let load_files = caddy["apps"]["tls"]["certificates"]["load_files"].as_array().unwrap();
        // Should have cert for route hostname + cert for root domain
        assert_eq!(load_files.len(), 2);
        assert_eq!(load_files[0]["certificate"], "/certs/myapp.pem");
        assert_eq!(load_files[0]["key"], "/certs/myapp-key.pem");
        assert_eq!(load_files[1]["certificate"], "/certs/localhost.pem");
        assert_eq!(load_files[1]["key"], "/certs/localhost-key.pem");
    }

    #[test]
    fn test_build_caddy_config_disabled_routes_excluded() {
        let mut disabled = make_route("secret", "secret-1", 9999);
        disabled.enabled = false;

        let config = make_config(vec![make_route("app", "frontend-1", 3000), disabled]);
        let json_str = build_caddy_config(&config, &[]);
        let caddy: serde_json::Value = serde_json::from_str(&json_str).expect("valid JSON");

        let routes = caddy["apps"]["http"]["servers"]["gateway"]["routes"]
            .as_array()
            .unwrap();
        // Only 1 reverse_proxy (app) + 1 landing page = 2 total
        assert_eq!(routes.len(), 3);

        // The disabled route's hostname should not appear anywhere in the config
        assert!(!json_str.contains("secret-1:9999"));
    }

    #[test]
    fn test_build_caddy_config_http_redirect() {
        let config = make_config(vec![]);
        let json_str = build_caddy_config(&config, &[]);
        let caddy: serde_json::Value = serde_json::from_str(&json_str).expect("valid JSON");

        let redirect = &caddy["apps"]["http"]["servers"]["http_redirect"];
        let handler = &redirect["routes"][0]["handle"][0];
        assert_eq!(handler["handler"], "static_response");
        assert_eq!(handler["status_code"], 301);
        let location = handler["headers"]["Location"][0].as_str().unwrap();
        assert!(location.starts_with("https://"));
    }

    // ---- to_docker_mount_path tests ----

    #[test]
    fn test_to_docker_mount_path_unix() {
        assert_eq!(
            to_docker_mount_path(std::path::Path::new("/home/user/.config/orca")),
            "/home/user/.config/orca"
        );
    }

    #[test]
    fn test_to_docker_mount_path_unix_root() {
        assert_eq!(to_docker_mount_path(std::path::Path::new("/")), "/");
    }

    #[test]
    fn test_to_docker_mount_path_unix_relative() {
        assert_eq!(
            to_docker_mount_path(std::path::Path::new("some/relative/path")),
            "some/relative/path"
        );
    }
}

/// Pull an image if it's not already present.
pub(crate) async fn pull_if_needed(state: &AppState, image: &str) -> Result<()> {
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
