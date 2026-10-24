import { createResource, createSignal, onCleanup, Show, For } from "solid-js";
import { tildePath } from "../lib/paths";
import { invoke } from "@tauri-apps/api/core";
import { stacksStore } from "../lib/dockerStore";
import { useRefresh } from "../lib/useRefresh";
import { formatPorts } from "../lib/format";
import { showToast } from "../components/Toast";
import LogViewer from "../components/LogViewer";
import Spinner from "../components/Spinner";
import Breadcrumb from "../components/Breadcrumb";
import YamlEditor from "../components/YamlEditor";
import StackOrcaYaml from "../components/StackOrcaYaml";
import Dropdown from "../components/Dropdown";
import StackProfiles from "../components/StackProfiles";
import StackDatabases from "../components/StackDatabases";
import HelpLink from "../components/HelpLink";
import type { StackProfilesReport } from "../lib/types";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { logError } from "../lib/activityStore";
import { confirmDanger } from "../components/ConfirmDialog";
import FolderActions from "../components/FolderActions";
import { stackUrls } from "../lib/stackUrls";
import { openContainerOn } from "../lib/containerTab";
import type { GatewayRoute } from "../lib/types";

interface StackDetailPageProps {
  stackName: string;
  onBack: () => void;
  onNavigate?: (target: string) => void;
}

type StackTab = "services" | "logs" | "compose" | "orca";

export default function StackDetailPage(props: StackDetailPageProps) {
  const [activeTab, setActiveTab] = createSignal<StackTab>("services");
  const [actionInProgress, setActionInProgress] = createSignal(false);
  const [serviceLoading, setServiceLoading] = createSignal<string | null>(null);
  const [logsFor, setLogsFor] = createSignal<{ id: string; name: string } | null>(null);
  const [composeContent, setComposeContent] = createSignal<string | null>(null);
  const [logServiceFilter, setLogServiceFilter] = createSignal<string | null>(null);
  const [savedSinceLastRestart, setSavedSinceLastRestart] = createSignal(false);

  // The stack comes from the shared list, refreshed by Docker events.
  const stackList = stacksStore.use();
  const stack = () => stackList.list().find((s) => s.name === props.stackName) ?? null;
  const fetchStack = () => stackList.refresh();

  useRefresh(fetchStack);

  // Compose profiles: the optional parts of the stack. Read from the compose
  // file, so fetched on open and after changes, not on every event.
  // The gateway's routes, for the stack's URLs in the header.
  const [routes, { refetch: refetchRoutes }] = createResource(() =>
    invoke<GatewayRoute[]>("gateway_list_routes").catch(() => [] as GatewayRoute[]),
  );
  // Routes change when orca.yaml is saved or a route is added elsewhere.
  const routesTimer = setInterval(() => { if (!document.hidden) void refetchRoutes(); }, 15_000);
  onCleanup(() => clearInterval(routesTimer));
  const [profiles, { mutate: setProfiles, refetch: refetchProfiles }] = createResource(
    () => props.stackName,
    (name) => invoke<StackProfilesReport>("stack_profiles", { name }),
  );
  const [profilesBusy, setProfilesBusy] = createSignal(false);
  const hasProfiles = () => !profiles.error && (profiles()?.profiles?.length ?? 0) > 0;
  const profilesOf = (service: string) =>
    (!profiles.error && profiles()?.services?.find((s) => s.name === service)?.profiles) || [];
  /** Services behind a profile that is off, so they have no container. */
  const offServices = () =>
    hasProfiles()
      ? profiles()!.services.filter((s) => s.profiles.length > 0 && !stack()?.services.some((c) => c.name === s.name))
      : [];

  const saveProfiles = async (list: string[], apply: boolean) => {
    setProfilesBusy(true);
    try {
      const r = await invoke<StackProfilesReport & { output?: { success: boolean; stderr: string } | null }>(
        "set_stack_profiles",
        { name: props.stackName, profiles: list, apply },
      );
      setProfiles(r);
      if (r.output && !r.output.success) {
        logError(`Could not apply profiles to ${props.stackName}`, r.output.stderr);
        showToast(`Could not apply: ${r.output.stderr.trim().split("\n").pop()}`, "error");
      } else {
        showToast(apply ? "Profiles applied" : "Saved. Orca starts this set from now on.", "success");
      }
      void fetchStack();
    } catch (e) {
      showToast(String(e), "error");
    }
    setProfilesBusy(false);
  };

  // The stack's compose files, as Compose recorded them; one is edited at a time.
  const [composeFiles, setComposeFiles] = createSignal<{ path: string; text?: string; error?: string }[]>([]);
  const [composeIndex, setComposeIndex] = createSignal(0);
  const [composeError, setComposeError] = createSignal<string | null>(null);
  const composePath = () => composeFiles()[composeIndex()]?.path ?? null;
  const showComposeFile = (i: number) => {
    setComposeIndex(i);
    const f = composeFiles()[i];
    setComposeContent(f?.text ?? null);
    setComposeError(f?.error ?? null);
  };
  const fetchComposeFile = async () => {
    try {
      const r = await invoke<{ files: { path: string; text?: string; error?: string }[] }>("stack_compose_files", { name: props.stackName });
      setComposeFiles(r.files);
      showComposeFile(Math.min(composeIndex(), Math.max(0, r.files.length - 1)));
    } catch (e) {
      setComposeContent(null);
      setComposeError(String(e));
    }
  };

  const doStackAction = async (action: string): Promise<boolean> => {
    setActionInProgress(true);
    let ok = false;
    try {
      const result = await invoke(action, { name: props.stackName });
      if (result && typeof result === "object") {
        const output = result as any;
        const failedHooks = ((output.hooks ?? []) as Array<{ hook: string; success: boolean; output: string }>).filter((h) => !h.success);
        ok = output.success !== false;
        if (!output.success) {
          showToast(`${action.replace(/_/g, " ")} failed: ${output.stderr || "Unknown error"}`, "error");
        } else if (failedHooks.length > 0) {
          for (const h of failedHooks) logError(`Stack hook failed: ${h.hook}`, h.output);
          showToast(`Stack is up, but ${failedHooks.length} hook(s) from orca.yaml failed. See Activity for the output.`, "error");
        } else {
          showToast(`${action.replace(/_/g, " ")} succeeded`, "success");
        }
      } else {
        ok = true;
        showToast(`${action.replace(/_/g, " ")} succeeded`, "success");
      }
      setTimeout(fetchStack, 500);
      if (action === "compose_up" || action === "compose_down") setTimeout(() => void refetchProfiles(), 600);
    } catch (err) {
      logError(`Failed to ${action.replace(/_/g, " ")} stack: ${err}`, `Stack "${props.stackName}"`);
      showToast(`${action} failed: ${err}`, "error");
    }
    setActionInProgress(false);
    return ok;
  };

  const restartService = async (containerId: string) => {
    setServiceLoading(containerId);
    try {
      await invoke("stop_container", { id: containerId });
      await invoke("start_container", { id: containerId });
      showToast("Service restarted", "success");
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
    { label: "Containers", onClick: () => props.onBack() },
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
                <div class="detail-page-image" style={{ display: "flex", "align-items": "center", gap: "6px" }}>
                  {s().working_dir ? tildePath(s().working_dir!) : "No working directory"}
                  <Show when={s().working_dir}>
                    <button
                      class="btn btn-sm"
                      style={{ padding: "1px 6px", "font-size": "11px", "line-height": "1.4" }}
                      title="Copy stack directory path"
                      onClick={() => {
                        navigator.clipboard.writeText(s().working_dir!);
                        showToast("Path copied to clipboard", "success");
                      }}
                    >
                      Copy path
                    </button>
                  </Show>
                  <Show when={s().services.length > 0}>
                    <span style={{ "margin-left": "12px", color: "#484f58" }}>
                      {runningCount()}/{s().services.length} services running
                    </span>
                  </Show>
                </div>
                <div class="stack-quick">
                  <For each={stackUrls(s(), routes() ?? []).slice(0, 3)}>
                    {(u) => (
                      <button class="app-url" title={`Open ${u.url} (${u.label})`}
                        onClick={() => shellOpen(u.url).catch(() => window.open(u.url, "_blank", "noopener,noreferrer"))}>
                        {u.url.replace(/^https:\/\//, "")} ↗
                      </button>
                    )}
                  </For>
                  <Show when={s().working_dir}>{(dir) => <FolderActions path={dir()} compact />}</Show>
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
                        title: "Compose down",
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
                    title="Start stack"
                  >
                    &#9654; Start
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
          Compose file
        </button>
        <button
          class={`detail-tab-item ${activeTab() === "orca" ? "active" : ""}`}
          onClick={() => setActiveTab("orca")}
        >
          orca.yaml
        </button>
      </div>

      {/* Tab content */}
      <div class="detail-tab-content">
        {/* Services tab */}
        <Show when={activeTab() === "services"}>
          <StackDatabases stackName={props.stackName} onNavigate={props.onNavigate} />
          <Show when={hasProfiles()}>
            <StackProfiles report={profiles()!} busy={profilesBusy()} onSave={(l, a) => void saveProfiles(l, a)} />
          </Show>
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
                        <For each={profilesOf(svc.name)}>{(p) => <span class="profile-tag" title={`In the ${p} profile`}>{p}</span>}</For>
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
                          <Show when={svc.state === "Running"}>
                            <button class="btn btn-sm" title={`Open a shell in ${svc.container_name}`}
                              onClick={() => { openContainerOn(svc.container_id, "terminal"); props.onNavigate?.(`container:${svc.container_id},stack:${props.stackName}`); }}>
                              Shell
                            </button>
                          </Show>
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
                <For each={offServices()}>
                  {(svc) => (
                    <tr class="service-off">
                      <td>
                        <span style={{ "font-weight": "500" }}>{svc.name}</span>
                        <For each={svc.profiles}>{(p) => <span class="profile-tag">{p}</span>}</For>
                      </td>
                      <td class="mono">{svc.image ?? "built"}</td>
                      <Show when={svc.profiles.some((p) => profiles()!.active.includes(p))} fallback={
                        <>
                          <td><span class="state-badge state-stopped" title="Its profile is off">Off</span></td>
                          <td />
                          <td style={{ "text-align": "right", opacity: 1 }}>
                            <button class="btn btn-sm" disabled={profilesBusy()}
                              onClick={() => void saveProfiles([...profiles()!.active, svc.profiles[0]], profiles()!.running)}>
                              Turn on {svc.profiles[0]}
                            </button>
                          </td>
                        </>
                      }>
                        <td><span class="state-badge state-created" title="Its profile is on; it starts with the stack">Not started</span></td>
                        <td />
                        <td />
                      </Show>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
            <Show when={!profiles.loading && !hasProfiles() && stack()!.services.length > 2}>
              <div style={{ color: "#6e7681", "font-size": "12px", "margin-top": "12px" }}>
                Not every service needed every time? Put optional ones behind a compose profile and switch them on here.{" "}
                <HelpLink path="/docs/profiles/#make-a-service-optional">How</HelpLink>
              </div>
            </Show>
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

        <Show when={activeTab() === "orca"}>
          <StackOrcaYaml stackName={props.stackName} />
        </Show>

        {/* Compose file tab */}
        <Show when={activeTab() === "compose"}>
          <div class="detail-overview">
            <Show when={composePath()}>
              <div class="detail-info-section" style={{ "margin-bottom": "12px", display: "flex", gap: "10px", "align-items": "center", "flex-wrap": "wrap" }}>
                <Show when={composeFiles().length > 1}>
                  <Dropdown
                    value={String(composeIndex())}
                    options={composeFiles().map((f, i) => ({ value: String(i), label: f.path.split(/[\\/]/).pop() ?? f.path }))}
                    onChange={(v) => showComposeFile(Number(v))}
                    style={{ width: "240px" }}
                  />
                </Show>
                <code class="mono" style={{ color: "#8b949e", "font-size": "12px", "word-break": "break-all" }}>
                  {composePath()}
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
                <span>The compose file changed. Apply it to recreate the services whose definition changed; the others keep running.</span>
                <button
                  class="btn btn-sm btn-primary"
                  onClick={() => {
                    void doStackAction("compose_up").then((ok) => ok && setSavedSinceLastRestart(false));
                  }}
                  disabled={actionInProgress()}
                >
                  Apply changes
                </button>
              </div>
            </Show>

            <Show when={composeContent() !== null}>
              <div style={{ height: "calc(100vh - 320px)", "min-height": "300px", "border-radius": "8px", overflow: "hidden", border: "1px solid #21262d" }}>
                <YamlEditor
                  value={composeContent()!}
                  readOnly={false}
                  title={`${props.stackName} — ${composePath()?.split(/[\\/]/).pop() ?? "compose file"}`}
                  // eslint-disable-next-line solid/reactivity -- async event handler, reactivity not needed
                  onSave={async (content: string) => {
                    const path = composePath();
                    if (!path) {
                      showToast("No compose file path available", "error");
                      return;
                    }
                    try {
                      await invoke("save_stack_compose_file", { name: props.stackName, path, text: content });
                      setComposeFiles((fs) => fs.map((f) => (f.path === path ? { ...f, text: content } : f)));
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
                Could not read the compose file{composeError() ? `: ${composeError()}` : "."}
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
