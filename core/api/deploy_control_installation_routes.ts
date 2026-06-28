/**
 * §5 / §11 Installation + InstallConfig routes, the §30 public Installation /
 * Deployment reads (incl. rollback-plan), and the §10 / §23 installation-driven
 * plan / destroy-plan / drift-check routes (mounted consecutively in the
 * original). Owns its handlers and its slice of the
 * {@link DEPLOY_CONTROL_INTERNAL_ENDPOINTS} descriptor inventory.
 */

import type {
  CreateCapsuleRequest,
  CapsulesService,
} from "../domains/capsules/mod.ts";
import type {
  InstallConfig,
  Installation,
  InstallationStatus,
  PublicInstallConfig,
  PublicInstallation,
} from "takosumi-contract/installations";
import type { JsonValue } from "takosumi-contract";
import { isAbsolute, normalize } from "node:path";
import {
  defineRoute,
  type DeployControlEndpoint,
  type DeployControlRouteContext,
  ensureRunnerProfilePermission,
  ensureSpacePermission,
  errorEnvelope,
  nonEmptyString,
  parsePageParams,
  readJsonBody,
  readOptionalJsonBody,
  DEPLOYMENT_ID_PATTERN,
  SPACE_ID_PATTERN,
} from "./deploy_control_shared.ts";
import { OpenTofuControllerError } from "../domains/deploy-control/errors.ts";
import {
  DEFAULT_CAPSULE_INSTALL_CONFIG_ID,
  defaultCapsuleOutputAllowlist,
} from "../domains/capsules/official_seed.ts";
import { pageSorted } from "takosumi-contract/pagination";
import {
  TAKOSUMI_API_INSTALLATION_DEPLOYMENTS_ROUTE,
  TAKOSUMI_API_INSTALLATION_ROUTE,
  TAKOSUMI_DEPLOYMENT_ROLLBACK_PLAN_ROUTE,
  TAKOSUMI_DEPLOYMENT_ROUTE,
  TAKOSUMI_INSTALL_CONFIG_ROUTE,
  TAKOSUMI_INSTALL_CONFIGS_ROUTE,
  TAKOSUMI_INSTALLATION_DESTROY_PLAN_ROUTE,
  TAKOSUMI_INSTALLATION_DRIFT_CHECK_ROUTE,
  TAKOSUMI_INSTALLATION_PLAN_ROUTE,
  TAKOSUMI_SPACE_INSTALLATIONS_ROUTE,
} from "./deploy_control_route_paths.ts";

const SPACE_ID_PARAM = { param: "spaceId", pattern: SPACE_ID_PATTERN } as const;
const DEPLOYMENT_ID_PARAM = {
  param: "deploymentId",
  pattern: DEPLOYMENT_ID_PATTERN,
} as const;
const INSTALL_CONFIG_ID_PARAM = {
  param: "installConfigId",
  pattern: /^cfg[-_][0-9a-zA-Z-]{3,96}$/,
} as const;
const INSTALLATION_ID_PARAM = { id: "installationId" } as const;

interface PatchInstallationRequest {
  readonly status?: InstallationStatus;
}

interface CreateInstallationRouteRequest extends Omit<
  CreateCapsuleRequest,
  "spaceId"
> {
  readonly modulePath?: string;
  readonly outputAllowlist?: InstallConfig["outputAllowlist"];
  readonly runnerId?: string;
  readonly vars?: Readonly<Record<string, JsonValue>>;
}

interface InstallationPlanRouteRequest {
  readonly runnerId?: string;
}

const API_PATCHABLE_INSTALLATION_STATUSES: ReadonlySet<InstallationStatus> =
  new Set(["active", "stale", "error"]);

function publicInstallation(installation: Installation): PublicInstallation {
  const {
    installType: _installType,
    currentOutputSnapshotId: _currentOutputSnapshotId,
    ...publicRecord
  } = installation;
  return publicRecord;
}

function publicInstallConfig(config: InstallConfig): PublicInstallConfig {
  const {
    installType: _installType,
    templateBinding: _templateBinding,
    sourceKind: _sourceKind,
    runnerId: _runnerId,
    internal: _internal,
    build: _build,
    prebuiltArtifact: _prebuiltArtifact,
    ...publicRecord
  } = config;
  return {
    ...publicRecord,
    sourceKind: publicInstallConfigSourceKind(config),
  };
}

function publicInstallConfigSourceKind(
  config: InstallConfig,
): PublicInstallConfig["sourceKind"] {
  if (config.sourceKind === "generic_capsule") return "generic_capsule";
  if (
    config.sourceKind === "first_party_capsule" ||
    config.sourceKind === "official_template" ||
    config.templateBinding
  ) {
    return "first_party_capsule";
  }
  return "generic_capsule";
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

type InstallConfigListView = "all" | "starter-catalog";

function parseInstallConfigListView(
  raw: string | undefined,
):
  | { readonly kind: "ok"; readonly view: InstallConfigListView }
  | { readonly kind: "invalid"; readonly response: Response } {
  if (raw === undefined || raw === "" || raw === "all") {
    return { kind: "ok", view: "all" };
  }
  if (raw === "starter-catalog") {
    return { kind: "ok", view: "starter-catalog" };
  }
  return {
    kind: "invalid",
    response: new Response(
      JSON.stringify({
        error: {
          code: "invalid_argument",
          message: "view must be all or starter-catalog",
        },
      }),
      {
        status: 400,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    ),
  };
}

function isStarterCatalogInstallConfig(config: InstallConfig): boolean {
  if (config.spaceId !== undefined) return false;
  if (config.id === DEFAULT_CAPSULE_INSTALL_CONFIG_ID) return true;
  return (
    config.trustLevel === "official" && config.catalog?.source !== undefined
  );
}

export const DEPLOY_CONTROL_INSTALLATION_ENDPOINTS: readonly DeployControlEndpoint[] =
  [
    {
      method: "POST",
      path: TAKOSUMI_SPACE_INSTALLATIONS_ROUTE,
      summary:
        "Creates an Installation under a Space (UNIQUE(space, name, environment)) from a Source + InstallConfig.",
      auth: "deploy-control-token",
      operationId: "createInstallation",
      openapi: {
        pathParams: ["spaceId"],
        requestSchema: "CreateCapsuleRequest",
        okStatus: "201",
        okSchema: "InstallationResponse",
      },
      notImplementedMessage: "installations not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_SPACE_INSTALLATIONS_ROUTE,
      summary: "Lists the Installations of a Space.",
      auth: "deploy-control-token",
      operationId: "listInstallations",
      openapi: {
        pathParams: ["spaceId"],
        okSchema: "ListInstallationsResponse",
      },
      notImplementedMessage: "installations not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_API_INSTALLATION_ROUTE,
      summary: "Reads an Installation ledger record (§30 public surface).",
      auth: "deploy-control-token",
      operationId: "getApiInstallation",
      openapi: {
        pathParams: ["installationId"],
        okSchema: "GetInstallationResponse",
      },
      notImplementedMessage: "installations not wired",
    },
    {
      method: "PATCH",
      path: TAKOSUMI_API_INSTALLATION_ROUTE,
      summary:
        "Updates safe mutable Installation fields; MVP exposes status patching for active/stale/error only.",
      auth: "deploy-control-token",
      operationId: "patchApiInstallation",
      openapi: {
        pathParams: ["installationId"],
        requestSchema: "PatchInstallationRequest",
        okSchema: "GetInstallationResponse",
      },
      notImplementedMessage: "installations not wired",
    },
    {
      method: "DELETE",
      path: TAKOSUMI_API_INSTALLATION_ROUTE,
      summary:
        "Starts the canonical destroy flow by creating a destroy-plan Run; approval + destroy_apply perform teardown.",
      auth: "deploy-control-token",
      operationId: "deleteApiInstallation",
      openapi: {
        pathParams: ["installationId"],
        okStatus: "202",
        okSchema: "RunResponse",
      },
      notImplementedMessage: "installations not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_API_INSTALLATION_DEPLOYMENTS_ROUTE,
      summary:
        "Lists Deployment records for an Installation (§30 public surface).",
      auth: "deploy-control-token",
      operationId: "listApiInstallationDeployments",
      openapi: {
        pathParams: ["installationId"],
        okSchema: "ListDeploymentsResponse",
      },
      notImplementedMessage: "deployment ledger not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_DEPLOYMENT_ROUTE,
      summary: "Reads a Deployment ledger record.",
      auth: "deploy-control-token",
      operationId: "getDeployment",
      openapi: { pathParams: ["deploymentId"], okSchema: "DeploymentResponse" },
      notImplementedMessage: "deployment ledger not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_DEPLOYMENT_ROLLBACK_PLAN_ROUTE,
      summary:
        "Creates a rollback plan run for a Deployment, pinned to that Deployment's source snapshot (flows through normal approval/apply).",
      auth: "deploy-control-token",
      operationId: "createDeploymentRollbackPlan",
      openapi: {
        pathParams: ["deploymentId"],
        okStatus: "201",
        okSchema: "RunResponse",
      },
      notImplementedMessage: "deployment rollback not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_INSTALL_CONFIGS_ROUTE,
      summary:
        "Lists built-in shared InstallConfigs plus the Space's own configs when spaceId is given.",
      auth: "deploy-control-token",
      operationId: "listInstallConfigs",
      openapi: { query: ["spaceId"], okSchema: "ListInstallConfigsResponse" },
      notImplementedMessage: "installations not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_INSTALL_CONFIG_ROUTE,
      summary:
        "Reads a public InstallConfig projection (built-in shared config or a Space-owned config).",
      auth: "deploy-control-token",
      operationId: "getInstallConfig",
      openapi: {
        pathParams: ["installConfigId"],
        okSchema: "InstallConfigResponse",
      },
      notImplementedMessage: "installations not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_INSTALLATION_PLAN_ROUTE,
      summary:
        "Creates an Installation-driven plan run: resolves the Source's latest SourceSnapshot and dispatches with installation state scope.",
      auth: "deploy-control-token",
      operationId: "createInstallationPlan",
      openapi: {
        pathParams: ["installationId"],
        requestSchema: "InstallationPlanRequest",
        okStatus: "201",
        okSchema: "RunResponse",
      },
      notImplementedMessage: "installations not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_INSTALLATION_DESTROY_PLAN_ROUTE,
      summary:
        "Creates an Installation-driven destroy-plan run (always lands waiting_approval per spec §23).",
      auth: "deploy-control-token",
      operationId: "createInstallationDestroyPlan",
      openapi: {
        pathParams: ["installationId"],
        requestSchema: "InstallationPlanRequest",
        okStatus: "201",
        okSchema: "RunResponse",
      },
      notImplementedMessage: "installations not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_INSTALLATION_DRIFT_CHECK_ROUTE,
      summary:
        "Creates an Installation-driven drift-check run (read-only drift_check; never applyable).",
      auth: "deploy-control-token",
      operationId: "createInstallationDriftCheck",
      openapi: {
        pathParams: ["installationId"],
        okStatus: "201",
        okSchema: "RunResponse",
      },
      notImplementedMessage: "installations not wired",
    },
  ];

export function mountDeployControlInstallationRoutes(
  ctx: DeployControlRouteContext,
): void {
  const { app, dependencies, controller, deployControlBodyLimit } = ctx;
  const installations = dependencies.installationsService;
  const requireInstallations = (
    deps: typeof dependencies,
  ): string | undefined =>
    deps.installationsService ? undefined : "installations not wired";

  app.post(
    TAKOSUMI_SPACE_INSTALLATIONS_ROUTE,
    deployControlBodyLimit,
    defineRoute({
      ctx,
      requireService: requireInstallations,
      param: SPACE_ID_PARAM,
      enforceBody: true,
      handler: async ({ c, principal, id }) => {
        ensureSpacePermission(principal, id);
        const body = await readJsonBody<CreateInstallationRouteRequest>(
          c,
          "installationCreate",
        );
        const {
          outputAllowlist: rawOutputAllowlist,
          modulePath: rawModulePath,
          vars: rawVars,
          runnerId: rawRunnerId,
          ...request
        } = body as Omit<
          CreateInstallationRouteRequest,
          "outputAllowlist" | "modulePath" | "vars" | "runnerId"
        > & {
          readonly outputAllowlist?: unknown;
          readonly modulePath?: unknown;
          readonly vars?: unknown;
          readonly runnerId?: unknown;
        };
        const outputAllowlist =
          rawOutputAllowlist === undefined
            ? undefined
            : outputAllowlistValue(rawOutputAllowlist);
        if (rawOutputAllowlist !== undefined && outputAllowlist === undefined) {
          throw new OpenTofuControllerError(
            "invalid_argument",
            "outputAllowlist must be an object of { from, type, required? } entries",
          );
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
        const runnerProfileId =
          rawRunnerId === undefined
            ? undefined
            : runnerIdFromBody({ runnerId: rawRunnerId });
        if (runnerProfileId) {
          ensureRunnerProfilePermission(principal, runnerProfileId);
        }
        const installConfigId =
          (vars !== undefined && Object.keys(vars).length > 0) ||
          modulePath !== undefined ||
          runnerProfileId ||
          outputAllowlist !== undefined
            ? (
                await createScopedInstallConfigForInstallation({
                  installations: installations!,
                  spaceId: id,
                  baseInstallConfigId: request.installConfigId,
                  installationName: request.name,
                  modulePath,
                  vars: vars ?? {},
                  outputAllowlist,
                  runnerProfileId,
                })
              ).id
            : request.installConfigId;
        const installation = await installations!.createCapsule({
          ...request,
          workspaceId: id,
          installConfigId,
        });
        return c.json({ installation: publicInstallation(installation) }, 201);
      },
    }),
  );

  app.get(
    TAKOSUMI_SPACE_INSTALLATIONS_ROUTE,
    defineRoute({
      ctx,
      requireService: requireInstallations,
      param: SPACE_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        ensureSpacePermission(principal, id);
        const page = parsePageParams(c);
        if (page.kind === "invalid") return page.response;
        const result = await installations!.listCapsulesPage(
          id,
          page.value,
        );
        return c.json(
          {
            installations: result.items.map(publicInstallation),
            ...(result.nextCursor !== undefined
              ? { nextCursor: result.nextCursor }
              : {}),
          },
          200,
        );
      },
    }),
  );

  // --- PUBLIC §30 Installation + Deployment reads --------------------------

  app.get(
    TAKOSUMI_API_INSTALLATION_ROUTE,
    defineRoute({
      ctx,
      param: INSTALLATION_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        const response = await controller.getInstallation(id);
        ensureSpacePermission(principal, response.capsule.workspaceId);
        return c.json(response, 200);
      },
    }),
  );

  app.patch(
    TAKOSUMI_API_INSTALLATION_ROUTE,
    deployControlBodyLimit,
    defineRoute({
      ctx,
      requireService: requireInstallations,
      param: INSTALLATION_ID_PARAM,
      enforceBody: true,
      handler: async ({ c, principal, id }) => {
        const existing = await controller.getInstallation(id);
        ensureSpacePermission(principal, existing.capsule.workspaceId);
        const body = await readJsonBody<PatchInstallationRequest>(
          c,
          "installationPatch",
        );
        if (body.status === undefined) {
          return c.json(
            errorEnvelope(
              c,
              "invalid_argument",
              "PATCH /internal/v1/installations/:installationId requires status",
            ),
            400,
          );
        }
        if (!API_PATCHABLE_INSTALLATION_STATUSES.has(body.status)) {
          return c.json(
            errorEnvelope(
              c,
              "invalid_argument",
              "status may only be patched to active, stale, or error; destroy states must use the destroy flow",
            ),
            400,
          );
        }
        const installation = await installations!.patchCapsuleStatus(
          id,
          body.status,
        );
        return c.json({ installation: publicInstallation(installation) }, 200);
      },
    }),
  );

  app.delete(
    TAKOSUMI_API_INSTALLATION_ROUTE,
    defineRoute({
      ctx,
      param: INSTALLATION_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        const existing = await controller.getInstallation(id);
        ensureSpacePermission(principal, existing.capsule.workspaceId);
        const response = await controller.createInstallationDestroyPlan(id, {
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
    TAKOSUMI_API_INSTALLATION_DEPLOYMENTS_ROUTE,
    defineRoute({
      ctx,
      param: INSTALLATION_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        const installation = await controller.getInstallation(id);
        ensureSpacePermission(principal, installation.capsule.workspaceId);
        const page = parsePageParams(c);
        if (page.kind === "invalid") return page.response;
        return c.json(await controller.listDeployments(id, page.value), 200);
      },
    }),
  );

  app.get(
    TAKOSUMI_DEPLOYMENT_ROUTE,
    defineRoute({
      ctx,
      param: DEPLOYMENT_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        const deployment = await controller.getDeployment(id);
        ensureSpacePermission(principal, deployment.spaceId);
        return c.json({ deployment }, 200);
      },
    }),
  );

  app.post(
    TAKOSUMI_DEPLOYMENT_ROLLBACK_PLAN_ROUTE,
    defineRoute({
      ctx,
      param: DEPLOYMENT_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        // Resolve the Deployment first so the rollback plan is space-permission
        // gated via its Space, then create the pinned rollback plan.
        const deployment = await controller.getDeployment(id);
        ensureSpacePermission(principal, deployment.spaceId);
        const response = await controller.createDeploymentRollbackPlan(id, {
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
      requireService: requireInstallations,
      handler: async ({ c, principal }) => {
        const spaceId = c.req.query("spaceId");
        if (spaceId !== undefined) {
          if (!SPACE_ID_PATTERN.test(spaceId)) {
            return c.json(
              errorEnvelope(
                c,
                "invalid_argument",
                "spaceId has an unsupported shape",
              ),
              400,
            );
          }
          ensureSpacePermission(principal, spaceId);
        }
        const page = parsePageParams(c);
        if (page.kind === "invalid") return page.response;
        const view = parseInstallConfigListView(c.req.query("view"));
        if (view.kind === "invalid") return view.response;
        // Without a spaceId only built-in shared configs (spaceId-less configs)
        // are returned; with one, built-ins plus that Space's own configs. The
        // official + scoped union is a small set, so it is materialized, merge-
        // sorted by (createdAt, id), and bounded with the in-memory keyset pager
        // (a keyset across a UNION query would be unsound).
        const official = (await installations!.listInstallConfigs()).filter(
          (config) =>
            config.spaceId === undefined && isSelectableInstallConfig(config),
        );
        const scoped =
          spaceId === undefined
            ? []
            : (await installations!.listInstallConfigs(spaceId)).filter(
                isSelectableInstallConfig,
              );
        const merged = (
          view.view === "starter-catalog"
            ? official.filter(isStarterCatalogInstallConfig)
            : [...official, ...scoped]
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

  // --- Installation-driven plan / destroy-plan (§10 / §23) ------------------

  app.post(
    TAKOSUMI_INSTALLATION_PLAN_ROUTE,
    defineRoute({
      ctx,
      param: INSTALLATION_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        const installation = await controller.getInstallation(id);
        ensureSpacePermission(principal, installation.capsule.workspaceId);
        const body = await readOptionalJsonBody<InstallationPlanRouteRequest>(
          c,
          "installationPlan",
        );
        const runnerProfileId = runnerIdFromBody(body);
        const response = await controller.createInstallationPlan(
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

  app.get(
    TAKOSUMI_INSTALL_CONFIG_ROUTE,
    defineRoute({
      ctx,
      requireService: requireInstallations,
      param: INSTALL_CONFIG_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        const config = await installations!.getInstallConfig(id);
        if (config.spaceId !== undefined) {
          ensureSpacePermission(principal, config.spaceId);
        }
        return c.json({ installConfig: publicInstallConfig(config) }, 200);
      },
    }),
  );

  app.post(
    TAKOSUMI_INSTALLATION_DESTROY_PLAN_ROUTE,
    defineRoute({
      ctx,
      param: INSTALLATION_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        const installation = await controller.getInstallation(id);
        ensureSpacePermission(principal, installation.capsule.workspaceId);
        const body = await readOptionalJsonBody<InstallationPlanRouteRequest>(
          c,
          "installationDestroyPlan",
        );
        const runnerProfileId = runnerIdFromBody(body);
        const response = await controller.createInstallationDestroyPlan(
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

  // Drift check is a canonical read-only Run type. It is Space-permission gated
  // like plan/destroy-plan, but never produces an applyable saved plan.
  app.post(
    TAKOSUMI_INSTALLATION_DRIFT_CHECK_ROUTE,
    defineRoute({
      ctx,
      param: INSTALLATION_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        const installation = await controller.getInstallation(id);
        ensureSpacePermission(principal, installation.capsule.workspaceId);
        const response = await controller.createInstallationDriftCheck(id, {
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

async function createScopedInstallConfigForInstallation(input: {
  readonly installations: CapsulesService;
  readonly spaceId: string;
  readonly baseInstallConfigId: string;
  readonly installationName: string;
  readonly modulePath?: string;
  readonly vars: Readonly<Record<string, JsonValue>>;
  readonly outputAllowlist?: InstallConfig["outputAllowlist"];
  readonly runnerProfileId?: string;
}): Promise<InstallConfig> {
  for (const [key, value] of Object.entries(input.vars)) {
    if (!isJsonValue(value)) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `vars.${key} must be a JSON value`,
      );
    }
  }
  const baseConfig = await input.installations.getInstallConfig(
    input.baseInstallConfigId,
  );
  if (
    baseConfig.spaceId !== undefined &&
    baseConfig.spaceId !== input.spaceId
  ) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `installConfigId ${input.baseInstallConfigId} is not available to space ${input.spaceId}`,
    );
  }
  const now = new Date().toISOString();
  return await input.installations.putInstallConfig({
    ...baseConfig,
    id: `cfg_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
    spaceId: input.spaceId,
    name: `${input.installationName}-config`,
    internal: { reason: "per_install_overrides" },
    ...(input.modulePath ? { modulePath: input.modulePath } : {}),
    variableMapping: { ...baseConfig.variableMapping, ...input.vars },
    ...(input.runnerProfileId ? { runnerId: input.runnerProfileId } : {}),
    outputAllowlist:
      input.outputAllowlist ?? scopedCloneOutputAllowlist(baseConfig),
    createdAt: now,
    updatedAt: now,
  });
}

function isSelectableInstallConfig(config: InstallConfig): boolean {
  if (config.internal?.reason === "per_install_overrides") return false;
  if (config.spaceId !== undefined && /^icfg_[0-9a-f]{16}$/iu.test(config.id)) {
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
  return baseConfig.sourceKind === "generic_capsule"
    ? defaultCapsuleOutputAllowlist()
    : baseConfig.outputAllowlist;
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
  if (
    normalized.length === 0 ||
    normalized === "." ||
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
