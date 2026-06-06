/**
 * Public OpenTofu deployment-control-plane HTTP surface (Space-direct
 * Installation model). Spec §30: the public vocabulary is mounted under `/api`
 * with NO version prefix.
 *
 *   POST  /api/spaces ; GET /api/spaces ; GET /api/spaces/{spaceId}
 *   PATCH /api/spaces/{spaceId}                        (displayName only — MVP)
 *   POST  /api/sources ; GET /api/sources ; GET /api/sources/{id}
 *   POST  /api/sources/{id}/sync ; POST /hooks/sources/{id}
 *   POST  /api/connections/source/https-token
 *   POST  /api/connections/source/ssh-key
 *   POST  /api/connections/cloudflare/token
 *   POST  /api/connections/aws/assume-role               (501 not_implemented)
 *   GET   /api/connections
 *   POST  /api/connections/{id}/test ; POST /api/connections/{id}/revoke
 *   POST  /api/spaces/{spaceId}/installations
 *   GET   /api/spaces/{spaceId}/installations
 *   GET   /api/installations/{id}
 *   PATCH /api/installations/{id}                                 (501 — MVP)
 *   DELETE /api/installations/{id}            (501 — use destroy-plan for MVP)
 *   GET   /api/install-configs
 *   POST  /api/installations/{id}/dependencies
 *   GET   /api/installations/{id}/dependencies
 *   DELETE /api/dependencies/{dependencyId}
 *   POST/GET /api/output-shares ; POST /api/output-shares/{id}/revoke (501)
 *   POST  /api/installations/{id}/plan ; /destroy-plan
 *   GET   /api/runs/{id} ; /logs ; /events
 *   POST  /api/runs/{id}/approve ; /cancel
 *   POST  /api/spaces/{spaceId}/plan-update
 *   GET   /api/run-groups/{id} ; POST /api/run-groups/{id}/approve
 *   GET   /api/installations/{id}/deployments
 *   GET   /api/deployments/{id}
 *   POST  /api/deployments/{id}/rollback-plan
 *   GET   /api/spaces/{spaceId}/activity
 *   GET/PUT /api/operator-connection-defaults
 *
 * The PlanRun / ApplyRun / RunnerProfile ledger routes and the Installation
 * read (+ deployments / deployment-outputs) used by the accounts plane + CLI
 * stay on the INTERNAL `/v1/*` seam (see `deploy-control-api.ts`); they are NOT
 * part of the §30 public vocabulary.
 */

import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  APPLY_RUNS_PATH,
  CONNECTIONS_AWS_ASSUME_ROLE_PATH,
  CONNECTIONS_CLOUDFLARE_TOKEN_PATH,
  CONNECTIONS_PATH,
  CONNECTIONS_SOURCE_HTTPS_TOKEN_PATH,
  CONNECTIONS_SOURCE_SSH_KEY_PATH,
  DEPLOY_CONTROL_ERROR_HTTP_STATUS_BY_CODE,
  RUNNER_PROFILES_PATH,
} from "takosumi-contract/deploy-control-api";
import type {
  ConnectionKind,
  ConnectionScopeHints,
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
import type {
  CreateSpaceRequest,
  SpacesService,
} from "../domains/spaces/mod.ts";
import type {
  CreateInstallationRequest,
  InstallationsService,
} from "../domains/installations/mod.ts";
import type {
  ConnectionsService,
  PutOperatorConnectionDefaultRequest,
} from "../domains/connections/mod.ts";
import type {
  CreateDependencyRequest,
  DependenciesService,
} from "../domains/dependencies/mod.ts";
import type { RunGroupsService } from "../domains/run-groups/mod.ts";
import type { ActivityService } from "../domains/activity/mod.ts";
import { ACTIVITY_MAX_LIMIT } from "takosumi-contract/activity";
import {
  OpenTofuControllerError,
  type OpenTofuControllerErrorCode,
  type OpenTofuDeploymentController,
} from "../domains/deploy-control/mod.ts";
import { log } from "../shared/log.ts";
import { constantTimeEqualsString } from "../shared/constant_time.ts";
import type { ApiEndpoint } from "./route_families.ts";

// --- INTERNAL `/v1` seam routes (spec §30 binding: NOT public `/api`). These
// are the in-process fetch seam the accounts plane + CLI consume; they keep the
// `/v1` prefix after the §30 `/api` cutover. ----------------------------------
export const TAKOSUMI_RUNNER_PROFILES_ROUTE = RUNNER_PROFILES_PATH;
export const TAKOSUMI_PLAN_RUNS_ROUTE = "/v1/plan-runs" as const;
export const TAKOSUMI_PLAN_RUN_ROUTE = "/v1/plan-runs/:planRunId" as const;
export const TAKOSUMI_APPLY_RUNS_ROUTE = APPLY_RUNS_PATH;
export const TAKOSUMI_APPLY_RUN_ROUTE = "/v1/apply-runs/:applyRunId" as const;
/** INTERNAL Installation read used by the accounts plane (stays `/v1`). */
export const TAKOSUMI_INSTALLATION_ROUTE =
  "/v1/installations/:installationId" as const;
/** INTERNAL Deployment list read used by the accounts plane (stays `/v1`). */
export const TAKOSUMI_INSTALLATION_DEPLOYMENTS_ROUTE =
  "/v1/installations/:installationId/deployments" as const;
/** INTERNAL DeploymentOutput read used by the accounts plane (stays `/v1`). */
export const TAKOSUMI_INSTALLATION_DEPLOYMENT_OUTPUTS_ROUTE =
  "/v1/installations/:installationId/deployment-outputs" as const;

// --- PUBLIC §30 `/api` routes. ------------------------------------------------
export const TAKOSUMI_CONNECTIONS_ROUTE = CONNECTIONS_PATH;
export const TAKOSUMI_CONNECTIONS_SOURCE_HTTPS_TOKEN_ROUTE =
  CONNECTIONS_SOURCE_HTTPS_TOKEN_PATH;
export const TAKOSUMI_CONNECTIONS_SOURCE_SSH_KEY_ROUTE =
  CONNECTIONS_SOURCE_SSH_KEY_PATH;
export const TAKOSUMI_CONNECTIONS_CLOUDFLARE_TOKEN_ROUTE =
  CONNECTIONS_CLOUDFLARE_TOKEN_PATH;
export const TAKOSUMI_CONNECTIONS_AWS_ASSUME_ROLE_ROUTE =
  CONNECTIONS_AWS_ASSUME_ROLE_PATH;
export const TAKOSUMI_CONNECTION_TEST_ROUTE =
  "/api/connections/:connectionId/test" as const;
export const TAKOSUMI_CONNECTION_REVOKE_ROUTE =
  "/api/connections/:connectionId/revoke" as const;
export const TAKOSUMI_SOURCES_ROUTE = SOURCES_PATH;
export const TAKOSUMI_SOURCE_ROUTE = "/api/sources/:sourceId" as const;
export const TAKOSUMI_SOURCE_SYNC_ROUTE =
  "/api/sources/:sourceId/sync" as const;
export const TAKOSUMI_SOURCE_SNAPSHOTS_ROUTE =
  "/api/sources/:sourceId/snapshots" as const;
export const TAKOSUMI_SPACES_ROUTE = "/api/spaces" as const;
export const TAKOSUMI_OPERATOR_CONNECTION_DEFAULTS_ROUTE =
  "/api/operator-connection-defaults" as const;
export const TAKOSUMI_SPACE_ROUTE = "/api/spaces/:spaceId" as const;
export const TAKOSUMI_SPACE_INSTALLATIONS_ROUTE =
  "/api/spaces/:spaceId/installations" as const;
/** PUBLIC Installation read / patch / delete (spec §30 `/api`). */
export const TAKOSUMI_API_INSTALLATION_ROUTE =
  "/api/installations/:installationId" as const;
/** PUBLIC Deployment list for an Installation (spec §30 `/api`). */
export const TAKOSUMI_API_INSTALLATION_DEPLOYMENTS_ROUTE =
  "/api/installations/:installationId/deployments" as const;
export const TAKOSUMI_DEPLOYMENT_ROUTE =
  "/api/deployments/:deploymentId" as const;
export const TAKOSUMI_DEPLOYMENT_ROLLBACK_PLAN_ROUTE =
  "/api/deployments/:deploymentId/rollback-plan" as const;
export const TAKOSUMI_INSTALL_CONFIGS_ROUTE = "/api/install-configs" as const;
export const TAKOSUMI_INSTALLATION_PLAN_ROUTE =
  "/api/installations/:installationId/plan" as const;
export const TAKOSUMI_INSTALLATION_DESTROY_PLAN_ROUTE =
  "/api/installations/:installationId/destroy-plan" as const;
export const TAKOSUMI_RUN_ROUTE = "/api/runs/:runId" as const;
export const TAKOSUMI_RUN_LOGS_ROUTE = "/api/runs/:runId/logs" as const;
export const TAKOSUMI_RUN_EVENTS_ROUTE = "/api/runs/:runId/events" as const;
export const TAKOSUMI_RUN_APPROVE_ROUTE = "/api/runs/:runId/approve" as const;
export const TAKOSUMI_RUN_CANCEL_ROUTE = "/api/runs/:runId/cancel" as const;
export const TAKOSUMI_INSTALLATION_DEPENDENCIES_ROUTE =
  "/api/installations/:installationId/dependencies" as const;
export const TAKOSUMI_DEPENDENCY_ROUTE =
  "/api/dependencies/:dependencyId" as const;
export const TAKOSUMI_OUTPUT_SHARES_ROUTE = "/api/output-shares" as const;
export const TAKOSUMI_OUTPUT_SHARE_REVOKE_ROUTE =
  "/api/output-shares/:shareId/revoke" as const;
export const TAKOSUMI_SPACE_PLAN_UPDATE_ROUTE =
  "/api/spaces/:spaceId/plan-update" as const;
export const TAKOSUMI_RUN_GROUP_ROUTE =
  "/api/run-groups/:runGroupId" as const;
export const TAKOSUMI_RUN_GROUP_APPROVE_ROUTE =
  "/api/run-groups/:runGroupId/approve" as const;
export const TAKOSUMI_SPACE_ACTIVITY_ROUTE =
  "/api/spaces/:spaceId/activity" as const;

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
    summary:
      "INTERNAL seam: reads an Installation ledger record (accounts-plane consumer; not part of the §30 public surface).",
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
    summary:
      "INTERNAL seam: lists Deployment records for an Installation (accounts-plane consumer; not part of the §30 public surface).",
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
      "INTERNAL seam: lists non-sensitive DeploymentOutput records for the current Deployment of an Installation (accounts-plane consumer; not part of the §30 public surface).",
    auth: "deploy-control-token",
    operationId: "listInstallationDeploymentOutputs",
    openapi: {
      pathParams: ["installationId"],
      okSchema: "ListDeploymentOutputsResponse",
    },
  },
  {
    method: "POST",
    path: TAKOSUMI_CONNECTIONS_SOURCE_HTTPS_TOKEN_ROUTE,
    summary:
      "Registers a git source HTTPS-token Connection (token write-only; optional username).",
    auth: "deploy-control-token",
    operationId: "createSourceHttpsTokenConnection",
    openapi: {
      requestSchema: "CreateConnectionRequest",
      okStatus: "201",
      okSchema: "ConnectionResponse",
    },
  },
  {
    method: "POST",
    path: TAKOSUMI_CONNECTIONS_SOURCE_SSH_KEY_ROUTE,
    summary:
      "Registers a git source SSH-key Connection (private key write-only; knownHosts required for StrictHostKeyChecking=yes).",
    auth: "deploy-control-token",
    operationId: "createSourceSshKeyConnection",
    openapi: {
      requestSchema: "CreateConnectionRequest",
      okStatus: "201",
      okSchema: "ConnectionResponse",
    },
  },
  {
    method: "POST",
    path: TAKOSUMI_CONNECTIONS_CLOUDFLARE_TOKEN_ROUTE,
    summary:
      "Registers a Cloudflare API-token Connection (token write-only; optional account/zone scope).",
    auth: "deploy-control-token",
    operationId: "createCloudflareTokenConnection",
    openapi: {
      requestSchema: "CreateConnectionRequest",
      okStatus: "201",
      okSchema: "ConnectionResponse",
    },
  },
  {
    method: "POST",
    path: TAKOSUMI_CONNECTIONS_AWS_ASSUME_ROLE_ROUTE,
    summary: "AWS assume-role Connection creation (not implemented for MVP).",
    auth: "deploy-control-token",
    operationId: "createAwsAssumeRoleConnection",
    openapi: {
      okStatus: "201",
      okSchema: "ConnectionResponse",
    },
  },
  {
    method: "GET",
    path: TAKOSUMI_CONNECTIONS_ROUTE,
    summary:
      "Lists Connections for a Space, or operator-scoped Connections when spaceId is omitted (never includes secret values).",
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
    method: "POST",
    path: TAKOSUMI_CONNECTION_REVOKE_ROUTE,
    summary: "Revokes a Connection and deletes its sealed secret blob.",
    auth: "deploy-control-token",
    operationId: "revokeConnection",
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
    path: TAKOSUMI_SPACES_ROUTE,
    summary:
      "Creates a Space (owner namespace `@handle`) Installations live directly under.",
    auth: "deploy-control-token",
    operationId: "createSpace",
    openapi: {
      requestSchema: "CreateSpaceRequest",
      okStatus: "201",
      okSchema: "SpaceResponse",
    },
  },
  {
    method: "GET",
    path: TAKOSUMI_SPACES_ROUTE,
    summary: "Lists Spaces visible to the principal.",
    auth: "deploy-control-token",
    operationId: "listSpaces",
    openapi: { okSchema: "ListSpacesResponse" },
  },
  {
    method: "GET",
    path: TAKOSUMI_SPACE_ROUTE,
    summary: "Reads a Space record.",
    auth: "deploy-control-token",
    operationId: "getSpace",
    openapi: { pathParams: ["spaceId"], okSchema: "SpaceResponse" },
  },
  {
    method: "PATCH",
    path: TAKOSUMI_SPACE_ROUTE,
    summary: "Updates a Space (displayName only for MVP).",
    auth: "deploy-control-token",
    operationId: "patchSpace",
    openapi: {
      pathParams: ["spaceId"],
      requestSchema: "PatchSpaceRequest",
      okSchema: "SpaceResponse",
    },
  },
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
  },
  {
    method: "PATCH",
    path: TAKOSUMI_API_INSTALLATION_ROUTE,
    summary:
      "Updates an Installation (not implemented for MVP; status note via run lifecycle).",
    auth: "deploy-control-token",
    operationId: "patchApiInstallation",
    openapi: {
      pathParams: ["installationId"],
      okSchema: "GetInstallationResponse",
    },
  },
  {
    method: "DELETE",
    path: TAKOSUMI_API_INSTALLATION_ROUTE,
    summary:
      "Deletes an Installation (not implemented for MVP; use the destroy-plan flow instead).",
    auth: "deploy-control-token",
    operationId: "deleteApiInstallation",
    openapi: {
      pathParams: ["installationId"],
      okStatus: "204",
      okSchema: "EmptyResponse",
    },
  },
  {
    method: "GET",
    path: TAKOSUMI_API_INSTALLATION_DEPLOYMENTS_ROUTE,
    summary: "Lists Deployment records for an Installation (§30 public surface).",
    auth: "deploy-control-token",
    operationId: "listApiInstallationDeployments",
    openapi: {
      pathParams: ["installationId"],
      okSchema: "ListDeploymentsResponse",
    },
  },
  {
    method: "GET",
    path: TAKOSUMI_DEPLOYMENT_ROUTE,
    summary: "Reads a Deployment ledger record.",
    auth: "deploy-control-token",
    operationId: "getDeployment",
    openapi: { pathParams: ["deploymentId"], okSchema: "DeploymentResponse" },
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
      okSchema: "PlanRunResponse",
    },
  },
  {
    method: "GET",
    path: TAKOSUMI_INSTALL_CONFIGS_ROUTE,
    summary:
      "Lists InstallConfigs (official catalog, plus the Space's own configs when spaceId is given).",
    auth: "deploy-control-token",
    operationId: "listInstallConfigs",
    openapi: { query: ["spaceId"], okSchema: "ListInstallConfigsResponse" },
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
      okSchema: "PlanRunResponse",
    },
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
      okSchema: "PlanRunResponse",
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
    method: "GET",
    path: TAKOSUMI_RUN_LOGS_ROUTE,
    summary:
      "Reads a Run's structured diagnostics + run-level audit trail (redacted).",
    auth: "deploy-control-token",
    operationId: "getRunLogs",
    openapi: { pathParams: ["runId"], okSchema: "RunLogsResponse" },
  },
  {
    method: "GET",
    path: TAKOSUMI_RUN_EVENTS_ROUTE,
    summary: "Reads a Run's run-level audit-event trail.",
    auth: "deploy-control-token",
    operationId: "getRunEvents",
    openapi: { pathParams: ["runId"], okSchema: "RunEventsResponse" },
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
  {
    method: "POST",
    path: TAKOSUMI_INSTALLATION_DEPENDENCIES_ROUTE,
    summary:
      "Creates a Dependency edge whose consumer is this Installation (variable_injection, same-Space; cycles rejected).",
    auth: "deploy-control-token",
    operationId: "createDependency",
    openapi: {
      pathParams: ["installationId"],
      requestSchema: "CreateDependencyRequest",
      okStatus: "201",
      okSchema: "DependencyResponse",
    },
  },
  {
    method: "GET",
    path: TAKOSUMI_INSTALLATION_DEPENDENCIES_ROUTE,
    summary:
      "Lists the Dependencies of an Installation, split into asProducer / asConsumer views.",
    auth: "deploy-control-token",
    operationId: "listInstallationDependencies",
    openapi: {
      pathParams: ["installationId"],
      okSchema: "InstallationDependenciesResponse",
    },
  },
  {
    method: "DELETE",
    path: TAKOSUMI_DEPENDENCY_ROUTE,
    summary: "Deletes a Dependency edge (space-permission gated via its consumer).",
    auth: "deploy-control-token",
    operationId: "deleteDependency",
    openapi: {
      pathParams: ["dependencyId"],
      okStatus: "204",
      okSchema: "EmptyResponse",
    },
  },
  {
    method: "POST",
    path: TAKOSUMI_OUTPUT_SHARES_ROUTE,
    summary: "Creates a cross-Space OutputShare (not implemented for MVP).",
    auth: "deploy-control-token",
    operationId: "createOutputShare",
    openapi: { okStatus: "201", okSchema: "OutputShareResponse" },
  },
  {
    method: "GET",
    path: TAKOSUMI_OUTPUT_SHARES_ROUTE,
    summary: "Lists cross-Space OutputShares (not implemented for MVP).",
    auth: "deploy-control-token",
    operationId: "listOutputShares",
    openapi: { okSchema: "ListOutputSharesResponse" },
  },
  {
    method: "POST",
    path: TAKOSUMI_OUTPUT_SHARE_REVOKE_ROUTE,
    summary: "Revokes a cross-Space OutputShare (not implemented for MVP).",
    auth: "deploy-control-token",
    operationId: "revokeOutputShare",
    openapi: { pathParams: ["shareId"], okSchema: "OutputShareResponse" },
  },
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
  },
  {
    method: "GET",
    path: TAKOSUMI_RUN_GROUP_ROUTE,
    summary: "Reads a RunGroup with its member Runs and computed status.",
    auth: "deploy-control-token",
    operationId: "getRunGroup",
    openapi: { pathParams: ["runGroupId"], okSchema: "RunGroupResponse" },
  },
  {
    method: "POST",
    path: TAKOSUMI_RUN_GROUP_APPROVE_ROUTE,
    summary:
      "Approves every member Run of a RunGroup currently waiting on approval.",
    auth: "deploy-control-token",
    operationId: "approveRunGroup",
    openapi: { pathParams: ["runGroupId"], okSchema: "RunGroupResponse" },
  },
  {
    method: "GET",
    path: TAKOSUMI_SPACE_ACTIVITY_ROUTE,
    summary:
      "Lists a Space's recent Activity audit trail (newest first; ?limit= 1..500).",
    auth: "deploy-control-token",
    operationId: "listSpaceActivity",
    openapi: { pathParams: ["spaceId"], okSchema: "ListActivityResponse" },
  },
] as const;

export const DEPLOY_CONTROL_JSON_BODY_LIMIT_BYTES = 1 * 1024 * 1024;

const ID_PATTERNS = {
  planRunId: /^plan_[0-9a-zA-Z]{8,64}$/,
  applyRunId: /^apply_[0-9a-zA-Z]{8,64}$/,
  // The InstallationsService mints `inst_...`; the legacy ledger fixtures used
  // `ins_...`. Accept either prefix so both shapes validate.
  installationId: /^inst?_[0-9a-zA-Z]{8,64}$/,
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
    "scope",
    "scopeHints",
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
  operatorConnectionDefault: new Set([
    "capability",
    "connectionId",
  ]),
  spaceCreate: new Set([
    "handle",
    "displayName",
    "type",
    "ownerUserId",
    "billingAccountId",
  ]),
  spacePatch: new Set(["displayName"]),
  installationCreate: new Set([
    "name",
    "environment",
    "sourceId",
    "installConfigId",
  ]),
  runApprove: new Set(["approvedBy", "reason"]),
  dependencyCreate: new Set([
    "producerInstallationId",
    "mode",
    "outputs",
    "visibility",
  ]),
};

type DeployControlRouteName =
  | "planRunCreate"
  | "applyRunCreate"
  | "connectionCreate"
  | "sourceCreate"
  | "sourcePatch"
  | "spaceCreate"
  | "spacePatch"
  | "installationCreate"
  | "operatorConnectionDefault"
  | "runApprove"
  | "dependencyCreate";

const CONNECTION_ID_PATTERN = /^conn_[0-9a-zA-Z]{8,64}$/;
const SOURCE_ID_PATTERN = /^src_[0-9a-zA-Z]{8,64}$/;
const SPACE_ID_PATTERN = /^space_[0-9a-zA-Z]{8,64}$/;
const RUN_ID_PATTERN = /^(plan|apply|ssr)_[0-9a-zA-Z]{8,64}$/;
const DEPENDENCY_ID_PATTERN = /^dep_[0-9a-zA-Z]{8,64}$/;
const RUN_GROUP_ID_PATTERN = /^rg_[0-9a-zA-Z]{8,64}$/;
const DEPLOYMENT_ID_PATTERN = /^dep(loy)?_[0-9a-zA-Z]{8,64}$/;

/**
 * §30 connection-creation subroute body. The subroute fixes the
 * `provider` / `kind` / `authMethod`; the body carries only the Space binding,
 * display name, optional scope, optional non-secret scope hints, and the
 * write-only credential `values`.
 */
interface ConnectionSubrouteBody {
  readonly spaceId?: string;
  readonly displayName?: string;
  readonly scope?: "operator" | "space";
  readonly scopeHints?: ConnectionScopeHints;
  readonly values: Readonly<Record<string, string>>;
}

/**
 * Builds a git-source Connection create request (§30 source subroutes). The
 * `source_git_ssh_key` kind REQUIRES `scopeHints.knownHostsEntry` so the runner
 * can pin the host key with `StrictHostKeyChecking=yes` (spec §7 / invariant on
 * SSH host-key pinning); omitting it is a typed invalid_argument.
 */
function buildSourceConnectionRequest(
  body: ConnectionSubrouteBody,
  kind: Extract<
    ConnectionKind,
    "source_git_https_token" | "source_git_ssh_key"
  >,
): CreateConnectionRequest {
  if (
    kind === "source_git_ssh_key" &&
    !nonEmptyString(body.scopeHints?.knownHostsEntry)
  ) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "scopeHints.knownHostsEntry is required for a source_git_ssh_key connection",
    );
  }
  return {
    ...(body.spaceId ? { spaceId: body.spaceId } : {}),
    provider: kind,
    kind,
    authMethod: "static_secret",
    ...(body.displayName ? { displayName: body.displayName } : {}),
    ...(body.scope ? { scope: body.scope } : {}),
    ...(body.scopeHints ? { scopeHints: body.scopeHints } : {}),
    values: body.values,
  };
}

/** Builds a Cloudflare API-token Connection create request (§30 subroute). */
function buildCloudflareConnectionRequest(
  body: ConnectionSubrouteBody,
): CreateConnectionRequest {
  return {
    ...(body.spaceId ? { spaceId: body.spaceId } : {}),
    provider: "cloudflare",
    kind: "provider",
    authMethod: "static_secret",
    ...(body.displayName ? { displayName: body.displayName } : {}),
    ...(body.scope ? { scope: body.scope } : {}),
    ...(body.scopeHints ? { scopeHints: body.scopeHints } : {}),
    values: body.values,
  };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

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
   * Spaces domain service (Core Specification §4). When unset, the Space routes
   * return 501 after successful auth.
   */
  readonly spacesService?: SpacesService;
  /**
   * Installations domain service (Core Specification §5 / §11). When unset, the
   * Installation / InstallConfig routes return 501 after successful auth.
   */
  readonly installationsService?: InstallationsService;
  /** Operator default connections + capability resolution (spec §9). */
  readonly connectionsService?: ConnectionsService;
  /**
   * Dependencies domain service (Core Specification §14 / §15). When unset, the
   * Dependency routes return 501 after successful auth.
   */
  readonly dependenciesService?: DependenciesService;
  /**
   * RunGroups domain service (Core Specification §19 / §24). When unset, the
   * plan-update / run-group routes return 501 after successful auth.
   */
  readonly runGroupsService?: RunGroupsService;
  /**
   * Activity domain service (Core Specification §27 / §34). When unset, the
   * Activity listing route returns 501 after successful auth, and the connection
   * route skips its Space-scoped audit emission.
   */
  readonly activityService?: ActivityService;
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

  // --- Connection creation subroutes (§30): thin validated wrappers over the
  // generic createConnection with the right kind/provider. -------------------

  /**
   * Shared §30 connection-creation handler: validates the subroute body,
   * resolves the connection-permission, creates the Connection through the
   * controller, emits Space activity (space-scoped only), and returns 201. The
   * credential `values` are forwarded write-only and never logged or echoed.
   */
  const createConnectionFromSubroute = (
    build: (body: ConnectionSubrouteBody) => CreateConnectionRequest,
  ) =>
  async (c: Context): Promise<Response> => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    const limit = enforceBodyLimit(c, DEPLOY_CONTROL_JSON_BODY_LIMIT_BYTES);
    if (limit) return limit;
    return await runHandler(c, async () => {
      const body = await readJsonBody<ConnectionSubrouteBody>(
        c,
        "connectionCreate",
      );
      const request = build(body);
      ensureConnectionPermission(auth.principal, request.spaceId);
      const response = await controller.createConnection(request);
      // Activity (§27 / §34): a Connection was registered. Emit ONLY for a
      // space-scoped Connection (operator-scope defaults are instance-wide, not
      // Space activity). Names / ids only — credential values never enter the
      // audit trail.
      const connection = response.connection;
      if (dependencies.activityService && connection.spaceId) {
        await dependencies.activityService.record({
          spaceId: connection.spaceId,
          actorId: auth.principal.actor,
          action: "connection.created",
          targetType: "connection",
          targetId: connection.id,
          metadata: {
            provider: connection.provider,
            kind: connection.kind ?? "provider",
            scope: connection.scope,
          },
        });
      }
      return c.json(response, 201);
    });
  };

  app.post(
    TAKOSUMI_CONNECTIONS_SOURCE_HTTPS_TOKEN_ROUTE,
    deployControlBodyLimit,
    createConnectionFromSubroute((body) =>
      buildSourceConnectionRequest(body, "source_git_https_token")
    ),
  );

  app.post(
    TAKOSUMI_CONNECTIONS_SOURCE_SSH_KEY_ROUTE,
    deployControlBodyLimit,
    createConnectionFromSubroute((body) =>
      buildSourceConnectionRequest(body, "source_git_ssh_key")
    ),
  );

  app.post(
    TAKOSUMI_CONNECTIONS_CLOUDFLARE_TOKEN_ROUTE,
    deployControlBodyLimit,
    createConnectionFromSubroute((body) => buildCloudflareConnectionRequest(body)),
  );

  app.post(TAKOSUMI_CONNECTIONS_AWS_ASSUME_ROLE_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    return c.json(
      notImplemented(c, "aws assume-role connections are not implemented yet"),
      501,
    );
  });

  app.get(TAKOSUMI_CONNECTIONS_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    const spaceId = c.req.query("spaceId") ?? "";
    // §30: with no spaceId, list operator-scoped Connections (instance-wide).
    // Only the unrestricted bearer (spaceIds: "*") may; a scoped principal is
    // rejected by ensureConnectionPermission(undefined).
    if (spaceId.trim().length === 0) {
      return await runHandler(c, async () => {
        ensureConnectionPermission(auth.principal, undefined);
        return c.json(await controller.listOperatorConnections(), 200);
      });
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
      ensureConnectionPermission(auth.principal, connection.spaceId);
      return c.json(await controller.testConnection(idCheck.value), 200);
    });
  });

  app.post(TAKOSUMI_CONNECTION_REVOKE_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    const idCheck = ensureValidConnectionId(c);
    if (idCheck.kind === "invalid") return idCheck.response;
    return await runHandler(c, async () => {
      const connection = await controller.getConnection(idCheck.value);
      ensureConnectionPermission(auth.principal, connection.spaceId);
      // Maps to the vault revoke path (the former DELETE handler logic).
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

  // --- Spaces (Core Specification §4) ----------------------------------------

  const spaces = dependencies.spacesService;
  const installations = dependencies.installationsService;

  app.post(TAKOSUMI_SPACES_ROUTE, deployControlBodyLimit, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    if (!spaces) return c.json(notImplemented(c, "spaces not wired"), 501);
    const limit = enforceBodyLimit(c, DEPLOY_CONTROL_JSON_BODY_LIMIT_BYTES);
    if (limit) return limit;
    return await runHandler(c, async () => {
      // Space creation is not scoped by an existing space id, so only an
      // unrestricted principal (`spaceIds: "*"`) may mint new Spaces.
      ensureSpaceCreatePermission(auth.principal);
      const body = await readJsonBody<CreateSpaceRequest>(c, "spaceCreate");
      return c.json({ space: await spaces.createSpace(body) }, 201);
    });
  });

  app.get(TAKOSUMI_SPACES_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    if (!spaces) return c.json(notImplemented(c, "spaces not wired"), 501);
    return await runHandler(c, async () => {
      const all = await spaces.listSpaces();
      // A scoped principal only sees the Spaces it may access.
      const visible = auth.principal.spaceIds === "*"
        ? all
        : all.filter((space) => scopeAllows(auth.principal.spaceIds, space.id));
      return c.json({ spaces: visible }, 200);
    });
  });

  app.get(TAKOSUMI_SPACE_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    if (!spaces) return c.json(notImplemented(c, "spaces not wired"), 501);
    const idCheck = ensureValidParam(c, "spaceId", SPACE_ID_PATTERN);
    if (idCheck.kind === "invalid") return idCheck.response;
    return await runHandler(c, async () => {
      ensureSpacePermission(auth.principal, idCheck.value);
      return c.json({ space: await spaces.getSpace(idCheck.value) }, 200);
    });
  });

  // §30 `PATCH /api/spaces/:spaceId` — MVP: displayName only.
  app.patch(TAKOSUMI_SPACE_ROUTE, deployControlBodyLimit, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    if (!spaces) return c.json(notImplemented(c, "spaces not wired"), 501);
    const idCheck = ensureValidParam(c, "spaceId", SPACE_ID_PATTERN);
    if (idCheck.kind === "invalid") return idCheck.response;
    const limit = enforceBodyLimit(c, DEPLOY_CONTROL_JSON_BODY_LIMIT_BYTES);
    if (limit) return limit;
    return await runHandler(c, async () => {
      ensureSpacePermission(auth.principal, idCheck.value);
      const body = await readJsonBody<{ readonly displayName: string }>(
        c,
        "spacePatch",
      );
      if (!nonEmptyString(body.displayName)) {
        throw new OpenTofuControllerError(
          "invalid_argument",
          "displayName is required",
        );
      }
      const space = await spaces.updateSpace(idCheck.value, {
        displayName: body.displayName,
      });
      return c.json({ space }, 200);
    });
  });

  // --- Operator default connections (Core Specification §9) ------------------

  const connectionsService = dependencies.connectionsService;

  app.put(
    TAKOSUMI_OPERATOR_CONNECTION_DEFAULTS_ROUTE,
    deployControlBodyLimit,
    async (c) => {
      const auth = await authorizeDeployControl(c, dependencies);
      if (!auth.ok) return auth.response;
      if (!connectionsService) {
        return c.json(notImplemented(c, "connections not wired"), 501);
      }
      const limit = enforceBodyLimit(c, DEPLOY_CONTROL_JSON_BODY_LIMIT_BYTES);
      if (limit) return limit;
      return await runHandler(c, async () => {
        // Instance-wide defaults: only the unrestricted bearer may set them.
        ensureConnectionPermission(auth.principal, undefined);
        const body = await readJsonBody<PutOperatorConnectionDefaultRequest>(
          c,
          "operatorConnectionDefault",
        );
        const record = await connectionsService.putOperatorConnectionDefault(
          body,
        );
        return c.json({ operatorConnectionDefault: record }, 200);
      });
    },
  );

  app.get(TAKOSUMI_OPERATOR_CONNECTION_DEFAULTS_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    if (!connectionsService) {
      return c.json(notImplemented(c, "connections not wired"), 501);
    }
    return await runHandler(c, async () => {
      ensureConnectionPermission(auth.principal, undefined);
      return c.json({
        operatorConnectionDefaults: await connectionsService
          .listOperatorConnectionDefaults(),
      }, 200);
    });
  });

  // --- Installations + InstallConfigs (Core Specification §5 / §11) -----------

  app.post(
    TAKOSUMI_SPACE_INSTALLATIONS_ROUTE,
    deployControlBodyLimit,
    async (c) => {
      const auth = await authorizeDeployControl(c, dependencies);
      if (!auth.ok) return auth.response;
      if (!installations) {
        return c.json(notImplemented(c, "installations not wired"), 501);
      }
      const idCheck = ensureValidParam(c, "spaceId", SPACE_ID_PATTERN);
      if (idCheck.kind === "invalid") return idCheck.response;
      const limit = enforceBodyLimit(c, DEPLOY_CONTROL_JSON_BODY_LIMIT_BYTES);
      if (limit) return limit;
      return await runHandler(c, async () => {
        ensureSpacePermission(auth.principal, idCheck.value);
        const body = await readJsonBody<
          Omit<CreateInstallationRequest, "spaceId">
        >(c, "installationCreate");
        const installation = await installations.createInstallation({
          ...body,
          spaceId: idCheck.value,
        });
        return c.json({ installation }, 201);
      });
    },
  );

  app.get(TAKOSUMI_SPACE_INSTALLATIONS_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    if (!installations) {
      return c.json(notImplemented(c, "installations not wired"), 501);
    }
    const idCheck = ensureValidParam(c, "spaceId", SPACE_ID_PATTERN);
    if (idCheck.kind === "invalid") return idCheck.response;
    return await runHandler(c, async () => {
      ensureSpacePermission(auth.principal, idCheck.value);
      return c.json(
        { installations: await installations.listInstallations(idCheck.value) },
        200,
      );
    });
  });

  // --- PUBLIC §30 Installation + Deployment reads --------------------------

  app.get(TAKOSUMI_API_INSTALLATION_ROUTE, async (c) => {
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

  // §30: Installation PATCH is minimal for MVP (status note handled via run
  // lifecycle); the surface exists but is not implemented.
  app.patch(TAKOSUMI_API_INSTALLATION_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    return c.json(
      notImplemented(c, "installation patch is not implemented yet"),
      501,
    );
  });

  // §30: Installation DELETE is NOT a destroy shortcut for MVP; callers use the
  // destroy-plan flow (`POST /api/installations/:id/destroy-plan`).
  app.delete(TAKOSUMI_API_INSTALLATION_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    return c.json(
      notImplemented(
        c,
        "installation delete is not implemented; use POST /api/installations/:installationId/destroy-plan",
      ),
      501,
    );
  });

  app.get(TAKOSUMI_API_INSTALLATION_DEPLOYMENTS_ROUTE, async (c) => {
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

  app.get(TAKOSUMI_DEPLOYMENT_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    const idCheck = ensureValidParam(c, "deploymentId", DEPLOYMENT_ID_PATTERN);
    if (idCheck.kind === "invalid") return idCheck.response;
    return await runHandler(c, async () => {
      const deployment = await controller.getDeployment(idCheck.value);
      ensureSpacePermission(auth.principal, deployment.spaceId);
      return c.json({ deployment }, 200);
    });
  });

  app.post(TAKOSUMI_DEPLOYMENT_ROLLBACK_PLAN_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    const idCheck = ensureValidParam(c, "deploymentId", DEPLOYMENT_ID_PATTERN);
    if (idCheck.kind === "invalid") return idCheck.response;
    return await runHandler(c, async () => {
      // Resolve the Deployment first so the rollback plan is space-permission
      // gated via its Space, then create the pinned rollback plan.
      const deployment = await controller.getDeployment(idCheck.value);
      ensureSpacePermission(auth.principal, deployment.spaceId);
      const response = await controller.createDeploymentRollbackPlan(
        idCheck.value,
        { actor: auth.principal.actor },
      );
      return c.json(response, 201);
    });
  });

  app.get(TAKOSUMI_INSTALL_CONFIGS_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    if (!installations) {
      return c.json(notImplemented(c, "installations not wired"), 501);
    }
    const spaceId = c.req.query("spaceId");
    return await runHandler(c, async () => {
      if (spaceId !== undefined) {
        ensureSpacePermission(auth.principal, spaceId);
      }
      // Without a spaceId only the official catalog (spaceId-less configs) is
      // returned; with one, the official catalog plus that Space's own configs.
      const official = (await installations.listInstallConfigs()).filter(
        (config) => config.spaceId === undefined,
      );
      const scoped = spaceId === undefined
        ? []
        : await installations.listInstallConfigs(spaceId);
      return c.json({ installConfigs: [...official, ...scoped] }, 200);
    });
  });

  // --- Installation-driven plan / destroy-plan (§10 / §23) ------------------

  app.post(TAKOSUMI_INSTALLATION_PLAN_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    const idCheck = ensureValidId(c, "installationId");
    if (idCheck.kind === "invalid") return idCheck.response;
    return await runHandler(c, async () => {
      const installation = await controller.getInstallation(idCheck.value);
      ensureSpacePermission(auth.principal, installation.installation.spaceId);
      const response = await controller.createInstallationPlan(idCheck.value, {
        actor: auth.principal.actor,
      });
      return c.json(response, 201);
    });
  });

  app.post(TAKOSUMI_INSTALLATION_DESTROY_PLAN_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    const idCheck = ensureValidId(c, "installationId");
    if (idCheck.kind === "invalid") return idCheck.response;
    return await runHandler(c, async () => {
      const installation = await controller.getInstallation(idCheck.value);
      ensureSpacePermission(auth.principal, installation.installation.spaceId);
      const response = await controller.createInstallationDestroyPlan(
        idCheck.value,
        { actor: auth.principal.actor },
      );
      return c.json(response, 201);
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

  app.get(TAKOSUMI_RUN_LOGS_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    const idCheck = ensureValidParam(c, "runId", RUN_ID_PATTERN);
    if (idCheck.kind === "invalid") return idCheck.response;
    return await runHandler(c, async () => {
      // Resolve the run's space first so logs are space-permission gated.
      const run = await controller.getRun(idCheck.value);
      ensureSpacePermission(auth.principal, run.spaceId);
      return c.json(await controller.getRunLogs(idCheck.value), 200);
    });
  });

  app.get(TAKOSUMI_RUN_EVENTS_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    const idCheck = ensureValidParam(c, "runId", RUN_ID_PATTERN);
    if (idCheck.kind === "invalid") return idCheck.response;
    return await runHandler(c, async () => {
      const run = await controller.getRun(idCheck.value);
      ensureSpacePermission(auth.principal, run.spaceId);
      return c.json(await controller.getRunEvents(idCheck.value), 200);
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

  // --- Dependencies (Core Specification §14 / §15) --------------------------

  const dependenciesService = dependencies.dependenciesService;

  app.post(
    TAKOSUMI_INSTALLATION_DEPENDENCIES_ROUTE,
    deployControlBodyLimit,
    async (c) => {
      const auth = await authorizeDeployControl(c, dependencies);
      if (!auth.ok) return auth.response;
      if (!dependenciesService) {
        return c.json(notImplemented(c, "dependencies not wired"), 501);
      }
      const idCheck = ensureValidId(c, "installationId");
      if (idCheck.kind === "invalid") return idCheck.response;
      const limit = enforceBodyLimit(c, DEPLOY_CONTROL_JSON_BODY_LIMIT_BYTES);
      if (limit) return limit;
      return await runHandler(c, async () => {
        // The consumer is the path Installation; its Space gates the write.
        const consumer = await controller.getInstallation(idCheck.value);
        ensureSpacePermission(auth.principal, consumer.installation.spaceId);
        const body = await readJsonBody<
          Omit<CreateDependencyRequest, "spaceId" | "consumerInstallationId">
        >(c, "dependencyCreate");
        const dependency = await dependenciesService.createDependency({
          ...body,
          spaceId: consumer.installation.spaceId,
          consumerInstallationId: idCheck.value,
        });
        return c.json({ dependency }, 201);
      });
    },
  );

  app.get(TAKOSUMI_INSTALLATION_DEPENDENCIES_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    if (!dependenciesService) {
      return c.json(notImplemented(c, "dependencies not wired"), 501);
    }
    const idCheck = ensureValidId(c, "installationId");
    if (idCheck.kind === "invalid") return idCheck.response;
    return await runHandler(c, async () => {
      const installation = await controller.getInstallation(idCheck.value);
      ensureSpacePermission(auth.principal, installation.installation.spaceId);
      return c.json(
        await dependenciesService.listForInstallation(idCheck.value),
        200,
      );
    });
  });

  app.delete(TAKOSUMI_DEPENDENCY_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    if (!dependenciesService) {
      return c.json(notImplemented(c, "dependencies not wired"), 501);
    }
    const idCheck = ensureValidParam(c, "dependencyId", DEPENDENCY_ID_PATTERN);
    if (idCheck.kind === "invalid") return idCheck.response;
    return await runHandler(c, async () => {
      // Resolve the edge first so deletion is space-permission gated via its
      // consumer Installation's Space (the edge carries spaceId directly).
      const dependency = await dependenciesService.getDependency(idCheck.value);
      if (!dependency) {
        throw new OpenTofuControllerError(
          "not_found",
          `dependency ${idCheck.value} not found`,
        );
      }
      ensureSpacePermission(auth.principal, dependency.spaceId);
      await dependenciesService.deleteDependency(idCheck.value);
      return c.body(null, 204);
    });
  });

  // --- Output shares (Core Specification §18 — surface exists, post-MVP) -----
  // The cross-Space OutputShare surface is defined but not implemented for MVP
  // (spec §34 / §35 Phase 8). The routes authenticate and then 501 so the
  // surface is discoverable without leaking an unconfigured handler.
  app.post(TAKOSUMI_OUTPUT_SHARES_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    return c.json(notImplemented(c, "output shares are not implemented yet"), 501);
  });
  app.get(TAKOSUMI_OUTPUT_SHARES_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    return c.json(notImplemented(c, "output shares are not implemented yet"), 501);
  });
  app.post(TAKOSUMI_OUTPUT_SHARE_REVOKE_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    return c.json(notImplemented(c, "output shares are not implemented yet"), 501);
  });

  // --- RunGroups (Core Specification §19 / §24) -----------------------------

  const runGroupsService = dependencies.runGroupsService;

  app.post(TAKOSUMI_SPACE_PLAN_UPDATE_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    if (!runGroupsService) {
      return c.json(notImplemented(c, "run groups not wired"), 501);
    }
    const idCheck = ensureValidParam(c, "spaceId", SPACE_ID_PATTERN);
    if (idCheck.kind === "invalid") return idCheck.response;
    return await runHandler(c, async () => {
      ensureSpacePermission(auth.principal, idCheck.value);
      const result = await runGroupsService.createSpaceUpdate(idCheck.value);
      return c.json(result, 201);
    });
  });

  app.get(TAKOSUMI_RUN_GROUP_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    if (!runGroupsService) {
      return c.json(notImplemented(c, "run groups not wired"), 501);
    }
    const idCheck = ensureValidParam(c, "runGroupId", RUN_GROUP_ID_PATTERN);
    if (idCheck.kind === "invalid") return idCheck.response;
    return await runHandler(c, async () => {
      const result = await runGroupsService.getRunGroup(idCheck.value);
      if (!result) {
        throw new OpenTofuControllerError(
          "not_found",
          `run group ${idCheck.value} not found`,
        );
      }
      ensureSpacePermission(auth.principal, result.runGroup.spaceId);
      return c.json(result, 200);
    });
  });

  app.post(TAKOSUMI_RUN_GROUP_APPROVE_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    if (!runGroupsService) {
      return c.json(notImplemented(c, "run groups not wired"), 501);
    }
    const idCheck = ensureValidParam(c, "runGroupId", RUN_GROUP_ID_PATTERN);
    if (idCheck.kind === "invalid") return idCheck.response;
    return await runHandler(c, async () => {
      // Resolve the group first so approve is space-permission gated.
      const existing = await runGroupsService.getRunGroup(idCheck.value);
      if (!existing) {
        throw new OpenTofuControllerError(
          "not_found",
          `run group ${idCheck.value} not found`,
        );
      }
      ensureSpacePermission(auth.principal, existing.runGroup.spaceId);
      const result = await runGroupsService.approveRunGroup(idCheck.value);
      return c.json(result, 200);
    });
  });

  // --- Activity audit trail (§27 / §34) -------------------------------------

  app.get(TAKOSUMI_SPACE_ACTIVITY_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    const activityService = dependencies.activityService;
    if (!activityService) {
      return c.json(notImplemented(c, "activity not wired"), 501);
    }
    const idCheck = ensureValidParam(c, "spaceId", SPACE_ID_PATTERN);
    if (idCheck.kind === "invalid") return idCheck.response;
    const limit = parseActivityLimit(c.req.query("limit"));
    if (limit.kind === "invalid") {
      return c.json(
        errorEnvelope(
          c,
          "invalid_argument",
          `limit must be an integer in 1..${ACTIVITY_MAX_LIMIT}`,
        ),
        400,
      );
    }
    return await runHandler(c, async () => {
      ensureSpacePermission(auth.principal, idCheck.value);
      const events = await activityService.list(idCheck.value, limit.value);
      return c.json({ events }, 200);
    });
  });

}

/**
 * Parses + validates the `?limit=` query for the Activity listing: an integer in
 * `1..ACTIVITY_MAX_LIMIT`, or absent (returns `undefined`, letting the service
 * apply its default). Anything else is a 400.
 */
function parseActivityLimit(
  raw: string | undefined,
):
  | { readonly kind: "ok"; readonly value: number | undefined }
  | { readonly kind: "invalid" } {
  if (raw === undefined || raw === "") return { kind: "ok", value: undefined };
  if (!/^\d+$/.test(raw)) return { kind: "invalid" };
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > ACTIVITY_MAX_LIMIT) {
    return { kind: "invalid" };
  }
  return { kind: "ok", value };
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
  app.post(
    TAKOSUMI_CONNECTIONS_SOURCE_HTTPS_TOKEN_ROUTE,
    post("connections not wired"),
  );
  app.post(
    TAKOSUMI_CONNECTIONS_SOURCE_SSH_KEY_ROUTE,
    post("connections not wired"),
  );
  app.post(
    TAKOSUMI_CONNECTIONS_CLOUDFLARE_TOKEN_ROUTE,
    post("connections not wired"),
  );
  app.post(
    TAKOSUMI_CONNECTIONS_AWS_ASSUME_ROLE_ROUTE,
    post("aws assume-role connections are not implemented yet"),
  );
  app.get(TAKOSUMI_CONNECTIONS_ROUTE, get("connections not wired"));
  app.post(TAKOSUMI_CONNECTION_TEST_ROUTE, post("connections not wired"));
  app.post(TAKOSUMI_CONNECTION_REVOKE_ROUTE, post("connections not wired"));
  app.post(TAKOSUMI_SOURCES_ROUTE, post("sources not wired"));
  app.get(TAKOSUMI_SOURCES_ROUTE, get("sources not wired"));
  app.get(TAKOSUMI_SOURCE_ROUTE, get("sources not wired"));
  app.patch(TAKOSUMI_SOURCE_ROUTE, post("sources not wired"));
  app.post(TAKOSUMI_SOURCE_SYNC_ROUTE, post("sources not wired"));
  app.get(TAKOSUMI_SOURCE_SNAPSHOTS_ROUTE, get("sources not wired"));
  app.post(TAKOSUMI_SPACES_ROUTE, post("spaces not wired"));
  app.get(TAKOSUMI_SPACES_ROUTE, get("spaces not wired"));
  app.get(TAKOSUMI_SPACE_ROUTE, get("spaces not wired"));
  app.patch(TAKOSUMI_SPACE_ROUTE, post("spaces not wired"));
  app.post(
    TAKOSUMI_SPACE_INSTALLATIONS_ROUTE,
    post("installations not wired"),
  );
  app.get(TAKOSUMI_SPACE_INSTALLATIONS_ROUTE, get("installations not wired"));
  app.get(TAKOSUMI_API_INSTALLATION_ROUTE, get("installations not wired"));
  app.patch(
    TAKOSUMI_API_INSTALLATION_ROUTE,
    post("installation patch is not implemented yet"),
  );
  app.delete(
    TAKOSUMI_API_INSTALLATION_ROUTE,
    post(
      "installation delete is not implemented; use POST /api/installations/:installationId/destroy-plan",
    ),
  );
  app.get(
    TAKOSUMI_API_INSTALLATION_DEPLOYMENTS_ROUTE,
    get("deployment ledger not wired"),
  );
  app.get(TAKOSUMI_DEPLOYMENT_ROUTE, get("deployment ledger not wired"));
  app.post(
    TAKOSUMI_DEPLOYMENT_ROLLBACK_PLAN_ROUTE,
    post("deployment rollback not wired"),
  );
  app.get(TAKOSUMI_INSTALL_CONFIGS_ROUTE, get("installations not wired"));
  app.post(TAKOSUMI_INSTALLATION_PLAN_ROUTE, post("installations not wired"));
  app.post(
    TAKOSUMI_INSTALLATION_DESTROY_PLAN_ROUTE,
    post("installations not wired"),
  );
  app.get(TAKOSUMI_RUN_ROUTE, get("runs not wired"));
  app.get(TAKOSUMI_RUN_LOGS_ROUTE, get("runs not wired"));
  app.get(TAKOSUMI_RUN_EVENTS_ROUTE, get("runs not wired"));
  app.post(TAKOSUMI_RUN_APPROVE_ROUTE, post("runs not wired"));
  app.post(TAKOSUMI_RUN_CANCEL_ROUTE, post("runs not wired"));
  app.post(
    TAKOSUMI_INSTALLATION_DEPENDENCIES_ROUTE,
    post("dependencies not wired"),
  );
  app.get(
    TAKOSUMI_INSTALLATION_DEPENDENCIES_ROUTE,
    get("dependencies not wired"),
  );
  app.delete(TAKOSUMI_DEPENDENCY_ROUTE, post("dependencies not wired"));
  app.post(
    TAKOSUMI_OUTPUT_SHARES_ROUTE,
    post("output shares are not implemented yet"),
  );
  app.get(
    TAKOSUMI_OUTPUT_SHARES_ROUTE,
    get("output shares are not implemented yet"),
  );
  app.post(
    TAKOSUMI_OUTPUT_SHARE_REVOKE_ROUTE,
    post("output shares are not implemented yet"),
  );
  app.post(TAKOSUMI_SPACE_PLAN_UPDATE_ROUTE, post("run groups not wired"));
  app.get(TAKOSUMI_RUN_GROUP_ROUTE, get("run groups not wired"));
  app.post(TAKOSUMI_RUN_GROUP_APPROVE_ROUTE, post("run groups not wired"));
  app.get(TAKOSUMI_SPACE_ACTIVITY_ROUTE, get("activity not wired"));
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

/**
 * Space creation is not gated by an existing space id, so a space-scoped
 * principal (`spaceIds: string[]`) cannot mint arbitrary Spaces; only the
 * unrestricted deploy-control bearer (`spaceIds: "*"`) may.
 */
function ensureSpaceCreatePermission(principal: DeployControlPrincipal): void {
  if (principal.spaceIds === "*") return;
  throw new OpenTofuControllerError(
    "permission_denied",
    `deploy control principal ${principal.actor} cannot create spaces`,
  );
}

/**
 * Operator-scoped connections (spec §8: no owning Space) are instance-wide;
 * only the unrestricted bearer may touch them. A space-scoped connection
 * falls back to the normal space permission check.
 */
function ensureConnectionPermission(
  principal: DeployControlPrincipal,
  spaceId: string | undefined,
): void {
  if (spaceId !== undefined) {
    ensureSpacePermission(principal, spaceId);
    return;
  }
  if (principal.spaceIds === "*") return;
  throw new OpenTofuControllerError(
    "permission_denied",
    `deploy control principal ${principal.actor} cannot manage operator-scoped connections`,
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
