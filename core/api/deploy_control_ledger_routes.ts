/**
 * Plan / Apply run ledger + operator execution boundary routes and the INTERNAL
 * `/internal/v1` DeploymentOutput read consumed by the accounts plane + CLI.
 * The Installation + Deployment reads (`/internal/v1/installations/:id` and
 * `.../deployments`) are owned solely by the installation route group
 * (`mountDeployControlInstallationRoutes`); they used to be duplicated here as a
 * separate `/v1` seam, but once both groups collapsed onto `/internal/v1` the
 * registrations became byte-identical, so the duplicate is removed and only the
 * DeploymentOutput read (no installation-group equivalent) remains.
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
  ensureSpacePermission,
  filterRunnerProfilesForPrincipal,
  readJsonBody,
} from "./deploy_control_shared.ts";
import {
  TAKOSUMI_APPLY_RUN_ROUTE,
  TAKOSUMI_APPLY_RUNS_ROUTE,
  TAKOSUMI_INSTALLATION_DEPLOYMENT_OUTPUTS_ROUTE,
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
        "Creates an OpenTofu plan run for a plain module source or a built-in InstallConfig module (templateId+inputs).",
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
      summary:
        "Creates an apply run from a succeeded PlanRun (confirmDestructive required for flagged destructive template plans).",
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
    {
      method: "GET",
      path: TAKOSUMI_INSTALLATION_DEPLOYMENT_OUTPUTS_ROUTE,
      summary:
        "INTERNAL seam: lists non-sensitive DeploymentOutput records for the current Deployment of an Installation (accounts-plane consumer; not part of the §30 public surface).",
      auth: "deploy-control-token",
      operationId: "listInstallationDeploymentOutputs",
      openapi: {
        pathParams: ["installationId"],
        okSchema: "ListDeploymentOutputsResponse",
      },
      notImplementedMessage: "deployment outputs not wired",
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
        ensureSpacePermission(principal, response.planRun.spaceId);
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
        ensureSpacePermission(principal, response.applyRun.spaceId);
        return c.json(response, 200);
      },
    }),
  );

  app.get(
    TAKOSUMI_INSTALLATION_DEPLOYMENT_OUTPUTS_ROUTE,
    defineRoute({
      ctx,
      param: { id: "installationId" },
      handler: async ({ c, principal, id }) => {
        const installation = await controller.getInstallation(id);
        ensureSpacePermission(principal, installation.capsule.workspaceId);
        return c.json(await controller.listDeploymentOutputs(id), 200);
      },
    }),
  );
}
