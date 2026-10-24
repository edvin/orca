import { createSignal, createEffect, onMount, Show, For } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { MachineInfo, RegistryCredential, RemoteHost } from "../lib/types";
import { showToast } from "../components/Toast";
import ConnectAiTools from "../components/ConnectAiTools";
import AssistantSettings from "../components/AssistantSettings";
import { confirmDanger, confirm as confirmDialog } from "../components/ConfirmDialog";
import { logError } from "../lib/activityStore";
import Spinner from "../components/Spinner";
import Dropdown from "../components/Dropdown";
import HelpLink from "../components/HelpLink";

type SettingsTab = "general" | "ai" | "registries" | "remote-hosts" | "auto-deploy" | "schedules" | "maintenance" | "certificates" | "privacy" | "about";

interface SettingsPageProps {
  initialTab?: string;
  onTabOpened?: () => void;
}

function CertificateAuthoritySection() {
  const [caInfo, setCaInfo] = createSignal<{ subject: string; expires: string; fingerprint: string } | null>(null);
  const [caError, setCaError] = createSignal<string | null>(null);
  const [copiedCmd, setCopiedCmd] = createSignal<string | null>(null);

  onMount(async () => {
    try {
      const info = await invoke("get_ca_info") as { subject: string; expires: string; fingerprint: string };
      setCaInfo(info);
    } catch (e) {
      setCaError(String(e));
    }
  });

  const downloadCaCert = async () => {
    try {
      const pem = await invoke("get_ca_certificate") as string;
      await invoke("write_temp_file", { name: "orca-ca.pem", content: pem });
      const blob = new Blob([pem], { type: "application/x-pem-file" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "orca-ca.pem";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast(`CA Certificate saved to ${downloadPath}`, "success");
    } catch (e) {
      showToast(`Failed to download CA certificate: ${e}`, "error");
    }
  };

  const copyCommand = (cmd: string) => {
    navigator.clipboard.writeText(cmd);
    setCopiedCmd(cmd);
    setTimeout(() => setCopiedCmd(null), 2000);
  };

  const downloadPath = navigator.platform.includes("Win")
    ? "%USERPROFILE%\\Downloads\\orca-ca.pem"
    : "~/Downloads/orca-ca.pem";

  const installInstructions: [string, string, string][] = [
    ["macOS", `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/Downloads/orca-ca.pem`, ""],
    ["Windows", `certutil -addstore -f "ROOT" %USERPROFILE%\\Downloads\\orca-ca.pem`, ""],
    ["Linux", "sudo cp ~/Downloads/orca-ca.pem /usr/local/share/ca-certificates/orca-ca.crt && sudo update-ca-certificates", ""],
  ];

  return (
    <div class="settings-section">
      <h2 class="settings-section-title">Orca certificate authority</h2>
      <div class="card">
        <p style={{ "font-size": "12px", color: "#8b949e", "margin-bottom": "16px", "line-height": "1.6" }}>
          Signs the TLS certificates for the gateway and app templates. Install it so browsers trust them.{" "}
          <HelpLink path="/docs/gateway/#trust-the-orca-ca" />
        </p>

        <Show when={caInfo()}>
          {(info) => (
            <div class="card-grid" style={{ "margin-bottom": "16px" }}>
              <span class="card-label">Subject</span>
              <span class="card-value mono">{info().subject}</span>
              <span class="card-label">Expires</span>
              <span class="card-value">{info().expires}</span>
              <span class="card-label">Fingerprint</span>
              <span class="card-value mono" style={{ "font-size": "11px", "word-break": "break-all" }}>{info().fingerprint}</span>
            </div>
          )}
        </Show>

        <Show when={caError()}>
          <div style={{ color: "#f85149", "font-size": "12px", "margin-bottom": "12px" }}>{caError()}</div>
        </Show>

        <button
          class="btn btn-primary"
          style={{ "margin-bottom": "20px" }}
          onClick={downloadCaCert}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style={{ "margin-right": "6px" }}>
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          Download CA certificate
        </button>

        <div style={{ "border-top": "1px solid #21262d", "padding-top": "16px" }}>
          <div style={{ "font-size": "12px", "font-weight": "600", color: "#c9d1d9", "margin-bottom": "12px" }}>Install instructions</div>
          <div style={{ display: "flex", "flex-direction": "column", gap: "10px" }}>
            <For each={installInstructions}>{([platform, cmd]) => (
              <div style={{ display: "flex", "align-items": "center", gap: "10px" }}>
                <span style={{ "font-size": "11px", "font-weight": "600", color: "#58a6ff", "min-width": "60px" }}>{platform}</span>
                <code class="mono" style={{ flex: "1", "font-size": "11px", color: "#c9d1d9", background: "#161b22", padding: "8px 10px", "border-radius": "6px", "word-break": "break-all", "line-height": "1.5" }}>{cmd}</code>
                <button
                  class="btn btn-ghost"
                  style={{ padding: "4px 8px", "flex-shrink": "0" }}
                  onClick={() => copyCommand(cmd)}
                  title="Copy to clipboard"
                >
                  {copiedCmd() === cmd ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3fb950" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
                  )}
                </button>
              </div>
            )}</For>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function SettingsPage(props: SettingsPageProps = {}) {
  const [tab, setTab] = createSignal<SettingsTab>(
    (props.initialTab as SettingsTab) || "general"
  );

  // Switch tab when navigated to with a specific tab (e.g., settings:remote-hosts)
  createEffect(() => {
    if (props.initialTab) {
      setTab(props.initialTab as SettingsTab);
      props.onTabOpened?.();
    }
  });

  const [machine, setMachine] = createSignal<MachineInfo | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [daemonConnected, setDaemonConnected] = createSignal(true);
  const [registries, setRegistries] = createSignal<RegistryCredential[]>([]);
  const [showAddRegistry, setShowAddRegistry] = createSignal(false);
  const [regServer, setRegServer] = createSignal("");
  const [regName, setRegName] = createSignal("");
  const [regUsername, setRegUsername] = createSignal("");
  const [regPassword, setRegPassword] = createSignal("");

  // Remote hosts
  const [remoteHosts, setRemoteHosts] = createSignal<RemoteHost[]>([]);
  const [showAddHost, setShowAddHost] = createSignal(false);
  const [editingHost, setEditingHost] = createSignal<RemoteHost | null>(null);
  const [hostName, setHostName] = createSignal("");
  const [hostUrl, setHostUrl] = createSignal("");
  const [hostToken, setHostToken] = createSignal("");
  const [hostTlsVerify, setHostTlsVerify] = createSignal(true);
  const [hostTags, setHostTags] = createSignal("");
  const [hostTesting, setHostTesting] = createSignal(false);
  const [hostTestResult, setHostTestResult] = createSignal<string | null>(null);
  const [showHostToken, setShowHostToken] = createSignal(false);

  // Auto-deploy
  const [deployRules, setDeployRules] = createSignal<any[]>([]);
  const [deployHistory, setDeployHistory] = createSignal<any[]>([]);
  const [showAddRule, setShowAddRule] = createSignal(false);
  const [editingRule, setEditingRule] = createSignal<any>(null);
  const [ruleName, setRuleName] = createSignal("");
  const [ruleImage, setRuleImage] = createSignal("");
  const [ruleTagFilter, setRuleTagFilter] = createSignal("");
  const [ruleContainers, setRuleContainers] = createSignal("");
  const [ruleEnabled, setRuleEnabled] = createSignal(true);
  const [webhookSecret, setWebhookSecret] = createSignal("");
  const [webhookUrl, setWebhookUrl] = createSignal("");
  const [webhookUrlCopied, setWebhookUrlCopied] = createSignal(false);
  const [testingWebhook, setTestingWebhook] = createSignal(false);

  // Schedules
  const [schedules, setSchedules] = createSignal<any[]>([]);
  const [showAddSchedule, setShowAddSchedule] = createSignal(false);
  const [editingSchedule, setEditingSchedule] = createSignal<any>(null);
  const [schedName, setSchedName] = createSignal("");
  const [schedContainer, setSchedContainer] = createSignal("");
  const [schedAction, setSchedAction] = createSignal("restart");
  const [schedCron, setSchedCron] = createSignal("");
  const [schedEnabled, setSchedEnabled] = createSignal(true);
  const [schedBuildTarget, setSchedBuildTarget] = createSignal("");
  const [schedBuildTargets, setSchedBuildTargets] = createSignal<any[]>([]);

  const refreshSchedules = async () => {
    try { setSchedules((await invoke("list_schedules")) as any[]); } catch {}
    try { setSchedBuildTargets((await invoke("list_build_targets")) as any[]); } catch {}
  };

  const resetSchedForm = () => {
    setEditingSchedule(null); setSchedName(""); setSchedContainer(""); setSchedAction("restart"); setSchedCron(""); setSchedEnabled(true); setSchedBuildTarget("");
  };

  const saveSchedRule = async () => {
    if (!schedName().trim() || !schedCron().trim()) return;
    if (schedAction() === "build" && !schedBuildTarget().trim()) return;
    if (schedAction() !== "build" && !schedContainer().trim()) return;
    try {
      await invoke("save_schedule", {
        id: editingSchedule()?.id || null,
        name: schedName().trim(),
        container: schedAction() === "build" ? schedBuildTarget().trim() : schedContainer().trim(),
        action: schedAction(),
        cron: schedCron().trim(),
        enabled: schedEnabled(),
        buildTarget: schedAction() === "build" ? schedBuildTarget().trim() : null,
      });
      showToast(editingSchedule() ? "Schedule updated" : "Schedule created", "success");
      setShowAddSchedule(false);
      resetSchedForm();
      await refreshSchedules();
    } catch (e) {
      showToast(`Failed: ${e}`, "error");
    }
  };

  // Maintenance / System Prune
  const [pruneContainers, setPruneContainers] = createSignal(false);
  const [pruneImages, setPruneImages] = createSignal(false);
  const [pruneVolumes, setPruneVolumes] = createSignal(false);
  const [pruneNetworks, setPruneNetworks] = createSignal(false);
  const [pruneBuildCache, setPruneBuildCache] = createSignal(false);
  const [pruneRunning, setPruneRunning] = createSignal(false);
  const [pruneResults, setPruneResults] = createSignal<string[]>([]);
  const [pruneShowConfirm, setPruneShowConfirm] = createSignal(false);

  // General settings
  const [startOnLogin, setStartOnLogin] = createSignal(false);
  const [showTrayIcon, setShowTrayIcon] = createSignal(true);
  const [telemetry, setTelemetry] = createSignal(false);
  const [interceptDockerUrls, setInterceptDockerUrls] = createSignal(true);

  const [apiToken, setApiToken] = createSignal("");
  const [daemonLogPath] = createSignal("");

  // WSL2 config (Windows only)
  const [wslMemory, setWslMemory] = createSignal("");
  const [wslProcessors, setWslProcessors] = createSignal("");
  const [wslSwap, setWslSwap] = createSignal("");
  const [wslSaving, setWslSaving] = createSignal(false);
  const isWindows = navigator.platform.includes("Win");
  const isMac = navigator.platform.includes("Mac");

  // Lima VM config (macOS only)
  const [limaAvailable, setLimaAvailable] = createSignal(false);
  const [limaName, setLimaName] = createSignal("");
  const [limaStatus, setLimaStatus] = createSignal("");
  const [limaCpus, setLimaCpus] = createSignal(4);
  const [limaMemoryGib, setLimaMemoryGib] = createSignal(4);
  const [limaDiskGib, setLimaDiskGib] = createSignal(60);
  const [limaRecommendedMemoryGib, setLimaRecommendedMemoryGib] = createSignal<number | null>(null);
  const [limaHostMemoryGib, setLimaHostMemoryGib] = createSignal<number | null>(null);
  const [limaOrigCpus, setLimaOrigCpus] = createSignal(4);
  const [limaOrigMemoryGib, setLimaOrigMemoryGib] = createSignal(4);
  const [limaOrigDiskGib, setLimaOrigDiskGib] = createSignal(60);
  const [limaSaving, setLimaSaving] = createSignal(false);

  const [mcpCopied, setMcpCopied] = createSignal(false);
  const [endpointCopied, setEndpointCopied] = createSignal(false);
  const [tokenCopied, setTokenCopied] = createSignal(false);
  const [tokenRevealed, setTokenRevealed] = createSignal(false);
  const [tokenError, setTokenError] = createSignal(false);

  const REGISTRY_PRESETS = [
    { label: "Docker Hub", server: "https://index.docker.io/v1/", name: "Docker Hub" },
    { label: "GitHub", server: "https://ghcr.io", name: "GitHub Container Registry" },
    { label: "GitLab", server: "https://registry.gitlab.com", name: "GitLab Container Registry" },
    { label: "AWS ECR", server: "https://<account>.dkr.ecr.<region>.amazonaws.com", name: "AWS ECR" },
  ];

  const refresh = async () => {
    try {
      const info = (await invoke("get_machine_info")) as MachineInfo;
      setMachine(info);
      setError(null);
      setDaemonConnected(true);
    } catch {
      setDaemonConnected(false);
      setError(null);
    }
  };

  const refreshRegistries = async () => {
    try {
      const result = (await invoke("list_registries")) as RegistryCredential[];
      setRegistries(result);
    } catch {
    }
  };

  const addRegistry = async () => {
    const server = regServer().trim();
    const name = regName().trim();
    const username = regUsername().trim();
    const password = regPassword();
    if (!server || !username || !password) return;
    try {
      await invoke("add_registry", { server, name: name || server, username, password });
      showToast("Registry added", "success");
      setShowAddRegistry(false);
      setRegServer("");
      setRegName("");
      setRegUsername("");
      setRegPassword("");
      await refreshRegistries();
    } catch (e) {
      logError(`Failed to add registry: ${e}`, `Server "${server}"`);
      showToast(`Failed to add registry: ${e}`, "error");
    }
  };

  const removeReg = async (server: string) => {
    if (!await confirmDanger("Remove registry", `Remove registry '${server}'?`)) return;
    try {
      await invoke("remove_registry", { server });
      showToast("Registry removed", "success");
      await refreshRegistries();
    } catch (e) {
      logError(`Failed to remove registry: ${e}`, `Server "${server}"`);
      showToast(`Failed to remove registry: ${e}`, "error");
    }
  };

  const applyPreset = (preset: typeof REGISTRY_PRESETS[number]) => {
    setRegServer(preset.server);
    setRegName(preset.name);
  };

  // --- Remote hosts ---

  const refreshRemoteHosts = async () => {
    try {
      const hosts = (await invoke("list_remote_hosts")) as RemoteHost[];
      setRemoteHosts(hosts);
      // Notify titlebar to refresh host selector
      document.dispatchEvent(new CustomEvent("orca-refresh"));
    } catch {}
  };

  const refreshDeployRules = async () => {
    try {
      const rules = (await invoke("list_deploy_rules")) as any[];
      setDeployRules(rules);
    } catch {}
  };

  const refreshDeployHistory = async () => {
    try {
      const history = (await invoke("list_deploy_history")) as any[];
      setDeployHistory(history);
    } catch {}
  };

  const resetRuleForm = () => {
    setEditingRule(null);
    setRuleName("");
    setRuleImage("");
    setRuleTagFilter("");
    setRuleContainers("");
    setRuleEnabled(true);
  };

  const saveRule = async () => {
    if (!ruleName().trim() || !ruleImage().trim()) return;
    try {
      await invoke("save_deploy_rule", {
        id: editingRule()?.id || null,
        name: ruleName().trim(),
        imagePattern: ruleImage().trim(),
        tagFilter: ruleTagFilter().trim() || null,
        containerNames: ruleContainers().trim() ? ruleContainers().split(",").map(s => s.trim()).filter(s => s) : null,
        enabled: ruleEnabled(),
      });
      showToast(editingRule() ? "Rule updated" : "Rule created", "success");
      setShowAddRule(false);
      resetRuleForm();
      await refreshDeployRules();
    } catch (e) {
      showToast(`Failed to save rule: ${e}`, "error");
    }
  };

  const deleteRule = async (id: string) => {
    const rule = deployRules().find((r: any) => r.id === id);
    const label = rule?.name ? `"${rule.name}"` : "this rule";
    if (!(await confirmDanger(`Delete deploy rule?`, `Remove ${label}? Webhooks matching this rule will stop auto-deploying.`))) return;
    try {
      await invoke("delete_deploy_rule", { id });
      showToast("Rule deleted", "success");
      await refreshDeployRules();
    } catch (e) {
      showToast(`Failed to delete rule: ${e}`, "error");
    }
  };

  const startEditRule = (rule: any) => {
    setEditingRule(rule);
    setRuleName(rule.name);
    setRuleImage(rule.image_pattern);
    setRuleTagFilter(rule.tag_filter || "");
    setRuleContainers((rule.container_names || []).join(", "));
    setRuleEnabled(rule.enabled);
    setShowAddRule(true);
  };

  const resetHostForm = () => {
    setHostName("");
    setHostUrl("");
    setHostToken("");
    setHostTlsVerify(true);
    setHostTags("");
    setHostTestResult(null);
    setEditingHost(null);
    setShowHostToken(false);
  };

  const startEditHost = (host: RemoteHost) => {
    setEditingHost(host);
    setHostName(host.name);
    setHostUrl(host.url);
    setHostToken("");  // Don't pre-fill token for security
    setHostTlsVerify(host.tls_verify);
    setHostTags((host.tags || []).join(", "));
    setHostTestResult(null);
    setShowHostToken(false);
    setShowAddHost(true);
  };

  const saveHost = async () => {
    const name = hostName().trim();
    const url = hostUrl().trim().replace(/\/+$/, "");
    const token = hostToken().trim();
    const tls_verify = hostTlsVerify();
    const tags = hostTags().split(",").map(t => t.trim()).filter(t => t.length > 0);
    if (!name || !url) return;

    const editing = editingHost();
    try {
      if (editing) {
        // Update existing — if token is empty, keep the old one
        // We need to pass something, so re-read from backend is not practical
        // User must provide token on edit if they want to change it
        await invoke("update_remote_host", {
          id: editing.id,
          name,
          url,
          token: token || "__KEEP__",
          tlsVerify: tls_verify,
          tags,
        });
        showToast("Host updated", "success");
      } else {
        if (!token) {
          showToast("API token is required", "error");
          return;
        }
        await invoke("add_remote_host", { name, url, token, tlsVerify: tls_verify, tags });
        showToast("Host added", "success");
      }
      setShowAddHost(false);
      resetHostForm();
      await refreshRemoteHosts();
    } catch (e) {
      logError(`Failed to save host: ${e}`, `Host "${name}"`);
      showToast(`Failed to save host: ${e}`, "error");
    }
  };

  const removeHost = async (host: RemoteHost) => {
    if (!await confirmDanger("Remove host", `Remove remote host '${host.name}'?`)) return;
    try {
      await invoke("remove_remote_host", { id: host.id });
      showToast("Host removed", "success");
      await refreshRemoteHosts();
    } catch (e) {
      logError(`Failed to remove host: ${e}`, `Host "${host.name}"`);
      showToast(`Failed to remove host: ${e}`, "error");
    }
  };

  const testHost = async () => {
    const url = hostUrl().trim().replace(/\/+$/, "");
    const token = hostToken().trim();
    if (!url) return;
    if (!token && editingHost()) {
      setHostTestResult("Enter the API token to test connection (leave blank to keep existing token on save)");
      return;
    }
    setHostTesting(true);
    setHostTestResult(null);
    try {
      const result = (await invoke("test_remote_host", {
        url,
        token,
        tlsVerify: hostTlsVerify(),
      })) as any;
      setHostTestResult(`Connected — version ${result.version || "unknown"}, status: ${result.status || "ok"}`);
    } catch (e) {
      setHostTestResult(`Failed: ${e}`);
    } finally {
      setHostTesting(false);
    }
  };

  const refreshGeneralSettings = async () => {
    try {
      const settings = (await invoke("get_general_settings")) as {
        start_on_login: boolean;
        show_tray_icon: boolean;
        telemetry: boolean;
        intercept_docker_desktop_urls: boolean;
      };
      setStartOnLogin(settings.start_on_login);
      setShowTrayIcon(settings.show_tray_icon);
      setTelemetry(settings.telemetry);
      setInterceptDockerUrls(settings.intercept_docker_desktop_urls);
      setDaemonConnected(true);
    } catch {
    }
  };

  const saveGeneralSetting = async (
    field: "start_on_login" | "show_tray_icon" | "telemetry" | "intercept_docker_desktop_urls",
    value: boolean,
  ) => {
    const prev = { start_on_login: startOnLogin(), show_tray_icon: showTrayIcon(), telemetry: telemetry(), intercept_docker_desktop_urls: interceptDockerUrls() };
    if (field === "start_on_login") setStartOnLogin(value);
    else if (field === "show_tray_icon") setShowTrayIcon(value);
    else if (field === "telemetry") setTelemetry(value);
    else if (field === "intercept_docker_desktop_urls") setInterceptDockerUrls(value);

    try {
      await invoke("save_general_settings", {
        startOnLogin: field === "start_on_login" ? value : startOnLogin(),
        showTrayIcon: field === "show_tray_icon" ? value : showTrayIcon(),
        telemetry: field === "telemetry" ? value : telemetry(),
        interceptDockerDesktopUrls: field === "intercept_docker_desktop_urls" ? value : interceptDockerUrls(),
      });
      showToast("Settings saved", "success");
    } catch (e) {
      setStartOnLogin(prev.start_on_login);
      setShowTrayIcon(prev.show_tray_icon);
      setTelemetry(prev.telemetry);
      setInterceptDockerUrls(prev.intercept_docker_desktop_urls);
      logError(`Failed to save general settings: ${e}`, `Field "${field}"`);
      showToast(`Failed to save settings: ${e}`, "error");
    }
  };


  const copyToClipboard = async (text: string, setter: (v: boolean) => void) => {
    try {
      await navigator.clipboard.writeText(text);
      setter(true);
      setTimeout(() => setter(false), 2000);
    } catch {
      showToast("Failed to copy to clipboard", "error");
    }
  };

  // Lazily fetch the daemon API token. The token is NOT loaded on page visit —
  // only when the user explicitly reveals or copies it, so it never sits
  // rendered on screen by default.
  const ensureToken = async (): Promise<string> => {
    if (apiToken()) return apiToken();
    try {
      const token = (await invoke("get_api_token")) as string;
      setApiToken(token);
      setTokenError(false);
      return token;
    } catch {
      // No token yet — usually the daemon hasn't started, so it never ran
      // ensure_token() to generate and persist one.
      setTokenError(true);
      return "";
    }
  };

  const toggleTokenRevealed = async () => {
    if (!tokenRevealed()) await ensureToken();
    setTokenRevealed(!tokenRevealed());
  };

  const mcpConfigWith = (token: string) =>
    JSON.stringify(
      {
        mcpServers: {
          orca: {
            type: "http",
            url: "http://127.0.0.1:9477/api/v1/agent/mcp",
            headers: {
              Authorization: `Bearer ${token || "YOUR_TOKEN_HERE"}`,
            },
          },
        },
      },
      null,
      2
    );

  // On-screen config keeps the token hidden until revealed.
  const mcpConfig = () => mcpConfigWith(tokenRevealed() ? apiToken() : "");

  // Copy actions fetch the real token first so the copied value always works,
  // regardless of whether the token is currently revealed on screen.
  const copyMcpConfig = async () => {
    const token = await ensureToken();
    if (!token) {
      showToast("No API token yet — is the daemon running?", "error");
      return;
    }
    await copyToClipboard(mcpConfigWith(token), setMcpCopied);
  };

  const copyToken = async () => {
    const token = await ensureToken();
    if (!token) {
      showToast("No API token yet — is the daemon running?", "error");
      return;
    }
    await copyToClipboard(token, setTokenCopied);
  };

  const TOKEN_MASK = "•".repeat(32);

  // Config/data/log locations mirror the daemon's platform-specific
  // OrcaConfig::config_path() — macOS and Windows do NOT use ~/.config.
  const platformPaths = () => {
    if (isMac) {
      const base = "~/Library/Application Support/orca";
      return { config: `${base}/config.json`, data: `${base}/`, log: `${base}/daemon.log` };
    }
    if (isWindows) {
      const base = "%APPDATA%\\orca";
      return { config: `${base}\\config.json`, data: `${base}\\`, log: `${base}\\daemon.log` };
    }
    return { config: "~/.config/orca/config.json", data: "~/.local/share/orca/", log: "~/.config/orca/daemon.log" };
  };

  const openaiEndpoint = "http://127.0.0.1:9477/api/v1/agent/openai/chat/completions";

  const refreshLimaSettings = async () => {
    if (!isMac) return;
    try {
      const settings = (await invoke("get_lima_settings")) as {
        available: boolean;
        name?: string;
        status?: string;
        cpus?: number;
        memory?: number;
        disk?: number;
        recommended_memory_gib?: number;
        host_memory_gib?: number;
      };
      setLimaAvailable(settings.available);
      setLimaRecommendedMemoryGib(settings.recommended_memory_gib ?? null);
      setLimaHostMemoryGib(settings.host_memory_gib ?? null);
      if (settings.available) {
        setLimaName(settings.name || "");
        setLimaStatus(settings.status || "");
        const memGib = settings.memory ? Math.round(settings.memory / (1024 * 1024 * 1024)) : 4;
        const diskGib = settings.disk ? Math.round(settings.disk / (1024 * 1024 * 1024)) : 60;
        const cpus = settings.cpus || 4;
        setLimaCpus(cpus);
        setLimaMemoryGib(memGib);
        setLimaDiskGib(diskGib);
        setLimaOrigCpus(cpus);
        setLimaOrigMemoryGib(memGib);
        setLimaOrigDiskGib(diskGib);
      }
    } catch {
      // Not on macOS or limactl not available
    }
  };

  const limaHasChanges = () =>
    limaCpus() !== limaOrigCpus() ||
    limaMemoryGib() !== limaOrigMemoryGib() ||
    limaDiskGib() !== limaOrigDiskGib();

  const saveLimaSettings = async () => {
    if (!await confirmDialog({
      title: "Restart Docker VM",
      message: "This will restart the Docker VM. Running containers will be stopped. This may take a few minutes.",
      confirmLabel: "Restart",
      danger: true,
    })) return;

    setLimaSaving(true);
    try {
      await invoke("save_lima_settings", {
        name: limaName(),
        cpus: limaCpus(),
        memoryGib: limaMemoryGib(),
        diskGib: limaDiskGib(),
      });
      showToast("VM resources updated", "success");
      await refreshLimaSettings();
    } catch (e) {
      showToast(`Failed to update VM: ${e}`, "error");
    } finally {
      setLimaSaving(false);
    }
  };

  const refreshWslConfig = async () => {
    if (!isWindows) return;
    try {
      const config = (await invoke("get_wsl_config")) as { memory: string; processors: string; swap: string };
      setWslMemory(config.memory);
      setWslProcessors(config.processors);
      setWslSwap(config.swap);
    } catch {
      // Not on Windows or command unavailable
    }
  };

  const saveWslConfig = async () => {
    setWslSaving(true);
    try {
      await invoke("save_wsl_config", {
        memory: wslMemory(),
        processors: wslProcessors(),
        swap: wslSwap(),
      });
      showToast("WSL2 config saved. Restart WSL2 for changes to take effect.", "success");
    } catch (e) {
      showToast(`Failed to save WSL2 config: ${e}`, "error");
    } finally {
      setWslSaving(false);
    }
  };

  onMount(() => {
    refresh();
    refreshRegistries();
    refreshRemoteHosts();
    refreshDeployRules();
    refreshDeployHistory();
    refreshSchedules();
    invoke("get_webhook_url").then((u) => setWebhookUrl(u as string)).catch(() => {});
    refreshGeneralSettings();
    refreshWslConfig();
    refreshLimaSettings();
  });

  return (
    <div>
      <div class="page-header">
        <h1 class="page-title">Settings</h1>
      </div>

      <Show when={error()}>
        <div class="card" style={{ "border-color": "#da3633", "margin-bottom": "16px" }}>
          <span style={{ color: "#f85149" }}>{error()}</span>
        </div>
      </Show>

      {/* Tabs */}
      <div class="tab-bar" style={{"margin-bottom":"24px"}}>
        <button class={`tab-item ${tab() === "general" ? "active" : ""}`} onClick={() => setTab("general")}>General</button>
        <button class={`tab-item ${tab() === "ai" ? "active" : ""}`} onClick={() => setTab("ai")}>AI & agents</button>
        <button class={`tab-item ${tab() === "registries" ? "active" : ""}`} onClick={() => setTab("registries")}>Registries</button>
        <button class={`tab-item ${tab() === "remote-hosts" ? "active" : ""}`} onClick={() => setTab("remote-hosts")}>Remote hosts</button>
        <button class={`tab-item ${tab() === "auto-deploy" ? "active" : ""}`} onClick={() => setTab("auto-deploy")}>Auto-deploy</button>
        <button class={`tab-item ${tab() === "schedules" ? "active" : ""}`} onClick={() => setTab("schedules")}>Schedules</button>
        <button class={`tab-item ${tab() === "maintenance" ? "active" : ""}`} onClick={() => setTab("maintenance")}>Maintenance</button>
        <button class={`tab-item ${tab() === "certificates" ? "active" : ""}`} onClick={() => setTab("certificates")}>Certificates</button>
        <button class={`tab-item ${tab() === "privacy" ? "active" : ""}`} onClick={() => setTab("privacy")}>Privacy & security</button>
        <button class={`tab-item ${tab() === "about" ? "active" : ""}`} onClick={() => setTab("about")}>About</button>
      </div>

      <div style={{ "max-width": "640px" }}>

        {/* === General Tab === */}
        <Show when={tab() === "general"}>
          <div style={{ display: "flex", "flex-direction": "column", gap: "20px" }}>
            <div class="settings-section">
              <h2 class="settings-section-title">Preferences</h2>
              <div class="card">
                <Show when={!daemonConnected()}>
                  <div style={{ padding: "6px 0 10px", color: "#8b949e", "font-size": "12px" }}>
                    Connect to daemon to change settings
                  </div>
                </Show>
                <div class="settings-row" style={{ opacity: daemonConnected() ? 1 : 0.5 }}>
                  <div class="settings-row-left">
                    <span class="settings-label">Start on Login</span>
                    <span class="settings-description">Automatically launch Orca Desktop when you log in</span>
                  </div>
                  <div
                    class="settings-toggle"
                    onClick={() => daemonConnected() && saveGeneralSetting("start_on_login", !startOnLogin())}
                    style={{ cursor: daemonConnected() ? "pointer" : "not-allowed" }}
                  >
                    <div class={`toggle-track${startOnLogin() ? " toggle-on" : ""}`}>
                      <div class="toggle-thumb" />
                    </div>
                  </div>
                </div>
                <div class="settings-divider" />
                <div class="settings-row" style={{ opacity: daemonConnected() ? 1 : 0.5 }}>
                  <div class="settings-row-left">
                    <span class="settings-label">Show tray icon</span>
                    <span class="settings-description">Display Orca Desktop in the system tray</span>
                  </div>
                  <div
                    class="settings-toggle"
                    onClick={() => daemonConnected() && saveGeneralSetting("show_tray_icon", !showTrayIcon())}
                    style={{ cursor: daemonConnected() ? "pointer" : "not-allowed" }}
                  >
                    <div class={`toggle-track${showTrayIcon() ? " toggle-on" : ""}`}>
                      <div class="toggle-thumb" />
                    </div>
                  </div>
                </div>
                <div class="settings-divider" />
                <div class="settings-row" style={{ opacity: daemonConnected() ? 1 : 0.5 }}>
                  <div class="settings-row-left">
                    <span class="settings-label">Intercept Docker Desktop URLs</span>
                    <span class="settings-description">When enabled, docker-desktop:// links open in Orca instead of Docker Desktop</span>
                  </div>
                  <div
                    class="settings-toggle"
                    onClick={() => daemonConnected() && saveGeneralSetting("intercept_docker_desktop_urls", !interceptDockerUrls())}
                    style={{ cursor: daemonConnected() ? "pointer" : "not-allowed" }}
                  >
                    <div class={`toggle-track${interceptDockerUrls() ? " toggle-on" : ""}`}>
                      <div class="toggle-thumb" />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* WSL2 resources — Windows only */}
            <Show when={isWindows}>
              <div class="settings-section">
                <h2 class="settings-section-title">WSL2 resources</h2>
                <div class="card" style={{ padding: "16px", display: "flex", "flex-direction": "column", gap: "12px" }}>
                  <div style={{ display: "flex", "align-items": "center", gap: "12px" }}>
                    <label style={{ width: "90px", "font-size": "13px", color: "#c9d1d9" }}>Memory</label>
                    <input
                      type="text"
                      class="form-input"
                      placeholder="e.g. 8GB"
                      value={wslMemory()}
                      onInput={(e) => setWslMemory(e.currentTarget.value)}
                      style={{ flex: "1" }}
                    />
                  </div>
                  <div style={{ display: "flex", "align-items": "center", gap: "12px" }}>
                    <label style={{ width: "90px", "font-size": "13px", color: "#c9d1d9" }}>Processors</label>
                    <input
                      type="text"
                      class="form-input"
                      placeholder="e.g. 4"
                      value={wslProcessors()}
                      onInput={(e) => setWslProcessors(e.currentTarget.value)}
                      style={{ flex: "1" }}
                    />
                  </div>
                  <div style={{ display: "flex", "align-items": "center", gap: "12px" }}>
                    <label style={{ width: "90px", "font-size": "13px", color: "#c9d1d9" }}>Swap</label>
                    <input
                      type="text"
                      class="form-input"
                      placeholder="e.g. 2GB"
                      value={wslSwap()}
                      onInput={(e) => setWslSwap(e.currentTarget.value)}
                      style={{ flex: "1" }}
                    />
                  </div>
                  <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between" }}>
                    <span style={{ "font-size": "11px", color: "#8b949e" }}>
                      Changes require a WSL2 restart to take effect (wsl --shutdown)
                    </span>
                    <button class="btn btn-primary" onClick={saveWslConfig} disabled={wslSaving()}>
                      {wslSaving() ? "Saving..." : "Save"}
                    </button>
                  </div>
                </div>
              </div>
            </Show>

            {/* Lima VM Resources — macOS only */}
            <Show when={isMac && limaAvailable()}>
              <div class="settings-section">
                <h2 class="settings-section-title">Virtual machine</h2>
                <p style={{ "font-size": "12px", color: "#8b949e", margin: "0 0 10px" }}>Lima VM resources for Docker</p>
                <div class="card" style={{ padding: "16px", display: "flex", "flex-direction": "column", gap: "14px" }}>
                  <div style={{ display: "flex", "align-items": "center", gap: "8px", "font-size": "13px" }}>
                    <span style={{ color: "#c9d1d9" }}>VM:</span>
                    <span style={{ color: "#e6edf3", "font-weight": "500" }}>{limaName()}</span>
                    <span style={{
                      "font-size": "11px",
                      padding: "2px 8px",
                      "border-radius": "10px",
                      background: limaStatus() === "Running" ? "rgba(63, 185, 80, 0.15)" : "rgba(139, 148, 158, 0.15)",
                      color: limaStatus() === "Running" ? "#3fb950" : "#8b949e",
                    }}>
                      {limaStatus()}
                    </span>
                  </div>

                  <div style={{ display: "flex", "align-items": "center", gap: "12px" }}>
                    <label style={{ width: "90px", "font-size": "13px", color: "#c9d1d9" }}>CPUs</label>
                    <input
                      type="number"
                      class="form-input"
                      min="1"
                      max="16"
                      step="1"
                      value={limaCpus()}
                      onInput={(e) => setLimaCpus(parseInt(e.currentTarget.value) || 1)}
                      style={{ flex: "1", "max-width": "120px" }}
                      disabled={limaSaving()}
                    />
                  </div>

                  <div style={{ display: "flex", "align-items": "center", gap: "12px" }}>
                    <label style={{ width: "90px", "font-size": "13px", color: "#c9d1d9" }}>Memory</label>
                    <div style={{ display: "flex", "align-items": "center", gap: "6px", flex: "1", "max-width": "160px" }}>
                      <input
                        type="number"
                        class="form-input"
                        min="2"
                        max={Math.max(limaHostMemoryGib() || 64, limaMemoryGib())}
                        step="1"
                        value={limaMemoryGib()}
                        onInput={(e) => setLimaMemoryGib(parseInt(e.currentTarget.value) || 2)}
                        style={{ flex: "1" }}
                        disabled={limaSaving()}
                      />
                      <span style={{ "font-size": "13px", color: "#8b949e" }}>GB</span>
                    </div>
                    <Show when={limaRecommendedMemoryGib()}>
                      {(recommended) => (
                        <span style={{ "font-size": "12px", color: "#8b949e" }}>
                          Recommended: {recommended()} GB
                          <Show when={limaHostMemoryGib()}>
                            {(hostMemory) => <> for {hostMemory()} GB host</>}
                          </Show>
                        </span>
                      )}
                    </Show>
                  </div>

                  <div style={{ display: "flex", "align-items": "center", gap: "12px" }}>
                    <label style={{ width: "90px", "font-size": "13px", color: "#c9d1d9" }}>Disk</label>
                    <div style={{ display: "flex", "align-items": "center", gap: "6px", flex: "1", "max-width": "160px" }}>
                      <input
                        type="number"
                        class="form-input"
                        min="20"
                        max="500"
                        step="10"
                        value={limaDiskGib()}
                        onInput={(e) => setLimaDiskGib(parseInt(e.currentTarget.value) || 20)}
                        style={{ flex: "1" }}
                        disabled={limaSaving()}
                      />
                      <span style={{ "font-size": "13px", color: "#8b949e" }}>GB</span>
                    </div>
                  </div>

                  <Show when={limaHasChanges()}>
                    <div style={{ "font-size": "11px", color: "#d29922", display: "flex", "align-items": "center", gap: "6px" }}>
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="#d29922"><path d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM0 8a8 8 0 1116 0A8 8 0 010 8zm9 3a1 1 0 11-2 0 1 1 0 012 0zm-.25-6.25a.75.75 0 00-1.5 0v3.5a.75.75 0 001.5 0v-3.5z"/></svg>
                      Applying changes will restart the Docker VM. Running containers will be stopped.
                    </div>
                  </Show>

                  <div style={{ display: "flex", "align-items": "center", "justify-content": "flex-end", gap: "8px" }}>
                    <button
                      class="btn"
                      disabled={limaSaving()}
                      onClick={async () => {
                        if (!await confirmDialog({ title: "Restart Docker VM", message: "This will restart the Docker VM. Running containers will be stopped.", confirmLabel: "Restart", danger: true })) return;
                        setLimaSaving(true);
                        try {
                          await invoke("save_lima_settings", { name: limaName(), cpus: limaCpus(), memoryGib: limaMemoryGib(), diskGib: limaDiskGib() });
                          showToast("VM restarted", "success");
                          await refreshLimaSettings();
                        } catch (e) { showToast(`Restart failed: ${e}`, "error"); }
                        finally { setLimaSaving(false); }
                      }}
                    >
                      {limaSaving() ? "Restarting..." : "Restart VM"}
                    </button>
                    <button
                      class="btn btn-primary"
                      onClick={saveLimaSettings}
                      disabled={!limaHasChanges() || limaSaving()}
                    >
                      {limaSaving() ? "Restarting VM..." : "Apply changes"}
                    </button>
                  </div>
                </div>
              </div>
            </Show>
          </div>
        </Show>

        {/* === AI & Agents Tab === */}
        <Show when={tab() === "ai"}>
          <div style={{ display: "flex", "flex-direction": "column", gap: "20px" }}>
            <ConnectAiTools />

            <AssistantSettings />

            {/* Agent Integration: the HTTP endpoint, for clients that can't start a command */}
            <div class="settings-section">
              <h2 class="settings-section-title">HTTP endpoint (advanced)</h2>
              <div class="card">
                <div style={{ display: "flex", "flex-direction": "column", gap: "16px" }}>
                  <div>
                    <div style={{ "font-size": "13px", "font-weight": 600, color: "#e6edf3", "margin-bottom": "6px" }}>
                      MCP Server Config
                    </div>
                    <p style={{ "font-size": "12px", color: "#8b949e", margin: "0 0 8px 0", "line-height": "1.5" }}>
                      Add this to <span class="mono">.mcp.json</span> in a project (Claude Code) or to any MCP client that
                      supports HTTP servers. Copying fills in your real token.{" "}
                      <HelpLink path="/docs/agents/#http-endpoint-advanced" />
                    </p>
                    <div style={{ position: "relative" }}>
                      <pre style={{
                        background: "#161b22", border: "1px solid #21262d", "border-radius": "6px",
                        padding: "12px", "padding-right": "40px", "font-size": "12px", "line-height": "1.5",
                        overflow: "auto", color: "#e6edf3", margin: 0,
                      }}>
                        {mcpConfig()}
                      </pre>
                      <button
                        class="action-icon"
                        style={{ position: "absolute", top: "8px", right: "8px", color: mcpCopied() ? "#3fb950" : "#8b949e" }}
                        onClick={copyMcpConfig}
                        title="Copy to clipboard"
                      >
                        <Show when={mcpCopied()} fallback={
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                        }>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                        </Show>
                      </button>
                    </div>
                  </div>

                  <div style={{ "border-top": "1px solid #21262d", "padding-top": "16px" }}>
                    <div style={{ "font-size": "13px", "font-weight": 600, color: "#e6edf3", "margin-bottom": "6px" }}>
                      OpenAI-Compatible Endpoint
                    </div>
                    <p style={{ "font-size": "12px", color: "#8b949e", margin: "0 0 8px 0", "line-height": "1.5" }}>
                      Use this endpoint with any OpenAI-compatible agent or tool.
                    </p>
                    <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
                      <div style={{
                        display: "flex", "align-items": "center", "justify-content": "space-between",
                        background: "#161b22", border: "1px solid #21262d", "border-radius": "6px", padding: "8px 12px",
                      }}>
                        <div>
                          <div style={{ "font-size": "10px", color: "#6e7681", "text-transform": "uppercase", "letter-spacing": "0.5px", "margin-bottom": "2px" }}>Endpoint</div>
                          <span class="mono" style={{ "font-size": "11px", color: "#e6edf3", "word-break": "break-all" }}>{openaiEndpoint}</span>
                        </div>
                        <button
                          class="action-icon"
                          style={{ color: endpointCopied() ? "#3fb950" : "#8b949e", "flex-shrink": "0" }}
                          onClick={() => copyToClipboard(openaiEndpoint, setEndpointCopied)}
                          title="Copy endpoint"
                        >
                          <Show when={endpointCopied()} fallback={
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                          }>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                          </Show>
                        </button>
                      </div>
                      <div style={{
                        display: "flex", "align-items": "center", "justify-content": "space-between",
                        background: "#161b22", border: "1px solid #21262d", "border-radius": "6px", padding: "8px 12px",
                      }}>
                        <div>
                          <div style={{ "font-size": "10px", color: "#6e7681", "text-transform": "uppercase", "letter-spacing": "0.5px", "margin-bottom": "2px" }}>API token</div>
                          <span class="mono" style={{ "font-size": "11px", color: tokenRevealed() && tokenError() ? "#f85149" : "#e6edf3" }}>{tokenRevealed() ? (apiToken() || (tokenError() ? "No token — is the daemon running?" : "Loading...")) : TOKEN_MASK}</span>
                        </div>
                        <div style={{ display: "flex", "align-items": "center", gap: "4px", "flex-shrink": "0" }}>
                          <button
                            class="action-icon"
                            style={{ color: tokenRevealed() ? "#58a6ff" : "#8b949e" }}
                            onClick={toggleTokenRevealed}
                            title={tokenRevealed() ? "Hide token" : "Reveal token"}
                          >
                            <Show when={tokenRevealed()} fallback={
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
                            }>
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 0 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/></svg>
                            </Show>
                          </button>
                          <button
                            class="action-icon"
                            style={{ color: tokenCopied() ? "#3fb950" : "#8b949e" }}
                            onClick={copyToken}
                            title="Copy token"
                          >
                            <Show when={tokenCopied()} fallback={
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                            }>
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                            </Show>
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </Show>

        {/* === Registries Tab === */}
        <Show when={tab() === "registries"}>
          <div class="settings-section">
            <h2 class="settings-section-title">Container registries</h2>
            <div class="card">
              <Show when={registries().length > 0} fallback={
                <div style={{ padding: "8px 0", color: "#8b949e" }}>No registries configured. Add credentials for private image registries.</div>
              }>
                <table class="table" style={{ margin: 0 }}>
                  <thead>
                    <tr>
                      <th>Server</th>
                      <th>Name</th>
                      <th>Username</th>
                      <th>Password</th>
                      <th style={{ "text-align": "right" }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={registries()}>
                      {(reg) => (
                        <tr>
                          <td class="mono" style={{ "font-size": "12px" }}>{reg.server}</td>
                          <td>{reg.name}</td>
                          <td>{reg.username}</td>
                          <td style={{ color: "#8b949e" }}>{"\u2022\u2022\u2022\u2022\u2022\u2022"}</td>
                          <td style={{ "text-align": "right" }}>
                            <button class="btn btn-sm btn-danger" onClick={() => removeReg(reg.server)} title="Delete registry" style={{ color: "#f85149" }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>
                          </td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </Show>

              <div style={{ "margin-top": "12px" }}>
                <Show when={!showAddRegistry()}>
                  <button class="btn btn-primary" onClick={() => setShowAddRegistry(true)}>Add registry</button>
                </Show>
              </div>

              <Show when={showAddRegistry()}>
                <div style={{ "margin-top": "12px", "border-top": "1px solid #21262d", "padding-top": "12px" }}>
                  <div style={{ "margin-bottom": "8px", "font-size": "12px", color: "#8b949e" }}>
                    Presets:{" "}
                    <For each={REGISTRY_PRESETS}>
                      {(preset, i) => (
                        <>
                          <button class="btn btn-sm" style={{ padding: "2px 8px", "font-size": "11px" }} onClick={() => applyPreset(preset)}>
                            {preset.label}
                          </button>
                          {i() < REGISTRY_PRESETS.length - 1 ? " " : ""}
                        </>
                      )}
                    </For>
                  </div>
                  <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
                    <div class="form-group">
                      <label class="form-label">Server URL</label>
                      <input class="form-input" type="text" placeholder="https://ghcr.io" value={regServer()} onInput={(e) => setRegServer(e.currentTarget.value)} />
                    </div>
                    <div class="form-group">
                      <label class="form-label">Display name</label>
                      <input class="form-input" type="text" placeholder="GitHub container registry" value={regName()} onInput={(e) => setRegName(e.currentTarget.value)} />
                    </div>
                    <div class="form-row">
                      <div class="form-group" style={{ flex: 1 }}>
                        <label class="form-label">Username</label>
                        <input class="form-input" type="text" placeholder="username" value={regUsername()} onInput={(e) => setRegUsername(e.currentTarget.value)} />
                      </div>
                      <div class="form-group" style={{ flex: 1 }}>
                        <label class="form-label">Password</label>
                        <input class="form-input" type="password" placeholder="password or token" value={regPassword()} onInput={(e) => setRegPassword(e.currentTarget.value)} />
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: "8px" }}>
                      <button class="btn btn-primary" onClick={addRegistry} disabled={!regServer().trim() || !regUsername().trim() || !regPassword()}>Save</button>
                      <button class="btn" onClick={() => setShowAddRegistry(false)}>Cancel</button>
                    </div>
                  </div>
                </div>
              </Show>
            </div>
          </div>
        </Show>

        {/* === Remote Hosts Tab === */}
        <Show when={tab() === "remote-hosts"}>
          <div class="settings-section">
            <h2 class="settings-section-title">Remote hosts</h2>
            <p style={{ "font-size": "13px", color: "#8b949e", "margin-bottom": "16px", "line-height": "1.5" }}>
              Servers running orca-daemon. Switch between hosts from the titlebar.{" "}
              <HelpLink path="/docs/remote-hosts/" />
            </p>
            <Show when={remoteHosts().length > 0} fallback={
              <div style={{ padding: "16px 0", color: "#8b949e" }}>No remote hosts configured.</div>
            }>
              <table class="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th style={{ "min-width": "200px" }}>URL</th>
                    <th>Tags</th>
                    <th style={{ width: "60px" }}>TLS</th>
                    <th style={{ "text-align": "right", width: "80px" }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={remoteHosts()}>
                    {(host) => (
                      <tr>
                        <td style={{ "font-weight": 500 }}>{host.name}</td>
                        <td class="mono" style={{ "font-size": "12px", color: "#8b949e" }}>{host.url}</td>
                        <td>
                          <div style={{ display: "flex", "flex-wrap": "wrap", gap: "3px" }}>
                            <For each={host.tags || []}>
                              {(tag) => (
                                <span style={{
                                  padding: "1px 6px",
                                  "border-radius": "10px",
                                  "font-size": "10px",
                                  "font-weight": "500",
                                  background: "rgba(88, 166, 255, 0.1)",
                                  color: "#58a6ff",
                                  border: "1px solid rgba(88, 166, 255, 0.15)",
                                }}>{tag}</span>
                              )}
                            </For>
                          </div>
                        </td>
                        <td>
                          <span style={{
                            "font-size": "11px",
                            padding: "2px 6px",
                            "border-radius": "4px",
                            background: host.tls_verify ? "rgba(63, 185, 80, 0.1)" : "rgba(248, 81, 73, 0.1)",
                            color: host.tls_verify ? "#3fb950" : "#f85149",
                          }}>{host.tls_verify ? "On" : "Off"}</span>
                        </td>
                        <td style={{ "text-align": "right" }}>
                          <div style={{ display: "flex", gap: "4px", "justify-content": "flex-end" }}>
                            <button
                              class="btn btn-sm"
                              onClick={() => startEditHost(host)}
                              title="Edit host"
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
                            </button>
                            <button
                              class="btn btn-sm btn-danger"
                              onClick={() => removeHost(host)}
                              title="Remove host"
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>

            <div style={{ "margin-top": "12px" }}>
              <Show when={!showAddHost()}>
                <button class="btn btn-primary" onClick={() => { resetHostForm(); setShowAddHost(true); }}>Add host</button>
              </Show>
            </div>
            <div class="card">

              <Show when={showAddHost()}>
                <div style={{ "margin-top": "12px", "border-top": "1px solid #21262d", "padding-top": "12px" }}>
                  <h3 style={{ "font-size": "14px", "font-weight": 600, "margin-bottom": "12px", color: "#e6edf3" }}>
                    {editingHost() ? `Edit "${editingHost()!.name}"` : "Add remote host"}
                  </h3>
                  <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
                    <div class="form-group">
                      <label class="form-label">Display name</label>
                      <input class="form-input" type="text" placeholder="Production server" value={hostName()} onInput={(e) => setHostName(e.currentTarget.value)} />
                    </div>
                    <div class="form-group">
                      <label class="form-label">Daemon URL</label>
                      <input class="form-input" type="text" placeholder="https://prod.example.com:9477" value={hostUrl()} onInput={(e) => {
                        setHostUrl(e.currentTarget.value);
                        // Auto-set TLS verify based on protocol
                        const url = e.currentTarget.value.trim().toLowerCase();
                        if (url.startsWith("http://")) setHostTlsVerify(false);
                        else if (url.startsWith("https://")) setHostTlsVerify(true);
                      }} />
                    </div>
                    <div class="form-group">
                      <label class="form-label">API Token {editingHost() ? "(leave blank to keep current)" : ""}</label>
                      <div style={{ display: "flex", gap: "4px" }}>
                        <input class="form-input" type={showHostToken() ? "text" : "password"} placeholder={editingHost() ? "Leave blank to keep current token" : "Bearer token"} value={hostToken()} onInput={(e) => setHostToken(e.currentTarget.value)} style={{ flex: "1" }} />
                        <button class="btn btn-sm" onClick={() => setShowHostToken(!showHostToken())} style={{ "flex-shrink": "0", "white-space": "nowrap" }}>
                          {showHostToken() ? "Hide" : "Show"}
                        </button>
                      </div>
                    </div>
                    <Show when={!hostUrl().trim().toLowerCase().startsWith("http://")}>
                      <div class="settings-row" style={{ padding: "4px 0" }}>
                        <div class="settings-row-left">
                          <span class="settings-label" style={{ "font-size": "13px" }}>Verify TLS certificate</span>
                          <span class="settings-description">Disable for self-signed certificates</span>
                        </div>
                        <label class="toggle">
                          <input type="checkbox" checked={hostTlsVerify()} onChange={(e) => setHostTlsVerify(e.currentTarget.checked)} />
                          <span class="toggle-slider" />
                        </label>
                      </div>
                    </Show>
                    <div class="form-group">
                      <label class="form-label">Tags <span style={{ color: "#484f58", "font-weight": "400" }}>(comma-separated)</span></label>
                      <input class="form-input" type="text" placeholder="production, eu-west, staging" value={hostTags()} onInput={(e) => setHostTags(e.currentTarget.value)} />
                      <Show when={hostTags().trim().length > 0}>
                        <div style={{ display: "flex", "flex-wrap": "wrap", gap: "4px", "margin-top": "6px" }}>
                          <For each={hostTags().split(",").map(t => t.trim()).filter(t => t.length > 0)}>
                            {(tag) => (
                              <span style={{
                                padding: "2px 8px",
                                "border-radius": "12px",
                                "font-size": "11px",
                                "font-weight": "500",
                                background: "rgba(88, 166, 255, 0.1)",
                                color: "#58a6ff",
                                border: "1px solid rgba(88, 166, 255, 0.15)",
                              }}>{tag}</span>
                            )}
                          </For>
                        </div>
                      </Show>
                    </div>
                    <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
                      <button class="btn btn-primary" onClick={saveHost} disabled={!hostName().trim() || !hostUrl().trim()}>
                        {editingHost() ? "Update" : "Save"}
                      </button>
                      <button class="btn" onClick={() => { testHost(); }} disabled={hostTesting() || !hostUrl().trim()}>
                        {hostTesting() ? "Testing..." : "Test connection"}
                      </button>
                      <button class="btn" onClick={() => { setShowAddHost(false); resetHostForm(); }}>Cancel</button>
                    </div>
                    <Show when={hostTestResult()}>
                      <div style={{
                        padding: "8px 12px",
                        "border-radius": "6px",
                        "font-size": "12px",
                        background: hostTestResult()!.startsWith("Failed") ? "#f8514922" : "#3fb95022",
                        color: hostTestResult()!.startsWith("Failed") ? "#f85149" : "#3fb950",
                        border: `1px solid ${hostTestResult()!.startsWith("Failed") ? "#f8514944" : "#3fb95044"}`,
                      }}>
                        {hostTestResult()}
                      </div>
                    </Show>
                  </div>
                </div>
              </Show>
            </div>
          </div>
        </Show>

        {/* === Auto-Deploy Tab === */}
        <Show when={tab() === "auto-deploy"}>
          <div class="settings-section">
            <h2 class="settings-section-title">Auto-deploy</h2>
            <p style={{ "font-size": "13px", color: "#8b949e", "margin-bottom": "16px", "line-height": "1.5" }}>
              Redeploys matching containers when GitHub or Docker Hub reports a new image.{" "}
              <HelpLink path="/docs/auto-deploy/" />
            </p>

            {/* Setup guide */}
            <Show when={deployRules().length === 0}>
              <p style={{ "font-size": "12px", color: "#8b949e", "margin-bottom": "16px", "line-height": "1.5" }}>
                To set up: save a webhook secret, add a rule below, then add the webhook URL and secret to your GitHub repo or Docker Hub.{" "}
                <HelpLink path="/docs/auto-deploy/#connect-github">Setup steps</HelpLink>
              </p>
            </Show>

            <div style={{ background: "#0d1117", "border-radius": "8px", padding: "14px 16px", "margin-bottom": "16px" }}>
              <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", "margin-bottom": "6px" }}>
                <span style={{ "font-size": "12px", color: "#8b949e" }}>Webhook URL (paste into GitHub repo settings):</span>
                <button class="btn btn-sm" style={{ "font-size": "11px", padding: "2px 8px" }}
                  onClick={async () => {
                    try {
                      const url = await invoke("get_webhook_url") as string;
                      await navigator.clipboard.writeText(url);
                      setWebhookUrlCopied(true);
                      setTimeout(() => setWebhookUrlCopied(false), 2000);
                    } catch { showToast("Failed to copy URL", "error"); }
                  }}
                >{webhookUrlCopied() ? "Copied!" : "Copy"}</button>
              </div>
              <code class="mono" style={{ "font-size": "13px", color: "#58a6ff", "word-break": "break-all", display: "block" }}>
                {webhookUrl() || "Loading..."}
              </code>
              <div style={{ color: "#6e7681", "margin-top": "8px", "font-size": "11px" }}>
                Event: <strong style={{ color: "#8b949e" }}>Packages</strong> &middot; Content type: <strong style={{ color: "#8b949e" }}>application/json</strong> &middot; For Docker Hub use <code style={{ color: "#6e7681" }}>/webhooks/dockerhub?token=&lt;webhook secret&gt;</code>
              </div>
            </div>

            {/* Webhook secret */}
            <div style={{ background: "#0d1117", "border-radius": "8px", padding: "14px 16px", "margin-bottom": "16px" }}>
              <div class="form-group" style={{ margin: 0 }}>
                <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", "margin-bottom": "6px" }}>
                  <label class="form-label" style={{ margin: 0 }}>Webhook secret</label>
                  <button class="btn btn-sm" style={{ "font-size": "11px", padding: "2px 8px" }}
                    onClick={async () => {
                      try {
                        await invoke("save_webhook_secret", { secret: webhookSecret().trim() || null });
                        showToast(webhookSecret().trim() ? "Webhook secret saved" : "Webhook secret cleared", "success");
                      } catch (e) { showToast(`Failed: ${e}`, "error"); }
                    }}
                  >Save</button>
                </div>
                <div style={{ display: "flex", gap: "8px" }}>
                <input class="form-input mono" type="password" placeholder="Same secret you set in GitHub webhook settings"
                  value={webhookSecret()} onInput={(e) => setWebhookSecret(e.currentTarget.value)}
                  style={{ "font-size": "12px", flex: "1" }}
                />
                <button class="btn btn-sm" title="Fill in a random secret, then Save and paste it into GitHub"
                  onClick={async () => {
                    const bytes = crypto.getRandomValues(new Uint8Array(24));
                    const secret = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
                    setWebhookSecret(secret);
                    try { await navigator.clipboard.writeText(secret); showToast("Secret generated and copied. Save it, then paste it into GitHub.", "info"); } catch {}
                  }}
                >Generate</button>
                </div>
                <span class="form-hint">Required: Orca refuses every webhook until a secret is set. GitHub signs its payloads with it (HMAC-SHA256); Docker Hub sends it as <code>?token=</code> in the webhook URL.</span>
              </div>
            </div>

            {/* Test webhook */}
            <div style={{ background: "#0d1117", "border-radius": "8px", padding: "14px 16px", "margin-bottom": "20px" }}>
              <div style={{ "font-size": "12px", color: "#8b949e", "margin-bottom": "8px" }}>Test your rules — enter an image and tag to see which rules would match:</div>
              <div style={{ display: "flex", gap: "8px", "align-items": "flex-end" }}>
                <div style={{ flex: 2 }}>
                  <input class="form-input mono" type="text" placeholder="ghcr.io/myorg/myapp" id="test-image" style={{ "font-size": "12px" }} />
                </div>
                <div style={{ flex: 1 }}>
                  <input class="form-input mono" type="text" placeholder="v1.0.0" id="test-tag" style={{ "font-size": "12px" }} />
                </div>
                <button class="btn btn-sm" disabled={testingWebhook()}
                  onClick={async () => {
                    const img = (document.getElementById("test-image") as HTMLInputElement)?.value.trim();
                    const tag = (document.getElementById("test-tag") as HTMLInputElement)?.value.trim() || "latest";
                    if (!img) return;
                    setTestingWebhook(true);
                    try {
                      const result = await invoke("test_deploy_webhook", { image: img, tag }) as any;
                      if (result.would_deploy) {
                        showToast(`Would deploy: ${result.matched_rules.map((r: any) => r.rule_name).join(", ")}`, "success");
                      } else {
                        showToast(`No rules match ${img}:${tag}`, "info");
                      }
                    } catch (e) { showToast(`Test failed: ${e}`, "error"); }
                    setTestingWebhook(false);
                  }}
                >{testingWebhook() ? "Testing..." : "Test"}</button>
              </div>
            </div>

            <Show when={deployRules().length > 0}>
              <table class="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Image pattern</th>
                    <th>Tag filter</th>
                    <th>Containers</th>
                    <th style={{ width: "60px" }}>Status</th>
                    <th style={{ "text-align": "right", width: "80px" }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={deployRules()}>
                    {(rule) => (
                      <tr>
                        <td style={{ "font-weight": 500 }}>{rule.name}</td>
                        <td class="mono" style={{ "font-size": "12px", color: "#8b949e" }}>{rule.image_pattern}</td>
                        <td>
                          <span class="mono" style={{ "font-size": "12px", padding: "1px 6px", "border-radius": "4px", background: "rgba(88, 166, 255, 0.1)", color: "#58a6ff" }}>
                            {rule.tag_filter || "*"}
                          </span>
                        </td>
                        <td style={{ "font-size": "12px", color: "#8b949e" }}>
                          {rule.container_names?.length ? rule.container_names.join(", ") : "Any matching"}
                        </td>
                        <td>
                          <span style={{
                            "font-size": "11px", padding: "2px 6px", "border-radius": "4px",
                            background: rule.enabled ? "rgba(63, 185, 80, 0.1)" : "rgba(139, 148, 158, 0.1)",
                            color: rule.enabled ? "#3fb950" : "#8b949e",
                          }}>{rule.enabled ? "Active" : "Paused"}</span>
                        </td>
                        <td style={{ "text-align": "right" }}>
                          <div style={{ display: "flex", gap: "4px", "justify-content": "flex-end" }}>
                            <button class="btn btn-sm" onClick={() => startEditRule(rule)} title="Edit">
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
                            </button>
                            <button class="btn btn-sm btn-danger" onClick={() => deleteRule(rule.id)} title="Delete">
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>

            <div style={{ "margin-top": "12px" }}>
              <Show when={!showAddRule()}>
                <button class="btn btn-primary" onClick={() => { resetRuleForm(); setShowAddRule(true); }}>Add rule</button>
              </Show>
            </div>

            <Show when={showAddRule()}>
              <div class="card" style={{ "margin-top": "12px" }}>
                <h3 style={{ "font-size": "14px", "font-weight": 600, "margin-bottom": "12px", color: "#e6edf3" }}>
                  {editingRule() ? `Edit "${editingRule().name}"` : "Add deploy rule"}
                </h3>
                <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
                  <div class="form-group">
                    <label class="form-label">Rule name</label>
                    <input class="form-input" type="text" placeholder="Production API" value={ruleName()} onInput={(e) => setRuleName(e.currentTarget.value)} />
                  </div>
                  <div class="form-group">
                    <label class="form-label">Image pattern</label>
                    <input class="form-input mono" type="text" placeholder="ghcr.io/myorg/myapp" value={ruleImage()} onInput={(e) => setRuleImage(e.currentTarget.value)} />
                    <span class="form-hint">The full image name without tag, e.g. ghcr.io/myorg/api. It must match the pushed image exactly; the registry host may be left out (myorg/api).</span>
                  </div>
                  <div class="form-row">
                    <div class="form-group" style={{ flex: 1 }}>
                      <label class="form-label">Tag filter</label>
                      <input class="form-input mono" type="text" placeholder="latest, v*, main" value={ruleTagFilter()} onInput={(e) => setRuleTagFilter(e.currentTarget.value)} />
                      <span class="form-hint">One or more, separated by commas: * = any tag, v* = version tags (v1.0, v2.3.1), latest, main</span>
                    </div>
                    <div class="form-group" style={{ flex: 1 }}>
                      <label class="form-label">Container names</label>
                      <input class="form-input" type="text" placeholder="Leave empty to match by image" value={ruleContainers()} onInput={(e) => setRuleContainers(e.currentTarget.value)} />
                      <span class="form-hint">e.g. api, worker. Leave empty to redeploy any container using this image.</span>
                    </div>
                  </div>
                  <div class="settings-row" style={{ padding: "4px 0" }}>
                    <div class="settings-row-left">
                      <span class="settings-label" style={{ "font-size": "13px" }}>Enabled</span>
                      <span class="settings-description">Pause this rule without deleting it</span>
                    </div>
                    <label class="toggle">
                      <input type="checkbox" checked={ruleEnabled()} onChange={(e) => setRuleEnabled(e.currentTarget.checked)} />
                      <span class="toggle-slider" />
                    </label>
                  </div>
                  <div style={{ display: "flex", gap: "8px" }}>
                    <button class="btn btn-primary" onClick={saveRule} disabled={!ruleName().trim() || !ruleImage().trim()}>
                      {editingRule() ? "Update" : "Save"}
                    </button>
                    <button class="btn" onClick={() => { setShowAddRule(false); resetRuleForm(); }}>Cancel</button>
                  </div>
                </div>
              </div>
            </Show>
          </div>

          <Show when={deployHistory().length > 0}>
            <div class="settings-section" style={{ "margin-top": "24px" }}>
              <h2 class="settings-section-title">Deploy history</h2>
              <table class="table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Rule</th>
                    <th>Image</th>
                    <th>Container</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={deployHistory().slice(0, 20)}>
                    {(record) => (
                      <tr>
                        <td style={{ "font-size": "12px", color: "#8b949e" }}>
                          {new Date(parseInt(record.timestamp) * 1000).toLocaleString()}
                        </td>
                        <td style={{ "font-weight": 500 }}>{record.rule_name}</td>
                        <td class="mono" style={{ "font-size": "12px", color: "#8b949e" }}>{record.image}</td>
                        <td>{record.container_name}</td>
                        <td>
                          <span style={{
                            "font-size": "11px", padding: "2px 6px", "border-radius": "4px",
                            background: record.status === "Success" ? "rgba(63, 185, 80, 0.1)" : "rgba(248, 81, 73, 0.1)",
                            color: record.status === "Success" ? "#3fb950" : "#f85149",
                          }}>{record.status}</span>
                          <Show when={record.error}>
                            <div style={{ "font-size": "11px", color: "#f85149", "margin-top": "2px" }}>{record.error}</div>
                          </Show>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
        </Show>

        {/* === Schedules Tab === */}
        <Show when={tab() === "schedules"}>
          <div class="settings-section">
            <h2 class="settings-section-title">Scheduled actions</h2>
            <p style={{ "font-size": "13px", color: "#8b949e", "margin-bottom": "16px", "line-height": "1.5" }}>
              Container actions on a cron schedule, in the local time of the machine the daemon runs on.{" "}
              <HelpLink path="/docs/containers/#scheduled-actions" />
            </p>

            <Show when={schedules().length > 0}>
              <table class="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Container</th>
                    <th>Action</th>
                    <th>Schedule</th>
                    <th style={{ width: "60px" }}>Status</th>
                    <th style={{ "text-align": "right", width: "80px" }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={schedules()}>
                    {(sched) => (
                      <tr>
                        <td style={{ "font-weight": 500 }}>{sched.name}</td>
                        <td class="mono" style={{ "font-size": "12px", color: "#8b949e" }}>{sched.action === "build" ? (sched.build_target || sched.container) : sched.container}</td>
                        <td>
                          <span style={{
                            "font-size": "11px", padding: "2px 6px", "border-radius": "4px",
                            background: sched.action === "restart" ? "rgba(210, 169, 34, 0.1)" : sched.action === "stop" ? "rgba(248, 81, 73, 0.1)" : sched.action === "build" ? "rgba(88, 166, 255, 0.1)" : "rgba(63, 185, 80, 0.1)",
                            color: sched.action === "restart" ? "#d29922" : sched.action === "stop" ? "#f85149" : sched.action === "build" ? "#58a6ff" : "#3fb950",
                          }}>{sched.action}</span>
                        </td>
                        <td class="mono" style={{ "font-size": "12px", color: "#8b949e" }}>{sched.cron}</td>
                        <td>
                          <span style={{
                            "font-size": "11px", padding: "2px 6px", "border-radius": "4px",
                            background: sched.enabled ? "rgba(63, 185, 80, 0.1)" : "rgba(139, 148, 158, 0.1)",
                            color: sched.enabled ? "#3fb950" : "#8b949e",
                          }}>{sched.enabled ? "Active" : "Paused"}</span>
                        </td>
                        <td style={{ "text-align": "right" }}>
                          <div style={{ display: "flex", gap: "4px", "justify-content": "flex-end" }}>
                            <button class="btn btn-sm" onClick={() => {
                              setEditingSchedule(sched); setSchedName(sched.name); setSchedContainer(sched.container);
                              setSchedAction(sched.action); setSchedCron(sched.cron); setSchedEnabled(sched.enabled);
                              setSchedBuildTarget(sched.build_target || "");
                              setShowAddSchedule(true);
                            }} title="Edit">
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
                            </button>
                            <button class="btn btn-sm btn-danger" onClick={async () => {
                              const label = sched.name ? `"${sched.name}"` : "this schedule";
                              if (!(await confirmDanger(`Delete schedule?`, `Remove ${label}? It will stop running on its cron trigger.`))) return;
                              try { await invoke("delete_schedule", { id: sched.id }); showToast("Deleted", "success"); await refreshSchedules(); }
                              catch (e) { showToast(`Failed: ${e}`, "error"); }
                            }} title="Delete">
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>

            <div style={{ "margin-top": "12px" }}>
              <Show when={!showAddSchedule()}>
                <button class="btn btn-primary" onClick={() => { resetSchedForm(); setShowAddSchedule(true); }}>Add schedule</button>
              </Show>
            </div>

            <Show when={showAddSchedule()}>
              <div class="card" style={{ "margin-top": "12px" }}>
                <h3 style={{ "font-size": "14px", "font-weight": 600, "margin-bottom": "12px", color: "#e6edf3" }}>
                  {editingSchedule() ? `Edit "${editingSchedule().name}"` : "Add schedule"}
                </h3>
                <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
                  <div class="form-row">
                    <div class="form-group" style={{ flex: 1 }}>
                      <label class="form-label">Name</label>
                      <input class="form-input" type="text" placeholder="Nightly restart" value={schedName()} onInput={(e) => setSchedName(e.currentTarget.value)} />
                    </div>
                    <div class="form-group" style={{ flex: 1 }}>
                      <label class="form-label">Action</label>
                      <Dropdown value={schedAction()} options={[
                        { value: "restart", label: "Restart" },
                        { value: "stop", label: "Stop" },
                        { value: "start", label: "Start" },
                        { value: "build", label: "Build" },
                      ]} onChange={(v) => setSchedAction(v)} />
                    </div>
                  </div>
                  <Show when={schedAction() !== "build"}>
                    <div class="form-row">
                      <div class="form-group" style={{ flex: 1 }}>
                        <label class="form-label">Container</label>
                        <input class="form-input" type="text" placeholder="Container name or ID" value={schedContainer()} onInput={(e) => setSchedContainer(e.currentTarget.value)} />
                      </div>
                    </div>
                  </Show>
                  <Show when={schedAction() === "build"}>
                    <div class="form-row">
                      <div class="form-group" style={{ flex: 1 }}>
                        <label class="form-label">Build target</label>
                        <Show when={schedBuildTargets().length > 0} fallback={
                          <input class="form-input" type="text" placeholder="Build target name from orca.yaml" value={schedBuildTarget()} onInput={(e) => setSchedBuildTarget(e.currentTarget.value)} />
                        }>
                          <Dropdown
                            value={schedBuildTarget()}
                            options={schedBuildTargets().map((t: any) => ({ value: t.name, label: `${t.name} (${t.tag})` }))}
                            onChange={(v) => setSchedBuildTarget(v)}
                          />
                        </Show>
                        <span class="form-hint">Select a build target defined in orca.yaml</span>
                      </div>
                    </div>
                  </Show>
                  <div class="form-row">
                    <div class="form-group" style={{ flex: 2 }}>
                      <label class="form-label">Cron expression</label>
                      <input class="form-input mono" type="text" placeholder="0 3 * * 0" value={schedCron()} onInput={(e) => setSchedCron(e.currentTarget.value)} />
                      <span class="form-hint">
                        Examples: <code>0 3 * * 0</code> (Sun 3am), <code>0 18 * * 1-5</code> (weekdays 6pm), <code>0 */6 * * *</code> (every 6h), <code>0 0 1 * *</code> (1st of month). Minute, hour, day, month, weekday, in this computer's time.
                      </span>
                    </div>
                  </div>
                  <div class="settings-row" style={{ padding: "4px 0" }}>
                    <div class="settings-row-left">
                      <span class="settings-label" style={{ "font-size": "13px" }}>Enabled</span>
                      <span class="settings-description">Pause this schedule without deleting it</span>
                    </div>
                    <label class="toggle">
                      <input type="checkbox" checked={schedEnabled()} onChange={(e) => setSchedEnabled(e.currentTarget.checked)} />
                      <span class="toggle-slider" />
                    </label>
                  </div>
                  <div style={{ display: "flex", gap: "8px" }}>
                    <button class="btn btn-primary" onClick={saveSchedRule} disabled={!schedName().trim() || !schedCron().trim() || (schedAction() === "build" ? !schedBuildTarget().trim() : !schedContainer().trim())}>
                      {editingSchedule() ? "Update" : "Save"}
                    </button>
                    <button class="btn" onClick={() => { setShowAddSchedule(false); resetSchedForm(); }}>Cancel</button>
                  </div>
                </div>
              </div>
            </Show>
          </div>
        </Show>

        {/* === Maintenance Tab === */}
        <Show when={tab() === "maintenance"}>
          <div style={{ display: "flex", "flex-direction": "column", gap: "20px" }}>
            <div class="settings-section">
              <h2 class="settings-section-title">System cleanup</h2>
              <p style={{ "font-size": "13px", color: "#8b949e", "margin-bottom": "16px", "line-height": "1.5" }}>
                Remove unused Docker resources to free up disk space. Select what to clean up and click "Run Cleanup".
              </p>

              <div style={{ display: "flex", "flex-direction": "column", gap: "1px" }}>
                {/* Stopped Containers - Safe */}
                <div style={{
                  background: "#161b22",
                  "border-left": "3px solid #3fb950",
                  padding: "14px 16px",
                  "border-radius": "6px 6px 0 0",
                  display: "flex",
                  "align-items": "flex-start",
                  gap: "12px",
                  cursor: "pointer",
                }} onClick={() => setPruneContainers(!pruneContainers())}>
                  <input
                    type="checkbox"
                    checked={pruneContainers()}
                    onChange={(e) => { e.stopPropagation(); setPruneContainers(e.currentTarget.checked); }}
                    style={{ "margin-top": "2px", "accent-color": "#3fb950", cursor: "pointer" }}
                  />
                  <div style={{ flex: "1" }}>
                    <div style={{ display: "flex", "align-items": "center", gap: "8px", "margin-bottom": "4px" }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#3fb950" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="5" rx="2"/><path d="M2 10h20"/></svg>
                      <span style={{ "font-size": "13px", "font-weight": "600", color: "#e6edf3" }}>Stopped containers</span>
                      <span style={{ "font-size": "11px", padding: "1px 6px", "border-radius": "10px", background: "#3fb95020", color: "#3fb950" }}>Safe</span>
                    </div>
                    <div style={{ "font-size": "12px", color: "#8b949e" }}>Remove all stopped containers (exited, dead, created)</div>
                  </div>
                </div>

                {/* Dangling Images - Safe */}
                <div style={{
                  background: "#161b22",
                  "border-left": "3px solid #3fb950",
                  padding: "14px 16px",
                  display: "flex",
                  "align-items": "flex-start",
                  gap: "12px",
                  cursor: "pointer",
                }} onClick={() => setPruneImages(!pruneImages())}>
                  <input
                    type="checkbox"
                    checked={pruneImages()}
                    onChange={(e) => { e.stopPropagation(); setPruneImages(e.currentTarget.checked); }}
                    style={{ "margin-top": "2px", "accent-color": "#3fb950", cursor: "pointer" }}
                  />
                  <div style={{ flex: "1" }}>
                    <div style={{ display: "flex", "align-items": "center", gap: "8px", "margin-bottom": "4px" }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#3fb950" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18M9 3v18"/></svg>
                      <span style={{ "font-size": "13px", "font-weight": "600", color: "#e6edf3" }}>Dangling images</span>
                      <span style={{ "font-size": "11px", padding: "1px 6px", "border-radius": "10px", background: "#3fb95020", color: "#3fb950" }}>Safe</span>
                    </div>
                    <div style={{ "font-size": "12px", color: "#8b949e" }}>Remove images not tagged and not referenced by any container</div>
                  </div>
                </div>

                {/* Unused Networks - Moderate */}
                <div style={{
                  background: "#161b22",
                  "border-left": "3px solid #d29922",
                  padding: "14px 16px",
                  display: "flex",
                  "align-items": "flex-start",
                  gap: "12px",
                  cursor: "pointer",
                }} onClick={() => setPruneNetworks(!pruneNetworks())}>
                  <input
                    type="checkbox"
                    checked={pruneNetworks()}
                    onChange={(e) => { e.stopPropagation(); setPruneNetworks(e.currentTarget.checked); }}
                    style={{ "margin-top": "2px", "accent-color": "#d29922", cursor: "pointer" }}
                  />
                  <div style={{ flex: "1" }}>
                    <div style={{ display: "flex", "align-items": "center", gap: "8px", "margin-bottom": "4px" }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#d29922" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="3"/><circle cx="5" cy="19" r="3"/><circle cx="19" cy="19" r="3"/><path d="M12 8v4M5.5 16.5l4-7M18.5 16.5l-4-7"/></svg>
                      <span style={{ "font-size": "13px", "font-weight": "600", color: "#e6edf3" }}>Unused networks</span>
                      <span style={{ "font-size": "11px", padding: "1px 6px", "border-radius": "10px", background: "#d2992220", color: "#d29922" }}>Moderate</span>
                    </div>
                    <div style={{ "font-size": "12px", color: "#8b949e" }}>Remove all custom networks not used by any container</div>
                  </div>
                </div>

                {/* Build Cache - Safe */}
                <div style={{
                  background: "#161b22",
                  "border-left": "3px solid #3fb950",
                  padding: "14px 16px",
                  display: "flex",
                  "align-items": "flex-start",
                  gap: "12px",
                  cursor: "pointer",
                }} onClick={() => setPruneBuildCache(!pruneBuildCache())}>
                  <input
                    type="checkbox"
                    checked={pruneBuildCache()}
                    onChange={(e) => { e.stopPropagation(); setPruneBuildCache(e.currentTarget.checked); }}
                    style={{ "margin-top": "2px", "accent-color": "#3fb950", cursor: "pointer" }}
                  />
                  <div style={{ flex: "1" }}>
                    <div style={{ display: "flex", "align-items": "center", gap: "8px", "margin-bottom": "4px" }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#3fb950" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 20h20M5 20V8l7-5 7 5v12"/><path d="M9 20v-6h6v6"/></svg>
                      <span style={{ "font-size": "13px", "font-weight": "600", color: "#e6edf3" }}>Build cache</span>
                      <span style={{ "font-size": "11px", padding: "1px 6px", "border-radius": "10px", background: "#3fb95020", color: "#3fb950" }}>Safe</span>
                    </div>
                    <div style={{ "font-size": "12px", color: "#8b949e" }}>Remove Docker build cache to free disk space</div>
                  </div>
                </div>

                {/* Unused Volumes - Dangerous */}
                <div style={{
                  background: "#161b22",
                  "border-left": "3px solid #f85149",
                  padding: "14px 16px",
                  "border-radius": "0 0 6px 6px",
                  display: "flex",
                  "align-items": "flex-start",
                  gap: "12px",
                  cursor: "pointer",
                }} onClick={() => setPruneVolumes(!pruneVolumes())}>
                  <input
                    type="checkbox"
                    checked={pruneVolumes()}
                    onChange={(e) => { e.stopPropagation(); setPruneVolumes(e.currentTarget.checked); }}
                    style={{ "margin-top": "2px", "accent-color": "#f85149", cursor: "pointer" }}
                  />
                  <div style={{ flex: "1" }}>
                    <div style={{ display: "flex", "align-items": "center", gap: "8px", "margin-bottom": "4px" }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f85149" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3"/></svg>
                      <span style={{ "font-size": "13px", "font-weight": "600", color: "#e6edf3" }}>Unused volumes</span>
                      <span style={{ "font-size": "11px", padding: "1px 6px", "border-radius": "10px", background: "#f8514920", color: "#f85149" }}>Dangerous</span>
                    </div>
                    <div style={{ "font-size": "12px", color: "#f85149" }}>Remove all volumes not used by any container. This will permanently delete data!</div>
                  </div>
                </div>
              </div>

              {/* Action area */}
              <div style={{ "margin-top": "20px", display: "flex", "align-items": "center", gap: "12px" }}>
                <Show when={!pruneShowConfirm()}>
                  <button
                    class="btn btn-primary"
                    disabled={pruneRunning() || (!pruneContainers() && !pruneImages() && !pruneVolumes() && !pruneNetworks() && !pruneBuildCache())}
                    onClick={() => setPruneShowConfirm(true)}
                  >
                    Run cleanup
                  </button>
                </Show>
                <Show when={pruneShowConfirm()}>
                  <div style={{
                    flex: "1",
                    background: "#da363318",
                    border: "1px solid #da363344",
                    "border-radius": "8px",
                    padding: "12px 16px",
                  }}>
                    <div style={{ "font-size": "13px", "font-weight": "600", color: "#f85149", "margin-bottom": "8px" }}>Confirm cleanup</div>
                    <div style={{ "font-size": "12px", color: "#8b949e", "margin-bottom": "12px" }}>
                      This will remove:
                      <ul style={{ margin: "4px 0 0 16px", padding: "0" }}>
                        <Show when={pruneContainers()}><li>Stopped containers</li></Show>
                        <Show when={pruneImages()}><li>Dangling images</li></Show>
                        <Show when={pruneNetworks()}><li>Unused networks</li></Show>
                        <Show when={pruneBuildCache()}><li>Build cache</li></Show>
                        <Show when={pruneVolumes()}><li style={{ color: "#f85149" }}>Unused volumes (data loss!)</li></Show>
                      </ul>
                    </div>
                    <div style={{ display: "flex", gap: "8px" }}>
                      <button class="btn" onClick={() => setPruneShowConfirm(false)}>Cancel</button>
                      <button
                        class="btn"
                        style={{ background: "#da3633", "border-color": "#da3633", color: "#fff" }}
                        disabled={pruneRunning()}
                        onClick={async () => {
                          setPruneShowConfirm(false);
                          setPruneRunning(true);
                          setPruneResults([]);
                          const results: string[] = [];
                          try {
                            if (pruneContainers()) {
                              const r = (await invoke("cleanup", { scope: "containers" })) as { log: string[] };
                              results.push(...r.log);
                            }
                            if (pruneImages()) {
                              const r = (await invoke("cleanup", { scope: "images" })) as { log: string[] };
                              results.push(...r.log);
                            }
                            if (pruneNetworks()) {
                              const r = (await invoke("cleanup", { scope: "networks" })) as { log: string[] };
                              results.push(...r.log);
                            }
                            if (pruneBuildCache()) {
                              const r = (await invoke("cleanup", { scope: "build_cache" })) as { log: string[] };
                              results.push(...r.log);
                            }
                            if (pruneVolumes()) {
                              const r = (await invoke("cleanup", { scope: "volumes" })) as { log: string[] };
                              results.push(...r.log);
                            }
                            showToast("System cleanup complete", "success");
                          } catch (e) {
                            results.push(`Error: ${e}`);
                            logError(`System cleanup failed: ${e}`);
                            showToast(`Cleanup failed: ${e}`, "error");
                          }
                          setPruneResults(results);
                          setPruneRunning(false);
                          // Reset checkboxes
                          setPruneContainers(false);
                          setPruneImages(false);
                          setPruneVolumes(false);
                          setPruneNetworks(false);
                          setPruneBuildCache(false);
                        }}
                      >
                        {pruneRunning() ? "Cleaning..." : "Confirm & Clean"}
                      </button>
                    </div>
                  </div>
                </Show>
                <Show when={pruneRunning()}>
                  <Spinner />
                  <span style={{ "font-size": "13px", color: "#8b949e" }}>Running cleanup...</span>
                </Show>
              </div>

              {/* Results */}
              <Show when={pruneResults().length > 0}>
                <div style={{
                  "margin-top": "16px",
                  background: "#0d1117",
                  border: "1px solid #30363d",
                  "border-radius": "8px",
                  padding: "12px 16px",
                }}>
                  <div style={{ "font-size": "13px", "font-weight": "600", color: "#3fb950", "margin-bottom": "8px" }}>Cleanup results</div>
                  <For each={pruneResults()}>
                    {(line) => (
                      <div style={{ "font-size": "12px", color: "#8b949e", padding: "2px 0" }} class="mono">{line}</div>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </div>
        </Show>

        {/* === Certificates Tab === */}
        <Show when={tab() === "certificates"}>
          <div style={{ display: "flex", "flex-direction": "column", gap: "20px" }}>
            <CertificateAuthoritySection />
          </div>
        </Show>

        {/* === Privacy & Security Tab === */}
        <Show when={tab() === "privacy"}>
          <div style={{ display: "flex", "flex-direction": "column", gap: "20px" }}>

            {/* Zero Telemetry Banner */}
            <div style={{ background: "linear-gradient(135deg, rgba(63, 185, 80, 0.08) 0%, rgba(88, 166, 255, 0.08) 100%)", border: "1px solid rgba(63, 185, 80, 0.15)", "border-radius": "12px", padding: "24px 28px", "text-align": "center" }}>
              <div style={{ "font-size": "28px", "font-weight": "800", "letter-spacing": "-1px", "margin-bottom": "6px", background: "linear-gradient(135deg, #3fb950, #58a6ff)", "-webkit-background-clip": "text", "-webkit-text-fill-color": "transparent", "background-clip": "text" }}>Zero telemetry</div>
              <div style={{ "font-size": "13px", color: "#8b949e", "line-height": "1.6" }}>Orca Desktop collects no analytics, no crash reports and no usage data.</div>
            </div>

            {/* Network Connections */}
            <div class="settings-section">
              <h2 class="settings-section-title">Network connections</h2>
              <div class="card">
                <p style={{ "font-size": "12px", color: "#6e7681", "margin-bottom": "12px" }}>The services Orca connects to, besides the ones your containers use.</p>
                <div style={{ display: "flex", "flex-direction": "column", gap: "0" }}>
                  <For each={[
                    ["AUTO", "#d29922", "Update check", "github.com", "On startup and every hour", "No user data"],
                    ["AUTO", "#d29922", "Template catalog", "orca-desktop.com", "Fetches app templates (cached hourly)", "No user data"],
                    ["USER", "#58a6ff", "Release check for AI tools", "api.github.com", "When an AI tool asks if Orca is current (cached hourly)", "No user data"],
                    ["USER", "#58a6ff", "Docker Hub search", "hub.docker.com", "When you search for images", "Search query only"],
                    ["USER", "#58a6ff", "AI assistant", "Your provider", "When you ask the assistant", "Your question and what its tools read, secrets blanked"],
                    ["USER", "#58a6ff", "Installers", "github.com", "When you set up Docker, Lima or Helm", "No user data"],
                    ["USER", "#58a6ff", "Image pull", "Your registries", "When you click 'Pull'", "Image reference"],
                    ["USER", "#58a6ff", "Remote hosts", "Your Orca daemons", "When you add a remote host", "API token (yours)"],
                  ] as [string, string, string, string, string, string][]}>{([type, color, name, dest, when, data]) => (
                    <div style={{ display: "flex", "align-items": "center", gap: "12px", padding: "10px 0", "border-bottom": "1px solid #21262d" }}>
                      <span style={{ "font-size": "9px", "font-weight": "700", "text-transform": "uppercase", color, "min-width": "32px", "letter-spacing": "0.5px" }}>{type}</span>
                      <div style={{ flex: "1" }}>
                        <div style={{ "font-size": "13px", "font-weight": "500" }}>{name} <span class="mono" style={{ "font-size": "11px", color: "#6e7681" }}>{dest}</span></div>
                        <div style={{ "font-size": "11px", color: "#8b949e" }}>{when}</div>
                      </div>
                      <span style={{ "font-size": "11px", color: type === "AUTO" ? "#3fb950" : "#d29922", "font-weight": "600", "white-space": "nowrap" }}>{data}</span>
                    </div>
                  )}</For>
                </div>
              </div>
            </div>

            {/* Security */}
            <div class="settings-section">
              <h2 class="settings-section-title">Security</h2>
              <div class="card">
                <div style={{ display: "flex", "flex-direction": "column", gap: "12px" }}>
                  <For each={[
                    ["Localhost only", "The desktop daemon binds to 127.0.0.1:9477, out of reach of the network"],
                    ["Token auth", "All API calls require a locally-generated bearer token"],
                    ["Signed updates", "The updater checks every download against a key built into the app"],
                    ["TLS support", "Remote host connections support TLS with certificate verification"],
                    ["Webhook secrets", "Webhooks are refused until a secret is set; GitHub's are checked with HMAC-SHA256, Docker Hub's by token"],
                    ["Open source", "MIT licensed — audit every line of code on GitHub"],
                  ] as [string, string][]}>{([title, desc]) => (
                    <div style={{ display: "flex", "align-items": "flex-start", gap: "10px" }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3fb950" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style={{ "flex-shrink": "0", "margin-top": "2px" }}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                      <div>
                        <div style={{ "font-size": "13px", "font-weight": "500" }}>{title}</div>
                        <div style={{ "font-size": "12px", color: "#8b949e" }}>{desc}</div>
                      </div>
                    </div>
                  )}</For>
                </div>
              </div>
            </div>

            {/* Certificate Authority — moved to Certificates tab */}
            <div class="settings-section">
              <h2 class="settings-section-title">Certificate authority</h2>
              <div class="card">
                <p style={{ "font-size": "12px", color: "#8b949e", "line-height": "1.6" }}>
                  Certificate management has moved to the{" "}
                  <button
                    class="btn-link"
                    style={{ color: "#58a6ff", background: "none", border: "none", cursor: "pointer", "font-size": "12px", padding: "0" }}
                    onClick={() => setTab("certificates")}
                  >
                    Certificates tab
                  </button>.
                </p>
              </div>
            </div>

            {/* AI Privacy */}
            <div class="settings-section">
              <h2 class="settings-section-title">AI privacy</h2>
              <div class="card">
                <div style={{ display: "flex", "flex-direction": "column", gap: "10px", "font-size": "13px", color: "#c9d1d9", "line-height": "1.6" }}>
                  <div style={{ display: "flex", "align-items": "flex-start", gap: "10px" }}>
                    <span style={{ color: "#a371f7", "flex-shrink": "0", "margin-top": "2px" }}>&#10003;</span>
                    <span>AI is <strong>entirely optional</strong> and off by default</span>
                  </div>
                  <div style={{ display: "flex", "align-items": "flex-start", gap: "10px" }}>
                    <span style={{ color: "#a371f7", "flex-shrink": "0", "margin-top": "2px" }}>&#10003;</span>
                    <span>You provide your own API key — we never see it</span>
                  </div>
                  <div style={{ display: "flex", "align-items": "flex-start", gap: "10px" }}>
                    <span style={{ color: "#a371f7", "flex-shrink": "0", "margin-top": "2px" }}>&#10003;</span>
                    <span>The assistant sends your question and what its tools read (containers, logs, configuration). Passwords, tokens and keys in that, such as secret env vars and Kubernetes Secrets, are blanked out first</span>
                  </div>
                  <div style={{ display: "flex", "align-items": "flex-start", gap: "10px" }}>
                    <span style={{ color: "#a371f7", "flex-shrink": "0", "margin-top": "2px" }}>&#10003;</span>
                    <span>Use <strong>Ollama</strong> to keep everything on your machine: nothing leaves it</span>
                  </div>
                </div>
              </div>
            </div>

            <div style={{ "text-align": "center", "font-size": "12px", color: "#484f58", "padding-top": "8px" }}>
              Full details: <HelpLink path="/docs/security/">Security and privacy</HelpLink> · <a href="https://github.com/edvin/orca/blob/main/SECURITY.md" target="_blank" rel="noopener noreferrer" style={{ color: "#58a6ff" }}>Security policy</a>
            </div>
          </div>
        </Show>

        {/* === About Tab === */}
        <Show when={tab() === "about"}>
          <div style={{ display: "flex", "flex-direction": "column", gap: "20px" }}>
            <div class="settings-section">
              <h2 class="settings-section-title">Container runtime</h2>
              <div class="card">
                <Show when={machine()} fallback={
                  <div style={{ padding: "8px 0", color: "#8b949e" }}>
                    {daemonConnected() ? "Loading runtime info..." : "Daemon not connected"}
                  </div>
                }>
                  {(m) => (
                    <div class="card-grid">
                      <span class="card-label">Runtime</span>
                      <span class="card-value">{m().config.runtime}</span>
                      <span class="card-label">Backend</span>
                      <span class="card-value">{m().backend}</span>
                      <span class="card-label">State</span>
                      <span class={`state-badge ${m().state === "Running" ? "state-running" : "state-stopped"}`}>{m().state}</span>
                      <span class="card-label">Socket path</span>
                      <span class="card-value mono">
                        {m().config.runtime === "Docker" ? "/var/run/docker.sock" : `/run/user/${1000}/podman/podman.sock`}
                      </span>
                      <span class="card-label">CPUs</span>
                      <span class="card-value">{m().config.cpus}</span>
                      <span class="card-label">Memory</span>
                      <span class="card-value">{(m().config.memory_mb / 1024).toFixed(1)} GB</span>
                    </div>
                  )}
                </Show>
              </div>
            </div>

            <div class="settings-section">
              <h2 class="settings-section-title">Paths</h2>
              <div class="card">
                <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
                  <For each={[
                    ["Config File", platformPaths().config],
                    ["Data Directory", platformPaths().data],
                    ["Daemon Log", daemonLogPath() || platformPaths().log],
                  ] as [string, string][]}>{([label, path]) => (
                    <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between" }}>
                      <div>
                        <div style={{ "font-size": "11px", color: "#6e7681" }}>{label}</div>
                        <span class="mono" style={{ "font-size": "12px", color: "#8b949e" }}>{path}</span>
                      </div>
                      <button
                        class="action-icon"
                        style={{ color: "#8b949e", "flex-shrink": "0" }}
                        onClick={() => { navigator.clipboard.writeText(path); showToast("Path copied", "success"); }}
                        title="Copy path"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                      </button>
                    </div>
                  )}</For>
                </div>
              </div>
            </div>

            <div class="settings-section">
              <h2 class="settings-section-title">Cleanup</h2>
              <div class="card">
                <p style={{ "font-size": "13px", color: "#8b949e", "margin-bottom": "16px", "line-height": "1.5" }}>
                  Remove Orca Desktop data from your system. This is useful before uninstalling or to start fresh.
                </p>
                <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
                  <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", padding: "8px 0", "border-bottom": "1px solid #21262d" }}>
                    <div>
                      <div style={{ "font-size": "13px", "font-weight": "500" }}>Remove user templates</div>
                      <div style={{ "font-size": "12px", color: "#8b949e" }}>Delete custom templates you've created</div>
                    </div>
                    <button class="btn btn-sm" onClick={async () => {
                      if (!await confirmDanger("Remove templates", "Remove all user-created templates?")) return;
                      try {
                        await invoke("cleanup", { scope: "templates" });
                        showToast("User templates removed", "success");
                      } catch (e) { logError(`Failed to remove templates: ${e}`); showToast(`Failed: ${e}`, "error"); }
                    }} title="Remove user templates" style={{ color: "#f85149" }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>
                  </div>
                  <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", padding: "8px 0", "border-bottom": "1px solid #21262d" }}>
                    <div>
                      <div style={{ "font-size": "13px", "font-weight": "500" }}>Stop & remove VMs</div>
                      <div style={{ "font-size": "12px", color: "#8b949e" }}>Stop Lima VMs (macOS) or remove Docker TCP config (Windows)</div>
                    </div>
                    <button class="btn btn-sm" onClick={async () => {
                      if (!await confirmDanger("Stop & remove VMs", "Stop and remove all Orca Desktop-managed VMs and runtime config?")) return;
                      try {
                        const result = (await invoke("cleanup", { scope: "vms" })) as { log: string[] };
                        showToast(result.log.join(". ") || "Cleanup done", "success");
                      } catch (e) { logError(`Failed to stop & remove VMs: ${e}`); showToast(`Failed: ${e}`, "error"); }
                    }} title="Remove VMs" style={{ color: "#f85149" }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>
                  </div>
                  <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", padding: "8px 0" }}>
                    <div>
                      <div style={{ "font-size": "13px", "font-weight": "500", color: "#f85149" }}>Reset everything</div>
                      <div style={{ "font-size": "12px", color: "#8b949e" }}>Remove all config, templates, VMs, and data — like a fresh install</div>
                    </div>
                    <button class="btn btn-sm" style={{ color: "#f85149", "border-color": "#da363380" }} onClick={async () => {
                      if (!await confirmDanger("Reset everything", "This will remove ALL Orca Desktop data including config, API keys, templates, and VMs.\n\nThis cannot be undone. Continue?")) return;
                      try {
                        await invoke("cleanup", { scope: "all" });
                        showToast("Orca Desktop has been fully reset. Restart the app.", "success");
                      } catch (e) { logError(`Failed to reset everything: ${e}`); showToast(`Failed: ${e}`, "error"); }
                    }}>Reset all</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </Show>

      </div>
    </div>
  );
}
