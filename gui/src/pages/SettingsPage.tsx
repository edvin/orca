import { createSignal, onMount, Show, For } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { MachineInfo, RegistryCredential, RemoteHost } from "../lib/types";
import { showToast } from "../components/Toast";
import { confirmDanger, confirm as confirmDialog } from "../components/ConfirmDialog";
import { logError } from "../lib/activityStore";
import { getOllamaSetupState, getOllamaSetupStatus, isOllamaSetupRunning, updateOllamaSetup } from "../lib/ollamaSetup";
import Spinner from "../components/Spinner";
import Dropdown from "../components/Dropdown";

type SettingsTab = "general" | "ai" | "registries" | "remote-hosts" | "auto-deploy" | "maintenance" | "about";

export default function SettingsPage() {
  const [tab, setTab] = createSignal<SettingsTab>("general");
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
  const [ruleSecret, setRuleSecret] = createSignal("");
  const [webhookSecret, setWebhookSecret] = createSignal("");
  const [webhookUrl, setWebhookUrl] = createSignal("");
  const [webhookUrlCopied, setWebhookUrlCopied] = createSignal(false);
  const [testingWebhook, setTestingWebhook] = createSignal(false);

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

  // AI settings
  type AiProviderType = "anthropic" | "openai" | "gemini" | "ollama" | "custom";
  const [aiProvider, setAiProvider] = createSignal<AiProviderType>("anthropic");
  const [aiApiKey, setAiApiKey] = createSignal("");
  const [aiModel, setAiModel] = createSignal("");
  const [aiUrl, setAiUrl] = createSignal("");
  const [aiSaving, setAiSaving] = createSignal(false);
  const [aiTesting, setAiTesting] = createSignal(false);
  const [aiTestResult, setAiTestResult] = createSignal<string | null>(null);
  const [hasAnthropicKey, setHasAnthropicKey] = createSignal(false);
  const [hasOpenaiKey, setHasOpenaiKey] = createSignal(false);
  const [availableModels, setAvailableModels] = createSignal<string[]>([]);
  const [loadingModels, setLoadingModels] = createSignal(false);
  const [apiToken, setApiToken] = createSignal("");
  const [daemonLog, setDaemonLog] = createSignal("");
  const [daemonLogPath, setDaemonLogPath] = createSignal("");

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
  const [limaOrigCpus, setLimaOrigCpus] = createSignal(4);
  const [limaOrigMemoryGib, setLimaOrigMemoryGib] = createSignal(4);
  const [limaOrigDiskGib, setLimaOrigDiskGib] = createSignal(60);
  const [limaSaving, setLimaSaving] = createSignal(false);

  const [mcpCopied, setMcpCopied] = createSignal(false);
  const [endpointCopied, setEndpointCopied] = createSignal(false);
  const [tokenCopied, setTokenCopied] = createSignal(false);

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
    } catch (e) {
      setDaemonConnected(false);
      setError(null);
    }
  };

  const refreshRegistries = async () => {
    try {
      const result = (await invoke("list_registries")) as RegistryCredential[];
      setRegistries(result);
    } catch (e) {
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
    if (!await confirmDanger("Remove Registry", `Remove registry '${server}'?`)) return;
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
    if (!await confirmDanger("Remove Host", `Remove remote host '${host.name}'?`)) return;
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
      };
      setStartOnLogin(settings.start_on_login);
      setShowTrayIcon(settings.show_tray_icon);
      setTelemetry(settings.telemetry);
      setDaemonConnected(true);
    } catch (e) {
    }
  };

  const saveGeneralSetting = async (
    field: "start_on_login" | "show_tray_icon" | "telemetry",
    value: boolean,
  ) => {
    const prev = { start_on_login: startOnLogin(), show_tray_icon: showTrayIcon(), telemetry: telemetry() };
    if (field === "start_on_login") setStartOnLogin(value);
    else if (field === "show_tray_icon") setShowTrayIcon(value);
    else if (field === "telemetry") setTelemetry(value);

    try {
      await invoke("save_general_settings", {
        startOnLogin: field === "start_on_login" ? value : startOnLogin(),
        showTrayIcon: field === "show_tray_icon" ? value : showTrayIcon(),
        telemetry: field === "telemetry" ? value : telemetry(),
      });
      showToast("Settings saved", "success");
    } catch (e) {
      setStartOnLogin(prev.start_on_login);
      setShowTrayIcon(prev.show_tray_icon);
      setTelemetry(prev.telemetry);
      logError(`Failed to save general settings: ${e}`, `Field "${field}"`);
      showToast(`Failed to save settings: ${e}`, "error");
    }
  };

  const refreshAiSettings = async () => {
    try {
      const settings = (await invoke("get_ai_settings")) as {
        provider: string;
        has_anthropic_key: boolean;
        has_openai_key: boolean;
        anthropic_model: string;
        openai_model: string;
        openai_url: string;
        api_token: string;
      };
      // Detect Ollama: custom provider with 11434 URL
      const isOllama = settings.provider === "custom" && (settings.openai_url || "").includes("11434");
      setAiProvider(isOllama ? "ollama" : settings.provider as AiProviderType);
      setHasAnthropicKey(settings.has_anthropic_key);
      setHasOpenaiKey(settings.has_openai_key);
      setAiModel(
        settings.provider === "anthropic" ? settings.anthropic_model : settings.openai_model
      );
      setAiUrl(settings.openai_url || "");
      setApiToken(settings.api_token);
      setAiApiKey("");
      // Load available models
      loadModels();
    } catch (e) {
    }
  };

  const loadModels = async () => {
    setLoadingModels(true);
    try {
      const result = (await invoke("list_ai_models")) as { models: string[] };
      // Strip "models/" prefix that some providers add (e.g. Gemini)
      const cleaned = (result.models || []).map(m => m.replace(/^models\//, ""));
      setAvailableModels(cleaned);
    } catch {
      setAvailableModels([]);
    } finally {
      setLoadingModels(false);
    }
  };

  const saveAiSettings = async () => {
    setAiSaving(true);
    try {
      // "ollama" is stored as "custom" with the Ollama URL
      const provider = aiProvider() === "ollama" ? "custom" : aiProvider();
      await invoke("save_ai_settings", {
        provider,
        apiKey: aiApiKey(),
        model: aiModel(),
        url: aiUrl() || null,
      });
      showToast("AI settings saved", "success");
      await refreshAiSettings();
    } catch (e) {
      logError(`Failed to save AI settings: ${e}`, `Provider "${aiProvider()}", model "${aiModel()}"`);
      showToast(`Failed to save AI settings: ${e}`, "error");
    } finally {
      setAiSaving(false);
    }
  };

  const testAi = async () => {
    setAiTesting(true);
    setAiTestResult(null);
    try {
      const result = (await invoke("ai_ask", {
        query: "Say 'AI connection successful!' in exactly those words.",
        context: null,
      })) as { answer: string };
      setAiTestResult("success");
      showToast("AI connection test passed", "success");
    } catch (e) {
      setAiTestResult("error");
      logError(`Failed AI connection test: ${e}`, `Provider "${aiProvider()}", model "${aiModel()}"`);
      showToast(`AI test failed: ${e}`, "error");
    } finally {
      setAiTesting(false);
    }
  };

  const setupOllama = async () => {
    if (isOllamaSetupRunning()) return; // Prevent double-run
    updateOllamaSetup("running", "Deploying Ollama container...");
    try {
      updateOllamaSetup("running", "Pulling Ollama image (this may take a few minutes)...");
      await invoke("pull_image", { reference: "ollama/ollama:latest" });

      updateOllamaSetup("running", "Creating Ollama container...");
      try {
        await invoke("create_and_run_container", {
          image: "ollama/ollama:latest",
          name: "ollama",
          ports: ["11434:11434"],
          volumes: ["ollama-models:/root/.ollama"],
          restart_policy: "unless-stopped",
          gpu: true,
        });
      } catch (e) {
        const err = String(e);
        if (err.includes("already in use") || err.includes("Conflict")) {
          try { await invoke("start_container", { id: "ollama" }); } catch {}
        } else {
          throw e;
        }
      }

      updateOllamaSetup("running", "Waiting for Ollama to start...");
      let ready = false;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        try {
          const result = await invoke("exec_container", { id: "ollama", command: ["ollama", "list"] }) as { output?: string };
          if (result) { ready = true; break; }
        } catch {}
        updateOllamaSetup("running", `Waiting for Ollama to start... (${(i + 1) * 3}s)`);
      }

      if (!ready) {
        updateOllamaSetup("error", "Ollama started but not responding. Try: docker exec ollama ollama pull qwen2.5:7b");
      }

      if (ready) {
        updateOllamaSetup("running", "Downloading qwen2.5:7b model (~4.7 GB)...");
        const pullPromise = invoke("exec_container", { id: "ollama", command: ["ollama", "pull", "qwen2.5:7b"] }).catch(() => null);

        let modelReady = false;
        const startTime = Date.now();
        for (let i = 0; i < 120; i++) {
          await new Promise((r) => setTimeout(r, 5000));
          const elapsed = Math.floor((Date.now() - startTime) / 1000);
          const mins = Math.floor(elapsed / 60);
          const secs = elapsed % 60;
          updateOllamaSetup("running", `Downloading qwen2.5:7b (~4.7 GB)... ${mins}m ${secs}s`);

          try {
            const listResult = await invoke("exec_container", { id: "ollama", command: ["ollama", "list"] }) as { output?: string };
            if (listResult?.output?.includes("qwen2.5")) { modelReady = true; break; }
          } catch {}
        }

        if (!modelReady) {
          await pullPromise;
          try {
            const check = await invoke("exec_container", { id: "ollama", command: ["ollama", "list"] }) as { output?: string };
            modelReady = check?.output?.includes("qwen2.5") || false;
          } catch {}
        }

        if (!modelReady) {
          updateOllamaSetup("error", "Model may still be downloading. Try: docker exec ollama ollama pull qwen2.5:7b");
        }
      }

      // Configure AI settings regardless (container is running)
      setAiProvider("ollama");
      setAiUrl("http://localhost:11434/v1");
      setAiModel("qwen2.5:7b");
      setAiApiKey("ollama");
      await saveAiSettings();

      updateOllamaSetup("done", "Ollama is ready! AI assistant is using your local model.");
      showToast("Ollama set up successfully", "success");
    } catch (e) {
      updateOllamaSetup("error", `Setup failed: ${e}`);
      showToast(`Ollama setup failed: ${e}`, "error");
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

  const mcpConfig = () =>
    JSON.stringify(
      {
        mcpServers: {
          orca: {
            url: "http://127.0.0.1:9477/api/v1/agent/mcp",
            headers: {
              Authorization: `Bearer ${apiToken() || "YOUR_TOKEN_HERE"}`,
            },
          },
        },
      },
      null,
      2
    );

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
      };
      setLimaAvailable(settings.available);
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
    } catch (_e) {
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
    } catch (_e) {
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
    invoke("get_webhook_url").then((u) => setWebhookUrl(u as string)).catch(() => {});
    refreshGeneralSettings();
    refreshAiSettings();
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
      <div class="tab-bar" style="margin-bottom: 24px">
        <button class={`tab-item ${tab() === "general" ? "active" : ""}`} onClick={() => setTab("general")}>General</button>
        <button class={`tab-item ${tab() === "ai" ? "active" : ""}`} onClick={() => setTab("ai")}>AI & Agents</button>
        <button class={`tab-item ${tab() === "registries" ? "active" : ""}`} onClick={() => setTab("registries")}>Registries</button>
        <button class={`tab-item ${tab() === "remote-hosts" ? "active" : ""}`} onClick={() => setTab("remote-hosts")}>Remote Hosts</button>
        <button class={`tab-item ${tab() === "auto-deploy" ? "active" : ""}`} onClick={() => setTab("auto-deploy")}>Auto-Deploy</button>
        <button class={`tab-item ${tab() === "maintenance" ? "active" : ""}`} onClick={() => setTab("maintenance")}>Maintenance</button>
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
                    <span class="settings-label">Show Tray Icon</span>
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
              </div>
            </div>

            {/* WSL2 Resources — Windows only */}
            <Show when={isWindows}>
              <div class="settings-section">
                <h2 class="settings-section-title">WSL2 Resources</h2>
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
                <h2 class="settings-section-title">Virtual Machine</h2>
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
                        max="64"
                        step="1"
                        value={limaMemoryGib()}
                        onInput={(e) => setLimaMemoryGib(parseInt(e.currentTarget.value) || 2)}
                        style={{ flex: "1" }}
                        disabled={limaSaving()}
                      />
                      <span style={{ "font-size": "13px", color: "#8b949e" }}>GB</span>
                    </div>
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
                      {limaSaving() ? "Restarting VM..." : "Apply Changes"}
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
            {/* AI Assistant */}
            <div class="settings-section">
              <h2 class="settings-section-title">AI Assistant</h2>
              <div class="card">
                <div style={{ display: "flex", "flex-direction": "column", gap: "12px" }}>
                  <div class="form-group">
                    <label class="form-label">Provider</label>
                    <div style={{ display: "flex", gap: "8px", "margin-top": "4px", "flex-wrap": "wrap" }}>
                      {([
                        ["anthropic", "Anthropic (Claude)"],
                        ["openai", "OpenAI (GPT)"],
                        ["gemini", "Google (Gemini)"],
                        ["ollama", "Ollama (Local)"],
                        ["custom", "Custom"],
                      ] as [AiProviderType, string][]).map(([id, label]) => (
                        <button
                          class={`btn btn-sm ${aiProvider() === id ? "btn-primary" : ""}`}
                          onClick={() => {
                            setAiProvider(id === "ollama" ? "custom" as AiProviderType : id);
                            setAiApiKey("");
                            setAiTestResult(null);
                            if (id === "anthropic") setAiModel("claude-sonnet-4-20250514");
                            else if (id === "openai") setAiModel("gpt-4o");
                            else if (id === "gemini") setAiModel("gemini-2.0-flash");
                            else if (id === "ollama") {
                              setAiModel("qwen2.5:7b");
                              setAiUrl("http://localhost:11434/v1");
                              setAiApiKey("ollama");
                              updateOllamaSetup("idle", "");
                            }
                            else setAiModel("");
                          }}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Ollama one-click setup */}
                  <Show when={aiProvider() === "ollama" || (aiProvider() === "custom" && aiUrl().includes("11434"))}>
                    <div style={{
                      background: "linear-gradient(135deg, rgba(88, 166, 255, 0.06) 0%, rgba(139, 92, 246, 0.06) 100%)",
                      border: "1px solid rgba(88, 166, 255, 0.15)",
                      "border-radius": "10px",
                      padding: "16px 18px",
                    }}>
                      <div style={{ display: "flex", "align-items": "center", gap: "10px", "margin-bottom": "8px" }}>
                        <span style={{ "font-size": "20px" }}>{"\u{1F9E0}"}</span>
                        <div>
                          <div style={{ "font-weight": "600", "font-size": "14px" }}>Run AI Locally with Ollama</div>
                          <div style={{ "font-size": "12px", color: "#8b949e" }}>No API keys, no cloud, no costs — runs on your machine</div>
                        </div>
                      </div>
                      <Show when={getOllamaSetupStatus()}>
                        <div style={{ "font-size": "12px", color: getOllamaSetupState() === "done" ? "#3fb950" : "#8b949e", "margin": "10px 0", display: "flex", "align-items": "center", gap: "6px" }}>
                          <Show when={isOllamaSetupRunning()}><Spinner size={12} /></Show>
                          <Show when={getOllamaSetupState() === "done"}><span style={{ color: "#3fb950" }}>{"\u2713"}</span></Show>
                          {getOllamaSetupStatus()}
                        </div>
                      </Show>
                      <button
                        class="btn btn-primary btn-sm"
                        onClick={setupOllama}
                        disabled={isOllamaSetupRunning()}
                        style={{ "margin-top": "6px" }}
                      >
                        {isOllamaSetupRunning() ? "Setting up..." : getOllamaSetupState() === "done" ? "Set up again" : "Set up Ollama"}
                      </button>
                      <div style={{ "font-size": "11px", color: "#6e7681", "margin-top": "8px" }}>
                        Deploys Ollama container and pulls qwen2.5:7b model (~4.7GB download, ~8GB RAM to run). Works on CPU — GPU optional but faster.
                      </div>
                    </div>
                  </Show>

                  {/* Custom URL field */}
                  <Show when={aiProvider() === "custom"}>
                    <div class="form-group">
                      <label class="form-label">API Base URL</label>
                      <input
                        class="form-input mono"
                        type="text"
                        placeholder="https://api.example.com/v1"
                        value={aiUrl()}
                        onInput={(e) => setAiUrl(e.currentTarget.value)}
                      />
                      <span class="form-hint">OpenAI-compatible endpoint (must support /chat/completions)</span>
                    </div>
                  </Show>

                  <div class="form-group">
                    <label class="form-label">
                      API Key
                      <Show when={
                        (aiProvider() === "anthropic" && hasAnthropicKey()) ||
                        (aiProvider() !== "anthropic" && hasOpenaiKey())
                      }>
                        <span style={{ color: "#3fb950", "font-size": "11px", "margin-left": "8px" }}>{"\u2713"} configured</span>
                      </Show>
                    </label>
                    <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
                      <input
                        class="form-input"
                        style={{ flex: "1" }}
                        type="password"
                        placeholder={
                          (aiProvider() === "anthropic" && hasAnthropicKey()) ||
                          (aiProvider() !== "anthropic" && hasOpenaiKey())
                            ? "Key is set — enter a new key to replace"
                            : aiProvider() === "anthropic" ? "sk-ant-..." : aiProvider() === "gemini" ? "AIza..." : "sk-..."
                        }
                        value={aiApiKey()}
                        onInput={(e) => setAiApiKey(e.currentTarget.value)}
                      />
                      <a
                        href={
                          aiProvider() === "anthropic" ? "https://console.anthropic.com/settings/keys"
                          : aiProvider() === "openai" ? "https://platform.openai.com/api-keys"
                          : aiProvider() === "gemini" ? "https://aistudio.google.com/apikey"
                          : ""
                        }
                        target="_blank"
                        class="btn btn-sm"
                        style={{
                          "text-decoration": "none",
                          "white-space": "nowrap",
                          display: aiProvider() === "custom" ? "none" : "inline-flex",
                          gap: "4px",
                          "align-items": "center",
                        }}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                        Get Key
                      </a>
                    </div>
                    <span class="form-hint">
                      {aiProvider() === "anthropic" ? "Create a key at console.anthropic.com — pay-per-token pricing"
                        : aiProvider() === "openai" ? "Create a key at platform.openai.com"
                        : aiProvider() === "gemini" ? "Create a key at aistudio.google.com"
                        : "Enter the API key for your custom endpoint"}
                    </span>
                  </div>

                  <div class="form-group">
                    <label class="form-label">
                      Model
                      <Show when={loadingModels()}>
                        <span style={{ color: "#8b949e", "font-size": "11px", "margin-left": "8px" }}>loading...</span>
                      </Show>
                      <Show when={!loadingModels() && availableModels().length > 0}>
                        <button
                          class="btn btn-sm"
                          style={{ "margin-left": "8px", "font-size": "10px", padding: "1px 6px" }}
                          onClick={loadModels}
                        >
                          Refresh
                        </button>
                      </Show>
                    </label>
                    <Show when={availableModels().length > 0} fallback={
                      <div style={{ padding: "8px 0", "font-size": "12px", color: "#6e7681" }}>
                        Save your API key first — available models will load as a dropdown
                      </div>
                    }>
                      <Dropdown
                        value={aiModel()}
                        options={availableModels().map((model) => ({ value: model, label: model }))}
                        onChange={(v) => setAiModel(v)}
                      />
                    </Show>
                  </div>

                  <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
                    <button class="btn btn-primary" onClick={saveAiSettings} disabled={aiSaving()}>
                      {aiSaving() ? "Saving..." : "Save"}
                    </button>
                    <button class="btn" onClick={testAi} disabled={aiTesting()}>
                      {aiTesting() ? "Testing..." : "Test Connection"}
                    </button>
                    <Show when={aiTestResult() === "success"}>
                      <span style={{ color: "#3fb950", "font-size": "12px" }}>Connection OK</span>
                    </Show>
                    <Show when={aiTestResult() === "error"}>
                      <span style={{ color: "#f85149", "font-size": "12px" }}>Test failed</span>
                    </Show>
                  </div>
                </div>
              </div>
              <p class="settings-note">
                API keys are stored locally and never shared. Used only for the built-in AI chat.
              </p>
            </div>

            {/* Agent Integration */}
            <div class="settings-section">
              <h2 class="settings-section-title">Agent Integration</h2>
              <div class="card">
                <div style={{ display: "flex", "flex-direction": "column", gap: "16px" }}>
                  <div>
                    <div style={{ "font-size": "13px", "font-weight": 600, color: "#e6edf3", "margin-bottom": "6px" }}>
                      MCP Server Config
                    </div>
                    <p style={{ "font-size": "12px", color: "#8b949e", margin: "0 0 8px 0", "line-height": "1.5" }}>
                      Add this to your Claude Code or Claude Desktop MCP configuration.
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
                        onClick={() => copyToClipboard(mcpConfig(), setMcpCopied)}
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
                          <div style={{ "font-size": "10px", color: "#6e7681", "text-transform": "uppercase", "letter-spacing": "0.5px", "margin-bottom": "2px" }}>API Token</div>
                          <span class="mono" style={{ "font-size": "11px", color: "#e6edf3" }}>{apiToken() || "Loading..."}</span>
                        </div>
                        <button
                          class="action-icon"
                          style={{ color: tokenCopied() ? "#3fb950" : "#8b949e", "flex-shrink": "0" }}
                          onClick={() => copyToClipboard(apiToken(), setTokenCopied)}
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
        </Show>

        {/* === Registries Tab === */}
        <Show when={tab() === "registries"}>
          <div class="settings-section">
            <h2 class="settings-section-title">Container Registries</h2>
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
                  <button class="btn btn-primary" onClick={() => setShowAddRegistry(true)}>Add Registry</button>
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
                      <label class="form-label">Display Name</label>
                      <input class="form-input" type="text" placeholder="GitHub Container Registry" value={regName()} onInput={(e) => setRegName(e.currentTarget.value)} />
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
            <h2 class="settings-section-title">Remote Hosts</h2>
            <p style={{ "font-size": "13px", color: "#8b949e", "margin-bottom": "16px", "line-height": "1.5" }}>
              Connect to remote servers running the orca-daemon. Switch between hosts from the titlebar dropdown.
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
                <button class="btn btn-primary" onClick={() => { resetHostForm(); setShowAddHost(true); }}>Add Host</button>
              </Show>
            </div>
            <div class="card">

              <Show when={showAddHost()}>
                <div style={{ "margin-top": "12px", "border-top": "1px solid #21262d", "padding-top": "12px" }}>
                  <h3 style={{ "font-size": "14px", "font-weight": 600, "margin-bottom": "12px", color: "#e6edf3" }}>
                    {editingHost() ? `Edit "${editingHost()!.name}"` : "Add Remote Host"}
                  </h3>
                  <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
                    <div class="form-group">
                      <label class="form-label">Display Name</label>
                      <input class="form-input" type="text" placeholder="Production Server" value={hostName()} onInput={(e) => setHostName(e.currentTarget.value)} />
                    </div>
                    <div class="form-group">
                      <label class="form-label">Daemon URL</label>
                      <input class="form-input" type="text" placeholder="https://prod.example.com:9477" value={hostUrl()} onInput={(e) => setHostUrl(e.currentTarget.value)} />
                    </div>
                    <div class="form-group">
                      <label class="form-label">API Token {editingHost() ? "(leave blank to keep current)" : ""}</label>
                      <div style={{ display: "flex", gap: "4px" }}>
                        <input class="form-input" type={showHostToken() ? "text" : "password"} placeholder="Bearer token" value={hostToken()} onInput={(e) => setHostToken(e.currentTarget.value)} style={{ flex: "1" }} />
                        <button class="btn btn-sm" onClick={() => setShowHostToken(!showHostToken())} style={{ "flex-shrink": "0", "white-space": "nowrap" }}>
                          {showHostToken() ? "Hide" : "Show"}
                        </button>
                      </div>
                    </div>
                    <div class="settings-row" style={{ padding: "4px 0" }}>
                      <div class="settings-row-left">
                        <span class="settings-label" style={{ "font-size": "13px" }}>Verify TLS Certificate</span>
                        <span class="settings-description">Disable for self-signed certificates</span>
                      </div>
                      <label class="toggle">
                        <input type="checkbox" checked={hostTlsVerify()} onChange={(e) => setHostTlsVerify(e.currentTarget.checked)} />
                        <span class="toggle-slider" />
                      </label>
                    </div>
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
                        {hostTesting() ? "Testing..." : "Test Connection"}
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
            <h2 class="settings-section-title">Auto-Deploy</h2>
            <p style={{ "font-size": "13px", color: "#8b949e", "margin-bottom": "16px", "line-height": "1.5" }}>
              Push code to GitHub and your containers update automatically. Orca receives a webhook when a new image is pushed, pulls it, and redeploys matching containers with the same configuration.
            </p>

            {/* Setup guide */}
            <Show when={deployRules().length === 0}>
              <div style={{ background: "#161b22", border: "1px solid #30363d", "border-radius": "10px", padding: "20px 24px", "margin-bottom": "20px" }}>
                <div style={{ "font-size": "14px", "font-weight": 600, color: "#e6edf3", "margin-bottom": "16px" }}>Quick setup</div>
                <div style={{ display: "flex", "flex-direction": "column", gap: "14px" }}>
                  <div style={{ display: "flex", gap: "12px", "align-items": "flex-start" }}>
                    <span style={{ background: "#58a6ff", color: "#fff", width: "22px", height: "22px", "border-radius": "50%", display: "flex", "align-items": "center", "justify-content": "center", "font-size": "12px", "font-weight": 600, "flex-shrink": 0 }}>1</span>
                    <div>
                      <div style={{ "font-size": "13px", color: "#e6edf3", "font-weight": 500 }}>Create a deploy rule below</div>
                      <div style={{ "font-size": "12px", color: "#8b949e" }}>Set the image pattern (e.g., <code style={{ color: "#58a6ff" }}>ghcr.io/myorg/myapp</code>) and tag filter (e.g., <code style={{ color: "#58a6ff" }}>v*</code> for version tags)</div>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: "12px", "align-items": "flex-start" }}>
                    <span style={{ background: "#58a6ff", color: "#fff", width: "22px", height: "22px", "border-radius": "50%", display: "flex", "align-items": "center", "justify-content": "center", "font-size": "12px", "font-weight": 600, "flex-shrink": 0 }}>2</span>
                    <div>
                      <div style={{ "font-size": "13px", color: "#e6edf3", "font-weight": 500 }}>Add a webhook in your GitHub repo</div>
                      <div style={{ "font-size": "12px", color: "#8b949e" }}>
                        Go to your repo's Settings &rarr; Webhooks &rarr; Add webhook. Set the payload URL to your daemon's webhook endpoint, content type to <code style={{ color: "#58a6ff" }}>application/json</code>, and select the <strong>Packages</strong> event.
                      </div>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: "12px", "align-items": "flex-start" }}>
                    <span style={{ background: "#3fb950", color: "#fff", width: "22px", height: "22px", "border-radius": "50%", display: "flex", "align-items": "center", "justify-content": "center", "font-size": "12px", "font-weight": 600, "flex-shrink": 0 }}>3</span>
                    <div>
                      <div style={{ "font-size": "13px", color: "#e6edf3", "font-weight": 500 }}>Push and watch</div>
                      <div style={{ "font-size": "12px", color: "#8b949e" }}>When GitHub Actions builds and pushes your image, Orca automatically pulls it and redeploys the matching container. Check the deploy history below for results.</div>
                    </div>
                  </div>
                </div>
              </div>
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
                Event: <strong style={{ color: "#8b949e" }}>Packages</strong> &middot; Content type: <strong style={{ color: "#8b949e" }}>application/json</strong> &middot; For Docker Hub use <code style={{ color: "#6e7681" }}>/webhooks/dockerhub</code>
              </div>
            </div>

            {/* Webhook secret */}
            <div style={{ background: "#0d1117", "border-radius": "8px", padding: "14px 16px", "margin-bottom": "16px" }}>
              <div class="form-group" style={{ margin: 0 }}>
                <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", "margin-bottom": "6px" }}>
                  <label class="form-label" style={{ margin: 0 }}>Webhook Secret</label>
                  <button class="btn btn-sm" style={{ "font-size": "11px", padding: "2px 8px" }}
                    onClick={async () => {
                      try {
                        await invoke("save_webhook_secret", { secret: webhookSecret().trim() || null });
                        showToast(webhookSecret().trim() ? "Webhook secret saved" : "Webhook secret cleared", "success");
                      } catch (e) { showToast(`Failed: ${e}`, "error"); }
                    }}
                  >Save</button>
                </div>
                <input class="form-input mono" type="password" placeholder="Same secret you set in GitHub webhook settings"
                  value={webhookSecret()} onInput={(e) => setWebhookSecret(e.currentTarget.value)}
                  style={{ "font-size": "12px" }}
                />
                <span class="form-hint">GitHub signs webhook payloads with this secret (HMAC-SHA256). Leave empty to accept all webhooks without signature validation.</span>
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
                    <th>Image Pattern</th>
                    <th>Tag Filter</th>
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
                <button class="btn btn-primary" onClick={() => { resetRuleForm(); setShowAddRule(true); }}>Add Rule</button>
              </Show>
            </div>

            <Show when={showAddRule()}>
              <div class="card" style={{ "margin-top": "12px" }}>
                <h3 style={{ "font-size": "14px", "font-weight": 600, "margin-bottom": "12px", color: "#e6edf3" }}>
                  {editingRule() ? `Edit "${editingRule().name}"` : "Add Deploy Rule"}
                </h3>
                <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
                  <div class="form-group">
                    <label class="form-label">Rule Name</label>
                    <input class="form-input" type="text" placeholder="Production API" value={ruleName()} onInput={(e) => setRuleName(e.currentTarget.value)} />
                  </div>
                  <div class="form-group">
                    <label class="form-label">Image Pattern</label>
                    <input class="form-input mono" type="text" placeholder="ghcr.io/myorg/myapp" value={ruleImage()} onInput={(e) => setRuleImage(e.currentTarget.value)} />
                    <span class="form-hint">The full image name without tag, e.g. ghcr.io/myorg/api. Matches any pushed image containing this text.</span>
                  </div>
                  <div class="form-row">
                    <div class="form-group" style={{ flex: 1 }}>
                      <label class="form-label">Tag Filter</label>
                      <input class="form-input mono" type="text" placeholder="latest, v*, main" value={ruleTagFilter()} onInput={(e) => setRuleTagFilter(e.currentTarget.value)} />
                      <span class="form-hint">* = any tag, v* = version tags (v1.0, v2.3.1), latest = only latest, main = branch</span>
                    </div>
                    <div class="form-group" style={{ flex: 1 }}>
                      <label class="form-label">Container Names</label>
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
              <h2 class="settings-section-title">Deploy History</h2>
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

        {/* === Maintenance Tab === */}
        <Show when={tab() === "maintenance"}>
          <div style={{ display: "flex", "flex-direction": "column", gap: "20px" }}>
            <div class="settings-section">
              <h2 class="settings-section-title">System Cleanup</h2>
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
                      <span style={{ "font-size": "13px", "font-weight": "600", color: "#e6edf3" }}>Stopped Containers</span>
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
                      <span style={{ "font-size": "13px", "font-weight": "600", color: "#e6edf3" }}>Dangling Images</span>
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
                      <span style={{ "font-size": "13px", "font-weight": "600", color: "#e6edf3" }}>Unused Networks</span>
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
                      <span style={{ "font-size": "13px", "font-weight": "600", color: "#e6edf3" }}>Build Cache</span>
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
                      <span style={{ "font-size": "13px", "font-weight": "600", color: "#e6edf3" }}>Unused Volumes</span>
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
                    Run Cleanup
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
                  <div style={{ "font-size": "13px", "font-weight": "600", color: "#3fb950", "margin-bottom": "8px" }}>Cleanup Results</div>
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

        {/* === About Tab === */}
        <Show when={tab() === "about"}>
          <div style={{ display: "flex", "flex-direction": "column", gap: "20px" }}>
            <div class="settings-section">
              <h2 class="settings-section-title">Container Runtime</h2>
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
                      <span class="card-label">Socket Path</span>
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
                  {([
                    ["Config File", "~/.config/orca/config.json"],
                    ["Data Directory", "~/.local/share/orca/"],
                    ["Daemon Log", daemonLogPath() || "~/.config/orca/daemon.log"],
                  ] as [string, string][]).map(([label, path]) => (
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
                  ))}
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
                      <div style={{ "font-size": "13px", "font-weight": "500" }}>Remove User Templates</div>
                      <div style={{ "font-size": "12px", color: "#8b949e" }}>Delete custom templates you've created</div>
                    </div>
                    <button class="btn btn-sm" onClick={async () => {
                      if (!await confirmDanger("Remove Templates", "Remove all user-created templates?")) return;
                      try {
                        await invoke("cleanup", { scope: "templates" });
                        showToast("User templates removed", "success");
                      } catch (e) { logError(`Failed to remove templates: ${e}`); showToast(`Failed: ${e}`, "error"); }
                    }} title="Remove user templates" style={{ color: "#f85149" }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>
                  </div>
                  <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", padding: "8px 0", "border-bottom": "1px solid #21262d" }}>
                    <div>
                      <div style={{ "font-size": "13px", "font-weight": "500" }}>Stop & Remove VMs</div>
                      <div style={{ "font-size": "12px", color: "#8b949e" }}>Stop Lima VMs (macOS) or remove Docker TCP config (Windows)</div>
                    </div>
                    <button class="btn btn-sm" onClick={async () => {
                      if (!await confirmDanger("Stop & Remove VMs", "Stop and remove all Orca Desktop-managed VMs and runtime config?")) return;
                      try {
                        const result = (await invoke("cleanup", { scope: "vms" })) as { log: string[] };
                        showToast(result.log.join(". ") || "Cleanup done", "success");
                      } catch (e) { logError(`Failed to stop & remove VMs: ${e}`); showToast(`Failed: ${e}`, "error"); }
                    }} title="Remove VMs" style={{ color: "#f85149" }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>
                  </div>
                  <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", padding: "8px 0" }}>
                    <div>
                      <div style={{ "font-size": "13px", "font-weight": "500", color: "#f85149" }}>Reset Everything</div>
                      <div style={{ "font-size": "12px", color: "#8b949e" }}>Remove all config, templates, VMs, and data — like a fresh install</div>
                    </div>
                    <button class="btn btn-sm" style={{ color: "#f85149", "border-color": "#da363380" }} onClick={async () => {
                      if (!await confirmDanger("Reset Everything", "This will remove ALL Orca Desktop data including config, API keys, templates, and VMs.\n\nThis cannot be undone. Continue?")) return;
                      try {
                        const result = (await invoke("cleanup", { scope: "all" })) as { log: string[] };
                        showToast("Orca Desktop has been fully reset. Restart the app.", "success");
                      } catch (e) { logError(`Failed to reset everything: ${e}`); showToast(`Failed: ${e}`, "error"); }
                    }}>Reset All</button>
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
