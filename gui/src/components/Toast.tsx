import { createSignal, For, Show } from "solid-js";
import { logError, logWarning, logInfo } from "../lib/activityStore";

export type ToastType = "success" | "error" | "info";

interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastMessage {
  id: number;
  message: string;
  type: ToastType;
  action?: ToastAction;
}

let nextId = 0;
const [toasts, setToasts] = createSignal<ToastMessage[]>([]);

export function showToast(
  message: string,
  type: ToastType = "info",
  action?: { label: string; onClick: () => void }
) {
  const id = nextId++;
  setToasts((prev) => [...prev, { id, message, type, action }]);
  setTimeout(() => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, type === "error" ? 8000 : 4000);

  // Log to activity feed for persistence
  if (type === "error") logError(message);
  else if (type === "info") logInfo(message);
}

function CopyToastButton(props: { message: string }) {
  const [copied, setCopied] = createSignal(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(props.message);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Fallback
      try {
        const textarea = document.createElement("textarea");
        textarea.value = props.message;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } catch {
        // silently fail
      }
    }
  };

  return (
    <button class="toast-copy" onClick={handleCopy} title="Copy error message">
      {copied()
        ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#3fb950" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>}
    </button>
  );
}

export default function ToastContainer() {
  return (
    <div class="toast-container">
      <For each={toasts()}>
        {(toast) => (
          <div class={`toast toast-${toast.type}`}>
            <span class="toast-icon">
              {toast.type === "success"
                ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3fb950" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                : toast.type === "error"
                ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f85149" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#58a6ff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>}
            </span>
            <span class="toast-message">
              {toast.message}
              <Show when={toast.action}>
                {(action) => (
                  <button
                    class="toast-action"
                    onClick={() => {
                      action().onClick();
                      setToasts((prev) => prev.filter((t) => t.id !== toast.id));
                    }}
                  >
                    {action().label}
                  </button>
                )}
              </Show>
            </span>
            <Show when={toast.type === "error"}>
              <CopyToastButton message={toast.message} />
            </Show>
            <button
              class="toast-close"
              onClick={() => setToasts((prev) => prev.filter((t) => t.id !== toast.id))}
            >
              {"\u00d7"}
            </button>
          </div>
        )}
      </For>
    </div>
  );
}
