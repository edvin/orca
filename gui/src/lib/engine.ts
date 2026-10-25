import { invoke } from "@tauri-apps/api/core";
import type { DevJob } from "./dev";

/** The engine Orca uses on macOS: its own VM, or another one picked in Settings. */
export type EngineChoice = { kind: "orca" } | { kind: "socket"; path: string; name?: string | null };

export interface EngineStatus {
  choice: EngineChoice;
  connected: boolean;
  socket: string | null;
  name: string | null;
  /** The daemon runs with DOCKER_HOST set, which wins over the choice. */
  from_env: boolean;
  orca_vm: { name: string; status: string } | null;
  others: { name: string; path: string; running: boolean }[];
  platform: "macos" | "windows" | "linux";
}

export interface DesktopStatus {
  installed: boolean;
  running: boolean;
  counts: { containers: number; images: number; volumes: number } | null;
  /** "moved" or "left", once decided. */
  outcome: "moved" | "left" | null;
  moved_at: string | null;
  /** Orca's own engine is up, to bring things into. */
  orca_ready: boolean;
  moving: boolean;
  /** How the source engine is named: "Docker Desktop", "Docker in Ubuntu". */
  name: string | null;
}

/** Where things come from: Docker Desktop, or (Windows) the Docker an earlier Orca put in the default WSL distro. */
export type MoveFrom = "desktop" | "earlier";

export interface PlanImage {
  id: string;
  tags: string[];
  digests: string[];
  size: number;
  in_orca: boolean;
}

export interface PlanVolume {
  name: string;
  size: number | null;
  action: "copy" | "define" | "skip";
  note: string | null;
  project: string | null;
  in_orca: "done" | "partial" | "theirs" | null;
}

export interface PlanProject {
  name: string;
  dir: string;
  files: string[];
  services: { name: string; running: boolean }[];
  problem: string | null;
  in_orca: boolean;
}

export interface MovePlan {
  socket: string;
  version: string | null;
  images: PlanImage[];
  volumes: PlanVolume[];
  networks: string[];
  projects: PlanProject[];
  standalone: string[];
  to_stop: string[];
  bytes_needed: number;
  bytes_free: number | null;
  anonymous_volumes: number;
}

export interface MoveRequest {
  from: MoveFrom;
  images: boolean;
  volumes: boolean;
  projects: boolean;
  skip: string[];
  switch_cli: boolean;
  quit_desktop: boolean;
}

export interface MoveOutcome {
  images: number;
  images_pulled: number;
  volumes: number;
  networks: number;
  projects: number;
  problems: string[];
  left: string[];
}

function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  return invoke<T>("engine_api", { method, path, body: body ?? null });
}

export const engineApi = {
  status: () => call<EngineStatus>("GET", "/engine"),
  choose: (choice: EngineChoice) =>
    call<{ connected: boolean; log: string[] }>("PUT", "/engine", choice),
};

const q = (from: MoveFrom) => `?from=${from}`;

export const desktopApi = {
  status: (from: MoveFrom = "desktop") => call<DesktopStatus>("GET", `/docker-desktop${q(from)}`),
  plan: (from: MoveFrom = "desktop") => call<MovePlan>("GET", `/docker-desktop/plan${q(from)}`),
  start: (from: MoveFrom = "desktop") => call<{ running: boolean }>("POST", `/docker-desktop/start${q(from)}`),
  move: (req: MoveRequest) => call<DevJob>("POST", "/docker-desktop/move", req),
  leave: (from: MoveFrom = "desktop") => call<{ ok: boolean }>("POST", `/docker-desktop/leave${q(from)}`),
  quit: (from: MoveFrom = "desktop") => call<{ ok: boolean }>("POST", `/docker-desktop/quit${q(from)}`),
};

export const isMac = () => navigator.platform.includes("Mac");
export const isWindows = () => navigator.platform.includes("Win");

/** Where Orca's own engine runs, for sentences: "in its own VM". */
export const ownEngine = () =>
  isMac() ? "in its own VM" : isWindows() ? "in a WSL distro of its own" : "on this computer's Docker";

/** The System Health fix that sets Orca's engine up. */
export const setupAction = () =>
  isMac() ? "setup_docker_macos" : isWindows() ? "setup_wsl_engine" : "install_docker_linux";
