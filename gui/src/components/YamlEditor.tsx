import { createSignal, onMount, onCleanup, Show } from "solid-js";
import * as monaco from "monaco-editor";

// Workers are configured by vite-plugin-monaco-editor

// Register YAML language with monarch tokenizer for syntax highlighting
let yamlRegistered = false;
function registerYaml() {
  if (yamlRegistered) return;
  yamlRegistered = true;
  monaco.languages.register({ id: "yaml" });
  monaco.languages.setMonarchTokensProvider("yaml", {
    tokenizer: {
      root: [
        [/#.*$/, "comment"],
        [/^---\s*$/, "keyword"],
        [/^\.\.\.\s*$/, "keyword"],
        [/\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?/, "number.date"],
        [/[^\s#:][^:]*(?=\s*:(\s|$))/, "type"],
        [/\b(true|false|yes|no|on|off|null|~)\b/i, "keyword"],
        [/[+-]?\d+(\.\d+)?([eE][+-]?\d+)?/, "number"],
        [/0[xX][0-9a-fA-F]+/, "number.hex"],
        [/"/, "string", "@doubleQuoteString"],
        [/'/, "string", "@singleQuoteString"],
        [/[&*][^\s]+/, "tag"],
        [/![^\s]+/, "tag"],
        [/[|>][+-]?\d*/, "operator"],
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
}

// Tokyo Night theme
const TOKYO_NIGHT: monaco.editor.IStandaloneThemeData = {
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
    { token: "type", foreground: "2ac3de" },
    { token: "tag", foreground: "f7768e" },
    { token: "operator", foreground: "89ddff" },
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
    "input.background": "#1a1b26",
    "input.border": "#3b4261",
    "dropdown.background": "#1a1b26",
    "scrollbarSlider.background": "#3b426180",
    "scrollbarSlider.hoverBackground": "#3b4261b3",
    "scrollbarSlider.activeBackground": "#3b4261",
  },
};

let themeRegistered = false;

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
  let editorInstance: monaco.editor.IStandaloneCodeEditor | null = null;
  const [saving, setSaving] = createSignal(false);
  const [modified, setModified] = createSignal(false);
  const [loadError, setLoadError] = createSignal<string | null>(null);

  onMount(() => {
    try {
      registerYaml();

      if (!themeRegistered) {
        monaco.editor.defineTheme("tokyo-night", TOKYO_NIGHT);
        themeRegistered = true;
      }

      editorInstance = monaco.editor.create(containerRef!, {
        value: props.value,
        language: "yaml",
        theme: "tokyo-night",
        readOnly: props.readOnly ?? false,
        minimap: { enabled: false },
        fontSize: 13,
        fontFamily: "'JetBrains Mono NF', 'JetBrains Mono', monospace",
        lineNumbers: "on",
        lineNumbersMinChars: 3,
        glyphMargin: false,
        folding: true,
        scrollBeyondLastLine: false,
        wordWrap: "on",
        automaticLayout: false,
        tabSize: 2,
        renderLineHighlight: props.readOnly ? "none" : "line",
        overviewRulerLanes: 0,
        overviewRulerBorder: false,
        hideCursorInOverviewRuler: true,
        dragAndDrop: false,
        contextmenu: false,
        // Disable sticky scroll — causes rendering artifacts in modal dialogs
        stickyScroll: { enabled: false },
        scrollbar: {
          verticalScrollbarSize: 8,
          horizontalScrollbarSize: 8,
        },
        padding: { top: 8, bottom: 8 },
        bracketPairColorization: { enabled: true },
      });

      const initialValue = props.value;
      editorInstance.onDidChangeModelContent(() => {
        setModified(editorInstance!.getValue() !== initialValue);
      });

      // Ctrl+S to save
      editorInstance.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
        () => {
          handleSave();
        }
      );

      // Manual layout — avoids the rendering artifacts from automaticLayout
      // in modal dialogs. We do an initial layout after the modal animation,
      // then observe container size changes.
      const doLayout = () => {
        if (editorInstance && containerRef) {
          editorInstance.layout({
            width: containerRef.clientWidth,
            height: containerRef.clientHeight,
          });
        }
      };

      // Force Monaco to re-measure all text by clearing and re-setting the value.
      // This fixes jumbled/overlapping text when the editor opens inside a modal
      // whose container dimensions aren't yet final at creation time.
      const forceRemeasure = () => {
        if (!editorInstance) return;
        doLayout();
        const currentValue = editorInstance.getValue();
        editorInstance.setValue("");
        editorInstance.setValue(currentValue);
      };

      // Initial layout: immediate + staggered timers to cover modal animations
      requestAnimationFrame(() => {
        forceRemeasure();
        // Cover CSS transitions / modal animation completion
        setTimeout(forceRemeasure, 100);
        setTimeout(forceRemeasure, 300);
      });

      const resizeObserver = new ResizeObserver(doLayout);
      if (containerRef) resizeObserver.observe(containerRef);

      onCleanup(() => {
        resizeObserver.disconnect();
        editorInstance?.dispose();
        editorInstance = null;
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
            <span style={{ "font-size": "13px", "font-weight": "600", color: "#a9b1d6" }}>
              {props.title || "YAML Editor"}
            </span>
            <Show when={modified()}>
              <span style={{ "font-size": "11px", color: "#e0af68" }}>(modified)</span>
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
              <button class="btn btn-sm" onClick={() => props.onClose?.()} style={{ "font-size": "11px" }}>
                Close
              </button>
            </Show>
          </div>
        </div>
      </Show>
      <Show when={loadError()}>
        <div style={{
          padding: "16px", color: "#f7768e", background: "rgba(247,118,142,0.08)",
          border: "1px solid rgba(247,118,142,0.2)", "border-radius": "8px", margin: "12px",
        }}>
          <strong>Editor failed to load:</strong> {loadError()}
          <pre style={{
            "margin-top": "12px", background: "#1a1b26", padding: "12px", "border-radius": "6px",
            "font-family": "'JetBrains Mono NF', monospace", "font-size": "12px",
            color: "#a9b1d6", "white-space": "pre-wrap", "word-break": "break-all",
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
