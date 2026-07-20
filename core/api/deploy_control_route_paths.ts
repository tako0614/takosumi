/**
 * Canonical route-path constants for the deploy-control seam, shared by the
 * per-resource-group route modules and the descriptor inventory. Every route is
 * an INTERNAL seam under `/internal/v1` (reached in-process or by the account
 * plane, never edge-public); co-locating the paths keeps the mount calls and
 * the descriptor in lockstep.
 */

import {
  APPLY_RUNS_PATH,
  CONNECTION_OAUTH_CALLBACK_PATH,
  CONNECTION_OAUTH_START_PATH,
  CONNECTION_SETUP_PATH,
  CONNECTIONS_PATH,
  CREDENTIAL_RECIPES_PATH,
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
// The Capsule read (`/internal/v1/capsules/:capsuleId`) and the state history
// list (`.../state-versions`) are owned by the Capsule route group
// (TAKOSUMI_API_CAPSULE_ROUTE / TAKOSUMI_API_CAPSULE_STATE_VERSIONS_ROUTE);
// the former separate ledger-seam duplicates were removed once both collapsed
// onto /internal/v1.

// --- INTERNAL deploy-control resource routes (`/internal/v1`). ----------------
export const TAKOSUMI_CONNECTIONS_ROUTE = CONNECTIONS_PATH;
export const TAKOSUMI_CONNECTION_ROUTE =
  `${INTERNAL_V1_PREFIX}/connections/:connectionId` as const;
export const TAKOSUMI_CONNECTION_SETUP_ROUTE = CONNECTION_SETUP_PATH;
export const TAKOSUMI_CONNECTION_OAUTH_START_ROUTE =
  CONNECTION_OAUTH_START_PATH;
export const TAKOSUMI_CONNECTION_OAUTH_CALLBACK_ROUTE =
  CONNECTION_OAUTH_CALLBACK_PATH;
export const TAKOSUMI_CREDENTIAL_RECIPES_ROUTE = CREDENTIAL_RECIPES_PATH;
export const TAKOSUMI_CREDENTIAL_RECIPE_ROUTE =
  `${INTERNAL_V1_PREFIX}/credential-recipes/:recipeId` as const;
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
export const TAKOSUMI_SOURCE_SNAPSHOT_FILE_ROUTE =
  `${INTERNAL_V1_PREFIX}/sources/:sourceId/snapshots/:sourceSnapshotId/file` as const;
export const TAKOSUMI_WORKSPACE_STABLE_SOURCE_TAG_ROUTE =
  `${INTERNAL_V1_PREFIX}/workspaces/:workspaceId/source-ref-resolutions/stable-semver` as const;
export const TAKOSUMI_COMPATIBILITY_REPORT_ROUTE =
  `${INTERNAL_V1_PREFIX}/compatibility-reports/:reportId` as const;
export const TAKOSUMI_WORKSPACES_ROUTE =
  `${INTERNAL_V1_PREFIX}/workspaces` as const;
export const TAKOSUMI_WORKSPACE_ROUTE =
  `${INTERNAL_V1_PREFIX}/workspaces/:workspaceId` as const;
export const TAKOSUMI_WORKSPACE_CAPSULES_ROUTE =
  `${INTERNAL_V1_PREFIX}/workspaces/:workspaceId/capsules` as const;
// Project routes (Workspace / Project / Capsule final model). Additive: the
// `:workspaceId` segment keeps the current Workspace path until the coordinated
// route-path convergence flips `/spaces` -> `/workspaces`.
export const TAKOSUMI_PROJECTS_ROUTE =
  `${INTERNAL_V1_PREFIX}/workspaces/:workspaceId/projects` as const;
export const TAKOSUMI_PROJECT_ROUTE =
  `${INTERNAL_V1_PREFIX}/projects/:projectId` as const;
/** Capsule read / patch / delete. */
export const TAKOSUMI_API_CAPSULE_ROUTE =
  `${INTERNAL_V1_PREFIX}/capsules/:capsuleId` as const;
/** State history list for a Capsule. */
export const TAKOSUMI_API_CAPSULE_STATE_VERSIONS_ROUTE =
  `${INTERNAL_V1_PREFIX}/capsules/:capsuleId/state-versions` as const;
/** Current public Output projection for a Capsule. */
export const TAKOSUMI_API_CAPSULE_OUTPUTS_ROUTE =
  `${INTERNAL_V1_PREFIX}/capsules/:capsuleId/outputs` as const;
export const TAKOSUMI_STATE_VERSION_ROUTE =
  `${INTERNAL_V1_PREFIX}/state-versions/:stateVersionId` as const;
export const TAKOSUMI_STATE_VERSION_ROLLBACK_PLAN_ROUTE =
  `${INTERNAL_V1_PREFIX}/state-versions/:stateVersionId/rollback-plan` as const;
export const TAKOSUMI_INSTALL_CONFIGS_ROUTE =
  `${INTERNAL_V1_PREFIX}/install-configs` as const;
export const TAKOSUMI_INSTALL_CONFIG_ROUTE =
  `${INTERNAL_V1_PREFIX}/install-configs/:installConfigId` as const;
export const TAKOSUMI_CAPSULE_PLAN_ROUTE =
  `${INTERNAL_V1_PREFIX}/capsules/:capsuleId/plan` as const;
export const TAKOSUMI_CAPSULE_DESTROY_PLAN_ROUTE =
  `${INTERNAL_V1_PREFIX}/capsules/:capsuleId/destroy-plan` as const;
/**
 * Capsule drift-check route. Creates a read-only drift-check plan that
 * never parks waiting_approval and can never be applied.
 */
export const TAKOSUMI_CAPSULE_DRIFT_CHECK_ROUTE =
  `${INTERNAL_V1_PREFIX}/capsules/:capsuleId/drift-check` as const;
export const TAKOSUMI_RUN_ROUTE = `${INTERNAL_V1_PREFIX}/runs/:runId` as const;
export const TAKOSUMI_RUN_LOGS_ROUTE =
  `${INTERNAL_V1_PREFIX}/runs/:runId/logs` as const;
export const TAKOSUMI_RUN_EVENTS_ROUTE =
  `${INTERNAL_V1_PREFIX}/runs/:runId/events` as const;
export const TAKOSUMI_RUN_COST_ROUTE =
  `${INTERNAL_V1_PREFIX}/runs/:runId/cost` as const;
export const TAKOSUMI_RUN_APPROVE_ROUTE =
  `${INTERNAL_V1_PREFIX}/runs/:runId/approve` as const;
export const TAKOSUMI_RUN_CANCEL_ROUTE =
  `${INTERNAL_V1_PREFIX}/runs/:runId/cancel` as const;
export const TAKOSUMI_CAPSULE_DEPENDENCIES_ROUTE =
  `${INTERNAL_V1_PREFIX}/capsules/:capsuleId/dependencies` as const;
export const TAKOSUMI_DEPENDENCY_ROUTE =
  `${INTERNAL_V1_PREFIX}/dependencies/:dependencyId` as const;
export const TAKOSUMI_OUTPUT_SHARES_ROUTE =
  `${INTERNAL_V1_PREFIX}/output-shares` as const;
export const TAKOSUMI_OUTPUT_SHARE_APPROVE_ROUTE =
  `${INTERNAL_V1_PREFIX}/output-shares/:shareId/approve` as const;
export const TAKOSUMI_OUTPUT_SHARE_REVOKE_ROUTE =
  `${INTERNAL_V1_PREFIX}/output-shares/:shareId/revoke` as const;
export const TAKOSUMI_WORKSPACE_PLAN_UPDATE_ROUTE =
  `${INTERNAL_V1_PREFIX}/workspaces/:workspaceId/plan-update` as const;
export const TAKOSUMI_WORKSPACE_DRIFT_CHECK_ROUTE =
  `${INTERNAL_V1_PREFIX}/workspaces/:workspaceId/drift-check` as const;
export const TAKOSUMI_RUN_GROUP_ROUTE =
  `${INTERNAL_V1_PREFIX}/run-groups/:runGroupId` as const;
export const TAKOSUMI_RUN_GROUP_APPROVE_ROUTE =
  `${INTERNAL_V1_PREFIX}/run-groups/:runGroupId/approve` as const;
export const TAKOSUMI_WORKSPACE_ACTIVITY_ROUTE =
  `${INTERNAL_V1_PREFIX}/workspaces/:workspaceId/activity` as const;
export const TAKOSUMI_WORKSPACE_BILLING_ROUTE =
  `${INTERNAL_V1_PREFIX}/workspaces/:workspaceId/billing` as const;
export const TAKOSUMI_WORKSPACE_USAGE_ROUTE =
  `${INTERNAL_V1_PREFIX}/workspaces/:workspaceId/usage` as const;
export const TAKOSUMI_WORKSPACE_BACKUPS_ROUTE =
  `${INTERNAL_V1_PREFIX}/workspaces/:workspaceId/backups` as const;
export const TAKOSUMI_WORKSPACE_BACKUP_RESTORES_ROUTE =
  `${INTERNAL_V1_PREFIX}/workspaces/:workspaceId/backups/:backupId/restores` as const;
export const TAKOSUMI_CAPSULE_BACKUPS_ROUTE =
  `${INTERNAL_V1_PREFIX}/capsules/:capsuleId/backups` as const;
/** Operator-only, explicit migration from retired backing-Capsule state. */
export const TAKOSUMI_WORKSPACE_RESOURCE_STATE_ADOPTION_ROUTE =
  `${INTERNAL_V1_PREFIX}/workspaces/:workspaceId/migrations/resource-state-adoption` as const;
/** Operator-only exact FormRef migration over canonical Resource/ResolutionLock rows. */
export const TAKOSUMI_WORKSPACE_RESOURCE_FORM_PIN_BACKFILL_ROUTE =
  `${INTERNAL_V1_PREFIX}/workspaces/:workspaceId/migrations/resource-form-pins/backfill` as const;
/** Operator-only retained exact FormRef replay from a redacted backup sidecar. */
export const TAKOSUMI_WORKSPACE_RESOURCE_FORM_PIN_RESTORE_ROUTE =
  `${INTERNAL_V1_PREFIX}/workspaces/:workspaceId/migrations/resource-form-pins/restore` as const;
/** Operator-only install of one immutable, verifier-approved Form Package. */
export const TAKOSUMI_FORM_PACKAGE_INSTALL_ROUTE =
  `${INTERNAL_V1_PREFIX}/form-packages/install` as const;
/** Operator-only re-verification of one retained exact FormRef/package pair. */
export const TAKOSUMI_FORM_PACKAGE_REVERIFY_ROUTE =
  `${INTERNAL_V1_PREFIX}/form-packages/reverify` as const;
/** Operator-only migration from retired runtime Output conventions. */
export const TAKOSUMI_WORKSPACE_OUTPUT_INTERFACE_MIGRATION_ROUTE =
  `${INTERNAL_V1_PREFIX}/workspaces/:workspaceId/migrations/output-interfaces` as const;
