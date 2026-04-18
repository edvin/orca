//! WSL2 distro management — create, start, stop, delete distros on Windows.
//!
//! Uses `wsl.exe` CLI for lifecycle management and `wsl -d <distro> -- <cmd>`
//! for running commands inside the distro.

use std::path::PathBuf;
use std::process::Stdio;

use tokio::process::Command;

use orca_core::machine::*;
use orca_core::runtime::RuntimeKind;

use crate::WindowsBackend;

/// The fixed name of the Orca-owned base image cache distro. User-created
/// distros must not use this name or any `orca-base-` prefixed name, since
/// Orca treats those names as its own and may export/unregister them.
const ORCA_BASE_DISTRO: &str = "orca-base-Ubuntu-24.04";

/// Reserved name prefix for Orca-owned base image caches. Any distro whose
/// name starts with this (case-insensitive) is reserved and cannot be
/// created via the public `create` API.
const ORCA_BASE_PREFIX: &str = "orca-base-";

/// Marker file dropped inside an Orca-owned base distro to prove ownership
/// before we export/reuse it. Without the marker we refuse to treat a
/// same-named distro as ours.
const ORCA_BASE_MARKER_PATH: &str = "/etc/orca-base-stamp";
const ORCA_BASE_MARKER_CONTENT: &str = "orca-base-marker v1";

/// Validate a WSL distro name. Must be safe as an argv to `wsl.exe` and
/// usable as a Windows filesystem fragment (wsl stores distros under
/// `%LOCALAPPDATA%\Packages\...`).
fn validate_distro_name(name: &str) -> anyhow::Result<()> {
    if name.is_empty() || name.len() > 64 {
        anyhow::bail!("WSL distro name must be 1..=64 characters");
    }
    if name.starts_with('-') || name.starts_with('.') {
        anyhow::bail!("WSL distro name must not start with '-' or '.'");
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
    {
        anyhow::bail!("WSL distro name must contain only ASCII alphanumerics, '-', and '_'");
    }
    // Reserve the `orca-base-` prefix (case-insensitive) for Orca's own
    // base image cache distros. User-facing create/delete must refuse
    // names in this namespace so they can't collide with, or overwrite,
    // the shared cache.
    if name.to_ascii_lowercase().starts_with(ORCA_BASE_PREFIX) {
        anyhow::bail!(
            "WSL distro name '{name}' is reserved: names starting with 'orca-base-' \
             are used for Orca's internal base image cache. Please choose a different name."
        );
    }
    Ok(())
}

/// Validate machine-config resources before templating `.wslconfig`.
fn validate_resources(config: &MachineConfig) -> anyhow::Result<()> {
    if config.cpus == 0 {
        anyhow::bail!("cpus must be >= 1");
    }
    if config.memory_mb < 1024 {
        anyhow::bail!("memory_mb must be >= 1024");
    }
    Ok(())
}

impl MachineManager for WindowsBackend {
    async fn create(&self, config: MachineConfig) -> anyhow::Result<MachineInfo> {
        validate_distro_name(&config.name)?;
        validate_resources(&config)?;

        // Defence-in-depth: `validate_distro_name` already rejects any
        // `orca-base-*` name, but assert the exact cache name here too
        // so this invariant is obvious at the call site and survives any
        // future loosening of the prefix rule.
        if config.name == ORCA_BASE_DISTRO {
            anyhow::bail!(
                "The name '{ORCA_BASE_DISTRO}' is reserved for Orca's base image cache. \
                 Please choose a different name."
            );
        }

        // Strategy: install Ubuntu-24.04 first, then export & re-import under
        // the requested `config.name`. Without the export/import dance,
        // `wsl --install -d Ubuntu-24.04` creates a distro literally named
        // "Ubuntu-24.04" — so every subsequent `wsl_exec(distro_name, ...)`
        // targets a distro that doesn't exist.
        let distro_name = config.name.clone();

        // Check if distro already exists
        let existing = self.list().await?;
        if existing.iter().any(|m| m.name == distro_name) {
            anyhow::bail!("WSL2 distro '{distro_name}' already exists");
        }

        tracing::info!("Installing WSL2 base image...");

        // 1. Install a base image into a distro name we unambiguously own.
        //
        //    Orca will NEVER touch a user-installed `Ubuntu` or
        //    `Ubuntu-24.04` distro — we treat those as foreign and out of
        //    scope. Exporting and deleting a user's distro to "reuse" its
        //    rootfs would destroy their home directory and any packages
        //    they installed. Instead we install into a uniquely-named
        //    marker distro (`orca-base-Ubuntu-24.04`) that no one else
        //    should create. If a previous run left it behind we reuse it;
        //    otherwise we install fresh.
        //
        //    Name-matching alone is not sufficient proof of ownership —
        //    a user could have manually created (or imported on another
        //    machine) a distro with that exact name. Before reusing a
        //    same-named distro, we verify it carries our marker file
        //    `/etc/orca-base-stamp`, dropped at first provision. If the
        //    marker is missing we refuse to touch it and tell the user
        //    to rename or unregister it manually.
        let base_name = ORCA_BASE_DISTRO;
        let orca_base_installed = existing.iter().any(|m| m.name == base_name);
        if orca_base_installed {
            if !verify_orca_base_marker(base_name).await {
                anyhow::bail!(
                    "A WSL distro named '{base_name}' already exists but was not created by Orca. \
                     Please remove it manually (wsl --unregister {base_name}) or rename it before proceeding."
                );
            }
        } else {
            // Prefer `--name` so modern wsl.exe installs `Ubuntu-24.04`
            // directly under our unique name. Older wsl.exe lacks
            // `--name`, so fall back to installing `Ubuntu-24.04` and
            // immediately renaming via export/import into our name.
            let named_install = Command::new("wsl.exe")
                .args(["--install", "-d", "Ubuntu-24.04", "--name", base_name, "--no-launch"])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .output()
                .await?;

            if !named_install.status.success() {
                // Older wsl.exe: install under default name into our own
                // tempfile, then import under our unique name. We refuse
                // to do this if a stray `Ubuntu-24.04` already exists —
                // that distro is NOT ours.
                let user_owned_collision = self
                    .list()
                    .await?
                    .iter()
                    .any(|m| m.name == "Ubuntu-24.04" || m.name == "Ubuntu");
                if user_owned_collision {
                    anyhow::bail!(
                        "A user-installed 'Ubuntu-24.04' distro is present. \
                         Orca will not modify it. Please install a newer wsl.exe \
                         (supports --name) or rename your existing distro."
                    );
                }
                let install_default = Command::new("wsl.exe")
                    .args(["--install", "-d", "Ubuntu-24.04", "--no-launch"])
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .output()
                    .await?;
                if !install_default.status.success() {
                    let stderr = String::from_utf8_lossy(&install_default.stderr);
                    anyhow::bail!("Failed to install WSL2 base distro: {stderr}");
                }
                // Export-and-reimport the just-installed Ubuntu-24.04
                // into our marker distro name, then unregister the
                // default-named one (which we created this run).
                let tmp_tar = tempfile::Builder::new()
                    .prefix("orca-wsl-base-")
                    .suffix(".tar")
                    .tempfile()?;
                let tar_path_str = tmp_tar
                    .path()
                    .to_str()
                    .ok_or_else(|| anyhow::anyhow!("invalid tarball path"))?
                    .to_string();
                let export = Command::new("wsl.exe")
                    .args(["--export", "Ubuntu-24.04", &tar_path_str])
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .output()
                    .await?;
                if !export.status.success() {
                    let stderr = String::from_utf8_lossy(&export.stderr);
                    anyhow::bail!("Failed to export freshly-installed base: {stderr}");
                }
                let base_dest = dirs::data_dir()
                    .ok_or_else(|| anyhow::anyhow!("cannot resolve data_dir"))?
                    .join("orca")
                    .join("wsl")
                    .join(base_name);
                tokio::fs::create_dir_all(&base_dest).await?;
                let import_base = Command::new("wsl.exe")
                    .args([
                        "--import",
                        base_name,
                        base_dest.to_str().ok_or_else(|| anyhow::anyhow!("invalid dest dir"))?,
                        &tar_path_str,
                        "--version",
                        "2",
                    ])
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .output()
                    .await?;
                if !import_base.status.success() {
                    let stderr = String::from_utf8_lossy(&import_base.stderr);
                    anyhow::bail!("Failed to import base under orca name: {stderr}");
                }
                // We created this default-named distro in this run — it
                // is ours to remove.
                let _ = Command::new("wsl.exe")
                    .args(["--unregister", "Ubuntu-24.04"])
                    .output()
                    .await;
                // tempfile Drop removes `tmp_tar`.
            }

            // Seal the freshly-provisioned base as Orca's by writing the
            // marker file. This MUST happen before the first export below
            // so future `create` calls can verify ownership and never
            // silently piggyback on a user-created same-named distro.
            ensure_orca_base_marker(base_name).await?;
        }

        // 2. Export our orca-owned base to a tarball, then import under
        //    `config.name` into a distro-specific data dir. We only ever
        //    export from a distro we own.
        //
        //    Use tempfile::NamedTempFile so the path is unguessable and
        //    Drop cleans it up even on panic — the previous predictable
        //    `/tmp/orca-wsl-<name>.tar` path let a local attacker
        //    pre-create a symlink to redirect the export, or race us to
        //    replace the tar with a malicious one before the import.
        let tmp_tar = tempfile::Builder::new().prefix("orca-wsl-").suffix(".tar").tempfile()?;
        let tar_path_str = tmp_tar
            .path()
            .to_str()
            .ok_or_else(|| anyhow::anyhow!("invalid tarball path"))?
            .to_string();
        let dest_dir = dirs::data_dir()
            .ok_or_else(|| anyhow::anyhow!("cannot resolve data_dir"))?
            .join("orca")
            .join("wsl")
            .join(&distro_name);
        tokio::fs::create_dir_all(&dest_dir).await?;

        let export = Command::new("wsl.exe")
            .args(["--export", base_name, &tar_path_str])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .await?;
        if !export.status.success() {
            let stderr = String::from_utf8_lossy(&export.stderr);
            anyhow::bail!("Failed to export WSL base image: {stderr}");
        }

        let import = Command::new("wsl.exe")
            .args([
                "--import",
                &distro_name,
                dest_dir.to_str().ok_or_else(|| anyhow::anyhow!("invalid dest dir"))?,
                &tar_path_str,
                "--version",
                "2",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .await?;
        // Explicit drop of `tmp_tar` happens at end of scope — no manual
        // remove needed; Drop handles it on both success and panic.
        drop(tmp_tar);
        if !import.status.success() {
            let stderr = String::from_utf8_lossy(&import.stderr);
            anyhow::bail!("Failed to import WSL distro: {stderr}");
        }

        // Configure memory and CPU limits via .wslconfig (merging with any
        // existing user config).
        self.configure_wsl_resources(&config).await?;

        // 3. Provision. All subsequent commands MUST run as root — the
        //    default user created by Ubuntu can't apt-get install or edit
        //    /etc/*. wsl_exec now always uses `--user root`.
        wsl_exec(&distro_name, "echo 'Distro started'").await?;

        // Install container runtime
        let runtime_install = match config.runtime {
            RuntimeKind::Podman => "set -euo pipefail; apt-get update -qq && apt-get install -y -qq podman",
            RuntimeKind::Docker => {
                // curl|sh with pipefail so a failing curl aborts instead of
                // silently running an empty installer.
                "set -euo pipefail; curl -fsSL https://get.docker.com -o /tmp/get-docker.sh && sh /tmp/get-docker.sh && rm -f /tmp/get-docker.sh"
            }
        };
        wsl_exec(&distro_name, runtime_install).await?;

        // Set up host.docker.internal DNS
        wsl_exec(
            &distro_name,
            r#"set -euo pipefail
HOST_IP=$(awk '/nameserver/{print $2; exit}' /etc/resolv.conf)
if ! grep -q host.docker.internal /etc/hosts; then
    echo "$HOST_IP host.docker.internal" >> /etc/hosts
fi"#,
        )
        .await?;

        // Configure Docker daemon for DNS and port forwarding. Write via
        // `tee` reading from stdin so we don't have to wrestle with
        // indented-heredoc terminator rules (the previous form used a
        // non-tabbed heredoc whose closing `EOF` was indented, which made
        // bash consume the rest of the command as heredoc content).
        let daemon_json = r#"{
  "iptables": true,
  "ip-forward": true,
  "dns": ["8.8.8.8", "8.8.4.4"]
}"#;
        let write_cmd = format!(
            "set -euo pipefail; mkdir -p /etc/docker && cat > /etc/docker/daemon.json <<'ORCA_EOF'\n{daemon_json}\nORCA_EOF"
        );
        wsl_exec(&distro_name, &write_cmd).await?;

        self.inspect(&distro_name).await
    }

    async fn start(&self, name: &str) -> anyhow::Result<()> {
        validate_distro_name(name)?;
        // WSL2 distros start on first access — just run a dummy command
        wsl_exec(name, "echo started").await?;

        // Start the container runtime
        wsl_exec(
            name,
            "if command -v dockerd &>/dev/null; then \
                nohup dockerd &>/dev/null & \
             elif command -v podman &>/dev/null; then \
                nohup podman system service --time=0 unix:///var/run/docker.sock &>/dev/null & \
             fi",
        )
        .await?;

        Ok(())
    }

    async fn stop(&self, name: &str) -> anyhow::Result<()> {
        validate_distro_name(name)?;
        let output = Command::new("wsl.exe")
            .args(["--terminate", name])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .await?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            anyhow::bail!("Failed to stop WSL2 distro '{name}': {stderr}");
        }
        Ok(())
    }

    async fn kill(&self, name: &str) -> anyhow::Result<()> {
        self.stop(name).await
    }

    async fn delete(&self, name: &str) -> anyhow::Result<()> {
        // Refuse to delete Orca's shared base image cache. If we let this
        // through, the next `create` has to re-download ~500MB of Ubuntu
        // and the user loses any in-flight provision work on another
        // distro that depends on the cache. `validate_distro_name` also
        // rejects `orca-base-*` names, but we keep an explicit guard
        // here so the error message is specific rather than a generic
        // "reserved name" complaint.
        if name.to_ascii_lowercase().starts_with(ORCA_BASE_PREFIX) {
            tracing::warn!(
                "Refusing to delete Orca-owned base distro '{name}'. \
                 If you truly want to remove it, run `wsl --unregister {name}` manually."
            );
            anyhow::bail!(
                "Refusing to delete '{name}': it is Orca's internal base image cache. \
                 Run `wsl --unregister {name}` manually if you really want to remove it."
            );
        }
        validate_distro_name(name)?;
        // Log any stop failure instead of swallowing it silently so a
        // stuck/crashing stop path is visible in the daemon log.
        if let Err(e) = self.stop(name).await {
            tracing::warn!("WSL delete: stop('{name}') failed (continuing): {e}");
        }

        let output = Command::new("wsl.exe")
            .args(["--unregister", name])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .await?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            anyhow::bail!("Failed to delete WSL2 distro '{name}': {stderr}");
        }
        Ok(())
    }

    async fn inspect(&self, name: &str) -> anyhow::Result<MachineInfo> {
        let machines = self.list().await?;
        machines
            .into_iter()
            .find(|m| m.name == name)
            .ok_or_else(|| anyhow::anyhow!("WSL2 distro '{name}' not found"))
    }

    async fn list(&self) -> anyhow::Result<Vec<MachineInfo>> {
        // wsl.exe --list emits UTF-16LE by default; setting WSL_UTF8=1
        // makes it emit UTF-8 so our lossy-UTF-8 decoder actually sees
        // the distro names. Without this the output is all replacement
        // characters and every parse fails.
        let output = Command::new("wsl.exe")
            .env("WSL_UTF8", "1")
            .args(["--list", "--verbose"])
            .stdout(Stdio::piped())
            .output()
            .await?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut machines = Vec::new();

        // Parse wsl.exe --list --verbose output:
        //   NAME   STATE   VERSION
        // * Ubuntu Running 2
        //   orca   Stopped 2
        for line in stdout.lines().skip(1) {
            let line = line.trim().trim_start_matches('*').trim();
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 3 {
                let name = parts[0].to_string();
                let state = match parts[1] {
                    "Running" => MachineState::Running,
                    "Stopped" => MachineState::Stopped,
                    "Installing" | "Starting" => MachineState::Starting,
                    "Stopping" | "Uninstalling" => MachineState::Stopping,
                    other => {
                        tracing::debug!("WSL distro '{name}' has unrecognised state '{other}'");
                        MachineState::Error
                    }
                };
                let version: u32 = parts[2].parse().unwrap_or(2);

                // Only show WSL2 distros
                if version == 2 {
                    machines.push(MachineInfo {
                        name: name.clone(),
                        state,
                        config: MachineConfig {
                            name,
                            cpus: 0,      // WSL2 doesn't expose per-distro CPU info
                            memory_mb: 0, // set via .wslconfig globally
                            disk_gb: 0,
                            runtime: RuntimeKind::Docker,
                            mounts: vec![],
                        },
                        backend: MachineBackend::Wsl2,
                    });
                }
            }
        }

        Ok(machines)
    }

    async fn runtime_socket(&self, _name: &str) -> anyhow::Result<PathBuf> {
        // Windows does not expose a Unix socket from WSL2 to the host.
        // Returning a fabricated named-pipe path here (as earlier
        // revisions did) caused downstream callers to spend time trying
        // to open a pipe that nothing creates, producing confusing
        // "file not found" / connect failures far from the root cause.
        // Fail fast with a helpful message so callers immediately know
        // to use `DOCKER_HOST` or the WSL TCP forwarder instead.
        anyhow::bail!("Windows runtime has no Unix-socket; connect via DOCKER_HOST or WSL TCP forwarder")
    }
}

impl WindowsBackend {
    /// Write Orca's WSL resource settings into the user's `.wslconfig`
    /// while PRESERVING any existing settings under other sections or keys.
    /// Previously we overwrote the entire file, wiping out user-authored
    /// `[experimental]` blocks, custom kernels, etc.
    async fn configure_wsl_resources(&self, config: &MachineConfig) -> anyhow::Result<()> {
        let home = dirs::home_dir().ok_or_else(|| anyhow::anyhow!("cannot resolve home dir"))?;
        let wslconfig_path = home.join(".wslconfig");

        // Read existing, split into sections. Very small parser — enough
        // for typical `.wslconfig` files that are a handful of flat
        // `key=value` pairs under `[wsl2]` and maybe `[experimental]`.
        let existing = tokio::fs::read_to_string(&wslconfig_path).await.unwrap_or_default();

        #[derive(Default)]
        struct Section {
            name: String,
            entries: Vec<(String, String)>,
        }
        let mut sections: Vec<Section> = Vec::new();
        let mut current = Section {
            name: String::new(),
            entries: Vec::new(),
        };
        for line in existing.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with(';') {
                continue;
            }
            if let Some(rest) = trimmed.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
                if !current.name.is_empty() || !current.entries.is_empty() {
                    sections.push(std::mem::take(&mut current));
                }
                current.name = rest.to_string();
            } else if let Some((k, v)) = trimmed.split_once('=') {
                current.entries.push((k.trim().to_string(), v.trim().to_string()));
            }
        }
        if !current.name.is_empty() || !current.entries.is_empty() {
            sections.push(current);
        }

        // Upsert keys we own under [wsl2]. Leave other sections alone.
        let wsl2 = sections.iter_mut().find(|s| s.name == "wsl2");
        let ours = [
            ("memory".to_string(), format!("{}MB", config.memory_mb)),
            ("processors".to_string(), config.cpus.to_string()),
            ("swap".to_string(), "0".to_string()),
            ("networkingMode".to_string(), "mirrored".to_string()),
            ("dnsTunneling".to_string(), "true".to_string()),
            ("autoProxy".to_string(), "true".to_string()),
        ];
        match wsl2 {
            Some(sec) => {
                for (k, v) in ours {
                    if let Some(existing) = sec.entries.iter_mut().find(|(ek, _)| ek == &k) {
                        existing.1 = v;
                    } else {
                        sec.entries.push((k, v));
                    }
                }
            }
            None => {
                sections.push(Section {
                    name: "wsl2".to_string(),
                    entries: ours.to_vec(),
                });
            }
        }

        // Serialise back.
        let mut out = String::new();
        for s in sections {
            if !s.name.is_empty() {
                out.push_str(&format!("[{}]\n", s.name));
            }
            for (k, v) in s.entries {
                out.push_str(&format!("{k}={v}\n"));
            }
            out.push('\n');
        }

        // Write atomically: temp sibling + rename.
        let tmp = wslconfig_path.with_extension("wslconfig.orca-new");
        tokio::fs::write(&tmp, out).await?;
        tokio::fs::rename(&tmp, &wslconfig_path).await?;
        Ok(())
    }
}

/// Execute a command inside a WSL2 distro AS ROOT. All of Orca's
/// provisioning steps (apt-get install, writing /etc/*, systemd edits)
/// require root; running as the default user silently fails.
async fn wsl_exec(distro: &str, command: &str) -> anyhow::Result<String> {
    let output = Command::new("wsl.exe")
        .env("WSL_UTF8", "1")
        .args(["-d", distro, "--user", "root", "--", "bash", "-c", command])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("WSL exec failed: {stderr}");
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Drop Orca's marker file inside a just-provisioned base distro. The
/// marker proves the distro was created by Orca so future runs can tell
/// it apart from a same-named user distro. Owned by root, mode 0644.
async fn ensure_orca_base_marker(distro: &str) -> anyhow::Result<()> {
    // Write via a heredoc so the content is never interpolated by the
    // shell, then chmod to the intended mode. The file lives under /etc
    // which is root-owned, so the file ends up root-owned too (wsl_exec
    // runs as root).
    let cmd = format!(
        "set -euo pipefail; cat > {path} <<'ORCA_MARKER_EOF'\n{content}\nORCA_MARKER_EOF\nchmod 0644 {path}",
        path = ORCA_BASE_MARKER_PATH,
        content = ORCA_BASE_MARKER_CONTENT,
    );
    wsl_exec(distro, &cmd).await.map(|_| ())
}

/// Return true iff the distro carries Orca's ownership marker. Any
/// failure to exec into the distro, or a non-zero exit from `test -f`,
/// is treated as "not ours" — we would rather re-install than wrongly
/// reuse a user distro.
async fn verify_orca_base_marker(distro: &str) -> bool {
    let output = Command::new("wsl.exe")
        .env("WSL_UTF8", "1")
        .args([
            "-d",
            distro,
            "--user",
            "root",
            "--",
            "test",
            "-f",
            ORCA_BASE_MARKER_PATH,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await;
    match output {
        Ok(o) => o.status.success(),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_normal_names() {
        validate_distro_name("orca").unwrap();
        validate_distro_name("my-dev-box").unwrap();
        validate_distro_name("box_01").unwrap();
        validate_distro_name("Ubuntu-24.04-ish").unwrap_err(); // '.' is not allowed
    }

    #[test]
    fn rejects_reserved_orca_base_name() {
        // The canonical Orca-owned name "orca-base-Ubuntu-24.04" contains
        // a '.' that the charset check rejects before the reserved-prefix
        // check fires. Either rejection path is acceptable — we just
        // require that the name is never accepted by `validate_distro_name`.
        validate_distro_name("orca-base-Ubuntu-24.04").unwrap_err();
    }

    #[test]
    fn rejects_any_orca_base_prefix() {
        // These names pass the charset check and are rejected specifically
        // because of the reserved-prefix rule — assert the error message
        // mentions "reserved" so we know that rule is doing the work.
        let err = validate_distro_name("orca-base-foo").unwrap_err();
        assert!(err.to_string().contains("reserved"));
        validate_distro_name("orca-base-").unwrap_err();
        // Case-insensitive.
        let err2 = validate_distro_name("Orca-Base-Foo").unwrap_err();
        assert!(err2.to_string().contains("reserved"));
        validate_distro_name("ORCA-BASE-X").unwrap_err();
    }

    #[test]
    fn rejects_empty_and_too_long() {
        validate_distro_name("").unwrap_err();
        validate_distro_name(&"a".repeat(65)).unwrap_err();
    }

    #[test]
    fn rejects_leading_dash_or_dot() {
        validate_distro_name("-foo").unwrap_err();
        validate_distro_name(".foo").unwrap_err();
    }

    #[test]
    fn rejects_invalid_chars() {
        validate_distro_name("foo bar").unwrap_err();
        validate_distro_name("foo/bar").unwrap_err();
        validate_distro_name("foo$bar").unwrap_err();
    }
}
