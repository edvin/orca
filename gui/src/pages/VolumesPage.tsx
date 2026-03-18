import { createSignal, onMount } from "solid-js";

export default function VolumesPage() {
  const [volumes, setVolumes] = createSignal<any[]>([]);

  onMount(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke("list_volumes") as any[];
      setVolumes(result);
    } catch (e) {
      console.error("Failed to list volumes:", e);
    }
  });

  return (
    <div>
      <h1 style={{ "font-size": "24px", "margin-bottom": "20px" }}>Volumes</h1>

      {volumes().length === 0 ? (
        <div style={{ "text-align": "center", padding: "60px 20px", color: "#848d97" }}>
          <p style={{ "font-size": "18px", "margin-bottom": "8px" }}>No volumes</p>
          <p>Volumes will appear here when containers create them.</p>
        </div>
      ) : null}
    </div>
  );
}
