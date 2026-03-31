import { createSignal, createEffect, onMount, onCleanup, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { startEventSubscription, onOrcaEvent } from "./lib/events";
import { addEvent } from "./lib/activityStore";
import { lazy } from "solid-js";
const AiWindow = lazy(() => import("./components/AiWindow"));
import Titlebar from "./components/Titlebar";
import StatusBar from "./components/StatusBar";
import Sidebar from "./components/Sidebar";
import ToastContainer, { showToast } from "./components/Toast";
import ConfirmDialog from "./components/ConfirmDialog";
import ContainersPage from "./pages/ContainersPage";
import ContainerDetailPage from "./pages/ContainerDetailPage";
import StackDetailPage from "./pages/StackDetailPage";
import ImagesPage from "./pages/ImagesPage";
import VolumesPage from "./pages/VolumesPage";
import VolumeDetailPage from "./pages/VolumeDetailPage";
import NetworksPage from "./pages/NetworksPage";
import KubernetesPage from "./pages/KubernetesPage";
import SettingsPage from "./pages/SettingsPage";
import EnvironmentPage from "./pages/EnvironmentPage";
import ActivityPage from "./pages/ActivityPage";
import DashboardPage from "./pages/DashboardPage";
import FleetPage from "./pages/FleetPage";
import TemplatesPage from "./pages/TemplatesPage";
import ConnectionScreen from "./components/ConnectionScreen";
import CommandPalette from "./components/CommandPalette";
import AiAssistant from "./components/AiAssistant";
import type { AiAssistantApi } from "./components/AiAssistant";
import type { EnvironmentStatus } from "./lib/types";
import KeyboardShortcuts from "./components/KeyboardShortcuts";

export type Page = "fleet" | "dashboard" | "templates" | "containers" | "container-detail" | "stack-detail" | "images" | "volumes" | "volume-detail" | "networks" | "kubernetes" | "environment" | "activity" | "settings";

export default function App() {
  const [page, setPage] = createSignal<Page>("dashboard");
  const [detailId, setDetailId] = createSignal<string | null>(null);
  const [daemonStatus, setDaemonStatus] = createSignal<string>("connecting");
  const [breadcrumbStack, setBreadcrumbStack] = createSignal<string | null>(null);
  const [showCommandPalette, setShowCommandPalette] = createSignal(false);
  const [showShortcuts, setShowShortcuts] = createSignal(false);
  const [environmentChecked, setEnvironmentChecked] = createSignal(false);
  const [startupStep, setStartupStep] = createSignal("Starting Orca...");
  let aiApi: AiAssistantApi | undefined;

  // Fleet health polling state
  const lastFleetStatus: Record<string, boolean> = {};
  const fleetStatusCount: Record<string, number> = {};
  let fleetPollInterval: ReturnType<typeof setInterval> | null = null;

  const pollFleetHealth = async () => {
    try {
      const hosts = (await invoke("probe_all_hosts")) as Array<{
        id: string | null;
        name: string;
        online: boolean;
        version: string | null;
      }>;
      // Only alert if there are remote hosts configured
      const hasRemotes = hosts.some((h) => h.id !== null);
      if (!hasRemotes) return;

      for (const host of hosts) {
        const key = host.id || "__local__";
        if (key in lastFleetStatus && lastFleetStatus[key] !== host.online) {
          // State changed — require 2 consecutive polls in the new state before alerting
          fleetStatusCount[key] = (fleetStatusCount[key] || 0) + 1;
          if (fleetStatusCount[key] >= 2) {
            if (host.online) {
              showToast(`${host.name} is back online`, "success");
            } else {
              showToast(`${host.name} is offline`, "error");
            }
            fleetStatusCount[key] = 0;
            lastFleetStatus[key] = host.online;
          }
        } else {
          fleetStatusCount[key] = 0;
          lastFleetStatus[key] = host.online;
        }
      }
    } catch {
      // Fleet polling failed silently — daemon may not support probe_all_hosts yet
    }
  };

  const checkDaemon = async () => {
    try {
      const status = (await invoke("get_status")) as any;
      setDaemonStatus(status.daemon_running ? "running" : "stopped");
    } catch {
      setDaemonStatus("disconnected");
    }
  };

  const handleGlobalKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      const overlay = document.querySelector(".modal-overlay") as HTMLElement | null;
      if (overlay) {
        const closeBtn = overlay.querySelector(".modal-close") as HTMLElement | null;
        if (closeBtn) closeBtn.click();
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "k") {
      e.preventDefault();
      setShowCommandPalette((v) => !v);
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "r") {
      e.preventDefault();
      document.dispatchEvent(new CustomEvent("orca-refresh"));
    }
    if (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const tag = (e.target as HTMLElement)?.tagName;
      const editable = (e.target as HTMLElement)?.getAttribute("contenteditable");
      if (tag !== "INPUT" && tag !== "TEXTAREA" && editable !== "true") {
        e.preventDefault();
        setShowShortcuts((v) => !v);
      }
    }
  };

  const checkEnvironment = async () => {
    if (environmentChecked()) return;
    setStartupStep("Checking environment...");

    // Timeout: if env check takes >15s, show the environment page anyway
    const timeout = setTimeout(() => {
      if (!environmentChecked()) {
        setStartupStep("Taking longer than expected...");
        setTimeout(() => {
          if (!environmentChecked()) {
            setEnvironmentChecked(true);
            setPage("environment");
          }
        }, 3000);
      }
    }, 15000);

    try {
      const envStatus = (await invoke("env_status")) as EnvironmentStatus;
      clearTimeout(timeout);
      setEnvironmentChecked(true);
      if (!envStatus.ready) {
        setPage("environment");
      } else {
        // Environment says ready, but check if daemon can actually reach Docker
        setStartupStep("Verifying Docker connection...");
        try {
          const health = (await invoke("system_health")) as any;
          if (!health?.docker_connected) {
            setPage("environment");
          }
        } catch {}
      }
    } catch {
      clearTimeout(timeout);
      // Daemon couldn't check environment — still show the app
      // The environment page will handle the error state
      setEnvironmentChecked(true);
      setPage("environment");
    }
  };

  const navigate = (target: string) => {
    if (target.startsWith("container:") && target.includes(",stack:")) {
      const [containerPart, stackPart] = target.split(",stack:");
      setDetailId(containerPart.replace("container:", ""));
      setBreadcrumbStack(stackPart);
      setPage("container-detail");
    } else if (target.startsWith("container:")) {
      setDetailId(target.split(":").slice(1).join(":"));
      setBreadcrumbStack(null);
      setPage("container-detail");
    } else if (target.startsWith("volume:")) {
      setDetailId(target.split(":").slice(1).join(":"));
      setBreadcrumbStack(null);
      setPage("volume-detail");
    } else if (target.startsWith("stack:")) {
      setDetailId(target.split(":").slice(1).join(":"));
      setBreadcrumbStack(null);
      setPage("stack-detail");
    } else if (target === "images:pull") {
      setDetailId("pull"); // Signal to ImagesPage to open pull dialog
      setPage("images");
    } else if (target.startsWith("settings:")) {
      setDetailId(target.split(":")[1]); // Signal to SettingsPage which tab to open
      setPage("settings");
    } else {
      setDetailId(null);
      setBreadcrumbStack(null);
      setPage(target as Page);
    }
  };

  // React to daemon status changes — when it becomes "running",
  // immediately check the environment and start fleet polling
  createEffect(() => {
    if (daemonStatus() === "running" && !environmentChecked()) {
      checkEnvironment();
      startEventSubscription();

      // Start fleet health polling (initial after 10s, then every 60s)
      if (!fleetPollInterval) {
        setTimeout(pollFleetHealth, 10000);
        fleetPollInterval = setInterval(pollFleetHealth, 60000);
      }
    }
  });

  onMount(() => {
    const unsubEvents = onOrcaEvent((payload: any) => {
      const eventType = payload?.type || payload?.Action || "";
      const name = payload?.name || payload?.Actor?.Attributes?.name || "";
      const reference = payload?.reference || payload?.Actor?.Attributes?.name || "";

      if (eventType === "container.died" || eventType === "die") {
        addEvent({ type: "container.died", title: `Container '${name}' exited`, severity: "error" });
        showToast(`Container '${name}' exited`, "error", {
          label: "View Logs",
          onClick: () => setPage("containers"),
        });
      } else if (eventType === "container.started" || eventType === "start") {
        addEvent({ type: "container.started", title: `Container '${name}' started`, severity: "success" });
      } else if (eventType === "image.pulled" || eventType === "pull") {
        addEvent({ type: "image.pulled", title: `Image pulled: ${reference}`, severity: "success" });
        showToast(`Image pulled: ${reference}`, "success");
      }
    });

    // Auto-start daemon with progress feedback
    const startAndWait = async () => {
      setStartupStep("Starting daemon...");
      try {
        await invoke("start_daemon");
      } catch {}

      // Poll for readiness
      setStartupStep("Waiting for daemon...");
      for (let i = 0; i < 10; i++) {
        try {
          const status = (await invoke("get_status")) as any;
          if (status.daemon_running) {
            setStartupStep("Connecting to Docker...");
            // On Windows, Docker in WSL might need a reconnect
            try { await invoke("reconnect_runtime"); } catch {}
            setDaemonStatus("running");
            return;
          }
        } catch {}
        if (i >= 3) setStartupStep("Starting daemon... (this may take a moment)");
        await new Promise(r => setTimeout(r, 500));
      }
      setDaemonStatus("stopped");
    };
    startAndWait();

    const interval = setInterval(() => {
      if (daemonStatus() !== "running") {
        checkDaemon();
      }
    }, 3000);

    document.addEventListener("keydown", handleGlobalKeyDown);
    onCleanup(() => {
      clearInterval(interval);
      if (fleetPollInterval) clearInterval(fleetPollInterval);
      document.removeEventListener("keydown", handleGlobalKeyDown);
      unsubEvents();
    });
  });

  const startResize = async (e: MouseEvent) => {
    e.preventDefault();
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      // Tauri 2 uses startResizing or the ResizeDirection enum
      const started = await (win as any).startResizing?.("BottomRight");
      if (started === undefined) await (win as any).startDragging?.();
    } catch (err) {
      console.error("Resize failed:", err);
    }
  };

  // If loaded with #ai hash, render standalone AI window
  const isAiWindow = window.location.hash === "#ai";

  return (
    <Show when={!isAiWindow} fallback={<AiWindow />}>
    <div class={`app-root ${navigator.platform.includes("Mac") ? "platform-macos" : ""}`}>
      <Titlebar daemonStatus={daemonStatus()} onNavigate={(p) => navigate(p)} />
      {daemonStatus() === "connecting" ? (
        <div style={{ display: "flex", "flex-direction": "column", "align-items": "center", "justify-content": "center", height: "calc(100vh - 40px)", gap: "16px" }}>
          <img src="/orca-logo-full.png" alt="Orca" style={{ width: "80px", height: "80px", "border-radius": "18px", opacity: "0.8" }} />
          <div style={{ color: "#8b949e", "font-size": "14px" }}>{startupStep()}</div>
        </div>
      ) : daemonStatus() !== "running" ? (
        <ConnectionScreen status={daemonStatus()} onRetry={checkDaemon} />
      ) : !environmentChecked() ? (
        <div style={{ display: "flex", "flex-direction": "column", "align-items": "center", "justify-content": "center", height: "calc(100vh - 40px)", gap: "16px" }}>
          <img src="/orca-logo-full.png" alt="Orca" style={{ width: "80px", height: "80px", "border-radius": "18px", opacity: "0.8" }} />
          <div style={{ color: "#8b949e", "font-size": "14px" }}>{startupStep()}</div>
        </div>
      ) : (
        <>
          <div class="app-body">
            <Sidebar
              currentPage={page() === "container-detail" ? "containers" as Page : page() === "stack-detail" ? "containers" as Page : page() === "volume-detail" ? "volumes" as Page : page()}
              onNavigate={(p: Page) => navigate(p)}
              daemonStatus={daemonStatus()}
            />
            <main class="app-main">
              {page() === "fleet" && <FleetPage onNavigate={(p) => navigate(p)} />}
              {page() === "dashboard" && <DashboardPage onNavigate={(p) => navigate(p)} />}
              {page() === "templates" && <TemplatesPage onNavigate={(p) => navigate(p)} />}
              {page() === "containers" && <ContainersPage onNavigate={(p) => navigate(p)} onAskAi={(id, name, image) => aiApi?.askAboutContainer(id, name, image)} />}
              {page() === "container-detail" && detailId() && (
                <ContainerDetailPage
                  containerId={detailId()!}
                  onBack={() => breadcrumbStack() ? navigate(`stack:${breadcrumbStack()}`) : navigate("containers")}
                  onNavigate={(p) => navigate(p)}
                  breadcrumbStack={breadcrumbStack()}
                />
              )}
              {page() === "stack-detail" && detailId() && (
                <StackDetailPage
                  stackName={detailId()!}
                  onBack={() => navigate("containers")}
                  onNavigate={(p) => navigate(p)}
                />
              )}
              {page() === "images" && <ImagesPage autoOpenPull={detailId() === "pull"} onPullOpened={() => setDetailId(null)} onNavigate={(p) => navigate(p)} />}
              {page() === "volumes" && <VolumesPage onNavigate={(p) => navigate(p)} />}
              {page() === "volume-detail" && detailId() && (
                <VolumeDetailPage
                  volumeName={detailId()!}
                  onBack={() => navigate("volumes")}
                  onNavigate={(p) => navigate(p)}
                />
              )}
              {page() === "networks" && <NetworksPage />}
              {page() === "kubernetes" && <KubernetesPage />}
              {/* Machine page merged into System Health */}
              {page() === "environment" && <EnvironmentPage />}
              {page() === "activity" && <ActivityPage />}
              {page() === "settings" && <SettingsPage initialTab={detailId() || undefined} onTabOpened={() => setDetailId(null)} />}
            </main>
          </div>
          {showCommandPalette() && (
            <CommandPalette
              onClose={() => setShowCommandPalette(false)}
              onNavigate={(p) => navigate(p)}
            />
          )}
          <AiAssistant onNavigate={(p: string) => navigate(p)} ref={(api) => { aiApi = api; }} />
        </>
      )}
      <StatusBar onNavigate={(p) => navigate(p)} />
      <ToastContainer />
      <ConfirmDialog />
      <Show when={showShortcuts()}>
        <KeyboardShortcuts onClose={() => setShowShortcuts(false)} />
      </Show>
      <div class="resize-handle" onMouseDown={startResize} />
    </div>
    </Show>
  );
}
