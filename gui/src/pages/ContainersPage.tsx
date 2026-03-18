import { createSignal, onMount } from "solid-js";

export default function ContainersPage() {
  const [containers, setContainers] = createSignal<any[]>([]);

  onMount(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke("list_containers") as any[];
      setContainers(result);
    } catch (e) {
      console.error("Failed to list containers:", e);
    }
  });

  return (
    <div>
      <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center", "margin-bottom": "20px" }}>
        <h1 style={{ "font-size": "24px" }}>Containers</h1>
        <div style={{ display: "flex", gap: "8px" }}>
          <input
            type="text"
            placeholder="Search containers..."
            style={{
              padding: "8px 12px",
              background: "#0d1117",
              border: "1px solid #30363d",
              "border-radius": "6px",
              color: "#c9d1d9",
              "font-size": "14px",
            }}
          />
        </div>
      </div>

      {containers().length === 0 ? (
        <div style={{
          "text-align": "center",
          padding: "60px 20px",
          color: "#848d97",
        }}>
          <p style={{ "font-size": "18px", "margin-bottom": "8px" }}>No containers</p>
          <p>Start a machine and run some containers to see them here.</p>
        </div>
      ) : (
        <table style={{ width: "100%", "border-collapse": "collapse" }}>
          <thead>
            <tr style={{ "border-bottom": "1px solid #30363d", color: "#848d97", "font-size": "12px", "text-transform": "uppercase" }}>
              <th style={{ padding: "8px", "text-align": "left" }}>Name</th>
              <th style={{ padding: "8px", "text-align": "left" }}>Image</th>
              <th style={{ padding: "8px", "text-align": "left" }}>State</th>
              <th style={{ padding: "8px", "text-align": "left" }}>Ports</th>
              <th style={{ padding: "8px", "text-align": "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {/* Container rows will go here */}
          </tbody>
        </table>
      )}
    </div>
  );
}
