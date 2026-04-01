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

  onMount(async () => {
    try {
      // Wait for the custom font to load before creating the editor.
      // Monaco measures character widths on creation — if the font isn't
      // loaded yet, it uses system font metrics, causing jumbled text,
      // wrong line heights, and scroll jumping.
      try {
        await document.fonts.load("13px 'JetBrains Mono NF'");
      } catch {
        // Font load failed or timed out — fall back to system monospace
      }

      registerYaml();

      if (!themeRegistered) {
        monaco.editor.defineTheme("tokyo-night", TOKYO_NIGHT);
        themeRegistered = true;
      }

      // Use the font only if it actually loaded, otherwise fall back to system mono
      const fontLoaded = document.fonts.check("13px 'JetBrains Mono NF'");
      const fontFamily = fontLoaded
        ? "'JetBrains Mono NF', monospace"
        : "'SF Mono', 'Cascadia Code', 'Consolas', 'Menlo', monospace";

      editorInstance = monaco.editor.create(containerRef!, {
        value: props.value,
        language: "yaml",
        theme: "tokyo-night",
        readOnly: props.readOnly ?? false,
        minimap: { enabled: false },
        fontSize: 13,
        fontFamily,
        fontLigatures: false,
        lineNumbers: "on",
        lineNumbersMinChars: 3,
        glyphMargin: false,
        folding: true,
        scrollBeyondLastLine: false,
        wordWrap: "on",
        automaticLayout: true,
        tabSize: 2,
        renderLineHighlight: props.readOnly ? "none" : "line",
        overviewRulerLanes: 0,
        overviewRulerBorder: false,
        hideCursorInOverviewRuler: true,
        dragAndDrop: false,
        contextmenu: false,
        stickyScroll: { enabled: false },
        scrollbar: {
          verticalScrollbarSize: 8,
          horizontalScrollbarSize: 8,
          useShadows: false,
        },
        padding: { top: 8, bottom: 8 },
        bracketPairColorization: { enabled: true },
        // Fixes scroll jumping — ensure Monaco uses consistent line height
        lineHeight: 20,
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

      // Force a layout + remeasure after the modal animation completes
      const forceRemeasure = () => {
        if (!editorInstance) return;
        editorInstance.layout();
        // Trigger font re-measurement
        editorInstance.updateOptions({ fontFamily });
      };

      requestAnimationFrame(() => {
        forceRemeasure();
        setTimeout(forceRemeasure, 150);
      });

      onCleanup(() => {
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
