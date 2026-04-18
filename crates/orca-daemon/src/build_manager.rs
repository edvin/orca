use orca_core::build::{BuildRecord, BuildSource, BuildStatus};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;

const MAX_HISTORY: usize = 500;

/// Cached BuildKit history to avoid shelling out on every request.
static BUILDKIT_CACHE: Mutex<Option<(Instant, Vec<BuildRecord>)>> = Mutex::new(None);

/// How long to cache BuildKit history results.
const BUILDKIT_CACHE_TTL_SECS: u64 = 30;

/// Serialises every read-modify-write cycle on `index.json` so two
/// concurrent start/update/delete calls cannot race and clobber each
/// other's changes.
static HISTORY_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn builds_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("orca")
        .join("builds")
}

fn index_path() -> PathBuf {
    builds_dir().join("index.json")
}

fn logs_dir() -> PathBuf {
    builds_dir().join("logs")
}

/// Validate a build id against a restricted character set.
///
/// Build ids come from the URL path for log read/write/delete endpoints,
/// and any `..` or path-separator character would let an authenticated
/// caller traverse out of the logs directory and read/delete arbitrary
/// `.log` files the daemon user can reach (e.g. CI or audit logs).
pub fn validate_build_id(build_id: &str) -> anyhow::Result<()> {
    if build_id.is_empty() || build_id.len() > 128 {
        anyhow::bail!("invalid build id: length");
    }
    if build_id.starts_with('-') || build_id.starts_with('.') {
        anyhow::bail!("invalid build id: must not start with '-' or '.'");
    }
    if !build_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
    {
        anyhow::bail!("invalid build id: illegal characters");
    }
    Ok(())
}

pub fn log_path(build_id: &str) -> anyhow::Result<PathBuf> {
    validate_build_id(build_id)?;
    Ok(logs_dir().join(format!("{build_id}.log")))
}

/// Load build history from disk.
pub fn load_history() -> Vec<BuildRecord> {
    let path = index_path();
    if !path.exists() {
        return Vec::new();
    }
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Save build history to disk (capped at MAX_HISTORY).
pub fn save_history(mut records: Vec<BuildRecord>) {
    if records.len() > MAX_HISTORY {
        // Remove oldest entries and their log files
        let to_remove: Vec<BuildRecord> = records.drain(..records.len() - MAX_HISTORY).collect();
        for r in to_remove {
            if let Ok(p) = log_path(&r.id) {
                let _ = std::fs::remove_file(p);
            }
        }
    }
    let dir = builds_dir();
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(index_path(), serde_json::to_string_pretty(&records).unwrap_or_default());
}

/// Create a new build record.
///
/// Acquires `HISTORY_LOCK` around the read-modify-write on `index.json`
/// so two concurrent callers cannot race and clobber each other's
/// records. The id now includes 16 random bits so two builds started in
/// the same millisecond still get unique ids.
pub async fn start_build(
    tag: &str,
    context_path: &str,
    dockerfile: &str,
    build_args: HashMap<String, String>,
    source: BuildSource,
) -> BuildRecord {
    use rand::RngCore;
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let mut rand_bytes = [0u8; 2];
    rand::rngs::OsRng.fill_bytes(&mut rand_bytes);
    let rand_u16 = u16::from_be_bytes(rand_bytes);
    let id = format!("{millis:x}{rand_u16:04x}");
    let _ = std::fs::create_dir_all(logs_dir());

    let record = BuildRecord {
        id,
        status: BuildStatus::InProgress,
        tag: tag.to_string(),
        context_path: context_path.to_string(),
        dockerfile: dockerfile.to_string(),
        build_args,
        started_at: chrono::Utc::now().to_rfc3339(),
        finished_at: None,
        duration_secs: None,
        image_id: None,
        error: None,
        log_lines: 0,
        source,
    };

    let _guard = HISTORY_LOCK.lock().await;
    let mut history = load_history();
    history.push(record.clone());
    save_history(history);
    record
}

/// Update a build record (mark complete/failed).
pub async fn update_build(id: &str, status: BuildStatus, image_id: Option<String>, error: Option<String>) {
    let _guard = HISTORY_LOCK.lock().await;
    let mut history = load_history();
    if let Some(record) = history.iter_mut().find(|r| r.id == id) {
        let now = chrono::Utc::now();
        record.status = status;
        record.finished_at = Some(now.to_rfc3339());
        record.image_id = image_id;
        record.error = error;
        // Calculate duration
        if let Ok(started) = chrono::DateTime::parse_from_rfc3339(&record.started_at) {
            record.duration_secs = Some((now - started.with_timezone(&chrono::Utc)).num_milliseconds() as f64 / 1000.0);
        }
        // Count log lines
        if let Ok(p) = log_path(id)
            && let Ok(log) = std::fs::read_to_string(p)
        {
            record.log_lines = log.lines().count() as u64;
        }
    }
    save_history(history);
}

/// Append a line to a build's log file.
///
/// Note: atomicity relies on `O_APPEND`, which guarantees single-write
/// atomicity on POSIX. On Windows there is no equivalent guarantee, so
/// concurrent appends from multiple build tasks to the same log may
/// interleave at sub-line boundaries. Because each build has its own
/// id-derived log file path, and per-build append calls are sequenced
/// from the single build-driving task, this hasn't caused problems in
/// practice.
pub fn append_log(id: &str, line: &str) {
    use std::io::Write;
    let path = match log_path(id) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!("append_log: rejecting invalid build id '{id}': {e}");
            return;
        }
    };
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{}", line);
    }
}

/// Get build log content.
pub fn get_log(id: &str) -> Option<String> {
    log_path(id).ok().and_then(|p| std::fs::read_to_string(p).ok())
}

/// Analyze build log for cache hit information.
pub fn analyze_cache(build_id: &str) -> Option<orca_core::build::CacheAnalysis> {
    let log = get_log(build_id)?;
    let mut total_steps = 0u32;
    let mut cached_steps = 0u32;
    for line in log.lines() {
        if line.contains('[')
            && line.contains(']')
            && (line.contains("RUN") || line.contains("COPY") || line.contains("ADD"))
        {
            total_steps += 1;
        }
        if line.contains("CACHED") {
            cached_steps += 1;
        }
    }
    Some(orca_core::build::CacheAnalysis {
        total_steps,
        cached_steps,
    })
}

/// Delete a build record and its log.
pub async fn delete_build(id: &str) {
    let _guard = HISTORY_LOCK.lock().await;
    let mut history = load_history();
    history.retain(|r| r.id != id);
    save_history(history);
    if let Ok(p) = log_path(id) {
        let _ = std::fs::remove_file(p);
    }
}

// --- BuildKit History Integration ---

/// Intermediate struct for parsing `docker buildx history ls --format json` output.
#[derive(serde::Deserialize)]
struct BuildKitRecord {
    #[serde(alias = "ref", alias = "Ref", default)]
    build_ref: String,
    #[serde(alias = "Status", default)]
    status: String,
    #[serde(alias = "Duration", alias = "duration", default)]
    duration: Option<serde_json::Value>,
    #[serde(alias = "CreatedAt", alias = "created_at", alias = "Created", default)]
    created_at: Option<String>,
    #[serde(alias = "Name", alias = "name", default)]
    name: String,
    #[serde(alias = "Error", alias = "error", default)]
    error: Option<String>,
}

/// Build the docker command, using WSL prefix on Windows.
fn docker_command() -> std::process::Command {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = std::process::Command::new("wsl");
        cmd.arg("docker");
        cmd
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("docker")
    }
}

/// Fetch build history from BuildKit via `docker buildx history ls`.
/// Returns an empty list if buildx or the history subcommand is unavailable.
pub async fn fetch_buildkit_history() -> Vec<BuildRecord> {
    // Run in a blocking task since we're spawning processes
    tokio::task::spawn_blocking(fetch_buildkit_history_sync)
        .await
        .unwrap_or_default()
}

fn fetch_buildkit_history_sync() -> Vec<BuildRecord> {
    // First check that buildx history is available
    let check = docker_command()
        .args(["buildx", "history", "ls", "--format", "json"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output();

    let output = match check {
        Ok(o) if o.status.success() => o,
        _ => return Vec::new(),
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    if stdout.trim().is_empty() {
        return Vec::new();
    }

    parse_buildkit_json(&stdout)
}

/// Parse JSON output from `docker buildx history ls --format json`.
/// The output may be a JSON array or newline-delimited JSON objects.
fn parse_buildkit_json(raw: &str) -> Vec<BuildRecord> {
    let trimmed = raw.trim();

    // Try parsing as a JSON array first
    let records: Vec<BuildKitRecord> = if trimmed.starts_with('[') {
        serde_json::from_str(trimmed).unwrap_or_default()
    } else {
        // Newline-delimited JSON objects
        trimmed
            .lines()
            .filter_map(|line| {
                let line = line.trim();
                if line.is_empty() {
                    return None;
                }
                serde_json::from_str::<BuildKitRecord>(line).ok()
            })
            .collect()
    };

    records
        .into_iter()
        .filter(|r| !r.build_ref.is_empty())
        .map(|r| {
            let status = match r.status.to_lowercase().as_str() {
                "completed" | "done" | "success" => BuildStatus::Success,
                "error" | "failed" | "failure" => BuildStatus::Failed,
                "canceled" | "cancelled" => BuildStatus::Cancelled,
                "running" | "in_progress" | "building" => BuildStatus::InProgress,
                _ => BuildStatus::Success,
            };

            let duration_secs = r.duration.as_ref().and_then(|v| match v {
                serde_json::Value::Number(n) => n.as_f64(),
                serde_json::Value::String(s) => parse_duration_string(s),
                _ => None,
            });

            let started_at = r
                .created_at
                .as_deref()
                .and_then(|s| {
                    // Try RFC3339 first, then other common formats
                    chrono::DateTime::parse_from_rfc3339(s)
                        .map(|d| d.to_rfc3339())
                        .ok()
                        .or_else(|| {
                            chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S")
                                .ok()
                                .map(|d| d.and_utc().to_rfc3339())
                        })
                })
                .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());

            let finished_at = if status != BuildStatus::InProgress {
                if let (Some(dur), Ok(start)) = (duration_secs, chrono::DateTime::parse_from_rfc3339(&started_at)) {
                    Some((start + chrono::Duration::milliseconds((dur * 1000.0) as i64)).to_rfc3339())
                } else {
                    None
                }
            } else {
                None
            };

            // Use the BuildKit ref as the ID, prefixed to avoid collisions
            let id = format!("bk-{}", r.build_ref.replace('/', "-"));

            // Use the name or ref as the tag
            let tag = if r.name.is_empty() { r.build_ref.clone() } else { r.name };

            BuildRecord {
                id,
                status,
                tag,
                context_path: String::new(),
                dockerfile: String::from("Dockerfile"),
                build_args: HashMap::new(),
                started_at,
                finished_at,
                duration_secs,
                image_id: None,
                error: r.error.filter(|e| !e.is_empty()),
                log_lines: 0,
                source: BuildSource::External,
            }
        })
        .collect()
}

/// Parse duration strings like "2m30s", "45s", "1h2m3s", or plain seconds.
fn parse_duration_string(s: &str) -> Option<f64> {
    // Try plain float first
    if let Ok(secs) = s.parse::<f64>() {
        return Some(secs);
    }

    let mut total = 0.0f64;
    let mut num_buf = String::new();
    for ch in s.chars() {
        match ch {
            '0'..='9' | '.' => num_buf.push(ch),
            'h' | 'H' => {
                total += num_buf.parse::<f64>().unwrap_or(0.0) * 3600.0;
                num_buf.clear();
            }
            'm' | 'M' => {
                // Check it's not "ms"
                total += num_buf.parse::<f64>().unwrap_or(0.0) * 60.0;
                num_buf.clear();
            }
            's' | 'S' => {
                total += num_buf.parse::<f64>().unwrap_or(0.0);
                num_buf.clear();
            }
            _ => {}
        }
    }

    if total > 0.0 { Some(total) } else { None }
}

/// Fetch BuildKit history with caching (30-second TTL).
pub async fn fetch_buildkit_history_cached() -> Vec<BuildRecord> {
    // Check cache
    if let Ok(guard) = BUILDKIT_CACHE.lock()
        && let Some((ts, records)) = guard.as_ref()
        && ts.elapsed().as_secs() < BUILDKIT_CACHE_TTL_SECS
    {
        return records.clone();
    }

    let records = fetch_buildkit_history().await;

    if let Ok(mut guard) = BUILDKIT_CACHE.lock() {
        *guard = Some((Instant::now(), records.clone()));
    }

    records
}

/// Merge Orca-tracked builds with BuildKit history.
/// Orca builds take priority when IDs overlap. Result is sorted newest-first.
pub async fn load_merged_history() -> Vec<BuildRecord> {
    let mut orca_history = load_history();
    let buildkit_history = fetch_buildkit_history_cached().await;

    // Collect Orca build IDs for dedup
    let orca_ids: std::collections::HashSet<String> = orca_history.iter().map(|r| r.id.clone()).collect();

    // Add BuildKit records that don't overlap with Orca records
    for bk_record in buildkit_history {
        if !orca_ids.contains(&bk_record.id) {
            orca_history.push(bk_record);
        }
    }

    // Sort newest first by started_at
    orca_history.sort_by(|a, b| b.started_at.cmp(&a.started_at));

    orca_history
}

/// Fetch logs for an external BuildKit build by its reference.
/// The build ID should be prefixed with "bk-".
pub async fn fetch_buildkit_logs(build_id: &str) -> Option<String> {
    if !build_id.starts_with("bk-") {
        return None;
    }
    // Recover the original ref from the sanitized ID.
    let build_ref = build_id.strip_prefix("bk-").unwrap_or(build_id);

    // Guard against flag-injection: a ref of `--help` or `-v` becomes a
    // docker-buildx option. Require a restricted identifier character set
    // with no leading `-`.
    if build_ref.is_empty()
        || build_ref.len() > 256
        || build_ref.starts_with('-')
        || !build_ref
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '/' | ':'))
    {
        tracing::warn!("fetch_buildkit_logs: rejecting suspicious build ref '{build_ref}'");
        return None;
    }

    tokio::task::spawn_blocking({
        let build_ref = build_ref.to_string();
        move || {
            // Insert `--` so the ref can never be interpreted as a flag
            // even if the allowlist above is bypassed via future refactor.
            let output = docker_command()
                .args(["buildx", "history", "logs", "--", &build_ref])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .output()
                .ok()?;

            if output.status.success() {
                Some(String::from_utf8_lossy(&output.stdout).to_string())
            } else {
                None
            }
        }
    })
    .await
    .ok()
    .flatten()
}
