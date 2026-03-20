import { invoke } from "@tauri-apps/api/core";

interface AiAssistantProps {
  onNavigate?: (page: string) => void;
  ref?: (api: AiAssistantApi) => void;
}

export interface AiAssistantApi {
  askAboutContainer: (containerId: string, containerName: string, image: string) => void;
}

/** Opens the AI assistant in a separate window */
async function openAiWindow() {
  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");

    // Check if the window already exists
    const existing = await WebviewWindow.getByLabel("ai-assistant");
    if (existing) {
      await existing.setFocus();
      return;
    }

    // Create a new window
    new WebviewWindow("ai-assistant", {
      url: "index.html#ai",
      title: "Orca Desktop AI",
      width: 480,
      height: 640,
      minWidth: 360,
      minHeight: 400,
      decorations: false,
      transparent: true,
      resizable: true,
      center: false,
      x: window.screenX + window.outerWidth - 500,
      y: window.screenY + 60,
    });
  } catch (e) {
    console.error("Failed to open AI window:", e);
  }
}

export default function AiAssistant(props: AiAssistantProps) {
  const askAboutContainer = async (containerId: string, containerName: string, image: string) => {
    await openAiWindow();
    // Give the window a moment to initialize, then send the event
    setTimeout(async () => {
      try {
        const { emit } = await import("@tauri-apps/api/event");
        await emit("ai-ask-container", { containerId, containerName, image });
      } catch (e) {
        console.error("Failed to send container context:", e);
      }
    }, 500);
  };

  if (props.ref) {
    props.ref({ askAboutContainer });
  }

  return (
    <button
      class="ai-fab"
      onClick={openAiWindow}
      title="AI Assistant"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect width="16" height="12" x="4" y="8" rx="2"/>
        <path d="M2 14h2"/>
        <path d="M20 14h2"/>
        <path d="M15 13v2"/>
        <path d="M9 13v2"/>
        <path d="M12 8V4H8"/>
      </svg>
    </button>
  );
}
