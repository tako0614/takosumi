/**
 * Canonical route-path constants for the deploy-control seam, shared by the
 * per-resource-group route modules and the descriptor inventory. Every route is
 * an INTERNAL seam under `/internal/v1` (reached in-process or by the account
 * plane, never edge-public); co-locating the paths keeps the mount calls and
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
import { INTERNAL_V1_PREFIX } from "takosumi-contract/api-surface";

// --- INTERNAL seam routes consumed by the accounts plane + CLI in-process. ----
export const TAKOSUMI_RUNNER_PROFILES_ROUTE = RUNNER_PROFILES_PATH;
export const TAKOSUMI_PLAN_RUNS_ROUTE =
  `${INTERNAL_V1_PREFIX}/plan-runs` as const;
export const TAKOSUMI_PLAN_RUN_ROUTE =
  `${INTERNAL_V1_PREFIX}/plan-runs/:planRunId` as const;
export const TAKOSUMI_APPLY_RUNS_ROUTE = APPLY_RUNS_PATH;
export const TAKOSUMI_APPLY_RUN_ROUTE =
  `${INTERNAL_V1_PREFIX}/apply-runs/:applyRunId` as const;
/** INTERNAL Installation read used by the accounts plane. */
export const TAKOSUMI_INSTALLATION_ROUTE =
  `${INTERNAL_V1_PREFIX}/installations/:installationId` as const;
/** INTERNAL Deployment list read used by the accounts plane. */
export const TAKOSUMI_INSTALLATION_DEPLOYMENTS_ROUTE =
  `${INTERNAL_V1_PREFIX}/installations/:installationId/deployments` as const;
/** INTERNAL DeploymentOutput read used by the accounts plane. */
export const TAKOSUMI_INSTALLATION_DEPLOYMENT_OUTPUTS_ROUTE =
  `${INTERNAL_V1_PREFIX}/installations/:installationId/deployment-outputs` as const;

// --- INTERNAL deploy-control resource routes (`/internal/v1`). ----------------
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
export const TAKOSUMI_PROVIDER_ROUTE =
  `${INTERNAL_V1_PREFIX}/providers/:providerId` as const;
export const TAKOSUMI_CONNECTION_TEST_ROUTE =
  `${INTERNAL_V1_PREFIX}/connections/:connectionId/test` as const;
export const TAKOSUMI_CONNECTION_REVOKE_ROUTE =
  `${INTERNAL_V1_PREFIX}/connections/:connectionId/revoke` as const;
export const TAKOSUMI_SOURCES_ROUTE = SOURCES_PATH;
export const TAKOSUMI_SOURCE_ROUTE =
  `${INTERNAL_V1_PREFIX}/sources/:sourceId` as const;
export const TAKOSUMI_SOURCE_SYNC_ROUTE =
  `${INTERNAL_V1_PREFIX}/sources/:sourceId/sync` as const;
export const TAKOSUMI_SOURCE_COMPATIBILITY_CHECK_ROUTE =
  `${INTERNAL_V1_PREFIX}/sources/:sourceId/compatibility-check` as const;
export const TAKOSUMI_SOURCE_SNAPSHOTS_ROUTE =
  `${INTERNAL_V1_PREFIX}/sources/:sourceId/snapshots` as const;
export const TAKOSUMI_COMPATIBILITY_REPORT_ROUTE =
  `${INTERNAL_V1_PREFIX}/compatibility-reports/:reportId` as const;
export const TAKOSUMI_SPACES_ROUTE = `${INTERNAL_V1_PREFIX}/spaces` as const;
export const TAKOSUMI_OPERATOR_CONNECTION_DEFAULTS_ROUTE =
  `${INTERNAL_V1_PREFIX}/operator-connection-defaults` as const;
export const TAKOSUMI_SPACE_ROUTE =
  `${INTERNAL_V1_PREFIX}/spaces/:spaceId` as const;
export const TAKOSUMI_SPACE_INSTALLATIONS_ROUTE =
  `${INTERNAL_V1_PREFIX}/spaces/:spaceId/installations` as const;
/** Installation read / patch / delete. */
export const TAKOSUMI_API_INSTALLATION_ROUTE =
  `${INTERNAL_V1_PREFIX}/installations/:installationId` as const;
/** Deployment list for an Installation. */
export const TAKOSUMI_API_INSTALLATION_DEPLOYMENTS_ROUTE =
  `${INTERNAL_V1_PREFIX}/installations/:installationId/deployments` as const;
export const TAKOSUMI_DEPLOYMENT_ROUTE =
  `${INTERNAL_V1_PREFIX}/deployments/:deploymentId` as const;
export const TAKOSUMI_DEPLOYMENT_ROLLBACK_PLAN_ROUTE =
  `${INTERNAL_V1_PREFIX}/deployments/:deploymentId/rollback-plan` as const;
export const TAKOSUMI_INSTALL_CONFIGS_ROUTE =
  `${INTERNAL_V1_PREFIX}/install-configs` as const;
export const TAKOSUMI_INSTALL_CONFIG_ROUTE =
  `${INTERNAL_V1_PREFIX}/install-configs/:installConfigId` as const;
export const TAKOSUMI_INSTALLATION_PLAN_ROUTE =
  `${INTERNAL_V1_PREFIX}/installations/:installationId/plan` as const;
export const TAKOSUMI_INSTALLATION_DESTROY_PLAN_ROUTE =
  `${INTERNAL_V1_PREFIX}/installations/:installationId/destroy-plan` as const;
/**
 * Installation drift-check route. Creates a read-only drift-check plan that
 * never parks waiting_approval and can never be applied.
 */
export const TAKOSUMI_INSTALLATION_DRIFT_CHECK_ROUTE =
  `${INTERNAL_V1_PREFIX}/installations/:installationId/drift-check` as const;
export const TAKOSUMI_RUN_ROUTE = `${INTERNAL_V1_PREFIX}/runs/:runId` as const;
export const TAKOSUMI_RUN_LOGS_ROUTE =
  `${INTERNAL_V1_PREFIX}/runs/:runId/logs` as const;
export const TAKOSUMI_RUN_EVENTS_ROUTE =
  `${INTERNAL_V1_PREFIX}/runs/:runId/events` as const;
export const TAKOSUMI_RUN_APPROVE_ROUTE =
  `${INTERNAL_V1_PREFIX}/runs/:runId/approve` as const;
export const TAKOSUMI_RUN_CANCEL_ROUTE =
  `${INTERNAL_V1_PREFIX}/runs/:runId/cancel` as const;
export const TAKOSUMI_INSTALLATION_DEPENDENCIES_ROUTE =
  `${INTERNAL_V1_PREFIX}/installations/:installationId/dependencies` as const;
export const TAKOSUMI_DEPENDENCY_ROUTE =
  `${INTERNAL_V1_PREFIX}/dependencies/:dependencyId` as const;
export const TAKOSUMI_OUTPUT_SHARES_ROUTE =
  `${INTERNAL_V1_PREFIX}/output-shares` as const;
export const TAKOSUMI_OUTPUT_SHARE_APPROVE_ROUTE =
  `${INTERNAL_V1_PREFIX}/output-shares/:shareId/approve` as const;
export const TAKOSUMI_OUTPUT_SHARE_REVOKE_ROUTE =
  `${INTERNAL_V1_PREFIX}/output-shares/:shareId/revoke` as const;
export const TAKOSUMI_SPACE_PLAN_UPDATE_ROUTE =
  `${INTERNAL_V1_PREFIX}/spaces/:spaceId/plan-update` as const;
export const TAKOSUMI_SPACE_DRIFT_CHECK_ROUTE =
  `${INTERNAL_V1_PREFIX}/spaces/:spaceId/drift-check` as const;
export const TAKOSUMI_RUN_GROUP_ROUTE =
  `${INTERNAL_V1_PREFIX}/run-groups/:runGroupId` as const;
export const TAKOSUMI_RUN_GROUP_APPROVE_ROUTE =
  `${INTERNAL_V1_PREFIX}/run-groups/:runGroupId/approve` as const;
export const TAKOSUMI_SPACE_ACTIVITY_ROUTE =
  `${INTERNAL_V1_PREFIX}/spaces/:spaceId/activity` as const;
export const TAKOSUMI_SPACE_BILLING_ROUTE =
  `${INTERNAL_V1_PREFIX}/spaces/:spaceId/billing` as const;
export const TAKOSUMI_SPACE_USAGE_ROUTE =
  `${INTERNAL_V1_PREFIX}/spaces/:spaceId/usage` as const;
export const TAKOSUMI_SPACE_CREDIT_RESERVATIONS_ROUTE =
  `${INTERNAL_V1_PREFIX}/spaces/:spaceId/credit-reservations` as const;
export const TAKOSUMI_SPACE_CREDITS_TOP_UP_ROUTE =
  `${INTERNAL_V1_PREFIX}/spaces/:spaceId/credits/top-up` as const;
export const TAKOSUMI_SPACE_SUBSCRIPTION_CHANGE_ROUTE =
  `${INTERNAL_V1_PREFIX}/spaces/:spaceId/subscription/change` as const;
export const TAKOSUMI_SPACE_BACKUPS_ROUTE =
  `${INTERNAL_V1_PREFIX}/spaces/:spaceId/backups` as const;
export const TAKOSUMI_INSTALLATION_BACKUPS_ROUTE =
  `${INTERNAL_V1_PREFIX}/installations/:installationId/backups` as const;
