export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

export function formatPorts(ports: { host_ip?: string | null; host_port: number; container_port: number }[]): string {
  if (!ports || ports.length === 0) return "-";
  // Deduplicate ports that only differ by host_ip (0.0.0.0 vs ::)
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const p of ports) {
    const key = `${p.host_port}:${p.container_port}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(`${p.host_port}:${p.container_port}`);
    }
  }
  return unique.join(", ");
}

export function formatTimestamp(ts: string): string {
  // Handle Unix timestamp (seconds)
  const num = Number(ts);
  if (!isNaN(num) && num > 1000000000) {
    const date = new Date(num * 1000);
    return timeAgo(date);
  }
  // Handle ISO date string
  const date = new Date(ts);
  if (!isNaN(date.getTime())) {
    return timeAgo(date);
  }
  return ts;
}

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

export function shortId(id: string): string {
  return id.replace("sha256:", "").substring(0, 12);
}

/**
 * A certificate's expiry as people say it, and how urgent it is: "until
 * 15 Dec 2026", "expires in 12 days" (warn, within 30), "expired 3 days
 * ago" (bad).
 */
export function certExpiry(iso: string | null | undefined): { text: string; level: "ok" | "warn" | "bad" } | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (isNaN(at.getTime())) return null;
  const days = Math.floor((at.getTime() - Date.now()) / 86_400_000);
  const date = at.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  if (days < 0) return { text: `expired ${date}`, level: "bad" };
  if (days === 0) return { text: "expires today", level: "bad" };
  if (days <= 30) return { text: `expires in ${days} day${days === 1 ? "" : "s"} (${date})`, level: "warn" };
  return { text: `until ${date}`, level: "ok" };
}
