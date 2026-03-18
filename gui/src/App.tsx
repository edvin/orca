import { createSignal, onMount, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { startEventSubscription } from "./lib/events";
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
import type { EnvironmentStatus } from "./lib/types";

export type Page = "stacks" | "containers" | "images" | "volumes" | "networks" | "kubernetes" | "machine" | "environment" | "settings";

export default function App() {
  const [page, setPage] = createSignal<Page>("stacks");
  const [daemonStatus, setDaemonStatus] = createSignal<string>("connecting");

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
      const searchInput = document.querySelector(".search-input") as HTMLInputElement | null;
      if (searchInput) {
        searchInput.focus();
        searchInput.select();
      }
    }
  };

  const checkEnvironment = async () => {
    try {
      const envStatus = (await invoke("env_status")) as EnvironmentStatus;
      if (!envStatus.ready) {
        setPage("environment");
      } else {
        const warnings = envStatus.checks.filter((c) => c.status === "Warning");
        if (warnings.length > 0) {
          showToast(
            `Environment has ${warnings.length} warning${warnings.length > 1 ? "s" : ""} \u2014 check Environment page`,
            "info"
          );
        }
      }
    } catch {
      // Daemon not ready yet, ignore
    }
  };

  onMount(() => {
    startEventSubscription();
    // Initial daemon check, then verify environment readiness
    checkDaemon().then(() => {
      if (daemonStatus() === "running") {
        checkEnvironment();
      }
    });
    const interval = setInterval(checkDaemon, 5000);
    document.addEventListener("keydown", handleGlobalKeyDown);
    onCleanup(() => {
      clearInterval(interval);
      document.removeEventListener("keydown", handleGlobalKeyDown);
    });
  });

  return (
    <div class="app-root">
      <Titlebar daemonStatus={daemonStatus()} />
      <div class="app-body">
        <Sidebar
          currentPage={page()}
          onNavigate={setPage}
          daemonStatus={daemonStatus()}
        />
        <main class="app-main">
          {page() === "stacks" && <StacksPage />}
          {page() === "containers" && <ContainersPage />}
          {page() === "images" && <ImagesPage />}
          {page() === "volumes" && <VolumesPage />}
          {page() === "networks" && <NetworksPage />}
          {page() === "kubernetes" && <KubernetesPage />}
          {page() === "machine" && <MachinePage />}
          {page() === "environment" && <EnvironmentPage />}
          {page() === "settings" && <SettingsPage />}
        </main>
      </div>
      <ToastContainer />
    </div>
  );
}
