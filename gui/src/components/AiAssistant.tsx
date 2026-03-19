import { createSignal, For, Show, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { AiResponse, AiContext } from "../lib/types";
import { showToast } from "./Toast";

interface AiMessage {
  role: "user" | "ai";
  content: string;
  suggestions?: { label: string; action: string; detail: string }[];
}

interface AiAssistantProps {
  onNavigate?: (page: string) => void;
}

export default function AiAssistant(props: AiAssistantProps) {
  const [open, setOpen] = createSignal(false);
  const [messages, setMessages] = createSignal<AiMessage[]>([]);
  const [input, setInput] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const [hasCredentials, setHasCredentials] = createSignal<boolean | null>(null);
  const [showInlineSetup, setShowInlineSetup] = createSignal(false);
  const [setupProvider, setSetupProvider] = createSignal<"anthropic" | "openai">("anthropic");
  const [setupApiKey, setSetupApiKey] = createSignal("");
  const [setupUrl, setSetupUrl] = createSignal("");
  const [setupModel, setSetupModel] = createSignal("");
  const [setupSaving, setSetupSaving] = createSignal(false);
  let messagesEnd: HTMLDivElement | undefined;

  const scrollToBottom = () => {
    setTimeout(() => {
      messagesEnd?.scrollIntoView({ behavior: "smooth" });
    }, 50);
  };

  const checkCredentials = async () => {
    try {
      const settings = (await invoke("get_ai_settings")) as {
        has_anthropic_key: boolean;
        has_openai_key: boolean;
      };
      setHasCredentials(settings.has_anthropic_key || settings.has_openai_key);
    } catch {
      setHasCredentials(false);
    }
  };

  const saveInlineKey = async () => {
    const key = setupApiKey().trim();
    if (!key) return;
    setSetupSaving(true);
    try {
      await invoke("save_ai_settings", {
        provider: setupProvider(),
        apiKey: key,
        model: setupModel().trim() || (setupProvider() === "openai" ? "gpt-4o" : "claude-sonnet-4-20250514"),
        url: setupUrl().trim() || null,
      });
      showToast("AI settings saved", "success");
      setShowInlineSetup(false);
      setSetupApiKey("");
      setSetupUrl("");
      setSetupModel("");
      await checkCredentials();
    } catch (e) {
      showToast(`Failed to save AI settings: ${e}`, "error");
    }
    setSetupSaving(false);
  };

  const sendMessage = async (query?: string) => {
    const text = query || input().trim();
    if (!text || loading()) return;

    // Check credentials before sending
    if (!hasCredentials()) {
      await checkCredentials();
      if (!hasCredentials()) {
        return;
      }
    }

    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setLoading(true);
    scrollToBottom();

    try {
      const result = (await invoke("ai_ask", {
        query: text,
        context: null,
      })) as AiResponse;

      setMessages((prev) => [
        ...prev,
        {
          role: "ai",
          content: result.answer,
          suggestions: result.suggestions,
        },
      ]);
    } catch (e: any) {
      setMessages((prev) => [
        ...prev,
        {
          role: "ai",
          content: `Error: ${e}`,
        },
      ]);
    } finally {
      setLoading(false);
      scrollToBottom();
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const handleSuggestion = (suggestion: { label: string; action: string; detail: string }) => {
    if (suggestion.action === "navigate" && props.onNavigate) {
      props.onNavigate(suggestion.detail);
    } else if (suggestion.action === "run_command") {
      sendMessage(suggestion.detail);
    }
  };

  const formatContent = (content: string) => {
    // Simple markdown-like formatting
    let html = content
      // Code blocks
      .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
      // Inline code
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      // Bold
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      // Line breaks
      .replace(/\n/g, '<br/>');
    return html;
  };

  return (
    <>
      {/* Floating Action Button */}
      <button
        class="ai-fab"
        onClick={() => {
          const willOpen = !open();
          setOpen(willOpen);
          if (willOpen) checkCredentials();
        }}
        title="AI Assistant"
      >
        {open() ? "\u2715" : "\u2728"}
      </button>

      {/* Chat Panel */}
      <Show when={open()}>
        <div class="ai-panel">
          <div class="ai-panel-header">
            <span>{"\u2728"} Orca AI</span>
            <button
              class="modal-close"
              onClick={() => setOpen(false)}
              style="font-size: 18px"
            >
              {"\u00d7"}
            </button>
          </div>

          <div class="ai-messages">
            <Show when={hasCredentials() === false}>
              <div class="ai-setup">
                <div style="font-size: 32px; opacity: 0.5">{"\u2728"}</div>
                <div style="font-size: 14px; color: #e6edf3; font-weight: 600">
                  Set up your AI provider to get started
                </div>
                <div style="font-size: 12px; color: #8b949e; line-height: 1.5; margin-bottom: 12px">
                  An API key from Anthropic or OpenAI is required to use the AI assistant.
                </div>
                <Show when={!showInlineSetup()}>
                  <div style="display: flex; gap: 8px; justify-content: center">
                    <button
                      class="btn btn-sm btn-primary"
                      onClick={() => props.onNavigate?.("settings")}
                    >
                      Configure in Settings
                    </button>
                    <button
                      class="btn btn-sm"
                      onClick={() => setShowInlineSetup(true)}
                    >
                      Enter API Key
                    </button>
                  </div>
                </Show>
                <Show when={showInlineSetup()}>
                  <div style="display: flex; flex-direction: column; gap: 8px; width: 100%; max-width: 300px">
                    <select
                      class="form-select"
                      value={setupProvider()}
                      onChange={(e) => setSetupProvider(e.currentTarget.value as "anthropic" | "openai")}
                    >
                      <option value="anthropic">Anthropic (Claude)</option>
                      <option value="openai">OpenAI / Compatible</option>
                    </select>
                    <input
                      type="password"
                      class="form-input"
                      placeholder="API Key"
                      value={setupApiKey()}
                      onInput={(e) => setSetupApiKey(e.currentTarget.value)}
                    />
                    <Show when={setupProvider() === "openai"}>
                      <input
                        type="text"
                        class="form-input"
                        placeholder="API URL (default: https://api.openai.com/v1)"
                        value={setupUrl()}
                        onInput={(e) => setSetupUrl(e.currentTarget.value)}
                      />
                      <input
                        type="text"
                        class="form-input"
                        placeholder="Model (default: gpt-4o)"
                        value={setupModel()}
                        onInput={(e) => setSetupModel(e.currentTarget.value)}
                      />
                    </Show>
                    <div style="display: flex; gap: 6px; justify-content: flex-end">
                      <button class="btn btn-sm" onClick={() => setShowInlineSetup(false)}>
                        Cancel
                      </button>
                      <button
                        class="btn btn-sm btn-primary"
                        onClick={saveInlineKey}
                        disabled={setupSaving() || !setupApiKey().trim()}
                      >
                        {setupSaving() ? "Saving..." : "Save"}
                      </button>
                    </div>
                  </div>
                </Show>
              </div>
            </Show>

            <Show when={hasCredentials() !== false && messages().length === 0}>
              <div class="ai-setup">
                <div style="font-size: 32px; opacity: 0.5">{"\u2728"}</div>
                <div style="font-size: 14px; color: #e6edf3; font-weight: 600">
                  Orca AI Assistant
                </div>
                <div style="font-size: 12px; color: #8b949e; line-height: 1.5">
                  Ask me anything about your containers, images, or Docker in general.
                </div>
                <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; justify-content: center">
                  <button
                    class="ai-suggestion-pill"
                    onClick={() => sendMessage("How do I debug a container that keeps restarting?")}
                  >
                    Debug restarts
                  </button>
                  <button
                    class="ai-suggestion-pill"
                    onClick={() => sendMessage("How do I optimize my Docker images for smaller size?")}
                  >
                    Optimize images
                  </button>
                  <button
                    class="ai-suggestion-pill"
                    onClick={() => sendMessage("Explain Docker networking basics")}
                  >
                    Networking basics
                  </button>
                </div>
              </div>
            </Show>

            <For each={messages()}>
              {(msg) => (
                <div>
                  <div
                    class={`ai-message ${msg.role === "user" ? "ai-message-user" : "ai-message-ai"}`}
                    innerHTML={msg.role === "ai" ? formatContent(msg.content) : undefined}
                  >
                    <Show when={msg.role === "user"}>{msg.content}</Show>
                  </div>
                  <Show when={msg.suggestions && msg.suggestions.length > 0}>
                    <div class="ai-suggestions" style="margin-left: 0">
                      <For each={msg.suggestions!}>
                        {(s) => (
                          <button
                            class="ai-suggestion-pill"
                            onClick={() => handleSuggestion(s)}
                          >
                            {s.label}
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              )}
            </For>

            <Show when={loading()}>
              <div class="ai-typing">
                <div class="ai-typing-dot" />
                <div class="ai-typing-dot" />
                <div class="ai-typing-dot" />
              </div>
            </Show>

            <div ref={messagesEnd} />
          </div>

          <div class="ai-input-bar">
            <input
              class="ai-input"
              value={input()}
              onInput={(e) => setInput(e.currentTarget.value)}
              onKeyDown={handleKeyDown}
              placeholder={hasCredentials() === false ? "Configure AI provider first..." : "Ask Orca AI..."}
              disabled={loading() || hasCredentials() === false}
            />
            <button
              class="ai-send"
              onClick={() => sendMessage()}
              disabled={loading() || !input().trim() || hasCredentials() === false}
            >
              Send
            </button>
          </div>
        </div>
      </Show>
    </>
  );
}
