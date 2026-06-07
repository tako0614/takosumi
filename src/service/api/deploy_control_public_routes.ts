/**
 * Public OpenTofu deployment-control-plane HTTP surface (Space-direct
 * Installation model). Spec §30: the public vocabulary is mounted under `/api`
 * with NO version prefix.
 *
 *   POST  /api/spaces ; GET /api/spaces ; GET /api/spaces/{spaceId}
 *   PATCH /api/spaces/{spaceId}                        (displayName only — MVP)
 *   POST  /api/sources ; GET /api/sources ; GET /api/sources/{id}
 *   POST  /api/sources/{id}/sync ; POST /hooks/sources/{id}
 *   POST  /api/connections/source/https-token
 *   POST  /api/connections/source/ssh-key
 *   POST  /api/connections/cloudflare/token
 *   POST  /api/connections/aws/assume-role
 *   GET   /api/connections
 *   POST  /api/connections/{id}/test ; POST /api/connections/{id}/revoke
 *   POST  /api/spaces/{spaceId}/installations
 *   GET   /api/spaces/{spaceId}/installations
 *   GET   /api/installations/{id}
 *   PATCH /api/installations/{id}                 (safe status patch only)
 *   DELETE /api/installations/{id}                (creates destroy-plan Run)
 *   GET   /api/install-configs
 *   POST  /api/installations/{id}/dependencies
 *   GET   /api/installations/{id}/dependencies
 *   DELETE /api/dependencies/{dependencyId}
 *   POST/GET /api/output-shares ; POST /api/output-shares/{shareId}/approve
 *   POST /api/output-shares/{shareId}/revoke
 *   POST  /api/installations/{id}/plan ; /destroy-plan
 *   GET   /api/runs/{id} ; /logs ; /events
 *   POST  /api/runs/{id}/approve ; /cancel
 *   POST  /api/spaces/{spaceId}/plan-update
 *   GET   /api/run-groups/{id} ; POST /api/run-groups/{id}/approve
 *   GET   /api/installations/{id}/deployments
 *   GET   /api/deployments/{id}
 *   POST  /api/deployments/{id}/rollback-plan
 *   GET   /api/spaces/{spaceId}/activity
 *   GET/PUT /api/operator-connection-defaults
 *
 * The PlanRun / ApplyRun / RunnerProfile ledger routes and the Installation
 * read (+ deployments / deployment-outputs) used by the accounts plane + CLI
 * stay on the INTERNAL `/v1/*` seam (see `deploy-control-api.ts`); they are NOT
 * part of the §30 public vocabulary.
 *
 * The handlers, their descriptor slices, and their 501 fallbacks are split into
 * per-resource-group sibling modules (`deploy_control_*_routes.ts`). This module
 * is the barrel: it composes them in mount order, derives the single
 * {@link DEPLOY_CONTROL_PUBLIC_ENDPOINTS} inventory from the group slices, and
 * drives the controller-absent 501 fallback by ITERATING that inventory instead
 * of re-listing every route. Shared auth / id-validation / runHandler primitives
 * + the {@link defineRoute} wrapper live in `deploy_control_shared.ts`.
 */

import type { Hono } from "hono";
import type { ApiEndpoint } from "./route_families.ts";
import {
  createDeployControlBodyLimit,
  type DeployControlEndpoint,
  type DeployControlPublicRouteDependencies,
  type DeployControlRouteContext,
  mountNotImplementedFromDescriptor,
} from "./deploy_control_shared.ts";
import {
  mountDeployControlLedgerRoutes,
} from "./deploy_control_ledger_routes.ts";
import {
  DEPLOY_CONTROL_CONNECTION_ENDPOINTS,
  mountDeployControlConnectionRoutes,
} from "./deploy_control_connection_routes.ts";
import {
  DEPLOY_CONTROL_SOURCE_ENDPOINTS,
  mountDeployControlSourceRoutes,
} from "./deploy_control_source_routes.ts";
import {
  DEPLOY_CONTROL_SPACE_ENDPOINTS,
  mountDeployControlSpaceRoutes,
} from "./deploy_control_space_routes.ts";
import {
  DEPLOY_CONTROL_INSTALLATION_ENDPOINTS,
  mountDeployControlInstallationRoutes,
} from "./deploy_control_installation_routes.ts";
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

// Re-export the shared dependency / principal types + the body-limit constant so
// existing importers (`app.ts`, the route-family table) keep their import paths.
export type {
  DeployControlBearerAuthorizationInput,
  DeployControlPrincipal,
  DeployControlPublicRouteDependencies,
} from "./deploy_control_shared.ts";
export { DEPLOY_CONTROL_JSON_BODY_LIMIT_BYTES } from "./deploy_control_shared.ts";

// Re-export route-path constants so existing in-process consumers keep compiling.
// The descriptor inventory below intentionally excludes the legacy `/v1`
// ledger seam; it is mounted for internal compatibility but is not discoverable
// through `/capabilities` or `/openapi.json`.
export * from "./deploy_control_route_paths.ts";

/**
 * The §30 `/api` deploy-control descriptor inventory, derived from the
 * per-resource-group slices in the SAME order they are mounted below. Consumed by
 * `route_families.ts` to derive `/capabilities` and `/openapi.json`, and
 * iterated by {@link mountNotImplementedRoutes} to drive the controller-absent
 * 501 fallback. The richer {@link DeployControlEndpoint} (with the per-route 501
 * message) is the lockstep source; this projection keeps the public
 * {@link ApiEndpoint} shape for the route-family table.
 */
const DEPLOY_CONTROL_PUBLIC_ENDPOINTS_RICH: readonly DeployControlEndpoint[] = [
  ...DEPLOY_CONTROL_CONNECTION_ENDPOINTS,
  ...DEPLOY_CONTROL_SOURCE_ENDPOINTS,
  ...DEPLOY_CONTROL_SPACE_ENDPOINTS,
  ...DEPLOY_CONTROL_INSTALLATION_ENDPOINTS,
  ...DEPLOY_CONTROL_RUN_ENDPOINTS,
  ...DEPLOY_CONTROL_DEPENDENCY_ENDPOINTS,
  ...DEPLOY_CONTROL_OUTPUT_SHARE_ENDPOINTS,
  ...DEPLOY_CONTROL_RUN_GROUP_ENDPOINTS,
  ...DEPLOY_CONTROL_ACTIVITY_ENDPOINTS,
];

export const DEPLOY_CONTROL_PUBLIC_ENDPOINTS: readonly ApiEndpoint[] =
  DEPLOY_CONTROL_PUBLIC_ENDPOINTS_RICH;

export function mountDeployControlPublicRoutes(
  app: Hono,
  dependencies: DeployControlPublicRouteDependencies = {},
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

  // Mount order mirrors the original single-file enumeration. The ledger routes
  // are an internal compatibility seam and are deliberately not part of the
  // public descriptor inventory above.
  mountDeployControlLedgerRoutes(ctx);
  mountDeployControlConnectionRoutes(ctx);
  mountDeployControlSourceRoutes(ctx);
  mountDeployControlSpaceRoutes(ctx);
  mountDeployControlInstallationRoutes(ctx);
  mountDeployControlRunRoutes(ctx);
  mountDeployControlDependencyRoutes(ctx);
  mountDeployControlOutputShareRoutes(ctx);
  mountDeployControlRunGroupRoutes(ctx);
  mountDeployControlActivityRoutes(ctx);
}

/**
 * Controller-absent fallback: every §30 descriptor route answers 501
 * `not_implemented` after a successful auth. Driven by iterating
 * {@link DEPLOY_CONTROL_PUBLIC_ENDPOINTS_RICH} so it can no longer drift from the
 * descriptor inventory. The operator-connection-default routes are intentionally
 * NOT in this fallback (matching the original): they are mounted only when a
 * controller is present.
 */
function mountNotImplementedRoutes(
  app: Hono,
  dependencies: DeployControlPublicRouteDependencies,
): void {
  mountNotImplementedFromDescriptor(
    app,
    dependencies,
    DEPLOY_CONTROL_PUBLIC_ENDPOINTS_RICH,
  );
}
