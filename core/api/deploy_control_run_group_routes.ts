/**
 * §19 / §24 RunGroup routes: the Workspace `plan-update` (creates a workspace_update
 * RunGroup re-planning every stale Capsule in topological order) plus the
 * RunGroup read / approve handlers. Owns its handlers and its slice of the
 * {@link DEPLOY_CONTROL_INTERNAL_ENDPOINTS} descriptor inventory.
 */

import { OpenTofuControllerError } from "../domains/deploy-control/mod.ts";
import {
  defineRoute,
  type DeployControlEndpoint,
  type DeployControlRouteContext,
  ensureSpacePermission,
  readJsonBody,
  RUN_GROUP_ID_PATTERN,
  SPACE_ID_PATTERN,
} from "./deploy_control_shared.ts";
import {
  TAKOSUMI_RUN_GROUP_APPROVE_ROUTE,
  TAKOSUMI_RUN_GROUP_ROUTE,
  TAKOSUMI_WORKSPACE_DRIFT_CHECK_ROUTE,
  TAKOSUMI_WORKSPACE_PLAN_UPDATE_ROUTE,
  TAKOSUMI_WORKSPACE_OUTPUT_SYNC_RECONCILE_ROUTE,
  TAKOSUMI_WORKSPACE_OUTPUT_SYNC_ROUTE,
  TAKOSUMI_WORKSPACE_OUTPUT_SYNC_SNAPSHOT_ROUTE,
} from "./deploy_control_route_paths.ts";

const RUN_GROUP_ID_PARAM = {
  param: "runGroupId",
  pattern: RUN_GROUP_ID_PATTERN,
} as const;

export const DEPLOY_CONTROL_RUN_GROUP_ENDPOINTS: readonly DeployControlEndpoint[] =
  [
    {
      method: "GET",
      path: TAKOSUMI_WORKSPACE_OUTPUT_SYNC_ROUTE,
      summary: "Reads Takosumi Workspace Output Sync settings and revision.",
      auth: "deploy-control-token",
      operationId: "getWorkspaceOutputSync",
      openapi: {
        pathParams: ["workspaceId"],
        okSchema: "WorkspaceOutputSyncStatusResponse",
      },
      notImplementedMessage: "output sync not wired",
    },
    {
      method: "PATCH",
      path: TAKOSUMI_WORKSPACE_OUTPUT_SYNC_ROUTE,
      summary: "Enables or disables Takosumi Workspace Output Sync.",
      auth: "deploy-control-token",
      operationId: "patchWorkspaceOutputSync",
      openapi: {
        pathParams: ["workspaceId"],
        requestSchema: "PatchWorkspaceOutputSyncRequest",
        okSchema: "WorkspaceOutputSyncStatusResponse",
      },
      notImplementedMessage: "output sync not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_WORKSPACE_OUTPUT_SYNC_SNAPSHOT_ROUTE,
      summary: "Reads the current non-secret Workspace Output snapshot.",
      auth: "deploy-control-token",
      operationId: "getWorkspaceOutputSyncSnapshot",
      openapi: {
        pathParams: ["workspaceId"],
        okSchema: "WorkspaceOutputSyncSnapshotResponse",
      },
      notImplementedMessage: "output sync not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_WORKSPACE_OUTPUT_SYNC_RECONCILE_ROUTE,
      summary: "Starts or advances durable staged Workspace reconciliation.",
      auth: "deploy-control-token",
      operationId: "reconcileWorkspaceOutputs",
      openapi: {
        pathParams: ["workspaceId"],
        okStatus: "202",
        okSchema: "WorkspaceOutputSyncReconcileResponse",
      },
      notImplementedMessage: "output sync not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_WORKSPACE_PLAN_UPDATE_ROUTE,
      summary:
        "Creates a workspace_update RunGroup: re-plans every stale Capsule (+ downstream) in topological order.",
      auth: "deploy-control-token",
      operationId: "createWorkspacePlanUpdate",
      openapi: {
        pathParams: ["workspaceId"],
        okStatus: "201",
        okSchema: "RunGroupResponse",
      },
      notImplementedMessage: "run groups not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_WORKSPACE_DRIFT_CHECK_ROUTE,
      summary:
        "Creates a workspace_drift_check RunGroup: creates one read-only drift_check Run per active Capsule in the Workspace.",
      auth: "deploy-control-token",
      operationId: "createWorkspaceDriftCheck",
      openapi: {
        pathParams: ["workspaceId"],
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
  const outputSyncService = dependencies.outputSyncService;
  const requireRunGroups = (deps: typeof dependencies): string | undefined =>
    deps.runGroupsService ? undefined : "run groups not wired";
  const requireOutputSync = (deps: typeof dependencies): string | undefined =>
    deps.outputSyncService ? undefined : "output sync not wired";

  app.get(
    TAKOSUMI_WORKSPACE_OUTPUT_SYNC_ROUTE,
    defineRoute({
      ctx,
      requireService: requireOutputSync,
      param: { param: "workspaceId", pattern: SPACE_ID_PATTERN },
      handler: async ({ c, principal, id }) => {
        ensureSpacePermission(principal, id);
        return c.json(await outputSyncService!.getStatus(id), 200);
      },
    }),
  );

  app.patch(
    TAKOSUMI_WORKSPACE_OUTPUT_SYNC_ROUTE,
    ctx.deployControlBodyLimit,
    defineRoute({
      ctx,
      requireService: requireOutputSync,
      param: { param: "workspaceId", pattern: SPACE_ID_PATTERN },
      enforceBody: true,
      handler: async ({ c, principal, id }) => {
        ensureSpacePermission(principal, id);
        const body = await readJsonBody<{ readonly enabled?: unknown }>(
          c,
          "outputSyncPatch",
        );
        if (typeof body.enabled !== "boolean") {
          throw new OpenTofuControllerError(
            "invalid_argument",
            "enabled must be boolean",
          );
        }
        return c.json(
          await outputSyncService!.setEnabled(id, body.enabled),
          200,
        );
      },
    }),
  );

  app.get(
    TAKOSUMI_WORKSPACE_OUTPUT_SYNC_SNAPSHOT_ROUTE,
    defineRoute({
      ctx,
      requireService: requireOutputSync,
      param: { param: "workspaceId", pattern: SPACE_ID_PATTERN },
      handler: async ({ c, principal, id }) => {
        ensureSpacePermission(principal, id);
        const snapshot = await outputSyncService!.getSnapshot(id);
        c.header("ETag", `\"takosumi-output-sync-${snapshot.revision}\"`);
        c.header("Cache-Control", "private, no-cache");
        return c.json({ snapshot }, 200);
      },
    }),
  );

  app.post(
    TAKOSUMI_WORKSPACE_OUTPUT_SYNC_RECONCILE_ROUTE,
    defineRoute({
      ctx,
      requireService: requireOutputSync,
      param: { param: "workspaceId", pattern: SPACE_ID_PATTERN },
      handler: async ({ c, principal, id }) => {
        ensureSpacePermission(principal, id);
        const result = await outputSyncService!.reconcile(id);
        return c.json(result, result.reconciliation ? 202 : 200);
      },
    }),
  );

  app.post(
    TAKOSUMI_WORKSPACE_PLAN_UPDATE_ROUTE,
    defineRoute({
      ctx,
      requireService: requireRunGroups,
      param: { param: "workspaceId", pattern: SPACE_ID_PATTERN },
      handler: async ({ c, principal, id }) => {
        ensureSpacePermission(principal, id);
        const result = await runGroupsService!.createWorkspaceUpdate(id);
        return c.json(result, 201);
      },
    }),
  );

  app.post(
    TAKOSUMI_WORKSPACE_DRIFT_CHECK_ROUTE,
    defineRoute({
      ctx,
      requireService: requireRunGroups,
      param: { param: "workspaceId", pattern: SPACE_ID_PATTERN },
      handler: async ({ c, principal, id }) => {
        ensureSpacePermission(principal, id);
        const result = await runGroupsService!.createWorkspaceDriftCheck(id);
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
        ensureSpacePermission(
          principal,
          result.runGroup.workspaceId ?? result.runGroup.spaceId,
        );
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
        ensureSpacePermission(
          principal,
          existing.runGroup.workspaceId ?? existing.runGroup.spaceId,
        );
        const result = await runGroupsService!.approveRunGroup(id);
        return c.json(result, 200);
      },
    }),
  );
}
