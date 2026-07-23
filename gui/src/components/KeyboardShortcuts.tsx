import { For, onMount, onCleanup } from "solid-js";
import { t } from "../i18n";

interface ShortcutGroup {
  title: string;
  shortcuts: Array<{ keys: string[]; description: string }>;
}

const isMac = navigator.platform.includes("Mac");
const modKey = isMac ? "\u2318" : "Ctrl";

const shortcutGroups = (): ShortcutGroup[] => [
  {
    title: t("components.shortcuts.navigation"),
    shortcuts: [
      { keys: [modKey, "K"], description: t("components.shortcuts.commandPalette") },
      { keys: [modKey, "R"], description: t("components.shortcuts.refreshPage") },
      { keys: ["Esc"], description: t("components.shortcuts.closeOrBack") },
    ],
  },
  {
    title: t("components.shortcuts.logs"),
    shortcuts: [
      { keys: [modKey, "F"], description: t("components.shortcuts.filterLogs") },
      { keys: ["+", "-"], description: t("components.shortcuts.adjustFont") },
    ],
  },
  {
    title: t("components.shortcuts.general"),
    shortcuts: [
      { keys: ["?"], description: t("components.shortcuts.show") },
    ],
  },
];

interface KeyboardShortcutsProps {
  onClose: () => void;
}

export default function KeyboardShortcuts(props: KeyboardShortcutsProps) {
  let mouseDownOnOverlay = false;

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" || e.key === "?") {
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
    }
  };

  onMount(() => {
    document.addEventListener("keydown", handleKeyDown, true);
    onCleanup(() => document.removeEventListener("keydown", handleKeyDown, true));
  });

  const handleOverlayMouseDown = (e: MouseEvent) => {
    mouseDownOnOverlay = (e.target as HTMLElement).getAttribute("data-overlay") === "true";
  };

  const handleOverlayClick = (e: MouseEvent) => {
    if (mouseDownOnOverlay && (e.target as HTMLElement).getAttribute("data-overlay") === "true") {
      props.onClose();
    }
    mouseDownOnOverlay = false;
  };

  return (
    <div
      data-overlay="true"
      onMouseDown={handleOverlayMouseDown}
      onClick={handleOverlayClick}
      style={{
        position: "fixed",
        inset: "0",
        background: "rgba(0, 0, 0, 0.6)",
        display: "flex",
        "align-items": "center",
        "justify-content": "center",
        "z-index": "10000",
      }}
    >
      <div style={{
        background: "#161b22",
        border: "1px solid #30363d",
        "border-radius": "12px",
        padding: "24px 28px",
        "min-width": "400px",
        "max-width": "520px",
        "box-shadow": "0 16px 48px rgba(0, 0, 0, 0.5)",
      }}>
        <div style={{
          display: "flex",
          "align-items": "center",
          "justify-content": "space-between",
          "margin-bottom": "20px",
        }}>
          <h2 style={{ margin: "0", "font-size": "16px", "font-weight": "600", color: "#e6edf3" }}>
            Keyboard Shortcuts
          </h2>
          <button
            onClick={() => props.onClose()}
            style={{
              background: "none",
              border: "none",
              color: "#8b949e",
              cursor: "pointer",
              "font-size": "18px",
              padding: "2px 6px",
              "border-radius": "4px",
            }}
          >
            {"\u00d7"}
          </button>
        </div>

        <For each={shortcutGroups()}>
          {(group) => (
            <div style={{ "margin-bottom": "16px" }}>
              <div style={{
                "font-size": "11px",
                "font-weight": "600",
                color: "#8b949e",
                "text-transform": "uppercase",
                "letter-spacing": "0.5px",
                "margin-bottom": "8px",
              }}>
                {group.title}
              </div>
              <For each={group.shortcuts}>
                {(shortcut) => (
                  <div style={{
                    display: "flex",
                    "align-items": "center",
                    "justify-content": "space-between",
                    padding: "6px 0",
                  }}>
                    <span style={{ "font-size": "13px", color: "#c9d1d9" }}>
                      {shortcut.description}
                    </span>
                    <div style={{ display: "flex", gap: "4px" }}>
                      <For each={shortcut.keys}>
                        {(key) => (
                          <kbd style={{
                            background: "#21262d",
                            border: "1px solid #30363d",
                            "border-radius": "4px",
                            padding: "2px 6px",
                            "font-size": "11px",
                            "font-family": "monospace",
                            color: "#c9d1d9",
                            "line-height": "1.4",
                            "min-width": "18px",
                            "text-align": "center",
                            "box-shadow": "0 1px 0 rgba(0,0,0,0.3)",
                          }}>
                            {key}
                          </kbd>
                        )}
                      </For>
                    </div>
                  </div>
                )}
              </For>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
