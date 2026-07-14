/**
 * In-process OpenTofu deployment-control-plane HTTP seam (Workspace-direct
 * Capsule model). This `core/api` Hono table is the `/internal/v1/*` seam
 * contract dialed in-process by the accounts composition; it is NOT edge-public.
 * The single edge-public deploy-control surface is `/api/v1/*`, owned by the
 * accounts router, which delegates to these `operations`. The canonical route
 * list is the composed `DEPLOY_CONTROL_INTERNAL_ENDPOINTS` descriptor inventory
 * below plus `docs/reference/deploy-control-api.md`; keep new routes in their
 * owning `deploy_control_*_routes.ts` slice instead of maintaining a
 * hand-written list in this header.
 *
 * The PlanRun / ApplyRun / operator execution boundary ledger routes and the
 * Capsule read plus StateVersion/Output reads used by the accounts
 * plane + CLI live on the same `/internal/v1/*` seam (see
 * `deploy-control-api.ts`); they are not surfaced through `/capabilities` or
 * `/openapi.json` and mount only when `mountInternalLedgerRoutes` is set.
 *
 * The handlers, their descriptor slices, and their 501 fallbacks are split into
 * per-resource-group sibling modules (`deploy_control_*_routes.ts`). This module
 * is the barrel: it composes them in mount order, derives the single
 * {@link DEPLOY_CONTROL_INTERNAL_ENDPOINTS} inventory from the group slices, and
 * drives the controller-absent 501 fallback by ITERATING that inventory instead
 * of re-listing every route. Shared auth / id-validation / runHandler primitives
 * + the {@link defineRoute} wrapper live in `deploy_control_shared.ts`.
 */

import type { Hono } from "hono";
import type { ApiEndpoint } from "./route_families.ts";
import {
  createDeployControlBodyLimit,
  type DeployControlEndpoint,
  type DeployControlInternalRouteDependencies,
  type DeployControlRouteContext,
  mountNotImplementedFromDescriptor,
} from "./deploy_control_shared.ts";
import { mountDeployControlLedgerRoutes } from "./deploy_control_ledger_routes.ts";
import {
  DEPLOY_CONTROL_CONNECTION_ENDPOINTS,
  mountDeployControlConnectionRoutes,
} from "./deploy_control_connection_routes.ts";
import {
  DEPLOY_CONTROL_CREDENTIAL_ENDPOINTS,
  mountDeployControlCredentialRoutes,
} from "./deploy_control_credential_routes.ts";
import {
  DEPLOY_CONTROL_SOURCE_ENDPOINTS,
  mountDeployControlSourceRoutes,
} from "./deploy_control_source_routes.ts";
import {
  DEPLOY_CONTROL_WORKSPACE_ENDPOINTS,
  mountDeployControlWorkspaceRoutes,
} from "./deploy_control_workspace_routes.ts";
import {
  DEPLOY_CONTROL_PROJECT_ENDPOINTS,
  mountDeployControlProjectRoutes,
} from "./deploy_control_project_routes.ts";
import {
  DEPLOY_CONTROL_CAPSULE_ENDPOINTS,
  mountDeployControlCapsuleRoutes,
} from "./deploy_control_capsule_routes.ts";
import {
  DEPLOY_CONTROL_RUN_ENDPOINTS,
  mountDeployControlRunRoutes,
} from "./deploy_control_run_routes.ts";
import {
  DEPLOY_CONTROL_DEPENDENCY_ENDPOINTS,
  mountDeployControlDependencyRoutes,
} from "./deploy_control_dependency_routes.ts";
import {
  DEPLOY_CONTROL_OUTPUT_SHARE_ENDPOINTS,
  mountDeployControlOutputShareRoutes,
} from "./deploy_control_output_share_routes.ts";
import {
  DEPLOY_CONTROL_RUN_GROUP_ENDPOINTS,
  mountDeployControlRunGroupRoutes,
} from "./deploy_control_run_group_routes.ts";
import {
  DEPLOY_CONTROL_ACTIVITY_ENDPOINTS,
  mountDeployControlActivityRoutes,
} from "./deploy_control_activity_routes.ts";
import {
  DEPLOY_CONTROL_BILLING_ENDPOINTS,
  mountDeployControlBillingRoutes,
} from "./deploy_control_billing_routes.ts";
import {
  DEPLOY_CONTROL_RESOURCE_STATE_ADOPTION_ENDPOINTS,
  mountDeployControlResourceStateAdoptionRoutes,
} from "./deploy_control_resource_state_adoption_routes.ts";

// Internal route-family entrypoint for shared dependency / principal types plus
// the body-limit constant used by app composition and route inventory.
export type {
  DeployControlBearerAuthorizationInput,
  DeployControlPrincipal,
  DeployControlInternalRouteDependencies,
} from "./deploy_control_shared.ts";
export { DEPLOY_CONTROL_JSON_BODY_LIMIT_BYTES } from "./deploy_control_shared.ts";

// Re-export route-path constants so existing in-process consumers keep compiling.
// The descriptor inventory below intentionally excludes the `/internal/v1`
// ledger seam; it is mounted for internal compatibility but is not discoverable
// through `/capabilities` or `/openapi.json`.
export * from "./deploy_control_route_paths.ts";

/**
 * The §30 `/internal/v1` deploy-control descriptor inventory, derived from the
 * per-resource-group slices in the SAME order they are mounted below. Consumed by
 * `route_families.ts` to derive `/capabilities` and `/openapi.json`, and
 * iterated by {@link mountNotImplementedRoutes} to drive the controller-absent
 * 501 fallback. The richer {@link DeployControlEndpoint} (with the per-route 501
 * message) is the lockstep source; this projection keeps the shared
 * {@link ApiEndpoint} shape for the route-family table.
 */
const DEPLOY_CONTROL_INTERNAL_ENDPOINTS_RICH: readonly DeployControlEndpoint[] =
  [
    ...DEPLOY_CONTROL_CONNECTION_ENDPOINTS,
  ...DEPLOY_CONTROL_CREDENTIAL_ENDPOINTS,
    ...DEPLOY_CONTROL_SOURCE_ENDPOINTS,
    ...DEPLOY_CONTROL_WORKSPACE_ENDPOINTS,
    ...DEPLOY_CONTROL_PROJECT_ENDPOINTS,
    ...DEPLOY_CONTROL_CAPSULE_ENDPOINTS,
    ...DEPLOY_CONTROL_RUN_ENDPOINTS,
    ...DEPLOY_CONTROL_DEPENDENCY_ENDPOINTS,
    ...DEPLOY_CONTROL_OUTPUT_SHARE_ENDPOINTS,
    ...DEPLOY_CONTROL_RUN_GROUP_ENDPOINTS,
    ...DEPLOY_CONTROL_ACTIVITY_ENDPOINTS,
    ...DEPLOY_CONTROL_BILLING_ENDPOINTS,
    ...DEPLOY_CONTROL_RESOURCE_STATE_ADOPTION_ENDPOINTS,
  ];

export const DEPLOY_CONTROL_INTERNAL_ENDPOINTS: readonly ApiEndpoint[] =
  DEPLOY_CONTROL_INTERNAL_ENDPOINTS_RICH;

export function mountDeployControlInternalRoutes(
  app: Hono,
  dependencies: DeployControlInternalRouteDependencies = {},
): void {
  const controller = dependencies.controller;

  if (!controller) {
    mountNotImplementedRoutes(app, dependencies);
    return;
  }

  const ctx: DeployControlRouteContext = {
    app,
    dependencies,
    controller,
    deployControlBodyLimit: createDeployControlBodyLimit(),
  };

  // The ledger routes are an internal compatibility seam and are deliberately
  // not part of the descriptor inventory above.
  if (dependencies.mountInternalLedgerRoutes === true) {
    mountDeployControlLedgerRoutes(ctx);
  }
  mountDeployControlConnectionRoutes(ctx);
  mountDeployControlCredentialRoutes(ctx);
  mountDeployControlSourceRoutes(ctx);
  mountDeployControlWorkspaceRoutes(ctx);
  mountDeployControlProjectRoutes(ctx);
  mountDeployControlCapsuleRoutes(ctx);
  mountDeployControlRunRoutes(ctx);
  mountDeployControlDependencyRoutes(ctx);
  mountDeployControlOutputShareRoutes(ctx);
  mountDeployControlRunGroupRoutes(ctx);
  mountDeployControlActivityRoutes(ctx);
  mountDeployControlBillingRoutes(ctx);
  mountDeployControlResourceStateAdoptionRoutes(ctx);
}

/**
 * Controller-absent fallback: every descriptor route answers 501
 * `not_implemented` after a successful auth. Driven by iterating
 * {@link DEPLOY_CONTROL_INTERNAL_ENDPOINTS_RICH} so it can no longer drift from
 * the descriptor inventory.
 */
function mountNotImplementedRoutes(
  app: Hono,
  dependencies: DeployControlInternalRouteDependencies,
): void {
  mountNotImplementedFromDescriptor(
    app,
    dependencies,
    DEPLOY_CONTROL_INTERNAL_ENDPOINTS_RICH,
  );
}
