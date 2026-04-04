import { Show } from "solid-js";

export default function ConnectionBanner(props: { status: string }) {
  return (
    <Show when={props.status !== "running"}>
      <div style={{
        background: "rgba(210, 153, 34, 0.1)",
        border: "1px solid rgba(210, 153, 34, 0.2)",
        "border-radius": "8px",
        padding: "8px 16px",
        margin: "0 0 16px 0",
        display: "flex",
        "align-items": "center",
        gap: "8px",
        "font-size": "13px",
        color: "#d29922",
      }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        Daemon connection lost — reconnecting...
      </div>
    </Show>
  );
}
