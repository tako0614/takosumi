/**
 * Public OpenTofu deployment-control-plane HTTP surface.
 *
 *   GET  /v1/runner-profiles
 *   POST /v1/plan-runs
 *   GET  /v1/plan-runs/{id}
 *   POST /v1/apply-runs
 *   GET  /v1/apply-runs/{id}
 *   GET  /v1/installations/{id}
 *   GET  /v1/installations/{id}/deployments
 *   GET  /v1/installations/{id}/deployment-outputs
 */

import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  APPLY_RUNS_PATH,
  CONNECTIONS_PATH,
  DEPLOY_CONTROL_ERROR_HTTP_STATUS_BY_CODE,
  RUNNER_PROFILES_PATH,
} from "takosumi-contract/deploy-control-api";
import type {
  CreateApplyRunRequest,
  CreateConnectionRequest,
  DeployControlErrorCode,
  DeployControlErrorEnvelope,
  DeployControlErrorHttpStatus,
  CreatePlanRunRequest,
  ListRunnerProfilesResponse,
  OpenTofuOperation,
} from "takosumi-contract/deploy-control-api";
import { SOURCES_PATH } from "takosumi-contract/sources";
import type {
  CreateSourceRequest,
  PatchSourceRequest,
} from "takosumi-contract/sources";
import {
  APPS_PATH,
  INSTALL_PROFILES_PATH,
} from "takosumi-contract/lanes";
import type {
  CreateAppRequest,
  CreateEnvironmentRequest,
  PatchAppRequest,
  PatchEnvironmentRequest,
  PutDeploymentProfileRequest,
} from "takosumi-contract/lanes";
import type { LanesService } from "../domains/lanes/mod.ts";
import {
  OpenTofuControllerError,
  type OpenTofuControllerErrorCode,
  type OpenTofuDeploymentController,
} from "../domains/deploy-control/mod.ts";
import { log } from "../shared/log.ts";
import { constantTimeEqualsString } from "../shared/constant_time.ts";
import type { ApiEndpoint } from "./route_families.ts";

export const TAKOSUMI_RUNNER_PROFILES_ROUTE = RUNNER_PROFILES_PATH;
export const TAKOSUMI_PLAN_RUNS_ROUTE = "/v1/plan-runs" as const;
export const TAKOSUMI_PLAN_RUN_ROUTE = "/v1/plan-runs/:planRunId" as const;
export const TAKOSUMI_APPLY_RUNS_ROUTE = APPLY_RUNS_PATH;
export const TAKOSUMI_APPLY_RUN_ROUTE = "/v1/apply-runs/:applyRunId" as const;
export const TAKOSUMI_INSTALLATION_ROUTE =
  "/v1/installations/:installationId" as const;
export const TAKOSUMI_INSTALLATION_DEPLOYMENTS_ROUTE =
  "/v1/installations/:installationId/deployments" as const;
export const TAKOSUMI_INSTALLATION_DEPLOYMENT_OUTPUTS_ROUTE =
  "/v1/installations/:installationId/deployment-outputs" as const;
export const TAKOSUMI_CONNECTIONS_ROUTE = CONNECTIONS_PATH;
export const TAKOSUMI_CONNECTION_ROUTE =
  "/v1/connections/:connectionId" as const;
export const TAKOSUMI_CONNECTION_TEST_ROUTE =
  "/v1/connections/:connectionId/test" as const;
export const TAKOSUMI_SOURCES_ROUTE = SOURCES_PATH;
export const TAKOSUMI_SOURCE_ROUTE = "/v1/sources/:sourceId" as const;
export const TAKOSUMI_SOURCE_SYNC_ROUTE =
  "/v1/sources/:sourceId/sync" as const;
export const TAKOSUMI_SOURCE_SNAPSHOTS_ROUTE =
  "/v1/sources/:sourceId/snapshots" as const;
export const TAKOSUMI_APPS_ROUTE = APPS_PATH;
export const TAKOSUMI_APP_ROUTE = "/v1/apps/:appId" as const;
export const TAKOSUMI_APP_ENVIRONMENTS_ROUTE =
  "/v1/apps/:appId/environments" as const;
export const TAKOSUMI_ENVIRONMENT_ROUTE =
  "/v1/environments/:environmentId" as const;
export const TAKOSUMI_DEPLOYMENT_PROFILE_ROUTE =
  "/v1/environments/:environmentId/deployment-profile" as const;
export const TAKOSUMI_INSTALL_PROFILES_ROUTE = INSTALL_PROFILES_PATH;
export const TAKOSUMI_INSTALL_PROFILE_ROUTE =
  "/v1/install-profiles/:installProfileId" as const;
export const TAKOSUMI_RUN_ROUTE = "/v1/runs/:runId" as const;
export const TAKOSUMI_RUN_APPROVE_ROUTE = "/v1/runs/:runId/approve" as const;
export const TAKOSUMI_RUN_CANCEL_ROUTE = "/v1/runs/:runId/cancel" as const;

/**
 * Endpoint inventory for the `deployControl-public` family, co-located with the
 * mount calls below. Consumed by `route_families.ts` to derive `/capabilities`
 * and `/openapi.json`. Keep in lockstep with {@link mountDeployControlPublicRoutes}.
 */
export const DEPLOY_CONTROL_PUBLIC_ENDPOINTS: readonly ApiEndpoint[] = [
  {
    method: "GET",
    path: TAKOSUMI_RUNNER_PROFILES_ROUTE,
    summary: "Lists OpenTofu runner profiles and provider allowlists.",
    auth: "deploy-control-token",
    operationId: "listRunnerProfiles",
    openapi: { okSchema: "ListRunnerProfilesResponse" },
  },
  {
    method: "POST",
    path: TAKOSUMI_PLAN_RUNS_ROUTE,
    summary:
      "Creates an OpenTofu plan run for a plain module source or an official template (templateId+inputs).",
    auth: "deploy-control-token",
    operationId: "createPlanRun",
    openapi: {
      requestSchema: "CreatePlanRunRequest",
      okStatus: "201",
      okSchema: "PlanRunResponse",
    },
  },
  {
    method: "GET",
    path: TAKOSUMI_PLAN_RUN_ROUTE,
    summary: "Reads an OpenTofu PlanRun.",
    auth: "deploy-control-token",
    operationId: "getPlanRun",
    openapi: { pathParams: ["planRunId"], okSchema: "PlanRunResponse" },
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
  },
  {
    method: "GET",
    path: TAKOSUMI_APPLY_RUN_ROUTE,
    summary: "Reads an OpenTofu ApplyRun.",
    auth: "deploy-control-token",
    operationId: "getApplyRun",
    openapi: { pathParams: ["applyRunId"], okSchema: "ApplyRunResponse" },
  },
  {
    method: "GET",
    path: TAKOSUMI_INSTALLATION_ROUTE,
    summary: "Reads an Installation ledger record.",
    auth: "deploy-control-token",
    operationId: "getInstallation",
    openapi: {
      pathParams: ["installationId"],
      okSchema: "GetInstallationResponse",
    },
  },
  {
    method: "GET",
    path: TAKOSUMI_INSTALLATION_DEPLOYMENTS_ROUTE,
    summary: "Lists Deployment records for an Installation.",
    auth: "deploy-control-token",
    operationId: "listInstallationDeployments",
    openapi: {
      pathParams: ["installationId"],
      okSchema: "ListDeploymentsResponse",
    },
  },
  {
    method: "GET",
    path: TAKOSUMI_INSTALLATION_DEPLOYMENT_OUTPUTS_ROUTE,
    summary:
      "Lists non-sensitive DeploymentOutput records for the current Deployment of an Installation.",
    auth: "deploy-control-token",
    operationId: "listInstallationDeploymentOutputs",
    openapi: {
      pathParams: ["installationId"],
      okSchema: "ListDeploymentOutputsResponse",
    },
  },
  {
    method: "POST",
    path: TAKOSUMI_CONNECTIONS_ROUTE,
    summary:
      "Registers provider credentials as a Connection (credential values are write-only).",
    auth: "deploy-control-token",
    operationId: "createConnection",
    openapi: {
      requestSchema: "CreateConnectionRequest",
      okStatus: "201",
      okSchema: "ConnectionResponse",
    },
  },
  {
    method: "GET",
    path: TAKOSUMI_CONNECTIONS_ROUTE,
    summary: "Lists Connections for a Space (never includes secret values).",
    auth: "deploy-control-token",
    operationId: "listConnections",
    openapi: { query: ["spaceId"], okSchema: "ListConnectionsResponse" },
  },
  {
    method: "POST",
    path: TAKOSUMI_CONNECTION_TEST_ROUTE,
    summary: "Verifies a Connection's stored credentials with the provider.",
    auth: "deploy-control-token",
    operationId: "testConnection",
    openapi: {
      pathParams: ["connectionId"],
      okSchema: "TestConnectionResponse",
    },
  },
  {
    method: "DELETE",
    path: TAKOSUMI_CONNECTION_ROUTE,
    summary: "Revokes a Connection and deletes its sealed secret blob.",
    auth: "deploy-control-token",
    operationId: "deleteConnection",
    openapi: {
      pathParams: ["connectionId"],
      okStatus: "204",
      okSchema: "EmptyResponse",
    },
  },
  {
    method: "POST",
    path: TAKOSUMI_SOURCES_ROUTE,
    summary:
      "Registers a git Source (URL-policy checked; ls-remote verification is a queued source_sync). Returns the hook secret once.",
    auth: "deploy-control-token",
    operationId: "createSource",
    openapi: {
      requestSchema: "CreateSourceRequest",
      okStatus: "201",
      okSchema: "CreateSourceResponse",
    },
  },
  {
    method: "GET",
    path: TAKOSUMI_SOURCES_ROUTE,
    summary: "Lists Sources for a Space (never includes the hook secret).",
    auth: "deploy-control-token",
    operationId: "listSources",
    openapi: { query: ["spaceId"], okSchema: "ListSourcesResponse" },
  },
  {
    method: "GET",
    path: TAKOSUMI_SOURCE_ROUTE,
    summary: "Reads a Source record.",
    auth: "deploy-control-token",
    operationId: "getSource",
    openapi: { pathParams: ["sourceId"], okSchema: "SourceResponse" },
  },
  {
    method: "PATCH",
    path: TAKOSUMI_SOURCE_ROUTE,
    summary: "Updates a Source (name / defaultRef / defaultPath / auth / status).",
    auth: "deploy-control-token",
    operationId: "patchSource",
    openapi: {
      pathParams: ["sourceId"],
      requestSchema: "PatchSourceRequest",
      okSchema: "SourceResponse",
    },
  },
  {
    method: "POST",
    path: TAKOSUMI_SOURCE_SYNC_ROUTE,
    summary:
      "Creates a source_sync run that resolves the source's default ref to an archive snapshot in the runner.",
    auth: "deploy-control-token",
    operationId: "createSourceSync",
    openapi: {
      pathParams: ["sourceId"],
      okStatus: "201",
      okSchema: "CreateSourceSyncResponse",
    },
  },
  {
    method: "GET",
    path: TAKOSUMI_SOURCE_SNAPSHOTS_ROUTE,
    summary: "Lists archive snapshots resolved for a Source.",
    auth: "deploy-control-token",
    operationId: "listSourceSnapshots",
    openapi: {
      pathParams: ["sourceId"],
      okSchema: "ListSourceSnapshotsResponse",
    },
  },
  {
    method: "POST",
    path: TAKOSUMI_APPS_ROUTE,
    summary: "Creates an App binding a Source to one install type.",
    auth: "deploy-control-token",
    operationId: "createApp",
    openapi: {
      requestSchema: "CreateAppRequest",
      okStatus: "201",
      okSchema: "AppResponse",
    },
  },
  {
    method: "GET",
    path: TAKOSUMI_APPS_ROUTE,
    summary: "Lists Apps for a Space.",
    auth: "deploy-control-token",
    operationId: "listApps",
    openapi: { query: ["spaceId"], okSchema: "ListAppsResponse" },
  },
  {
    method: "GET",
    path: TAKOSUMI_APP_ROUTE,
    summary: "Reads an App record.",
    auth: "deploy-control-token",
    operationId: "getApp",
    openapi: { pathParams: ["appId"], okSchema: "AppResponse" },
  },
  {
    method: "PATCH",
    path: TAKOSUMI_APP_ROUTE,
    summary: "Updates an App (name / install profile binding).",
    auth: "deploy-control-token",
    operationId: "patchApp",
    openapi: {
      pathParams: ["appId"],
      requestSchema: "PatchAppRequest",
      okSchema: "AppResponse",
    },
  },
  {
    method: "DELETE",
    path: TAKOSUMI_APP_ROUTE,
    summary: "Deletes an App (refused while Environments exist).",
    auth: "deploy-control-token",
    operationId: "deleteApp",
    openapi: {
      pathParams: ["appId"],
      okStatus: "204",
      okSchema: "EmptyResponse",
    },
  },
  {
    method: "POST",
    path: TAKOSUMI_APP_ENVIRONMENTS_ROUTE,
    summary:
      "Creates an Environment lane for an App (automation defaults by name production/preview).",
    auth: "deploy-control-token",
    operationId: "createEnvironment",
    openapi: {
      pathParams: ["appId"],
      requestSchema: "CreateEnvironmentRequest",
      okStatus: "201",
      okSchema: "EnvironmentResponse",
    },
  },
  {
    method: "GET",
    path: TAKOSUMI_APP_ENVIRONMENTS_ROUTE,
    summary: "Lists the Environment lanes of an App.",
    auth: "deploy-control-token",
    operationId: "listEnvironments",
    openapi: {
      pathParams: ["appId"],
      okSchema: "ListEnvironmentsResponse",
    },
  },
  {
    method: "GET",
    path: TAKOSUMI_ENVIRONMENT_ROUTE,
    summary: "Reads an Environment record.",
    auth: "deploy-control-token",
    operationId: "getEnvironment",
    openapi: {
      pathParams: ["environmentId"],
      okSchema: "EnvironmentResponse",
    },
  },
  {
    method: "PATCH",
    path: TAKOSUMI_ENVIRONMENT_ROUTE,
    summary:
      "Updates an Environment (ref / path / autoSync / autoPlan / autoApply / requireApproval).",
    auth: "deploy-control-token",
    operationId: "patchEnvironment",
    openapi: {
      pathParams: ["environmentId"],
      requestSchema: "PatchEnvironmentRequest",
      okSchema: "EnvironmentResponse",
    },
  },
  {
    method: "GET",
    path: TAKOSUMI_DEPLOYMENT_PROFILE_ROUTE,
    summary: "Reads the per-Environment Connection binding (DeploymentProfile).",
    auth: "deploy-control-token",
    operationId: "getDeploymentProfile",
    openapi: {
      pathParams: ["environmentId"],
      okSchema: "DeploymentProfileResponse",
    },
  },
  {
    method: "PUT",
    path: TAKOSUMI_DEPLOYMENT_PROFILE_ROUTE,
    summary:
      "Replaces the per-Environment Connection binding (DeploymentProfile). References Connection ids only.",
    auth: "deploy-control-token",
    operationId: "putDeploymentProfile",
    openapi: {
      pathParams: ["environmentId"],
      requestSchema: "PutDeploymentProfileRequest",
      okSchema: "DeploymentProfileResponse",
    },
  },
  {
    method: "GET",
    path: TAKOSUMI_INSTALL_PROFILES_ROUTE,
    summary:
      "Lists InstallProfiles (the official catalog seeded from templates plus operator profiles).",
    auth: "deploy-control-token",
    operationId: "listInstallProfiles",
    openapi: { okSchema: "ListInstallProfilesResponse" },
  },
  {
    method: "GET",
    path: TAKOSUMI_INSTALL_PROFILE_ROUTE,
    summary: "Reads an InstallProfile record.",
    auth: "deploy-control-token",
    operationId: "getInstallProfile",
    openapi: {
      pathParams: ["installProfileId"],
      okSchema: "InstallProfileResponse",
    },
  },
  {
    method: "GET",
    path: TAKOSUMI_RUN_ROUTE,
    summary:
      "Reads the unified Run projection (over the SourceSync / Plan / Apply ledgers).",
    auth: "deploy-control-token",
    operationId: "getRun",
    openapi: { pathParams: ["runId"], okSchema: "RunResponse" },
  },
  {
    method: "POST",
    path: TAKOSUMI_RUN_APPROVE_ROUTE,
    summary:
      "Approves a waiting-approval run (destroy plan or destructive change), clearing the apply gate.",
    auth: "deploy-control-token",
    operationId: "approveRun",
    openapi: {
      pathParams: ["runId"],
      requestSchema: "ApproveRunRequest",
      okSchema: "RunResponse",
    },
  },
  {
    method: "POST",
    path: TAKOSUMI_RUN_CANCEL_ROUTE,
    summary: "Cancels a queued or waiting-approval run.",
    auth: "deploy-control-token",
    operationId: "cancelRun",
    openapi: { pathParams: ["runId"], okSchema: "RunResponse" },
  },
] as const;

export const DEPLOY_CONTROL_JSON_BODY_LIMIT_BYTES = 1 * 1024 * 1024;

const ID_PATTERNS = {
  planRunId: /^plan_[0-9a-zA-Z]{8,64}$/,
  applyRunId: /^apply_[0-9a-zA-Z]{8,64}$/,
  installationId: /^ins_[0-9a-zA-Z]{8,64}$/,
} as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const ALLOWED_KEYS: Record<DeployControlRouteName, ReadonlySet<string>> = {
  planRunCreate: new Set([
    "spaceId",
    "source",
    "runnerProfileId",
    "installationId",
    "operation",
    "variables",
    "requiredProviders",
    "templateId",
    "templateVersion",
    "inputs",
  ]),
  applyRunCreate: new Set([
    "planRunId",
    "approval",
    "expected",
    "confirmDestructive",
  ]),
  connectionCreate: new Set([
    "spaceId",
    "provider",
    "kind",
    "authMethod",
    "displayName",
    "owner",
    "scope",
    "values",
  ]),
  sourceCreate: new Set([
    "spaceId",
    "name",
    "url",
    "defaultRef",
    "defaultPath",
    "authConnectionId",
  ]),
  sourcePatch: new Set([
    "name",
    "defaultRef",
    "defaultPath",
    "authConnectionId",
    "status",
  ]),
  appCreate: new Set([
    "spaceId",
    "name",
    "sourceId",
    "installType",
    "installProfileId",
  ]),
  appPatch: new Set(["name", "installProfileId"]),
  environmentCreate: new Set([
    "name",
    "ref",
    "path",
    "autoSync",
    "autoPlan",
    "autoApply",
    "requireApproval",
  ]),
  environmentPatch: new Set([
    "ref",
    "path",
    "autoSync",
    "autoPlan",
    "autoApply",
    "requireApproval",
  ]),
  deploymentProfilePut: new Set(["bindings"]),
  runApprove: new Set(["approvedBy", "reason"]),
};

type DeployControlRouteName =
  | "planRunCreate"
  | "applyRunCreate"
  | "connectionCreate"
  | "sourceCreate"
  | "sourcePatch"
  | "appCreate"
  | "appPatch"
  | "environmentCreate"
  | "environmentPatch"
  | "deploymentProfilePut"
  | "runApprove";

const CONNECTION_ID_PATTERN = /^conn_[0-9a-zA-Z]{8,64}$/;
const SOURCE_ID_PATTERN = /^src_[0-9a-zA-Z]{8,64}$/;
const APP_ID_PATTERN = /^app_[0-9a-zA-Z]{8,64}$/;
const ENVIRONMENT_ID_PATTERN = /^env_[0-9a-zA-Z]{8,64}$/;
const RUN_ID_PATTERN = /^(plan|apply|ssr)_[0-9a-zA-Z]{8,64}$/;
const INSTALL_PROFILE_ID_PATTERN = /^profile_[0-9a-zA-Z_]{1,96}$/;

export interface DeployControlPublicRouteDependencies {
  /**
   * DeployControl bearer resolver. When unset or empty, deploy control routes are
   * disabled and return 404 so public hosts do not leak an unconfigured
   * surface.
   */
  readonly getDeployControlToken?: () => string | undefined;
  /**
   * Optional scoped bearer resolver supplied by an operator/account-plane. When
   * present it receives the raw bearer value and must return the principal
   * scopes allowed for this request, or undefined to reject the bearer.
   */
  readonly authorizeDeployControlBearer?: (
    input: DeployControlBearerAuthorizationInput,
  ) => DeployControlPrincipal | undefined | Promise<DeployControlPrincipal | undefined>;
  /**
   * OpenTofu deployment controller. When unset, mounted endpoints return 501
   * after successful auth.
   */
  readonly controller?: OpenTofuDeploymentController;
  /**
   * Lanes domain service (Core Specification §6.3-§6.7). When unset, the
   * App / Environment / InstallProfile / DeploymentProfile routes return 501
   * after successful auth.
   */
  readonly lanesService?: LanesService;
}

export interface DeployControlBearerAuthorizationInput {
  readonly token: string;
  readonly request: Request;
}

export interface DeployControlPrincipal {
  readonly actor: string;
  readonly spaceIds?: readonly string[] | "*";
  readonly operations?: readonly OpenTofuOperation[] | "*";
  readonly runnerProfileIds?: readonly string[] | "*";
}

type DeployControlAuthResult =
  | { readonly ok: true; readonly principal: DeployControlPrincipal }
  | { readonly ok: false; readonly response: Response };

export function mountDeployControlPublicRoutes(
  app: Hono,
  dependencies: DeployControlPublicRouteDependencies = {},
): void {
  const controller = dependencies.controller;

  if (!controller) {
    mountNotImplementedRoutes(app, dependencies);
    return;
  }

  const deployControlBodyLimit = bodyLimit({
    maxSize: DEPLOY_CONTROL_JSON_BODY_LIMIT_BYTES,
    onError: (c) =>
      c.json(
        errorEnvelope(
          c,
          "resource_exhausted",
          `request body exceeds ${DEPLOY_CONTROL_JSON_BODY_LIMIT_BYTES} byte limit`,
        ),
        413,
      ),
  });

  app.get(TAKOSUMI_RUNNER_PROFILES_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    return await runHandler(c, async () =>
      c.json(
        filterRunnerProfilesForPrincipal(
          await controller.listRunnerProfiles(),
          auth.principal,
        ),
        200,
      )
    );
  });

  app.post(TAKOSUMI_PLAN_RUNS_ROUTE, deployControlBodyLimit, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    const bodyLimit = enforceBodyLimit(c, DEPLOY_CONTROL_JSON_BODY_LIMIT_BYTES);
    if (bodyLimit) return bodyLimit;
    return await runHandler(c, async () => {
      const body = await readJsonBody<CreatePlanRunRequest>(c, "planRunCreate");
      ensurePlanCreatePermission(auth.principal, body);
      const response = await controller.createPlanRun(body, {
        actor: auth.principal.actor,
      });
      return c.json(response, 201);
    });
  });

  app.get(TAKOSUMI_PLAN_RUN_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    const idCheck = ensureValidId(c, "planRunId");
    if (idCheck.kind === "invalid") return idCheck.response;
    return await runHandler(c, async () => {
      const response = await controller.getPlanRun(idCheck.value);
      ensureSpacePermission(auth.principal, response.planRun.spaceId);
      return c.json(response, 200);
    });
  });

  app.post(TAKOSUMI_APPLY_RUNS_ROUTE, deployControlBodyLimit, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    const bodyLimit = enforceBodyLimit(c, DEPLOY_CONTROL_JSON_BODY_LIMIT_BYTES);
    if (bodyLimit) return bodyLimit;
    return await runHandler(c, async () => {
      const body = await readJsonBody<CreateApplyRunRequest>(
        c,
        "applyRunCreate",
      );
      const plan = await controller.getPlanRun(body.planRunId);
      ensureApplyPermission(auth.principal, plan.planRun);
      const response = await controller.createApplyRun(body, {
        actor: auth.principal.actor,
      });
      return c.json(response, 201);
    });
  });

  app.get(TAKOSUMI_APPLY_RUN_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    const idCheck = ensureValidId(c, "applyRunId");
    if (idCheck.kind === "invalid") return idCheck.response;
    return await runHandler(c, async () => {
      const response = await controller.getApplyRun(idCheck.value);
      ensureSpacePermission(auth.principal, response.applyRun.spaceId);
      return c.json(response, 200);
    });
  });

  app.get(TAKOSUMI_INSTALLATION_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    const idCheck = ensureValidId(c, "installationId");
    if (idCheck.kind === "invalid") return idCheck.response;
    return await runHandler(c, async () => {
      const response = await controller.getInstallation(idCheck.value);
      ensureSpacePermission(auth.principal, response.installation.spaceId);
      return c.json(response, 200);
    });
  });

  app.get(TAKOSUMI_INSTALLATION_DEPLOYMENTS_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    const idCheck = ensureValidId(c, "installationId");
    if (idCheck.kind === "invalid") return idCheck.response;
    return await runHandler(c, async () => {
      const installation = await controller.getInstallation(idCheck.value);
      ensureSpacePermission(auth.principal, installation.installation.spaceId);
      return c.json(await controller.listDeployments(idCheck.value), 200);
    });
  });

  app.get(TAKOSUMI_INSTALLATION_DEPLOYMENT_OUTPUTS_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    const idCheck = ensureValidId(c, "installationId");
    if (idCheck.kind === "invalid") return idCheck.response;
    return await runHandler(c, async () => {
      const installation = await controller.getInstallation(idCheck.value);
      ensureSpacePermission(auth.principal, installation.installation.spaceId);
      return c.json(await controller.listDeploymentOutputs(idCheck.value), 200);
    });
  });

  app.post(TAKOSUMI_CONNECTIONS_ROUTE, deployControlBodyLimit, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    const limit = enforceBodyLimit(c, DEPLOY_CONTROL_JSON_BODY_LIMIT_BYTES);
    if (limit) return limit;
    return await runHandler(c, async () => {
      const body = await readJsonBody<CreateConnectionRequest>(
        c,
        "connectionCreate",
      );
      ensureSpacePermission(auth.principal, body.spaceId);
      const response = await controller.createConnection(body);
      return c.json(response, 201);
    });
  });

  app.get(TAKOSUMI_CONNECTIONS_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    const spaceId = c.req.query("spaceId") ?? "";
    if (spaceId.trim().length === 0) {
      return c.json(
        errorEnvelope(c, "invalid_argument", "spaceId query is required"),
        400,
      );
    }
    return await runHandler(c, async () => {
      ensureSpacePermission(auth.principal, spaceId);
      return c.json(await controller.listConnections(spaceId), 200);
    });
  });

  app.post(TAKOSUMI_CONNECTION_TEST_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    const idCheck = ensureValidConnectionId(c);
    if (idCheck.kind === "invalid") return idCheck.response;
    return await runHandler(c, async () => {
      const connection = await controller.getConnection(idCheck.value);
      ensureSpacePermission(auth.principal, connection.spaceId);
      return c.json(await controller.testConnection(idCheck.value), 200);
    });
  });

  app.delete(TAKOSUMI_CONNECTION_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    const idCheck = ensureValidConnectionId(c);
    if (idCheck.kind === "invalid") return idCheck.response;
    return await runHandler(c, async () => {
      const connection = await controller.getConnection(idCheck.value);
      ensureSpacePermission(auth.principal, connection.spaceId);
      await controller.deleteConnection(idCheck.value);
      return c.body(null, 204);
    });
  });

  // --- Sources (Core Specification §6) --------------------------------------

  app.post(TAKOSUMI_SOURCES_ROUTE, deployControlBodyLimit, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    const limit = enforceBodyLimit(c, DEPLOY_CONTROL_JSON_BODY_LIMIT_BYTES);
    if (limit) return limit;
    return await runHandler(c, async () => {
      const body = await readJsonBody<CreateSourceRequest>(c, "sourceCreate");
      ensureSpacePermission(auth.principal, body.spaceId);
      const response = await controller.createSource(body);
      return c.json(response, 201);
    });
  });

  app.get(TAKOSUMI_SOURCES_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    const spaceId = c.req.query("spaceId") ?? "";
    if (spaceId.trim().length === 0) {
      return c.json(
        errorEnvelope(c, "invalid_argument", "spaceId query is required"),
        400,
      );
    }
    return await runHandler(c, async () => {
      ensureSpacePermission(auth.principal, spaceId);
      return c.json(await controller.listSources(spaceId), 200);
    });
  });

  app.get(TAKOSUMI_SOURCE_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    const idCheck = ensureValidSourceId(c);
    if (idCheck.kind === "invalid") return idCheck.response;
    return await runHandler(c, async () => {
      const response = await controller.getSource(idCheck.value);
      ensureSpacePermission(auth.principal, response.source.spaceId);
      return c.json(response, 200);
    });
  });

  app.patch(TAKOSUMI_SOURCE_ROUTE, deployControlBodyLimit, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    const idCheck = ensureValidSourceId(c);
    if (idCheck.kind === "invalid") return idCheck.response;
    const limit = enforceBodyLimit(c, DEPLOY_CONTROL_JSON_BODY_LIMIT_BYTES);
    if (limit) return limit;
    return await runHandler(c, async () => {
      const existing = await controller.getSource(idCheck.value);
      ensureSpacePermission(auth.principal, existing.source.spaceId);
      const body = await readJsonBody<PatchSourceRequest>(c, "sourcePatch");
      return c.json(await controller.patchSource(idCheck.value, body), 200);
    });
  });

  app.post(TAKOSUMI_SOURCE_SYNC_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    const idCheck = ensureValidSourceId(c);
    if (idCheck.kind === "invalid") return idCheck.response;
    return await runHandler(c, async () => {
      const existing = await controller.getSource(idCheck.value);
      ensureSpacePermission(auth.principal, existing.source.spaceId);
      return c.json(await controller.createSourceSync(idCheck.value), 201);
    });
  });

  app.get(TAKOSUMI_SOURCE_SNAPSHOTS_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    const idCheck = ensureValidSourceId(c);
    if (idCheck.kind === "invalid") return idCheck.response;
    return await runHandler(c, async () => {
      const existing = await controller.getSource(idCheck.value);
      ensureSpacePermission(auth.principal, existing.source.spaceId);
      return c.json(await controller.listSourceSnapshots(idCheck.value), 200);
    });
  });

  // --- Lanes: App / Environment / InstallProfile / DeploymentProfile (§6) ---

  const lanes = dependencies.lanesService;

  app.post(TAKOSUMI_APPS_ROUTE, deployControlBodyLimit, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    if (!lanes) return c.json(notImplemented(c, "lanes not wired"), 501);
    const limit = enforceBodyLimit(c, DEPLOY_CONTROL_JSON_BODY_LIMIT_BYTES);
    if (limit) return limit;
    return await runHandler(c, async () => {
      const body = await readJsonBody<CreateAppRequest>(c, "appCreate");
      ensureSpacePermission(auth.principal, body.spaceId);
      return c.json({ app: await lanes.createApp(body) }, 201);
    });
  });

  app.get(TAKOSUMI_APPS_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    if (!lanes) return c.json(notImplemented(c, "lanes not wired"), 501);
    const spaceId = c.req.query("spaceId") ?? "";
    if (spaceId.trim().length === 0) {
      return c.json(
        errorEnvelope(c, "invalid_argument", "spaceId query is required"),
        400,
      );
    }
    return await runHandler(c, async () => {
      ensureSpacePermission(auth.principal, spaceId);
      return c.json({ apps: await lanes.listApps(spaceId) }, 200);
    });
  });

  app.get(TAKOSUMI_APP_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    if (!lanes) return c.json(notImplemented(c, "lanes not wired"), 501);
    const idCheck = ensureValidParam(c, "appId", APP_ID_PATTERN);
    if (idCheck.kind === "invalid") return idCheck.response;
    return await runHandler(c, async () => {
      const app = await lanes.getApp(idCheck.value);
      ensureSpacePermission(auth.principal, app.spaceId);
      return c.json({ app }, 200);
    });
  });

  app.patch(TAKOSUMI_APP_ROUTE, deployControlBodyLimit, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    if (!lanes) return c.json(notImplemented(c, "lanes not wired"), 501);
    const idCheck = ensureValidParam(c, "appId", APP_ID_PATTERN);
    if (idCheck.kind === "invalid") return idCheck.response;
    const limit = enforceBodyLimit(c, DEPLOY_CONTROL_JSON_BODY_LIMIT_BYTES);
    if (limit) return limit;
    return await runHandler(c, async () => {
      const app = await lanes.getApp(idCheck.value);
      ensureSpacePermission(auth.principal, app.spaceId);
      const body = await readJsonBody<PatchAppRequest>(c, "appPatch");
      return c.json({ app: await lanes.patchApp(idCheck.value, body) }, 200);
    });
  });

  app.delete(TAKOSUMI_APP_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    if (!lanes) return c.json(notImplemented(c, "lanes not wired"), 501);
    const idCheck = ensureValidParam(c, "appId", APP_ID_PATTERN);
    if (idCheck.kind === "invalid") return idCheck.response;
    return await runHandler(c, async () => {
      const app = await lanes.getApp(idCheck.value);
      ensureSpacePermission(auth.principal, app.spaceId);
      await lanes.deleteApp(idCheck.value);
      return c.body(null, 204);
    });
  });

  app.post(
    TAKOSUMI_APP_ENVIRONMENTS_ROUTE,
    deployControlBodyLimit,
    async (c) => {
      const auth = await authorizeDeployControl(c, dependencies);
      if (!auth.ok) return auth.response;
      if (!lanes) return c.json(notImplemented(c, "lanes not wired"), 501);
      const idCheck = ensureValidParam(c, "appId", APP_ID_PATTERN);
      if (idCheck.kind === "invalid") return idCheck.response;
      const limit = enforceBodyLimit(c, DEPLOY_CONTROL_JSON_BODY_LIMIT_BYTES);
      if (limit) return limit;
      return await runHandler(c, async () => {
        const app = await lanes.getApp(idCheck.value);
        ensureSpacePermission(auth.principal, app.spaceId);
        const body = await readJsonBody<CreateEnvironmentRequest>(
          c,
          "environmentCreate",
        );
        return c.json(
          { environment: await lanes.createEnvironment(idCheck.value, body) },
          201,
        );
      });
    },
  );

  app.get(TAKOSUMI_APP_ENVIRONMENTS_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    if (!lanes) return c.json(notImplemented(c, "lanes not wired"), 501);
    const idCheck = ensureValidParam(c, "appId", APP_ID_PATTERN);
    if (idCheck.kind === "invalid") return idCheck.response;
    return await runHandler(c, async () => {
      const app = await lanes.getApp(idCheck.value);
      ensureSpacePermission(auth.principal, app.spaceId);
      return c.json(
        { environments: await lanes.listEnvironments(idCheck.value) },
        200,
      );
    });
  });

  app.get(TAKOSUMI_ENVIRONMENT_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    if (!lanes) return c.json(notImplemented(c, "lanes not wired"), 501);
    const idCheck = ensureValidParam(c, "environmentId", ENVIRONMENT_ID_PATTERN);
    if (idCheck.kind === "invalid") return idCheck.response;
    return await runHandler(c, async () => {
      const environment = await lanes.getEnvironment(idCheck.value);
      await ensureEnvironmentSpacePermission(lanes, auth.principal, environment.appId);
      return c.json({ environment }, 200);
    });
  });

  app.patch(TAKOSUMI_ENVIRONMENT_ROUTE, deployControlBodyLimit, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    if (!lanes) return c.json(notImplemented(c, "lanes not wired"), 501);
    const idCheck = ensureValidParam(c, "environmentId", ENVIRONMENT_ID_PATTERN);
    if (idCheck.kind === "invalid") return idCheck.response;
    const limit = enforceBodyLimit(c, DEPLOY_CONTROL_JSON_BODY_LIMIT_BYTES);
    if (limit) return limit;
    return await runHandler(c, async () => {
      const environment = await lanes.getEnvironment(idCheck.value);
      await ensureEnvironmentSpacePermission(lanes, auth.principal, environment.appId);
      const body = await readJsonBody<PatchEnvironmentRequest>(
        c,
        "environmentPatch",
      );
      return c.json(
        { environment: await lanes.patchEnvironment(idCheck.value, body) },
        200,
      );
    });
  });

  app.get(TAKOSUMI_DEPLOYMENT_PROFILE_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    if (!lanes) return c.json(notImplemented(c, "lanes not wired"), 501);
    const idCheck = ensureValidParam(c, "environmentId", ENVIRONMENT_ID_PATTERN);
    if (idCheck.kind === "invalid") return idCheck.response;
    return await runHandler(c, async () => {
      const environment = await lanes.getEnvironment(idCheck.value);
      await ensureEnvironmentSpacePermission(lanes, auth.principal, environment.appId);
      const deploymentProfile = await lanes.getDeploymentProfile(idCheck.value);
      if (!deploymentProfile) {
        return c.json(
          errorEnvelope(c, "not_found", "deployment profile not set"),
          404,
        );
      }
      return c.json({ deploymentProfile }, 200);
    });
  });

  app.put(TAKOSUMI_DEPLOYMENT_PROFILE_ROUTE, deployControlBodyLimit, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    if (!lanes) return c.json(notImplemented(c, "lanes not wired"), 501);
    const idCheck = ensureValidParam(c, "environmentId", ENVIRONMENT_ID_PATTERN);
    if (idCheck.kind === "invalid") return idCheck.response;
    const limit = enforceBodyLimit(c, DEPLOY_CONTROL_JSON_BODY_LIMIT_BYTES);
    if (limit) return limit;
    return await runHandler(c, async () => {
      const environment = await lanes.getEnvironment(idCheck.value);
      await ensureEnvironmentSpacePermission(lanes, auth.principal, environment.appId);
      const body = await readJsonBody<PutDeploymentProfileRequest>(
        c,
        "deploymentProfilePut",
      );
      return c.json(
        {
          deploymentProfile: await lanes.putDeploymentProfile(
            idCheck.value,
            body,
          ),
        },
        200,
      );
    });
  });

  app.get(TAKOSUMI_INSTALL_PROFILES_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    if (!lanes) return c.json(notImplemented(c, "lanes not wired"), 501);
    return await runHandler(c, async () => {
      return c.json(
        { installProfiles: await lanes.listInstallProfiles() },
        200,
      );
    });
  });

  app.get(TAKOSUMI_INSTALL_PROFILE_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    if (!lanes) return c.json(notImplemented(c, "lanes not wired"), 501);
    const idCheck = ensureValidParam(
      c,
      "installProfileId",
      INSTALL_PROFILE_ID_PATTERN,
    );
    if (idCheck.kind === "invalid") return idCheck.response;
    return await runHandler(c, async () => {
      return c.json(
        { installProfile: await lanes.getInstallProfile(idCheck.value) },
        200,
      );
    });
  });

  // --- Unified Run facade (§6.8) --------------------------------------------

  app.get(TAKOSUMI_RUN_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    const idCheck = ensureValidParam(c, "runId", RUN_ID_PATTERN);
    if (idCheck.kind === "invalid") return idCheck.response;
    return await runHandler(c, async () => {
      const run = await controller.getRun(idCheck.value);
      ensureSpacePermission(auth.principal, run.spaceId);
      return c.json({ run }, 200);
    });
  });

  app.post(TAKOSUMI_RUN_APPROVE_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    const idCheck = ensureValidParam(c, "runId", RUN_ID_PATTERN);
    if (idCheck.kind === "invalid") return idCheck.response;
    return await runHandler(c, async () => {
      const existing = await controller.getRun(idCheck.value);
      ensureSpacePermission(auth.principal, existing.spaceId);
      const body = await readOptionalJsonBody<{
        readonly approvedBy?: string;
        readonly reason?: string;
      }>(c, "runApprove");
      const approvedBy = body.approvedBy ?? auth.principal.actor;
      return c.json(
        {
          run: await controller.approveRun(idCheck.value, {
            approvedBy,
            ...(body.reason ? { reason: body.reason } : {}),
          }),
        },
        200,
      );
    });
  });

  app.post(TAKOSUMI_RUN_CANCEL_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    const idCheck = ensureValidParam(c, "runId", RUN_ID_PATTERN);
    if (idCheck.kind === "invalid") return idCheck.response;
    return await runHandler(c, async () => {
      // Resolve the run's space first so cancel is space-permission gated.
      const existing = await controller.getRun(idCheck.value);
      ensureSpacePermission(auth.principal, existing.spaceId);
      return c.json({ run: await controller.cancelRun(idCheck.value) }, 200);
    });
  });

}

/**
 * Resolves an environment's owning Space (via its App) and enforces the
 * principal's space permission. Used by the environment / deployment-profile
 * routes whose id does not itself carry the space.
 */
async function ensureEnvironmentSpacePermission(
  lanes: LanesService,
  principal: DeployControlPrincipal,
  appId: string,
): Promise<void> {
  const app = await lanes.getApp(appId);
  ensureSpacePermission(principal, app.spaceId);
}

function mountNotImplementedRoutes(
  app: Hono,
  dependencies: DeployControlPublicRouteDependencies,
): void {
  const post = (message: string) => async (c: Context) => {
    const auth = await authorizeDeployControl(c, dependencies);
    return auth.ok ? c.json(notImplemented(c, message), 501) : auth.response;
  };
  const get = post;
  app.get(TAKOSUMI_RUNNER_PROFILES_ROUTE, get("runner profiles not wired"));
  app.post(TAKOSUMI_PLAN_RUNS_ROUTE, post("plan runs not wired"));
  app.get(TAKOSUMI_PLAN_RUN_ROUTE, get("plan runs not wired"));
  app.post(TAKOSUMI_APPLY_RUNS_ROUTE, post("apply runs not wired"));
  app.get(TAKOSUMI_APPLY_RUN_ROUTE, get("apply runs not wired"));
  app.get(TAKOSUMI_INSTALLATION_ROUTE, get("installations not wired"));
  app.get(
    TAKOSUMI_INSTALLATION_DEPLOYMENTS_ROUTE,
    get("deployment ledger not wired"),
  );
  app.get(
    TAKOSUMI_INSTALLATION_DEPLOYMENT_OUTPUTS_ROUTE,
    get("deployment outputs not wired"),
  );
  app.post(TAKOSUMI_CONNECTIONS_ROUTE, post("connections not wired"));
  app.get(TAKOSUMI_CONNECTIONS_ROUTE, get("connections not wired"));
  app.post(TAKOSUMI_CONNECTION_TEST_ROUTE, post("connections not wired"));
  app.delete(TAKOSUMI_CONNECTION_ROUTE, post("connections not wired"));
  app.post(TAKOSUMI_SOURCES_ROUTE, post("sources not wired"));
  app.get(TAKOSUMI_SOURCES_ROUTE, get("sources not wired"));
  app.get(TAKOSUMI_SOURCE_ROUTE, get("sources not wired"));
  app.patch(TAKOSUMI_SOURCE_ROUTE, post("sources not wired"));
  app.post(TAKOSUMI_SOURCE_SYNC_ROUTE, post("sources not wired"));
  app.get(TAKOSUMI_SOURCE_SNAPSHOTS_ROUTE, get("sources not wired"));
  app.post(TAKOSUMI_APPS_ROUTE, post("lanes not wired"));
  app.get(TAKOSUMI_APPS_ROUTE, get("lanes not wired"));
  app.get(TAKOSUMI_APP_ROUTE, get("lanes not wired"));
  app.patch(TAKOSUMI_APP_ROUTE, post("lanes not wired"));
  app.delete(TAKOSUMI_APP_ROUTE, post("lanes not wired"));
  app.post(TAKOSUMI_APP_ENVIRONMENTS_ROUTE, post("lanes not wired"));
  app.get(TAKOSUMI_APP_ENVIRONMENTS_ROUTE, get("lanes not wired"));
  app.get(TAKOSUMI_ENVIRONMENT_ROUTE, get("lanes not wired"));
  app.patch(TAKOSUMI_ENVIRONMENT_ROUTE, post("lanes not wired"));
  app.get(TAKOSUMI_DEPLOYMENT_PROFILE_ROUTE, get("lanes not wired"));
  app.put(TAKOSUMI_DEPLOYMENT_PROFILE_ROUTE, post("lanes not wired"));
  app.get(TAKOSUMI_INSTALL_PROFILES_ROUTE, get("lanes not wired"));
  app.get(TAKOSUMI_INSTALL_PROFILE_ROUTE, get("lanes not wired"));
  app.get(TAKOSUMI_RUN_ROUTE, get("runs not wired"));
  app.post(TAKOSUMI_RUN_APPROVE_ROUTE, post("runs not wired"));
  app.post(TAKOSUMI_RUN_CANCEL_ROUTE, post("runs not wired"));
}

async function authorizeDeployControl(
  c: Context,
  dependencies: DeployControlPublicRouteDependencies,
): Promise<DeployControlAuthResult> {
  const configuredToken = dependencies.getDeployControlToken?.();
  if (!configuredToken && !dependencies.authorizeDeployControlBearer) {
    return {
      ok: false,
      response: c.json(
        errorEnvelope(c, "not_found", "deploy control routes disabled"),
        404,
      ),
    };
  }
  const header = c.req.header("authorization") ?? "";
  const bearer = bearerTokenFromAuthorization(header);
  if (!bearer) {
    return {
      ok: false,
      response: c.json(
        errorEnvelope(c, "unauthenticated", "invalid deploy control bearer"),
        401,
      ),
    };
  }
  if (dependencies.authorizeDeployControlBearer) {
    const principal = await dependencies.authorizeDeployControlBearer({
      token: bearer,
      request: c.req.raw,
    });
    if (principal) return { ok: true, principal };
    return {
      ok: false,
      response: c.json(
        errorEnvelope(c, "unauthenticated", "invalid deploy control bearer"),
        401,
      ),
    };
  }
  if (!configuredToken || !constantTimeEqualsString(bearer, configuredToken)) {
    return {
      ok: false,
      response: c.json(
        errorEnvelope(c, "unauthenticated", "invalid deploy control bearer"),
        401,
      ),
    };
  }
  return {
    ok: true,
    principal: {
      actor: "deploy-control-bearer",
      spaceIds: "*",
      operations: "*",
      runnerProfileIds: "*",
    },
  };
}

function bearerTokenFromAuthorization(header: string): string | undefined {
  const prefix = "Bearer ";
  return header.startsWith(prefix) ? header.slice(prefix.length) : undefined;
}

function ensurePlanCreatePermission(
  principal: DeployControlPrincipal,
  request: CreatePlanRunRequest,
): void {
  const operation = request.operation ?? (request.installationId ? "update" : "create");
  ensureSpacePermission(principal, request.spaceId);
  ensureOperationPermission(principal, operation);
  if (request.runnerProfileId) {
    ensureRunnerProfilePermission(principal, request.runnerProfileId);
  } else if (principal.runnerProfileIds !== "*") {
    throw new OpenTofuControllerError(
      "permission_denied",
      `deploy control principal ${principal.actor} must choose an allowed runner profile`,
    );
  }
}

function ensureApplyPermission(
  principal: DeployControlPrincipal,
  planRun: { readonly spaceId: string; readonly operation: OpenTofuOperation; readonly runnerProfileId: string },
): void {
  ensureSpacePermission(principal, planRun.spaceId);
  ensureOperationPermission(principal, planRun.operation);
  ensureRunnerProfilePermission(principal, planRun.runnerProfileId);
}

function ensureSpacePermission(
  principal: DeployControlPrincipal,
  spaceId: string,
): void {
  if (scopeAllows(principal.spaceIds, spaceId)) return;
  throw new OpenTofuControllerError(
    "permission_denied",
    `deploy control principal ${principal.actor} cannot access space ${spaceId}`,
  );
}

function ensureOperationPermission(
  principal: DeployControlPrincipal,
  operation: OpenTofuOperation,
): void {
  if (scopeAllows(principal.operations, operation)) return;
  throw new OpenTofuControllerError(
    "permission_denied",
    `deploy control principal ${principal.actor} cannot run ${operation}`,
  );
}

function ensureRunnerProfilePermission(
  principal: DeployControlPrincipal,
  runnerProfileId: string,
): void {
  if (scopeAllows(principal.runnerProfileIds, runnerProfileId)) return;
  throw new OpenTofuControllerError(
    "permission_denied",
    `deploy control principal ${principal.actor} cannot use runner profile ${runnerProfileId}`,
  );
}

function scopeAllows(
  scope: readonly string[] | "*" | undefined,
  value: string,
): boolean {
  return scope === "*" || scope?.includes(value) === true;
}

function filterRunnerProfilesForPrincipal(
  response: ListRunnerProfilesResponse,
  principal: DeployControlPrincipal,
): ListRunnerProfilesResponse {
  if (principal.runnerProfileIds === "*") return response;
  const allowed = new Set(principal.runnerProfileIds ?? []);
  return {
    runnerProfiles: response.runnerProfiles.filter((profile) =>
      allowed.has(profile.id)
    ),
  };
}

function notImplemented(
  c: Context,
  message: string,
): DeployControlErrorEnvelope {
  return {
    error: {
      code: "not_implemented" satisfies DeployControlErrorCode,
      message,
      requestId: resolveRequestId(c),
    },
  };
}

async function runHandler(
  c: Context,
  fn: () => Promise<Response>,
): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof OpenTofuControllerError) {
      return c.json(
        errorEnvelope(c, err.code, err.message),
        controllerHttpStatus(err.code),
      );
    }
    const requestId = resolveRequestId(c);
    log.error("deployControl.public_routes.internal_error", {
      requestId,
      path: c.req.path,
      method: c.req.method,
      error: err,
    });
    return c.json(
      {
        error: {
          code: "internal_error" satisfies DeployControlErrorCode,
          message: "internal error",
          requestId,
        },
      } satisfies DeployControlErrorEnvelope,
      500,
    );
  }
}

async function readJsonBody<T>(
  c: Context,
  route: DeployControlRouteName,
): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "request body must be valid JSON",
    );
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "request body must be a JSON object",
    );
  }
  const allowed = ALLOWED_KEYS[route];
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `unknown_field: ${key}`,
      );
    }
  }
  return raw as T;
}

/**
 * Reads an OPTIONAL JSON body (the approve route allows an empty body). Returns
 * `{}` when there is no body or it is empty; otherwise validates it like
 * {@link readJsonBody} (object shape + allowed-key allowlist).
 */
async function readOptionalJsonBody<T>(
  c: Context,
  route: DeployControlRouteName,
): Promise<T> {
  const text = await c.req.text();
  if (text.trim().length === 0) return {} as T;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "request body must be valid JSON",
    );
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "request body must be a JSON object",
    );
  }
  const allowed = ALLOWED_KEYS[route];
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `unknown_field: ${key}`,
      );
    }
  }
  return raw as T;
}

function enforceBodyLimit(
  c: Context,
  limitBytes: number,
): Response | undefined {
  const header = c.req.header("content-length");
  if (header === undefined) return undefined;
  const parsed = Number(header);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return c.json(
      errorEnvelope(c, "invalid_argument", "invalid content-length header"),
      400,
    );
  }
  if (parsed > limitBytes) {
    return c.json(
      errorEnvelope(
        c,
        "resource_exhausted",
        `request body exceeds ${limitBytes} byte limit`,
      ),
      413,
    );
  }
  return undefined;
}

function ensureValidId(
  c: Context,
  param: keyof typeof ID_PATTERNS,
):
  | { readonly kind: "ok"; readonly value: string }
  | { readonly kind: "invalid"; readonly response: Response } {
  const raw = c.req.param(param) ?? "";
  if (!ID_PATTERNS[param].test(raw)) {
    return {
      kind: "invalid",
      response: c.json(
        errorEnvelope(c, "invalid_argument", `${param} has an unsupported shape`),
        400,
      ),
    };
  }
  return { kind: "ok", value: raw };
}

function ensureValidConnectionId(
  c: Context,
):
  | { readonly kind: "ok"; readonly value: string }
  | { readonly kind: "invalid"; readonly response: Response } {
  const raw = c.req.param("connectionId") ?? "";
  if (!CONNECTION_ID_PATTERN.test(raw)) {
    return {
      kind: "invalid",
      response: c.json(
        errorEnvelope(c, "invalid_argument", "connectionId has an unsupported shape"),
        400,
      ),
    };
  }
  return { kind: "ok", value: raw };
}

function ensureValidSourceId(
  c: Context,
):
  | { readonly kind: "ok"; readonly value: string }
  | { readonly kind: "invalid"; readonly response: Response } {
  const raw = c.req.param("sourceId") ?? "";
  if (!SOURCE_ID_PATTERN.test(raw)) {
    return {
      kind: "invalid",
      response: c.json(
        errorEnvelope(c, "invalid_argument", "sourceId has an unsupported shape"),
        400,
      ),
    };
  }
  return { kind: "ok", value: raw };
}

function ensureValidParam(
  c: Context,
  param: string,
  pattern: RegExp,
):
  | { readonly kind: "ok"; readonly value: string }
  | { readonly kind: "invalid"; readonly response: Response } {
  const raw = c.req.param(param) ?? "";
  if (!pattern.test(raw)) {
    return {
      kind: "invalid",
      response: c.json(
        errorEnvelope(c, "invalid_argument", `${param} has an unsupported shape`),
        400,
      ),
    };
  }
  return { kind: "ok", value: raw };
}

function controllerHttpStatus(
  code: OpenTofuControllerErrorCode,
): DeployControlErrorHttpStatus {
  return DEPLOY_CONTROL_ERROR_HTTP_STATUS_BY_CODE[code];
}

function errorEnvelope(
  c: Context,
  code: DeployControlErrorCode,
  message: string,
): DeployControlErrorEnvelope {
  return {
    error: {
      code,
      message,
      requestId: resolveRequestId(c),
    },
  };
}

function resolveRequestId(c: Context): string {
  const fromHeader = c.req.header("x-request-id") ??
    c.req.header("x-correlation-id");
  if (fromHeader && isValidRequestIdShape(fromHeader)) return fromHeader;
  return crypto.randomUUID();
}

function isValidRequestIdShape(value: string): boolean {
  if (value.length === 0 || value.length > 64) return false;
  return UUID_PATTERN.test(value) || ULID_PATTERN.test(value);
}
