import { createSignal, onMount, onCleanup, For, Index, Show, createEffect } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { showToast } from "../components/Toast";
import { useRefresh } from "../lib/useRefresh";
import { confirmDanger } from "../components/ConfirmDialog";
import { logError, logInfo } from "../lib/activityStore";
import Spinner from "../components/Spinner";
import YamlEditor from "../components/YamlEditor";
import Dropdown from "../components/Dropdown";
import CopyButton from "../components/CopyButton";
import K8sTerminal from "../components/K8sTerminal";
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
  K8sJob,
  K8sCronJob,
  K8sDaemonSet,
  K8sStatefulSet,
  K8sReplicaSet,
  HorizontalPodAutoscaler,
  NetworkPolicy,
  StorageClass,
  CustomResourceDefinition,
} from "../lib/types";

type Tab = "pods" | "deployments" | "daemonsets" | "statefulsets" | "replicasets" | "services" | "ingresses" | "storage" | "events" | "config" | "helm" | "jobs" | "crds" | "topology";

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
  const [stopping, setStopping] = createSignal(false);
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

  // Secret Create/Edit
  const [secretDialogOpen, setSecretDialogOpen] = createSignal(false);
  const [secretDialogMode, setSecretDialogMode] = createSignal<"create" | "edit">("create");
  const [secretDialogName, setSecretDialogName] = createSignal("");
  const [secretDialogType, setSecretDialogType] = createSignal("Opaque");
  const [secretDialogEntries, setSecretDialogEntries] = createSignal<{ key: string; value: string }[]>([{ key: "", value: "" }]);
  const [secretDialogRevealed, setSecretDialogRevealed] = createSignal<Set<number>>(new Set());
  const [secretDialogSaving, setSecretDialogSaving] = createSignal(false);

  // PVC Create
  const [pvcDialogOpen, setPvcDialogOpen] = createSignal(false);
  const [pvcName, setPvcName] = createSignal("");
  const [pvcStorageClass, setPvcStorageClass] = createSignal("");
  const [pvcSizeValue, setPvcSizeValue] = createSignal("1");
  const [pvcSizeUnit, setPvcSizeUnit] = createSignal("Gi");
  const [pvcAccessModes, setPvcAccessModes] = createSignal<Set<string>>(new Set(["ReadWriteOnce"]));
  const [pvcCreating, setPvcCreating] = createSignal(false);

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
  // K8s setup WebSocket: tracked at page scope so onCleanup can close it on
  // fast unmount / navigation, and so a re-invocation of handleEnable can
  // close any prior socket before opening a new one.
  let setupWs: WebSocket | null = null;

  // Feature 4: Helm
  const [helmReleases, setHelmReleases] = createSignal<HelmRelease[]>([]);
  const [helmAvailable, setHelmAvailable] = createSignal<boolean | null>(null);

  // Helm Install
  const [helmInstallOpen, setHelmInstallOpen] = createSignal(false);
  const [helmReleaseName, setHelmReleaseName] = createSignal("");
  const [helmChartName, setHelmChartName] = createSignal("");
  const [helmInstallNs, setHelmInstallNs] = createSignal("default");
  const [helmSetValues, setHelmSetValues] = createSignal<{ key: string; value: string }[]>([]);
  const [helmInstalling, setHelmInstalling] = createSignal(false);

  // Jobs / CronJobs
  const [jobs, setJobs] = createSignal<K8sJob[]>([]);
  const [cronJobs, setCronJobs] = createSignal<K8sCronJob[]>([]);

  // DaemonSets / StatefulSets / ReplicaSets
  const [daemonSets, setDaemonSets] = createSignal<K8sDaemonSet[]>([]);
  const [statefulSets, setStatefulSets] = createSignal<K8sStatefulSet[]>([]);
  const [replicaSets, setReplicaSets] = createSignal<K8sReplicaSet[]>([]);

  // HPAs, Network Policies, Storage Classes, CRDs
  const [hpas, setHpas] = createSignal<HorizontalPodAutoscaler[]>([]);
  const [networkPolicies, setNetworkPolicies] = createSignal<NetworkPolicy[]>([]);
  const [storageClasses, setStorageClasses] = createSignal<StorageClass[]>([]);
  const [crds, setCrds] = createSignal<CustomResourceDefinition[]>([]);

  // HPA Create dialog
  const [hpaDialogOpen, setHpaDialogOpen] = createSignal(false);
  const [hpaName, setHpaName] = createSignal("");
  const [hpaDeployment, setHpaDeployment] = createSignal("");
  const [hpaMin, setHpaMin] = createSignal("1");
  const [hpaMax, setHpaMax] = createSignal("5");
  const [hpaCpuTarget, setHpaCpuTarget] = createSignal("50");
  const [hpaCreating, setHpaCreating] = createSignal(false);

  // Topology hover
  const [topoHover, setTopoHover] = createSignal<string | null>(null);

  // Feature 5: Topology (data computed from existing signals)

  // Setup progress dialog
  const [setupDialogOpen, setSetupDialogOpen] = createSignal(false);
  const [setupLog, setSetupLog] = createSignal("");
  const [setupRunning, setSetupRunning] = createSignal(false);
  const [setupSuccess, setSetupSuccess] = createSignal<boolean | null>(null);
  // Create Ingress dialog
  const [createIngressOpen, setCreateIngressOpen] = createSignal(false);
  const [ingressName, setIngressName] = createSignal("");
  const [ingressHostname, setIngressHostname] = createSignal("");
  const [ingressServiceName, setIngressServiceName] = createSignal("");
  const [ingressServicePort, setIngressServicePort] = createSignal("");
  const [ingressPath, setIngressPath] = createSignal("/");
  const [ingressPathType, setIngressPathType] = createSignal("Prefix");
  const [ingressTls, setIngressTls] = createSignal(false);
  const [ingressCreating, setIngressCreating] = createSignal(false);
  const [ingressServices, setIngressServices] = createSignal<K8sService[]>([]);

  // Traefik info panel
  const [traefikInfoOpen, setTraefikInfoOpen] = createSignal(false);
  const [traefikService, setTraefikService] = createSignal<K8sService | null>(null);
  const [traefikForwarding, setTraefikForwarding] = createSignal(false);
  const [traefikIntegrationMode, setTraefikIntegrationMode] = createSignal<string | null>(null);

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
        // Detect Traefik service in kube-system
        try {
          const sysServices = (await invoke("k8s_services", { namespace: "kube-system" })) as K8sService[];
          const traefik = sysServices.find((svc) => svc.name === "traefik");
          setTraefikService(traefik || null);
        } catch {
          setTraefikService(null);
        }
        // Fetch Traefik integration mode
        try {
          const ts = (await invoke("gateway_traefik_status")) as { mode: string };
          setTraefikIntegrationMode(ts.mode);
        } catch {
          setTraefikIntegrationMode(null);
        }
      }
    } catch {
    }
  };

  useRefresh(refreshStatus);

  let hasLoadedOnce = false;
  // Guard against tab/namespace-change races: each refreshWorkloads() run
  // increments workloadReqId and captures the current tab. Before any
  // setter fires we early-return if either changed — avoids stale data
  // clobbering the fresh tab's state.
  let workloadReqId = 0;

  const refreshWorkloads = async () => {
    const s = status();
    if (!s?.running) return;
    const ns = selectedNs();
    const myReq = ++workloadReqId;
    const myTab = tab();
    const stale = () => myReq !== workloadReqId || myTab !== tab();
    // Only show spinner on first load — never on refresh
    if (!hasLoadedOnce) {
      if (stale()) return;
      setLoading(true);
    }
    try {
      if (myTab === "pods") {
        const [podResult, metricsResult] = await Promise.allSettled([
          invoke("k8s_pods", { namespace: ns }) as Promise<Pod[]>,
          invoke("k8s_pod_metrics", { namespace: ns }) as Promise<PodMetrics[]>,
        ]);
        if (stale()) return;
        if (podResult.status === "fulfilled") setPods(podResult.value);
        if (metricsResult.status === "fulfilled") {
          const map: Record<string, PodMetrics> = {};
          for (const m of metricsResult.value) {
            map[m.name] = m;
          }
          setPodMetrics(map);
        }
      } else if (myTab === "deployments") {
        const [depResult, hpaResult] = await Promise.allSettled([
          invoke("k8s_deployments", { namespace: ns }) as Promise<Deployment[]>,
          invoke("k8s_hpas", { namespace: ns }) as Promise<HorizontalPodAutoscaler[]>,
        ]);
        if (stale()) return;
        if (depResult.status === "fulfilled") setDeployments(depResult.value);
        if (hpaResult.status === "fulfilled") setHpas(hpaResult.value);
      } else if (myTab === "services") {
        const [svcResult, npResult] = await Promise.allSettled([
          invoke("k8s_services", { namespace: ns }) as Promise<K8sService[]>,
          invoke("k8s_network_policies", { namespace: ns }) as Promise<NetworkPolicy[]>,
        ]);
        if (stale()) return;
        if (svcResult.status === "fulfilled") setServices(svcResult.value);
        if (npResult.status === "fulfilled") setNetworkPolicies(npResult.value);
      } else if (myTab === "ingresses") {
        const result = (await invoke("k8s_ingresses", { namespace: ns })) as Ingress[];
        if (stale()) return;
        setIngresses(result);
      } else if (myTab === "storage") {
        const [pvcResult, pvResult, scResult] = await Promise.allSettled([
          invoke("k8s_pvcs", { namespace: ns }) as Promise<PersistentVolumeClaim[]>,
          invoke("k8s_pvs") as Promise<PersistentVolume[]>,
          invoke("k8s_storage_classes") as Promise<StorageClass[]>,
        ]);
        if (stale()) return;
        if (pvcResult.status === "fulfilled") setPvcs(pvcResult.value);
        if (pvResult.status === "fulfilled") setPvs(pvResult.value);
        if (scResult.status === "fulfilled") setStorageClasses(scResult.value);
      } else if (myTab === "crds") {
        const result = (await invoke("k8s_crds")) as CustomResourceDefinition[];
        if (stale()) return;
        setCrds(result);
      } else if (myTab === "events") {
        const result = (await invoke("k8s_events", { namespace: ns })) as K8sEvent[];
        if (stale()) return;
        setEvents(result);
      } else if (myTab === "config") {
        const [cmResult, secResult] = await Promise.all([
          invoke("k8s_configmaps", { namespace: ns }) as Promise<K8sConfigMap[]>,
          invoke("k8s_secrets", { namespace: ns }) as Promise<K8sSecret[]>,
        ]);
        if (stale()) return;
        setConfigMaps(cmResult);
        setSecrets(secResult);
      } else if (myTab === "helm") {
        try {
          if (helmAvailable() === null) {
            const avail = (await invoke("k8s_helm_available")) as { available: boolean };
            if (stale()) return;
            setHelmAvailable(avail.available);
          }
          if (helmAvailable()) {
            const releases = (await invoke("k8s_helm_list")) as HelmRelease[];
            if (stale()) return;
            setHelmReleases(releases);
          }
        } catch { /* helm not available */ }
      } else if (myTab === "jobs") {
        const [jobData, cronData] = await Promise.all([
          invoke("k8s_jobs", { namespace: ns }) as Promise<K8sJob[]>,
          invoke("k8s_cronjobs", { namespace: ns }) as Promise<K8sCronJob[]>,
        ]);
        if (stale()) return;
        setJobs(jobData);
        setCronJobs(cronData);
      } else if (myTab === "daemonsets") {
        const result = (await invoke("k8s_daemonsets", { namespace: ns })) as K8sDaemonSet[];
        if (stale()) return;
        setDaemonSets(result);
      } else if (myTab === "statefulsets") {
        const result = (await invoke("k8s_statefulsets", { namespace: ns })) as K8sStatefulSet[];
        if (stale()) return;
        setStatefulSets(result);
      } else if (myTab === "replicasets") {
        const result = (await invoke("k8s_replicasets", { namespace: ns })) as K8sReplicaSet[];
        if (stale()) return;
        setReplicaSets(result);
      } else if (myTab === "topology") {
        // Topology needs pods, deployments, services, and optionally metrics
        const [p, d, svcT, m] = await Promise.allSettled([
          invoke("k8s_pods", { namespace: ns }) as Promise<Pod[]>,
          invoke("k8s_deployments", { namespace: ns }) as Promise<Deployment[]>,
          invoke("k8s_services", { namespace: ns }) as Promise<K8sService[]>,
          invoke("k8s_pod_metrics", { namespace: ns }) as Promise<PodMetrics[]>,
        ]);
        if (stale()) return;
        if (p.status === "fulfilled") setPods(p.value);
        if (d.status === "fulfilled") setDeployments(d.value);
        if (svcT.status === "fulfilled") setServices(svcT.value);
        if (m.status === "fulfilled") {
          const map: Record<string, PodMetrics> = {};
          for (const met of m.value) map[met.name] = met;
          setPodMetrics(map);
        }
      }
    } catch {
    } finally {
      if (!stale()) {
        setLoading(false);
        hasLoadedOnce = true;
      }
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
      // Ensure the log-follow poll loop stops if the user navigates away
      // while it's active — previously this interval kept polling forever.
      if (logFollowInterval) {
        clearInterval(logFollowInterval);
        logFollowInterval = null;
      }
      if (setupWs) {
        try { setupWs.close(); } catch {}
        setupWs = null;
      }
    });
  });

  const handleEnable = async () => {
    // Close any previous setup WebSocket before opening a new one so
    // rapid re-invocations don't leak sockets.
    if (setupWs) {
      try { setupWs.close(); } catch {}
      setupWs = null;
    }

    setEnabling(true);
    setSetupLog("");
    setSetupRunning(true);
    setSetupSuccess(null);
    setSetupDialogOpen(true);

    try {
      // Get WebSocket URL for the active daemon (local or remote)
      const wsUrl = await invoke("get_daemon_ws_url", { path: "/k8s/enable-stream" }) as string;
      const ws = new WebSocket(wsUrl);
      setupWs = ws;

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
          if (setupWs === ws) setupWs = null;
        } else if (line === "[ERROR]") {
          setSetupSuccess(false);
          setSetupRunning(false);
          setEnabling(false);
          ws.close();
          if (setupWs === ws) setupWs = null;
        } else {
          setSetupLog((prev) => prev + line + "\n");
          // Check for instruction-style output (not an actual install)
          if (line.includes("To set up") || line.includes("Lima VM first")) {
            setSetupSuccess(null); // informational, not success/failure
          }
        }
      };

      ws.onerror = () => {
        // WebSocket failed — fall back to non-streaming invoke
        ws.close();
        if (setupWs === ws) setupWs = null;
        (async () => {
          try {
            setSetupLog("Live streaming not available, using batch mode...\n\n");
            const result = (await invoke("k8s_enable")) as any;
            const output = typeof result === "string" ? result : (result?.output || JSON.stringify(result, null, 2));
            if (output && output !== "{}" && output !== "null") {
              setSetupLog(output);
              const isReady = output.includes("cluster is ready") || output.includes("Ready");
              const isInstructions = output.includes("To set up") || output.includes("Lima VM first");
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
        if (setupWs === ws) setupWs = null;
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

  const handleStop = async () => {
    setStopping(true);
    showToast("Stopping Kubernetes cluster...", "info");
    try {
      await invoke("k8s_disable");
      showToast("Kubernetes cluster stopped", "success");
      await refreshStatus();
    } catch (e) {
      logError(`Failed to stop Kubernetes: ${e}`);
      showToast(`Failed to stop: ${e}`, "error");
    }
    setStopping(false);
  };

  const handleStart = async () => {
    try {
      setEnabling(true);
      await invoke("k8s_start");
      showToast("Kubernetes cluster started", "success");
      await refreshStatus();
    } catch (e) {
      logError(`Failed to start Kubernetes: ${e}`);
      showToast(`Failed to start: ${e}`, "error");
    } finally {
      setEnabling(false);
    }
  };

  const handleReset = async () => {
    if (!await confirmDanger("Reset Kubernetes", "This will uninstall k3s and delete ALL workloads, data, and configuration. A fresh k3s will be reinstalled.")) return;
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
      const command = tab() === "statefulsets" ? "k8s_scale_statefulset" : "k8s_scale_deployment";
      await invoke(command, { namespace: target.namespace, name: target.name, replicas: scaleValue() });
      showToast(`Scaled ${target.name} to ${scaleValue()} replicas`, "success");
      setScaleTarget(null);
      await refreshWorkloads();
    } catch (e) {
      const kind = tab() === "statefulsets" ? "StatefulSet" : "Deployment";
      logError(`Failed to scale ${kind}: ${e}`, `${kind} "${target.name}" in "${target.namespace}"`);
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

  // --- Secret handlers ---
  const openCreateSecretDialog = () => {
    setSecretDialogMode("create");
    setSecretDialogName("");
    setSecretDialogType("Opaque");
    setSecretDialogEntries([{ key: "", value: "" }]);
    setSecretDialogRevealed(new Set<number>());
    setSecretDialogOpen(true);
  };

  const openEditSecretDialog = (sec: K8sSecret) => {
    setSecretDialogMode("edit");
    setSecretDialogName(sec.name);
    setSecretDialogType(sec.secret_type);
    const entries = Object.entries(sec.data).map(([key, value]) => {
      try { return { key, value: atob(value) }; } catch { return { key, value }; }
    });
    setSecretDialogEntries(entries.length > 0 ? entries : [{ key: "", value: "" }]);
    setSecretDialogRevealed(new Set<number>());
    setSecretDialogOpen(true);
  };

  const handleSaveSecret = async () => {
    const name = secretDialogName().trim();
    if (!name) { showToast("Secret name is required", "error"); return; }
    const entries = secretDialogEntries().filter(e => e.key.trim());
    if (entries.length === 0) { showToast("At least one key-value entry is required", "error"); return; }
    const data: Record<string, string> = {};
    for (const e of entries) data[e.key.trim()] = e.value;
    setSecretDialogSaving(true);
    try {
      if (secretDialogMode() === "create") {
        await invoke("k8s_create_secret", { namespace: selectedNs(), name, data, secretType: secretDialogType() });
        showToast(`Secret '${name}' created`, "success");
      } else {
        await invoke("k8s_update_secret", { namespace: selectedNs(), name, data });
        showToast(`Secret '${name}' updated`, "success");
      }
      setSecretDialogOpen(false);
      await refreshWorkloads();
    } catch (e) {
      showToast(`Failed to save secret: ${e}`, "error");
    } finally {
      setSecretDialogSaving(false);
    }
  };

  const handleDeleteSecret = async (namespace: string, name: string) => {
    if (!await confirmDanger("Delete Secret", `Delete secret '${name}'? This cannot be undone.`)) return;
    try {
      await invoke("k8s_delete_secret", { namespace, name });
      showToast(`Secret '${name}' deleted`, "success");
      await refreshWorkloads();
    } catch (e) {
      logError(`Failed to delete secret: ${e}`, `Secret "${name}" in namespace "${namespace}"`);
      showToast(`Failed to delete secret: ${e}`, "error");
    }
  };

  // --- PVC Create handler ---
  const handleCreatePvc = async () => {
    const name = pvcName().trim();
    if (!name) { showToast("PVC name is required", "error"); return; }
    const storageClass = pvcStorageClass().trim();
    if (!storageClass) { showToast("Storage class is required", "error"); return; }
    const size = `${pvcSizeValue()}${pvcSizeUnit()}`;
    const accessModes = Array.from(pvcAccessModes());
    if (accessModes.length === 0) { showToast("Select at least one access mode", "error"); return; }
    setPvcCreating(true);
    try {
      await invoke("k8s_create_pvc", { namespace: selectedNs(), name, storageClass, size, accessModes });
      showToast(`PVC '${name}' created`, "success");
      setPvcDialogOpen(false);
      setPvcName("");
      setPvcStorageClass("");
      setPvcSizeValue("1");
      setPvcSizeUnit("Gi");
      setPvcAccessModes(new Set(["ReadWriteOnce"]));
      await refreshWorkloads();
    } catch (e) {
      showToast(`Failed to create PVC: ${e}`, "error");
    } finally {
      setPvcCreating(false);
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

  const handleHelmInstall = async () => {
    const relName = helmReleaseName().trim();
    const chart = helmChartName().trim();
    if (!relName || !chart) {
      showToast("Release name and chart are required", "error");
      return;
    }
    setHelmInstalling(true);
    try {
      const setVals = helmSetValues()
        .filter((v) => v.key.trim() && v.value.trim())
        .map((v) => `${v.key.trim()}=${v.value.trim()}`);
      await invoke("k8s_helm_install", {
        releaseName: relName,
        chart,
        namespace: helmInstallNs(),
        setValues: setVals.length > 0 ? setVals : null,
      });
      showToast(`Helm release '${relName}' installed`, "success");
      setHelmInstallOpen(false);
      setHelmReleaseName("");
      setHelmChartName("");
      setHelmSetValues([]);
      await refreshWorkloads();
    } catch (e) {
      showToast(`Helm install failed: ${e}`, "error");
    } finally {
      setHelmInstalling(false);
    }
  };

  // Open the Create Ingress dialog, optionally pre-filled from a service
  const openCreateIngress = async (prefillService?: K8sService) => {
    // Load services for the current namespace
    try {
      const svcs = (await invoke("k8s_services", { namespace: selectedNs() })) as K8sService[];
      setIngressServices(svcs);
    } catch {
      setIngressServices([]);
    }
    if (prefillService) {
      setIngressServiceName(prefillService.name);
      setIngressName(`${prefillService.name}-ingress`);
      if (prefillService.ports.length > 0) {
        setIngressServicePort(String(prefillService.ports[0].port));
      }
    } else {
      setIngressServiceName("");
      setIngressName("");
      setIngressServicePort("");
    }
    setIngressHostname("");
    setIngressPath("/");
    setIngressPathType("Prefix");
    setIngressTls(false);
    setCreateIngressOpen(true);
  };

  const handleCreateIngress = async () => {
    const name = ingressName().trim();
    const hostname = ingressHostname().trim();
    const svcName = ingressServiceName();
    const svcPort = parseInt(ingressServicePort());
    const path = ingressPath().trim() || "/";
    const pathType = ingressPathType();

    if (!name || !hostname || !svcName || !svcPort) {
      showToast("Name, hostname, service, and port are required", "error");
      return;
    }

    // Validate every interpolated field. The YAML is built by template
    // literal, so any unescaped newline in a user-supplied field would
    // inject arbitrary YAML — a hostname like `foo\n    secretName: evil`
    // could attach additional TLS rules, for example.
    const dns1123 = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
    const dns1123Label = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
    if (!dns1123Label.test(name)) {
      showToast("Ingress name must be a DNS-1123 label (lowercase letters, digits, hyphens)", "error");
      return;
    }
    if (!dns1123.test(hostname)) {
      showToast("Hostname must be a DNS-1123 subdomain", "error");
      return;
    }
    if (!dns1123Label.test(svcName)) {
      showToast("Service name must be a DNS-1123 label", "error");
      return;
    }
    const ns = selectedNs();
    if (!dns1123Label.test(ns)) {
      showToast(`Invalid namespace: ${ns}`, "error");
      return;
    }
    if (!Number.isInteger(svcPort) || svcPort < 1 || svcPort > 65535) {
      showToast("Service port must be 1-65535", "error");
      return;
    }
    if (pathType !== "Prefix" && pathType !== "Exact" && pathType !== "ImplementationSpecific") {
      showToast(`Invalid pathType: ${pathType}`, "error");
      return;
    }
    // URL paths: allow a reasonable set of characters. Reject anything
    // containing whitespace (which could break YAML) or control bytes.
    if (!/^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/]*$/.test(path)) {
      showToast("Path must start with / and contain only URL-safe characters", "error");
      return;
    }

    let yaml = `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${name}
  namespace: ${ns}
spec:
  rules:
  - host: ${hostname}
    http:
      paths:
      - path: ${path}
        pathType: ${pathType}
        backend:
          service:
            name: ${svcName}
            port:
              number: ${svcPort}`;

    if (ingressTls()) {
      yaml += `
  tls:
  - hosts:
    - ${hostname}
    secretName: ${hostname}-tls`;
    }

    setIngressCreating(true);
    try {
      await invoke("k8s_apply_yaml", { yaml });
      showToast(`Ingress '${name}' created`, "success");
      setCreateIngressOpen(false);
      await refreshWorkloads();
    } catch (e) {
      showToast(`Failed to create ingress: ${e}`, "error");
    } finally {
      setIngressCreating(false);
    }
  };

  // Traefik dashboard: on Windows, port-forward first then open; otherwise just open
  const openTraefikDashboard = async () => {
    const dashUrl = status()?.traefik_dashboard;
    if (dashUrl) {
      // Non-Windows: URL is directly accessible
      await shellOpen(dashUrl);
      return;
    }
    // Windows / no direct URL: port-forward traefik service port 9000, then open
    const tSvc = traefikService();
    if (!tSvc) {
      showToast("Traefik service not found in kube-system", "error");
      return;
    }
    // Check if already forwarded
    if (isForwarded("kube-system", "traefik", 9000)) {
      await shellOpen("http://localhost:9000/dashboard/");
      return;
    }
    setTraefikForwarding(true);
    try {
      await invoke("k8s_port_forward", { namespace: "kube-system", service: "traefik", port: 9000, localPort: 9000 });
      await refreshPortForwards();
      // Give port-forward a moment to bind before opening browser
      await new Promise(r => setTimeout(r, 1500));
      await shellOpen("http://localhost:9000/dashboard/");
    } catch (e) {
      showToast(`Failed to forward Traefik dashboard: ${e}`, "error");
    } finally {
      setTraefikForwarding(false);
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
    { id: "daemonsets", label: "DaemonSets", icon: "\u25C9" },
    { id: "statefulsets", label: "StatefulSets", icon: "\u25A3" },
    { id: "replicasets", label: "ReplicaSets", icon: "\u25A7" },
    { id: "services", label: "Services", icon: "\u29BF" },
    { id: "ingresses", label: "Ingresses", icon: "\u21C4" },
    { id: "storage", label: "Storage", icon: "\u25A8" },
    { id: "events", label: "Events", icon: "\u26A0" },
    { id: "config", label: "Config", icon: "\u2699" },
    { id: "helm", label: "Helm", icon: "\u2388" },
    { id: "jobs", label: "Jobs", icon: "\u23F0" },
    { id: "crds", label: "CRDs", icon: "\u2756" },
    { id: "topology", label: "Topology", icon: "\u25CE" },
  ];

  const emptyMessages: Record<Tab, { title: string; desc: string }> = {
    pods: { title: "No pods in this namespace", desc: "Pods will appear here when you deploy workloads to this namespace." },
    deployments: { title: "No deployments in this namespace", desc: "Create a deployment to manage replicated pods." },
    daemonsets: { title: "No DaemonSets in this namespace", desc: "DaemonSets ensure a pod runs on every (or selected) node." },
    statefulsets: { title: "No StatefulSets in this namespace", desc: "StatefulSets manage stateful applications with stable network identities." },
    replicasets: { title: "No ReplicaSets in this namespace", desc: "ReplicaSets maintain a stable set of replica pods. Usually managed by Deployments." },
    services: { title: "No services in this namespace", desc: "Services provide stable networking endpoints for your pods." },
    ingresses: { title: "No ingresses in this namespace", desc: "Ingresses route external HTTP traffic to your services via Traefik." },
    storage: { title: "No storage resources", desc: "Persistent Volume Claims will appear when workloads request storage." },
    events: { title: "No events in this namespace", desc: "Events will appear when Kubernetes resources change state." },
    config: { title: "No ConfigMaps or Secrets", desc: "ConfigMaps and Secrets store configuration data for your workloads." },
    helm: { title: "No Helm releases", desc: "Install Helm charts using the helm CLI to manage releases here." },
    jobs: { title: "No Jobs or CronJobs", desc: "Jobs and CronJobs will appear here when you create batch workloads." },
    crds: { title: "No Custom Resource Definitions", desc: "CRDs extend the Kubernetes API with custom resource types." },
    topology: { title: "No resources to visualize", desc: "Deploy workloads to see a visual topology of your namespace." },
  };

  return (
    <div>
      <div class="page-header">
        <h1 class="page-title">Kubernetes</h1>
      </div>

      {/* Hero Card: Not installed / Installed but stopped / Enabling */}
      <Show when={status() && !status()!.running}>
        <div class="hero-card">
          <Show when={enabling()}>
            <div class="hero-spinner">
              <Spinner />
              <div class="hero-title" style={{ "font-size": "20px" }}>
                {status()?.installed ? "Starting cluster..." : "Setting up cluster..."}
              </div>
              <div class="hero-subtitle" style={{ "margin-bottom": "0" }}>
                {status()?.installed
                  ? "Starting k3s. This may take a moment."
                  : "Installing k3s and configuring Traefik ingress. This may take a minute."}
              </div>
            </div>
          </Show>
          <Show when={!enabling()}>
            <div style={{ position: "relative" }}>
              <div style={{ "font-size": "48px", "margin-bottom": "16px", opacity: "0.6" }}>{"\u2638"}</div>
              <div class="hero-title">Kubernetes</div>
              <Show when={status()?.installed} fallback={
                <>
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
                </>
              }>
                <div class="hero-subtitle">
                  The Kubernetes cluster is installed but not running.
                </div>
                <div style={{ display: "flex", gap: "10px", "justify-content": "center", "margin-top": "8px" }}>
                  <button
                    class="btn btn-primary btn-hero"
                    onClick={handleStart}
                  >
                    Start Kubernetes
                  </button>
                  <button
                    class="btn btn-hero"
                    style={{
                      background: "rgba(248, 81, 73, 0.1)",
                      color: "#f85149",
                      border: "1px solid rgba(248, 81, 73, 0.3)",
                      "font-size": "13px",
                      padding: "8px 16px",
                    }}
                    onClick={handleReset}
                  >
                    Reset Kubernetes
                  </button>
                </div>
              </Show>
              <Show when={status()?.error && !status()?.error?.includes("not found") && !status()?.installed}>
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
                  {status()?.error}
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
              background: stopping() ? "#d29922" : "#3fb950",
              "box-shadow": stopping() ? "0 0 6px #d2992244" : "0 0 6px #3fb95044",
            }} />
            <span style={{ "font-weight": "600", "font-size": "13px" }}>
              {stopping() ? "Stopping..." : (status()?.version || "Kubernetes")}
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
          <Show when={traefikIntegrationMode() && traefikService()}>
            <span class="status-bar-separator" />
            <span style={{ "font-size": "11px", color: "#8b949e" }} title="Configured in Gateway page">
              {traefikIntegrationMode() === "separate_ports"
                ? "Traefik: Separate ports"
                : traefikIntegrationMode() === "gateway_proxies_traefik"
                ? "Traefik: Proxied via Gateway"
                : "Traefik: Default"}
            </span>
          </Show>
          <div style={{ "margin-left": "auto", display: "flex", gap: "6px" }}>
            <Show when={status()?.traefik_dashboard || traefikService()}>
              <button
                class="btn btn-sm"
                style={{ "font-size": "11px" }}
                onClick={openTraefikDashboard}
                disabled={traefikForwarding()}
              >
                {traefikForwarding() ? "Connecting..." : "Traefik Dashboard"}
              </button>
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
                  <Show when={traefikService()}>
                    <button class="dropdown-item" onClick={() => setTraefikInfoOpen(true)}>
                      {"\u29BF"} Traefik Info
                    </button>
                  </Show>
                  <div class="dropdown-divider" />
                  <button class="dropdown-item dropdown-item-danger" onClick={handleReset}>
                    {"\u26A0"} Reset Cluster
                  </button>
                  <button class="dropdown-item dropdown-item-danger" onClick={handleStop} disabled={stopping()}>
                    {stopping() ? "Stopping..." : "\u25A0 Stop Kubernetes"}
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

          {/* Autoscalers sub-section */}
          <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", "margin-top": "24px", "margin-bottom": "12px" }}>
            <h3 style={{ color: "#e6edf3", "font-size": "14px", margin: "0" }}>
              Autoscalers
            </h3>
            <button class="btn btn-sm btn-primary" onClick={() => {
              setHpaName("");
              setHpaDeployment(deployments().length > 0 ? deployments()[0].name : "");
              setHpaMin("1");
              setHpaMax("5");
              setHpaCpuTarget("50");
              setHpaDialogOpen(true);
            }}>
              + Create HPA
            </button>
          </div>
          <Show
            when={hpas().length > 0}
            fallback={
              <div class="empty-state-tab" style={{ padding: "32px 20px" }}>
                <div class="empty-state-tab-title">No autoscalers in this namespace</div>
                <div class="empty-state-tab-desc">Create an HPA to automatically scale deployments based on CPU usage.</div>
              </div>
            }
          >
            <table class="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Reference</th>
                  <th>Min</th>
                  <th>Max</th>
                  <th>Current</th>
                  <th>Target CPU</th>
                  <th>Current CPU</th>
                  <th>Age</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                <For each={hpas()}>
                  {(hpa) => (
                    <tr>
                      <td style={{ "font-weight": "500" }}>{hpa.name}</td>
                      <td class="mono" style={{ color: "#8b949e", "font-size": "12px" }}>{hpa.reference}</td>
                      <td class="mono">{hpa.min_replicas}</td>
                      <td class="mono">{hpa.max_replicas}</td>
                      <td class="mono">{hpa.current_replicas}</td>
                      <td class="mono" style={{ color: "#8b949e" }}>{hpa.target_cpu || "-"}</td>
                      <td class="mono" style={{ color: "#8b949e" }}>{hpa.current_cpu || "-"}</td>
                      <td style={{ color: "#8b949e" }}>{hpa.created_at}</td>
                      <td>
                        <div style={{ display: "flex", gap: "4px", "align-items": "center" }}>
                          <button
                            class="action-icon"
                            title="View YAML"
                            onClick={() => viewYaml("hpa", hpa.name, hpa.namespace)}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
                          </button>
                          <button
                            class="action-icon action-icon-delete"
                            title="Delete HPA"
                            onClick={async () => {
                              const ok = await confirmDanger(`Delete HPA "${hpa.name}"?`, "This will remove the autoscaler. The deployment will keep its current replica count.");
                              if (!ok) return;
                              try {
                                await invoke("k8s_delete_hpa", { namespace: hpa.namespace, name: hpa.name });
                                showToast(`Deleted HPA ${hpa.name}`, "success");
                                refreshWorkloads();
                              } catch (e) {
                                showToast(`Failed to delete HPA: ${e}`, "error");
                              }
                            }}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
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

        {/* DaemonSets Tab */}
        <Show when={tab() === "daemonsets"}>
          <Show
            when={daemonSets().length > 0}
            fallback={
              <div class="empty-state-tab">
                <div class="empty-state-tab-title">{emptyMessages.daemonsets.title}</div>
                <div class="empty-state-tab-desc">{emptyMessages.daemonsets.desc}</div>
              </div>
            }
          >
            <table class="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Desired</th>
                  <th>Current</th>
                  <th>Ready</th>
                  <th>Node Selector</th>
                  <th>Images</th>
                  <th>Age</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                <For each={daemonSets()}>
                  {(ds) => (
                    <tr>
                      <td style={{ "font-weight": "500" }}>{ds.name}</td>
                      <td class="mono">{ds.desired}</td>
                      <td class="mono">{ds.current}</td>
                      <td class="mono">
                        <span style={{
                          color: ds.ready === ds.desired ? "#3fb950" : "#d29922",
                        }}>
                          {ds.ready}
                        </span>
                      </td>
                      <td style={{ "max-width": "200px", "font-size": "12px", color: "#8b949e" }}>
                        {ds.node_selector || "-"}
                      </td>
                      <td style={{ "max-width": "300px" }}>
                        <For each={ds.images}>
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
                      <td style={{ color: "#8b949e" }}>{ds.created_at}</td>
                      <td>
                        <div style={{ display: "flex", gap: "4px", "align-items": "center" }}>
                          <button
                            class="action-icon"
                            title="View/Edit YAML"
                            onClick={() => viewYaml("daemonset", ds.name, ds.namespace)}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
                          </button>
                          <button
                            class="action-icon action-icon-delete"
                            title="Delete DaemonSet"
                            onClick={async () => {
                              if (!await confirmDanger(`Delete DaemonSet "${ds.name}"?`, "This will remove the DaemonSet and its pods.")) return;
                              try {
                                await invoke("k8s_delete_daemonset", { namespace: ds.namespace, name: ds.name });
                                showToast(`DaemonSet ${ds.name} deleted`, "success");
                                logInfo(`Deleted DaemonSet ${ds.name}`);
                                refreshWorkloads();
                              } catch (e) {
                                showToast(`Delete failed: ${e}`, "error");
                              }
                            }}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
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

        {/* StatefulSets Tab */}
        <Show when={tab() === "statefulsets"}>
          <Show
            when={statefulSets().length > 0}
            fallback={
              <div class="empty-state-tab">
                <div class="empty-state-tab-title">{emptyMessages.statefulsets.title}</div>
                <div class="empty-state-tab-desc">{emptyMessages.statefulsets.desc}</div>
              </div>
            }
          >
            <table class="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Ready</th>
                  <th>Replicas</th>
                  <th>Images</th>
                  <th>Age</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                <For each={statefulSets()}>
                  {(sts) => {
                    const [readyCount, totalCount] = sts.ready.split("/").map(Number);
                    return (
                      <tr>
                        <td style={{ "font-weight": "500" }}>{sts.name}</td>
                        <td class="mono">
                          <span style={{
                            color: readyCount === totalCount ? "#3fb950" : "#d29922",
                          }}>
                            {sts.ready}
                          </span>
                        </td>
                        <td class="mono">{sts.replicas}</td>
                        <td style={{ "max-width": "300px" }}>
                          <For each={sts.images}>
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
                        <td style={{ color: "#8b949e" }}>{sts.created_at}</td>
                        <td>
                          <div style={{ display: "flex", gap: "4px", "align-items": "center" }}>
                            <button
                              class="btn btn-sm"
                              style={{ "font-size": "11px" }}
                              onClick={() => openScaleDialog(sts.namespace, sts.name, sts.replicas)}
                            >
                              Scale
                            </button>
                            <button
                              class="action-icon"
                              title="Restart StatefulSet"
                              onClick={async () => {
                                try {
                                  await invoke("k8s_restart_statefulset", { namespace: sts.namespace, name: sts.name });
                                  showToast(`StatefulSet ${sts.name} restarting`, "success");
                                  await refreshWorkloads();
                                } catch (e) {
                                  logError(`Failed to restart StatefulSet: ${e}`, `StatefulSet "${sts.name}" in "${sts.namespace}"`);
                                  showToast(`Failed to restart: ${e}`, "error");
                                }
                              }}
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 21h5v-5"/></svg>
                            </button>
                            <button
                              class="action-icon"
                              title="View/Edit YAML"
                              onClick={() => viewYaml("statefulset", sts.name, sts.namespace)}
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
                            </button>
                            <button
                              class="action-icon action-icon-delete"
                              title="Delete StatefulSet"
                              onClick={async () => {
                                if (!await confirmDanger(`Delete StatefulSet "${sts.name}"?`, "This will remove the StatefulSet and its pods.")) return;
                                try {
                                  await invoke("k8s_delete_statefulset", { namespace: sts.namespace, name: sts.name });
                                  showToast(`StatefulSet ${sts.name} deleted`, "success");
                                  logInfo(`Deleted StatefulSet ${sts.name}`);
                                  refreshWorkloads();
                                } catch (e) {
                                  showToast(`Delete failed: ${e}`, "error");
                                }
                              }}
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
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

        {/* ReplicaSets Tab */}
        <Show when={tab() === "replicasets"}>
          <Show
            when={replicaSets().length > 0}
            fallback={
              <div class="empty-state-tab">
                <div class="empty-state-tab-title">{emptyMessages.replicasets.title}</div>
                <div class="empty-state-tab-desc">{emptyMessages.replicasets.desc}</div>
              </div>
            }
          >
            <table class="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Desired</th>
                  <th>Current</th>
                  <th>Ready</th>
                  <th>Owner</th>
                  <th>Images</th>
                  <th>Age</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                <For each={replicaSets()}>
                  {(rs) => (
                    <tr>
                      <td style={{ "font-weight": "500" }}>{rs.name}</td>
                      <td class="mono">{rs.desired}</td>
                      <td class="mono">{rs.current}</td>
                      <td class="mono">
                        <span style={{
                          color: rs.ready === rs.desired ? "#3fb950" : "#d29922",
                        }}>
                          {rs.ready}
                        </span>
                      </td>
                      <td style={{ color: "#8b949e", "font-size": "12px" }}>
                        {rs.owner || "-"}
                      </td>
                      <td style={{ "max-width": "300px" }}>
                        <For each={rs.images}>
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
                      <td style={{ color: "#8b949e" }}>{rs.created_at}</td>
                      <td>
                        <div style={{ display: "flex", gap: "4px", "align-items": "center" }}>
                          <button
                            class="action-icon"
                            title="View/Edit YAML"
                            onClick={() => viewYaml("replicaset", rs.name, rs.namespace)}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
                          </button>
                          <button
                            class="action-icon action-icon-delete"
                            title="Delete ReplicaSet"
                            onClick={async () => {
                              if (!await confirmDanger(`Delete ReplicaSet "${rs.name}"?`, "This will remove the ReplicaSet and its pods.")) return;
                              try {
                                await invoke("k8s_delete_replicaset", { namespace: rs.namespace, name: rs.name });
                                showToast(`ReplicaSet ${rs.name} deleted`, "success");
                                logInfo(`Deleted ReplicaSet ${rs.name}`);
                                refreshWorkloads();
                              } catch (e) {
                                showToast(`Delete failed: ${e}`, "error");
                              }
                            }}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
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
                  <th />
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
                      <td style={{ display: "flex", gap: "4px", "align-items": "center" }}>
                        <button
                          class="btn btn-sm"
                          style={{ "font-size": "11px", padding: "2px 8px" }}
                          title="Create an Ingress to expose this service"
                          onClick={() => openCreateIngress(svc)}
                        >
                          Expose
                        </button>
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

          {/* Network Policies sub-section */}
          <h3 style={{ color: "#e6edf3", "font-size": "14px", "margin-top": "24px", "margin-bottom": "12px" }}>
            Network Policies
          </h3>
          <Show
            when={networkPolicies().length > 0}
            fallback={
              <div class="empty-state-tab" style={{ padding: "32px 20px" }}>
                <div class="empty-state-tab-title">No network policies in this namespace</div>
                <div class="empty-state-tab-desc">Network policies control traffic flow between pods.</div>
              </div>
            }
          >
            <table class="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Pod Selector</th>
                  <th>Policy Types</th>
                  <th>Age</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                <For each={networkPolicies()}>
                  {(np) => (
                    <tr>
                      <td style={{ "font-weight": "500" }}>{np.name}</td>
                      <td class="mono" style={{ color: "#8b949e", "font-size": "12px" }}>{np.pod_selector}</td>
                      <td>
                        <div style={{ display: "flex", gap: "4px", "flex-wrap": "wrap" }}>
                          <For each={np.policy_types}>
                            {(pt) => (
                              <span style={{
                                background: pt === "Ingress" ? "#1c2333" : "#1f2d1f",
                                color: pt === "Ingress" ? "#79c0ff" : "#3fb950",
                                padding: "2px 8px",
                                "border-radius": "10px",
                                "font-size": "12px",
                              }}>
                                {pt}
                              </span>
                            )}
                          </For>
                        </div>
                      </td>
                      <td style={{ color: "#8b949e" }}>{np.created_at}</td>
                      <td>
                        <div style={{ display: "flex", gap: "4px", "align-items": "center" }}>
                          <button
                            class="action-icon"
                            title="View YAML"
                            onClick={() => viewYaml("networkpolicy", np.name, np.namespace)}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
                          </button>
                          <button
                            class="action-icon action-icon-delete"
                            title="Delete Network Policy"
                            onClick={async () => {
                              const ok = await confirmDanger(`Delete network policy "${np.name}"?`, "This may affect network connectivity for pods in this namespace.");
                              if (!ok) return;
                              try {
                                await invoke("k8s_delete_network_policy", { namespace: np.namespace, name: np.name });
                                showToast(`Deleted network policy ${np.name}`, "success");
                                refreshWorkloads();
                              } catch (e) {
                                showToast(`Failed to delete: ${e}`, "error");
                              }
                            }}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
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

        {/* Ingresses Tab */}
        <Show when={tab() === "ingresses"}>
          <div style={{ display: "flex", "justify-content": "flex-end", "margin-bottom": "12px" }}>
            <button
              class="btn btn-sm btn-primary"
              style={{ "font-size": "12px", padding: "4px 12px" }}
              onClick={() => openCreateIngress()}
            >
              + Create Ingress
            </button>
          </div>
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
                  <th />
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
          <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", "margin-bottom": "12px" }}>
            <h3 style={{ color: "#e6edf3", "font-size": "14px", margin: "0" }}>
              Persistent Volume Claims
            </h3>
            <button class="btn btn-sm btn-primary" onClick={() => setPvcDialogOpen(true)}>
              + Create PVC
            </button>
          </div>
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

          {/* Storage Classes sub-section */}
          <h3 style={{ color: "#e6edf3", "font-size": "14px", "margin-top": "24px", "margin-bottom": "12px" }}>
            Storage Classes
          </h3>
          <Show
            when={storageClasses().length > 0}
            fallback={
              <div class="empty-state-tab" style={{ padding: "32px 20px" }}>
                <div class="empty-state-tab-title">No storage classes</div>
                <div class="empty-state-tab-desc">Storage classes define how persistent volumes are provisioned.</div>
              </div>
            }
          >
            <table class="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Provisioner</th>
                  <th>Reclaim Policy</th>
                  <th>Binding Mode</th>
                  <th>Default</th>
                  <th>Age</th>
                </tr>
              </thead>
              <tbody>
                <For each={storageClasses()}>
                  {(sc) => (
                    <tr>
                      <td style={{ "font-weight": "500" }}>
                        {sc.name}
                        <Show when={sc.is_default}>
                          <span style={{
                            background: "#1f3a2a",
                            color: "#3fb950",
                            padding: "2px 6px",
                            "border-radius": "10px",
                            "font-size": "11px",
                            "margin-left": "8px",
                          }}>
                            default
                          </span>
                        </Show>
                      </td>
                      <td class="mono" style={{ color: "#8b949e", "font-size": "12px" }}>{sc.provisioner}</td>
                      <td style={{ color: "#8b949e" }}>{sc.reclaim_policy}</td>
                      <td style={{ color: "#8b949e" }}>{sc.volume_binding_mode}</td>
                      <td>{sc.is_default ? "Yes" : "No"}</td>
                      <td style={{ color: "#8b949e" }}>{sc.created_at}</td>
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
          <div style={{ display: "flex", gap: "8px", "margin-bottom": "16px", "align-items": "center" }}>
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
            <Show when={configSubTab() === "secrets"}>
              <div style={{ "margin-left": "auto" }}>
                <button class="btn btn-sm btn-primary" onClick={openCreateSecretDialog}>
                  + Create Secret
                </button>
              </div>
            </Show>
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
                              title="Edit secret data"
                              onClick={() => openEditSecretDialog(sec)}
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                            </button>
                            <button
                              class="action-icon"
                              title="View/Edit YAML"
                              onClick={() => viewYaml("secret", sec.name, sec.namespace)}
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>
                            </button>
                            <button
                              class="action-icon action-icon-delete"
                              title="Delete secret"
                              onClick={() => handleDeleteSecret(sec.namespace, sec.name)}
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
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
                Helm is the package manager for Kubernetes — install it to deploy charts.
              </div>
              <button
                class="btn btn-primary"
                style={{ "margin-top": "12px" }}
                onClick={async () => {
                  showToast("Installing Helm — this may take a minute...", "info");
                  try {
                    await invoke("env_fix", { action: "install_helm" });
                    showToast("Helm installed!", "success");
                    setHelmAvailable(true);
                  } catch (e) {
                    showToast(`Helm install failed: ${e}`, "error");
                  }
                }}
              >
                Install Helm
              </button>
            </div>
          </Show>
          <Show when={helmAvailable() === null}>
            <div style={{ color: "#8b949e", "text-align": "center", padding: "20px" }}>
              <Spinner />
            </div>
          </Show>
          <Show when={helmAvailable()}>
            <div style={{ display: "flex", "justify-content": "flex-end", "margin-bottom": "8px" }}>
              <button class="btn btn-primary" style={{ display: "inline-flex", "align-items": "center", gap: "6px" }} onClick={() => { setHelmInstallNs(selectedNs()); setHelmInstallOpen(true); }}>
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                Install Chart
              </button>
            </div>
            <Show
              when={helmReleases().length > 0}
              fallback={
                <div class="empty-state-tab">
                  <div class="empty-state-tab-title">{emptyMessages.helm.title}</div>
                  <div class="empty-state-tab-desc">
                    Click "Install Chart" above or use <code style={{ background: "#0d1117", padding: "2px 6px", "border-radius": "4px" }}>helm install</code> CLI to add releases.
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

        {/* Jobs Tab */}
        <Show when={tab() === "jobs"}>
          <Show
            when={cronJobs().length > 0 || jobs().length > 0}
            fallback={
              <div class="empty-state-tab">
                <div class="empty-state-tab-title">{emptyMessages.jobs.title}</div>
                <div class="empty-state-tab-desc">{emptyMessages.jobs.desc}</div>
              </div>
            }
          >
            {/* CronJobs Section */}
            <Show when={cronJobs().length > 0}>
              <h3 style={{ margin: "16px 0 8px", color: "#e6edf3", "font-size": "14px", "font-weight": "600" }}>CronJobs</h3>
              <table class="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Schedule</th>
                    <th>Suspend</th>
                    <th>Active</th>
                    <th>Last Scheduled</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={cronJobs()}>
                    {(cj) => (
                      <tr style={{ opacity: cj.suspend ? 0.5 : 1 }}>
                        <td style={{ "font-weight": "500" }}>
                          {cj.name}
                          <Show when={cj.suspend}>
                            <span style={{
                              "margin-left": "8px",
                              "font-size": "10px",
                              padding: "2px 6px",
                              "border-radius": "4px",
                              background: "#30363d",
                              color: "#8b949e",
                            }}>Suspended</span>
                          </Show>
                        </td>
                        <td class="mono" style={{ "font-size": "12px", color: "#8b949e" }}>{cj.schedule}</td>
                        <td>
                          <span style={{ color: cj.suspend ? "#f85149" : "#3fb950", "font-weight": "500" }}>
                            {cj.suspend ? "Yes" : "No"}
                          </span>
                        </td>
                        <td>{cj.active}</td>
                        <td style={{ color: "#8b949e", "font-size": "12px" }}>
                          {cj.last_schedule ? new Date(cj.last_schedule).toLocaleString() : "Never"}
                        </td>
                        <td style={{ display: "flex", gap: "4px" }}>
                          <button
                            class="action-icon"
                            title="Trigger Job now"
                            onClick={async () => {
                              try {
                                const result = await invoke("k8s_trigger_cronjob", { namespace: cj.namespace, name: cj.name }) as { job: string };
                                showToast(`Job created: ${result.job}`, "success");
                                logInfo(`Triggered CronJob ${cj.name} -> ${result.job}`);
                                refreshWorkloads();
                              } catch (e) {
                                showToast(`Failed to trigger: ${e}`, "error");
                              }
                            }}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                          </button>
                          <button
                            class="action-icon"
                            title={cj.suspend ? "Resume CronJob" : "Suspend CronJob"}
                            onClick={async () => {
                              try {
                                await invoke("k8s_suspend_cronjob", { namespace: cj.namespace, name: cj.name, suspend: !cj.suspend });
                                showToast(`CronJob ${cj.name} ${cj.suspend ? "resumed" : "suspended"}`, "success");
                                logInfo(`${cj.suspend ? "Resumed" : "Suspended"} CronJob ${cj.name}`);
                                refreshWorkloads();
                              } catch (e) {
                                showToast(`Failed: ${e}`, "error");
                              }
                            }}
                          >
                            <Show when={cj.suspend}
                              fallback={
                                <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                              }
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                            </Show>
                          </button>
                          <button
                            class="action-icon"
                            title="View YAML"
                            onClick={() => viewYaml("CronJob", cj.name, cj.namespace)}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                          </button>
                          <button
                            class="action-icon action-icon-delete"
                            title="Delete CronJob"
                            onClick={async () => {
                              if (!await confirmDanger(`Delete CronJob "${cj.name}"?`, "This will remove the CronJob and stop future scheduling.")) return;
                              try {
                                await invoke("k8s_delete_cronjob", { namespace: cj.namespace, name: cj.name });
                                showToast(`CronJob ${cj.name} deleted`, "success");
                                logInfo(`Deleted CronJob ${cj.name}`);
                                refreshWorkloads();
                              } catch (e) {
                                showToast(`Delete failed: ${e}`, "error");
                              }
                            }}
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

            {/* Jobs Section */}
            <Show when={jobs().length > 0}>
              <h3 style={{ margin: "16px 0 8px", color: "#e6edf3", "font-size": "14px", "font-weight": "600" }}>Jobs</h3>
              <table class="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Status</th>
                    <th>Completions</th>
                    <th>Duration</th>
                    <th>Started</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={jobs()}>
                    {(job) => (
                      <tr>
                        <td style={{ "font-weight": "500" }}>{job.name}</td>
                        <td>
                          <span style={{
                            color: job.status === "Succeeded" ? "#3fb950" : job.status === "Failed" ? "#f85149" : "#d29922",
                            "font-weight": "500",
                          }}>
                            {job.status}
                          </span>
                        </td>
                        <td class="mono" style={{ "font-size": "12px" }}>{job.completions}</td>
                        <td style={{ color: "#8b949e", "font-size": "12px" }}>{job.duration}</td>
                        <td style={{ color: "#8b949e", "font-size": "12px" }}>
                          {job.start_time ? new Date(job.start_time).toLocaleString() : "-"}
                        </td>
                        <td style={{ display: "flex", gap: "4px" }}>
                          <button
                            class="action-icon"
                            title="View Logs"
                            onClick={() => {
                              setLogPod(job.name);
                              setLogLines([]);
                              setLogFollow(false);
                              invoke("k8s_pod_logs", { namespace: job.namespace, name: job.name, tail: logTail() })
                                .then((lines) => setLogLines(lines as string[]))
                                .catch((e) => showToast(`Failed to get logs: ${e}`, "error"));
                            }}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                          </button>
                          <button
                            class="action-icon"
                            title="View YAML"
                            onClick={() => viewYaml("Job", job.name, job.namespace)}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                          </button>
                          <button
                            class="action-icon action-icon-delete"
                            title="Delete Job"
                            onClick={async () => {
                              if (!await confirmDanger(`Delete Job "${job.name}"?`, "This will remove the Job and its pods.")) return;
                              try {
                                await invoke("k8s_delete_job", { namespace: job.namespace, name: job.name });
                                showToast(`Job ${job.name} deleted`, "success");
                                logInfo(`Deleted Job ${job.name}`);
                                refreshWorkloads();
                              } catch (e) {
                                showToast(`Delete failed: ${e}`, "error");
                              }
                            }}
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

        {/* CRDs Tab */}
        <Show when={tab() === "crds"}>
          <Show
            when={crds().length > 0}
            fallback={
              <div class="empty-state-tab">
                <div class="empty-state-tab-title">{emptyMessages.crds.title}</div>
                <div class="empty-state-tab-desc">{emptyMessages.crds.desc}</div>
              </div>
            }
          >
            <table class="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Group</th>
                  <th>Kind</th>
                  <th>Scope</th>
                  <th>Versions</th>
                  <th>Age</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                <For each={crds()}>
                  {(crd) => (
                    <tr>
                      <td style={{ "font-weight": "500", "max-width": "300px", "word-break": "break-all" }}>{crd.name}</td>
                      <td class="mono" style={{ color: "#8b949e", "font-size": "12px" }}>{crd.group}</td>
                      <td>{crd.kind}</td>
                      <td>
                        <span style={{
                          background: crd.scope === "Namespaced" ? "#1c2333" : "#2d1f2d",
                          color: crd.scope === "Namespaced" ? "#79c0ff" : "#d2a8ff",
                          padding: "2px 8px",
                          "border-radius": "10px",
                          "font-size": "12px",
                        }}>
                          {crd.scope}
                        </span>
                      </td>
                      <td class="mono" style={{ color: "#8b949e", "font-size": "12px" }}>
                        {crd.versions.join(", ")}
                      </td>
                      <td style={{ color: "#8b949e" }}>{crd.created_at}</td>
                      <td>
                        <button
                          class="action-icon"
                          title="View YAML"
                          onClick={() => viewYaml("crd", crd.name, "default")}
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
            <div style={{ padding: "12px 0" }}>
              <For each={services()}>
                {(svc) => {
                  const matchedDeps = () => deployments().filter((d) =>
                    svc.name.includes(d.name) || d.name.includes(svc.name) || svc.name === d.name
                  );
                  const svcKey = `svc-${svc.name}`;
                  const isHighlighted = (key: string) => {
                    const h = topoHover();
                    if (!h) return false;
                    return h === key || h === svcKey || matchedDeps().some((d) => h === `dep-${d.name}` || h === svcKey);
                  };
                  return (
                    <div style={{
                      display: "flex", "align-items": "stretch", gap: "0",
                      "margin-bottom": "20px", "flex-wrap": "wrap", position: "relative",
                    }}>
                      {/* Service card */}
                      <div
                        style={{
                          background: "#1c2333",
                          border: `2px solid ${isHighlighted(svcKey) ? "#58a6ff" : "#30363d"}`,
                          "border-radius": "10px", padding: "14px 18px",
                          "min-width": "200px", cursor: "pointer",
                          transition: "border-color 0.2s, box-shadow 0.2s, transform 0.15s",
                          "box-shadow": isHighlighted(svcKey) ? "0 0 12px rgba(88,166,255,0.2)" : "none",
                          transform: isHighlighted(svcKey) ? "scale(1.02)" : "scale(1)",
                        }}
                        onClick={() => setTab("services")}
                        onMouseEnter={() => setTopoHover(svcKey)}
                        onMouseLeave={() => setTopoHover(null)}
                        title="Click to view services"
                      >
                        <div style={{ display: "flex", "align-items": "center", gap: "6px", "margin-bottom": "6px" }}>
                          <span style={{ "font-size": "14px" }}>{"\u29BF"}</span>
                          <span style={{ "font-size": "10px", color: "#79c0ff", "text-transform": "uppercase", "letter-spacing": "0.5px", "font-weight": "600" }}>Service</span>
                        </div>
                        <div style={{ "font-weight": "600", "font-size": "14px", color: "#e6edf3", "margin-bottom": "6px" }}>{svc.name}</div>
                        <div style={{ "font-size": "11px", color: "#8b949e", "margin-bottom": "4px" }}>
                          Type: {svc.service_type}
                        </div>
                        <div style={{ display: "flex", "flex-wrap": "wrap", gap: "4px" }}>
                          <For each={svc.ports}>
                            {(p) => (
                              <span style={{
                                background: "#0d419d33", color: "#79c0ff", "font-size": "10px",
                                padding: "2px 6px", "border-radius": "4px", "font-family": "'JetBrains Mono NF', monospace",
                              }}>
                                {p.name ? `${p.name}: ` : ""}{p.port}{p.node_port ? ` -> ${p.node_port}` : ""}/{p.protocol}
                              </span>
                            )}
                          </For>
                        </div>
                        <Show when={svc.cluster_ip}>
                          <div style={{ "font-size": "10px", color: "#6e7681", "margin-top": "4px", "font-family": "'JetBrains Mono NF', monospace" }}>
                            {svc.cluster_ip}
                          </div>
                        </Show>
                      </div>

                      <Show when={matchedDeps().length > 0}>
                        {/* SVG connector line */}
                        <svg width="40" height="100%" style={{ "min-height": "40px", "align-self": "center", flex: "0 0 40px" }}>
                          <line x1="0" y1="50%" x2="40" y2="50%" stroke="#30363d" stroke-width="2" stroke-dasharray="4 3" />
                          <circle cx="38" cy="50%" r="3" fill="#58a6ff" />
                        </svg>
                      </Show>

                      <For each={matchedDeps()}>
                        {(dep) => {
                          const depPods = () => pods().filter((p) => p.name.startsWith(dep.name));
                          const depKey = `dep-${dep.name}`;
                          const depHealthy = dep.replicas_ready === dep.replicas_desired && dep.replicas_desired > 0;
                          const depDegraded = dep.replicas_ready > 0 && dep.replicas_ready < dep.replicas_desired;
                          const depBorderColor = depHealthy ? "#2d4a2d" : depDegraded ? "#5c4a1e" : "#5c1e1e";
                          const depGlowColor = depHealthy ? "rgba(63,185,80,0.15)" : depDegraded ? "rgba(210,153,34,0.15)" : "rgba(248,81,73,0.15)";
                          return (
                            <div style={{ display: "flex", "align-items": "stretch", gap: "0" }}>
                              <div
                                style={{
                                  background: "#1f2a1f",
                                  border: `2px solid ${isHighlighted(depKey) || isHighlighted(svcKey) ? (depHealthy ? "#3fb950" : depDegraded ? "#d29922" : "#f85149") : depBorderColor}`,
                                  "border-radius": "10px", padding: "14px 18px",
                                  "min-width": "200px", cursor: "pointer",
                                  transition: "border-color 0.2s, box-shadow 0.2s, transform 0.15s",
                                  "box-shadow": isHighlighted(depKey) || isHighlighted(svcKey) ? `0 0 12px ${depGlowColor}` : "none",
                                  transform: isHighlighted(depKey) || isHighlighted(svcKey) ? "scale(1.02)" : "scale(1)",
                                  position: "relative",
                                }}
                                onClick={() => setTab("deployments")}
                                onMouseEnter={() => setTopoHover(depKey)}
                                onMouseLeave={() => setTopoHover(null)}
                                title="Click to view deployments"
                              >
                                <div style={{ display: "flex", "align-items": "center", gap: "6px", "margin-bottom": "6px" }}>
                                  <span style={{ "font-size": "14px" }}>{"\u25A6"}</span>
                                  <span style={{ "font-size": "10px", color: "#3fb950", "text-transform": "uppercase", "letter-spacing": "0.5px", "font-weight": "600" }}>Deployment</span>
                                </div>
                                <div style={{ "font-weight": "600", "font-size": "14px", color: "#e6edf3", "margin-bottom": "6px" }}>{dep.name}</div>
                                <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                                  <span style={{
                                    background: depHealthy ? "#23882e22" : depDegraded ? "#d2992222" : "#f8514922",
                                    color: depHealthy ? "#3fb950" : depDegraded ? "#d29922" : "#f85149",
                                    "font-size": "11px", "font-weight": "600",
                                    padding: "2px 8px", "border-radius": "10px",
                                  }}>
                                    {dep.replicas_ready}/{dep.replicas_desired} ready
                                  </span>
                                  <Show when={dep.replicas_desired > 1}>
                                    <span style={{
                                      background: "#30363d", color: "#8b949e",
                                      "font-size": "10px", padding: "2px 6px", "border-radius": "8px",
                                    }}>
                                      {dep.replicas_desired} replicas
                                    </span>
                                  </Show>
                                </div>
                              </div>

                              <Show when={depPods().length > 0}>
                                <svg width="40" height="100%" style={{ "min-height": "40px", "align-self": "center", flex: "0 0 40px" }}>
                                  <line x1="0" y1="50%" x2="40" y2="50%" stroke="#30363d" stroke-width="2" stroke-dasharray="4 3" />
                                  <circle cx="38" cy="50%" r="3" fill="#3fb950" />
                                </svg>
                                <div style={{ display: "flex", "flex-direction": "column", gap: "6px", "justify-content": "center" }}>
                                  <For each={depPods()}>
                                    {(pod) => {
                                      const podKey = `pod-${pod.name}`;
                                      const podBorder = pod.status === "Running" ? "#2d4a2d" : pod.status === "Pending" ? "#5c4a1e" : pod.status === "Failed" ? "#5c1e1e" : "#30363d";
                                      const metrics = () => podMetrics()[pod.name];
                                      return (
                                        <div
                                          style={{
                                            background: "#161b22",
                                            border: `2px solid ${isHighlighted(podKey) || isHighlighted(depKey) || isHighlighted(svcKey) ? podStatusColor(pod.status) : podBorder}`,
                                            "border-radius": "8px", padding: "10px 14px",
                                            "min-width": "220px", cursor: "pointer",
                                            transition: "border-color 0.2s, box-shadow 0.2s, transform 0.15s",
                                            transform: isHighlighted(podKey) ? "scale(1.03)" : "scale(1)",
                                          }}
                                          onClick={() => setTab("pods")}
                                          onMouseEnter={() => setTopoHover(podKey)}
                                          onMouseLeave={() => setTopoHover(null)}
                                          title="Click to view pods"
                                        >
                                          <div style={{ display: "flex", "align-items": "center", gap: "6px", "margin-bottom": "4px" }}>
                                            <span style={{
                                              width: "8px", height: "8px", "border-radius": "50%",
                                              background: podStatusColor(pod.status),
                                              "box-shadow": `0 0 6px ${podStatusColor(pod.status)}`,
                                            }} />
                                            <span style={{ "font-size": "12px", color: "#e6edf3", "font-weight": "600" }}>
                                              {pod.name.length > 35 ? pod.name.slice(0, 33) + ".." : pod.name}
                                            </span>
                                          </div>
                                          <div style={{ display: "flex", gap: "8px", "padding-left": "14px", "font-size": "10px", color: "#8b949e" }}>
                                            <span>{pod.status}</span>
                                            <span>{pod.ready}</span>
                                            <Show when={pod.restarts > 0}>
                                              <span style={{ color: pod.restarts > 5 ? "#f85149" : "#d29922" }}>{pod.restarts} restarts</span>
                                            </Show>
                                          </div>
                                          <Show when={metrics()}>
                                            <div style={{ display: "flex", gap: "10px", "padding-left": "14px", "margin-top": "4px" }}>
                                              <span style={{ "font-size": "10px", color: "#58a6ff", "font-family": "'JetBrains Mono NF', monospace" }}>
                                                CPU: {metrics()!.cpu}
                                              </span>
                                              <span style={{ "font-size": "10px", color: "#bc8cff", "font-family": "'JetBrains Mono NF', monospace" }}>
                                                Mem: {metrics()!.memory}
                                              </span>
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
                        }}
                      </For>
                    </div>
                  );
                }}
              </For>

              {/* Deployments without a matching service */}
              <For each={deployments().filter((d) => !services().some((s) => s.name.includes(d.name) || d.name.includes(s.name)))}>
                {(dep) => {
                  const depPods = () => pods().filter((p) => p.name.startsWith(dep.name));
                  const depKey = `dep-${dep.name}`;
                  const depHealthy = dep.replicas_ready === dep.replicas_desired && dep.replicas_desired > 0;
                  const depDegraded = dep.replicas_ready > 0 && dep.replicas_ready < dep.replicas_desired;
                  const depBorderColor = depHealthy ? "#2d4a2d" : depDegraded ? "#5c4a1e" : "#5c1e1e";
                  return (
                    <div style={{
                      display: "flex", "align-items": "stretch", gap: "0",
                      "margin-bottom": "20px", "flex-wrap": "wrap",
                    }}>
                      <div
                        style={{
                          background: "#1f2a1f",
                          border: `2px solid ${topoHover() === depKey ? (depHealthy ? "#3fb950" : depDegraded ? "#d29922" : "#f85149") : depBorderColor}`,
                          "border-radius": "10px", padding: "14px 18px",
                          "min-width": "200px", cursor: "pointer",
                          transition: "border-color 0.2s, box-shadow 0.2s, transform 0.15s",
                          transform: topoHover() === depKey ? "scale(1.02)" : "scale(1)",
                          position: "relative",
                        }}
                        onClick={() => setTab("deployments")}
                        onMouseEnter={() => setTopoHover(depKey)}
                        onMouseLeave={() => setTopoHover(null)}
                      >
                        <div style={{ display: "flex", "align-items": "center", gap: "6px", "margin-bottom": "6px" }}>
                          <span style={{ "font-size": "14px" }}>{"\u25A6"}</span>
                          <span style={{ "font-size": "10px", color: "#3fb950", "text-transform": "uppercase", "letter-spacing": "0.5px", "font-weight": "600" }}>Deployment</span>
                        </div>
                        <div style={{ "font-weight": "600", "font-size": "14px", color: "#e6edf3", "margin-bottom": "6px" }}>{dep.name}</div>
                        <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                          <span style={{
                            background: depHealthy ? "#23882e22" : depDegraded ? "#d2992222" : "#f8514922",
                            color: depHealthy ? "#3fb950" : depDegraded ? "#d29922" : "#f85149",
                            "font-size": "11px", "font-weight": "600",
                            padding: "2px 8px", "border-radius": "10px",
                          }}>
                            {dep.replicas_ready}/{dep.replicas_desired} ready
                          </span>
                          <Show when={dep.replicas_desired > 1}>
                            <span style={{
                              background: "#30363d", color: "#8b949e",
                              "font-size": "10px", padding: "2px 6px", "border-radius": "8px",
                            }}>
                              {dep.replicas_desired} replicas
                            </span>
                          </Show>
                        </div>
                      </div>

                      <Show when={depPods().length > 0}>
                        <svg width="40" height="100%" style={{ "min-height": "40px", "align-self": "center", flex: "0 0 40px" }}>
                          <line x1="0" y1="50%" x2="40" y2="50%" stroke="#30363d" stroke-width="2" stroke-dasharray="4 3" />
                          <circle cx="38" cy="50%" r="3" fill="#3fb950" />
                        </svg>
                        <div style={{ display: "flex", "flex-direction": "column", gap: "6px", "justify-content": "center" }}>
                          <For each={depPods()}>
                            {(pod) => {
                              const podKey = `pod-${pod.name}`;
                              const podBorder = pod.status === "Running" ? "#2d4a2d" : pod.status === "Pending" ? "#5c4a1e" : pod.status === "Failed" ? "#5c1e1e" : "#30363d";
                              const metrics = () => podMetrics()[pod.name];
                              return (
                                <div
                                  style={{
                                    background: "#161b22",
                                    border: `2px solid ${topoHover() === podKey || topoHover() === depKey ? podStatusColor(pod.status) : podBorder}`,
                                    "border-radius": "8px", padding: "10px 14px",
                                    "min-width": "220px", cursor: "pointer",
                                    transition: "border-color 0.2s, box-shadow 0.2s, transform 0.15s",
                                    transform: topoHover() === podKey ? "scale(1.03)" : "scale(1)",
                                  }}
                                  onClick={() => setTab("pods")}
                                  onMouseEnter={() => setTopoHover(podKey)}
                                  onMouseLeave={() => setTopoHover(null)}
                                >
                                  <div style={{ display: "flex", "align-items": "center", gap: "6px", "margin-bottom": "4px" }}>
                                    <span style={{
                                      width: "8px", height: "8px", "border-radius": "50%",
                                      background: podStatusColor(pod.status),
                                      "box-shadow": `0 0 6px ${podStatusColor(pod.status)}`,
                                    }} />
                                    <span style={{ "font-size": "12px", color: "#e6edf3", "font-weight": "600" }}>
                                      {pod.name.length > 35 ? pod.name.slice(0, 33) + ".." : pod.name}
                                    </span>
                                  </div>
                                  <div style={{ display: "flex", gap: "8px", "padding-left": "14px", "font-size": "10px", color: "#8b949e" }}>
                                    <span>{pod.status}</span>
                                    <span>{pod.ready}</span>
                                    <Show when={pod.restarts > 0}>
                                      <span style={{ color: pod.restarts > 5 ? "#f85149" : "#d29922" }}>{pod.restarts} restarts</span>
                                    </Show>
                                  </div>
                                  <Show when={metrics()}>
                                    <div style={{ display: "flex", gap: "10px", "padding-left": "14px", "margin-top": "4px" }}>
                                      <span style={{ "font-size": "10px", color: "#58a6ff", "font-family": "'JetBrains Mono NF', monospace" }}>
                                        CPU: {metrics()!.cpu}
                                      </span>
                                      <span style={{ "font-size": "10px", color: "#bc8cff", "font-family": "'JetBrains Mono NF', monospace" }}>
                                        Mem: {metrics()!.memory}
                                      </span>
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
                }}
              </For>

              {/* Orphan pods (not matching any deployment) */}
              {(() => {
                const depNames = deployments().map((d) => d.name);
                const orphanPods = pods().filter((p) => !depNames.some((dn) => p.name.startsWith(dn)));
                return (
                  <Show when={orphanPods.length > 0}>
                    <div style={{ "margin-top": "12px" }}>
                      <div style={{ "font-size": "11px", color: "#8b949e", "margin-bottom": "10px", "text-transform": "uppercase", "letter-spacing": "0.5px", "font-weight": "600" }}>Standalone Pods</div>
                      <div style={{ display: "flex", gap: "10px", "flex-wrap": "wrap" }}>
                        <For each={orphanPods}>
                          {(pod) => {
                            const podKey = `pod-${pod.name}`;
                            const podBorder = pod.status === "Running" ? "#2d4a2d" : pod.status === "Pending" ? "#5c4a1e" : pod.status === "Failed" ? "#5c1e1e" : "#30363d";
                            const metrics = () => podMetrics()[pod.name];
                            return (
                              <div
                                style={{
                                  background: "#161b22",
                                  border: `2px solid ${topoHover() === podKey ? podStatusColor(pod.status) : podBorder}`,
                                  "border-radius": "8px", padding: "10px 14px",
                                  "min-width": "200px", cursor: "pointer",
                                  transition: "border-color 0.2s, box-shadow 0.2s, transform 0.15s",
                                  transform: topoHover() === podKey ? "scale(1.03)" : "scale(1)",
                                }}
                                onClick={() => setTab("pods")}
                                onMouseEnter={() => setTopoHover(podKey)}
                                onMouseLeave={() => setTopoHover(null)}
                              >
                                <div style={{ display: "flex", "align-items": "center", gap: "6px", "margin-bottom": "4px" }}>
                                  <span style={{
                                    width: "8px", height: "8px", "border-radius": "50%",
                                    background: podStatusColor(pod.status),
                                    "box-shadow": `0 0 6px ${podStatusColor(pod.status)}`,
                                  }} />
                                  <span style={{ "font-size": "12px", color: "#e6edf3", "font-weight": "600" }}>{pod.name}</span>
                                </div>
                                <div style={{ display: "flex", gap: "8px", "padding-left": "14px", "font-size": "10px", color: "#8b949e" }}>
                                  <span>{pod.status}</span>
                                  <span>{pod.ready}</span>
                                  <Show when={pod.restarts > 0}>
                                    <span style={{ color: pod.restarts > 5 ? "#f85149" : "#d29922" }}>{pod.restarts} restarts</span>
                                  </Show>
                                </div>
                                <Show when={metrics()}>
                                  <div style={{ display: "flex", gap: "10px", "padding-left": "14px", "margin-top": "4px" }}>
                                    <span style={{ "font-size": "10px", color: "#58a6ff", "font-family": "'JetBrains Mono NF', monospace" }}>
                                      CPU: {metrics()!.cpu}
                                    </span>
                                    <span style={{ "font-size": "10px", color: "#bc8cff", "font-family": "'JetBrains Mono NF', monospace" }}>
                                      Mem: {metrics()!.memory}
                                    </span>
                                  </div>
                                </Show>
                              </div>
                            );
                          }}
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

      {/* Helm Install Modal */}
      <Show when={helmInstallOpen()}>
        <div class="modal-overlay"
          onMouseDown={(e) => { (e.currentTarget as any).__mdTarget = e.target; }}
          onClick={(e) => { if ((e.currentTarget as any).__mdTarget === e.target && (e.target as HTMLElement).classList.contains("modal-overlay")) setHelmInstallOpen(false); }}>
          <div class="modal-dialog" style={{ "max-width": "520px" }}>
            <div class="modal-header">
              <span class="modal-title">Install Helm Chart</span>
              <button class="modal-close" onClick={() => setHelmInstallOpen(false)}>{"\u00d7"}</button>
            </div>
            <div style={{ padding: "16px", display: "flex", "flex-direction": "column", gap: "14px" }}>
              <div class="form-group">
                <label class="form-label">Release Name</label>
                <input
                  class="form-input"
                  type="text"
                  placeholder="my-release"
                  value={helmReleaseName()}
                  onInput={(e) => setHelmReleaseName(e.currentTarget.value)}
                  style={{ width: "100%" }}
                />
              </div>
              <div class="form-group">
                <label class="form-label">Chart</label>
                <input
                  class="form-input"
                  type="text"
                  placeholder="bitnami/nginx"
                  value={helmChartName()}
                  onInput={(e) => setHelmChartName(e.currentTarget.value)}
                  style={{ width: "100%" }}
                />
                <span class="form-hint">e.g. bitnami/nginx, ingress-nginx/ingress-nginx</span>
              </div>
              <div class="form-group">
                <label class="form-label">Namespace</label>
                <Dropdown
                  options={namespaces().map((n) => ({ value: n.name, label: n.name }))}
                  value={helmInstallNs()}
                  onChange={(v) => setHelmInstallNs(v)}
                  placeholder="Select namespace"
                  style={{ width: "100%" }}
                />
              </div>
              <div>
                <label class="form-label">
                  Set Values <span style={{ color: "#6e7681", "font-weight": "400" }}>(optional)</span>
                </label>
                <For each={helmSetValues()}>
                  {(entry, i) => (
                    <div style={{ display: "flex", gap: "6px", "margin-bottom": "6px", "align-items": "center" }}>
                      <input
                        class="form-input"
                        type="text"
                        placeholder="key"
                        value={entry.key}
                        onInput={(e) => {
                          const vals = [...helmSetValues()];
                          vals[i()] = { ...vals[i()], key: e.currentTarget.value };
                          setHelmSetValues(vals);
                        }}
                        style={{ flex: "1" }}
                      />
                      <span style={{ color: "#6e7681" }}>=</span>
                      <input
                        class="form-input"
                        type="text"
                        placeholder="value"
                        value={entry.value}
                        onInput={(e) => {
                          const vals = [...helmSetValues()];
                          vals[i()] = { ...vals[i()], value: e.currentTarget.value };
                          setHelmSetValues(vals);
                        }}
                        style={{ flex: "1" }}
                      />
                      <button
                        class="action-icon action-icon-delete"
                        onClick={() => {
                          const vals = [...helmSetValues()];
                          vals.splice(i(), 1);
                          setHelmSetValues(vals);
                        }}
                        title="Remove"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                      </button>
                    </div>
                  )}
                </For>
                <button
                  class="btn btn-sm"
                  style={{ "font-size": "12px" }}
                  onClick={() => setHelmSetValues([...helmSetValues(), { key: "", value: "" }])}
                >
                  + Add Value
                </button>
              </div>
              <div style={{ "font-size": "11px", color: "#6e7681", background: "#0d1117", padding: "8px 10px", "border-radius": "6px", border: "1px solid #21262d" }}>
                Add chart repos first, e.g.:<br />
                <code style={{ "font-size": "11px" }}>helm repo add bitnami https://charts.bitnami.com/bitnami</code>
              </div>
            </div>
            <div class="modal-footer">
              <button class="btn" onClick={() => setHelmInstallOpen(false)}>Cancel</button>
              <button class="btn btn-primary" onClick={handleHelmInstall} disabled={helmInstalling()}>
                {helmInstalling() ? "Installing..." : "Install"}
              </button>
            </div>
          </div>
        </div>
      </Show>

      {/* Rollback History Modal */}
      <Show when={rollbackDep()}>
        <div class="modal-overlay"
          onMouseDown={(e) => { (e.currentTarget as any).__mdTarget = e.target; }}
          onClick={(e) => { if ((e.currentTarget as any).__mdTarget === e.target && (e.target as HTMLElement).classList.contains("modal-overlay")) setRollbackDep(null); }}>
          <div class="modal-dialog" style={{ "max-width": "500px" }}>
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
                        <th />
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
        <div class="modal-overlay"
          onMouseDown={(e) => { (e.currentTarget as any).__mdTarget = e.target; }}
          onClick={(e) => { if ((e.currentTarget as any).__mdTarget === e.target && (e.target as HTMLElement).classList.contains("modal-overlay")) setPortDialogSvc(null); }}>
          <div class="modal-dialog" style={{ "max-width": "420px" }}>
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
                          rel="noopener noreferrer"
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
                      // Start polling. Stop escalating tail / polling
                      // forever once the pod disappears — otherwise we
                      // spin requesting the backlog of a dead pod.
                      const podName = logPod();
                      const ns = selectedNs();
                      let emptyStreak = 0;
                      const EMPTY_STREAK_LIMIT = 5;
                      const poll = async () => {
                        try {
                          setLogTail((t) => Math.min(t + 100, 5000));
                          const lines = (await invoke("k8s_pod_logs", {
                            namespace: ns, name: podName, container: null, tail: logTail(),
                          })) as string[];
                          if (!lines || lines.length === 0) {
                            emptyStreak++;
                          } else {
                            if (emptyStreak > 0) {
                              // Pod is producing output again — reset
                              // tail so we don't keep requesting a huge
                              // backlog every tick.
                              setLogTail(100);
                            }
                            emptyStreak = 0;
                            setLogLines(lines);
                            if (logContainerRef) logContainerRef.scrollTop = logContainerRef.scrollHeight;
                          }
                        } catch (e) {
                          // 404 / pod-gone / kubectl error counts toward
                          // the streak too.
                          const msg = String(e || "");
                          if (msg.includes("404") || msg.toLowerCase().includes("not found")) {
                            emptyStreak += EMPTY_STREAK_LIMIT; // fast-fail
                          } else {
                            emptyStreak++;
                          }
                        }
                        if (emptyStreak >= EMPTY_STREAK_LIMIT) {
                          if (logFollowInterval) { clearInterval(logFollowInterval); logFollowInterval = null; }
                          setLogFollow(false);
                          showToast("Pod no longer available — stopped following logs", "info");
                        }
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
            <div ref={logContainerRef} class="selectable" style={{
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
        <div class="modal-overlay"
          onMouseDown={(e) => { (e.currentTarget as any).__mdTarget = e.target; }}
          onClick={(e) => { if ((e.currentTarget as any).__mdTarget === e.target && (e.target as HTMLElement).classList.contains("modal-overlay")) setScaleTarget(null); }}>
          <div class="modal-dialog" style={{ "max-width": "340px" }}>
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
        <div class="modal-overlay"
          onMouseDown={(e) => { (e.currentTarget as any).__mdTarget = e.target; }}
          onClick={(e) => { if ((e.currentTarget as any).__mdTarget === e.target && (e.target as HTMLElement).classList.contains("modal-overlay")) setYamlResource(null); }}>
          <div class="modal-dialog" style={{ width: "1000px", "max-width": "92vw", height: "85vh", display: "flex", "flex-direction": "column", background: "#1a1b26" }}>
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
        <div class="modal-overlay"
          onMouseDown={(e) => { (e.currentTarget as any).__mdTarget = e.target; }}
          onClick={(e) => { if ((e.currentTarget as any).__mdTarget === e.target && (e.target as HTMLElement).classList.contains("modal-overlay")) setDeployYamlOpen(false); }}>
          <div class="modal-dialog" style={{ width: "1000px", "max-width": "92vw", height: "85vh", display: "flex", "flex-direction": "column", background: "#1a1b26" }}>
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
        <div class="modal-overlay"
          onMouseDown={(e) => { (e.currentTarget as any).__mdTarget = e.target; }}
          onClick={(e) => { if ((e.currentTarget as any).__mdTarget === e.target && (e.target as HTMLElement).classList.contains("modal-overlay")) setCreateNsOpen(false); }}>
          <div class="modal-dialog" style={{ "max-width": "400px" }}>
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

      {/* Pod Shell Terminal Modal */}
      <Show when={shellPod()}>
        <div class="modal-overlay"
          onMouseDown={(e) => { (e.currentTarget as any).__mdTarget = e.target; }}
          onClick={(e) => { if ((e.currentTarget as any).__mdTarget === e.target && (e.target as HTMLElement).classList.contains("modal-overlay")) setShellPod(null); }}>
          <div class="modal-dialog" style={{ width: "800px", height: "600px", "max-width": "90vw", "max-height": "85vh", display: "flex", "flex-direction": "column" }}>
            <div class="modal-header">
              <span class="modal-title">Terminal: {shellPod()!.name}</span>
              <button class="modal-close" onClick={() => setShellPod(null)}>{"\u00d7"}</button>
            </div>
            <div style={{ flex: "1", "min-height": "0" }}>
              <K8sTerminal podName={shellPod()!.name} namespace={shellPod()!.namespace} />
            </div>
          </div>
        </div>
      </Show>

      {/* ConfigMap Viewer Modal */}
      <Show when={viewConfigMap()}>
        <div class="modal-overlay"
          onMouseDown={(e) => { (e.currentTarget as any).__mdTarget = e.target; }}
          onClick={(e) => { if ((e.currentTarget as any).__mdTarget === e.target && (e.target as HTMLElement).classList.contains("modal-overlay")) setViewConfigMap(null); }}>
          <div class="modal-dialog" style={{ width: "700px", "max-width": "90vw", "max-height": "80vh", display: "flex", "flex-direction": "column" }}>
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
        <div class="modal-overlay"
          onMouseDown={(e) => { (e.currentTarget as any).__mdTarget = e.target; }}
          onClick={(e) => { if ((e.currentTarget as any).__mdTarget === e.target && (e.target as HTMLElement).classList.contains("modal-overlay")) setViewSecret(null); }}>
          <div class="modal-dialog" style={{ width: "700px", "max-width": "90vw", "max-height": "80vh", display: "flex", "flex-direction": "column" }}>
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

      {/* Create Ingress Dialog */}
      <Show when={createIngressOpen()}>
        <div class="modal-overlay"
          onMouseDown={(e) => { (e.currentTarget as any).__mdTarget = e.target; }}
          onClick={(e) => { if ((e.currentTarget as any).__mdTarget === e.target && (e.target as HTMLElement).classList.contains("modal-overlay")) setCreateIngressOpen(false); }}>
          <div class="modal-dialog" style={{ "max-width": "520px" }}>
            <div class="modal-header">
              <span class="modal-title">Create Ingress</span>
              <button class="modal-close" onClick={() => setCreateIngressOpen(false)}>{"\u00d7"}</button>
            </div>
            <div style={{ padding: "16px", display: "flex", "flex-direction": "column", gap: "14px" }}>
              <div>
                <label style={{ "font-size": "12px", color: "#8b949e", display: "block", "margin-bottom": "4px" }}>Ingress Name</label>
                <input
                  type="text"
                  class="form-input"
                  placeholder="my-app-ingress"
                  value={ingressName()}
                  onInput={(e) => setIngressName(e.currentTarget.value)}
                  style={{ width: "100%" }}
                  ref={(el) => setTimeout(() => el.focus(), 50)}
                />
              </div>
              <div>
                <label style={{ "font-size": "12px", color: "#8b949e", display: "block", "margin-bottom": "4px" }}>Hostname</label>
                <input
                  type="text"
                  class="form-input"
                  placeholder="myapp.local"
                  value={ingressHostname()}
                  onInput={(e) => setIngressHostname(e.currentTarget.value)}
                  style={{ width: "100%" }}
                />
              </div>
              <div style={{ display: "flex", gap: "12px" }}>
                <div style={{ flex: "1" }}>
                  <label style={{ "font-size": "12px", color: "#8b949e", display: "block", "margin-bottom": "4px" }}>Service</label>
                  <Dropdown
                    value={ingressServiceName()}
                    options={ingressServices().map((s) => ({ value: s.name, label: s.name }))}
                    onChange={(v) => {
                      setIngressServiceName(v);
                      // Auto-select first port of the chosen service
                      const svc = ingressServices().find((s) => s.name === v);
                      if (svc && svc.ports.length > 0) {
                        setIngressServicePort(String(svc.ports[0].port));
                      } else {
                        setIngressServicePort("");
                      }
                    }}
                    placeholder="Select service..."
                    style={{ width: "100%" }}
                  />
                </div>
                <div style={{ "min-width": "120px" }}>
                  <label style={{ "font-size": "12px", color: "#8b949e", display: "block", "margin-bottom": "4px" }}>Port</label>
                  <Dropdown
                    value={ingressServicePort()}
                    options={(() => {
                      const svc = ingressServices().find((s) => s.name === ingressServiceName());
                      if (!svc) return [];
                      return svc.ports.map((p) => ({
                        value: String(p.port),
                        label: p.name ? `${p.port} (${p.name})` : String(p.port),
                      }));
                    })()}
                    onChange={(v) => setIngressServicePort(v)}
                    placeholder="Port"
                    style={{ width: "100%" }}
                  />
                </div>
              </div>
              <div style={{ display: "flex", gap: "12px" }}>
                <div style={{ flex: "1" }}>
                  <label style={{ "font-size": "12px", color: "#8b949e", display: "block", "margin-bottom": "4px" }}>Path</label>
                  <input
                    type="text"
                    class="form-input"
                    placeholder="/"
                    value={ingressPath()}
                    onInput={(e) => setIngressPath(e.currentTarget.value)}
                    style={{ width: "100%" }}
                  />
                </div>
                <div style={{ "min-width": "180px" }}>
                  <label style={{ "font-size": "12px", color: "#8b949e", display: "block", "margin-bottom": "4px" }}>Path Type</label>
                  <Dropdown
                    value={ingressPathType()}
                    options={[
                      { value: "Prefix", label: "Prefix" },
                      { value: "Exact", label: "Exact" },
                      { value: "ImplementationSpecific", label: "ImplementationSpecific" },
                    ]}
                    onChange={(v) => setIngressPathType(v)}
                    style={{ width: "100%" }}
                  />
                </div>
              </div>
              <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                <input
                  type="checkbox"
                  id="ingress-tls"
                  checked={ingressTls()}
                  onChange={(e) => setIngressTls(e.currentTarget.checked)}
                />
                <label for="ingress-tls" style={{ "font-size": "12px", color: "#c9d1d9", cursor: "pointer" }}>
                  Enable TLS
                </label>
                <Show when={ingressTls() && ingressHostname().trim()}>
                  <span style={{ "font-size": "11px", color: "#8b949e" }}>
                    (secret: {ingressHostname().trim()}-tls)
                  </span>
                </Show>
              </div>
            </div>
            <div class="modal-footer">
              <button class="btn" onClick={() => setCreateIngressOpen(false)}>Cancel</button>
              <button
                class="btn btn-primary"
                onClick={handleCreateIngress}
                disabled={ingressCreating() || !ingressName().trim() || !ingressHostname().trim() || !ingressServiceName() || !ingressServicePort()}
              >
                {ingressCreating() ? "Creating..." : "Create"}
              </button>
            </div>
          </div>
        </div>
      </Show>

      {/* Secret Create/Edit Dialog */}
      <Show when={secretDialogOpen()}>
        <div class="modal-overlay"
          onMouseDown={(e) => { (e.currentTarget as any).__mdTarget = e.target; }}
          onClick={(e) => { if ((e.currentTarget as any).__mdTarget === e.target && (e.target as HTMLElement).classList.contains("modal-overlay")) setSecretDialogOpen(false); }}>
          <div class="modal-dialog" style={{ "max-width": "600px" }}>
            <div class="modal-header">
              <span class="modal-title">{secretDialogMode() === "create" ? "Create Secret" : `Edit Secret: ${secretDialogName()}`}</span>
              <button class="modal-close" onClick={() => setSecretDialogOpen(false)}>{"\u00d7"}</button>
            </div>
            <div style={{ padding: "16px", display: "flex", "flex-direction": "column", gap: "14px", "max-height": "60vh", overflow: "auto" }}>
              <Show when={secretDialogMode() === "create"}>
                <div>
                  <label style={{ "font-size": "12px", color: "#8b949e", display: "block", "margin-bottom": "4px" }}>Name</label>
                  <input
                    type="text"
                    class="form-input"
                    placeholder="my-secret"
                    value={secretDialogName()}
                    onInput={(e) => setSecretDialogName(e.currentTarget.value)}
                    ref={(el) => setTimeout(() => el.focus(), 50)}
                    style={{ width: "100%" }}
                  />
                </div>
                <div>
                  <label style={{ "font-size": "12px", color: "#8b949e", display: "block", "margin-bottom": "4px" }}>Type</label>
                  <Dropdown
                    value={secretDialogType()}
                    onChange={(v) => {
                      setSecretDialogType(v);
                      if (v === "kubernetes.io/tls") {
                        setSecretDialogEntries([{ key: "tls.crt", value: "" }, { key: "tls.key", value: "" }]);
                      } else if (v === "kubernetes.io/dockerconfigjson") {
                        setSecretDialogEntries([{ key: ".dockerconfigjson", value: "" }]);
                      }
                    }}
                    options={[
                      { value: "Opaque", label: "Opaque" },
                      { value: "kubernetes.io/tls", label: "kubernetes.io/tls" },
                      { value: "kubernetes.io/dockerconfigjson", label: "kubernetes.io/dockerconfigjson" },
                    ]}
                    style={{ width: "100%" }}
                  />
                </div>
              </Show>

              <div>
                <label style={{ "font-size": "12px", color: "#8b949e", display: "block", "margin-bottom": "8px" }}>Data Entries</label>
                <Index each={secretDialogEntries()}>
                  {(entry, i) => {
                    const isTls = () => secretDialogType() === "kubernetes.io/tls" && (entry().key === "tls.crt" || entry().key === "tls.key");
                    const isRevealed = () => secretDialogRevealed().has(i);
                    return (
                      <div style={{ display: "flex", gap: "8px", "margin-bottom": "8px", "align-items": "flex-start" }}>
                        <input
                          type="text"
                          class="form-input"
                          placeholder="Key"
                          value={entry().key}
                          onInput={(e) => {
                            const entries = [...secretDialogEntries()];
                            entries[i] = { ...entries[i], key: e.currentTarget.value };
                            setSecretDialogEntries(entries);
                          }}
                          disabled={isTls()}
                          style={{ width: "140px", "flex-shrink": "0" }}
                        />
                        <Show when={isTls()} fallback={
                          <div style={{ flex: "1", position: "relative", display: "flex", gap: "4px" }}>
                            <input
                              type={isRevealed() ? "text" : "password"}
                              class="form-input"
                              placeholder="Value"
                              value={entry().value}
                              onInput={(e) => {
                                const entries = [...secretDialogEntries()];
                                entries[i] = { ...entries[i], value: e.currentTarget.value };
                                setSecretDialogEntries(entries);
                              }}
                              style={{ width: "100%", "padding-right": "32px" }}
                            />
                            <button
                              class="btn btn-sm"
                              style={{ "font-size": "10px", padding: "2px 6px", position: "absolute", right: "4px", top: "50%", transform: "translateY(-50%)" }}
                              onClick={() => {
                                const next = new Set(secretDialogRevealed());
                                if (isRevealed()) next.delete(i); else next.add(i);
                                setSecretDialogRevealed(next);
                              }}
                            >
                              {isRevealed() ? "Hide" : "Show"}
                            </button>
                          </div>
                        }>
                          <textarea
                            class="form-input"
                            placeholder={entry().key === "tls.crt" ? "Paste certificate PEM..." : "Paste private key PEM..."}
                            value={entry().value}
                            onInput={(e) => {
                              const entries = [...secretDialogEntries()];
                              entries[i] = { ...entries[i], value: e.currentTarget.value };
                              setSecretDialogEntries(entries);
                            }}
                            style={{ flex: "1", "min-height": "80px", "font-family": "'JetBrains Mono NF', monospace", "font-size": "11px" }}
                          />
                        </Show>
                        <button
                          class="action-icon action-icon-delete"
                          title="Remove entry"
                          disabled={isTls()}
                          onClick={() => {
                            const entries = secretDialogEntries().filter((_, idx) => idx !== i);
                            setSecretDialogEntries(entries.length > 0 ? entries : [{ key: "", value: "" }]);
                          }}
                          style={{ "margin-top": "6px", opacity: isTls() ? "0.3" : "1" }}
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                        </button>
                      </div>
                    );
                  }}
                </Index>
                <button
                  class="btn btn-sm"
                  style={{ "font-size": "12px" }}
                  onClick={() => setSecretDialogEntries([...secretDialogEntries(), { key: "", value: "" }])}
                >
                  + Add Entry
                </button>
              </div>
            </div>
            <div class="modal-footer">
              <button class="btn" onClick={() => setSecretDialogOpen(false)}>Cancel</button>
              <button
                class="btn btn-primary"
                onClick={handleSaveSecret}
                disabled={secretDialogSaving() || !secretDialogName().trim()}
              >
                {secretDialogSaving() ? "Saving..." : secretDialogMode() === "create" ? "Create" : "Save"}
              </button>
            </div>
          </div>
        </div>
      </Show>

      {/* Create PVC Dialog */}
      <Show when={pvcDialogOpen()}>
        <div class="modal-overlay"
          onMouseDown={(e) => { (e.currentTarget as any).__mdTarget = e.target; }}
          onClick={(e) => { if ((e.currentTarget as any).__mdTarget === e.target && (e.target as HTMLElement).classList.contains("modal-overlay")) setPvcDialogOpen(false); }}>
          <div class="modal-dialog" style={{ "max-width": "480px" }}>
            <div class="modal-header">
              <span class="modal-title">Create Persistent Volume Claim</span>
              <button class="modal-close" onClick={() => setPvcDialogOpen(false)}>{"\u00d7"}</button>
            </div>
            <div style={{ padding: "16px", display: "flex", "flex-direction": "column", gap: "14px" }}>
              <div>
                <label style={{ "font-size": "12px", color: "#8b949e", display: "block", "margin-bottom": "4px" }}>Name</label>
                <input
                  type="text"
                  class="form-input"
                  placeholder="my-pvc"
                  value={pvcName()}
                  onInput={(e) => setPvcName(e.currentTarget.value)}
                  ref={(el) => setTimeout(() => el.focus(), 50)}
                  style={{ width: "100%" }}
                />
              </div>
              <div>
                <label style={{ "font-size": "12px", color: "#8b949e", display: "block", "margin-bottom": "4px" }}>Storage Class</label>
                <input
                  type="text"
                  class="form-input"
                  placeholder="e.g. local-path (k3s default)"
                  value={pvcStorageClass()}
                  onInput={(e) => setPvcStorageClass(e.currentTarget.value)}
                  style={{ width: "100%" }}
                />
                <div style={{ "font-size": "11px", color: "#6e7681", "margin-top": "4px" }}>
                  Common: local-path (k3s), standard (minikube), gp2/gp3 (AWS)
                </div>
              </div>
              <div>
                <label style={{ "font-size": "12px", color: "#8b949e", display: "block", "margin-bottom": "4px" }}>Size</label>
                <div style={{ display: "flex", gap: "8px" }}>
                  <input
                    type="number"
                    class="form-input"
                    min="1"
                    value={pvcSizeValue()}
                    onInput={(e) => setPvcSizeValue(e.currentTarget.value)}
                    style={{ width: "100px" }}
                  />
                  <Dropdown
                    value={pvcSizeUnit()}
                    onChange={setPvcSizeUnit}
                    options={[
                      { value: "Mi", label: "Mi" },
                      { value: "Gi", label: "Gi" },
                      { value: "Ti", label: "Ti" },
                    ]}
                    style={{ width: "80px" }}
                  />
                </div>
              </div>
              <div>
                <label style={{ "font-size": "12px", color: "#8b949e", display: "block", "margin-bottom": "8px" }}>Access Modes</label>
                <For each={["ReadWriteOnce", "ReadOnlyMany", "ReadWriteMany"] as const}>{(mode) => (
                  <label style={{ display: "flex", "align-items": "center", gap: "8px", "margin-bottom": "6px", "font-size": "13px", color: "#c9d1d9", cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={pvcAccessModes().has(mode)}
                      onChange={(e) => {
                        const next = new Set(pvcAccessModes());
                        if (e.currentTarget.checked) next.add(mode); else next.delete(mode);
                        setPvcAccessModes(next);
                      }}
                    />
                    {mode}
                  </label>
                )}</For>
              </div>
            </div>
            <div class="modal-footer">
              <button class="btn" onClick={() => setPvcDialogOpen(false)}>Cancel</button>
              <button
                class="btn btn-primary"
                onClick={handleCreatePvc}
                disabled={pvcCreating() || !pvcName().trim() || !pvcStorageClass().trim()}
              >
                {pvcCreating() ? "Creating..." : "Create"}
              </button>
            </div>
          </div>
        </div>
      </Show>

      {/* Create HPA Dialog */}
      <Show when={hpaDialogOpen()}>
        <div class="modal-overlay"
          onMouseDown={(e) => { (e.currentTarget as any).__mdTarget = e.target; }}
          onClick={(e) => { if ((e.currentTarget as any).__mdTarget === e.target && (e.target as HTMLElement).classList.contains("modal-overlay")) setHpaDialogOpen(false); }}>
          <div class="modal-dialog" style={{ "max-width": "480px" }}>
            <div class="modal-header">
              <span class="modal-title">Create Horizontal Pod Autoscaler</span>
              <button class="modal-close" onClick={() => setHpaDialogOpen(false)}>{"\u00d7"}</button>
            </div>
            <div style={{ padding: "16px", display: "flex", "flex-direction": "column", gap: "14px" }}>
              <div>
                <label style={{ "font-size": "12px", color: "#8b949e", display: "block", "margin-bottom": "4px" }}>Deployment</label>
                <Dropdown
                  value={hpaDeployment()}
                  onChange={setHpaDeployment}
                  options={deployments().map((d) => ({ value: d.name, label: d.name }))}
                  placeholder="Select deployment..."
                  style={{ width: "100%" }}
                />
              </div>
              <div>
                <label style={{ "font-size": "12px", color: "#8b949e", display: "block", "margin-bottom": "4px" }}>HPA Name</label>
                <input
                  type="text"
                  class="form-input"
                  placeholder="my-hpa"
                  value={hpaName()}
                  onInput={(e) => setHpaName(e.currentTarget.value)}
                  style={{ width: "100%" }}
                />
              </div>
              <div style={{ display: "flex", gap: "12px" }}>
                <div style={{ flex: 1 }}>
                  <label style={{ "font-size": "12px", color: "#8b949e", display: "block", "margin-bottom": "4px" }}>Min Replicas</label>
                  <input
                    type="number"
                    class="form-input"
                    min="1"
                    value={hpaMin()}
                    onInput={(e) => setHpaMin(e.currentTarget.value)}
                    style={{ width: "100%" }}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ "font-size": "12px", color: "#8b949e", display: "block", "margin-bottom": "4px" }}>Max Replicas</label>
                  <input
                    type="number"
                    class="form-input"
                    min="1"
                    value={hpaMax()}
                    onInput={(e) => setHpaMax(e.currentTarget.value)}
                    style={{ width: "100%" }}
                  />
                </div>
              </div>
              <div>
                <label style={{ "font-size": "12px", color: "#8b949e", display: "block", "margin-bottom": "4px" }}>CPU Target %</label>
                <input
                  type="number"
                  class="form-input"
                  min="1"
                  max="100"
                  value={hpaCpuTarget()}
                  onInput={(e) => setHpaCpuTarget(e.currentTarget.value)}
                  style={{ width: "120px" }}
                />
                <div style={{ "font-size": "11px", color: "#6e7681", "margin-top": "4px" }}>
                  Average CPU utilization target across all pods (requires metrics-server)
                </div>
              </div>
            </div>
            <div class="modal-footer">
              <button class="btn" onClick={() => setHpaDialogOpen(false)}>Cancel</button>
              <button
                class="btn btn-primary"
                onClick={async () => {
                  if (!hpaDeployment().trim() || !hpaName().trim()) return;
                  setHpaCreating(true);
                  try {
                    await invoke("k8s_create_hpa", {
                      namespace: selectedNs(),
                      name: hpaName().trim(),
                      deployment: hpaDeployment().trim(),
                      min: parseInt(hpaMin()) || 1,
                      max: parseInt(hpaMax()) || 5,
                      cpuTarget: parseInt(hpaCpuTarget()) || 50,
                    });
                    showToast(`Created HPA ${hpaName()}`, "success");
                    setHpaDialogOpen(false);
                    refreshWorkloads();
                  } catch (e) {
                    showToast(`Failed to create HPA: ${e}`, "error");
                  } finally {
                    setHpaCreating(false);
                  }
                }}
                disabled={hpaCreating() || !hpaName().trim() || !hpaDeployment().trim()}
              >
                {hpaCreating() ? "Creating..." : "Create"}
              </button>
            </div>
          </div>
        </div>
      </Show>

      {/* Traefik Info Panel */}
      <Show when={traefikInfoOpen() && traefikService()}>
        <div class="modal-overlay"
          onMouseDown={(e) => { (e.currentTarget as any).__mdTarget = e.target; }}
          onClick={(e) => { if ((e.currentTarget as any).__mdTarget === e.target && (e.target as HTMLElement).classList.contains("modal-overlay")) setTraefikInfoOpen(false); }}>
          <div class="modal-dialog" style={{ "max-width": "480px" }}>
            <div class="modal-header">
              <span class="modal-title">Traefik Ingress Controller</span>
              <button class="modal-close" onClick={() => setTraefikInfoOpen(false)}>{"\u00d7"}</button>
            </div>
            <div style={{ padding: "16px" }}>
              <div style={{ "margin-bottom": "16px" }}>
                <div style={{ "font-size": "12px", color: "#8b949e", "margin-bottom": "8px" }}>Entrypoints</div>
                <table class="table" style={{ "margin-bottom": "0" }}>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Port</th>
                      <th>Protocol</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={traefikService()!.ports}>
                      {(p) => (
                        <tr>
                          <td style={{ "font-weight": "500" }}>
                            {p.name || (p.port === 80 ? "web" : p.port === 443 ? "websecure" : `port-${p.port}`)}
                          </td>
                          <td class="mono">{p.port}{p.node_port ? ` (NodePort: ${p.node_port})` : ""}</td>
                          <td style={{ color: "#8b949e" }}>{p.protocol}</td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
              <div style={{
                padding: "10px 12px",
                background: "rgba(88, 166, 255, 0.06)",
                border: "1px solid rgba(88, 166, 255, 0.15)",
                "border-radius": "6px",
                "font-size": "12px",
                color: "#8b949e",
                "line-height": "1.5",
              }}>
                Traefik is the default ingress controller for k3s. It listens on the entrypoints above
                and routes traffic based on Ingress rules. To add custom entrypoints, edit the Traefik
                HelmChartConfig in the kube-system namespace.
              </div>
            </div>
            <div class="modal-footer">
              <button class="btn" onClick={() => setTraefikInfoOpen(false)}>Close</button>
              <button
                class="btn btn-primary"
                style={{ "font-size": "12px" }}
                onClick={openTraefikDashboard}
                disabled={traefikForwarding()}
              >
                {traefikForwarding() ? "Connecting..." : "Open Dashboard"}
              </button>
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
