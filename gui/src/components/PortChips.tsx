import { For, Show } from "solid-js";
import { type PortGroup, portText } from "../lib/ports";

const DOT: Record<PortGroup["kind"], string> = {
  web: "#58a6ff",
  other: "#6e7681",
  unknown: "transparent",
};

function describe(g: PortGroup): string {
  const where = g.hostPort ? `localhost:${g.hostPort}` : "not published on this computer";
  const what = g.to
    ? `${g.to - g.port + 1} ports${g.label ? ` (${g.label})` : ""}`
    : g.label ?? `Port ${g.port}`;
  const kind =
    g.noAnswer ? "Didn't answer when checked"
    : g.kind === "web" ? "A web page: the gateway can serve it"
    : g.kind === "other" ? `Not a web page: reach it at ${where}`
    : "Not known: Check asks the port";
  return `${what}, ${g.protocol.toUpperCase().replace("+", " and ")}. ${kind}.`;
}

/** A container's ports as chips: what each one is, and whether it's a web page. */
export default function PortChips(props: { groups: PortGroup[]; max?: number }) {
  const shown = () => props.groups.slice(0, props.max ?? props.groups.length);
  const rest = () => props.groups.slice(shown().length);
  return (
    <div style={{ display: "flex", gap: "4px", "flex-wrap": "wrap", "justify-content": "flex-end", "min-width": "0" }}>
      <For each={shown()}>
        {(g) => (
          <span
            title={describe(g)}
            style={{
              display: "inline-flex",
              "align-items": "center",
              gap: "5px",
              color: "#8b949e",
              "font-size": "11px",
              background: "#161b22",
              padding: "1px 7px 1px 6px",
              "border-radius": "4px",
              border: `1px solid ${g.kind === "web" ? "rgba(88,166,255,0.35)" : "#30363d"}`,
              "white-space": "nowrap",
              opacity: g.noAnswer ? "0.55" : "1",
            }}
          >
            <Show when={g.kind !== "unknown"}>
              <span style={{
                width: "6px",
                height: "6px",
                "border-radius": "50%",
                background: g.kind === "web" ? DOT.web : "transparent",
                border: `1px solid ${DOT[g.kind]}`,
                "flex-shrink": "0",
              }} />
            </Show>
            <span class="mono" style={{ color: g.kind === "web" ? "#c9d1d9" : "#8b949e" }}>{portText(g)}</span>
            <Show when={g.protocol !== "tcp"}>
              <span style={{ color: "#6e7681", "font-size": "10px" }}>{g.protocol}</span>
            </Show>
            <Show when={g.label}>
              <span style={{ color: g.kind === "web" ? "#e6edf3" : "#8b949e", "max-width": "160px", overflow: "hidden", "text-overflow": "ellipsis" }}>
                {g.label}
              </span>
            </Show>
          </span>
        )}
      </For>
      <Show when={rest().length > 0}>
        <span
          title={rest().map((g) => `${portText(g)}${g.label ? ` ${g.label}` : ""}`).join(", ")}
          style={{ color: "#8b949e", "font-size": "11px", padding: "1px 6px", border: "1px solid #30363d", "border-radius": "4px", "white-space": "nowrap" }}
        >
          +{rest().length} more
        </span>
      </Show>
    </div>
  );
}
