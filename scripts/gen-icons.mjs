// Builds Orca's bundled icon set: app-icon tiles (a brand-coloured rounded
// square with the logo in white) from Simple Icons (CC0), plus a few generic
// ones for roles Simple Icons doesn't cover (a mail catcher, a cache…), and
// which container images get which icon.
//
//   npm pack simple-icons@16.35.0 && tar -xzf simple-icons-16.35.0.tgz
//   node scripts/gen-icons.mjs package
//
// Writes crates/orca-core/src/icons.json and gui/src/lib/icons.json (the
// same file: the daemon draws the landing page, the app its own cards).

import fs from "node:fs";
import path from "node:path";

const pkg = process.argv[2];
if (!pkg) throw new Error("usage: node scripts/gen-icons.mjs <simple-icons package folder>");
const data = JSON.parse(fs.readFileSync(path.join(pkg, "data/simple-icons.json"), "utf8"));
const hexOf = Object.fromEntries(data.map((d) => [d.slug, d]));

// Icon name -> Simple Icons slug.
const BRANDS = {
  grafana: "grafana", prometheus: "prometheus", postgresql: "postgresql", redis: "redis", mysql: "mysql",
  mariadb: "mariadb", mongodb: "mongodb", rabbitmq: "rabbitmq", nginx: "nginx", traefik: "traefikproxy",
  caddy: "caddy", minio: "minio", elasticsearch: "elasticsearch", kibana: "kibana", keycloak: "keycloak",
  phpmyadmin: "phpmyadmin", temporal: "temporal", wordpress: "wordpress", nodejs: "nodedotjs", php: "php",
  python: "python", go: "go", meilisearch: "meilisearch", clickhouse: "clickhouse", docker: "docker",
  kubernetes: "kubernetes", kafka: "apachekafka", vault: "vault", consul: "consul", jenkins: "jenkins",
  gitlab: "gitlab", sentry: "sentry", jaeger: "jaeger", opentelemetry: "opentelemetry", adminer: "adminer",
  laravel: "laravel", symfony: "symfony", vue: "vuedotjs", react: "react", nextjs: "nextdotjs", vite: "vite",
  django: "django", rails: "rubyonrails", apache: "apache", influxdb: "influxdb", opensearch: "opensearch",
  ollama: "ollama", n8n: "n8n", metabase: "metabase", mattermost: "mattermost", nextcloud: "nextcloud",
  gitea: "gitea", portainer: "portainer", ghost: "ghost", pusher: "pusher", pocketbase: "pocketbase", sonarqube: "sonarqubeserver",
};

// Generic roles, drawn with strokes on a 24 grid.
const GENERIC = {
  mail: { title: "Mail", d: "M3 6.5h18v11H3z M3.5 7l8.5 6.5L20.5 7" },
  database: { title: "Database", d: "M5 6c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3z M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6 M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3" },
  cache: { title: "Cache", d: "M13 2 5 14h6l-1 8 8-12h-6z" },
  queue: { title: "Queue", d: "M4 6h12 M4 12h16 M4 18h9 M17 3l3 3-3 3" },
  websocket: { title: "WebSockets", d: "M7 8 3 12l4 4 M17 8l4 4-4 4 M10 12h.01 M14 12h.01" },
  docs: { title: "Docs", d: "M4 4.5A1.5 1.5 0 0 1 5.5 3H11v17H5.5A1.5 1.5 0 0 1 4 18.5z M20 4.5A1.5 1.5 0 0 0 18.5 3H13v17h5.5a1.5 1.5 0 0 0 1.5-1.5z" },
  api: { title: "API", d: "M8 4C6 4 6 6 6 8s-2 4-2 4 2 2 2 4 0 4 2 4 M16 4c2 0 2 2 2 4s2 4 2 4-2 2-2 4 0 4-2 4" },
  worker: { title: "Worker", d: "M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z M12 2v3 M12 19v3 M2 12h3 M19 12h3 M4.9 4.9 7 7 M17 17l2.1 2.1 M4.9 19.1 7 17 M17 7l2.1-2.1" },
  auth: { title: "Sign-in", d: "M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6z M9 12l2 2 4-4" },
  search: { title: "Search", d: "M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z M15.5 15.5 21 21" },
  storage: { title: "Storage", d: "M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z M3.5 7.5 12 12l8.5-4.5 M12 12v9" },
  web: { title: "Website", d: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M3 12h18 M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z" },
  metrics: { title: "Metrics", d: "M4 20V10 M10 20V4 M16 20v-7 M22 20H2" },
  app: { title: "App", d: "M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z" },
};

// Which images get which icon: an image's path without registry and tag
// ("grafana/grafana"), or its last part ("postgres").
const IMAGES = [
  ["grafana/grafana", "grafana"], ["grafana/grafana-oss", "grafana"], ["prom/prometheus", "prometheus"],
  ["postgres", "postgresql"], ["postgis/postgis", "postgresql"], ["bitnami/postgresql", "postgresql"], ["pgvector/pgvector", "postgresql"],
  ["dpage/pgadmin4", "postgresql"], ["redis", "redis"], ["redis/redis-stack", "redis"], ["bitnami/redis", "redis"],
  ["rediscommander/redis-commander", "redis"], ["valkey/valkey", "cache"], ["memcached", "cache"], ["eqalpha/keydb", "cache"],
  ["mysql", "mysql"], ["mariadb", "mariadb"], ["mongo", "mongodb"], ["mongo-express", "mongodb"], ["rabbitmq", "rabbitmq"],
  ["nginx", "nginx"], ["nginxinc/nginx-unprivileged", "nginx"], ["traefik", "traefik"], ["caddy", "caddy"],
  ["minio/minio", "minio"], ["bitnami/minio", "minio"], ["elasticsearch/elasticsearch", "elasticsearch"], ["elasticsearch", "elasticsearch"],
  ["kibana/kibana", "kibana"], ["kibana", "kibana"], ["keycloak/keycloak", "keycloak"], ["jboss/keycloak", "keycloak"],
  ["phpmyadmin", "phpmyadmin"], ["phpmyadmin/phpmyadmin", "phpmyadmin"], ["temporalio/auto-setup", "temporal"], ["temporalio/server", "temporal"],
  ["temporalio/ui", "temporal"], ["temporalio/admin-tools", "temporal"], ["wordpress", "wordpress"], ["node", "nodejs"],
  ["php", "php"], ["python", "python"], ["golang", "go"], ["getmeili/meilisearch", "meilisearch"],
  ["clickhouse/clickhouse-server", "clickhouse"], ["clickhouse", "clickhouse"], ["axllent/mailpit", "mailpit"], ["mailhog/mailhog", "mail"],
  ["maildev/maildev", "mail"], ["soketi/soketi", "websocket"], ["apache/kafka", "kafka"], ["confluentinc/cp-kafka", "kafka"],
  ["bitnami/kafka", "kafka"], ["hashicorp/vault", "vault"], ["vault", "vault"], ["hashicorp/consul", "consul"],
  ["jenkins/jenkins", "jenkins"], ["gitlab/gitlab-ce", "gitlab"], ["gitlab/gitlab-ee", "gitlab"], ["getsentry/sentry", "sentry"],
  ["jaegertracing/all-in-one", "jaeger"], ["otel/opentelemetry-collector", "opentelemetry"],
  ["otel/opentelemetry-collector-contrib", "opentelemetry"], ["adminer", "adminer"], ["httpd", "apache"], ["influxdb", "influxdb"],
  ["opensearchproject/opensearch", "opensearch"], ["ollama/ollama", "ollama"], ["n8nio/n8n", "n8n"], ["metabase/metabase", "metabase"],
  ["mattermost/mattermost-team-edition", "mattermost"], ["nextcloud", "nextcloud"], ["gitea/gitea", "gitea"],
  ["portainer/portainer-ce", "portainer"], ["ghost", "ghost"], ["sonarqube", "sonarqube"], ["typesense/typesense", "search"],
  ["pocket-id/pocket-id", "auth"], ["authelia/authelia", "auth"], ["nats", "queue"], ["localstack/localstack", "storage"],
];

// Names people may write for the same icon.
const ALIASES = {
  postgres: "postgresql", pg: "postgresql", pgadmin: "postgresql", mongo: "mongodb", node: "nodejs", golang: "go",
  traefikproxy: "traefik", vuejs: "vue", next: "nextjs", s3: "storage", email: "mail",
  soketi: "websocket", reverb: "websocket", oidc: "auth", sso: "auth", elastic: "elasticsearch",
};

const lum = (hex) => {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
// A near-black tile gets a faint edge, so it doesn't vanish on a dark page.
const tile = (bg, inner) => {
  const edge = /^#[0-9a-f]{6}$/i.test(bg) && lum(bg.slice(1)) < 0.02 ? ` stroke="#fff" stroke-opacity=".16"` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x=".5" y=".5" width="31" height="31" rx="7" fill="${bg}"${edge}/>${inner}</svg>`;
};

const icons = {};
for (const [name, slug] of Object.entries(BRANDS)) {
  const file = path.join(pkg, "icons", `${slug}.svg`);
  if (!fs.existsSync(file)) throw new Error(`no Simple Icon ${slug}`);
  const d = fs.readFileSync(file, "utf8").match(/ d="([^"]+)"/)[1];
  const hex = hexOf[slug].hex;
  const fg = lum(hex) > 0.55 ? "#111" : "#fff";
  icons[name] = { title: hexOf[slug].title, svg: tile(`#${hex}`, `<path transform="translate(6 6) scale(.8333)" fill="${fg}" d="${d}"/>`) };
}
for (const [name, g] of Object.entries(GENERIC)) {
  icons[name] = {
    title: g.title,
    svg: tile("#3d4b5f", `<path transform="translate(5 5) scale(.9167)" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="${g.d}"/>`),
  };
}
// Logos from other projects, in scripts/icons (see its README for licences),
// on a white tile.
const VENDORED = { mailpit: { title: "Mailpit", file: "mailpit.svg" } };
for (const [name, v] of Object.entries(VENDORED)) {
  const src = fs.readFileSync(path.join("scripts/icons", v.file), "utf8");
  const [, , vw, vh] = src.match(/viewBox="([^"]+)"/)[1].split(/[ ,]+/).map(Number);
  const paths = [...src.matchAll(/<path\b[^>]*?\bd="([^"]+)"[^>]*?(?:style="fill:(#[0-9a-fA-F]{3,6})[^"]*"|fill="(#[0-9a-fA-F]{3,6})")/g)]
    .map((m) => `<path fill="${m[2] ?? m[3]}" d="${m[1]}"/>`).join("");
  const k = 22 / Math.max(vw, vh);
  const dx = (32 - vw * k) / 2, dy = (32 - vh * k) / 2;
  icons[name] = { title: v.title, svg: tile("#fff", `<g transform="translate(${dx.toFixed(2)} ${dy.toFixed(2)}) scale(${k.toFixed(4)})">${paths}</g>`) };
}
for (const [, n] of IMAGES) if (!icons[n]) throw new Error(`image rule names unknown icon ${n}`);
for (const [, n] of Object.entries(ALIASES)) if (!icons[n]) throw new Error(`alias names unknown icon ${n}`);

const out = JSON.stringify({ source: "Simple Icons 16.35.0 (CC0 1.0), Mailpit (MIT, see scripts/icons) and Orca's own", icons, aliases: ALIASES, images: IMAGES }, null, 1) + "\n";
for (const p of ["crates/orca-core/src/icons.json", "gui/src/lib/icons.json"]) fs.writeFileSync(p, out);
console.log(`${Object.keys(icons).length} icons, ${IMAGES.length} image rules, ${(out.length / 1024).toFixed(0)} KB`);
