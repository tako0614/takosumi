/**
 * Which apps an account-level read may cover (TASK-0118 Phase 9.1).
 *
 * Account-level replacement reads (`GET /api/v1/activity`, the bootstrap
 * notification feed, the account launcher) never consult Workspace
 * membership. They cover exactly the apps the caller owns or is a member of,
 * narrowed by the credential's own limits: a PAT's `appIds`, and an installed
 * app's own OAuth token (its `appIds` is its own app). Credentials that carry
 * a Workspace restriction or the trusted shared-account composition re-run
 * the ordinary per-app decision for each candidate, so a restricted
 * credential never covers more than the per-app routes would allow it.
 */
import type { Capsule } from "takosumi-contract/install-configs";
import { errorJson } from "../http-helpers.ts";
import { requireAppAccess } from "./app-authorization.ts";
import {
  controlPlaneUnavailable,
  installedAppTokenDelegates,
  isInstalledAppToken,
  type ControlDispatchContext,
} from "./shared.ts";

/** Accessible-app pages one account-level read may enumerate (100 apps each). */
const ACCOUNT_APP_PAGE_LIMIT = 20;

export interface AccountAppScope {
  /** Capsule ids the caller may view through this credential. */
  readonly appIds: ReadonlySet<string>;
  /** The Capsules for `appIds` that still exist (any status). */
  readonly capsules: ReadonlyMap<string, Capsule>;
  /** False when the accessible-app listing stopped at its page budget. */
  readonly complete: boolean;
}

export type AccountAppScopeResult =
  | { readonly ok: true; readonly scope: AccountAppScope }
  | { readonly ok: false; readonly response: Response };

/**
 * A legacy Workspace-scoped credential without an app list has no per-app
 * limit to intersect with, so it cannot use an account-level read.
 */
export function accountReadCredentialRefusal(
  ctx: ControlDispatchContext,
): Response | undefined {
  return ctx.session.workspaceId !== undefined && ctx.session.appIds === undefined
    ? errorJson(
      "app_access_denied",
      "A Workspace-scoped credential cannot read account-wide app data; use an account session or an app-scoped token.",
      403,
      ctx.request,
    )
    : undefined;
}

function restrictedCredential(ctx: ControlDispatchContext): boolean {
  const session = ctx.session;
  return session.credential === "oauth-access-token" ||
    session.workspaceId !== undefined ||
    session.requireCurrentMembership === true;
}

export async function resolveAccountAppScope(
  ctx: ControlDispatchContext,
  options: {
    /**
     * An operator-designated delegate app's own token (Takos) acts for its
     * user on the user's other apps: skip its own-app list and let the
     * per-app decision (which applies the delegation rules) decide each app.
     */
    readonly expandDelegate?: boolean;
  } = {},
): Promise<AccountAppScopeResult> {
  const refused = accountReadCredentialRefusal(ctx);
  if (refused) return { ok: false, response: refused };
  const resolver = ctx.operations.appAccess;
  if (!resolver) return { ok: false, response: controlPlaneUnavailable() };
  const accessible = new Set<string>();
  let cursor: string | undefined;
  let complete = false;
  for (let page = 0; page < ACCOUNT_APP_PAGE_LIMIT; page++) {
    ctx.assertActive?.();
    const result = await resolver.listAccessibleApps(ctx.session.subject, {
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    for (const app of result.apps) {
      if (app.role === "owner" || app.role === "member") accessible.add(app.capsuleId);
    }
    if (!result.nextCursor) {
      complete = true;
      break;
    }
    cursor = result.nextCursor;
  }
  const delegated = options.expandDelegate === true && isInstalledAppToken(ctx.session) &&
    await installedAppTokenDelegates(ctx.operations, ctx.session);
  const limited = ctx.session.appIds === undefined || delegated
    ? [...accessible]
    : [...accessible].filter((id) => ctx.session.appIds!.includes(id));
  const capsules = limited.length > 0
    ? await ctx.operations.capsules.getCapsulesByIds(limited)
    : [];
  const byId = new Map<string, Capsule>();
  for (const capsule of capsules) {
    if (limited.includes(capsule.id)) byId.set(capsule.id, capsule);
  }
  if (restrictedCredential(ctx)) {
    // The ordinary per-app decision applies the token's own limits (the
    // installed app's own app, a Workspace restriction, current membership).
    for (const capsule of [...byId.values()]) {
      const decision = await requireAppAccess({
        operations: ctx.operations,
        store: ctx.store,
        session: ctx.session,
        workspaceId: capsule.workspaceId,
        capsuleId: capsule.id,
        capsule,
        action: "view",
        ...(ctx.assertActive ? { assertActive: ctx.assertActive } : {}),
        ...(ctx.diagnostics ? { diagnostics: ctx.diagnostics } : {}),
      });
      if (!decision.ok) byId.delete(capsule.id);
    }
  }
  return {
    ok: true,
    scope: { appIds: new Set(byId.keys()), capsules: byId, complete },
  };
}
