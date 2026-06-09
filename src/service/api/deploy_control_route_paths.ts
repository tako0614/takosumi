/**
 * Canonical route-path constants for the public `/api` deploy-control surface
 * and the internal `/v1` seam, shared by the per-resource-group route modules
 * and the descriptor inventory. Co-locating the paths keeps the mount calls and
 * the descriptor in lockstep.
 */

import {
  APPLY_RUNS_PATH,
  CONNECTIONS_AWS_ASSUME_ROLE_PATH,
  CONNECTIONS_CLOUDFLARE_OAUTH_CALLBACK_PATH,
  CONNECTIONS_CLOUDFLARE_OAUTH_START_PATH,
  CONNECTIONS_CLOUDFLARE_TOKEN_PATH,
  CONNECTIONS_GCP_IMPERSONATION_PATH,
  CONNECTIONS_GCP_OAUTH_CALLBACK_PATH,
  CONNECTIONS_GCP_OAUTH_START_PATH,
  CONNECTIONS_PROVIDER_ENV_SET_PATH,
  CONNECTIONS_PATH,
  CONNECTIONS_SOURCE_HTTPS_TOKEN_PATH,
  CONNECTIONS_SOURCE_SSH_KEY_PATH,
  PROVIDERS_PATH,
  RUNNER_PROFILES_PATH,
} from "@takosumi/internal/deploy-control-api";
import { SOURCES_PATH } from "takosumi-contract/sources";

// --- INTERNAL `/v1` seam routes (NOT public `/api`). These are the in-process
// fetch seam the accounts plane + CLI consume; they keep the `/v1` prefix while
// public deploy-control APIs live under `/api`. -------------------------------
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

// --- PUBLIC `/api` routes. ----------------------------------------------------
export const TAKOSUMI_CONNECTIONS_ROUTE = CONNECTIONS_PATH;
export const TAKOSUMI_CONNECTIONS_SOURCE_HTTPS_TOKEN_ROUTE =
  CONNECTIONS_SOURCE_HTTPS_TOKEN_PATH;
export const TAKOSUMI_CONNECTIONS_SOURCE_SSH_KEY_ROUTE =
  CONNECTIONS_SOURCE_SSH_KEY_PATH;
export const TAKOSUMI_CONNECTIONS_CLOUDFLARE_TOKEN_ROUTE =
  CONNECTIONS_CLOUDFLARE_TOKEN_PATH;
export const TAKOSUMI_CONNECTIONS_AWS_ASSUME_ROLE_ROUTE =
  CONNECTIONS_AWS_ASSUME_ROLE_PATH;
export const TAKOSUMI_CONNECTIONS_PROVIDER_ENV_SET_ROUTE =
  CONNECTIONS_PROVIDER_ENV_SET_PATH;
export const TAKOSUMI_CONNECTIONS_CLOUDFLARE_OAUTH_START_ROUTE =
  CONNECTIONS_CLOUDFLARE_OAUTH_START_PATH;
export const TAKOSUMI_CONNECTIONS_CLOUDFLARE_OAUTH_CALLBACK_ROUTE =
  CONNECTIONS_CLOUDFLARE_OAUTH_CALLBACK_PATH;
export const TAKOSUMI_CONNECTIONS_GCP_OAUTH_START_ROUTE =
  CONNECTIONS_GCP_OAUTH_START_PATH;
export const TAKOSUMI_CONNECTIONS_GCP_OAUTH_CALLBACK_ROUTE =
  CONNECTIONS_GCP_OAUTH_CALLBACK_PATH;
export const TAKOSUMI_CONNECTIONS_GCP_IMPERSONATION_ROUTE =
  CONNECTIONS_GCP_IMPERSONATION_PATH;
export const TAKOSUMI_PROVIDERS_ROUTE = PROVIDERS_PATH;
export const TAKOSUMI_PROVIDER_ROUTE = "/api/providers/:providerId" as const;
export const TAKOSUMI_CONNECTION_TEST_ROUTE =
  "/api/connections/:connectionId/test" as const;
export const TAKOSUMI_CONNECTION_REVOKE_ROUTE =
  "/api/connections/:connectionId/revoke" as const;
export const TAKOSUMI_SOURCES_ROUTE = SOURCES_PATH;
export const TAKOSUMI_SOURCE_ROUTE = "/api/sources/:sourceId" as const;
export const TAKOSUMI_SOURCE_SYNC_ROUTE =
  "/api/sources/:sourceId/sync" as const;
export const TAKOSUMI_SOURCE_COMPATIBILITY_CHECK_ROUTE =
  "/api/sources/:sourceId/compatibility-check" as const;
export const TAKOSUMI_SOURCE_SNAPSHOTS_ROUTE =
  "/api/sources/:sourceId/snapshots" as const;
export const TAKOSUMI_COMPATIBILITY_REPORT_ROUTE =
  "/api/compatibility-reports/:reportId" as const;
export const TAKOSUMI_SPACES_ROUTE = "/api/spaces" as const;
export const TAKOSUMI_OPERATOR_CONNECTION_DEFAULTS_ROUTE =
  "/api/operator-connection-defaults" as const;
export const TAKOSUMI_SPACE_ROUTE = "/api/spaces/:spaceId" as const;
export const TAKOSUMI_SPACE_INSTALLATIONS_ROUTE =
  "/api/spaces/:spaceId/installations" as const;
/** PUBLIC Installation read / patch / delete. */
export const TAKOSUMI_API_INSTALLATION_ROUTE =
  "/api/installations/:installationId" as const;
/** PUBLIC Deployment list for an Installation. */
export const TAKOSUMI_API_INSTALLATION_DEPLOYMENTS_ROUTE =
  "/api/installations/:installationId/deployments" as const;
export const TAKOSUMI_DEPLOYMENT_ROUTE =
  "/api/deployments/:deploymentId" as const;
export const TAKOSUMI_DEPLOYMENT_ROLLBACK_PLAN_ROUTE =
  "/api/deployments/:deploymentId/rollback-plan" as const;
export const TAKOSUMI_INSTALL_CONFIGS_ROUTE = "/api/install-configs" as const;
export const TAKOSUMI_INSTALL_CONFIG_ROUTE =
  "/api/install-configs/:installConfigId" as const;
export const TAKOSUMI_INSTALLATION_PLAN_ROUTE =
  "/api/installations/:installationId/plan" as const;
export const TAKOSUMI_INSTALLATION_DESTROY_PLAN_ROUTE =
  "/api/installations/:installationId/destroy-plan" as const;
/**
 * Installation drift-check route. Creates a read-only drift-check plan that
 * never parks waiting_approval and can never be applied.
 */
export const TAKOSUMI_INSTALLATION_DRIFT_CHECK_ROUTE =
  "/api/installations/:installationId/drift-check" as const;
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
export const TAKOSUMI_OUTPUT_SHARE_APPROVE_ROUTE =
  "/api/output-shares/:shareId/approve" as const;
export const TAKOSUMI_OUTPUT_SHARE_REVOKE_ROUTE =
  "/api/output-shares/:shareId/revoke" as const;
export const TAKOSUMI_SPACE_PLAN_UPDATE_ROUTE =
  "/api/spaces/:spaceId/plan-update" as const;
export const TAKOSUMI_SPACE_DRIFT_CHECK_ROUTE =
  "/api/spaces/:spaceId/drift-check" as const;
export const TAKOSUMI_RUN_GROUP_ROUTE = "/api/run-groups/:runGroupId" as const;
export const TAKOSUMI_RUN_GROUP_APPROVE_ROUTE =
  "/api/run-groups/:runGroupId/approve" as const;
export const TAKOSUMI_SPACE_ACTIVITY_ROUTE =
  "/api/spaces/:spaceId/activity" as const;
export const TAKOSUMI_SPACE_BILLING_ROUTE =
  "/api/spaces/:spaceId/billing" as const;
export const TAKOSUMI_SPACE_USAGE_ROUTE = "/api/spaces/:spaceId/usage" as const;
export const TAKOSUMI_SPACE_CREDIT_RESERVATIONS_ROUTE =
  "/api/spaces/:spaceId/credit-reservations" as const;
export const TAKOSUMI_SPACE_CREDITS_TOP_UP_ROUTE =
  "/api/spaces/:spaceId/credits/top-up" as const;
export const TAKOSUMI_SPACE_SUBSCRIPTION_CHANGE_ROUTE =
  "/api/spaces/:spaceId/subscription/change" as const;
export const TAKOSUMI_SPACE_BACKUPS_ROUTE =
  "/api/spaces/:spaceId/backups" as const;
export const TAKOSUMI_INSTALLATION_BACKUPS_ROUTE =
  "/api/installations/:installationId/backups" as const;
