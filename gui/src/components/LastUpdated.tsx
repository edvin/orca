import { createSignal, onCleanup, onMount } from "solid-js";
import { t } from "../i18n";

interface LastUpdatedProps {
  timestamp: Date | null;
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 5) return t("components.lastUpdated.justNow");
  if (seconds < 60) return t("components.lastUpdated.seconds", { count: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("components.lastUpdated.minutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  return t("components.lastUpdated.hours", { count: hours });
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
