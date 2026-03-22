import { createSignal, onMount, onCleanup, For, Show, createEffect } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { showToast } from "../components/Toast";
import { useRefresh } from "../lib/useRefresh";
import { confirmDanger } from "../components/ConfirmDialog";
import { logError, logInfo } from "../lib/activityStore";
import Spinner from "../components/Spinner";
import YamlEditor from "../components/YamlEditor";
import Dropdown from "../components/Dropdown";
import CopyButton from "../components/CopyButton";
import type {
  ClusterStatus,
  Pod,
  Deployment,
  K8sService,
  Ingress,
  Namespace,
  PersistentVolumeClaim,
  PersistentVolume,
  K8sEvent,
  K8sConfigMap,
  K8sSecret,
  PodMetrics,
  RolloutRevision,
  HelmRelease,
} from "../lib/types";

type Tab = "pods" | "deployments" | "services" | "ingresses" | "storage" | "events" | "config" | "helm" | "topology";

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
  const [portForwards, setPortForwards] = createSignal<Set<string>>(new Set());
  const [k8sMenuOpen, setK8sMenuOpen] = createSignal(false);
  const [scaleTarget, setScaleTarget] = createSignal<{ namespace: string; name: string; current: number } | null>(null);
  const [scaleValue, setScaleValue] = createSignal(1);
  const [portForwardEditing, setPortForwardEditing] = createSignal<string | null>(null);
  const [portForwardLocalPort, setPortForwardLocalPort] = createSignal("");
  const [logPod, setLogPod] = createSignal<string | null>(null);
  const [logLines, setLogLines] = createSignal<string[]>([]);
  const [portDialogSvc, setPortDialogSvc] = createSignal<K8sService | null>(null);
  const [portDialogLocalPorts, setPortDialogLocalPorts] = createSignal<Record<number, string>>({});
  const [yamlResource, setYamlResource] = createSignal<{ kind: string; name: string; namespace: string; yaml: string } | null>(null);
  const [events, setEvents] = createSignal<K8sEvent[]>([]);
  const [configMaps, setConfigMaps] = createSignal<K8sConfigMap[]>([]);
  const [secrets, setSecrets] = createSignal<K8sSecret[]>([]);
  const [configSubTab, setConfigSubTab] = createSignal<"configmaps" | "secrets">("configmaps");
  const [deployYamlOpen, setDeployYamlOpen] = createSignal(false);
  const [createNsOpen, setCreateNsOpen] = createSignal(false);
  const [newNsName, setNewNsName] = createSignal("");
  const [shellPod, setShellPod] = createSignal<{ name: string; namespace: string } | null>(null);
  const [viewConfigMap, setViewConfigMap] = createSignal<K8sConfigMap | null>(null);
  const [viewSecret, setViewSecret] = createSignal<K8sSecret | null>(null);
  const [revealedKeys, setRevealedKeys] = createSignal<Set<string>>(new Set());

  // Feature 1: Pod Metrics
  const [podMetrics, setPodMetrics] = createSignal<Record<string, PodMetrics>>({});

  // Feature 2: Deployment Rollback
  const [rollbackDep, setRollbackDep] = createSignal<{ namespace: string; name: string } | null>(null);
  const [rollbackHistory, setRollbackHistory] = createSignal<RolloutRevision[]>([]);
  const [rollbackLoading, setRollbackLoading] = createSignal(false);

  // Feature 3: Log Follow
  const [logFollow, setLogFollow] = createSignal(false);
  const [logTail, setLogTail] = createSignal(200);
  let logFollowInterval: ReturnType<typeof setInterval> | null = null;
  let logContainerRef: HTMLDivElement | undefined;

  // Feature 4: Helm
  const [helmReleases, setHelmReleases] = createSignal<HelmRelease[]>([]);
  const [helmAvailable, setHelmAvailable] = createSignal<boolean | null>(null);

  // Feature 5: Topology (data computed from existing signals)

  // Setup progress dialog
  const [setupDialogOpen, setSetupDialogOpen] = createSignal(false);
  const [setupLog, setSetupLog] = createSignal("");
  const [setupRunning, setSetupRunning] = createSignal(false);
  const [setupSuccess, setSetupSuccess] = createSignal<boolean | null>(null);
  let mouseDownOnOverlay = false;
  let setupLogRef: HTMLPreElement | undefined;

  // Auto-scroll setup log
  createEffect(() => {
    setupLog();
    if (setupLogRef) setupLogRef.scrollTop = setupLogRef.scrollHeight;
  });

  const refreshStatus = async () => {
    try {
      const s = (await invoke("k8s_status")) as ClusterStatus;
      setStatus(s);
      if (s.running) {
        try {
          const ns = (await invoke("k8s_namespaces")) as Namespace[];
          if (ns.length > 0) {
            setNamespaces(ns);
            // Only auto-select on first load (when still on default with no data)
            if (!ns.find((n: Namespace) => n.name === selectedNs()) && namespaces().length === 0) {
              setSelectedNs(ns[0].name);
            }
          }
        } catch {
          // If namespace listing fails and we have nothing, provide defaults
          if (namespaces().length === 0) {
            setNamespaces([
              { name: "default", status: "Active", age: "" },
              { name: "kube-system", status: "Active", age: "" },
            ]);
          }
        }
      }
    } catch (e) {
    }
  };

  useRefresh(refreshStatus);

  let hasLoadedOnce = false;

  const refreshWorkloads = async () => {
    const s = status();
    if (!s?.running) return;
    const ns = selectedNs();
    // Only show spinner on first load — never on refresh
    if (!hasLoadedOnce) setLoading(true);
    try {
      const currentTab = tab();
      if (currentTab === "pods") {
        const [podResult, metricsResult] = await Promise.allSettled([
          invoke("k8s_pods", { namespace: ns }) as Promise<Pod[]>,
          invoke("k8s_pod_metrics", { namespace: ns }) as Promise<PodMetrics[]>,
        ]);
        if (podResult.status === "fulfilled") setPods(podResult.value);
        if (metricsResult.status === "fulfilled") {
          const map: Record<string, PodMetrics> = {};
          for (const m of metricsResult.value) {
            map[m.name] = m;
          }
          setPodMetrics(map);
        }
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
      } else if (currentTab === "events") {
        setEvents((await invoke("k8s_events", { namespace: ns })) as K8sEvent[]);
      } else if (currentTab === "config") {
        const [cmResult, secResult] = await Promise.all([
          invoke("k8s_configmaps", { namespace: ns }) as Promise<K8sConfigMap[]>,
          invoke("k8s_secrets", { namespace: ns }) as Promise<K8sSecret[]>,
        ]);
        setConfigMaps(cmResult);
        setSecrets(secResult);
      } else if (currentTab === "helm") {
        try {
          if (helmAvailable() === null) {
            const avail = (await invoke("k8s_helm_available")) as { available: boolean };
            setHelmAvailable(avail.available);
          }
          if (helmAvailable()) {
            setHelmReleases((await invoke("k8s_helm_list")) as HelmRelease[]);
          }
        } catch { /* helm not available */ }
      } else if (currentTab === "topology") {
        // Topology needs pods, deployments, and services
        const [p, d, s] = await Promise.all([
          invoke("k8s_pods", { namespace: ns }) as Promise<Pod[]>,
          invoke("k8s_deployments", { namespace: ns }) as Promise<Deployment[]>,
          invoke("k8s_services", { namespace: ns }) as Promise<K8sService[]>,
        ]);
        setPods(p);
        setDeployments(d);
        setServices(s);
      }
    } catch (e) {
    } finally {
      setLoading(false);
      hasLoadedOnce = true;
    }
  };

  createEffect(() => {
    selectedNs();
    tab();
    refreshWorkloads();
  });

  // Close K8s menu on outside click
  const handleDocClick = (e: MouseEvent) => {
    if (k8sMenuOpen() && !(e.target as HTMLElement)?.closest?.(".dropdown-wrapper")) {
      setK8sMenuOpen(false);
    }
  };

  onMount(() => {
    document.addEventListener("click", handleDocClick);
    refreshStatus();
    refreshPortForwards();
    const interval = setInterval(() => {
      refreshStatus();
      refreshWorkloads();
    }, 5000);
    onCleanup(() => {
      clearInterval(interval);
      document.removeEventListener("click", handleDocClick);
    });
  });

  const handleEnable = async () => {
    setEnabling(true);
    setSetupLog("");
    setSetupRunning(true);
    setSetupSuccess(null);
    setSetupDialogOpen(true);

    try {
      // Get auth token for WebSocket
      let token = "";
      try { token = await invoke("get_api_token") as string; } catch {}

      const wsUrl = `ws://127.0.0.1:9477/api/v1/k8s/enable-stream?token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        setSetupLog("Starting Kubernetes setup...\n");
      };

      ws.onmessage = (event) => {
        const line = event.data;
        if (line === "[DONE]") {
          setSetupSuccess(true);
          setSetupRunning(false);
          setEnabling(false);
          refreshStatus();
          ws.close();
        } else if (line === "[ERROR]") {
          setSetupSuccess(false);
          setSetupRunning(false);
          setEnabling(false);
          ws.close();
        } else {
          setSetupLog((prev) => prev + line + "\n");
          // Check for instruction-style output (not an actual install)
          if (line.includes("To set up") || line.includes("Docker Desktop")) {
            setSetupSuccess(null); // informational, not success/failure
          }
        }
      };

      ws.onerror = () => {
        // WebSocket failed — fall back to non-streaming invoke
        ws.close();
        (async () => {
          try {
            setSetupLog("Live streaming not available, using batch mode...\n\n");
            const result = (await invoke("k8s_enable")) as any;
            const output = typeof result === "string" ? result : (result?.output || JSON.stringify(result, null, 2));
            if (output && output !== "{}" && output !== "null") {
              setSetupLog(output);
              const isReady = output.includes("cluster is ready") || output.includes("Ready");
              const isInstructions = output.includes("To set up") || output.includes("Docker Desktop") || output.includes("Lima");
              setSetupSuccess(isReady ? true : isInstructions ? null : true);
            } else {
              setSetupLog("No output from daemon. Check the Activity tab and daemon log for details.\n");
              logError("Failed to enable Kubernetes: no output received from daemon");
              setSetupSuccess(false);
            }
            await refreshStatus();
          } catch (e) {
            logError(`Failed to enable Kubernetes: ${e}`);
            setSetupLog((prev) => prev + `\nError: ${e}\n`);
            setSetupSuccess(false);
          } finally {
            setSetupRunning(false);
            setEnabling(false);
          }
        })();
      };

      ws.onclose = () => {
        // Ensure state is cleaned up if connection drops unexpectedly
        if (setupRunning()) {
          setSetupRunning(false);
          setEnabling(false);
          if (setupSuccess() === null) {
            setSetupSuccess(false);
            setSetupLog((prev) => prev + "\nConnection lost.\n");
          }
        }
      };
    } catch (e) {
      logError(`Failed to enable Kubernetes: ${e}`);
      setSetupLog(`Error: ${e}\n`);
      setSetupSuccess(false);
      setSetupRunning(false);
      setEnabling(false);
    }
  };

  const closeSetupDialog = async () => {
    setSetupDialogOpen(false);
    await refreshStatus();
  };

  const refreshPortForwards = async () => {
    try {
      const fwds = (await invoke("k8s_list_port_forwards")) as { namespace: string; service: string; port: string }[];
      setPortForwards(new Set(fwds.map((f) => `${f.namespace}/${f.service}/${f.port}`)));
    } catch {}
  };

  const startPortForward = async (namespace: string, service: string, port: number, localPort?: number) => {
    const local = localPort || port;
    try {
      await invoke("k8s_port_forward", { namespace, service, port, localPort: local });
      showToast(`Port forwarded — accessible at localhost:${local}`, "success");
      await refreshPortForwards();
    } catch (e) {
      showToast(`Port forward failed: ${e}`, "error");
    }
  };

  const stopPortForward = async (namespace: string, service: string, port: number) => {
    try {
      await invoke("k8s_stop_port_forward", { namespace, service, port });
      showToast(`Port forward stopped`, "info");
      await refreshPortForwards();
    } catch {}
  };

  const isForwarded = (namespace: string, service: string, port: number) =>
    portForwards().has(`${namespace}/${service}/${port}`);

  const handleDisable = async () => {
    try {
      await invoke("k8s_disable");
      showToast("Kubernetes cluster disabled", "success");
      await refreshStatus();
    } catch (e) {
      logError(`Failed to disable Kubernetes: ${e}`);
      showToast(`Failed to disable: ${e}`, "error");
    }
  };

  const handleReset = async () => {
    if (!await confirmDanger("Reset Cluster", "Reset Kubernetes cluster? This will delete ALL workloads and data.")) return;
    try {
      await invoke("k8s_reset");
      showToast("Kubernetes cluster reset", "success");
      await refreshStatus();
    } catch (e) {
      logError(`Failed to reset Kubernetes cluster: ${e}`);
      showToast(`Failed to reset: ${e}`, "error");
    }
  };

  const handleDeletePod = async (namespace: string, name: string) => {
    if (!await confirmDanger("Delete Pod", `Delete pod '${name}'?`)) return;
    try {
      await invoke("k8s_delete_pod", { namespace, name });
      showToast(`Pod ${name} deleted`, "success");
      await refreshWorkloads();
    } catch (e) {
      logError(`Failed to delete pod: ${e}`, `Pod "${name}" in namespace "${namespace}"`);
      showToast(`Failed to delete pod: ${e}`, "error");
    }
  };

  const openScaleDialog = (namespace: string, name: string, currentReplicas: number) => {
    setScaleTarget({ namespace, name, current: currentReplicas });
    setScaleValue(currentReplicas);
  };

  const doScale = async () => {
    const target = scaleTarget();
    if (!target) return;
    try {
      await invoke("k8s_scale_deployment", { namespace: target.namespace, name: target.name, replicas: scaleValue() });
      showToast(`Scaled ${target.name} to ${scaleValue()} replicas`, "success");
      setScaleTarget(null);
      await refreshWorkloads();
    } catch (e) {
      logError(`Failed to scale deployment: ${e}`, `Deployment "${target.name}" in "${target.namespace}"`);
      showToast(`Failed to scale: ${e}`, "error");
    }
  };

  const handleRestart = async (namespace: string, name: string) => {
    try {
      await invoke("k8s_restart_deployment", { namespace, name });
      showToast(`Deployment ${name} restarting`, "success");
      await refreshWorkloads();
    } catch (e) {
      logError(`Failed to restart deployment: ${e}`, `Deployment "${name}" in "${namespace}"`);
      showToast(`Failed to restart: ${e}`, "error");
    }
  };

  const handleDeletePvc = async (namespace: string, name: string) => {
    if (!await confirmDanger("Delete PVC", `Delete PVC '${name}'? Associated data may be lost.`)) return;
    try {
      await invoke("k8s_delete_pvc", { namespace, name });
      showToast(`PVC ${name} deleted`, "success");
      await refreshWorkloads();
    } catch (e) {
      logError(`Failed to delete PVC: ${e}`, `PVC "${name}" in namespace "${namespace}"`);
      showToast(`Failed to delete PVC: ${e}`, "error");
    }
  };

  const handleViewLogs = async (namespace: string, name: string) => {
    setLogPod(name);
    setLogFollow(false);
    setLogTail(200);
    if (logFollowInterval) { clearInterval(logFollowInterval); logFollowInterval = null; }
    try {
      const lines = (await invoke("k8s_pod_logs", {
        namespace,
        name,
        container: null,
        tail: 200,
      })) as string[];
      setLogLines(lines);
    } catch (e) {
      logError(`Failed to fetch pod logs: ${e}`, `Pod "${name}" in namespace "${namespace}"`);
      showToast(`Failed to get logs: ${e}`, "error");
      setLogPod(null);
    }
  };

  // Feature 2: Rollback handler
  const handleShowHistory = async (namespace: string, name: string) => {
    setRollbackDep({ namespace, name });
    setRollbackLoading(true);
    try {
      const history = (await invoke("k8s_rollout_history", { namespace, name })) as RolloutRevision[];
      setRollbackHistory(history);
    } catch (e) {
      showToast(`Failed to get rollout history: ${e}`, "error");
      setRollbackDep(null);
    } finally {
      setRollbackLoading(false);
    }
  };

  const handleRollback = async (revision: number) => {
    const dep = rollbackDep();
    if (!dep) return;
    if (!await confirmDanger("Rollback Deployment", `Rollback '${dep.name}' to revision ${revision}?`)) return;
    try {
      await invoke("k8s_rollout_undo", { namespace: dep.namespace, name: dep.name, revision });
      showToast(`Rolling back ${dep.name} to revision ${revision}`, "success");
      setRollbackDep(null);
      await refreshWorkloads();
    } catch (e) {
      showToast(`Rollback failed: ${e}`, "error");
    }
  };

  // Feature 4: Helm uninstall handler
  const handleHelmUninstall = async (name: string, namespace: string) => {
    if (!await confirmDanger("Uninstall Helm Release", `Uninstall '${name}' from namespace '${namespace}'?`)) return;
    try {
      await invoke("k8s_helm_uninstall", { name, namespace });
      showToast(`Helm release '${name}' uninstalled`, "success");
      await refreshWorkloads();
    } catch (e) {
      showToast(`Helm uninstall failed: ${e}`, "error");
    }
  };

  const viewYaml = async (kind: string, name: string, namespace: string) => {
    try {
      const yaml = await invoke("k8s_get_yaml", { kind, name, namespace }) as string;
      if (!yaml || yaml.trim().length === 0) {
        showToast(`No YAML returned for ${kind}/${name}`, "error");
        return;
      }
      setYamlResource({ kind, name, namespace, yaml });
    } catch (e) {
      showToast(`Failed to get YAML for ${kind}/${name}: ${e}`, "error");
    }
  };

  const applyYaml = async (yaml: string) => {
    try {
      await invoke("k8s_apply_yaml", { yaml });
      showToast("YAML applied successfully", "success");
      setYamlResource(null);
      refreshWorkloads();
    } catch (e) {
      showToast(`Failed to apply: ${e}`, "error");
      throw e;
    }
  };

  const handleDeployYaml = async (yaml: string) => {
    try {
      await invoke("k8s_apply_yaml", { yaml });
      showToast("YAML deployed successfully", "success");
      setDeployYamlOpen(false);
      refreshWorkloads();
    } catch (e) {
      showToast(`Failed to deploy: ${e}`, "error");
      throw e;
    }
  };

  const handleCreateNamespace = async () => {
    const name = newNsName().trim();
    if (!name) return;
    try {
      await invoke("k8s_create_namespace", { name });
      showToast(`Namespace '${name}' created`, "success");
      setCreateNsOpen(false);
      setNewNsName("");
      await refreshStatus();
      setSelectedNs(name);
    } catch (e) {
      logError(`Failed to create namespace: ${e}`);
      showToast(`Failed to create namespace: ${e}`, "error");
    }
  };

  const handleDeleteNamespace = async () => {
    const ns = selectedNs();
    if (!await confirmDanger("Delete Namespace", `Delete namespace '${ns}'? This will destroy ALL resources within it.`)) return;
    try {
      await invoke("k8s_delete_namespace", { name: ns });
      showToast(`Namespace '${ns}' deleted`, "success");
      setSelectedNs("default");
      await refreshStatus();
    } catch (e) {
      logError(`Failed to delete namespace: ${e}`);
      showToast(`Failed to delete namespace: ${e}`, "error");
    }
  };

  const systemNamespaces = new Set(["default", "kube-system", "kube-public", "kube-node-lease"]);

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
    { id: "events", label: "Events", icon: "\u26A0" },
    { id: "config", label: "Config", icon: "\u2699" },
    { id: "helm", label: "Helm", icon: "\u2388" },
    { id: "topology", label: "Topology", icon: "\u25CE" },
  ];

  const emptyMessages: Record<Tab, { title: string; desc: string }> = {
    pods: { title: "No pods in this namespace", desc: "Pods will appear here when you deploy workloads to this namespace." },
    deployments: { title: "No deployments in this namespace", desc: "Create a deployment to manage replicated pods." },
    services: { title: "No services in this namespace", desc: "Services provide stable networking endpoints for your pods." },
    ingresses: { title: "No ingresses in this namespace", desc: "Ingresses route external HTTP traffic to your services via Traefik." },
    storage: { title: "No storage resources", desc: "Persistent Volume Claims will appear when workloads request storage." },
    events: { title: "No events in this namespace", desc: "Events will appear when Kubernetes resources change state." },
    config: { title: "No ConfigMaps or Secrets", desc: "ConfigMaps and Secrets store configuration data for your workloads." },
    helm: { title: "No Helm releases", desc: "Install Helm charts using the helm CLI to manage releases here." },
    topology: { title: "No resources to visualize", desc: "Deploy workloads to see a visual topology of your namespace." },
  };

  return (
    <div>
      <div class="page-header">
        <h1 class="page-title">Kubernetes</h1>
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
              <Show when={status()?.error}>
                <div style={{
                  "margin-top": "16px",
                  padding: "10px 14px",
                  background: "rgba(248, 81, 73, 0.08)",
                  border: "1px solid rgba(248, 81, 73, 0.2)",
                  "border-radius": "8px",
                  "font-size": "12px",
                  color: "#f85149",
                  "text-align": "left",
                  "max-width": "500px",
                  margin: "16px auto 0",
                }}>
                  <strong>Detection issue:</strong> {status()?.error}
                </div>
              </Show>
            </div>
          </Show>
        </div>
      </Show>

      {/* Compact status bar when running */}
      <Show when={status()?.running}>
        <div style={{
          display: "flex",
          "align-items": "center",
          gap: "16px",
          padding: "10px 16px",
          background: "rgba(22, 27, 34, 0.5)",
          border: "1px solid rgba(255,255,255,0.06)",
          "border-radius": "10px",
          "margin-bottom": "16px",
          "flex-wrap": "wrap",
        }}>
          <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
            <span style={{
              width: "8px", height: "8px", "border-radius": "50%",
              background: "#3fb950", "box-shadow": "0 0 6px #3fb95044",
            }} />
            <span style={{ "font-weight": "600", "font-size": "13px" }}>
              {status()?.version || "Kubernetes"}
            </span>
          </div>
          <span class="status-bar-separator" />
          <span style={{ "font-size": "12px", color: "#8b949e" }}>
            {status()?.node_name}
          </span>
          <span class="status-bar-separator" />
          <span style={{ "font-size": "12px", color: "#3fb950" }}>
            {status()?.pods_running}/{status()?.pods_total} pods
          </span>
          <div style={{ "margin-left": "auto", display: "flex", gap: "6px" }}>
            <Show when={status()?.traefik_dashboard}>
              <a href={status()!.traefik_dashboard!} target="_blank" class="btn btn-sm" style={{ "text-decoration": "none", "font-size": "11px" }}>
                Traefik
              </a>
            </Show>
            <div class="dropdown-wrapper">
              <button
                class="action-icon"
                onClick={() => setK8sMenuOpen(!k8sMenuOpen())}
                title="More actions"
                style={{ color: "#8b949e" }}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><circle cx="3" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="13" cy="8" r="1.5"/></svg>
              </button>
              <Show when={k8sMenuOpen()}>
                <div class="dropdown-menu" style={{ "min-width": "200px" }} onClick={() => setK8sMenuOpen(false)}>
                  <button class="dropdown-item" onClick={() => { refreshStatus(); refreshWorkloads(); }}>
                    {"\u21BB"} Refresh
                  </button>
                  <div class="dropdown-divider" />
                  <button class="dropdown-item dropdown-item-danger" onClick={handleReset}>
                    {"\u26A0"} Reset Cluster
                  </button>
                  <button class="dropdown-item dropdown-item-danger" onClick={handleDisable}>
                    {"\u2715"} Disable Kubernetes
                  </button>
                </div>
              </Show>
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
          <Dropdown
            value={selectedNs()}
            options={namespaces().map((ns) => ({ value: ns.name, label: ns.name }))}
            onChange={(v) => setSelectedNs(v)}
            style={{ "min-width": "160px" }}
          />
          <button
            class="action-icon"
            title="Create namespace"
            onClick={() => { setNewNsName(""); setCreateNsOpen(true); }}
            style={{ color: "#3fb950", "font-size": "16px" }}
          >
            +
          </button>
          <Show when={!systemNamespaces.has(selectedNs())}>
            <button
              class="action-icon action-icon-delete"
              title="Delete namespace"
              onClick={handleDeleteNamespace}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </Show>
          <div style={{ "margin-left": "auto" }}>
            <button
              class="btn btn-sm btn-primary"
              title="Deploy from YAML"
              onClick={() => setDeployYamlOpen(true)}
              style={{ "font-size": "12px", padding: "4px 12px" }}
            >
              + Deploy
            </button>
          </div>
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

        {/* Loading indicator — only on first load */}
        <Show when={loading() && !hasLoadedOnce}>
          <div style={{ color: "#8b949e", "text-align": "center", padding: "20px" }}>
            <Spinner />
          </div>
        </Show>

        {/* Pods Tab */}
        <Show when={tab() === "pods"}>
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
                  <th>CPU</th>
                  <th>Memory</th>
                  <th>Restarts</th>
                  <th>Age</th>
                  <th>IP</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                <For each={pods()}>
                  {(pod) => {
                    const metrics = () => podMetrics()[pod.name];
                    return (
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
                      <td class="mono" style={{ color: "#8b949e", "font-size": "12px" }}>
                        {metrics()?.cpu || "\u2014"}
                      </td>
                      <td class="mono" style={{ color: "#8b949e", "font-size": "12px" }}>
                        {metrics()?.memory || "\u2014"}
                      </td>
                      <td class="mono">{pod.restarts}</td>
                      <td style={{ color: "#8b949e" }}>{pod.age}</td>
                      <td class="mono" style={{ color: "#8b949e" }}>{pod.ip || "-"}</td>
                      <td>
                        <div style={{ display: "flex", gap: "4px" }}>
                          <button
                            class="action-icon"
                            title="View logs"
                            onClick={() => handleViewLogs(pod.namespace, pod.name)}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>
                          </button>
                          <button
                            class="action-icon action-icon-restart"
                            title="Restart pod"
                            onClick={() => handleDeletePod(pod.namespace, pod.name)}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
                          </button>
                          <button
                            class="action-icon action-icon-delete"
                            title="Delete pod"
                            onClick={() => handleDeletePod(pod.namespace, pod.name)}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                          </button>
                          <button
                            class="action-icon"
                            title="View/Edit YAML"
                            onClick={() => viewYaml("pod", pod.name, pod.namespace)}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
                          </button>
                          <button
                            class="action-icon"
                            title="Terminal"
                            onClick={() => setShellPod({ name: pod.name, namespace: pod.namespace })}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
                          </button>
                        </div>
                      </td>
                    </tr>
                    );
                  }}
                </For>
              </tbody>
            </table>
          </Show>
        </Show>

        {/* Deployments Tab */}
        <Show when={tab() === "deployments"}>
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
                        <div style={{ display: "flex", gap: "4px", "align-items": "center" }}>
                          <button
                            class="btn btn-sm"
                            style={{ "font-size": "11px" }}
                            onClick={() => openScaleDialog(dep.namespace, dep.name, dep.replicas_desired)}
                          >
                            Scale
                          </button>
                          <button
                            class="action-icon"
                            title="Restart deployment"
                            onClick={() => handleRestart(dep.namespace, dep.name)}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 21h5v-5"/></svg>
                          </button>
                          <button
                            class="action-icon"
                            title="Rollout history"
                            onClick={() => handleShowHistory(dep.namespace, dep.name)}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                          </button>
                          <button
                            class="action-icon"
                            title="View/Edit YAML"
                            onClick={() => viewYaml("deployment", dep.name, dep.namespace)}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
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
        <Show when={tab() === "services"}>
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
                  <th style={{ "text-align": "right" }}>Access</th>
                  <th></th>
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
                      <td style={{ "text-align": "right" }}>
                        <Show when={svc.ports.length > 1} fallback={
                          <div style={{ display: "flex", gap: "4px", "justify-content": "flex-end", "flex-wrap": "wrap", "align-items": "center" }}>
                            <For each={svc.ports}>
                              {(p) => {
                                const editKey = () => `${svc.name}/${p.port}`;
                                const isEditing = () => portForwardEditing() === editKey();
                                return (
                                  <Show when={isForwarded(selectedNs(), svc.name, p.port)} fallback={
                                    <Show when={isEditing()} fallback={
                                      <button
                                        class="btn btn-sm"
                                        style={{ "font-size": "11px", padding: "2px 8px" }}
                                        onClick={() => {
                                          setPortForwardLocalPort(String(p.port));
                                          setPortForwardEditing(editKey());
                                        }}
                                        title={`Forward port ${p.port} — click to configure`}
                                      >
                                        :{p.port}
                                      </button>
                                    }>
                                      <div style={{ display: "flex", "align-items": "center", gap: "2px" }}>
                                        <input
                                          type="number"
                                          class="form-input"
                                          style={{ width: "70px", "font-size": "11px", padding: "2px 6px", "text-align": "center" }}
                                          value={portForwardLocalPort()}
                                          onInput={(e) => setPortForwardLocalPort(e.currentTarget.value)}
                                          onKeyDown={(e) => {
                                            if (e.key === "Enter") {
                                              startPortForward(selectedNs(), svc.name, p.port, parseInt(portForwardLocalPort()) || p.port);
                                              setPortForwardEditing(null);
                                            }
                                            if (e.key === "Escape") setPortForwardEditing(null);
                                          }}
                                          ref={(el) => setTimeout(() => el.focus(), 50)}
                                        />
                                        <button
                                          class="btn btn-sm btn-primary"
                                          style={{ "font-size": "11px", padding: "2px 6px" }}
                                          onClick={() => {
                                            startPortForward(selectedNs(), svc.name, p.port, parseInt(portForwardLocalPort()) || p.port);
                                            setPortForwardEditing(null);
                                          }}
                                        >
                                          {"\u25B6"}
                                        </button>
                                        <button
                                          class="btn btn-sm"
                                          style={{ "font-size": "11px", padding: "2px 6px" }}
                                          onClick={() => setPortForwardEditing(null)}
                                        >
                                          {"\u2715"}
                                        </button>
                                      </div>
                                    </Show>
                                  }>
                                    <button
                                      class="btn btn-sm btn-primary"
                                      style={{ "font-size": "11px", padding: "2px 8px" }}
                                      onClick={() => stopPortForward(selectedNs(), svc.name, p.port)}
                                      title={`Stop forwarding port ${p.port}`}
                                    >
                                      :{p.port} {"\u2713"}
                                    </button>
                                  </Show>
                                );
                              }}
                            </For>
                          </div>
                        }>
                          <button
                            class="btn btn-sm"
                            style={{ "font-size": "11px", padding: "2px 8px" }}
                            onClick={() => {
                              const locals: Record<number, string> = {};
                              svc.ports.forEach((p) => { locals[p.port] = String(p.port); });
                              setPortDialogLocalPorts(locals);
                              setPortDialogSvc(svc);
                            }}
                          >
                            {svc.ports.length} ports
                          </button>
                        </Show>
                      </td>
                      <td>
                        <button
                          class="action-icon"
                          title="View/Edit YAML"
                          onClick={() => viewYaml("service", svc.name, svc.namespace)}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
                        </button>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </Show>

        {/* Ingresses Tab */}
        <Show when={tab() === "ingresses"}>
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
                  <th></th>
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
                      <td>
                        <button
                          class="action-icon"
                          title="View/Edit YAML"
                          onClick={() => viewYaml("ingress", ing.name, ing.namespace)}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
                        </button>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </Show>

        {/* Storage Tab */}
        <Show when={tab() === "storage"}>
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
                          class="action-icon action-icon-delete"
                          title="Delete PVC"
                          onClick={() => handleDeletePvc(pvc.namespace, pvc.name)}
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
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

        {/* Events Tab */}
        <Show when={tab() === "events"}>
          <Show
            when={events().length > 0}
            fallback={
              <div class="empty-state-tab">
                <div class="empty-state-tab-title">{emptyMessages.events.title}</div>
                <div class="empty-state-tab-desc">{emptyMessages.events.desc}</div>
              </div>
            }
          >
            <table class="table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Reason</th>
                  <th>Object</th>
                  <th>Message</th>
                  <th>Count</th>
                  <th>Age</th>
                </tr>
              </thead>
              <tbody>
                <For each={events()}>
                  {(evt) => (
                    <tr>
                      <td>
                        <span style={{
                          color: evt.type === "Warning" ? "#d29922" : "#3fb950",
                          "font-weight": "500",
                        }}>
                          {evt.type}
                        </span>
                      </td>
                      <td style={{ "font-weight": "500" }}>{evt.reason}</td>
                      <td class="mono" style={{ "font-size": "12px", color: "#8b949e" }}>{evt.object}</td>
                      <td style={{ "font-size": "12px", "max-width": "400px" }}>{evt.message}</td>
                      <td class="mono">{evt.count}</td>
                      <td style={{ color: "#8b949e" }}>{evt.age}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </Show>

        {/* Config Tab */}
        <Show when={tab() === "config"}>
          <div style={{ display: "flex", gap: "8px", "margin-bottom": "16px" }}>
            <button
              class={`btn btn-sm ${configSubTab() === "configmaps" ? "btn-primary" : ""}`}
              onClick={() => setConfigSubTab("configmaps")}
              style={{ "font-size": "12px" }}
            >
              ConfigMaps ({configMaps().length})
            </button>
            <button
              class={`btn btn-sm ${configSubTab() === "secrets" ? "btn-primary" : ""}`}
              onClick={() => setConfigSubTab("secrets")}
              style={{ "font-size": "12px" }}
            >
              Secrets ({secrets().length})
            </button>
          </div>

          <Show when={configSubTab() === "configmaps"}>
            <Show
              when={configMaps().length > 0}
              fallback={
                <div class="empty-state-tab">
                  <div class="empty-state-tab-title">No ConfigMaps in this namespace</div>
                  <div class="empty-state-tab-desc">ConfigMaps store non-sensitive configuration data.</div>
                </div>
              }
            >
              <table class="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Keys</th>
                    <th>Age</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={configMaps()}>
                    {(cm) => (
                      <tr>
                        <td style={{ "font-weight": "500" }}>{cm.name}</td>
                        <td class="mono" style={{ color: "#8b949e" }}>{cm.keys.length}</td>
                        <td style={{ color: "#8b949e" }}>{cm.age}</td>
                        <td>
                          <div style={{ display: "flex", gap: "4px" }}>
                            <button
                              class="action-icon"
                              title="View data"
                              onClick={() => setViewConfigMap(cm)}
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
                            </button>
                            <button
                              class="action-icon"
                              title="View/Edit YAML"
                              onClick={() => viewYaml("configmap", cm.name, cm.namespace)}
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>
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

          <Show when={configSubTab() === "secrets"}>
            <Show
              when={secrets().length > 0}
              fallback={
                <div class="empty-state-tab">
                  <div class="empty-state-tab-title">No Secrets in this namespace</div>
                  <div class="empty-state-tab-desc">Secrets store sensitive data like passwords and API keys.</div>
                </div>
              }
            >
              <table class="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Type</th>
                    <th>Keys</th>
                    <th>Age</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={secrets()}>
                    {(sec) => (
                      <tr>
                        <td style={{ "font-weight": "500" }}>{sec.name}</td>
                        <td class="mono" style={{ "font-size": "12px", color: "#8b949e" }}>{sec.secret_type}</td>
                        <td class="mono" style={{ color: "#8b949e" }}>{sec.keys.length}</td>
                        <td style={{ color: "#8b949e" }}>{sec.age}</td>
                        <td>
                          <div style={{ display: "flex", gap: "4px" }}>
                            <button
                              class="action-icon"
                              title="View secret values"
                              onClick={() => { setRevealedKeys(new Set<string>()); setViewSecret(sec); }}
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                            </button>
                            <button
                              class="action-icon"
                              title="View/Edit YAML"
                              onClick={() => viewYaml("secret", sec.name, sec.namespace)}
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>
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
        </Show>

        {/* Helm Tab */}
        <Show when={tab() === "helm"}>
          <Show when={helmAvailable() === false}>
            <div class="empty-state-tab">
              <div class="empty-state-tab-title">Helm is not installed</div>
              <div class="empty-state-tab-desc">
                Install Helm to manage Kubernetes packages:<br />
                <code style={{ background: "#0d1117", padding: "4px 8px", "border-radius": "4px", "font-size": "12px", "margin-top": "8px", display: "inline-block" }}>
                  curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
                </code>
              </div>
            </div>
          </Show>
          <Show when={helmAvailable() === null}>
            <div style={{ color: "#8b949e", "text-align": "center", padding: "20px" }}>
              <Spinner />
            </div>
          </Show>
          <Show when={helmAvailable()}>
            <Show
              when={helmReleases().length > 0}
              fallback={
                <div class="empty-state-tab">
                  <div class="empty-state-tab-title">{emptyMessages.helm.title}</div>
                  <div class="empty-state-tab-desc">
                    Use <code style={{ background: "#0d1117", padding: "2px 6px", "border-radius": "4px" }}>helm install</code> CLI to add releases, then manage them here.
                  </div>
                </div>
              }
            >
              <table class="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Namespace</th>
                    <th>Chart</th>
                    <th>Status</th>
                    <th>Revision</th>
                    <th>Updated</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={helmReleases()}>
                    {(rel) => (
                      <tr>
                        <td style={{ "font-weight": "500" }}>{rel.name}</td>
                        <td style={{ color: "#8b949e" }}>{rel.namespace}</td>
                        <td class="mono" style={{ "font-size": "12px", color: "#8b949e" }}>{rel.chart}</td>
                        <td>
                          <span style={{
                            color: rel.status === "deployed" ? "#3fb950" : rel.status === "failed" ? "#f85149" : "#d29922",
                            "font-weight": "500",
                          }}>
                            {rel.status}
                          </span>
                        </td>
                        <td class="mono">{rel.revision}</td>
                        <td style={{ color: "#8b949e", "font-size": "12px" }}>
                          {rel.updated ? rel.updated.split(".")[0] : ""}
                        </td>
                        <td>
                          <button
                            class="action-icon action-icon-delete"
                            title="Uninstall release"
                            onClick={() => handleHelmUninstall(rel.name, rel.namespace)}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                          </button>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>
          </Show>
        </Show>

        {/* Topology Tab */}
        <Show when={tab() === "topology"}>
          <Show
            when={deployments().length > 0 || services().length > 0 || pods().length > 0}
            fallback={
              <div class="empty-state-tab">
                <div class="empty-state-tab-title">{emptyMessages.topology.title}</div>
                <div class="empty-state-tab-desc">{emptyMessages.topology.desc}</div>
              </div>
            }
          >
            <div style={{ padding: "8px 0" }}>
              <For each={services()}>
                {(svc) => {
                  // Find deployments that might be targeted by this service
                  // (simplified: match by name prefix or label overlap)
                  const matchedDeps = () => deployments().filter((d) =>
                    svc.name.includes(d.name) || d.name.includes(svc.name) || svc.name === d.name
                  );
                  return (
                    <div style={{
                      display: "flex", "align-items": "flex-start", gap: "0",
                      "margin-bottom": "16px", "flex-wrap": "wrap",
                    }}>
                      {/* Service card */}
                      <div
                        style={{
                          background: "#1c2333", border: "1px solid #30363d",
                          "border-radius": "8px", padding: "10px 14px",
                          "min-width": "160px", cursor: "pointer",
                        }}
                        onClick={() => setTab("services")}
                        title="View services"
                      >
                        <div style={{ "font-size": "10px", color: "#79c0ff", "margin-bottom": "4px" }}>Service</div>
                        <div style={{ "font-weight": "600", "font-size": "13px", color: "#e6edf3" }}>{svc.name}</div>
                        <div style={{ "font-size": "11px", color: "#8b949e" }}>
                          {svc.service_type} {svc.ports.map((p) => `:${p.port}`).join(", ")}
                        </div>
                      </div>

                      <Show when={matchedDeps().length > 0}>
                        <div style={{ display: "flex", "align-items": "center", padding: "0 8px", color: "#484f58", "font-size": "18px", "align-self": "center" }}>
                          {"\u2192"}
                        </div>
                      </Show>

                      <For each={matchedDeps()}>
                        {(dep) => {
                          const depPods = () => pods().filter((p) => p.name.startsWith(dep.name));
                          return (
                            <div style={{ display: "flex", "align-items": "flex-start", gap: "0" }}>
                              <div
                                style={{
                                  background: "#1f2a1f", border: "1px solid #2d4a2d",
                                  "border-radius": "8px", padding: "10px 14px",
                                  "min-width": "160px", cursor: "pointer",
                                }}
                                onClick={() => setTab("deployments")}
                                title="View deployments"
                              >
                                <div style={{ "font-size": "10px", color: "#3fb950", "margin-bottom": "4px" }}>Deployment</div>
                                <div style={{ "font-weight": "600", "font-size": "13px", color: "#e6edf3" }}>{dep.name}</div>
                                <div style={{ "font-size": "11px", color: "#8b949e" }}>
                                  {dep.replicas_ready}/{dep.replicas_desired} ready
                                </div>
                              </div>

                              <Show when={depPods().length > 0}>
                                <div style={{ display: "flex", "align-items": "center", padding: "0 8px", color: "#484f58", "font-size": "18px", "align-self": "center" }}>
                                  {"\u2192"}
                                </div>
                                <div style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>
                                  <For each={depPods()}>
                                    {(pod) => (
                                      <div
                                        style={{
                                          background: "#161b22", border: "1px solid #30363d",
                                          "border-radius": "6px", padding: "6px 12px",
                                          "min-width": "180px", cursor: "pointer",
                                        }}
                                        onClick={() => setTab("pods")}
                                        title="View pods"
                                      >
                                        <div style={{ display: "flex", "align-items": "center", gap: "6px" }}>
                                          <span style={{
                                            width: "6px", height: "6px", "border-radius": "50%",
                                            background: podStatusColor(pod.status),
                                          }} />
                                          <span style={{ "font-size": "12px", color: "#e6edf3", "font-weight": "500" }}>
                                            {pod.name.length > 30 ? pod.name.slice(0, 28) + ".." : pod.name}
                                          </span>
                                        </div>
                                        <div style={{ "font-size": "10px", color: "#8b949e", "margin-top": "2px", "padding-left": "12px" }}>
                                          {pod.status} | {pod.ready}
                                        </div>
                                      </div>
                                    )}
                                  </For>
                                </div>
                              </Show>
                            </div>
                          );
                        }}
                      </For>
                    </div>
                  );
                }}
              </For>

              {/* Show deployments without a matching service */}
              <For each={deployments().filter((d) => !services().some((s) => s.name.includes(d.name) || d.name.includes(s.name)))}>
                {(dep) => {
                  const depPods = () => pods().filter((p) => p.name.startsWith(dep.name));
                  return (
                    <div style={{
                      display: "flex", "align-items": "flex-start", gap: "0",
                      "margin-bottom": "16px", "flex-wrap": "wrap",
                    }}>
                      <div
                        style={{
                          background: "#1f2a1f", border: "1px solid #2d4a2d",
                          "border-radius": "8px", padding: "10px 14px",
                          "min-width": "160px", cursor: "pointer",
                        }}
                        onClick={() => setTab("deployments")}
                      >
                        <div style={{ "font-size": "10px", color: "#3fb950", "margin-bottom": "4px" }}>Deployment</div>
                        <div style={{ "font-weight": "600", "font-size": "13px", color: "#e6edf3" }}>{dep.name}</div>
                        <div style={{ "font-size": "11px", color: "#8b949e" }}>
                          {dep.replicas_ready}/{dep.replicas_desired} ready
                        </div>
                      </div>

                      <Show when={depPods().length > 0}>
                        <div style={{ display: "flex", "align-items": "center", padding: "0 8px", color: "#484f58", "font-size": "18px", "align-self": "center" }}>
                          {"\u2192"}
                        </div>
                        <div style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>
                          <For each={depPods()}>
                            {(pod) => (
                              <div
                                style={{
                                  background: "#161b22", border: "1px solid #30363d",
                                  "border-radius": "6px", padding: "6px 12px",
                                  "min-width": "180px", cursor: "pointer",
                                }}
                                onClick={() => setTab("pods")}
                              >
                                <div style={{ display: "flex", "align-items": "center", gap: "6px" }}>
                                  <span style={{
                                    width: "6px", height: "6px", "border-radius": "50%",
                                    background: podStatusColor(pod.status),
                                  }} />
                                  <span style={{ "font-size": "12px", color: "#e6edf3", "font-weight": "500" }}>
                                    {pod.name.length > 30 ? pod.name.slice(0, 28) + ".." : pod.name}
                                  </span>
                                </div>
                                <div style={{ "font-size": "10px", color: "#8b949e", "margin-top": "2px", "padding-left": "12px" }}>
                                  {pod.status} | {pod.ready}
                                </div>
                              </div>
                            )}
                          </For>
                        </div>
                      </Show>
                    </div>
                  );
                }}
              </For>

              {/* Orphan pods (not matching any deployment) */}
              {(() => {
                const depNames = deployments().map((d) => d.name);
                const orphanPods = pods().filter((p) => !depNames.some((dn) => p.name.startsWith(dn)));
                return (
                  <Show when={orphanPods.length > 0}>
                    <div style={{ "margin-top": "8px" }}>
                      <div style={{ "font-size": "11px", color: "#8b949e", "margin-bottom": "8px" }}>Standalone Pods</div>
                      <div style={{ display: "flex", gap: "8px", "flex-wrap": "wrap" }}>
                        <For each={orphanPods}>
                          {(pod) => (
                            <div
                              style={{
                                background: "#161b22", border: "1px solid #30363d",
                                "border-radius": "6px", padding: "6px 12px",
                                cursor: "pointer",
                              }}
                              onClick={() => setTab("pods")}
                            >
                              <div style={{ display: "flex", "align-items": "center", gap: "6px" }}>
                                <span style={{
                                  width: "6px", height: "6px", "border-radius": "50%",
                                  background: podStatusColor(pod.status),
                                }} />
                                <span style={{ "font-size": "12px", color: "#e6edf3" }}>{pod.name}</span>
                              </div>
                            </div>
                          )}
                        </For>
                      </div>
                    </div>
                  </Show>
                );
              })()}
            </div>
          </Show>
        </Show>
      </Show>

      {/* Rollback History Modal */}
      <Show when={rollbackDep()}>
        <div class="modal-overlay" onClick={() => setRollbackDep(null)}>
          <div class="modal-dialog" style={{ "max-width": "500px" }} onClick={(e) => e.stopPropagation()}>
            <div class="modal-header">
              <span class="modal-title">Rollout History: {rollbackDep()!.name}</span>
              <button class="modal-close" onClick={() => setRollbackDep(null)}>{"\u00d7"}</button>
            </div>
            <div style={{ padding: "16px" }}>
              <Show when={rollbackLoading()}>
                <div style={{ "text-align": "center", padding: "20px" }}><Spinner /></div>
              </Show>
              <Show when={!rollbackLoading()}>
                <Show when={rollbackHistory().length > 0} fallback={
                  <div style={{ color: "#8b949e", "font-size": "13px" }}>No rollout history available</div>
                }>
                  <table class="table">
                    <thead>
                      <tr>
                        <th>Revision</th>
                        <th>Change Cause</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={rollbackHistory()}>
                        {(rev) => (
                          <tr>
                            <td class="mono">{rev.revision}</td>
                            <td style={{ color: "#8b949e", "font-size": "12px" }}>
                              {rev.change_cause || "\u2014"}
                            </td>
                            <td>
                              <button
                                class="btn btn-sm"
                                style={{ "font-size": "11px" }}
                                onClick={() => handleRollback(rev.revision)}
                              >
                                Rollback
                              </button>
                            </td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </Show>
              </Show>
            </div>
            <div class="modal-footer">
              <button class="btn" onClick={() => setRollbackDep(null)}>Close</button>
            </div>
          </div>
        </div>
      </Show>

      {/* Multi-Port Forward Dialog */}
      <Show when={portDialogSvc()}>
        <div class="modal-overlay" onClick={() => setPortDialogSvc(null)}>
          <div class="modal-dialog" style={{ "max-width": "420px" }} onClick={(e) => e.stopPropagation()}>
            <div class="modal-header">
              <span class="modal-title">Port Forward: {portDialogSvc()!.name}</span>
              <button class="modal-close" onClick={() => setPortDialogSvc(null)}>{"\u00d7"}</button>
            </div>
            <div style={{ padding: "16px" }}>
              <For each={portDialogSvc()!.ports}>
                {(p) => {
                  const forwarded = () => isForwarded(selectedNs(), portDialogSvc()!.name, p.port);
                  const localVal = () => portDialogLocalPorts()[p.port] || String(p.port);
                  return (
                    <div style={{
                      display: "flex", "align-items": "center", gap: "10px",
                      padding: "10px 0",
                      "border-bottom": "1px solid rgba(255,255,255,0.06)",
                    }}>
                      <span class="mono" style={{ "font-size": "12px", "min-width": "80px", color: "#e6edf3" }}>
                        :{p.port}/{p.protocol}
                      </span>
                      <input
                        type="number"
                        class="form-input"
                        style={{ width: "80px", "font-size": "12px", padding: "4px 8px", "text-align": "center" }}
                        value={localVal()}
                        disabled={forwarded()}
                        onInput={(e) => {
                          setPortDialogLocalPorts((prev) => ({ ...prev, [p.port]: e.currentTarget.value }));
                        }}
                      />
                      <button
                        class={forwarded() ? "btn btn-sm btn-danger" : "btn btn-sm btn-primary"}
                        style={{ "font-size": "11px", padding: "4px 12px", "min-width": "60px" }}
                        onClick={async () => {
                          if (forwarded()) {
                            await stopPortForward(selectedNs(), portDialogSvc()!.name, p.port);
                          } else {
                            await startPortForward(selectedNs(), portDialogSvc()!.name, p.port, parseInt(localVal()) || p.port);
                          }
                        }}
                      >
                        {forwarded() ? "Stop" : "Forward"}
                      </button>
                      <Show when={forwarded()}>
                        <a
                          href={`http://localhost:${localVal()}`}
                          target="_blank"
                          style={{ "font-size": "11px", color: "#58a6ff", "text-decoration": "none", "white-space": "nowrap" }}
                        >
                          Open in browser
                        </a>
                      </Show>
                    </div>
                  );
                }}
              </For>
            </div>
          </div>
        </div>
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
        }} onClick={() => {
          setLogPod(null);
          setLogFollow(false);
          if (logFollowInterval) { clearInterval(logFollowInterval); logFollowInterval = null; }
        }}>
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
              gap: "8px",
            }}>
              <span style={{ color: "#e6edf3", "font-weight": "600" }}>
                Logs: {logPod()}
              </span>
              <div style={{ display: "flex", gap: "6px", "align-items": "center" }}>
                <button
                  class={`btn btn-sm ${logFollow() ? "btn-primary" : ""}`}
                  onClick={() => {
                    const next = !logFollow();
                    setLogFollow(next);
                    if (next) {
                      // Start polling
                      const podName = logPod();
                      const ns = selectedNs();
                      const poll = async () => {
                        try {
                          setLogTail((t) => Math.min(t + 100, 5000));
                          const lines = (await invoke("k8s_pod_logs", {
                            namespace: ns, name: podName, container: null, tail: logTail(),
                          })) as string[];
                          setLogLines(lines);
                          if (logContainerRef) logContainerRef.scrollTop = logContainerRef.scrollHeight;
                        } catch { /* ignore follow errors */ }
                      };
                      logFollowInterval = setInterval(poll, 2000);
                    } else {
                      if (logFollowInterval) { clearInterval(logFollowInterval); logFollowInterval = null; }
                    }
                  }}
                  style={{ "font-size": "11px" }}
                >
                  {logFollow() ? "Following..." : "Follow"}
                </button>
                <button class="btn btn-sm" onClick={() => {
                  setLogPod(null);
                  setLogFollow(false);
                  if (logFollowInterval) { clearInterval(logFollowInterval); logFollowInterval = null; }
                }}>Close</button>
              </div>
            </div>
            <div ref={logContainerRef} style={{
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

      {/* Scale Dialog */}
      <Show when={scaleTarget()}>
        <div class="modal-overlay" onClick={() => setScaleTarget(null)}>
          <div class="modal-dialog" style={{ "max-width": "340px" }} onClick={(e) => e.stopPropagation()}>
            <div class="modal-header">
              <span class="modal-title">Scale: {scaleTarget()!.name}</span>
              <button class="modal-close" onClick={() => setScaleTarget(null)}>{"\u00d7"}</button>
            </div>
            <div style={{ padding: "24px", "text-align": "center" }}>
              <div style={{ "font-size": "12px", color: "#8b949e", "margin-bottom": "16px" }}>
                Current: {scaleTarget()!.current} replica{scaleTarget()!.current !== 1 ? "s" : ""}
              </div>
              <div style={{ display: "flex", "align-items": "center", "justify-content": "center", gap: "12px" }}>
                <button
                  class="action-icon"
                  style={{
                    width: "36px", height: "36px", "border-radius": "50%",
                    background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)",
                    display: "flex", "align-items": "center", "justify-content": "center",
                    "font-size": "18px", color: "#e6edf3",
                  }}
                  onClick={() => setScaleValue(Math.max(0, scaleValue() - 1))}
                >
                  &minus;
                </button>
                <div style={{
                  "font-size": "32px", "font-weight": "700", color: "#e6edf3",
                  "min-width": "60px", "text-align": "center",
                  "font-family": "'JetBrains Mono NF', monospace",
                }}>
                  {scaleValue()}
                </div>
                <button
                  class="action-icon"
                  style={{
                    width: "36px", height: "36px", "border-radius": "50%",
                    background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)",
                    display: "flex", "align-items": "center", "justify-content": "center",
                    "font-size": "18px", color: "#e6edf3",
                  }}
                  onClick={() => setScaleValue(scaleValue() + 1)}
                >
                  +
                </button>
              </div>
              <div style={{ "font-size": "11px", color: "#6e7681", "margin-top": "12px" }}>
                {scaleValue() === 0 ? "This will stop all pods" : `${scaleValue()} replica${scaleValue() !== 1 ? "s" : ""} will be running`}
              </div>
            </div>
            <div class="modal-footer">
              <button class="btn" onClick={() => setScaleTarget(null)}>Cancel</button>
              <button
                class="btn btn-primary"
                onClick={doScale}
                disabled={scaleValue() === scaleTarget()!.current}
              >
                Scale to {scaleValue()}
              </button>
            </div>
          </div>
        </div>
      </Show>

      {/* YAML Editor Modal */}
      <Show when={yamlResource()}>
        <div class="modal-overlay" onClick={() => setYamlResource(null)}>
          <div class="modal-dialog" style={{ width: "800px", "max-width": "90vw", height: "80vh", display: "flex", "flex-direction": "column" }} onClick={(e) => e.stopPropagation()}>
            <YamlEditor
              value={yamlResource()!.yaml}
              title={`${yamlResource()!.kind}/${yamlResource()!.name}`}
              onSave={applyYaml}
              onClose={() => setYamlResource(null)}
            />
          </div>
        </div>
      </Show>

      {/* Kubernetes Setup Progress Dialog */}
      <Show when={setupDialogOpen()}>
        <div class="modal-overlay"
          onMouseDown={(e) => { mouseDownOnOverlay = (e.target as HTMLElement).classList.contains("modal-overlay"); }}
          onClick={(e) => { if (mouseDownOnOverlay && (e.target as HTMLElement).classList.contains("modal-overlay") && !setupRunning()) closeSetupDialog(); mouseDownOnOverlay = false; }}
        >
          <div class="modal-dialog" style={{ "max-width": "1000px", width: "90vw" }}>
            <div class="modal-header">
              <span class="modal-title">
                <Show when={setupRunning()} fallback={
                  setupSuccess() === true
                    ? <span style={{ color: "#3fb950" }}>{"\u2713"} Kubernetes cluster ready</span>
                    : setupSuccess() === false
                    ? <span style={{ color: "#f85149" }}>{"\u2717"} Kubernetes setup failed</span>
                    : <span>Kubernetes Setup</span>
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
              <pre ref={setupLogRef} style={{
                padding: "16px", margin: 0,
                "font-family": "'JetBrains Mono NF', monospace",
                "font-size": "12px", "line-height": "1.6",
                color: "#c9d1d9", "white-space": "pre-wrap",
                "word-break": "break-all", "max-height": "60vh",
                "min-height": "350px", overflow: "auto",
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

      {/* Deploy from YAML Modal */}
      <Show when={deployYamlOpen()}>
        <div class="modal-overlay" onClick={() => setDeployYamlOpen(false)}>
          <div class="modal-dialog" style={{ width: "800px", "max-width": "90vw", height: "80vh", display: "flex", "flex-direction": "column" }} onClick={(e) => e.stopPropagation()}>
            <YamlEditor
              value={"# Enter your Kubernetes YAML here\n# Example:\n# apiVersion: v1\n# kind: Pod\n# metadata:\n#   name: my-pod\n# spec:\n#   containers:\n#   - name: my-container\n#     image: nginx\n"}
              title="Deploy from YAML"
              onSave={handleDeployYaml}
              onClose={() => setDeployYamlOpen(false)}
            />
          </div>
        </div>
      </Show>

      {/* Create Namespace Modal */}
      <Show when={createNsOpen()}>
        <div class="modal-overlay" onClick={() => setCreateNsOpen(false)}>
          <div class="modal-dialog" style={{ "max-width": "400px" }} onClick={(e) => e.stopPropagation()}>
            <div class="modal-header">
              <span class="modal-title">Create Namespace</span>
              <button class="modal-close" onClick={() => setCreateNsOpen(false)}>{"\u00d7"}</button>
            </div>
            <div style={{ padding: "16px" }}>
              <label style={{ "font-size": "12px", color: "#8b949e", display: "block", "margin-bottom": "6px" }}>Namespace name</label>
              <input
                type="text"
                class="form-input"
                placeholder="my-namespace"
                value={newNsName()}
                onInput={(e) => setNewNsName(e.currentTarget.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleCreateNamespace(); }}
                ref={(el) => setTimeout(() => el.focus(), 50)}
                style={{ width: "100%" }}
              />
            </div>
            <div class="modal-footer">
              <button class="btn" onClick={() => setCreateNsOpen(false)}>Cancel</button>
              <button
                class="btn btn-primary"
                onClick={handleCreateNamespace}
                disabled={!newNsName().trim()}
              >
                Create
              </button>
            </div>
          </div>
        </div>
      </Show>

      {/* Pod Shell Modal */}
      <Show when={shellPod()}>
        <div class="modal-overlay" onClick={() => setShellPod(null)}>
          <div class="modal-dialog" style={{ "max-width": "500px" }} onClick={(e) => e.stopPropagation()}>
            <div class="modal-header">
              <span class="modal-title">Terminal: {shellPod()!.name}</span>
              <button class="modal-close" onClick={() => setShellPod(null)}>{"\u00d7"}</button>
            </div>
            <div style={{ padding: "16px" }}>
              <div style={{ "font-size": "13px", color: "#8b949e", "margin-bottom": "12px" }}>
                Open a shell in pod <strong style={{ color: "#e6edf3" }}>{shellPod()!.name}</strong>
              </div>
              <div style={{
                background: "#0d1117",
                border: "1px solid #21262d",
                "border-radius": "6px",
                padding: "12px",
                "font-family": "'JetBrains Mono NF', monospace",
                "font-size": "12px",
                color: "#e6edf3",
                display: "flex",
                "align-items": "center",
                gap: "8px",
              }}>
                <code style={{ flex: "1", "word-break": "break-all" }}>
                  kubectl exec -it {shellPod()!.name} -n {shellPod()!.namespace} -- sh
                </code>
                <CopyButton text={`kubectl exec -it ${shellPod()!.name} -n ${shellPod()!.namespace} -- sh`} label="Copy command" />
              </div>
              <div style={{ "font-size": "11px", color: "#6e7681", "margin-top": "8px" }}>
                Run this command in your terminal to access the pod shell.
              </div>
            </div>
            <div class="modal-footer">
              <button class="btn" onClick={() => setShellPod(null)}>Close</button>
            </div>
          </div>
        </div>
      </Show>

      {/* ConfigMap Viewer Modal */}
      <Show when={viewConfigMap()}>
        <div class="modal-overlay" onClick={() => setViewConfigMap(null)}>
          <div class="modal-dialog" style={{ width: "700px", "max-width": "90vw", "max-height": "80vh", display: "flex", "flex-direction": "column" }} onClick={(e) => e.stopPropagation()}>
            <div class="modal-header">
              <span class="modal-title">ConfigMap: {viewConfigMap()!.name}</span>
              <button class="modal-close" onClick={() => setViewConfigMap(null)}>{"\u00d7"}</button>
            </div>
            <div style={{ padding: "16px", overflow: "auto", flex: "1" }}>
              <For each={Object.entries(viewConfigMap()!.data)}>
                {([key, value]) => (
                  <div style={{ "margin-bottom": "16px" }}>
                    <div style={{
                      "font-size": "12px", "font-weight": "600", color: "#58a6ff",
                      "margin-bottom": "4px", display: "flex", "align-items": "center", gap: "8px",
                    }}>
                      {key}
                      <CopyButton text={value} label="Copy value" />
                    </div>
                    <pre style={{
                      background: "#0d1117", border: "1px solid #21262d",
                      "border-radius": "6px", padding: "10px",
                      "font-family": "'JetBrains Mono NF', monospace",
                      "font-size": "12px", color: "#c9d1d9",
                      "white-space": "pre-wrap", "word-break": "break-all",
                      margin: 0, "max-height": "200px", overflow: "auto",
                    }}>{value}</pre>
                  </div>
                )}
              </For>
              <Show when={Object.keys(viewConfigMap()!.data).length === 0}>
                <div style={{ color: "#8b949e", "font-size": "13px" }}>No data in this ConfigMap</div>
              </Show>
            </div>
            <div class="modal-footer">
              <button class="btn" onClick={() => setViewConfigMap(null)}>Close</button>
            </div>
          </div>
        </div>
      </Show>

      {/* Secret Viewer Modal */}
      <Show when={viewSecret()}>
        <div class="modal-overlay" onClick={() => setViewSecret(null)}>
          <div class="modal-dialog" style={{ width: "700px", "max-width": "90vw", "max-height": "80vh", display: "flex", "flex-direction": "column" }} onClick={(e) => e.stopPropagation()}>
            <div class="modal-header">
              <span class="modal-title">Secret: {viewSecret()!.name}</span>
              <button class="modal-close" onClick={() => setViewSecret(null)}>{"\u00d7"}</button>
            </div>
            <div style={{ padding: "16px", overflow: "auto", flex: "1" }}>
              <div style={{ "font-size": "11px", color: "#d29922", "margin-bottom": "12px" }}>
                Type: {viewSecret()!.secret_type}
              </div>
              <For each={Object.entries(viewSecret()!.data)}>
                {([key, value]) => {
                  const isRevealed = () => revealedKeys().has(key);
                  const decoded = () => {
                    try { return atob(value); } catch { return value; }
                  };
                  return (
                    <div style={{ "margin-bottom": "16px" }}>
                      <div style={{
                        "font-size": "12px", "font-weight": "600", color: "#58a6ff",
                        "margin-bottom": "4px", display: "flex", "align-items": "center", gap: "8px",
                      }}>
                        {key}
                        <button
                          class="btn btn-sm"
                          style={{ "font-size": "10px", padding: "1px 6px" }}
                          onClick={() => {
                            const next = new Set(revealedKeys());
                            if (isRevealed()) next.delete(key); else next.add(key);
                            setRevealedKeys(next);
                          }}
                        >
                          {isRevealed() ? "Hide" : "Reveal"}
                        </button>
                        <Show when={isRevealed()}>
                          <CopyButton text={decoded()} label="Copy decoded value" />
                        </Show>
                      </div>
                      <pre style={{
                        background: "#0d1117", border: "1px solid #21262d",
                        "border-radius": "6px", padding: "10px",
                        "font-family": "'JetBrains Mono NF', monospace",
                        "font-size": "12px", color: "#c9d1d9",
                        "white-space": "pre-wrap", "word-break": "break-all",
                        margin: 0,
                      }}>{isRevealed() ? decoded() : "\u2022".repeat(Math.min(decoded().length, 24))}</pre>
                    </div>
                  );
                }}
              </For>
              <Show when={Object.keys(viewSecret()!.data).length === 0}>
                <div style={{ color: "#8b949e", "font-size": "13px" }}>No data in this Secret</div>
              </Show>
            </div>
            <div class="modal-footer">
              <button class="btn" onClick={() => setViewSecret(null)}>Close</button>
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
