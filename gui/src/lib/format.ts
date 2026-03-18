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
