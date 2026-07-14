/**
 * First-login personal-Workspace hook (spec §4: "初回ログイン時に個人 Workspace を自動
 * 作成する") wired on the account-session bootstrap route the dashboard hits
 * first (`GET /v1/account/session/me`).
 *
 * The OAuth/OIDC login seam does not own deploy-control operations; the
 * account-session bootstrap route does because the platform worker passes the
 * `controlPlaneOperations` facade. The idempotent ensure runs here as
 * fire-and-forget: a failed ensure must never fail the session read.
 */

import type { ControlPlaneOperations } from "./control-routes.ts";
import type { AccountsStore } from "./store.ts";
import { extractAccountSessionId } from "./account-session.ts";

/**
 * Resolves the presented session, derives a stable handle from the account, and
 * fires the idempotent `ensurePersonalWorkspace` against the deploy-control facade.
 *
 * Fire-and-forget by contract: the returned promise never rejects. Callers
 * (the session/me route) MUST NOT await it on the response path.
 */
export async function maybeEnsurePersonalWorkspaceForSession(input: {
  readonly request: Request;
  readonly store: AccountsStore;
  readonly operations?: ControlPlaneOperations;
}): Promise<void> {
  try {
    const operations = input.operations;
    if (!operations) return;
    const sessionId = extractAccountSessionId(input.request);
    if (!sessionId || !sessionId.startsWith("sess_")) return;
    const session = await input.store.findAccountSession(sessionId);
    if (!session || session.expiresAt < Date.now()) return;
    const account = await input.store.findAccount(session.subject);
    const handle = personalWorkspaceHandle({
      subject: session.subject,
      email: account?.email,
      displayName: account?.displayName,
    });
    await operations.workspaces
      .createWorkspace({
        handle,
        displayName: handle,
        type: "personal",
        ownerUserId: session.subject,
      })
      .catch((error) => {
        // A handle collision (`failed_precondition`) is the idempotent steady
        // state once the personal Workspace exists — swallow it. The deploy-control
        // facade has no accounts-side handle->Workspace index to do a pre-check, so
        // we lean on the unique-handle guard in `createWorkspace`.
        if (!isAlreadyTakenError(error)) {
          // Any other failure is best-effort too: log nothing here (no logger in
          // this package) and never propagate.
        }
      });
  } catch {
    // Never let the personal-Workspace hook fail the session bootstrap response.
  }
}

function isAlreadyTakenError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (error as { code?: unknown }).code === "failed_precondition";
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
