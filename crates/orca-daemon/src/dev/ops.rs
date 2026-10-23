//! Git and compose plumbing for dev instances.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use orca_core::dev::{ComposeModel, Worktree, worktree};
use orca_core::runtime::RuntimeKind;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;

use super::jobs::JobHandle;
use crate::state::AppState;

// --- git -----------------------------------------------------------------

async fn git(dir: &Path, args: &[&str]) -> Result<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .await
        .context("could not run git; is it installed?")?;
    if !out.status.success() {
        anyhow::bail!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Main working tree of the repo that `path` is in (any worktree or subfolder).
pub async fn main_root(path: &Path) -> Result<PathBuf> {
    let common = git(path, &["rev-parse", "--path-format=absolute", "--git-common-dir"])
        .await
        .map_err(|_| anyhow::anyhow!("{} is not inside a git repository", path.display()))?;
    let common = PathBuf::from(common);
    if common.file_name().is_some_and(|n| n == ".git") {
        let root = common
            .parent()
            .ok_or_else(|| anyhow::anyhow!("unexpected git dir {}", common.display()))?;
        return Ok(canonical(root));
    }
    anyhow::bail!(
        "{} belongs to a bare repository; register one of its worktrees' main checkout instead",
        path.display()
    )
}

/// Top of the worktree that `path` is in.
pub async fn worktree_root(path: &Path) -> Result<PathBuf> {
    let top = git(path, &["rev-parse", "--show-toplevel"]).await?;
    Ok(canonical(Path::new(&top)))
}

/// The repository's worktrees. Projects are listed every few seconds (the
/// Projects page, the dashboard, the tray), so the list is reused until git's
/// own files say a worktree was added, removed or moved to another commit.
pub async fn list_worktrees(root: &Path) -> Result<Vec<Worktree>> {
    type Cached = (Vec<(PathBuf, Option<std::time::SystemTime>)>, Instant, Vec<Worktree>);
    static CACHE: OnceLock<Mutex<std::collections::HashMap<PathBuf, Cached>>> = OnceLock::new();
    const MAX_AGE: Duration = Duration::from_secs(60);

    let fingerprint = worktrees_fingerprint(root);
    let cache = CACHE.get_or_init(Default::default);
    if let Some((fp, at, wts)) = cache.lock().await.get(root)
        && *fp == fingerprint
        && at.elapsed() < MAX_AGE
    {
        return Ok(wts.clone());
    }
    let out = git(root, &["worktree", "list", "--porcelain"]).await?;
    let mut wts = worktree::parse_porcelain(&out);
    for wt in &mut wts {
        wt.path = canonical(&wt.path);
    }
    cache
        .lock()
        .await
        .insert(root.to_path_buf(), (fingerprint, Instant::now(), wts.clone()));
    Ok(wts)
}

/// Modification times of the files `git worktree list` reads: each
/// worktree's HEAD and HEAD reflog (written on every commit, checkout and
/// reset), lock marker and location, and the folder that lists them.
fn worktrees_fingerprint(root: &Path) -> Vec<(PathBuf, Option<std::time::SystemTime>)> {
    let git_dir = root.join(".git");
    let mut files = vec![
        git_dir.join("HEAD"),
        git_dir.join("logs/HEAD"),
        git_dir.join("worktrees"),
    ];
    if let Ok(entries) = std::fs::read_dir(git_dir.join("worktrees")) {
        let mut dirs: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
        dirs.sort();
        for d in dirs {
            files.extend(["HEAD", "logs/HEAD", "locked", "gitdir"].map(|f| d.join(f)));
        }
    }
    files
        .into_iter()
        .map(|f| {
            let mtime = std::fs::metadata(&f).and_then(|m| m.modified()).ok();
            (f, mtime)
        })
        .collect()
}

/// Commits on `branch` that `base` doesn't have. `None` when it can't be told.
pub async fn commits_ahead(root: &Path, base: &str, branch: &str) -> Option<u32> {
    git(root, &["rev-list", "--count", &format!("{base}..{branch}")])
        .await
        .ok()?
        .parse()
        .ok()
}

/// Local branches whose remote branch is gone, usually because the pull
/// request was merged and the branch deleted.
pub async fn branches_with_gone_upstream(root: &Path) -> Vec<String> {
    git(
        root,
        &[
            "for-each-ref",
            "--format=%(refname:short)\t%(upstream:track)",
            "refs/heads",
        ],
    )
    .await
    .map(|out| {
        out.lines()
            .filter_map(|l| l.split_once('\t'))
            .filter(|(_, track)| track.contains("gone"))
            .map(|(b, _)| b.to_string())
            .collect()
    })
    .unwrap_or_default()
}

/// Whether the worktree has uncommitted changes (ignoring Orca's own folder).
/// `git status` scans the whole worktree, and the Projects page asks for
/// every instance every few seconds, so the answer is reused briefly.
pub async fn is_dirty(dir: &Path) -> bool {
    static CACHE: OnceLock<Mutex<std::collections::HashMap<PathBuf, (Instant, bool)>>> = OnceLock::new();
    const MAX_AGE: Duration = Duration::from_secs(15);

    let cache = CACHE.get_or_init(Default::default);
    if let Some((at, dirty)) = cache.lock().await.get(dir)
        && at.elapsed() < MAX_AGE
    {
        return *dirty;
    }
    let dirty = git(dir, &["status", "--porcelain", "--", ".", ":!.orca"])
        .await
        .is_ok_and(|s| !s.is_empty());
    cache.lock().await.insert(dir.to_path_buf(), (Instant::now(), dirty));
    dirty
}

pub fn canonical(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

// --- compose files -------------------------------------------------------

const DEFAULT_FILES: &[&str] = &[
    "compose.yaml",
    "compose.yml",
    "docker-compose.yaml",
    "docker-compose.yml",
];
const OVERRIDE_FILES: &[&str] = &[
    "compose.override.yaml",
    "compose.override.yml",
    "docker-compose.override.yaml",
    "docker-compose.override.yml",
];

/// The compose files for a worktree, as compose itself would pick them:
/// `compose:` from orca.yaml, else `COMPOSE_FILE` from `.env`, else the
/// first default file plus its override file. Passing `-f` turns compose's
/// own discovery off, so Orca has to replicate it.
pub fn compose_files(dir: &Path, from_yaml: Option<Vec<String>>) -> Result<Vec<PathBuf>> {
    let resolve = |f: &str| {
        let p = Path::new(f);
        if p.is_absolute() { p.to_path_buf() } else { dir.join(p) }
    };
    if let Some(list) = from_yaml.filter(|l| !l.is_empty()) {
        let files: Vec<PathBuf> = list.iter().map(|f| resolve(f)).collect();
        for f in &files {
            if !f.exists() {
                anyhow::bail!("compose file {} (from orca.yaml) does not exist", f.display());
            }
        }
        return Ok(files);
    }
    if let Some(list) = compose_file_from_dotenv(dir) {
        return Ok(list.iter().map(|f| resolve(f)).collect());
    }
    let main = DEFAULT_FILES
        .iter()
        .map(|f| dir.join(f))
        .find(|p| p.exists())
        .ok_or_else(|| anyhow::anyhow!("no compose file found in {}", dir.display()))?;
    let mut files = vec![main];
    if let Some(ov) = OVERRIDE_FILES.iter().map(|f| dir.join(f)).find(|p| p.exists()) {
        files.push(ov);
    }
    Ok(files)
}

fn compose_file_from_dotenv(dir: &Path) -> Option<Vec<String>> {
    let text = std::fs::read_to_string(dir.join(".env")).ok()?;
    let sep = if cfg!(windows) { ';' } else { ':' };
    for line in text.lines() {
        let line = line.trim();
        if let Some(v) = line.strip_prefix("COMPOSE_FILE=") {
            let v = v.trim().trim_matches(['"', '\'']);
            let list: Vec<String> = v.split(sep).filter(|s| !s.is_empty()).map(str::to_string).collect();
            if !list.is_empty() {
                return Some(list);
            }
        }
    }
    None
}

// --- compose execution -----------------------------------------------------

/// `docker compose` or `podman compose`, matching the connected runtime.
async fn compose_program(state: &AppState) -> (&'static str, &'static str) {
    match state.rt().await.detect_runtime().await {
        RuntimeKind::Podman => ("podman", "compose"),
        RuntimeKind::Docker => ("docker", "compose"),
    }
}

/// A `docker`/`podman` CLI command aimed at the engine the daemon is connected
/// to. An app started from Finder or the Dock gets a bare PATH
/// (`/usr/bin:/bin:…`), so add the usual install locations, and pass the
/// daemon's socket so the CLI doesn't follow a different `docker context`.
pub async fn runtime_cli(state: &AppState, program: &str) -> Command {
    let mut cmd = Command::new(program);
    cmd.env("PATH", cli_path());
    if let Some(host) = state.rt().await.host.clone() {
        let var = if program == "podman" {
            "CONTAINER_HOST"
        } else {
            "DOCKER_HOST"
        };
        cmd.env(var, host);
    }
    cmd
}

pub(crate) fn cli_path() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut dirs: Vec<String> = [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/Applications/Docker.app/Contents/Resources/bin",
        "/opt/podman/bin",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    // Docker Desktop and Rancher Desktop user-level CLI symlinks.
    dirs.push(format!("{home}/.docker/bin"));
    dirs.push(format!("{home}/.rd/bin"));
    if let Ok(path) = std::env::var("PATH") {
        dirs.push(path);
    }
    dirs.join(":")
}

pub struct ComposeRun {
    pub success: bool,
    pub stdout: String,
    /// Last lines of stderr, for error messages.
    pub stderr_tail: String,
}

/// Run compose with `args` in `dir`. When a job is given, every output line
/// goes to its log as it arrives.
pub async fn compose(state: &AppState, dir: &Path, args: &[String], job: Option<&JobHandle>) -> Result<ComposeRun> {
    let (program, sub) = compose_program(state).await;
    if let Some(j) = job {
        j.log(format!("$ {program} {sub} {}", args.join(" "))).await;
    }
    let mut child = runtime_cli(state, program)
        .await
        .arg(sub)
        .args(args)
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("could not run `{program} {sub}`"))?;

    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let job_out = job.cloned();
    let job_err = job.cloned();
    let out_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        let mut all = String::new();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(j) = &job_out {
                j.log(line.clone()).await;
            }
            all.push_str(&line);
            all.push('\n');
        }
        all
    });
    let err_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        let mut tail: Vec<String> = Vec::new();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(j) = &job_err {
                j.log(line.clone()).await;
            }
            tail.push(line);
            if tail.len() > 30 {
                tail.remove(0);
            }
        }
        tail.join("\n")
    });
    let status = child.wait().await?;
    let stdout = out_task.await.unwrap_or_default();
    let stderr_tail = err_task.await.unwrap_or_default();
    Ok(ComposeRun {
        success: status.success(),
        stdout,
        stderr_tail,
    })
}

/// Like [`compose`] but turns a non-zero exit into an error with the most
/// useful stderr lines.
pub async fn compose_ok(state: &AppState, dir: &Path, args: &[String], job: Option<&JobHandle>) -> Result<String> {
    let run = compose(state, dir, args, job).await?;
    if !run.success {
        anyhow::bail!("{}", friendly_compose_error(&run.stderr_tail));
    }
    Ok(run.stdout)
}

/// Pick the line that explains a compose failure and add a hint for the
/// common ones.
fn friendly_compose_error(stderr: &str) -> String {
    let lines: Vec<&str> = stderr.lines().filter(|l| !l.trim().is_empty()).collect();
    let key = lines
        .iter()
        .rev()
        .find(|l| {
            let l = l.to_lowercase();
            l.contains("error") || l.contains("failed") || l.contains("invalid")
        })
        .or(lines.last())
        .map(|l| l.trim().to_string())
        .unwrap_or_else(|| "compose failed without output".to_string());
    if key.contains("port is already allocated") || key.contains("address already in use") {
        return format!(
            "{key}\nAnother container or program already uses that port. If you previously ran this project with \
             plain `docker compose up`, stop it first (`docker compose down` in the main checkout)."
        );
    }
    if key.contains("is already in use by container") {
        return format!(
            "{key}\nA container with a fixed name already exists, probably from running the project outside Orca."
        );
    }
    key
}

/// The resolved model for `files` under compose project `project`.
pub async fn resolve_model(
    state: &AppState,
    dir: &Path,
    project: &str,
    files: &[PathBuf],
) -> Result<(ComposeModel, serde_json::Value)> {
    let mut args = vec!["-p".to_string(), project.to_string()];
    for f in files {
        args.push("-f".into());
        args.push(f.to_string_lossy().to_string());
    }
    // Every profile, so services behind one are known too; which of them
    // run is chosen per start.
    args.extend([
        "--profile".into(),
        "*".into(),
        "config".into(),
        "--format".into(),
        "json".into(),
    ]);
    let json = compose_ok(state, dir, &args, None)
        .await
        .context("compose could not read the project")?;
    let raw: serde_json::Value = serde_json::from_str(&json).context("compose printed invalid JSON")?;
    Ok((ComposeModel::parse(&json)?, raw))
}

/// Short-lived cache of resolved models, so listing projects doesn't run
/// `compose config` for every worktree on every poll.
type ModelCache = Mutex<Vec<(String, Instant, ComposeModel)>>;

pub async fn resolve_model_cached(
    state: &AppState,
    dir: &Path,
    project: &str,
    files: &[PathBuf],
) -> Result<ComposeModel> {
    static CACHE: OnceLock<ModelCache> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(Vec::new()));
    let key = format!("{}|{project}|{files:?}", dir.display());
    {
        let c = cache.lock().await;
        if let Some((_, at, m)) = c.iter().find(|(k, _, _)| *k == key)
            && at.elapsed() < Duration::from_secs(15)
        {
            return Ok(m.clone());
        }
    }
    let (model, _) = resolve_model(state, dir, project, files).await?;
    let mut c = cache.lock().await;
    c.retain(|(k, at, _)| *k != key && at.elapsed() < Duration::from_secs(60));
    c.push((key, Instant::now(), model.clone()));
    Ok(model)
}

/// Compose version, cached. `None` when it can't be determined.
pub async fn compose_version(state: &AppState) -> Option<(u32, u32, u32)> {
    static VERSION: OnceLock<Mutex<Option<(u32, u32, u32)>>> = OnceLock::new();
    let cell = VERSION.get_or_init(|| Mutex::new(None));
    if let Some(v) = *cell.lock().await {
        return Some(v);
    }
    let run = compose(state, Path::new("."), &["version".into(), "--short".into()], None)
        .await
        .ok()?;
    let v = parse_version(run.stdout.trim())?;
    *cell.lock().await = Some(v);
    Some(v)
}

fn parse_version(s: &str) -> Option<(u32, u32, u32)> {
    let s = s.trim().trim_start_matches('v');
    let mut parts = s.split(['.', '-', '+']).map(|p| p.parse::<u32>());
    Some((
        parts.next()?.ok()?,
        parts.next()?.ok()?,
        parts.next().and_then(Result::ok).unwrap_or(0),
    ))
}

/// Compose 2.24.4 added `!reset` and `!override`; older versions (and
/// podman-compose) get a fully resolved file instead.
pub async fn supports_override_tags(state: &AppState) -> bool {
    if matches!(compose_program(state).await.0, "podman") {
        return false;
    }
    compose_version(state).await.is_some_and(|v| v >= (2, 24, 4))
}

/// Whether nothing on this machine listens on `port`.
pub fn port_is_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_parsing() {
        assert_eq!(parse_version("2.24.4"), Some((2, 24, 4)));
        assert_eq!(parse_version("v5.3.1"), Some((5, 3, 1)));
        assert_eq!(parse_version("2.20.2-desktop.1"), Some((2, 20, 2)));
        assert_eq!(parse_version("1.29"), Some((1, 29, 0)));
        assert_eq!(parse_version("garbage"), None);
    }

    #[test]
    fn friendly_errors() {
        let e = friendly_compose_error(
            "Container x Creating\nError response from daemon: driver failed: Bind for 0.0.0.0:5432 failed: port is already allocated\n",
        );
        assert!(e.starts_with("Error response from daemon"), "{e}");
        assert!(e.contains("docker compose down"), "{e}");
    }

    #[test]
    fn compose_file_discovery() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        assert!(compose_files(d, None).is_err());
        std::fs::write(d.join("docker-compose.yml"), "services: {}").unwrap();
        std::fs::write(d.join("docker-compose.override.yml"), "services: {}").unwrap();
        let f = compose_files(d, None).unwrap();
        assert_eq!(
            f,
            vec![d.join("docker-compose.yml"), d.join("docker-compose.override.yml")]
        );
        std::fs::write(d.join(".env"), "FOO=1\nCOMPOSE_FILE=a.yml:b.yml\n").unwrap();
        assert_eq!(compose_files(d, None).unwrap(), vec![d.join("a.yml"), d.join("b.yml")]);
        // orca.yaml wins, and must point at real files.
        assert!(compose_files(d, Some(vec!["missing.yml".into()])).is_err());
        assert_eq!(
            compose_files(d, Some(vec!["docker-compose.yml".into()])).unwrap(),
            vec![d.join("docker-compose.yml")]
        );
    }
}
