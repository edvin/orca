import { createSignal, For, Show, onMount, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import DOMPurify from "dompurify";
import type { AiResponse, AiContext } from "../lib/types";
import { t, lang } from "../i18n";
import { settingsDetailEn, settingsDetailZhCN } from "../i18n/settingsDetail";

const tr = (key: string, params: Record<string, string | number> = {}) => {
  const central = t(key);
  const value = central === key ? (lang() === "zh-CN" ? settingsDetailZhCN[key] : settingsDetailEn[key]) ?? key : central;
  return Object.entries(params).reduce((text, [name, replacement]) => text.replaceAll(`{${name}}`, String(replacement)), value);
};

/** Standalone AI chat window — rendered when the app loads with #ai hash */

interface AiMessage {
  role: "user" | "ai";
  content: string;
}

export default function AiWindow() {
  const [messages, setMessages] = createSignal<AiMessage[]>([]);
  const [input, setInput] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const [hasCredentials, setHasCredentials] = createSignal<boolean | null>(null);
  const [pendingContext, setPendingContext] = createSignal<AiContext | null>(null);
  let messagesEnd: HTMLDivElement | undefined;
  let inputRef: HTMLTextAreaElement | undefined;

  const scrollToBottom = () => {
    setTimeout(() => messagesEnd?.scrollIntoView({ behavior: "smooth" }), 50);
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

  const sendMessage = async (query?: string) => {
    const text = query || input().trim();
    if (!text || loading()) return;

    const ctx = pendingContext();
    setPendingContext(null);

    if (!hasCredentials()) {
      await checkCredentials();
      if (!hasCredentials()) return;
    }

    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setLoading(true);
    scrollToBottom();

    try {
      // Send recent conversation history (sliding window of last 20 messages)
      const allMessages = messages();
      const historyWindow = allMessages.slice(-20).map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const result = (await invoke("ai_ask", {
        query: text,
        context: ctx || null,
        history: historyWindow,
      })) as AiResponse;

      setMessages((prev) => [...prev, { role: "ai", content: result.answer }]);
    } catch (e: any) {
      setMessages((prev) => [...prev, { role: "ai", content: tr("ai.error", { error: String(e) }) }]);
    } finally {
      setLoading(false);
      scrollToBottom();
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  // Listen for context from the main window. Register cleanup
  // synchronously so a fast unmount during the async setup doesn't leak
  // the Tauri listeners.
  onMount(() => {
    let unlisten: (() => void) | null = null;
    let unlistenBuild: (() => void) | null = null;
    let disposed = false;

    onCleanup(() => {
      disposed = true;
      try { unlisten?.(); } catch {}
      try { unlistenBuild?.(); } catch {}
      unlisten = null;
      unlistenBuild = null;
    });

    checkCredentials();
    inputRef?.focus();

    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const u1 = await listen<{ containerId: string; containerName: string; image: string }>(
          "ai-ask-container",
          async (event) => {
            if (disposed) return;
            const { containerId, containerName, image } = event.payload;
            let logs = "";
            try {
              const logResult = (await invoke("container_logs", { id: containerId, tail: 50 })) as string[];
              logs = logResult.map((l: string) => l.replace(/\n$/, "")).join("\n");
            } catch {}
            if (disposed) return;
            const context: AiContext = {
              container_id: containerId,
              container_name: containerName,
              image,
              container_logs: logs || undefined,
            };
            setPendingContext(context);
            setInput("");
            inputRef?.focus();
          },
        );
        if (disposed) { try { u1(); } catch {} return; }
        unlisten = u1;

        const u2 = await listen<{ tag: string; error: string; logTail: string }>(
          "ai-ask-build",
          (event) => {
            if (disposed) return;
            const { tag, error, logTail } = event.payload;
            const context: AiContext = {
              container_name: tr("ai.buildContext", { tag }),
              error,
              container_logs: logTail || undefined,
            };
            setPendingContext(context);
            const prompt = tr("ai.buildPrompt", { tag, error, logTail });
            setInput(prompt);
            inputRef?.focus();
          },
        );
        if (disposed) { try { u2(); } catch {} return; }
        unlistenBuild = u2;
      } catch {}
    })();
  });

  const compactHistory = async () => {
    if (loading() || messages().length < 6) return;
    setLoading(true);
    try {
      const allMessages = messages();
      const summary = allMessages
        .map((m) => `${m.role === "user" ? tr("ai.user") : "AI"}: ${m.content.slice(0, 200)}`)
        .join("\n");
      const result = (await invoke("ai_ask", {
        query: tr("ai.summaryPrompt", { summary }),
        context: null,
        history: [],
      })) as AiResponse;
      setMessages([
        { role: "ai", content: tr("ai.previousSummary", { summary: result.answer }) },
      ]);
    } catch {
      // If compaction fails, just keep the recent messages
      setMessages((prev) => prev.slice(-6));
    }
    setLoading(false);
  };

  const renderMarkdown = (text: string) => {
    const html = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="ai-code-block"><code>$2</code></pre>')
      .replace(/`([^`]+)`/g, '<code class="ai-inline-code">$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\n/g, "<br/>");
    return DOMPurify.sanitize(html);
  };

  const isMac = navigator.platform.includes("Mac");

  return (
    <div class={`ai-window ${isMac ? "ai-window-macos" : ""}`}>
      {/* Header */}
      <div class="ai-window-header" data-tauri-drag-region>
        <div class="ai-window-title" data-tauri-drag-region>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z"/>
            <path d="M4 3v2"/><path d="M3 4h2"/>
            <path d="M20 19v2"/><path d="M19 20h2"/>
          </svg>
          Orca Desktop AI
        </div>
        <div style={{ display: "flex", "align-items": "center", gap: "2px" }}>
          <Show when={messages().length > 0}>
            <button
              class="ai-window-header-btn"
              onClick={() => compactHistory()}
              disabled={loading() || messages().length < 6}
              title={tr("ai.compact")}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
            </button>
            <button
              class="ai-window-header-btn"
              onClick={() => { setMessages([]); setPendingContext(null); }}
              disabled={loading()}
              title={tr("ai.clear")}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </Show>
          <button class="ai-window-close" onClick={async () => {
            try {
              const { getCurrentWindow } = await import("@tauri-apps/api/window");
              await getCurrentWindow().close();
            } catch {}
          }}>{"\u00d7"}</button>
        </div>
      </div>

      {/* Messages */}
      <div class="ai-window-messages">
        <Show when={hasCredentials() === false}>
          <div class="ai-window-empty">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" style={{ opacity: 0.3 }}>
              <path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z"/>
              <path d="M4 3v2"/><path d="M3 4h2"/>
              <path d="M20 19v2"/><path d="M19 20h2"/>
            </svg>
            <div style={{ "font-size": "15px", "font-weight": "600", "margin-top": "12px" }}>{tr("ai.configureProvider")}</div>
            <div style={{ "font-size": "13px", color: "#6e7681", "margin-top": "6px", "line-height": "1.5" }}>
              {tr("ai.configureHint")}
            </div>
          </div>
        </Show>

        <Show when={hasCredentials() && messages().length === 0}>
          <div class="ai-window-empty">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#58a6ff" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" style={{ opacity: 0.4 }}>
              <path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z"/>
              <path d="M4 3v2"/><path d="M3 4h2"/>
              <path d="M20 19v2"/><path d="M19 20h2"/>
            </svg>
            <div style={{ "font-size": "15px", "font-weight": "600", "margin-top": "12px" }}>{tr("ai.askAnything")}</div>
            <div style={{ "font-size": "13px", color: "#6e7681", "margin-top": "6px", "line-height": "1.5" }}>
              {tr("ai.helpHint")}
            </div>
          </div>
        </Show>

        <For each={messages()}>
          {(msg) => (
            <div class="ai-window-msg">
              <Show when={msg.role === "ai"}>
                <div class="ai-window-msg-avatar">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z"/></svg>
                </div>
              </Show>
              <Show when={msg.role === "ai"} fallback={
                <div class="ai-window-msg-bubble ai-window-msg-user">
                  {msg.content}
                </div>
              }>
                <div
                  class="ai-window-msg-bubble ai-window-msg-ai"
                  // eslint-disable-next-line solid/no-innerhtml -- sanitized via renderMarkdown/DOMPurify
                  innerHTML={renderMarkdown(msg.content)}
                />
              </Show>
            </div>
          )}
        </For>

        <Show when={loading()}>
          <div class="ai-window-msg">
            <div class="ai-window-msg-avatar">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z"/></svg>
            </div>
            <div class="ai-window-msg-bubble ai-window-msg-ai ai-window-typing">
              <span /><span /><span />
            </div>
          </div>
        </Show>

        <div ref={messagesEnd} />
      </div>

      {/* Context banner */}
      <Show when={pendingContext()}>
        {(ctx) => (
          <div class="ai-context-banner">
            <div class="ai-context-info">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/>
              </svg>
              <span>{ctx().container_name}</span>
              <span style={{ color: "#6e7681", "font-size": "11px" }}>{ctx().image}</span>
            </div>
            <button class="ai-context-dismiss" onClick={() => setPendingContext(null)} title={tr("ai.clearContext")}>{"\u00d7"}</button>
          </div>
        )}
      </Show>

      {/* Input */}
      <div class="ai-window-input-area">
        <textarea
          ref={inputRef}
          class="ai-window-input"
          placeholder={hasCredentials() === false
            ? tr("ai.configureFirst")
            : pendingContext()
            ? tr("ai.askAbout", { name: pendingContext()!.container_name || "" })
            : tr("ai.placeholder")}
          value={input()}
          onInput={(e) => setInput(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
          disabled={loading() || hasCredentials() === false}
          rows={1}
        />
        <button
          class="ai-window-send"
          onClick={() => sendMessage()}
          disabled={loading() || !input().trim() || hasCredentials() === false}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="22" y1="2" x2="11" y2="13"/>
            <polygon points="22 2 15 22 11 13 2 9 22 2"/>
          </svg>
        </button>
      </div>
    </div>
  );
}
