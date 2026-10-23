// App icons: a built-in name (`grafana`), a data: or https: image, or one a
// container's image picks (`postgres:17` gets PostgreSQL's). The set is the
// daemon's too: see scripts/gen-icons.mjs.

import set from "./icons.json";
import type { ComposeProject, GatewayRoute } from "./types";

const icons = set.icons as Record<string, { title: string; svg: string }>;
const aliases = set.aliases as Record<string, string>;
const images = new Map(set.images as [string, string][]);

const svgSrc = (svg: string) => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;

/** An `<img src>` for an icon setting, or null. */
export function iconSrc(icon?: string | null): string | null {
  if (!icon) return null;
  if (icon.startsWith("https://") || icon.startsWith("data:image/")) return icon;
  const n = icon.trim().toLowerCase();
  const found = icons[aliases[n] ?? n];
  return found ? svgSrc(found.svg) : null;
}

/** The built-in icon an image picks: by its path without registry and tag,
 *  else by its last part. */
export function iconForImage(image?: string | null): string | null {
  if (!image) return null;
  let name = image.split("@")[0];
  const colon = name.lastIndexOf(":");
  if (colon > name.lastIndexOf("/")) name = name.slice(0, colon);
  const parts = name.split("/");
  if (parts.length > 1 && (parts[0].includes(".") || parts[0].includes(":") || parts[0] === "localhost")) parts.shift();
  if (parts[0] === "library") parts.shift();
  const found = images.get(parts.join("/").toLowerCase()) ?? images.get((parts[parts.length - 1] ?? "").toLowerCase());
  return found ? iconSrc(found) : null;
}

/** A stack's icon: its main route's own, else the image of a routed
 *  service, else the first service whose image has one. */
export function stackIcon(stack: ComposeProject, routes: GatewayRoute[]): string | null {
  const names = new Set(stack.services.map((s) => s.container_name));
  const own = routes
    .filter((r) => names.has(r.container_name))
    .sort((a, b) => (a.path ? 1 : 0) - (b.path ? 1 : 0));
  for (const r of own) {
    const src = iconSrc(r.presentation?.icon);
    if (src) return src;
  }
  const routed = new Set(own.map((r) => r.container_name));
  const ordered = [...stack.services].sort((a, b) => Number(routed.has(b.container_name)) - Number(routed.has(a.container_name)));
  for (const s of ordered) {
    const src = iconForImage(s.image);
    if (src) return src;
  }
  return null;
}
