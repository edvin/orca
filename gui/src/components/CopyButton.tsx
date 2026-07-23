import { createSignal } from "solid-js";
import { copyToClipboard } from "../lib/clipboard";
import { t } from "../i18n";

interface CopyButtonProps {
  text: string;
  label?: string;
}

export default function CopyButton(props: CopyButtonProps) {
  const [copied, setCopied] = createSignal(false);

  const handleClick = async (e: MouseEvent) => {
    e.stopPropagation();
    await copyToClipboard(props.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      class="btn btn-sm copy-btn"
      onClick={handleClick}
      title={props.label || t("components.copy.clipboard")}
      style={{
        padding: "2px 6px",
        "font-size": "11px",
        "min-width": "auto",
        "line-height": "1",
        opacity: copied() ? "1" : "0.6",
        transition: "opacity 0.15s ease",
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = "1"; }}
      onMouseLeave={(e) => { if (!copied()) (e.currentTarget as HTMLElement).style.opacity = "0.6"; }}
    >
      {copied() ? "\u2713" : "\u2398"}
    </button>
  );
}
