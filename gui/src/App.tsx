import { createSignal, createEffect, onMount, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { startEventSubscription, onOrcaEvent } from "./lib/events";
import { addEvent } from "./lib/activityStore";
import Titlebar from "./components/Titlebar";
import Sidebar from "./components/Sidebar";
import ToastContainer, { showToast } from "./components/Toast";
import StacksPage from "./pages/StacksPage";
import ContainersPage from "./pages/ContainersPage";
import ImagesPage from "./pages/ImagesPage";
import VolumesPage from "./pages/VolumesPage";
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
import type { EnvironmentStatus } from "./lib/types";

export type Page = "dashboard" | "templates" | "stacks" | "containers" | "images" | "volumes" | "networks" | "kubernetes" | "machine" | "environment" | "activity" | "settings";

export default function App() {
  const [page, setPage] = createSignal<Page>("dashboard");
  const [daemonStatus, setDaemonStatus] = createSignal<string>("connecting");
  const [showCommandPalette, setShowCommandPalette] = createSignal(false);
  const [environmentChecked, setEnvironmentChecked] = createSignal(false);

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
  };

  const checkEnvironment = async () => {
    if (environmentChecked()) return;
    try {
      const envStatus = (await invoke("env_status")) as EnvironmentStatus;
      setEnvironmentChecked(true);
      if (!envStatus.ready) {
        setPage("environment");
        showToast("Setup required — follow the steps to get started", "info");
      } else {
        const warnings = envStatus.checks.filter((c) => c.status === "Warning");
        if (warnings.length > 0) {
          showToast(
            `Environment has ${warnings.length} warning${warnings.length > 1 ? "s" : ""} — check Environment page`,
            "info"
          );
        }
      }
    } catch {
      // Daemon returned error, will retry next time
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

  return (
    <div class="app-root">
      <Titlebar daemonStatus={daemonStatus()} onNavigate={(p) => setPage(p as Page)} />
      {daemonStatus() !== "running" ? (
        <ConnectionScreen status={daemonStatus()} onRetry={checkDaemon} />
      ) : (
        <>
          <div class="app-body">
            <Sidebar
              currentPage={page()}
              onNavigate={setPage}
              daemonStatus={daemonStatus()}
            />
            <main class="app-main">
              {page() === "dashboard" && <DashboardPage onNavigate={(p) => setPage(p as Page)} />}
              {page() === "templates" && <TemplatesPage />}
              {page() === "stacks" && <StacksPage />}
              {page() === "containers" && <ContainersPage onNavigate={(p) => setPage(p as Page)} />}
              {page() === "images" && <ImagesPage />}
              {page() === "volumes" && <VolumesPage />}
              {page() === "networks" && <NetworksPage />}
              {page() === "kubernetes" && <KubernetesPage />}
              {page() === "machine" && <MachinePage />}
              {page() === "environment" && <EnvironmentPage />}
              {page() === "activity" && <ActivityPage />}
              {page() === "settings" && <SettingsPage />}
            </main>
          </div>
          {showCommandPalette() && (
            <CommandPalette
              onClose={() => setShowCommandPalette(false)}
              onNavigate={(p) => setPage(p)}
            />
          )}
          <AiAssistant onNavigate={(p) => setPage(p as Page)} />
        </>
      )}
      <ToastContainer />
    </div>
  );
}
