/**
 * §5 / §11 Capsule + InstallConfig routes, the §30 public Capsule /
 * StateVersion reads (including rollback-plan), and the Capsule-driven
 * plan / destroy-plan / drift-check routes (mounted consecutively in the
 * original). Owns its handlers and its slice of the
 * {@link DEPLOY_CONTROL_INTERNAL_ENDPOINTS} descriptor inventory.
 */

import type {
  CreateCapsuleRequest,
  CapsulesService,
} from "../domains/capsules/mod.ts";
import type {
  Capsule,
  CapsuleStatus,
  PublicCapsule,
} from "takosumi-contract/capsules";
import type {
  InstallConfig,
  ManagedPublicHostnameAllocation,
  PublicInstallConfig,
} from "takosumi-contract/install-configs";
import type { CapsuleInterfaceBlueprint } from "takosumi-contract/interfaces";
import {
  capsuleInterfaceBlueprintsNeedInstallingPrincipal,
  resolveCapsuleInterfaceBlueprintInstallingPrincipal,
} from "takosumi-contract/interfaces";
import {
  normalizeScopeBoundaryPolicy,
  type JsonValue,
} from "takosumi-contract";
import { isAbsolute, normalize } from "node:path";
import {
  defineRoute,
  type DeployControlEndpoint,
  type DeployControlRouteContext,
  ensureRunnerProfilePermission,
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
import { validateCapsuleInterfaceBlueprints } from "../domains/interfaces/service.ts";
import { normalizeVariablePathRecord } from "../domains/deploy-control/validation.ts";
import { defaultCapsuleOutputAllowlist } from "../domains/capsules/default_install_config.ts";
import { pageSorted } from "takosumi-contract/pagination";
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

interface CreateCapsuleRouteRequest extends CreateCapsuleRequest {
  readonly modulePath?: string;
  readonly outputAllowlist?: InstallConfig["outputAllowlist"];
  readonly interfaceBlueprints?: readonly CapsuleInterfaceBlueprint[];
  readonly runnerId?: string;
  readonly vars?: Readonly<Record<string, JsonValue>>;
  readonly managedPublicHostname?: ManagedPublicHostnameAllocation;
}

interface CapsulePlanRouteRequest {
  readonly compatibilityReportId?: unknown;
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

function publicInstallConfig(config: InstallConfig): PublicInstallConfig {
  const { runnerId: _runnerId, internal: _internal, ...publicRecord } = config;
  const store = config.store;
  return {
    ...publicRecord,
    policy: publicPolicyConfig(config.policy),
    ...(store ? { store } : {}),
  };
}

function publicPolicyConfig(
  policy: InstallConfig["policy"],
): InstallConfig["policy"] {
  const providerCredentials = policy.providerCredentials;
  const normalizedProviderCredentials = providerCredentials
    ? {
        ...(providerCredentials.requireTemporary === true
          ? { requireTemporary: true }
          : {}),
        ...(providerCredentials.requireTtlEnforced === true
          ? { requireTtlEnforced: true }
          : {}),
      }
    : undefined;
  const scopeBoundary = normalizeScopeBoundaryPolicy(policy.scopeBoundary);
  return {
    ...policy,
    ...(normalizedProviderCredentials
      ? { providerCredentials: normalizedProviderCredentials }
      : {}),
    ...(scopeBoundary ? { scopeBoundary } : {}),
  };
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

function isStoreInstallConfig(config: InstallConfig): boolean {
  if (config.workspaceId !== undefined) return false;
  return config.store?.source !== undefined;
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
      method: "POST",
      path: TAKOSUMI_WORKSPACE_CAPSULES_ROUTE,
      summary:
        "Creates a Capsule under a Workspace (UNIQUE(workspace, name, environment)) from a Source + InstallConfig.",
      auth: "deploy-control-token",
      operationId: "createCapsule",
      openapi: {
        pathParams: ["workspaceId"],
        requestSchema: "CreateCapsuleRequest",
        okStatus: "201",
        okSchema: "CapsuleResponse",
      },
      notImplementedMessage: "capsules not wired",
    },
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
        requestSchema: "CapsulePlanRequest",
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

  app.post(
    TAKOSUMI_WORKSPACE_CAPSULES_ROUTE,
    deployControlBodyLimit,
    defineRoute({
      ctx,
      requireService: requireCapsules,
      param: WORKSPACE_ID_PARAM,
      enforceBody: true,
      handler: async ({ c, principal, id }) => {
        ensureWorkspacePermission(principal, id);
        const body = await readJsonBody<CreateCapsuleRouteRequest>(
          c,
          "capsuleCreate",
        );
        const {
          outputAllowlist: rawOutputAllowlist,
          interfaceBlueprints: rawInterfaceBlueprints,
          modulePath: rawModulePath,
          vars: rawVars,
          runnerId: rawRunnerId,
          managedPublicHostname: rawManagedPublicHostname,
          ...request
        } = body as Omit<
          CreateCapsuleRouteRequest,
          | "outputAllowlist"
          | "interfaceBlueprints"
          | "modulePath"
          | "vars"
          | "runnerId"
          | "managedPublicHostname"
        > & {
          readonly outputAllowlist?: unknown;
          readonly interfaceBlueprints?: unknown;
          readonly modulePath?: unknown;
          readonly vars?: unknown;
          readonly runnerId?: unknown;
          readonly managedPublicHostname?: unknown;
        };
        const outputAllowlist =
          rawOutputAllowlist === undefined
            ? undefined
            : outputAllowlistValue(rawOutputAllowlist);
        if (rawOutputAllowlist !== undefined && outputAllowlist === undefined) {
          throw new OpenTofuControllerError(
            "invalid_argument",
            "outputAllowlist must be an object of { from, type, required?, sensitive? } entries",
          );
        }
        let interfaceBlueprints:
          readonly CapsuleInterfaceBlueprint[] | undefined;
        if (rawInterfaceBlueprints !== undefined) {
          if (!Array.isArray(rawInterfaceBlueprints)) {
            throw new OpenTofuControllerError(
              "invalid_argument",
              "interfaceBlueprints must be an array",
            );
          }
          try {
            validateCapsuleInterfaceBlueprints(
              rawInterfaceBlueprints as readonly CapsuleInterfaceBlueprint[],
            );
          } catch (error) {
            throw new OpenTofuControllerError(
              "invalid_argument",
              error instanceof Error
                ? error.message
                : "interfaceBlueprints contains an invalid declaration",
            );
          }
          interfaceBlueprints =
            rawInterfaceBlueprints as readonly CapsuleInterfaceBlueprint[];
        }
        const modulePath =
          rawModulePath === undefined
            ? undefined
            : modulePathValue(rawModulePath);
        if (rawModulePath !== undefined && modulePath === undefined) {
          throw new OpenTofuControllerError(
            "invalid_argument",
            "modulePath must be a safe relative path inside the SourceSnapshot",
          );
        }
        const vars =
          rawVars === undefined ? undefined : jsonRecordValue(rawVars);
        if (rawVars !== undefined && vars === undefined) {
          throw new OpenTofuControllerError(
            "invalid_argument",
            "vars must be an object of JSON values keyed by OpenTofu variable names",
          );
        }
        const normalizedVars =
          vars === undefined
            ? undefined
            : normalizeVariablePathRecord(vars, "vars");
        const runnerProfileId =
          rawRunnerId === undefined
            ? undefined
            : runnerIdFromBody({ runnerId: rawRunnerId });
        if (runnerProfileId) {
          ensureRunnerProfilePermission(principal, runnerProfileId);
        }
        const managedPublicHostname = managedPublicHostnameValue(
          rawManagedPublicHostname,
        );
        if (
          rawManagedPublicHostname !== undefined &&
          managedPublicHostname === undefined
        ) {
          throw new OpenTofuControllerError(
            "invalid_argument",
            "managedPublicHostname must be { mode: 'scoped' | 'vanity' }",
          );
        }
        const baseInstallConfig = await capsules!.getInstallConfig(
          request.installConfigId,
        );
        const selectedInterfaceBlueprints =
          interfaceBlueprints ?? baseInstallConfig.interfaceBlueprints;
        const needsInstallingPrincipalScope =
          capsuleInterfaceBlueprintsNeedInstallingPrincipal(
            selectedInterfaceBlueprints,
          );
        const installConfigId =
          (normalizedVars !== undefined &&
            Object.keys(normalizedVars).length > 0) ||
          modulePath !== undefined ||
          runnerProfileId ||
          outputAllowlist !== undefined ||
          interfaceBlueprints !== undefined ||
          managedPublicHostname !== undefined ||
          needsInstallingPrincipalScope
            ? (
                await createScopedInstallConfigForCapsule({
                  capsules: capsules!,
                  workspaceId: id,
                  baseInstallConfig,
                  capsuleName: request.name,
                  modulePath,
                  vars: normalizedVars ?? {},
                  outputAllowlist,
                  interfaceBlueprints: selectedInterfaceBlueprints,
                  installingPrincipalId: principal.actor,
                  runnerProfileId,
                  managedPublicHostname,
                })
              ).id
            : request.installConfigId;
        const capsule = await capsules!.createCapsule({
          ...request,
          workspaceId: id,
          installConfigId,
        });
        return c.json(capsuleResponse(capsule), 201);
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
        // Without a workspaceId only shared configs are returned; with one,
        // shared configs plus that Workspace's own configs. The
        // shared + scoped union is a small set, so it is materialized, merge-
        // sorted by (createdAt, id), and bounded with the in-memory keyset pager
        // (a keyset across a UNION query would be unsound).
        const sharedConfigs = (await capsules!.listInstallConfigs()).filter(
          (config) =>
            config.workspaceId === undefined &&
            isSelectableInstallConfig(config),
        );
        const scoped =
          workspaceId === undefined || view.view === "store"
            ? []
            : (await capsules!.listInstallConfigs(workspaceId)).filter(
                isSelectableInstallConfig,
              );
        const merged = (
          view.view === "store"
            ? sharedConfigs.filter(isStoreInstallConfig)
            : [...sharedConfigs, ...scoped]
        ).sort(
          (a, b) =>
            a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        );
        const { items, nextCursor } = pageSorted(merged, page.value);
        return c.json(
          {
            installConfigs: items.map(publicInstallConfig),
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
        return c.json({ installConfig: publicInstallConfig(config) }, 200);
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
        const response = await controller.createCapsuleDestroyPlan(
          id,
          {
            actor: principal.actor,
          },
          runnerProfileId ? { runnerProfileId } : {},
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

async function createScopedInstallConfigForCapsule(input: {
  readonly capsules: CapsulesService;
  readonly workspaceId: string;
  readonly baseInstallConfig: InstallConfig;
  readonly capsuleName: string;
  readonly modulePath?: string;
  readonly vars: Readonly<Record<string, JsonValue>>;
  readonly outputAllowlist?: InstallConfig["outputAllowlist"];
  readonly interfaceBlueprints?: readonly CapsuleInterfaceBlueprint[];
  readonly installingPrincipalId: string;
  readonly runnerProfileId?: string;
  readonly managedPublicHostname?: ManagedPublicHostnameAllocation;
}): Promise<InstallConfig> {
  for (const [key, value] of Object.entries(input.vars)) {
    if (!isJsonValue(value)) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `vars.${key} must be a JSON value`,
      );
    }
  }
  const baseConfig = input.baseInstallConfig;
  if (
    baseConfig.workspaceId !== undefined &&
    baseConfig.workspaceId !== input.workspaceId
  ) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "install config is not available to this workspace",
    );
  }
  const now = new Date().toISOString();
  const { modulePath: _baseModulePath, ...baseConfigWithoutModulePath } =
    baseConfig;
  const configBase =
    input.modulePath === "" ? baseConfigWithoutModulePath : baseConfig;
  return await input.capsules.putInstallConfig({
    ...configBase,
    id: `cfg_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
    workspaceId: input.workspaceId,
    name: `${input.capsuleName}-config`,
    internal: { reason: "per_install_overrides" },
    ...(input.modulePath ? { modulePath: input.modulePath } : {}),
    variableMapping: { ...baseConfig.variableMapping, ...input.vars },
    ...(input.runnerProfileId ? { runnerId: input.runnerProfileId } : {}),
    ...(input.managedPublicHostname
      ? { managedPublicHostname: input.managedPublicHostname }
      : {}),
    ...(input.interfaceBlueprints
      ? {
          interfaceBlueprints:
            resolveCapsuleInterfaceBlueprintInstallingPrincipal(
              input.interfaceBlueprints,
              input.installingPrincipalId,
            ),
        }
      : {}),
    outputAllowlist:
      input.outputAllowlist ?? scopedCloneOutputAllowlist(baseConfig),
    createdAt: now,
    updatedAt: now,
  });
}

function managedPublicHostnameValue(
  value: unknown,
): ManagedPublicHostnameAllocation | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const mode = (value as { readonly mode?: unknown }).mode;
  return mode === "scoped" || mode === "vanity" ? { mode } : undefined;
}

function isSelectableInstallConfig(config: InstallConfig): boolean {
  if (config.internal?.reason === "per_install_overrides") return false;
  if (
    config.workspaceId !== undefined &&
    /^icfg_[0-9a-f]{16}$/iu.test(config.id)
  ) {
    return false;
  }
  return true;
}

function scopedCloneOutputAllowlist(
  baseConfig: InstallConfig,
): InstallConfig["outputAllowlist"] {
  if (Object.keys(baseConfig.outputAllowlist).length > 0) {
    return baseConfig.outputAllowlist;
  }
  return defaultCapsuleOutputAllowlist();
}

function modulePathValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (!raw) return undefined;
  if (isAbsolute(raw) || raw.includes("\0") || /^[A-Za-z]:[\\/]/u.test(raw)) {
    return undefined;
  }
  const normalized = normalize(raw)
    .replaceAll("\\", "/")
    .replace(/^\.\//u, "")
    .replace(/\/+$/u, "");
  if (normalized.length === 0 || normalized === ".") return "";
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    return undefined;
  }
  return normalized;
}

function outputAllowlistValue(
  value: unknown,
): InstallConfig["outputAllowlist"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const out: Record<string, InstallConfig["outputAllowlist"][string]> = {};
  for (const [name, item] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) return undefined;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return undefined;
    }
    const record = item as Record<string, unknown>;
    const from = typeof record.from === "string" ? record.from.trim() : "";
    const type = typeof record.type === "string" ? record.type.trim() : "";
    if (!from || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(from)) return undefined;
    if (
      type !== "string" &&
      type !== "url" &&
      type !== "hostname" &&
      type !== "number" &&
      type !== "boolean" &&
      type !== "json"
    ) {
      return undefined;
    }
    out[name] = {
      from,
      type,
      ...(typeof record.required === "boolean"
        ? { required: record.required }
        : {}),
      ...(typeof record.sensitive === "boolean"
        ? { sensitive: record.sensitive }
        : {}),
    };
  }
  return out;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function jsonRecordValue(
  value: unknown,
): Readonly<Record<string, JsonValue>> | undefined {
  if (!isPlainJsonObject(value)) return undefined;
  const out: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!isJsonValue(item)) return undefined;
    out[key] = item;
  }
  return out;
}

function isPlainJsonObject(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
