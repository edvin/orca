use clap::{Parser, Subcommand};

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
}

#[derive(Subcommand)]
enum MachineAction {
    /// List all machines
    List,
    /// Start a machine
    Start {
        /// Machine name (default: "default")
        #[arg(default_value = "default")]
        name: String,
    },
    /// Stop a machine
    Stop {
        /// Machine name (default: "default")
        #[arg(default_value = "default")]
        name: String,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let client = client::DaemonClient::new("http://127.0.0.1:9477", cli.token);

    match cli.command {
        Commands::Status => cmd_status(&client).await?,
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
        },
        Commands::Machine { action } => match action {
            MachineAction::List => cmd_machine_list(&client).await?,
            MachineAction::Start { name } => cmd_machine_start(&client, &name).await?,
            MachineAction::Stop { name } => cmd_machine_stop(&client, &name).await?,
        },
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
        let ports = c
            .ports
            .iter()
            .map(|p| format!("{}:{}", p.host_port, p.container_port))
            .collect::<Vec<_>>()
            .join(", ");
        println!(
            "{:<14} {:<18} {:<20} {:<10} {}",
            short_id, c.name, c.image, c.state, ports
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
        std::process::exit(result.exit_code);
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

async fn cmd_machine_start(client: &client::DaemonClient, name: &str) -> anyhow::Result<()> {
    println!("Starting machine '{name}'...");
    client.start_machine(name).await?;
    println!("Machine '{name}' started.");
    Ok(())
}

async fn cmd_machine_stop(client: &client::DaemonClient, name: &str) -> anyhow::Result<()> {
    println!("Stopping machine '{name}'...");
    client.stop_machine(name).await?;
    println!("Machine '{name}' stopped.");
    Ok(())
}

// --- Helpers ---

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
