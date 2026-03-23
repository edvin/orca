import { test, Page } from "@playwright/test";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCREENSHOT_DIR = path.join(__dirname, "../../screenshots");

// Read API token from local daemon config (Node.js context).
// This token authenticates to the Orca daemon which ONLY listens on
// 127.0.0.1:9477 (localhost) — it is not network-accessible.
// See: crates/orca-daemon/src/main.rs (--host default_value = "127.0.0.1")
function readApiToken(): string {
  try {
    const configPath = path.join(process.env.HOME || "~", ".config/orca/config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return config.api_token || "localhost-only-test-token"; // nosemgrep: generic-api-key
  } catch {
    return "localhost-only-test-token";
  }
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
          env_status: () => Promise.resolve({ ready: true, checks: [{ name: "Docker", status: "ok", message: "Docker is running" }], all_passed: true }),
          // Activity
          get_activity: () => Promise.resolve([]),
          get_daemon_log: () => Promise.resolve(""),
          // Version
          get_version: () => Promise.resolve("0.6.1"),
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

  test("06b - Image scan results", async ({ page }) => {
    await navigateTo(page, "Images");
    // Click the composer:2 row to expand it
    const composerRow = page.locator("tr", { hasText: "composer" }).first();
    if (await composerRow.isVisible({ timeout: 3000 }).catch(() => false)) {
      await composerRow.click();
      await page.waitForTimeout(1000);
      // Click "Scan for Vulnerabilities" button in the expanded detail
      const scanBtn = page.getByText("Scan for Vulnerabilities").first();
      if (await scanBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await scanBtn.click();
        // Wait for scan results to appear (Trivy can take a while)
        try {
          await page.waitForSelector("text=CRITICAL", { timeout: 120000 });
        } catch {
          // Maybe no CRITICAL vulns, look for any result
          try {
            await page.waitForSelector("text=No vulnerabilities", { timeout: 5000 });
          } catch {}
        }
        await page.waitForTimeout(500);
        // Scroll the CRITICAL text into view to show the vulnerability table
        const criticalEl = page.getByText("CRITICAL").first();
        if (await criticalEl.isVisible({ timeout: 1000 }).catch(() => false)) {
          await criticalEl.scrollIntoViewIfNeeded();
          await page.waitForTimeout(500);
        }
        await screenshot(page, "06b-image-scan");
      }
    }
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
    const tab = page.locator(".filter-pill", { hasText: "Deployments" }).first();
    if (await tab.isVisible({ timeout: 2000 }).catch(() => false)) {
      await tab.click();
      await waitForPageLoad(page);
      await screenshot(page, "11-k8s-deployments");
    }
  });

  test("12 - K8s Services", async ({ page }) => {
    await navigateTo(page, "Kubernetes");
    await selectK8sNamespace(page, "demo");
    const tab = page.locator(".filter-pill", { hasText: "Services" }).first();
    if (await tab.isVisible({ timeout: 2000 }).catch(() => false)) {
      await tab.click();
      await waitForPageLoad(page);
      await screenshot(page, "12-k8s-services");
    }
  });

  test("13 - K8s Helm", async ({ page }) => {
    await navigateTo(page, "Kubernetes");
    const tab = page.locator(".filter-pill", { hasText: "Helm" }).first();
    if (await tab.isVisible({ timeout: 2000 }).catch(() => false)) {
      await tab.click();
      await waitForPageLoad(page);
      await screenshot(page, "13-k8s-helm");
    }
  });

  test("14 - K8s Jobs", async ({ page }) => {
    await navigateTo(page, "Kubernetes");
    const tab = page.locator(".filter-pill", { hasText: "Jobs" }).first();
    if (await tab.isVisible({ timeout: 2000 }).catch(() => false)) {
      await tab.click();
      await waitForPageLoad(page);
      await screenshot(page, "14-k8s-jobs");
    }
  });

  test("15 - K8s Topology", async ({ page }) => {
    await navigateTo(page, "Kubernetes");
    await selectK8sNamespace(page, "demo");
    const tab = page.locator(".filter-pill", { hasText: "Topology" }).first();
    if (await tab.isVisible({ timeout: 2000 }).catch(() => false)) {
      await tab.click();
      await waitForPageLoad(page);
      await screenshot(page, "15-k8s-topology");
    }
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
    const tab = page.locator("button", { hasText: "AI & Agents" }).first();
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
});
