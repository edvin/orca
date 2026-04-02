import { onMount } from "solid-js";
import { logError } from "../lib/activityStore";
import { showToast } from "./Toast";

interface AiAssistantProps {
  onNavigate?: (page: string) => void;
  ref?: (api: AiAssistantApi) => void;
}

export interface AiAssistantApi {
  askAboutContainer: (containerId: string, containerName: string, image: string) => void;
  askAboutBuild: (tag: string, error: string, logTail: string) => void;
}

/** Opens the AI assistant in a separate window */
export async function openAiWindow() {
  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");

    // Check if the window already exists
    const existing = await WebviewWindow.getByLabel("ai-assistant");
    if (existing) {
      await existing.setFocus();
      return;
    }

    // Create a new window
    const isMac = navigator.platform.includes("Mac");
    const win = new WebviewWindow("ai-assistant", {
      url: "index.html#ai",
      title: "Orca Desktop AI",
      width: 480,
      height: 640,
      minWidth: 360,
      minHeight: 400,
      decorations: isMac,
      transparent: !isMac,
      resizable: true,
      center: false,
      x: window.screenX + window.outerWidth - 500,
      y: window.screenY + 60,
    });

    // Listen for creation errors
    win.once("tauri://error", (e) => {
      logError(`AI window creation failed: ${JSON.stringify(e.payload)}`);
      showToast(`Failed to open AI window: ${JSON.stringify(e.payload)}`, "error");
    });

  } catch (e) {
    const msg = String(e);
    logError(`Failed to open AI window: ${msg}`);
    showToast(`Failed to open AI window: ${msg}`, "error");
  }
}

export default function AiAssistant(props: AiAssistantProps) {
  const askAboutContainer = async (containerId: string, containerName: string, image: string) => {
    await openAiWindow();
    setTimeout(async () => {
      try {
        const { emit } = await import("@tauri-apps/api/event");
        await emit("ai-ask-container", { containerId, containerName, image });
      } catch (e) {
        logError(`Failed to send container context to AI: ${e}`);
      }
    }, 500);
  };

  const askAboutBuild = async (tag: string, error: string, logTail: string) => {
    await openAiWindow();
    setTimeout(async () => {
      try {
        const { emit } = await import("@tauri-apps/api/event");
        await emit("ai-ask-build", { tag, error, logTail });
      } catch (e) {
        logError(`Failed to send build context to AI: ${e}`);
      }
    }, 500);
  };

  // Pass API ref to parent via callback
  onMount(() => {
    props.ref?.({ askAboutContainer, askAboutBuild });
  });

  return null;
}
