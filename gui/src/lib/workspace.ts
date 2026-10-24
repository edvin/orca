// A team workspace: one repo with orca-workspace.yaml that sets up the
// shared services, network, gateway and the list of projects. See the
// daemon's /workspace API.

import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { DevJob } from "./dev";

export interface WorkspaceSecret {
  name: string;
  provider: "passbolt" | "1password";
  reference: string;
  /** A page that shows the value (Passbolt). */
  link: string | null;
  filled: boolean;
}

export interface WorkspaceProject {
  key: string;
  description: string | null;
  repo: string;
  dir: string;
  cloned: boolean;
  /** Its setup command ran on this machine. */
  set_up: boolean;
  stack: string | null;
  running: boolean;
  uses: string[];
  setup: string | null;
  urls: string[];
  secrets: WorkspaceSecret[];
  env_file?: string | null;
  /** The project's icon as an image src, when the workspace file sets one. */
  icon?: string | null;
  worktrees: boolean;
}

export interface WorkspaceStatus {
  joined: boolean;
  name?: string;
  description?: string | null;
  repo?: string;
  path?: string;
  /** The workspace file couldn't be read. */
  error?: string;
  network?: string | null;
  domain?: string;
  certificate?: "workspace" | "orca";
  /** What the last pull brought in. */
  last_update?: { at: string; commits: string[]; more: number } | null;
  /** The workspace's logo, also on the gateway's landing page. */
  logo?: string | null;
  shared?: { name: string; running: number; total: number } | null;
  shared_urls?: { title: string; url: string; icon?: string | null }[];
  registries?: { host: string; logged_in: boolean }[];
  secret_clis?: { passbolt: boolean; "1password": boolean };
  providers?: { passbolt: string | null; "1password": boolean };
  projects?: WorkspaceProject[];
}

export interface FolderSuggestion {
  /** Where the workspace goes, as ~/… */
  folder: string;
  /** Where its projects go: the folder that holds it. */
  parent: string;
  /** A copy of the workspace is already there; it's joined where it is. */
  existing: boolean;
  /** Git checkouts in that folder. */
  checkouts: number;
}

const call = <T>(method: string, path: string, body?: unknown) =>
  invoke<T>("workspace_api", { method, path, body: body ?? null });
const enc = encodeURIComponent;

export const workspaceApi = {
  status: () => call<WorkspaceStatus>("GET", "/workspace"),
  /** Where joining `repo` would clone it: next to the user's checkouts, or a copy already there. */
  suggestFolder: (repo: string) => call<FolderSuggestion>("GET", `/workspace/suggest-folder?repo=${enc(repo)}`),
  join: (repo: string, folder?: string) => call<DevJob>("POST", "/workspace/join", { repo, folder: folder || null }),
  update: () => call<DevJob>("POST", "/workspace/update"),
  leave: () => call<{ left: boolean }>("POST", "/workspace/leave"),
  setup: (key: string, rerunSetup = false) =>
    call<DevJob>("POST", `/workspace/projects/${enc(key)}/setup`, { rerun_setup: rerunSetup }),
  setEnv: (key: string, values: Record<string, string>) =>
    call<{ secrets: WorkspaceSecret[] }>("PUT", `/workspace/projects/${enc(key)}/env`, { values }),
  fetchSecrets: (key: string) =>
    call<{ filled: string[]; failed: { name: string; error: string }[]; secrets: WorkspaceSecret[] }>(
      "POST",
      `/workspace/projects/${enc(key)}/secrets`,
    ),
};

/** A repo to join, from an orca://workspace?repo=… link; the Workspace page picks it up. */
const [pendingJoin, setPendingJoin] = createSignal<string | null>(null);
export const pendingWorkspaceJoin = pendingJoin;
export const requestWorkspaceJoin = (repo: string) => setPendingJoin(repo);
export const clearWorkspaceJoin = () => setPendingJoin(null);

/**
 * A project to set up, from an orca://workspace?setup=<key> link (the
 * landing page's "Not set up" cards). The Workspace page shows it; setting
 * it up still takes a click.
 */
const [pendingSetup, setPendingSetup] = createSignal<string | null>(null);
export const pendingWorkspaceSetup = pendingSetup;
export const requestWorkspaceSetup = (key: string) => setPendingSetup(key);
export const clearWorkspaceSetup = () => setPendingSetup(null);
