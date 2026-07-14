/**
 * Plan / Apply run ledger + operator execution boundary routes.
 * The Capsule + StateVersion reads (`/internal/v1/capsules/:id` and
 * `.../state-versions`) are owned solely by the Capsule route group
 * (`mountDeployControlCapsuleRoutes`); they used to be duplicated here as a
 * separate `/v1` seam, but once both groups collapsed onto `/internal/v1` the
 * registrations became byte-identical, so the duplicate is removed.
 * This group owns its handlers and an internal descriptor slice used only for
 * route metadata; it is intentionally excluded from the internal descriptor
 * inventory surfaced by `/capabilities` and `/openapi.json`.
 */

import type {
  CreateApplyRunRequest,
  CreatePlanRunRequest,
} from "@takosumi/internal/deploy-control-api";
import {
  defineRoute,
  type DeployControlEndpoint,
  type DeployControlRouteContext,
  ensureApplyPermission,
  ensurePlanCreatePermission,
  ensureWorkspacePermission,
  filterRunnerProfilesForPrincipal,
  readJsonBody,
} from "./deploy_control_shared.ts";
import {
  TAKOSUMI_APPLY_RUN_ROUTE,
  TAKOSUMI_APPLY_RUNS_ROUTE,
  TAKOSUMI_PLAN_RUN_ROUTE,
  TAKOSUMI_PLAN_RUNS_ROUTE,
  TAKOSUMI_RUNNER_PROFILES_ROUTE,
} from "./deploy_control_route_paths.ts";

export const DEPLOY_CONTROL_LEDGER_ENDPOINTS: readonly DeployControlEndpoint[] =
  [
    {
      method: "GET",
      path: TAKOSUMI_RUNNER_PROFILES_ROUTE,
      summary:
        "Lists operator execution boundaries and provider allowlists for the OpenTofu runner seam.",
      auth: "deploy-control-token",
      operationId: "listRunnerProfiles",
      openapi: { okSchema: "ListRunnerProfilesResponse" },
      notImplementedMessage: "operator execution boundaries not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_PLAN_RUNS_ROUTE,
      summary:
        "Creates an OpenTofu plan run for a Git-backed Capsule source.",
      auth: "deploy-control-token",
      operationId: "createPlanRun",
      openapi: {
        requestSchema: "CreatePlanRunRequest",
        okStatus: "201",
        okSchema: "PlanRunResponse",
      },
      notImplementedMessage: "plan runs not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_PLAN_RUN_ROUTE,
      summary: "Reads an OpenTofu PlanRun.",
      auth: "deploy-control-token",
      operationId: "getPlanRun",
      openapi: { pathParams: ["planRunId"], okSchema: "PlanRunResponse" },
      notImplementedMessage: "plan runs not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_APPLY_RUNS_ROUTE,
      summary: "Creates an apply run from a succeeded reviewed PlanRun.",
      auth: "deploy-control-token",
      operationId: "createApplyRun",
      openapi: {
        requestSchema: "CreateApplyRunRequest",
        okStatus: "201",
        okSchema: "ApplyRunResponse",
      },
      notImplementedMessage: "apply runs not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_APPLY_RUN_ROUTE,
      summary: "Reads an OpenTofu ApplyRun.",
      auth: "deploy-control-token",
      operationId: "getApplyRun",
      openapi: { pathParams: ["applyRunId"], okSchema: "ApplyRunResponse" },
      notImplementedMessage: "apply runs not wired",
    },
  ];

export function mountDeployControlLedgerRoutes(
  ctx: DeployControlRouteContext,
): void {
  const { app, controller, deployControlBodyLimit } = ctx;

  app.get(
    TAKOSUMI_RUNNER_PROFILES_ROUTE,
    defineRoute({
      ctx,
      handler: async ({ c, principal }) =>
        c.json(
          filterRunnerProfilesForPrincipal(
            await controller.listRunnerProfiles(),
            principal,
          ),
          200,
        ),
    }),
  );

  app.post(
    TAKOSUMI_PLAN_RUNS_ROUTE,
    deployControlBodyLimit,
    defineRoute({
      ctx,
      enforceBody: true,
      handler: async ({ c, principal }) => {
        const body = await readJsonBody<CreatePlanRunRequest>(
          c,
          "planRunCreate",
        );
        ensurePlanCreatePermission(principal, body);
        const response = await controller.createPlanRun(body, {
          actor: principal.actor,
        });
        return c.json(response, 201);
      },
    }),
  );

  app.get(
    TAKOSUMI_PLAN_RUN_ROUTE,
    defineRoute({
      ctx,
      param: { id: "planRunId" },
      handler: async ({ c, principal, id }) => {
        const response = await controller.getPlanRun(id);
        ensureWorkspacePermission(principal, response.planRun.workspaceId);
        return c.json(response, 200);
      },
    }),
  );

  app.post(
    TAKOSUMI_APPLY_RUNS_ROUTE,
    deployControlBodyLimit,
    defineRoute({
      ctx,
      enforceBody: true,
      handler: async ({ c, principal }) => {
        const body = await readJsonBody<CreateApplyRunRequest>(
          c,
          "applyRunCreate",
        );
        const plan = await controller.getPlanRun(body.planRunId);
        ensureApplyPermission(principal, plan.planRun);
        const response = await controller.createApplyRun(body, {
          actor: principal.actor,
        });
        return c.json(response, 201);
      },
    }),
  );

  app.get(
    TAKOSUMI_APPLY_RUN_ROUTE,
    defineRoute({
      ctx,
      param: { id: "applyRunId" },
      handler: async ({ c, principal, id }) => {
        const response = await controller.getApplyRun(id);
        ensureWorkspacePermission(principal, response.applyRun.workspaceId);
        return c.json(response, 200);
      },
    }),
  );
}
