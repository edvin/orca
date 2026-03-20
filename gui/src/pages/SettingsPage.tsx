import { createSignal, onMount, Show, For } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { MachineInfo, RegistryCredential } from "../lib/types";
import { showToast } from "../components/Toast";

type SettingsTab = "general" | "ai" | "registries" | "about";

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

  // General settings
  const [startOnLogin, setStartOnLogin] = createSignal(false);
  const [showTrayIcon, setShowTrayIcon] = createSignal(true);
  const [telemetry, setTelemetry] = createSignal(false);

  // AI settings
  type AiProviderType = "anthropic" | "openai" | "gemini" | "custom";
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
      console.error("Failed to list registries:", e);
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
      showToast(`Failed to add registry: ${e}`, "error");
    }
  };

  const removeReg = async (server: string) => {
    if (!window.confirm(`Remove registry '${server}'?`)) return;
    try {
      await invoke("remove_registry", { server });
      showToast("Registry removed", "success");
      await refreshRegistries();
    } catch (e) {
      showToast(`Failed to remove registry: ${e}`, "error");
    }
  };

  const applyPreset = (preset: typeof REGISTRY_PRESETS[number]) => {
    setRegServer(preset.server);
    setRegName(preset.name);
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
      console.error("Failed to load general settings:", e);
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
      setAiProvider(settings.provider as AiProviderType);
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
      console.error("Failed to load AI settings:", e);
    }
  };

  const loadModels = async () => {
    setLoadingModels(true);
    try {
      const result = (await invoke("list_ai_models")) as { models: string[] };
      setAvailableModels(result.models || []);
    } catch {
      setAvailableModels([]);
    } finally {
      setLoadingModels(false);
    }
  };

  const saveAiSettings = async () => {
    setAiSaving(true);
    try {
      await invoke("save_ai_settings", {
        provider: aiProvider(),
        apiKey: aiApiKey(),
        model: aiModel(),
        url: aiUrl() || null,
      });
      showToast("AI settings saved", "success");
      await refreshAiSettings();
    } catch (e) {
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
      showToast(`AI test failed: ${e}`, "error");
    } finally {
      setAiTesting(false);
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

  onMount(() => {
    refresh();
    refreshRegistries();
    refreshGeneralSettings();
    refreshAiSettings();
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
                        ["custom", "Custom"],
                      ] as [AiProviderType, string][]).map(([id, label]) => (
                        <button
                          class={`btn btn-sm ${aiProvider() === id ? "btn-primary" : ""}`}
                          onClick={() => {
                            setAiProvider(id);
                            setAiApiKey("");
                            setAiTestResult(null);
                            if (id === "anthropic") setAiModel("claude-sonnet-4-20250514");
                            else if (id === "openai") setAiModel("gpt-4o");
                            else if (id === "gemini") setAiModel("gemini-2.0-flash");
                            else setAiModel("");
                          }}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

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
                        <span style={{ color: "#3fb950", "font-size": "11px", "margin-left": "8px" }}>(configured)</span>
                      </Show>
                    </label>
                    <input
                      class="form-input"
                      type="password"
                      placeholder={
                        (aiProvider() === "anthropic" && hasAnthropicKey()) ||
                        (aiProvider() !== "anthropic" && hasOpenaiKey())
                          ? "Key is set — enter a new key to replace"
                          : "Enter your API key"
                      }
                      value={aiApiKey()}
                      onInput={(e) => setAiApiKey(e.currentTarget.value)}
                    />
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
                      <input
                        class="form-input"
                        type="text"
                        placeholder={
                          aiProvider() === "anthropic" ? "claude-sonnet-4-20250514"
                            : aiProvider() === "gemini" ? "gemini-2.0-flash"
                            : aiProvider() === "openai" ? "gpt-4o"
                            : "model-name"
                        }
                        value={aiModel()}
                        onInput={(e) => setAiModel(e.currentTarget.value)}
                      />
                    }>
                      <select
                        class="form-input"
                        value={aiModel()}
                        onChange={(e) => setAiModel(e.currentTarget.value)}
                      >
                        <For each={availableModels()}>
                          {(model) => <option value={model}>{model}</option>}
                        </For>
                      </select>
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
                    <pre style={{
                      background: "#161b22", border: "1px solid #21262d", "border-radius": "6px",
                      padding: "12px", "font-size": "12px", "line-height": "1.5",
                      overflow: "auto", color: "#e6edf3", margin: 0,
                    }}>
                      {mcpConfig()}
                    </pre>
                    <button class="btn btn-sm" style={{ "margin-top": "8px" }} onClick={() => copyToClipboard(mcpConfig(), setMcpCopied)}>
                      {mcpCopied() ? "Copied!" : "Copy Config"}
                    </button>
                  </div>

                  <div style={{ "border-top": "1px solid #21262d", "padding-top": "16px" }}>
                    <div style={{ "font-size": "13px", "font-weight": 600, color: "#e6edf3", "margin-bottom": "6px" }}>
                      OpenAI-Compatible Endpoint
                    </div>
                    <p style={{ "font-size": "12px", color: "#8b949e", margin: "0 0 8px 0", "line-height": "1.5" }}>
                      Use this endpoint with any OpenAI-compatible agent or tool.
                    </p>
                    <div class="card-grid" style={{ "font-size": "12px" }}>
                      <span class="card-label">Endpoint</span>
                      <span class="card-value mono" style={{ "font-size": "11px", "word-break": "break-all" }}>{openaiEndpoint}</span>
                      <span class="card-label">Auth</span>
                      <span class="card-value mono" style={{ "font-size": "11px" }}>Bearer {apiToken() || "YOUR_TOKEN_HERE"}</span>
                    </div>
                    <div style={{ display: "flex", gap: "8px", "margin-top": "8px" }}>
                      <button class="btn btn-sm" onClick={() => copyToClipboard(openaiEndpoint, setEndpointCopied)}>
                        {endpointCopied() ? "Copied!" : "Copy Endpoint"}
                      </button>
                      <button class="btn btn-sm" onClick={() => copyToClipboard(apiToken(), setTokenCopied)}>
                        {tokenCopied() ? "Copied!" : "Copy Token"}
                      </button>
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
                            <button class="btn btn-sm btn-danger" onClick={() => removeReg(reg.server)}>Delete</button>
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
              <h2 class="settings-section-title">Configuration</h2>
              <div class="card">
                <div class="card-grid">
                  <span class="card-label">Config File</span>
                  <span class="card-value mono">~/.config/orca/config.json</span>
                  <span class="card-label">Data Directory</span>
                  <span class="card-value mono">~/.local/share/orca/</span>
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
                      if (!window.confirm("Remove all user-created templates?")) return;
                      try {
                        await invoke("cleanup", { scope: "templates" });
                        showToast("User templates removed", "success");
                      } catch (e) { showToast(`Failed: ${e}`, "error"); }
                    }}>Remove</button>
                  </div>
                  <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", padding: "8px 0", "border-bottom": "1px solid #21262d" }}>
                    <div>
                      <div style={{ "font-size": "13px", "font-weight": "500" }}>Stop & Remove VMs</div>
                      <div style={{ "font-size": "12px", color: "#8b949e" }}>Stop Lima VMs (macOS) or remove Docker TCP config (Windows)</div>
                    </div>
                    <button class="btn btn-sm" onClick={async () => {
                      if (!window.confirm("Stop and remove all Orca Desktop-managed VMs and runtime config?")) return;
                      try {
                        const result = (await invoke("cleanup", { scope: "vms" })) as { log: string[] };
                        showToast(result.log.join(". ") || "Cleanup done", "success");
                      } catch (e) { showToast(`Failed: ${e}`, "error"); }
                    }}>Remove</button>
                  </div>
                  <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", padding: "8px 0" }}>
                    <div>
                      <div style={{ "font-size": "13px", "font-weight": "500", color: "#f85149" }}>Reset Everything</div>
                      <div style={{ "font-size": "12px", color: "#8b949e" }}>Remove all config, templates, VMs, and data — like a fresh install</div>
                    </div>
                    <button class="btn btn-sm" style={{ color: "#f85149", "border-color": "#da363380" }} onClick={async () => {
                      if (!window.confirm("This will remove ALL Orca Desktop data including config, API keys, templates, and VMs.\n\nThis cannot be undone. Continue?")) return;
                      try {
                        const result = (await invoke("cleanup", { scope: "all" })) as { log: string[] };
                        showToast("Orca Desktop has been fully reset. Restart the app.", "success");
                      } catch (e) { showToast(`Failed: ${e}`, "error"); }
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
