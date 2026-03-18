use clap::{Parser, Subcommand};

mod client;

#[derive(Parser)]
#[command(name = "vessel", about = "Vessel — open source container desktop")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Manage container machines
    Machine {
        #[command(subcommand)]
        action: MachineAction,
    },
    /// Show daemon status
    Status,
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
        #[arg(default_value = "default")]
        name: String,
    },
    /// Create a new machine
    Create {
        name: String,
        #[arg(long, default_value = "2")]
        cpus: u32,
        #[arg(long, default_value = "4096")]
        memory: u64,
        #[arg(long, default_value = "60")]
        disk: u64,
    },
    /// Delete a machine
    Delete {
        name: String,
        #[arg(long)]
        force: bool,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let client = client::DaemonClient::new("http://127.0.0.1:9477");

    match cli.command {
        Commands::Status => {
            let health = client.health().await?;
            println!("Vessel daemon: {} (v{})", health.status, health.version);
        }
        Commands::Machine { action } => match action {
            MachineAction::List => {
                println!("NAME\tSTATE\tCPUS\tMEMORY\tRUNTIME");
                // TODO: call daemon API
            }
            MachineAction::Start { name } => {
                println!("Starting machine '{name}'...");
                // TODO
            }
            MachineAction::Stop { name } => {
                println!("Stopping machine '{name}'...");
                // TODO
            }
            MachineAction::Create {
                name,
                cpus,
                memory,
                disk,
            } => {
                println!("Creating machine '{name}' (cpus={cpus}, memory={memory}MB, disk={disk}GB)...");
                // TODO
            }
            MachineAction::Delete { name, force } => {
                let msg = if force { " (force)" } else { "" };
                println!("Deleting machine '{name}'{msg}...");
                // TODO
            }
        },
    }

    Ok(())
}
