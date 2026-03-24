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
    // Tokyo Night theme — matches the controlpanel project
    monaco.editor.defineTheme("orca-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "", foreground: "a9b1d6" },
        { token: "comment", foreground: "565f89", fontStyle: "italic" },
        { token: "keyword", foreground: "bb9af7" },
        { token: "string", foreground: "9ece6a" },
        { token: "number", foreground: "ff9e64" },
        { token: "number.date", foreground: "ff9e64" },
        { token: "constant", foreground: "ff9e64" },
        { token: "type", foreground: "2ac3de" },         // YAML keys
        { token: "tag", foreground: "f7768e" },           // anchors, tags
        { token: "operator", foreground: "89ddff" },      // block scalars, list dashes
        { token: "string.escape", foreground: "89ddff" },
        { token: "variable", foreground: "c0caf5" },
        { token: "identifier", foreground: "a9b1d6" },
        { token: "function", foreground: "7aa2f7" },
        { token: "delimiter.bracket", foreground: "89ddff" },
        { token: "attribute.name", foreground: "bb9af7" },
        { token: "attribute.value", foreground: "9ece6a" },
      ],
      colors: {
        "editor.background": "#1a1b26",
        "editor.foreground": "#a9b1d6",
        "editor.lineHighlightBackground": "#1e2030",
        "editor.lineHighlightBorder": "#00000000",
        "editor.selectionBackground": "#33467c",
        "editor.selectionHighlightBackground": "#2f3549",
        "editor.inactiveSelectionBackground": "#292e42",
        "editorLineNumber.foreground": "#3b4261",
        "editorLineNumber.activeForeground": "#737aa2",
        "editorCursor.foreground": "#c0caf5",
        "editorWidget.background": "#1a1b26",
        "editorWidget.border": "#292e42",
        "editorIndentGuide.background": "#292e42",
        "editorIndentGuide.activeBackground": "#3b4261",
        "editorBracketMatch.background": "#1a1b2600",
        "editorBracketMatch.border": "#545c7e",
        "editorStickyScroll.background": "#1a1b26",
        "editorStickyScrollHover.background": "#1e2030",
        "input.background": "#1a1b26",
        "input.border": "#3b4261",
        "dropdown.background": "#1a1b26",
        "scrollbarSlider.background": "#3b426180",
        "scrollbarSlider.hoverBackground": "#3b4261b3",
        "scrollbarSlider.activeBackground": "#3b4261",
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
      guides: { indentation: true, bracketPairs: true },
      bracketPairColorization: { enabled: true },
      stickyScroll: { enabled: true },
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
          padding: "8px 12px", background: "#1a1b26", "border-bottom": "1px solid #292e42",
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
