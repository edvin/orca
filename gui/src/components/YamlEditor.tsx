import { createSignal, onMount, onCleanup, Show } from "solid-js";
import * as monaco from "monaco-editor";

// Configure Monaco workers for Vite bundling
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";

(self as any).MonacoEnvironment = {
  getWorker(_: string, label: string) {
    if (label === "json") return new jsonWorker();
    return new editorWorker();
  },
};

interface YamlEditorProps {
  value: string;
  readOnly?: boolean;
  height?: string;
  onSave?: (value: string) => void;
  onClose?: () => void;
  title?: string;
}

export default function YamlEditor(props: YamlEditorProps) {
  let containerRef: HTMLDivElement | undefined;
  let editorInstance: any = null;
  const [saving, setSaving] = createSignal(false);
  const [modified, setModified] = createSignal(false);

  const [loadError, setLoadError] = createSignal<string | null>(null);

  onMount(() => {
    try {
    // Configure YAML-friendly dark theme
    monaco.editor.defineTheme("orca-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [],
      colors: {
        "editor.background": "#0d1117",
        "editor.foreground": "#e6edf3",
        "editor.lineHighlightBackground": "#161b2255",
        "editorLineNumber.foreground": "#484f58",
        "editorLineNumber.activeForeground": "#8b949e",
        "editor.selectionBackground": "#1f6feb44",
        "editorCursor.foreground": "#58a6ff",
        "editorWidget.background": "#161b22",
        "editorWidget.border": "#30363d",
        "input.background": "#0d1117",
        "input.border": "#30363d",
        "dropdown.background": "#161b22",
      },
    });

    editorInstance = monaco.editor.create(containerRef!, {
      value: props.value,
      language: "yaml",
      theme: "orca-dark",
      readOnly: props.readOnly ?? false,
      minimap: { enabled: false },
      fontSize: 13,
      fontFamily: "'JetBrains Mono NF', monospace",
      lineNumbers: "on",
      scrollBeyondLastLine: false,
      wordWrap: "on",
      automaticLayout: true,
      tabSize: 2,
      renderLineHighlight: "line",
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      scrollbar: {
        verticalScrollbarSize: 6,
        horizontalScrollbarSize: 6,
      },
      padding: { top: 8, bottom: 8 },
    });

    editorInstance.onDidChangeModelContent(() => {
      setModified(editorInstance.getValue() !== props.value);
    });

    // Ctrl+S to save
    editorInstance.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      () => {
        if (props.onSave && !props.readOnly) {
          handleSave();
        }
      }
    );

    onCleanup(() => {
      editorInstance?.dispose();
    });
    } catch (e) {
      setLoadError(String(e));
    }
  });

  const handleSave = async () => {
    if (!props.onSave || !editorInstance) return;
    setSaving(true);
    try {
      await props.onSave(editorInstance.getValue());
      setModified(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: "flex", "flex-direction": "column", height: "100%" }}>
      <Show when={props.title || props.onSave || props.onClose}>
        <div style={{
          display: "flex", "align-items": "center", "justify-content": "space-between",
          padding: "8px 12px", background: "#161b22", "border-bottom": "1px solid #21262d",
        }}>
          <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
            <span style={{ "font-size": "13px", "font-weight": "600", color: "#e6edf3" }}>
              {props.title || "YAML Editor"}
            </span>
            <Show when={modified()}>
              <span style={{ "font-size": "11px", color: "#d29922" }}>(modified)</span>
            </Show>
          </div>
          <div style={{ display: "flex", gap: "6px" }}>
            <Show when={props.onSave && !props.readOnly}>
              <button
                class="btn btn-sm btn-primary"
                onClick={handleSave}
                disabled={saving() || !modified()}
                style={{ "font-size": "11px" }}
              >
                {saving() ? "Applying..." : "Apply Changes"}
              </button>
            </Show>
            <Show when={props.onClose}>
              <button class="btn btn-sm" onClick={props.onClose} style={{ "font-size": "11px" }}>
                Close
              </button>
            </Show>
          </div>
        </div>
      </Show>
      <Show when={loadError()}>
        <div style={{
          padding: "16px", color: "#f85149", background: "rgba(248,81,73,0.08)",
          border: "1px solid rgba(248,81,73,0.2)", "border-radius": "8px", margin: "12px",
        }}>
          <strong>Editor failed to load:</strong> {loadError()}
          <pre style={{
            "margin-top": "12px", background: "#0d1117", padding: "12px", "border-radius": "6px",
            "font-family": "'JetBrains Mono NF', monospace", "font-size": "12px",
            color: "#c9d1d9", "white-space": "pre-wrap", "word-break": "break-all",
            "max-height": "60vh", overflow: "auto",
          }}>{props.value}</pre>
        </div>
      </Show>
      <Show when={!loadError()}>
        <div
          ref={containerRef}
          style={{ flex: "1", "min-height": props.height || "300px" }}
        />
      </Show>
    </div>
  );
}
