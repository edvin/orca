//! Orca's own engine on Windows: Docker in a WSL distro of Orca's own,
//! `orca`, made from Ubuntu's WSL image. Never Docker Desktop's engine, and
//! nothing installed into the user's own distros.
//!
//! - **Reaching the engine.** dockerd listens on its socket in the distro and
//!   on `127.0.0.1:2376`, which WSL forwards to Windows. That port only takes
//!   clients with a certificate from Orca's own engine CA (mutual TLS), so
//!   other programs on the machine can't drive Docker as root through it.
//! - **The CLI.** `docker` and `docker compose` run inside the distro (see
//!   [`for_engine`]), so no `docker.exe` is needed on Windows, and compose
//!   sees paths as the engine does.
//! - **Folders.** `C:\…` is `/mnt/c/…` in the distro, as in any WSL distro. A
//!   folder inside another distro (`\\wsl.localhost\Ubuntu\home\me\app`) is
//!   reached through WSL's shared `/mnt/wsl`: Orca bind-mounts that distro's
//!   root at `/mnt/wsl/orca/distros/<name>`, which every distro in the WSL VM
//!   sees, the engine's included. Nothing is written in that distro.
//! - **Staying up.** WSL stops a distro soon after its last process exits,
//!   systemd services or not, so the daemon keeps a `sleep` running in it.

use std::path::{Path, PathBuf};

use anyhow::Result;

/// The distro Orca's engine runs in.
pub const DISTRO: &str = "orca";
/// The engine's TLS port, on 127.0.0.1 in the distro and on Windows.
pub const PORT: u16 = 2376;
/// The Ubuntu release the distro is made from: the current LTS. Each new
/// distro gets its latest point release (see [`pick_image`]).
pub const UBUNTU_RELEASE: &str = "26.04";
/// Where Ubuntu publishes its WSL images and their checksums.
pub const IMAGE_BASE: &str = "https://releases.ubuntu.com/26.04/";
/// Where other distros' roots are bind-mounted, under WSL's shared `/mnt/wsl`.
pub const DISTROS_DIR: &str = "/mnt/wsl/orca/distros";
/// Raised when what the distro is made with changes, so an older one can be
/// offered a rebuild (as `ORCA_VM_GENERATION` on macOS).
pub const GENERATION: u32 = 1;

/// Where the distro's disk, the downloaded image and the engine's
/// certificates live: `%LOCALAPPDATA%\orca-engine`. Not under
/// `%LOCALAPPDATA%\orca`, which the uninstaller removes: the distro's disk
/// holds the user's images and volumes.
pub fn data_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("orca-engine")
}

/// The engine's certificates (see [`ensure_certs`]).
pub fn certs_dir() -> PathBuf {
    data_dir().join("certs")
}

/// The engine's address for clients on Windows.
pub fn address() -> String {
    format!("tcp://127.0.0.1:{PORT}")
}

/// The newest point release of [`UBUNTU_RELEASE`]'s amd64 WSL image in a
/// `SHA256SUMS` file: `(file name, sha256)`.
pub fn pick_image(sums: &str) -> Option<(String, String)> {
    let prefix = format!("ubuntu-{UBUNTU_RELEASE}");
    sums.lines()
        .filter_map(|l| {
            let (sha, name) = l.split_once(char::is_whitespace)?;
            let name = name.trim().trim_start_matches('*');
            let point = name.strip_prefix(&prefix)?.strip_suffix("-wsl-amd64.wsl")?;
            // "" for the release itself, ".1" for 26.04.1, …
            let n: u32 = if point.is_empty() {
                0
            } else {
                point.strip_prefix('.')?.parse().ok()?
            };
            (sha.len() == 64 && sha.chars().all(|c| c.is_ascii_hexdigit()))
                .then(|| (n, name.to_string(), sha.to_lowercase()))
        })
        .max_by_key(|(n, _, _)| *n)
        .map(|(_, name, sha)| (name, sha))
}

/// A Windows folder as the engine's distro sees it: `C:\code\app` is
/// `/mnt/c/code/app`, `\\wsl.localhost\Ubuntu\home\me\app` (or `\\wsl$\…`)
/// is `/mnt/wsl/orca/distros/Ubuntu/home/me/app`, and a folder in Orca's own
/// distro is its own path. A Linux path is taken as it is.
pub fn engine_path(path: &str) -> Option<String> {
    if path.starts_with('/') {
        return Some(path.to_string());
    }
    let p = path.replace('\\', "/");
    for unc in ["//wsl.localhost/", "//wsl$/"] {
        if p.len() >= unc.len() && p[..unc.len()].eq_ignore_ascii_case(unc) {
            let rest = &p[unc.len()..];
            let (distro, inner) = rest.split_once('/').unwrap_or((rest, ""));
            if !valid_distro_name(distro) {
                return None;
            }
            let inner = inner.trim_end_matches('/');
            return Some(if distro.eq_ignore_ascii_case(DISTRO) {
                format!("/{inner}")
            } else {
                format!("{DISTROS_DIR}/{distro}/{inner}").trim_end_matches('/').to_string()
            });
        }
    }
    let mut chars = p.chars();
    let (drive, colon) = (chars.next()?, chars.next()?);
    if !drive.is_ascii_alphabetic() || colon != ':' || !(p.len() == 2 || p[2..].starts_with('/')) {
        return None;
    }
    let rest = p[2..].trim_end_matches('/');
    Some(format!("/mnt/{}{rest}", drive.to_ascii_lowercase()))
}

/// The other distro a path inside `/mnt/wsl/orca/distros/` is in.
pub fn distro_of(engine_path: &str) -> Option<&str> {
    engine_path
        .strip_prefix(DISTROS_DIR)?
        .strip_prefix('/')?
        .split('/')
        .next()
        .filter(|d| !d.is_empty())
}

/// One command-line argument as the engine sees it: a Windows path, or an
/// argument carrying one (`--env-file=C:\…`, a `-v C:\src:/dst` mount),
/// translated with [`engine_path`]; anything else as it is.
pub fn engine_arg(arg: &str) -> String {
    if let Some(p) = engine_path_strict(arg) {
        return p;
    }
    // --flag=C:\path
    if let Some((flag, value)) = arg.split_once('=')
        && flag.starts_with('-')
        && let Some(p) = engine_path_strict(value)
    {
        return format!("{flag}={p}");
    }
    // C:\src:/dst[:ro], a bind mount
    if arg.len() > 3 {
        let p = arg.replace('\\', "/");
        if let Some(i) = p[2..].find(":/").map(|i| i + 2) {
            let (src, rest) = (&arg[..i], &arg[i..]);
            if let Some(s) = engine_path_strict(src) {
                return format!("{s}{rest}");
            }
        }
    }
    arg.to_string()
}

/// [`engine_path`] for Windows paths only: a Linux path or a relative one
/// isn't a path to translate in an argument.
fn engine_path_strict(s: &str) -> Option<String> {
    if s.starts_with('/') {
        return None;
    }
    engine_path(s)
}

/// An environment variable as the engine sees it: `COMPOSE_FILE`'s Windows
/// list (`;`) becomes a Linux one (`:`) with its paths translated, and the
/// separator variable that goes with it is dropped. `None` drops a variable.
pub fn engine_env(key: &str, value: &str) -> Option<String> {
    match key {
        "COMPOSE_PATH_SEPARATOR" => None,
        "COMPOSE_FILE" => Some(
            value
                .split([';', ':'].as_ref())
                .filter(|s| !s.is_empty())
                .fold((Vec::<String>::new(), None::<String>), |(mut out, drive), part| {
                    // "C" then "\x\compose.yaml" when a drive letter was split on ':'.
                    match drive {
                        Some(d) => out.push(engine_path(&format!("{d}:{part}")).unwrap_or(part.to_string())),
                        None if part.len() == 1 && part.chars().all(|c| c.is_ascii_alphabetic()) => {
                            return (out, Some(part.to_string()));
                        }
                        None => out.push(engine_path_strict(part).unwrap_or_else(|| part.to_string())),
                    }
                    (out, None)
                })
                .0
                .join(":"),
        ),
        // Windows' own variables mean nothing in the distro.
        "PATH" | "Path" | "PATHEXT" | "SystemRoot" | "COMSPEC" | "TEMP" | "TMP" | "USERPROFILE" | "APPDATA"
        | "LOCALAPPDATA" | "DOCKER_HOST" | "DOCKER_TLS_VERIFY" | "DOCKER_CERT_PATH" | "DOCKER_CONTEXT" => None,
        _ => Some(engine_path_strict(value).unwrap_or_else(|| value.to_string())),
    }
}

/// The `wsl.exe` arguments that run `program args…` in Orca's distro, in
/// `cwd`, with `envs`: `-d orca --cd <dir> --exec env K=V … program args…`.
/// `--exec` runs it without a shell, so arguments arrive as they are.
pub fn engine_invocation(
    program: &str,
    args: &[String],
    cwd: Option<&str>,
    envs: &[(String, Option<String>)],
) -> Vec<String> {
    let mut out = vec!["-d".to_string(), DISTRO.to_string(), "-u".to_string(), "root".to_string()];
    if let Some(dir) = cwd.and_then(engine_path) {
        out.push("--cd".into());
        out.push(dir);
    }
    out.push("--exec".into());
    out.push("env".into());
    for (k, v) in envs {
        if let Some(v) = v.as_deref().and_then(|v| engine_env(k, v)) {
            out.push(format!("{k}={v}"));
        }
    }
    out.push(program.to_string());
    out.extend(args.iter().map(|a| engine_arg(a)));
    out
}

/// Runs a `docker`/`podman` command where the engine is: on Windows inside
/// Orca's distro, with its working folder, environment and path arguments as
/// the engine sees them; elsewhere as it is. Call it after the program,
/// arguments, folder and environment, and before stdin/stdout, which aren't
/// carried over on Windows.
pub trait OnEngine {
    fn on_engine(&mut self) -> tokio::process::Command;
}

impl OnEngine for tokio::process::Command {
    fn on_engine(&mut self) -> tokio::process::Command {
        let cmd = std::mem::replace(self, tokio::process::Command::new("true"));
        for_engine(cmd)
    }
}

/// [`OnEngine::on_engine`] on an owned command.
pub fn for_engine(cmd: tokio::process::Command) -> tokio::process::Command {
    if !cfg!(windows) {
        return cmd;
    }
    let std = cmd.as_std();
    let program = std.get_program().to_string_lossy().to_string();
    let program = Path::new(&program)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or(program);
    let args: Vec<String> = std.get_args().map(|a| a.to_string_lossy().to_string()).collect();
    let cwd = std.get_current_dir().map(|d| d.to_string_lossy().to_string());
    let envs: Vec<(String, Option<String>)> = std
        .get_envs()
        .map(|(k, v)| (k.to_string_lossy().to_string(), v.map(|v| v.to_string_lossy().to_string())))
        .collect();
    let mut out = tokio::process::Command::new("wsl.exe");
    out.args(engine_invocation(&program, &args, cwd.as_deref(), &envs))
        // wsl.exe's own messages in UTF-8, not UTF-16.
        .env("WSL_UTF8", "1");
    #[cfg(windows)]
    {
        out.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    out
}

/// The files the daemon and the engine need for mutual TLS.
pub struct Certs {
    pub dir: PathBuf,
}

impl Certs {
    pub fn ca(&self) -> PathBuf {
        self.dir.join("ca.pem")
    }
    /// The client certificate and key, as the docker CLI names them.
    pub fn cert(&self) -> PathBuf {
        self.dir.join("cert.pem")
    }
    pub fn key(&self) -> PathBuf {
        self.dir.join("key.pem")
    }
    pub fn server_cert(&self) -> PathBuf {
        self.dir.join("server-cert.pem")
    }
    pub fn server_key(&self) -> PathBuf {
        self.dir.join("server-key.pem")
    }
}

/// Make the engine's own CA, its server certificate (for 127.0.0.1 and
/// localhost) and the client certificate the daemon uses, once. Existing
/// files are kept, so the engine and its clients keep matching.
pub fn ensure_certs(dir: &Path) -> Result<Certs> {
    let certs = Certs { dir: dir.to_path_buf() };
    let all = [certs.ca(), certs.cert(), certs.key(), certs.server_cert(), certs.server_key()];
    if all.iter().all(|p| p.exists()) {
        return Ok(certs);
    }
    std::fs::create_dir_all(dir)?;
    let now = time::OffsetDateTime::now_utc();
    let later = now + time::Duration::days(365 * 20);

    let mut ca = rcgen::CertificateParams::new(Vec::<String>::new())?;
    ca.distinguished_name.push(rcgen::DnType::CommonName, "Orca engine CA");
    ca.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    ca.key_usages = vec![rcgen::KeyUsagePurpose::KeyCertSign, rcgen::KeyUsagePurpose::CrlSign];
    ca.not_before = now;
    ca.not_after = later;
    let ca_key = rcgen::KeyPair::generate()?;
    let ca_cert = ca.self_signed(&ca_key)?;

    let mut server = rcgen::CertificateParams::new(vec!["localhost".to_string()])?;
    server.subject_alt_names.push(rcgen::SanType::IpAddress(std::net::IpAddr::V4(
        std::net::Ipv4Addr::LOCALHOST,
    )));
    server.distinguished_name.push(rcgen::DnType::CommonName, "Orca engine");
    server.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ServerAuth];
    server.not_before = now;
    server.not_after = later;
    let server_key = rcgen::KeyPair::generate()?;
    let server_cert = server.signed_by(&server_key, &ca_cert, &ca_key)?;

    let mut client = rcgen::CertificateParams::new(Vec::<String>::new())?;
    client.distinguished_name.push(rcgen::DnType::CommonName, "Orca");
    client.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ClientAuth];
    client.not_before = now;
    client.not_after = later;
    let client_key = rcgen::KeyPair::generate()?;
    let client_cert = client.signed_by(&client_key, &ca_cert, &ca_key)?;

    // The CA's key isn't kept: nothing else is ever signed with it.
    std::fs::write(certs.ca(), ca_cert.pem())?;
    std::fs::write(certs.server_cert(), server_cert.pem())?;
    std::fs::write(certs.server_key(), server_key.serialize_pem())?;
    std::fs::write(certs.cert(), client_cert.pem())?;
    std::fs::write(certs.key(), client_key.serialize_pem())?;
    Ok(certs)
}

/// Sets up the distro, as root: no first-run user prompt, systemd, Docker
/// Engine from Docker's own packages, and dockerd on its socket and on the
/// TLS port. The server certificate is in `/etc/docker/orca/` already.
/// Idempotent, so it also repairs a distro.
pub fn provision_script() -> String {
    format!(
        r#"set -eu
export DEBIAN_FRONTEND=noninteractive
# No first-run prompt for a user: Orca's distro runs as root.
rm -f /etc/wsl-distribution.conf
# systemd, no Windows PATH (a docker.exe on it would shadow ours), root by default.
cat > /etc/wsl.conf <<'EOF'
[boot]
systemd=true
[interop]
appendWindowsPath=false
[user]
default=root
EOF
if ! command -v dockerd >/dev/null 2>&1; then
  apt-get update -q
  apt-get install -y -q ca-certificates curl
  curl -fsSL https://get.docker.com | sh
fi
command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 || apt-get install -y -q docker-compose-plugin
mkdir -p /etc/docker /etc/systemd/system/docker.service.d
cat > /etc/docker/daemon.json <<'EOF'
{{
  "hosts": ["unix:///var/run/docker.sock", "tcp://127.0.0.1:{PORT}"],
  "tls": true,
  "tlsverify": true,
  "tlscacert": "/etc/docker/orca/ca.pem",
  "tlscert": "/etc/docker/orca/server-cert.pem",
  "tlskey": "/etc/docker/orca/server-key.pem"
}}
EOF
# The packaged unit passes -H fd://, which clashes with "hosts" above.
cat > /etc/systemd/system/docker.service.d/orca.conf <<'EOF'
[Service]
ExecStart=
ExecStart=/usr/bin/dockerd --containerd=/run/containerd/containerd.sock
EOF
chmod 600 /etc/docker/orca/server-key.pem
mkdir -p {DISTROS_DIR}
echo {GENERATION} > /etc/orca-generation
"#
    )
}

/// Run once systemd is up (after the distro restarted with it): start
/// Docker, now and on every start.
pub const START_SCRIPT: &str =
    "systemctl daemon-reload && systemctl enable containerd docker >/dev/null 2>&1; systemctl restart docker";

/// Run as root in another distro: bind its root into WSL's shared
/// `/mnt/wsl`, so the engine can reach folders in it. Undone when WSL shuts
/// down; nothing is installed or written in that distro.
pub fn share_script(distro: &str) -> String {
    let target = format!("{DISTROS_DIR}/{distro}");
    format!("mkdir -p '{target}' && (mountpoint -q '{target}' || mount --bind / '{target}')")
}

/// Whether `name` is a distro name Orca will put in a command.
pub fn valid_distro_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// Distro names from `wsl --list --quiet` (UTF-16 or UTF-8, with or
/// without a default marker).
pub fn parse_distros(out: &str) -> Vec<String> {
    out.lines()
        .map(|l| l.replace('\0', "").trim().trim_start_matches('*').trim().to_string())
        .filter(|l| valid_distro_name(l))
        .collect()
}

/// Whether a `wsl --version` output is at least `2.4.10`, which installs a
/// `.wsl` image with `--install --from-file`. Unknown counts as older.
pub fn wsl_can_install_from_file(version_out: &str) -> bool {
    version_out
        .lines()
        .find_map(|l| {
            let v = l.split(':').nth(1)?.trim();
            let mut n = v.split('.').map(|p| p.trim().parse::<u32>().ok());
            Some((n.next()??, n.next()??, n.next()?.unwrap_or(0)))
        })
        .is_some_and(|v| v >= (2, 4, 10))
}

// --- Windows: making, starting and reaching the distro --------------------------

#[cfg(windows)]
pub use win::*;

#[cfg(windows)]
mod win {
    use super::*;
    use anyhow::Context;
    use std::process::Stdio;
    use std::time::Duration;
    use tokio::io::AsyncWriteExt;
    use tokio::process::Command;

    const NO_WINDOW: u32 = 0x08000000;

    fn wsl() -> Command {
        let mut c = Command::new("wsl.exe");
        c.env("WSL_UTF8", "1").creation_flags(NO_WINDOW);
        c
    }

    /// `wsl.exe args…`: its output, or what it said went wrong.
    pub async fn run(args: &[&str]) -> Result<String> {
        let out = wsl()
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .await
            .context("could not run wsl.exe")?;
        let text = |b: &[u8]| String::from_utf8_lossy(b).replace('\0', "").trim().to_string();
        if out.status.success() {
            Ok(text(&out.stdout))
        } else {
            let (o, e) = (text(&out.stdout), text(&out.stderr));
            anyhow::bail!("{}", if e.is_empty() { o } else { e })
        }
    }

    /// A shell script run as root in `distro`, its input from `stdin`.
    pub async fn sh(distro: &str, script: &str, stdin: Option<&[u8]>) -> Result<String> {
        let mut child = wsl()
            .args(["-d", distro, "-u", "root", "--exec", "sh", "-c", script])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .context("could not run wsl.exe")?;
        let mut input = child.stdin.take().expect("piped");
        if let Some(bytes) = stdin {
            input.write_all(bytes).await?;
        }
        drop(input);
        let out = child.wait_with_output().await?;
        let text = |b: &[u8]| String::from_utf8_lossy(b).trim().to_string();
        if out.status.success() {
            Ok(text(&out.stdout))
        } else {
            anyhow::bail!("{}\n{}", text(&out.stdout), text(&out.stderr))
        }
    }

    pub async fn distros() -> Vec<String> {
        run(&["--list", "--quiet"]).await.map(|o| parse_distros(&o)).unwrap_or_default()
    }

    pub async fn running_distros() -> Vec<String> {
        run(&["--list", "--running", "--quiet"])
            .await
            .map(|o| parse_distros(&o))
            .unwrap_or_default()
    }

    pub async fn exists() -> bool {
        distros().await.iter().any(|d| d.eq_ignore_ascii_case(DISTRO))
    }

    /// The generation the distro was made with (0: older, or unreadable).
    pub async fn generation() -> u32 {
        sh(DISTRO, "cat /etc/orca-generation", None)
            .await
            .ok()
            .and_then(|s| s.trim().parse().ok())
            .unwrap_or(0)
    }

    static KEEPALIVE: std::sync::OnceLock<tokio::sync::Mutex<Option<tokio::process::Child>>> =
        std::sync::OnceLock::new();

    /// Start the distro and keep it running while the daemon does.
    pub async fn keep_running() {
        let slot = KEEPALIVE.get_or_init(|| tokio::sync::Mutex::new(None));
        let mut child = slot.lock().await;
        if let Some(c) = child.as_mut()
            && matches!(c.try_wait(), Ok(None))
        {
            return;
        }
        match wsl()
            .args(["-d", DISTRO, "-u", "root", "--exec", "sleep", "infinity"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(false)
            .spawn()
        {
            Ok(c) => *child = Some(c),
            Err(e) => tracing::warn!("Could not start the {DISTRO} distro: {e}"),
        }
    }

    /// A client for the engine, with the daemon's certificate.
    pub fn client(timeout: u64) -> Result<bollard::Docker> {
        let c = ensure_certs(&certs_dir())?;
        Ok(bollard::Docker::connect_with_ssl(
            &address(),
            &c.key(),
            &c.cert(),
            &c.ca(),
            timeout,
            bollard::API_DEFAULT_VERSION,
        )?)
    }

    /// Start the distro and wait up to `secs` for its engine to answer.
    pub async fn connect(secs: u64) -> Option<bollard::Docker> {
        if !exists().await {
            return None;
        }
        keep_running().await;
        let docker = client(120).ok()?;
        for _ in 0..secs.max(1) {
            if matches!(
                tokio::time::timeout(Duration::from_secs(2), docker.ping()).await,
                Ok(Ok(_))
            ) {
                share_distros().await;
                return Some(docker);
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        // Up but Docker isn't: ask systemd to start it once.
        let _ = sh(DISTRO, START_SCRIPT, None).await;
        for _ in 0..20 {
            if docker.ping().await.is_ok() {
                share_distros().await;
                return Some(docker);
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        None
    }

    /// Let the engine reach folders in the other running distros.
    pub async fn share_distros() {
        for d in running_distros().await {
            if d.eq_ignore_ascii_case(DISTRO) || d.starts_with("docker-desktop") {
                continue;
            }
            if let Err(e) = sh(&d, &share_script(&d), None).await {
                tracing::debug!("Could not share distro {d} with the engine: {e}");
            }
        }
    }

    /// Make the distro from Ubuntu's newest WSL image, set Docker up in it
    /// and start it. `say` reports progress.
    pub async fn create(say: &(dyn Fn(String) + Send + Sync)) -> Result<()> {
        let dir = data_dir();
        std::fs::create_dir_all(dir.join("images"))?;
        let certs = ensure_certs(&certs_dir())?;

        say(format!(">>> Finding Ubuntu {UBUNTU_RELEASE}'s newest WSL image"));
        let http = reqwest::Client::new();
        let sums = http
            .get(format!("{IMAGE_BASE}SHA256SUMS"))
            .send()
            .await?
            .error_for_status()?
            .text()
            .await?;
        let (name, sha) = pick_image(&sums).context("no Ubuntu WSL image in the release's checksums")?;
        let image = dir.join("images").join(&name);
        if !image.exists() || sha256_file(&image).await? != sha {
            say(format!("    Downloading {name}"));
            download(&http, &format!("{IMAGE_BASE}{name}"), &image, say).await?;
        }
        say("    Checking its checksum".into());
        let got = sha256_file(&image).await?;
        if got != sha {
            let _ = std::fs::remove_file(&image);
            anyhow::bail!("the download doesn't match Ubuntu's checksum (got {got}); try again");
        }

        say(format!(">>> Making the {DISTRO} distro"));
        let location = dir.join("distro");
        let image_s = image.to_string_lossy().to_string();
        let location_s = location.to_string_lossy().to_string();
        let version = run(&["--version"]).await.unwrap_or_default();
        if wsl_can_install_from_file(&version) {
            run(&[
                "--install", "--from-file", &image_s, "--name", DISTRO, "--location", &location_s, "--no-launch",
            ])
            .await?;
        } else {
            std::fs::create_dir_all(&location)?;
            run(&["--import", DISTRO, &location_s, &image_s, "--version", "2"]).await?;
        }

        say(">>> Setting up Docker (a few minutes)".into());
        sh(DISTRO, "mkdir -p /etc/docker/orca", None).await?;
        for (src, dst) in [
            (certs.ca(), "ca.pem"),
            (certs.server_cert(), "server-cert.pem"),
            (certs.server_key(), "server-key.pem"),
        ] {
            let bytes = std::fs::read(&src)?;
            sh(DISTRO, &format!("cat > /etc/docker/orca/{dst}"), Some(&bytes)).await?;
        }
        sh(DISTRO, &provision_script(), None).await.context("setting up Docker failed")?;

        say(">>> Starting it with systemd".into());
        run(&["--terminate", DISTRO]).await.ok();
        keep_running().await;
        sh(DISTRO, START_SCRIPT, None).await?;
        say(">>> Waiting for Docker".into());
        match connect(60).await {
            Some(d) => {
                let v = d.version().await.ok().and_then(|v| v.version).unwrap_or_default();
                say(format!("    Docker {v} is running in the {DISTRO} distro"));
                Ok(())
            }
            None => anyhow::bail!("Docker didn't answer on 127.0.0.1:{PORT}"),
        }
    }

    /// Set the distro up again in place (Docker, its settings, certificates),
    /// keeping its images and volumes.
    pub async fn repair(say: &(dyn Fn(String) + Send + Sync)) -> Result<()> {
        let certs = ensure_certs(&certs_dir())?;
        say(format!(">>> Repairing the {DISTRO} distro"));
        run(&["--terminate", DISTRO]).await.ok();
        sh(DISTRO, "mkdir -p /etc/docker/orca", None).await?;
        for (src, dst) in [
            (certs.ca(), "ca.pem"),
            (certs.server_cert(), "server-cert.pem"),
            (certs.server_key(), "server-key.pem"),
        ] {
            let bytes = std::fs::read(&src)?;
            sh(DISTRO, &format!("cat > /etc/docker/orca/{dst}"), Some(&bytes)).await?;
        }
        sh(DISTRO, &provision_script(), None).await?;
        run(&["--terminate", DISTRO]).await.ok();
        keep_running().await;
        sh(DISTRO, START_SCRIPT, None).await?;
        match connect(60).await {
            Some(_) => {
                say("    Docker is running".into());
                Ok(())
            }
            None => anyhow::bail!("Docker didn't answer on 127.0.0.1:{PORT}"),
        }
    }

    /// Delete the distro and everything in it.
    pub async fn remove() -> Result<()> {
        run(&["--unregister", DISTRO]).await.map(|_| ())
    }

    /// The IP Windows has as seen from the distro (WSL's NAT gateway), for
    /// `host.docker.internal`. `None` with mirrored networking, where
    /// containers reach Windows through the engine's `host-gateway`.
    pub async fn windows_ip() -> Option<String> {
        let route = sh(DISTRO, "ip route show default", None).await.ok()?;
        route
            .split_whitespace()
            .skip_while(|w| *w != "via")
            .nth(1)
            .filter(|ip| ip.parse::<std::net::Ipv4Addr>().is_ok())
            .map(str::to_string)
    }

    /// Bytes free for the engine: the least of what the distro's disk and
    /// the Windows drive it lives on have left (its disk grows into it).
    pub async fn free_bytes() -> Option<u64> {
        let in_distro: u64 = sh(DISTRO, "df -B1 --output=avail /var/lib/docker | tail -1", None)
            .await
            .ok()?
            .trim()
            .parse()
            .ok()?;
        let dir = data_dir();
        let disks = sysinfo::Disks::new_with_refreshed_list();
        let on_windows = disks
            .list()
            .iter()
            .filter(|d| dir.starts_with(d.mount_point()))
            .max_by_key(|d| d.mount_point().as_os_str().len())
            .map(|d| d.available_space());
        Some(on_windows.map_or(in_distro, |w| w.min(in_distro)))
    }

    async fn sha256_file(path: &Path) -> Result<String> {
        use sha2::Digest;
        let path = path.to_path_buf();
        tokio::task::spawn_blocking(move || {
            let mut f = std::fs::File::open(&path)?;
            let mut h = sha2::Sha256::new();
            std::io::copy(&mut f, &mut h)?;
            Ok(format!("{:x}", h.finalize()))
        })
        .await?
    }

    async fn download(
        http: &reqwest::Client,
        url: &str,
        to: &Path,
        say: &(dyn Fn(String) + Send + Sync),
    ) -> Result<()> {
        use futures_util::StreamExt;
        let res = http.get(url).send().await?.error_for_status()?;
        let total = res.content_length().unwrap_or(0);
        let part = to.with_extension("part");
        let mut file = tokio::fs::File::create(&part).await?;
        let mut stream = res.bytes_stream();
        let (mut got, mut shown) = (0u64, 0u64);
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            got += chunk.len() as u64;
            file.write_all(&chunk).await?;
            if total > 0 && got * 10 / total > shown {
                shown = got * 10 / total;
                say(format!("    {}%", shown * 10));
            }
        }
        file.flush().await?;
        drop(file);
        std::fs::rename(&part, to)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_the_newest_point_release() {
        let sums = "96c7f5fb28a7fe28245331f9bfbe4375f18dd29a4850116ad3c4f60f6700c55c *ubuntu-26.04-wsl-amd64.wsl\n\
                    48d56724b5c8e60f24893e83e73bbb58c60b3ca22fba3da977075420acd54104 *ubuntu-26.04.1-wsl-amd64.wsl\n\
                    1111111111111111111111111111111111111111111111111111111111111111 *ubuntu-26.04.1-desktop-amd64.iso\n";
        assert_eq!(
            pick_image(sums),
            Some((
                "ubuntu-26.04.1-wsl-amd64.wsl".into(),
                "48d56724b5c8e60f24893e83e73bbb58c60b3ca22fba3da977075420acd54104".into()
            ))
        );
        assert_eq!(pick_image("nothing here"), None);
    }

    #[test]
    fn windows_folders_as_the_engine_sees_them() {
        assert_eq!(engine_path(r"C:\Users\me\code\app").as_deref(), Some("/mnt/c/Users/me/code/app"));
        assert_eq!(engine_path(r"d:\work\").as_deref(), Some("/mnt/d/work"));
        assert_eq!(engine_path("C:/x").as_deref(), Some("/mnt/c/x"));
        assert_eq!(engine_path("C:").as_deref(), Some("/mnt/c"));
        assert_eq!(
            engine_path(r"\\wsl.localhost\Ubuntu\home\me\app").as_deref(),
            Some("/mnt/wsl/orca/distros/Ubuntu/home/me/app")
        );
        assert_eq!(
            engine_path(r"\\wsl$\Ubuntu-24.04\home\me").as_deref(),
            Some("/mnt/wsl/orca/distros/Ubuntu-24.04/home/me")
        );
        assert_eq!(engine_path(r"\\WSL.LOCALHOST\orca\srv\x").as_deref(), Some("/srv/x"));
        assert_eq!(engine_path("/home/me/app").as_deref(), Some("/home/me/app"));
        assert_eq!(engine_path(r"\\server\share\x"), None);
        assert_eq!(engine_path("relative"), None);
        assert_eq!(engine_path("a:b"), None);
    }

    #[test]
    fn arguments_with_windows_paths_are_translated() {
        assert_eq!(engine_arg(r"C:\code\app\compose.yaml"), "/mnt/c/code/app/compose.yaml");
        assert_eq!(engine_arg(r"--env-file=C:\code\.env"), "--env-file=/mnt/c/code/.env");
        assert_eq!(engine_arg(r"C:\code\data:/data:ro"), "/mnt/c/code/data:/data:ro");
        assert_eq!(engine_arg("/var/lib:/x"), "/var/lib:/x");
        assert_eq!(engine_arg("up"), "up");
        assert_eq!(engine_arg("-d"), "-d");
        assert_eq!(engine_arg("nginx:alpine"), "nginx:alpine");
        assert_eq!(engine_arg("app=1"), "app=1");
    }

    #[test]
    fn compose_file_lists_become_linux_lists() {
        assert_eq!(
            engine_env("COMPOSE_FILE", r"C:\a\compose.yaml;C:\a\.orca\databases.override.yaml").as_deref(),
            Some("/mnt/c/a/compose.yaml:/mnt/c/a/.orca/databases.override.yaml")
        );
        assert_eq!(
            engine_env("COMPOSE_FILE", "compose.yaml;.orca/databases.override.yaml").as_deref(),
            Some("compose.yaml:.orca/databases.override.yaml")
        );
        assert_eq!(engine_env("COMPOSE_PATH_SEPARATOR", ";"), None);
        assert_eq!(engine_env("PATH", r"C:\Windows"), None);
        assert_eq!(engine_env("COMPOSE_PROFILES", "web,db").as_deref(), Some("web,db"));
    }

    #[test]
    fn commands_run_in_the_distro() {
        let args: Vec<String> = ["compose", "-f", r"C:\code\app\compose.yaml", "up", "-d"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let inv = engine_invocation(
            "docker",
            &args,
            Some(r"C:\code\app"),
            &[("COMPOSE_PROFILES".into(), Some("web".into())), ("PATH".into(), Some("x".into()))],
        );
        assert_eq!(
            inv,
            [
                "-d", "orca", "-u", "root", "--cd", "/mnt/c/code/app", "--exec", "env", "COMPOSE_PROFILES=web",
                "docker", "compose", "-f", "/mnt/c/code/app/compose.yaml", "up", "-d"
            ]
        );
    }

    #[test]
    fn tells_which_distro_a_path_is_in() {
        assert_eq!(distro_of("/mnt/wsl/orca/distros/Ubuntu/home/me"), Some("Ubuntu"));
        assert_eq!(distro_of("/mnt/c/x"), None);
    }

    #[test]
    fn certs_are_made_once_and_kept() {
        let dir = std::env::temp_dir().join(format!("orca-certs-{}", rand::random::<u32>()));
        let c = ensure_certs(&dir).unwrap();
        let ca = std::fs::read_to_string(c.ca()).unwrap();
        assert!(ca.contains("BEGIN CERTIFICATE"));
        assert!(std::fs::read_to_string(c.key()).unwrap().contains("PRIVATE KEY"));
        let again = ensure_certs(&dir).unwrap();
        assert_eq!(std::fs::read_to_string(again.ca()).unwrap(), ca);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn distro_names_are_checked_before_use() {
        assert!(valid_distro_name("Ubuntu-24.04"));
        assert!(!valid_distro_name("x'; rm -rf /"));
        assert!(!valid_distro_name(""));
        assert_eq!(
            parse_distros("* Ubuntu\r\norca\r\ndocker-desktop\r\n\r\n"),
            ["Ubuntu", "orca", "docker-desktop"]
        );
        assert_eq!(parse_distros("U\0b\0u\0n\0t\0u\0\n\0"), ["Ubuntu"]);
    }

    #[test]
    fn knows_when_wsl_installs_wsl_images() {
        assert!(wsl_can_install_from_file("WSL version: 2.4.10.0\nKernel version: 6.6.36.6-1"));
        assert!(wsl_can_install_from_file("WSL-Version: 3.0.2.0"));
        assert!(!wsl_can_install_from_file("WSL version: 2.3.26.0"));
        assert!(!wsl_can_install_from_file(""));
    }

    #[test]
    fn the_setup_script_configures_tls_on_the_port() {
        let s = provision_script();
        assert!(s.contains("tcp://127.0.0.1:2376"));
        assert!(s.contains("\"tlsverify\": true"));
        assert!(s.contains("systemd=true"));
    }
}
