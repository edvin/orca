import { createSignal } from "solid-js";

export type OllamaSetupState = "idle" | "running" | "done" | "error";

const [setupState, setSetupState] = createSignal<OllamaSetupState>("idle");
const [setupStatus, setSetupStatus] = createSignal("");

export function getOllamaSetupState() { return setupState(); }
export function getOllamaSetupStatus() { return setupStatus(); }
export function isOllamaSetupRunning() { return setupState() === "running"; }

export function updateOllamaSetup(state: OllamaSetupState, status: string) {
  setSetupState(state);
  setSetupStatus(status);
}
