// Shared databases: the servers projects get a database on, the databases
// Orca made, and what each project's orca.yaml requires.

import { invoke } from "@tauri-apps/api/core";

export type Engine = "mysql" | "percona" | "mariadb" | "postgres";

export const ENGINE_NAME: Record<Engine, string> = { mysql: "MySQL", percona: "Percona Server", mariadb: "MariaDB", postgres: "PostgreSQL" };
/** Built-in icon per engine (Percona Server is MySQL underneath). */
export const ENGINE_ICON: Record<Engine, string> = { mysql: "mysql", percona: "mysql", mariadb: "mariadb", postgres: "postgresql" };

export interface DatabaseInfo {
  name: string;
  size: number | null;
  project: string | null;
  dir: string | null;
  user: string | null;
  seed: string | null;
  snapshots: number;
}

export interface DatabaseServer {
  /** `workspace:mysql` or `orca:postgres-17`. */
  id: string;
  /** Where it comes from: the joined workspace, or run by Orca itself. */
  source: "workspace" | "orca";
  label: string;
  engine: Engine;
  version: string | null;
  running: boolean;
  container: string | null;
  /** Its port on this computer, for database tools. */
  port: number | null;
  databases: DatabaseInfo[];
}

/** One database a project's orca.yaml requires, and where it comes from. */
export interface Requirement {
  engine?: Engine;
  version?: string | null;
  database?: string;
  user?: string;
  /** The server id; none when the project runs its own. */
  server?: string | null;
  source?: { kind: "workspace" | "orca" | "own"; why?: string };
  /** "the workspace's mysql (MySQL)", "Orca's PostgreSQL 17". */
  from?: string;
  replaces?: string | null;
  /** Why nothing can provide it. */
  error?: string;
}

export interface ProjectNeeds {
  project: string;
  dir: string;
  running: boolean;
  databases: Requirement[];
}

/** A project's own database container. */
export interface OwnService {
  project: string;
  dir: string | null;
  service: string;
  container: string;
  running: boolean;
  image: string;
  engine: Engine;
  version: string | null;
  database: string | null;
  volumes: string[];
  /** Its orca.yaml requires a database. */
  required: boolean;
  /** This is the service that database `replaces`. */
  replaced: boolean;
  /** Where the required database comes from now. */
  now_from: string | null;
}

export interface Imported {
  from: string;
  database: string;
  snapshot_before: string | null;
  bytes: number;
}

export interface DatabasesOverview {
  servers: DatabaseServer[];
  projects: ProjectNeeds[];
  snapshot_dir: string;
}

export interface Snapshot {
  name: string;
  bytes: number;
  /** Unix seconds. */
  at: number;
}

export interface ConnectionInfo {
  engine: Engine;
  database: string;
  user: string | null;
  password: string | null;
  /** From the project's containers. */
  inside: string | null;
  /** From this computer, for database tools. */
  outside: string | null;
  host_port: number | null;
}

const call = <T>(method: string, path: string, body?: unknown) =>
  invoke<T>("databases_api", { method, path, body: body ?? null });
const enc = encodeURIComponent;
const at = (server: string, db: string) => `/databases/${enc(server)}/${enc(db)}`;

export const databasesApi = {
  overview: () => call<DatabasesOverview>("GET", "/databases"),
  /** Without sizes: fast, for summaries on other pages. */
  quick: () => call<DatabasesOverview>("GET", "/databases?quick=true"),
  connection: (server: string, db: string) => call<ConnectionInfo>("GET", `${at(server, db)}/connection`),
  reset: (server: string, db: string) => call<{ seed_output: string | null }>("POST", `${at(server, db)}/reset`),
  snapshots: (server: string, db: string) => call<Snapshot[]>("GET", `${at(server, db)}/snapshots`),
  snapshot: (server: string, db: string, label?: string) => call<Snapshot>("POST", `${at(server, db)}/snapshots`, { label: label || null }),
  restore: (server: string, db: string, snap: string) => call<unknown>("POST", `${at(server, db)}/snapshots/${enc(snap)}/restore`),
  deleteSnapshot: (server: string, db: string, snap: string) => call<unknown>("DELETE", `${at(server, db)}/snapshots/${enc(snap)}`),
  ownServices: () => call<OwnService[]>("GET", "/databases/own-services"),
  import: (server: string, db: string, container: string, sourceDb?: string | null) =>
    call<Imported>("POST", `${at(server, db)}/import`, { container, database: sourceDb ?? null }),
  start: (server: string) => call<unknown>("POST", `/databases/servers/${enc(server)}/start`),
  stop: (server: string) => call<unknown>("POST", `/databases/servers/${enc(server)}/stop`),
};

/** Where a requirement's database is, in a word or two: "shared", "Orca's server", "its own db". */
export function shortFrom(r: Requirement): string {
  if (r.error) return r.error;
  const kind = r.source?.kind;
  return kind === "workspace" ? "shared" : kind === "orca" ? "Orca's server" : `its own ${r.replaces ?? "database"}`;
}

export function bytes(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** The snippet a project adds to its orca.yaml to get a database. */
export const REQUIRE_SNIPPET = `requires:
  database:
    engine: mysql          # mysql, percona, mariadb or postgres
    version: ">=8.0"       # optional
    replaces: db           # its own compose service, if it has one
    env:                   # how the app wants it; DATABASE_URL when left out
      DB_HOST: "{host}"
      DB_PORT: "{port}"
      DB_DATABASE: "{name}"
      DB_USERNAME: "{user}"
      DB_PASSWORD: "{password}"`;
