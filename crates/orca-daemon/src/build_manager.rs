use orca_core::build::{BuildRecord, BuildSource, BuildStatus};
use std::collections::HashMap;
use std::path::PathBuf;

const MAX_HISTORY: usize = 500;

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

pub fn log_path(build_id: &str) -> PathBuf {
    logs_dir().join(format!("{build_id}.log"))
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
            let _ = std::fs::remove_file(log_path(&r.id));
        }
    }
    let dir = builds_dir();
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(index_path(), serde_json::to_string_pretty(&records).unwrap_or_default());
}

/// Create a new build record.
pub fn start_build(
    tag: &str,
    context_path: &str,
    dockerfile: &str,
    build_args: HashMap<String, String>,
    source: BuildSource,
) -> BuildRecord {
    let id = format!(
        "{:x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    );
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

    let mut history = load_history();
    history.push(record.clone());
    save_history(history);
    record
}

/// Update a build record (mark complete/failed).
pub fn update_build(id: &str, status: BuildStatus, image_id: Option<String>, error: Option<String>) {
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
        if let Ok(log) = std::fs::read_to_string(log_path(id)) {
            record.log_lines = log.lines().count() as u64;
        }
    }
    save_history(history);
}

/// Append a line to a build's log file.
pub fn append_log(id: &str, line: &str) {
    use std::io::Write;
    let path = log_path(id);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{}", line);
    }
}

/// Get build log content.
pub fn get_log(id: &str) -> Option<String> {
    std::fs::read_to_string(log_path(id)).ok()
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
pub fn delete_build(id: &str) {
    let mut history = load_history();
    history.retain(|r| r.id != id);
    save_history(history);
    let _ = std::fs::remove_file(log_path(id));
}
