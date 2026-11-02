import { createSignal, onMount, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { Network } from "../lib/types";
import { useRefresh } from "../lib/useRefresh";
import { showToast } from "../components/Toast";
import { confirmDanger } from "../components/ConfirmDialog";
import { logError } from "../lib/activityStore";
import CopyButton from "../components/CopyButton";
import NetworkMap, { chipLabel, networkColors, tag, type TopologyNetwork } from "../components/NetworkMap";

const DEFAULT_NETWORKS = ["bridge", "host", "none"];
// Docker has exactly one host and one none network, so those can't be created.
const DRIVERS = [
  { value: "bridge", recommended: true, description: "A private network on this machine. What compose projects use." },
  { value: "macvlan", recommended: false, description: "Each container gets its own address on your local network." },
  { value: "ipvlan", recommended: false, description: "Like macvlan, but containers share the machine's MAC address." },
];
export default function NetworksPage(props: { onNavigate?: (page: string) => void }) {
  const [networks, setNetworks] = createSignal<Network[]>([]);
  const [showCreate, setShowCreate] = createSignal(false);
  const [createName, setCreateName] = createSignal("");
  const [createDriver, setCreateDriver] = createSignal("bridge");
  const [creating, setCreating] = createSignal(false);
  const [expandedNetwork, setExpandedNetwork] = createSignal<string | null>(null);
  const [topologyView, setTopologyView] = createSignal((() => {
    try { return localStorage.getItem("orca.networks.view") === "map"; } catch { return false; }
  })());
  const [topology, setTopology] = createSignal<TopologyNetwork[]>([]);
  const [topologyLoaded, setTopologyLoaded] = createSignal(false);
  const [loaded, setLoaded] = createSignal(false);

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
    setTopologyLoaded(true);
  };

  useRefresh(() => {
    refresh();
    refreshTopology();
  });

  onMount(() => {
    refresh();
    refreshTopology();
  });

  const showMap = (map: boolean) => {
    setTopologyView(map);
    try { localStorage.setItem("orca.networks.view", map ? "map" : "list"); } catch { /* not kept */ }
    if (map) refreshTopology();
  };

  const removeNetwork = async (name: string, e: MouseEvent) => {
    e.stopPropagation();
    if (!await confirmDanger("Remove network", `Remove network "${name}"?`)) return;
    try {
      await invoke("remove_network", { name });
      showToast(`Network "${name}" removed`, "success");
      await refresh();
      refreshTopology();
    } catch (err) {
      logError(`Failed to remove network: ${err}`, `Network "${name}"`);
      showToast(`Failed to remove network: ${err}`, "error");
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
      showToast(`Network "${name}" created`, "success");
      setCreateName("");
      setCreateDriver("bridge");
      setShowCreate(false);
      await refresh();
      refreshTopology();
    } catch (err) {
      logError(`Failed to create network: ${err}`, `Network "${name}", driver "${createDriver()}"`);
      showToast(`Failed to create network: ${err}`, "error");
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

  // Containers per network, from the topology (matched by name).
  const members = (name: string) => topology().find((t) => t.name === name)?.containers ?? [];
  const colors = () => networkColors(topology());
  const colorOf = (name: string) => colors().get(name) ?? "#6e7681";

  // In use first (busiest first), then empty ones you made, then Docker's own.
  const ordered = () =>
    networks()
      .map((n) => ({ n, count: members(n.name).length }))
      .map((x) => ({ ...x, rank: x.count > 0 ? 0 : isDefaultNetwork(x.n.name) ? 2 : 1 }))
      .sort((a, b) => a.rank - b.rank || b.count - a.count || a.n.name.localeCompare(b.n.name))
      .map((x) => x.n);
  const inUse = () => networks().filter((n) => members(n.name).length > 0).length;
  const connected = () => new Set(topology().flatMap((t) => t.containers.map((c) => c.id))).size;
  const bridging = () => {
    const count = new Map<string, number>();
    for (const t of topology()) for (const c of t.containers) count.set(c.id, (count.get(c.id) ?? 0) + 1);
    return [...count.values()].filter((v) => v > 1).length;
  };
  const kind = (n: Network) => tag(n) ?? (isDefaultNetwork(n.name) ? "Docker" : "Custom");

  return (
    <div>
      <div class="page-header">
        <div>
          <h1 class="page-title">Networks</h1>
          <div class="page-subtitle">How your containers reach each other. Containers on the same network find each other by name.</div>
        </div>
        <div class="page-actions">
          <div class="segmented" role="tablist">
            <button class={topologyView() ? "" : "active"} onClick={() => showMap(false)} title="Every network, with what's on it">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style={{ "margin-right": "5px", "vertical-align": "-2px" }}>
                <line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/>
              </svg>
              List
            </button>
            <button class={topologyView() ? "active" : ""} onClick={() => showMap(true)} title="Which containers connect which networks">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style={{ "margin-right": "5px", "vertical-align": "-2px" }}>
                <circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/>
                <line x1="12" y1="7" x2="12" y2="12"/><path d="M12 12L5 17"/><path d="M12 12l7 5"/>
              </svg>
              Map
            </button>
          </div>
          <button class="btn" title="Refresh" aria-label="Refresh" onClick={() => { refresh(); refreshTopology(); }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style={{ "vertical-align": "-2px" }}><path d="M20 12a8 8 0 1 1-3-6.2M20 4v5h-5"/></svg>
          </button>
          <button class="btn btn-primary btn-iconed" onClick={() => setShowCreate(true)}>
            <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>Create network
          </button>
        </div>
      </div>

      <Show when={topologyView()} fallback={
        <Show when={loaded()} fallback={
          <div class="nl">
            <For each={[0, 1, 2, 3]}>{() => <div class="nl-row nl-skeleton" />}</For>
          </div>
        }>
          <div class="nl-summary">
            <div><span class="nl-k">Networks</span><b>{networks().length}</b></div>
            <div><span class="nl-k">In use</span><b>{inUse()}</b></div>
            <div><span class="nl-k">Containers connected</span><b>{connected()}</b></div>
            <div><span class="nl-k">On more than one</span><b class={bridging() ? "nl-accent" : ""}>{bridging()}</b>
              <Show when={bridging()}><button class="nl-link" onClick={() => showMap(true)}>Map →</button></Show>
            </div>
          </div>

          <div class="nl">
            <For each={ordered()}>
              {(n) => {
                const open = () => expandedNetwork() === n.id;
                const ctrs = () => [...members(n.name)].sort((a, b) => a.name.localeCompare(b.name));
                const used = () => ctrs().length > 0;
                return (
                  <div class="nl-row" classList={{ "nl-open": open(), "nl-empty": !used() }} style={{ "--net": colorOf(n.name) }}>
                    <div class="nl-main" role="button" tabindex="0"
                      onClick={() => setExpandedNetwork(open() ? null : n.id)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpandedNetwork(open() ? null : n.id); } }}>
                      <span class="nl-icon">
                        <svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="M12 7v5M12 12l-7 5M12 12l7 5"/></svg>
                      </span>
                      <div class="nl-title">
                        <div class="nl-name">{n.name}<span class={`nl-tag nl-tag-${kind(n).split(" ")[0].toLowerCase()}`}>{kind(n)}</span></div>
                        <div class="nl-meta mono">
                          {n.driver || "none"}
                          <Show when={n.subnet}><span> · {n.subnet}</span></Show>
                          <Show when={n.gateway}><span> · gateway {n.gateway}</span></Show>
                        </div>
                      </div>
                      <div class="nl-ctrs">
                        <Show when={used()} fallback={<span class="nl-none">No containers</span>}>
                          <For each={ctrs().slice(0, 4)}>
                            {(c) => (
                              <button class="nl-chip" title={`${c.name}${c.ip ? ` · ${c.ip.split("/")[0]}` : ""}`}
                                onClick={(e) => { e.stopPropagation(); props.onNavigate?.(`container:${c.id}`); }}>
                                {chipLabel(n, c.name)}
                              </button>
                            )}
                          </For>
                          <Show when={ctrs().length > 4}><span class="nl-more">+{ctrs().length - 4}</span></Show>
                        </Show>
                      </div>
                      <span class="nl-count" title={`${ctrs().length} containers`}>{ctrs().length}</span>
                      <span class="nl-actions">
                        <Show when={!isDefaultNetwork(n.name) && n.name !== "orca-gateway" && !used()}>
                          <button class="action-icon action-icon-delete" title="Remove network" onClick={(e) => removeNetwork(n.name, e)}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                          </button>
                        </Show>
                        <svg class="nl-caret" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
                      </span>
                    </div>

                    <Show when={open()}>
                      <div class="nl-detail">
                        <div class="nl-facts">
                          <div><span class="nl-k">ID</span><span class="mono selectable">{n.id.substring(0, 12)}</span><CopyButton text={n.id} label="Copy full network ID" /></div>
                          <div><span class="nl-k">Driver</span><span>{n.driver || "none"}</span></div>
                          <div><span class="nl-k">Subnet</span><span class="mono selectable">{n.subnet || "–"}</span></div>
                          <div><span class="nl-k">Gateway</span><span class="mono selectable">{n.gateway || "–"}</span></div>
                        </div>
                        <Show when={Object.keys(n.labels).length > 0}>
                          <div class="nl-labels">
                            <For each={Object.entries(n.labels)}>{([k, v]) => <span class="nl-label mono selectable">{k}={v}</span>}</For>
                          </div>
                        </Show>
                        <Show when={used()} fallback={
                          <div class="nl-hint">
                            {isDefaultNetwork(n.name)
                              ? n.name === "bridge" ? "Docker's default network: containers run without a network land here, and reach each other only by IP." : `Docker's ${n.name} network.`
                              : "Nothing is connected. Run a container with this network, or remove it."}
                          </div>
                        }>
                          <div class="nl-members">
                            <For each={ctrs()}>
                              {(c) => (
                                <button class="nl-member" onClick={() => props.onNavigate?.(`container:${c.id}`)}>
                                  <span class="nl-member-name">{c.name}</span>
                                  <span class="nl-member-ip mono">{c.ip ? c.ip.split("/")[0] : "no address"}</span>
                                </button>
                              )}
                            </For>
                          </div>
                        </Show>
                      </div>
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>
      }>
        <Show when={topologyLoaded()} fallback={<div class="empty"><p class="empty-title">Loading the network map…</p></div>}>
          <NetworkMap networks={topology()} onOpenContainer={(id) => props.onNavigate?.(`container:${id}`)} />
        </Show>
      </Show>

      {/* Create Network Dialog */}
      <Show when={showCreate()}>
        <div class="modal-overlay" onMouseDown={handleOverlayMouseDown} onClick={handleOverlayClick}>
          <div class="modal-dialog" style={{ width: "640px", "max-width": "92vw" }}>
            <div class="modal-header">
              <div class="modal-head-main">
                <span class="modal-icon"><svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="M12 7v5M12 12l-7 5M12 12l7 5"/></svg></span>
                <div>
                  <h2 class="modal-title">Create network</h2>
                  <div class="modal-subtitle">Containers you connect to it find each other by name.</div>
                </div>
              </div>
              <button class="modal-close" onClick={() => setShowCreate(false)}>
                {"\u00d7"}
              </button>
            </div>
            <form onSubmit={handleCreate}>
              <div class="modal-body">
                <div class="form-group">
                  <label class="form-label">Name</label>
                  <input
                    class="form-input mono"
                    type="text"
                    placeholder="my-network"
                    value={createName()}
                    onInput={(e) => setCreateName(e.currentTarget.value)}
                    autofocus
                  />
                </div>

                <div class="form-group">
                  <label class="form-label">Driver</label>
                  <div class="choice-cards choice-cards-3" role="radiogroup">
                    <For each={DRIVERS}>
                      {(d) => (
                        <button type="button" role="radio" aria-checked={createDriver() === d.value}
                          class="choice-card" classList={{ on: createDriver() === d.value }}
                          onClick={() => setCreateDriver(d.value)}>
                          <span class="choice-dot" />
                          <span>
                            <span class="choice-title">{d.value}<Show when={d.recommended}><small>Usual</small></Show></span>
                            <span class="choice-desc" style={{ display: "block" }}>{d.description}</span>
                          </span>
                        </button>
                      )}
                    </For>
                  </div>
                </div>
              </div>

              <div class="modal-footer">
                <button type="button" class="btn" onClick={() => setShowCreate(false)} disabled={creating()}>
                  Cancel
                </button>
                <button
                  type="submit"
                  class="btn btn-primary"
                  disabled={creating() || !createName().trim()}
                >
                  {creating() ? "Creating..." : "Create"}
                </button>
              </div>
            </form>
          </div>
        </div>
      </Show>
    </div>
  );
}
