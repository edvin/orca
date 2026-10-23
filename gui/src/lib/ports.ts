// What a container's ports are for, from the image and the port number:
// what Orca knows without asking the container. `probe_container_ports`
// asks the ports themselves, on request only.

import type { PortMapping } from "./types";

/** web: an HTTP server the gateway can serve. other: something else. */
export type PortKind = "web" | "other" | "unknown";

export interface PortGroup {
  port: number;
  /** Last port of a run of ports (a relay range), when it's one. */
  to?: number;
  protocol: string;
  label?: string;
  kind: PortKind;
  /** Port on this computer, when published (of the first in a run). */
  hostPort?: number;
  /** Checked, and nothing answered. */
  noAnswer?: boolean;
}

/** A probe result from the daemon. */
export interface PortProbe {
  container_port: number;
  protocol: string;
  kind: "web" | "other" | "no_answer" | "not_checked";
  label?: string;
  status?: number;
}

type Known = [label: string, web: boolean];

// By port, when the image doesn't say otherwise.
const PORTS: Record<number, Known> = {
  21: ["FTP", false],
  22: ["SSH", false],
  25: ["SMTP", false],
  53: ["DNS", false],
  80: ["HTTP", true],
  110: ["POP3", false],
  143: ["IMAP", false],
  389: ["LDAP", false],
  443: ["HTTPS", false],
  465: ["SMTPS", false],
  587: ["SMTP", false],
  636: ["LDAPS", false],
  993: ["IMAPS", false],
  995: ["POP3S", false],
  1025: ["SMTP", false],
  1433: ["SQL Server", false],
  1521: ["Oracle", false],
  1883: ["MQTT", false],
  2181: ["ZooKeeper", false],
  3306: ["MySQL", false],
  3478: ["STUN/TURN", false],
  4222: ["NATS", false],
  5349: ["TURN over TLS", false],
  5432: ["PostgreSQL", false],
  5672: ["AMQP", false],
  6379: ["Redis", false],
  6380: ["Redis", false],
  6443: ["Kubernetes API", false],
  7233: ["Temporal", false],
  7687: ["Neo4j Bolt", false],
  8125: ["StatsD", false],
  9042: ["Cassandra", false],
  9092: ["Kafka", false],
  9093: ["Kafka", false],
  9229: ["Node debugger", false],
  9300: ["Elasticsearch cluster", false],
  11211: ["Memcached", false],
  15672: ["RabbitMQ admin", true],
  26257: ["CockroachDB", false],
  27017: ["MongoDB", false],
  27018: ["MongoDB", false],
  50051: ["gRPC", false],
};

// By image, first match wins; these also name a container's web ports.
const IMAGES: [RegExp, Record<number, Known>][] = [
  [/clickhouse/, { 8123: ["ClickHouse HTTP", true], 9000: ["ClickHouse native", false], 9009: ["ClickHouse replication", false] }],
  [/minio/, { 9000: ["S3 API", true], 9001: ["MinIO console", true] }],
  [/mailpit/, { 8025: ["Mailpit", true], 1025: ["SMTP", false], 1110: ["POP3", false] }],
  [/mailhog/, { 8025: ["MailHog", true], 1025: ["SMTP", false] }],
  [/rabbitmq/, { 15672: ["RabbitMQ admin", true], 15692: ["Metrics", true] }],
  [/grafana/, { 3000: ["Grafana", true] }],
  [/prometheus/, { 9090: ["Prometheus", true] }],
  [/loki/, { 3100: ["Loki", true] }],
  [/jaeger/, { 16686: ["Jaeger", true], 4317: ["OTLP gRPC", false], 4318: ["OTLP HTTP", true] }],
  [/temporalio\/ui/, { 8080: ["Temporal UI", true] }],
  [/temporal/, { 7233: ["Temporal", false] }],
  [/elasticsearch|opensearch/, { 9200: ["Search API", true], 9300: ["Cluster", false] }],
  [/kibana/, { 5601: ["Kibana", true] }],
  [/keycloak/, { 8080: ["Keycloak", true], 9000: ["Management", true] }],
  [/adminer/, { 8080: ["Adminer", true] }],
  [/phpmyadmin/, { 80: ["phpMyAdmin", true] }],
  [/^php|fpm/, { 9000: ["PHP-FPM", false] }],
  [/soketi/, { 6001: ["WebSockets", true], 9601: ["Metrics", true] }],
  [/coturn/, { 3478: ["STUN/TURN", false], 5349: ["TURN over TLS", false] }],
  [/gitea|forgejo/, { 3000: ["Gitea", true], 22: ["Git over SSH", false] }],
  [/gitlab/, { 80: ["GitLab", true], 22: ["Git over SSH", false] }],
];

/** The image's name, without registry, tag or digest. */
function imageName(image: string): string {
  const noDigest = image.split("@")[0];
  const parts = noDigest.split("/");
  const last = parts[parts.length - 1].split(":")[0];
  // Keep the namespace (temporalio/ui) but drop a registry host.
  const ns = parts.length > 1 && !parts[parts.length - 2].includes(".") ? `${parts[parts.length - 2]}/` : "";
  return (ns + last).toLowerCase();
}

/** What Orca knows about a port of a container running `image`. */
export function knownPort(image: string, port: number, protocol = "tcp"): { label?: string; kind: PortKind } {
  const name = imageName(image);
  const byImage = IMAGES.find(([re, ports]) => re.test(name) && ports[port]);
  const known = byImage ? byImage[1][port] : PORTS[port];
  // A web page is TCP; whatever a UDP port is, the gateway can't serve it.
  if (protocol.toLowerCase() === "udp") return { label: known?.[0], kind: "other" };
  return known ? { label: known[0], kind: known[1] ? "web" : "other" } : { kind: "unknown" };
}

/**
 * A container's ports, one group per port and protocol, lowest first, with
 * runs of three or more unnamed ports (a relay range) folded into one.
 */
export function portGroups(image: string, ports: PortMapping[], probes?: PortProbe[]): PortGroup[] {
  const seen = new Map<string, PortGroup>();
  for (const p of ports) {
    const protocol = (p.protocol || "tcp").toLowerCase();
    const key = `${p.container_port}/${protocol}`;
    if (seen.has(key)) continue;
    const g: PortGroup = { port: p.container_port, protocol, ...knownPort(image, p.container_port, protocol) };
    if (p.host_port) g.hostPort = p.host_port;
    const probe = probes?.find((x) => x.container_port === p.container_port && x.protocol === protocol);
    if (probe?.kind === "web") {
      g.kind = "web";
      g.label = probe.label ?? g.label;
    } else if (probe?.kind === "other") {
      g.kind = "other";
      g.label = probe.label ?? g.label;
    } else if (probe?.kind === "no_answer") {
      g.noAnswer = true;
    }
    seen.set(key, g);
  }
  // The same port and service over TCP and UDP is one chip (STUN on 3478).
  const merged: PortGroup[] = [];
  for (const g of [...seen.values()].sort((a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol))) {
    const prev = merged[merged.length - 1];
    if (prev && prev.port === g.port && prev.label === g.label && prev.kind === g.kind) {
      prev.protocol = `${prev.protocol}+${g.protocol}`;
      prev.hostPort ??= g.hostPort;
    } else {
      merged.push(g);
    }
  }
  const sorted = merged;

  const out: PortGroup[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (
      j + 1 < sorted.length &&
      !sorted[i].label &&
      !sorted[j + 1].label &&
      sorted[j + 1].protocol === sorted[i].protocol &&
      sorted[j + 1].port === sorted[j].port + 1
    ) j++;
    if (j - i >= 2) {
      const relay = /coturn|turn/.test(imageName(image)) && sorted[i].port >= 49152;
      out.push({ ...sorted[i], to: sorted[j].port, label: relay ? "relay ports" : undefined, kind: relay ? "other" : sorted[i].kind });
      i = j + 1;
    } else {
      out.push(sorted[i++]);
    }
  }
  return out;
}

/** The port the gateway should route to: the first web one, else the first that may be. */
export function routablePort(groups: PortGroup[]): number | undefined {
  const pick = (kind: PortKind) => groups.find((g) => g.kind === kind && g.to === undefined)?.port;
  return pick("web") ?? pick("unknown");
}

/** How a port group reads on a chip: ":8123", ":49160–49201". */
export function portText(g: PortGroup): string {
  return g.to ? `:${g.port}–${g.to}` : `:${g.port}`;
}
