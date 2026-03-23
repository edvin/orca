import { createSignal, onMount, onCleanup, Show } from "solid-js";
import * as monaco from "monaco-editor";
import "monaco-editor/min/vs/editor/editor.main.css";

// Configure Monaco workers for Vite bundling
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";

(self as any).MonacoEnvironment = {
  getWorker(_: string, label: string) {
    if (label === "json") return new jsonWorker();
    return new editorWorker();
  },
};

// Register YAML language with monarch tokenizer for syntax highlighting
monaco.languages.register({ id: "yaml" });
monaco.languages.setMonarchTokensProvider("yaml", {
  tokenizer: {
    root: [
      // Comments
      [/#.*$/, "comment"],
      // Document markers
      [/^---\s*$/, "keyword"],
      [/^\.\.\.\s*$/, "keyword"],
      // Timestamps
      [/\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?/, "number.date"],
      // Keys (before colon)
      [/[^\s#:][^:]*(?=\s*:(\s|$))/, "type"],
      // Booleans
      [/\b(true|false|yes|no|on|off|null|~)\b/i, "keyword"],
      // Numbers
      [/[+-]?\d+(\.\d+)?([eE][+-]?\d+)?/, "number"],
      [/0[xX][0-9a-fA-F]+/, "number.hex"],
      [/0[oO][0-7]+/, "number.octal"],
      // Strings
      [/"/, "string", "@doubleQuoteString"],
      [/'/, "string", "@singleQuoteString"],
      // Anchors and aliases
      [/[&*][^\s]+/, "tag"],
      // Tags
      [/![^\s]+/, "tag"],
      // Block scalars
      [/[|>][+-]?\d*/, "operator"],
      // List items
      [/^\s*-\s/, "operator"],
    ],
    doubleQuoteString: [
      [/[^\\"]+/, "string"],
      [/\\./, "string.escape"],
      [/"/, "string", "@pop"],
    ],
    singleQuoteString: [
      [/[^\\']+/, "string"],
      [/\\./, "string.escape"],
      [/'/, "string", "@pop"],
    ],
  },
});

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
    // Configure YAML-friendly dark theme matching the app
    monaco.editor.defineTheme("orca-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "comment", foreground: "6e7681", fontStyle: "italic" },
        { token: "type", foreground: "79c0ff" },         // keys
        { token: "keyword", foreground: "ff7b72" },       // booleans, doc markers
        { token: "number", foreground: "d2a8ff" },        // numbers
        { token: "number.date", foreground: "d2a8ff" },   // timestamps
        { token: "string", foreground: "a5d6ff" },        // strings
        { token: "string.escape", foreground: "79c0ff" }, // escape sequences
        { token: "tag", foreground: "7ee787" },           // anchors, tags
        { token: "operator", foreground: "8b949e" },      // block scalars, list dashes
      ],
      colors: {
        "editor.background": "#0d1117",
        "editor.foreground": "#e6edf3",
        "editor.lineHighlightBackground": "#161b2266",
        "editor.lineHighlightBorder": "#00000000",
        "editorLineNumber.foreground": "#3b4048",
        "editorLineNumber.activeForeground": "#e6edf3",
        "editor.selectionBackground": "#1f6feb44",
        "editor.selectionHighlightBackground": "#1f6feb22",
        "editorCursor.foreground": "#58a6ff",
        "editorWidget.background": "#161b22",
        "editorWidget.border": "#30363d",
        "editorIndentGuide.background": "#21262d",
        "editorIndentGuide.activeBackground": "#30363d",
        "editorBracketMatch.background": "#1f6feb22",
        "editorBracketMatch.border": "#1f6feb66",
        "input.background": "#0d1117",
        "input.border": "#30363d",
        "dropdown.background": "#161b22",
        "scrollbarSlider.background": "#484f5833",
        "scrollbarSlider.hoverBackground": "#484f5866",
        "scrollbarSlider.activeBackground": "#484f5899",
      },
    });

    editorInstance = monaco.editor.create(containerRef!, {
      value: props.value,
      language: "yaml",
      theme: "orca-dark",
      readOnly: props.readOnly ?? false,
      minimap: { enabled: false },
      fontSize: 13,
      fontFamily: "'JetBrains Mono NF', 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      fontLigatures: false,
      lineNumbers: "on",
      lineNumbersMinChars: 3,
      glyphMargin: false,
      folding: true,
      foldingHighlight: false,
      scrollBeyondLastLine: false,
      wordWrap: "on",
      automaticLayout: false,
      tabSize: 2,
      renderLineHighlight: "line",
      renderLineHighlightOnlyWhenFocus: false,
      overviewRulerLanes: 0,
      overviewRulerBorder: false,
      hideCursorInOverviewRuler: true,
      dragAndDrop: false,
      links: false,
      occurrencesHighlight: "off" as any,
      selectionHighlight: false,
      matchBrackets: "never" as any,
      renderWhitespace: "none",
      guides: { indentation: true, bracketPairs: false },
      contextmenu: false,
      scrollbar: {
        verticalScrollbarSize: 6,
        horizontalScrollbarSize: 6,
        useShadows: false,
      },
      padding: { top: 8, bottom: 8 },
      smoothScrolling: true,
      cursorBlinking: "smooth",
      cursorSmoothCaretAnimation: "on",
      roundedSelection: true,
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

    // Manual layout on container resize (more reliable than automaticLayout)
    const resizeObserver = new ResizeObserver(() => {
      if (editorInstance && containerRef) {
        editorInstance.layout({
          width: containerRef.clientWidth,
          height: containerRef.clientHeight,
        });
      }
    });
    if (containerRef) resizeObserver.observe(containerRef);

    // Initial layout after a tick (modal animation may not be complete)
    requestAnimationFrame(() => {
      if (editorInstance && containerRef) {
        editorInstance.layout({
          width: containerRef.clientWidth,
          height: containerRef.clientHeight,
        });
      }
    });

    onCleanup(() => {
      resizeObserver.disconnect();
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
          style={{ flex: "1", "min-height": props.height || "300px", overflow: "hidden", position: "relative" }}
        />
      </Show>
    </div>
  );
}
