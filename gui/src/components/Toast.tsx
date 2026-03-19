import { createSignal, For, Show } from "solid-js";

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
  }, 4000);
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
      {copied() ? "\u2713" : "\u2398"}
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
              {toast.type === "success" ? "\u2713" : toast.type === "error" ? "\u2717" : "\u2139"}
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
              \u00d7
            </button>
          </div>
        )}
      </For>
    </div>
  );
}
