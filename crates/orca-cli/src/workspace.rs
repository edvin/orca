//! `orca workspace`: join a team workspace, see its projects, set one up.

use serde_json::{Value, json};

use crate::client::DaemonClient;
use crate::dev::follow_job;

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or_default()
}

/// Print a finished job's outcome, and fail when it failed.
fn finish(done: &Value) -> anyhow::Result<()> {
    if s(done, "status") == "failed" {
        anyhow::bail!("{}", s(done, "error"));
    }
    Ok(())
}

pub async fn join(client: &DaemonClient, repo: String, folder: Option<String>) -> anyhow::Result<()> {
    // A local folder (`.`, `../team-workspace`) is joined where it is; the
    // daemon wants its absolute path.
    let local = std::path::Path::new(&repo);
    let repo = if !local.is_absolute() && local.is_dir() {
        local.canonicalize()?.to_string_lossy().to_string()
    } else {
        repo
    };
    let job = client
        .post_value("/workspace/join", &json!({ "repo": repo, "folder": folder }))
        .await?;
    finish(&follow_job(client, job, false).await?)?;
    println!("\nJoined. `orca workspace status` lists the projects; `orca workspace setup <project>` sets one up.");
    Ok(())
}

pub async fn update(client: &DaemonClient) -> anyhow::Result<()> {
    let job = client.post_value("/workspace/update", &json!({})).await?;
    finish(&follow_job(client, job, false).await?)
}

pub async fn leave(client: &DaemonClient) -> anyhow::Result<()> {
    client.post_value("/workspace/leave", &json!({})).await?;
    println!("Left the workspace and removed its routes. Your clones and their .env files are still there.");
    Ok(())
}

/// Warnings a job left with its result (a .env not in .gitignore, a secret
/// that couldn't be fetched).
fn print_warnings(result: &Value) {
    for w in result["warnings"].as_array().into_iter().flatten() {
        println!("Warning: {}", w.as_str().unwrap_or_default());
    }
}

pub async fn status(client: &DaemonClient, json_out: bool) -> anyhow::Result<()> {
    let w = client.get_value("/workspace").await?;
    if json_out {
        println!("{}", serde_json::to_string_pretty(&w)?);
        return Ok(());
    }
    if w["joined"] != json!(true) {
        println!("No workspace joined. Join one with `orca workspace join <git url>`.");
        return Ok(());
    }
    if let Some(e) = w.get("error").and_then(Value::as_str) {
        anyhow::bail!("the workspace file has a problem: {e}");
    }
    println!("{}  ({})", s(&w, "name"), s(&w, "path"));
    println!("Gateway  *.{}", s(&w, "domain"));
    if let Some(shared) = w.get("shared").filter(|v| !v.is_null()) {
        println!("Shared   {}/{} services running", shared["running"], shared["total"]);
    }
    for r in w["registries"].as_array().into_iter().flatten() {
        if r["logged_in"] != json!(true) {
            println!(
                "Registry {}: not logged in. Run `docker login {}`.",
                s(r, "host"),
                s(r, "host")
            );
        }
    }
    println!();
    for p in w["projects"].as_array().into_iter().flatten() {
        let state = if p["running"] == json!(true) {
            "running"
        } else if p["cloned"] == json!(true) {
            "cloned"
        } else {
            "not cloned"
        };
        let missing: Vec<&str> = p["secrets"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|x| x["filled"] != json!(true))
            .map(|x| s(x, "name"))
            .collect();
        println!("{:<20} {:<11} {}", s(p, "key"), state, s(p, "description"));
        for u in p["urls"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|_| p["running"] == json!(true))
        {
            println!("{:<32} {}", "", u.as_str().unwrap_or_default());
        }
        if !missing.is_empty() && p["cloned"] == json!(true) {
            println!("{:<32} missing secrets: {}", "", missing.join(", "));
        }
    }
    Ok(())
}

pub async fn setup(client: &DaemonClient, key: String, rerun_setup: bool) -> anyhow::Result<()> {
    let path = format!("/workspace/projects/{}/setup", urlencoding::encode(&key));
    let job = client.post_value(&path, &json!({ "rerun_setup": rerun_setup })).await?;
    let done = follow_job(client, job, false).await?;
    finish(&done)?;
    let result = &done["result"];
    print_warnings(result);
    if let Some(missing) = result.get("missing_secrets").and_then(Value::as_array) {
        let w = client.get_value("/workspace").await?;
        let project = w["projects"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|p| s(p, "key") == key);
        let env_file = project.and_then(|p| p["env_file"].as_str()).unwrap_or(".env");
        println!("\n{key} needs these secrets in its {env_file} before it can start:");
        for name in missing.iter().filter_map(Value::as_str) {
            let info = project.and_then(|p| {
                p["secrets"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|x| s(x, "name") == name)
            });
            let hint = info
                .and_then(|i| {
                    i.get("link")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .or_else(|| i.get("reference").and_then(Value::as_str).map(str::to_string))
                })
                .unwrap_or_default();
            println!("  {name:<24} {hint}");
        }
        println!("\nFill them in on Orca's Workspace page (or in {env_file}), then run this again.");
        return Ok(());
    }
    for u in result["urls"].as_array().into_iter().flatten() {
        println!("→ {}", u.as_str().unwrap_or_default());
    }
    Ok(())
}

pub async fn import_haproxy(client: &DaemonClient, file: String, domain: Option<String>) -> anyhow::Result<()> {
    let text = std::fs::read_to_string(&file).map_err(|e| anyhow::anyhow!("can't read {file}: {e}"))?;
    let r = client
        .post_value("/workspace/import-haproxy", &json!({ "text": text, "domain": domain }))
        .await?;
    print!("{}", s(&r, "yaml"));
    Ok(())
}
