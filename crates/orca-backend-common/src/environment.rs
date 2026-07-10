use orca_core::environment::*;
use serde::Deserialize as SerdeDeserialize;
use std::process::Stdio;
use tokio::process::Command;
use tokio::sync::OnceCell;

/// Cached container CLI detection result.
static CLI_CELL: OnceCell<&'static str> = OnceCell::const_new();

/// Detect the container CLI command — prefers docker, falls back to podman.
/// The result is cached after the first call.
fn extended_path() -> String {
    let current = std::env::var("PATH").unwrap_or_default();
    format!("/usr/local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/sbin:{current}")
}

/// Minimum Lima version Orca's macOS setup is verified against. Lima 2.0
/// (released 2025-11-06) is the first release whose VZ + usernet SSH bring-up
/// we've confirmed works with our `limactl create` config; older 1.x can hang
/// at "Waiting for port …:22" forever. Bumping this is a deliberate, tested
/// release decision — keep it a compiled-in constant, not runtime config, so
/// it can't drift from the code that actually drives Lima.
const MIN_LIMA: (u32, u32, u32) = (2, 0, 0);

/// Generation of Orca's Lima VM definition. Bump whenever the VM's base image
/// or host↔guest transport changes in a way an existing VM can't acquire
/// without a rebuild. Stamped into a host-side marker on create; on reuse a VM
/// whose marker is missing or lower than this is offered an upgrade-Recreate
/// (works even when the VM is unreachable — it's a host-side file, not a guest
/// probe), and this auto-covers every future base change too.
/// - Gen 1: pre-vsock Ubuntu 24.04 (HWE-kernel hack, gvisor *usernet IP* path —
///   breaks under a mesh VPN like NetBird/Tailscale).
/// - Gen 2: Ubuntu 26.04 LTS + vsock SSH (VPN-immune AF_VSOCK transport).
const ORCA_VM_GENERATION: u32 = 2;

/// Parse `limactl --version` output (e.g. "limactl version 2.0.0") into a
/// (major, minor, patch) tuple. Tolerates a leading `v` and pre-release
/// suffixes ("2.1.0-rc.1" → (2,1,0)). Returns None if no dotted version found.
fn parse_lima_version(s: &str) -> Option<(u32, u32, u32)> {
    for tok in s.split_whitespace() {
        let t = tok.trim_start_matches('v');
        let mut parts = t.split('.');
        let (Some(a), Some(b)) = (parts.next(), parts.next()) else {
            continue;
        };
        let (Ok(major), Ok(minor)) = (a.parse::<u32>(), b.parse::<u32>()) else {
            continue;
        };
        // Patch may carry a suffix ("0-rc1") or be absent entirely.
        let patch = parts
            .next()
            .and_then(|p| p.split(|c: char| !c.is_ascii_digit()).next())
            .and_then(|p| p.parse::<u32>().ok())
            .unwrap_or(0);
        return Some((major, minor, patch));
    }
    None
}

/// Path to the marker file recording which Lima version created an instance.
/// Co-located inside the instance dir so it's deleted with the VM (and
/// re-stamped on recreate). Used to detect a stale VM built by an older Lima.
fn lima_marker_path(vm: &str) -> Option<std::path::PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(
        std::path::Path::new(&home)
            .join(".lima")
            .join(vm)
            .join("orca-created-by"),
    )
}

/// Path to the marker recording which Orca VM generation built an instance.
/// Co-located in the instance dir so it's deleted with the VM and re-stamped on
/// recreate. A missing marker means a pre-tracking (gen 1) VM.
fn lima_generation_path(vm: &str) -> Option<std::path::PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(
        std::path::Path::new(&home)
            .join(".lima")
            .join(vm)
            .join("orca-vm-generation"),
    )
}

/// Read the Orca VM generation stamped for `vm`. Returns 1 (the pre-tracking
/// base) when the marker is absent or unparseable, so an old VM is always
/// treated as upgradeable rather than silently assumed current.
fn lima_vm_generation(vm: &str) -> u32 {
    lima_generation_path(vm)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| s.trim().parse::<u32>().ok())
        .unwrap_or(1)
}

// ---- Orca's Lima VM `--set` overrides (shared by both `limactl create` sites
// so the config can't drift between them).

/// Forward all 127.0.0.1-bound guest ports to the host, matching Docker
/// Desktop's localhost behavior.
const ORCA_PORT_FORWARDS: &str = r#".portForwards += [{"guestIP": "0.0.0.0", "guestIPMustBeZero": true, "guestPortRange": [1, 65535], "hostIP": "127.0.0.1", "proto": "tcp"}]"#;

/// Bind-mount the host's /Volumes and /private into the guest (writable).
const ORCA_MOUNTS: &str =
    r#".mounts += [{"location": "/Volumes", "writable": true}, {"location": "/private", "writable": true}]"#;

/// Pin the guest to Ubuntu 26.04 LTS (one image per arch; Lima picks the host's).
/// Why this base: systemd 259 (>=256) lets Lima carry SSH + the docker-socket
/// forward over **AF_VSOCK** (`.ssh.overVsock`) — a hypervisor channel that an
/// IP-layer mesh VPN (NetBird/Tailscale/WireGuard) cannot intercept, unlike the
/// gvisor *usernet IP* path 24.04 was stuck on (24.04 = systemd 255, one short).
/// And kernel 7.0 has native idmapped overlayfs, so the old HWE-kernel apt
/// install (the source of the 0.46.9 boot hang) is no longer needed.
const ORCA_IMAGES: &str = r#".images = [{"location": "https://cloud-images.ubuntu.com/releases/resolute/release/ubuntu-26.04-server-cloudimg-arm64.img", "arch": "aarch64"}, {"location": "https://cloud-images.ubuntu.com/releases/resolute/release/ubuntu-26.04-server-cloudimg-amd64.img", "arch": "x86_64"}]"#;

/// Use vsock for SSH (and thus the docker-socket forward). Auto-engages on a
/// systemd-256+ guest; set explicitly to document intent and the VPN rationale.
const ORCA_SSH_OVER_VSOCK: &str = ".ssh.overVsock = true";

/// Path of the static usernet drop-in inside the guest.
const ORCA_SLIRP_NETWORK_PATH: &str = "/etc/systemd/network/05-orca-slirp.network";

/// Desired content of the static usernet drop-in — the **single source of truth**
/// for the guest's gvisor-slirp interface, shared by create-time provisioning
/// (`orca_provision_setarg`) and the daemon's live self-heal
/// (`orca_static_usernet_script` → `ensure_static_usernet`).
///
/// Why static: behind a mesh VPN (NetBird) the host's `/etc/resolv.conf` search
/// list is huge; Lima injects it verbatim into the guest's DHCP OFFER (option
/// 119; `gvproxy.go` reads it unconditionally — no size budget, no lima.yaml
/// knob, and the vz driver hard-codes MTU 1500 so it can't be widened). The
/// oversized OFFER fragments, the guest's raw-socket DHCP client never
/// reassembles it, `eth0` gets no IP, and Lima hangs on "Waiting for …:22" (a
/// host reboot masks it — the VM boots before the VPN — but a warm restart with
/// the VPN up hits it every time). Pinning the interface to Lima's OWN slirp
/// constants (guest .15, gateway .2, hostResolver DNS .3 — fixed in Lima's
/// `pkg/networks/const.go`, per-VM-private, so this collides with nothing)
/// removes DHCP from the boot path entirely.
///
/// **To change the guest network later:** edit this content and ship an Orca
/// update. `ensure_static_usernet` rewrites the file in place and bounces
/// networkd only when the content differs, so every existing VM converges on the
/// next daemon connect — no recreate. (networkd bounces are safe: the control
/// channel is AF_VSOCK, not IP.)
const ORCA_SLIRP_NETWORK: &str = "[Match]\nName=eth* en*\nType=ether\n\n[Network]\nDHCP=no\nAddress=192.168.5.15/24\nGateway=192.168.5.2\nDNS=192.168.5.3\nDNS=192.168.5.2\n";

/// SME-mask step (Apple M4/M5): VZ advertises SME/SME2 to guests but misexecutes
/// it, so SIMD libraries (libyuv in Chromium) pick SME paths and die with SIGILL
/// on every video. `arm64.nosme` forces a NEON fallback. Guarded on `grep sme`,
/// so it's a no-op elsewhere. Mirrors `ensure_sme_masked` and the reconcile patch.
const ORCA_SME_MASK_SCRIPT: &str = "if grep -qw sme /proc/cpuinfo && [ ! -f /etc/default/grub.d/99-orca-nosme.cfg ]; then\n  echo 'GRUB_CMDLINE_LINUX=\"$GRUB_CMDLINE_LINUX arm64.nosme\"' > /etc/default/grub.d/99-orca-nosme.cfg\n  update-grub\nfi\n";

/// Idempotent shell fragment that writes [`ORCA_SLIRP_NETWORK`] and bounces
/// networkd **only when the on-disk content changed** (so it's a no-op in steady
/// state, and re-applies automatically after a config change ships). Shared by
/// create-time provisioning and the daemon self-heal so the two can't drift.
pub fn orca_static_usernet_script() -> String {
    format!(
        "F={path}\nT=$(mktemp)\ncat > $T <<'ORCA_NET_EOF'\n{content}ORCA_NET_EOF\nif ! cmp -s $T $F; then\n  install -m 0644 $T $F\n  systemctl enable systemd-networkd >/dev/null 2>&1 || true\n  systemctl restart systemd-networkd >/dev/null 2>&1 || true\nfi\nrm -f $T\n",
        path = ORCA_SLIRP_NETWORK_PATH,
        content = ORCA_SLIRP_NETWORK,
    )
}

/// Full `mode: system` provision script: IPv4 forwarding + SME mask + static
/// usernet. Idempotent — Lima re-runs `system` provision on every boot, from the
/// local cidata mount in its own `boot.sh`, *before* and independent of guest
/// networking (so it still runs on the exact boot where DHCP is hung). Composed
/// from the shared pieces above so create-time and the daemon self-heals share
/// one definition.
fn orca_provision_script() -> String {
    format!(
        "#!/bin/bash\nset -eu\necho 'net.ipv4.ip_forward=1' > /etc/sysctl.d/99-orca-forward.conf\n{sme}{net}",
        sme = ORCA_SME_MASK_SCRIPT,
        net = orca_static_usernet_script(),
    )
}

/// The `limactl --set` expression that appends our provision to lima.yaml.
/// `serde_json` does the JSON string escaping, so [`orca_provision_script`] stays
/// readable (real newlines, no hand-escaped `\n`).
fn orca_provision_setarg() -> String {
    let v = serde_json::json!([{ "mode": "system", "script": orca_provision_script() }]);
    format!(".provision += {v}")
}

const BYTES_PER_GIB: u64 = 1024 * 1024 * 1024;

#[derive(Debug, Clone, Copy)]
pub struct LimaMemoryDefault {
    pub memory_gib: u32,
    pub host_memory_gib: Option<u32>,
}

/// Pick a first-run Lima VM size from the Mac's physical RAM.
///
/// The VM should be big enough for normal compose stacks, but small Macs must
/// keep enough memory for macOS and the GUI. Larger machines get a better
/// default than the old flat 8 GiB without making first launch surprisingly
/// greedy.
pub fn recommended_lima_memory_gib(host_memory_gib: u32) -> u32 {
    if host_memory_gib == 0 {
        return 8;
    }

    let half = (host_memory_gib / 2).clamp(4, 16);
    let leave_for_host = host_memory_gib.saturating_sub(2).max(2);
    half.min(leave_for_host)
}

fn bytes_to_gib_ceil(bytes: u64) -> Option<u32> {
    if bytes == 0 {
        return None;
    }
    Some(bytes.div_ceil(BYTES_PER_GIB).min(u32::MAX as u64) as u32)
}

pub async fn detect_lima_memory_default() -> LimaMemoryDefault {
    let host_memory_gib = run_cmd("sysctl", &["-n", "hw.memsize"])
        .await
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .and_then(bytes_to_gib_ceil);

    LimaMemoryDefault {
        memory_gib: host_memory_gib.map(recommended_lima_memory_gib).unwrap_or(8),
        host_memory_gib,
    }
}

fn describe_lima_memory_default(default: LimaMemoryDefault) -> String {
    match default.host_memory_gib {
        Some(host_memory_gib) => format!(
            "    VM memory: {} GiB (detected {} GiB on this Mac).\n",
            default.memory_gib, host_memory_gib
        ),
        None => format!(
            "    VM memory: {} GiB (could not detect host memory; using fallback).\n",
            default.memory_gib
        ),
    }
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

    // Track when the last output line was sent, for heartbeat
    let last_output = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let update_last = |ts: &std::sync::Arc<std::sync::atomic::AtomicU64>| {
        ts.store(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
            std::sync::atomic::Ordering::Relaxed,
        );
    };
    update_last(&last_output);

    // Read stdout and stderr concurrently, sending lines as they come
    let tx2 = tx.clone();
    let last2 = last_output.clone();
    let stdout_task = tokio::spawn(async move {
        if let Some(out) = stdout {
            let mut reader = BufReader::new(out).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                update_last(&last2);
                // Tee to the daemon log: the GUI stream is ephemeral, so this
                // is the only durable record of what limactl/apt actually did.
                tracing::info!(target: "fix_stream", "[out] {line}");
                let _ = tx2.send(line).await;
            }
        }
    });

    let tx3 = tx.clone();
    let last3 = last_output.clone();
    let stderr_task = tokio::spawn(async move {
        if let Some(err) = stderr {
            let mut reader = BufReader::new(err).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                update_last(&last3);
                tracing::info!(target: "fix_stream", "[err] {line}");
                let _ = tx3.send(line).await;
            }
        }
    });

    // Heartbeat: send a dot every 5 seconds if no output has been produced
    let tx_heartbeat = tx.clone();
    let last_hb = last_output.clone();
    let heartbeat = tokio::spawn(async move {
        let mut elapsed = 0u64;
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            elapsed += 5;
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            let last = last_hb.load(std::sync::atomic::Ordering::Relaxed);
            if now - last >= 4 {
                let msg = match elapsed {
                    0..=30 => "    ...".to_string(),
                    31..=60 => format!("    Still working... ({elapsed}s)"),
                    61..=120 => format!("    Still working... ({elapsed}s) — installing packages"),
                    _ => format!("    Still working... ({elapsed}s) — this can take a few minutes on first run"),
                };
                if tx_heartbeat.send(msg).await.is_err() {
                    break;
                }
            }
        }
    });

    // Overall timeout: 30 minutes. Install scripts can be long but should
    // never hang indefinitely; bound the wait so a stuck subprocess can't
    // pin this task forever.
    const OVERALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(1800);
    let drain = async {
        let _ = stdout_task.await;
        let _ = stderr_task.await;
    };
    if tokio::time::timeout(OVERALL_TIMEOUT, drain).await.is_err() {
        heartbeat.abort();
        let _ = child.start_kill();
        return Err(format!("command timed out after {}s", OVERALL_TIMEOUT.as_secs()));
    }
    heartbeat.abort();

    let status = child.wait().await.map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("exit code {}", status.code().unwrap_or(-1)))
    }
}

/// Run a fix action with streaming output to a sender.
pub async fn run_fix_streaming(action: &str, tx: tokio::sync::mpsc::Sender<String>) -> anyhow::Result<()> {
    let send = |msg: String| {
        let tx = tx.clone();
        async move {
            let _ = tx.send(msg).await;
        }
    };

    tracing::info!("run_fix_streaming: action={action}");
    match action {
        "install_docker" => {
            #[cfg(target_os = "windows")]
            {
                send(">>> Checking WSL status...".into()).await;
                if let Ok(v) = run_cmd("wsl", &["--version"]).await {
                    for line in v.lines() {
                        send(line.to_string()).await;
                    }
                }

                send("\n>>> Probing WSL...".into()).await;
                let probe = run_cmd("wsl", &["-u", "root", "--", "echo", "wsl-ok"])
                    .await
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
                         echo -e '[Service]\\nExecStart=\\nExecStart=/usr/bin/dockerd -H fd:// -H tcp://127.0.0.1:2375 --containerd=/run/containerd/containerd.sock' > /etc/systemd/system/docker.service.d/override.conf && \
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
                run_cmd_streaming(
                    "wsl",
                    &[
                        "-u",
                        "root",
                        "--",
                        "bash",
                        "-c",
                        "curl -fsSL https://get.docker.com | sh",
                    ],
                    &tx,
                )
                .await
                .map_err(|e| anyhow::anyhow!("Install failed: {e}"))?;

                send("\n>>> Adding user to docker group...".into()).await;
                let _ = run_cmd(
                    "wsl",
                    &[
                        "-u",
                        "root",
                        "--",
                        "bash",
                        "-c",
                        "DEFAULT_USER=$(getent passwd 1000 | cut -d: -f1) && usermod -aG docker \"$DEFAULT_USER\"",
                    ],
                )
                .await;

                send(">>> Configuring TCP listener...".into()).await;
                let _ = run_cmd("wsl", &["-u", "root", "--", "bash", "-c",
                    "mkdir -p /etc/systemd/system/docker.service.d && \
                     echo -e '[Service]\\nExecStart=\\nExecStart=/usr/bin/dockerd -H fd:// -H tcp://127.0.0.1:2375 --containerd=/run/containerd/containerd.sock' > /etc/systemd/system/docker.service.d/override.conf && \
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
            let result = run_cmd_streaming("sh", &["-c", "curl -fsSL https://get.docker.com | sudo -n sh"], &tx).await;

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
                run_cmd_streaming("sudo", &["-n", "apt", "install", "-y", "podman"], &tx)
                    .await
                    .map_err(|e| anyhow::anyhow!("apt install failed (sudo may require password): {e}"))?;
            } else if run_cmd("dnf", &["--version"]).await.is_ok() {
                send(">>> Using dnf...\n".into()).await;
                run_cmd_streaming("sudo", &["-n", "dnf", "install", "-y", "podman"], &tx)
                    .await
                    .map_err(|e| anyhow::anyhow!("dnf install failed: {e}"))?;
            } else if run_cmd("pacman", &["--version"]).await.is_ok() {
                send(">>> Using pacman...\n".into()).await;
                run_cmd_streaming("sudo", &["-n", "pacman", "-S", "--noconfirm", "podman"], &tx)
                    .await
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
                    echo -e '[Service]\nExecStart=\nExecStart=/usr/bin/dockerd -H fd:// -H tcp://127.0.0.1:2375 --containerd=/run/containerd/containerd.sock' > /etc/systemd/system/docker.service.d/override.conf && \
                    systemctl daemon-reload && \
                    systemctl restart docker
                "#;
                run_cmd_streaming("wsl", &["-u", "root", "--", "bash", "-c", script], &tx)
                    .await
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
                run_cmd_streaming("bash", &["-c", script], &tx)
                    .await
                    .map_err(|e| anyhow::anyhow!("NVIDIA Container Toolkit installation failed: {e}"))?;
            }

            send("\n>>> NVIDIA Container Toolkit installed!\n".into()).await;
            send(">>> Waiting for Docker to come back online...\n".into()).await;

            // Docker was restarted as part of the install — wait for it to be ready
            for i in 0..15 {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                let check = {
                    #[cfg(target_os = "windows")]
                    {
                        run_cmd("wsl", &["-u", "root", "--", "docker", "info"]).await
                    }
                    #[cfg(not(target_os = "windows"))]
                    {
                        run_cmd("docker", &["info"]).await
                    }
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
            // Capture the version, don't just check presence: brew `install`
            // is a no-op when limactl already exists, so a pre-existing (often
            // years-old) Lima is never bumped unless we `upgrade` it below.
            let lima_version = run_cmd("limactl", &["--version"])
                .await
                .ok()
                .and_then(|s| parse_lima_version(&s));
            let docker_cli_installed = run_cmd("docker", &["--version"]).await.is_ok();
            let compose_installed = run_cmd("docker", &["compose", "version"]).await.is_ok();
            let buildx_installed = run_cmd("docker", &["buildx", "version"]).await.is_ok();

            {
                let mut packages = Vec::new();
                if lima_version.is_none() {
                    packages.push("lima");
                }
                if !docker_cli_installed {
                    packages.push("docker");
                }
                if !compose_installed {
                    packages.push("docker-compose");
                }
                if !buildx_installed {
                    packages.push("docker-buildx");
                }

                if packages.is_empty() {
                    send("    Lima, Docker CLI, Compose, and Buildx already installed.\n".into()).await;
                } else {
                    send(format!("    Installing: {}\n", packages.join(", "))).await;
                    let install_result =
                        run_cmd_streaming("brew", &[&["install"][..], &packages.to_vec()].concat(), &tx).await;
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

            // Ensure Lima meets the minimum version we test against. A
            // pre-existing limactl below MIN is the silent cause of VMs that
            // boot but never become reachable ("Waiting for port …:22"), so
            // upgrade it explicitly — brew `install` above would have skipped it.
            if let Some(cur) = lima_version
                && cur < MIN_LIMA
            {
                send(format!(
                    "    Lima {}.{}.{} is older than the required {}.{}.{} — upgrading...\n",
                    cur.0, cur.1, cur.2, MIN_LIMA.0, MIN_LIMA.1, MIN_LIMA.2
                ))
                .await;
                if let Err(e) = run_cmd_streaming("brew", &["upgrade", "lima"], &tx).await {
                    send(format!("\n    brew upgrade lima failed: {e}\n")).await;
                    anyhow::bail!("Failed to upgrade Lima via Homebrew: {e}");
                }
            }
            // Re-verify after any install/upgrade. Refuse to proceed on a Lima
            // below MIN rather than create a VM that may never become reachable.
            match run_cmd("limactl", &["--version"])
                .await
                .ok()
                .and_then(|s| parse_lima_version(&s))
            {
                Some(v) if v >= MIN_LIMA => {
                    send(format!("    Lima {}.{}.{} OK.\n", v.0, v.1, v.2)).await;
                }
                Some(v) => {
                    anyhow::bail!(
                        "Orca requires Lima >= {}.{}.{}, but found {}.{}.{}. \
                         Run `brew update && brew upgrade lima`, then try again.",
                        MIN_LIMA.0,
                        MIN_LIMA.1,
                        MIN_LIMA.2,
                        v.0,
                        v.1,
                        v.2
                    );
                }
                None => {
                    anyhow::bail!("Lima is not available after install. Install it with `brew install lima`.");
                }
            }

            // Step 3: Create Lima VM with Docker
            send(">>> Step 3/5: Creating Lima VM with Docker...\n".into()).await;

            // Check if a Lima VM already exists
            let existing_vms = run_cmd("limactl", &["list", "--format", "{{.Name}}"])
                .await
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
                send(format!("    Lima VM '{}' already exists.\n", vm_name)).await;
                // Surface a stale instance (built by an older Lima) — it can
                // boot but never become reachable. We never auto-delete; the
                // user chooses Recreate.
                if let Some(p) = lima_marker_path(vm_name) {
                    match std::fs::read_to_string(&p).ok().and_then(|s| parse_lima_version(&s)) {
                        Some(v) if v < MIN_LIMA => {
                            send(format!(
                                "    Note: this VM was created by Lima {}.{}.{}, older than the \
                                 required {}.{}.{}. If Docker doesn't come up below, use Recreate \
                                 to rebuild it.\n",
                                v.0, v.1, v.2, MIN_LIMA.0, MIN_LIMA.1, MIN_LIMA.2
                            ))
                            .await;
                        }
                        None => {
                            send(
                                "    Note: this VM predates Orca version tracking. If Docker \
                                 doesn't come up below, use Recreate to rebuild it.\n"
                                    .into(),
                            )
                            .await;
                        }
                        _ => {}
                    }
                }
                // Independently of the Lima-binary version, flag a VM built on an
                // older Orca base (pre-26.04/pre-vsock). It still works without a
                // VPN, so we never auto-rebuild — just point at Recreate.
                if lima_vm_generation(vm_name) < ORCA_VM_GENERATION {
                    send(
                        "    Note: this VM uses an older base (pre-Ubuntu 26.04, no vsock). It \
                         works without a VPN, but for VPN-immune networking use Recreate to \
                         rebuild it on the current base.\n"
                            .into(),
                    )
                    .await;
                }
            } else {
                send("    Creating 'orca' VM with Apple Virtualization...\n".into()).await;
                send("    This downloads a Linux image (Ubuntu 26.04 LTS) and installs Docker.\n".into()).await;
                let lima_memory_default = detect_lima_memory_default().await;
                let lima_memory_arg = format!("--memory={}", lima_memory_default.memory_gib);
                send(describe_lima_memory_default(lima_memory_default)).await;
                send("    First-time setup takes 3-5 minutes.\n\n".into()).await;

                // Create the VM. Args shared with the non-streaming run_fix path
                // via the ORCA_* constants so the two can't drift. 26.04 + vsock
                // is what lets the host↔guest channel survive a mesh VPN.
                let orca_provision = orca_provision_setarg();
                let create_result = run_cmd_streaming(
                    "limactl",
                    &[
                        "create",
                        "--name=orca",
                        "--vm-type=vz",
                        "--rosetta",
                        "--mount-writable",
                        "--mount-type=virtiofs",
                        lima_memory_arg.as_str(),
                        "--cpus=4",
                        "--set",
                        ORCA_IMAGES,
                        "--set",
                        ORCA_SSH_OVER_VSOCK,
                        "--set",
                        ORCA_PORT_FORWARDS,
                        "--set",
                        ORCA_MOUNTS,
                        "--set",
                        orca_provision.as_str(),
                        "template:docker",
                    ],
                    &tx,
                )
                .await;

                if let Err(e) = create_result {
                    send(format!("\n    VM creation failed: {e}\n")).await;
                    send(format!(
                        "    Orca requested {} GiB of VM memory. If this Mac is low on memory, \
                         close other apps and try again.\n",
                        lima_memory_default.memory_gib
                    ))
                    .await;
                    anyhow::bail!("Failed to create Lima VM: {e}");
                }
                send("\n    VM created.\n".into()).await;

                // Stamp the Lima version that built this instance so a future
                // setup can detect a stale VM (older Lima) and offer Recreate
                // rather than silently reusing it.
                if let Some(v) = run_cmd("limactl", &["--version"])
                    .await
                    .ok()
                    .and_then(|s| parse_lima_version(&s))
                    && let Some(p) = lima_marker_path("orca")
                {
                    let _ = std::fs::write(&p, format!("{}.{}.{}\n", v.0, v.1, v.2));
                }
                // Stamp the VM generation too, so a future Orca that ships a
                // newer base can detect this VM is outdated and offer an upgrade.
                if let Some(p) = lima_generation_path("orca") {
                    let _ = std::fs::write(&p, format!("{ORCA_VM_GENERATION}\n"));
                }
            }

            // Step 4: Start the VM
            send(">>> Step 4/5: Starting Lima VM...\n".into()).await;

            let start_result = run_cmd_streaming("limactl", &["start", vm_name], &tx).await;

            if let Err(e) = start_result {
                // VM might already be running
                let status = run_cmd("limactl", &["list", "--format", "{{.Name}} {{.Status}}"])
                    .await
                    .unwrap_or_default();
                if !status.contains("Running") {
                    send(format!("\n    Failed to start VM: {e}\n")).await;
                    anyhow::bail!("Failed to start Lima VM: {e}");
                }
            }
            send("    VM is running.\n".into()).await;

            // Reachability gate. A managed/corporate Mac can intercept Lima's VZ
            // host<->guest channel: the VM boots (VZ "running") but the hostagent
            // can never reach guest SSH, so `limactl start` loops "Waiting for
            // port ...:22" to a 10-minute timeout. Detect that here and give an
            // accurate diagnosis instead of grinding through the kernel-reboot
            // and docker-verify steps below — which would otherwise hang on
            // `limactl shell` or leave the UI flooding with 500s. `limactl shell`
            // against an unreachable VM returns "connection refused" promptly, so
            // this probe is bounded (~30s) and won't stall a healthy slow boot.
            send(">>> Checking the VM is reachable...\n".into()).await;
            let mut reachable = false;
            for i in 0..10 {
                if run_cmd("limactl", &["shell", vm_name, "true"]).await.is_ok() {
                    reachable = true;
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                if i % 3 == 2 {
                    send(format!(
                        "    Still waiting for the VM to accept connections... ({}s)\n",
                        (i + 1) * 3
                    ))
                    .await;
                }
            }
            if !reachable {
                send("\n    The VM started but its network never came up — the host can't reach it.\n".into()).await;
                send("    Lima loops on \"Waiting for port ...:22\" because it gates boot readiness on\n".into()).await;
                send("    the guest's usernet (192.168.5.x) SSH, and that network never configured.\n\n".into()).await;
                send("    #1 cause behind a mesh VPN (NetBird/Tailscale/WireGuard): the VPN pushes a\n".into()).await;
                send("    large DNS *search-domain* list, Lima snapshots it at VM start and offers it\n".into()).await;
                send("    over DHCP, and an oversized DHCP reply gets fragmented — the guest's DHCP\n".into()).await;
                send("    client never sees it, so lima0 gets no IP. This is why a restart while the\n".into()).await;
                send("    VPN is up fails but a boot *before* the VPN connects (e.g. after a full\n".into()).await;
                send("    reboot) works.\n\n".into()).await;
                send("    To fix, in order of preference:\n".into()).await;
                send("      - Disconnect the VPN, start the VM, then reconnect the VPN, or\n".into()).await;
                send("      - Temporarily disable the content filter / VPN and run setup again, or\n".into()).await;
                send("      - Ask IT to allow Lima / Virtualization.framework guest networking.\n".into()).await;
                send("    (On managed Macs an EDR/content-filter system extension can cause the same\n".into()).await;
                send("    wall — list them with:  systemextensionsctl list)\n".into()).await;
                anyhow::bail!(
                    "VM started but never became reachable — usernet SSH never came up. Most likely \
                     a mesh VPN's large DNS search-domain list oversized the guest's DHCP reply (boot \
                     the VM with the VPN disconnected), or security/filtering software is blocking \
                     Virtualization.framework guest networking (see `systemextensionsctl list`)"
                );
            }
            send("    VM is reachable.\n".into()).await;

            // (No kernel-activation reboot: the 26.04 base ships kernel 7.0 with
            // native idmapped overlayfs, so the old HWE-kernel install + reboot
            // dance is gone.)

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
                    if std::path::Path::new(&socket_path).exists() {
                        break;
                    }
                    if i % 3 == 2 {
                        send(format!("    Waiting... ({}s)\n", (i + 1) * 2)).await;
                    }
                }
            }

            if std::path::Path::new(&socket_path).exists() {
                send(format!("    Docker socket: {socket_path}\n")).await;

                // Remove stale contexts, create fresh one pointing to the correct socket
                let _ = run_cmd("docker", &["context", "rm", "-f", "lima"]).await;
                let _ = run_cmd("docker", &["context", "rm", "-f", "lima-orca"]).await;
                let _ = run_cmd("docker", &["context", "rm", "-f", "lima-docker"]).await;
                let _ = run_cmd(
                    "docker",
                    &[
                        "context",
                        "create",
                        "lima-orca",
                        "--docker",
                        &format!("host=unix://{socket_path}"),
                    ],
                )
                .await;
                let _ = run_cmd("docker", &["context", "use", "lima-orca"]).await;
                send("    Docker context 'lima-orca' configured.\n".into()).await;
            } else {
                send(format!("    Warning: Docker socket not found at {socket_path}\n")).await;
            }

            // Verify Docker works via the correct socket directly
            send("\n>>> Verifying Docker connection...\n".into()).await;
            match run_cmd(
                "docker",
                &[
                    "-H",
                    &format!("unix://{socket_path}"),
                    "info",
                    "--format",
                    "{{.ServerVersion}}",
                ],
            )
            .await
            {
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
                    send("    The VM is running but Docker inside it never became reachable.\n".into()).await;
                    send("    This is the signature of a stale VM (often one built by an older\n".into()).await;
                    send("    Lima). Wait a minute and restart Orca; if it persists, use the\n".into()).await;
                    send("    'Recreate VM' button on the System Health page to rebuild it.\n".into()).await;
                }
            }
        }
        #[cfg(target_os = "macos")]
        "repair_lima_orca" => {
            send(">>> Repairing Lima VM\n".into()).await;
            send("    This force-stops the VM, removes stale lock and socket files,\n".into()).await;
            send("    and restarts it. Your containers and images are preserved.\n\n".into()).await;

            let (vm, status) = match find_lima_vm_for_repair().await {
                Some(v) => v,
                None => {
                    send("    No Lima VM found. Use 'Set up Docker' to create one.\n".into()).await;
                    anyhow::bail!("No Lima VM exists to repair");
                }
            };
            send(format!(
                ">>> Step 1/4: Stopping Lima VM '{vm}' (current status: {status})\n"
            ))
            .await;
            // Graceful stop first, then force — `--force` alone leaves the
            // VM in a bad state when it's already stopped.
            let _ = run_cmd("limactl", &["stop", &vm]).await;
            match run_cmd("limactl", &["stop", "--force", &vm]).await {
                Ok(_) => send("    Stopped.\n".into()).await,
                Err(e) => send(format!("    Stop reported: {e}\n")).await,
            }

            send(">>> Step 2/4: Removing stale lock and socket files\n".into()).await;
            lima_repair_clean(&vm, &send).await;

            send(format!(">>> Step 3/4: Starting Lima VM '{vm}'\n")).await;
            match run_cmd_streaming("limactl", &["start", &vm], &tx).await {
                Ok(_) => send("    Start command completed.\n".into()).await,
                Err(e) => {
                    send(format!("\n    Start failed: {e}\n")).await;
                    send("    The disk image or config may be corrupt.\n".into()).await;
                    send("    Use the 'Recreate VM' button on the System Health page to rebuild it.\n".into()).await;
                    send("    (warning: this deletes containers and images).\n".into()).await;
                    anyhow::bail!("limactl start failed: {e}");
                }
            }

            send(">>> Step 4/4: Verifying Docker connection\n".into()).await;
            let home = std::env::var("HOME").unwrap_or_default();
            let socket = format!("{home}/.lima/{vm}/sock/docker.sock");
            let mut ok = false;
            for i in 0..15 {
                if std::path::Path::new(&socket).exists()
                    && run_cmd(
                        "docker",
                        &[
                            "-H",
                            &format!("unix://{socket}"),
                            "info",
                            "--format",
                            "{{.ServerVersion}}",
                        ],
                    )
                    .await
                    .is_ok()
                {
                    ok = true;
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                if i % 3 == 2 {
                    send(format!("    Waiting for Docker... ({}s)\n", (i + 1) * 2)).await;
                }
            }
            if ok {
                send("    Docker is reachable. Repair complete.\n".into()).await;
            } else {
                send("    Docker socket did not come up within 30s.\n".into()).await;
                send("    The VM started but Docker inside it isn't responding.\n".into()).await;
                send("    Try again, or use the 'Recreate VM' button on the System Health page.\n".into()).await;
                anyhow::bail!("VM started but Docker socket never became reachable");
            }
        }
        #[cfg(target_os = "macos")]
        "recreate_lima_orca" => {
            // Destructive: only ever invoked after explicit user confirmation in
            // the GUI. Deletes the existing VM and rebuilds a fresh one — the
            // fix for a stale instance created by an older Lima that the normal
            // setup path would otherwise reuse as-is (see the "already exists"
            // branch in setup_docker_macos).
            send(">>> Recreating the Docker VM\n".into()).await;
            send("    This permanently deletes the existing Lima VM and builds a fresh one.\n".into()).await;
            send("    Containers, images, and volumes inside it are NOT preserved.\n\n".into()).await;
            // Force-stop first so delete can't fail on a running or wedged VM.
            for name in ["orca", "docker", "default"] {
                let _ = run_cmd("limactl", &["stop", "-f", name]).await;
                let _ = run_cmd("limactl", &["delete", "-f", name]).await;
            }
            send("    Old VM removed. Building a fresh one...\n\n".into()).await;
            // Delegate to the full setup path: it re-checks the Lima version and,
            // with no instance present, creates + starts + verifies a new one.
            // Boxed because this recurses into the same async fn; clone tx so the
            // `send` closure's borrow of it isn't moved out.
            return Box::pin(run_fix_streaming("setup_docker_macos", tx.clone())).await;
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

/// Helpers for repair_lima_orca. Mirror the daemon-side logic in
/// `orca-daemon/src/main.rs` but stream progress through the SSE channel
/// so the GUI's repair dialog can show the user what's happening.
#[cfg(target_os = "macos")]
async fn find_lima_vm_for_repair() -> Option<(String, String)> {
    let out = run_cmd("limactl", &["list", "--format", "{{.Name}}\t{{.Status}}"])
        .await
        .ok()?;
    let mut orca = None;
    let mut docker = None;
    for line in out.lines() {
        let mut it = line.split('\t');
        let name = it.next().unwrap_or("").trim();
        let status = it.next().unwrap_or("").trim().to_string();
        match name {
            "orca" => orca = Some(("orca".to_string(), status)),
            "docker" => docker = Some(("docker".to_string(), status)),
            _ => {}
        }
    }
    orca.or(docker)
}

#[cfg(target_os = "macos")]
async fn lima_repair_clean<F, Fut>(vm: &str, send: &F)
where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    let home = std::env::var("HOME").unwrap_or_default();
    let dir = format!("{home}/.lima/{vm}");

    let sock_dir = format!("{dir}/sock");
    if std::path::Path::new(&sock_dir).exists() {
        match std::fs::remove_dir_all(&sock_dir) {
            Ok(_) => send("    Removed sock/ directory\n".into()).await,
            Err(e) => send(format!("    Could not remove sock/: {e}\n")).await,
        }
    }

    // Match the ephemerals list in orca-daemon/src/main.rs::lima_deep_clean.
    let ephemerals = [
        "ha.pid",
        "qemu.pid",
        "ha.sock",
        "ha.stdout.log",
        "ha.stderr.log",
        "serial0.log",
        "serial0.sock",
        "serialv.log",
        "serialv.sock",
        "serialp.log",
        "serialp.sock",
        "vz-identifier",
    ];
    let mut removed = 0;
    for name in &ephemerals {
        let p = format!("{dir}/{name}");
        if std::path::Path::new(&p).exists() && std::fs::remove_file(&p).is_ok() {
            removed += 1;
        }
    }
    send(format!("    Removed {removed} ephemeral state file(s)\n")).await;
}

/// Decode command output, handling UTF-16LE (common from Windows CLI tools like wsl.exe).
fn decode_output(bytes: &[u8]) -> String {
    // Check for UTF-16LE BOM (FF FE) or null bytes interleaved with ASCII
    // which is the telltale sign of UTF-16LE without BOM
    let is_utf16 = (bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE)
        || (bytes.len() >= 4 && bytes[1] == 0 && bytes[3] == 0);

    if is_utf16 {
        let skip = if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
            2
        } else {
            0
        };
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
                let is_root = std::env::var("USER").map(|u| u == "root").unwrap_or(false);
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
        std::path::Path::new(&format!(
            "{}\\Docker\\Docker\\Docker Desktop.exe",
            std::env::var("ProgramFiles").unwrap_or_default()
        ))
        .exists()
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

// --- Docker Desktop migration (macOS only) ---

/// Status of Docker Desktop relative to the Orca Lima runtime.
#[derive(Debug, Clone, serde::Serialize)]
pub struct DockerDesktopStatus {
    /// Docker Desktop is installed on this machine.
    pub installed: bool,
    /// Docker Desktop's context is the currently active Docker context.
    pub active: bool,
    /// The Orca Lima VM exists and could be used as the runtime.
    pub orca_runtime_available: bool,
}

/// Check whether Docker Desktop is installed and whether its context is active.
#[cfg(target_os = "macos")]
pub async fn docker_desktop_status() -> DockerDesktopStatus {
    let installed = std::path::Path::new("/Applications/Docker.app").exists();

    // Check the active Docker context name
    let active = match run_cmd("docker", &["context", "inspect", "--format", "{{.Name}}"]).await {
        Ok(name) => {
            let name = name.trim();
            // "desktop-linux" is Docker Desktop's default context on macOS.
            // "default" can also mean Docker Desktop if Docker Desktop is installed
            // and no other context has been created.
            name == "desktop-linux" || (name == "default" && installed)
        }
        Err(_) => false,
    };

    // Check whether the lima-orca context exists (or the Orca Lima VM is available)
    let orca_runtime_available = if let Ok(home) = std::env::var("HOME") {
        let socket = format!("{home}/.lima/orca/sock/docker.sock");
        std::path::Path::new(&socket).exists()
    } else {
        false
    };

    DockerDesktopStatus {
        installed,
        active,
        orca_runtime_available,
    }
}

#[cfg(not(target_os = "macos"))]
pub async fn docker_desktop_status() -> DockerDesktopStatus {
    DockerDesktopStatus {
        installed: false,
        active: false,
        orca_runtime_available: false,
    }
}

/// Switch Docker CLI to use the Orca Lima runtime context.
#[cfg(target_os = "macos")]
pub async fn switch_to_orca_runtime() -> anyhow::Result<String> {
    // 1. Check that the Orca Lima VM exists
    let home = std::env::var("HOME").map_err(|_| anyhow::anyhow!("HOME not set"))?;
    let socket = format!("{home}/.lima/orca/sock/docker.sock");

    if !std::path::Path::new(&socket).exists() {
        return Err(anyhow::anyhow!(
            "Orca Lima VM not found. Please set up Docker via the System Health page first."
        ));
    }

    // 2. Ensure the lima-orca Docker context exists, create it if missing
    let context_exists = run_cmd("docker", &["context", "inspect", "lima-orca"]).await.is_ok();

    if !context_exists {
        let host = format!("unix://{socket}");
        run_cmd(
            "docker",
            &[
                "context",
                "create",
                "lima-orca",
                "--docker",
                &format!("host={host}"),
                "--description",
                "Orca Lima runtime",
            ],
        )
        .await
        .map_err(|e| anyhow::anyhow!("Failed to create Docker context: {e}"))?;
    }

    // 3. Switch to the lima-orca context
    run_cmd("docker", &["context", "use", "lima-orca"])
        .await
        .map_err(|e| anyhow::anyhow!("Failed to switch Docker context: {e}"))?;

    // 4. Verify connectivity
    match run_cmd("docker", &["info", "--format", "{{.ServerVersion}}"]).await {
        Ok(version) => Ok(format!(
            "Switched to Orca runtime (Docker {}). The Docker CLI now uses the lightweight Lima VM.",
            version.trim()
        )),
        Err(_) => Ok("Switched Docker context to lima-orca. The runtime may still be starting up.".to_string()),
    }
}

#[cfg(not(target_os = "macos"))]
pub async fn switch_to_orca_runtime() -> anyhow::Result<String> {
    Err(anyhow::anyhow!("Runtime switching is only supported on macOS"))
}

/// Stop Docker Desktop application (macOS only).
#[cfg(target_os = "macos")]
pub async fn stop_docker_desktop() -> anyhow::Result<()> {
    // Try osascript first (graceful quit)
    let result = run_cmd("osascript", &["-e", "quit app \"Docker\""]).await;
    if result.is_ok() {
        return Ok(());
    }

    // Fallback: killall
    let _ = run_cmd("killall", &["Docker Desktop"]).await;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub async fn stop_docker_desktop() -> anyhow::Result<()> {
    Err(anyhow::anyhow!("Stopping Docker Desktop is only supported on macOS"))
}

async fn check_podman_socket() -> HealthCheck {
    // Check rootless socket first, then root socket
    let uid = std::env::var("UID")
        .or_else(|_| std::fs::read_to_string("/proc/self/loginuid").map(|s| s.trim().to_string()))
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
        run_cmd(
            "wsl",
            &[
                "-u",
                "root",
                "--",
                "nvidia-smi",
                "--query-gpu=name",
                "--format=csv,noheader",
            ],
        )
        .await
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
                    details: Some(format!(
                        "{} — Container Toolkit {}",
                        gpu,
                        ver.trim().lines().next().unwrap_or("")
                    )),
                },
                Err(_) => HealthCheck {
                    name: "NVIDIA GPU".to_string(),
                    description: format!("{} detected but Container Toolkit not installed", gpu),
                    status: CheckStatus::Warning,
                    fix_action: Some("install_nvidia_toolkit".to_string()),
                    details: Some(format!(
                        "{} — install nvidia-container-toolkit for GPU in containers",
                        gpu
                    )),
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
            let docker = check_docker_installed().await;
            let docker_ok = docker.status == CheckStatus::Pass;
            checks.push(docker);
            checks.push(check_docker_socket().await);
            checks.push(check_docker_running().await);
            checks.push(check_docker_group().await);
            // Only show Podman checks if Docker is not installed (it's an alternative, not required alongside Docker)
            if !docker_ok {
                checks.push(check_podman_installed().await);
                checks.push(check_podman_socket().await);
            }
            let gpu = check_nvidia_gpu().await;
            if gpu.details.is_some() {
                checks.push(gpu);
            }
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
                                if let Ok(version) =
                                    run_cmd("docker", &["-H", &host_arg, "info", "--format", "{{.ServerVersion}}"])
                                        .await
                                {
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
                                if let Ok(version) =
                                    run_cmd("docker", &["-H", &host_arg, "info", "--format", "{{.ServerVersion}}"])
                                        .await
                                {
                                    let v = version.trim().to_string();
                                    if !v.is_empty() {
                                        found_version = Some(v);
                                    }
                                }
                            }
                        }
                    }
                    found_version
                }
            };

            // Is there an Orca-managed Lima VM on an outdated base? Read from the
            // host-side generation marker, so this works even when the VM is
            // unreachable. Drives both the "Docker works but upgrade available"
            // nudge and the choice of Repair-vs-Recreate when Docker is down.
            let stale_base_vm = run_cmd("limactl", &["list", "--format", "{{.Name}}"])
                .await
                .ok()
                .and_then(|out| {
                    out.lines()
                        .map(|l| l.trim().to_string())
                        .find(|n| n == "orca" || n == "docker")
                })
                .filter(|vm| lima_vm_generation(vm) < ORCA_VM_GENERATION);

            if let Some(version) = docker_running {
                // Docker is running (via Docker Desktop, Lima, Colima, etc.)
                checks.push(HealthCheck {
                    name: "Docker Runtime".to_string(),
                    description: "Docker engine is running".to_string(),
                    status: CheckStatus::Pass,
                    fix_action: None,
                    details: Some(format!("Server version: {version}")),
                });
                // Docker works, but on an old base. Offer (don't force) an
                // upgrade — a happy user can ignore it; a user who's about to hit
                // a VPN rollout gets a one-click path onto the vsock base.
                if let Some(vm) = &stale_base_vm {
                    checks.push(HealthCheck {
                        name: "Docker VM Base".to_string(),
                        description: "Your Docker VM runs an older base (pre-Ubuntu 26.04, no vsock). \
                             Upgrading gives VPN-immune networking and drops the legacy kernel \
                             workaround. Optional — safe to skip if Docker works for you."
                            .to_string(),
                        status: CheckStatus::Warning,
                        fix_action: Some("recreate_lima_orca".to_string()),
                        details: Some(format!(
                            "Rebuilds VM '{vm}' on Ubuntu 26.04 + vsock SSH. Containers, images, \
                             and volumes inside it are NOT preserved — you'll re-pull/re-run them."
                        )),
                    });
                }
            } else {
                // Distinguish "Lima VM exists but not running" (offer Repair)
                // from "no VM at all" (offer Setup). Without this branch
                // both cases land on setup_docker_macos which is wrong for
                // an existing-but-stuck VM: it would refuse to recreate.
                let lima_vm_status = run_cmd("limactl", &["list", "--format", "{{.Name}}\t{{.Status}}"])
                    .await
                    .ok()
                    .and_then(|out| {
                        out.lines()
                            .filter_map(|line| {
                                let mut it = line.split('\t');
                                let name = it.next()?.trim();
                                let status = it.next()?.trim().to_string();
                                if name == "orca" || name == "docker" {
                                    Some((name.to_string(), status))
                                } else {
                                    None
                                }
                            })
                            .next()
                    });

                if let Some((vm, status)) = lima_vm_status {
                    // An old-base VM that's unreachable is the NetBird case:
                    // Repair just restarts the same broken base and won't help.
                    // Steer straight to Recreate (which rebuilds on 26.04+vsock).
                    if stale_base_vm.is_some() {
                        checks.push(HealthCheck {
                            name: "Docker Runtime".to_string(),
                            description: format!(
                                "Lima VM '{vm}' is {status} but Docker is unreachable, and it runs \
                                 an older base (pre-26.04, no vsock) that can fail behind a VPN. \
                                 Recreate to rebuild it on Ubuntu 26.04 + vsock."
                            ),
                            status: CheckStatus::Fail,
                            fix_action: Some("recreate_lima_orca".to_string()),
                            details: Some(
                                "Rebuilds the VM on the current base. Containers, images, and \
                                 volumes inside it are NOT preserved. (A plain Repair restarts the \
                                 same old base and usually won't fix a VPN-blocked VM.)"
                                    .to_string(),
                            ),
                        });
                    } else {
                        checks.push(HealthCheck {
                            name: "Docker Runtime".to_string(),
                            description: format!(
                                "Lima VM '{vm}' is {status} — Docker is unreachable. \
                                 Click Repair to recover (preserves your containers and images)."
                            ),
                            status: CheckStatus::Fail,
                            fix_action: Some("repair_lima_orca".to_string()),
                            details: Some(
                                "Stops the VM, removes stale lock and socket files, and restarts it. \
                                 If repair fails, use the 'Recreate VM' button on the System Health page."
                                    .to_string(),
                            ),
                        });
                    }
                } else {
                    // No Lima VM yet — first-time setup.
                    checks.push(HealthCheck {
                        name: "Docker Runtime".to_string(),
                        description: "Docker is not running. Click Fix to install and configure automatically."
                            .to_string(),
                        status: CheckStatus::Fail,
                        fix_action: Some("setup_docker_macos".to_string()),
                        details: Some(
                            "Installs Homebrew, Lima, and Docker in a lightweight Linux VM using Apple Virtualization"
                                .to_string(),
                        ),
                    });
                }
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
                match run_cmd(
                    "wsl",
                    &["-u", "root", "--", "docker", "info", "--format", "{{.ServerVersion}}"],
                )
                .await
                {
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
            if gpu.details.is_some() {
                checks.push(gpu);
            }
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
            if run_cmd("apt", &["--version"]).await.is_ok() {
                let output = run_cmd("sudo", &["apt", "install", "-y", "podman"])
                    .await
                    .map_err(|e| {
                        anyhow::anyhow!(
                            "Failed to install Podman via apt.\n\n\
                             You can try installing manually by running:\n\
                             sudo apt install -y podman\n\n\
                             Error: {e}"
                        )
                    })?;
                Ok(format!("Installed podman via apt:\n{output}"))
            } else if run_cmd("dnf", &["--version"]).await.is_ok() {
                let output = run_cmd("sudo", &["dnf", "install", "-y", "podman"])
                    .await
                    .map_err(|e| {
                        anyhow::anyhow!(
                            "Failed to install Podman via dnf.\n\n\
                             You can try installing manually by running:\n\
                             sudo dnf install -y podman\n\n\
                             Error: {e}"
                        )
                    })?;
                Ok(format!("Installed podman via dnf:\n{output}"))
            } else if run_cmd("pacman", &["--version"]).await.is_ok() {
                let output = run_cmd("sudo", &["pacman", "-S", "--noconfirm", "podman"])
                    .await
                    .map_err(|e| {
                        anyhow::anyhow!(
                            "Failed to install Podman via pacman.\n\n\
                             You can try installing manually by running:\n\
                             sudo pacman -S podman\n\n\
                             Error: {e}"
                        )
                    })?;
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
                .map_err(|e| {
                    anyhow::anyhow!(
                        "The Docker install script failed.\n\n\
                     You can try installing manually by running:\n\
                     curl -fsSL https://get.docker.com | sh\n\n\
                     Or see: https://docs.docker.com/engine/install/\n\n\
                     Error: {e}"
                    )
                })?;
            Ok(format!("Docker installed:\n{output}"))
        }
        "start_docker" => {
            #[cfg(target_os = "windows")]
            {
                // On Windows, configure TCP listener and start Docker inside WSL2
                let _ = run_cmd("wsl", &["-u", "root", "--", "bash", "-c",
                    "mkdir -p /etc/systemd/system/docker.service.d && \
                     echo -e '[Service]\\nExecStart=\\nExecStart=/usr/bin/dockerd -H fd:// -H tcp://127.0.0.1:2375 --containerd=/run/containerd/containerd.sock' > /etc/systemd/system/docker.service.d/override.conf && \
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
                let output = run_cmd("sudo", &["systemctl", "start", "docker"]).await.map_err(|e| {
                    anyhow::anyhow!(
                        "Failed to start the Docker daemon.\n\n\
                         Try running manually:\n\
                         sudo systemctl start docker\n\n\
                         If Docker is not installed, use the Install button above first.\n\n\
                         Error: {e}"
                    )
                })?;
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
                    if out.is_empty() {
                        String::new()
                    } else {
                        format!("\n{out}")
                    }
                )),
                Err(_) => {
                    let out = run_cmd("sudo", &["systemctl", "start", "podman.socket"])
                        .await
                        .map_err(|e| {
                            anyhow::anyhow!(
                                "Failed to start the Podman socket.\n\n\
                             Try running manually:\n\
                             systemctl --user start podman.socket\n\
                             or: sudo systemctl start podman.socket\n\n\
                             If Podman is not installed, use the Install button above first.\n\n\
                             Error: {e}"
                            )
                        })?;
                    Ok(format!(
                        "Podman socket started (root).{}",
                        if out.is_empty() {
                            String::new()
                        } else {
                            format!("\n{out}")
                        }
                    ))
                }
            }
        }
        "add_docker_group" => {
            let user = std::env::var("USER").unwrap_or_else(|_| "unknown".to_string());
            let output = run_cmd("sudo", &["usermod", "-aG", "docker", &user])
                .await
                .map_err(|e| {
                    anyhow::anyhow!(
                        "Failed to add your user to the docker group.\n\n\
                     Try running manually:\n\
                     sudo usermod -aG docker {user}\n\n\
                     Then log out and back in for the change to take effect.\n\n\
                     Error: {e}"
                    )
                })?;
            Ok(format!(
                "Added {user} to docker group.\n\n\
                 Important: You need to log out and back in (or restart) for this to take effect.{}",
                if output.is_empty() {
                    String::new()
                } else {
                    format!("\n{output}")
                }
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
                let probe = run_cmd("wsl", &["-u", "root", "--", "echo", "wsl-ok"])
                    .await
                    .map_err(|e| {
                        anyhow::anyhow!(
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
                        )
                    })?;

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
                                     echo -e '[Service]\\nExecStart=\\nExecStart=/usr/bin/dockerd -H fd:// -H tcp://127.0.0.1:2375 --containerd=/run/containerd/containerd.sock' > /etc/systemd/system/docker.service.d/override.conf && \
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
                let _ = run_cmd(
                    "wsl",
                    &["-u", "root", "--", "bash", "-c", "pkill dockerd 2>/dev/null || true"],
                )
                .await;

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
                match run_cmd("wsl", &["-u", "root", "--", "bash", "-c", "sh /tmp/get-docker.sh 2>&1"]).await {
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
                     echo -e '[Service]\\nExecStart=\\nExecStart=/usr/bin/dockerd -H fd:// -H tcp://127.0.0.1:2375 --containerd=/run/containerd/containerd.sock' > /etc/systemd/system/docker.service.d/override.conf && \
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
                    .map_err(|e| {
                        anyhow::anyhow!(
                            "The Docker install script failed.\n\n\
                         You can try installing manually:\n\
                         curl -fsSL https://get.docker.com | sh\n\n\
                         Or see: https://docs.docker.com/engine/install/\n\n\
                         Error: {e}"
                        )
                    })?;
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
            let output = run_cmd("brew", &["install", "lima"]).await.map_err(|e| {
                anyhow::anyhow!(
                    "Failed to install Lima via Homebrew.\n\n\
                     You can try installing manually by running:\n\
                     brew install lima\n\n\
                     Make sure Homebrew is installed first (see https://brew.sh).\n\n\
                     Error: {e}"
                )
            })?;
            Ok(format!("Lima installed:\n{output}"))
        }
        "enable_wsl2" => {
            let output = run_cmd("wsl", &["--install"]).await.map_err(|e| {
                anyhow::anyhow!(
                    "Failed to enable WSL2.\n\n\
                     You can try enabling it manually:\n\
                     1. Open PowerShell as Administrator\n\
                     2. Run: wsl --install\n\
                     3. Restart your computer when prompted\n\n\
                     See: https://learn.microsoft.com/en-us/windows/wsl/install\n\n\
                     Error: {e}"
                )
            })?;
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

            Ok(format!(
                "NVIDIA Container Toolkit installed!\n\nRestart any running Ollama containers to use GPU.\n\n{output}"
            ))
        }
        "install_helm" => {
            #[cfg(target_os = "windows")]
            let output = run_cmd(
                "wsl",
                &[
                    "-u",
                    "root",
                    "--",
                    "bash",
                    "-c",
                    "curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash",
                ],
            )
            .await
            .map_err(|e| anyhow::anyhow!("Helm install failed: {e}"))?;

            #[cfg(not(target_os = "windows"))]
            let output = run_cmd(
                "bash",
                &[
                    "-c",
                    "curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | sudo bash",
                ],
            )
            .await
            .map_err(|e| anyhow::anyhow!("Helm install failed: {e}"))?;

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
                if !lima_ok {
                    pkgs.push("lima");
                }
                if !docker_ok {
                    pkgs.push("docker");
                }
                if !compose_ok {
                    pkgs.push("docker-compose");
                }
                if !buildx_ok {
                    pkgs.push("docker-buildx");
                }
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
            let vms = run_cmd("limactl", &["list", "--format", "{{.Name}}"])
                .await
                .unwrap_or_default();
            let vm_name = if vms.lines().any(|l| l.trim() == "orca") {
                "orca"
            } else if vms.lines().any(|l| l.trim() == "docker") {
                "docker"
            } else {
                "orca"
            };
            if !vms
                .lines()
                .any(|l| l.trim() == "orca" || l.trim() == "docker" || l.trim() == "default")
            {
                output.push_str("Creating Lima VM 'orca'...\n");
                let lima_memory_default = detect_lima_memory_default().await;
                let lima_memory_arg = format!("--memory={}", lima_memory_default.memory_gib);
                output.push_str(&describe_lima_memory_default(lima_memory_default));
                // Same args as the streaming path, via the shared ORCA_* consts
                // (26.04 + vsock; no HWE-kernel install).
                let orca_provision = orca_provision_setarg();
                match run_cmd(
                    "limactl",
                    &[
                        "create",
                        "--name=orca",
                        "--vm-type=vz",
                        "--rosetta",
                        "--mount-writable",
                        "--mount-type=virtiofs",
                        lima_memory_arg.as_str(),
                        "--cpus=4",
                        "--set",
                        ORCA_IMAGES,
                        "--set",
                        ORCA_SSH_OVER_VSOCK,
                        "--set",
                        ORCA_PORT_FORWARDS,
                        "--set",
                        ORCA_MOUNTS,
                        "--set",
                        orca_provision.as_str(),
                        "template:docker",
                    ],
                )
                .await
                {
                    Ok(_) => {
                        output.push_str("VM created.\n");
                        if let Some(p) = lima_generation_path("orca") {
                            let _ = std::fs::write(&p, format!("{ORCA_VM_GENERATION}\n"));
                        }
                    }
                    Err(e) => output.push_str(&format!("VM creation failed: {e}\n")),
                }
            }

            output.push_str(&format!("Starting Lima VM '{vm_name}'...\n"));
            let _ = run_cmd("limactl", &["start", vm_name]).await;

            // (No kernel-activation reboot — 26.04 ships kernel 7.0 with native
            // idmapped overlayfs.)

            // Verify
            match run_cmd("docker", &["info", "--format", "{{.ServerVersion}}"]).await {
                Ok(v) => output.push_str(&format!("\nDocker {} is ready!\n", v.trim())),
                Err(_) => output.push_str("\nDocker may still be starting. Restart Orca in a moment.\n"),
            }

            Ok(output)
        }
        #[cfg(target_os = "macos")]
        "repair_lima_orca" => {
            let mut output = String::new();
            output.push_str(">>> Repairing Lima VM\n");
            let (vm, status) = find_lima_vm_for_repair()
                .await
                .ok_or_else(|| anyhow::anyhow!("No Lima VM exists to repair"))?;
            output.push_str(&format!("VM '{vm}' status: {status}\n"));
            let _ = run_cmd("limactl", &["stop", &vm]).await;
            let _ = run_cmd("limactl", &["stop", "--force", &vm]).await;
            output.push_str("Stopped.\n");

            let home = std::env::var("HOME").unwrap_or_default();
            let dir = format!("{home}/.lima/{vm}");
            let _ = std::fs::remove_dir_all(format!("{dir}/sock"));
            for f in [
                "ha.pid",
                "qemu.pid",
                "ha.sock",
                "ha.stdout.log",
                "ha.stderr.log",
                "serial0.log",
                "serial0.sock",
                "serialv.log",
                "serialv.sock",
                "serialp.log",
                "serialp.sock",
                "vz-identifier",
            ] {
                let _ = std::fs::remove_file(format!("{dir}/{f}"));
            }
            output.push_str("Removed stale state files.\n");

            match run_cmd("limactl", &["start", &vm]).await {
                Ok(o) => output.push_str(&format!("Started:\n{o}\n")),
                Err(e) => {
                    return Err(anyhow::anyhow!(
                        "Repair failed at start step: {e}\n\
                         Try the streaming Repair from the Environment page, or 'Recreate VM'."
                    ));
                }
            }
            Ok(output)
        }
        #[cfg(target_os = "macos")]
        "recreate_lima_orca" => {
            // Non-streaming fallback for the destructive recreate (the GUI uses
            // the streaming path; this only runs if the SSE stream itself
            // failed). Confirmation already happened in the GUI.
            for name in ["orca", "docker", "default"] {
                let _ = run_cmd("limactl", &["stop", "-f", name]).await;
                let _ = run_cmd("limactl", &["delete", "-f", name]).await;
            }
            // Delegate to setup, which recreates when no instance is present.
            Box::pin(run_fix("setup_docker_macos")).await
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
    cmd.args(["info"]).stdout(Stdio::null()).stderr(Stdio::null());
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
            let total = parse_meminfo_kb(&meminfo, "MemTotal:").map(|kb| kb * 1024).unwrap_or(0);
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
                let free_pages = output
                    .lines()
                    .find(|l| l.contains("Pages free"))
                    .and_then(|l| l.split_whitespace().last())
                    .and_then(|s| s.trim_end_matches('.').parse::<u64>().ok())
                    .unwrap_or(0);
                let inactive_pages = output
                    .lines()
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
                let parts: Vec<&str> = output.split_whitespace().collect();
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
                let parts: Vec<&str> = output.split_whitespace().collect();
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
                    if i == 0 {
                        continue;
                    }
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
            .or({
                // On macOS, the CLI might not be in PATH even though docker is running.
                // Try to extract version from the socket connection later (via bollard in daemon).
                None
            })
    } else {
        None
    };

    let disk = if connected { get_disk_usage().await } else { None };

    let resources = get_system_resources().await;

    let mut warnings = Vec::new();
    if !connected {
        warnings.push(format!(
            "{} is not running or not reachable",
            if cli == "podman" { "Podman" } else { "Docker" }
        ));
    }
    if let Some(ref res) = resources {
        if res.disk_usage_percent > 90.0 {
            warnings.push("Disk usage is above 90% — consider pruning images".to_string());
        }
        if res.memory_available_bytes < 512 * 1024 * 1024 {
            warnings.push("Less than 512MB memory available".to_string());
        }
    }
    if let Some(ref du) = disk
        && du.reclaimable_bytes > 5 * 1024 * 1024 * 1024
    {
        let gb = du.reclaimable_bytes / (1024 * 1024 * 1024);
        warnings.push(format!("{gb}GB of Docker storage is reclaimable — consider pruning"));
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
        run_cmd(
            "wsl",
            &[
                "-u",
                "root",
                "--",
                "nvidia-smi",
                "--query-gpu=name,memory.used,memory.total,utilization.gpu",
                "--format=csv,noheader,nounits",
            ],
        )
        .await
    } else {
        run_cmd(
            "nvidia-smi",
            &[
                "--query-gpu=name,memory.used,memory.total,utilization.gpu",
                "--format=csv,noheader,nounits",
            ],
        )
        .await
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

    #[test]
    fn recommended_lima_memory_scales_with_host_memory() {
        assert_eq!(recommended_lima_memory_gib(8), 4);
        assert_eq!(recommended_lima_memory_gib(16), 8);
        assert_eq!(recommended_lima_memory_gib(24), 12);
        assert_eq!(recommended_lima_memory_gib(32), 16);
        assert_eq!(recommended_lima_memory_gib(64), 16);
    }

    #[test]
    fn recommended_lima_memory_keeps_room_for_small_hosts() {
        assert_eq!(recommended_lima_memory_gib(0), 8);
        assert_eq!(recommended_lima_memory_gib(4), 2);
        assert_eq!(recommended_lima_memory_gib(6), 4);
    }
}
