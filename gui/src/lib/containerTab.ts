// Which tab a container's page opens on, when something links straight to
// it (e.g. "Shell" on a stack's service). Read once, then cleared.

let pending: string | null = null;

export function openContainerOn(tab: string) {
  pending = tab;
}
export function takeContainerTab(): string | null {
  const t = pending;
  pending = null;
  return t;
}
