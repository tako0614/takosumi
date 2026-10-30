/**
 * Personal-Workspace bootstrap helpers. Since TASK-0118 P9.1-c no read route
 * (the Workspace list included) creates or repairs a personal Workspace; the
 * internal personal namespace is filled only by writes that need it.
 */

import type { ControlPlaneOperations } from "./control-routes.ts";
import type { TakosumiAccountRecord } from "./store.ts";
import type { Workspace } from "takosumi-contract/workspaces";

/**
 * Strict shared-account login bootstrap. The caller must resolve a current
 * canonical account before entering this seam. Fresh creation and initial
 * owner membership share the Workspace domain's durable owner claim. Existing
 * namespaces require current owner membership and are never repaired here.
 * Failures propagate.
 */
export async function ensurePersonalWorkspaceForAccount(input: {
  readonly account: TakosumiAccountRecord;
  readonly operations: Pick<ControlPlaneOperations, "workspaces">;
}): Promise<Workspace> {
  const ensure = input.operations.workspaces.ensurePersonalWorkspaceForSharedAccount;
  if (!ensure) throw new Error("Personal Workspace bootstrap is unavailable.");
  const workspace = await ensure.call(
    input.operations.workspaces,
    input.account.subject,
    personalWorkspaceHandle({
      subject: input.account.subject,
      email: input.account.email,
      displayName: input.account.displayName,
    }),
  );
  if (workspace.type !== "personal" || workspace.ownerUserId !== input.account.subject) {
    throw new Error("Personal Workspace bootstrap returned a different owner.");
  }
  return workspace;
}

/**
 * Derives a personal-Workspace handle from the account, sanitized to the Workspace
 * handle rule (`^[a-z0-9][a-z0-9-]{1,38}$`, length 2..39). Preference order:
 *   1. displayName (slugified),
 *   2. email local-part (slugified),
 *   3. `u-<short subject>` fallback.
 * The chosen candidate is sanitized + length-clamped; an unusable candidate
 * falls through to the next source, and the final fallback is always valid.
 */
export function personalWorkspaceHandle(input: {
  readonly subject: string;
  readonly email?: string;
  readonly displayName?: string;
}): string {
  const candidates: string[] = [];
  if (input.displayName) candidates.push(input.displayName);
  if (input.email) {
    const localPart = input.email.split("@")[0];
    if (localPart) candidates.push(localPart);
  }
  for (const candidate of candidates) {
    const handle = sanitizeHandle(candidate);
    if (handle) return handle;
  }
  return fallbackHandle(input.subject);
}

/**
 * Lowercases, replaces non-`[a-z0-9-]` runs with a hyphen, trims leading/
 * trailing hyphens, ensures a leading alnum, and clamps to 39 chars. Returns
 * `undefined` when nothing usable (length < 2) remains.
 */
function sanitizeHandle(raw: string): string | undefined {
  let handle = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  // The handle rule requires a leading alnum; drop any non-alnum head.
  handle = handle.replace(/^[^a-z0-9]+/, "");
  if (handle.length < 2) return undefined;
  return handle.slice(0, 39).replace(/-+$/, "");
}

/**
 * `u-<short subject>` — always a valid handle. The subject is sanitized the
 * same way and clamped so the total stays within the 39-char limit.
 */
function fallbackHandle(subject: string): string {
  const tail = subject
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 36);
  return `u-${tail.length > 0 ? tail : "anon"}`.slice(0, 39);
}
