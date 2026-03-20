import { createSignal, Show } from "solid-js";

interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

type ResolverFn = (result: boolean) => void;

const [isOpen, setIsOpen] = createSignal(false);
const [options, setOptions] = createSignal<ConfirmOptions>({
  title: "",
  message: "",
});
let resolver: ResolverFn | null = null;

/** Show a confirm dialog and return a promise that resolves to true/false */
export function confirm(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    resolver = resolve;
    setOptions(opts);
    setIsOpen(true);
  });
}

/** Shorthand for a destructive confirm */
export function confirmDanger(title: string, message: string): Promise<boolean> {
  return confirm({ title, message, confirmLabel: "Delete", danger: true });
}

function handleResult(result: boolean) {
  setIsOpen(false);
  resolver?.(result);
  resolver = null;
}

/** Render this component once at the app root */
export default function ConfirmDialog() {
  let mouseDownOnOverlay = false;

  return (
    <Show when={isOpen()}>
      <div
        class="modal-overlay"
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
        <div class="modal-dialog" style={{ "max-width": "440px" }}>
          <div class="modal-header">
            <span class="modal-title">{options().title}</span>
            <button class="modal-close" onClick={() => handleResult(false)}>
              {"\u00d7"}
            </button>
          </div>
          <div class="modal-body">
            <p style={{ "line-height": "1.5", "white-space": "pre-wrap" }}>
              {options().message}
            </p>
          </div>
          <div class="modal-footer">
            <button class="btn" onClick={() => handleResult(false)}>
              {options().cancelLabel || "Cancel"}
            </button>
            <button
              class={options().danger ? "btn" : "btn btn-primary"}
              style={options().danger ? { background: "#da3633", color: "#fff", border: "1px solid #da3633" } : {}}
              onClick={() => handleResult(true)}
            >
              {options().confirmLabel || "Confirm"}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}
