/**
 * Shared current-Space state for the §31 control-plane views.
 *
 * The control views (Spaces / Installations / Graph / Activity / Install flow)
 * all operate on one "current Space". This module owns that selection so the
 * header space selector and every control view agree on it without prop
 * drilling.
 *
 * Persistence convention matches the existing dashboard screens, which remember
 * the last picked space in `localStorage` under `tg_apps_space_id` (see
 * views/installations/InstallationsListView.tsx + views/connections). We reuse
 * the SAME key so a space picked in either world carries across both. The value
 * here is a deploy-control Space id (`space_...`), which is what the control
 * routes expect.
 */
import { createSignal } from "solid-js";

const STORAGE_KEY = "tg_apps_space_id";

function readInitial(): string {
  if (typeof localStorage === "undefined") return "";
  return localStorage.getItem(STORAGE_KEY) ?? "";
}

// Module-level singletons so every view shares one reactive source of truth.
const [currentSpaceId, setCurrentSpaceIdSignal] = createSignal(readInitial());

export { currentSpaceId };

/** Set (and persist) the current Space id. Pass "" to clear. */
export function setCurrentSpaceId(spaceId: string): void {
  const next = spaceId.trim();
  setCurrentSpaceIdSignal(next);
  if (typeof localStorage === "undefined") return;
  if (next) localStorage.setItem(STORAGE_KEY, next);
  else localStorage.removeItem(STORAGE_KEY);
}
