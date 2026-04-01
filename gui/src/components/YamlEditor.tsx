import { createSignal, onMount, onCleanup, Show } from "solid-js";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, rectangularSelection } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { yaml } from "@codemirror/lang-yaml";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, foldGutter, HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";

// Tokyo Night theme for CodeMirror 6
const tokyoNightTheme = EditorView.theme({
  "&": {
    backgroundColor: "#1a1b26",
    color: "#a9b1d6",
  },
  ".cm-content": {
    caretColor: "#c0caf5",
    fontFamily: "'JetBrains Mono NF', 'JetBrains Mono', monospace",
    fontSize: "13px",
    lineHeight: "20px",
    padding: "8px 0",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "#c0caf5",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "#33467c",
  },
  ".cm-activeLine": {
    backgroundColor: "#1e2030",
  },
  ".cm-gutters": {
    backgroundColor: "#1a1b26",
    color: "#3b4261",
    borderRight: "1px solid #292e42",
    minWidth: "3ch",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "#1e2030",
    color: "#737aa2",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    padding: "0 8px 0 4px",
  },
  ".cm-foldGutter .cm-gutterElement": {
    color: "#3b4261",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily: "'JetBrains Mono NF', 'JetBrains Mono', monospace",
    fontSize: "13px",
  },
  ".cm-matchingBracket": {
    backgroundColor: "transparent",
    outline: "1px solid #545c7e",
  },
  // Scrollbar styling
  ".cm-scroller::-webkit-scrollbar": {
    width: "8px",
    height: "8px",
  },
  ".cm-scroller::-webkit-scrollbar-track": {
    background: "transparent",
  },
  ".cm-scroller::-webkit-scrollbar-thumb": {
    background: "#3b426180",
    borderRadius: "4px",
  },
  ".cm-scroller::-webkit-scrollbar-thumb:hover": {
    background: "#3b4261b3",
  },
});

// Tokyo Night syntax highlighting
const tokyoNightHighlighting = HighlightStyle.define([
  { tag: tags.comment, color: "#565f89", fontStyle: "italic" },
  { tag: tags.keyword, color: "#bb9af7" },
  { tag: tags.string, color: "#9ece6a" },
  { tag: tags.number, color: "#ff9e64" },
  { tag: tags.bool, color: "#ff9e64" },
  { tag: tags.null, color: "#bb9af7" },
  { tag: tags.propertyName, color: "#2ac3de" },
  { tag: tags.variableName, color: "#c0caf5" },
  { tag: tags.operator, color: "#89ddff" },
  { tag: tags.punctuation, color: "#89ddff" },
  { tag: tags.bracket, color: "#89ddff" },
  { tag: tags.tagName, color: "#f7768e" },
  { tag: tags.attributeName, color: "#bb9af7" },
  { tag: tags.attributeValue, color: "#9ece6a" },
  { tag: tags.definition(tags.variableName), color: "#7aa2f7" },
  { tag: tags.meta, color: "#f7768e" },
  { tag: tags.atom, color: "#bb9af7" },
]);

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
  let editorView: EditorView | null = null;
  const [saving, setSaving] = createSignal(false);
  const [modified, setModified] = createSignal(false);
  const [loadError, setLoadError] = createSignal<string | null>(null);

  const handleSave = async () => {
    if (!props.onSave || !editorView) return;
    setSaving(true);
    try {
      await props.onSave(editorView.state.doc.toString());
      setModified(false);
    } finally {
      setSaving(false);
    }
  };

  onMount(() => {
    try {
      const initialValue = props.value;

      const saveKeymap = keymap.of([
        {
          key: "Mod-s",
          run: () => {
            handleSave();
            return true;
          },
        },
      ]);

      const updateListener = EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          setModified(update.state.doc.toString() !== initialValue);
        }
      });

      const extensions = [
        lineNumbers(),
        highlightActiveLineGutter(),
        foldGutter(),
        drawSelection(),
        rectangularSelection(),
        bracketMatching(),
        highlightActiveLine(),
        yaml(),
        tokyoNightTheme,
        syntaxHighlighting(tokyoNightHighlighting),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([...defaultKeymap, indentWithTab]),
        saveKeymap,
        updateListener,
        EditorView.lineWrapping,
        EditorState.tabSize.of(2),
      ];

      if (props.readOnly) {
        extensions.push(EditorState.readOnly.of(true));
      }

      const state = EditorState.create({
        doc: props.value,
        extensions,
      });

      editorView = new EditorView({
        state,
        parent: containerRef!,
      });

      onCleanup(() => {
        editorView?.destroy();
        editorView = null;
      });
    } catch (e) {
      setLoadError(String(e));
    }
  });

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
