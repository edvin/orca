//! Worktree dev instances: `orca up`, `orca down`, `orca logs`, `orca env`,
//! `orca projects …`. Commands work out the project and instance from the
//! current folder, so an agent in a worktree just runs `orca up`.

use std::path::PathBuf;
use std::time::Duration;

use clap::Subcommand;
use serde_json::{Value, json};

use crate::client::DaemonClient;

#[derive(Subcommand)]
pub enum ProjectAction {
    /// Register a git repo (any of its worktrees works)
    Add {
        /// Path inside the repo (default: current folder)
        path: Option<PathBuf>,
    },
    /// List registered projects and their instances
    List {
        #[arg(long)]
        json: bool,
    },
    /// Unregister a project (stop its instances first)
    Remove { id: String },
}

/// Project and instance for the current folder.
pub struct Here {
    pub project: String,
    pub instance: String,
    pub worktree: PathBuf,
}

pub async fn here(client: &DaemonClient) -> anyhow::Result<Here> {
    let cwd = std::env::current_dir()?;
    let v = client.post_value("/dev/resolve", &json!({ "path": cwd })).await?;
    Ok(Here {
        project: str_of(&v, "project"),
        instance: str_of(&v, "instance"),
        worktree: PathBuf::from(str_of(&v, "worktree")),
    })
}

fn str_of(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn enc(s: &str) -> String {
    urlencoding::encode(s).into_owned()
}

fn instance_path(h: &Here) -> String {
    format!("/dev/projects/{}/instances/{}", enc(&h.project), enc(&h.instance))
}

// --- projects --------------------------------------------------------------

pub async fn projects(client: &DaemonClient, action: ProjectAction) -> anyhow::Result<()> {
    match action {
        ProjectAction::Add { path } => {
            let path = match path {
                Some(p) => std::fs::canonicalize(&p).unwrap_or(p),
                None => std::env::current_dir()?,
            };
            let v = client.post_value("/dev/projects", &json!({ "path": path })).await?;
            let id = str_of(&v, "id");
            if v.get("existing").and_then(Value::as_bool) == Some(true) {
                println!("Already registered as '{id}' ({}).", str_of(&v, "root"));
            } else {
                println!("Registered '{id}' ({}).", str_of(&v, "root"));
                println!("Run `orca up` in any of its worktrees to start an instance.");
            }
        }
        ProjectAction::List { json } => {
            let v = client.get_value("/dev/projects").await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&v)?);
                return Ok(());
            }
            let list = v.as_array().cloned().unwrap_or_default();
            if list.is_empty() {
                println!("No projects registered. Run `orca projects add` inside a git repo.");
            }
            for p in list {
                println!("{}  {}", str_of(&p, "id"), str_of(&p, "root"));
                for e in p["errors"].as_array().into_iter().flatten() {
                    println!("  ! {}", e.as_str().unwrap_or_default());
                }
                print_instances(&p);
            }
        }
        ProjectAction::Remove { id } => {
            client.delete_path(&format!("/dev/projects/{}", enc(&id))).await?;
            println!("Unregistered '{id}'.");
        }
    }
    Ok(())
}

fn print_instances(p: &Value) {
    for s in p["shared"].as_array().into_iter().flatten() {
        println!("  shared   {:<20} {}", str_of(s, "name"), str_of(s, "status"));
    }
    for i in p["instances"].as_array().into_iter().flatten() {
        let urls: Vec<String> = i["routes"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|r| str_of(r, "url"))
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect();
        println!(
            "  instance {:<20} {:<13} {}",
            str_of(i, "name"),
            str_of(i, "status"),
            urls.join(" ")
        );
    }
}

// --- up / down ---------------------------------------------------------------

fn mark(status: &str) -> &'static str {
    match status {
        "done" => "✓",
        "failed" => "✗",
        "skipped" => "-",
        "running" => "…",
        _ => " ",
    }
}

/// Poll a job, printing each step once it settles. Returns the final job.
async fn follow_job(client: &DaemonClient, job: Value, quiet: bool) -> anyhow::Result<Value> {
    let id = str_of(&job, "id");
    let mut printed: Vec<String> = Vec::new();
    let mut announced: Option<String> = None;
    loop {
        let j = client.get_value(&format!("/dev/jobs/{}", enc(&id))).await?;
        if !quiet {
            for s in j["steps"].as_array().into_iter().flatten() {
                let key = str_of(s, "key");
                let status = str_of(s, "status");
                if printed.contains(&key) {
                    continue;
                }
                match status.as_str() {
                    "done" | "failed" | "skipped" => {
                        let detail = s.get("detail").and_then(Value::as_str).unwrap_or_default();
                        let first = detail.lines().next().unwrap_or_default();
                        println!("{} {:<38} {}", mark(&status), str_of(s, "label"), first);
                        printed.push(key);
                    }
                    "running" if announced.as_deref() != Some(key.as_str()) => {
                        eprintln!("… {}", str_of(s, "label"));
                        announced = Some(key);
                    }
                    _ => {}
                }
            }
        }
        if str_of(&j, "status") != "running" {
            return Ok(j);
        }
        tokio::time::sleep(Duration::from_millis(600)).await;
    }
}

pub async fn up(client: &DaemonClient, profiles: Vec<String>, no_build: bool, json_out: bool) -> anyhow::Result<()> {
    let profiles = (!profiles.is_empty()).then_some(profiles);
    let h = here(client).await?;
    if !json_out {
        println!("Starting {} / {} ({})", h.project, h.instance, h.worktree.display());
    }
    let job = client
        .post_value(
            &format!("{}/up", instance_path(&h)),
            &json!({ "profiles": profiles, "build": !no_build, "source": "cli" }),
        )
        .await?;
    let done = follow_job(client, job, json_out).await?;
    if json_out {
        println!("{}", serde_json::to_string_pretty(&done)?);
    }
    if str_of(&done, "status") != "succeeded" {
        let err = str_of(&done, "error");
        if !json_out {
            eprintln!("\nFailed: {err}");
            if let Some(log) = done["log"].as_array() {
                let tail: Vec<&str> = log.iter().rev().take(15).filter_map(Value::as_str).collect();
                if !tail.is_empty() {
                    eprintln!("\nLast output:");
                    for line in tail.iter().rev() {
                        eprintln!("  {line}");
                    }
                }
            }
        }
        std::process::exit(1);
    }
    if !json_out {
        let r = &done["result"];
        println!();
        for u in r["urls"].as_array().into_iter().flatten() {
            println!("  {:<12} {}", str_of(u, "service"), str_of(u, "url"));
        }
        for p in r["host_ports"].as_array().into_iter().flatten() {
            println!(
                "  {:<12} localhost:{}  (container port {})",
                str_of(p, "service"),
                p["host_port"],
                p["container_port"]
            );
        }
        for w in r["warnings"].as_array().into_iter().flatten() {
            println!("  ! {}", w.as_str().unwrap_or_default());
        }
        println!("\nURLs, ports and connection strings: {}", str_of(r, "env_file"));
    }
    Ok(())
}

pub async fn down(client: &DaemonClient, remove: bool, json_out: bool) -> anyhow::Result<()> {
    let h = here(client).await?;
    let action = if remove { "remove" } else { "down" };
    let job = client
        .post_value(&format!("{}/{action}", instance_path(&h)), &json!({}))
        .await?;
    let done = follow_job(client, job, json_out).await?;
    if json_out {
        println!("{}", serde_json::to_string_pretty(&done)?);
    }
    if str_of(&done, "status") != "succeeded" {
        if !json_out {
            eprintln!("Failed: {}", str_of(&done, "error"));
        }
        std::process::exit(1);
    }
    Ok(())
}

// --- status / logs / env -------------------------------------------------------

/// Instance section of `orca status`, when run inside a registered worktree.
pub async fn status(client: &DaemonClient, all: bool, json_out: bool) -> anyhow::Result<()> {
    let h = match here(client).await {
        Ok(h) => h,
        Err(e) => {
            if json_out {
                println!("{}", json!({ "instance": null, "reason": e.to_string() }));
            }
            return Ok(());
        }
    };
    let p = client.get_value(&format!("/dev/projects/{}", enc(&h.project))).await?;
    let me = p["instances"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|i| str_of(i, "name") == h.instance)
        .cloned()
        .unwrap_or(Value::Null);
    if json_out {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({ "project": p["id"], "instance": me, "shared": p["shared"] }))?
        );
        return Ok(());
    }
    if all {
        println!("\nProject {} ({})", str_of(&p, "id"), str_of(&p, "root"));
        print_instances(&p);
        return Ok(());
    }
    println!("\nInstance {} of {}: {}", h.instance, h.project, str_of(&me, "status"));
    for s in me["services"].as_array().into_iter().flatten() {
        println!(
            "  {:<12} {}",
            str_of(s, "name"),
            s["state"].as_str().unwrap_or_default()
        );
    }
    let mut seen = std::collections::BTreeSet::new();
    for r in me["routes"].as_array().into_iter().flatten() {
        let url = format!(
            "{}{}",
            str_of(r, "url"),
            r["path"]
                .as_str()
                .map(|p| p.trim_end_matches('*').trim_end_matches('/'))
                .unwrap_or("")
        );
        if seen.insert(url.clone()) {
            println!("  {url}");
        }
    }
    for a in me["ports"].as_array().into_iter().flatten() {
        println!(
            "  {}:{} -> localhost:{}",
            str_of(a, "service"),
            a["container_port"],
            a["host_port"]
        );
    }
    if let Some(e) = me["last_error"].as_str() {
        println!("  last error: {}", e.lines().next().unwrap_or_default());
    }
    let shared: Vec<String> = p["shared"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|s| format!("{} ({})", str_of(s, "name"), str_of(s, "status")))
        .collect();
    if !shared.is_empty() {
        println!("  shared: {}", shared.join(", "));
    }
    Ok(())
}

pub async fn logs(client: &DaemonClient, service: Option<String>, tail: u32, follow: bool) -> anyhow::Result<()> {
    let h = here(client).await?;
    let mut url = format!("{}/logs?tail={tail}", instance_path(&h));
    if let Some(s) = &service {
        url.push_str(&format!("&service={}", enc(s)));
    }
    let v = client.get_value(&url).await?;
    print!("{}", str_of(&v, "logs"));
    if !follow {
        return Ok(());
    }
    // Poll with --since; compose prints RFC 3339 timestamps per line.
    let mut since = chrono::Utc::now().to_rfc3339();
    loop {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let mut url = format!("{}/logs?tail=1000&since={}", instance_path(&h), enc(&since));
        if let Some(s) = &service {
            url.push_str(&format!("&service={}", enc(s)));
        }
        since = chrono::Utc::now().to_rfc3339();
        let v = client.get_value(&url).await?;
        print!("{}", str_of(&v, "logs"));
    }
}

/// Print `.orca/env` as shell exports, for `eval $(orca env)`.
pub async fn env(client: &DaemonClient) -> anyhow::Result<()> {
    let h = here(client).await?;
    let path = h.worktree.join(".orca").join("env");
    let text = std::fs::read_to_string(&path)
        .map_err(|_| anyhow::anyhow!("{} does not exist yet; run `orca up` first", path.display()))?;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            println!("export {k}='{}'", v.replace('\'', "'\\''"));
        }
    }
    Ok(())
}

/// `orca run [--profile p] [--serve svc] [--down] -- cmd …`: make sure the
/// instance runs, load its env, run the command, return its exit code.
pub async fn run(
    client: &DaemonClient,
    profiles: Vec<String>,
    serve: Option<String>,
    down_after: bool,
    no_up: bool,
    cmd: Vec<String>,
) -> anyhow::Result<()> {
    let h = here(client).await?;
    if !no_up {
        let p = client.get_value(&format!("/dev/projects/{}", enc(&h.project))).await?;
        let status = p["instances"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|i| str_of(i, "name") == h.instance)
            .map(|i| str_of(i, "status"))
            .unwrap_or_default();
        if status != "running" || !profiles.is_empty() {
            eprintln!("Starting {} / {}", h.project, h.instance);
            let job = client
                .post_value(
                    &format!("{}/up", instance_path(&h)),
                    &json!({ "profiles": (!profiles.is_empty()).then_some(&profiles), "build": true, "source": "cli" }),
                )
                .await?;
            let done = follow_job(client, job, false).await?;
            if str_of(&done, "status") != "succeeded" {
                anyhow::bail!("could not start the instance: {}", str_of(&done, "error"));
            }
        }
    }

    let mut command = tokio::process::Command::new(&cmd[0]);
    command.args(&cmd[1..]).current_dir(std::env::current_dir()?);
    let env_path = h.worktree.join(".orca").join("env");
    if let Ok(text) = std::fs::read_to_string(&env_path) {
        for line in text.lines().filter(|l| !l.trim().is_empty() && !l.starts_with('#')) {
            if let Some((k, v)) = line.split_once('=') {
                command.env(k, v);
            }
        }
    }

    let mut served: Option<String> = None;
    if let Some(svc) = &serve {
        let r = client
            .post_value(&format!("{}/host-routes/{}", instance_path(&h), enc(svc)), &json!({}))
            .await?;
        let port = r["port"].as_u64().unwrap_or_default();
        eprintln!(
            "Serving {svc} at {} (listen on port {port}, all interfaces)",
            str_of(&r, "url")
        );
        // Most dev servers read PORT/HOST; they must listen on 0.0.0.0 so
        // the gateway container can reach them.
        command.env("PORT", port.to_string());
        command.env("HOST", "0.0.0.0");
        command.env(
            format!("ORCA_URL_{}", svc.to_uppercase().replace('-', "_")),
            str_of(&r, "url"),
        );
        served = Some(svc.clone());
    }

    let mut child = command
        .spawn()
        .map_err(|e| anyhow::anyhow!("could not run {}: {e}", cmd[0]))?;
    // Ctrl-C reaches the child too; keep waiting so we can clean up after it.
    let status = loop {
        tokio::select! {
            s = child.wait() => break s?,
            _ = tokio::signal::ctrl_c() => continue,
        }
    };

    if let Some(svc) = served {
        let _ = client
            .delete_path(&format!("{}/host-routes/{}", instance_path(&h), enc(&svc)))
            .await;
    }
    if down_after {
        let job = client
            .post_value(&format!("{}/down", instance_path(&h)), &json!({}))
            .await?;
        follow_job(client, job, true).await?;
    }
    std::process::exit(status.code().unwrap_or(1));
}
