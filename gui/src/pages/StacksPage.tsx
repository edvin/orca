import { createSignal, onMount, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { ComposeProject } from "../lib/types";
import { formatPorts } from "../lib/format";

export default function StacksPage() {
  const [stacks, setStacks] = createSignal<ComposeProject[]>([]);
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
  const [loading, setLoading] = createSignal<string | null>(null);

  const refresh = async () => {
    try {
      const result = (await invoke("list_stacks")) as ComposeProject[];
      setStacks(result);
    } catch (e) {
      console.error("Failed to list stacks:", e);
    }
  };

  onMount(() => {
    refresh();
    const interval = setInterval(refresh, 3000);
    onCleanup(() => clearInterval(interval));
  });

  const toggleExpand = (name: string) => {
    const next = new Set(expanded());
    if (next.has(name)) {
      next.delete(name);
    } else {
      next.add(name);
    }
    setExpanded(next);
  };

  const doStackAction = async (action: string, name: string, e: MouseEvent) => {
    e.stopPropagation();
    setLoading(name);
    try {
      await invoke(action, { name });
      // Give containers a moment to change state
      setTimeout(refresh, 500);
    } catch (err) {
      console.error(`${action} failed:`, err);
    }
    setLoading(null);
  };

  const statusConfig = (status: string) => {
    switch (status) {
      case "Running":
        return { class: "state-running", label: "Running" };
      case "Partial":
        return { class: "state-paused", label: "Partial" };
      case "Stopped":
        return { class: "state-exited", label: "Stopped" };
      default:
        return { class: "state-created", label: status };
    }
  };

  const serviceStateClass = (state: string) => {
    switch (state) {
      case "Running":
        return "state-running";
      case "Exited":
        return "state-exited";
      case "Created":
        return "state-created";
      case "Paused":
        return "state-paused";
      default:
        return "state-stopped";
    }
  };

  return (
    <div>
      <div class="page-header">
        <h1 class="page-title">
          Stacks
          <span style={{
            "font-size": "13px",
            color: "#8b949e",
            "font-weight": "400",
            "margin-left": "8px",
          }}>
            {stacks().length} project{stacks().length !== 1 ? "s" : ""}
          </span>
        </h1>
        <button class="btn" onClick={refresh}>Refresh</button>
      </div>

      <Show
        when={stacks().length > 0}
        fallback={
          <div class="empty">
            <p class="empty-title">No compose stacks found</p>
            <p>Run <code style={{ color: "#c9d1d9" }}>docker compose up</code> to create a stack.</p>
          </div>
        }
      >
        <div class="stack-list">
          <For each={stacks()}>
            {(stack) => {
              const sc = () => statusConfig(stack.status);
              const isExpanded = () => expanded().has(stack.name);
              const runningCount = () =>
                stack.services.filter((s) => s.state === "Running").length;

              return (
                <div class="stack-card">
                  <div
                    class="stack-header"
                    onClick={() => toggleExpand(stack.name)}
                  >
                    <div class="stack-header-left">
                      <span class={`expand-arrow ${isExpanded() ? "expanded" : ""}`}>
                        &#9654;
                      </span>
                      <div>
                        <div class="stack-name">{stack.name}</div>
                        <div class="stack-meta">
                          {runningCount()}/{stack.services.length} services running
                          <Show when={stack.working_dir}>
                            <span class="stack-path"> &middot; {stack.working_dir}</span>
                          </Show>
                        </div>
                      </div>
                    </div>
                    <div class="stack-header-right">
                      <span class={`state-badge ${sc().class}`}>{sc().label}</span>
                      <div class="btn-group">
                        <Show when={stack.status !== "Running"}>
                          <button
                            class="btn btn-sm btn-primary"
                            onClick={(e) => doStackAction("start_stack", stack.name, e)}
                            disabled={loading() === stack.name}
                          >
                            {loading() === stack.name ? "..." : "Start All"}
                          </button>
                        </Show>
                        <Show when={stack.status !== "Stopped"}>
                          <button
                            class="btn btn-sm"
                            onClick={(e) => doStackAction("stop_stack", stack.name, e)}
                            disabled={loading() === stack.name}
                          >
                            {loading() === stack.name ? "..." : "Stop All"}
                          </button>
                        </Show>
                        <button
                          class="btn btn-sm"
                          onClick={(e) => doStackAction("restart_stack", stack.name, e)}
                          disabled={loading() === stack.name}
                        >
                          Restart
                        </button>
                      </div>
                    </div>
                  </div>

                  <Show when={isExpanded()}>
                    <div class="stack-services">
                      <table class="table">
                        <thead>
                          <tr>
                            <th>Service</th>
                            <th>Image</th>
                            <th>State</th>
                            <th>Ports</th>
                            <th style={{ "text-align": "right" }}>Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          <For each={stack.services}>
                            {(svc) => (
                              <tr>
                                <td>
                                  <span style={{ "font-weight": "500" }}>
                                    {svc.name}
                                  </span>
                                  <br />
                                  <span
                                    class="mono"
                                    style={{ color: "#8b949e", "font-size": "11px" }}
                                  >
                                    {svc.container_name}
                                  </span>
                                </td>
                                <td class="mono">{svc.image}</td>
                                <td>
                                  <span
                                    class={`state-badge ${serviceStateClass(svc.state)}`}
                                  >
                                    {svc.state}
                                  </span>
                                </td>
                                <td class="mono">{formatPorts(svc.ports)}</td>
                                <td style={{ "text-align": "right" }}>
                                  <div class="btn-group" style={{ "justify-content": "flex-end" }}>
                                    <Show when={svc.state !== "Running"}>
                                      <button
                                        class="btn btn-sm btn-primary"
                                        onClick={() =>
                                          invoke("start_container", {
                                            id: svc.container_id,
                                          }).then(refresh)
                                        }
                                      >
                                        Start
                                      </button>
                                    </Show>
                                    <Show when={svc.state === "Running"}>
                                      <button
                                        class="btn btn-sm"
                                        onClick={() =>
                                          invoke("stop_container", {
                                            id: svc.container_id,
                                          }).then(refresh)
                                        }
                                      >
                                        Stop
                                      </button>
                                    </Show>
                                  </div>
                                </td>
                              </tr>
                            )}
                          </For>
                        </tbody>
                      </table>
                    </div>
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
}
