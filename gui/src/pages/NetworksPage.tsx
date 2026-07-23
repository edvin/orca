import { createSignal, onMount, For, Index, Show, untrack } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { Network } from "../lib/types";
import { useRefresh } from "../lib/useRefresh";
import { showToast } from "../components/Toast";
import { confirmDanger } from "../components/ConfirmDialog";
import SortableHeader from "../components/SortableHeader";
import { useSort } from "../lib/useSort";
import { logError } from "../lib/activityStore";
import Dropdown from "../components/Dropdown";
import { SkeletonRow } from "../components/Skeleton";
import { t } from "../i18n";

const DEFAULT_NETWORKS = ["bridge", "host", "none"];
const NETWORK_COLORS = ["#58a6ff", "#3fb950", "#d29922", "#f85149", "#bc8cff", "#79c0ff"];

interface TopologyNetwork {
  id: string;
  name: string;
  driver: string;
  subnet: string | null;
  gateway: string | null;
  containers: Array<{ id: string; name: string; ip: string }>;
}

export default function NetworksPage() {
  const [networks, setNetworks] = createSignal<Network[]>([]);
  const [showCreate, setShowCreate] = createSignal(false);
  const [createName, setCreateName] = createSignal("");
  const [createDriver, setCreateDriver] = createSignal("bridge");
  const [creating, setCreating] = createSignal(false);
  const [expandedNetwork, setExpandedNetwork] = createSignal<string | null>(null);
  const [topologyView, setTopologyView] = createSignal(false);
  const [topology, setTopology] = createSignal<TopologyNetwork[]>([]);
  const [hoveredNode, setHoveredNode] = createSignal<{ type: "network" | "container"; name: string; details: string; x: number; y: number } | null>(null);
  const [loaded, setLoaded] = createSignal(false);
  const { sortField, sortDir, toggleSort, sortFn } = useSort<Network>("name");

  const refresh = async () => {
    try {
      const result = (await invoke("list_networks")) as Network[];
      setNetworks(result);
    } catch (e) {
      logError(`Failed to list networks: ${e}`);
    }
    setLoaded(true);
  };

  const refreshTopology = async () => {
    try {
      const result = (await invoke("network_topology")) as TopologyNetwork[];
      setTopology(result);
    } catch (e) {
      logError(`Failed to load topology: ${e}`);
    }
  };

  useRefresh(() => {
    refresh();
    if (topologyView()) refreshTopology();
  });

  onMount(refresh);

  const toggleTopology = () => {
    const next = !topologyView();
    setTopologyView(next);
    if (next) refreshTopology();
  };

  const removeNetwork = async (name: string, e: MouseEvent) => {
    e.stopPropagation();
    if (!await confirmDanger(t("infra.networks.removeTitle"), t("infra.networks.removeConfirm", { name }))) return;
    try {
      await invoke("remove_network", { name });
      showToast(t("infra.networks.removed", { name }), "success");
      await refresh();
    } catch (err) {
      logError(`Failed to remove network: ${err}`, `Network "${name}"`);
      showToast(t("infra.networks.removeFailed", { error: String(err) }), "error");
    }
  };

  const handleCreate = async (e: Event) => {
    e.preventDefault();
    const name = createName().trim();
    if (!name) return;

    setCreating(true);
    try {
      await invoke("create_network", {
        name,
        driver: createDriver().trim() || null,
      });
      showToast(t("infra.networks.created", { name }), "success");
      setCreateName("");
      setCreateDriver("bridge");
      setShowCreate(false);
      await refresh();
      if (topologyView()) refreshTopology();
    } catch (err) {
      logError(`Failed to create network: ${err}`, `Network "${name}", driver "${createDriver()}"`);
      showToast(t("infra.networks.createFailed", { error: String(err) }), "error");
    }
    setCreating(false);
  };

  let mouseDownOnOverlay = false;
  const handleOverlayMouseDown = (e: MouseEvent) => {
    mouseDownOnOverlay = (e.target as HTMLElement).classList.contains("modal-overlay");
  };
  const handleOverlayClick = (e: MouseEvent) => {
    if (mouseDownOnOverlay && (e.target as HTMLElement).classList.contains("modal-overlay")) {
      setShowCreate(false);
    }
    mouseDownOnOverlay = false;
  };

  const isDefaultNetwork = (name: string) => DEFAULT_NETWORKS.includes(name);

  const sorted = () => {
    return sortFn(networks(), (item, field) => {
      switch (field) {
        case "name": return item.name;
        case "driver": return item.driver || "none";
        case "subnet": return item.subnet || "";
        default: return "";
      }
    });
  };

  // Build shared-container connections for the topology SVG
  const sharedContainerLines = () => {
    const topo = topology();
    // Map container ID to list of network indices
    const containerNetworks: Record<string, number[]> = {};
    topo.forEach((net, ni) => {
      net.containers.forEach((c) => {
        if (!containerNetworks[c.id]) containerNetworks[c.id] = [];
        containerNetworks[c.id].push(ni);
      });
    });
    // For containers on multiple networks, draw lines between their positions
    const lines: Array<{ x1: number; y1: number; x2: number; y2: number; color: string }> = [];
    const cols = 3;
    for (const [, netIndices] of Object.entries(containerNetworks)) {
      if (netIndices.length < 2) continue;
      for (let a = 0; a < netIndices.length - 1; a++) {
        const ni1 = netIndices[a];
        const ni2 = netIndices[a + 1];
        const x1 = 150 + (ni1 % cols) * 250;
        const y1 = 80 + Math.floor(ni1 / cols) * 200 + 52;
        const x2 = 150 + (ni2 % cols) * 250;
        const y2 = 80 + Math.floor(ni2 / cols) * 200 + 52;
        lines.push({ x1, y1, x2, y2, color: "#484f58" });
      }
    }
    return lines;
  };

  const svgHeight = () => {
    const rows = Math.ceil(topology().length / 3);
    return Math.max(300, rows * 200 + 80);
  };

  return (
    <div>
      <div class="page-header">
        <h1 class="page-title">
          {t("infra.networks.title")}
          <span style={{ "font-size": "13px", color: "#8b949e", "font-weight": "400", "margin-left": "8px" }}>
            {networks().length}
          </span>
        </h1>
        <div class="page-actions">
          <button
            class="btn"
            onClick={toggleTopology}
            style={{
              background: topologyView() ? "#1f6feb" : undefined,
              color: topologyView() ? "#fff" : undefined,
              "border-color": topologyView() ? "#1f6feb" : undefined,
            }}
            title={t("infra.networks.toggleTopology")}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style={{ "margin-right": "4px", "vertical-align": "-2px" }}>
              <circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/>
              <line x1="12" y1="7" x2="12" y2="12"/><path d="M12 12L5 17"/><path d="M12 12l7 5"/>
            </svg>
            {t("infra.networks.topology")}
          </button>
          <button class="btn btn-primary" onClick={() => setShowCreate(true)}>
            {t("infra.common.create")}
          </button>
          <button class="btn" onClick={() => { refresh(); if (topologyView()) refreshTopology(); }}>{t("infra.common.refresh")}</button>
        </div>
      </div>

      <Show when={topologyView()} fallback={
        <Show
          when={networks().length > 0}
          fallback={
            <Show when={loaded()} fallback={
              <table class="table">
                <thead>
                  <tr><th>{t("infra.common.name")}</th><th>{t("infra.common.id")}</th><th>{t("infra.common.driver")}</th><th>{t("infra.networks.subnet")}</th><th>{t("infra.networks.gateway")}</th><th>{t("infra.common.actions")}</th></tr>
                </thead>
                <tbody>
                  <SkeletonRow columns={6} />
                  <SkeletonRow columns={6} />
                  <SkeletonRow columns={6} />
                  <SkeletonRow columns={6} />
                </tbody>
              </table>
            }>
              <div class="empty">
                <div class="empty-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><line x1="12" y1="7" x2="12" y2="12"/><path d="M12 12L5 17"/><path d="M12 12l7 5"/></svg></div>
                <p class="empty-title">{t("infra.networks.emptyTitle")}</p>
                <p>{t("infra.networks.emptyDescription")}</p>
                <div class="empty-actions">
                  <button class="btn btn-primary" onClick={() => setShowCreate(true)}>{t("infra.networks.createTitle")}</button>
                </div>
              </div>
            </Show>
          }
        >
          <table class="table">
            <thead>
              <tr>
                <SortableHeader label="Name" field="name" currentSort={sortField()} currentDirection={sortDir()} onSort={toggleSort} />
                <th>{t("infra.common.id")}</th>
                <SortableHeader label={t("infra.common.driver")} field="driver" currentSort={sortField()} currentDirection={sortDir()} onSort={toggleSort} />
                <SortableHeader label={t("infra.networks.subnet")} field="subnet" currentSort={sortField()} currentDirection={sortDir()} onSort={toggleSort} />
                <th>{t("infra.networks.gateway")}</th>
                <th style={{ "text-align": "right" }}>{t("infra.common.actions")}</th>
              </tr>
            </thead>
            <tbody>
              <For each={sorted()}>
                {(n) => (<>
                  <tr
                    onClick={() => setExpandedNetwork(expandedNetwork() === n.id ? null : n.id)}
                    style={{ cursor: "pointer" }}
                  >
                    <td style={{ "font-weight": "500" }}>
                      <span class={`expand-arrow ${expandedNetwork() === n.id ? "expanded" : ""}`} style={{ "margin-right": "6px", "font-size": "10px" }}>
                        {"\u25B6"}
                      </span>
                      {n.name}
                    </td>
                    <td class="mono" style={{ color: "#8b949e" }}>{n.id.substring(0, 12)}</td>
                    <td>{n.driver || "none"}</td>
                    <td class="mono">{n.subnet || "-"}</td>
                    <td class="mono">{n.gateway || "-"}</td>
                    <td style={{ "text-align": "right" }}>
                      <Show when={!isDefaultNetwork(n.name)}>
                        <button
                          class="action-icon action-icon-delete"
                          title={t("infra.networks.removeAction")}
                          onClick={(e) => removeNetwork(n.name, e)}
                          style={{ color: "#f85149" }}
                        ><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>
                      </Show>
                    </td>
                  </tr>
                  <Show when={expandedNetwork() === n.id}>
                    <tr>
                      <td colspan="6" style={{ padding: "12px 16px 12px 36px", background: "#161b22", "border-top": "none" }}>
                        <div style={{ display: "grid", "grid-template-columns": "repeat(3, 1fr)", gap: "12px", "font-size": "13px" }}>
                          <div>
                            <span style={{ color: "#8b949e" }}>{t("infra.networks.fullId")}</span>
                            <div class="mono" style={{ "word-break": "break-all", "margin-top": "2px" }}>{n.id}</div>
                          </div>
                          <div>
                            <span style={{ color: "#8b949e" }}>{t("infra.networks.subnet")}</span>
                            <div class="mono" style={{ "margin-top": "2px" }}>{n.subnet || t("infra.common.none")}</div>
                          </div>
                          <div>
                            <span style={{ color: "#8b949e" }}>{t("infra.networks.gateway")}</span>
                            <div class="mono" style={{ "margin-top": "2px" }}>{n.gateway || "None"}</div>
                          </div>
                          <div>
                            <span style={{ color: "#8b949e" }}>{t("infra.common.driver")}</span>
                            <div style={{ "margin-top": "2px" }}>{n.driver || "none"}</div>
                          </div>
                          <div>
                            <span style={{ color: "#8b949e" }}>{t("infra.networks.scope")}</span>
                            <div style={{ "margin-top": "2px" }}>{isDefaultNetwork(n.name) ? "Default" : "Custom"}</div>
                          </div>
                          <div>
                            <span style={{ color: "#8b949e" }}>{t("infra.common.labels")}</span>
                            <div class="mono" style={{ "margin-top": "2px" }}>
                              {Object.keys(n.labels).length > 0
                                ? Object.entries(n.labels).map(([k, v]) => `${k}=${v}`).join(", ")
                                : "None"}
                            </div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  </Show>
                </>)}
              </For>
            </tbody>
          </table>
        </Show>
      }>
        {/* Topology View */}
        <div style={{ position: "relative" }}>
          <Show when={topology().length > 0} fallback={
            <div class="empty">
              <div class="empty-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><line x1="12" y1="7" x2="12" y2="12"/><path d="M12 12L5 17"/><path d="M12 12l7 5"/></svg></div>
              <p class="empty-title">{t("infra.networks.loadingTopology")}</p>
            </div>
          }>
            <svg
              viewBox={`0 0 800 ${svgHeight()}`}
              style={{ width: "100%", height: `${svgHeight()}px`, background: "#0d1117", "border-radius": "8px", border: "1px solid #21262d" }}
              onMouseLeave={() => setHoveredNode(null)}
            >
              {/* Connection lines for containers on multiple networks */}
              <For each={sharedContainerLines()}>
                {(line) => (
                  <line
                    x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2}
                    stroke={line.color} stroke-width={1.5} stroke-dasharray="4,4" opacity={0.6}
                  />
                )}
              </For>

              {/* Network nodes */}
              <Index each={topology()}>
                {(netAccessor, index) => {
                  const net = untrack(netAccessor);
                  const cols = 3;
                  const x = 150 + (index % cols) * 250;
                  const y = 80 + Math.floor(index / cols) * 200;
                  const color = NETWORK_COLORS[index % NETWORK_COLORS.length];
                  const containerCount = net.containers.length;
                  const netWidth = Math.max(200, containerCount * 50 + 20);
                  const halfW = netWidth / 2;

                  return (
                    <g>
                      {/* Network rectangle */}
                      <rect
                        x={x - halfW} y={y - 35}
                        width={netWidth} height={containerCount > 0 ? 100 : 70}
                        rx={8}
                        fill="#161b22" stroke={color} stroke-width={2}
                        onMouseEnter={(e) => setHoveredNode({
                          type: "network", name: net.name,
                          details: `Driver: ${net.driver || "none"}\nSubnet: ${net.subnet || "none"}\nGateway: ${net.gateway || "none"}\nContainers: ${containerCount}`,
                          x: e.clientX, y: e.clientY,
                        })}
                        onMouseLeave={() => setHoveredNode(null)}
                        style={{ cursor: "pointer" }}
                      />
                      {/* Network name */}
                      <text x={x} y={y - 10} text-anchor="middle" fill="#e6edf3" font-size="13" font-weight="600" style={{ "pointer-events": "none" }}>
                        {net.name}
                      </text>
                      {/* Network info */}
                      <text x={x} y={y + 8} text-anchor="middle" fill="#8b949e" font-size="11" style={{ "pointer-events": "none" }}>
                        {net.driver || "none"}{net.subnet ? ` | ${net.subnet}` : ""}
                      </text>

                      {/* Connected containers */}
                      <Index each={net.containers}>
                        {(containerAccessor, jIndex) => {
                          const container = untrack(containerAccessor);
                          const maxPerRow = Math.max(1, Math.floor(netWidth / 50));
                          const cx = x - halfW + 25 + (jIndex % maxPerRow) * 50;
                          const cy = y + 30 + Math.floor(jIndex / maxPerRow) * 28;
                          const shortName = container.name.length > 7 ? container.name.slice(0, 7) : container.name;
                          return (
                            <g
                              onMouseEnter={(e) => setHoveredNode({
                                type: "container", name: container.name,
                                details: t("infra.networks.containerDetails", { id: container.id.substring(0, 12), ip: container.ip || "none" }),
                                x: e.clientX, y: e.clientY,
                              })}
                              onMouseLeave={() => setHoveredNode(null)}
                              style={{ cursor: "pointer" }}
                            >
                              <rect
                                x={cx - 20} y={cy - 10}
                                width={40} height={20} rx={4}
                                fill="#0d2818" stroke="#3fb950" stroke-width={1}
                              />
                              <text x={cx} y={cy + 4} text-anchor="middle" fill="#c9d1d9" font-size="8" style={{ "pointer-events": "none" }}>
                                {shortName}
                              </text>
                            </g>
                          );
                        }}
                      </Index>
                    </g>
                  );
                }}
              </Index>
            </svg>

            {/* Hover tooltip */}
            <Show when={hoveredNode()}>
              {(node) => (
                <div style={{
                  position: "fixed",
                  left: `${node().x + 12}px`,
                  top: `${node().y - 10}px`,
                  background: "#1c2128",
                  border: "1px solid #30363d",
                  "border-radius": "6px",
                  padding: "8px 12px",
                  "font-size": "12px",
                  color: "#e6edf3",
                  "z-index": "1000",
                  "pointer-events": "none",
                  "white-space": "pre-line",
                  "max-width": "300px",
                  "box-shadow": "0 4px 12px rgba(0,0,0,0.4)",
                }}>
                  <div style={{ "font-weight": "600", "margin-bottom": "4px", color: node().type === "network" ? "#58a6ff" : "#3fb950" }}>
                    {node().name}
                  </div>
                  <div style={{ color: "#8b949e" }}>{node().details}</div>
                </div>
              )}
            </Show>
          </Show>
        </div>
      </Show>

      {/* Create Network Dialog */}
      <Show when={showCreate()}>
        <div class="modal-overlay" onMouseDown={handleOverlayMouseDown} onClick={handleOverlayClick}>
          <div class="modal-dialog">
            <div class="modal-header">
              <h2 class="modal-title">{t("infra.networks.createTitle")}</h2>
              <button class="modal-close" onClick={() => setShowCreate(false)}>
                {"\u00d7"}
              </button>
            </div>
            <form onSubmit={handleCreate}>
              <div class="modal-body" style={{ overflow: "visible", "min-height": "200px" }}>
                <div class="form-group">
                  <label class="form-label">
                    Name <span style={{ color: "#f85149" }}>*</span>
                  </label>
                  <input
                    class="form-input"
                    type="text"
                    placeholder="my-network"
                    value={createName()}
                    onInput={(e) => setCreateName(e.currentTarget.value)}
                    autofocus
                  />
                </div>

                <div class="form-group">
                  <label class="form-label">{t("infra.common.driver")}</label>
                  <Dropdown
                    value={createDriver()}
                    options={[
                      { value: "bridge", label: "bridge" },
                      { value: "host", label: "host" },
                      { value: "macvlan", label: "macvlan" },
                      { value: "ipvlan", label: "ipvlan" },
                      { value: "none", label: "none" },
                    ]}
                    onChange={(v) => setCreateDriver(v)}
                  />
                </div>
              </div>

              <div class="modal-footer">
                <button type="button" class="btn" onClick={() => setShowCreate(false)} disabled={creating()}>
                  {t("infra.common.cancel")}
                </button>
                <button
                  type="submit"
                  class="btn btn-primary"
                  disabled={creating() || !createName().trim()}
                >
                  {creating() ? t("infra.common.creating") : t("infra.common.create")}
                </button>
              </div>
            </form>
          </div>
        </div>
      </Show>
    </div>
  );
}
