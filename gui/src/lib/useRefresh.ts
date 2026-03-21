import { onMount, onCleanup } from "solid-js";

/** Listen for Ctrl+R refresh events and call the provided function. */
export function useRefresh(fn: () => void) {
  const handler = () => fn();
  onMount(() => {
    document.addEventListener("orca-refresh", handler);
    onCleanup(() => document.removeEventListener("orca-refresh", handler));
  });
}
