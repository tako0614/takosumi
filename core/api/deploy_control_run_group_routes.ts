/**
 * §19 / §24 RunGroup routes. The Workspace bulk operations (`plan-update`,
 * `drift-check`) and RunGroup approval are retired (TASK-0118 stage 9.1): they
 * answer `410` with `run_group_retired` and never read the Workspace or the
 * group. Plan or drift-check each app through its own Capsule route instead.
 * The RunGroup read stays so a row written before the retirement can still be
 * inspected (production and staging hold none). Owns its handlers and its
 * slice of the {@link DEPLOY_CONTROL_INTERNAL_ENDPOINTS} descriptor inventory.
 */

import { OpenTofuControllerError } from "../domains/deploy-control/mod.ts";
import {
  defineRoute,
  type DeployControlEndpoint,
  type DeployControlRouteContext,
  ensureWorkspacePermission,
  RUN_GROUP_ID_PATTERN,
  WORKSPACE_ID_PATTERN,
} from "./deploy_control_shared.ts";
import {
  TAKOSUMI_RUN_GROUP_APPROVE_ROUTE,
  TAKOSUMI_RUN_GROUP_ROUTE,
  TAKOSUMI_WORKSPACE_DRIFT_CHECK_ROUTE,
  TAKOSUMI_WORKSPACE_PLAN_UPDATE_ROUTE,
} from "./deploy_control_route_paths.ts";

const RUN_GROUP_ID_PARAM = {
  param: "runGroupId",
  pattern: RUN_GROUP_ID_PATTERN,
} as const;

/** Message every retired RunGroup operation returns with `run_group_retired`. */
export const RUN_GROUP_RETIRED_MESSAGE =
  "Workspace RunGroups are retired. Plan each app with POST /capsules/{capsuleId}/plan, drift-check it with POST /capsules/{capsuleId}/drift-check, and approve each Run on its own.";

function runGroupRetiredError(): OpenTofuControllerError {
  return new OpenTofuControllerError("run_group_retired", RUN_GROUP_RETIRED_MESSAGE);
}

export const DEPLOY_CONTROL_RUN_GROUP_ENDPOINTS: readonly DeployControlEndpoint[] =
  [
    {
      method: "POST",
      path: TAKOSUMI_WORKSPACE_PLAN_UPDATE_ROUTE,
      summary:
        "Retired: answers 410 run_group_retired. Plan each app with its Capsule plan route.",
      auth: "deploy-control-token",
      operationId: "createWorkspacePlanUpdate",
      openapi: {
        pathParams: ["workspaceId"],
        okSchema: "ErrorResponse",
        retired: true,
      },
      notImplementedMessage: "run groups not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_WORKSPACE_DRIFT_CHECK_ROUTE,
      summary:
        "Retired: answers 410 run_group_retired. Drift-check each app with its Capsule drift-check route.",
      auth: "deploy-control-token",
      operationId: "createWorkspaceDriftCheck",
      openapi: {
        pathParams: ["workspaceId"],
        okSchema: "ErrorResponse",
        retired: true,
      },
      notImplementedMessage: "run groups not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_RUN_GROUP_ROUTE,
      summary:
        "Reads a RunGroup written before the retirement, with its member Runs and computed status.",
      auth: "deploy-control-token",
      operationId: "getRunGroup",
      openapi: { pathParams: ["runGroupId"], okSchema: "RunGroupResponse" },
      notImplementedMessage: "run groups not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_RUN_GROUP_APPROVE_ROUTE,
      summary:
        "Retired: answers 410 run_group_retired. Approve each member Run on its own.",
      auth: "deploy-control-token",
      operationId: "approveRunGroup",
      openapi: {
        pathParams: ["runGroupId"],
        okSchema: "ErrorResponse",
        retired: true,
      },
      notImplementedMessage: "run groups not wired",
    },
  ];

export function mountDeployControlRunGroupRoutes(
  ctx: DeployControlRouteContext,
): void {
  const { app, dependencies } = ctx;
  const runGroupsService = dependencies.runGroupsService;
  const requireRunGroups = (deps: typeof dependencies): string | undefined =>
    deps.runGroupsService ? undefined : "run groups not wired";
  // The retired operations authenticate the operator bearer and validate the
  // path parameter, then refuse without reading the Workspace or the group.
  app.post(
    TAKOSUMI_WORKSPACE_PLAN_UPDATE_ROUTE,
    defineRoute({
      ctx,
      param: { param: "workspaceId", pattern: WORKSPACE_ID_PATTERN },
      handler: () => Promise.reject(runGroupRetiredError()),
    }),
  );

  app.post(
    TAKOSUMI_WORKSPACE_DRIFT_CHECK_ROUTE,
    defineRoute({
      ctx,
      param: { param: "workspaceId", pattern: WORKSPACE_ID_PATTERN },
      handler: () => Promise.reject(runGroupRetiredError()),
    }),
  );

  app.get(
    TAKOSUMI_RUN_GROUP_ROUTE,
    defineRoute({
      ctx,
      requireService: requireRunGroups,
      param: RUN_GROUP_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        const result = await runGroupsService!.getRunGroup(id);
        if (!result) {
          throw new OpenTofuControllerError(
            "not_found",
            `run group ${id} not found`,
          );
        }
        ensureWorkspacePermission(principal, result.runGroup.workspaceId);
        return c.json(result, 200);
      },
    }),
  );

  app.post(
    TAKOSUMI_RUN_GROUP_APPROVE_ROUTE,
    defineRoute({
      ctx,
      param: RUN_GROUP_ID_PARAM,
      handler: () => Promise.reject(runGroupRetiredError()),
    }),
  );
}
