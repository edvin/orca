import { createSignal, onMount, onCleanup, For, Show, createEffect } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { showToast } from "../components/Toast";
import Spinner from "../components/Spinner";
import type {
  ClusterStatus,
  Pod,
  Deployment,
  K8sService,
  Ingress,
  Namespace,
  PersistentVolumeClaim,
  PersistentVolume,
} from "../lib/types";

type Tab = "pods" | "deployments" | "services" | "ingresses" | "storage";

export default function KubernetesPage() {
  const [status, setStatus] = createSignal<ClusterStatus | null>(null);
  const [namespaces, setNamespaces] = createSignal<Namespace[]>([]);
  const [selectedNs, setSelectedNs] = createSignal("default");
  const [tab, setTab] = createSignal<Tab>("pods");
  const [pods, setPods] = createSignal<Pod[]>([]);
  const [deployments, setDeployments] = createSignal<Deployment[]>([]);
  const [services, setServices] = createSignal<K8sService[]>([]);
  const [ingresses, setIngresses] = createSignal<Ingress[]>([]);
  const [pvcs, setPvcs] = createSignal<PersistentVolumeClaim[]>([]);
  const [pvs, setPvs] = createSignal<PersistentVolume[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [enabling, setEnabling] = createSignal(false);
  const [logPod, setLogPod] = createSignal<string | null>(null);
  const [logLines, setLogLines] = createSignal<string[]>([]);

  // Setup progress dialog
  const [setupDialogOpen, setSetupDialogOpen] = createSignal(false);
  const [setupLog, setSetupLog] = createSignal("");
  const [setupRunning, setSetupRunning] = createSignal(false);
  const [setupSuccess, setSetupSuccess] = createSignal<boolean | null>(null);
  let mouseDownOnOverlay = false;

  const refreshStatus = async () => {
    try {
      const s = (await invoke("k8s_status")) as ClusterStatus;
      setStatus(s);
      if (s.running) {
        const ns = (await invoke("k8s_namespaces")) as Namespace[];
        setNamespaces(ns);
        if (!ns.find((n) => n.name === selectedNs())) {
          setSelectedNs(ns.length > 0 ? ns[0].name : "default");
        }
      }
    } catch (e) {
      console.error("Failed to get k8s status:", e);
    }
  };

  const refreshWorkloads = async () => {
    const s = status();
    if (!s?.running) return;
    const ns = selectedNs();
    setLoading(true);
    try {
      const currentTab = tab();
      if (currentTab === "pods") {
        setPods((await invoke("k8s_pods", { namespace: ns })) as Pod[]);
      } else if (currentTab === "deployments") {
        setDeployments((await invoke("k8s_deployments", { namespace: ns })) as Deployment[]);
      } else if (currentTab === "services") {
        setServices((await invoke("k8s_services", { namespace: ns })) as K8sService[]);
      } else if (currentTab === "ingresses") {
        setIngresses((await invoke("k8s_ingresses", { namespace: ns })) as Ingress[]);
      } else if (currentTab === "storage") {
        const [pvcResult, pvResult] = await Promise.all([
          invoke("k8s_pvcs", { namespace: ns }) as Promise<PersistentVolumeClaim[]>,
          invoke("k8s_pvs") as Promise<PersistentVolume[]>,
        ]);
        setPvcs(pvcResult);
        setPvs(pvResult);
      }
    } catch (e) {
      console.error("Failed to load workloads:", e);
    } finally {
      setLoading(false);
    }
  };

  createEffect(() => {
    selectedNs();
    tab();
    refreshWorkloads();
  });

  onMount(() => {
    refreshStatus();
    const interval = setInterval(() => {
      refreshStatus();
      refreshWorkloads();
    }, 5000);
    onCleanup(() => clearInterval(interval));
  });

  const handleEnable = async () => {
    setEnabling(true);
    setSetupLog("Setting up Kubernetes cluster...\nThis may take a few minutes.\n\n");
    setSetupRunning(true);
    setSetupSuccess(null);
    setSetupDialogOpen(true);

    try {
      const result = (await invoke("k8s_enable")) as { output?: string };
      const output = result?.output || "";
      setSetupLog((prev) => prev + output);
      setSetupSuccess(true);
      await refreshStatus();
    } catch (e) {
      setSetupLog((prev) => prev + `\nError: ${e}`);
      setSetupSuccess(false);
    } finally {
      setSetupRunning(false);
      setEnabling(false);
    }
  };

  const closeSetupDialog = async () => {
    setSetupDialogOpen(false);
    await refreshStatus();
  };

  const handleDisable = async () => {
    try {
      await invoke("k8s_disable");
      showToast("Kubernetes cluster disabled", "success");
      await refreshStatus();
    } catch (e) {
      showToast(`Failed to disable: ${e}`, "error");
    }
  };

  const handleReset = async () => {
    if (!window.confirm("Reset Kubernetes cluster? This will delete ALL workloads and data.")) return;
    try {
      await invoke("k8s_reset");
      showToast("Kubernetes cluster reset", "success");
      await refreshStatus();
    } catch (e) {
      showToast(`Failed to reset: ${e}`, "error");
    }
  };

  const handleDeletePod = async (namespace: string, name: string) => {
    if (!window.confirm(`Delete pod '${name}'?`)) return;
    try {
      await invoke("k8s_delete_pod", { namespace, name });
      showToast(`Pod ${name} deleted`, "success");
      await refreshWorkloads();
    } catch (e) {
      showToast(`Failed to delete pod: ${e}`, "error");
    }
  };

  const handleScale = async (namespace: string, name: string) => {
    const input = prompt(`Scale deployment "${name}" — enter replica count:`);
    if (input === null) return;
    const replicas = parseInt(input, 10);
    if (isNaN(replicas) || replicas < 0) {
      showToast("Invalid replica count", "error");
      return;
    }
    try {
      await invoke("k8s_scale_deployment", { namespace, name, replicas });
      showToast(`Scaled ${name} to ${replicas} replicas`, "success");
      await refreshWorkloads();
    } catch (e) {
      showToast(`Failed to scale: ${e}`, "error");
    }
  };

  const handleRestart = async (namespace: string, name: string) => {
    try {
      await invoke("k8s_restart_deployment", { namespace, name });
      showToast(`Deployment ${name} restarting`, "success");
      await refreshWorkloads();
    } catch (e) {
      showToast(`Failed to restart: ${e}`, "error");
    }
  };

  const handleDeletePvc = async (namespace: string, name: string) => {
    if (!window.confirm(`Delete PVC '${name}'? Associated data may be lost.`)) return;
    try {
      await invoke("k8s_delete_pvc", { namespace, name });
      showToast(`PVC ${name} deleted`, "success");
      await refreshWorkloads();
    } catch (e) {
      showToast(`Failed to delete PVC: ${e}`, "error");
    }
  };

  const handleViewLogs = async (namespace: string, name: string) => {
    setLogPod(name);
    try {
      const lines = (await invoke("k8s_pod_logs", {
        namespace,
        name,
        container: null,
        tail: 200,
      })) as string[];
      setLogLines(lines);
    } catch (e) {
      showToast(`Failed to get logs: ${e}`, "error");
      setLogPod(null);
    }
  };

  const podStatusColor = (s: string) => {
    switch (s) {
      case "Running": return "#3fb950";
      case "Succeeded": return "#8b949e";
      case "Pending": return "#d29922";
      case "Failed": return "#f85149";
      default: return "#848d97";
    }
  };

  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: "pods", label: "Pods", icon: "\u2B22" },
    { id: "deployments", label: "Deployments", icon: "\u25A6" },
    { id: "services", label: "Services", icon: "\u29BF" },
    { id: "ingresses", label: "Ingresses", icon: "\u21C4" },
    { id: "storage", label: "Storage", icon: "\u25A8" },
  ];

  const emptyMessages: Record<Tab, { title: string; desc: string }> = {
    pods: { title: "No pods in this namespace", desc: "Pods will appear here when you deploy workloads to this namespace." },
    deployments: { title: "No deployments in this namespace", desc: "Create a deployment to manage replicated pods." },
    services: { title: "No services in this namespace", desc: "Services provide stable networking endpoints for your pods." },
    ingresses: { title: "No ingresses in this namespace", desc: "Ingresses route external HTTP traffic to your services via Traefik." },
    storage: { title: "No storage resources", desc: "Persistent Volume Claims will appear when workloads request storage." },
  };

  return (
    <div>
      <div class="page-header">
        <h1 class="page-title">Kubernetes</h1>
        <button class="btn" onClick={() => { refreshStatus(); refreshWorkloads(); }}>
          Refresh
        </button>
      </div>

      {/* Hero Card: Not installed / Enabling */}
      <Show when={status() && !status()!.running}>
        <div class="hero-card">
          <Show when={enabling()}>
            <div class="hero-spinner">
              <Spinner />
              <div class="hero-title" style={{ "font-size": "20px" }}>Setting up cluster...</div>
              <div class="hero-subtitle" style={{ "margin-bottom": "0" }}>
                Installing k3s and configuring Traefik ingress. This may take a minute.
              </div>
            </div>
          </Show>
          <Show when={!enabling()}>
            <div style={{ position: "relative" }}>
              <div style={{ "font-size": "48px", "margin-bottom": "16px", opacity: "0.6" }}>{"\u2638"}</div>
              <div class="hero-title">Kubernetes</div>
              <div class="hero-subtitle">
                Run a local Kubernetes cluster powered by k3s with Traefik ingress.
                Deploy, scale, and manage containerized workloads with a production-grade orchestrator.
              </div>
              <button
                class="btn btn-primary btn-hero"
                onClick={handleEnable}
              >
                Enable Kubernetes
              </button>
            </div>
          </Show>
        </div>
      </Show>

      {/* Hero Card: Running */}
      <Show when={status()?.running}>
        <div class="hero-card hero-card-running">
          <div style={{
            display: "flex",
            "align-items": "center",
            "justify-content": "space-between",
            "margin-bottom": "20px",
            position: "relative",
          }}>
            <div style={{ display: "flex", "align-items": "center", gap: "12px" }}>
              <span style={{
                width: "10px",
                height: "10px",
                "border-radius": "50%",
                background: "#3fb950",
                display: "inline-block",
                "box-shadow": "0 0 8px #3fb95044",
              }} />
              <span style={{ "font-size": "18px", "font-weight": "600", color: "#e6edf3" }}>
                Cluster Running
              </span>
            </div>
            <div style={{ display: "flex", gap: "8px" }}>
              <Show when={status()?.traefik_dashboard}>
                <a
                  href={status()!.traefik_dashboard!}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="btn"
                  style={{ "text-decoration": "none" }}
                >
                  Traefik Dashboard
                </a>
              </Show>
              <button class="btn btn-danger" onClick={handleReset}>
                Reset
              </button>
              <button class="btn btn-danger" onClick={handleDisable}>
                Disable
              </button>
            </div>
          </div>

          <div class="hero-status-grid">
            <div class="hero-stat">
              <div class="hero-stat-label">Version</div>
              <div class="hero-stat-value">{status()?.version || "-"}</div>
            </div>
            <div class="hero-stat">
              <div class="hero-stat-label">Node</div>
              <div class="hero-stat-value">{status()?.node_name || "-"}</div>
              <div class="hero-stat-sub">{status()?.node_status || ""}</div>
            </div>
            <div class="hero-stat">
              <div class="hero-stat-label">Pods Running</div>
              <div class="hero-stat-value" style={{ color: "#3fb950" }}>
                {status()?.pods_running}
                <span style={{ color: "#8b949e", "font-size": "14px", "font-weight": "400" }}>
                  {" / "}{status()?.pods_total}
                </span>
              </div>
            </div>
            <div class="hero-stat">
              <div class="hero-stat-label">Namespaces</div>
              <div class="hero-stat-value">{namespaces().length}</div>
            </div>
          </div>
        </div>
      </Show>

      {/* Status loading state */}
      <Show when={!status()}>
        <div class="hero-card">
          <div class="hero-spinner">
            <Spinner />
            <div style={{ color: "#8b949e", "font-size": "14px" }}>Loading cluster status...</div>
          </div>
        </div>
      </Show>

      {/* Workload area */}
      <Show when={status()?.running}>
        {/* Namespace selector + Tabs */}
        <div style={{
          display: "flex",
          "align-items": "center",
          gap: "16px",
          "margin-bottom": "0",
        }}>
          <label style={{ color: "#8b949e", "font-size": "13px" }}>Namespace:</label>
          <select
            value={selectedNs()}
            onChange={(e) => setSelectedNs(e.currentTarget.value)}
            class="form-select"
            style={{ padding: "6px 28px 6px 10px", "font-size": "13px", "min-width": "140px" }}
          >
            <For each={namespaces()}>
              {(ns) => <option value={ns.name}>{ns.name}</option>}
            </For>
          </select>
        </div>

        {/* Tab bar */}
        <div class="tab-bar" style={{ "margin-top": "16px" }}>
          <For each={tabs}>
            {(t) => (
              <button
                class={`tab-item ${tab() === t.id ? "active" : ""}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            )}
          </For>
        </div>

        {/* Loading indicator */}
        <Show when={loading()}>
          <div style={{ color: "#8b949e", "text-align": "center", padding: "20px" }}>
            <Spinner />
          </div>
        </Show>

        {/* Pods Tab */}
        <Show when={tab() === "pods" && !loading()}>
          <Show
            when={pods().length > 0}
            fallback={
              <div class="empty-state-tab">
                <div class="empty-state-tab-title">{emptyMessages.pods.title}</div>
                <div class="empty-state-tab-desc">{emptyMessages.pods.desc}</div>
              </div>
            }
          >
            <table class="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Ready</th>
                  <th>Status</th>
                  <th>Restarts</th>
                  <th>Age</th>
                  <th>IP</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                <For each={pods()}>
                  {(pod) => (
                    <tr>
                      <td style={{ "font-weight": "500" }}>{pod.name}</td>
                      <td class="mono">{pod.ready}</td>
                      <td>
                        <span style={{
                          color: podStatusColor(pod.status),
                          "font-weight": "500",
                        }}>
                          {pod.status}
                        </span>
                      </td>
                      <td class="mono">{pod.restarts}</td>
                      <td style={{ color: "#8b949e" }}>{pod.age}</td>
                      <td class="mono" style={{ color: "#8b949e" }}>{pod.ip || "-"}</td>
                      <td>
                        <div style={{ display: "flex", gap: "4px" }}>
                          <button
                            class="btn btn-sm"
                            onClick={() => handleViewLogs(pod.namespace, pod.name)}
                          >
                            Logs
                          </button>
                          <button
                            class="btn btn-sm btn-danger"
                            onClick={() => handleDeletePod(pod.namespace, pod.name)}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </Show>

        {/* Deployments Tab */}
        <Show when={tab() === "deployments" && !loading()}>
          <Show
            when={deployments().length > 0}
            fallback={
              <div class="empty-state-tab">
                <div class="empty-state-tab-title">{emptyMessages.deployments.title}</div>
                <div class="empty-state-tab-desc">{emptyMessages.deployments.desc}</div>
              </div>
            }
          >
            <table class="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Ready</th>
                  <th>Images</th>
                  <th>Age</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                <For each={deployments()}>
                  {(dep) => (
                    <tr>
                      <td style={{ "font-weight": "500" }}>{dep.name}</td>
                      <td class="mono">
                        <span style={{
                          color: dep.replicas_ready === dep.replicas_desired ? "#3fb950" : "#d29922",
                        }}>
                          {dep.replicas_ready}
                        </span>
                        <span style={{ color: "#8b949e" }}> / {dep.replicas_desired}</span>
                      </td>
                      <td style={{ "max-width": "300px" }}>
                        <For each={dep.images}>
                          {(img) => (
                            <div class="mono" style={{
                              "font-size": "12px",
                              color: "#8b949e",
                              "white-space": "nowrap",
                              overflow: "hidden",
                              "text-overflow": "ellipsis",
                            }}>
                              {img}
                            </div>
                          )}
                        </For>
                      </td>
                      <td style={{ color: "#8b949e" }}>{dep.age}</td>
                      <td>
                        <div style={{ display: "flex", gap: "4px" }}>
                          <button
                            class="btn btn-sm"
                            onClick={() => handleScale(dep.namespace, dep.name)}
                          >
                            Scale
                          </button>
                          <button
                            class="btn btn-sm"
                            onClick={() => handleRestart(dep.namespace, dep.name)}
                          >
                            Restart
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </Show>

        {/* Services Tab */}
        <Show when={tab() === "services" && !loading()}>
          <Show
            when={services().length > 0}
            fallback={
              <div class="empty-state-tab">
                <div class="empty-state-tab-title">{emptyMessages.services.title}</div>
                <div class="empty-state-tab-desc">{emptyMessages.services.desc}</div>
              </div>
            }
          >
            <table class="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Cluster IP</th>
                  <th>Ports</th>
                  <th>Age</th>
                </tr>
              </thead>
              <tbody>
                <For each={services()}>
                  {(svc) => (
                    <tr>
                      <td style={{ "font-weight": "500" }}>{svc.name}</td>
                      <td>
                        <span style={{
                          background: svc.service_type === "LoadBalancer" ? "#1f3a2a" : "#1c2333",
                          color: svc.service_type === "LoadBalancer" ? "#3fb950" : "#79c0ff",
                          padding: "2px 8px",
                          "border-radius": "10px",
                          "font-size": "12px",
                        }}>
                          {svc.service_type}
                        </span>
                      </td>
                      <td class="mono" style={{ color: "#8b949e" }}>{svc.cluster_ip || "-"}</td>
                      <td class="mono" style={{ "font-size": "12px" }}>
                        {svc.ports.map((p) => {
                          let s = `${p.port}`;
                          if (p.target_port && p.target_port !== String(p.port)) {
                            s += `:${p.target_port}`;
                          }
                          s += `/${p.protocol}`;
                          if (p.node_port) s += ` (${p.node_port})`;
                          return s;
                        }).join(", ")}
                      </td>
                      <td style={{ color: "#8b949e" }}>{svc.age}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </Show>

        {/* Ingresses Tab */}
        <Show when={tab() === "ingresses" && !loading()}>
          <Show
            when={ingresses().length > 0}
            fallback={
              <div class="empty-state-tab">
                <div class="empty-state-tab-title">{emptyMessages.ingresses.title}</div>
                <div class="empty-state-tab-desc">{emptyMessages.ingresses.desc}</div>
              </div>
            }
          >
            <table class="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Hosts</th>
                  <th>Address</th>
                  <th>Age</th>
                </tr>
              </thead>
              <tbody>
                <For each={ingresses()}>
                  {(ing) => (
                    <tr>
                      <td style={{ "font-weight": "500" }}>{ing.name}</td>
                      <td class="mono">{ing.hosts.join(", ") || "-"}</td>
                      <td class="mono" style={{ color: "#8b949e" }}>{ing.address || "-"}</td>
                      <td style={{ color: "#8b949e" }}>{ing.age}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </Show>

        {/* Storage Tab */}
        <Show when={tab() === "storage" && !loading()}>
          <h3 style={{ color: "#e6edf3", "font-size": "14px", "margin-bottom": "12px" }}>
            Persistent Volume Claims
          </h3>
          <Show
            when={pvcs().length > 0}
            fallback={
              <div class="empty-state-tab" style={{ "margin-bottom": "24px", padding: "32px 20px" }}>
                <div class="empty-state-tab-title">No PVCs in this namespace</div>
                <div class="empty-state-tab-desc">{emptyMessages.storage.desc}</div>
              </div>
            }
          >
            <table class="table" style={{ "margin-bottom": "24px" }}>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Volume</th>
                  <th>Capacity</th>
                  <th>Class</th>
                  <th>Age</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                <For each={pvcs()}>
                  {(pvc) => (
                    <tr>
                      <td style={{ "font-weight": "500" }}>{pvc.name}</td>
                      <td>
                        <span style={{
                          color: pvc.status === "Bound" ? "#3fb950" : "#d29922",
                          "font-weight": "500",
                        }}>
                          {pvc.status}
                        </span>
                      </td>
                      <td class="mono" style={{ color: "#8b949e", "font-size": "12px" }}>
                        {pvc.volume || "-"}
                      </td>
                      <td class="mono">{pvc.capacity || "-"}</td>
                      <td style={{ color: "#8b949e" }}>{pvc.storage_class || "-"}</td>
                      <td style={{ color: "#8b949e" }}>{pvc.age}</td>
                      <td>
                        <button
                          class="btn btn-sm btn-danger"
                          onClick={() => handleDeletePvc(pvc.namespace, pvc.name)}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>

          <h3 style={{ color: "#e6edf3", "font-size": "14px", "margin-bottom": "12px" }}>
            Persistent Volumes
          </h3>
          <Show
            when={pvs().length > 0}
            fallback={
              <div class="empty-state-tab" style={{ padding: "32px 20px" }}>
                <div class="empty-state-tab-title">No persistent volumes</div>
              </div>
            }
          >
            <table class="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Capacity</th>
                  <th>Status</th>
                  <th>Claim</th>
                  <th>Reclaim Policy</th>
                  <th>Class</th>
                  <th>Age</th>
                </tr>
              </thead>
              <tbody>
                <For each={pvs()}>
                  {(pv) => (
                    <tr>
                      <td style={{ "font-weight": "500" }}>{pv.name}</td>
                      <td class="mono">{pv.capacity || "-"}</td>
                      <td>
                        <span style={{
                          color: pv.status === "Bound" ? "#3fb950" : pv.status === "Available" ? "#79c0ff" : "#d29922",
                          "font-weight": "500",
                        }}>
                          {pv.status}
                        </span>
                      </td>
                      <td class="mono" style={{ color: "#8b949e", "font-size": "12px" }}>
                        {pv.claim || "-"}
                      </td>
                      <td style={{ color: "#8b949e" }}>{pv.reclaim_policy || "-"}</td>
                      <td style={{ color: "#8b949e" }}>{pv.storage_class || "-"}</td>
                      <td style={{ color: "#8b949e" }}>{pv.age}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </Show>
      </Show>

      {/* Log Viewer Modal */}
      <Show when={logPod()}>
        <div style={{
          position: "fixed",
          inset: "0",
          background: "rgba(0,0,0,0.6)",
          display: "flex",
          "align-items": "center",
          "justify-content": "center",
          "z-index": "1000",
        }} onClick={() => setLogPod(null)}>
          <div style={{
            background: "#161b22",
            border: "1px solid #30363d",
            "border-radius": "10px",
            width: "80vw",
            "max-width": "900px",
            height: "70vh",
            display: "flex",
            "flex-direction": "column",
            overflow: "hidden",
          }} onClick={(e) => e.stopPropagation()}>
            <div style={{
              display: "flex",
              "align-items": "center",
              "justify-content": "space-between",
              padding: "12px 16px",
              "border-bottom": "1px solid #30363d",
            }}>
              <span style={{ color: "#e6edf3", "font-weight": "600" }}>
                Logs: {logPod()}
              </span>
              <button class="btn btn-sm" onClick={() => setLogPod(null)}>Close</button>
            </div>
            <div style={{
              flex: "1",
              overflow: "auto",
              padding: "12px 16px",
              "font-family": "'JetBrains Mono', 'Fira Code', monospace",
              "font-size": "12px",
              "line-height": "1.6",
              color: "#c9d1d9",
              "white-space": "pre-wrap",
              "word-break": "break-all",
            }}>
              <Show
                when={logLines().length > 0}
                fallback={<span style={{ color: "#8b949e" }}>No log output</span>}
              >
                <For each={logLines()}>
                  {(line) => <div>{line}</div>}
                </For>
              </Show>
            </div>
          </div>
        </div>
      </Show>

      {/* Kubernetes Setup Progress Dialog */}
      <Show when={setupDialogOpen()}>
        <div class="modal-overlay"
          onMouseDown={(e) => { mouseDownOnOverlay = (e.target as HTMLElement).classList.contains("modal-overlay"); }}
          onClick={(e) => { if (mouseDownOnOverlay && (e.target as HTMLElement).classList.contains("modal-overlay") && !setupRunning()) closeSetupDialog(); mouseDownOnOverlay = false; }}
        >
          <div class="modal-dialog" style={{ "max-width": "640px" }}>
            <div class="modal-header">
              <span class="modal-title">
                <Show when={setupRunning()} fallback={
                  <Show when={setupSuccess()} fallback={
                    <span style={{ color: "#f85149" }}>{"\u2717"} Kubernetes setup failed</span>
                  }>
                    <span style={{ color: "#3fb950" }}>{"\u2713"} Kubernetes cluster ready</span>
                  </Show>
                }>
                  <span>Setting up Kubernetes...</span>
                </Show>
              </span>
              <Show when={!setupRunning()}>
                <button class="modal-close" onClick={closeSetupDialog}>{"\u00d7"}</button>
              </Show>
            </div>
            <div style={{ padding: "0" }}>
              <Show when={setupRunning()}>
                <div style={{ height: "3px", background: "#21262d", overflow: "hidden" }}>
                  <div style={{ height: "100%", width: "30%", background: "#58a6ff", animation: "progress-slide 1.5s ease-in-out infinite", "border-radius": "2px" }} />
                </div>
              </Show>
              <pre style={{
                padding: "16px", margin: 0,
                "font-family": "'JetBrains Mono NF', monospace",
                "font-size": "12px", "line-height": "1.6",
                color: "#c9d1d9", "white-space": "pre-wrap",
                "word-break": "break-all", "max-height": "400px",
                "min-height": "120px", overflow: "auto",
                background: "#0d1117",
              }}>{setupLog()}</pre>
            </div>
            <div class="modal-footer">
              <Show when={!setupRunning()}>
                <button class="btn btn-primary" onClick={closeSetupDialog}>Close</button>
              </Show>
              <Show when={setupRunning()}>
                <span style={{ "font-size": "12px", color: "var(--text-muted)" }}>
                  This may take several minutes — downloading k3s and waiting for the cluster...
                </span>
              </Show>
            </div>
          </div>
        </div>
      </Show>

      <style>{`
        @keyframes progress-slide {
          0% { transform: translateX(-100%); }
          50% { transform: translateX(233%); }
          100% { transform: translateX(-100%); }
        }
      `}</style>
    </div>
  );
}
