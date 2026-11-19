import { showToast } from "../components/Toast";
import { t } from "./i18n";

export async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(t("Copied!"), "success");
  } catch {
    // Fallback for non-HTTPS contexts
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      showToast(t("Copied!"), "success");
    } catch {
      showToast(t("Failed to copy to clipboard"), "error");
    }
  }
}
