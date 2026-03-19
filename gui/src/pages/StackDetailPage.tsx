import { createSignal, onMount, onCleanup, Show, For } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { ComposeProject } from "../lib/types";
import { formatPorts } from "../lib/format";
import { showToast } from "../components/Toast";
import LogViewer from "../components/LogViewer";
import Spinner from "../components/Spinner";
import Breadcrumb from "../components/Breadcrumb";

interface StackDetailPageProps {
  stackName: string;
  onBack: () => void;
  onNavigate?: (target: string) => void;
}

type StackTab = "services" | "logs" | "compose";

export default function StackDetailPage(props: StackDetailPageProps) {
  const [stack, setStack] = createSignal<ComposeProject | null>(null);
  const [activeTab, setActiveTab] = createSignal<StackTab>("services");
  const [actionInProgress, setActionInProgress] = createSignal(false);
  const [serviceLoading, setServiceLoading] = createSignal<string | null>(null);
  const [logsFor, setLogsFor] = createSignal<{ id: string; name: string } | null>(null);
  const [composeContent, setComposeContent] = createSignal<string | null>(null);
  const [composeOutput, setComposeOutput] = createSignal<{ output: any } | null>(null);
  const [logServiceFilter, setLogServiceFilter] = createSignal<string | null>(null);

  const fetchStack = async () => {
    try {
      const result = (await invoke("get_stack", { name: props.stackName })) as ComposeProject;
      setStack(result);
    } catch (e) {
      console.error("Failed to fetch stack:", e);
    }
  };

  const fetchComposeFile = async () => {
    const s = stack();
    if (!s?.config_file) return;
    try {
      const content = await invoke("read_file", { path: s.config_file }) as string;
      setComposeContent(content);
    } catch {
      setComposeContent(null);
    }
  };

  onMount(() => {
    fetchStack();
    const interval = setInterval(fetchStack, 3000);
    onCleanup(() => clearInterval(interval));
  });

  const doStackAction = async (action: string) => {
    setActionInProgress(true);
    setComposeOutput(null);
    try {
      const result = await invoke(action, { name: props.stackName });
      if (result && typeof result === "object") {
        setComposeOutput({ output: result as any });
      }
      showToast(`${action.replace(/_/g, " ")} succeeded`, "success");
      setTimeout(fetchStack, 500);
    } catch (err) {
      showToast(`${action} failed: ${err}`, "error");
    }
    setActionInProgress(false);
  };

  const restartService = async (containerId: string) => {
    setServiceLoading(containerId);
    try {
      await invoke("stop_container", { id: containerId });
      await invoke("start_container", { id: containerId });
      showToast("Service restarted", "success");
      await fetchStack();
    } catch (err) {
      showToast(`Restart failed: ${err}`, "error");
    }
    setServiceLoading(null);
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

  const breadcrumbItems = () => [
    { label: "Stacks", onClick: () => props.onBack() },
    { label: props.stackName },
  ];

  const runningCount = () => {
    const s = stack();
    return s ? s.services.filter((svc) => svc.state === "Running").length : 0;
  };

  return (
    <div class="detail-page">
      <Breadcrumb items={breadcrumbItems()} />

      {/* Header bar */}
      <div class="detail-page-header">
        <Show
          when={stack()}
          fallback={
            <div class="detail-page-info">
              <div class="detail-page-name">Loading...</div>
            </div>
          }
        >
          {(s) => (
            <>
              <div class="detail-page-info">
                <div class="detail-page-name">{s().name}</div>
                <div class="detail-page-image">
                  {s().working_dir || "No working directory"}
                  <Show when={s().services.length > 0}>
                    <span style={{ "margin-left": "12px", color: "#484f58" }}>
                      {runningCount()}/{s().services.length} services running
                    </span>
                  </Show>
                </div>
              </div>

              <span class={`state-badge ${statusConfig(s().status).class}`}>
                {statusConfig(s().status).label}
              </span>

              <div class="detail-page-actions">
                <Show when={actionInProgress()}>
                  <Spinner />
                </Show>
                <Show when={s().status !== "Running"}>
                  <button
                    class="btn btn-sm btn-primary"
                    onClick={() => doStackAction("start_stack")}
                    disabled={actionInProgress()}
                  >
                    Start All
                  </button>
                </Show>
                <Show when={s().status !== "Stopped"}>
                  <button
                    class="btn btn-sm"
                    onClick={() => doStackAction("stop_stack")}
                    disabled={actionInProgress()}
                  >
                    Stop All
                  </button>
                </Show>
                <Show when={s().working_dir}>
                  <div class="btn-separator" />
                  <button
                    class="btn btn-sm btn-primary"
                    onClick={() => doStackAction("compose_up")}
                    disabled={actionInProgress()}
                    title="docker compose up -d"
                  >
                    Up
                  </button>
                  <button
                    class="btn btn-sm btn-danger"
                    onClick={() => {
                      if (
                        window.confirm(
                          `Run docker compose down for '${props.stackName}'? This will stop and remove all containers.`
                        )
                      ) {
                        doStackAction("compose_down");
                      }
                    }}
                    disabled={actionInProgress()}
                    title="docker compose down"
                  >
                    Down
                  </button>
                  <button
                    class="btn btn-sm"
                    onClick={() => doStackAction("compose_pull")}
                    disabled={actionInProgress()}
                    title="docker compose pull"
                  >
                    Pull
                  </button>
                </Show>
              </div>
            </>
          )}
        </Show>
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
                Compose output
                {co().output.success ? " (success)" : " (failed)"}
              </span>
              <button class="btn btn-sm" onClick={() => setComposeOutput(null)}>
                Dismiss
              </button>
            </div>
            <Show when={co().output.stdout}>
              <pre
                class="mono"
                style={{
                  color: "#c9d1d9",
                  "white-space": "pre-wrap",
                  "margin-bottom": "4px",
                }}
              >
                {co().output.stdout}
              </pre>
            </Show>
            <Show when={co().output.stderr}>
              <pre
                class="mono"
                style={{ color: "#f85149", "white-space": "pre-wrap" }}
              >
                {co().output.stderr}
              </pre>
            </Show>
          </div>
        )}
      </Show>

      {/* Tab bar */}
      <div class="detail-tab-bar">
        <button
          class={`detail-tab-item ${activeTab() === "services" ? "active" : ""}`}
          onClick={() => setActiveTab("services")}
        >
          Services
        </button>
        <button
          class={`detail-tab-item ${activeTab() === "logs" ? "active" : ""}`}
          onClick={() => setActiveTab("logs")}
        >
          Logs
        </button>
        <button
          class={`detail-tab-item ${activeTab() === "compose" ? "active" : ""}`}
          onClick={() => {
            setActiveTab("compose");
            if (!composeContent()) fetchComposeFile();
          }}
        >
          Compose File
        </button>
      </div>

      {/* Tab content */}
      <div class="detail-tab-content">
        {/* Services tab */}
        <Show when={activeTab() === "services"}>
          <Show
            when={stack() && stack()!.services.length > 0}
            fallback={
              <div
                style={{
                  color: "#484f58",
                  "font-size": "13px",
                  padding: "24px 0",
                }}
              >
                No services found in this stack.
              </div>
            }
          >
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
                <For each={stack()!.services}>
                  {(svc) => (
                    <tr
                      class="clickable-row"
                      onClick={() =>
                        props.onNavigate?.(
                          `container:${svc.container_id},stack:${props.stackName}`
                        )
                      }
                    >
                      <td>
                        <span style={{ "font-weight": "500" }}>{svc.name}</span>
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
                        <div
                          class="btn-group"
                          style={{ "justify-content": "flex-end" }}
                          onClick={(e: MouseEvent) => e.stopPropagation()}
                        >
                          <button
                            class="btn btn-sm"
                            onClick={() =>
                              setLogsFor({
                                id: svc.container_id,
                                name: `${props.stackName}/${svc.name}`,
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
                                })
                                  .then(fetchStack)
                                  .finally(() => setServiceLoading(null));
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
                                })
                                  .then(fetchStack)
                                  .finally(() => setServiceLoading(null));
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
          </Show>
        </Show>

        {/* Logs tab */}
        <Show when={activeTab() === "logs"}>
          <div style={{ "margin-bottom": "12px" }}>
            <div
              style={{
                display: "flex",
                "align-items": "center",
                gap: "8px",
                "margin-bottom": "12px",
              }}
            >
              <span
                style={{
                  "font-size": "12px",
                  color: "#8b949e",
                  "white-space": "nowrap",
                }}
              >
                Service:
              </span>
              <div class="filter-pills">
                <button
                  class={`filter-pill ${logServiceFilter() === null ? "active" : ""}`}
                  onClick={() => setLogServiceFilter(null)}
                >
                  Select a service
                </button>
                <For each={stack()?.services ?? []}>
                  {(svc) => (
                    <button
                      class={`filter-pill ${logServiceFilter() === svc.container_id ? "active" : ""}`}
                      onClick={() => setLogServiceFilter(svc.container_id)}
                    >
                      {svc.name}
                    </button>
                  )}
                </For>
              </div>
            </div>
          </div>
          <Show
            when={logServiceFilter()}
            fallback={
              <div
                style={{
                  color: "#484f58",
                  "font-size": "13px",
                  padding: "24px 0",
                }}
              >
                Select a service above to view its logs.
              </div>
            }
          >
            {(containerId) => {
              const svc = () =>
                stack()?.services.find(
                  (s) => s.container_id === containerId()
                );
              return (
                <LogViewer
                  containerId={containerId()}
                  containerName={`${props.stackName}/${svc()?.name ?? "unknown"}`}
                  onClose={() => setLogServiceFilter(null)}
                />
              );
            }}
          </Show>
        </Show>

        {/* Compose file tab */}
        <Show when={activeTab() === "compose"}>
          <div class="detail-overview">
            <Show when={stack()?.config_file}>
              <div class="detail-info-section" style={{ "margin-bottom": "16px" }}>
                <div class="detail-section-title">Compose File Path</div>
                <code
                  class="mono"
                  style={{
                    color: "#8b949e",
                    "font-size": "13px",
                    "word-break": "break-all",
                  }}
                >
                  {stack()!.config_file}
                </code>
              </div>
            </Show>

            <Show when={!stack()?.config_file}>
              <div
                style={{
                  color: "#484f58",
                  "font-size": "13px",
                  padding: "24px 0",
                }}
              >
                No compose file path available for this stack.
              </div>
            </Show>

            <Show when={composeContent()}>
              <div class="detail-export-block">
                <pre class="detail-export-code">{composeContent()}</pre>
              </div>
            </Show>

            <Show when={stack()?.config_file && !composeContent()}>
              <div
                style={{
                  color: "#484f58",
                  "font-size": "12px",
                  "margin-top": "8px",
                }}
              >
                Could not read compose file contents. The file may not be
                accessible.
              </div>
            </Show>
          </div>
        </Show>
      </div>

      {/* Log viewer modal */}
      <Show when={logsFor()}>
        {(lf) => (
          <div
            class="modal-overlay"
            onClick={(e) => {
              if (
                (e.target as HTMLElement).classList.contains("modal-overlay")
              )
                setLogsFor(null);
            }}
          >
            <div
              style={{
                width: "80vw",
                "max-width": "900px",
                height: "70vh",
              }}
            >
              <LogViewer
                containerId={lf().id}
                containerName={lf().name}
                onClose={() => setLogsFor(null)}
              />
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}
