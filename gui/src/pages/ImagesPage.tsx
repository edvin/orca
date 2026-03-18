import { createSignal, onMount } from "solid-js";

export default function ImagesPage() {
  const [images, setImages] = createSignal<any[]>([]);

  onMount(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke("list_images") as any[];
      setImages(result);
    } catch (e) {
      console.error("Failed to list images:", e);
    }
  });

  return (
    <div>
      <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center", "margin-bottom": "20px" }}>
        <h1 style={{ "font-size": "24px" }}>Images</h1>
        <input
          type="text"
          placeholder="Pull image (e.g. nginx:latest)"
          style={{
            padding: "8px 12px",
            background: "#0d1117",
            border: "1px solid #30363d",
            "border-radius": "6px",
            color: "#c9d1d9",
            width: "300px",
          }}
        />
      </div>

      {images().length === 0 ? (
        <div style={{ "text-align": "center", padding: "60px 20px", color: "#848d97" }}>
          <p style={{ "font-size": "18px", "margin-bottom": "8px" }}>No images</p>
          <p>Pull an image to get started.</p>
        </div>
      ) : null}
    </div>
  );
}
