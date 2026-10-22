// Which tab a container's page opens on, when something links straight to
// it (e.g. "Shell" on a stack's service). A container's page takes it when
// it's for that container, also when the page is already open.

import { createSignal } from "solid-js";

const [pending, setPending] = createSignal<{ id: string; tab: string } | null>(null);

export function openContainerOn(id: string, tab: string) {
  setPending({ id, tab });
}

/** The tab asked for `id`, once. */
export function takeContainerTab(id: string): string | null {
  const p = pending();
  if (!p || p.id !== id) return null;
  setPending(null);
  return p.tab;
}

export const pendingContainerTab = pending;
