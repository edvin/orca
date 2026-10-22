//! Local model servers for the built-in assistant: Ollama, LM Studio and
//! llama.cpp's llama-server all speak the OpenAI API on a known port.

use serde::Serialize;

#[derive(Serialize)]
pub struct LocalServer {
    /// "ollama", "lmstudio", "llamacpp" or "openai" (some other server).
    pub kind: &'static str,
    pub name: &'static str,
    /// OpenAI-compatible base URL, as the assistant's `openai_url`.
    pub url: String,
    pub models: Vec<String>,
}

/// The servers running on this machine, found in well under a second.
pub async fn detect() -> Vec<LocalServer> {
    let http = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(800))
        .build()
    {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let (ollama, lmstudio, llamacpp) = tokio::join!(
        probe(&http, 11434, "ollama", "Ollama"),
        probe(&http, 1234, "lmstudio", "LM Studio"),
        probe(&http, 8080, "llamacpp", "llama.cpp server"),
    );
    [ollama, lmstudio, llamacpp].into_iter().flatten().collect()
}

async fn probe(http: &reqwest::Client, port: u16, kind: &'static str, name: &'static str) -> Option<LocalServer> {
    let url = format!("http://127.0.0.1:{port}/v1");
    let body: serde_json::Value = http.get(format!("{url}/models")).send().await.ok()?.json().await.ok()?;
    let data = body.get("data")?.as_array()?;
    let models: Vec<String> = data
        .iter()
        .filter_map(|m| m.get("id").and_then(|i| i.as_str()).map(str::to_string))
        .collect();
    // Port 8080 is popular; only call it llama.cpp when it says so.
    let llama = data
        .iter()
        .any(|m| m.get("owned_by").and_then(|o| o.as_str()) == Some("llamacpp"));
    let (kind, name) = if kind == "llamacpp" && !llama {
        ("openai", "Local OpenAI-compatible server")
    } else {
        (kind, name)
    };
    Some(LocalServer {
        kind,
        name,
        url,
        models,
    })
}

/// Whether an OpenAI-compatible base URL points at this machine.
pub fn is_local(url: &str) -> bool {
    let Ok(u) = reqwest::Url::parse(url) else { return false };
    matches!(
        u.host_str(),
        Some("127.0.0.1" | "localhost" | "[::1]" | "::1" | "host.docker.internal")
    )
}

/// The tools a small local model gets: enough to look into and fix the
/// usual problems, few enough to fit its context and keep it on track.
pub const LOCAL_TOOLS: &[&str] = &[
    "list_containers",
    "inspect_container",
    "container_logs",
    "container_stats",
    "diagnose_container",
    "start_container",
    "stop_container",
    "restart_container",
    "check_port_availability",
    "system_health",
    "list_stacks",
    "stack_logs",
    "compose_up",
    "compose_down",
    "stack_restart",
    "gateway_routes",
    "list_images",
    "instance_status",
    "instance_logs",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_urls() {
        assert!(is_local("http://127.0.0.1:11434/v1"));
        assert!(is_local("http://localhost:1234/v1"));
        assert!(!is_local("https://api.openai.com/v1"));
        assert!(!is_local("not a url"));
    }

    #[test]
    fn local_tools_exist() {
        let catalog = orca_core::agent_tools::tool_catalog();
        for t in LOCAL_TOOLS {
            assert!(catalog.iter().any(|c| c.name == *t), "{t} is not a tool");
        }
    }
}
