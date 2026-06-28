/**
 * Shared current-Workspace state for the §31 control-plane views.
 *
 * The control views (Workspaces / Capsules / Graph / Activity / Add flow)
 * all operate on one "current Workspace". This module owns that selection so the
 * header workspace selector and every control view agree on it without prop
 * drilling.
 *
 * Persistence convention matches the existing dashboard screens, which remember
 * the last picked workspace in `localStorage` under `tg_apps_space_id` (see
 * legacy capsule-list and connection views). We reuse
 * the SAME key so a workspace picked in either world carries across both. The value
 * here is a deploy-control Workspace id (`workspace_...`), which is what the control
 * routes expect.
 */
import { createSignal } from "solid-js";

const STORAGE_KEY = "tg_apps_space_id";

function readInitial(): string {
  if (typeof localStorage === "undefined") return "";
  return localStorage.getItem(STORAGE_KEY) ?? "";
}

// Module-level singletons so every view shares one reactive source of truth.
const [currentWorkspaceId, setCurrentWorkspaceIdSignal] = createSignal(readInitial());

export { currentWorkspaceId };

export function selectAvailableWorkspaceId(
  current: string,
  workspaces: readonly { id: string }[],
): string {
  if (workspaces.length === 0) return "";
  const trimmed = current.trim();
  if (trimmed && workspaces.some((workspace) => workspace.id === trimmed)) return trimmed;
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
