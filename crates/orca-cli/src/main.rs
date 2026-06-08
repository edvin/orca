use clap::{Args, Parser, Subcommand};
use serde::Serialize;

mod client;

#[derive(Parser)]
#[command(name = "orca", about = "Orca — open source container desktop")]
struct Cli {
    /// API token for daemon authentication (overrides config file).
    #[arg(long, global = true, env = "ORCA_TOKEN")]
    token: Option<String>,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Show daemon health and runtime info
    Status,

    /// Print CLI and daemon version
    Version,

    /// Manage containers
    Containers {
        #[command(subcommand)]
        action: ContainerAction,
    },

    /// Manage images
    Images {
        #[command(subcommand)]
        action: ImageAction,
    },

    /// Manage compose stacks
    Stacks {
        #[command(subcommand)]
        action: StackAction,
    },

    /// Kubernetes cluster management
    K8s {
        #[command(subcommand)]
        action: K8sAction,
    },

    /// Manage container machines
    Machine {
        #[command(subcommand)]
        action: MachineAction,
    },

    /// Manage the gateway reverse proxy
    Gateway {
        #[command(subcommand)]
        action: GatewayAction,
    },

    /// Manage the Orca CA certificate
    Ca {
        #[command(subcommand)]
        action: CaAction,
    },

    /// Browse and search application templates
    Templates {
        #[command(subcommand)]
        action: TemplateAction,
    },

    /// Deploy a compose file or template
    Deploy {
        /// Path to a docker-compose file
        #[arg(required_unless_present = "template")]
        path: Option<String>,

        /// Deploy a template by ID instead
        #[arg(long)]
        template: Option<String>,
    },

    /// Export, import, and manage Orca configuration
    Config {
        #[command(subcommand)]
        action: ConfigAction,
    },
}

#[derive(Subcommand)]
enum ContainerAction {
    /// List all containers
    List,
    /// Start a container
    Start {
        /// Container ID or name
        id: String,
    },
    /// Stop a container
    Stop {
        /// Container ID or name
        id: String,
    },
    /// Show container logs
    Logs {
        /// Container ID or name
        id: String,
        /// Number of lines from the end
        #[arg(long)]
        tail: Option<u32>,
    },
    /// Execute a command in a container
    Exec {
        /// Container ID or name
        id: String,
        /// Command and arguments
        #[arg(trailing_var_arg = true, required = true)]
        cmd: Vec<String>,
    },
}

#[derive(Subcommand)]
enum ImageAction {
    /// List images
    List,
    /// Pull an image
    Pull {
        /// Image reference (e.g. nginx:alpine)
        reference: String,
    },
    /// Remove an image
    Remove {
        /// Image ID or tag
        id: String,
    },
    /// Prune unused images
    Prune,
}

#[derive(Subcommand)]
enum StackAction {
    /// List compose stacks
    List,
    /// Run docker compose up
    Up {
        /// Stack name
        name: String,
    },
    /// Run docker compose down
    Down {
        /// Stack name
        name: String,
    },
}

#[derive(Subcommand)]
enum K8sAction {
    /// Show Kubernetes cluster status
    Status,
    /// Enable Kubernetes
    Enable,
    /// Disable Kubernetes
    Disable,
    /// Show or set the cluster container runtime (docker | containerd).
    /// Docker (default) matches Docker Desktop: locally built images are usable
    /// by Kubernetes with no push or import. Omit the value to show the current setting.
    Runtime {
        /// "docker" or "containerd". Omit to display the current value.
        value: Option<String>,
    },
}

#[derive(Subcommand)]
enum MachineAction {
    /// List all machines
    List,
}

#[derive(Subcommand)]
enum GatewayAction {
    /// Show gateway running state
    Status,
    /// Start the gateway
    Start,
    /// Stop the gateway
    Stop,
    /// List gateway routes
    Routes,
    /// Add a gateway route
    Add {
        /// Hostname (e.g. app.localhost)
        host: String,
        /// Container name
        container: String,
        /// Container port
        port: u16,
    },
    /// Remove a gateway route
    Remove {
        /// Hostname to remove
        host: String,
    },
    /// View or update gateway configuration
    Config(GatewayConfigArgs),
}

#[derive(Args)]
struct GatewayConfigArgs {
    /// Show current config (default if no flags)
    #[arg(long)]
    show: bool,

    /// Set the gateway domain
    #[arg(long)]
    domain: Option<String>,

    /// Set the HTTP port
    #[arg(long)]
    http_port: Option<u16>,

    /// Set the HTTPS port
    #[arg(long)]
    https_port: Option<u16>,

    /// Set TLS mode (orca_ca or custom)
    #[arg(long)]
    tls_mode: Option<String>,

    /// Path to PEM certificate file (for custom TLS)
    #[arg(long)]
    cert_file: Option<String>,

    /// Path to PEM key file (for custom TLS)
    #[arg(long)]
    key_file: Option<String>,
}

impl GatewayConfigArgs {
    fn has_updates(&self) -> bool {
        self.domain.is_some()
            || self.http_port.is_some()
            || self.https_port.is_some()
            || self.tls_mode.is_some()
            || self.cert_file.is_some()
            || self.key_file.is_some()
    }
}

#[derive(Subcommand)]
enum CaAction {
    /// Export CA certificate PEM to stdout
    Export,
    /// Show CA certificate info
    Info,
    /// Install CA certificate to system trust store
    Install,
}

#[derive(Subcommand)]
enum TemplateAction {
    /// List all templates
    List,
    /// Search templates by query
    Search {
        /// Search query (matches name, description, category)
        query: String,
    },
}

#[derive(Subcommand)]
enum ConfigAction {
    /// Export configuration as YAML
    Export {
        /// Include sensitive fields (certs, tokens, keys)
        #[arg(long)]
        include_secrets: bool,
    },
    /// Import configuration from a YAML file
    Import {
        /// Path to YAML config file
        file: String,
    },
    /// Get a configuration value
    Get {
        /// Dot-path key (e.g. gateway.domain)
        key: String,
    },
    /// Set a configuration value
    Set {
        /// Dot-path key (e.g. gateway.domain)
        key: String,
        /// Value to set
        value: String,
    },
}

/// YAML-friendly subset of OrcaConfig for export.
#[derive(Serialize, serde::Deserialize)]
struct ConfigExport {
    gateway: GatewayExport,
}

#[derive(Serialize, serde::Deserialize)]
struct GatewayExport {
    domain: String,
    http_port: u16,
    https_port: u16,
    tls_mode: String,
    routes: Vec<RouteExport>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    custom_cert: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    custom_key: Option<String>,
}

#[derive(Serialize, serde::Deserialize)]
struct RouteExport {
    hostname: String,
    container_name: String,
    port: u16,
    enabled: bool,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let client = client::DaemonClient::new("http://127.0.0.1:9477", cli.token)?;

    match cli.command {
        Commands::Status => cmd_status(&client).await?,
        Commands::Version => cmd_version(&client).await?,
        Commands::Containers { action } => match action {
            ContainerAction::List => cmd_containers_list(&client).await?,
            ContainerAction::Start { id } => cmd_container_start(&client, &id).await?,
            ContainerAction::Stop { id } => cmd_container_stop(&client, &id).await?,
            ContainerAction::Logs { id, tail } => cmd_container_logs(&client, &id, tail).await?,
            ContainerAction::Exec { id, cmd } => cmd_container_exec(&client, &id, cmd).await?,
        },
        Commands::Images { action } => match action {
            ImageAction::List => cmd_images_list(&client).await?,
            ImageAction::Pull { reference } => cmd_image_pull(&client, &reference).await?,
            ImageAction::Remove { id } => cmd_image_remove(&client, &id).await?,
            ImageAction::Prune => cmd_image_prune(&client).await?,
        },
        Commands::Stacks { action } => match action {
            StackAction::List => cmd_stacks_list(&client).await?,
            StackAction::Up { name } => cmd_stack_up(&client, &name).await?,
            StackAction::Down { name } => cmd_stack_down(&client, &name).await?,
        },
        Commands::K8s { action } => match action {
            K8sAction::Status => cmd_k8s_status(&client).await?,
            K8sAction::Enable => cmd_k8s_enable(&client).await?,
            K8sAction::Disable => cmd_k8s_disable(&client).await?,
            K8sAction::Runtime { value } => cmd_k8s_runtime(&client, value).await?,
        },
        Commands::Machine { action } => match action {
            MachineAction::List => cmd_machine_list(&client).await?,
        },
        Commands::Gateway { action } => match action {
            GatewayAction::Status => cmd_gateway_status(&client).await?,
            GatewayAction::Start => cmd_gateway_start(&client).await?,
            GatewayAction::Stop => cmd_gateway_stop(&client).await?,
            GatewayAction::Routes => cmd_gateway_routes(&client).await?,
            GatewayAction::Add { host, container, port } => cmd_gateway_add(&client, &host, &container, port).await?,
            GatewayAction::Remove { host } => cmd_gateway_remove(&client, &host).await?,
            GatewayAction::Config(args) => cmd_gateway_config(&client, args).await?,
        },
        Commands::Ca { action } => match action {
            CaAction::Export => cmd_ca_export(&client).await?,
            CaAction::Info => cmd_ca_info(&client).await?,
            CaAction::Install => cmd_ca_install(&client).await?,
        },
        Commands::Templates { action } => match action {
            TemplateAction::List => cmd_templates_list(&client).await?,
            TemplateAction::Search { query } => cmd_templates_search(&client, &query).await?,
        },
        Commands::Deploy { path, template } => cmd_deploy(&client, path, template).await?,
        Commands::Config { action } => match action {
            ConfigAction::Export { include_secrets } => cmd_config_export(include_secrets)?,
            ConfigAction::Import { file } => cmd_config_import(&file)?,
            ConfigAction::Get { key } => cmd_config_get(&key)?,
            ConfigAction::Set { key, value } => cmd_config_set(&key, &value)?,
        },
    }

    Ok(())
}

// --- Version ---

async fn cmd_version(client: &client::DaemonClient) -> anyhow::Result<()> {
    println!("cli: {}", env!("CARGO_PKG_VERSION"));
    match client.health().await {
        Ok(health) => println!("daemon: {}", health.version),
        Err(_) => println!("daemon: not running"),
    }
    Ok(())
}

// --- Status ---

async fn cmd_status(client: &client::DaemonClient) -> anyhow::Result<()> {
    let health = client.health().await?;
    println!("Orca daemon: {} (v{})", health.status, health.version);
    Ok(())
}

// --- Containers ---

async fn cmd_containers_list(client: &client::DaemonClient) -> anyhow::Result<()> {
    let containers = client.list_containers().await?;
    if containers.is_empty() {
        println!("No containers found.");
        return Ok(());
    }

    println!("{:<14} {:<18} {:<20} {:<10} PORTS", "ID", "NAME", "IMAGE", "STATE");
    for c in &containers {
        let short_id = if c.id.len() > 12 { &c.id[..12] } else { &c.id };
        let linked_name = container_link(&c.id, &c.name);
        let ports = c
            .ports
            .iter()
            .map(|p| format!("{}:{}", p.host_port, p.container_port))
            .collect::<Vec<_>>()
            .join(", ");
        println!(
            "{:<14} {:<18} {:<20} {:<10} {}",
            short_id, linked_name, c.image, c.state, ports
        );
    }
    Ok(())
}

async fn cmd_container_start(client: &client::DaemonClient, id: &str) -> anyhow::Result<()> {
    client.start_container(id).await?;
    println!("Container {id} started.");
    Ok(())
}

async fn cmd_container_stop(client: &client::DaemonClient, id: &str) -> anyhow::Result<()> {
    client.stop_container(id).await?;
    println!("Container {id} stopped.");
    Ok(())
}

async fn cmd_container_logs(client: &client::DaemonClient, id: &str, tail: Option<u32>) -> anyhow::Result<()> {
    let lines = client.container_logs(id, tail).await?;
    for line in &lines {
        println!("{line}");
    }
    Ok(())
}

async fn cmd_container_exec(client: &client::DaemonClient, id: &str, cmd: Vec<String>) -> anyhow::Result<()> {
    let result = client.exec_container(id, cmd).await?;
    if !result.output.is_empty() {
        print!("{}", result.output);
    }
    if result.exit_code != 0 {
        // POSIX exit codes are unsigned bytes. Negative codes from the
        // daemon (e.g. -1 for "failed to spawn") must NOT silently map to
        // 0 — that would report success to the calling shell. Map any
        // negative code to 1 ("general error"); otherwise cap at 255.
        let code = if result.exit_code < 0 {
            1
        } else {
            std::cmp::min(result.exit_code, 255)
        };
        std::process::exit(code);
    }
    Ok(())
}

// --- Images ---

async fn cmd_images_list(client: &client::DaemonClient) -> anyhow::Result<()> {
    let images = client.list_images().await?;
    if images.is_empty() {
        println!("No images found.");
        return Ok(());
    }

    println!("{:<24} {:<10} {:<12} CREATED", "REPOSITORY", "TAG", "SIZE");
    for img in &images {
        let (repo, tag) = if img.repo_tags.is_empty() {
            ("<untagged>".to_string(), String::new())
        } else {
            let t = &img.repo_tags[0];
            match t.rsplit_once(':') {
                Some((r, tg)) => (r.to_string(), tg.to_string()),
                None => (t.clone(), "latest".to_string()),
            }
        };
        let size = format_bytes(img.size_bytes);
        let created = &img.created_at;
        println!("{:<24} {:<10} {:<12} {}", repo, tag, size, created);
    }
    Ok(())
}

async fn cmd_image_pull(client: &client::DaemonClient, reference: &str) -> anyhow::Result<()> {
    println!("Pulling {reference}...");
    client.pull_image(reference).await?;
    println!("Pull complete.");
    Ok(())
}

async fn cmd_image_remove(client: &client::DaemonClient, id: &str) -> anyhow::Result<()> {
    client.remove_image(id).await?;
    println!("Image {id} removed.");
    Ok(())
}

async fn cmd_image_prune(client: &client::DaemonClient) -> anyhow::Result<()> {
    let result = client.prune_images().await?;
    if result.images_deleted.is_empty() {
        println!("No unused images to prune.");
    } else {
        println!(
            "Pruned {} image(s), reclaimed {}.",
            result.images_deleted.len(),
            format_bytes(result.space_reclaimed)
        );
    }
    Ok(())
}

// --- Stacks ---

async fn cmd_stacks_list(client: &client::DaemonClient) -> anyhow::Result<()> {
    let stacks = client.list_stacks().await?;
    if stacks.is_empty() {
        println!("No compose stacks found.");
        return Ok(());
    }

    println!("{:<24} {:<12} {:<6} DIRECTORY", "NAME", "STATUS", "SVCS");
    for s in &stacks {
        let dir = s.working_dir.as_deref().unwrap_or("-");
        println!("{:<24} {:<12} {:<6} {}", s.name, s.status, s.services.len(), dir);
    }
    Ok(())
}

async fn cmd_stack_up(client: &client::DaemonClient, name: &str) -> anyhow::Result<()> {
    println!("Starting stack '{name}'...");
    client.stack_up(name).await?;
    println!("Stack '{name}' is up.");
    Ok(())
}

async fn cmd_stack_down(client: &client::DaemonClient, name: &str) -> anyhow::Result<()> {
    println!("Stopping stack '{name}'...");
    client.stack_down(name).await?;
    println!("Stack '{name}' is down.");
    Ok(())
}

// --- Kubernetes ---

async fn cmd_k8s_status(client: &client::DaemonClient) -> anyhow::Result<()> {
    let status = client.k8s_status().await?;
    println!("Kubernetes:");
    println!("  Enabled:  {}", status.enabled);
    println!("  Running:  {}", status.running);
    if let Some(v) = &status.version {
        println!("  Version:  {v}");
    }
    if let Some(node) = &status.node_name {
        let node_status = status.node_status.as_deref().unwrap_or("Unknown");
        println!("  Node:     {node} ({node_status})");
    }
    println!("  Pods:     {}/{} running", status.pods_running, status.pods_total);
    Ok(())
}

async fn cmd_k8s_enable(client: &client::DaemonClient) -> anyhow::Result<()> {
    println!("Enabling Kubernetes...");
    client.k8s_enable().await?;
    println!("Kubernetes enabled.");
    Ok(())
}

async fn cmd_k8s_runtime(
    client: &client::DaemonClient,
    value: Option<String>,
) -> anyhow::Result<()> {
    match value {
        None => {
            let runtime = client.k8s_get_runtime().await?;
            println!("Kubernetes runtime: {runtime}");
            if runtime == "docker" {
                println!("  (Docker/cri-dockerd — matches Docker Desktop; locally built images work with no push or import)");
            }
        }
        Some(v) => {
            let runtime = v.to_lowercase();
            if runtime != "docker" && runtime != "containerd" {
                anyhow::bail!("runtime must be 'docker' or 'containerd', got '{v}'");
            }
            client.k8s_set_runtime(&runtime).await?;
            println!("Kubernetes runtime set to: {runtime}");
            println!("Takes effect on the next `orca k8s enable` (or `reset`); an already-running cluster keeps its current runtime until reset.");
        }
    }
    Ok(())
}

async fn cmd_k8s_disable(client: &client::DaemonClient) -> anyhow::Result<()> {
    println!("Disabling Kubernetes...");
    client.k8s_disable().await?;
    println!("Kubernetes disabled.");
    Ok(())
}

// --- Machines ---

async fn cmd_machine_list(client: &client::DaemonClient) -> anyhow::Result<()> {
    let machines = client.list_machines().await?;
    if machines.is_empty() {
        println!("No machines found.");
        return Ok(());
    }

    println!("{:<16} {:<10} {:<6} {:<10} RUNTIME", "NAME", "STATE", "CPUS", "MEMORY");
    for m in &machines {
        let mem = format!("{} MB", m.config.memory_mb);
        println!(
            "{:<16} {:<10} {:<6} {:<10} {}",
            m.name, m.state, m.config.cpus, mem, m.config.runtime
        );
    }
    Ok(())
}

// --- Gateway ---

async fn cmd_gateway_status(client: &client::DaemonClient) -> anyhow::Result<()> {
    let status = client.gateway_status().await?;
    let running = status.get("running").and_then(|v| v.as_bool()).unwrap_or(false);
    let domain = status.get("domain").and_then(|v| v.as_str()).unwrap_or("-");
    let http_port = status.get("http_port").and_then(|v| v.as_u64()).unwrap_or(0);
    let https_port = status.get("https_port").and_then(|v| v.as_u64()).unwrap_or(0);
    let route_count = status.get("route_count").and_then(|v| v.as_u64()).unwrap_or(0);

    println!("Gateway:");
    println!("  Running:  {}", if running { "yes" } else { "no" });
    println!("  Domain:   {domain}");
    println!("  HTTP:     {http_port}");
    println!("  HTTPS:    {https_port}");
    println!("  Routes:   {route_count}");
    Ok(())
}

async fn cmd_gateway_start(client: &client::DaemonClient) -> anyhow::Result<()> {
    client.gateway_start().await?;
    println!("Gateway started. {}", orca_link("gateway", "Open Gateway"));
    Ok(())
}

async fn cmd_gateway_stop(client: &client::DaemonClient) -> anyhow::Result<()> {
    client.gateway_stop().await?;
    println!("Gateway stopped.");
    Ok(())
}

async fn cmd_gateway_routes(client: &client::DaemonClient) -> anyhow::Result<()> {
    let routes = client.gateway_routes().await?;
    if routes.is_empty() {
        println!("No gateway routes configured.");
        return Ok(());
    }

    println!("{:<30} {:<20} {:<8} ENABLED", "HOSTNAME", "CONTAINER", "PORT");
    for r in &routes {
        let hostname = r.get("hostname").and_then(|v| v.as_str()).unwrap_or("-");
        let container = r.get("container_name").and_then(|v| v.as_str()).unwrap_or("-");
        let port = r.get("port").and_then(|v| v.as_u64()).unwrap_or(0);
        let enabled = r.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
        let linked_host = orca_link(&format!("gateway/route/{hostname}"), hostname);
        println!(
            "{:<30} {:<20} {:<8} {}",
            linked_host,
            container,
            port,
            if enabled { "yes" } else { "no" }
        );
    }
    Ok(())
}

async fn cmd_gateway_add(client: &client::DaemonClient, host: &str, container: &str, port: u16) -> anyhow::Result<()> {
    client.gateway_add_route(host, container, port).await?;
    println!("Route added: {host} -> {container}:{port}");
    Ok(())
}

async fn cmd_gateway_remove(client: &client::DaemonClient, host: &str) -> anyhow::Result<()> {
    client.gateway_remove_route(host).await?;
    println!("Route removed: {host}");
    Ok(())
}

async fn cmd_gateway_config(client: &client::DaemonClient, args: GatewayConfigArgs) -> anyhow::Result<()> {
    if !args.has_updates() {
        // Show current config
        let config = client.gateway_get_config().await?;
        let yaml = serde_yaml::to_string(&config)?;
        print!("{yaml}");
        return Ok(());
    }

    // Merge updates into current config
    let mut config = client.gateway_get_config().await?;
    let obj = config
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("expected config to be a JSON object"))?;

    if let Some(domain) = &args.domain {
        obj.insert("domain".to_string(), serde_json::Value::String(domain.clone()));
    }
    if let Some(port) = args.http_port {
        obj.insert("http_port".to_string(), serde_json::Value::Number(port.into()));
    }
    if let Some(port) = args.https_port {
        obj.insert("https_port".to_string(), serde_json::Value::Number(port.into()));
    }
    if let Some(mode) = &args.tls_mode {
        obj.insert("tls_mode".to_string(), serde_json::Value::String(mode.clone()));
    }
    if let Some(cert_path) = &args.cert_file {
        let pem = std::fs::read_to_string(cert_path)
            .map_err(|e| anyhow::anyhow!("failed to read cert file '{}': {}", cert_path, e))?;
        obj.insert("custom_cert".to_string(), serde_json::Value::String(pem));
    }
    if let Some(key_path) = &args.key_file {
        let pem = std::fs::read_to_string(key_path)
            .map_err(|e| anyhow::anyhow!("failed to read key file '{}': {}", key_path, e))?;
        obj.insert("custom_key".to_string(), serde_json::Value::String(pem));
    }

    client.gateway_update_config(&config).await?;
    println!("Gateway configuration updated.");
    Ok(())
}

// --- CA ---

async fn cmd_ca_export(client: &client::DaemonClient) -> anyhow::Result<()> {
    let pem = client.ca_certificate().await?;
    print!("{pem}");
    Ok(())
}

async fn cmd_ca_info(client: &client::DaemonClient) -> anyhow::Result<()> {
    let info = client.ca_info().await?;
    let subject = info.get("subject").and_then(|v| v.as_str()).unwrap_or("-");
    let expiry = info.get("expiry").and_then(|v| v.as_str()).unwrap_or("-");
    let fingerprint = info.get("fingerprint").and_then(|v| v.as_str()).unwrap_or("-");

    println!("CA Certificate:");
    println!("  Subject:      {subject}");
    println!("  Expiry:       {expiry}");
    println!("  Fingerprint:  {fingerprint}");
    Ok(())
}

async fn cmd_ca_install(client: &client::DaemonClient) -> anyhow::Result<()> {
    let pem = client.ca_certificate().await?;

    // Write to a secure, unguessable temp file via tempfile::Builder so a
    // local attacker can't pre-create a symlink at a predictable path and
    // swap the contents between write and `sudo security add-trusted-cert`
    // (a swap that would install an attacker-controlled root CA).
    let tmpfile = tempfile::Builder::new().prefix("orca-ca-").suffix(".crt").tempfile()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(tmpfile.path(), std::fs::Permissions::from_mode(0o600));
    }
    std::fs::write(tmpfile.path(), &pem)?;
    let tmp_path = tmpfile.path().to_path_buf();
    // Keep the file alive until we're done — calling `.keep()` returns
    // (File, PathBuf), we just want the PathBuf to outlive the scope.
    let _tmp_guard = tmpfile; // intentionally keep named so Drop removes on function exit

    let tmp_str = tmp_path.display().to_string();

    let (cmd, args, manual_instructions) = if cfg!(target_os = "linux") {
        // Run cp and update-ca-certificates as two separate sudo
        // invocations, passing argv directly — avoids shell quoting issues
        // if TMPDIR contains unusual characters.
        (
            "sudo",
            vec!["cp", tmp_str.as_str(), "/usr/local/share/ca-certificates/orca-ca.crt"],
            format!(
                "sudo cp '{}' /usr/local/share/ca-certificates/orca-ca.crt && sudo update-ca-certificates",
                tmp_str
            ),
        )
    } else if cfg!(target_os = "macos") {
        (
            "sudo",
            vec![
                "security",
                "add-trusted-cert",
                "-d",
                "-r",
                "trustRoot",
                "-k",
                "/Library/Keychains/System.keychain",
                tmp_str.as_str(),
            ],
            format!(
                "sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain '{}'",
                tmp_str
            ),
        )
    } else if cfg!(target_os = "windows") {
        (
            "certutil",
            vec!["-addstore", "-f", "ROOT", tmp_str.as_str()],
            format!("certutil -addstore -f \"ROOT\" \"{}\"", tmp_str),
        )
    } else {
        anyhow::bail!("Unsupported platform. Certificate saved to: {}", tmp_str);
    };

    println!("Installing CA certificate to system trust store...");
    let status = std::process::Command::new(cmd).args(&args).status();

    // On Linux, run `update-ca-certificates` as a second step so we can
    // surface per-step errors clearly.
    let linux_step2_status = if cfg!(target_os = "linux") && status.as_ref().map(|s| s.success()).unwrap_or(false) {
        Some(
            std::process::Command::new("sudo")
                .arg("update-ca-certificates")
                .status(),
        )
    } else {
        None
    };

    let overall_ok = match (&status, &linux_step2_status) {
        (Ok(s), None) => s.success(),
        (Ok(s1), Some(Ok(s2))) => s1.success() && s2.success(),
        _ => false,
    };

    if overall_ok {
        println!("CA certificate installed successfully.");
        // tempfile Drop will remove the file.
        Ok(())
    } else {
        // If we got here on Linux with step 1 succeeding but step 2
        // (update-ca-certificates) failing, the .crt is sitting in the
        // system trust source dir WITHOUT having been rehashed — remove
        // it so a partial install doesn't persist a cert that will be
        // picked up by the next `update-ca-certificates` run.
        #[cfg(target_os = "linux")]
        {
            let step1_ok = status.as_ref().map(|s| s.success()).unwrap_or(false);
            let step2_failed = matches!(
                &linux_step2_status,
                Some(Ok(s)) if !s.success()
            ) || matches!(&linux_step2_status, Some(Err(_)));
            if step1_ok && step2_failed {
                let _ = std::process::Command::new("sudo")
                    .args(["rm", "-f", "/usr/local/share/ca-certificates/orca-ca.crt"])
                    .status();
            }
        }

        eprintln!("Automatic installation failed. Install manually:");
        eprintln!("  {manual_instructions}");
        // Keep the tempfile alive at its CURRENT unpredictable path so a
        // local attacker cannot race us to replace the PEM with their own
        // root CA before the user runs the manual install command. We
        // deliberately do NOT copy to `/tmp/orca-ca.crt` — that predictable
        // path re-introduced the exact TOCTOU the hardened path was
        // designed to prevent.
        match _tmp_guard.keep() {
            Ok((_file, persisted)) => {
                eprintln!("Certificate saved to: {}", persisted.display());
            }
            Err(e) => {
                eprintln!("(Failed to preserve temp cert file: {e})");
            }
        }
        anyhow::bail!("CA certificate installation failed — see message above")
    }
}

// --- Templates ---

async fn cmd_templates_list(client: &client::DaemonClient) -> anyhow::Result<()> {
    let templates = client.list_templates().await?;
    if templates.is_empty() {
        println!("No templates available.");
        return Ok(());
    }

    println!("{:<12} {:<20} {:<14} DESCRIPTION", "ID", "NAME", "CATEGORY");
    for t in &templates {
        let id = t.get("id").and_then(|v| v.as_str()).unwrap_or("-");
        let name = t.get("name").and_then(|v| v.as_str()).unwrap_or("-");
        let category = t.get("category").and_then(|v| v.as_str()).unwrap_or("-");
        let desc = t.get("description").and_then(|v| v.as_str()).unwrap_or("-");
        println!("{:<12} {:<20} {:<14} {}", id, name, category, desc);
    }
    Ok(())
}

async fn cmd_templates_search(client: &client::DaemonClient, query: &str) -> anyhow::Result<()> {
    let templates = client.list_templates().await?;
    let query_lower = query.to_lowercase();

    let matches: Vec<_> = templates
        .iter()
        .filter(|t| {
            let name = t.get("name").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
            let desc = t
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_lowercase();
            let category = t.get("category").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
            name.contains(&query_lower) || desc.contains(&query_lower) || category.contains(&query_lower)
        })
        .collect();

    if matches.is_empty() {
        println!("No templates matching '{query}'.");
        return Ok(());
    }

    println!("{:<12} {:<20} {:<14} DESCRIPTION", "ID", "NAME", "CATEGORY");
    for t in &matches {
        let id = t.get("id").and_then(|v| v.as_str()).unwrap_or("-");
        let name = t.get("name").and_then(|v| v.as_str()).unwrap_or("-");
        let category = t.get("category").and_then(|v| v.as_str()).unwrap_or("-");
        let desc = t.get("description").and_then(|v| v.as_str()).unwrap_or("-");
        println!("{:<12} {:<20} {:<14} {}", id, name, category, desc);
    }
    Ok(())
}

// --- Deploy ---

async fn cmd_deploy(
    client: &client::DaemonClient,
    path: Option<String>,
    template: Option<String>,
) -> anyhow::Result<()> {
    if let Some(template_id) = template {
        println!("Deploying template '{template_id}'...");
        client.deploy_template(&template_id).await?;
        println!("Template deployed.");
    } else if let Some(path) = path {
        println!("Deploying from '{path}'...");
        client.deploy_stack(&path).await?;
        println!("Stack deployed.");
    } else {
        anyhow::bail!("Either <path> or --template <id> is required.");
    }
    Ok(())
}

// --- Config ---

fn cmd_config_export(include_secrets: bool) -> anyhow::Result<()> {
    let config = orca_core::config::OrcaConfig::load()?;

    let tls_mode = match config.gateway.tls_mode {
        orca_core::config::GatewayTlsMode::OrcaCa => "orca_ca".to_string(),
        orca_core::config::GatewayTlsMode::Custom => "custom".to_string(),
        orca_core::config::GatewayTlsMode::Unknown => "unknown".to_string(),
    };

    let routes: Vec<RouteExport> = config
        .gateway
        .routes
        .iter()
        .map(|r| RouteExport {
            hostname: r.hostname.clone(),
            container_name: r.container_name.clone(),
            port: r.port,
            enabled: r.enabled,
        })
        .collect();

    let export = ConfigExport {
        gateway: GatewayExport {
            domain: config.gateway.domain.clone(),
            http_port: config.gateway.http_port,
            https_port: config.gateway.https_port,
            tls_mode,
            routes,
            custom_cert: if include_secrets {
                config.gateway.custom_cert.clone()
            } else {
                None
            },
            custom_key: if include_secrets {
                config.gateway.custom_key.clone()
            } else {
                None
            },
        },
    };

    let yaml = serde_yaml::to_string(&export)?;
    print!("{yaml}");
    Ok(())
}

fn cmd_config_import(file: &str) -> anyhow::Result<()> {
    let contents = std::fs::read_to_string(file).map_err(|e| anyhow::anyhow!("failed to read '{}': {}", file, e))?;
    let import: serde_yaml::Value = serde_yaml::from_str(&contents)?;

    let mut config = orca_core::config::OrcaConfig::load()?;

    if let Some(gw) = import.get("gateway") {
        if let Some(domain) = gw.get("domain").and_then(|v| v.as_str()) {
            config.gateway.domain = domain.to_string();
        }
        if let Some(port) = gw.get("http_port").and_then(|v| v.as_u64()) {
            config.gateway.http_port = port as u16;
        }
        if let Some(port) = gw.get("https_port").and_then(|v| v.as_u64()) {
            config.gateway.https_port = port as u16;
        }
        if let Some(mode) = gw.get("tls_mode").and_then(|v| v.as_str()) {
            config.gateway.tls_mode = match mode {
                "custom" => orca_core::config::GatewayTlsMode::Custom,
                _ => orca_core::config::GatewayTlsMode::OrcaCa,
            };
        }
        if let Some(routes) = gw.get("routes").and_then(|v| v.as_sequence()) {
            let mut new_routes = Vec::new();
            for r in routes {
                let hostname = r.get("hostname").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let container_name = r
                    .get("container_name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let port = r.get("port").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
                let enabled = r.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
                if !hostname.is_empty() {
                    let path = r.get("path").and_then(|v| v.as_str()).map(|s| s.to_string());
                    new_routes.push(orca_core::config::GatewayRoute {
                        hostname,
                        container_name,
                        port,
                        enabled,
                        path,
                    });
                }
            }
            config.gateway.routes = new_routes;
        }
    }

    config.save()?;
    println!("Configuration imported from '{file}'.");
    Ok(())
}

fn cmd_config_get(key: &str) -> anyhow::Result<()> {
    let config = orca_core::config::OrcaConfig::load()?;

    let value: String = match key {
        "gateway.domain" => config.gateway.domain.clone(),
        "gateway.http_port" => config.gateway.http_port.to_string(),
        "gateway.https_port" => config.gateway.https_port.to_string(),
        "gateway.tls_mode" => match config.gateway.tls_mode {
            orca_core::config::GatewayTlsMode::OrcaCa => "orca_ca".to_string(),
            orca_core::config::GatewayTlsMode::Custom => "custom".to_string(),
            orca_core::config::GatewayTlsMode::Unknown => "unknown".to_string(),
        },
        _ => {
            eprintln!("Unknown key: {key}");
            eprintln!("Valid keys: gateway.domain, gateway.http_port, gateway.https_port, gateway.tls_mode");
            std::process::exit(1);
        }
    };

    println!("{value}");
    Ok(())
}

fn cmd_config_set(key: &str, value: &str) -> anyhow::Result<()> {
    let mut config = orca_core::config::OrcaConfig::load()?;

    match key {
        "gateway.domain" => config.gateway.domain = value.to_string(),
        "gateway.http_port" => {
            config.gateway.http_port = value.parse().map_err(|_| anyhow::anyhow!("invalid port: {value}"))?;
        }
        "gateway.https_port" => {
            config.gateway.https_port = value.parse().map_err(|_| anyhow::anyhow!("invalid port: {value}"))?;
        }
        "gateway.tls_mode" => {
            config.gateway.tls_mode = match value {
                "custom" => orca_core::config::GatewayTlsMode::Custom,
                "orca_ca" => orca_core::config::GatewayTlsMode::OrcaCa,
                _ => anyhow::bail!("invalid tls_mode: {value} (expected 'orca_ca' or 'custom')"),
            };
        }
        _ => {
            eprintln!("Unknown key: {key}");
            eprintln!("Valid keys: gateway.domain, gateway.http_port, gateway.https_port, gateway.tls_mode");
            std::process::exit(1);
        }
    }

    config.save()?;
    println!("{key} = {value}");
    Ok(())
}

// --- Helpers ---

/// Create an OSC 8 terminal hyperlink (supported by iTerm2, Windows Terminal, GNOME Terminal, etc.)
/// Falls back to plain text in terminals that don't support it.
fn orca_link(path: &str, label: &str) -> String {
    let url = format!("orca://{path}");
    format!("\x1b]8;;{url}\x1b\\{label}\x1b]8;;\x1b\\")
}

/// Format a container ID as a clickable link to its detail page
fn container_link(id: &str, name: &str) -> String {
    orca_link(&format!("container/{id}"), name)
}

fn format_bytes(bytes: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = 1024 * KB;
    const GB: u64 = 1024 * MB;

    if bytes >= GB {
        format!("{:.1} GB", bytes as f64 / GB as f64)
    } else if bytes >= MB {
        format!("{:.1} MB", bytes as f64 / MB as f64)
    } else if bytes >= KB {
        format!("{:.1} KB", bytes as f64 / KB as f64)
    } else {
        format!("{bytes} B")
    }
}
