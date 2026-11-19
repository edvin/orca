// Topology view of a project: the gateway on top, one column per instance,
// shared services below, with the links between them drawn as they are.
import { For, Show } from "solid-js";
import { DATA_MODE_LABEL, STATUS_META, instanceUrls } from "../../lib/dev";
import type { DevInstance, DevProject } from "../../lib/dev";
import { StatusDot } from "./DevBits";
import { t } from "../../lib/i18n";

interface Props {
  project: DevProject;
  onOpen: (name: string) => void;
}

export default function Topology(props: Props) {
  const instances = () => (props.project.instances ?? []).filter((i) => i.status !== "orphaned");
  const live = (i: DevInstance) => i.status === "running" || i.status === "partial";
  // An instance is linked to the shared stack when it runs and shares at
  // least one service (own-server services don't count).
  const usesShared = (i: DevInstance) =>
    live(i) && props.project.shared.some((s) => i.data_modes?.[s.name] !== "own-server");
  const gw = () => props.project.gateway;

  return (
    <div class="dev-topo">
      <div class="dev-topo-gateway" classList={{ "dev-topo-on": !!gw()?.running }}>
        <StatusDot color={gw()?.running ? "#3fb950" : "#6e7681"} />
        <b>{t("Gateway")}</b>
        <span>
          {t("HTTPS hostnames for every instance")}{gw() && gw()!.https_port !== 443 ? ` · port ${gw()!.https_port}` : ""}
        </span>
      </div>

      <div class="dev-topo-row" style={{ "--n": String(Math.max(instances().length, 1)) }}>
        <For each={instances()}>
          {(i) => (
            <div class="dev-topo-col">
              <div class="dev-topo-stub" classList={{ "dev-topo-stub-on": live(i) && i.routes.length > 0 }} />
              <div
                class="dev-topo-inst"
                classList={{ "dev-topo-inst-on": live(i) }}
                onClick={() => props.onOpen(i.name)}
                title={STATUS_META[i.status].hint}
              >
                <div class="dev-topo-inst-name">
                  <StatusDot color={STATUS_META[i.status].color} />
                  {i.name}
                </div>
                <div class="dev-topo-inst-status">{STATUS_META[i.status].label}</div>
                <For each={i.services}>
                  {(s) => (
                    <div class="dev-topo-svc">
                      <StatusDot color={s.state.toLowerCase() === "running" ? "#3fb950" : "#6e7681"} />
                      {s.name}
                      <Show when={i.data_modes?.[s.name] === "own-server"}>
                        <span class="dev-topo-tag">{t("own server")}</span>
                      </Show>
                    </div>
                  )}
                </For>
                <For each={instanceUrls(i.routes)}>
                  {(u) => <div class="dev-topo-url">{u.url.replace(/^https:\/\//, "")}</div>}
                </For>
                <For each={Object.entries(i.data_modes ?? {}).filter(([, m]) => m === "own-database")}>
                  {([svc]) => (
                    <div class="dev-topo-tag" style={{ "margin-top": "4px" }}>
                      {svc}: {i.tenants?.[svc] ?? DATA_MODE_LABEL["own-database"].toLowerCase()}
                    </div>
                  )}
                </For>
              </div>
              <div class="dev-topo-stub dev-topo-stub-down" classList={{ "dev-topo-stub-on": usesShared(i) }} />
            </div>
          )}
        </For>
      </div>

      <Show when={props.project.shared.length > 0}>
        <div class="dev-topo-shared">
          <div class="dev-topo-shared-label">{t("Shared · runs once")}</div>
          <div style={{ display: "flex", gap: "10px", "flex-wrap": "wrap", "justify-content": "center" }}>
            <For each={props.project.shared}>
              {(s) => (
                <div class="dev-topo-shared-svc">
                  <StatusDot color={s.status === "running" ? "#3fb950" : s.status === "stopped" ? "#d29922" : "#6e7681"} />
                  {s.name}
                  <span>
                    {
                      instances().filter((i) => live(i) && (i.data_modes?.[s.name] ?? "shared") !== "own-server").length
                    }{" "}
                    {t("connected")}</span>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  );
}
