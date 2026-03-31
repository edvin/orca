//! Agent tool executor — dispatches tool calls to the container runtime.
//!
//! Used by both the MCP and OpenAI-compatible API endpoints.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::json;

use orca_core::compose;
use orca_core::image::ImageManager;
use orca_core::kubernetes::K8sManager;
use orca_core::network::NetworkManager;
use orca_core::runtime::{ContainerCreateOpts, ContainerRuntime, ExecOpts, PortMapping, VolumeMount};
use orca_core::volume::VolumeManager;

use crate::state::AppState;

/// Execute a named tool with the given JSON arguments.
pub async fn execute_tool(
    state: &Arc<AppState>,
    tool_name: &str,
    arguments: serde_json::Value,
) -> Result<serde_json::Value, String> {
    match tool_name {
        // === Container Operations ===
        "list_containers" => {
            let containers = state
                .rt()
                .await
                .list_containers(true)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(containers).unwrap_or_default())
        }

        "inspect_container" => {
            let id = get_str(&arguments, "id")?;
            let container = state
                .rt()
                .await
                .inspect_container(id)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(container).unwrap_or_default())
        }

        "container_logs" => {
            let id = get_str(&arguments, "id")?;
            let tail = arguments.get("tail").and_then(|v| v.as_u64()).map(|v| v as u32);
            let mut rx = state
                .rt()
                .await
                .container_logs(id, false, tail)
                .await
                .map_err(|e| e.to_string())?;
            let mut lines = Vec::new();
            while let Some(line) = rx.recv().await {
                lines.push(line);
            }
            Ok(json!({ "logs": lines }))
        }

        "container_stats" => {
            let id = get_str(&arguments, "id")?;
            let stats = state.rt().await.container_stats(id).await.map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(stats).unwrap_or_default())
        }

        "start_container" => {
            let id = get_str(&arguments, "id")?;
            state.rt().await.start_container(id).await.map_err(|e| e.to_string())?;
            Ok(json!({ "status": "started" }))
        }

        "stop_container" => {
            let id = get_str(&arguments, "id")?;
            state
                .rt()
                .await
                .stop_container(id, 10)
                .await
                .map_err(|e| e.to_string())?;
            Ok(json!({ "status": "stopped" }))
        }

        "restart_container" => {
            let id = get_str(&arguments, "id")?;
            state.rt().await.stop_container(id, 10).await.ok();
            state.rt().await.start_container(id).await.map_err(|e| e.to_string())?;
            Ok(json!({ "status": "restarted" }))
        }

        "exec_in_container" => {
            let id = get_str(&arguments, "id")?;
            let command: Vec<String> = arguments
                .get("command")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .ok_or("Missing 'command' parameter")?;
            let result = state
                .rt()
                .await
                .exec(ExecOpts {
                    container: id.to_string(),
                    command,
                    interactive: false,
                    tty: false,
                    env: Default::default(),
                    workdir: None,
                })
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap_or_default())
        }

        "create_and_run_container" => {
            let image = get_str(&arguments, "image")?.to_string();
            let name = arguments.get("name").and_then(|v| v.as_str()).map(|s| s.to_string());

            let ports: Vec<PortMapping> = arguments
                .get("ports")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|s| {
                            let s = s.as_str()?;
                            let parts: Vec<&str> = s.split(':').collect();
                            if parts.len() == 2 {
                                Some(PortMapping {
                                    host_ip: None,
                                    host_port: parts[0].parse().ok()?,
                                    container_port: parts[1].parse().ok()?,
                                    protocol: "tcp".to_string(),
                                })
                            } else {
                                None
                            }
                        })
                        .collect()
                })
                .unwrap_or_default();

            let env: HashMap<String, String> = arguments
                .get("env")
                .and_then(|v| v.as_object())
                .map(|obj| {
                    obj.iter()
                        .map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string()))
                        .collect()
                })
                .unwrap_or_default();

            let volumes: Vec<VolumeMount> = arguments
                .get("volumes")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|s| {
                            let s = s.as_str()?;
                            let parts: Vec<&str> = s.splitn(2, ':').collect();
                            if parts.len() == 2 {
                                Some(VolumeMount {
                                    source: parts[0].to_string(),
                                    target: parts[1].to_string(),
                                    read_only: false,
                                })
                            } else {
                                None
                            }
                        })
                        .collect()
                })
                .unwrap_or_default();

            let memory_limit = arguments
                .get("memory_limit")
                .and_then(|v| v.as_str())
                .map(parse_memory_string)
                .transpose()?;

            let cpu_limit = arguments.get("cpu_limit").and_then(|v| v.as_f64());

            let opts = ContainerCreateOpts {
                image,
                name: name.clone(),
                command: vec![],
                env,
                ports,
                volumes,
                labels: HashMap::new(),
                restart_policy: None,
                network: None,
                detach: true,
                entrypoint: None,
                remove_on_exit: false,
                cpu_limit,
                memory_limit,
                memory_swap: None,
                gpu: false,
                user: None,
            };

            let container_id = state
                .rt()
                .await
                .create_container(opts)
                .await
                .map_err(|e| e.to_string())?;
            state
                .rt()
                .await
                .start_container(&container_id)
                .await
                .map_err(|e| e.to_string())?;

            Ok(json!({
                "id": container_id,
                "name": name,
                "status": "running",
            }))
        }

        "remove_container" => {
            let id = get_str(&arguments, "id")?;
            let force = arguments.get("force").and_then(|v| v.as_bool()).unwrap_or(false);
            state
                .rt()
                .await
                .remove_container(id, force)
                .await
                .map_err(|e| e.to_string())?;
            Ok(json!({ "status": "removed" }))
        }

        // === Diagnostics ===
        "diagnose_container" => {
            let id = get_str(&arguments, "id")?;
            let inspect = state.rt().await.inspect_container(id).await.ok();
            let stats = state.rt().await.container_stats(id).await.ok();
            let mut logs_rx = state.rt().await.container_logs(id, false, Some(50)).await.ok();
            let mut log_lines = Vec::new();
            if let Some(ref mut rx) = logs_rx {
                while let Some(line) = rx.recv().await {
                    log_lines.push(line);
                }
            }
            Ok(json!({
                "container": inspect,
                "stats": stats,
                "recent_logs": log_lines,
            }))
        }

        "check_port_availability" => {
            let port = arguments
                .get("port")
                .and_then(|v| v.as_u64())
                .ok_or("Missing 'port' parameter")? as u16;
            let containers = state
                .rt()
                .await
                .list_containers(true)
                .await
                .map_err(|e| e.to_string())?;
            let using: Vec<_> = containers.iter().filter(|c| {
                c.ports.iter().any(|p| p.host_port == port)
            }).map(|c| json!({
                "container": c.name,
                "mapping": format!("{}:{}", port, c.ports.iter().find(|p| p.host_port == port).map(|p| p.container_port).unwrap_or(0))
            })).collect();
            Ok(json!({
                "port": port,
                "available": using.is_empty(),
                "used_by": using,
            }))
        }

        "system_health" => {
            let health = orca_backend_common::environment::check_system_health().await;
            Ok(serde_json::to_value(health).unwrap_or_default())
        }

        "environment_status" => {
            let status = orca_backend_common::environment::check_environment().await;
            Ok(serde_json::to_value(status).unwrap_or_default())
        }

        // === Images ===
        "list_images" => {
            let images = ImageManager::list(state.rt().await.as_ref())
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(images).unwrap_or_default())
        }

        "pull_image" => {
            let reference = get_str(&arguments, "reference")?;
            let mut rx = ImageManager::pull(state.rt().await.as_ref(), reference)
                .await
                .map_err(|e| e.to_string())?;
            // Consume all progress events to completion
            let mut progress = Vec::new();
            while let Some(p) = rx.recv().await {
                progress.push(json!({
                    "layer": p.layer,
                    "status": p.status,
                }));
            }
            Ok(json!({
                "status": "pulled",
                "reference": reference,
                "progress_events": progress.len(),
            }))
        }

        "remove_image" => {
            let id = get_str(&arguments, "id")?;
            let force = arguments.get("force").and_then(|v| v.as_bool()).unwrap_or(false);
            ImageManager::remove(state.rt().await.as_ref(), id, force)
                .await
                .map_err(|e| e.to_string())?;
            Ok(json!({ "status": "removed" }))
        }

        "prune_images" => {
            let result = ImageManager::prune(state.rt().await.as_ref())
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap_or_default())
        }

        // === Compose Stacks ===
        "list_stacks" => {
            let containers = state
                .rt()
                .await
                .list_containers(true)
                .await
                .map_err(|e| e.to_string())?;
            let stacks = compose::extract_projects(&containers);
            Ok(serde_json::to_value(stacks).unwrap_or_default())
        }

        "compose_up" => {
            let name = get_str(&arguments, "name")?;
            let (dir, config) = resolve_stack_dir(state, name).await?;
            let output =
                orca_core::compose::ComposeRunner::compose_up(state.rt().await.as_ref(), &dir, config.as_deref())
                    .await
                    .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(output).unwrap_or_default())
        }

        "compose_down" => {
            let name = get_str(&arguments, "name")?;
            let (dir, config) = resolve_stack_dir(state, name).await?;
            let output =
                orca_core::compose::ComposeRunner::compose_down(state.rt().await.as_ref(), &dir, config.as_deref())
                    .await
                    .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(output).unwrap_or_default())
        }

        // === Volumes & Networks ===
        "list_volumes" => {
            let volumes = VolumeManager::list(state.rt().await.as_ref())
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(volumes).unwrap_or_default())
        }

        "list_networks" => {
            let networks = NetworkManager::list(state.rt().await.as_ref())
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(networks).unwrap_or_default())
        }

        "create_network" => {
            let name = get_str(&arguments, "name")?;
            let driver = arguments.get("driver").and_then(|v| v.as_str()).unwrap_or("bridge");
            let network = NetworkManager::create(state.rt().await.as_ref(), name, driver)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(network).unwrap_or_default())
        }

        // === Templates ===
        "list_templates" => {
            let templates = orca_backend_common::templates::all_templates();
            Ok(serde_json::to_value(templates).unwrap_or_default())
        }

        "deploy_template" => {
            let id = get_str(&arguments, "id")?;
            let templates = orca_backend_common::templates::all_templates();
            let template = templates
                .iter()
                .find(|t| t.id == id)
                .ok_or_else(|| format!("Template '{}' not found", id))?;

            let container_name = arguments
                .get("name")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("orca-{}", template.id));

            let ports_str: Vec<String> = arguments
                .get("ports")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_else(|| template.default_ports.clone());
            let ports: Vec<PortMapping> = ports_str
                .iter()
                .filter_map(|s| {
                    let parts: Vec<&str> = s.split(':').collect();
                    if parts.len() == 2 {
                        Some(PortMapping {
                            host_ip: None,
                            host_port: parts[0].parse().ok()?,
                            container_port: parts[1].parse().ok()?,
                            protocol: "tcp".to_string(),
                        })
                    } else {
                        None
                    }
                })
                .collect();

            let env_list: Vec<String> = arguments
                .get("env")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_else(|| template.default_env.clone());
            let env: HashMap<String, String> = env_list
                .iter()
                .filter_map(|s| {
                    let mut parts = s.splitn(2, '=');
                    let key = parts.next()?.to_string();
                    let val = parts.next().unwrap_or("").to_string();
                    Some((key, val))
                })
                .collect();

            let vol_list = template.default_volumes.clone();
            let volumes: Vec<VolumeMount> = vol_list
                .iter()
                .filter_map(|s| {
                    let parts: Vec<&str> = s.splitn(2, ':').collect();
                    if parts.len() == 2 {
                        Some(VolumeMount {
                            source: parts[0].to_string(),
                            target: parts[1].to_string(),
                            read_only: false,
                        })
                    } else {
                        None
                    }
                })
                .collect();

            let opts = ContainerCreateOpts {
                image: template.image.clone(),
                name: Some(container_name.clone()),
                command: vec![],
                env,
                ports,
                volumes,
                labels: HashMap::new(),
                restart_policy: Some(template.restart_policy.clone()),
                network: None,
                detach: true,
                entrypoint: None,
                remove_on_exit: false,
                cpu_limit: None,
                memory_limit: None,
                memory_swap: None,
                gpu: false,
                user: None,
            };

            let container_id = state
                .rt()
                .await
                .create_container(opts)
                .await
                .map_err(|e| e.to_string())?;
            state
                .rt()
                .await
                .start_container(&container_id)
                .await
                .map_err(|e| e.to_string())?;

            Ok(json!({
                "id": container_id,
                "name": container_name,
                "notes": template.notes,
            }))
        }

        // === Kubernetes ===
        "k8s_status" => {
            let status = state.k8s.status().await.map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(status).unwrap_or_default())
        }

        "k8s_list_pods" => {
            let namespace = arguments.get("namespace").and_then(|v| v.as_str()).unwrap_or("default");
            let pods = state.k8s.list_pods(namespace).await.map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(pods).unwrap_or_default())
        }

        "k8s_apply_yaml" => {
            let yaml = get_str(&arguments, "yaml")?;
            let output = state.k8s.apply_yaml(yaml).await.map_err(|e| e.to_string())?;
            Ok(json!({ "output": output }))
        }

        "k8s_pod_logs" => {
            let namespace = get_str(&arguments, "namespace")?;
            let name = get_str(&arguments, "name")?;
            let tail = arguments.get("tail").and_then(|v| v.as_u64()).map(|v| v as u32);
            let logs = state
                .k8s
                .pod_logs(namespace, name, None, tail)
                .await
                .map_err(|e| e.to_string())?;
            Ok(json!({ "logs": logs }))
        }

        "k8s_list_namespaces" => {
            let namespaces = state.k8s.list_namespaces().await.map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(namespaces).unwrap_or_default())
        }

        "k8s_list_deployments" => {
            let ns = arguments.get("namespace").and_then(|v| v.as_str()).unwrap_or("default");
            let deployments = state.k8s.list_deployments(ns).await.map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(deployments).unwrap_or_default())
        }

        "k8s_list_services" => {
            let ns = arguments.get("namespace").and_then(|v| v.as_str()).unwrap_or("default");
            let services = state.k8s.list_services(ns).await.map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(services).unwrap_or_default())
        }

        "k8s_list_events" => {
            let ns = arguments.get("namespace").and_then(|v| v.as_str()).unwrap_or("default");
            let events = state.k8s.list_events(ns).await.map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(events).unwrap_or_default())
        }

        "k8s_scale_deployment" => {
            let ns = get_str(&arguments, "namespace")?;
            let name = get_str(&arguments, "name")?;
            let replicas = arguments.get("replicas").and_then(|v| v.as_u64()).unwrap_or(1) as u32;
            state
                .k8s
                .scale_deployment(ns, name, replicas)
                .await
                .map_err(|e| e.to_string())?;
            Ok(json!({ "scaled": name, "replicas": replicas }))
        }

        "k8s_restart_deployment" => {
            let ns = get_str(&arguments, "namespace")?;
            let name = get_str(&arguments, "name")?;
            state
                .k8s
                .restart_deployment(ns, name)
                .await
                .map_err(|e| e.to_string())?;
            Ok(json!({ "restarted": name }))
        }

        "k8s_delete_pod" => {
            let ns = get_str(&arguments, "namespace")?;
            let name = get_str(&arguments, "name")?;
            state.k8s.delete_pod(ns, name).await.map_err(|e| e.to_string())?;
            Ok(json!({ "deleted": name }))
        }

        "k8s_get_yaml" => {
            let kind = get_str(&arguments, "kind")?;
            let ns = get_str(&arguments, "namespace")?;
            let name = get_str(&arguments, "name")?;
            let yaml = state
                .k8s
                .get_resource_yaml(kind, name, ns)
                .await
                .map_err(|e| e.to_string())?;
            Ok(json!({ "yaml": yaml }))
        }

        "k8s_list_configmaps" => {
            let ns = arguments.get("namespace").and_then(|v| v.as_str()).unwrap_or("default");
            let configmaps = state.k8s.list_configmaps(ns).await.map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(configmaps).unwrap_or_default())
        }

        "k8s_list_secrets" => {
            let ns = arguments.get("namespace").and_then(|v| v.as_str()).unwrap_or("default");
            let secrets = state.k8s.list_secrets(ns).await.map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(secrets).unwrap_or_default())
        }

        "k8s_list_ingresses" => {
            let ns = arguments.get("namespace").and_then(|v| v.as_str()).unwrap_or("default");
            let ingresses = state.k8s.list_ingresses(ns).await.map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(ingresses).unwrap_or_default())
        }

        "k8s_helm_list" => {
            let releases = state.k8s.helm_list().await.map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(releases).unwrap_or_default())
        }

        _ => Err(format!("Unknown tool: {tool_name}")),
    }
}

// --- Helpers ---

fn get_str<'a>(args: &'a serde_json::Value, key: &str) -> Result<&'a str, String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("Missing '{}' parameter", key))
}

fn parse_memory_string(s: &str) -> Result<u64, String> {
    let s = s.trim().to_lowercase();
    if s.is_empty() {
        return Err("empty memory string".into());
    }
    if let Ok(bytes) = s.parse::<u64>() {
        return Ok(bytes);
    }
    let (num_str, multiplier) = if let Some(n) = s.strip_suffix("gi") {
        (n, 1024u64 * 1024 * 1024)
    } else if let Some(n) = s.strip_suffix("mi") {
        (n, 1024u64 * 1024)
    } else if let Some(n) = s.strip_suffix("ki") {
        (n, 1024u64)
    } else if let Some(n) = s.strip_suffix('g') {
        (n, 1_000_000_000u64)
    } else if let Some(n) = s.strip_suffix('m') {
        (n, 1_000_000u64)
    } else if let Some(n) = s.strip_suffix('k') {
        (n, 1_000u64)
    } else {
        return Err(format!("Invalid memory string: {s}"));
    };
    let num: f64 = num_str.parse().map_err(|_| format!("Invalid memory string: {s}"))?;
    Ok((num * multiplier as f64) as u64)
}

async fn resolve_stack_dir(state: &AppState, name: &str) -> Result<(String, Option<String>), String> {
    let containers = state
        .rt()
        .await
        .list_containers(true)
        .await
        .map_err(|e| e.to_string())?;
    let stacks = compose::extract_projects(&containers);
    let stack = stacks
        .into_iter()
        .find(|s| s.name == name)
        .ok_or_else(|| format!("Stack '{name}' not found"))?;
    let working_dir = stack
        .working_dir
        .ok_or_else(|| format!("Stack '{name}' has no working directory"))?;
    Ok((working_dir, stack.config_file))
}
