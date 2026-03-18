import { createSignal, For, onCleanup } from "solid-js";

export type ToastType = "success" | "error" | "info";

interface ToastMessage {
  id: number;
  message: string;
  type: ToastType;
}

let nextId = 0;
const [toasts, setToasts] = createSignal<ToastMessage[]>([]);

export function showToast(message: string, type: ToastType = "info") {
  const id = nextId++;
  setToasts((prev) => [...prev, { id, message, type }]);
  setTimeout(() => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, 4000);
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
            <span class="toast-message">{toast.message}</span>
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
