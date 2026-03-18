import { createSignal, onMount } from "solid-js";

export default function MachinePage() {
  const [machine, setMachine] = createSignal<any>(null);

  onMount(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const info = await invoke("get_machine_info");
      setMachine(info);
    } catch (e) {
      console.error("Failed to get machine info:", e);
    }
  });

  const m = () => machine();

  return (
    <div>
      <h1 style={{ "font-size": "24px", "margin-bottom": "20px" }}>Machine</h1>

      {m() ? (
        <div style={{
          background: "#161b22",
          border: "1px solid #30363d",
          "border-radius": "8px",
          padding: "24px",
          "max-width": "600px",
        }}>
          <div style={{ display: "grid", "grid-template-columns": "120px 1fr", gap: "12px", "font-size": "14px" }}>
            <span style={{ color: "#848d97" }}>Name</span>
            <span>{m().name}</span>
            <span style={{ color: "#848d97" }}>State</span>
            <span style={{
              color: m().state === "running" ? "#3fb950" : "#f85149",
              "font-weight": "bold",
            }}>{m().state}</span>
            <span style={{ color: "#848d97" }}>CPUs</span>
            <span>{m().cpus}</span>
            <span style={{ color: "#848d97" }}>Memory</span>
            <span>{m().memory_mb} MB</span>
            <span style={{ color: "#848d97" }}>Disk</span>
            <span>{m().disk_gb} GB</span>
            <span style={{ color: "#848d97" }}>Runtime</span>
            <span>{m().runtime}</span>
          </div>

          <div style={{ "margin-top": "24px", display: "flex", gap: "8px" }}>
            <button style={{
              padding: "8px 16px",
              background: "#238636",
              color: "white",
              border: "none",
              "border-radius": "6px",
              cursor: "pointer",
            }}>
              Start
            </button>
            <button style={{
              padding: "8px 16px",
              background: "#da3633",
              color: "white",
              border: "none",
              "border-radius": "6px",
              cursor: "pointer",
            }}>
              Stop
            </button>
          </div>
        </div>
      ) : (
        <p style={{ color: "#848d97" }}>Loading machine info...</p>
      )}
    </div>
  );
}
