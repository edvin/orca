// Screenshots of the Orca app for the website, with a made-up demo machine
// (the "acme" projects), so no real names or paths show.
//
// Needs the GUI dev server: cd gui && npx vite --port 5199
//   node tools/capture-app.mjs            all shots -> raw-screens/
//   node tools/capture-app.mjs gateway    just one

import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, "raw-screens");
const BASE = process.env.APP_URL ?? "http://localhost:5199";
const exe = process.env.HOME + "/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

// --- The demo machine, injected into the page -------------------------------

function installMock(templates) {
  const HOME = "/Users/alex/code";
  let seq = 0;
  const hex = (n) => {
    let s = "";
    seq++;
    for (let i = 0; i < n; i++) s += ((seq * 2654435761 + i * 40503) >>> (i % 7)).toString(16).slice(-1);
    return s;
  };
  const now = Math.floor(Date.now() / 1000);
  const port = (c, h) => ({ host_ip: "0.0.0.0", host_port: h ?? c, container_port: c, protocol: "tcp" });

  // project, service, image, state, ports, extra
  const DEF = [
    ["shop", "web", "acme/shop-web:dev", "Running", [port(3000)], { health: "healthy" }],
    ["shop", "api", "acme/shop-api:dev", "Running", [port(8080)], { health: "healthy" }],
    ["shop", "worker", "acme/shop-api:dev", "Running", []],
    ["shop", "postgres", "postgres:17", "Running", [port(5432)], { health: "healthy" }],
    ["shop", "redis", "redis:7-alpine", "Running", [port(6379)]],
    ["shop", "soketi", "quay.io/soketi/soketi:1.6-16-debian", "Running", [port(6001)]],
    ["shop", "mailpit", "axllent/mailpit:v1.24", "Running", [port(8025), port(1025)]],
    ["shop-feature-checkout", "web", "acme/shop-web:dev", "Running", [port(3000, 41003)]],
    ["shop-feature-checkout", "api", "acme/shop-api:dev", "Running", [port(8080, 41004)]],
    ["shop-feature-checkout", "worker", "acme/shop-api:dev", "Running", []],
    ["sso", "keycloak", "quay.io/keycloak/keycloak:26.4", "Running", [port(8080, 8180)], { health: "healthy" }],
    ["sso", "postgres", "postgres:17", "Running", []],
    ["website", "wordpress", "wordpress:6.8", "Running", [port(80, 8081)]],
    ["website", "mysql", "mysql:8.4", "Running", [port(3306, 3307)]],
    ["telemetry", "grafana", "grafana/grafana:12.2", "Running", [port(3000, 3001)]],
    ["telemetry", "prometheus", "prom/prometheus:v3.6", "Running", [port(9090)]],
    ["telemetry", "loki", "grafana/loki:3.5", "Exited", []],
    ["orca-gateway", "caddy", "caddy:2.10-alpine", "Running", [port(80), port(443)]],
  ];
  const containers = DEF.map(([project, service, image, state, ports, extra = {}], i) => {
    const working = project === "shop-feature-checkout" ? `${HOME}/shop-feature-checkout` : `${HOME}/${project}`;
    return {
      id: hex(64),
      name: project === "orca-gateway" ? "orca-gateway" : `${project}-${service}-1`,
      image,
      state,
      ports,
      labels:
        project === "orca-gateway"
          ? { "orca.managed": "gateway" }
          : {
              "com.docker.compose.project": project,
              "com.docker.compose.service": service,
              "com.docker.compose.project.working_dir": working,
              "com.docker.compose.project.config_files": `${working}/compose.yaml`,
            },
      created_at: String(now - 3600 * (3 + i)),
      health_status: extra.health ?? null,
      restart_policy: "unless-stopped",
      restart_count: 0,
    };
  });
  const byName = Object.fromEntries(containers.map((c) => [c.name, c]));

  const stacks = [];
  for (const c of containers) {
    const p = c.labels["com.docker.compose.project"];
    if (!p) continue;
    let s = stacks.find((x) => x.name === p);
    if (!s) {
      s = { name: p, working_dir: c.labels["com.docker.compose.project.working_dir"], config_file: c.labels["com.docker.compose.project.config_files"], services: [], status: "Running" };
      stacks.push(s);
    }
    s.services.push({ name: c.labels["com.docker.compose.service"], container_id: c.id, container_name: c.name, image: c.image, state: c.state, ports: c.ports });
  }
  for (const s of stacks) {
    const run = s.services.filter((x) => x.state === "Running").length;
    s.status = run === s.services.length ? "Running" : run === 0 ? "Stopped" : "Partial";
  }

  const MB = 1048576;
  const baseMem = { "shop-web-1": 310, "shop-api-1": 420, "shop-worker-1": 260, "shop-postgres-1": 180, "shop-redis-1": 14, "shop-soketi-1": 62, "shop-mailpit-1": 28, "sso-keycloak-1": 610, "website-wordpress-1": 140, "website-mysql-1": 390, "telemetry-grafana-1": 120, "telemetry-prometheus-1": 210, "orca-gateway": 36, "shop-feature-checkout-web-1": 290, "shop-feature-checkout-api-1": 400, "shop-feature-checkout-worker-1": 240, "sso-postgres-1": 90 };
  const baseCpu = { "shop-web-1": 6, "shop-api-1": 9, "shop-worker-1": 3.5, "shop-postgres-1": 2.2, "sso-keycloak-1": 4.1, "telemetry-prometheus-1": 2.8, "shop-feature-checkout-web-1": 5, "website-mysql-1": 1.3 };
  const stats = () => {
    const t = Date.now() / 1000;
    return containers
      .filter((c) => c.state === "Running")
      .map((c, i) => {
        const cpu = (baseCpu[c.name] ?? 0.6) * (1 + 0.45 * Math.sin(t / 4 + i) + 0.2 * Math.sin(t / 1.3 + i * 2));
        return {
          container_id: c.id,
          cpu_percent: Math.max(0.05, cpu),
          memory_usage_bytes: (baseMem[c.name] ?? 50) * MB * (1 + 0.04 * Math.sin(t / 6 + i)),
          memory_limit_bytes: 16 * 1024 * MB,
          network_rx_bytes: 4.2e6 * (i + 1) + (t % 1000) * 900,
          network_tx_bytes: 1.3e6 * (i + 1) + (t % 1000) * 400,
          block_read_bytes: 4e7,
          block_write_bytes: 1e6,
        };
      });
  };

  const images = [
    ["acme/shop-web:dev", 412], ["acme/shop-api:dev", 538], ["postgres:17", 438], ["redis:7-alpine", 41], ["quay.io/soketi/soketi:1.6-16-debian", 196],
    ["axllent/mailpit:v1.24", 34], ["quay.io/keycloak/keycloak:26.4", 476], ["wordpress:6.8", 702], ["mysql:8.4", 773], ["grafana/grafana:12.2", 689],
    ["prom/prometheus:v3.6", 318], ["grafana/loki:3.5", 124], ["caddy:2.10-alpine", 52], ["node:24-slim", 239], ["elasticsearch:8.19.4", 1340],
  ].map(([tag, mb], i) => ({ id: "sha256:" + hex(64), repo_tags: [tag], size_bytes: mb * MB, created_at: String(now - 86400 * (i + 1)) }));

  const routes = [
    { hostname: "shop.localhost", container_name: "shop-web-1", port: 3000, enabled: true, owner: "project:shop", presentation: { title: "Storefront", description: "The customer-facing shop" } },
    { hostname: "shop.localhost", path: "/api/*", container_name: "shop-api-1", port: 8080, enabled: true, owner: "project:shop" },
    { hostname: "shop.localhost", path: "/app/*", container_name: "shop-soketi-1", port: 6001, enabled: true, owner: "project:shop" },
    { hostname: "mail.localhost", container_name: "shop-mailpit-1", port: 8025, enabled: true, owner: "project:shop", presentation: { title: "Mailpit" } },
    { hostname: "web-feature-checkout-shop.localhost", container_name: "shop-feature-checkout-web-1", port: 3000, enabled: true, owner: "dev:shop:feature-checkout" },
    { hostname: "sso.localhost", container_name: "sso-keycloak-1", port: 8080, enabled: true, owner: "label:sso-keycloak-1", presentation: { title: "Keycloak" } },
    { hostname: "website.localhost", container_name: "website-wordpress-1", port: 80, enabled: true, owner: "stack:website" },
    { hostname: "grafana.localhost", container_name: "telemetry-grafana-1", port: 3000, enabled: true },
  ].map((r) => ({ ...r, url: `https://${r.hostname}${(r.path ?? "").replace(/\*$/, "")}` }));

  const orcaYaml = `# Acme shop: how Orca runs it. https://orca-desktop.com/docs/orca-yaml/
gateway:
  - hostname: shop          # the storefront
    service: web
    port: 3000
    title: Storefront
    description: The customer-facing shop
  - hostname: shop
    service: api
    port: 8080
    path: /api/*
  - hostname: shop          # Laravel Echo connects to /app/ on this host
    service: soketi
    port: 6001
    path: /app/*
  - hostname: mail
    service: mailpit
    port: 8025
    title: Mailpit

links:
  Shop:
    - name: Storefront
      local: shop
      staging: https://staging.shop.example.com
      production: https://shop.example.com

hooks:
  after_up:
    - "api: php artisan migrate --force"
`;

  const svcDefs = [
    ["web", "acme/shop-web:dev", [], ["api"]], ["api", "acme/shop-api:dev", [], ["postgres", "redis"]], ["worker", "acme/shop-api:dev", [], ["postgres", "redis"]],
    ["postgres", "postgres:17", [], []], ["redis", "redis:7-alpine", [], []], ["soketi", "quay.io/soketi/soketi:1.6-16-debian", [], []],
    ["mailpit", "axllent/mailpit:v1.24", ["mail"], []], ["elasticsearch", "elasticsearch:8.19.4", ["search"], []], ["kibana", "kibana:8.19.4", ["search"], ["elasticsearch"]],
    ["xdebug-proxy", "acme/xdebug-proxy", ["debug"], []],
  ];
  const profilesReport = {
    profiles: [
      { name: "mail", services: ["mailpit"] },
      { name: "search", services: ["elasticsearch", "kibana"] },
      { name: "debug", services: ["xdebug-proxy"] },
    ],
    services: svcDefs.map(([name, image, profiles, depends_on]) => ({ name, image, profiles, depends_on, state: byName[`shop-${name}-1`]?.state ?? null })),
    active: ["mail"],
    remembered: true,
    running: true,
  };

  // Worktree projects (the /dev API).
  const inst = (name, branch, status, extra = {}) => ({
    name, path: `${HOME}/${name === "main" ? "shop" : "shop-" + name}`, branch, head: "4f2c9e1", is_main: name === "main", orphaned: false, dirty: name === "feature-checkout",
    ahead: name === "main" ? 0 : 3, upstream_gone: false, status, compose_project: name === "main" ? "shop" : `shop-${name}`,
    services: [], routes: [], ports: [], profiles: [], hostname_overrides: {}, data_modes: {}, tenants: {}, configured: true,
    started_by: "ui", last_started: new Date(Date.now() - 3600e3).toISOString(), job_id: null, last_error: null, ...extra,
  });
  const svc = (p, s, state = "running") => ({ name: s, state, container_id: hex(12), container_name: `${p}-${s}-1`, image: "acme/shop-web:dev" });
  const project = {
    id: "shop", root: `${HOME}/shop`, main_branch: "main",
    orca_yaml: { exists: true, has_dev: true, error: null }, shared_source: "orca.yaml",
    shared: [
      { name: "postgres", reason: null, image: "postgres:17", status: "running", container_id: hex(12), container_name: "shop-shared-postgres-1", ports: [{ host_port: 5432, container_port: 5432 }], data_mode: "own-database" },
      { name: "redis", reason: null, image: "redis:7-alpine", status: "running", container_id: hex(12), container_name: "shop-shared-redis-1", ports: [], data_mode: "shared" },
      { name: "mailpit", reason: null, image: "axllent/mailpit:v1.24", status: "running", container_id: hex(12), container_name: "shop-shared-mailpit-1", ports: [], data_mode: "shared" },
    ],
    instances: [
      inst("main", "main", "running", {
        services: ["web", "api", "worker"].map((s) => svc("shop", s)),
        routes: [{ service: "web", hostname: "web-main-shop.localhost", path: null, url: "https://web-main-shop.localhost" }, { service: "api", hostname: "web-main-shop.localhost", path: "/api*", url: "https://web-main-shop.localhost" }],
        tenants: {},
      }),
      inst("feature-checkout", "feature/checkout", "running", {
        services: ["web", "api", "worker"].map((s) => svc("shop-feature-checkout", s)),
        routes: [{ service: "web", hostname: "web-feature-checkout-shop.localhost", path: null, url: "https://web-feature-checkout-shop.localhost" }],
        data_modes: { postgres: "own-database" }, tenants: { postgres: "shop_feature_checkout" }, profiles: ["search"],
        ports: [{ service: "api", container_port: 9229, host_port: 41012 }],
      }),
      inst("agent-fix-tax", "fix/tax-rounding", "running", {
        services: ["web", "api", "worker"].map((s) => svc("shop-agent-fix-tax", s)),
        routes: [{ service: "web", hostname: "web-agent-fix-tax-shop.localhost", path: null, url: "https://web-agent-fix-tax-shop.localhost" }],
        started_by: "mcp", data_modes: { postgres: "own-database" }, tenants: { postgres: "shop_agent_fix_tax" },
      }),
      inst("spike-search", "spike/search-v2", "idle_stopped", { profiles: ["search"], last_started: new Date(Date.now() - 86400e3).toISOString() }),
    ],
    gateway: { running: true, domain: "localhost", https_port: 443, dns: { ok: true, host: "localhost", addresses: ["127.0.0.1"], problem: null } },
    errors: [],
  };

  const R = {
    get_status: { daemon_running: true }, start_daemon: {}, check_environment: { checks: [], all_passed: true }, subscribe_events: {},
    env_status: { ready: true, platform: "macos", suggested_runtime: "docker", checks: [
      { name: "Docker Runtime", description: "Docker engine is running", status: "Pass", fix_action: null, details: "Server version: 29.9.1" },
      { name: "Docker VM", description: "The Lima VM 'orca' is running", status: "Pass", fix_action: null, details: "Ubuntu 26.04 · 4 CPUs · 12 GB" },
      { name: "Docker Compose", description: "docker compose is available", status: "Pass", fix_action: null, details: "v5.1.4" },
      { name: "Gateway ports", description: "Ports 80 and 443 are free for the gateway", status: "Pass", fix_action: null, details: null },
    ] },
    get_machine_info: { name: "orca", status: "Running", cpus: 4, memory_gb: 12, disk_gb: 100, os: "Ubuntu 26.04" },
    get_version: "0.50.0",
    get_active_host: { id: null, name: "Local", url: "http://127.0.0.1:9477/api/v1", is_remote: false },
    list_remote_hosts: [], probe_all_hosts: [{ id: null, name: "Local", online: true, version: "0.50.0" }],
    list_containers: containers, list_stacks: stacks, list_images: images,
    list_volumes: ["shop_pgdata", "shop_redis", "sso_pgdata", "website_mysql", "telemetry_grafana", "telemetry_prometheus"].map((n) => ({ name: n, driver: "local", mountpoint: `/var/lib/docker/volumes/${n}/_data`, labels: {}, created_at: new Date().toISOString() })),
    list_networks: ["bridge", "shop_default", "sso_default", "website_default", "telemetry_default", "orca-gateway"].map((n, i) => ({ id: hex(64), name: n, driver: "bridge", subnet: `172.${18 + i}.0.0/16`, gateway: `172.${18 + i}.0.1`, labels: {} })),
    system_health: {
      docker_connected: true, docker_version: "29.9.1",
      disk_usage: { images_size_bytes: 7.6e9, containers_size_bytes: 3.1e8, volumes_size_bytes: 2.4e9, build_cache_size_bytes: 1.9e9, total_size_bytes: 1.22e10, reclaimable_bytes: 2.1e9, computed_at: now },
      system_resources: { cpu_count: 12, memory_total_bytes: 36 * 1024 ** 3, memory_available_bytes: 21 * 1024 ** 3, disk_total_bytes: 494e9, disk_free_bytes: 301e9, disk_usage_percent: 39 },
      warnings: [], os: "linux", arch: "arm64",
    },
    gateway_status: { running: true, container_id: "c4dd1e", routes_active: routes.length, domain: "localhost", http_port: 80, https_port: 443, tls_mode: "orca_ca", port_conflicts: [], stack_links: [], traefik_mode: "gateway_only" },
    gateway_list_routes: routes,
    gateway_get_config: { domain: "localhost", enabled: true, http_port: 80, https_port: 443, tls_mode: "orca_ca", routes, custom_cert: null, custom_key: null },
    gateway_get_links: [], gateway_get_dismissed: [], gateway_check_ports: { conflicts: [] },
    gateway_traefik_status: { mode: "gateway_only", traefik_detected: false, traefik_reachable: false },
    gateway_get_landing: { settings: { title: "Acme dev", subtitle: null, show_status: true, show_targets: true, search: true, web_search: "google" }, url: "https://localhost" },
    stack_profiles: profilesReport,
    stack_orca_yaml: {
      path: `${HOME}/shop/orca.yaml`, exists: true, reference: "https://orca-desktop.com/docs/orca-yaml/", text: orcaYaml, local_override: false, error: null,
      routes: routes.filter((r) => r.owner === "project:shop").map((r) => ({ hostname: r.hostname, path: r.path ?? null, service: r.container_name.replace(/^shop-|-1$/g, ""), port: r.port, status: "active", detail: "" })),
      has_dev: true, domain: "localhost",
      services: svcDefs.filter(([n]) => byName[`shop-${n}-1`]).map(([name, image]) => ({ name, image, ports: (byName[`shop-${name}-1`]?.ports ?? []).map((p) => p.container_port) })),
    },
    validate_orca_yaml: { ok: true, error: null, line: null, warnings: [] },
    get_activity: [], get_daemon_log: "", list_templates: templates,
    get_ai_settings: { provider: "custom", anthropic_model: "claude-sonnet-5-5", has_anthropic_key: false, has_openai_key: false, openai_model: "qwen3:8b", openai_url: "http://127.0.0.1:11434/v1", ready: true },
    ai_local_servers: { servers: [
      { kind: "ollama", name: "Ollama", url: "http://127.0.0.1:11434/v1", models: ["qwen3:8b", "qwen3-coder:30b", "gemma3:12b"] },
      { kind: "lmstudio", name: "LM Studio", url: "http://127.0.0.1:1234/v1", models: ["openai/gpt-oss-20b"] },
    ] },
    mcp_clients: [
      { id: "claude-code", name: "Claude Code", detected: true, connected: true, config_path: "~/.claude.json", after_connect: null },
      { id: "claude-desktop", name: "Claude Desktop", detected: true, connected: true, config_path: "claude_desktop_config.json", after_connect: null },
      { id: "cursor", name: "Cursor", detected: true, connected: false, config_path: "~/.cursor/mcp.json", after_connect: null },
      { id: "vscode", name: "VS Code", detected: true, connected: false, config_path: "mcp.json", after_connect: null },
      { id: "windsurf", name: "Windsurf", detected: false, connected: false, config_path: "", after_connect: null },
      { id: "codex", name: "Codex", detected: false, connected: false, config_path: "", after_connect: null },
    ],
    mcp_command: "/Users/you/Library/Application Support/orca/bin/orca",
    pick_folder: "/Users/alex/code/storefront",
    inspect_folder: { path: "/Users/alex/code/storefront", name: "storefront", compose_files: ["compose.yaml"], orca_yaml: true, git: true,
      services: ["web", "api", "worker", "postgres", "redis", "meilisearch"], profiles: ["search"], stack: null, error: null },
    folder_apps: [{ id: "vscode", label: "VS Code", kind: "editor" }, { id: "ghostty", label: "Ghostty", kind: "terminal" }],
    get_api_token: "orca_6f1d9c2e8b7a4f03a9d5c1e7b2f8a6d4", list_ai_models: { models: ["qwen3:8b", "qwen3-coder:30b", "gemma3:12b"] },
    list_remote_hosts: [
      { id: "h1", name: "staging", url: "https://orca.staging.acme.dev/api/v1", tls_verify: true, tags: ["staging", "eu-west"] },
      { id: "h2", name: "production", url: "https://orca.acme.dev/api/v1", tls_verify: true, tags: ["production", "eu-west"] },
      { id: "h3", name: "build-runner", url: "https://orca.ci.acme.dev/api/v1", tls_verify: true, tags: ["ci"] },
    ],
    probe_host: { online: true, version: "0.50.0", docker_connected: true, cpu_count: 8, memory_total: 32 * 1024 ** 3, memory_available: 19 * 1024 ** 3, disk_usage_percent: 41, containers_running: 14, containers_total: 15, images_total: 31, os: "Ubuntu 24.04", arch: "x86_64" },
    probe_all_hosts: [
      { id: null, name: "Local", online: true, version: "0.50.0" }, { id: "h1", name: "staging", online: true, version: "0.50.0" },
      { id: "h2", name: "production", online: true, version: "0.50.0" }, { id: "h3", name: "build-runner", online: true, version: "0.50.0" },
    ],
    list_schedules: [], list_registries: [], list_deploy_rules: [], list_deploy_history: [], list_build_targets: [],
  };

  // A small k3s cluster running the shop.
  const pod = (name, app, image, status = "Running", restarts = 0, age = "2d") => ({
    name, namespace: "default", status, ready: status === "Running" ? "1/1" : "0/1", restarts, age, node: "orca", ip: `10.42.0.${10 + name.length}`,
    containers: [{ name: app, image, ready: status === "Running", restart_count: restarts }],
  });
  const pods = [
    pod("web-7c9d8f6b5-2xkqp", "web", "ghcr.io/acme/shop-web:1.42.0"), pod("web-7c9d8f6b5-h8zvn", "web", "ghcr.io/acme/shop-web:1.42.0"),
    pod("api-5f7b9c8d4-mq2rt", "api", "ghcr.io/acme/shop-api:1.42.0"), pod("api-5f7b9c8d4-x7lpw", "api", "ghcr.io/acme/shop-api:1.42.0", "Running", 1),
    pod("worker-6d8c7b5f9-9qkzt", "worker", "ghcr.io/acme/shop-api:1.42.0"), pod("postgres-0", "postgres", "postgres:17", "Running", 0, "6d"),
    pod("redis-0", "redis", "redis:7-alpine", "Running", 0, "6d"), pod("migrate-29351840-8kq2v", "migrate", "ghcr.io/acme/shop-api:1.42.0", "Succeeded", 0, "41m"),
  ];
  const K8S = {
    k8s_status: { enabled: true, running: true, installed: true, version: "v1.34.1+k3s1", node_name: "orca", node_status: "Ready", pods_running: 7, pods_total: 8, traefik_dashboard: null },
    k8s_namespaces: ["shop", "default", "kube-system"].map((name) => ({ name, status: "Active", age: "6d" })),
    k8s_pods: pods,
    k8s_pod_metrics: pods.filter((p) => p.status === "Running").map((p, i) => ({ name: p.name, cpu: `${[12, 9, 31, 27, 6, 18, 3][i] ?? 4}m`, memory: `${[148, 151, 212, 207, 96, 184, 12][i] ?? 40}Mi` })),
    k8s_deployments: [
      { name: "web", namespace: "default", replicas_ready: 2, replicas_desired: 2, age: "2d", images: ["ghcr.io/acme/shop-web:1.42.0"] },
      { name: "api", namespace: "default", replicas_ready: 2, replicas_desired: 2, age: "2d", images: ["ghcr.io/acme/shop-api:1.42.0"] },
      { name: "worker", namespace: "default", replicas_ready: 1, replicas_desired: 1, age: "2d", images: ["ghcr.io/acme/shop-api:1.42.0"] },
    ],
    k8s_services: [
      { name: "web", namespace: "default", service_type: "ClusterIP", cluster_ip: "10.43.18.204", external_ip: null, ports: [{ name: "http", port: 80, target_port: "3000", node_port: null, protocol: "TCP" }], age: "2d" },
      { name: "api", namespace: "default", service_type: "ClusterIP", cluster_ip: "10.43.77.12", external_ip: null, ports: [{ name: "http", port: 80, target_port: "8080", node_port: null, protocol: "TCP" }], age: "2d" },
      { name: "postgres", namespace: "default", service_type: "ClusterIP", cluster_ip: "None", external_ip: null, ports: [{ name: "pg", port: 5432, target_port: "5432", node_port: null, protocol: "TCP" }], age: "6d" },
      { name: "redis", namespace: "default", service_type: "ClusterIP", cluster_ip: "None", external_ip: null, ports: [{ name: "redis", port: 6379, target_port: "6379", node_port: null, protocol: "TCP" }], age: "6d" },
    ],
  };
  window.__DEMO = { project };

  const devApi = (args) => {
    const p = args.path.split("?")[0];
    if (p === "/dev/projects") return [project];
    if (p === "/dev/candidates") return [];
    if (p.startsWith("/dev/jobs")) return [];
    if (p.endsWith("/plan")) {
      const q = new URLSearchParams(args.path.split("?")[1] ?? "");
      const sel = q.has("profiles") ? (q.get("profiles") || "").split(",").filter(Boolean) : ["search"];
      const profs = [{ name: "search", services: ["elasticsearch", "kibana"] }, { name: "debug", services: ["xdebug-proxy"] }];
      const on = ["api", "web", "worker", ...profs.filter((x) => sel.includes(x.name)).flatMap((x) => x.services)];
      return {
        instance: "spike-search", worktree: `${HOME}/shop-spike-search`, compose_project: "shop-spike-search", compose_files: [], resolved_mode: false,
        shared_services: ["postgres", "redis", "mailpit"], active_profiles: sel,
        data: [{ service: "postgres", kind: "postgres", shared_db: "shop", mode: "own-database", default_mode: "shared", tenant: "shop_spike_search", supports_own_database: true, own_database_note: null }],
        plan: { compose_project: "shop-spike-search", services: on, running_services: on, left_out: profs.filter((x) => !sel.includes(x.name)).flatMap((x) => x.services), profiles: profs,
          routes: [{ service: "web", hostname: "web-spike-search-shop.localhost", port: 3000, path: null, url: "https://web-spike-search-shop.localhost", container_name: "x" }, { service: "api", hostname: "web-spike-search-shop.localhost", port: 8080, path: "/api*", url: "https://web-spike-search-shop.localhost", container_name: "y" }],
          host_ports: [{ service: "api", container_port: 9229, host_port: 41020 }], networks: [], warnings: [], override_yaml: "", env_file: "", service_env: {}, own_databases: { postgres: { kind: "postgres", shared_db: "shop", tenant: "shop_spike_search" } }, own_servers: [] },
      };
    }
    return [];
  };

  window.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => {
      if (cmd === "all_container_stats") return stats();
      if (cmd === "container_stats") return stats().find((s) => s.container_id === args?.id) ?? stats()[0];
      if (cmd === "dev_api") return devApi(args);
      if (cmd === "inspect_container") {
        const c = containers.find((x) => x.id === args?.id || x.name === args?.id) ?? containers[0];
        return { ...c, exit_code: 0, oom_killed: false, started_at: new Date(Date.now() - 3 * 3600e3).toISOString(),
          command: c.name.includes("web") ? "npm run dev" : "php artisan serve --host=0.0.0.0 --port=8080",
          env: ["APP_ENV=local", "APP_URL=https://shop.localhost", "DB_HOST=postgres", "REDIS_HOST=redis", "PUSHER_HOST=shop.localhost"],
          mounts: [{ source: "/Users/alex/code/shop", destination: "/app", mode: "rw", type: "bind" }], health_log: [] };
      }
      if (cmd in R) return R[cmd];
      if (cmd in K8S) return K8S[cmd];
      if (cmd.startsWith("plugin:")) return null;
      if (cmd.startsWith("list_") || cmd.startsWith("k8s_")) return [];
      return {};
    },
    transformCallback: (fn) => { const id = Math.random().toString(36).slice(2); window[id] = fn; return id; },
    metadata: { currentWindow: { label: "main" } },
    convertFileSrc: (p) => p,
  };
}

// --- Shots -------------------------------------------------------------------

const SHOTS = {
  async dashboard(page) {
    await nav(page, "Dashboard");
    await page.waitForTimeout(26000); // let the charts fill
    return { full: true };
  },
  async containers(page) {
    await nav(page, "Containers");
    return { full: true };
  },
  async "stack-profiles"(page) {
    await openStack(page);
    return { clip: content };
  },
  async "orca-yaml-editor"(page) {
    await openStack(page);
    await page.locator(".detail-tab-item", { hasText: "orca.yaml" }).click();
    await page.waitForTimeout(1500);
    return { clip: content };
  },
  async gateway(page) {
    await nav(page, "Gateway");
    return { clip: content };
  },
  async worktrees(page) {
    await nav(page, "Projects");
    return { clip: content };
  },
  async "container-detail"(page) {
    await nav(page, "Containers");
    await page.getByText("api-1", { exact: true }).first().click().catch(() => {});
    await page.waitForTimeout(3000);
    return { clip: content };
  },
  async fleet(page) {
    await nav(page, "Fleet");
    await page.waitForTimeout(2500);
    return { clip: content };
  },
  async "app-catalog"(page) {
    await nav(page, "App Catalog");
    await page.waitForTimeout(1500);
    return { clip: content };
  },
  async images(page) {
    await nav(page, "Images");
    return { clip: content };
  },
  async "settings-ai"(page) {
    await nav(page, "Settings");
    await page.getByText("AI & agents", { exact: true }).first().click().catch(() => {});
    await page.waitForTimeout(1500);
    return { clip: content };
  },
  async "settings-assistant"(page) {
    await nav(page, "Settings");
    await page.getByText("AI & agents", { exact: true }).first().click().catch(() => {});
    await page.waitForTimeout(1500);
    const card = page.locator(".assistant-card");
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    const box = await card.boundingBox();
    return { clip: { x: box.x - 24, y: box.y - 64, width: box.width + 48, height: box.height + 96 } };
  },
  async "open-folder"(page) {
    await nav(page, "Dashboard");
    await page.locator(".page-actions button", { hasText: "Open folder" }).click();
    await page.waitForTimeout(500);
    await page.locator(".open-folder-pick button", { hasText: "Choose a folder" }).click();
    await page.waitForTimeout(1200);
    const box = await page.locator(".modal-dialog.open-folder").boundingBox();
    return { clip: { x: box.x - 40, y: box.y - 40, width: box.width + 80, height: box.height + 80 } };
  },
  async palette(page) {
    await nav(page, "Dashboard");
    await page.locator(".titlebar-search").first().click();
    await page.waitForTimeout(400);
    await page.keyboard.type("shop");
    await page.waitForTimeout(800);
    const box = await page.locator(".command-palette").boundingBox();
    return { clip: { x: box.x - 40, y: box.y - 40, width: box.width + 80, height: box.height + 80 } };
  },
  async "landing-settings"(page) {
    await nav(page, "Gateway");
    await page.locator(".tab-item, .detail-tab-item, button", { hasText: /^Landing page$/ }).first().click();
    await page.waitForTimeout(1200);
    const card = page.locator(".landing-search-card");
    await card.scrollIntoViewIfNeeded();
    const box = await card.boundingBox();
    return { clip: { x: box.x - 24, y: box.y - 24, width: box.width + 48, height: box.height + 48 } };
  },
  async kubernetes(page) {
    await nav(page, "Kubernetes");
    await page.waitForTimeout(2500);
    return { clip: content };
  },
  async "k8s-topology"(page) {
    await nav(page, "Kubernetes");
    await page.waitForTimeout(2000);
    await page.getByText("Topology", { exact: true }).first().click().catch(() => {});
    await page.waitForTimeout(2500);
    return { clip: content };
  },
  async "start-dialog"(page) {
    await nav(page, "Projects");
    const card = page.locator(".dev-card", { hasText: "spike-search" });
    await card.click();
    await page.waitForTimeout(1200);
    const start = page.getByRole("button", { name: /^Start/ }).last();
    if (await start.isVisible().catch(() => false)) await start.click();
    await page.waitForTimeout(1500);
    return { full: true };
  },
};

const content = { x: 220, y: 46, width: 1220, height: 838 };

async function nav(page, label) {
  await page.locator(".nav-label", { hasText: label }).first().click();
  await page.waitForTimeout(2200);
}
async function openStack(page) {
  await nav(page, "Containers");
  await page.locator(".stack-link", { hasText: /^shop›?$/ }).first().click();
  await page.waitForTimeout(2200);
}

const only = process.argv.slice(2);
// The real catalog: it's public, and makes the App Catalog shot honest.
const TEMPLATES = await fetch("https://orca-desktop.com/templates.json").then((r) => r.json()).then((d) => (Array.isArray(d) ? d : d.templates ?? [])).catch(() => []);
const browser = await chromium.launch({ executablePath: exe });
for (const [name, fn] of Object.entries(SHOTS)) {
  if (only.length && !only.includes(name)) continue;
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "dark" });
  await ctx.addInitScript(installMock, TEMPLATES);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("  pageerror", name, e.message));
  await page.goto(BASE);
  await page.addStyleTag({ content: "body { background: #0a0e14 !important; } *::-webkit-scrollbar { display: none; }" });
  await page.waitForTimeout(2500);
  const opts = await fn(page);
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, ...(opts.clip ? { clip: opts.clip } : {}) });
  console.log("captured", name);
  await ctx.close();
}

// The gateway's landing page, rendered by the daemon itself (see landing_demo in landing.rs).
if (!only.length || only.includes("landing-page")) {
  const html = process.env.LANDING_HTML;
  if (html) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2, colorScheme: "dark" });
    const page = await ctx.newPage();
    await page.goto("file://" + html);
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, "landing-page.png") });
    console.log("captured landing-page");
    await ctx.close();
  }
}
await browser.close();
