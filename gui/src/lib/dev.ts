// Worktree dev instances: types and a thin client for the daemon's /dev API.
import { invoke } from "@tauri-apps/api/core";

export type InstanceStatus =
  | "not_deployed"
  | "starting"
  | "stopping"
  | "running"
  | "partial"
  | "stopped"
  | "failed"
  | "orphaned"
  | "idle_stopped";

export type DataMode = "shared" | "own-database" | "own-server";

export interface PortAssignment {
  service: string;
  container_port: number;
  host_port: number;
}

export interface DevSharedService {
  name: string;
  reason: string | null;
  image: string | null;
  status: "running" | "stopped" | "not_started";
  container_id: string | null;
  container_name: string | null;
  ports: { host_port: number; container_port: number; protocol?: string }[];
  data_mode: DataMode;
}

export interface DevService {
  name: string;
  state: string;
  container_id: string;
  container_name: string;
  image: string;
}

export interface DevRoute {
  service: string | null;
  hostname: string;
  path: string | null;
  url: string;
}

export interface DevInstance {
  name: string;
  path: string;
  branch: string | null;
  head: string | null;
  is_main: boolean;
  orphaned: boolean;
  dirty: boolean;
  ahead: number | null;
  upstream_gone: boolean;
  status: InstanceStatus;
  compose_project: string;
  services: DevService[];
  routes: DevRoute[];
  ports: PortAssignment[];
  /** Compose profiles it runs, besides the services without one. */
  profiles: string[];
  hostname_overrides: Record<string, string>;
  data_modes: Record<string, DataMode>;
  tenants: Record<string, string>;
  configured: boolean;
  started_by: string | null;
  last_started: string | null;
  job_id: string | null;
  last_error: string | null;
}

export interface DevProject {
  id: string;
  root: string;
  main_branch: string | null;
  orca_yaml?: { exists: boolean; has_dev: boolean; error: string | null };
  shared_source?: "orca.yaml" | "suggested";
  shared: DevSharedService[];
  instances: DevInstance[];
  gateway?: {
    running: boolean;
    domain: string;
    https_port: number;
    /** Whether instance hostnames resolve to this machine for scripts and CLI tools. */
    dns?: { ok: boolean; host: string; addresses: string[]; problem: string | null };
    /** DNS names of the gateway's custom certificate, when it uses one. */
    cert_names?: string[] | null;
  };
  errors: string[];
}

export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface JobStep {
  key: string;
  label: string;
  status: StepStatus;
  detail: string | null;
}

export interface DevJob {
  id: string;
  project: string;
  instance: string | null;
  action: string;
  status: "running" | "succeeded" | "failed";
  steps: JobStep[];
  log: string[];
  error: string | null;
  started_at: string;
  finished_at: string | null;
  result: {
    urls?: { service: string; url: string }[];
    host_ports?: PortAssignment[];
    env_file?: string;
    warnings?: string[];
  } | null;
}

export interface PlannedRoute {
  service: string;
  hostname: string;
  port: number;
  path: string | null;
  url: string;
  container_name: string;
}

export interface EnvVar {
  key: string;
  value: string;
  source: "compose" | "orca";
  why: string | null;
}

export interface DataChoice {
  service: string;
  mode: DataMode;
  default_mode: DataMode;
  kind: "postgres" | "mysql" | "redis" | "mongo" | "rabbitmq" | null;
  shared_db: string | null;
  tenant: string | null;
  supports_own_database: boolean;
  own_database_note: string | null;
}

export interface DataInfo extends DataChoice {
  size: number | null;
  shared_size: number | null;
}

export interface InstancePlan {
  compose_project: string;
  services: string[];
  running_services: string[];
  /** Per-instance services that won't run: behind a profile not picked. */
  left_out: string[];
  /** The compose file's profiles, with the per-instance services in each. */
  profiles: { name: string; services: string[] }[];
  routes: PlannedRoute[];
  host_ports: PortAssignment[];
  networks: string[];
  warnings: string[];
  override_yaml: string;
  env_file: string;
  service_env: Record<string, EnvVar[]>;
  own_databases: Record<string, { kind: string; shared_db: string; tenant: string }>;
  own_servers: string[];
}

export interface PlanView {
  instance: string;
  worktree: string;
  compose_project: string;
  compose_files: string[];
  resolved_mode: boolean;
  shared_services: string[];
  plan: InstancePlan;
  /** The profiles this plan runs. */
  active_profiles: string[];
  data: DataChoice[];
}

export type ExposeT = number | { port: number; host?: string | null; path?: string | null };

export interface SharedServiceT {
  data: DataMode;
  database?: string | null;
  own_database?: { name?: string | null; seed: "clone-main" | "empty" } | null;
  host_port?: number | null;
}

/** The `dev:` section of orca.yaml, as the daemon serializes it. */
export interface DevConfigT {
  naming: { instance: "branch" | "folder"; hostname: string };
  start: "manual" | "on-create";
  shared_project?: string | null;
  shared: Record<string, SharedServiceT>;
  instance: {
    env: Record<string, Record<string, string>>;
    expose: Record<string, ExposeT>;
    host_ports: Record<string, number[]>;
    hooks: { after_up: string[]; after_own_database: string[] };
    idle_stop: string | null;
    limits: { memory?: string | null; cpus?: unknown } | null;
  };
}

export interface SetupService {
  name: string;
  image: string | null;
  built: boolean;
  ports: { target: number; published: string | null; suggested: "browser" | "host" }[];
  volumes: string[];
  depends_on: string[];
  suggested_shared: boolean;
  reason: string;
  kind: "postgres" | "mysql" | "redis" | "mongo" | "rabbitmq" | null;
  shared_db: string | null;
  referenced_by: { service: string; key: string; value: string }[];
  own_database_rewrites: { service: string; key: string; from: string; to: string }[];
  profiles: string[];
}

export interface SetupAnalysis {
  orca_yaml: { path: string; exists: boolean; text: string; has_dev: boolean; has_comments: boolean; error: string | null };
  dev: DevConfigT;
  source: "orca.yaml" | "suggested";
  services: SetupService[];
  migrations: { service: string; command: string; source: string }[];
  adoption: { project: string; containers: string[]; volumes: string[]; running: boolean } | null;
  agents_file: { path: string; exists: boolean; has_snippet: boolean };
  compose_files: string[];
  hostnames: {
    recommended: "flat" | "nested";
    /** Env vars that set a cookie domain. */
    cookie_vars: { service: string; key: string; value: string }[];
    domain: string;
    cert_names: string[] | null;
  };
}

export interface YamlValidation {
  validation: { ok: boolean; error: string | null; line: number | null; dev: DevConfigT | null; warnings: string[] };
  plan: PlanView | null;
  plan_error: string | null;
}

export interface Candidate {
  root: string;
  name: string | null;
  stacks: string[];
  /** Its orca.yaml already has a `dev:` section. */
  has_dev?: boolean;
}

function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  return invoke<T>("dev_api", { method, path, body: body ?? null });
}

const enc = encodeURIComponent;
const inst = (p: string, i: string) => `/dev/projects/${enc(p)}/instances/${enc(i)}`;

export const devApi = {
  listProjects: (details = false) => call<DevProject[]>("GET", `/dev/projects${details ? "?details=true" : ""}`),
  getProject: (id: string, details = false) =>
    call<DevProject>("GET", `/dev/projects/${enc(id)}${details ? "?details=true" : ""}`),
  addProject: (path: string) => call<{ id: string; root: string; existing: boolean }>("POST", "/dev/projects", { path }),
  removeProject: (id: string) => call<null>("DELETE", `/dev/projects/${enc(id)}`),
  candidates: () => call<Candidate[]>("GET", "/dev/candidates"),
  sharedUp: (id: string) => call<DevJob>("POST", `/dev/projects/${enc(id)}/shared/up`),
  sharedDown: (id: string) => call<DevJob>("POST", `/dev/projects/${enc(id)}/shared/down`),
  /** `profiles` undefined: the instance's saved choice. */
  plan: (p: string, i: string, profiles?: string[], modes?: Record<string, DataMode>) => {
    const q = new URLSearchParams();
    if (profiles) q.set("profiles", profiles.join(","));
    if (modes && Object.keys(modes).length > 0) {
      q.set("data", Object.entries(modes).map(([k, v]) => `${k}:${v}`).join(","));
    }
    const qs = q.toString();
    return call<PlanView>("GET", `${inst(p, i)}/plan${qs ? `?${qs}` : ""}`);
  },
  up: (
    p: string,
    i: string,
    opts: { profiles?: string[]; build?: boolean; data_modes?: Record<string, DataMode> } = {},
  ) => call<DevJob>("POST", `${inst(p, i)}/up`, { ...opts, source: "ui" }),
  data: (p: string, i: string) => call<DataInfo[]>("GET", `${inst(p, i)}/data`),
  dataReset: (p: string, i: string, service: string) =>
    call<DevJob>("POST", `${inst(p, i)}/data/${enc(service)}/reset`),
  down: (p: string, i: string) => call<DevJob>("POST", `${inst(p, i)}/down`),
  remove: (p: string, i: string) => call<DevJob>("POST", `${inst(p, i)}/remove`),
  update: (
    p: string,
    i: string,
    s: {
      name?: string;
      hostname_overrides?: Record<string, string>;
      profiles?: string[];
      data_modes?: Record<string, DataMode>;
      drop_data?: boolean;
    },
  ) => call<{ name: string }>("PUT", inst(p, i), s),
  logs: (p: string, i: string, opts: { service?: string; tail?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.service) q.set("service", opts.service);
    q.set("tail", String(opts.tail ?? 300));
    return call<{ logs: string }>("GET", `${inst(p, i)}/logs?${q}`);
  },
  job: (id: string) => call<DevJob>("GET", `/dev/jobs/${enc(id)}`),
  setup: (id: string) => call<SetupAnalysis>("GET", `/dev/projects/${enc(id)}/setup`),
  writeYaml: (
    id: string,
    req: { text?: string; dev?: DevConfigT; gitignore_local?: boolean; dry_run?: boolean },
  ) => call<{ path: string; text: string }>("PUT", `/dev/projects/${enc(id)}/orca-yaml`, req),
  validateYaml: (id: string, text: string, instance?: string) =>
    call<YamlValidation>("POST", `/dev/projects/${enc(id)}/orca-yaml/validate`, { text, instance: instance ?? null }),
  addAgentsSnippet: (id: string) => call<{ path: string }>("POST", `/dev/projects/${enc(id)}/agents-snippet`),
  adopt: (id: string, project: string) => call<{ shared_project: string }>("POST", `/dev/projects/${enc(id)}/adopt`, { project }),
  jobs: (project: string) => call<DevJob[]>("GET", `/dev/jobs?project=${enc(project)}`),
};

/** Poll a job until it finishes, reporting every snapshot. */
export async function followJob(id: string, onUpdate: (job: DevJob) => void): Promise<DevJob> {
  for (;;) {
    const job = await devApi.job(id);
    onUpdate(job);
    if (job.status !== "running") return job;
    await new Promise((r) => setTimeout(r, 700));
  }
}

/** Human labels and colors per instance status. */
export const STATUS_META: Record<InstanceStatus, { label: string; color: string; hint: string }> = {
  not_deployed: { label: "Not started", color: "#6e7681", hint: "This worktree has never been started." },
  starting: { label: "Starting", color: "#58a6ff", hint: "Orca is starting this instance." },
  stopping: { label: "Stopping", color: "#58a6ff", hint: "Orca is stopping this instance." },
  running: { label: "Running", color: "#3fb950", hint: "All services are up." },
  partial: { label: "Partly running", color: "#d29922", hint: "Some services are up, some are not." },
  stopped: { label: "Stopped", color: "#8b949e", hint: "Stopped. Its settings and host ports are kept." },
  failed: { label: "Failed", color: "#f85149", hint: "The last start failed. Open it to see why." },
  orphaned: { label: "Worktree gone", color: "#f85149", hint: "The worktree folder no longer exists." },
  idle_stopped: {
    label: "Idle-stopped",
    color: "#d29922",
    hint: "Orca stopped it after it went unused. Opening its URL or starting it brings it back with the same URLs, ports and data.",
  },
};

/** URLs of an instance, one per hostname+path, with the path made readable. */
export function instanceUrls(routes: DevRoute[]): { service: string; url: string }[] {
  const seen = new Set<string>();
  const out: { service: string; url: string }[] = [];
  for (const r of routes) {
    const path = r.path ? r.path.replace(/\*$/, "").replace(/\/$/, "") : "";
    const url = r.url + path;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ service: r.service ?? r.hostname, url });
  }
  return out;
}

/** "2 h ago" style relative time. */
export function ago(iso: string | null | undefined): string {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/** Shorten a path under the home folder to ~/… */
export function tildify(path: string): string {
  return path.replace(/^\/(home|Users)\/[^/]+/, "~");
}

export const DATA_MODE_LABEL: Record<DataMode, string> = {
  shared: "Shared data",
  "own-database": "Own database",
  "own-server": "Own server",
};

/** One line saying what a data mode means for this service. */
export function dataModeDescription(mode: DataMode, c: Pick<DataChoice, "service" | "shared_db" | "tenant" | "kind">): string {
  const db = c.kind === "redis" ? "DB 0" : c.kind === "rabbitmq" ? `vhost ${c.shared_db ?? "/"}` : c.shared_db ?? c.service;
  switch (mode) {
    case "shared":
      return `Same ${db} as every other worktree. Nothing to copy.`;
    case "own-database":
      if (c.kind === "redis") return `A separate Redis DB number in the shared server${c.tenant ? ` (DB ${c.tenant})` : ""}. Starts empty.`;
      if (c.kind === "rabbitmq") return `Its own vhost${c.tenant ? ` (${c.tenant})` : ""} in the shared broker, so its queues don't mix with others. Starts empty.`;
      return `${c.tenant ? c.tenant : "A copy of " + db} in the shared server, copied when it starts. For branches that change data.`;
    case "own-server":
      return `A private ${c.service} inside this instance. Starts empty. For branches that change the server itself.`;
  }
}

/** 1536 → "1.5 KB" */
export function bytes(n: number | null | undefined): string {
  if (n == null) return "";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 10 && u > 0 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

/** Container port and the kind of reach for a per-instance service. */
export function exposePort(e: ExposeT | undefined): number | null {
  if (e == null) return null;
  return typeof e === "number" ? e : e.port;
}

/** Render the hostname pattern for a preview. */
// Hostname patterns. Mirrors crates/orca-core/src/dev/hostnames.rs so the
// setup screens can preview exactly what the daemon will produce.

/** `web-feat-x-shop.localhost`: one wildcard certificate covers every instance. */
export const HOSTNAME_FLAT = "{service}-{instance}-{project}.{domain}";
/** `web.feat-x.shop.localhost`: each instance gets its own cookie scope. */
export const HOSTNAME_NESTED = "{service}.{instance}.{project}.{domain}";
/** Cookie domain that keeps cookies inside one instance under the nested pattern. */
export const NESTED_COOKIE_DOMAIN = ".{instance}.{project}.{domain}";

export type HostnameStyle = "flat" | "nested" | "custom";

export function hostnameStyle(pattern: string): HostnameStyle {
  const p = pattern.trim();
  return p === HOSTNAME_FLAT ? "flat" : p === HOSTNAME_NESTED ? "nested" : "custom";
}

function fnv6(s: string): string {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(s)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h & 0xffffff).toString(16).padStart(6, "0");
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || s;
}

const fill = (pattern: string, vars: Record<string, string>, unknown: string[]) =>
  pattern.replace(/\{\s*(\w+)\s*\}/g, (_, k: string) => {
    if (k in vars) return vars[k];
    unknown.push(k);
    return `{${k}}`;
  });

/** Render a hostname pattern the way the daemon does: DNS-safe service
 *  names, and labels over 63 characters shortened (instance part first)
 *  with a hash so they stay unique. */
export function renderHostname(pattern: string, vars: Record<string, string>): { host: string; error: string | null } {
  const unknown: string[] = [];
  const v: Record<string, string> = { ...vars, service: slug(vars.service ?? "") };
  let host = fill(pattern, v, unknown);
  if (unknown.length > 0) {
    return { host, error: `Unknown variable {${unknown[0]}}; use {service}, {instance}, {project} or {domain}.` };
  }
  const over = Math.max(...host.split(".").map((l) => l.length)) - 63;
  if (over > 0 && pattern.includes("{instance}")) {
    const inst = v.instance ?? "";
    const keep = Math.max(inst.length - over - 7, 0);
    const short = keep === 0 ? fnv6(inst) : `${inst.slice(0, keep).replace(/-+$/, "")}-${fnv6(inst)}`;
    host = fill(pattern, { ...v, instance: short }, []);
  }
  host = host
    .split(".")
    .map((l) => (l.length <= 63 ? l : `${l.slice(0, 56).replace(/-+$/, "")}-${fnv6(l)}`))
    .join(".");
  const valid =
    host.length > 0 &&
    host.length <= 253 &&
    host.split(".").every((l) => l.length > 0 && !l.startsWith("-") && !l.endsWith("-") && /^[a-z0-9-]+$/.test(l));
  return { host, error: valid ? null : `"${host}" isn't a valid hostname: use lowercase letters, digits, "-" and ".".` };
}

/** Back-compat helper for previews that only need the string. */
export function previewHostname(pattern: string, vars: Record<string, string>): string {
  return renderHostname(pattern, vars).host;
}

/** Patterns that will make hostnames collide. */
export function hostnamePatternWarnings(pattern: string): string[] {
  const out: string[] = [];
  if (!pattern.includes("{instance}"))
    out.push("No {instance} in the pattern: every worktree gets the same hostnames, so only one can be reached at a time.");
  if (!pattern.includes("{service}"))
    out.push("No {service} in the pattern: services with a URL share one hostname unless you give them paths.");
  return out;
}

/** Whether a certificate for `names` covers `host`. Wildcards match one label. */
export function certCovers(names: string[], host: string): boolean {
  return names.some((n) => {
    const name = n.toLowerCase();
    if (!name.startsWith("*.")) return name === host;
    const dot = host.indexOf(".");
    return dot > 0 && host.slice(dot + 1) === name.slice(2);
  });
}
