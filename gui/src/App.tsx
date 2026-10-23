import { createSignal, createEffect, onMount, onCleanup, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { onOrcaEvent } from "./lib/events";
import { addEvent } from "./lib/activityStore";
import { lazy } from "solid-js";
import { openFolderDialog, openFolderTarget } from "./lib/openFolder";
import { requestWorkspaceJoin } from "./lib/workspace";
const AiWindow = lazy(() => import("./components/AiWindow"));
// Pages load on first visit: together with xterm and CodeMirror they made
// one 1.6 MB bundle that was parsed before the first paint.
const ContainersPage = lazy(() => import("./pages/ContainersPage"));
const ContainerDetailPage = lazy(() => import("./pages/ContainerDetailPage"));
const StackDetailPage = lazy(() => import("./pages/StackDetailPage"));
const ImagesPage = lazy(() => import("./pages/ImagesPage"));
const VolumesPage = lazy(() => import("./pages/VolumesPage"));
const VolumeDetailPage = lazy(() => import("./pages/VolumeDetailPage"));
const NetworksPage = lazy(() => import("./pages/NetworksPage"));
const GatewayPage = lazy(() => import("./pages/GatewayPage"));
const ProjectsPage = lazy(() => import("./pages/ProjectsPage"));
const WorkspacePage = lazy(() => import("./pages/WorkspacePage"));
const KubernetesPage = lazy(() => import("./pages/KubernetesPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const EnvironmentPage = lazy(() => import("./pages/EnvironmentPage"));
const ActivityPage = lazy(() => import("./pages/ActivityPage"));
const FleetPage = lazy(() => import("./pages/FleetPage"));
const TemplatesPage = lazy(() => import("./pages/TemplatesPage"));
const BuildsPage = lazy(() => import("./pages/BuildsPage"));
const ComposeWizard = lazy(() => import("./components/ComposeWizard"));
const OpenFolderDialog = lazy(() => import("./components/OpenFolderDialog"));
import Titlebar from "./components/Titlebar";
import StatusBar from "./components/StatusBar";
import Sidebar from "./components/Sidebar";
import ToastContainer, { showToast } from "./components/Toast";
import ConfirmDialog from "./components/ConfirmDialog";
import DashboardPage from "./pages/DashboardPage";
import ConnectionScreen from "./components/ConnectionScreen";
import ConnectionBanner from "./components/ConnectionBanner";
import CommandPalette from "./components/CommandPalette";
import AiAssistant from "./components/AiAssistant";
import type { AiAssistantApi } from "./components/AiAssistant";
import type { EnvironmentStatus } from "./lib/types";
import KeyboardShortcuts from "./components/KeyboardShortcuts";
import { startPoller, type Poller } from "./lib/poller";

export type Page = "fleet" | "dashboard" | "workspace" | "projects" | "templates" | "containers" | "container-detail" | "stack-detail" | "images" | "builds" | "volumes" | "volume-detail" | "networks" | "gateway" | "kubernetes" | "environment" | "activity" | "settings";

export default function App() {
  // The AI assistant opens this same App in a second webview via a #ai hash.
  // Detect it up front so we can skip every main-window side effect
  // (daemon bootstrap, event subscription, deep-link listener, keyboard
  // shortcuts, fleet polling). If we didn't skip, both webviews would race
  // on `subscribe_events` — the Rust side aborts the previous subscription
  // on each call, so whichever window wins would silently starve the other.
  const isAiWindow = typeof window !== "undefined" && window.location.hash === "#ai";

  const [page, setPage] = createSignal<Page>("dashboard");
  const [detailId, setDetailId] = createSignal<string | null>(null);
  const [daemonStatus, setDaemonStatus] = createSignal<string>("connecting");
  const [breadcrumbStack, setBreadcrumbStack] = createSignal<string | null>(null);
  const [showCommandPalette, setShowCommandPalette] = createSignal(false);
  const [showShortcuts, setShowShortcuts] = createSignal(false);
  const [showComposeWizard, setShowComposeWizard] = createSignal(false);
  const [environmentChecked, setEnvironmentChecked] = createSignal(false);
  const [startupStep, setStartupStep] = createSignal("Starting Orca...");
  let aiApi: AiAssistantApi | undefined;

  // Fleet health polling state
  const lastFleetStatus: Record<string, boolean> = {};
  const fleetStatusCount: Record<string, number> = {};
  let fleetPoller: Poller | null = null;

  const pollFleetHealth = async () => {
    try {
      const hosts = (await invoke("probe_all_hosts")) as Array<{
        id: string | null;
        name: string;
        online: boolean;
        version: string | null;
      }>;
      // Only alert if there are remote hosts configured
      const hasRemotes = hosts.some((h) => h.id !== null);
      if (!hasRemotes) return;

      for (const host of hosts) {
        const key = host.id || "__local__";
        if (key in lastFleetStatus && lastFleetStatus[key] !== host.online) {
          // State changed — require 2 consecutive polls in the new state before alerting
          fleetStatusCount[key] = (fleetStatusCount[key] || 0) + 1;
          if (fleetStatusCount[key] >= 2) {
            if (host.online) {
              showToast(`${host.name} is back online`, "success");
            } else {
              showToast(`${host.name} is offline`, "error");
            }
            fleetStatusCount[key] = 0;
            lastFleetStatus[key] = host.online;
          }
        } else {
          fleetStatusCount[key] = 0;
          lastFleetStatus[key] = host.online;
        }
      }
    } catch {
      // Fleet polling failed silently — daemon may not support probe_all_hosts yet
    }
  };

  const checkDaemon = async () => {
    try {
      const status = (await invoke("get_status")) as any;
      setDaemonStatus(status.daemon_running ? "running" : "stopped");
    } catch {
      setDaemonStatus("disconnected");
    }
  };

  // While the UI is up, a lost daemon shows as "reconnecting" (banner, page
  // stays mounted) so short gaps — a deliberate restart, the app's watchdog
  // restarting a crashed daemon — don't throw the user out. Only after
  // RECONNECT_GRACE failed checks does it become "stopped" and show the
  // connection screen. This only reports: restarting is the watchdog's job
  // (src-tauri/src/daemon.rs).
  const RECONNECT_GRACE = 10; // × 3 s
  let failedChecks = 0;
  const watchDaemon = async () => {
    let up = false;
    try {
      up = ((await invoke("get_status")) as any).daemon_running === true;
    } catch {}
    if (up) {
      failedChecks = 0;
      if (daemonStatus() !== "running") setDaemonStatus("running");
      return;
    }
    failedChecks++;
    const s = daemonStatus();
    if (s === "running" || s === "reconnecting") {
      setDaemonStatus(failedChecks >= RECONNECT_GRACE ? "stopped" : "reconnecting");
    } else if (s !== "connecting") {
      setDaemonStatus("stopped");
    }
  };

  const isInEditableTarget = (e: KeyboardEvent): boolean => {
    const el = e.target as HTMLElement | null;
    if (!el) return false;
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return true;
    if (el.isContentEditable) return true;
    // xterm.js terminals absorb keyboard input inside `.xterm` — treat as
    // editable so our shortcuts don't fight with the shell.
    if (el.closest?.(".xterm, .cm-editor")) return true;
    return false;
  };

  const handleGlobalKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      const overlay = document.querySelector(".modal-overlay") as HTMLElement | null;
      if (overlay) {
        const closeBtn = overlay.querySelector(".modal-close") as HTMLElement | null;
        if (closeBtn) closeBtn.click();
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "k") {
      e.preventDefault();
      setShowCommandPalette((v) => !v);
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "r") {
      if (isInEditableTarget(e)) return;
      e.preventDefault();
      document.dispatchEvent(new CustomEvent("orca-refresh"));
    }
    if (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (isInEditableTarget(e)) return;
      e.preventDefault();
      setShowShortcuts((v) => !v);
    }
  };

  let dockerConnectedAtStart = false;
  const checkEnvironment = async () => {
    if (environmentChecked()) return;
    // The daemon already reached Docker, so the environment is fine: skip
    // the full check (it runs `docker info` and `limactl`) and show the app.
    // The System Health page still runs it.
    if (dockerConnectedAtStart) {
      setEnvironmentChecked(true);
      return;
    }
    setStartupStep("Checking environment...");

    // Timeout: if env check takes >15s, show the environment page anyway
    const timeout = setTimeout(() => {
      if (!environmentChecked()) {
        setStartupStep("Taking longer than expected...");
        setTimeout(() => {
          if (!environmentChecked()) {
            setEnvironmentChecked(true);
            setPage("environment");
          }
        }, 3000);
      }
    }, 15000);

    try {
      const envStatus = (await invoke("env_status")) as EnvironmentStatus;
      clearTimeout(timeout);
      setEnvironmentChecked(true);
      if (!envStatus.ready) {
        setPage("environment");
      } else {
        // Environment says ready, but check if daemon can actually reach Docker
        setStartupStep("Verifying Docker connection...");
        try {
          const health = (await invoke("system_health")) as any;
          if (!health?.docker_connected) {
            setPage("environment");
          }
        } catch {}
      }
    } catch {
      clearTimeout(timeout);
      // Daemon couldn't check environment — still show the app
      // The environment page will handle the error state
      setEnvironmentChecked(true);
      setPage("environment");
    }
  };

  const handleDeepLink = async (url: string) => {
    // Parse orca:// and docker-desktop:// URLs and navigate accordingly
    if (url.startsWith("docker-desktop://")) {
      try {
        const intercept = await invoke("get_intercept_docker_urls") as boolean;
        if (!intercept) return;
      } catch {
        return;
      }
    }
    try {
      const normalizedUrl = url.replace(/^docker-desktop:\/\//, "orca://");
      const parsed = new URL(normalizedUrl);
      const host = parsed.hostname;
      const pathParts = parsed.pathname.split("/").filter(Boolean);

      switch (host) {
        case "dashboard":
          // docker-desktop://dashboard/build/... → images page
          if (pathParts[0] === "build") {
            navigate("images");
          } else {
            navigate("dashboard");
          }
          break;
        case "containers":
          navigate("containers");
          break;
        case "container":
          if (pathParts.length > 0) {
            navigate(`container:${pathParts.join("/")}`);
          } else {
            navigate("containers");
          }
          break;
        case "build":
          // orca://build/{context}/{id} -> navigate to images page
          navigate("images");
          break;
        case "images":
          navigate("images");
          break;
        case "volumes":
          navigate("volumes");
          break;
        case "networks":
          navigate("networks");
          break;
        case "gateway":
          navigate("gateway");
          break;
        case "projects":
          navigate("projects");
          break;
        case "workspace": {
          // orca://workspace?repo=<git url>: the link a team puts in its wiki.
          const repo = parsed.searchParams.get("repo");
          if (repo) requestWorkspaceJoin(repo);
          navigate("workspace");
          break;
        }
        case "kubernetes":
          navigate("kubernetes");
          break;
        case "settings":
          if (pathParts.length > 0) {
            navigate(`settings:${pathParts[0]}`);
          } else {
            navigate("settings");
          }
          break;
        case "fleet":
          navigate("fleet");
          break;
        case "templates":
          navigate("templates");
          break;
        case "environment":
          navigate("environment");
          break;
        case "activity":
          navigate("activity");
          break;
        default:
          console.warn("Unknown deep link path:", url);
          break;
      }
    } catch (e) {
      console.error("Failed to parse deep link URL:", url, e);
    }
  };

  const navigate = (target: string) => {
    if (target.startsWith("container:") && target.includes(",stack:")) {
      const [containerPart, stackPart] = target.split(",stack:");
      setDetailId(containerPart.replace("container:", ""));
      setBreadcrumbStack(stackPart);
      setPage("container-detail");
    } else if (target.startsWith("container:")) {
      setDetailId(target.split(":").slice(1).join(":"));
      setBreadcrumbStack(null);
      setPage("container-detail");
    } else if (target.startsWith("volume:")) {
      setDetailId(target.split(":").slice(1).join(":"));
      setBreadcrumbStack(null);
      setPage("volume-detail");
    } else if (target.startsWith("stack:")) {
      setDetailId(target.split(":").slice(1).join(":"));
      setBreadcrumbStack(null);
      setPage("stack-detail");
    } else if (target === "images:pull") {
      setDetailId("pull"); // Signal to ImagesPage to open pull dialog
      setPage("images");
    } else if (target === "open-folder") {
      openFolderDialog();
    } else if (target === "compose:wizard") {
      setShowComposeWizard(true);
    } else if (target.startsWith("settings:")) {
      setDetailId(target.split(":")[1]); // Signal to SettingsPage which tab to open
      setPage("settings");
    } else {
      setDetailId(null);
      setBreadcrumbStack(null);
      setPage(target as Page);
    }
  };

  // React to daemon status changes. On every rising edge from not-running
  // to running, (re)start the event subscription so the UI doesn't go
  // silent after a daemon restart.
  let prevDaemonStatus: string | null = null;
  createEffect(() => {
    if (isAiWindow) return; // AI window doesn't manage daemon/events
    const status = daemonStatus();
    const wasRunning = prevDaemonStatus === "running";
    prevDaemonStatus = status;

    if (status !== "running") return;

    // First-time startup side-effects
    if (!environmentChecked()) {
      checkEnvironment();
      if (!fleetPoller) {
        setTimeout(pollFleetHealth, 10000);
        fleetPoller = startPoller(pollFleetHealth, 60000, { immediate: false });
      }
    }

    // Always (re)subscribe on a rising edge — fresh startup or reconnect
    if (!wasRunning) {
      import("./lib/events").then(({ restartEventSubscription }) => restartEventSubscription());
    }
  });

  onMount(() => {
    // AI window runs in a separate webview and only renders <AiWindow/>.
    // Skip every main-window bootstrap (deep-link listener, event stream,
    // daemon polling, global shortcuts) so we don't fight the main window
    // for the single daemon event subscription.
    if (isAiWindow) return;

    // The AI window asks the main window to show a page (e.g. Settings → AI).
    let unlistenNavigate: (() => void) | null = null;
    import("@tauri-apps/api/event")
      .then(({ listen }) => listen<string>("orca-navigate", (e) => navigate(e.payload)))
      .then((u) => { unlistenNavigate = u; })
      .catch(() => {});
    onCleanup(() => unlistenNavigate?.());

    // A folder (or compose file) dropped onto the window opens it as a project.
    let unlistenDrop: (() => void) | null = null;
    import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) => getCurrentWebview().onDragDropEvent((e) => {
        if (e.payload.type === "drop" && e.payload.paths.length > 0) openFolderDialog(e.payload.paths[0]);
      }))
      .then((u) => { unlistenDrop = u; })
      .catch(() => {});
    onCleanup(() => unlistenDrop?.());

    // Listen for deep link URLs (orca:// protocol). Guard against the
    // unmount-before-subscribe race: if the component has been cleaned up
    // before onOpenUrl resolves, we immediately unsubscribe and drop the
    // handle instead of leaking a listener.
    let unsubDeepLink: (() => void) | undefined;
    let unmounted = false;
    onOpenUrl((urls) => {
      for (const url of urls) {
        handleDeepLink(url);
      }
    }).then((unsub) => {
      if (unmounted) {
        try { unsub(); } catch {}
      } else {
        unsubDeepLink = unsub;
      }
    }).catch((e) => {
      console.debug("Deep link listener not available:", e);
    });

    const unsubEvents = onOrcaEvent((payload: any) => {
      const kind = payload?.kind;
      const data = kind?.data || {};
      const attrs = payload?.Actor?.Attributes || {};
      const eventType = payload?.type || payload?.Action || kind?.type || "";
      const id = data.id || payload?.id || payload?.Actor?.ID || payload?.Actor?.id || "";
      const name = data.name || payload?.name || attrs.name || "";
      const containerLabel = name || (id ? id.slice(0, 12) : "container");
      const reference = data.reference || payload?.reference || attrs.name || data.id || "";
      const exitCodeRaw = data.exit_code ?? attrs.exitCode;
      const exitCode = typeof exitCodeRaw === "number" ? exitCodeRaw : Number.parseInt(String(exitCodeRaw ?? ""), 10);
      const oomKilled = data.oom_killed === true || attrs.oomKilled === "true";

      // Docker says "died" for every stop. Speak up only when something went
      // wrong: out of memory, or a crash, not a stop (0, or 143/137 from
      // SIGTERM/SIGKILL) and never Orca's own containers (the gateway
      // restarts when its domain or certificate changes).
      const ownContainer = name.startsWith("orca-") || attrs["orca.managed"] === "true";
      const stopped = exitCode === 0 || exitCode === 143 || exitCode === 137;
      if (
        (eventType === "container.died" || eventType === "die" || eventType === "ContainerDied") &&
        !ownContainer &&
        (oomKilled || !stopped)
      ) {
        const title = oomKilled
          ? `Container '${containerLabel}' ran out of memory`
          : `Container '${containerLabel}' exited`;
        const detail = oomKilled
          ? "Docker reported OOMKilled. Check the container memory limit or, on macOS, increase the Docker VM memory in Settings."
          : Number.isFinite(exitCode) ? `Exit code: ${exitCode}` : undefined;
        addEvent({ type: "container.died", title, detail, severity: "error" });
        showToast(oomKilled ? `${title}. Check memory settings.` : title, "error", {
          label: oomKilled && id ? "View Container" : "View Logs",
          onClick: () => {
            if (oomKilled && id) {
              setDetailId(id);
              setPage("container-detail");
            } else {
              setPage("containers");
            }
          },
        });
      } else if (eventType === "container.started" || eventType === "start" || eventType === "ContainerStarted") {
        addEvent({ type: "container.started", title: `Container '${containerLabel}' started`, severity: "success" });
      } else if (eventType === "image.pulled" || eventType === "pull" || eventType === "ImagePulled") {
        addEvent({ type: "image.pulled", title: `Image pulled: ${reference}`, severity: "success" });
        showToast(`Image pulled: ${reference}`, "success");
      } else if (eventType === "DevInstance" || eventType === "dev.instance") {
        const who =
          data.source === "mcp" ? "An agent" :
          data.source === "cli" ? "The CLI" :
          data.source === "wake" ? "A request" :
          data.source === "orca" ? "Orca" : "You";
        const what: Record<string, string> = {
          up: data.source === "wake" ? (data.succeeded ? "woke up" : "couldn't wake") : data.succeeded ? "started" : "couldn't start",
          down: data.succeeded ? "stopped" : "couldn't stop",
          remove: data.succeeded ? "removed" : "couldn't remove",
          idle_stop: "stopped idle instance",
          data_reset: "reset the database of",
        };
        const title = `${who} ${what[data.action] ?? data.action} ${data.instance} (${data.project})`;
        const detail = [data.url, data.message?.split("\n")[0]].filter(Boolean).join(" · ") || undefined;
        addEvent({ type: "dev.instance", title, detail, severity: data.succeeded ? "info" : "error" });
        // The Projects page already reports what the user did there.
        if (data.source !== "ui" || !data.succeeded) {
          showToast(title, data.succeeded ? "info" : "error", {
            label: "Open Projects",
            onClick: () => navigate("projects"),
          });
        }
      }
    });

    // Auto-start daemon with progress feedback
    const startAndWait = async () => {
      setStartupStep("Starting daemon...");
      try {
        await invoke("start_daemon");
      } catch {}

      // Poll for readiness
      setStartupStep("Waiting for daemon...");
      for (let i = 0; i < 10; i++) {
        try {
          const status = (await invoke("get_status")) as any;
          if (status.daemon_running) {
            setStartupStep("Connecting to Docker...");
            // Reconnect only if the daemon has no working connection (e.g.
            // Docker in WSL on Windows came up after it). A reconnect swaps
            // the runtime, which restarts its event stream and empties its
            // caches, so don't do it on every launch.
            try {
              const health = (await invoke("system_health")) as any;
              dockerConnectedAtStart = health?.docker_connected === true;
              if (!dockerConnectedAtStart) await invoke("reconnect_runtime");
            } catch {}
            setDaemonStatus("running");
            return;
          }
        } catch {}
        if (i >= 3) setStartupStep("Starting daemon... (this may take a moment)");
        await new Promise(r => setTimeout(r, 500));
      }
      setDaemonStatus("stopped");
    };
    startAndWait();

    // eslint-disable-next-line solid/reactivity -- polled callback reads the current status
    const watchdog = startPoller(() => {
      if (daemonStatus() !== "connecting") return watchDaemon();
    }, 3000, { immediate: false });

    document.addEventListener("keydown", handleGlobalKeyDown);
    const openCmdPalette = () => setShowCommandPalette((v) => !v);
    document.addEventListener("orca-open-command-palette", openCmdPalette);
    onCleanup(() => {
      unmounted = true;
      watchdog.stop();
      fleetPoller?.stop();
      document.removeEventListener("keydown", handleGlobalKeyDown);
      document.removeEventListener("orca-open-command-palette", openCmdPalette);
      unsubEvents();
      unsubDeepLink?.();
      import("./lib/events").then(({ stopEventSubscription }) => stopEventSubscription());
    });
  });

  const startResize = async (e: MouseEvent) => {
    e.preventDefault();
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      // Tauri 2 uses startResizing or the ResizeDirection enum
      const started = await (win as any).startResizing?.("BottomRight");
      if (started === undefined) await (win as any).startDragging?.();
    } catch (err) {
      console.error("Resize failed:", err);
    }
  };

  return (
    <Show when={!isAiWindow} fallback={<AiWindow />}>
    <div class={`app-root ${navigator.platform.includes("Mac") ? "platform-macos" : ""}`}>
      <Titlebar daemonStatus={daemonStatus()} onNavigate={(p) => navigate(p)} />
      {daemonStatus() === "connecting" ? (
        <div style={{ display: "flex", "flex-direction": "column", "align-items": "center", "justify-content": "center", height: "calc(100vh - 40px)", gap: "16px" }}>
          <img src="/orca-logo-full.png" alt="Orca" style={{ width: "80px", height: "80px", "border-radius": "18px", opacity: "0.8" }} />
          <div style={{ color: "#8b949e", "font-size": "14px" }}>{startupStep()}</div>
        </div>
      ) : daemonStatus() !== "running" && daemonStatus() !== "reconnecting" ? (
        <ConnectionScreen status={daemonStatus()} onRetry={checkDaemon} />
      ) : !environmentChecked() ? (
        <div style={{ display: "flex", "flex-direction": "column", "align-items": "center", "justify-content": "center", height: "calc(100vh - 40px)", gap: "16px" }}>
          <img src="/orca-logo-full.png" alt="Orca" style={{ width: "80px", height: "80px", "border-radius": "18px", opacity: "0.8" }} />
          <div style={{ color: "#8b949e", "font-size": "14px" }}>{startupStep()}</div>
        </div>
      ) : (
        <>
          <div class="app-body">
            <Sidebar
              currentPage={page() === "container-detail" ? "containers" as Page : page() === "stack-detail" ? "containers" as Page : page() === "volume-detail" ? "volumes" as Page : page()}
              onNavigate={(p: Page) => navigate(p)}
              daemonStatus={daemonStatus()}
            />
            <main class="app-main">
              <ConnectionBanner status={daemonStatus()} />
              {page() === "fleet" && <FleetPage onNavigate={(p) => navigate(p)} />}
              {page() === "dashboard" && <DashboardPage onNavigate={(p) => navigate(p)} />}
              {page() === "templates" && <TemplatesPage onNavigate={(p) => navigate(p)} />}
              {page() === "containers" && <ContainersPage onNavigate={(p) => navigate(p)} onAskAi={(id, name, image) => aiApi?.askAboutContainer(id, name, image)} />}
              {page() === "container-detail" && detailId() && (
                <ContainerDetailPage
                  containerId={detailId()!}
                  onBack={() => breadcrumbStack() ? navigate(`stack:${breadcrumbStack()}`) : navigate("containers")}
                  onNavigate={(p) => navigate(p)}
                  breadcrumbStack={breadcrumbStack()}
                />
              )}
              {page() === "stack-detail" && detailId() && (
                <StackDetailPage
                  stackName={detailId()!}
                  onBack={() => navigate("containers")}
                  onNavigate={(p) => navigate(p)}
                />
              )}
              {page() === "images" && <ImagesPage autoOpenPull={detailId() === "pull"} onPullOpened={() => setDetailId(null)} onNavigate={(p) => navigate(p)} />}
              {page() === "builds" && <BuildsPage onNavigate={(p) => navigate(p)} onAskAi={(tag, error, logTail) => aiApi?.askAboutBuild(tag, error, logTail)} />}
              {page() === "volumes" && <VolumesPage onNavigate={(p) => navigate(p)} />}
              {page() === "volume-detail" && detailId() && (
                <VolumeDetailPage
                  volumeName={detailId()!}
                  onBack={() => navigate("volumes")}
                  onNavigate={(p) => navigate(p)}
                />
              )}
              {page() === "networks" && <NetworksPage />}
              {page() === "gateway" && <GatewayPage onNavigate={(p) => navigate(p)} />}
              {page() === "projects" && <ProjectsPage onNavigate={(p) => navigate(p)} />}
              {page() === "workspace" && <WorkspacePage onNavigate={(p) => navigate(p)} />}
              {page() === "kubernetes" && <KubernetesPage />}
              {/* Machine page merged into System Health */}
              {page() === "environment" && <EnvironmentPage />}
              {page() === "activity" && <ActivityPage />}
              {page() === "settings" && <SettingsPage initialTab={detailId() || undefined} onTabOpened={() => setDetailId(null)} />}
            </main>
          </div>
          {showCommandPalette() && (
            <CommandPalette
              onClose={() => setShowCommandPalette(false)}
              onNavigate={(p) => navigate(p)}
              onOpenComposeWizard={() => setShowComposeWizard(true)}
              onShowShortcuts={() => setShowShortcuts(true)}
            />
          )}
          <Show when={openFolderTarget() !== undefined}>
            <OpenFolderDialog onNavigate={(p) => navigate(p)} />
          </Show>
          <Show when={showComposeWizard()}>
            <ComposeWizard
              onClose={() => setShowComposeWizard(false)}
              onDeployed={() => { if (page() === "containers") navigate("containers"); }}
            />
          </Show>
          <AiAssistant onNavigate={(p: string) => navigate(p)} ref={(api) => { aiApi = api; }} />
        </>
      )}
      <StatusBar onNavigate={(p) => navigate(p)} />
      <ToastContainer />
      <ConfirmDialog />
      <Show when={showShortcuts()}>
        <KeyboardShortcuts onClose={() => setShowShortcuts(false)} />
      </Show>
      <div class="resize-handle" onMouseDown={startResize} />
    </div>
    </Show>
  );
}
