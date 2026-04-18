import { createSignal, For, Show } from "solid-js";
import { logError } from "../lib/activityStore";

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

// Cap on how many toasts are shown at once. Beyond this, the oldest is
// dropped so a burst of errors doesn't stack unreadably off-screen.
const MAX_VISIBLE = 5;

// Pending auto-dismiss timeouts keyed by toast id. A manual dismiss must
// clear its timeout or we'll mutate the toast list after it's already gone
// (harmless today, but also pure bookkeeping leak). This also ensures that
// when we evict an overflowed toast, we don't leave its timer to race and
// filter out an unrelated toast that's been assigned the same slot.
const pendingTimeouts = new Map<number, ReturnType<typeof setTimeout>>();

function dismissToast(id: number) {
  const t = pendingTimeouts.get(id);
  if (t !== undefined) {
    clearTimeout(t);
    pendingTimeouts.delete(id);
  }
  setToasts((prev) => prev.filter((t) => t.id !== id));
}

export function showToast(
  message: string,
  type: ToastType = "info",
  action?: { label: string; onClick: () => void }
) {
  const id = nextId++;
  setToasts((prev) => {
    const next = [...prev, { id, message, type, action }];
    // Evict oldest toasts (from the head) when over the cap; clear their
    // timeouts so they don't fire against a later toast list.
    while (next.length > MAX_VISIBLE) {
      const dropped = next.shift();
      if (dropped) {
        const t = pendingTimeouts.get(dropped.id);
        if (t !== undefined) {
          clearTimeout(t);
          pendingTimeouts.delete(dropped.id);
        }
      }
    }
    return next;
  });
  const handle = setTimeout(() => {
    pendingTimeouts.delete(id);
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, type === "error" ? 8000 : 4000);
  pendingTimeouts.set(id, handle);

  // Only log errors to activity feed (info toasts are too noisy)
  if (type === "error") logError(message);
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
                      dismissToast(toast.id);
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
              onClick={() => dismissToast(toast.id)}
            >
              {"\u00d7"}
            </button>
          </div>
        )}
      </For>
    </div>
  );
}
