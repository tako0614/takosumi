/**
 * §5 / §11 Capsule + InstallConfig routes, the §30 public Capsule /
 * StateVersion reads (including rollback-plan), and the Capsule-driven
 * plan / destroy-plan / drift-check routes (mounted consecutively in the
 * original). Owns its handlers and its slice of the
 * {@link DEPLOY_CONTROL_INTERNAL_ENDPOINTS} descriptor inventory.
 */

import type {
  Capsule,
  CapsuleStatus,
  PublicCapsule,
} from "takosumi-contract/capsules";
import {
  defineRoute,
  type DeployControlEndpoint,
  type DeployControlRouteContext,
  ensureOperationPermission,
  ensureRunnerProfileSelectionPermission,
  ensureWorkspacePermission,
  errorEnvelope,
  nonEmptyString,
  parsePageParams,
  readJsonBody,
  readOptionalJsonBody,
  STATE_VERSION_ID_PATTERN,
  WORKSPACE_ID_PATTERN,
} from "./deploy_control_shared.ts";
import { OpenTofuControllerError } from "../domains/deploy-control/errors.ts";
import { publicInstallConfigRecord } from "../domains/capsules/public_install_config.ts";
import {
  TAKOSUMI_API_CAPSULE_STATE_VERSIONS_ROUTE,
  TAKOSUMI_API_CAPSULE_OUTPUTS_ROUTE,
  TAKOSUMI_API_CAPSULE_ROUTE,
  TAKOSUMI_STATE_VERSION_ROLLBACK_PLAN_ROUTE,
  TAKOSUMI_STATE_VERSION_ROUTE,
  TAKOSUMI_INSTALL_CONFIG_ROUTE,
  TAKOSUMI_INSTALL_CONFIGS_ROUTE,
  TAKOSUMI_CAPSULE_DESTROY_PLAN_ROUTE,
  TAKOSUMI_CAPSULE_DRIFT_CHECK_ROUTE,
  TAKOSUMI_CAPSULE_PLAN_ROUTE,
  TAKOSUMI_WORKSPACE_CAPSULES_ROUTE,
} from "./deploy_control_route_paths.ts";

const WORKSPACE_ID_PARAM = {
  param: "workspaceId",
  pattern: WORKSPACE_ID_PATTERN,
} as const;
const STATE_VERSION_ID_PARAM = {
  param: "stateVersionId",
  pattern: STATE_VERSION_ID_PATTERN,
} as const;
const INSTALL_CONFIG_ID_PARAM = {
  param: "installConfigId",
  pattern: /^cfg[-_][0-9a-zA-Z-]{3,96}$/,
} as const;
const CAPSULE_ID_PARAM = { id: "capsuleId" } as const;

interface PatchCapsuleRequest {
  readonly status?: CapsuleStatus;
}

interface CapsulePlanRouteRequest {
  readonly compatibilityReportId?: unknown;
  readonly recoverySourceSnapshotId?: unknown;
  readonly runnerId?: string;
}

const API_PATCHABLE_CAPSULE_STATUSES: ReadonlySet<CapsuleStatus> = new Set([
  "active",
  "stale",
  "error",
]);

function publicCapsule(capsule: Capsule): PublicCapsule {
  const {
    currentOutputId: _currentOutputId,
    autoUpdateAttemptSourceSnapshotId: _autoUpdateAttemptSourceSnapshotId,
    installingPrincipalId: _installingPrincipalId,
    publicOriginReservation: _publicOriginReservation,
    ...publicRecord
  } = capsule;
  return publicRecord;
}

function capsuleResponse(capsule: Capsule): {
  readonly capsule: PublicCapsule;
} {
  return { capsule: publicCapsule(capsule) };
}

function capsuleHasAppliedState(capsule: {
  readonly currentStateVersionId?: string;
  readonly currentStateGeneration: number;
}): boolean {
  return Boolean(
    capsule.currentStateVersionId || capsule.currentStateGeneration > 0,
  );
}

function runnerIdFromBody(body: {
  readonly runnerId?: unknown;
}): string | undefined {
  if (body.runnerId === undefined) return undefined;
  if (!nonEmptyString(body.runnerId)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "runnerId must be a non-empty string",
    );
  }
  return body.runnerId.trim();
}

function compatibilityReportIdFromBody(body: {
  readonly compatibilityReportId?: unknown;
}): string | undefined {
  if (body.compatibilityReportId === undefined) return undefined;
  if (!nonEmptyString(body.compatibilityReportId)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "compatibilityReportId must be a non-empty string",
    );
  }
  return body.compatibilityReportId.trim();
}

function recoverySourceSnapshotIdFromBody(body: {
  readonly recoverySourceSnapshotId?: unknown;
}): string | undefined {
  if (body.recoverySourceSnapshotId === undefined) return undefined;
  if (!nonEmptyString(body.recoverySourceSnapshotId)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "recoverySourceSnapshotId must be a non-empty string",
    );
  }
  return body.recoverySourceSnapshotId.trim();
}

type InstallConfigListView = "all" | "store";

function parseInstallConfigListView(
  raw: string | undefined,
):
  | { readonly kind: "ok"; readonly view: InstallConfigListView }
  | { readonly kind: "invalid"; readonly response: Response } {
  if (raw === undefined || raw === "" || raw === "all") {
    return { kind: "ok", view: "all" };
  }
  if (raw === "store") {
    return { kind: "ok", view: "store" };
  }
  return {
    kind: "invalid",
    response: new Response(
      JSON.stringify({
        error: {
          code: "invalid_argument",
          message: "view must be all or store",
        },
      }),
      {
        status: 400,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    ),
  };
}

function parseIncludeDestroyed(
  raw: string | undefined,
):
  | { readonly kind: "ok"; readonly includeDestroyed: boolean }
  | { readonly kind: "invalid"; readonly response: Response } {
  if (raw === undefined || raw === "" || raw === "true") {
    return { kind: "ok", includeDestroyed: true };
  }
  if (raw === "false") {
    return { kind: "ok", includeDestroyed: false };
  }
  return {
    kind: "invalid",
    response: new Response(
      JSON.stringify({
        error: {
          code: "invalid_argument",
          message: "includeDestroyed must be true or false",
        },
      }),
      {
        status: 400,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    ),
  };
}

export const DEPLOY_CONTROL_CAPSULE_ENDPOINTS: readonly DeployControlEndpoint[] =
  [
    {
      method: "GET",
      path: TAKOSUMI_WORKSPACE_CAPSULES_ROUTE,
      summary: "Lists the Capsules of a Workspace.",
      auth: "deploy-control-token",
      operationId: "listCapsules",
      openapi: {
        pathParams: ["workspaceId"],
        okSchema: "ListCapsulesResponse",
      },
      notImplementedMessage: "capsules not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_API_CAPSULE_ROUTE,
      summary: "Reads a Capsule ledger record.",
      auth: "deploy-control-token",
      operationId: "getCapsule",
      openapi: {
        pathParams: ["capsuleId"],
        okSchema: "CapsuleResponse",
      },
      notImplementedMessage: "capsules not wired",
    },
    {
      method: "PATCH",
      path: TAKOSUMI_API_CAPSULE_ROUTE,
      summary:
        "Updates safe mutable Capsule fields; MVP exposes status patching for active/stale/error only.",
      auth: "deploy-control-token",
      operationId: "patchCapsule",
      openapi: {
        pathParams: ["capsuleId"],
        requestSchema: "PatchCapsuleRequest",
        okSchema: "CapsuleResponse",
      },
      notImplementedMessage: "capsules not wired",
    },
    {
      method: "DELETE",
      path: TAKOSUMI_API_CAPSULE_ROUTE,
      summary:
        "Starts the canonical destroy flow by creating a destroy-plan Run; approval + destroy_apply perform teardown.",
      auth: "deploy-control-token",
      operationId: "deleteCapsule",
      openapi: {
        pathParams: ["capsuleId"],
        okStatus: "202",
        okSchema: "RunResponse",
      },
      notImplementedMessage: "capsules not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_API_CAPSULE_STATE_VERSIONS_ROUTE,
      summary: "Lists StateVersion records for a Capsule.",
      auth: "deploy-control-token",
      operationId: "listCapsuleStateVersions",
      openapi: {
        pathParams: ["capsuleId"],
        okSchema: "ListStateVersionsResponse",
      },
      notImplementedMessage: "state-version ledger not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_API_CAPSULE_OUTPUTS_ROUTE,
      summary: "Reads the current public Output projection for a Capsule.",
      auth: "deploy-control-token",
      operationId: "getCapsuleOutput",
      openapi: {
        pathParams: ["capsuleId"],
        okSchema: "OutputResponse",
      },
      notImplementedMessage: "output ledger not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_STATE_VERSION_ROUTE,
      summary: "Reads a StateVersion ledger record.",
      auth: "deploy-control-token",
      operationId: "getStateVersion",
      openapi: {
        pathParams: ["stateVersionId"],
        okSchema: "StateVersionResponse",
      },
      notImplementedMessage: "state-version ledger not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_STATE_VERSION_ROLLBACK_PLAN_ROUTE,
      summary:
        "Creates a rollback plan run for a StateVersion, pinned to that StateVersion's source snapshot (flows through normal approval/apply).",
      auth: "deploy-control-token",
      operationId: "createStateVersionRollbackPlan",
      openapi: {
        pathParams: ["stateVersionId"],
        okStatus: "201",
        okSchema: "RunResponse",
      },
      notImplementedMessage: "state-version rollback not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_INSTALL_CONFIGS_ROUTE,
      summary:
        "Lists operator-scoped InstallConfigs plus the Workspace's own configs when workspaceId is given.",
      auth: "deploy-control-token",
      operationId: "listInstallConfigs",
      openapi: {
        query: ["workspaceId"],
        okSchema: "ListInstallConfigsResponse",
      },
      notImplementedMessage: "capsules not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_INSTALL_CONFIG_ROUTE,
      summary:
        "Reads a public InstallConfig projection (operator-scoped or Workspace-owned).",
      auth: "deploy-control-token",
      operationId: "getInstallConfig",
      openapi: {
        pathParams: ["installConfigId"],
        okSchema: "InstallConfigResponse",
      },
      notImplementedMessage: "capsules not wired",
    },
    {
      method: "PATCH",
      path: TAKOSUMI_INSTALL_CONFIG_ROUTE,
      summary:
        "Atomically patches one explicitly selected, Workspace-neutral, provenance-free InstallConfig template only while no Capsule of any status references it.",
      auth: "deploy-control-token",
      operationId: "patchInstallConfig",
      openapi: {
        pathParams: ["installConfigId"],
        requestSchema: "InstallConfigPatchV1",
        okSchema: "InstallConfigResponse",
      },
      notImplementedMessage: "capsules not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_CAPSULE_PLAN_ROUTE,
      summary:
        "Creates a Capsule-driven plan run: resolves the Source's latest SourceSnapshot and dispatches with Capsule state scope.",
      auth: "deploy-control-token",
      operationId: "createCapsulePlan",
      openapi: {
        pathParams: ["capsuleId"],
        requestSchema: "CapsulePlanRequest",
        okStatus: "201",
        okSchema: "RunResponse",
      },
      notImplementedMessage: "capsules not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_CAPSULE_DESTROY_PLAN_ROUTE,
      summary:
        "Creates a Capsule-driven destroy-plan run (always lands waiting_approval per spec §23).",
      auth: "deploy-control-token",
      operationId: "createCapsuleDestroyPlan",
      openapi: {
        pathParams: ["capsuleId"],
        requestSchema: "CapsuleDestroyPlanRequest",
        okStatus: "201",
        okSchema: "RunResponse",
      },
      notImplementedMessage: "capsules not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_CAPSULE_DRIFT_CHECK_ROUTE,
      summary:
        "Creates a Capsule-driven drift-check run (read-only drift_check; never applyable).",
      auth: "deploy-control-token",
      operationId: "createCapsuleDriftCheck",
      openapi: {
        pathParams: ["capsuleId"],
        okStatus: "201",
        okSchema: "RunResponse",
      },
      notImplementedMessage: "capsules not wired",
    },
  ];

export function mountDeployControlCapsuleRoutes(
  ctx: DeployControlRouteContext,
): void {
  const { app, dependencies, controller, deployControlBodyLimit } = ctx;
  const capsules = dependencies.capsulesService;
  const requireCapsules = (deps: typeof dependencies): string | undefined =>
    deps.capsulesService ? undefined : "capsules not wired";

  // Capsule creation is coordinated exclusively by the exact-provenance initial
  // install authority. Keep an authenticated tombstone so callers learn the
  // surviving read method without disclosing Workspace existence before auth.
  app.post(
    TAKOSUMI_WORKSPACE_CAPSULES_ROUTE,
    defineRoute({
      ctx,
      param: WORKSPACE_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        ensureWorkspacePermission(principal, id);
        c.header("Allow", "GET");
        return c.json(
          errorEnvelope(c, "method_not_allowed", "method not allowed"),
          405,
        );
      },
    }),
  );
  app.get(
    TAKOSUMI_WORKSPACE_CAPSULES_ROUTE,
    defineRoute({
      ctx,
      requireService: requireCapsules,
      param: WORKSPACE_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        ensureWorkspacePermission(principal, id);
        const page = parsePageParams(c);
        if (page.kind === "invalid") return page.response;
        const includeDestroyed = parseIncludeDestroyed(
          c.req.query("includeDestroyed"),
        );
        if (includeDestroyed.kind === "invalid") {
          return includeDestroyed.response;
        }
        const result = await capsules!.listCapsulesPage(id, {
          ...page.value,
          includeDestroyed: includeDestroyed.includeDestroyed,
        });
        return c.json(
          {
            capsules: result.items.map(publicCapsule),
            ...(result.nextCursor !== undefined
              ? { nextCursor: result.nextCursor }
              : {}),
          },
          200,
        );
      },
    }),
  );

  // --- PUBLIC §30 Capsule + StateVersion reads ------------------------------

  app.get(
    TAKOSUMI_API_CAPSULE_ROUTE,
    defineRoute({
      ctx,
      param: CAPSULE_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        const response = await controller.getCapsule(id);
        ensureWorkspacePermission(principal, response.capsule.workspaceId);
        return c.json(response, 200);
      },
    }),
  );

  app.patch(
    TAKOSUMI_API_CAPSULE_ROUTE,
    deployControlBodyLimit,
    defineRoute({
      ctx,
      requireService: requireCapsules,
      param: CAPSULE_ID_PARAM,
      enforceBody: true,
      handler: async ({ c, principal, id }) => {
        const existing = await controller.getCapsule(id);
        ensureWorkspacePermission(principal, existing.capsule.workspaceId);
        const body = await readJsonBody<PatchCapsuleRequest>(c, "capsulePatch");
        if (body.status === undefined) {
          return c.json(
            errorEnvelope(
              c,
              "invalid_argument",
              "PATCH /internal/v1/capsules/:capsuleId requires status",
            ),
            400,
          );
        }
        if (!API_PATCHABLE_CAPSULE_STATUSES.has(body.status)) {
          return c.json(
            errorEnvelope(
              c,
              "invalid_argument",
              "status may only be patched to active, stale, or error; destroy states must use the destroy flow",
            ),
            400,
          );
        }
        const capsule = await capsules!.patchCapsuleStatus(id, body.status);
        return c.json(capsuleResponse(capsule), 200);
      },
    }),
  );

  app.delete(
    TAKOSUMI_API_CAPSULE_ROUTE,
    defineRoute({
      ctx,
      requireService: requireCapsules,
      param: CAPSULE_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        const existing = await controller.getCapsule(id);
        ensureWorkspacePermission(principal, existing.capsule.workspaceId);
        if (!capsuleHasAppliedState(existing.capsule)) {
          const capsule = await capsules!.abandonUnappliedCapsule(
            id,
            "delete requested before first successful apply",
          );
          return c.json({ ...capsuleResponse(capsule), abandoned: true }, 202);
        }
        ensureOperationPermission(principal, "destroy");
        ensureRunnerProfileSelectionPermission(principal, undefined);
        const response = await controller.createCapsuleDestroyPlan(id, {
          actor: principal.actor,
        });
        return c.json(
          { run: await controller.getRun(response.planRun.id) },
          202,
        );
      },
    }),
  );

  app.get(
    TAKOSUMI_API_CAPSULE_STATE_VERSIONS_ROUTE,
    defineRoute({
      ctx,
      param: CAPSULE_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        const capsule = await controller.getCapsule(id);
        ensureWorkspacePermission(principal, capsule.capsule.workspaceId);
        const page = parsePageParams(c);
        if (page.kind === "invalid") return page.response;
        return c.json(await controller.listStateVersions(id, page.value), 200);
      },
    }),
  );

  app.get(
    TAKOSUMI_API_CAPSULE_OUTPUTS_ROUTE,
    defineRoute({
      ctx,
      param: CAPSULE_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        // Authorize from the Capsule's public owner boundary before following
        // its internal currentOutputId cursor inside the controller.
        const capsule = await controller.getCapsule(id);
        ensureWorkspacePermission(principal, capsule.capsule.workspaceId);
        return c.json(await controller.getCurrentOutput(id), 200);
      },
    }),
  );

  app.get(
    TAKOSUMI_STATE_VERSION_ROUTE,
    defineRoute({
      ctx,
      param: STATE_VERSION_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        const { stateVersion } = await controller.getStateVersion(id);
        ensureWorkspacePermission(principal, stateVersion.workspaceId);
        return c.json({ stateVersion }, 200);
      },
    }),
  );

  app.post(
    TAKOSUMI_STATE_VERSION_ROLLBACK_PLAN_ROUTE,
    defineRoute({
      ctx,
      param: STATE_VERSION_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        // Resolve the StateVersion first so the rollback plan is
        // Workspace-permission gated, then create the pinned rollback plan.
        const { stateVersion } = await controller.getStateVersion(id);
        ensureWorkspacePermission(principal, stateVersion.workspaceId);
        ensureOperationPermission(principal, "update");
        ensureRunnerProfileSelectionPermission(principal, undefined);
        const response = await controller.createStateVersionRollbackPlan(id, {
          actor: principal.actor,
        });
        return c.json(
          { run: await controller.getRun(response.planRun.id) },
          201,
        );
      },
    }),
  );

  app.get(
    TAKOSUMI_INSTALL_CONFIGS_ROUTE,
    defineRoute({
      ctx,
      requireService: requireCapsules,
      handler: async ({ c, principal }) => {
        const workspaceId = c.req.query("workspaceId");
        if (workspaceId !== undefined) {
          if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
            return c.json(
              errorEnvelope(
                c,
                "invalid_argument",
                "workspaceId has an unsupported shape",
              ),
              400,
            );
          }
          ensureWorkspacePermission(principal, workspaceId);
        }
        const page = parsePageParams(c);
        if (page.kind === "invalid") return page.response;
        const view = parseInstallConfigListView(c.req.query("view"));
        if (view.kind === "invalid") return view.response;
        const { items, nextCursor } =
          await capsules!.listInstallConfigUnionPage(workspaceId, page.value, {
            view: view.view,
          });
        return c.json(
          {
            installConfigs: items.map(publicInstallConfigRecord),
            ...(nextCursor !== undefined ? { nextCursor } : {}),
          },
          200,
        );
      },
    }),
  );

  // --- Capsule-driven plan / destroy-plan (§10 / §23) -----------------------

  app.post(
    TAKOSUMI_CAPSULE_PLAN_ROUTE,
    defineRoute({
      ctx,
      param: CAPSULE_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        const capsule = await controller.getCapsule(id);
        ensureWorkspacePermission(principal, capsule.capsule.workspaceId);
        const body = await readOptionalJsonBody<CapsulePlanRouteRequest>(
          c,
          "capsulePlan",
        );
        const runnerProfileId = runnerIdFromBody(body);
        const compatibilityReportId = compatibilityReportIdFromBody(body);
        ensureOperationPermission(
          principal,
          capsuleHasAppliedState(capsule.capsule) ? "update" : "create",
        );
        ensureRunnerProfileSelectionPermission(principal, runnerProfileId);
        const response = await controller.createCapsulePlan(
          id,
          {
            actor: principal.actor,
          },
          {
            ...(runnerProfileId ? { runnerProfileId } : {}),
            ...(compatibilityReportId ? { compatibilityReportId } : {}),
          },
        );
        return c.json(
          { run: await controller.getRun(response.planRun.id) },
          201,
        );
      },
    }),
  );

  app.get(
    TAKOSUMI_INSTALL_CONFIG_ROUTE,
    defineRoute({
      ctx,
      requireService: requireCapsules,
      param: INSTALL_CONFIG_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        const config = await capsules!.getInstallConfig(id);
        if (config.workspaceId !== undefined) {
          ensureWorkspacePermission(principal, config.workspaceId);
        }
        return c.json({ installConfig: publicInstallConfigRecord(config) }, 200);
      },
    }),
  );

  app.patch(
    TAKOSUMI_INSTALL_CONFIG_ROUTE,
    deployControlBodyLimit,
    defineRoute({
      ctx,
      requireService: requireCapsules,
      param: INSTALL_CONFIG_ID_PARAM,
      enforceBody: true,
      handler: async ({ c, principal, id }) => {
        const current = await capsules!.getInstallConfig(id);
        if (current.workspaceId !== undefined) {
          ensureWorkspacePermission(principal, current.workspaceId);
        } else if (principal.workspaceIds !== "*") {
          throw new OpenTofuControllerError(
            "permission_denied",
            "only an unrestricted operator may patch a shared InstallConfig",
          );
        }
        const body = await readJsonBody<unknown>(c, "installConfigPatch");
        const config = await capsules!.applyInstallConfigPatch(id, body);
        return c.json({ installConfig: publicInstallConfigRecord(config) }, 200);
      },
    }),
  );

  app.post(
    TAKOSUMI_CAPSULE_DESTROY_PLAN_ROUTE,
    defineRoute({
      ctx,
      param: CAPSULE_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        const capsule = await controller.getCapsule(id);
        ensureWorkspacePermission(principal, capsule.capsule.workspaceId);
        const body = await readOptionalJsonBody<CapsulePlanRouteRequest>(
          c,
          "capsuleDestroyPlan",
        );
        const runnerProfileId = runnerIdFromBody(body);
        const recoverySourceSnapshotId =
          recoverySourceSnapshotIdFromBody(body);
        ensureOperationPermission(principal, "destroy");
        ensureRunnerProfileSelectionPermission(principal, runnerProfileId);
        if (recoverySourceSnapshotId && principal.workspaceIds !== "*") {
          throw new OpenTofuControllerError(
            "permission_denied",
            "only an unrestricted operator may select a destroy recovery SourceSnapshot",
          );
        }
        const response = await controller.createCapsuleDestroyPlan(
          id,
          {
            actor: principal.actor,
          },
          {
            ...(runnerProfileId ? { runnerProfileId } : {}),
            ...(recoverySourceSnapshotId
              ? { sourceSnapshotId: recoverySourceSnapshotId }
              : {}),
          },
        );
        return c.json(
          { run: await controller.getRun(response.planRun.id) },
          201,
        );
      },
    }),
  );

  // Drift check is a canonical read-only Run type. It is Workspace-permission gated
  // like plan/destroy-plan, but never produces an applyable saved plan.
  app.post(
    TAKOSUMI_CAPSULE_DRIFT_CHECK_ROUTE,
    defineRoute({
      ctx,
      param: CAPSULE_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        const capsule = await controller.getCapsule(id);
        ensureWorkspacePermission(principal, capsule.capsule.workspaceId);
        ensureOperationPermission(principal, "update");
        ensureRunnerProfileSelectionPermission(principal, undefined);
        const response = await controller.createCapsuleDriftCheck(id, {
          actor: principal.actor,
        });
        return c.json(
          { run: await controller.getRun(response.planRun.id) },
          201,
        );
      },
    }),
  );
}
