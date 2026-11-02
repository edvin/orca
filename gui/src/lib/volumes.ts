// What a volume is for, from the containers that mount it and compose's labels.

import type { Container, Volume } from "./types";

export interface VolumeUser {
  container: Container;
  destination: string;
  rw: boolean;
}

/** Volume name -> the containers that mount it, and where. */
export function volumeUsers(containers: Container[]): Map<string, VolumeUser[]> {
  const out = new Map<string, VolumeUser[]>();
  for (const c of containers) {
    for (const m of c.mounts ?? []) {
      // A volume mount names its volume; older daemons only give the path under /var/lib/docker/volumes.
      const name = m.name ?? (m.kind === "volume" || !m.kind ? m.source.match(/\/volumes\/([^/]+)\/_data$/)?.[1] : undefined);
      if (!name) continue;
      out.set(name, [...(out.get(name) ?? []), { container: c, destination: m.destination, rw: m.rw }]);
    }
  }
  return out;
}

/** Docker names a volume nobody named with 64 hex characters. */
export const isAnonymous = (name: string) => /^[0-9a-f]{64}$/.test(name);

export const volumeStack = (v: Volume) => v.labels?.["com.docker.compose.project"] ?? null;

/** The name to show: compose's key ("pgdata"), the name, or "Anonymous volume". */
export function volumeTitle(v: Volume): string {
  if (isAnonymous(v.name)) return "Anonymous volume";
  const key = v.labels?.["com.docker.compose.volume"];
  return key && volumeStack(v) ? key : v.name;
}

/** "postgres-1" for "shop-postgres-1" in the shop stack. */
export function shortContainer(name: string, stack: string | null): string {
  return stack && name.startsWith(`${stack}-`) ? name.slice(stack.length + 1) : name;
}
