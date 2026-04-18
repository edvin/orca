// Strict SVG and HTML sanitizers.
//
// Template icons and AI/markdown output come from partly-untrusted sources
// (remote template catalogs, user-authored templates, model output). These
// helpers strip anything that could execute script or load external
// resources while preserving enough of the original markup to be useful.

const SVG_ALLOWED_TAGS = new Set([
  "svg",
  "g",
  "path",
  "circle",
  "ellipse",
  "rect",
  "line",
  "polyline",
  "polygon",
  "title",
  "desc",
  "defs",
  "linearGradient",
  "radialGradient",
  "stop",
  "clipPath",
  "mask",
  "pattern",
  "use",
  "text",
  "tspan",
]);

const SVG_ALLOWED_ATTRS = new Set([
  "id",
  "class",
  "viewBox",
  "width",
  "height",
  "x",
  "y",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "d",
  "points",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "stroke-opacity",
  "stroke-miterlimit",
  "opacity",
  "transform",
  "xmlns",
  "preserveAspectRatio",
  "offset",
  "stop-color",
  "stop-opacity",
  "clip-path",
  "mask",
  "style",
  "text-anchor",
  "font-size",
  "font-family",
  "font-weight",
  "dominant-baseline",
  "gradientUnits",
  "gradientTransform",
  "spreadMethod",
  "patternUnits",
  // `href` / `xlink:href` are needed so `<use href="#icon-id">` and
  // `<image href="#...">` can reference local fragments. The per-attribute
  // URL check below rejects any non-fragment target, so adding these to the
  // allow-list does not admit external URLs.
  "href",
  "xlink:href",
  "src",
]);

const DANGEROUS_URL_PREFIX = /^\s*(javascript|data|vbscript):/i;

/**
 * Local fragment URL: `#foo`, `#foo-bar`, etc. Cross-document `<use href>`
 * / paint-server `url()` references are treated as external and removed —
 * they would otherwise let a sanitised icon fetch arbitrary URLs (tracking
 * pixels, internal-network exfil) on render.
 */
const LOCAL_FRAGMENT = /^#[A-Za-z0-9_-]+$/;

/** Matches CSS `url(...)` tokens in style values. Permissive on
 * whitespace / quoting. */
const CSS_URL_TOKEN = /url\s*\([^)]*\)/gi;

/**
 * Attributes whose value can legitimately be a `url(#id)` reference (paint
 * servers, masks, clip paths, filters). For these we allow only local
 * fragments.
 */
const PAINT_SERVER_ATTRS = new Set(["fill", "stroke", "clip-path", "mask", "filter"]);

/**
 * Sanitize an SVG string. Allow-listed tags and attributes only; any event
 * handler, script, foreignObject, or URL-valued attribute with a dangerous
 * scheme is dropped. Returns a safe SVG string, or an empty string if the
 * input could not be parsed or contained no SVG root.
 */
export function sanitizeSvg(raw: string): string {
  if (!raw) return "";

  // Fast-path rejection for obvious attacks — keeps malformed inputs from
  // silently yielding partial markup.
  if (/<\s*(script|iframe|object|embed|foreignObject)/i.test(raw)) {
    // Fall through to DOM sanitisation, but the checks below will strip
    // these tags entirely.
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(raw, "image/svg+xml");
  const root = doc.documentElement;
  if (!root || root.nodeName.toLowerCase() === "parsererror") {
    return "";
  }

  const walker = (node: Element) => {
    const tag = node.localName?.toLowerCase() ?? "";
    if (!SVG_ALLOWED_TAGS.has(tag)) {
      node.remove();
      return;
    }
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) {
        node.removeAttribute(attr.name);
        continue;
      }
      if (!SVG_ALLOWED_ATTRS.has(name) && !name.startsWith("data-")) {
        node.removeAttribute(attr.name);
        continue;
      }
      if (name === "href" || name === "xlink:href" || name === "src") {
        // `<use href="...">`, `<image href="...">`, etc. Allow only local
        // fragment references (`#icon-id`). Any absolute or remote URL is
        // a tracking / SSRF / exfiltration vector.
        if (!LOCAL_FRAGMENT.test(attr.value.trim())) {
          node.removeAttribute(attr.name);
          continue;
        }
      }
      if (PAINT_SERVER_ATTRS.has(name)) {
        // `fill="url(...)"` / `stroke="url(...)"` etc. must only reference
        // local fragments. Any `url(http://…)` here would cause the
        // webview to fetch the target on render.
        const v = attr.value.trim();
        if (v.startsWith("url(") || /\burl\s*\(/i.test(v)) {
          const match = v.match(/^url\s*\(\s*["']?([^)"']+)["']?\s*\)$/);
          if (!match || !LOCAL_FRAGMENT.test(match[1].trim())) {
            node.removeAttribute(attr.name);
            continue;
          }
        }
      }
      if (name === "style") {
        // Reject JS schemes, CSS expressions, @import, and any `url(...)`
        // whose target isn't a local fragment.
        const v = attr.value;
        // CSS identifier escapes (`\75rl(...)`) let an attacker spell
        // `url(...)` / `javascript:` past the literal-string checks below.
        // Legitimate template icons never need `\` in a style value, so
        // reject outright.
        if (v.indexOf("\\") !== -1) {
          node.removeAttribute(attr.name);
          continue;
        }
        if (/expression\s*\(|@import|javascript:|vbscript:|data:/i.test(v)) {
          node.removeAttribute(attr.name);
          continue;
        }
        let externalUrl = false;
        for (const m of v.matchAll(CSS_URL_TOKEN)) {
          const inner = m[0]
            .replace(/^url\s*\(/i, "")
            .replace(/\)$/, "")
            .trim()
            .replace(/^["']|["']$/g, "")
            .trim();
          if (!LOCAL_FRAGMENT.test(inner)) {
            externalUrl = true;
            break;
          }
        }
        if (externalUrl) {
          node.removeAttribute(attr.name);
          continue;
        }
      }
    }
    for (const child of Array.from(node.children)) {
      walker(child);
    }
  };

  // Require the outer element to be <svg>; otherwise bail.
  if (root.localName?.toLowerCase() !== "svg") {
    return "";
  }
  walker(root);
  return root.outerHTML;
}

/**
 * HTML-escape a string for safe interpolation into HTML source text or
 * attribute values. Does NOT accept tags — use sanitizeSvg/sanitizeHtml for
 * markup.
 */
export function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Allow-list a URL for use in an `href` attribute. Returns a safe URL or
 * an empty string. Only http/https/mailto are accepted.
 */
export function safeHref(url: unknown): string {
  const s = String(url ?? "").trim();
  if (!s) return "";
  if (DANGEROUS_URL_PREFIX.test(s)) return "";
  // Reject protocol-relative URLs (`//evil.example/x`) — they inherit the
  // current page's scheme and effectively behave like absolute cross-origin
  // links, bypassing the intent of the leading-`/` branch below.
  if (/^\/\//.test(s)) return "";
  // A leading `/` is allowed only for same-origin absolute paths; the
  // following character must NOT be another `/` (that would be
  // protocol-relative, handled above).
  if (/^(https?:\/\/|mailto:|\/[^\/]|#)/i.test(s)) return s;
  return "";
}
