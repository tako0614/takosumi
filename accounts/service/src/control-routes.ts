/**
 * Account-plane session-authed deploy-control pass-through routes (spec §31 UI
 * backing surface, conformance M10).
 *
 * The dashboard SPA (served by the platform worker) authenticates with the
 * ACCOUNTS-plane session cookie, not the operator deploy-control bearer. This
 * is the edge-public `/api/v1/*` deploy-control surface the dashboard calls
 * same-origin; the operator-bearer-gated contract is served in-process under
 * the `/internal/v1` seam.
 *
 * This module is the THIN SHELL after the P3 god-file split: it owns the
 * single authn entry point, the `/api/v1` ownership predicate, and a
 * resource-keyed dispatch table. The per-resource request handlers (auth,
 * ownership gate, validation, error mapping, response shapes — all unchanged)
 * live in `control/<resource>.ts`; the `ControlPlaneOperations` facade lives in
 * `control-operations.ts`; cross-cutting helpers live in `control/shared.ts` /
 * `control/parse.ts`. Route ⇄ handler parity is
 * gated by `control-route-inventory.ts` (see {@link controlInventoryResourceKey}
 * and the inventory parity test).
 *
 * Authorization: every handler requires an authenticated account session or
 * PAT (anonymous -> 401) and then enforces that the bearer subject owns the
 * target deploy-control Workspace (`Workspace.ownerUserId`) or owns the accounts-ledger
 * account that contains that Workspace.
 */

import { isApiV1Path, API_V1_PREFIX } from "takosumi-contract";
import { errorJson } from "./http-helpers.ts";
import {
  requireAccountsBearer,
  type AccountsBearerRequiredScope,
} from "./account-session.ts";
import type { AccountsStore } from "./store.ts";
import type { ControlPlaneOperations } from "./control-operations.ts";
import {
  type ControlDispatchContext,
  type ControlSession,
  controllerErrorResponse,
  controlPlaneUnavailable,
} from "./control/shared.ts";
import { handleWorkspaces } from "./control/workspaces.ts";
import { handleCapsules } from "./control/capsules.ts";
import { handleInstallConfigs } from "./control/install-configs.ts";
import {
  handleCredentialRecipes,
  handleProviderConnections,
} from "./control/providers.ts";
import { handleDependencies } from "./control/dependencies.ts";
import {
  handleSources,
  handleCompatibilityReports,
} from "./control/sources.ts";
import { handleStateVersions } from "./control/state-versions.ts";
import { handleRuns, handleRunGroups } from "./control/runs.ts";
import {
  handleConnections,
  completeConnectionOAuth,
} from "./control/connections.ts";
import { handleOutputShares } from "./control/output-shares.ts";
import { handleDashboard } from "./control/dashboard.ts";
import {
  accountWorkspaceInventoryForbiddenResponse,
  handleAccountWorkspaceViews,
  isAccountWorkspaceInventorySegments,
} from "./control/account-workspace-views.ts";
import { handleProjects } from "./control/projects.ts";
import {
  appendServerTiming,
  measureServerTiming,
  serverTimingBucketForPath,
  type ServerTimingBucket,
} from "./server-timing.ts";

// Re-exports keep the pre-split import surface stable for in-tree consumers
// (`mod.ts`, `control-personal-workspace.ts`, and the control-route tests).
export type {
  ControlPlaneOperations,
  RunGroupWithRunsLike,
  ControlWorkspaceRole,
  ControlMembershipStatus,
  PublicWorkspaceMember,
} from "./control-operations.ts";
export { canAccessWorkspace } from "./control/shared.ts";

/** A per-resource request handler. Returns `undefined` to fall through to 404. */
type ControlResourceHandler = (
  ctx: ControlDispatchContext,
  segments: readonly string[],
  method: string,
) => Promise<Response | undefined>;

/**
 * Resource dispatch table, keyed directly by the public v1 resource name. This
 * is the single source of "which resource handler owns a route", and its key
 * set is gated against {@link control-route-inventory.ts} by the inventory
 * parity test.
 */
const RESOURCE_HANDLERS: Partial<Record<string, ControlResourceHandler>> = {
  workspaces: handleWorkspaces,
  projects: handleProjects,
  capsules: handleCapsules,
  "capsule-configs": handleInstallConfigs,
  "credential-recipes": handleCredentialRecipes,
  "provider-connections": handleProviderConnections,
  dependencies: handleDependencies,
  sources: handleSources,
  "compatibility-reports": handleCompatibilityReports,
  "state-versions": handleStateVersions,
  runs: handleRuns,
  "run-groups": handleRunGroups,
  connections: handleConnections,
  "output-shares": handleOutputShares,
  dashboard: handleDashboard,
  views: handleAccountWorkspaceViews,
};

/**
 * Retired public route roots from the pre-v1 control surface. They are rejected
 * instead of being translated into the canonical v1 resources.
 */
const RETIRED_PUBLIC_CONTROL_SEGMENTS = new Set([
  "spaces",
  "installations",
  "install-configs",
  "deployments",
]);

/** Registered dispatch resource keys (for the inventory parity test). */
export const CONTROL_DISPATCH_RESOURCE_KEYS: readonly string[] =
  Object.keys(RESOURCE_HANDLERS);

/**
 * Maps a public `/api/v1` inventory path to the dispatch resource key that
 * serves it. Returns `undefined` for non-`/api/v1` paths. Used by the inventory
 * parity test to assert every declared route has a registered handler (and vice
 * versa).
 */
export function controlInventoryResourceKey(path: string): string | undefined {
  if (!isApiV1Path(path)) return undefined;
  const tail = path.slice(API_V1_PREFIX.length);
  const segments = tail.split("/").filter(Boolean);
  return segments[0];
}

/**
 * True for any path this session-authed control surface owns: the edge-public
 * {@link API_V1_PREFIX} (`/api/v1`). Used by `mod.ts` to route into
 * {@link handleControlRoute} before the generic 404.
 */
export function isControlRoutePath(pathname: string): boolean {
  return isApiV1Path(pathname);
}

interface ControlRouteContext {
  readonly request: Request;
  readonly url: URL;
  readonly store: AccountsStore;
  readonly operations?: ControlPlaneOperations;
  readonly resolveOperations?: () => Promise<
    ControlPlaneOperations | undefined
  >;
  readonly issuer?: string;
  readonly managedPublicBaseDomain?: string;
}

/**
 * Dispatches the public control surface after a composition root has already
 * authenticated one exact Accounts subject.
 *
 * This is an in-process authority seam, not another HTTP authentication path:
 * callers must not expose it directly. The normal account-session/PAT route
 * below remains the public entrypoint. Runtime adapters such as the optional
 * operator-control MCP route use this seam only after current Interface OAuth
 * introspection and then retain every existing per-Workspace membership gate,
 * controller policy check, saved-plan guard, Run/state/output update, and audit
 * write implemented by the public handlers.
 */
export async function handleAuthenticatedControlRoute(
  context: ControlRouteContext & {
    readonly subject: string;
    readonly workspaceId?: string;
  },
): Promise<Response | undefined> {
  const { request, url } = context;
  if (!isApiV1Path(url.pathname)) return undefined;
  const timings = serverTimingBucketForPath(url.pathname);
  return await dispatchAuthenticatedControlRoute(
    {
      ...context,
      session: {
        subject: context.subject,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
        requiredAccess: controlRouteRequiredScope(request),
      },
    },
    timings,
  );
}

async function dispatchAuthenticatedControlRoute(
  context: ControlRouteContext & { readonly session: ControlSession },
  timings: ServerTimingBucket,
): Promise<Response> {
  const { request, url } = context;
  const tail = url.pathname.slice(API_V1_PREFIX.length);
  const segments = normalizeControlRouteSegments(tail);

  // The account-wide Workspace inventory is intentionally unavailable to a
  // Workspace-scoped credential. Keep this fence before resolving the Control
  // operations facade: a rejected request must not initialize or otherwise
  // touch the Control D1/store substrate. The handler repeats the same guard
  // for direct composition callers.
  if (
    request.method.toUpperCase() === "GET" &&
    isAccountWorkspaceInventorySegments(segments) &&
    context.session.workspaceId !== undefined
  ) {
    return appendServerTiming(
      accountWorkspaceInventoryForbiddenResponse(),
      timings,
    );
  }

  let operations = context.operations;
  if (!operations && context.resolveOperations) {
    operations = await measureServerTiming(
      timings,
      "tk_control_init",
      context.resolveOperations,
    );
  }
  if (!operations)
    return appendServerTiming(controlPlaneUnavailable(), timings);
  try {
    const response = await measureServerTiming(
      timings,
      "tk_control_dispatch",
      () =>
        dispatch({
          request,
          url,
          tail,
          operations,
          store: context.store,
          ...(context.issuer ? { issuer: context.issuer } : {}),
          ...(context.managedPublicBaseDomain
            ? { managedPublicBaseDomain: context.managedPublicBaseDomain }
            : {}),
          session: context.session,
        }),
    );
    return appendServerTiming(response, timings);
  } catch (error) {
    return appendServerTiming(controllerErrorResponse(error), timings);
  }
}

/**
 * Single entry point for the `/api/v1/*` family. Authenticates the account
 * session/PAT ONCE (anonymous -> 401), then dispatches to the matched sub-route.
 * Returns `undefined` only when the path is not owned by this family (so the
 * caller can fall through to its own 404).
 */
export async function handleControlRoute(
  context: ControlRouteContext,
): Promise<Response | undefined> {
  const { request, url, store } = context;
  if (!isApiV1Path(url.pathname)) return undefined;
  const timings = serverTimingBucketForPath(url.pathname);
  const prefix = API_V1_PREFIX;

  // The credential-OAuth callback is the ONE control route reached by a
  // top-level CROSS-SITE redirect (dash.cloudflare.com -> this origin). The
  // browser sends no Authorization header, and privacy/cookie policy can still
  // withhold the session cookie, so `requireAccountSession` would make the
  // callback brittle. The callback therefore authenticates from the
  // authenticated subject embedded in the HMAC-signed OAuth state (minted by
  // the cookie-authenticated `start`), not from the session cookie. Route it
  // BEFORE the session gate.
  const connectionOAuthHelperId = connectionOAuthCallbackHelperId(
    url.pathname,
    request.method,
    prefix,
  );
  if (connectionOAuthHelperId) {
    const operations =
      context.operations ??
      (context.resolveOperations
        ? await measureServerTiming(
            timings,
            "tk_control_init",
            context.resolveOperations,
          )
        : undefined);
    if (!operations) return controlPlaneUnavailable();
    try {
      return await completeConnectionOAuth(
        operations,
        store,
        url,
        connectionOAuthHelperId,
      );
    } catch (error) {
      return controllerErrorResponse(error);
    }
  }

  // Authn gate: every other control route requires a live account session or a
  // scoped personal access token. The dashboard presents the HttpOnly
  // `takosumi_session` cookie; automation callers present an opaque PAT bearer.
  // Workspace authorization is enforced per route below after the target Workspace is
  // known.
  const bearer = await measureServerTiming(timings, "tk_control_auth", () =>
    requireAccountsBearer({
      request,
      store,
      scope: controlRouteRequiredScope(request),
    }),
  );
  if (!bearer.ok) return appendServerTiming(bearer.response, timings);

  return await dispatchAuthenticatedControlRoute(
    {
      ...context,
      session: {
        subject: bearer.auth.subject,
        ...(bearer.auth.workspaceId
          ? { workspaceId: bearer.auth.workspaceId }
          : {}),
        requiredAccess: controlRouteRequiredScope(request),
      },
    },
    timings,
  );
}

function controlRouteRequiredScope(
  request: Request,
): Exclude<AccountsBearerRequiredScope, "admin"> {
  switch (request.method.toUpperCase()) {
    case "GET":
    case "HEAD":
    case "OPTIONS":
      return "read";
    default:
      return "write";
  }
}

/**
 * Returns the opaque helper id for `GET /api/v1/connections/oauth/:id/callback`.
 * only control route reached cross-site, so it is dispatched before the
 * session-cookie gate and authorizes from the signed OAuth state instead
 * (see {@link handleControlRoute}).
 */
function connectionOAuthCallbackHelperId(
  pathname: string,
  method: string,
  prefix: string,
): string | undefined {
  if (method !== "GET") return undefined;
  const match = pathname.match(
    new RegExp(`^${prefix}/connections/oauth/([^/]+)/callback$`, "u"),
  );
  if (!match?.[1]) return undefined;
  try {
    const helperId = decodeURIComponent(match[1]);
    return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(helperId)
      ? helperId
      : undefined;
  } catch {
    return undefined;
  }
}

interface DispatchInput {
  readonly request: Request;
  readonly url: URL;
  readonly tail: string;
  readonly operations: ControlPlaneOperations;
  readonly store: AccountsStore;
  readonly issuer?: string;
  readonly managedPublicBaseDomain?: string;
  readonly session: ControlSession;
}

async function dispatch(input: DispatchInput): Promise<Response> {
  const rawSegments = normalizeControlRouteSegments(input.tail);
  if (RETIRED_PUBLIC_CONTROL_SEGMENTS.has(rawSegments[0] ?? "")) {
    return errorJson("not_found", "not found", 404);
  }
  const segments = rawSegments;
  const method = input.request.method;
  const key = segments[0];
  const handler = key !== undefined ? RESOURCE_HANDLERS[key] : undefined;
  if (handler) {
    const ctx: ControlDispatchContext = {
      request: input.request,
      url: input.url,
      operations: input.operations,
      store: input.store,
      ...(input.issuer ? { issuer: input.issuer } : {}),
      ...(input.managedPublicBaseDomain
        ? { managedPublicBaseDomain: input.managedPublicBaseDomain }
        : {}),
      session: input.session,
    };
    const response = await handler(ctx, segments, method);
    if (response) return response;
  }
  return errorJson("not_found", "not found", 404);
}

function normalizeControlRouteSegments(tail: string): string[] {
  return tail.split("/").filter(Boolean);
}
