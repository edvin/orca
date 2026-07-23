import { createSignal, onMount, onCleanup, Show, For } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { ComposeProject } from "../lib/types";
import { useRefresh } from "../lib/useRefresh";
import { formatPorts } from "../lib/format";
import { showToast } from "../components/Toast";
import LogViewer from "../components/LogViewer";
import Spinner from "../components/Spinner";
import Breadcrumb from "../components/Breadcrumb";
import YamlEditor from "../components/YamlEditor";
import { logError } from "../lib/activityStore";
import { confirmDanger } from "../components/ConfirmDialog";
import { t, lang } from "../i18n";
import { settingsDetailEn, settingsDetailZhCN } from "../i18n/settingsDetail";

const tr = (key: string, params: Record<string, string | number> = {}) => {
  const central = t(key);
  const value = central === key ? (lang() === "zh-CN" ? settingsDetailZhCN[key] : settingsDetailEn[key]) ?? key : central;
  return Object.entries(params).reduce((text, [name, replacement]) => text.replaceAll(`{${name}}`, String(replacement)), value);
};

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
  const [logServiceFilter, setLogServiceFilter] = createSignal<string | null>(null);
  const [savedSinceLastRestart, setSavedSinceLastRestart] = createSignal(false);

  const fetchStack = async () => {
    try {
      const result = (await invoke("get_stack", { name: props.stackName })) as ComposeProject;
      setStack(result);
    } catch {
    }
  };

  useRefresh(fetchStack);

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
    try {
      const result = await invoke(action, { name: props.stackName });
      if (result && typeof result === "object") {
        const output = result as any;
        if (!output.success) {
          showToast(`${action.replace(/_/g, " ")} failed: ${output.stderr || "Unknown error"}`, "error");
        } else {
          showToast(`${action.replace(/_/g, " ")} succeeded`, "success");
        }
      } else {
        showToast(`${action.replace(/_/g, " ")} succeeded`, "success");
      }
      setTimeout(fetchStack, 500);
    } catch (err) {
      logError(`Failed to ${action.replace(/_/g, " ")} stack: ${err}`, `Stack "${props.stackName}"`);
      showToast(`${action} failed: ${err}`, "error");
    }
    setActionInProgress(false);
  };

  const restartService = async (containerId: string) => {
    setServiceLoading(containerId);
    try {
      await invoke("stop_container", { id: containerId });
      await invoke("start_container", { id: containerId });
      showToast(tr("stack.serviceRestarted"), "success");
      await fetchStack();
    } catch (err) {
      logError(`Failed to restart service: ${err}`, `Stack "${props.stackName}", service ${containerId}`);
      showToast(`Restart failed: ${err}`, "error");
    }
    setServiceLoading(null);
  };

  const statusConfig = (status: string) => {
    switch (status) {
      case "Running":
        return { class: "state-running", label: tr("common.running") };
      case "Partial":
        return { class: "state-paused", label: tr("common.partial") };
      case "Stopped":
        return { class: "state-exited", label: tr("common.stopped") };
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
    { label: tr("stack.title"), onClick: () => props.onBack() },
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
              <div class="detail-page-name">{tr("common.loading")}</div>
            </div>
          }
        >
          {(s) => (
            <>
              <div class="detail-page-info">
                <div class="detail-page-name">{s().name}</div>
                <div class="detail-page-image" style={{ display: "flex", "align-items": "center", gap: "6px" }}>
                  {s().working_dir || tr("stack.noWorkingDirectory")}
                  <Show when={s().working_dir}>
                    <button
                      class="btn btn-sm"
                      style={{ padding: "1px 6px", "font-size": "11px", "line-height": "1.4" }}
                      title={tr("stack.copyPathTitle")}
                      onClick={() => {
                        navigator.clipboard.writeText(s().working_dir!);
                        showToast("Path copied to clipboard", "success");
                      }}
                    >
                      {tr("stack.copyPath")}
                    </button>
                  </Show>
                  <Show when={s().services.length > 0}>
                    <span style={{ "margin-left": "12px", color: "#484f58" }}>
                      {tr("stack.servicesRunning", { running: runningCount(), total: s().services.length })}
                    </span>
                  </Show>
                </div>
              </div>

              <span class={`state-badge ${statusConfig(s().status).class}`}>
                {statusConfig(s().status).label}
              </span>

              <div class={`detail-page-actions action-icons ${actionInProgress() ? "loading" : ""}`}>
                <Show when={actionInProgress()}>
                  <div class="action-spinner"><Spinner size={14} /></div>
                </Show>
                <Show when={s().status === "Running"}>
                  <button
                    class="btn btn-sm"
                    onClick={async () => {
                      const ok = await confirmDanger({
                        title: "Compose Down",
                        message: "This will stop and remove the stack's containers. Continue?",
                        confirmLabel: "Down",
                      });
                      if (!ok) return;
                      doStackAction("compose_down");
                    }}
                    disabled={actionInProgress()}
                    title="Stop stack"
                  >
                    &#9632; Stop
                  </button>
                </Show>
                <Show when={s().status !== "Running"}>
                  <button
                    class="btn btn-sm btn-primary"
                    onClick={() => doStackAction("compose_up")}
                    disabled={actionInProgress()}
                    title={tr("stack.startTitle")}
                  >
                    &#9654; {tr("common.start")}
                  </button>
                </Show>
                <Show when={s().working_dir}>
                  <button
                    class="btn btn-sm"
                    onClick={() => doStackAction("restart_stack")}
                    disabled={actionInProgress()}
                    title="Restart stack"
                  >
                    &#10227; Restart
                  </button>
                  <button
                    class="btn btn-sm"
                    onClick={() => doStackAction("compose_pull")}
                    disabled={actionInProgress()}
                    title="Pull images"
                  >
                    &#8595; Pull
                  </button>
                </Show>
              </div>
            </>
          )}
        </Show>
      </div>

      {/* Tab bar */}
      <div class="detail-tab-bar">
        <button
          class={`detail-tab-item ${activeTab() === "services" ? "active" : ""}`}
          onClick={() => setActiveTab("services")}
        >
          {tr("stack.services")}
        </button>
        <button
          class={`detail-tab-item ${activeTab() === "logs" ? "active" : ""}`}
          onClick={() => setActiveTab("logs")}
        >
          {tr("common.logs")}
        </button>
        <button
          class={`detail-tab-item ${activeTab() === "compose" ? "active" : ""}`}
          onClick={() => {
            setActiveTab("compose");
            if (!composeContent()) fetchComposeFile();
          }}
        >
          {tr("stack.composeFile")}
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
                {tr("stack.noServices")}
              </div>
            }
          >
            <table class="table">
              <thead>
                <tr>
                  <th>t("stack.service")</th>
                  <th>t("common.image")</th>
                  <th>t("common.state")</th>
                  <th>t("stack.ports")</th>
                  <th style={{ "text-align": "right" }}>t("common.actions")</th>
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
                              {tr("common.start")}
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
                {tr("stack.service")}:
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
              <div class="detail-info-section" style={{ "margin-bottom": "12px" }}>
                <code
                  class="mono"
                  style={{
                    color: "#8b949e",
                    "font-size": "12px",
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
                {tr("stack.noComposePath")}
              </div>
            </Show>

            <Show when={savedSinceLastRestart()}>
              <div
                style={{
                  display: "flex",
                  "align-items": "center",
                  gap: "12px",
                  padding: "8px 12px",
                  background: "rgba(210, 169, 34, 0.1)",
                  border: "1px solid rgba(210, 169, 34, 0.2)",
                  "border-radius": "6px",
                  "font-size": "13px",
                  color: "#d29922",
                  "margin-bottom": "8px",
                }}
              >
                <span>Compose file has been modified. Restart the stack to apply changes.</span>
                <button
                  class="btn btn-sm btn-primary"
                  onClick={() => {
                    doStackAction("restart_stack");
                    setSavedSinceLastRestart(false);
                  }}
                  disabled={actionInProgress()}
                >
                  Restart Stack
                </button>
              </div>
            </Show>

            <Show when={composeContent() !== null}>
              <div style={{ height: "calc(100vh - 320px)", "min-height": "300px", "border-radius": "8px", overflow: "hidden", border: "1px solid #21262d" }}>
                <YamlEditor
                  value={composeContent()!}
                  readOnly={false}
                  title={`${props.stackName} — docker-compose.yml`}
                  // eslint-disable-next-line solid/reactivity -- async event handler, reactivity not needed
                  onSave={async (content: string) => {
                    const configFile = stack()?.config_file;
                    if (!configFile) {
                      showToast("No compose file path available", "error");
                      return;
                    }
                    try {
                      await invoke("save_compose_file", { path: configFile, content });
                      setComposeContent(content);
                      setSavedSinceLastRestart(true);
                      showToast("Compose file saved", "success");
                    } catch (e) {
                      showToast(`Failed to save: ${e}`, "error");
                      throw e;
                    }
                  }}
                />
              </div>
            </Show>

            <Show when={stack()?.config_file && composeContent() === null}>
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
