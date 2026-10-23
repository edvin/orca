//! Agent tool definitions for AI-driven container management.
//!
//! Provides a catalog of tools that can be exposed via MCP (Model Context Protocol)
//! or OpenAI-compatible function calling APIs.

use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
    pub category: String,
}

fn json_schema(properties: serde_json::Value) -> serde_json::Value {
    json!({
        "type": "object",
        "properties": properties,
    })
}

/// All available agent tools.
pub fn tool_catalog() -> Vec<ToolDefinition> {
    vec![
        // === Container Operations ===
        ToolDefinition {
            name: "list_containers".into(),
            description: "List all containers with their status, ports, and resource usage. Use this to get an overview of running workloads.".into(),
            parameters: json_schema(json!({})),
            category: "Containers".into(),
        },
        ToolDefinition {
            name: "inspect_container".into(),
            description: "Get detailed information about a container including env vars, mounts, network settings, exit code, and error messages. Essential for diagnosing issues.".into(),
            parameters: json_schema(json!({ "id": { "type": "string", "description": "Container ID or name" } })),
            category: "Containers".into(),
        },
        ToolDefinition {
            name: "container_logs".into(),
            description: "Get recent log output from a container. Use this to diagnose crashes, errors, and unexpected behavior.".into(),
            parameters: json_schema(json!({
                "id": { "type": "string", "description": "Container ID or name" },
                "tail": { "type": "integer", "description": "Number of recent lines to return", "default": 100 }
            })),
            category: "Containers".into(),
        },
        ToolDefinition {
            name: "container_stats".into(),
            description: "Get real-time CPU, memory, and network usage for a container. Use to identify resource exhaustion.".into(),
            parameters: json_schema(json!({ "id": { "type": "string", "description": "Container ID or name" } })),
            category: "Containers".into(),
        },
        ToolDefinition {
            name: "start_container".into(),
            description: "Start a stopped container.".into(),
            parameters: json_schema(json!({ "id": { "type": "string" } })),
            category: "Containers".into(),
        },
        ToolDefinition {
            name: "stop_container".into(),
            description: "Stop a running container gracefully.".into(),
            parameters: json_schema(json!({ "id": { "type": "string" } })),
            category: "Containers".into(),
        },
        ToolDefinition {
            name: "restart_container".into(),
            description: "Restart a container (stop then start). Useful for applying config changes or recovering from issues.".into(),
            parameters: json_schema(json!({ "id": { "type": "string" } })),
            category: "Containers".into(),
        },
        ToolDefinition {
            name: "exec_in_container".into(),
            description: "Execute a command inside a running container and return the output. Use for debugging, checking file contents, testing connectivity, etc.".into(),
            parameters: json_schema(json!({
                "id": { "type": "string", "description": "Container ID or name" },
                "command": { "type": "array", "items": { "type": "string" }, "description": "Command and arguments to execute" }
            })),
            category: "Containers".into(),
        },
        ToolDefinition {
            name: "create_and_run_container".into(),
            description: "Create and start a new container from an image with specified configuration.".into(),
            parameters: json_schema(json!({
                "image": { "type": "string", "description": "Docker image to use" },
                "name": { "type": "string", "description": "Container name" },
                "ports": { "type": "array", "items": { "type": "string" }, "description": "Port mappings in host:container format" },
                "env": { "type": "object", "description": "Environment variables as key-value pairs" },
                "volumes": { "type": "array", "items": { "type": "string" }, "description": "Volume mounts in host:container format" },
                "memory_limit": { "type": "string", "description": "Memory limit e.g. 512m, 1g" },
                "cpu_limit": { "type": "number", "description": "CPU core limit e.g. 0.5, 2.0" }
            })),
            category: "Containers".into(),
        },
        ToolDefinition {
            name: "remove_container".into(),
            description: "Remove a stopped container.".into(),
            parameters: json_schema(json!({ "id": { "type": "string" }, "force": { "type": "boolean", "default": false } })),
            category: "Containers".into(),
        },

        // === Diagnostics ===
        ToolDefinition {
            name: "diagnose_container".into(),
            description: "Comprehensive diagnosis of a container — returns inspect data, recent logs, resource stats, and exit info in one call. Use this as the first step when investigating any container issue.".into(),
            parameters: json_schema(json!({ "id": { "type": "string", "description": "Container ID or name" } })),
            category: "Diagnostics".into(),
        },
        ToolDefinition {
            name: "check_port_availability".into(),
            description: "Check if a port is available on the host or which container is using it.".into(),
            parameters: json_schema(json!({ "port": { "type": "integer" } })),
            category: "Diagnostics".into(),
        },
        ToolDefinition {
            name: "system_health".into(),
            description: "Get overall system health including Docker connection status, disk usage, memory, CPU, and any warnings.".into(),
            parameters: json_schema(json!({})),
            category: "Diagnostics".into(),
        },
        ToolDefinition {
            name: "environment_status".into(),
            description: "Check the container runtime environment — is Docker/Podman installed and running?".into(),
            parameters: json_schema(json!({})),
            category: "Diagnostics".into(),
        },

        // === Images ===
        ToolDefinition {
            name: "list_images".into(),
            description: "List all container images with their tags, sizes, and creation dates.".into(),
            parameters: json_schema(json!({})),
            category: "Images".into(),
        },
        ToolDefinition {
            name: "pull_image".into(),
            description: "Pull a container image from a registry.".into(),
            parameters: json_schema(json!({ "reference": { "type": "string", "description": "Image reference e.g. nginx:latest, postgres:16" } })),
            category: "Images".into(),
        },
        ToolDefinition {
            name: "remove_image".into(),
            description: "Remove a container image.".into(),
            parameters: json_schema(json!({ "id": { "type": "string" }, "force": { "type": "boolean", "default": false } })),
            category: "Images".into(),
        },
        ToolDefinition {
            name: "prune_images".into(),
            description: "Remove all unused images to free disk space.".into(),
            parameters: json_schema(json!({})),
            category: "Images".into(),
        },

        // === Compose Stacks ===
        ToolDefinition {
            name: "list_stacks".into(),
            description: "List all Docker Compose stacks with their services and status.".into(),
            parameters: json_schema(json!({})),
            category: "Stacks".into(),
        },
        ToolDefinition {
            name: "compose_up".into(),
            description: "Run docker compose up for a stack (starts all services).".into(),
            parameters: json_schema(json!({ "name": { "type": "string", "description": "Stack/project name" } })),
            category: "Stacks".into(),
        },
        ToolDefinition {
            name: "compose_down".into(),
            description: "Run docker compose down for a stack (stops and removes all services).".into(),
            parameters: json_schema(json!({ "name": { "type": "string" } })),
            category: "Stacks".into(),
        },
        ToolDefinition {
            name: "stack_restart".into(),
            description: "Restart every service of a compose stack (stop and start the containers as they are).".into(),
            parameters: json_schema(json!({ "name": { "type": "string", "description": "Stack (compose project) name" } })),
            category: "Stacks".into(),
        },
        ToolDefinition {
            name: "stack_pull".into(),
            description: "Pull the latest images for a stack's services. Run compose_up afterwards to recreate the services that changed.".into(),
            parameters: json_schema(json!({ "name": { "type": "string" } })),
            category: "Stacks".into(),
        },
        ToolDefinition {
            name: "stack_logs".into(),
            description: "Recent logs of a stack, all services interleaved and prefixed with the service name, or one service.".into(),
            parameters: json_schema(json!({ "name": { "type": "string" }, "service": { "type": "string", "description": "Only this service" }, "tail": { "type": "integer", "default": 100 } })),
            category: "Stacks".into(),
        },
        ToolDefinition {
            name: "deploy_project".into(),
            description: "Start the compose project in a folder (docker compose up -d) and apply its orca.yaml: gateway routes, setup hooks. Use it to run a project that isn't a stack yet.".into(),
            parameters: json_schema(json!({ "path": { "type": "string", "description": "Absolute path of the project folder, or of a compose file in it" } })),
            category: "Stacks".into(),
        },
        ToolDefinition {
            name: "stack_profiles".into(),
            description: "A stack's compose profiles: which optional services each one holds, which are on, and the state of every service.".into(),
            parameters: json_schema(json!({ "name": { "type": "string" } })),
            category: "Stacks".into(),
        },
        ToolDefinition {
            name: "set_stack_profiles".into(),
            description: "Choose which compose profiles a stack runs. Remembered for every later start. With apply (default true) and the stack running, starts what the new set adds and stops and removes what it leaves out (volumes are kept).".into(),
            parameters: json_schema(json!({ "name": { "type": "string" }, "profiles": { "type": "array", "items": { "type": "string" }, "description": "Profiles to run; [] for only the services without one" }, "apply": { "type": "boolean", "default": true } })),
            category: "Stacks".into(),
        },
        ToolDefinition {
            name: "read_orca_yaml".into(),
            description: "A stack's orca.yaml: its text, path, whether it exists, entries Orca skipped and why, the state of each gateway route, and a suggested first file when there is none.".into(),
            parameters: json_schema(json!({ "name": { "type": "string" } })),
            category: "Stacks".into(),
        },
        ToolDefinition {
            name: "write_orca_yaml".into(),
            description: "Write a stack's orca.yaml (gateway routes, links, build targets, setup hooks, dev section). Validated first; Orca applies it at once. Read it with read_orca_yaml first and keep what you don't mean to change.".into(),
            parameters: json_schema(json!({ "name": { "type": "string" }, "text": { "type": "string", "description": "The whole file" } })),
            category: "Stacks".into(),
        },

        // === Gateway ===
        ToolDefinition {
            name: "gateway_status".into(),
            description: "Whether the HTTPS gateway runs, its domain, ports, certificate mode and route count.".into(),
            parameters: json_schema(json!({})),
            category: "Gateway".into(),
        },
        ToolDefinition {
            name: "gateway_start".into(),
            description: "Start the HTTPS gateway (a managed Caddy container) so routes like https://shop.localhost work.".into(),
            parameters: json_schema(json!({})),
            category: "Gateway".into(),
        },
        ToolDefinition {
            name: "gateway_stop".into(),
            description: "Stop the HTTPS gateway. Routes stay configured.".into(),
            parameters: json_schema(json!({})),
            category: "Gateway".into(),
        },
        ToolDefinition {
            name: "gateway_routes".into(),
            description: "Every gateway route: hostname, path, container, port, whether it's enabled, and where it comes from (orca.yaml, labels, a worktree instance, or added by hand).".into(),
            parameters: json_schema(json!({})),
            category: "Gateway".into(),
        },
        ToolDefinition {
            name: "gateway_add_route".into(),
            description: "Route an HTTPS hostname (and optionally a path) to a container port through the gateway. A name without a dot gets the gateway's domain: 'shop' becomes shop.localhost. For a project, prefer gateway: entries in its orca.yaml so the team shares them.".into(),
            parameters: json_schema(json!({ "hostname": { "type": "string" }, "container": { "type": "string", "description": "Container name" }, "port": { "type": "integer", "description": "Port inside the container" }, "path": { "type": "string", "description": "Only this path, such as /api/*" } })),
            category: "Gateway".into(),
        },
        ToolDefinition {
            name: "gateway_remove_route".into(),
            description: "Remove a route that was added by hand (routes from orca.yaml, labels or worktree instances are managed there).".into(),
            parameters: json_schema(json!({ "hostname": { "type": "string", "description": "Full hostname, such as shop.localhost" } })),
            category: "Gateway".into(),
        },

        // === Orca itself ===
        ToolDefinition {
            name: "check_for_update".into(),
            description: "Whether a newer Orca is out: the running version, the latest release, and the headlines of each newer release. Use it when the developer asks if Orca is current, or when a feature they ask about isn't there (it may need a newer version).".into(),
            parameters: json_schema(json!({
                "refresh": { "type": "boolean", "description": "Ask GitHub now instead of using the check from the last hour" }
            })),
            category: "Orca".into(),
        },
        ToolDefinition {
            name: "offer_update".into(),
            description: "Show the Orca app's Update prompt for the latest version, when the developer wants to update. It doesn't install anything: the developer clicks Update, and Orca restarts, which ends this connection for a moment. Without the app (a daemon on a server), it returns the command to upgrade instead.".into(),
            parameters: json_schema(json!({})),
            category: "Orca".into(),
        },
        // === Workspace ===
        ToolDefinition {
            name: "workspace_status".into(),
            description: "The team workspace this machine joined: its shared services and every project in it (repo, whether it's cloned and running, its URLs, and secrets still missing from its .env). Use it to find a project by name or description before setting it up.".into(),
            parameters: json_schema(json!({})),
            category: "Workspace".into(),
        },
        ToolDefinition {
            name: "setup_project".into(),
            description: "Set up and start a workspace project by its key: clone it, create its .env and fill in secrets the developer's secret manager CLI can fetch, run its setup command, start the shared services it uses, and start it. Waits until done and returns its URLs. If secrets are missing, it stops before starting and lists them with links: ask the developer to fill them in Orca (Workspace page), never ask them to paste secrets into the chat. Then call it again.".into(),
            parameters: json_schema(json!({
                "key": { "type": "string", "description": "The project's key, from workspace_status" },
                "rerun_setup": { "type": "boolean", "description": "Run the setup command again even if it ran before" }
            })),
            category: "Workspace".into(),
        },
        ToolDefinition {
            name: "update_workspace".into(),
            description: "Pull the latest workspace file and apply it: network, gateway domain and certificate, shared services and routes.".into(),
            parameters: json_schema(json!({})),
            category: "Workspace".into(),
        },
        // === Projects (worktree instances) ===
        ToolDefinition {
            name: "list_projects".into(),
            description: "Projects registered for worktree instances: each git repository with its shared services and one instance per worktree (status, URLs, ports, data modes).".into(),
            parameters: json_schema(json!({})),
            category: "Worktree instances".into(),
        },
        ToolDefinition {
            name: "add_project".into(),
            description: "Register a git repository so each of its worktrees can run as its own instance. Any folder inside the repository works. Its orca.yaml dev: section configures it; without one, Orca suggests a setup.".into(),
            parameters: json_schema(json!({ "path": { "type": "string", "description": "Absolute path inside the repository" } })),
            category: "Worktree instances".into(),
        },
        ToolDefinition {
            name: "remove_project".into(),
            description: "Unregister a project. Stop its instances first; nothing in the repository is changed.".into(),
            parameters: json_schema(json!({ "id": { "type": "string", "description": "Project id from list_projects" } })),
            category: "Worktree instances".into(),
        },

        // === Builds ===
        ToolDefinition {
            name: "list_build_targets".into(),
            description: "Build targets from the builds: section of every project's orca.yaml.".into(),
            parameters: json_schema(json!({})),
            category: "Builds".into(),
        },
        ToolDefinition {
            name: "start_build".into(),
            description: "Build an image from a build target. Returns a build id; follow it with build_status.".into(),
            parameters: json_schema(json!({ "target": { "type": "string", "description": "Build target name" } })),
            category: "Builds".into(),
        },
        ToolDefinition {
            name: "build_status".into(),
            description: "A build's status, duration and the end of its log.".into(),
            parameters: json_schema(json!({ "id": { "type": "string" }, "tail": { "type": "integer", "default": 60 } })),
            category: "Builds".into(),
        },

        // === Volumes & Networks ===
        ToolDefinition {
            name: "remove_volume".into(),
            description: "Delete a volume and the data in it. It must not be in use.".into(),
            parameters: json_schema(json!({ "name": { "type": "string" } })),
            category: "Storage".into(),
        },
        ToolDefinition {
            name: "list_volumes".into(),
            description: "List all Docker volumes.".into(),
            parameters: json_schema(json!({})),
            category: "Storage".into(),
        },
        ToolDefinition {
            name: "list_networks".into(),
            description: "List all Docker networks.".into(),
            parameters: json_schema(json!({})),
            category: "Networking".into(),
        },
        ToolDefinition {
            name: "create_network".into(),
            description: "Create a new Docker network.".into(),
            parameters: json_schema(json!({
                "name": { "type": "string" },
                "driver": { "type": "string", "default": "bridge" }
            })),
            category: "Networking".into(),
        },

        // === Templates ===
        ToolDefinition {
            name: "list_templates".into(),
            description: "List available one-click app templates (databases, web servers, monitoring tools).".into(),
            parameters: json_schema(json!({})),
            category: "Templates".into(),
        },
        ToolDefinition {
            name: "deploy_template".into(),
            description: "Deploy a pre-configured app template (e.g., PostgreSQL, Redis, Grafana) with one click.".into(),
            parameters: json_schema(json!({
                "id": { "type": "string", "description": "Template ID e.g. postgres, redis, grafana" },
                "name": { "type": "string", "description": "Container name override" },
                "ports": { "type": "array", "items": { "type": "string" }, "description": "Port mapping overrides" },
                "env": { "type": "array", "items": { "type": "string" }, "description": "Env var overrides in KEY=value format" }
            })),
            category: "Templates".into(),
        },

        // === Kubernetes ===
        ToolDefinition {
            name: "k8s_status".into(),
            description: "Get Kubernetes cluster status including version, node info, and pod counts.".into(),
            parameters: json_schema(json!({})),
            category: "Kubernetes".into(),
        },
        ToolDefinition {
            name: "k8s_list_pods".into(),
            description: "List Kubernetes pods in a namespace.".into(),
            parameters: json_schema(json!({ "namespace": { "type": "string", "default": "default" } })),
            category: "Kubernetes".into(),
        },
        ToolDefinition {
            name: "k8s_apply_yaml".into(),
            description: "Apply a Kubernetes YAML manifest to create or update resources.".into(),
            parameters: json_schema(json!({ "yaml": { "type": "string", "description": "YAML manifest content" } })),
            category: "Kubernetes".into(),
        },
        ToolDefinition {
            name: "k8s_pod_logs".into(),
            description: "Get logs from a Kubernetes pod.".into(),
            parameters: json_schema(json!({
                "namespace": { "type": "string" },
                "name": { "type": "string" },
                "tail": { "type": "integer", "default": 100 }
            })),
            category: "Kubernetes".into(),
        },
        ToolDefinition {
            name: "k8s_list_namespaces".into(),
            description: "List all Kubernetes namespaces.".into(),
            parameters: json_schema(json!({})),
            category: "Kubernetes".into(),
        },
        ToolDefinition {
            name: "k8s_list_deployments".into(),
            description: "List Kubernetes deployments in a namespace.".into(),
            parameters: json_schema(json!({ "namespace": { "type": "string", "default": "default" } })),
            category: "Kubernetes".into(),
        },
        ToolDefinition {
            name: "k8s_list_services".into(),
            description: "List Kubernetes services in a namespace.".into(),
            parameters: json_schema(json!({ "namespace": { "type": "string", "default": "default" } })),
            category: "Kubernetes".into(),
        },
        ToolDefinition {
            name: "k8s_list_events".into(),
            description: "List recent Kubernetes events in a namespace (useful for debugging).".into(),
            parameters: json_schema(json!({ "namespace": { "type": "string", "default": "default" } })),
            category: "Kubernetes".into(),
        },
        ToolDefinition {
            name: "k8s_scale_deployment".into(),
            description: "Scale a Kubernetes deployment to a specific number of replicas.".into(),
            parameters: json_schema(json!({
                "namespace": { "type": "string" },
                "name": { "type": "string" },
                "replicas": { "type": "integer" }
            })),
            category: "Kubernetes".into(),
        },
        ToolDefinition {
            name: "k8s_restart_deployment".into(),
            description: "Restart a Kubernetes deployment (rolling restart).".into(),
            parameters: json_schema(json!({
                "namespace": { "type": "string" },
                "name": { "type": "string" }
            })),
            category: "Kubernetes".into(),
        },
        ToolDefinition {
            name: "k8s_delete_pod".into(),
            description: "Delete a Kubernetes pod (it will be recreated by its controller).".into(),
            parameters: json_schema(json!({
                "namespace": { "type": "string" },
                "name": { "type": "string" }
            })),
            category: "Kubernetes".into(),
        },
        ToolDefinition {
            name: "k8s_get_yaml".into(),
            description: "Get the YAML manifest of a Kubernetes resource.".into(),
            parameters: json_schema(json!({
                "kind": { "type": "string", "description": "Resource kind (e.g., pod, deployment, service)" },
                "namespace": { "type": "string" },
                "name": { "type": "string" }
            })),
            category: "Kubernetes".into(),
        },
        ToolDefinition {
            name: "k8s_list_configmaps".into(),
            description: "List ConfigMaps in a namespace.".into(),
            parameters: json_schema(json!({ "namespace": { "type": "string", "default": "default" } })),
            category: "Kubernetes".into(),
        },
        ToolDefinition {
            name: "k8s_list_secrets".into(),
            description: "List Secrets in a namespace (names only, not values).".into(),
            parameters: json_schema(json!({ "namespace": { "type": "string", "default": "default" } })),
            category: "Kubernetes".into(),
        },
        ToolDefinition {
            name: "k8s_list_ingresses".into(),
            description: "List Ingresses in a namespace.".into(),
            parameters: json_schema(json!({ "namespace": { "type": "string", "default": "default" } })),
            category: "Kubernetes".into(),
        },
        ToolDefinition {
            name: "k8s_helm_list".into(),
            description: "List installed Helm releases.".into(),
            parameters: json_schema(json!({})),
            category: "Kubernetes".into(),
        },
        // === Worktree instances ===
        ToolDefinition {
            name: "instance_status".into(),
            description: "Status of the Orca instance for a git worktree: whether it runs, its URLs, host ports, services, shared services and where its .orca/env file is. Pass the worktree path you are working in. Use this before testing to find the app's URLs.".into(),
            parameters: json!({
                "type": "object",
                "properties": { "worktree": { "type": "string", "description": "Absolute path of the git worktree (your current working directory)" } },
                "required": ["worktree"]
            }),
            category: "Worktree instances".into(),
        },
        ToolDefinition {
            name: "instance_up".into(),
            description: "Start or rebuild the Orca instance for a git worktree, so this branch's code runs with its own URLs and ports while databases are shared. Waits until it is up and returns URLs, host ports, the env file path, and the error with log tail if it fails. Rebuilds images from the worktree's code by default.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "worktree": { "type": "string", "description": "Absolute path of the git worktree" },
                    "profiles": { "type": "array", "items": { "type": "string" }, "description": "Compose profiles to run besides the services without one, e.g. [\"search\"]. Remembered for the next start; [] runs only the default services. Omit to keep the last choice." },
                    "rebuild": { "type": "boolean", "description": "Rebuild images from the worktree's code (default true)" },
                    "data": { "type": "object", "description": "Data mode per shared service, e.g. {\"postgres\": \"own-database\"}. Modes: shared, own-database (a copy just for this worktree), own-server. Use own-database before running migrations or writing test data.", "additionalProperties": { "type": "string", "enum": ["shared", "own-database", "own-server"] } }
                },
                "required": ["worktree"]
            }),
            category: "Worktree instances".into(),
        },
        ToolDefinition {
            name: "instance_down".into(),
            description: "Stop the Orca instance for a git worktree. Host ports and settings are kept for the next start. With remove=true also deletes its volumes, images, own databases and generated files.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "worktree": { "type": "string", "description": "Absolute path of the git worktree" },
                    "remove": { "type": "boolean", "description": "Also delete volumes, images, own databases and .orca files (default false)" }
                },
                "required": ["worktree"]
            }),
            category: "Worktree instances".into(),
        },
        ToolDefinition {
            name: "instance_logs".into(),
            description: "Recent logs of the Orca instance for a git worktree, all services interleaved or one service.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "worktree": { "type": "string", "description": "Absolute path of the git worktree" },
                    "service": { "type": "string", "description": "Only this service" },
                    "tail": { "type": "integer", "description": "Lines per service (default 200)" }
                },
                "required": ["worktree"]
            }),
            category: "Worktree instances".into(),
        },
        ToolDefinition {
            name: "instance_env".into(),
            description: "URLs, host ports and database names of the Orca instance for a git worktree, as key/value pairs (the contents of .orca/env). Use these to point tests or scripts at this worktree's running app.".into(),
            parameters: json!({
                "type": "object",
                "properties": { "worktree": { "type": "string", "description": "Absolute path of the git worktree" } },
                "required": ["worktree"]
            }),
            category: "Worktree instances".into(),
        },
        ToolDefinition {
            name: "instance_db_reset".into(),
            description: "Reset this worktree's own database in a shared service to a fresh copy of the shared data. Only works when the instance uses own-database mode for that service. Deletes the worktree's changes to that database.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "worktree": { "type": "string", "description": "Absolute path of the git worktree" },
                    "service": { "type": "string", "description": "Shared service, e.g. postgres" }
                },
                "required": ["worktree", "service"]
            }),
            category: "Worktree instances".into(),
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn tool_catalog_has_tools() {
        let catalog = tool_catalog();
        assert!(!catalog.is_empty(), "tool catalog should not be empty");
    }

    #[test]
    fn tool_catalog_all_have_names() {
        for tool in tool_catalog() {
            assert!(!tool.name.is_empty(), "every tool must have a non-empty name");
        }
    }

    #[test]
    fn tool_catalog_all_have_descriptions() {
        for tool in tool_catalog() {
            assert!(
                !tool.description.is_empty(),
                "tool '{}' must have a non-empty description",
                tool.name
            );
        }
    }

    #[test]
    fn tool_catalog_unique_names() {
        let catalog = tool_catalog();
        let mut seen = HashSet::new();
        for tool in &catalog {
            assert!(seen.insert(&tool.name), "duplicate tool name: '{}'", tool.name);
        }
    }

    #[test]
    fn tool_catalog_has_diagnose_container() {
        let catalog = tool_catalog();
        assert!(
            catalog.iter().any(|t| t.name == "diagnose_container"),
            "catalog must contain the 'diagnose_container' diagnostic tool"
        );
    }
}
