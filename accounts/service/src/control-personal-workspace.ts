/**
 * Lazy personal-Workspace bootstrap (spec §4: "初回ログイン時に個人 Workspace を自動
 * 作成する") owned by the canonical Workspace list route.
 *
 * Identity reads such as `GET /v1/account/session/me` must remain read-only.
 * The Workspace list route already owns the deploy-control facade, so it can
 * await the domain's idempotent ensure before returning the first page. This
 * keeps every D1 operation inside the guarded request lifetime and avoids a
 * repeated create-and-collision write path on every authentication probe.
 */

import type { ControlPlaneOperations } from "./control-routes.ts";
import type { AccountsStore } from "./store.ts";
import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";

/**
 * Derives a preferred handle from the authenticated account and awaits the
 * deploy-control domain's idempotent ensure. The preferred handle is only
 * presentation input: durable bootstrap identity is owner-scoped, existing
 * owned personal Workspaces are eligible for deterministic adoption, and a
 * subject fallback plus a fresh domain-generated candidate handle foreign
 * claims. The returned promise never rejects so a best-effort bootstrap cannot
 * hide other accessible Workspaces.
 */
export async function maybeEnsurePersonalWorkspaceForSubject(input: {
  readonly subject: TakosumiSubject;
  readonly store: AccountsStore;
  readonly operations?: ControlPlaneOperations;
}): Promise<void> {
  try {
    const operations = input.operations;
    if (!operations?.workspaces.ensurePersonalWorkspace) return;
    const account = await input.store.findAccount(input.subject);
    const handle = personalWorkspaceHandle({
      subject: input.subject,
      email: account?.email,
      displayName: account?.displayName,
    });
    await operations.workspaces.ensurePersonalWorkspace(input.subject, handle);
  } catch {
    // Never let personal-Workspace bootstrap hide other accessible Workspaces.
  }
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
