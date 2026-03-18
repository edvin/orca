import { createSignal, onMount } from "solid-js";
import Sidebar from "./components/Sidebar";
import ContainersPage from "./pages/ContainersPage";
import ImagesPage from "./pages/ImagesPage";
import VolumesPage from "./pages/VolumesPage";
import MachinePage from "./pages/MachinePage";

type Page = "containers" | "images" | "volumes" | "machine";

export default function App() {
  const [page, setPage] = createSignal<Page>("containers");
  const [daemonStatus, setDaemonStatus] = createSignal<string>("checking...");

  onMount(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const status = await invoke("get_status") as any;
      setDaemonStatus(status.daemon_running ? "running" : "stopped");
    } catch {
      setDaemonStatus("disconnected");
    }
  });

  return (
    <div style={{ display: "flex", height: "100vh" }}>
      <Sidebar currentPage={page()} onNavigate={setPage} daemonStatus={daemonStatus()} />
      <main style={{ flex: 1, padding: "24px", overflow: "auto" }}>
        {page() === "containers" && <ContainersPage />}
        {page() === "images" && <ImagesPage />}
        {page() === "volumes" && <VolumesPage />}
        {page() === "machine" && <MachinePage />}
      </main>
    </div>
  );
}
