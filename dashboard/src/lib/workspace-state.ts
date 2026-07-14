/**
 * Shared current-Workspace state for the §31 control-plane views.
 *
 * The control views (Workspaces / Capsules / Graph / Activity / Add flow)
 * all operate on one "current Workspace". This module owns that selection so the
 * header workspace selector and every control view agree on it without prop
 * drilling.
 *
 * The selected Workspace is persisted under one canonical dashboard key. The
 * value is opaque to the client and is passed only to Workspace-scoped APIs.
 */
import { createSignal } from "solid-js";

const STORAGE_KEY = "takosumi.currentWorkspaceId";

function readInitial(): string {
  if (typeof localStorage === "undefined") return "";
  return localStorage.getItem(STORAGE_KEY) ?? "";
}

// Module-level singletons so every view shares one reactive source of truth.
const [currentWorkspaceId, setCurrentWorkspaceIdSignal] =
  createSignal(readInitial());

export { currentWorkspaceId };

export function selectAvailableWorkspaceId(
  current: string,
  workspaces: readonly { id: string }[],
): string {
  if (workspaces.length === 0) return "";
  const trimmed = current.trim();
  if (trimmed && workspaces.some((workspace) => workspace.id === trimmed))
    return trimmed;
  return workspaces[0]!.id;
}

/** Set (and persist) the current Workspace id. Pass "" to clear. */
export function setCurrentWorkspaceId(workspaceId: string): void {
  const next = workspaceId.trim();
  setCurrentWorkspaceIdSignal(next);
  if (typeof localStorage === "undefined") return;
  if (next) localStorage.setItem(STORAGE_KEY, next);
  else localStorage.removeItem(STORAGE_KEY);
}
