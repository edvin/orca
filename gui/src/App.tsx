import { createSignal, onMount, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { startEventSubscription } from "./lib/events";
import Sidebar from "./components/Sidebar";
import StacksPage from "./pages/StacksPage";
import ContainersPage from "./pages/ContainersPage";
import ImagesPage from "./pages/ImagesPage";
import VolumesPage from "./pages/VolumesPage";
import NetworksPage from "./pages/NetworksPage";
import MachinePage from "./pages/MachinePage";

export type Page = "stacks" | "containers" | "images" | "volumes" | "networks" | "machine";

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

  onMount(() => {
    checkDaemon();
    startEventSubscription();
    const interval = setInterval(checkDaemon, 5000);
    onCleanup(() => clearInterval(interval));
  });

  return (
    <div style={{ display: "flex", height: "100vh" }}>
      <Sidebar
        currentPage={page()}
        onNavigate={setPage}
        daemonStatus={daemonStatus()}
      />
      <main
        style={{
          flex: 1,
          padding: "24px",
          overflow: "auto",
          background: "#0d1117",
        }}
      >
        {page() === "stacks" && <StacksPage />}
        {page() === "containers" && <ContainersPage />}
        {page() === "images" && <ImagesPage />}
        {page() === "volumes" && <VolumesPage />}
        {page() === "networks" && <NetworksPage />}
        {page() === "machine" && <MachinePage />}
      </main>
    </div>
  );
}
