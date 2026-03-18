import { createSignal, onCleanup, onMount } from "solid-js";

interface LastUpdatedProps {
  timestamp: Date | null;
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 5) return "Updated just now";
  if (seconds < 60) return `Updated ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `Updated ${hours}h ago`;
}

export default function LastUpdated(props: LastUpdatedProps) {
  const [now, setNow] = createSignal(Date.now());

  onMount(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(interval));
  });

  const label = () => {
    const ts = props.timestamp;
    if (!ts) return "";
    return formatElapsed(now() - ts.getTime());
  };

  return (
    <span class="last-updated">{label()}</span>
  );
}
