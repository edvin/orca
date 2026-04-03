import { createSignal, For, Show, onMount, onCleanup } from "solid-js";

interface DropdownOption {
  value: string;
  label: string;
}

interface DropdownProps {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  style?: Record<string, string>;
}

export default function Dropdown(props: DropdownProps) {
  const [open, setOpen] = createSignal(false);
  let wrapperRef: HTMLDivElement | undefined;

  const selectedLabel = () =>
    props.options.find((o) => o.value === props.value)?.label || props.value || props.placeholder || "Select...";

  const handleClickOutside = (e: MouseEvent) => {
    if (open() && wrapperRef && !wrapperRef.contains(e.target as Node)) {
      setOpen(false);
    }
  };

  onMount(() => {
    document.addEventListener("mousedown", handleClickOutside);
    onCleanup(() => document.removeEventListener("mousedown", handleClickOutside));
  });

  return (
    <div ref={wrapperRef} class="custom-dropdown" style={props.style}>
      <button
        type="button"
        class="custom-dropdown-trigger form-input"
        onClick={() => setOpen(!open())}
      >
        <span class="custom-dropdown-value">{selectedLabel()}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="custom-dropdown-arrow" style={{ transform: open() ? "rotate(180deg)" : "none" }}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      <Show when={open()}>
        <div class="custom-dropdown-menu">
          <For each={props.options}>
            {(opt) => (
              <div
                class={`custom-dropdown-item ${opt.value === props.value ? "active" : ""}`}
                onClick={() => {
                  props.onChange(opt.value);
                  setOpen(false);
                }}
              >
                {opt.label}
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
