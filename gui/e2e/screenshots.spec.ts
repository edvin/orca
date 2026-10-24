import { test, Page } from "@playwright/test";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCREENSHOT_DIR = process.env.ORCA_SCREENSHOT_DIR ?? path.join(__dirname, "../../screenshots");

// Read API token from local daemon config (Node.js context).
// This token authenticates to the Orca daemon which ONLY listens on
// 127.0.0.1:9477 (localhost) — it is not network-accessible.
// See: crates/orca-daemon/src/main.rs (--host default_value = "127.0.0.1")
function readApiToken(): string {
  if (process.env.ORCA_API_TOKEN) return process.env.ORCA_API_TOKEN;
  const home = process.env.HOME || "~";
  // Linux, then macOS.
  for (const rel of [".config/orca/config.json", "Library/Application Support/orca/config.json"]) {
    try {
      const config = JSON.parse(fs.readFileSync(path.join(home, rel), "utf-8"));
      if (config.api_token) return config.api_token;
    } catch {
      // try the next location
    }
  }
  return "localhost-only-test-token"; // nosemgrep: generic-api-key
}

const API_TOKEN = readApiToken();

// Mock the Tauri IPC bridge so invoke() calls go to the daemon's REST API
async function injectTauriBridge(page: Page) {
  await page.addInitScript((token) => {
    // Mock Tauri globals before the app loads
    (window as any).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: any) => {
        const DAEMON = "/api/v1";
        const AUTH = { "Authorization": "Bearer " + token };
        const fetchJson = (url) => fetch(url, { headers: AUTH }).then(r => r.ok ? r.json() : []);

        // Route commands to REST endpoints
        const routes = {
          // App lifecycle
          get_status: () => Promise.resolve({ daemon_running: true }),
          start_daemon: () => Promise.resolve({}),
          check_environment: () => Promise.resolve({ checks: [], all_passed: true }),
          subscribe_events: () => Promise.resolve({}),
          // Containers
          list_containers: () => fetchJson(DAEMON +"/containers"),
          // The pages that call the daemon's API by path.
          databases_api: () => fetch(DAEMON + args.path, {
            method: args.method,
            headers: { ...AUTH, "Content-Type": "application/json" },
            body: args.body ? JSON.stringify(args.body) : undefined,
          }).then(r => r.json()),
          workspace_api: () => fetch(DAEMON + args.path, {
            method: args.method,
            headers: { ...AUTH, "Content-Type": "application/json" },
            body: args.body ? JSON.stringify(args.body) : undefined,
          }).then(r => r.json()),
          probe_container_ports: () => fetch(DAEMON + "/containers/" + encodeURIComponent(args.id) + "/probe-ports", { method: "POST", headers: AUTH })
            .then(r => r.json()),
          container_stats: () => fetchJson(DAEMON +"/containers/" + (args?.id || "") + "/stats")
            .catch(() => ({ cpu_percent: 0, memory_usage_bytes: 0, memory_limit_bytes: 0 })),
          container_logs: () => fetch(DAEMON +"/containers/" + args.id + "/logs?follow=false&tail=" + (args.tail || 100), { headers: AUTH })
            .then(r => r.text())
            .then(text => {
              const lines = [];
              text.split(String.fromCharCode(10)).forEach(l => {
                if (l.startsWith("data:")) lines.push(l.substring(5));
              });
              return lines;
            }),
          all_container_stats: () => fetchJson(DAEMON +"/containers/stats"),
          start_container: () => Promise.resolve({}),
          stop_container: () => Promise.resolve({}),
          inspect_container: () => fetchJson(DAEMON +"/containers/" + args.id),
          container_list_files: () => fetchJson(DAEMON +"/containers/" + args.id + "/files" + (args.path ? "?path=" + encodeURIComponent(args.path) : "")),
          container_read_file: () => fetchJson(DAEMON +"/containers/" + args.id + "/file?path=" + encodeURIComponent(args.path)),
          // Images
          list_images: () => fetchJson(DAEMON +"/images"),
          inspect_image: () => fetchJson(DAEMON +"/images/" + encodeURIComponent(args.id)),
          image_history: () => fetchJson(DAEMON +"/images/" + encodeURIComponent(args.id) + "/history"),
          scan_image: () => fetchJson(DAEMON +"/images/" + encodeURIComponent(args.id) + "/scan"),
          // Volumes
          list_volumes: () => fetchJson(DAEMON +"/volumes"),
          // Networks
          list_networks: () => fetchJson(DAEMON +"/networks"),
          network_topology: () => fetchJson(DAEMON +"/networks/topology"),
          // Stacks
          list_stacks: () => fetchJson(DAEMON +"/stacks"),
          // K8s
          k8s_status: () => fetchJson(DAEMON +"/k8s/status"),
          k8s_pods: () => fetchJson(DAEMON +"/k8s/pods/" + (args.namespace || "default")),
          k8s_deployments: () => fetchJson(DAEMON +"/k8s/deployments/" + (args.namespace || "default")),
          k8s_services: () => fetchJson(DAEMON +"/k8s/services/" + (args.namespace || "default")),
          k8s_ingresses: () => fetchJson(DAEMON +"/k8s/ingresses/" + (args.namespace || "default")),
          k8s_events: () => fetchJson(DAEMON +"/k8s/events/" + (args.namespace || "default")),
          k8s_namespaces: () => fetchJson(DAEMON +"/k8s/namespaces"),
          k8s_pvcs: () => fetchJson(DAEMON +"/k8s/pvcs/" + (args.namespace || "default")),
          k8s_pvs: () => fetchJson(DAEMON +"/k8s/pvs"),
          k8s_configmaps: () => fetchJson(DAEMON +"/k8s/configmaps/" + (args.namespace || "default")),
          k8s_secrets: () => fetchJson(DAEMON +"/k8s/secrets/" + (args.namespace || "default")),
          k8s_helm_list: () => fetchJson(DAEMON +"/k8s/helm/releases"),
          k8s_helm_available: () => fetchJson(DAEMON +"/k8s/helm/available"),
          k8s_pod_metrics: () => fetchJson(DAEMON +"/k8s/pods/" + (args.namespace || "default") + "/metrics"),
          k8s_jobs: () => fetchJson(DAEMON +"/k8s/jobs/" + (args.namespace || "default")),
          k8s_cronjobs: () => fetchJson(DAEMON +"/k8s/cronjobs/" + (args.namespace || "default")),
          k8s_list_port_forwards: () => Promise.resolve([]),
          // System
          system_health: () => fetchJson(DAEMON +"/system/health"),
          environment_status: () => fetchJson(DAEMON +"/environment/status"),
          // Settings / config
          get_ai_settings: () => fetchJson(DAEMON +"/settings/ai"),
          list_registries: () => fetchJson(DAEMON +"/registries"),
          list_templates: () => fetchJson(DAEMON +"/templates"),
          get_api_token: () => Promise.resolve("mock-token"),
          get_wsl_config: () => Promise.resolve({ memory: "", processors: "", swap: "" }),
          // Fleet / remote hosts
          list_remote_hosts: () => Promise.resolve([
            { id: "fleet-1", name: "Production", url: "http://10.10.10.201:9477/api/v1", tls_verify: false, tags: ["production", "eu-west"] },
            { id: "fleet-2", name: "Staging", url: "http://10.10.10.202:9477/api/v1", tls_verify: false, tags: ["staging", "eu-west"] },
          ]),
          get_active_host: () => Promise.resolve({ id: null, name: "Local", url: "http://127.0.0.1:9477/api/v1", is_remote: false }),
          probe_host: () => Promise.resolve({
            online: true, version: "0.16.0", docker_connected: true,
            cpu_count: 4, memory_total: 8589934592, memory_available: 4294967296,
            disk_usage_percent: 45.0, containers_running: 3, containers_total: 5,
            images_total: 12, os: "linux", arch: "x86_64",
          }),
          probe_all_hosts: () => Promise.resolve([
            { id: null, name: "Local", online: true, version: "0.16.0" },
            { id: "fleet-1", name: "Production", online: true, version: "0.16.0" },
            { id: "fleet-2", name: "Staging", online: true, version: "0.16.0" },
          ]),
          switch_host: () => Promise.resolve({ host: "Local", url: "http://127.0.0.1:9477/api/v1" }),
          env_status: () => Promise.resolve({ ready: true, checks: [{ name: "Docker", status: "ok", message: "Docker is running" }], all_passed: true }),
          // Activity
          get_activity: () => Promise.resolve([]),
          get_daemon_log: () => Promise.resolve(""),
          // Version
          get_version: () => Promise.resolve("0.6.1"),
          // Projects (worktree dev instances)
          dev_api: () => fetch(DAEMON + args.path, {
            method: args.method,
            headers: { ...AUTH, "Content-Type": "application/json" },
            body: args.body ? JSON.stringify(args.body) : undefined,
          }).then(async (r) => {
            const j = await r.json().catch(() => null);
            if (!r.ok) throw (j && j.error) || "request failed";
            return j;
          }),
          pick_folder: () => Promise.resolve(null),
          reveal_path: () => Promise.resolve(null),
          // Gateway
          gateway_status: () => Promise.resolve({
            running: true, container_id: "abc123", routes_active: 4,
            domain: "localhost", http_port: 80, https_port: 443, tls_mode: "orca_ca",
            port_conflicts: [],
            stack_links: [
              {
                stack: "webmail-stalwart",
                group: "Mail",
                links: [
                  { name: "Webmail", urls: { local: "webmail", staging: "https://mail.staging.example.com", production: "https://mail.example.com" } },
                  { name: "Admin Panel", urls: { local: "mail-admin", staging: "https://admin.staging.example.com" } },
                ],
              },
              {
                stack: "my-project",
                group: "Frontend",
                links: [
                  { name: "Web App", urls: { local: "app", staging: "https://staging.example.com", production: "https://www.example.com" } },
                  { name: "Storybook", urls: { local: "app/storybook" } },
                ],
              },
              {
                stack: "my-project",
                group: "Backend",
                links: [
                  { name: "API", urls: { local: "api", staging: "https://staging-api.example.com", production: "https://api.example.com" } },
                  { name: "API Docs", urls: { local: "api/docs", staging: "https://staging-api.example.com/docs" } },
                ],
              },
            ],
          }),
          gateway_list_routes: () => Promise.resolve([
            { hostname: "webmail.localhost", container_name: "webmail-stalwart-webmail-1", port: 8095, enabled: true },
            { hostname: "mail-admin.localhost", container_name: "webmail-stalwart-stalwart-1", port: 8080, enabled: true },
            { hostname: "app.localhost", container_name: "my-project-frontend-1", port: 3000, enabled: true },
            { hostname: "app.localhost", container_name: "my-project-ws-1", port: 4000, enabled: true, path: "/ws/*" },
            { hostname: "api.localhost", container_name: "my-project-backend-1", port: 8080, enabled: true },
          ]),
          gateway_get_config: () => Promise.resolve({
            enabled: true, domain: "localhost", http_port: 80, https_port: 443,
            tls_mode: "orca_ca", routes: [],
            stack_links: [],
          }),
          gateway_get_links: () => Promise.resolve([]),
          gateway_check_ports: () => Promise.resolve({ conflicts: [] }),
        };

        const handler = routes[cmd];
        if (handler) {
          try {
            return await handler();
          } catch (e) {
            console.warn("Mock invoke failed for", cmd, e);
            return cmd.startsWith("list_") || cmd.startsWith("k8s_") ? [] : {};
          }
        }

        console.warn("Unmocked Tauri command:", cmd, args);
        // Return sensible defaults for unknown commands
        if (cmd.startsWith("list_") || cmd.endsWith("s")) return [];
        return {};
      },
      convertFileSrc: (path) => path,
    };

    // Mock Tauri event system
    window.__TAURI_INTERNALS__.metadata = { currentWindow: { label: "main" } };
    window.__TAURI_INTERNALS__.transformCallback = (fn) => {
      const id = Math.random().toString(36).slice(2);
      window[id] = fn;
      return id;
    };

    // Mock @tauri-apps/api/event listen function
    if (!(window as any).__TAURI_INTERNALS__.event) {
      (window as any).__TAURI_INTERNALS__.event = {};
    }
  }, API_TOKEN);
}

// Helper: wait for page to settle
async function waitForPageLoad(page: Page, timeout = 5000) {
  await page.waitForTimeout(2000);
  try {
    await page.waitForLoadState("networkidle", { timeout });
  } catch { /* polling pages won't settle */ }
  await page.waitForTimeout(500);
}

// Helper: navigate via sidebar
async function navigateTo(page: Page, label: string) {
  // Ensure sidebar is expanded (might be collapsed after detail navigation)
  const navLabel = page.locator(".nav-label", { hasText: label });
  if (!await navLabel.isVisible({ timeout: 1000 }).catch(() => false)) {
    // Sidebar might be collapsed — click the toggle to expand
    const toggle = page.locator(".sidebar-toggle, .nav-toggle").first();
    if (await toggle.isVisible({ timeout: 500 }).catch(() => false)) {
      await toggle.click();
      await page.waitForTimeout(300);
    }
  }
  await navLabel.click();
  await waitForPageLoad(page);
}

// Helper: select K8s namespace
async function selectK8sNamespace(page: Page, ns: string) {
  const nsDropdown = page.locator("text=Namespace:").locator("..").locator("button, .dropdown-trigger").first();
  if (await nsDropdown.isVisible({ timeout: 2000 }).catch(() => false)) {
    await nsDropdown.click();
    await page.waitForTimeout(400);
    const option = page.getByText(ns, { exact: true }).first();
    if (await option.isVisible({ timeout: 1000 }).catch(() => false)) {
      await option.click();
      await waitForPageLoad(page);
    }
  }
}

// Helper: screenshot
async function screenshot(page: Page, name: string) {
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, `${name}.png`),
    fullPage: false,
  });
  console.log(`  Screenshot saved: ${name}.png`);
}

test.describe("Orca Desktop Screenshots", () => {
  test.beforeEach(async ({ page }) => {
    await injectTauriBridge(page);
    await page.goto("/");
    // Fix transparent background (Tauri uses transparent window + custom bg)
    await page.addStyleTag({ content: "body { background: #0a0e14 !important; }" });
    await waitForPageLoad(page);
  });

  test("00 - Fleet", async ({ page }) => {
    // Fleet page only shows when remote hosts are configured
    const fleetNav = page.locator(".nav-label", { hasText: "Fleet" });
    if (await fleetNav.isVisible({ timeout: 3000 }).catch(() => false)) {
      await fleetNav.click();
      await waitForPageLoad(page, 8000);
      await screenshot(page, "00-fleet");
    }
  });

  test("01 - Dashboard", async ({ page }) => {
    // Dashboard is the default page — wait extra for system health and stats to load
    await page.waitForTimeout(8000);
    await screenshot(page, "01-dashboard");
  });

  test("02 - Containers", async ({ page }) => {
    await navigateTo(page, "Containers");
    await screenshot(page, "02-containers");
  });

  test("03 - Container detail", async ({ page }) => {
    await navigateTo(page, "Containers");
    const row = page.locator("tr").filter({ has: page.locator("text=Running") }).first();
    if (await row.isVisible({ timeout: 3000 }).catch(() => false)) {
      await row.click();
      await waitForPageLoad(page);
      await screenshot(page, "03-container-detail");
    }
  });

  test("04 - Container logs", async ({ page }) => {
    await navigateTo(page, "Containers");
    // Click a running container (look for "Running" badge)
    const runningRow = page.locator("tr").filter({ has: page.locator("text=Running") }).first();
    if (await runningRow.isVisible({ timeout: 3000 }).catch(() => false)) {
      await runningRow.click();
      await waitForPageLoad(page);
      const tab = page.getByText("Logs", { exact: true }).first();
      if (await tab.isVisible({ timeout: 2000 }).catch(() => false)) {
        await tab.click();
        await waitForPageLoad(page, 8000);
        await screenshot(page, "04-container-logs");
      }
    }
  });

  test("05 - Container files", async ({ page }) => {
    await navigateTo(page, "Containers");
    const row = page.locator("tr").filter({ has: page.locator("text=Running") }).first();
    if (await row.isVisible({ timeout: 3000 }).catch(() => false)) {
      await row.click();
      await waitForPageLoad(page);
      const tab = page.getByText("Files", { exact: true }).first();
      if (await tab.isVisible({ timeout: 2000 }).catch(() => false)) {
        await tab.click();
        await waitForPageLoad(page);
        await screenshot(page, "05-container-files");
      }
    }
  });

  test("06 - Images", async ({ page }) => {
    await navigateTo(page, "Images");
    await screenshot(page, "06-images");
  });

  test("07 - Volumes", async ({ page }) => {
    await navigateTo(page, "Volumes");
    await screenshot(page, "07-volumes");
  });

  test("08 - Networks", async ({ page }) => {
    await navigateTo(page, "Networks");
    await screenshot(page, "08-networks");
  });

  test("09 - Network topology", async ({ page }) => {
    await navigateTo(page, "Networks");
    const btn = page.getByText("Topology", { exact: true }).first();
    if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await btn.click();
      await waitForPageLoad(page);
      await screenshot(page, "09-network-topology");
    }
  });

  test("10 - Kubernetes", async ({ page }) => {
    await navigateTo(page, "Kubernetes");
    await selectK8sNamespace(page, "demo");
    await screenshot(page, "10-kubernetes");
  });

  test("11 - K8s Deployments", async ({ page }) => {
    await navigateTo(page, "Kubernetes");
    await selectK8sNamespace(page, "demo");
    const tab = page.locator(".tab-item", { hasText: "Deployments" }).first();
    if (await tab.isVisible({ timeout: 2000 }).catch(() => false)) {
      await tab.click();
      await waitForPageLoad(page);
      await screenshot(page, "11-k8s-deployments");
    }
  });

  test("12 - K8s Services", async ({ page }) => {
    await navigateTo(page, "Kubernetes");
    await selectK8sNamespace(page, "demo");
    const tab = page.locator(".tab-item", { hasText: "Services" }).first();
    if (await tab.isVisible({ timeout: 2000 }).catch(() => false)) {
      await tab.click();
      await waitForPageLoad(page);
      await screenshot(page, "12-k8s-services");
    }
  });

  test("13 - K8s Helm", async ({ page }) => {
    await navigateTo(page, "Kubernetes");
    const tab = page.locator(".tab-item", { hasText: "Helm" }).first();
    if (await tab.isVisible({ timeout: 2000 }).catch(() => false)) {
      await tab.click();
      await waitForPageLoad(page);
      await screenshot(page, "13-k8s-helm");
    }
  });

  test("14 - K8s Jobs", async ({ page }) => {
    await navigateTo(page, "Kubernetes");
    const tab = page.locator(".tab-item", { hasText: "Jobs" }).first();
    if (await tab.isVisible({ timeout: 2000 }).catch(() => false)) {
      await tab.click();
      await waitForPageLoad(page);
      await screenshot(page, "14-k8s-jobs");
    }
  });

  test("15 - K8s Topology", async ({ page }) => {
    await navigateTo(page, "Kubernetes");
    await selectK8sNamespace(page, "demo");
    const tab = page.locator(".tab-item", { hasText: "Topology" }).first();
    if (await tab.isVisible({ timeout: 2000 }).catch(() => false)) {
      await tab.click();
      await waitForPageLoad(page);
      await screenshot(page, "15-k8s-topology");
    }
  });

  test("25 - Gateway", async ({ page }) => {
    await navigateTo(page, "Gateway");
    await waitForPageLoad(page);
    await screenshot(page, "25-gateway");
  });

  test("16 - App Catalog", async ({ page }) => {
    await navigateTo(page, "App Catalog");
    await screenshot(page, "16-app-catalog");
  });

  test("17 - System Health", async ({ page }) => {
    await navigateTo(page, "System Health");
    await screenshot(page, "17-system-health");
  });

  test("18 - Activity", async ({ page }) => {
    await navigateTo(page, "Activity");
    await screenshot(page, "18-activity");
  });

  test("19 - Settings", async ({ page }) => {
    await navigateTo(page, "Settings");
    await screenshot(page, "19-settings");
  });

  test("20 - Settings AI", async ({ page }) => {
    await navigateTo(page, "Settings");
    const tab = page.locator("button", { hasText: "AI & agents" }).first();
    if (await tab.isVisible({ timeout: 2000 }).catch(() => false)) {
      await tab.click();
      await waitForPageLoad(page);
      await screenshot(page, "20-settings-ai");
    }
  });

  test("21 - Settings Maintenance", async ({ page }) => {
    await navigateTo(page, "Settings");
    const tab = page.getByText("Maintenance", { exact: true }).first();
    if (await tab.isVisible({ timeout: 2000 }).catch(() => false)) {
      await tab.click();
      await waitForPageLoad(page);
      await screenshot(page, "21-settings-maintenance");
    }
  });

  test("22 - Keyboard shortcuts", async ({ page }) => {
    await page.keyboard.press("?");
    await page.waitForTimeout(800);
    await screenshot(page, "22-keyboard-shortcuts");
  });

  test("23 - Command palette", async ({ page }) => {
    await page.keyboard.press("Control+k");
    await page.waitForTimeout(800);
    await screenshot(page, "23-command-palette");
  });

  // Scan test last — Trivy can take a while on first run
  test("24 - Image scan results", async ({ page }) => {
    await navigateTo(page, "Images");
    // Use nginx:alpine — small image, likely has a few vulns
    const row = page.locator("tr", { hasText: "nginx" }).first();
    if (await row.isVisible({ timeout: 3000 }).catch(() => false)) {
      await row.click();
      await page.waitForTimeout(1000);
      const scanBtn = page.getByText("Scan for Vulnerabilities").first();
      if (await scanBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await scanBtn.click();
        // Wait for any scan result (CRITICAL, HIGH, MEDIUM, LOW, or "No vulnerabilities")
        try {
          await page.waitForSelector("text=/CRITICAL|HIGH|MEDIUM|LOW|No vulnerabilities/", { timeout: 120000 });
        } catch {}
        await page.waitForTimeout(500);
        // Try to scroll results into view
        for (const sev of ["CRITICAL", "HIGH", "MEDIUM"]) {
          const el = page.getByText(sev).first();
          if (await el.isVisible({ timeout: 500 }).catch(() => false)) {
            await el.scrollIntoViewIfNeeded();
            break;
          }
        }
        await page.waitForTimeout(500);
        await screenshot(page, "06b-image-scan");
      }
    }
  });
  test("25 - Projects board", async ({ page }) => {
    await navigateTo(page, "Worktrees");
    await page.waitForTimeout(1500);
    await screenshot(page, "25-projects");
  });

  test("26 - Projects instance detail", async ({ page }) => {
    await navigateTo(page, "Worktrees");
    await page.waitForTimeout(1500);
    const running = page.locator(".dev-card.dev-card-running").first();
    const card = (await running.isVisible({ timeout: 1000 }).catch(() => false)) ? running : page.locator(".dev-card").first();
    if (await card.isVisible({ timeout: 2000 }).catch(() => false)) {
      // Click the title: links on the card open URLs instead of the drawer.
      await card.locator(".dev-card-name").click();
      await page.waitForTimeout(1200);
      await screenshot(page, "26-projects-instance");
      await page.getByText("Generated files", { exact: true }).click();
      await page.waitForTimeout(1500);
      await screenshot(page, "26b-projects-generated");
      await page.getByText("Logs", { exact: true }).last().click();
      await page.waitForTimeout(1500);
      await screenshot(page, "26c-projects-logs");
    }
  });

  test("27 - Projects start dialog", async ({ page }) => {
    await navigateTo(page, "Worktrees");
    await page.waitForTimeout(1500);
    const start = page.locator(".dev-card .btn-primary", { hasText: "Start" }).first();
    if (await start.isVisible({ timeout: 2000 }).catch(() => false)) {
      await start.click();
      await page.waitForTimeout(1800);
      await screenshot(page, "27-projects-start");
    }
  });
  test("28 - Projects setup wizard", async ({ page }) => {
    await navigateTo(page, "Worktrees");
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "orca.yaml" }).click();
    await page.waitForTimeout(2500);
    await screenshot(page, "28-projects-yaml-form");
    await page.locator(".dev-seg button", { hasText: "YAML" }).first().click();
    await page.waitForTimeout(2000);
    await screenshot(page, "28b-projects-yaml-text");
  });

  test("28c - Projects hostname picker", async ({ page }) => {
    // Read-only: switches the picker in the form but never saves.
    await navigateTo(page, "Worktrees");
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "orca.yaml" }).click();
    await page.waitForTimeout(2500);
    const title = page.locator(".dev-section-title", { hasText: "Hostnames" }).first();
    if (await title.isVisible({ timeout: 2000 }).catch(() => false)) {
      await title.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await screenshot(page, "28c-projects-hostnames");
      await page.locator(".dev-option", { hasText: "Flat" }).first().click();
      await page.waitForTimeout(300);
      await screenshot(page, "28d-projects-hostnames-flat");
    }
  });

  test("29 - Projects data and env tabs", async ({ page }) => {
    await navigateTo(page, "Worktrees");
    await page.waitForTimeout(1500);
    const card = page.locator(".dev-card.dev-card-running").first();
    if (await card.isVisible({ timeout: 2000 }).catch(() => false)) {
      await card.locator(".dev-card-name").click();
      await page.waitForTimeout(800);
      await page.locator(".detail-tab-item", { hasText: "Data" }).click();
      await page.waitForTimeout(2500);
      await screenshot(page, "29-projects-data");
      await page.locator(".detail-tab-item", { hasText: "Env" }).click();
      await page.waitForTimeout(2000);
      await screenshot(page, "29b-projects-env");
    }
  });
  // Read-only: never registers a project or saves anything, so it is safe
  // against a real daemon. The wizard shot needs a project without a dev:
  // section to already be registered.
  test("30 - Projects add dialog and setup wizard", async ({ page }) => {
    await navigateTo(page, "Worktrees");
    await page.waitForTimeout(1200);
    await page.getByRole("button", { name: "Add project" }).click();
    await page.waitForTimeout(1500);
    await screenshot(page, "30-projects-add");
    await page.locator(".modal-close").first().click();
    // Find a registered project that has no dev: section yet.
    const setup = page.getByRole("button", { name: "Set up worktrees…" });
    const tabs = page.locator(".dev-project-tab");
    for (let i = 0; i < (await tabs.count()); i++) {
      if (await setup.isVisible({ timeout: 500 }).catch(() => false)) break;
      await tabs.nth(i).click();
      await page.waitForTimeout(800);
    }
    if (await setup.isVisible({ timeout: 1500 }).catch(() => false)) {
      await setup.click();
      await page.waitForSelector(".dev-wizard", { timeout: 15000 });
      await page.waitForTimeout(2500);
      const shots = ["30b-wizard-shared", "30c-wizard-data", "30d-wizard-reach", "30e-wizard-presets", "30f-wizard-review"];
      for (let i = 0; i < shots.length; i++) {
        await screenshot(page, shots[i]);
        if (i < shots.length - 1) {
          await page.locator(".dev-wizard .modal-footer .btn-primary", { hasText: "Next" }).click();
          await page.waitForTimeout(1500);
        }
      }
    }
  });
  test("31 - Projects topology and dashboard", async ({ page }) => {
    await navigateTo(page, "Worktrees");
    await page.waitForTimeout(1500);
    const tab = page.locator(".dev-project-tab", { hasText: "myapp" });
    if (await tab.isVisible({ timeout: 800 }).catch(() => false)) await tab.click();
    await page.waitForTimeout(800);
    await screenshot(page, "31-projects-board-phase3");
    await page.locator(".dev-seg button", { hasText: "Topology" }).first().click();
    await page.waitForTimeout(1000);
    await screenshot(page, "31b-projects-topology");
    await page.locator(".dev-seg button", { hasText: "Cards" }).first().click();
    await navigateTo(page, "Dashboard");
    await page.waitForTimeout(2000);
    await screenshot(page, "31c-dashboard");
  });
});
