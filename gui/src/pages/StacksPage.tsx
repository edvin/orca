import { createSignal, onMount, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { ComposeProject } from "../lib/types";
import { formatPorts } from "../lib/format";
import { showToast } from "../components/Toast";
import LogViewer from "../components/LogViewer";
import Spinner from "../components/Spinner";
import LastUpdated from "../components/LastUpdated";

interface StacksPageProps {
  onNavigate?: (target: string) => void;
}

export default function StacksPage(props: StacksPageProps) {
  const [stacks, setStacks] = createSignal<ComposeProject[]>([]);
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
  const [loading, setLoading] = createSignal<string | null>(null);
  const [composeOutput, setComposeOutput] = createSignal<{
    name: string;
    output: any;
  } | null>(null);
  const [logsFor, setLogsFor] = createSignal<{
    id: string;
    name: string;
  } | null>(null);
  const [serviceLoading, setServiceLoading] = createSignal<string | null>(null);
  const [lastUpdated, setLastUpdated] = createSignal<Date | null>(null);

  const restartService = async (containerId: string) => {
    setServiceLoading(containerId);
    try {
      await invoke("stop_container", { id: containerId });
      await invoke("start_container", { id: containerId });
      showToast("Service restarted", "success");
      await refresh();
    } catch (err) {
      showToast(`Restart failed: ${err}`, "error");
    }
    setServiceLoading(null);
  };

  const refresh = async () => {
    try {
      const result = (await invoke("list_stacks")) as ComposeProject[];
      setStacks(result);
      setLastUpdated(new Date());
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

  const doStackAction = async (
    action: string,
    name: string,
    e: MouseEvent
  ) => {
    e.stopPropagation();
    setLoading(name);
    setComposeOutput(null);
    try {
      const result = await invoke(action, { name });
      // Compose CLI actions return output, container actions don't
      if (result && typeof result === "object") {
        setComposeOutput({ name, output: result as any });
      }
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
          <span
            style={{
              "font-size": "13px",
              color: "#8b949e",
              "font-weight": "400",
              "margin-left": "8px",
            }}
          >
            {stacks().length} project{stacks().length !== 1 ? "s" : ""}
          </span>
          <LastUpdated timestamp={lastUpdated()} />
        </h1>
        <button class="btn" onClick={refresh}>
          Refresh
        </button>
      </div>

      {/* Compose CLI output */}
      <Show when={composeOutput()}>
        {(co) => (
          <div
            class="card"
            style={{
              "margin-bottom": "16px",
              "border-color": co().output.success ? "#238636" : "#da3633",
            }}
          >
            <div
              style={{
                display: "flex",
                "justify-content": "space-between",
                "align-items": "center",
                "margin-bottom": "8px",
              }}
            >
              <span style={{ "font-weight": "600", "font-size": "13px" }}>
                Compose output: {co().name}
                {co().output.success ? " (success)" : " (failed)"}
              </span>
              <button
                class="btn btn-sm"
                onClick={() => setComposeOutput(null)}
              >
                Dismiss
              </button>
            </div>
            <Show when={co().output.stdout}>
              <pre class="mono" style={{ color: "#c9d1d9", "white-space": "pre-wrap", "margin-bottom": "4px" }}>
                {co().output.stdout}
              </pre>
            </Show>
            <Show when={co().output.stderr}>
              <pre class="mono" style={{ color: "#f85149", "white-space": "pre-wrap" }}>
                {co().output.stderr}
              </pre>
            </Show>
          </div>
        )}
      </Show>

      {/* Log Viewer — modal overlay so it doesn't shift content */}
      <Show when={logsFor()}>
        {(lf) => (
          <div class="modal-overlay" onMouseDown={(e) => { (e.currentTarget as any).__mdOverlay = (e.target as HTMLElement).classList.contains("modal-overlay"); }} onClick={(e) => {
            if ((e.currentTarget as any).__mdOverlay && (e.target as HTMLElement).classList.contains("modal-overlay")) setLogsFor(null);
            (e.currentTarget as any).__mdOverlay = false;
          }}>
            <div style={{ width: "80vw", "max-width": "900px", height: "70vh" }}>
              <LogViewer
                containerId={lf().id}
                containerName={lf().name}
                onClose={() => setLogsFor(null)}
              />
            </div>
          </div>
        )}
      </Show>

      <Show
        when={stacks().length > 0}
        fallback={
          <div class="empty">
            <div class="empty-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7v10c0 1.1.9 2 2 2h12a2 2 0 002-2V7"/><path d="M7 4h10a2 2 0 012 2v1H5V6a2 2 0 012-2z"/><line x1="9" y1="11" x2="15" y2="11"/><line x1="9" y1="14" x2="13" y2="14"/></svg></div>
            <p class="empty-title">No compose stacks detected</p>
            <p>
              Run{" "}
              <code style={{ color: "#c9d1d9" }}>docker compose up</code> in
              a project directory to see it here
            </p>
          </div>
        }
      >
        <div class="stack-list">
          <For each={stacks()}>
            {(stack) => {
              const sc = () => statusConfig(stack.status);
              const isExpanded = () => expanded().has(stack.name);
              const isLoading = () => loading() === stack.name;
              const runningCount = () =>
                stack.services.filter((s) => s.state === "Running").length;

              const allRunning = () =>
                stack.services.length > 0 &&
                runningCount() === stack.services.length;

              return (
                <div
                  class={`stack-card ${allRunning() ? "stack-card-healthy" : ""}`}
                  style={{ cursor: "pointer" }}
                  onClick={() => props.onNavigate?.(`stack:${stack.name}`)}
                >
                  <div
                    class="stack-header"
                    onClick={(e: MouseEvent) => { e.stopPropagation(); toggleExpand(stack.name); }}
                  >
                    <div class="stack-header-left">
                      <span
                        class={`expand-arrow ${isExpanded() ? "expanded" : ""}`}
                      >
                        &#9654;
                      </span>
                      <div>
                        <div class="stack-name">
                          {stack.name}
                          {/* Service health dots */}
                          <span class="service-dots" style={{ "margin-left": "10px", display: "inline-flex" }}>
                            <For each={stack.services}>
                              {(svc) => (
                                <span
                                  class={`service-dot ${
                                    svc.state === "Running"
                                      ? "service-dot-running"
                                      : svc.state === "Exited"
                                      ? "service-dot-stopped"
                                      : "service-dot-other"
                                  }`}
                                  title={`${svc.name}: ${svc.state}`}
                                />
                              )}
                            </For>
                          </span>
                        </div>
                        <div class="stack-meta">
                          {runningCount()}/{stack.services.length} services
                          running
                          <Show when={stack.working_dir}>
                            <span class="stack-path">
                              {" "}
                              &middot; {stack.working_dir}
                            </span>
                          </Show>
                        </div>
                      </div>
                    </div>
                    <div class="stack-header-right">
                      <span class={`state-badge ${sc().class}`}>
                        {sc().label}
                      </span>
                      <div class="btn-group">
                        {/* Container-level actions (fast, no rebuild) */}
                        <Show when={stack.status !== "Running"}>
                          <button
                            class="btn btn-sm btn-primary"
                            onClick={(e) =>
                              doStackAction("start_stack", stack.name, e)
                            }
                            disabled={isLoading()}
                          >
                            Start
                          </button>
                        </Show>
                        <Show when={stack.status !== "Stopped"}>
                          <button
                            class="btn btn-sm"
                            onClick={(e) =>
                              doStackAction("stop_stack", stack.name, e)
                            }
                            disabled={isLoading()}
                          >
                            Stop
                          </button>
                        </Show>
                        {/* Compose CLI actions (full lifecycle) */}
                        <Show when={stack.working_dir}>
                          <div class="btn-separator" />
                          <button
                            class="btn btn-sm btn-primary"
                            onClick={(e) =>
                              doStackAction("compose_up", stack.name, e)
                            }
                            disabled={isLoading()}
                            title="docker compose up -d"
                          >
                            {isLoading() ? (<><Spinner size={12} />{" ..."}</>) : "Up"}
                          </button>
                          <button
                            class="btn btn-sm btn-danger"
                            onClick={(e) => {
                              if (window.confirm(`Run docker compose down for '${stack.name}'? This will stop and remove all containers in the stack.`)) {
                                doStackAction("compose_down", stack.name, e);
                              }
                            }}
                            disabled={isLoading()}
                            title="docker compose down"
                          >
                            Down
                          </button>
                          <button
                            class="btn btn-sm"
                            onClick={(e) =>
                              doStackAction("compose_pull", stack.name, e)
                            }
                            disabled={isLoading()}
                            title="docker compose pull"
                          >
                            Pull
                          </button>
                        </Show>
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
                                    style={{
                                      color: "#8b949e",
                                      "font-size": "11px",
                                    }}
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
                                  <div
                                    class="btn-group"
                                    style={{
                                      "justify-content": "flex-end",
                                    }}
                                  >
                                    <button
                                      class="btn btn-sm"
                                      onClick={() =>
                                        setLogsFor({
                                          id: svc.container_id,
                                          name: `${stack.name}/${svc.name}`,
                                        })
                                      }
                                    >
                                      Logs
                                    </button>
                                    <Show when={serviceLoading() === svc.container_id}>
                                      <Spinner />
                                    </Show>
                                    <Show when={svc.state !== "Running"}>
                                      <button
                                        class="btn btn-sm btn-primary"
                                        onClick={() => {
                                          setServiceLoading(svc.container_id);
                                          invoke("start_container", {
                                            id: svc.container_id,
                                          }).then(refresh).finally(() => setServiceLoading(null));
                                        }}
                                        disabled={serviceLoading() === svc.container_id}
                                      >
                                        Start
                                      </button>
                                    </Show>
                                    <Show when={svc.state === "Running"}>
                                      <button
                                        class="btn btn-sm"
                                        onClick={() => {
                                          setServiceLoading(svc.container_id);
                                          invoke("stop_container", {
                                            id: svc.container_id,
                                          }).then(refresh).finally(() => setServiceLoading(null));
                                        }}
                                        disabled={serviceLoading() === svc.container_id}
                                      >
                                        Stop
                                      </button>
                                      <button
                                        class="btn btn-sm"
                                        onClick={() => restartService(svc.container_id)}
                                        disabled={serviceLoading() === svc.container_id}
                                      >
                                        Restart
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
