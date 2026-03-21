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
import MachinePage from "./pages/MachinePage";
import SettingsPage from "./pages/SettingsPage";
import EnvironmentPage from "./pages/EnvironmentPage";
import ActivityPage from "./pages/ActivityPage";
import DashboardPage from "./pages/DashboardPage";
import TemplatesPage from "./pages/TemplatesPage";
import ConnectionScreen from "./components/ConnectionScreen";
import CommandPalette from "./components/CommandPalette";
import AiAssistant from "./components/AiAssistant";
import type { AiAssistantApi } from "./components/AiAssistant";
import type { EnvironmentStatus } from "./lib/types";

export type Page = "dashboard" | "templates" | "containers" | "container-detail" | "stack-detail" | "images" | "volumes" | "volume-detail" | "networks" | "kubernetes" | "environment" | "activity" | "settings";

export default function App() {
  const [page, setPage] = createSignal<Page>("dashboard");
  const [detailId, setDetailId] = createSignal<string | null>(null);
  const [daemonStatus, setDaemonStatus] = createSignal<string>("connecting");
  const [breadcrumbStack, setBreadcrumbStack] = createSignal<string | null>(null);
  const [showCommandPalette, setShowCommandPalette] = createSignal(false);
  const [environmentChecked, setEnvironmentChecked] = createSignal(false);
  let aiApi: AiAssistantApi | undefined;

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
  };

  const checkEnvironment = async () => {
    if (environmentChecked()) return;
    try {
      const envStatus = (await invoke("env_status")) as EnvironmentStatus;
      setEnvironmentChecked(true);
      if (!envStatus.ready) {
        setPage("environment");
      } else {
        // Environment says ready, but check if daemon can actually reach Docker
        try {
          const health = (await invoke("system_health")) as any;
          if (!health?.docker_connected) {
            setPage("environment");
            showToast("Docker detected but daemon not connected — check System Health", "info");
          }
        } catch {}
      }
    } catch {
      // Daemon returned error, will retry next time
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
    } else {
      setDetailId(null);
      setBreadcrumbStack(null);
      setPage(target as Page);
    }
  };

  // React to daemon status changes — when it becomes "running",
  // immediately check the environment
  createEffect(() => {
    if (daemonStatus() === "running" && !environmentChecked()) {
      checkEnvironment();
      startEventSubscription();
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

    // Try to auto-start daemon, then check status
    invoke("start_daemon").catch(() => {}).finally(() => {
      checkDaemon();
    });

    const interval = setInterval(() => {
      if (daemonStatus() !== "running") {
        checkDaemon();
      }
    }, 3000);

    document.addEventListener("keydown", handleGlobalKeyDown);
    onCleanup(() => {
      clearInterval(interval);
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
      await (win as any).startResizing?.("BottomRight")
        ?? (win as any).startDragging?.();
    } catch (err) {
      console.error("Resize failed:", err);
    }
  };

  // If loaded with #ai hash, render standalone AI window
  if (window.location.hash === "#ai") {
    return <AiWindow />;
  }

  return (
    <div class={`app-root ${navigator.platform.includes("Mac") ? "platform-macos" : ""}`}>
      <Titlebar daemonStatus={daemonStatus()} onNavigate={(p) => navigate(p)} />
      {daemonStatus() !== "running" ? (
        <ConnectionScreen status={daemonStatus()} onRetry={checkDaemon} />
      ) : (
        <>
          <div class="app-body">
            <Sidebar
              currentPage={page() === "container-detail" ? "containers" as Page : page() === "stack-detail" ? "containers" as Page : page() === "volume-detail" ? "volumes" as Page : page()}
              onNavigate={(p: Page) => navigate(p)}
              daemonStatus={daemonStatus()}
            />
            <main class="app-main">
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
              {page() === "images" && <ImagesPage autoOpenPull={detailId() === "pull"} onPullOpened={() => setDetailId(null)} />}
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
              {page() === "settings" && <SettingsPage />}
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
      <div class="resize-handle" onMouseDown={startResize} />
    </div>
  );
}
