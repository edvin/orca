import type { ComposeProject, GatewayRoute } from "./types";

export interface StackUrl {
  url: string;
  label: string;
}

/** The HTTPS URLs that reach a stack's services through the gateway, the
 *  main (path-less) ones first. */
export function stackUrls(stack: ComposeProject, routes: GatewayRoute[]): StackUrl[] {
  const names = new Set(stack.services.map((s) => s.container_name));
  const seen = new Set<string>();
  return routes
    .filter((r) => r.enabled && names.has(r.container_name))
    .sort((a, b) => (a.path ? 1 : 0) - (b.path ? 1 : 0))
    .map((r) => {
      const path = (r.path ?? "").replace(/\*$/, "");
      const url = (r.url ?? `https://${r.hostname}`) + path;
      const service = stack.services.find((s) => s.container_name === r.container_name)?.name ?? r.container_name;
      return { url, label: r.presentation?.title || service };
    })
    .filter((u) => (seen.has(u.url) ? false : (seen.add(u.url), true)));
}
