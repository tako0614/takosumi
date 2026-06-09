/**
 * §5 / §11 Installation + InstallConfig routes, the §30 public Installation /
 * Deployment reads (incl. rollback-plan), and the §10 / §23 installation-driven
 * plan / destroy-plan / drift-check routes (mounted consecutively in the
 * original). Owns its handlers and its slice of the
 * {@link DEPLOY_CONTROL_PUBLIC_ENDPOINTS} descriptor inventory.
 */

import type {
  CreateInstallationRequest,
} from "../domains/installations/mod.ts";
import type {
  InstallConfig,
  Installation,
  InstallationStatus,
  PublicInstallConfig,
  PublicInstallation,
} from "takosumi-contract/installations";
import {
  defineRoute,
  type DeployControlEndpoint,
  type DeployControlRouteContext,
  ensureSpacePermission,
  errorEnvelope,
  readJsonBody,
  DEPLOYMENT_ID_PATTERN,
  SPACE_ID_PATTERN,
} from "./deploy_control_shared.ts";
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
  pattern: /^cfg_[0-9a-zA-Z]{3,64}$/,
} as const;
const INSTALLATION_ID_PARAM = { id: "installationId" } as const;

interface PatchInstallationRequest {
  readonly status?: InstallationStatus;
}

const API_PATCHABLE_INSTALLATION_STATUSES: ReadonlySet<InstallationStatus> =
  new Set(["active", "stale", "error"]);

function publicInstallation(installation: Installation): PublicInstallation {
  const { installType: _installType, ...publicRecord } = installation;
  return publicRecord;
}

function publicInstallConfig(config: InstallConfig): PublicInstallConfig {
  const {
    installType: _installType,
    templateBinding: _templateBinding,
    ...publicRecord
  } = config;
  return publicRecord;
}

export const DEPLOY_CONTROL_INSTALLATION_ENDPOINTS:
  readonly DeployControlEndpoint[] = [
    {
      method: "POST",
      path: TAKOSUMI_SPACE_INSTALLATIONS_ROUTE,
      summary:
        "Creates an Installation under a Space (UNIQUE(space, name, environment)) from a Source + InstallConfig.",
      auth: "deploy-control-token",
      operationId: "createInstallation",
      openapi: {
        pathParams: ["spaceId"],
        requestSchema: "CreateInstallationRequest",
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
        const body = await readJsonBody<
          Omit<CreateInstallationRequest, "spaceId">
        >(c, "installationCreate");
        const installation = await installations!.createInstallation({
          ...body,
          spaceId: id,
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
        const records = await installations!.listInstallations(id);
        return c.json(
          { installations: records.map(publicInstallation) },
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
        ensureSpacePermission(principal, response.installation.spaceId);
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
        ensureSpacePermission(principal, existing.installation.spaceId);
        const body = await readJsonBody<PatchInstallationRequest>(
          c,
          "installationPatch",
        );
        if (body.status === undefined) {
          return c.json(
            errorEnvelope(
              c,
              "invalid_argument",
              "PATCH /api/installations/:installationId requires status",
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
        const installation = await installations!.patchInstallationStatus(
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
        ensureSpacePermission(principal, existing.installation.spaceId);
        const response = await controller.createInstallationDestroyPlan(id, {
          actor: principal.actor,
        });
        return c.json({ run: await controller.getRun(response.planRun.id) }, 202);
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
        ensureSpacePermission(principal, installation.installation.spaceId);
        return c.json(await controller.listDeployments(id), 200);
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
        return c.json({ run: await controller.getRun(response.planRun.id) }, 201);
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
        // Without a spaceId only built-in shared configs (spaceId-less configs)
        // are returned; with one, built-ins plus that Space's own configs.
        const official = (await installations!.listInstallConfigs()).filter(
          (config) => config.spaceId === undefined,
        );
        const scoped = spaceId === undefined
          ? []
          : await installations!.listInstallConfigs(spaceId);
        return c.json(
          { installConfigs: [...official, ...scoped].map(publicInstallConfig) },
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
        ensureSpacePermission(principal, installation.installation.spaceId);
        const response = await controller.createInstallationPlan(id, {
          actor: principal.actor,
        });
        return c.json({ run: await controller.getRun(response.planRun.id) }, 201);
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
        ensureSpacePermission(principal, installation.installation.spaceId);
        const response = await controller.createInstallationDestroyPlan(id, {
          actor: principal.actor,
        });
        return c.json({ run: await controller.getRun(response.planRun.id) }, 201);
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
        ensureSpacePermission(principal, installation.installation.spaceId);
        const response = await controller.createInstallationDriftCheck(id, {
          actor: principal.actor,
        });
        return c.json({ run: await controller.getRun(response.planRun.id) }, 201);
      },
    }),
  );
}
