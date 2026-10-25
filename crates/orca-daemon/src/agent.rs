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
                extra_hosts: vec![],
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
            let health = crate::api::system_health_report(state, false).await;
            Ok(serde_json::to_value(health).unwrap_or_default())
        }

        "environment_status" => {
            let status =
                orca_backend_common::environment::check_environment(crate::api::other_engine(state).await.as_deref())
                    .await;
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
            let output = crate::stack_profiles::up(state, name, &dir, config.as_deref())
                .await
                .map_err(|e| e.to_string())?;
            let hooks = if output.success {
                crate::api::run_stack_hooks(state, &dir, config.as_deref()).await
            } else {
                Vec::new()
            };
            let mut body = serde_json::to_value(output).unwrap_or_default();
            body["hooks"] = serde_json::json!(hooks);
            Ok(body)
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
            let templates = orca_backend_common::templates::all_templates().await;
            Ok(serde_json::to_value(templates).unwrap_or_default())
        }

        "deploy_template" => {
            let id = get_str(&arguments, "id")?;
            let templates = orca_backend_common::templates::all_templates().await;
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
                extra_hosts: vec![],
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

        "instance_status" | "instance_up" | "instance_down" | "instance_logs" | "instance_env"
        | "instance_db_reset" => instance_tool(state, tool_name, &arguments)
            .await
            .map_err(|e| format!("{e:#}")),

        // === Stacks (through the API, so tools validate exactly as the app does) ===
        "stack_restart" => {
            api(
                state,
                "POST",
                &format!("/stacks/{}/restart", seg(&arguments, "name")?),
                None,
            )
            .await
        }
        "stack_pull" => {
            api(
                state,
                "POST",
                &format!("/stacks/{}/pull", seg(&arguments, "name")?),
                None,
            )
            .await
        }
        "stack_logs" => {
            let name = get_str(&arguments, "name")?;
            let (dir, config) = resolve_stack_dir(state, name).await?;
            let tail = arguments
                .get("tail")
                .and_then(|v| v.as_u64())
                .unwrap_or(100)
                .min(2000)
                .to_string();
            let mut args = vec![
                "-p".to_string(),
                name.to_string(),
                "logs".into(),
                "--no-color".into(),
                "--tail".into(),
                tail,
            ];
            if let Some(svc) = arguments.get("service").and_then(|v| v.as_str()) {
                if svc.starts_with('-') {
                    return Err(format!("'{svc}' is not a service name"));
                }
                args.push("--".into());
                args.push(svc.to_string());
            }
            let out = state
                .rt()
                .await
                .compose_args(&dir, config.as_deref(), &args)
                .await
                .map_err(|e| e.to_string())?;
            Ok(json!({ "logs": out.stdout, "errors": out.stderr }))
        }
        "deploy_project" => {
            api(
                state,
                "POST",
                "/stacks/deploy",
                Some(json!({ "path": get_str(&arguments, "path")? })),
            )
            .await
        }
        "stack_profiles" => {
            api(
                state,
                "GET",
                &format!("/stacks/{}/profiles", seg(&arguments, "name")?),
                None,
            )
            .await
        }
        "set_stack_profiles" => {
            let body = json!({
                "profiles": arguments.get("profiles").cloned().unwrap_or(json!([])),
                "apply": arguments.get("apply").and_then(|v| v.as_bool()).unwrap_or(true),
            });
            api(
                state,
                "PUT",
                &format!("/stacks/{}/profiles", seg(&arguments, "name")?),
                Some(body),
            )
            .await
        }
        "read_orca_yaml" => {
            api(
                state,
                "GET",
                &format!("/stacks/{}/orca-yaml", seg(&arguments, "name")?),
                None,
            )
            .await
        }
        "write_orca_yaml" => {
            let body = json!({ "text": get_str(&arguments, "text")? });
            api(
                state,
                "PUT",
                &format!("/stacks/{}/orca-yaml", seg(&arguments, "name")?),
                Some(body),
            )
            .await
        }

        // === Gateway ===
        "gateway_status" => api(state, "GET", "/gateway/status", None).await,
        "gateway_start" => api(state, "POST", "/gateway/start", None).await,
        "gateway_stop" => api(state, "POST", "/gateway/stop", None).await,
        "gateway_routes" => {
            // With whether each route's service runs, as the landing page shows it.
            let mut routes = api(state, "GET", "/gateway/routes", None).await?;
            let states = api(state, "GET", "/gateway/route-states", None)
                .await
                .unwrap_or_default();
            if let (Some(routes), Some(states)) = (routes.as_array_mut(), states.as_array()) {
                for r in routes.iter_mut() {
                    let st = states
                        .iter()
                        .find(|s| s["hostname"] == r["hostname"] && s["path"] == r["path"]);
                    if let (Some(st), Some(obj)) = (st, r.as_object_mut()) {
                        for k in ["state", "label", "group", "setup"] {
                            obj.insert(k.into(), st[k].clone());
                        }
                    }
                }
            }
            Ok(routes)
        }
        "gateway_requests" => {
            let mut q = format!(
                "/gateway/requests?limit={}&problems={}",
                arguments.get("limit").and_then(|v| v.as_u64()).unwrap_or(50).min(500),
                arguments.get("problems").and_then(|v| v.as_bool()).unwrap_or(false)
            );
            if let Some(query) = arguments.get("query").and_then(|v| v.as_str()) {
                q.push_str(&format!("&q={}", urlencoding::encode(query)));
            }
            api(state, "GET", &q, None).await
        }
        "identify_ports" => {
            api(
                state,
                "POST",
                &format!("/containers/{}/probe-ports", seg(&arguments, "container")?),
                None,
            )
            .await
        }
        "gateway_add_route" => {
            let port = arguments.get("port").and_then(|v| v.as_u64()).ok_or("Missing 'port'")?;
            let body = json!({
                "hostname": get_str(&arguments, "hostname")?,
                "container_name": get_str(&arguments, "container")?,
                "port": port,
                "path": arguments.get("path").and_then(|v| v.as_str()),
            });
            api(state, "POST", "/gateway/routes", Some(body)).await
        }
        "gateway_remove_route" => {
            api(
                state,
                "DELETE",
                &format!("/gateway/routes/{}", seg(&arguments, "hostname")?),
                None,
            )
            .await
        }

        // === Projects ===
        "workspace_status" => api(state, "GET", "/workspace", None).await,
        "setup_project" => {
            let body =
                json!({ "rerun_setup": arguments.get("rerun_setup").and_then(|v| v.as_bool()).unwrap_or(false) });
            let job = api(
                state,
                "POST",
                &format!("/workspace/projects/{}/setup", seg(&arguments, "key")?),
                Some(body),
            )
            .await?;
            wait_for_job(job).await
        }
        "check_for_update" => {
            let refresh = arguments.get("refresh").and_then(|v| v.as_bool()).unwrap_or(false);
            api(state, "GET", &format!("/update?refresh={refresh}"), None).await
        }
        "offer_update" => api(state, "POST", "/update/prompt", None).await,
        "join_workspace" => {
            let body = json!({
                "repo": get_str(&arguments, "repo")?,
                "folder": arguments.get("folder").and_then(|v| v.as_str()),
            });
            let job = api(state, "POST", "/workspace/join", Some(body)).await?;
            wait_for_job(job).await
        }
        "check_workspace" => api(state, "POST", "/workspace/check", None).await,
        "orca_docs" => crate::docs::read(
            arguments.get("topic").and_then(|v| v.as_str()),
            arguments.get("section").and_then(|v| v.as_str()),
        ),
        "find_database_services" => api(state, "GET", "/databases/own-services", None).await,
        "database_import" => {
            api(
                state,
                "POST",
                &format!(
                    "/databases/{}/{}/import",
                    seg(&arguments, "server")?,
                    seg(&arguments, "database")?
                ),
                Some(json!({
                    "container": get_str(&arguments, "container")?,
                    "database": arguments.get("source_database").and_then(|v| v.as_str()),
                })),
            )
            .await
        }
        "list_databases" => {
            let mut v = api(state, "GET", "/databases", None).await?;
            // Snapshots by name, so the tool can restore one.
            if let Some(servers) = v["servers"].as_array_mut() {
                for s in servers.iter_mut() {
                    let id = s["id"].as_str().unwrap_or("").to_string();
                    if let Some(dbs) = s["databases"].as_array_mut() {
                        for d in dbs.iter_mut() {
                            let name = d["name"].as_str().unwrap_or("").to_string();
                            let snaps: Vec<String> = crate::databases::snapshots(&id, &name)
                                .into_iter()
                                .map(|s| s.name)
                                .collect();
                            d["snapshot_files"] = json!(snaps);
                        }
                    }
                }
            }
            Ok(v)
        }
        "database_connection" => {
            let mut v = api(
                state,
                "GET",
                &format!(
                    "/databases/{}/{}/connection",
                    seg(&arguments, "server")?,
                    seg(&arguments, "database")?
                ),
                None,
            )
            .await?;
            // The password stays out of the conversation.
            if let Some(pw) = v["password"].as_str().map(str::to_string).filter(|p| !p.is_empty()) {
                for k in ["inside", "outside"] {
                    if let Some(u) = v[k].as_str() {
                        v[k] = json!(u.replace(&pw, "****"));
                    }
                }
            }
            v["password"] = json!("in the project's .env");
            Ok(v)
        }
        "database_snapshot" => {
            api(
                state,
                "POST",
                &format!(
                    "/databases/{}/{}/snapshots",
                    seg(&arguments, "server")?,
                    seg(&arguments, "database")?
                ),
                Some(json!({ "label": arguments.get("label").and_then(|v| v.as_str()) })),
            )
            .await
        }
        "database_restore" => {
            api(
                state,
                "POST",
                &format!(
                    "/databases/{}/{}/snapshots/{}/restore",
                    seg(&arguments, "server")?,
                    seg(&arguments, "database")?,
                    seg(&arguments, "snapshot")?
                ),
                None,
            )
            .await
        }
        "database_reset" => {
            api(
                state,
                "POST",
                &format!(
                    "/databases/{}/{}/reset",
                    seg(&arguments, "server")?,
                    seg(&arguments, "database")?
                ),
                None,
            )
            .await
        }
        "fetch_project_secrets" => {
            api(
                state,
                "POST",
                &format!("/workspace/projects/{}/secrets", seg(&arguments, "key")?),
                None,
            )
            .await
        }
        "update_workspace" => {
            let job = api(state, "POST", "/workspace/update", None).await?;
            wait_for_job(job).await
        }
        "list_projects" => api(state, "GET", "/dev/projects", None).await,
        "add_project" => {
            api(
                state,
                "POST",
                "/dev/projects",
                Some(json!({ "path": get_str(&arguments, "path")? })),
            )
            .await
        }
        "remove_project" => {
            api(
                state,
                "DELETE",
                &format!("/dev/projects/{}", seg(&arguments, "id")?),
                None,
            )
            .await
        }

        // === Builds ===
        "list_build_targets" => api(state, "GET", "/builds/targets", None).await,
        "start_build" => {
            api(
                state,
                "POST",
                &format!("/builds/targets/{}", seg(&arguments, "target")?),
                Some(json!({})),
            )
            .await
        }
        "build_status" => {
            let id = seg(&arguments, "id")?;
            let build = api(state, "GET", &format!("/builds/{id}"), None).await?;
            let logs = api(state, "GET", &format!("/builds/{id}/logs"), None)
                .await
                .unwrap_or_default();
            let tail = arguments.get("tail").and_then(|v| v.as_u64()).unwrap_or(60) as usize;
            let lines: Vec<String> = match &logs {
                serde_json::Value::Array(a) => a
                    .iter()
                    .map(|l| l.as_str().map(str::to_string).unwrap_or_else(|| l.to_string()))
                    .collect(),
                serde_json::Value::String(t) => t.lines().map(str::to_string).collect(),
                other => other
                    .get("logs")
                    .and_then(|l| l.as_str())
                    .map(|t| t.lines().map(str::to_string).collect())
                    .unwrap_or_default(),
            };
            let start = lines.len().saturating_sub(tail);
            Ok(json!({ "build": build, "log_tail": lines[start..] }))
        }

        "remove_volume" => api(state, "DELETE", &format!("/volumes/{}", seg(&arguments, "name")?), None).await,

        _ => Err(format!("Unknown tool: {tool_name}")),
    }
}

/// Worktree-instance tools. Agents identify their instance by the worktree
/// path they work in; Orca works out the project and instance from it.
async fn instance_tool(
    state: &Arc<AppState>,
    tool: &str,
    args: &serde_json::Value,
) -> anyhow::Result<serde_json::Value> {
    use crate::dev::{deploy, jobs, project};

    let worktree = args
        .get("worktree")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("Missing 'worktree' parameter: pass the absolute path of your git worktree"))?;
    let (project_id, name, wt) = deploy::resolve_path(state, std::path::Path::new(worktree)).await?;
    crate::dev::activity::touch(&project_id, &name).await;

    // Wait for a job, then summarise it for the agent.
    async fn finish(job: jobs::JobHandle) -> serde_json::Value {
        let id = job.snapshot().await.id;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20 * 60);
        loop {
            let j = jobs::get(&id).await;
            match j {
                Some(j) if j.status != jobs::JobStatus::Running || std::time::Instant::now() > deadline => {
                    let steps: Vec<String> = j
                        .steps
                        .iter()
                        .map(|s| {
                            format!(
                                "{:?}: {}{}",
                                s.status,
                                s.label,
                                s.detail.as_ref().map(|d| format!(" ({d})")).unwrap_or_default()
                            )
                        })
                        .collect();
                    let mut out = serde_json::json!({
                        "status": j.status,
                        "steps": steps,
                        "result": j.result,
                    });
                    if let Some(e) = &j.error {
                        out["error"] = serde_json::json!(e);
                        let tail: Vec<&String> = j
                            .log
                            .iter()
                            .rev()
                            .take(40)
                            .collect::<Vec<_>>()
                            .into_iter()
                            .rev()
                            .collect();
                        out["log_tail"] = serde_json::json!(tail);
                    }
                    return out;
                }
                Some(_) => tokio::time::sleep(std::time::Duration::from_millis(800)).await,
                None => return serde_json::json!({ "status": "unknown", "job": id }),
            }
        }
    }

    match tool {
        "instance_status" => {
            let ctx = project::ProjectCtx::load(state, &project_id).await?;
            let view = project::build_view(state, &ctx, false).await;
            let inst = view.instances.into_iter().find(|i| i.name == name);
            Ok(serde_json::json!({
                "project": project_id,
                "instance": inst,
                "shared": view.shared,
                "env_file": wt.join(".orca").join("env"),
            }))
        }
        "instance_up" => {
            let data_modes = match args.get("data") {
                Some(v) if !v.is_null() => {
                    Some(serde_json::from_value(v.clone()).map_err(|e| anyhow::anyhow!("invalid 'data': {e}"))?)
                }
                _ => None,
            };
            let opts = deploy::UpOptions {
                profiles: args
                    .get("profiles")
                    .and_then(|v| v.as_array())
                    .map(|a| a.iter().filter_map(|p| p.as_str()).map(str::to_string).collect()),
                build: Some(args.get("rebuild").and_then(|v| v.as_bool()).unwrap_or(true)),
                source: Some("mcp".into()),
                data_modes,
            };
            let job = deploy::up(state.clone(), project_id, name, opts).await?;
            Ok(finish(job).await)
        }
        "instance_down" => {
            let remove = args.get("remove").and_then(|v| v.as_bool()).unwrap_or(false);
            let mode = if remove {
                deploy::DownMode::Remove
            } else {
                deploy::DownMode::Stop
            };
            let job = deploy::down(state.clone(), project_id, name, mode).await?;
            Ok(finish(job).await)
        }
        "instance_logs" => {
            let tail = args.get("tail").and_then(|v| v.as_u64()).unwrap_or(200).min(2000) as u32;
            let service = args.get("service").and_then(|v| v.as_str());
            let text = deploy::logs(state, &project_id, &name, service, tail, None).await?;
            Ok(serde_json::json!({ "logs": text }))
        }
        "instance_env" => {
            let path = wt.join(".orca").join("env");
            let text = std::fs::read_to_string(&path).map_err(|_| {
                anyhow::anyhow!(
                    "{} doesn't exist yet: start the instance with instance_up first",
                    path.display()
                )
            })?;
            let vars: serde_json::Map<String, serde_json::Value> = text
                .lines()
                .filter(|l| !l.trim().is_empty() && !l.starts_with('#'))
                .filter_map(|l| l.split_once('='))
                .map(|(k, v)| (k.to_string(), serde_json::json!(v)))
                .collect();
            Ok(serde_json::json!({ "env_file": path, "vars": vars }))
        }
        "instance_db_reset" => {
            let service = args
                .get("service")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("Missing 'service' parameter"))?;
            let job = deploy::data_reset(state.clone(), project_id, name, service.to_string()).await?;
            Ok(finish(job).await)
        }
        _ => anyhow::bail!("unknown instance tool {tool}"),
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

/// A copy of a tool result with secrets blanked out, for the built-in AI
/// assistant: values of secret-looking keys and `KEY=value` env entries,
/// passwords in URLs, and the data of Kubernetes Secrets. What the provider
/// still sees is enough to diagnose with.
pub fn redact_secrets(v: &serde_json::Value) -> serde_json::Value {
    use serde_json::Value;
    match v {
        Value::Object(map) => {
            let is_k8s_secret = map
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|t| t == "Opaque" || t.starts_with("kubernetes.io/"))
                && map.contains_key("data");
            Value::Object(
                map.iter()
                    .map(|(k, val)| {
                        let out = match val {
                            Value::String(_) if secretish(k) => Value::String(MASK.into()),
                            Value::Object(data) if is_k8s_secret && (k == "data" || k == "stringData") => {
                                Value::Object(data.keys().map(|dk| (dk.clone(), Value::String(MASK.into()))).collect())
                            }
                            other => redact_secrets(other),
                        };
                        (k.clone(), out)
                    })
                    .collect(),
            )
        }
        Value::Array(items) => Value::Array(items.iter().map(redact_secrets).collect()),
        Value::String(s) => Value::String(redact_text(s)),
        other => other.clone(),
    }
}

const MASK: &str = "[redacted]";

/// A key or variable name that usually holds a secret.
fn secretish(name: &str) -> bool {
    let n = name.trim().trim_matches(|c| c == '"' || c == '\'').to_ascii_lowercase();
    [
        "pass",
        "secret",
        "token",
        "api_key",
        "apikey",
        "private_key",
        "credential",
        "auth",
        "dsn",
        "database_url",
        "session_key",
        "signing_key",
        "cookie",
    ]
    .iter()
    .any(|w| n.contains(w))
        || n == "key"
        || n.ends_with("_key")
        || n.ends_with("-key")
        || n.ends_with(".key")
        || n.ends_with("_pat")
}

/// Secrets in free text: logs, command output, a manifest, an .env file.
/// Line by line: `KEY=value` and `key: value` with a secret-looking key,
/// passwords in URLs, and the values of a Kubernetes Secret's `data:` and
/// `stringData:`.
pub fn redact_text(s: &str) -> String {
    let secret_manifest = s.lines().any(|l| l.trim() == "kind: Secret");
    let mut in_data = false;
    let mut out = String::with_capacity(s.len());
    for (i, line) in s.split('\n').enumerate() {
        if i > 0 {
            out.push('\n');
        }
        let indented = line.starts_with(' ') || line.starts_with('\t');
        if secret_manifest && !indented {
            let t = line.trim_end();
            in_data = t == "data:" || t == "stringData:";
        } else if in_data
            && indented
            && let Some((k, _)) = line.split_once(':')
        {
            out.push_str(k);
            out.push_str(": ");
            out.push_str(MASK);
            continue;
        }
        out.push_str(&redact_line(line));
    }
    out
}

fn redact_line(line: &str) -> String {
    let trimmed = line.trim_start();
    let lead = &line[..line.len() - trimmed.len()];
    let body = trimmed.strip_prefix("export ").unwrap_or(trimmed);
    let prefix = &trimmed[..trimmed.len() - body.len()];
    for sep in ['=', ':'] {
        if let Some((key, value)) = body.split_once(sep) {
            let key_ok = !key.is_empty() && !key.trim().contains(' ') && !key.contains("://");
            if key_ok && secretish(key) && !value.trim().is_empty() {
                let space = if sep == ':' { " " } else { "" };
                return format!("{lead}{prefix}{}{sep}{space}{MASK}", key.trim_end());
            }
        }
    }
    strip_url_passwords(line)
}

/// scheme://user:password@host → scheme://user:[redacted]@host, for every URL in the text.
fn strip_url_passwords(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find("://") {
        out.push_str(&rest[..i + 3]);
        rest = &rest[i + 3..];
        let end = rest
            .find(|c: char| c.is_whitespace() || c == '"' || c == '\'')
            .unwrap_or(rest.len());
        let authority = &rest[..end];
        match authority.find('@') {
            Some(at) if !authority[..at].contains('/') => match authority[..at].split_once(':') {
                Some((user, _)) => {
                    out.push_str(user);
                    out.push(':');
                    out.push_str(MASK);
                    out.push_str(&authority[at..]);
                }
                None => out.push_str(authority),
            },
            _ => out.push_str(authority),
        }
        rest = &rest[end..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod redact_tests {
    use super::redact_secrets;
    use serde_json::json;

    #[test]
    fn secrets_in_text_manifests_and_command_output() {
        let yaml = "apiVersion: v1\nkind: Secret\nmetadata:\n  name: db\ndata:\n  password: aHVudGVyMg==\n  user: YWRtaW4=\nstringData:\n  token: plain-tok\ntype: Opaque\n";
        let env = "APP_ENV=local\nAPP_KEY=base64:abcdef\nexport GITHUB_PAT=ghp_123\nREDIS_URL=redis://u:p4ss@r:6379 and https://a:b@c.example\n";
        let r = redact_secrets(&json!({ "yaml": yaml, "output": env, "logs": "db_password: hunter2" })).to_string();
        for leaked in [
            "aHVudGVyMg",
            "YWRtaW4",
            "plain-tok",
            "abcdef",
            "ghp_123",
            "p4ss",
            ":b@",
            "hunter2",
        ] {
            assert!(!r.contains(leaked), "{leaked} leaked: {r}");
        }
        for kept in [
            "name: db",
            "APP_ENV=local",
            "kind: Secret",
            "type: Opaque",
            "r:6379",
            "c.example",
        ] {
            assert!(r.contains(kept), "{kept} lost: {r}");
        }
    }

    #[test]
    fn secrets_are_blanked_and_the_rest_kept() {
        let v = json!({
            "name": "shop-api-1",
            "env": ["APP_ENV=local", "DB_PASSWORD=hunter2", "STRIPE_API_KEY=sk_live_x", "DATABASE_URL=postgres://app:pw@db/shop"],
            "labels": { "auth_token": "abc", "team": "web" },
            "url": "redis://:s3cret@redis:6379/0",
            "secret": { "type": "Opaque", "data": { "password": "aHVudGVyMg==", "user": "YWRtaW4=" } },
        });
        let r = redact_secrets(&v).to_string();
        for leaked in [
            "hunter2",
            "sk_live_x",
            "pw@",
            "abc",
            "s3cret",
            "aHVudGVyMg==",
            "YWRtaW4=",
        ] {
            assert!(!r.contains(leaked), "{leaked} leaked: {r}");
        }
        for kept in [
            "shop-api-1",
            "APP_ENV=local",
            "DB_PASSWORD=[redacted]",
            "\"team\":\"web\"",
            "@redis:6379/0",
        ] {
            assert!(r.contains(kept), "{kept} missing: {r}");
        }
    }
}

/// Follow a job the API started until it ends (at most 20 minutes), and
/// summarise it: status, steps, result, and the end of its log on failure.
async fn wait_for_job(job: serde_json::Value) -> Result<serde_json::Value, String> {
    let id = job
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or("the job has no id")?
        .to_string();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20 * 60);
    loop {
        let j = crate::dev::jobs::get(&id).await.ok_or("the job disappeared")?;
        if j.status != crate::dev::jobs::JobStatus::Running || std::time::Instant::now() > deadline {
            let steps: Vec<String> = j
                .steps
                .iter()
                .map(|s| {
                    format!(
                        "{:?}: {}{}",
                        s.status,
                        s.label,
                        s.detail.as_ref().map(|d| format!(" ({d})")).unwrap_or_default()
                    )
                })
                .collect();
            let mut out = json!({ "status": j.status, "steps": steps, "result": j.result });
            if let Some(e) = &j.error {
                out["error"] = json!(e);
                let start = j.log.len().saturating_sub(40);
                out["log_tail"] = json!(j.log[start..]);
            }
            return Ok(out);
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
}

/// A string argument made safe as one URL path segment.
fn seg(args: &serde_json::Value, key: &str) -> Result<String, String> {
    Ok(urlencoding::encode(get_str(args, key)?).into_owned())
}

/// Call one of the daemon's own API routes in-process, so a tool behaves and
/// validates exactly like the app. Errors carry the API's message.
pub(crate) async fn api(
    state: &Arc<AppState>,
    method: &str,
    path: &str,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    use tower::ServiceExt;
    let request = axum::http::Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json")
        .body(axum::body::Body::from(body.map(|b| b.to_string()).unwrap_or_default()))
        .map_err(|e| e.to_string())?;
    let response = crate::api::routes()
        .with_state(state.clone())
        .oneshot(request)
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 16 * 1024 * 1024)
        .await
        .map_err(|e| e.to_string())?;
    let value: serde_json::Value = if bytes.is_empty() {
        json!({ "ok": status.is_success() })
    } else {
        serde_json::from_slice(&bytes).unwrap_or_else(|_| json!(String::from_utf8_lossy(&bytes)))
    };
    if status.is_success() {
        Ok(value)
    } else {
        Err(value
            .get("error")
            .and_then(|e| e.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| format!("{status}: {value}")))
    }
}
