use std::process::Stdio;
use tokio::process::Command;
use tokio::sync::OnceCell;
use orca_core::environment::*;
use serde::Deserialize as SerdeDeserialize;

/// Cached container CLI detection result.
static CLI_CELL: OnceCell<&'static str> = OnceCell::const_new();

/// Detect the container CLI command — prefers docker, falls back to podman.
/// The result is cached after the first call.
fn extended_path() -> String {
    let current = std::env::var("PATH").unwrap_or_default();
    format!("/usr/local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/sbin:{current}")
}

async fn detect_cli() -> &'static str {
    CLI_CELL
        .get_or_init(|| async {
            let path = extended_path();
            if Command::new("docker")
                .arg("--version")
                .env("PATH", &path)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .await
                .is_ok_and(|s| s.success())
            {
                return "docker";
            }
            if Command::new("podman")
                .arg("--version")
                .env("PATH", &path)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .await
                .is_ok_and(|s| s.success())
            {
                return "podman";
            }
            "docker" // default
        })
        .await
}

/// Detect the current platform.
fn detect_platform() -> String {
    if cfg!(target_os = "linux") {
        "linux".to_string()
    } else if cfg!(target_os = "macos") {
        "macos".to_string()
    } else if cfg!(target_os = "windows") {
        "windows".to_string()
    } else {
        "unknown".to_string()
    }
}

/// Run a command and capture its stdout. Returns Ok(stdout) on success.
pub async fn run_cmd(program: &str, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new(program);
    // Use piped stdin (not null) — wsl.exe on Windows exits immediately with null stdin.
    // We drop the stdin handle right away so the child sees EOF, not a blocked pipe.
    cmd.args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Extend PATH to include common binary locations. App bundles on macOS
    // have a minimal PATH, but this is harmless on all platforms.
    let current_path = std::env::var("PATH").unwrap_or_default();
    let extended = format!(
        "/usr/local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/sbin:{}",
        current_path
    );
    cmd.env("PATH", &extended);

    let child = cmd.spawn().map_err(|e| e.to_string())?;
    let result = child.wait_with_output().await.map_err(|e| e.to_string())?;

    let stdout = decode_output(&result.stdout);
    let stderr = decode_output(&result.stderr);
    // Combine stdout and stderr so we never lose output
    let combined = if stderr.trim().is_empty() {
        stdout.trim().to_string()
    } else if stdout.trim().is_empty() {
        stderr.trim().to_string()
    } else {
        format!("{}\n{}", stdout.trim(), stderr.trim())
    };

    if result.status.success() {
        Ok(combined)
    } else {
        Err(if combined.is_empty() {
            format!("exit code {}", result.status.code().unwrap_or(-1))
        } else {
            combined
        })
    }
}

/// Run a command and stream its output line by line to a sender.
/// Returns the exit status.
pub async fn run_cmd_streaming(
    program: &str,
    args: &[&str],
    tx: &tokio::sync::mpsc::Sender<String>,
) -> Result<(), String> {
    use tokio::io::{AsyncBufReadExt, BufReader};

    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let current_path = std::env::var("PATH").unwrap_or_default();
    let extended = format!(
        "/usr/local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/sbin:{}",
        current_path
    );
    cmd.env("PATH", &extended);

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;

    // Drop stdin so the child sees EOF
    drop(child.stdin.take());

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // Read stdout and stderr concurrently, sending lines as they come
    let tx2 = tx.clone();
    let stdout_task = tokio::spawn(async move {
        if let Some(out) = stdout {
            let mut reader = BufReader::new(out).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let _ = tx2.send(line).await;
            }
        }
    });

    let tx3 = tx.clone();
    let stderr_task = tokio::spawn(async move {
        if let Some(err) = stderr {
            let mut reader = BufReader::new(err).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let _ = tx3.send(line).await;
            }
        }
    });

    let _ = stdout_task.await;
    let _ = stderr_task.await;

    let status = child.wait().await.map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("exit code {}", status.code().unwrap_or(-1)))
    }
}

/// Run a fix action with streaming output to a sender.
pub async fn run_fix_streaming(
    action: &str,
    tx: tokio::sync::mpsc::Sender<String>,
) -> anyhow::Result<()> {
    let send = |msg: String| {
        let tx = tx.clone();
        async move { let _ = tx.send(msg).await; }
    };

    tracing::info!("run_fix_streaming: action={action}");
    match action {
        "install_docker" => {
            #[cfg(target_os = "windows")]
            {
                send(">>> Checking WSL status...".into()).await;
                if let Ok(v) = run_cmd("wsl", &["--version"]).await {
                    for line in v.lines() { send(line.to_string()).await; }
                }

                send("\n>>> Probing WSL...".into()).await;
                let probe = run_cmd("wsl", &["-u", "root", "--", "echo", "wsl-ok"]).await
                    .map_err(|e| anyhow::anyhow!("WSL not available: {e}"))?;
                if !probe.contains("wsl-ok") {
                    anyhow::bail!("No WSL distro found. Install Ubuntu from the Microsoft Store.");
                }
                send("WSL is ready.\n".into()).await;

                // Check if Docker is already installed
                send(">>> Checking for existing Docker installation...".into()).await;
                if let Ok(v) = run_cmd("wsl", &["-u", "root", "--", "docker", "--version"]).await {
                    send(format!("Docker found: {v}")).await;
                    send(">>> Configuring TCP listener...".into()).await;
                    let _ = run_cmd("wsl", &["-u", "root", "--", "bash", "-c",
                        "mkdir -p /etc/systemd/system/docker.service.d && \
                         echo -e '[Service]\\nExecStart=\\nExecStart=/usr/bin/dockerd -H fd:// -H tcp://0.0.0.0:2375 --containerd=/run/containerd/containerd.sock' > /etc/systemd/system/docker.service.d/override.conf && \
                         systemctl daemon-reload 2>/dev/null"
                    ]).await;
                    send(">>> Starting Docker service...".into()).await;
                    let _ = run_cmd("wsl", &["-u", "root", "--", "service", "docker", "start"]).await;
                    send("Docker started.".into()).await;
                    return Ok(());
                }

                send("Docker not installed. Running install script...\n".into()).await;

                // Stop existing daemon
                let _ = run_cmd("wsl", &["-u", "root", "--", "service", "docker", "stop"]).await;

                // Stream the install script
                send(">>> Downloading and running Docker install script...".into()).await;
                send("    (this will take a minute or two)\n".into()).await;
                run_cmd_streaming("wsl", &["-u", "root", "--", "bash", "-c",
                    "curl -fsSL https://get.docker.com | sh"
                ], &tx).await.map_err(|e| anyhow::anyhow!("Install failed: {e}"))?;

                send("\n>>> Adding user to docker group...".into()).await;
                let _ = run_cmd("wsl", &["-u", "root", "--", "bash", "-c",
                    "DEFAULT_USER=$(getent passwd 1000 | cut -d: -f1) && usermod -aG docker \"$DEFAULT_USER\""
                ]).await;

                send(">>> Configuring TCP listener...".into()).await;
                let _ = run_cmd("wsl", &["-u", "root", "--", "bash", "-c",
                    "mkdir -p /etc/systemd/system/docker.service.d && \
                     echo -e '[Service]\\nExecStart=\\nExecStart=/usr/bin/dockerd -H fd:// -H tcp://0.0.0.0:2375 --containerd=/run/containerd/containerd.sock' > /etc/systemd/system/docker.service.d/override.conf && \
                     systemctl daemon-reload 2>/dev/null"
                ]).await;

                send(">>> Starting Docker service...".into()).await;
                let _ = run_cmd("wsl", &["-u", "root", "--", "service", "docker", "start"]).await;

                send(">>> Verifying...".into()).await;
                match run_cmd("wsl", &["-u", "root", "--", "docker", "--version"]).await {
                    Ok(v) => send(format!("{v}\n\nDocker installed successfully!")).await,
                    Err(e) => send(format!("Verification failed: {e}")).await,
                }
            }

            #[cfg(not(target_os = "windows"))]
            {
                send(">>> Running Docker install script...".into()).await;
                run_cmd_streaming("sh", &["-c", "curl -fsSL https://get.docker.com | sh"], &tx)
                    .await
                    .map_err(|e| anyhow::anyhow!("Install failed: {e}"))?;
                send("\nDocker installed successfully!".into()).await;
            }
        }
        "install_docker_linux" => {
            send(">>> Installing Docker on Linux...".into()).await;
            send("    Running: curl -fsSL https://get.docker.com | sudo sh\n".into()).await;

            // The Docker install script needs root. Use sudo -S which reads
            // password from stdin (will fail if sudo requires password without
            // NOPASSWD, but that's expected for a desktop app).
            // First try without password (NOPASSWD configured or already cached)
            let result = run_cmd_streaming(
                "sh", &["-c", "curl -fsSL https://get.docker.com | sudo -n sh"],
                &tx
            ).await;

            match result {
                Ok(_) => {
                    send("\n>>> Adding user to docker group...".into()).await;
                    let user = std::env::var("USER").unwrap_or_else(|_| "user".to_string());
                    let _ = run_cmd("sudo", &["-n", "usermod", "-aG", "docker", &user]).await;
                    send(format!("    Added {user} to docker group")).await;

                    send("\n>>> Starting Docker service...".into()).await;
                    let _ = run_cmd("sudo", &["-n", "systemctl", "start", "docker"]).await;
                    let _ = run_cmd("sudo", &["-n", "systemctl", "enable", "docker"]).await;

                    send(">>> Verifying...".into()).await;
                    match run_cmd("docker", &["--version"]).await {
                        Ok(v) => send(format!("{v}\n\nDocker installed successfully!\n\nYou may need to log out and back in for group changes to take effect.")).await,
                        Err(e) => send(format!("Verification failed: {e}")).await,
                    }
                }
                Err(e) => {
                    send(format!("\nInstall script failed: {e}\n")).await;
                    send("This likely means sudo requires a password.\n".into()).await;
                    send("Please install Docker manually by running in a terminal:\n".into()).await;
                    send("  curl -fsSL https://get.docker.com | sudo sh\n".into()).await;
                    send("  sudo usermod -aG docker $USER\n".into()).await;
                    send("  sudo systemctl start docker\n".into()).await;
                    send("\nThen restart Orca Desktop.".into()).await;
                    anyhow::bail!("Docker install requires sudo access. See instructions above.");
                }
            }
        }
        "install_podman_linux" => {
            send(">>> Installing Podman on Linux...\n".into()).await;
            // Detect package manager
            if run_cmd("apt", &["--version"]).await.is_ok() {
                send(">>> Using apt...\n".into()).await;
                run_cmd_streaming("sudo", &["-n", "apt", "install", "-y", "podman"], &tx).await
                    .map_err(|e| anyhow::anyhow!("apt install failed (sudo may require password): {e}"))?;
            } else if run_cmd("dnf", &["--version"]).await.is_ok() {
                send(">>> Using dnf...\n".into()).await;
                run_cmd_streaming("sudo", &["-n", "dnf", "install", "-y", "podman"], &tx).await
                    .map_err(|e| anyhow::anyhow!("dnf install failed: {e}"))?;
            } else if run_cmd("pacman", &["--version"]).await.is_ok() {
                send(">>> Using pacman...\n".into()).await;
                run_cmd_streaming("sudo", &["-n", "pacman", "-S", "--noconfirm", "podman"], &tx).await
                    .map_err(|e| anyhow::anyhow!("pacman install failed: {e}"))?;
            } else {
                anyhow::bail!("No supported package manager found. Install podman manually.");
            }
            send("\nPodman installed successfully!".into()).await;
        }
        "install_nvidia_toolkit" => {
            send(">>> Installing NVIDIA Container Toolkit...\n".into()).await;

            #[cfg(target_os = "windows")]
            {
                send("Installing inside WSL2...\n".into()).await;
                // Re-apply TCP override after nvidia-ctk (it may modify Docker config)
                let script = r#"
                    curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg 2>/dev/null && \
                    curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
                        sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
                        tee /etc/apt/sources.list.d/nvidia-container-toolkit.list > /dev/null && \
                    apt-get update && apt-get install -y nvidia-container-toolkit && \
                    nvidia-ctk runtime configure --runtime=docker && \
                    mkdir -p /etc/systemd/system/docker.service.d && \
                    echo -e '[Service]\nExecStart=\nExecStart=/usr/bin/dockerd -H fd:// -H tcp://0.0.0.0:2375 --containerd=/run/containerd/containerd.sock' > /etc/systemd/system/docker.service.d/override.conf && \
                    systemctl daemon-reload && \
                    systemctl restart docker
                "#;
                run_cmd_streaming("wsl", &["-u", "root", "--", "bash", "-c", script], &tx).await
                    .map_err(|e| anyhow::anyhow!("NVIDIA Container Toolkit installation failed: {e}"))?;
            }

            #[cfg(not(target_os = "windows"))]
            {
                let script = r#"
                    curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg 2>/dev/null && \
                    curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
                        sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
                        sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list > /dev/null && \
                    sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit && \
                    sudo nvidia-ctk runtime configure --runtime=docker && \
                    sudo systemctl restart docker
                "#;
                run_cmd_streaming("bash", &["-c", script], &tx).await
                    .map_err(|e| anyhow::anyhow!("NVIDIA Container Toolkit installation failed: {e}"))?;
            }

            send("\n>>> NVIDIA Container Toolkit installed!\n".into()).await;
            send(">>> Waiting for Docker to come back online...\n".into()).await;

            // Docker was restarted as part of the install — wait for it to be ready
            for i in 0..15 {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                let check = {
                    #[cfg(target_os = "windows")]
                    { run_cmd("wsl", &["-u", "root", "--", "docker", "info"]).await }
                    #[cfg(not(target_os = "windows"))]
                    { run_cmd("docker", &["info"]).await }
                };
                if check.is_ok() {
                    send("    Docker is back online.\n".into()).await;
                    break;
                }
                if i % 3 == 2 {
                    send(format!("    Waiting... ({}s)\n", (i + 1) * 2)).await;
                }
            }

            send("\n>>> Done! Close this dialog to restart Orca and reconnect.\n".into()).await;
            send("    Then restart any Ollama containers to use GPU acceleration.\n".into()).await;
        }
        "setup_docker_macos" => {
            send(">>> Setting up Docker on macOS via Lima\n".into()).await;
            send("    This will create a lightweight Linux VM using Apple Virtualization.\n".into()).await;

            // Step 1: Check/install Homebrew
            send(">>> Step 1/5: Checking Homebrew...\n".into()).await;
            if run_cmd("brew", &["--version"]).await.is_err() {
                send("    Homebrew not found. Installing...\n".into()).await;
                let brew_result = run_cmd_streaming(
                    "sh", &["-c", "/bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""],
                    &tx
                ).await;
                if let Err(e) = brew_result {
                    send(format!("\n    Homebrew installation failed: {e}\n")).await;
                    send("    Install Homebrew manually: https://brew.sh\n".into()).await;
                    anyhow::bail!("Homebrew is required. Install it from https://brew.sh");
                }
                send("    Homebrew installed.\n".into()).await;
            } else {
                send("    Homebrew is installed.\n".into()).await;
            }

            // Step 2: Install Lima + Docker CLI + Docker Compose
            send(">>> Step 2/5: Installing Lima, Docker CLI, and Compose...\n".into()).await;
            let lima_installed = run_cmd("limactl", &["--version"]).await.is_ok();
            let docker_cli_installed = run_cmd("docker", &["--version"]).await.is_ok();
            let compose_installed = run_cmd("docker", &["compose", "version"]).await.is_ok();
            let buildx_installed = run_cmd("docker", &["buildx", "version"]).await.is_ok();

            {
                let mut packages = Vec::new();
                if !lima_installed { packages.push("lima"); }
                if !docker_cli_installed { packages.push("docker"); }
                if !compose_installed { packages.push("docker-compose"); }
                if !buildx_installed { packages.push("docker-buildx"); }

                if packages.is_empty() {
                    send("    Lima, Docker CLI, Compose, and Buildx already installed.\n".into()).await;
                } else {
                    send(format!("    Installing: {}\n", packages.join(", "))).await;
                    let install_result = run_cmd_streaming(
                        "brew", &[&["install"][..], &packages.iter().map(|s| *s).collect::<Vec<_>>()].concat(),
                        &tx
                    ).await;
                    if let Err(e) = install_result {
                        send(format!("\n    brew install failed: {e}\n")).await;
                        anyhow::bail!("Failed to install Lima/Docker via Homebrew: {e}");
                    }

                    // Set up docker-compose as a CLI plugin (docker compose v2)
                    if !compose_installed {
                        send("    Configuring Docker Compose plugin...\n".into()).await;
                        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
                        let plugins_dir = format!("{home}/.docker/cli-plugins");
                        let _ = std::fs::create_dir_all(&plugins_dir);
                        // Find the brew-installed docker-compose binary and symlink it
                        if let Ok(prefix) = run_cmd("brew", &["--prefix", "docker-compose"]).await {
                            let bin = format!("{}/bin/docker-compose", prefix.trim());
                            let link = format!("{plugins_dir}/docker-compose");
                            #[cfg(unix)]
                            let _ = std::os::unix::fs::symlink(&bin, &link);
                            send("    Docker Compose plugin linked.\n".into()).await;
                        }
                    }

                    // Set up docker-buildx as a CLI plugin
                    if !buildx_installed {
                        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
                        let plugins_dir = format!("{home}/.docker/cli-plugins");
                        let _ = std::fs::create_dir_all(&plugins_dir);
                        if let Ok(prefix) = run_cmd("brew", &["--prefix", "docker-buildx"]).await {
                            let bin = format!("{}/bin/docker-buildx", prefix.trim());
                            let link = format!("{plugins_dir}/docker-buildx");
                            #[cfg(unix)]
                            let _ = std::os::unix::fs::symlink(&bin, &link);
                            send("    Docker Buildx plugin linked.\n".into()).await;
                        }
                    }

                    send("    Installation complete.\n".into()).await;
                }
            }

            // Step 3: Create Lima VM with Docker
            send(">>> Step 3/5: Creating Lima VM with Docker...\n".into()).await;

            // Check if a Lima VM already exists
            let existing_vms = run_cmd("limactl", &["list", "--format", "{{.Name}}"]).await
                .unwrap_or_default();
            let has_orca_vm = existing_vms.lines().any(|l| {
                let name = l.trim();
                name == "orca" || name == "docker" || name == "default"
            });
            // Determine the VM name — prefer "orca", fall back to existing
            let vm_name = if existing_vms.lines().any(|l| l.trim() == "orca") {
                "orca"
            } else if existing_vms.lines().any(|l| l.trim() == "docker") {
                "docker" // Legacy name from earlier versions
            } else {
                "orca"
            };

            if has_orca_vm {
                send(format!("    Lima VM '{}' already exists.\n", vm_name).into()).await;
            } else {
                send("    Creating 'orca' VM with Apple Virtualization...\n".into()).await;
                send("    This downloads a lightweight Linux image (~150MB)\n\n".into()).await;

                // Create VM with --set to add port forwarding for 127.0.0.1-bound ports
                // This matches Docker Desktop behavior where localhost:80 works from the host
                let create_result = run_cmd_streaming(
                    "limactl", &["create", "--name=orca", "--vm-type=vz",
                        "--rosetta", "--mount-writable",
                        "--mount-type=virtiofs",
                        "--memory=8",
                        "--cpus=4",
                        "--set", r#".portForwards += [{"guestIP": "0.0.0.0", "guestIPMustBeZero": true, "guestPortRange": [1, 65535], "hostIP": "127.0.0.1", "proto": "tcp"}]"#,
                        "--set", r#".mounts += [{"location": "/Volumes", "writable": true}, {"location": "/private", "writable": true}]"#,
                        "--set", r##".provision += [{"mode": "system", "script": "#!/bin/bash\nset -eu\n# Install HWE kernel for idmapped mount support (6.12+)\nif ! dpkg -l linux-generic-hwe-24.04 2>/dev/null | grep -q ^ii; then\n  apt-get update -qq && apt-get install -y -qq linux-generic-hwe-24.04\nfi\n"}]"##,
                        "template:docker"],
                    &tx
                ).await;

                if let Err(e) = create_result {
                    send(format!("\n    VM creation failed: {e}\n")).await;
                    anyhow::bail!("Failed to create Lima VM: {e}");
                }
                send("\n    VM created.\n".into()).await;
            }

            // Step 4: Start the VM
            send(">>> Step 4/5: Starting Lima VM...\n".into()).await;

            let start_result = run_cmd_streaming(
                "limactl", &["start", vm_name],
                &tx
            ).await;

            if let Err(e) = start_result {
                // VM might already be running
                let status = run_cmd("limactl", &["list", "--format", "{{.Name}} {{.Status}}"]).await.unwrap_or_default();
                if !status.contains("Running") {
                    send(format!("\n    Failed to start VM: {e}\n")).await;
                    anyhow::bail!("Failed to start Lima VM: {e}");
                }
            }
            send("    VM is running.\n".into()).await;

            // Step 5: Configure Docker context to use Lima
            send(">>> Step 5/5: Configuring Docker...\n".into()).await;

            // Lima's docker template auto-configures the socket
            // Set the DOCKER_HOST for the current session and persist it
            let socket_path = format!(
                "{home}/.lima/{vm_name}/sock/docker.sock",
                home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into()),
                vm_name = vm_name
            );

            // Wait for socket to appear
            if !std::path::Path::new(&socket_path).exists() {
                send("    Waiting for Docker socket...\n".into()).await;
                for i in 0..15 {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    if std::path::Path::new(&socket_path).exists() { break; }
                    if i % 3 == 2 { send(format!("    Waiting... ({}s)\n", (i + 1) * 2)).await; }
                }
            }

            if std::path::Path::new(&socket_path).exists() {
                send(format!("    Docker socket: {socket_path}\n")).await;

                // Remove stale contexts, create fresh one pointing to the correct socket
                let _ = run_cmd("docker", &["context", "rm", "-f", "lima"]).await;
                let _ = run_cmd("docker", &["context", "rm", "-f", "lima-orca"]).await;
                let _ = run_cmd("docker", &["context", "rm", "-f", "lima-docker"]).await;
                let _ = run_cmd("docker", &["context", "create", "lima-orca",
                    "--docker", &format!("host=unix://{socket_path}"),
                ]).await;
                let _ = run_cmd("docker", &["context", "use", "lima-orca"]).await;
                send("    Docker context 'lima-orca' configured.\n".into()).await;
            } else {
                send(format!("    Warning: Docker socket not found at {socket_path}\n")).await;
            }

            // Verify Docker works via the correct socket directly
            send("\n>>> Verifying Docker connection...\n".into()).await;
            match run_cmd("docker", &["-H", &format!("unix://{socket_path}"), "info", "--format", "{{.ServerVersion}}"]).await {
                Ok(version) => {
                    send(format!("    Docker {} is ready!\n", version.trim())).await;
                    send("\n>>> Setup complete. Orca Desktop is ready to use.\n".into()).await;
                    send("    You can now manage containers, pull images, and deploy apps.\n".into()).await;
                    send("\n    Tip: If you previously used Docker Desktop, you can uninstall it.\n".into()).await;
                    send("    All your existing images and containers will need to be re-created\n".into()).await;
                    send("    in the new Lima-based Docker environment.\n".into()).await;
                }
                Err(e) => {
                    send(format!("    Docker verification failed: {e}\n")).await;
                    send("    The VM is running but Docker may still be starting.\n".into()).await;
                    send("    Try restarting Orca Desktop in a minute.\n".into()).await;
                }
            }
        }
        // For all other actions, fall back to non-streaming run_fix
        _ => {
            send(format!("Running {action}...")).await;
            let output = run_fix(action).await?;
            send(output).await;
        }
    }
    Ok(())
}

/// Decode command output, handling UTF-16LE (common from Windows CLI tools like wsl.exe).
fn decode_output(bytes: &[u8]) -> String {
    // Check for UTF-16LE BOM (FF FE) or null bytes interleaved with ASCII
    // which is the telltale sign of UTF-16LE without BOM
    let is_utf16 = (bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE)
        || (bytes.len() >= 4 && bytes[1] == 0 && bytes[3] == 0);

    if is_utf16 {
        let skip = if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE { 2 } else { 0 };
        let u16s: Vec<u16> = bytes[skip..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&u16s)
    } else {
        String::from_utf8_lossy(bytes).to_string()
    }
}

async fn check_docker_installed() -> HealthCheck {
    // Try via PATH (which we extend), then explicit common paths as fallback
    let result = match run_cmd("docker", &["--version"]).await {
        Ok(v) => Ok(v),
        Err(_) => match run_cmd("/usr/local/bin/docker", &["--version"]).await {
            Ok(v) => Ok(v),
            Err(_) => run_cmd("/opt/homebrew/bin/docker", &["--version"]).await,
        },
    };

    // On Windows, also check inside WSL if the host check failed
    #[cfg(target_os = "windows")]
    let result = match result {
        Ok(v) => Ok(v),
        Err(_) => run_cmd("wsl", &["docker", "--version"]).await,
    };

    match result {
        Ok(version) => HealthCheck {
            name: "Docker Runtime".to_string(),
            description: "Container runtime is available".to_string(),
            status: CheckStatus::Pass,
            fix_action: None,
            details: Some(version),
        },
        Err(e) => HealthCheck {
            name: "Docker Runtime".to_string(),
            description: "No container runtime found".to_string(),
            status: CheckStatus::Fail,
            fix_action: Some(if cfg!(target_os = "linux") {
                "install_docker_linux".to_string()
            } else if cfg!(target_os = "macos") {
                "setup_docker_macos".to_string()
            } else {
                "install_docker".to_string()
            }),
            details: Some(format!("Docker/Podman not in PATH: {e}")),
        },
    }
}

async fn check_podman_installed() -> HealthCheck {
    match run_cmd("podman", &["--version"]).await {
        Ok(version) => HealthCheck {
            name: "Podman Runtime".to_string(),
            description: "Podman CLI is installed".to_string(),
            status: CheckStatus::Pass,
            fix_action: None,
            details: Some(version),
        },
        Err(e) => HealthCheck {
            name: "Podman Runtime".to_string(),
            description: "Podman CLI is installed (alternative to Docker)".to_string(),
            status: CheckStatus::Warning,
            fix_action: Some("install_podman_linux".to_string()),
            details: Some(format!("Not found: {e}")),
        },
    }
}

async fn check_docker_socket() -> HealthCheck {
    let sock = std::path::Path::new("/var/run/docker.sock");
    if sock.exists() {
        HealthCheck {
            name: "Docker Socket".to_string(),
            description: "Docker daemon socket exists at /var/run/docker.sock".to_string(),
            status: CheckStatus::Pass,
            fix_action: None,
            details: Some("/var/run/docker.sock".to_string()),
        }
    } else {
        HealthCheck {
            name: "Docker Socket".to_string(),
            description: "Docker daemon socket at /var/run/docker.sock".to_string(),
            status: CheckStatus::Fail,
            fix_action: Some("start_docker".to_string()),
            details: Some("Socket not found — Docker daemon may not be running".to_string()),
        }
    }
}

async fn check_docker_running() -> HealthCheck {
    let cli = detect_cli().await;
    match run_cmd(cli, &["info", "--format", "{{.ServerVersion}}"]).await {
        Ok(version) => HealthCheck {
            name: "Container Daemon".to_string(),
            description: format!("{cli} daemon is running and responsive"),
            status: CheckStatus::Pass,
            fix_action: None,
            details: Some(format!("Server version: {version}")),
        },
        Err(e) => {
            let fix = if cli == "podman" {
                "start_podman".to_string()
            } else {
                "start_docker".to_string()
            };
            HealthCheck {
                name: "Container Daemon".to_string(),
                description: format!("{cli} daemon is running and responsive"),
                status: CheckStatus::Fail,
                fix_action: Some(fix),
                details: Some(format!("Daemon not responding: {e}")),
            }
        }
    }
}

async fn check_docker_group() -> HealthCheck {
    // Check if current user is in the docker group
    match run_cmd("id", &["-nG"]).await {
        Ok(groups) => {
            let in_group = groups.split_whitespace().any(|g| g == "docker");
            if in_group {
                HealthCheck {
                    name: "Docker Group".to_string(),
                    description: "Current user is in the docker group".to_string(),
                    status: CheckStatus::Pass,
                    fix_action: None,
                    details: Some("User is in the docker group".to_string()),
                }
            } else {
                // Check if running as root (root doesn't need docker group)
                let is_root = std::env::var("USER")
                    .map(|u| u == "root")
                    .unwrap_or(false);
                if is_root {
                    HealthCheck {
                        name: "Docker Group".to_string(),
                        description: "Current user is in the docker group".to_string(),
                        status: CheckStatus::Pass,
                        fix_action: None,
                        details: Some("Running as root (group membership not needed)".to_string()),
                    }
                } else {
                    HealthCheck {
                        name: "Docker Group".to_string(),
                        description: "Current user is in the docker group (required for rootless Docker)".to_string(),
                        status: CheckStatus::Warning,
                        fix_action: Some("add_docker_group".to_string()),
                        details: Some("User is not in the docker group — you may need to use sudo".to_string()),
                    }
                }
            }
        }
        Err(e) => HealthCheck {
            name: "Docker Group".to_string(),
            description: "Current user is in the docker group".to_string(),
            status: CheckStatus::Warning,
            fix_action: None,
            details: Some(format!("Could not check groups: {e}")),
        },
    }
}


async fn check_wsl2_enabled() -> HealthCheck {
    match run_cmd("wsl", &["--status"]).await {
        Ok(output) => {
            let has_wsl2 = output.contains("2") || output.to_lowercase().contains("wsl 2");
            if has_wsl2 {
                HealthCheck {
                    name: "WSL2".to_string(),
                    description: "Windows Subsystem for Linux 2 is enabled".to_string(),
                    status: CheckStatus::Pass,
                    fix_action: None,
                    details: Some(output.lines().next().unwrap_or(&output).to_string()),
                }
            } else {
                HealthCheck {
                    name: "WSL2".to_string(),
                    description: "Windows Subsystem for Linux 2 is required for containers".to_string(),
                    status: CheckStatus::Fail,
                    fix_action: Some("enable_wsl2".to_string()),
                    details: Some("WSL2 does not appear to be active".to_string()),
                }
            }
        }
        Err(e) => HealthCheck {
            name: "WSL2".to_string(),
            description: "Windows Subsystem for Linux 2 is required for containers".to_string(),
            status: CheckStatus::Fail,
            fix_action: Some("enable_wsl2".to_string()),
            details: Some(format!("WSL not available: {e}")),
        },
    }
}

async fn check_docker_desktop() -> HealthCheck {
    // Check if Docker Desktop is installed by looking for its specific markers
    let desktop_installed = if cfg!(target_os = "macos") {
        std::path::Path::new("/Applications/Docker.app").exists()
    } else if cfg!(target_os = "windows") {
        std::path::Path::new(
            &format!(
                "{}\\Docker\\Docker\\Docker Desktop.exe",
                std::env::var("ProgramFiles").unwrap_or_default()
            ),
        ).exists()
    } else if cfg!(target_os = "linux") {
        std::path::Path::new("/opt/docker-desktop").exists()
    } else {
        false
    };

    if desktop_installed {
        HealthCheck {
            name: "Docker Desktop".to_string(),
            description: "Detected — Orca shares the same Docker daemon".to_string(),
            status: CheckStatus::Pass,
            fix_action: None,
            details: Some("Docker Desktop is installed alongside Orca".to_string()),
        }
    } else {
        // Don't show Docker Desktop as a check at all when not installed —
        // we don't want to promote it, Orca is the replacement
        HealthCheck {
            name: "Docker Desktop".to_string(),
            description: "Not installed".to_string(),
            status: CheckStatus::Pass, // Pass, not Warning — absence is fine
            fix_action: None,
            details: None, // No details, keeps it quiet
        }
    }
}

async fn check_podman_socket() -> HealthCheck {
    // Check rootless socket first, then root socket
    let uid = std::env::var("UID")
        .or_else(|_| {
            std::fs::read_to_string("/proc/self/loginuid")
                .map(|s| s.trim().to_string())
        })
        .unwrap_or_default();

    let rootless = format!("/run/user/{uid}/podman/podman.sock");
    let root = "/run/podman/podman.sock";

    let (found, path) = if std::path::Path::new(&rootless).exists() {
        (true, rootless)
    } else if std::path::Path::new(root).exists() {
        (true, root.to_string())
    } else {
        (false, String::new())
    };

    if found {
        HealthCheck {
            name: "Podman Socket".to_string(),
            description: "Podman API socket is available".to_string(),
            status: CheckStatus::Pass,
            fix_action: None,
            details: Some(path),
        }
    } else {
        HealthCheck {
            name: "Podman Socket".to_string(),
            description: "Podman API socket for container management".to_string(),
            status: CheckStatus::Warning,
            fix_action: Some("start_podman".to_string()),
            details: Some("Podman socket not found — try: systemctl --user start podman.socket".to_string()),
        }
    }
}

async fn check_nvidia_gpu() -> HealthCheck {
    // Check for NVIDIA GPU
    let has_gpu = if cfg!(target_os = "windows") {
        // On Windows, check inside WSL
        run_cmd("wsl", &["-u", "root", "--", "nvidia-smi", "--query-gpu=name", "--format=csv,noheader"]).await
    } else {
        run_cmd("nvidia-smi", &["--query-gpu=name", "--format=csv,noheader"]).await
    };

    match has_gpu {
        Ok(gpu_name) => {
            let gpu = gpu_name.trim().lines().next().unwrap_or("").to_string();
            // Check for NVIDIA Container Toolkit
            let toolkit = if cfg!(target_os = "windows") {
                run_cmd("wsl", &["-u", "root", "--", "nvidia-container-cli", "--version"]).await
            } else {
                run_cmd("nvidia-container-cli", &["--version"]).await
            };

            match toolkit {
                Ok(ver) => HealthCheck {
                    name: "NVIDIA GPU".to_string(),
                    description: "GPU acceleration available for AI workloads".to_string(),
                    status: CheckStatus::Pass,
                    fix_action: None,
                    details: Some(format!("{} — Container Toolkit {}", gpu, ver.trim().lines().next().unwrap_or(""))),
                },
                Err(_) => HealthCheck {
                    name: "NVIDIA GPU".to_string(),
                    description: format!("{} detected but Container Toolkit not installed", gpu),
                    status: CheckStatus::Warning,
                    fix_action: Some("install_nvidia_toolkit".to_string()),
                    details: Some(format!("{} — install nvidia-container-toolkit for GPU in containers", gpu)),
                },
            }
        }
        Err(_) => HealthCheck {
            name: "NVIDIA GPU".to_string(),
            description: "No NVIDIA GPU detected — optional, only needed for local AI acceleration".to_string(),
            status: CheckStatus::Pass,
            fix_action: None,
            details: None,
        },
    }
}

/// Run all environment checks for the current platform.
pub async fn check_environment() -> EnvironmentStatus {
    let platform = detect_platform();
    let mut checks = Vec::new();

    match platform.as_str() {
        "linux" => {
            checks.push(check_docker_installed().await);
            checks.push(check_podman_installed().await);
            checks.push(check_docker_socket().await);
            checks.push(check_podman_socket().await);
            checks.push(check_docker_running().await);
            checks.push(check_docker_group().await);
            let gpu = check_nvidia_gpu().await;
            if gpu.details.is_some() { checks.push(gpu); }
        }
        "macos" => {
            // Always check if Docker is actually running — regardless of Docker Desktop
            // First try `docker info` which respects DOCKER_HOST and the active context
            let docker_running = match run_cmd("docker", &["info", "--format", "{{.ServerVersion}}"]).await {
                Ok(version) => Some(version.trim().to_string()),
                Err(_) => {
                    // docker info failed — the Docker context may be stale (pointing
                    // to a dead Docker Desktop socket). Try known Lima sockets directly.
                    let mut found_version = None;
                    if let Ok(home) = std::env::var("HOME") {
                        for vm in &["orca", "docker", "default", "colima"] {
                            let socket = format!("{home}/.lima/{vm}/sock/docker.sock");
                            if std::path::Path::new(&socket).exists() {
                                let host_arg = format!("unix://{socket}");
                                if let Ok(version) = run_cmd("docker", &["-H", &host_arg, "info", "--format", "{{.ServerVersion}}"]).await {
                                    let v = version.trim().to_string();
                                    if !v.is_empty() {
                                        found_version = Some(v);
                                        break;
                                    }
                                }
                            }
                        }
                        // Also try Colima default socket
                        if found_version.is_none() {
                            let colima_sock = format!("{home}/.colima/default/docker.sock");
                            if std::path::Path::new(&colima_sock).exists() {
                                let host_arg = format!("unix://{colima_sock}");
                                if let Ok(version) = run_cmd("docker", &["-H", &host_arg, "info", "--format", "{{.ServerVersion}}"]).await {
                                    let v = version.trim().to_string();
                                    if !v.is_empty() {
                                        found_version = Some(v);
                                    }
                                }
                            }
                        }
                    }
                    found_version
                },
            };

            if let Some(version) = docker_running {
                // Docker is running (via Docker Desktop, Lima, Colima, etc.)
                checks.push(HealthCheck {
                    name: "Docker Runtime".to_string(),
                    description: "Docker engine is running".to_string(),
                    status: CheckStatus::Pass,
                    fix_action: None,
                    details: Some(format!("Server version: {version}")),
                });
            } else {
                // Docker not running — single action to set up everything
                checks.push(HealthCheck {
                    name: "Docker Runtime".to_string(),
                    description: "Docker is not running. Click Fix to install and configure automatically.".to_string(),
                    status: CheckStatus::Fail,
                    fix_action: Some("setup_docker_macos".to_string()),
                    details: Some("Installs Homebrew, Lima, and Docker in a lightweight Linux VM using Apple Virtualization".to_string()),
                });
            }
        }
        "windows" => {
            checks.push(check_wsl2_enabled().await);
            // Check if Docker is installed inside WSL
            let wsl_docker = match run_cmd("wsl", &["-u", "root", "--", "docker", "--version"]).await {
                Ok(version) => HealthCheck {
                    name: "Docker Runtime".to_string(),
                    description: "Docker is installed in WSL2".to_string(),
                    status: CheckStatus::Pass,
                    fix_action: None,
                    details: Some(version.trim().to_string()),
                },
                Err(_) => HealthCheck {
                    name: "Docker Runtime".to_string(),
                    description: "Docker not found in WSL2".to_string(),
                    status: CheckStatus::Fail,
                    fix_action: Some("install_docker".to_string()),
                    details: Some("Install Docker inside WSL2".to_string()),
                },
            };
            let docker_installed = wsl_docker.status == CheckStatus::Pass;
            checks.push(wsl_docker);

            // Check if Docker daemon is actually running
            if docker_installed {
                match run_cmd("wsl", &["-u", "root", "--", "docker", "info", "--format", "{{.ServerVersion}}"]).await {
                    Ok(version) => {
                        checks.push(HealthCheck {
                            name: "Docker Service".to_string(),
                            description: "Docker daemon is running in WSL2".to_string(),
                            status: CheckStatus::Pass,
                            fix_action: None,
                            details: Some(format!("Server version: {}", version.trim())),
                        });
                    }
                    Err(_) => {
                        checks.push(HealthCheck {
                            name: "Docker Service".to_string(),
                            description: "Docker daemon is not running".to_string(),
                            status: CheckStatus::Fail,
                            fix_action: Some("start_docker".to_string()),
                            details: Some("Click Fix to start Docker in WSL2".to_string()),
                        });
                    }
                }
            }

            // Only show Docker Desktop if it's actually installed
            let dd = check_docker_desktop().await;
            if dd.details.is_some() {
                checks.push(dd);
            }

            // GPU check
            let gpu = check_nvidia_gpu().await;
            if gpu.details.is_some() { checks.push(gpu); }
        }
        _ => {}
    }

    // Environment is ready if a container runtime is available
    // Docker Desktop counts only if it's actually installed (has details)
    let ready = checks.iter().any(|c| {
        if c.name.contains("Runtime") && c.status == CheckStatus::Pass {
            return true;
        }
        if c.name == "Docker Desktop" && c.status == CheckStatus::Pass && c.details.is_some() {
            return true;
        }
        false
    });

    let suggested = if checks
        .iter()
        .any(|c| c.name == "Podman Runtime" && c.status == CheckStatus::Pass)
    {
        "podman"
    } else {
        "docker"
    };

    EnvironmentStatus {
        ready,
        platform,
        checks,
        suggested_runtime: suggested.to_string(),
    }
}

/// Run an automated fix action.
pub async fn run_fix(action: &str) -> anyhow::Result<String> {
    tracing::info!("run_fix (non-streaming): action={action}");
    match action {
        "install_podman_linux" => {
            // Detect package manager and install
            if let Ok(_) = run_cmd("apt", &["--version"]).await {
                let output =
                    run_cmd("sudo", &["apt", "install", "-y", "podman"]).await
                        .map_err(|e| anyhow::anyhow!(
                            "Failed to install Podman via apt.\n\n\
                             You can try installing manually by running:\n\
                             sudo apt install -y podman\n\n\
                             Error: {e}"
                        ))?;
                Ok(format!("Installed podman via apt:\n{output}"))
            } else if let Ok(_) = run_cmd("dnf", &["--version"]).await {
                let output =
                    run_cmd("sudo", &["dnf", "install", "-y", "podman"]).await
                        .map_err(|e| anyhow::anyhow!(
                            "Failed to install Podman via dnf.\n\n\
                             You can try installing manually by running:\n\
                             sudo dnf install -y podman\n\n\
                             Error: {e}"
                        ))?;
                Ok(format!("Installed podman via dnf:\n{output}"))
            } else if let Ok(_) = run_cmd("pacman", &["--version"]).await {
                let output =
                    run_cmd("sudo", &["pacman", "-S", "--noconfirm", "podman"]).await
                        .map_err(|e| anyhow::anyhow!(
                            "Failed to install Podman via pacman.\n\n\
                             You can try installing manually by running:\n\
                             sudo pacman -S podman\n\n\
                             Error: {e}"
                        ))?;
                Ok(format!("Installed podman via pacman:\n{output}"))
            } else {
                anyhow::bail!(
                    "Could not detect a supported package manager.\n\n\
                     Please install Podman manually for your distribution.\n\
                     See: https://podman.io/docs/installation#linux-distributions"
                )
            }
        }
        "install_docker_linux" => {
            let output = run_cmd("sh", &["-c", "curl -fsSL https://get.docker.com | sh"])
                .await
                .map_err(|e| anyhow::anyhow!(
                    "The Docker install script failed.\n\n\
                     You can try installing manually by running:\n\
                     curl -fsSL https://get.docker.com | sh\n\n\
                     Or see: https://docs.docker.com/engine/install/\n\n\
                     Error: {e}"
                ))?;
            Ok(format!("Docker installed:\n{output}"))
        }
        "start_docker" => {
            #[cfg(target_os = "windows")]
            {
                // On Windows, configure TCP listener and start Docker inside WSL2
                let _ = run_cmd("wsl", &["-u", "root", "--", "bash", "-c",
                    "mkdir -p /etc/systemd/system/docker.service.d && \
                     echo -e '[Service]\\nExecStart=\\nExecStart=/usr/bin/dockerd -H fd:// -H tcp://0.0.0.0:2375 --containerd=/run/containerd/containerd.sock' > /etc/systemd/system/docker.service.d/override.conf && \
                     systemctl daemon-reload 2>/dev/null; \
                     service docker start"
                ]).await
                    .map_err(|e| anyhow::anyhow!(
                        "Failed to start Docker in WSL2.\n\n\
                         Make sure Docker is installed in WSL2.\n\n\
                         Error: {e}"
                    ))?;
                Ok("Docker started in WSL2 with TCP listener.\n\nRestart Orca Desktop to connect.".to_string())
            }
            #[cfg(not(target_os = "windows"))]
            {
                let output = run_cmd("sudo", &["systemctl", "start", "docker"])
                    .await
                    .map_err(|e| anyhow::anyhow!(
                        "Failed to start the Docker daemon.\n\n\
                         Try running manually:\n\
                         sudo systemctl start docker\n\n\
                         If Docker is not installed, use the Install button above first.\n\n\
                         Error: {e}"
                    ))?;
                Ok(format!(
                    "Docker daemon started.{}",
                    if output.is_empty() {
                        String::new()
                    } else {
                        format!("\n{output}")
                    }
                ))
            }
        }
        "start_podman" => {
            // Try rootless socket first, fall back to root
            let output = run_cmd("systemctl", &["--user", "start", "podman.socket"]).await;
            match output {
                Ok(out) => Ok(format!(
                    "Podman socket started (rootless).{}",
                    if out.is_empty() { String::new() } else { format!("\n{out}") }
                )),
                Err(_) => {
                    let out = run_cmd("sudo", &["systemctl", "start", "podman.socket"])
                        .await
                        .map_err(|e| anyhow::anyhow!(
                            "Failed to start the Podman socket.\n\n\
                             Try running manually:\n\
                             systemctl --user start podman.socket\n\
                             or: sudo systemctl start podman.socket\n\n\
                             If Podman is not installed, use the Install button above first.\n\n\
                             Error: {e}"
                        ))?;
                    Ok(format!(
                        "Podman socket started (root).{}",
                        if out.is_empty() { String::new() } else { format!("\n{out}") }
                    ))
                }
            }
        }
        "add_docker_group" => {
            let user = std::env::var("USER").unwrap_or_else(|_| "unknown".to_string());
            let output = run_cmd("sudo", &["usermod", "-aG", "docker", &user])
                .await
                .map_err(|e| anyhow::anyhow!(
                    "Failed to add your user to the docker group.\n\n\
                     Try running manually:\n\
                     sudo usermod -aG docker {user}\n\n\
                     Then log out and back in for the change to take effect.\n\n\
                     Error: {e}"
                ))?;
            Ok(format!(
                "Added {user} to docker group.\n\n\
                 Important: You need to log out and back in (or restart) for this to take effect.{}",
                if output.is_empty() { String::new() } else { format!("\n{output}") }
            ))
        }
        "install_docker" => {
            // On Windows: install Docker inside the default WSL2 distro
            #[cfg(target_os = "windows")]
            {
                // Collect diagnostics so we can debug issues
                let mut log = String::new();

                // Check WSL version
                log.push_str(">>> Checking WSL status...\n");
                match run_cmd("wsl", &["--version"]).await {
                    Ok(v) => log.push_str(&format!("{v}\n")),
                    Err(e) => log.push_str(&format!("wsl --version failed: {e}\n")),
                }

                // List distros for diagnostics
                log.push_str("\n>>> Listing WSL distros...\n");
                match run_cmd("wsl", &["--list", "--verbose"]).await {
                    Ok(v) => log.push_str(&format!("{v}\n")),
                    Err(e) => log.push_str(&format!("wsl --list failed: {e}\n")),
                }

                // Use the default WSL distro (no -d flag) to avoid UTF-16 distro name issues.
                // First verify WSL can run a simple command.
                log.push_str("\n>>> Probing WSL...\n");
                let probe = run_cmd("wsl", &["-u", "root", "--", "echo", "wsl-ok"]).await
                    .map_err(|e| anyhow::anyhow!(
                        "No WSL2 Linux distribution found.\n\n\
                         To install Docker on Windows, Orca needs a Linux environment via WSL2.\n\n\
                         How to set up WSL2:\n\
                         1. Open the Microsoft Store app\n\
                         2. Search for \"Ubuntu\" and click Install\n\
                         3. Launch Ubuntu once to complete setup (create a username and password)\n\
                         4. Come back here and click Install again\n\n\
                         Alternatively, run this in PowerShell (as Administrator):\n\
                         wsl --install -d Ubuntu\n\n\
                         Error details: {e}"
                    ))?;

                log.push_str(&format!("Probe result: '{}'\n", probe));

                if !probe.contains("wsl-ok") {
                    anyhow::bail!(
                        "{log}\n\
                         WSL2 is installed but no Linux distribution is configured.\n\n\
                         Please install a Linux distribution:\n\
                         1. Open the Microsoft Store app\n\
                         2. Search for \"Ubuntu\" and click Install\n\
                         3. Launch Ubuntu once to complete setup (create a username and password)\n\
                         4. Come back here and click Install again"
                    );
                }

                // Check if Docker is already installed
                log.push_str("\n>>> Checking if Docker is already installed in WSL...\n");
                match run_cmd("wsl", &["-u", "root", "--", "docker", "--version"]).await {
                    Ok(v) => {
                        log.push_str(&format!("Docker already installed: {v}\n"));
                        log.push_str("\n>>> Checking if Docker daemon is running...\n");
                        match run_cmd("wsl", &["-u", "root", "--", "docker", "info"]).await {
                            Ok(info) => {
                                log.push_str("Docker daemon is running.\n");
                                log.push_str(&format!("{}\n", info.lines().take(5).collect::<Vec<_>>().join("\n")));
                                return Ok(format!("{log}\nDocker is already installed and running."));
                            }
                            Err(_) => {
                                log.push_str("Docker daemon is not running.\n");
                                // Ensure TCP listener is configured
                                log.push_str("Configuring TCP listener...\n");
                                let _ = run_cmd("wsl", &["-u", "root", "--", "bash", "-c",
                                    "mkdir -p /etc/systemd/system/docker.service.d && \
                                     echo -e '[Service]\\nExecStart=\\nExecStart=/usr/bin/dockerd -H fd:// -H tcp://0.0.0.0:2375 --containerd=/run/containerd/containerd.sock' > /etc/systemd/system/docker.service.d/override.conf && \
                                     systemctl daemon-reload 2>/dev/null"
                                ]).await;
                                log.push_str("Restarting Docker with TCP listener...\n");
                                match run_cmd("wsl", &["-u", "root", "--", "service", "docker", "restart"]).await {
                                    Ok(o) => log.push_str(&format!("{o}\n")),
                                    Err(e) => log.push_str(&format!("Failed to restart: {e}\n")),
                                }
                                // Verify
                                match run_cmd("wsl", &["-u", "root", "--", "docker", "--version"]).await {
                                    Ok(v) => return Ok(format!("{log}\nDocker started: {v}")),
                                    Err(e) => log.push_str(&format!("Still not working: {e}\n")),
                                }
                            }
                        }
                    }
                    Err(_) => log.push_str("Docker not installed yet.\n"),
                }

                // Install Docker using the official convenience script, running as root.
                log.push_str("\n>>> Stopping any existing Docker service...\n");
                let _ = run_cmd("wsl", &["-u", "root", "--", "service", "docker", "stop"]).await;
                let _ = run_cmd("wsl", &["-u", "root", "--", "bash", "-c", "pkill dockerd 2>/dev/null || true"]).await;

                log.push_str(">>> Downloading Docker install script...\n");
                match run_cmd("wsl", &["-u", "root", "--", "bash", "-c",
                    "curl -fsSL https://get.docker.com -o /tmp/get-docker.sh 2>&1 && echo 'Download OK' || echo 'Download FAILED'"
                ]).await {
                    Ok(o) => log.push_str(&format!("{o}\n")),
                    Err(e) => {
                        log.push_str(&format!("Download failed: {e}\n"));
                        anyhow::bail!("{log}\n\nFailed to download Docker install script. Check your internet connection.");
                    }
                }

                log.push_str("\n>>> Running install script (this takes a while)...\n");
                match run_cmd("wsl", &["-u", "root", "--", "bash", "-c",
                    "sh /tmp/get-docker.sh 2>&1"
                ]).await {
                    Ok(o) => log.push_str(&format!("{o}\n")),
                    Err(e) => {
                        log.push_str(&format!("Install script failed: {e}\n"));
                        anyhow::bail!(
                            "{log}\n\n\
                             Docker install script failed.\n\n\
                             You can try installing manually:\n\
                             1. Open Ubuntu from the Start menu\n\
                             2. Run: curl -fsSL https://get.docker.com | sudo sh"
                        );
                    }
                }

                log.push_str("\n>>> Adding user to docker group...\n");
                let _ = run_cmd("wsl", &["-u", "root", "--", "bash", "-c",
                    "DEFAULT_USER=$(getent passwd 1000 | cut -d: -f1) && usermod -aG docker \"$DEFAULT_USER\" 2>&1 && echo \"Added $DEFAULT_USER to docker group\""
                ]).await.map(|o| log.push_str(&format!("{o}\n")));

                // Configure Docker to also listen on TCP so orca-daemon on
                // the Windows host can connect to it
                log.push_str("\n>>> Configuring Docker TCP listener for Orca...\n");
                let _ = run_cmd("wsl", &["-u", "root", "--", "bash", "-c",
                    "mkdir -p /etc/systemd/system/docker.service.d && \
                     echo -e '[Service]\\nExecStart=\\nExecStart=/usr/bin/dockerd -H fd:// -H tcp://0.0.0.0:2375 --containerd=/run/containerd/containerd.sock' > /etc/systemd/system/docker.service.d/override.conf && \
                     systemctl daemon-reload 2>/dev/null; \
                     echo 'TCP listener configured on port 2375'"
                ]).await.map(|o| log.push_str(&format!("{o}\n")));

                log.push_str("\n>>> Starting Docker service...\n");
                match run_cmd("wsl", &["-u", "root", "--", "service", "docker", "start"]).await {
                    Ok(o) => log.push_str(&format!("{o}\n")),
                    Err(e) => log.push_str(&format!("Failed to start Docker: {e}\n")),
                }

                log.push_str("\n>>> Verifying installation...\n");
                match run_cmd("wsl", &["-u", "root", "--", "docker", "--version"]).await {
                    Ok(v) => {
                        log.push_str(&format!("{v}\n"));
                        log.push_str(">>> Docker installed and started successfully\n");
                    }
                    Err(e) => {
                        log.push_str(&format!("Verification failed: {e}\n"));
                        log.push_str("Docker may have installed but the daemon may not have started.\n");
                    }
                }

                Ok(log)
            }
            #[cfg(not(target_os = "windows"))]
            {
                let output = run_cmd("bash", &["-c", "curl -fsSL https://get.docker.com | sh"])
                    .await
                    .map_err(|e| anyhow::anyhow!(
                        "The Docker install script failed.\n\n\
                         You can try installing manually:\n\
                         curl -fsSL https://get.docker.com | sh\n\n\
                         Or see: https://docs.docker.com/engine/install/\n\n\
                         Error: {e}"
                    ))?;
                Ok(format!("Docker installed:\n{output}"))
            }
        }
        "install_brew" => {
            let output = run_cmd("bash", &["-c", "/bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""])
                .await
                .map_err(|e| anyhow::anyhow!(
                    "Homebrew installation failed.\n\n\
                     You can try installing manually by opening Terminal and running:\n\
                     /bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"\n\n\
                     See: https://brew.sh\n\n\
                     Error: {e}"
                ))?;
            Ok(format!("Homebrew installed:\n{output}"))
        }
        "install_lima" => {
            let output = run_cmd("brew", &["install", "lima"])
                .await
                .map_err(|e| anyhow::anyhow!(
                    "Failed to install Lima via Homebrew.\n\n\
                     You can try installing manually by running:\n\
                     brew install lima\n\n\
                     Make sure Homebrew is installed first (see https://brew.sh).\n\n\
                     Error: {e}"
                ))?;
            Ok(format!("Lima installed:\n{output}"))
        }
        "enable_wsl2" => {
            let output = run_cmd("wsl", &["--install"])
                .await
                .map_err(|e| anyhow::anyhow!(
                    "Failed to enable WSL2.\n\n\
                     You can try enabling it manually:\n\
                     1. Open PowerShell as Administrator\n\
                     2. Run: wsl --install\n\
                     3. Restart your computer when prompted\n\n\
                     See: https://learn.microsoft.com/en-us/windows/wsl/install\n\n\
                     Error: {e}"
                ))?;
            Ok(format!(
                "WSL2 installation initiated.\n\n\
                 Important: You may need to restart your computer to complete the setup.\n\
                 After restarting, open the Microsoft Store and install Ubuntu if you haven't already.\n\
                 {output}"
            ))
        }
        "install_nvidia_toolkit" => {
            #[cfg(target_os = "windows")]
            let output = run_cmd("wsl", &["-u", "root", "--", "bash", "-c",
                "curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg 2>/dev/null && \
                 curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | tee /etc/apt/sources.list.d/nvidia-container-toolkit.list > /dev/null && \
                 apt-get update && apt-get install -y nvidia-container-toolkit && \
                 nvidia-ctk runtime configure --runtime=docker && \
                 systemctl restart docker"
            ]).await.map_err(|e| anyhow::anyhow!("NVIDIA Container Toolkit install failed: {e}"))?;

            #[cfg(not(target_os = "windows"))]
            let output = run_cmd("bash", &["-c",
                "curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg 2>/dev/null && \
                 curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list > /dev/null && \
                 sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit && \
                 sudo nvidia-ctk runtime configure --runtime=docker && \
                 sudo systemctl restart docker"
            ]).await.map_err(|e| anyhow::anyhow!("NVIDIA Container Toolkit install failed: {e}"))?;

            Ok(format!("NVIDIA Container Toolkit installed!\n\nRestart any running Ollama containers to use GPU.\n\n{output}"))
        }
        "install_helm" => {
            #[cfg(target_os = "windows")]
            let output = run_cmd("wsl", &["-u", "root", "--", "bash", "-c",
                "curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash"
            ]).await.map_err(|e| anyhow::anyhow!("Helm install failed: {e}"))?;

            #[cfg(not(target_os = "windows"))]
            let output = run_cmd("bash", &["-c",
                "curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | sudo bash"
            ]).await.map_err(|e| anyhow::anyhow!("Helm install failed: {e}"))?;

            Ok(format!("Helm installed!\n\n{output}"))
        }
        // Long-running setup actions — these should use the SSE streaming endpoint.
        // If we reach here it means streaming failed; run the core steps directly.
        "setup_docker_macos" => {
            let mut output = String::new();
            output.push_str(">>> Setting up Docker on macOS via Lima\n\n");

            // Check/install Homebrew
            if run_cmd("brew", &["--version"]).await.is_err() {
                output.push_str("Installing Homebrew...\n");
                let _ = run_cmd("sh", &["-c", "/bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""]).await
                    .map_err(|e| { output.push_str(&format!("Homebrew install failed: {e}\n")); })
                    .ok();
            } else {
                output.push_str("Homebrew: installed\n");
            }

            // Install Lima + Docker CLI + Docker Compose + Buildx
            let lima_ok = run_cmd("limactl", &["--version"]).await.is_ok();
            let docker_ok = run_cmd("docker", &["--version"]).await.is_ok();
            let compose_ok = run_cmd("docker", &["compose", "version"]).await.is_ok();
            let buildx_ok = run_cmd("docker", &["buildx", "version"]).await.is_ok();
            {
                let mut pkgs: Vec<&str> = Vec::new();
                if !lima_ok { pkgs.push("lima"); }
                if !docker_ok { pkgs.push("docker"); }
                if !compose_ok { pkgs.push("docker-compose"); }
                if !buildx_ok { pkgs.push("docker-buildx"); }
                if pkgs.is_empty() {
                    output.push_str("Lima, Docker CLI, Compose, and Buildx: installed\n");
                } else {
                    output.push_str(&format!("Installing {}...\n", pkgs.join(", ")));
                    match run_cmd("brew", &[&["install"][..], &pkgs].concat()).await {
                        Ok(o) => output.push_str(&format!("{o}\n")),
                        Err(e) => output.push_str(&format!("brew install failed: {e}\n")),
                    }
                    // Link docker-compose as CLI plugin
                    if !compose_ok {
                        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
                        let plugins_dir = format!("{home}/.docker/cli-plugins");
                        let _ = std::fs::create_dir_all(&plugins_dir);
                        if let Ok(prefix) = run_cmd("brew", &["--prefix", "docker-compose"]).await {
                            let bin = format!("{}/bin/docker-compose", prefix.trim());
                            let link = format!("{plugins_dir}/docker-compose");
                            let _ = std::fs::remove_file(&link);
                            #[cfg(unix)]
                            let _ = std::os::unix::fs::symlink(&bin, &link);
                        }
                    }
                    // Link docker-buildx as CLI plugin
                    if !buildx_ok {
                        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
                        let plugins_dir = format!("{home}/.docker/cli-plugins");
                        let _ = std::fs::create_dir_all(&plugins_dir);
                        if let Ok(prefix) = run_cmd("brew", &["--prefix", "docker-buildx"]).await {
                            let bin = format!("{}/bin/docker-buildx", prefix.trim());
                            let link = format!("{plugins_dir}/docker-buildx");
                            let _ = std::fs::remove_file(&link);
                            #[cfg(unix)]
                            let _ = std::os::unix::fs::symlink(&bin, &link);
                        }
                    }
                }
            }

            // Create/start Lima VM
            let vms = run_cmd("limactl", &["list", "--format", "{{.Name}}"]).await.unwrap_or_default();
            let vm_name = if vms.lines().any(|l| l.trim() == "orca") { "orca" }
                else if vms.lines().any(|l| l.trim() == "docker") { "docker" }
                else { "orca" };
            if !vms.lines().any(|l| l.trim() == "orca" || l.trim() == "docker" || l.trim() == "default") {
                output.push_str("Creating Lima VM 'orca'...\n");
                match run_cmd("limactl", &["create", "--name=orca", "--vm-type=vz", "--rosetta", "--mount-writable", "--mount-type=virtiofs",
                    "--memory=8", "--cpus=4",
                    "--set", r#".portForwards += [{"guestIP": "0.0.0.0", "guestIPMustBeZero": true, "guestPortRange": [1, 65535], "hostIP": "127.0.0.1", "proto": "tcp"}]"#,
                    "--set", r#".mounts += [{"location": "/Volumes", "writable": true}, {"location": "/private", "writable": true}]"#,
                    "--set", r##".provision += [{"mode": "system", "script": "#!/bin/bash\nset -eu\n# Install HWE kernel for idmapped mount support (6.12+)\nif ! dpkg -l linux-generic-hwe-24.04 2>/dev/null | grep -q ^ii; then\n  apt-get update -qq && apt-get install -y -qq linux-generic-hwe-24.04\nfi\n"}]"##,
                    "template:docker"]).await {
                    Ok(_) => output.push_str("VM created.\n"),
                    Err(e) => output.push_str(&format!("VM creation failed: {e}\n")),
                }
            }

            output.push_str(&format!("Starting Lima VM '{vm_name}'...\n"));
            let _ = run_cmd("limactl", &["start", vm_name]).await;

            // Verify
            match run_cmd("docker", &["info", "--format", "{{.ServerVersion}}"]).await {
                Ok(v) => output.push_str(&format!("\nDocker {} is ready!\n", v.trim())),
                Err(_) => output.push_str("\nDocker may still be starting. Restart Orca in a moment.\n"),
            }

            Ok(output)
        }
        _ => anyhow::bail!("Unknown fix action: {action}"),
    }
}

// ==================== System Health ====================

/// Check if Docker/Podman is currently reachable.
pub async fn check_docker_connection() -> bool {
    // First try via the extended PATH
    let cli = detect_cli().await;
    let mut cmd = Command::new(cli);
    cmd.args(["info"])
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let path = extended_path();
    cmd.env("PATH", &path);

    if cmd.status().await.is_ok_and(|s| s.success()) {
        return true;
    }

    // On Windows, try Docker via WSL
    #[cfg(target_os = "windows")]
    {
        if Command::new("wsl")
            .args(["-u", "root", "--", "docker", "info"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .is_ok_and(|s| s.success())
        {
            return true;
        }
    }

    // Fallback: try connecting directly to the Docker socket
    let sock = std::path::Path::new("/var/run/docker.sock");
    if sock.exists() {
        return true;
    }

    // Check macOS Docker Desktop socket
    if let Some(home) = dirs::home_dir() {
        let desktop_sock = home.join(".docker/run/docker.sock");
        if desktop_sock.exists() {
            return true;
        }
    }

    false
}

/// JSON shape returned by `docker system df --format '{{json .}}'`.
#[derive(SerdeDeserialize)]
#[serde(rename_all = "PascalCase")]
struct DockerDfRow {
    #[serde(rename = "Type")]
    type_name: String,
    size: String,
    reclaimable: String,
}

/// Parse a Docker human-readable size string (e.g. "1.234GB", "45.6kB") into bytes.
fn parse_docker_size(s: &str) -> u64 {
    let s = s.trim();
    // Find where the numeric part ends and the unit begins
    let (num_str, unit) = match s.find(|c: char| c.is_alphabetic()) {
        Some(idx) => (&s[..idx], s[idx..].to_uppercase()),
        None => return s.parse::<u64>().unwrap_or(0),
    };
    let num: f64 = num_str.parse().unwrap_or(0.0);
    let multiplier: f64 = match unit.as_str() {
        "B" => 1.0,
        "KB" => 1_000.0,
        "MB" => 1_000_000.0,
        "GB" => 1_000_000_000.0,
        "TB" => 1_000_000_000_000.0,
        "KIB" => 1_024.0,
        "MIB" => 1_048_576.0,
        "GIB" => 1_073_741_824.0,
        "TIB" => 1_099_511_627_776.0,
        _ => 1.0,
    };
    (num * multiplier) as u64
}

/// Parse reclaimable string like "1.234GB (45%)" — extract just the size portion.
fn parse_reclaimable_size(s: &str) -> u64 {
    // Strip any parenthesized percentage at the end
    let size_part = if let Some(idx) = s.find('(') {
        s[..idx].trim()
    } else {
        s.trim()
    };
    parse_docker_size(size_part)
}

/// Get Docker/Podman disk usage (system df).
pub async fn get_disk_usage() -> Option<DiskUsage> {
    let cli = detect_cli().await;
    let output = Command::new(cli)
        .args(["system", "df", "--format", "{{json .}}"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .await
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut images_size: u64 = 0;
    let mut containers_size: u64 = 0;
    let mut volumes_size: u64 = 0;
    let mut build_cache_size: u64 = 0;
    let mut total_reclaimable: u64 = 0;

    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(row) = serde_json::from_str::<DockerDfRow>(line) {
            let size = parse_docker_size(&row.size);
            let reclaimable = parse_reclaimable_size(&row.reclaimable);
            match row.type_name.as_str() {
                "Images" => images_size = size,
                "Containers" => containers_size = size,
                "Volumes" | "Local Volumes" => volumes_size = size,
                "Build Cache" => build_cache_size = size,
                _ => {}
            }
            total_reclaimable += reclaimable;
        }
    }

    let total = images_size + containers_size + volumes_size + build_cache_size;

    Some(DiskUsage {
        images_size_bytes: images_size,
        containers_size_bytes: containers_size,
        volumes_size_bytes: volumes_size,
        build_cache_size_bytes: build_cache_size,
        total_size_bytes: total,
        reclaimable_bytes: total_reclaimable,
    })
}

/// Parse a value in kB from /proc/meminfo.
fn parse_meminfo_kb(meminfo: &str, key: &str) -> Option<u64> {
    for line in meminfo.lines() {
        if line.starts_with(key) {
            // Format: "MemTotal:       16384000 kB"
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 2 {
                return parts[1].parse::<u64>().ok();
            }
        }
    }
    None
}

/// Get system resource info.
pub async fn get_system_resources() -> Option<SystemResources> {
    let cpu_count = std::thread::available_parallelism()
        .map(|p| p.get() as u32)
        .unwrap_or(1);

    // Memory from /proc/meminfo (Linux)
    let (memory_total, memory_available) = if cfg!(target_os = "linux") {
        if let Ok(meminfo) = std::fs::read_to_string("/proc/meminfo") {
            let total = parse_meminfo_kb(&meminfo, "MemTotal:")
                .map(|kb| kb * 1024)
                .unwrap_or(0);
            let available = parse_meminfo_kb(&meminfo, "MemAvailable:")
                .map(|kb| kb * 1024)
                .unwrap_or(0);
            (total, available)
        } else {
            (0, 0)
        }
    } else if cfg!(target_os = "macos") {
        // macOS: use sysctl for memory
        let total = match run_cmd("sysctl", &["-n", "hw.memsize"]).await {
            Ok(s) => s.trim().parse::<u64>().unwrap_or(0),
            Err(_) => 0,
        };
        // Get page size and free pages for available memory
        let available = match run_cmd("vm_stat", &[]).await {
            Ok(output) => {
                let page_size = 16384u64; // default on Apple Silicon
                let free_pages = output.lines()
                    .find(|l| l.contains("Pages free"))
                    .and_then(|l| l.split_whitespace().last())
                    .and_then(|s| s.trim_end_matches('.').parse::<u64>().ok())
                    .unwrap_or(0);
                let inactive_pages = output.lines()
                    .find(|l| l.contains("Pages inactive"))
                    .and_then(|l| l.split_whitespace().last())
                    .and_then(|s| s.trim_end_matches('.').parse::<u64>().ok())
                    .unwrap_or(0);
                (free_pages + inactive_pages) * page_size
            }
            Err(_) => total / 2, // rough fallback
        };
        (total, available)
    } else if cfg!(target_os = "windows") {
        // Windows: use PowerShell to query OS memory info
        match run_cmd("powershell", &["-NoProfile", "-Command",
            "Get-CimInstance Win32_OperatingSystem | ForEach-Object { \"$($_.TotalVisibleMemorySize) $($_.FreePhysicalMemory)\" }"
        ]).await {
            Ok(output) => {
                let parts: Vec<&str> = output.trim().split_whitespace().collect();
                if parts.len() >= 2 {
                    let total_kb = parts[0].parse::<u64>().unwrap_or(0);
                    let free_kb = parts[1].parse::<u64>().unwrap_or(0);
                    (total_kb * 1024, free_kb * 1024)
                } else {
                    (0, 0)
                }
            }
            Err(_) => (0, 0),
        }
    } else {
        (0, 0)
    };

    // Disk usage
    let (disk_total, disk_free) = if cfg!(target_os = "windows") {
        // Windows: use PowerShell to get disk info for C:
        match run_cmd("powershell", &["-NoProfile", "-Command",
            "Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='C:'\" | ForEach-Object { \"$($_.Size) $($_.FreeSpace)\" }"
        ]).await {
            Ok(output) => {
                let parts: Vec<&str> = output.trim().split_whitespace().collect();
                if parts.len() >= 2 {
                    let total = parts[0].parse::<u64>().unwrap_or(0);
                    let free = parts[1].parse::<u64>().unwrap_or(0);
                    (total, free)
                } else {
                    (0, 0)
                }
            }
            Err(_) => (0, 0),
        }
    } else {
        // Linux/macOS: use df -k
        match run_cmd("df", &["-k", "/"]).await {
        Ok(output) => {
            let mut total = 0u64;
            let mut free = 0u64;
            for (i, line) in output.lines().enumerate() {
                if i == 0 { continue; }
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 4 {
                    total = parts[1].parse::<u64>().unwrap_or(0) * 1024; // KB to bytes
                    free = parts[3].parse::<u64>().unwrap_or(0) * 1024;
                }
                break;
            }
            (total, free)
        }
        Err(_) => (0, 0),
    }
    };

    let disk_usage_percent = if disk_total > 0 {
        ((disk_total - disk_free) as f64 / disk_total as f64) * 100.0
    } else {
        0.0
    };

    Some(SystemResources {
        cpu_count,
        memory_total_bytes: memory_total,
        memory_available_bytes: memory_available,
        disk_total_bytes: disk_total,
        disk_free_bytes: disk_free,
        disk_usage_percent,
    })
}

/// Full system health check.
pub async fn check_system_health() -> SystemHealth {
    let connected = check_docker_connection().await;

    let cli = detect_cli().await;
    let version = if connected {
        // Try CLI first, then fall back to docker version without format (macOS compat)
        run_cmd(cli, &["version", "--format", "{{.Server.Version}}"])
            .await
            .ok()
            .or_else(|| {
                // On macOS, the CLI might not be in PATH even though docker is running.
                // Try to extract version from the socket connection later (via bollard in daemon).
                None
            })
    } else {
        None
    };

    let disk = if connected {
        get_disk_usage().await
    } else {
        None
    };

    let resources = get_system_resources().await;

    let mut warnings = Vec::new();
    if !connected {
        warnings.push(format!("{} is not running or not reachable", if cli == "podman" { "Podman" } else { "Docker" }));
    }
    if let Some(ref res) = resources {
        if res.disk_usage_percent > 90.0 {
            warnings.push("Disk usage is above 90% — consider pruning images".to_string());
        }
        if res.memory_available_bytes < 512 * 1024 * 1024 {
            warnings.push("Less than 512MB memory available".to_string());
        }
    }
    if let Some(ref du) = disk {
        if du.reclaimable_bytes > 5 * 1024 * 1024 * 1024 {
            let gb = du.reclaimable_bytes / (1024 * 1024 * 1024);
            warnings.push(format!(
                "{gb}GB of Docker storage is reclaimable — consider pruning"
            ));
        }
    }

    // GPU info (if NVIDIA GPU available)
    let gpu = get_gpu_info().await;

    SystemHealth {
        docker_connected: connected,
        docker_version: version,
        disk_usage: disk,
        system_resources: resources,
        warnings,
        gpu,
        os: None,
        arch: None,
    }
}

async fn get_gpu_info() -> Option<GpuInfo> {
    let output = if cfg!(target_os = "windows") {
        run_cmd("wsl", &["-u", "root", "--", "nvidia-smi",
            "--query-gpu=name,memory.used,memory.total,utilization.gpu",
            "--format=csv,noheader,nounits"]).await
    } else {
        run_cmd("nvidia-smi", &[
            "--query-gpu=name,memory.used,memory.total,utilization.gpu",
            "--format=csv,noheader,nounits"]).await
    };

    let text = output.ok()?;
    let parts: Vec<&str> = text.trim().split(", ").collect();
    if parts.len() >= 4 {
        Some(GpuInfo {
            name: parts[0].trim().to_string(),
            memory_used_mb: parts[1].trim().parse().unwrap_or(0),
            memory_total_mb: parts[2].trim().parse().unwrap_or(0),
            utilization_percent: parts[3].trim().parse().unwrap_or(0),
        })
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extended_path_includes_homebrew() {
        let path = extended_path();
        assert!(
            path.contains("/opt/homebrew/bin"),
            "extended_path should include /opt/homebrew/bin, got: {}",
            path
        );
    }

    #[test]
    fn detect_platform_returns_valid() {
        let platform = detect_platform();
        assert!(
            ["linux", "macos", "windows", "unknown"].contains(&platform.as_str()),
            "detect_platform should return a known platform, got: {}",
            platform
        );
    }

    #[test]
    fn parse_docker_size_various_units() {
        assert_eq!(parse_docker_size("0B"), 0);
        assert_eq!(parse_docker_size("100B"), 100);
        assert_eq!(parse_docker_size("1KB"), 1_000);
        assert_eq!(parse_docker_size("1.5MB"), 1_500_000);
        assert_eq!(parse_docker_size("2GB"), 2_000_000_000);
        assert_eq!(parse_docker_size("1KIB"), 1_024);
    }

    #[test]
    fn parse_reclaimable_size_with_percentage() {
        assert_eq!(parse_reclaimable_size("1.234GB (45%)"), 1_234_000_000);
        assert_eq!(parse_reclaimable_size("0B"), 0);
    }

    #[test]
    fn parse_meminfo_kb_extracts_value() {
        let meminfo = "MemTotal:       16384000 kB\nMemFree:         1234567 kB\nMemAvailable:   8000000 kB\n";
        assert_eq!(parse_meminfo_kb(meminfo, "MemTotal:"), Some(16384000));
        assert_eq!(parse_meminfo_kb(meminfo, "MemAvailable:"), Some(8000000));
        assert_eq!(parse_meminfo_kb(meminfo, "SwapTotal:"), None);
    }
}
