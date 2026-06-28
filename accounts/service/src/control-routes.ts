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
 * `control/parse.ts` / `control/projection.ts`. Route ⇄ handler parity is
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
import type { SharedCellRuntimeAllocator } from "./runtime.ts";
import type { ControlPlaneOperations } from "./control-operations.ts";
import {
  type ControlDispatchContext,
  controllerErrorResponse,
  controlPlaneUnavailable,
} from "./control/shared.ts";
import { handleWorkspaces } from "./control/workspaces.ts";
import { handleDeploy } from "./control/deploy.ts";
import { handleCapsules } from "./control/capsules.ts";
import { handleInstallConfigs } from "./control/install-configs.ts";
import {
  handleProviders,
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
  completeCloudflareOAuth,
} from "./control/connections.ts";
import { handleOutputShares } from "./control/output-shares.ts";
import { handleBilling } from "./control/billing.ts";

// Re-exports keep the pre-split import surface stable for in-tree consumers
// (`mod.ts`, `control-personal-space.ts`, and the control-route tests).
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
 * Resource dispatch table, keyed by the NORMALIZED first path segment (after
 * {@link normalizePublicControlSegments} maps the public Workspace/Capsule/
 * StateVersion vocabulary onto the legacy segment names). This is the single
 * source of "which resource handler owns a route", and its key set is gated
 * against {@link control-route-inventory.ts} by the inventory parity test.
 */
const RESOURCE_HANDLERS: Partial<Record<string, ControlResourceHandler>> = {
  spaces: handleWorkspaces,
  deploy: handleDeploy,
  installations: handleCapsules,
  "install-configs": handleInstallConfigs,
  providers: handleProviders,
  "provider-connections": handleProviderConnections,
  dependencies: handleDependencies,
  sources: handleSources,
  "compatibility-reports": handleCompatibilityReports,
  deployments: handleStateVersions,
  runs: handleRuns,
  "run-groups": handleRunGroups,
  connections: handleConnections,
  "output-shares": handleOutputShares,
  billing: handleBilling,
};

/** Registered dispatch resource keys (for the inventory parity test). */
export const CONTROL_DISPATCH_RESOURCE_KEYS: readonly string[] =
  Object.keys(RESOURCE_HANDLERS);

/**
 * Maps a public `/api/v1` inventory path to the dispatch resource key that
 * serves it, applying the SAME normalization the live dispatcher uses. Returns
 * `undefined` for non-`/api/v1` paths. Used by the inventory parity test to
 * assert every declared route has a registered handler (and vice versa).
 */
export function controlInventoryResourceKey(path: string): string | undefined {
  if (!isApiV1Path(path)) return undefined;
  const tail = path.slice(API_V1_PREFIX.length);
  const segments = normalizePublicControlSegments(
    tail.split("/").filter(Boolean),
  );
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
  readonly sharedCellRuntime?: SharedCellRuntimeAllocator;
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
  const prefix = API_V1_PREFIX;

  // The credential-OAuth callback is the ONE control route reached by a
  // top-level CROSS-SITE redirect (dash.cloudflare.com -> this origin). The
  // browser sends no Authorization header and, because the `takosumi_session`
  // cookie is `SameSite=Strict`, does NOT send the session cookie either, so
  // `requireAccountSession` here would always 401 and the user would land on a
  // raw 401 JSON instead of being redirected back to /connections. The callback
  // therefore authenticates from the authenticated subject embedded in the
  // HMAC-signed OAuth state (minted by the cookie-authenticated `start`), not
  // from the session cookie. Route it BEFORE the session gate.
  if (isCloudflareOAuthCallbackPath(url.pathname, request.method, prefix)) {
    const operations = context.operations;
    if (!operations) return controlPlaneUnavailable();
    try {
      return await completeCloudflareOAuth(operations, store, url);
    } catch (error) {
      return controllerErrorResponse(error);
    }
  }

  // Authn gate: every other control route requires a live account session or a
  // scoped personal access token. The dashboard presents the HttpOnly
  // `takosumi_session` cookie; automation callers present a `takpat_*` bearer.
  // Workspace authorization is enforced per route below after the target Workspace is
  // known.
  const bearer = await requireAccountsBearer({
    request,
    store,
    scope: controlRouteRequiredScope(request),
  });
  if (!bearer.ok) return bearer.response;

  const operations = context.operations;
  if (!operations) return controlPlaneUnavailable();

  const tail = url.pathname.slice(prefix.length); // e.g. "/spaces"
  try {
    return await dispatch({
      request,
      url,
      tail,
      operations,
      store,
      session: { subject: bearer.auth.subject },
      sharedCellRuntime: context.sharedCellRuntime,
    });
  } catch (error) {
    return controllerErrorResponse(error);
  }
}

function controlRouteRequiredScope(
  request: Request,
): AccountsBearerRequiredScope {
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
 * True for `GET /api/v1/connections/cloudflare/oauth/callback`. This is the
 * only control route reached cross-site, so it is dispatched before the
 * `SameSite=Strict` session-cookie gate and authorizes from the signed OAuth
 * state instead (see {@link handleControlRoute}).
 */
function isCloudflareOAuthCallbackPath(
  pathname: string,
  method: string,
  prefix: string,
): boolean {
  return (
    method === "GET" &&
    pathname === `${prefix}/connections/cloudflare/oauth/callback`
  );
}

interface DispatchInput {
  readonly request: Request;
  readonly url: URL;
  readonly tail: string;
  readonly operations: ControlPlaneOperations;
  readonly store: AccountsStore;
  readonly session: { readonly subject: string };
  readonly sharedCellRuntime?: SharedCellRuntimeAllocator;
}

async function dispatch(input: DispatchInput): Promise<Response> {
  const segments = normalizePublicControlSegments(
    input.tail.split("/").filter(Boolean),
  );
  const method = input.request.method;
  const key = segments[0];
  const handler = key !== undefined ? RESOURCE_HANDLERS[key] : undefined;
  if (handler) {
    const ctx: ControlDispatchContext = {
      request: input.request,
      url: input.url,
      operations: input.operations,
      store: input.store,
      session: input.session,
      ...(input.sharedCellRuntime
        ? { sharedCellRuntime: input.sharedCellRuntime }
        : {}),
    };
    const response = await handler(ctx, segments, method);
    if (response) return response;
  }
  return errorJson("not_found", "not found", 404);
}

/**
 * Maps the public Workspace / Capsule / Capsule-config / StateVersion vocabulary
 * onto the legacy first-segment names the dispatch table and per-resource
 * handlers key on. Pure path normalization — no behavior change.
 */
function normalizePublicControlSegments(
  segments: readonly string[],
): readonly string[] {
  if (segments[0] === "capsule-configs") {
    return segments.map((segment, index) =>
      index === 0 ? "install-configs" : segment,
    );
  }
  if (segments[0] === "workspaces") {
    return segments.map((segment, index) =>
      index === 0
        ? "spaces"
        : index === 2 && segment === "capsules"
          ? "installations"
          : segment,
    );
  }
  if (segments[0] === "capsules") {
    return segments.map((segment, index) =>
      index === 0
        ? "installations"
        : index === 2 && segment === "state-versions"
          ? "deployments"
          : segment,
    );
  }
  if (segments[0] === "state-versions") {
    return segments.map((segment, index) =>
      index === 0 ? "deployments" : segment,
    );
  }
  return segments;
}
