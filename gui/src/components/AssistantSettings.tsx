// The built-in assistant's settings. Optional: most people connect Claude or
// another AI tool over MCP instead (ConnectAiTools). The assistant is for
// chatting inside Orca, ideally with a model on this machine: Ollama,
// LM Studio or llama.cpp's server, found automatically.

import { createSignal, For, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { showToast } from "./Toast";
import { logError } from "../lib/activityStore";
import { getOllamaSetupState, getOllamaSetupStatus, isOllamaSetupRunning, updateOllamaSetup } from "../lib/ollamaSetup";
import Spinner from "./Spinner";
import Dropdown from "./Dropdown";

type CloudProvider = "anthropic" | "openai" | "gemini" | "custom";

interface LocalServer {
  kind: string;
  name: string;
  url: string;
  models: string[];
}

/** The model the Ollama container pulls: small, and good at calling tools. */
const CONTAINER_MODEL = "qwen3:8b";

const CLOUD: [CloudProvider, string, string, string][] = [
  ["anthropic", "Anthropic (Claude)", "claude-sonnet-5-5", "https://console.anthropic.com/settings/keys"],
  ["openai", "OpenAI", "gpt-4o", "https://platform.openai.com/api-keys"],
  ["gemini", "Google Gemini", "gemini-2.0-flash", "https://aistudio.google.com/apikey"],
  ["custom", "Other endpoint", "", ""],
];

const isLocalUrl = (url: string) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url);

export default function AssistantSettings() {
  const isMac = navigator.platform.includes("Mac");
  const [mode, setMode] = createSignal<"local" | "cloud">("local");
  const [provider, setProvider] = createSignal<CloudProvider>("anthropic");
  const [apiKey, setApiKey] = createSignal("");
  const [model, setModel] = createSignal("");
  const [url, setUrl] = createSignal("");
  const [hasAnthropicKey, setHasAnthropicKey] = createSignal(false);
  const [hasOpenaiKey, setHasOpenaiKey] = createSignal(false);
  const [keyFromEnv, setKeyFromEnv] = createSignal<string | null>(null);
  const [ready, setReady] = createSignal(false);
  const [models, setModels] = createSignal<string[]>([]);
  const [servers, setServers] = createSignal<LocalServer[] | null>(null);
  const [picked, setPicked] = createSignal<Record<string, string>>({});
  const [saving, setSaving] = createSignal(false);
  const [testing, setTesting] = createSignal(false);
  const [testResult, setTestResult] = createSignal<"success" | "error" | null>(null);
  const [showOther, setShowOther] = createSignal(false);
  // "A server on another port?": its own fields, so a saved cloud model can't sneak in.
  const [otherUrl, setOtherUrl] = createSignal("");
  const [otherModel, setOtherModel] = createSignal("");
  // The provider whose models `models()` holds: the saved one.
  const [savedProvider, setSavedProvider] = createSignal<CloudProvider | null>(null);

  const savedLocal = () => provider() === "custom" && isLocalUrl(url());
  const hasKey = () => (provider() === "anthropic" ? hasAnthropicKey() : hasOpenaiKey());

  const refresh = async () => {
    try {
      const s = await invoke<{
        provider: string;
        has_anthropic_key: boolean;
        has_openai_key: boolean;
        anthropic_model: string;
        openai_model: string;
        openai_url: string;
        ready?: boolean;
        key_source?: "env" | "settings" | null;
        key_env_var?: string;
      }>("get_ai_settings");
      setKeyFromEnv(s.key_source === "env" ? s.key_env_var ?? null : null);
      setProvider(s.provider as CloudProvider);
      setSavedProvider(s.provider as CloudProvider);
      setHasAnthropicKey(s.has_anthropic_key);
      setHasOpenaiKey(s.has_openai_key);
      setModel(s.provider === "anthropic" ? s.anthropic_model : s.openai_model);
      setUrl(s.openai_url || "");
      setApiKey("");
      setReady(!!s.ready);
      // Someone with a cloud key set up keeps seeing it; everyone else starts local.
      setMode(s.ready && !(s.provider === "custom" && isLocalUrl(s.openai_url || "")) ? "cloud" : "local");
      void loadModels();
    } catch {}
  };

  const detect = async () => {
    setServers(null);
    try {
      const r = await invoke<{ servers: LocalServer[] }>("ai_local_servers");
      setServers(r.servers);
    } catch {
      setServers([]);
    }
  };

  const loadModels = async () => {
    try {
      const r = await invoke<{ models: string[] }>("list_ai_models");
      setModels((r.models || []).map((m) => m.replace(/^models\//, "")));
    } catch {
      setModels([]);
    }
  };

  onMount(() => {
    void refresh();
    void detect();
  });

  const save = async (p: CloudProvider, m: string, u: string | null, key: string) => {
    setSaving(true);
    try {
      await invoke("save_ai_settings", { provider: p, apiKey: key, model: m, url: u });
      await refresh();
      return true;
    } catch (e) {
      logError(`Failed to save AI settings: ${e}`, `Provider "${p}", model "${m}"`);
      showToast(`Could not save: ${e}`, "error");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const useLocal = async (s: LocalServer) => {
    const m = picked()[s.url] ?? (url() === s.url && s.models.includes(model()) ? model() : s.models[0]);
    if (!m) return;
    if (await save("custom", m, s.url, "")) showToast(`The assistant now uses ${m} on ${s.name}`, "success");
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      await invoke("ai_ask", { query: "Say 'AI connection successful!' in exactly those words.", context: null });
      setTestResult("success");
    } catch (e) {
      setTestResult("error");
      showToast(`Test failed: ${e}`, "error");
    } finally {
      setTesting(false);
    }
  };

  // Linux and Windows with an NVIDIA GPU can run Ollama in a container at
  // full speed. On a Mac the container can't reach the GPU.
  const setupOllamaContainer = async () => {
    if (isOllamaSetupRunning()) return;
    try {
      updateOllamaSetup("running", "Pulling the Ollama image…");
      await invoke("pull_image", { reference: "ollama/ollama:latest" });
      updateOllamaSetup("running", "Starting Ollama…");
      const health = await invoke<{ gpu?: unknown }>("system_health", { refresh: false }).catch(() => null);
      try {
        await invoke("create_and_run_container", {
          image: "ollama/ollama:latest",
          name: "ollama",
          ports: ["11434:11434"],
          volumes: ["ollama-models:/root/.ollama"],
          restartPolicy: "unless-stopped",
          gpu: !!health?.gpu,
        });
      } catch (e) {
        const err = String(e);
        if (!err.includes("already in use") && !err.includes("Conflict")) throw e;
        await invoke("start_container", { id: "ollama" }).catch(() => {});
      }
      let up = false;
      for (let i = 0; i < 20 && !up; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        up = await invoke("exec_container", { id: "ollama", command: ["ollama", "list"] }).then(() => true, () => false);
      }
      if (!up) throw new Error(`Ollama isn't answering. Try: docker exec ollama ollama pull ${CONTAINER_MODEL}`);
      // The pull outlives the app's 30 s request timeout, so watch `ollama list` instead.
      void invoke("exec_container", { id: "ollama", command: ["ollama", "pull", CONTAINER_MODEL] }).catch(() => {});
      const started = Date.now();
      let pulled = false;
      while (!pulled && Date.now() - started < 30 * 60_000) {
        await new Promise((r) => setTimeout(r, 5000));
        const s = Math.floor((Date.now() - started) / 1000);
        updateOllamaSetup("running", `Downloading ${CONTAINER_MODEL} (about 5 GB)… ${Math.floor(s / 60)}m ${s % 60}s`);
        const list = await invoke<{ output?: string }>("exec_container", { id: "ollama", command: ["ollama", "list"] }).catch(() => null);
        pulled = !!list?.output?.includes(CONTAINER_MODEL);
      }
      if (!pulled) throw new Error(`the model is still downloading. Check with: docker exec ollama ollama list`);
      await save("custom", CONTAINER_MODEL, "http://127.0.0.1:11434/v1", "");
      updateOllamaSetup("done", `Ollama is ready. The assistant uses ${CONTAINER_MODEL}.`);
      await detect();
    } catch (e) {
      updateOllamaSetup("error", `Ollama setup failed: ${e}`);
      showToast(`Ollama setup failed: ${e}`, "error");
    }
  };

  const status = () =>
    !ready()
      ? "Off"
      : savedLocal()
        ? `On · ${model()} on this computer`
        : `On · ${model()} via ${CLOUD.find((c) => c[0] === provider())?.[1] ?? provider()}`;

  return (
    <div class="settings-section">
      <h2 class="settings-section-title">Built-in assistant</h2>
      <div class="card assistant-card">
        <div class="assistant-head">
          <div>
            <div class="assistant-sub">
              Optional. A chat window inside Orca, behind the ✦ button. Run it on a model on this computer: free, private,
              and nothing leaves your machine. To use Claude or ChatGPT, connect them above instead.
            </div>
          </div>
          <span class="assistant-status" classList={{ on: ready() }}>{status()}</span>
        </div>

        <div class="segmented">
          <button classList={{ active: mode() === "local" }} onClick={() => setMode("local")}>Local model</button>
          <button classList={{ active: mode() === "cloud" }} onClick={() => setMode("cloud")}>Cloud API key</button>
        </div>

        <Show when={mode() === "local"}>
          <div class="local-servers">
            <div class="local-servers-head">
              <span>Model servers on this computer</span>
              <button class="btn btn-sm" onClick={() => void detect()} disabled={servers() === null}>
                {servers() === null ? "Looking…" : "Look again"}
              </button>
            </div>
            <Show when={servers() !== null} fallback={<div class="local-empty"><Spinner size={12} /> Looking for Ollama, LM Studio and llama.cpp…</div>}>
              <For each={servers()} fallback={
                <div class="local-empty">
                  <p>No local model server is running. Install one, start it, and click <b>Look again</b>:</p>
                  <ul>
                    <li><b>Ollama</b> (ollama.com), then <span class="mono">ollama pull {CONTAINER_MODEL}</span>. The easiest start.</li>
                    <li><b>LM Studio</b> (lmstudio.ai): download a model, then start its server.</li>
                    <li><b>llama.cpp</b>: <span class="mono">llama-server -hf Qwen/Qwen3-8B-GGUF</span></li>
                  </ul>
                  <Show when={isMac}>
                    <p class="local-note">Install it as a Mac app rather than in a container: containers can't use the Mac's GPU.</p>
                  </Show>
                </div>
              }>
                {(s) => {
                  const inUse = () => ready() && savedLocal() && url() === s.url;
                  return (
                    <div class="local-server" classList={{ active: inUse() }}>
                      <div class="local-server-name">
                        {s.name}
                        <small>{s.models.length ? `${s.models.length} model${s.models.length === 1 ? "" : "s"}` : "no models yet"} · {s.url}</small>
                      </div>
                      <Show when={s.models.length > 0} fallback={<span class="local-note">Download a model in {s.name} first</span>}>
                        <div class="local-server-pick">
                          <Dropdown
                            value={picked()[s.url] ?? (inUse() ? model() : s.models[0])}
                            options={s.models.map((m) => ({ value: m, label: m }))}
                            onChange={(v) => setPicked({ ...picked(), [s.url]: v })}
                          />
                          <button
                            class={`btn btn-sm ${inUse() && !(picked()[s.url] && picked()[s.url] !== model()) ? "" : "btn-primary"}`}
                            disabled={saving()}
                            onClick={() => void useLocal(s)}
                          >
                            {inUse() && !(picked()[s.url] && picked()[s.url] !== model()) ? "✓ In use" : "Use"}
                          </button>
                        </div>
                      </Show>
                    </div>
                  );
                }}
              </For>
            </Show>

            <Show when={!isMac}>
              <div class="local-container">
                <div>
                  <b>Or run Ollama in a container</b>
                  <div class="local-note">Pulls {CONTAINER_MODEL} (about 5 GB, 8 GB of memory). Fast with an NVIDIA GPU, slow on CPU only.</div>
                  <Show when={getOllamaSetupStatus()}>
                    <div class="local-note" style={{ color: getOllamaSetupState() === "error" ? "#f85149" : getOllamaSetupState() === "done" ? "#3fb950" : undefined }}>
                      <Show when={isOllamaSetupRunning()}><Spinner size={11} /> </Show>{getOllamaSetupStatus()}
                    </div>
                  </Show>
                </div>
                <button class="btn btn-sm" disabled={isOllamaSetupRunning()} onClick={() => void setupOllamaContainer()}>
                  {isOllamaSetupRunning() ? "Setting up…" : "Set up"}
                </button>
              </div>
            </Show>

            <button class="ai-connect-more" onClick={() => {
              // Start from the local server in use, if that's one of these.
              if (!showOther() && savedLocal()) { setOtherUrl(url()); setOtherModel(model()); }
              setShowOther(!showOther());
            }}>
              {showOther() ? "Hide" : "A server on another port?"}
            </button>
            <Show when={showOther()}>
              <div class="assistant-row">
                <input class="form-input mono" placeholder="http://127.0.0.1:8000/v1" value={otherUrl()}
                  onInput={(e) => setOtherUrl(e.currentTarget.value)} />
                <input class="form-input mono" placeholder="model name" value={otherModel()}
                  onInput={(e) => setOtherModel(e.currentTarget.value)} />
                <button class="btn btn-sm btn-primary" disabled={saving() || !/^https?:\/\/\S+$/.test(otherUrl().trim()) || !otherModel().trim()}
                  onClick={() => void save("custom", otherModel().trim(), otherUrl().trim(), "").then((ok) => ok && showToast("Saved", "success"))}>
                  Use
                </button>
              </div>
            </Show>
          </div>
        </Show>

        <Show when={mode() === "cloud"}>
          <div class="assistant-cloud">
            <p class="local-note">
              Billed per token by the provider: a Claude or ChatGPT subscription doesn't cover API use. Connecting Claude above
              uses your subscription instead.
            </p>
            <div class="assistant-row wrap">
              <For each={CLOUD}>{([id, label, defaultModel]) => (
                <button class={`btn btn-sm ${provider() === id && !savedLocal() ? "btn-primary" : ""}`} onClick={() => {
                  setProvider(id);
                  setApiKey("");
                  setTestResult(null);
                  setModel(defaultModel);
                  if (id !== "custom") setUrl("");
                }}>{label}</button>
              )}</For>
            </div>
            <Show when={provider() === "custom"}>
              <div class="form-group">
                <label class="form-label">API base URL</label>
                <input class="form-input mono" placeholder="https://api.example.com/v1" value={url()} onInput={(e) => setUrl(e.currentTarget.value)} />
                <span class="form-hint">An OpenAI-compatible endpoint with /chat/completions</span>
              </div>
            </Show>
            <div class="form-group">
              <label class="form-label">
                API key
                <Show when={hasKey() && !savedLocal()}>
                  <span class="assistant-key-ok">✓ set{keyFromEnv() ? ` (from ${keyFromEnv()})` : ""}</span>
                </Show>
              </label>
              <div class="assistant-row">
                <input class="form-input" type="password" value={apiKey()} onInput={(e) => setApiKey(e.currentTarget.value)}
                  placeholder={hasKey() && !savedLocal() ? "Enter a new key to replace it" : provider() === "anthropic" ? "sk-ant-…" : provider() === "gemini" ? "AIza…" : "sk-…"} />
                <Show when={CLOUD.find((c) => c[0] === provider())?.[3]}>
                  {(href) => <a class="btn btn-sm" href={href()} target="_blank" rel="noopener noreferrer">Get a key</a>}
                </Show>
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">Model</label>
              <Show when={models().length > 0 && !savedLocal() && provider() === savedProvider()} fallback={
                <input class="form-input mono" value={model()} onInput={(e) => setModel(e.currentTarget.value)} placeholder="Save the key to pick from a list" />
              }>
                <Dropdown value={model()} options={models().map((m) => ({ value: m, label: m }))} onChange={setModel} />
              </Show>
            </div>
            <div class="assistant-row">
              <button class="btn btn-primary" disabled={saving()}
                onClick={() => void save(provider(), model(), provider() === "custom" ? url() || null : null, apiKey()).then((ok) => ok && showToast("Saved", "success"))}>
                {saving() ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </Show>

        <Show when={ready()}>
          <div class="assistant-row assistant-test">
            <button class="btn btn-sm" onClick={() => void test()} disabled={testing()}>{testing() ? "Asking…" : "Test the assistant"}</button>
            <Show when={testResult() === "success"}><span class="assistant-key-ok">Works</span></Show>
            <Show when={testResult() === "error"}><span style={{ color: "#f85149", "font-size": "12px" }}>Didn't answer</span></Show>
            <Show when={savedLocal()}><span class="local-note">A local model gets a lean set of 19 tools, and up to 5 minutes per answer.</span></Show>
          </div>
        </Show>
      </div>
      <p class="settings-note">API keys stay in Orca's config on this computer and are only sent to the provider you pick.</p>
    </div>
  );
}
