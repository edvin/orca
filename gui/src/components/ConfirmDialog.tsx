import { createSignal, Show, onCleanup, onMount } from "solid-js";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { renderMarkdown } from "../lib/markdown";

interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** Markdown shown below the message, such as release notes. */
  details?: string;
  /** The dialog's width; 440px by default. */
  width?: string;
}

type PendingConfirm = {
  opts: ConfirmOptions;
  resolve: (result: boolean) => void;
};

// A FIFO queue of pending confirmations. The dialog shows the head of the
// queue; when the user answers, we resolve the current head and advance.
// This prevents the module-level singleton resolver from being silently
// clobbered if two callers invoke confirm() before the first is answered.
const [queue, setQueue] = createSignal<PendingConfirm[]>([]);
const [isOpen, setIsOpen] = createSignal(false);
// When the queue advances to a new head (either by answering one dialog or
// because a new confirm arrived), we briefly refuse key-based confirmation
// so a rapid Enter double-tap can't answer the next dialog before the user
// has a chance to see its prompt.
let keyGuardUntil = 0;
const KEY_GUARD_MS = 150;

function current(): PendingConfirm | undefined {
  return queue()[0];
}

/** A dialog title as its button: "Delete schedule?" → "Delete schedule". */
const actionLabel = (title: string) => title.replace(/\?\s*$/, "");

/** Show a confirm dialog and return a promise that resolves to true/false */
export function confirm(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    setQueue((q) => [...q, { opts, resolve }]);
    setIsOpen(true);
  });
}

/**
 * Shorthand for a destructive confirm.
 * Backwards-compat: accepts either an options object or positional
 * (title, message) arguments.
 */
export function confirmDanger(
  arg1: string | (Omit<ConfirmOptions, "danger"> & Partial<Pick<ConfirmOptions, "danger">>),
  message?: string,
): Promise<boolean> {
  if (typeof arg1 === "string") {
    // The button names the action, as the title does: "Stop all containers", not "Delete".
    return confirm({ title: arg1, message: message ?? "", confirmLabel: actionLabel(arg1), danger: true });
  }
  return confirm({ ...arg1, confirmLabel: arg1.confirmLabel ?? actionLabel(arg1.title), danger: true });
}

function handleResult(result: boolean) {
  const head = current();
  setQueue((q) => q.slice(1));
  if (queue().length === 0) {
    setIsOpen(false);
  } else {
    // Queue still has items — a new head just became visible. Block
    // keyboard confirmation briefly so users don't auto-answer it.
    keyGuardUntil = performance.now() + KEY_GUARD_MS;
  }
  head?.resolve(result);
}

/** Render this component once at the app root */
export default function ConfirmDialog() {
  let mouseDownOnOverlay = false;
  let confirmBtnRef: HTMLButtonElement | undefined;

  const onKey = (e: KeyboardEvent) => {
    if (!isOpen()) return;
    if (e.key === "Escape") {
      if (performance.now() < keyGuardUntil) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      handleResult(false);
    } else if (e.key === "Enter") {
      // Only react if focus isn't inside another input inside the dialog.
      const target = e.target as HTMLElement | null;
      if (
        target
        && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }
      // Swallow Enter during the guard window so a rapid double-tap can't
      // blow through two queued dialogs without the user seeing the second.
      if (performance.now() < keyGuardUntil) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      handleResult(true);
    }
  };

  onMount(() => {
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });

  return (
    <Show when={isOpen() && current()}>
      {(head) => {
        // Focus the confirm button when the dialog appears so Enter works.
        queueMicrotask(() => confirmBtnRef?.focus());
        const opts = () => head().opts;
        return (
          <div
            class="modal-overlay"
            data-own-escape
            onMouseDown={(e) => {
              mouseDownOnOverlay = (e.target as HTMLElement).classList.contains("modal-overlay");
            }}
            onClick={(e) => {
              if (mouseDownOnOverlay && (e.target as HTMLElement).classList.contains("modal-overlay")) {
                handleResult(false);
              }
              mouseDownOnOverlay = false;
            }}
          >
            <div class="modal-dialog" style={{ "max-width": opts().width ?? "440px", width: opts().width }} role="dialog" aria-modal="true">
              <div class="modal-header">
                <span class="modal-title">{opts().title}</span>
                <button class="modal-close" onClick={() => handleResult(false)} aria-label="Close">
                  {"\u00d7"}
                </button>
              </div>
              <div class="modal-body">
                <p class="selectable" style={{ "line-height": "1.5", "white-space": "pre-wrap" }}>
                  {opts().message}
                </p>
                <Show when={opts().details}>
                  {(md) => (
                    <div
                      class="markdown selectable"
                      // eslint-disable-next-line solid/no-innerhtml -- sanitized by renderMarkdown (DOMPurify)
                      innerHTML={renderMarkdown(md())}
                      onClick={(e) => {
                        const a = (e.target as HTMLElement).closest("a");
                        if (!a) return;
                        e.preventDefault();
                        shellOpen(a.href).catch(() => window.open(a.href, "_blank", "noopener,noreferrer"));
                      }}
                    />
                  )}
                </Show>
              </div>
              <div class="modal-footer">
                <button class="btn" onClick={() => handleResult(false)}>
                  {opts().cancelLabel || "Cancel"}
                </button>
                <button
                  ref={(el) => (confirmBtnRef = el)}
                  class={opts().danger ? "btn" : "btn btn-primary"}
                  style={opts().danger ? { background: "#da3633", color: "#fff", border: "1px solid #da3633" } : {}}
                  onClick={() => handleResult(true)}
                >
                  {opts().confirmLabel || "Confirm"}
                </button>
              </div>
            </div>
          </div>
        );
      }}
    </Show>
  );
}
