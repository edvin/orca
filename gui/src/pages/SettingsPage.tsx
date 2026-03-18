import { createSignal, onMount, Show, For } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { MachineInfo, RegistryCredential } from "../lib/types";
import { showToast } from "../components/Toast";

export default function SettingsPage() {
  const [machine, setMachine] = createSignal<MachineInfo | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [registries, setRegistries] = createSignal<RegistryCredential[]>([]);
  const [showAddRegistry, setShowAddRegistry] = createSignal(false);
  const [regServer, setRegServer] = createSignal("");
  const [regName, setRegName] = createSignal("");
  const [regUsername, setRegUsername] = createSignal("");
  const [regPassword, setRegPassword] = createSignal("");

  // AI settings
  const [aiProvider, setAiProvider] = createSignal<"anthropic" | "openai">("anthropic");
  const [aiApiKey, setAiApiKey] = createSignal("");
  const [aiModel, setAiModel] = createSignal("");
  const [aiSaving, setAiSaving] = createSignal(false);
  const [aiTesting, setAiTesting] = createSignal(false);
  const [aiTestResult, setAiTestResult] = createSignal<string | null>(null);
  const [hasAnthropicKey, setHasAnthropicKey] = createSignal(false);
  const [hasOpenaiKey, setHasOpenaiKey] = createSignal(false);
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
    } catch (e) {
      setError(String(e));
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

  const refreshAiSettings = async () => {
    try {
      const settings = (await invoke("get_ai_settings")) as {
        provider: string;
        has_anthropic_key: boolean;
        has_openai_key: boolean;
        anthropic_model: string;
        openai_model: string;
        api_token: string;
      };
      setAiProvider(settings.provider as "anthropic" | "openai");
      setHasAnthropicKey(settings.has_anthropic_key);
      setHasOpenaiKey(settings.has_openai_key);
      setAiModel(
        settings.provider === "openai" ? settings.openai_model : settings.anthropic_model
      );
      setApiToken(settings.api_token);
      // Clear the key input — we never send stored keys back to the frontend
      setAiApiKey("");
    } catch (e) {
      console.error("Failed to load AI settings:", e);
    }
  };

  const saveAiSettings = async () => {
    setAiSaving(true);
    try {
      await invoke("save_ai_settings", {
        provider: aiProvider(),
        apiKey: aiApiKey(),
        model: aiModel(),
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
      if (result.answer.toLowerCase().includes("successful")) {
        setAiTestResult("success");
        showToast("AI connection test passed", "success");
      } else {
        setAiTestResult("success");
        showToast("AI responded successfully", "success");
      }
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

      <div style={{ "max-width": "640px", display: "flex", "flex-direction": "column", gap: "20px" }}>
        {/* General Section */}
        <div class="settings-section">
          <h2 class="settings-section-title">General</h2>
          <div class="card">
            <div class="settings-row">
              <div class="settings-row-left">
                <span class="settings-label">Start on Login</span>
                <span class="settings-description">Automatically launch Orca when you log in</span>
              </div>
              <div class="settings-toggle disabled">
                <div class="toggle-track">
                  <div class="toggle-thumb" />
                </div>
              </div>
            </div>
            <div class="settings-divider" />
            <div class="settings-row">
              <div class="settings-row-left">
                <span class="settings-label">Show Tray Icon</span>
                <span class="settings-description">Display Orca in the system tray</span>
              </div>
              <div class="settings-toggle disabled">
                <div class="toggle-track toggle-on">
                  <div class="toggle-thumb" />
                </div>
              </div>
            </div>
          </div>
          <p class="settings-note">
            These settings are read-only for now. Edit the config file directly to change them.
          </p>
        </div>

        {/* Runtime Section */}
        <div class="settings-section">
          <h2 class="settings-section-title">Container Runtime</h2>
          <div class="card">
            <Show when={machine()} fallback={
              <div style={{ padding: "8px 0", color: "#8b949e" }}>Loading runtime info...</div>
            }>
              {(m) => (
                <div class="card-grid">
                  <span class="card-label">Runtime</span>
                  <span class="card-value">{m().config.runtime}</span>

                  <span class="card-label">Backend</span>
                  <span class="card-value">{m().backend}</span>

                  <span class="card-label">State</span>
                  <span class={`state-badge ${m().state === "Running" ? "state-running" : "state-stopped"}`}>
                    {m().state}
                  </span>

                  <span class="card-label">Socket Path</span>
                  <span class="card-value mono">
                    {m().config.runtime === "Docker"
                      ? "/var/run/docker.sock"
                      : `/run/user/${1000}/podman/podman.sock`}
                  </span>

                  <span class="card-label">CPUs</span>
                  <span class="card-value">{m().config.cpus}</span>

                  <span class="card-label">Memory</span>
                  <span class="card-value">
                    {(m().config.memory_mb / 1024).toFixed(1)} GB
                  </span>
                </div>
              )}
            </Show>
          </div>
        </div>

        {/* Registries Section */}
        <div class="settings-section">
          <h2 class="settings-section-title">Registries</h2>
          <div class="card">
            <Show when={registries().length > 0} fallback={
              <div style={{ padding: "8px 0", color: "#8b949e" }}>No registries configured.</div>
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
                          <button class="btn btn-sm btn-danger" onClick={() => removeReg(reg.server)}>
                            Delete
                          </button>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>

            <div style={{ "margin-top": "12px" }}>
              <Show when={!showAddRegistry()}>
                <button class="btn btn-primary" onClick={() => setShowAddRegistry(true)}>
                  Add Registry
                </button>
              </Show>
            </div>

            <Show when={showAddRegistry()}>
              <div style={{ "margin-top": "12px", "border-top": "1px solid #21262d", "padding-top": "12px" }}>
                <div style={{ "margin-bottom": "8px", "font-size": "12px", color: "#8b949e" }}>
                  Presets:{" "}
                  <For each={REGISTRY_PRESETS}>
                    {(preset, i) => (
                      <>
                        <button
                          class="btn btn-sm"
                          style={{ padding: "2px 8px", "font-size": "11px" }}
                          onClick={() => applyPreset(preset)}
                        >
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
                    <input
                      class="form-input"
                      type="text"
                      placeholder="https://ghcr.io"
                      value={regServer()}
                      onInput={(e) => setRegServer(e.currentTarget.value)}
                    />
                  </div>
                  <div class="form-group">
                    <label class="form-label">Display Name</label>
                    <input
                      class="form-input"
                      type="text"
                      placeholder="GitHub Container Registry"
                      value={regName()}
                      onInput={(e) => setRegName(e.currentTarget.value)}
                    />
                  </div>
                  <div class="form-row">
                    <div class="form-group" style={{ flex: 1 }}>
                      <label class="form-label">Username</label>
                      <input
                        class="form-input"
                        type="text"
                        placeholder="username"
                        value={regUsername()}
                        onInput={(e) => setRegUsername(e.currentTarget.value)}
                      />
                    </div>
                    <div class="form-group" style={{ flex: 1 }}>
                      <label class="form-label">Password</label>
                      <input
                        class="form-input"
                        type="password"
                        placeholder="password or token"
                        value={regPassword()}
                        onInput={(e) => setRegPassword(e.currentTarget.value)}
                      />
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: "8px" }}>
                    <button
                      class="btn btn-primary"
                      onClick={addRegistry}
                      disabled={!regServer().trim() || !regUsername().trim() || !regPassword()}
                    >
                      Save
                    </button>
                    <button class="btn" onClick={() => setShowAddRegistry(false)}>
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            </Show>
          </div>
        </div>

        {/* AI Assistant Section */}
        <div class="settings-section">
          <h2 class="settings-section-title">AI Assistant</h2>
          <div class="card">
            <div style={{ display: "flex", "flex-direction": "column", gap: "12px" }}>
              {/* Provider selector */}
              <div class="form-group">
                <label class="form-label">Provider</label>
                <div style={{ display: "flex", gap: "16px", "margin-top": "4px" }}>
                  <label style={{ display: "flex", "align-items": "center", gap: "6px", cursor: "pointer", color: "#e6edf3" }}>
                    <input
                      type="radio"
                      name="ai-provider"
                      checked={aiProvider() === "anthropic"}
                      onChange={() => {
                        setAiProvider("anthropic");
                        setAiModel("claude-sonnet-4-20250514");
                        setAiApiKey("");
                        setAiTestResult(null);
                      }}
                    />
                    Anthropic (Claude)
                  </label>
                  <label style={{ display: "flex", "align-items": "center", gap: "6px", cursor: "pointer", color: "#e6edf3" }}>
                    <input
                      type="radio"
                      name="ai-provider"
                      checked={aiProvider() === "openai"}
                      onChange={() => {
                        setAiProvider("openai");
                        setAiModel("gpt-4o");
                        setAiApiKey("");
                        setAiTestResult(null);
                      }}
                    />
                    OpenAI (GPT)
                  </label>
                </div>
              </div>

              {/* API Key */}
              <div class="form-group">
                <label class="form-label">
                  {aiProvider() === "openai" ? "OpenAI" : "Anthropic"} API Key
                  <Show when={
                    (aiProvider() === "anthropic" && hasAnthropicKey()) ||
                    (aiProvider() === "openai" && hasOpenaiKey())
                  }>
                    <span style={{ color: "#3fb950", "font-size": "11px", "margin-left": "8px" }}>
                      (configured)
                    </span>
                  </Show>
                </label>
                <input
                  class="form-input"
                  type="password"
                  placeholder={
                    (aiProvider() === "anthropic" && hasAnthropicKey()) ||
                    (aiProvider() === "openai" && hasOpenaiKey())
                      ? "Key is set — enter a new key to replace"
                      : aiProvider() === "openai"
                      ? "sk-..."
                      : "sk-ant-..."
                  }
                  value={aiApiKey()}
                  onInput={(e) => setAiApiKey(e.currentTarget.value)}
                />
              </div>

              {/* Model */}
              <div class="form-group">
                <label class="form-label">Model</label>
                <input
                  class="form-input"
                  type="text"
                  placeholder={aiProvider() === "openai" ? "gpt-4o" : "claude-sonnet-4-20250514"}
                  value={aiModel()}
                  onInput={(e) => setAiModel(e.currentTarget.value)}
                />
              </div>

              {/* Buttons */}
              <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
                <button
                  class="btn btn-primary"
                  onClick={saveAiSettings}
                  disabled={aiSaving()}
                >
                  {aiSaving() ? "Saving..." : "Save"}
                </button>
                <button
                  class="btn"
                  onClick={testAi}
                  disabled={aiTesting()}
                >
                  {aiTesting() ? "Testing..." : "Test"}
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

        {/* Agent Integration Section */}
        <div class="settings-section">
          <h2 class="settings-section-title">Agent Integration</h2>
          <div class="card">
            <div style={{ display: "flex", "flex-direction": "column", gap: "16px" }}>
              {/* MCP Config */}
              <div>
                <div style={{ "font-size": "13px", "font-weight": 600, color: "#e6edf3", "margin-bottom": "6px" }}>
                  MCP Server Config
                </div>
                <p style={{ "font-size": "12px", color: "#8b949e", margin: "0 0 8px 0", "line-height": "1.5" }}>
                  Add this to your Claude Code or Claude Desktop MCP configuration.
                </p>
                <pre
                  style={{
                    background: "#161b22",
                    border: "1px solid #21262d",
                    "border-radius": "6px",
                    padding: "12px",
                    "font-size": "12px",
                    "line-height": "1.5",
                    overflow: "auto",
                    color: "#e6edf3",
                    margin: 0,
                  }}
                >
                  {mcpConfig()}
                </pre>
                <button
                  class="btn btn-sm"
                  style={{ "margin-top": "8px" }}
                  onClick={() => copyToClipboard(mcpConfig(), setMcpCopied)}
                >
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
                  <span class="card-value mono" style={{ "font-size": "11px", "word-break": "break-all" }}>
                    {openaiEndpoint}
                  </span>
                  <span class="card-label">Auth</span>
                  <span class="card-value mono" style={{ "font-size": "11px" }}>
                    Bearer {apiToken() || "YOUR_TOKEN_HERE"}
                  </span>
                </div>
                <div style={{ display: "flex", gap: "8px", "margin-top": "8px" }}>
                  <button
                    class="btn btn-sm"
                    onClick={() => copyToClipboard(openaiEndpoint, setEndpointCopied)}
                  >
                    {endpointCopied() ? "Copied!" : "Copy Endpoint"}
                  </button>
                  <button
                    class="btn btn-sm"
                    onClick={() => copyToClipboard(apiToken(), setTokenCopied)}
                  >
                    {tokenCopied() ? "Copied!" : "Copy Token"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Config Location */}
        <div class="settings-section">
          <h2 class="settings-section-title">Configuration</h2>
          <div class="card">
            <div class="card-grid">
              <span class="card-label">Config File</span>
              <span class="card-value mono">~/.config/orca/config.toml</span>

              <span class="card-label">Data Directory</span>
              <span class="card-value mono">~/.local/share/orca/</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
