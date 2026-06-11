/**
 * §19 / §24 RunGroup routes: the Space `plan-update` (creates a space_update
 * RunGroup re-planning every stale Installation in topological order) plus the
 * RunGroup read / approve handlers. Owns its handlers and its slice of the
 * {@link DEPLOY_CONTROL_PUBLIC_ENDPOINTS} descriptor inventory.
 */

import { OpenTofuControllerError } from "../domains/deploy-control/mod.ts";
import {
  defineRoute,
  type DeployControlEndpoint,
  type DeployControlRouteContext,
  ensureSpacePermission,
  RUN_GROUP_ID_PATTERN,
  SPACE_ID_PATTERN,
} from "./deploy_control_shared.ts";
import {
  TAKOSUMI_RUN_GROUP_APPROVE_ROUTE,
  TAKOSUMI_RUN_GROUP_ROUTE,
  TAKOSUMI_SPACE_DRIFT_CHECK_ROUTE,
  TAKOSUMI_SPACE_PLAN_UPDATE_ROUTE,
} from "./deploy_control_route_paths.ts";

const RUN_GROUP_ID_PARAM = {
  param: "runGroupId",
  pattern: RUN_GROUP_ID_PATTERN,
} as const;

export const DEPLOY_CONTROL_RUN_GROUP_ENDPOINTS: readonly DeployControlEndpoint[] =
  [
    {
      method: "POST",
      path: TAKOSUMI_SPACE_PLAN_UPDATE_ROUTE,
      summary:
        "Creates a space_update RunGroup: re-plans every stale Installation (+ downstream) in topological order.",
      auth: "deploy-control-token",
      operationId: "createSpacePlanUpdate",
      openapi: {
        pathParams: ["spaceId"],
        okStatus: "201",
        okSchema: "RunGroupResponse",
      },
      notImplementedMessage: "run groups not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_SPACE_DRIFT_CHECK_ROUTE,
      summary:
        "Creates a space_drift_check RunGroup: creates one read-only drift_check Run per active Installation in the Space.",
      auth: "deploy-control-token",
      operationId: "createSpaceDriftCheck",
      openapi: {
        pathParams: ["spaceId"],
        okStatus: "201",
        okSchema: "RunGroupResponse",
      },
      notImplementedMessage: "run groups not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_RUN_GROUP_ROUTE,
      summary: "Reads a RunGroup with its member Runs and computed status.",
      auth: "deploy-control-token",
      operationId: "getRunGroup",
      openapi: { pathParams: ["runGroupId"], okSchema: "RunGroupResponse" },
      notImplementedMessage: "run groups not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_RUN_GROUP_APPROVE_ROUTE,
      summary:
        "Approves every member Run of a RunGroup currently waiting on approval.",
      auth: "deploy-control-token",
      operationId: "approveRunGroup",
      openapi: { pathParams: ["runGroupId"], okSchema: "RunGroupResponse" },
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

  app.post(
    TAKOSUMI_SPACE_PLAN_UPDATE_ROUTE,
    defineRoute({
      ctx,
      requireService: requireRunGroups,
      param: { param: "spaceId", pattern: SPACE_ID_PATTERN },
      handler: async ({ c, principal, id }) => {
        ensureSpacePermission(principal, id);
        const result = await runGroupsService!.createSpaceUpdate(id);
        return c.json(result, 201);
      },
    }),
  );

  app.post(
    TAKOSUMI_SPACE_DRIFT_CHECK_ROUTE,
    defineRoute({
      ctx,
      requireService: requireRunGroups,
      param: { param: "spaceId", pattern: SPACE_ID_PATTERN },
      handler: async ({ c, principal, id }) => {
        ensureSpacePermission(principal, id);
        const result = await runGroupsService!.createSpaceDriftCheck(id);
        return c.json(result, 201);
      },
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
        ensureSpacePermission(principal, result.runGroup.spaceId);
        return c.json(result, 200);
      },
    }),
  );

  app.post(
    TAKOSUMI_RUN_GROUP_APPROVE_ROUTE,
    defineRoute({
      ctx,
      requireService: requireRunGroups,
      param: RUN_GROUP_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        // Resolve the group first so approve is space-permission gated.
        const existing = await runGroupsService!.getRunGroup(id);
        if (!existing) {
          throw new OpenTofuControllerError(
            "not_found",
            `run group ${id} not found`,
          );
        }
        ensureSpacePermission(principal, existing.runGroup.spaceId);
        const result = await runGroupsService!.approveRunGroup(id);
        return c.json(result, 200);
      },
    }),
  );
}
