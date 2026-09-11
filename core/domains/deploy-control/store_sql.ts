/**
 * SQL-backed OpenTofu deployment-control-plane ledger (core-spec.md §27).
 *
 * The store keeps searchable columns for common list/read paths and persists
 * the contract object as JSON so the public run ledger can evolve without a
 * schema migration for every non-indexed field.
 *
 * Logical schema is the Workspace/Capsule model. Frozen pre-v1 physical column
 * names such as `space_id` / `installation_id` remain private to this adapter;
 * TypeScript schema keys and JSON records are canonical. A SINGLE `runs` table
 * stores the internal PlanRun
 * (kind `plan`), ApplyRun (kind `apply`), SourceSyncRun (kind `source_sync`),
 * CompatibilityCheck Run (kind `compatibility_check`), and Backup Run records
 * persist as rows discriminated by `kind`; the typed accessors verify the row
 * kind before parsing.
 */
import type {
  ApplyRun,
  ProviderConnection,
  InstallConfig,
  Capsule,
  PlanRun,
  RunnerProfile,
  StateVersion,
} from "@takosumi/internal/deploy-control-api";
import type { SqlClient } from "../../adapters/storage/sql.ts";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  lt,
  ne,
  notExists,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { drizzle, type PgRemoteDatabase } from "drizzle-orm/pg-proxy";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import * as pgSchema from "../../adapters/storage/drizzle/schema/postgres.ts";
import type { SourceSnapshot, SourceSyncRun } from "takosumi-contract/sources";
import type { CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import type {
  AccountWorkspaceListParams,
  AccountWorkspacePage,
  Workspace,
  WorkspaceMember,
} from "takosumi-contract/workspaces";
import type { Project } from "takosumi-contract/projects";
import type { ProviderBindingSet } from "takosumi-contract/connections";
import type { InstallConfigCommittedPostApplyRecoveryProof } from "takosumi-contract/install-configs";
import type {
  Dependency,
  DependencySnapshot,
} from "takosumi-contract/dependencies";
import type { OutputShare, Output } from "takosumi-contract/outputs";
import type { ArtifactRecord, Run, RunGroup } from "takosumi-contract/runs";
import type { ActivityEvent } from "takosumi-contract/activity";
import {
  clampPageLimit,
  decodeCursor,
  type Page,
  type PageParams,
  pageFromProbe,
  pageFromProbeBy,
  pageSorted,
} from "takosumi-contract/pagination";
import type { BackupRecord } from "takosumi-contract/backups";
import type { UsageEvent } from "takosumi-contract/billing";
import type {
  CredentialMintEvent,
  SecurityFinding,
} from "takosumi-contract/security";
import type {
  CommitSourceSyncSuccessInput,
  CommitSourceSyncSuccessResult,
  CommitRunStateInput,
  CommitRunStateResult,
  CommitRestoredStateInput,
  CommitRestoredStateResult,
  BeginApplyRunResult,
  BeginBackupRunResult,
  BeginCompatibilityCheckRunResult,
  CommitCompatibilityCheckRunInput,
  CommitCompatibilityCheckRunResult,
  CommitBackupRunInput,
  CommitBackupRunResult,
  BeginRestoreRunResult,
  BeginSourceSyncRunResult,
  ConnectionActorAuthority,
  CreateConnectionRegistrationInput,
  CommitConnectionTestResultInput,
  CapsuleExecutionAuthority,
  CapsuleExecutionAuthorityInput,
  CapsuleInitialAuthorityInput,
  CapsuleInitialAuthorityResult,
  SourceConfigurationWriteInput,
  SourceConfigurationWriteResult,
  CapsuleInstallConfigRebindInput,
  CapsuleInstallConfigRebindResult,
  ClaimCapsuleInterfaceMaterializationIntentInput,
  MarkConnectionExpiredIfUnchangedInput,
  RevokeConnectionIfUnchangedInput,
  MarkCapsuleStaleCommand,
  MarkCapsuleStaleResult,
  UpdateCapsuleLifecycleCommand,
  UpdateCapsuleLifecycleResult,
  CapsuleRuntimeSafety,
  CapsulePatch,
  CapsuleStateVersionGuard,
  OpenTofuControlStore,
  PreparePlanRunInput,
  PreparePlanRunResult,
  PlanRunInputs,
  PublicHostReservation,
  RecoverableOpenTofuRunListOptions,
  RenewCapsuleInterfaceMaterializationIntentLeaseInput,
  RenewCapsuleInterfaceMaterializationIntentLeaseResult,
  RetryCapsuleInterfaceMaterializationIntentInput,
  RetryCapsuleInterfaceMaterializationIntentResult,
  RuntimeSecretRetirementDispatchClaimInput,
  SettleCapsuleInterfaceMaterializationIntentInput,
  SettleCapsuleInterfaceMaterializationIntentResult,
  StoredInstallConfig,
  StoredManagedRun,
  StoredRunRecord,
  StoredSecretBlob,
  StoredSource,
  ProjectCreationInput,
  ProjectCreationResult,
  CapsuleListPageParams,
  BeginWorkspaceDrainingResult,
  FreezeWorkspaceManagementExpectation,
  FreezeWorkspaceManagementResult,
  WorkspaceManagement,
  WorkspaceManagementAuthority,
  WorkspaceAccountReplacementInput,
  WorkspaceMemberMutationInput,
  WorkspaceOwnerMemberRepairInput,
  WorkspaceReplacementInput,
  RunManagementAuthorityInput,
  TransitionRunInput,
  TransitionRunResult,
} from "./store.ts";
import {
  assertExactRunTransitionInput,
  assertDrainRunCancellationInput,
  assertSourceSyncSuccessCommit,
  assertSourceConfigurationWriteInput,
  assertWorkspaceManagementAdmission,
  assertWorkspaceManagementAuthorityInput,
  assertWorkspaceFreezeExpectation,
  assertCompatibilityCheckRunAdmissionInput,
  compatibilityCheckRunAdmissionMatches,
  compatibilityCheckReportForStorage,
  assertCommitCompatibilityCheckRunInput,
  compatibilityCheckRunCommitDisposition,
  assertCommitBackupRunInput,
  backupRunCommitDisposition,
  prepareConnectionExpiration,
  prepareConnectionRegistration,
  prepareConnectionRevocation,
  prepareConnectionTestResult,
  validateWorkspaceMemberReplacement,
  validateWorkspaceOwnerMemberRepair,
  validateWorkspaceReplacement,
  assertCapsulePlanCreationFence,
  assertPlanRunPreparation,
  assertCapsuleInterfaceMaterializationIntentClaimInput,
  assertCapsuleInterfaceMaterializationIntentSettlementInput,
  assertRetryCapsuleInterfaceMaterializationIntentInput,
  assertRenewCapsuleInterfaceMaterializationIntentLeaseInput,
  boundedActivityWorkspaceIds,
  capsuleInterfaceMaterializationFailureListLimit,
  clampActivityLimit,
  clampRecoverableOpenTofuRunListLimit,
  clampRunListLimit,
  capsuleLifecycleMutationAlreadyApplied,
  capsuleLifecycleMutationPatch,
  capsuleRuntimeSafetyFromRun,
  CapsuleStateVersionGuardConflict,
  CapsuleStateGenerationGuardConflict,
  WorkspaceManagementAdmissionConflictError,
  isApplyRunRecord,
  isPlanRunRecord,
  isSourceSyncRunRecord,
  isRecoverableOpenTofuRunRecord,
  normalizeStoredCapsuleCompatibilityLevel,
  normalizeStoredCapsuleCompatibilityReport,
  normalizeWorkspaceManagement,
  parseStoredCapsuleRootModuleVariableDeclarations,
  parseStoredCapsuleCompatibilityProviderGraph,
  planRunPreparationPersistsInputs,
  PRE_PROVIDER_RUNNER_FAILURE_DIAGNOSTIC_CODES,
  planRunPreparationExactlyMatches,
  PlanRunPreparationConflictError,
  providerBindingSetAuthorityDigest,
  providerBindingSetTargetsCapsule,
  runtimeSecretRetirementDispatchAttempt,
  sourceSnapshotsExactlyMatch,
  workspaceAccountReplacementAllowed,
  workspaceAccountAuthorityAllowed,
  workspaceMemberMutationAllowed,
  workspaceMemberMutationDropsOwner,
  installConfigManagementAuthority,
  installConfigRequiresManagementAuthority,
  publicStoredInstallConfig,
  storeInstallConfig,
  sourceSyncRunStoredIdentityMatches,
  sourceSyncRunManagementAuthority,
  sourceSyncRunImmutableIdentityMatches,
  runStoredIdentityMatches,
  runDrainCancellationMatches,
  runRequiresStoredManagementAuthority,
  runManagementAuthority,
  runManagementAuthorityForIdentity,
  preserveStoredRunManagementAuthority,
  storeRunManagementAuthority,
  restoreRunCreationIdentityMatches,
  publicStoredRun,
  storeSourceSyncRun,
  storedCapsuleCompatibilityProviderGraph,
  SourceSnapshotConflictError,
  validateCommitRestoredStateInterfaceMaterialization,
  validateCommitRunStateInterfaceMaterializationIntent,
} from "./store.ts";
import {
  PG_GIT_INSTALL_PLAN_MANAGEMENT_BLOCKER_SQL,
} from "../install-plans/management_blockers_sql.ts";
import {
  capsuleInterfaceBlueprintsJson,
  type CapsuleInterfaceMaterializationIntent,
  validateCapsuleInterfaceMaterializationIntent,
} from "./interface_materialization_intent.ts";
import {
  artifactRecordFromRow,
  coerceRunRowStatus,
  normalizeCapsuleRecord,
  normalizeOptionalCapsuleRecord,
  normalizeOptionalSourceSnapshotRecord,
  normalizeSourceSnapshotRecord,
  normalizeUsageEvent,
  parseWorkspaceMemberRecord,
  WorkspaceMemberRowError,
  workspaceMemberFromRow,
  usageEventFromRow,
  usageResourceMetadataFromRow,
} from "./store_row_mappers.ts";
import type { SqlTransaction } from "../../adapters/storage/sql.ts";
import {
  stableJsonDigest,
  stableStringify,
} from "../../adapters/source/digest.ts";
import {
  committedPostApplyRecoveryProofMatches,
  exactRecoveryProofsEqual,
  type CommittedPostApplyRecoveryRows,
} from "./committed_post_apply_recovery.ts";

/** Discriminator stored in the single `runs` table (§27). */
// §27 runs.type values. Destroy runs persist their own discriminator
// (destroy_plan / destroy_apply) so the raw table matches the spec enum and
// the D1 backend; the typed accessors read both kinds of their family.
const RUN_KINDS_PLAN = ["plan", "destroy_plan"] as const;
const RUN_KINDS_APPLY = ["apply", "destroy_apply"] as const;
const RUN_KIND_SOURCE_SYNC = "source_sync";
const RUN_KIND_COMPATIBILITY_CHECK = "compatibility_check";

function compatibilityReportSourceId(value: string | null | undefined): string {
  if (!value?.trim()) {
    throw new TypeError(
      "CapsuleCompatibilityReport must reference a registered Git Source",
    );
  }
  return value;
}
const RUN_KIND_BACKUP = "backup";
const RUN_KIND_RESTORE = "restore";

/*
 * Complete, fail-closed safety projection used only by the private Workspace
 * freeze command.  This is deliberately not a second Run decoder: it checks
 * the physical/JSON fields that identify execution authority and the small
 * terminal evidence set described by workspace-management-quiescence.md.
 */
const PG_WORKSPACE_FREEZE_AUDIT_EVENTS_SQL = `
  case
    when jsonb_typeof(run.run_json -> 'auditEvents') = 'array'
      then run.run_json -> 'auditEvents'
    else '[]'::jsonb
  end
`;

const PG_WORKSPACE_FREEZE_VALID_APPLY_AUDIT_SQL = `
  jsonb_typeof(run.run_json -> 'auditEvents') = 'array'
  and not exists (
    select 1
      from jsonb_array_elements(
        ${PG_WORKSPACE_FREEZE_AUDIT_EVENTS_SQL}
      ) as audit_event(value)
     where jsonb_typeof(audit_event.value) is distinct from 'object'
        or jsonb_typeof(audit_event.value -> 'type') is distinct from 'string'
        or btrim(audit_event.value ->> 'type') = ''
        or case
             when audit_event.value ? 'data' then
               jsonb_typeof(audit_event.value -> 'data') is distinct from 'object'
               or (
                 audit_event.value -> 'data' ? 'providerDispatched'
                 and jsonb_typeof(
                   audit_event.value -> 'data' -> 'providerDispatched'
                 ) is distinct from 'boolean'
               )
               or (
                 audit_event.value -> 'data' ? 'lifecycleActionDispatched'
                 and jsonb_typeof(
                   audit_event.value -> 'data' -> 'lifecycleActionDispatched'
                 ) is distinct from 'boolean'
               )
               or (
                 audit_event.value -> 'data' ? 'actionDispatched'
                 and jsonb_typeof(
                   audit_event.value -> 'data' -> 'actionDispatched'
                 ) is distinct from 'boolean'
               )
             else false
           end
  )
`;

const PG_WORKSPACE_FREEZE_APPLY_DISPATCHED_SQL = `
  exists (
    select 1
      from jsonb_array_elements(
        ${PG_WORKSPACE_FREEZE_AUDIT_EVENTS_SQL}
      ) as audit_event(value)
     where audit_event.value -> 'data' -> 'providerDispatched' = 'true'::jsonb
        or audit_event.value -> 'data' -> 'lifecycleActionDispatched' = 'true'::jsonb
        or (
          left(
            audit_event.value ->> 'type',
            length('lifecycle_action.')
          ) = 'lifecycle_action.'
          and audit_event.value -> 'data' -> 'actionDispatched' = 'true'::jsonb
        )
  )
`;

const PG_WORKSPACE_FREEZE_APPLY_FINALIZERS_SETTLED_SQL = `
  (
    select coalesce(
      max(audit_event.ordinality) filter (
        where audit_event.value ->> 'type' = 'billing.capture.pending'
      ),
      0
    )
      from jsonb_array_elements(
        ${PG_WORKSPACE_FREEZE_AUDIT_EVENTS_SQL}
      ) with ordinality as audit_event(value, ordinality)
  ) <= (
    select coalesce(
      max(audit_event.ordinality) filter (
        where audit_event.value ->> 'type' = 'billing.capture.completed'
      ),
      0
    )
      from jsonb_array_elements(
        ${PG_WORKSPACE_FREEZE_AUDIT_EVENTS_SQL}
      ) with ordinality as audit_event(value, ordinality)
  )
  and (
    select coalesce(
      max(audit_event.ordinality) filter (
        where audit_event.value ->> 'type' = 'runtime_secret.retirement.pending'
      ),
      0
    )
      from jsonb_array_elements(
        ${PG_WORKSPACE_FREEZE_AUDIT_EVENTS_SQL}
      ) with ordinality as audit_event(value, ordinality)
  ) <= (
    select coalesce(
      max(audit_event.ordinality) filter (
        where audit_event.value ->> 'type' = 'runtime_secret.retirement.completed'
      ),
      0
    )
      from jsonb_array_elements(
        ${PG_WORKSPACE_FREEZE_AUDIT_EVENTS_SQL}
      ) with ordinality as audit_event(value, ordinality)
  )
`;

const PG_WORKSPACE_FREEZE_RUN_BLOCKER_SQL = `
  not coalesce((
    run.lease_token is null
    and run.kind in (
      'plan', 'destroy_plan', 'drift_check', 'apply', 'destroy_apply',
      'source_sync', 'compatibility_check', 'backup', 'restore'
    )
    and run.status in ('succeeded', 'failed', 'cancelled', 'expired')
    and jsonb_typeof(run.run_json) = 'object'
    and jsonb_typeof(run.run_json -> 'id') = 'string'
    and btrim(run.run_json ->> 'id') <> ''
    and run.run_json ->> 'id' = run.id
    and jsonb_typeof(run.run_json -> 'workspaceId') = 'string'
    and btrim(run.run_json ->> 'workspaceId') <> ''
    and run.run_json ->> 'workspaceId' = run.space_id
    and jsonb_typeof(run.run_json -> 'status') = 'string'
    and run.run_json ->> 'status' = run.status
    and case
      when run.source_id is null then not (run.run_json ? 'sourceId')
      else jsonb_typeof(run.run_json -> 'sourceId') = 'string'
        and btrim(run.run_json ->> 'sourceId') <> ''
        and run.run_json ->> 'sourceId' = run.source_id
    end
    and case
      when run.installation_id is null then not (run.run_json ? 'capsuleId')
      else jsonb_typeof(run.run_json -> 'capsuleId') = 'string'
        and btrim(run.run_json ->> 'capsuleId') <> ''
        and run.run_json ->> 'capsuleId' = run.installation_id
    end
    and (
      not (run.run_json ? 'environment')
      or (
        jsonb_typeof(run.run_json -> 'environment') = 'string'
        and btrim(run.run_json ->> 'environment') <> ''
      )
    )
    and case
      when run.kind in ('plan', 'destroy_plan', 'drift_check') then
        not (run.run_json ? 'environment')
        and (
          not (run.run_json ? 'capsuleContext')
          or (
            jsonb_typeof(run.run_json -> 'capsuleContext') = 'object'
            and jsonb_typeof(run.run_json -> 'capsuleContext' -> 'workspaceId') = 'string'
            and run.run_json -> 'capsuleContext' ->> 'workspaceId' = run.space_id
            and jsonb_typeof(run.run_json -> 'capsuleContext' -> 'capsuleId') = 'string'
            and btrim(run.run_json -> 'capsuleContext' ->> 'capsuleId') <> ''
            and run.run_json -> 'capsuleContext' ->> 'capsuleId' = run.installation_id
            and jsonb_typeof(run.run_json -> 'capsuleContext' -> 'environment') = 'string'
            and btrim(run.run_json -> 'capsuleContext' ->> 'environment') <> ''
          )
        )
      else true
    end
    and case
      when run.heartbeat_at is null then not (run.run_json ? 'heartbeatAt')
      else run.heartbeat_at between 0 and 9007199254740991
        and jsonb_typeof(run.run_json -> 'heartbeatAt') = 'number'
        and run.run_json -> 'heartbeatAt' = to_jsonb(run.heartbeat_at)
    end
    and case
      when run.kind in ('plan', 'destroy_plan', 'drift_check', 'apply', 'destroy_apply')
      then
        case when jsonb_typeof(run.run_json -> 'createdAt') = 'number' then
          run.run_json ->> 'createdAt' ~ '^(0|[1-9][0-9]*)$'
          and (run.run_json ->> 'createdAt')::numeric <= 9007199254740991
        else false end
        and run.run_json ->> 'createdAt' = run.created_at
        and case when jsonb_typeof(run.run_json -> 'updatedAt') = 'number' then
          run.run_json ->> 'updatedAt' ~ '^(0|[1-9][0-9]*)$'
          and (run.run_json ->> 'updatedAt')::numeric <= 9007199254740991
        else false end
        and (
          not (run.run_json ? 'startedAt')
          or case when jsonb_typeof(run.run_json -> 'startedAt') = 'number' then
            run.run_json ->> 'startedAt' ~ '^(0|[1-9][0-9]*)$'
            and (run.run_json ->> 'startedAt')::numeric <= 9007199254740991
          else false end
        )
        and (
          not (run.run_json ? 'finishedAt')
          or case when jsonb_typeof(run.run_json -> 'finishedAt') = 'number' then
            run.run_json ->> 'finishedAt' ~ '^(0|[1-9][0-9]*)$'
            and (run.run_json ->> 'finishedAt')::numeric <= 9007199254740991
          else false end
        )
      else
        jsonb_typeof(run.run_json -> 'createdAt') = 'string'
        and btrim(run.run_json ->> 'createdAt') <> ''
        and run.run_json ->> 'createdAt' = run.created_at
        and (
          not (run.run_json ? 'startedAt')
          or (
            jsonb_typeof(run.run_json -> 'startedAt') = 'string'
            and btrim(run.run_json ->> 'startedAt') <> ''
          )
        )
        and (
          not (run.run_json ? 'finishedAt')
          or (
            jsonb_typeof(run.run_json -> 'finishedAt') = 'string'
            and btrim(run.run_json ->> 'finishedAt') <> ''
          )
        )
    end
    and case
      when run.kind in ('plan', 'destroy_plan', 'drift_check') then
        (
          not (run.run_json ? 'requiresApproval')
          or jsonb_typeof(run.run_json -> 'requiresApproval') = 'boolean'
        )
        and (
          not (run.run_json ? 'appliedApplyRunId')
          or (
            jsonb_typeof(run.run_json -> 'appliedApplyRunId') = 'string'
            and btrim(run.run_json ->> 'appliedApplyRunId') <> ''
          )
        )
        and (
          not (run.run_json ? 'approval')
          or (
            jsonb_typeof(run.run_json -> 'approval') = 'object'
            and case when jsonb_typeof(
              run.run_json -> 'approval' -> 'approvedAt'
            ) = 'number' then
              run.run_json -> 'approval' ->> 'approvedAt' ~
                '^(0|[1-9][0-9]*)$'
              and (run.run_json -> 'approval' ->> 'approvedAt')::numeric <=
                9007199254740991
            else false end
          )
        )
        and not (
          run.status = 'succeeded'
          and run.kind <> 'drift_check'
          and (
            run.run_json ->> 'operation' = 'destroy'
            or coalesce(
              run.run_json -> 'requiresApproval' = 'true'::jsonb,
              false
            )
          )
          and not (run.run_json ? 'approval')
          and not (run.run_json ? 'appliedApplyRunId')
        )
      else true
    end
    and case run.kind
      when 'plan' then
        not (run.run_json ? 'kind')
        and not (run.run_json ? 'type')
        and not (run.run_json ? 'planRunId')
        and not (run.run_json ? 'expected')
        and not (run.run_json ? 'driftCheck')
        and run.run_json ->> 'operation' in ('create', 'update')
        and jsonb_typeof(run.run_json -> 'sourceDigest') = 'string'
        and btrim(run.run_json ->> 'sourceDigest') <> ''
        and jsonb_typeof(run.run_json -> 'variablesDigest') = 'string'
        and btrim(run.run_json ->> 'variablesDigest') <> ''
      when 'destroy_plan' then
        not (run.run_json ? 'kind')
        and not (run.run_json ? 'type')
        and not (run.run_json ? 'planRunId')
        and not (run.run_json ? 'expected')
        and not (run.run_json ? 'driftCheck')
        and run.run_json ->> 'operation' = 'destroy'
        and jsonb_typeof(run.run_json -> 'sourceDigest') = 'string'
        and btrim(run.run_json ->> 'sourceDigest') <> ''
        and jsonb_typeof(run.run_json -> 'variablesDigest') = 'string'
        and btrim(run.run_json ->> 'variablesDigest') <> ''
      when 'drift_check' then
        not (run.run_json ? 'kind')
        and not (run.run_json ? 'type')
        and not (run.run_json ? 'planRunId')
        and not (run.run_json ? 'expected')
        and run.run_json ->> 'operation' = 'update'
        and run.run_json -> 'driftCheck' = 'true'::jsonb
        and jsonb_typeof(run.run_json -> 'sourceDigest') = 'string'
        and btrim(run.run_json ->> 'sourceDigest') <> ''
        and jsonb_typeof(run.run_json -> 'variablesDigest') = 'string'
        and btrim(run.run_json ->> 'variablesDigest') <> ''
      when 'apply' then
        not (run.run_json ? 'kind')
        and not (run.run_json ? 'type')
        and not (run.run_json ? 'sourceDigest')
        and not (run.run_json ? 'variablesDigest')
        and run.run_json ->> 'operation' in ('create', 'update')
        and jsonb_typeof(run.run_json -> 'planRunId') = 'string'
        and btrim(run.run_json ->> 'planRunId') <> ''
        and jsonb_typeof(run.run_json -> 'expected') = 'object'
        and ${PG_WORKSPACE_FREEZE_VALID_APPLY_AUDIT_SQL}
        and ${PG_WORKSPACE_FREEZE_APPLY_FINALIZERS_SETTLED_SQL}
        and case run.status
          when 'succeeded' then true
          when 'failed' then
            not (run.run_json ? 'stateVersionId')
            and not (run.run_json ? 'outputId')
            and not (run.run_json ? 'executionEvidence')
            and not (${PG_WORKSPACE_FREEZE_APPLY_DISPATCHED_SQL})
            and exists (
              select 1
                from jsonb_array_elements(
                  ${PG_WORKSPACE_FREEZE_AUDIT_EVENTS_SQL}
                ) as audit_event(value)
               where audit_event.value ->> 'type' = 'apply.failed'
                 and audit_event.value -> 'data' -> 'providerDispatched' = 'false'::jsonb
            )
          else
            not (run.run_json ? 'stateVersionId')
            and not (run.run_json ? 'outputId')
            and not (run.run_json ? 'executionEvidence')
            and not (run.run_json ? 'startedAt')
            and not (run.run_json ? 'heartbeatAt')
            and not (${PG_WORKSPACE_FREEZE_APPLY_DISPATCHED_SQL})
        end
      when 'destroy_apply' then
        not (run.run_json ? 'kind')
        and not (run.run_json ? 'type')
        and not (run.run_json ? 'sourceDigest')
        and not (run.run_json ? 'variablesDigest')
        and run.run_json ->> 'operation' = 'destroy'
        and jsonb_typeof(run.run_json -> 'planRunId') = 'string'
        and btrim(run.run_json ->> 'planRunId') <> ''
        and jsonb_typeof(run.run_json -> 'expected') = 'object'
        and ${PG_WORKSPACE_FREEZE_VALID_APPLY_AUDIT_SQL}
        and ${PG_WORKSPACE_FREEZE_APPLY_FINALIZERS_SETTLED_SQL}
        and case run.status
          when 'succeeded' then true
          when 'failed' then
            not (run.run_json ? 'stateVersionId')
            and not (run.run_json ? 'outputId')
            and not (run.run_json ? 'executionEvidence')
            and not (${PG_WORKSPACE_FREEZE_APPLY_DISPATCHED_SQL})
            and exists (
              select 1
                from jsonb_array_elements(
                  ${PG_WORKSPACE_FREEZE_AUDIT_EVENTS_SQL}
                ) as audit_event(value)
               where (
                   audit_event.value ->> 'type' = 'apply.failed'
                   or audit_event.value ->> 'type' = 'destroy.failed'
                 )
                 and audit_event.value -> 'data' -> 'providerDispatched' = 'false'::jsonb
            )
          else
            not (run.run_json ? 'stateVersionId')
            and not (run.run_json ? 'outputId')
            and not (run.run_json ? 'executionEvidence')
            and not (run.run_json ? 'startedAt')
            and not (run.run_json ? 'heartbeatAt')
            and not (${PG_WORKSPACE_FREEZE_APPLY_DISPATCHED_SQL})
        end
      when 'source_sync' then
        run.status in ('succeeded', 'failed')
        and run.run_json ->> 'kind' = 'source_sync'
        and not (run.run_json ? 'type')
        and not (run.run_json ? 'operation')
        and not (run.run_json ? 'sourceDigest')
        and not (run.run_json ? 'variablesDigest')
        and not (run.run_json ? 'planRunId')
        and not (run.run_json ? 'expected')
        and jsonb_typeof(run.run_json -> 'sourceId') = 'string'
        and btrim(run.run_json ->> 'sourceId') <> ''
      when 'compatibility_check' then
        run.run_json ->> 'type' = 'compatibility_check'
        and not (run.run_json ? 'kind')
        and not (run.run_json ? 'operation')
        and not (run.run_json ? 'sourceDigest')
        and not (run.run_json ? 'variablesDigest')
        and not (run.run_json ? 'planRunId')
        and not (run.run_json ? 'expected')
      when 'backup' then
        run.run_json ->> 'type' = 'backup'
        and not (run.run_json ? 'kind')
        and not (run.run_json ? 'operation')
        and not (run.run_json ? 'sourceDigest')
        and not (run.run_json ? 'variablesDigest')
        and not (run.run_json ? 'planRunId')
        and not (run.run_json ? 'expected')
      when 'restore' then
        run.run_json ->> 'type' = 'restore'
        and not (run.run_json ? 'kind')
        and not (run.run_json ? 'operation')
        and not (run.run_json ? 'sourceDigest')
        and not (run.run_json ? 'variablesDigest')
        and not (run.run_json ? 'planRunId')
        and not (run.run_json ? 'expected')
        and jsonb_typeof(run.run_json -> 'capsuleId') = 'string'
        and btrim(run.run_json ->> 'capsuleId') <> ''
        and jsonb_typeof(run.run_json -> 'environment') = 'string'
        and btrim(run.run_json ->> 'environment') <> ''
        and case run.status
          when 'cancelled' then
            not (run.run_json ? 'startedAt')
            and not (run.run_json ? 'heartbeatAt')
            and not (run.run_json ? 'restoredStateVersionId')
            and not (run.run_json ? 'restoredServiceData')
          when 'succeeded' then
            jsonb_typeof(run.run_json -> 'restoredStateVersionId') = 'string'
            and btrim(run.run_json ->> 'restoredStateVersionId') <> ''
            and jsonb_typeof(run.run_json -> 'restoredFromStateVersionId') = 'string'
            and btrim(run.run_json ->> 'restoredFromStateVersionId') <> ''
            and (
              not (run.run_json ? 'restoreServiceData')
              and not (run.run_json ? 'restoredServiceData')
              or run.run_json -> 'restoreServiceData' = 'false'::jsonb
                and not (run.run_json ? 'restoredServiceData')
              or run.run_json -> 'restoreServiceData' = 'true'::jsonb
                and jsonb_typeof(run.run_json -> 'restoredServiceData') = 'object'
                and run.run_json -> 'restoredServiceData' ->> 'status' = 'restored'
                and jsonb_typeof(
                  run.run_json -> 'restoredServiceData' -> 'ref'
                ) = 'string'
                and btrim(
                  run.run_json -> 'restoredServiceData' ->> 'ref'
                ) <> ''
                and jsonb_typeof(
                  run.run_json -> 'restoredServiceData' -> 'digest'
                ) = 'string'
                and btrim(
                  run.run_json -> 'restoredServiceData' ->> 'digest'
                ) <> ''
            )
            and exists (
              select 1
                from takosumi_state_versions as target_state
                join takosumi_state_versions as source_state
                  on source_state.id = run.run_json ->> 'restoredFromStateVersionId'
               where target_state.id = run.run_json ->> 'restoredStateVersionId'
                 and target_state.space_id = run.space_id
                 and target_state.installation_id = run.installation_id
                 and target_state.environment = run.run_json ->> 'environment'
                 and source_state.space_id = run.space_id
                 and source_state.installation_id = run.installation_id
                 and source_state.environment = run.run_json ->> 'environment'
                 and target_state.generation > source_state.generation
                 and jsonb_typeof(run.run_json -> 'restoreStateGeneration') = 'number'
                 and run.run_json -> 'restoreStateGeneration' =
                   to_jsonb(source_state.generation)
                 and jsonb_typeof(target_state.snapshot_json) = 'object'
                 and target_state.snapshot_json -> 'id' = to_jsonb(target_state.id)
                 and target_state.snapshot_json -> 'workspaceId' = to_jsonb(target_state.space_id)
                 and target_state.snapshot_json -> 'capsuleId' = to_jsonb(target_state.installation_id)
                 and target_state.snapshot_json -> 'environment' = to_jsonb(target_state.environment)
                 and target_state.snapshot_json -> 'generation' =
                   to_jsonb(target_state.generation)
                 and target_state.snapshot_json -> 'createdByRunId' = to_jsonb(run.id)
                 and jsonb_typeof(source_state.snapshot_json) = 'object'
                 and source_state.snapshot_json -> 'id' = to_jsonb(source_state.id)
                 and source_state.snapshot_json -> 'workspaceId' = to_jsonb(source_state.space_id)
                 and source_state.snapshot_json -> 'capsuleId' = to_jsonb(source_state.installation_id)
                 and source_state.snapshot_json -> 'environment' = to_jsonb(source_state.environment)
                 and source_state.snapshot_json -> 'generation' =
                   to_jsonb(source_state.generation)
                 and jsonb_typeof(source_state.snapshot_json -> 'createdByRunId') = 'string'
                 and btrim(source_state.snapshot_json ->> 'createdByRunId') <> ''
                 and (
                   (
                     not exists (
                       select 1
                         from takosumi_capsule_interface_materialization_intents
                        where id = 'cimi_' ||
                          (source_state.snapshot_json ->> 'createdByRunId')
                     )
                     and not exists (
                       select 1
                         from takosumi_capsule_interface_materialization_intents
                        where id = 'cimi_restore_' ||
                          (source_state.snapshot_json ->> 'createdByRunId')
                     )
                   )
                   or exists (
                     select 1
                       from takosumi_capsule_interface_materialization_intents
                         as source_intent
                      where source_intent.id = case
                        when exists (
                          select 1
                            from takosumi_capsule_interface_materialization_intents
                           where id = 'cimi_' ||
                             (source_state.snapshot_json ->> 'createdByRunId')
                        ) then 'cimi_' ||
                          (source_state.snapshot_json ->> 'createdByRunId')
                        else 'cimi_restore_' ||
                          (source_state.snapshot_json ->> 'createdByRunId')
                      end
                        and source_intent.workspace_id = run.space_id
                        and source_intent.capsule_id = run.installation_id
                        and source_intent.state_version_id = source_state.id
                        and source_intent.state_generation = source_state.generation
                        and exists (
                          select 1
                            from takosumi_capsule_interface_materialization_intents
                              as replacement_intent
                           where replacement_intent.id = 'cimi_restore_' || run.id
                             and replacement_intent.apply_run_id is null
                             and replacement_intent.restore_run_id = run.id
                             and replacement_intent.source_intent_id = source_intent.id
                             and replacement_intent.workspace_id = run.space_id
                             and replacement_intent.capsule_id = run.installation_id
                             and replacement_intent.state_version_id = target_state.id
                             and replacement_intent.state_generation = target_state.generation
                             and replacement_intent.blueprints_digest =
                               source_intent.blueprints_digest
                        )
                   )
                 )
            )
          else false
        end
      else false
    end
  ), false)
`;

const PG_WORKSPACE_FREEZE_INTERFACE_BLOCKER_SQL = `
  not coalesce((
    intent.status = 'completed'
    and intent.lease_token is null
    and intent.lease_expires_at is null
    and intent.error_json is null
    and intent.dead_lettered_at is null
    and btrim(intent.id) <> ''
    and btrim(intent.workspace_id) <> ''
    and btrim(intent.capsule_id) <> ''
    and btrim(intent.install_config_id) <> ''
    and btrim(intent.state_version_id) <> ''
    and btrim(intent.output_id) <> ''
    and btrim(intent.completed_at) <> ''
    and intent.state_generation >= 1
    and intent.total_items >= 1
    and intent.next_item_index between 0 and intent.total_items
    and intent.attempts >= 0
    and intent.blueprints_digest ~ '^sha256:[0-9a-f]{64}$'
    and (
      intent.apply_run_id is not null
      and btrim(intent.apply_run_id) <> ''
      and intent.restore_run_id is null
      and intent.source_intent_id is null
      and intent.id = 'cimi_' || intent.apply_run_id
      or intent.apply_run_id is null
      and intent.restore_run_id is not null
      and btrim(intent.restore_run_id) <> ''
      and intent.source_intent_id is not null
      and btrim(intent.source_intent_id) <> ''
      and intent.id = 'cimi_restore_' || intent.restore_run_id
    )
    and exists (
      select 1
        from takosumi_runs as origin_run
       where origin_run.id = coalesce(intent.apply_run_id, intent.restore_run_id)
         and origin_run.space_id = intent.workspace_id
         and origin_run.installation_id = intent.capsule_id
         and origin_run.status = 'succeeded'
         and (
           intent.apply_run_id is not null and origin_run.kind = 'apply'
           or intent.restore_run_id is not null and origin_run.kind = 'restore'
         )
    )
    and exists (
      select 1
        from takosumi_state_versions as intent_state
       where intent_state.id = intent.state_version_id
         and intent_state.space_id = intent.workspace_id
         and intent_state.installation_id = intent.capsule_id
         and intent_state.generation = intent.state_generation
         and jsonb_typeof(intent_state.snapshot_json) = 'object'
         and intent_state.snapshot_json -> 'id' = to_jsonb(intent_state.id)
         and intent_state.snapshot_json -> 'workspaceId' = to_jsonb(intent_state.space_id)
         and intent_state.snapshot_json -> 'capsuleId' = to_jsonb(intent_state.installation_id)
         and intent_state.snapshot_json -> 'generation' =
           to_jsonb(intent_state.generation)
         and intent_state.snapshot_json -> 'createdByRunId' =
           to_jsonb(coalesce(intent.apply_run_id, intent.restore_run_id))
    )
    and (
      intent.restore_run_id is null
      or exists (
        select 1
          from takosumi_runs as restore_origin
          join takosumi_state_versions as source_state
            on source_state.id =
              restore_origin.run_json ->> 'restoredFromStateVersionId'
          join takosumi_capsule_interface_materialization_intents
            as source_intent
            on source_intent.id = intent.source_intent_id
         where restore_origin.id = intent.restore_run_id
           and restore_origin.kind = 'restore'
           and restore_origin.space_id = intent.workspace_id
           and restore_origin.installation_id = intent.capsule_id
           and jsonb_typeof(
                 restore_origin.run_json -> 'restoredFromStateVersionId'
               ) = 'string'
           and source_state.space_id = intent.workspace_id
           and source_state.installation_id = intent.capsule_id
           and source_state.environment =
             restore_origin.run_json ->> 'environment'
           and source_state.generation >= 1
           and jsonb_typeof(source_state.snapshot_json) = 'object'
           and source_state.snapshot_json -> 'id' = to_jsonb(source_state.id)
           and source_state.snapshot_json -> 'workspaceId' = to_jsonb(source_state.space_id)
           and source_state.snapshot_json -> 'capsuleId' =
             to_jsonb(source_state.installation_id)
           and source_state.snapshot_json -> 'environment' =
             to_jsonb(source_state.environment)
           and source_state.snapshot_json -> 'generation' =
             to_jsonb(source_state.generation)
           and jsonb_typeof(
                 source_state.snapshot_json -> 'createdByRunId'
               ) = 'string'
           and btrim(
                 source_state.snapshot_json ->> 'createdByRunId'
               ) <> ''
           and source_intent.id = case
             when exists (
               select 1
                 from takosumi_capsule_interface_materialization_intents
                where id = 'cimi_' ||
                  (source_state.snapshot_json ->> 'createdByRunId')
             ) then 'cimi_' ||
               (source_state.snapshot_json ->> 'createdByRunId')
             else 'cimi_restore_' ||
               (source_state.snapshot_json ->> 'createdByRunId')
           end
           and source_intent.workspace_id = intent.workspace_id
           and source_intent.capsule_id = intent.capsule_id
           and source_intent.install_config_id = intent.install_config_id
           and source_intent.state_version_id = source_state.id
           and source_intent.state_generation = source_state.generation
           and source_intent.blueprints_digest = intent.blueprints_digest
      )
    )
    and jsonb_typeof(intent.receipt_json) = 'object'
    and (
      select count(*)
        from jsonb_object_keys(
          case when jsonb_typeof(intent.receipt_json) = 'object'
            then intent.receipt_json else '{}'::jsonb end
        )
    ) = 3
    and jsonb_typeof(intent.receipt_json -> 'disposition') = 'string'
    and intent.receipt_json ->> 'disposition' in (
      'materialized',
      'retired_before_materialization',
      'superseded_before_materialization'
    )
    and jsonb_typeof(intent.receipt_json -> 'blueprintsDigest') = 'string'
    and intent.receipt_json ->> 'blueprintsDigest' = intent.blueprints_digest
    and jsonb_typeof(intent.receipt_json -> 'completedAt') = 'string'
    and intent.receipt_json ->> 'completedAt' = intent.completed_at
    and (
      intent.receipt_json ->> 'disposition' <> 'materialized'
      or intent.next_item_index = intent.total_items
    )
  ), false)
`;

/** Internal transaction abort used when a manual-backup settlement CAS loses. */
class BackupCommitConflictError extends Error {
  constructor() {
    super("manual Backup settlement conflict");
    this.name = "BackupCommitConflictError";
  }
}

/** Internal transaction abort used when a compatibility settlement CAS loses. */
class CompatibilityCheckCommitConflictError extends Error {
  constructor() {
    super("compatibility Check settlement conflict");
    this.name = "CompatibilityCheckCommitConflictError";
  }
}

const PG_PRE_PROVIDER_FAILURE_CODE_SQL =
  PRE_PROVIDER_RUNNER_FAILURE_DIAGNOSTIC_CODES.map((code) => `'${code}'`).join(
    ", ",
  );

function pgRunCreatedAtMillisOrder(): SQL {
  return sql`
    CASE
      WHEN ${pgSchema.runs.createdAt} ~ '^[0-9]+$'
        THEN ${pgSchema.runs.createdAt}::double precision
      ELSE EXTRACT(EPOCH FROM ${pgSchema.runs.createdAt}::timestamptz) * 1000
    END
  `;
}

/**
 * Parse a stored Run timestamp with the same numeric-then-Date.parse order as
 * runTimestampValue, without allowing malformed input to reach a cast.
 *
 * This deliberately remains local to recoverable-run queries. The older
 * runtime-safety expressions above have a separate compatibility surface and
 * must not be changed as part of this bounded listing fix.
 */
function pgRecoverableRunTimestampMillis(value: SQL): SQL {
  return sql`
    CASE
      WHEN ${value} IS NULL THEN NULL
      WHEN pg_input_is_valid(${value}, 'double precision') THEN
        CASE
          WHEN (${value})::double precision BETWEEN
            -1.7976931348623157e+308::double precision AND
            1.7976931348623157e+308::double precision
            THEN (${value})::double precision
          ELSE NULL
        END
      WHEN pg_input_is_valid(${value}, 'timestamptz') THEN
        FLOOR(EXTRACT(EPOCH FROM (${value})::timestamptz) * 1000)
      ELSE NULL
    END
  `;
}

/**
 * Safety ordering is based on the lifecycle effect, not immutable creation.
 * A restore can sit in waiting_approval while newer applies finish, then become
 * queued; while destructive work is in flight it must dominate every terminal
 * candidate regardless of when its Run row was created.
 */
function pgRunRuntimeSafetyInFlightOrder(): SQL {
  return sql`
    CASE
      WHEN ${pgSchema.runs.kind} = 'destroy_apply'
        AND ${pgSchema.runs.status} IN ('queued', 'running') THEN 1
      WHEN ${pgSchema.runs.kind} = 'restore'
        AND ${pgSchema.runs.status} IN ('queued', 'running') THEN 1
      ELSE 0
    END
  `;
}

/** Mirrors runtimeSafetyCandidateEffectTimestamp in store.ts. */
function pgRunRuntimeSafetyEffectAtMillisOrder(): SQL {
  return sql`
    CASE
      WHEN ${pgSchema.runs.kind} IN ('apply', 'destroy_apply') THEN COALESCE(
        NULLIF(${pgSchema.runs.runJson} ->> 'finishedAt', '')::double precision,
        NULLIF(${pgSchema.runs.runJson} ->> 'updatedAt', '')::double precision,
        ${pgSchema.runs.heartbeatAt}::double precision,
        NULLIF(${pgSchema.runs.runJson} ->> 'startedAt', '')::double precision,
        ${pgRunCreatedAtMillisOrder()}
      )
      WHEN ${pgSchema.runs.kind} = 'restore' THEN COALESCE(
        EXTRACT(
          EPOCH FROM NULLIF(${pgSchema.runs.runJson} ->> 'finishedAt', '')::timestamptz
        ) * 1000,
        ${pgSchema.runs.heartbeatAt}::double precision,
        EXTRACT(
          EPOCH FROM NULLIF(${pgSchema.runs.runJson} ->> 'startedAt', '')::timestamptz
        ) * 1000,
        ${pgRunCreatedAtMillisOrder()}
      )
      ELSE ${pgRunCreatedAtMillisOrder()}
    END
  `;
}

/** Mirrors runtimeSafetyCandidateRiskRank in store.ts. */
function pgRunRuntimeSafetyRiskOrder(): SQL {
  return sql`
    CASE
      WHEN ${pgSchema.runs.kind} = 'destroy_apply'
        AND ${pgSchema.runs.status} = 'succeeded' THEN 3
      WHEN ${pgSchema.runs.kind} = 'destroy_apply'
        AND ${pgSchema.runs.status} IN ('queued', 'running') THEN 2
      WHEN ${pgSchema.runs.status} IN ('failed', 'expired') THEN 1
      WHEN ${pgSchema.runs.kind} = 'restore'
        AND ${pgSchema.runs.status} IN ('queued', 'running') THEN 1
      ELSE 0
    END
  `;
}

function pgRuntimeSafetyCandidateWhere(capsuleId: string): SQL | undefined {
  return and(
    eq(pgSchema.runs.capsuleId, capsuleId),
    or(
      and(
        eq(pgSchema.runs.kind, "apply"),
        or(
          eq(pgSchema.runs.status, "succeeded"),
          and(eq(pgSchema.runs.status, "failed"), pgRunMutationDispatched()),
          and(eq(pgSchema.runs.status, "expired"), pgRunStarted()),
        ),
      ),
      and(
        eq(pgSchema.runs.kind, "destroy_apply"),
        or(
          inArray(pgSchema.runs.status, ["queued", "running", "succeeded"]),
          and(eq(pgSchema.runs.status, "failed"), pgRunMutationDispatched()),
          and(eq(pgSchema.runs.status, "expired"), pgRunStarted()),
        ),
      ),
      and(
        eq(pgSchema.runs.kind, RUN_KIND_RESTORE),
        inArray(pgSchema.runs.status, [
          "queued",
          "running",
          "succeeded",
          "failed",
          "expired",
        ]),
      ),
    ),
  );
}

/** Atomic CAS fence mirroring capsuleRuntimeSafetyFromRun. */
function pgCapsuleRuntimeSafetySafeOrAbsent(capsuleId: string): SQL {
  return sql`COALESCE((
    SELECT CASE
      WHEN ${pgSchema.runs.kind} IN ('apply', 'restore')
        AND ${pgSchema.runs.status} = 'succeeded' THEN TRUE
      ELSE FALSE
    END
    FROM ${pgSchema.runs}
    WHERE ${pgRuntimeSafetyCandidateWhere(capsuleId)}
    ORDER BY
      ${pgRunRuntimeSafetyInFlightOrder()} DESC,
      ${pgRunRuntimeSafetyEffectAtMillisOrder()} DESC,
      ${pgRunRuntimeSafetyRiskOrder()} DESC,
      ${pgSchema.runs.id} DESC
    LIMIT 1
  ), TRUE)`;
}

/**
 * PostgreSQL keeps the raw Run JSON alongside the public proof material. The
 * authority key is private persistence metadata and must not participate in
 * recovery proof digests, but the same raw snapshot still fences the eventual
 * capsule UPDATE against a concurrent Run change.
 */
type PgCommittedPostApplyRecoveryRows = CommittedPostApplyRecoveryRows & {
  readonly failedApplyRunStored: StoredRunRecord;
};

async function pgCommittedPostApplyRecoveryRows(
  db: PgRemoteDatabase<typeof pgSchema>,
  failedApplyRun: ApplyRun,
  proof: InstallConfigCommittedPostApplyRecoveryProof,
): Promise<PgCommittedPostApplyRecoveryRows | undefined> {
  const failedApplyRunStored = structuredClone(
    failedApplyRun as StoredRunRecord,
  );
  const [stateRows, outputRows] = await Promise.all([
    db
      .select({ json: pgSchema.stateVersions.snapshotJson })
      .from(pgSchema.stateVersions)
      .where(eq(pgSchema.stateVersions.id, proof.stateVersionId))
      .limit(1),
    db
      .select({ json: pgSchema.outputs.snapshotJson })
      .from(pgSchema.outputs)
      .where(eq(pgSchema.outputs.id, proof.outputId))
      .limit(1),
  ]);
  const stateVersion = parseRow(stateRows[0]) as StateVersion | undefined;
  const output = parseRow(outputRows[0]) as Output | undefined;
  return stateVersion && output
    ? {
        // Proof material is derived from the public Run projection; the
        // private authority metadata remains available only to the SQL fence.
        failedApplyRun: publicStoredRun(failedApplyRunStored) as ApplyRun,
        failedApplyRunStored,
        stateVersion,
        output,
      }
    : undefined;
}

/**
 * Same-statement recovery fence: latest decisive candidate plus the complete
 * Run/StateVersion/Output JSON rows used to derive the value-free receipt.
 */
function pgCapsuleCommittedPostApplyRecoveryFence(
  db: PgRemoteDatabase<typeof pgSchema>,
  capsuleId: string,
  rows: PgCommittedPostApplyRecoveryRows,
): SQL {
  const failedRunFence = db
    .select({ id: pgSchema.runs.id })
    .from(pgSchema.runs)
    .where(
      and(
        eq(pgSchema.runs.id, rows.failedApplyRun.id),
        // Compare the complete raw stored JSON, including private authority
        // metadata. Only the public projection is fed into proof digests.
        eq(pgSchema.runs.runJson, rows.failedApplyRunStored),
      ),
    );
  const stateVersionFence = db
    .select({ id: pgSchema.stateVersions.id })
    .from(pgSchema.stateVersions)
    .where(
      and(
        eq(pgSchema.stateVersions.id, rows.stateVersion.id),
        eq(pgSchema.stateVersions.snapshotJson, rows.stateVersion),
      ),
    );
  const outputFence = db
    .select({ id: pgSchema.outputs.id })
    .from(pgSchema.outputs)
    .where(
      and(
        eq(pgSchema.outputs.id, rows.output.id),
        eq(pgSchema.outputs.snapshotJson, rows.output),
      ),
    );
  return and(
    sql`(
      SELECT ${pgSchema.runs.id}
      FROM ${pgSchema.runs}
      WHERE ${pgRuntimeSafetyCandidateWhere(capsuleId)}
      ORDER BY
        ${pgRunRuntimeSafetyInFlightOrder()} DESC,
        ${pgRunRuntimeSafetyEffectAtMillisOrder()} DESC,
        ${pgRunRuntimeSafetyRiskOrder()} DESC,
        ${pgSchema.runs.id} DESC
      LIMIT 1
    ) = ${rows.failedApplyRun.id}`,
    exists(failedRunFence),
    exists(stateVersionFence),
    exists(outputFence),
  )!;
}

/** PostgreSQL counterpart of the ordered D1 authority snapshot statement. */
const PG_CAPSULE_EXECUTION_AUTHORITY_BATCH_SQL = `
with ordered_capsule_authority_requests as (
  select
    (request.ordinality - 1)::integer as request_index,
    request.value ->> 'workspaceId' as workspace_id,
    request.value ->> 'capsuleId' as capsule_id
  from jsonb_array_elements($1::jsonb) with ordinality
    as request(value, ordinality)
),
requested_capsule_ids as (
  select distinct capsule_id
  from ordered_capsule_authority_requests
),
latest_capsule_runtime_safety as (
  select
    request.capsule_id,
    candidate.run_json as safety_json
  from requested_capsule_ids as request
  left join lateral (
    select candidate.run_json
    from takosumi_runs as candidate
    where candidate.installation_id = request.capsule_id
      and (
        (
          candidate.kind = 'apply'
          and (
            candidate.status = 'succeeded'
            or (
              candidate.status = 'failed'
              and exists (
                select 1
                from jsonb_array_elements(
                  coalesce(candidate.run_json -> 'auditEvents', '[]'::jsonb)
                ) as audit_event
                where audit_event -> 'data' ->> 'lifecycleActionDispatched' = 'true'
                   or (
                     audit_event -> 'data' ->> 'providerDispatched' = 'true'
                     and not exists (
                       select 1
                       from jsonb_array_elements(
                         coalesce(candidate.run_json -> 'diagnostics', '[]'::jsonb)
                       ) as diagnostic
                       where diagnostic ->> 'severity' = 'error'
                         and diagnostic ->> 'code' in (${PG_PRE_PROVIDER_FAILURE_CODE_SQL})
                     )
                   )
              )
            )
            or (
              candidate.status = 'expired'
              and nullif(candidate.run_json ->> 'startedAt', '') is not null
            )
          )
        )
        or (
          candidate.kind = 'destroy_apply'
          and (
            candidate.status in ('queued', 'running', 'succeeded')
            or (
              candidate.status = 'failed'
              and exists (
                select 1
                from jsonb_array_elements(
                  coalesce(candidate.run_json -> 'auditEvents', '[]'::jsonb)
                ) as audit_event
                where audit_event -> 'data' ->> 'lifecycleActionDispatched' = 'true'
                   or (
                     audit_event -> 'data' ->> 'providerDispatched' = 'true'
                     and not exists (
                       select 1
                       from jsonb_array_elements(
                         coalesce(candidate.run_json -> 'diagnostics', '[]'::jsonb)
                       ) as diagnostic
                       where diagnostic ->> 'severity' = 'error'
                         and diagnostic ->> 'code' in (${PG_PRE_PROVIDER_FAILURE_CODE_SQL})
                     )
                   )
              )
            )
            or (
              candidate.status = 'expired'
              and nullif(candidate.run_json ->> 'startedAt', '') is not null
            )
          )
        )
        or (
          candidate.kind = 'restore'
          and candidate.status in (
            'queued', 'running', 'succeeded', 'failed', 'expired'
          )
        )
      )
    order by
      case
        when candidate.kind = 'destroy_apply'
          and candidate.status in ('queued', 'running') then 1
        when candidate.kind = 'restore'
          and candidate.status in ('queued', 'running') then 1
        else 0
      end desc,
      case
        when candidate.kind in ('apply', 'destroy_apply') then coalesce(
          nullif(candidate.run_json ->> 'finishedAt', '')::double precision,
          nullif(candidate.run_json ->> 'updatedAt', '')::double precision,
          candidate.heartbeat_at::double precision,
          nullif(candidate.run_json ->> 'startedAt', '')::double precision,
          case
            when candidate.created_at ~ '^[0-9]+$'
              then candidate.created_at::double precision
            else extract(epoch from candidate.created_at::timestamptz) * 1000
          end
        )
        when candidate.kind = 'restore' then coalesce(
          extract(
            epoch from nullif(
              candidate.run_json ->> 'finishedAt',
              ''
            )::timestamptz
          ) * 1000,
          candidate.heartbeat_at::double precision,
          extract(
            epoch from nullif(
              candidate.run_json ->> 'startedAt',
              ''
            )::timestamptz
          ) * 1000,
          case
            when candidate.created_at ~ '^[0-9]+$'
              then candidate.created_at::double precision
            else extract(epoch from candidate.created_at::timestamptz) * 1000
          end
        )
        else case
          when candidate.created_at ~ '^[0-9]+$'
            then candidate.created_at::double precision
          else extract(epoch from candidate.created_at::timestamptz) * 1000
        end
      end desc,
      case
        when candidate.kind = 'destroy_apply'
          and candidate.status = 'succeeded' then 3
        when candidate.kind = 'destroy_apply'
          and candidate.status in ('queued', 'running') then 2
        when candidate.status in ('failed', 'expired') then 1
        when candidate.kind = 'restore'
          and candidate.status in ('queued', 'running') then 1
        else 0
      end desc,
      candidate.id desc
    limit 1
  ) as candidate on true
)
select
  request.request_index,
  capsule.execution_authority_epoch as epoch,
  safety.safety_json
from ordered_capsule_authority_requests as request
left join takosumi_capsules as capsule
  on capsule.space_id = request.workspace_id
 and capsule.id = request.capsule_id
 and capsule.status <> 'destroyed'
left join latest_capsule_runtime_safety as safety
  on safety.capsule_id = request.capsule_id
order by request.request_index
`;

/** Mirrors applyRunMutationDispatched in the shared store model. */
function pgRunMutationDispatched(): SQL {
  const preProviderFailureCodes = sql.join(
    PRE_PROVIDER_RUNNER_FAILURE_DIAGNOSTIC_CODES.map((code) => sql`${code}`),
    sql`, `,
  );
  return sql`
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        COALESCE(${pgSchema.runs.runJson} -> 'auditEvents', '[]'::jsonb)
      ) AS audit_event
      WHERE audit_event -> 'data' ->> 'lifecycleActionDispatched' = 'true'
    )
    OR (
      EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          COALESCE(${pgSchema.runs.runJson} -> 'auditEvents', '[]'::jsonb)
        ) AS audit_event
        WHERE audit_event -> 'data' ->> 'providerDispatched' = 'true'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          COALESCE(${pgSchema.runs.runJson} -> 'diagnostics', '[]'::jsonb)
        ) AS diagnostic
        WHERE diagnostic ->> 'severity' = 'error'
          AND diagnostic ->> 'code' IN (${preProviderFailureCodes})
      )
    )
  `;
}

/** Mirrors applyRunBillingCapturePending in the shared store model. */
function pgRunBillingCapturePending(): SQL {
  return sql`
    (
      SELECT COALESCE(
        MAX(audit_event.ordinality) FILTER (
          WHERE audit_event.value ->> 'type' = 'billing.capture.pending'
        ),
        0
      )
      FROM jsonb_array_elements(
        COALESCE(${pgSchema.runs.runJson} -> 'auditEvents', '[]'::jsonb)
      ) WITH ORDINALITY AS audit_event(value, ordinality)
    ) > (
      SELECT COALESCE(
        MAX(audit_event.ordinality) FILTER (
          WHERE audit_event.value ->> 'type' = 'billing.capture.completed'
        ),
        0
      )
      FROM jsonb_array_elements(
        COALESCE(${pgSchema.runs.runJson} -> 'auditEvents', '[]'::jsonb)
      ) WITH ORDINALITY AS audit_event(value, ordinality)
    )
  `;
}

/** Mirrors applyRunRuntimeSecretRetirementPending in the shared store model. */
function pgRunRuntimeSecretRetirementPending(): SQL {
  return sql`
    (
      SELECT COALESCE(
        MAX(audit_event.ordinality) FILTER (
          WHERE audit_event.value ->> 'type' = 'runtime_secret.retirement.pending'
        ),
        0
      )
      FROM jsonb_array_elements(
        COALESCE(${pgSchema.runs.runJson} -> 'auditEvents', '[]'::jsonb)
      ) WITH ORDINALITY AS audit_event(value, ordinality)
    ) > (
      SELECT COALESCE(
        MAX(audit_event.ordinality) FILTER (
          WHERE audit_event.value ->> 'type' = 'runtime_secret.retirement.completed'
        ),
        0
      )
      FROM jsonb_array_elements(
        COALESCE(${pgSchema.runs.runJson} -> 'auditEvents', '[]'::jsonb)
      ) WITH ORDINALITY AS audit_event(value, ordinality)
    )
  `;
}

function pgCapsuleInstallConfigRebindBlocked(
  capsuleId: string,
  executionAuthorityEpoch: number,
): SQL {
  return and(
    eq(pgSchema.runs.capsuleId, capsuleId),
    or(
      and(
        inArray(pgSchema.runs.kind, [...RUN_KINDS_APPLY]),
        inArray(pgSchema.runs.status, ["queued", "running"]),
      ),
      and(
        inArray(pgSchema.runs.kind, [...RUN_KINDS_PLAN]),
        inArray(pgSchema.runs.status, ["queued", "running"]),
        sql`COALESCE(${pgSchema.runs.runJson} ->> 'appliedApplyRunId', '') = ''`,
        sql`COALESCE(
          NULLIF(${pgSchema.runs.runJson} ->> 'capsuleExecutionAuthorityEpoch', '')::integer,
          ${executionAuthorityEpoch}
        ) = ${executionAuthorityEpoch}`,
      ),
    ),
  )!;
}

/** An expired apply/destroy is uncertain only after it started. */
function pgRunStarted(): SQL {
  return sql`NULLIF(${pgSchema.runs.runJson} ->> 'startedAt', '') IS NOT NULL`;
}

/**
 * Builds the keyset WHERE predicate `(createdAt, id) > (cursor)` over the given
 * `(createdAtCol, idCol)` sort columns: a row qualifies when its createdAt is
 * strictly after the cursor, or equal-createdAt with a strictly-greater id. When
 * there is no cursor (first page) the existing filter is returned unchanged.
 */
function pgKeysetWhere(
  filter: SQL | undefined,
  createdAtCol: PgColumn,
  idCol: PgColumn,
  cursor: { readonly createdAt: string; readonly id: string } | undefined,
): SQL | undefined {
  if (cursor === undefined) return filter;
  const keyset = or(
    gt(createdAtCol, cursor.createdAt),
    and(eq(createdAtCol, cursor.createdAt), gt(idCol, cursor.id)),
  );
  return filter === undefined ? keyset : and(filter, keyset);
}

/**
 * Descending counterpart of {@link pgKeysetWhere} for a newest-first list
 * (`ORDER BY createdAt DESC, id DESC`, e.g. control backups): a row qualifies
 * when its keyset is strictly BEFORE the cursor position.
 */
function pgKeysetWhereDesc(
  filter: SQL | undefined,
  createdAtCol: PgColumn,
  idCol: PgColumn,
  cursor: { readonly createdAt: string; readonly id: string } | undefined,
): SQL | undefined {
  if (cursor === undefined) return filter;
  const keyset = or(
    lt(createdAtCol, cursor.createdAt),
    and(eq(createdAtCol, cursor.createdAt), lt(idCol, cursor.id)),
  );
  return filter === undefined ? keyset : and(filter, keyset);
}

/** Dashboard order is updated_at DESC with id ASC (the established UI order). */
function pgWorkspaceUpdatedDescKeysetWhere(
  filter: SQL | undefined,
  cursor: { readonly createdAt: string; readonly id: string } | undefined,
): SQL | undefined {
  if (cursor === undefined) return filter;
  const keyset = or(
    lt(pgSchema.workspaces.updatedAt, cursor.createdAt),
    and(
      eq(pgSchema.workspaces.updatedAt, cursor.createdAt),
      gt(pgSchema.workspaces.id, cursor.id),
    ),
  );
  return filter === undefined ? keyset : and(filter, keyset);
}

export class SqlOpenTofuControlStore implements OpenTofuControlStore {
  readonly persistence = "durable" as const;
  readonly #client: SqlClient;
  readonly #db: PgRemoteDatabase<typeof pgSchema>;

  constructor(input: { readonly client: SqlClient }) {
    this.#client = input.client;
    this.#db = drizzle(
      async (query, params, method) => {
        const result = await this.#client.query(query, params);
        if (method !== "all") return { rows: [...result.rows] };
        const columns = selectedDriverColumns(query);
        return {
          rows: result.rows.map((row) =>
            columns.map((column) => (row as Record<string, unknown>)[column]),
          ),
        };
      },
      { schema: pgSchema },
    );
  }

  async putRunnerProfile(profile: RunnerProfile): Promise<RunnerProfile> {
    await this.#pgUpsert(pgSchema.runnerProfiles, {
      id: profile.id,
      profileJson: profile,
      createdAt: profile.createdAt,
    });
    return profile;
  }

  async getRunnerProfile(id: string): Promise<RunnerProfile | undefined> {
    return await this.#pgFirstJson<RunnerProfile>(
      pgSchema.runnerProfiles,
      pgSchema.runnerProfiles.profileJson,
      eq(pgSchema.runnerProfiles.id, id),
    );
  }

  async listRunnerProfiles(): Promise<readonly RunnerProfile[]> {
    return await this.#pgManyJson<RunnerProfile>(
      pgSchema.runnerProfiles,
      pgSchema.runnerProfiles.profileJson,
      { orderBy: [asc(pgSchema.runnerProfiles.id)] },
    );
  }

  // --- runs (single §27 table; rows discriminated by kind) -----------------

  async putPlanRun(run: PlanRun): Promise<PlanRun> {
    await this.#putRunDrizzle(
      run.driftCheck === true
        ? "drift_check"
        : run.operation === "destroy"
          ? "destroy_plan"
          : "plan",
      {
        id: run.id,
        workspaceId: run.workspaceId,
        capsuleId: run.capsuleId ?? null,
        createdAt: run.createdAt,
        json: run,
      },
    );
    return publicStoredRun(run);
  }

  async preparePlanRun(
    input: PreparePlanRunInput,
  ): Promise<PreparePlanRunResult> {
    input = structuredClone(input);
    assertPlanRunPreparation(input);
    if (input.expectedWorkspaceManagementAuthority !== undefined) {
      assertWorkspaceManagementAuthorityInput(
        input.expectedWorkspaceManagementAuthority,
        input.run.workspaceId,
      );
    }
    return await this.#client.transaction(async (transaction) => {
      const db = this.#drizzleForClient(transaction);
      const run = input.run;
      // An existing exact row is an idempotent replay and deliberately does
      // not revalidate mutable current authority. A new row must lock and
      // validate the Workspace first, before any dependent Capsule lock or
      // Run/sidecar write, so a draining race cannot leave a stale Plan.
      const existingRun = await db
        .select({ id: pgSchema.runs.id })
        .from(pgSchema.runs)
        .where(eq(pgSchema.runs.id, run.id))
        .limit(1);
      let storedRun: StoredRunRecord = publicStoredRun(run);
      if (existingRun.length === 0) {
        const management = await pgWorkspaceManagementForTransaction(
          transaction,
          run.workspaceId,
        );
        if (input.expectedWorkspaceManagementAuthority === undefined) {
          throw new WorkspaceManagementAdmissionConflictError(run.workspaceId);
        }
        const expectedWorkspaceManagementAuthority =
          input.expectedWorkspaceManagementAuthority;
        assertWorkspaceManagementAdmission(
          management,
          run.workspaceId,
          expectedWorkspaceManagementAuthority,
        );
        storedRun = storeRunManagementAuthority(
          run,
          expectedWorkspaceManagementAuthority,
        );
        if (input.expectedCapsulePlanAuthority !== undefined && run.capsuleId) {
          const rows = await transaction.query<{
            installConfigId: string | null;
            currentStateVersionId: string | null;
            executionAuthorityEpoch: number | string | null;
            capsuleJson: unknown;
          }>(
            `select
               install_config_id as "installConfigId",
               current_state_version_id as "currentStateVersionId",
               execution_authority_epoch as "executionAuthorityEpoch",
               installation_json as "capsuleJson"
             from takosumi_capsules
             where id = $1
             for update`,
            [run.capsuleId],
          );
          const row = rows.rows[0];
          const persistedCapsule = row
            ? normalizeOptionalCapsuleRecord(
                parseJson(row.capsuleJson) as Capsule,
              )
            : undefined;
          const capsule = persistedCapsule
            ? {
                ...persistedCapsule,
                ...(row?.installConfigId
                  ? { installConfigId: row.installConfigId }
                  : {}),
                currentStateVersionId:
                  row?.currentStateVersionId ?? undefined,
              }
            : undefined;
          assertCapsulePlanCreationFence(
            capsule,
            row?.executionAuthorityEpoch === null ||
                row?.executionAuthorityEpoch === undefined
              ? undefined
              : Number(row.executionAuthorityEpoch),
            input.expectedCapsulePlanAuthority,
          );
        }
      }
      const inserted = await db
        .insert(pgSchema.runs)
        .values({
          id: run.id,
          kind: run.driftCheck === true
            ? "drift_check"
            : run.operation === "destroy"
              ? "destroy_plan"
              : "plan",
          workspaceId: run.workspaceId,
          sourceId: null,
          capsuleId: run.capsuleId ?? null,
          status: run.status,
          leaseToken: null,
          heartbeatAt: run.heartbeatAt ?? null,
          createdAt: String(run.createdAt),
          runJson: storedRun,
        })
        .onConflictDoNothing({ target: pgSchema.runs.id })
        .returning({ json: pgSchema.runs.runJson });
      if (inserted.length === 0) {
        const currentRunRows = await db
          .select({ json: pgSchema.runs.runJson })
          .from(pgSchema.runs)
          .where(eq(pgSchema.runs.id, run.id))
          .limit(1);
        const currentInputRows = await db
          .select({ json: pgSchema.planRunInputs.inputsJson })
          .from(pgSchema.planRunInputs)
          .where(eq(pgSchema.planRunInputs.planRunId, run.id))
          .limit(1);
        const parsedCurrentRun = parseRow(currentRunRows[0]) as
          | StoredRunRecord
          | undefined;
        const currentRun = coerceRunRowStatus(
          parsedCurrentRun && isPlanRunRecord(parsedCurrentRun)
            ? parsedCurrentRun
            : undefined,
        );
        const currentSnapshotRows = currentRun?.dependencySnapshotId
          ? await db
            .select({ json: pgSchema.dependencySnapshots.snapshotJson })
            .from(pgSchema.dependencySnapshots)
            .where(
              eq(
                pgSchema.dependencySnapshots.id,
                currentRun.dependencySnapshotId,
              ),
            )
            .limit(1)
          : [];
        const currentInputs = parseRow(currentInputRows[0]) as
          | PlanRunInputs
          | undefined;
        const currentSnapshot = parseRow(currentSnapshotRows[0]) as
          | DependencySnapshot
          | undefined;
        if (
          planRunPreparationExactlyMatches(
            currentRun,
            currentInputs,
            currentSnapshot,
            input,
          )
        ) {
          return {
            status: "existing" as const,
            run: publicStoredRun(currentRun),
          };
        }
        throw new PlanRunPreparationConflictError(run.id);
      }
      if (input.dependencySnapshot) {
        await db.insert(pgSchema.dependencySnapshots).values({
          id: input.dependencySnapshot.id,
          runId: input.dependencySnapshot.runId,
          snapshotJson: input.dependencySnapshot,
          createdAt: input.dependencySnapshot.createdAt,
        });
      }
      if (planRunPreparationPersistsInputs(run)) {
        await db.insert(pgSchema.planRunInputs).values({
          planRunId: input.inputs.planRunId,
          inputsJson: input.inputs,
        });
      }
      return { status: "created" as const, run: publicStoredRun(run) };
    });
  }

  async getPlanRun(id: string): Promise<PlanRun | undefined> {
    const run = await this.#getRun<StoredRunRecord>(id, [
      ...RUN_KINDS_PLAN,
      "drift_check",
    ]);
    return coerceRunRowStatus(
      run && isPlanRunRecord(run) ? publicStoredRun(run) : undefined,
    );
  }

  async getRunManagementAuthority(
    input: RunManagementAuthorityInput,
  ): Promise<WorkspaceManagementAuthority | undefined> {
    input = structuredClone(input);
    const kinds = input.kind === "plan"
      ? [...RUN_KINDS_PLAN, "drift_check"]
      : input.kind === "apply"
        ? [...RUN_KINDS_APPLY]
        : input.kind === "source_sync"
          ? [RUN_KIND_SOURCE_SYNC]
          : [RUN_KIND_RESTORE];
    const rows = await this.#db
      .select({
        id: pgSchema.runs.id,
        workspaceId: pgSchema.runs.workspaceId,
        kind: pgSchema.runs.kind,
        json: pgSchema.runs.runJson,
      })
      .from(pgSchema.runs)
      .where(
        and(
          eq(pgSchema.runs.id, input.id),
          eq(pgSchema.runs.workspaceId, input.workspaceId),
          inArray(pgSchema.runs.kind, kinds),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (row === undefined) return undefined;
    let value: unknown;
    try {
      value = parseJson(row.json);
    } catch {
      return undefined;
    }
    if (value === null || typeof value !== "object") return undefined;
    return runManagementAuthorityForIdentity(
      value as StoredRunRecord,
      input,
    );
  }

  async putApplyRun(run: ApplyRun): Promise<ApplyRun> {
    await this.#putRunDrizzle(
      run.operation === "destroy" ? "destroy_apply" : "apply",
      {
        id: run.id,
        workspaceId: run.workspaceId,
        capsuleId: run.capsuleId ?? null,
        createdAt: run.createdAt,
        json: run,
      },
    );
    return publicStoredRun(run);
  }

  async beginApplyRun(
    run: ApplyRun,
    expectedWorkspaceManagementAuthority?: WorkspaceManagementAuthority,
  ): Promise<BeginApplyRunResult> {
    ({ run, expectedWorkspaceManagementAuthority } = structuredClone({
      run,
      expectedWorkspaceManagementAuthority,
    }));
    if (expectedWorkspaceManagementAuthority !== undefined) {
      assertWorkspaceManagementAuthorityInput(
        expectedWorkspaceManagementAuthority,
        run.workspaceId,
      );
    }
    return await this.#client.transaction(async (transaction) => {
      const db = this.#drizzleForClient(transaction);
      const existingRows = await db
        .select({
          kind: pgSchema.runs.kind,
          workspaceId: pgSchema.runs.workspaceId,
          json: pgSchema.runs.runJson,
        })
        .from(pgSchema.runs)
        .where(eq(pgSchema.runs.id, run.id))
        .limit(1);
      const existing = parseRow(existingRows[0]) as
        | StoredRunRecord
        | undefined;
      if (existing) {
        return isApplyRunRecord(existing)
          ? {
              status: "existing" as const,
              run: coerceRunRowStatus(publicStoredRun(existing))!,
            }
          : { status: "conflict" as const };
      }

      // Workspace is the outer lock in this transaction. The active state is
      // always required for a new Apply row; an expected authority additionally
      // pins the exact management epoch captured by the caller.
      const management = await pgWorkspaceManagementForTransaction(
        transaction,
        run.workspaceId,
      );
      if (expectedWorkspaceManagementAuthority === undefined) {
        throw new WorkspaceManagementAdmissionConflictError(run.workspaceId);
      }
      assertWorkspaceManagementAdmission(
        management,
        run.workspaceId,
        expectedWorkspaceManagementAuthority,
      );

      const inserted = await db
        .insert(pgSchema.runs)
        .values({
          id: run.id,
          kind: run.operation === "destroy" ? "destroy_apply" : "apply",
          workspaceId: run.workspaceId,
          sourceId: null,
          capsuleId: run.capsuleId ?? null,
          status: run.status,
          leaseToken: null,
          heartbeatAt: run.heartbeatAt ?? null,
          createdAt: String(run.createdAt),
          runJson: storeRunManagementAuthority(
            run,
            expectedWorkspaceManagementAuthority,
          ),
        })
        .onConflictDoNothing({ target: pgSchema.runs.id })
        .returning({ json: pgSchema.runs.runJson });
      if (inserted[0]) {
        return { status: "created" as const, run: publicStoredRun(run) };
      }
      const currentRows = await db
        .select({
          kind: pgSchema.runs.kind,
          workspaceId: pgSchema.runs.workspaceId,
          json: pgSchema.runs.runJson,
        })
        .from(pgSchema.runs)
        .where(eq(pgSchema.runs.id, run.id))
        .limit(1);
      const current = parseRow(currentRows[0]) as
        | StoredRunRecord
        | undefined;
      return current && isApplyRunRecord(current)
        ? {
            status: "existing" as const,
            run: coerceRunRowStatus(publicStoredRun(current))!,
          }
        : { status: "conflict" as const };
    });
  }

  async getApplyRun(id: string): Promise<ApplyRun | undefined> {
    const run = await this.#getRun<StoredRunRecord>(id, RUN_KINDS_APPLY);
    return coerceRunRowStatus(
      run && isApplyRunRecord(run) ? publicStoredRun(run) : undefined,
    );
  }

  /**
   * Status-conditional, lease-fenced compare-and-set transition (the queue
   * consumer's correctness-critical claim primitive). Mirrors the CAS shape of
   * the revoke-debt `#updateMutable`: a guarded drizzle UPDATE that only matches
   * the row when its `status` is still in `expectFrom` (and, when set, its
   * `leaseToken` still equals `expectLeaseToken`, and when set the persisted
   * `startedAt` equals `expectStartedAt`). On a win the row's status / run JSON
   * advance to `input.run`; `setLeaseToken` / `clearLeaseToken` /
   * `clearHeartbeat` / `heartbeatAt` write the lease and heartbeat columns. A
   * lost race (0 rows) re-reads the current row and returns it with `won: false`.
   */
  async transitionRun(input: TransitionRunInput): Promise<TransitionRunResult> {
    input = structuredClone(input);
    assertExactRunTransitionInput(input);
    assertDrainRunCancellationInput(input);
    if (input.expectedWorkspaceManagementAuthority !== undefined) {
      // Validate the caller's captured authority before any database work.
      // A valid but stale/mis-bound expectation is a normal CAS loss below;
      // malformed input is a programming error and throws TypeError.
      assertWorkspaceManagementAuthorityInput(
        input.expectedWorkspaceManagementAuthority,
        input.expectedWorkspaceManagementAuthority.workspaceId,
      );
    }
    const candidate = input.run as StoredRunRecord;
    const candidateKindMatches =
      input.kind === "plan"
        ? isPlanRunRecord(candidate)
        : input.kind === "apply"
          ? isApplyRunRecord(candidate)
          : input.kind === "source_sync"
            ? isSourceSyncRunRecord(candidate)
            : "type" in candidate && candidate.type === RUN_KIND_RESTORE;
    if (!candidateKindMatches || input.run.id !== input.id) {
      const currentRun =
        input.kind === "plan"
          ? await this.getPlanRun(input.id)
          : input.kind === "apply"
            ? await this.getApplyRun(input.id)
            : input.kind === "source_sync"
              ? await this.getSourceSyncRun(input.id)
              : await this.getBackupRun(input.id);
      return { won: false, ...(currentRun ? { run: currentRun } : {}) };
    }
    const kinds =
      input.kind === "plan"
        ? [...RUN_KINDS_PLAN, "drift_check"]
        : input.kind === "apply"
          ? [...RUN_KINDS_APPLY]
          : input.kind === "source_sync"
            ? [RUN_KIND_SOURCE_SYNC]
            : [RUN_KIND_RESTORE];
    const drainCancellation = input.expectDrainCancellation;
    const heartbeatAt = input.heartbeatAt ?? input.run.heartbeatAt;
    const persisted: PlanRun | ApplyRun | SourceSyncRun | Run =
      input.clearHeartbeat
        ? stripRunHeartbeat(input.run)
        : heartbeatAt === undefined
          ? input.run
          : ({ ...input.run, heartbeatAt } as
              PlanRun | ApplyRun | SourceSyncRun | Run);
    const leaseSet: { leaseToken?: string | null } = input.clearLeaseToken
      ? { leaseToken: null }
      : input.setLeaseToken !== undefined
        ? { leaseToken: input.setLeaseToken }
        : {};
    const requireStoredManagementAuthority =
      input.requireStoredManagementAuthority === true;
    const update = async (
      db: PgRemoteDatabase<typeof pgSchema>,
      expectedWorkspaceId?: string,
      current?: StoredRunRecord,
    ): Promise<PlanRun | ApplyRun | SourceSyncRun | Run | undefined> => {
      let runForWrite: PlanRun | ApplyRun | SourceSyncRun | Run =
        publicStoredRun(persisted as StoredRunRecord);
      let currentRun = current;
      let storedAuthority: WorkspaceManagementAuthority | undefined;
      if (
        currentRun === undefined &&
        (input.kind === "source_sync" ||
          input.setLeaseToken !== undefined ||
          requireStoredManagementAuthority ||
          drainCancellation !== undefined)
      ) {
          const currentRows = await db
            .select({ json: pgSchema.runs.runJson })
            .from(pgSchema.runs)
            .where(
              and(
                eq(pgSchema.runs.id, input.id),
                inArray(pgSchema.runs.kind, kinds),
              ),
            )
            .limit(1);
          currentRun = parseRow(currentRows[0]) as
            | StoredRunRecord
            | undefined;
      }
      if (
        currentRun !== undefined &&
        !runStoredIdentityMatches(
          currentRun,
          input.run as StoredRunRecord,
        )
      ) {
        return undefined;
      }
      if (
        drainCancellation !== undefined &&
        (currentRun === undefined || !runDrainCancellationMatches(currentRun, input))
      ) {
        return undefined;
      }
      if (
        (input.setLeaseToken !== undefined || requireStoredManagementAuthority) &&
        (currentRun === undefined || !runRequiresStoredManagementAuthority(currentRun))
      ) {
        return undefined;
      }
      if (input.setLeaseToken !== undefined || requireStoredManagementAuthority) {
        storedAuthority = currentRun
          ? runManagementAuthority(currentRun)
          : undefined;
        if (storedAuthority === undefined) return undefined;
      }
      const expectedRunWorkspaceId = expectedWorkspaceId ?? input.run.workspaceId;
      const runIdentityFence = and(
        // The indexed Workspace owner and JSON identity must still describe
        // the candidate row. Mutable progress fields intentionally remain
        // unfenced so a same-lease heartbeat may race this write safely.
        eq(pgSchema.runs.workspaceId, expectedRunWorkspaceId),
        sql`${pgSchema.runs.runJson} ->> 'id' = ${input.id}`,
        sql`${pgSchema.runs.runJson} ->> 'workspaceId' = ${expectedRunWorkspaceId}`,
        input.kind === "source_sync"
          ? sql`${pgSchema.runs.runJson} ->> 'kind' = ${RUN_KIND_SOURCE_SYNC}`
          : input.kind === "restore"
            ? sql`${pgSchema.runs.runJson} ->> 'type' = ${RUN_KIND_RESTORE}`
            : sql`true`,
      );
      const runAuthorityFence = input.setLeaseToken === undefined &&
          !requireStoredManagementAuthority
        ? sql`true`
        : storedAuthority === undefined
          ? sql`false`
          : and(
              sql`${pgSchema.runs.runJson} -> 'workspaceManagementAuthority' ->> 'workspaceId' = ${storedAuthority.workspaceId}`,
              sql`${pgSchema.runs.runJson} -> 'workspaceManagementAuthority' ->> 'managementState' = ${storedAuthority.managementState}`,
              sql`${pgSchema.runs.runJson} -> 'workspaceManagementAuthority' ->> 'managementEpoch' = ${String(storedAuthority.managementEpoch)}`,
            );
      const drainWorkspaceFence = drainCancellation === undefined
        ? sql`true`
        : exists(
            db
              .select({ one: sql`1` })
              .from(pgSchema.workspaces)
              .where(
                and(
                  eq(
                    pgSchema.workspaces.id,
                    drainCancellation.management.workspaceId,
                  ),
                  eq(pgSchema.workspaces.managementState, "draining"),
                  eq(
                    pgSchema.workspaces.managementEpoch,
                    drainCancellation.management.managementEpoch,
                  ),
                ),
              ),
          );
      const drainOriginalAuthorityFence = drainCancellation === undefined
        ? sql`true`
        : sql`jsonb_typeof(${pgSchema.runs.runJson}) = 'object'
          AND jsonb_typeof(${pgSchema.runs.runJson} -> 'workspaceManagementAuthority') = 'object'
          AND jsonb_typeof(${pgSchema.runs.runJson} -> 'workspaceManagementAuthority' -> 'workspaceId') = 'string'
          AND btrim(${pgSchema.runs.runJson} -> 'workspaceManagementAuthority' ->> 'workspaceId') <> ''
          AND ${pgSchema.runs.runJson} -> 'workspaceManagementAuthority' ->> 'workspaceId' = ${pgSchema.runs.workspaceId}
          AND jsonb_typeof(${pgSchema.runs.runJson} -> 'workspaceManagementAuthority' -> 'managementState') = 'string'
          AND ${pgSchema.runs.runJson} -> 'workspaceManagementAuthority' ->> 'managementState' = 'active'
          AND jsonb_typeof(${pgSchema.runs.runJson} -> 'workspaceManagementAuthority' -> 'managementEpoch') = 'number'
          AND CASE
            WHEN ${pgSchema.runs.runJson} -> 'workspaceManagementAuthority' ->> 'managementEpoch' ~ '^(0|[1-9][0-9]*)$'
            THEN (${pgSchema.runs.runJson} -> 'workspaceManagementAuthority' ->> 'managementEpoch')::numeric > 0
              AND (${pgSchema.runs.runJson} -> 'workspaceManagementAuthority' ->> 'managementEpoch')::numeric <= 9007199254740991
              AND (${pgSchema.runs.runJson} -> 'workspaceManagementAuthority' ->> 'managementEpoch')::numeric < ${drainCancellation.management.managementEpoch}
            ELSE false
          END`;
      const drainExpectedRun = drainCancellation?.expectedRun;
      const drainExpectedKind = drainExpectedRun === undefined
        ? undefined
        : input.kind === "plan"
          ? (drainExpectedRun as PlanRun).driftCheck === true
            ? "drift_check"
            : (drainExpectedRun as PlanRun).operation === "destroy"
              ? "destroy_plan"
              : "plan"
          : (drainExpectedRun as ApplyRun).operation === "destroy"
            ? "destroy_apply"
            : "apply";
      const drainExpectedSnapshot = drainExpectedRun === undefined
        ? undefined
        : and(
            eq(
              pgSchema.runs.runJson,
              runJsonPreservingManagementAuthority(
                drainExpectedRun as StoredRunRecord,
              ),
            ),
            eq(pgSchema.runs.workspaceId, drainExpectedRun.workspaceId),
            eq(pgSchema.runs.status, drainExpectedRun.status),
            eq(pgSchema.runs.kind, drainExpectedKind!),
            drainExpectedRun.capsuleId === undefined
              ? isNull(pgSchema.runs.capsuleId)
              : eq(pgSchema.runs.capsuleId, drainExpectedRun.capsuleId),
            isNull(pgSchema.runs.leaseToken),
            drainExpectedRun.heartbeatAt === undefined
              ? isNull(pgSchema.runs.heartbeatAt)
              : eq(pgSchema.runs.heartbeatAt, drainExpectedRun.heartbeatAt),
          );
      // PostgreSQL JSONB considers 1.0 equal to 1.  Keep the freeze
      // predicate's canonical integer representation fence in this CAS so a
      // raw timestamp cannot be normalized by the cancellation writer and
      // silently clear a blocker.
      const drainTimestampFence = drainCancellation === undefined
        ? sql`true`
        : sql`CASE
          WHEN jsonb_typeof(${pgSchema.runs.runJson} -> 'createdAt') = 'number' THEN
            ${pgSchema.runs.runJson} ->> 'createdAt' ~ '^(0|[1-9][0-9]*)$'
            AND (${pgSchema.runs.runJson} ->> 'createdAt')::numeric <= 9007199254740991
          ELSE false
        END
        AND ${pgSchema.runs.runJson} ->> 'createdAt' = ${pgSchema.runs.createdAt}
        AND CASE
          WHEN jsonb_typeof(${pgSchema.runs.runJson} -> 'updatedAt') = 'number' THEN
            ${pgSchema.runs.runJson} ->> 'updatedAt' ~ '^(0|[1-9][0-9]*)$'
            AND (${pgSchema.runs.runJson} ->> 'updatedAt')::numeric <= 9007199254740991
          ELSE false
        END
        AND (
          NOT (${pgSchema.runs.runJson} ? 'startedAt')
          OR CASE
            WHEN jsonb_typeof(${pgSchema.runs.runJson} -> 'startedAt') = 'number' THEN
              ${pgSchema.runs.runJson} ->> 'startedAt' ~ '^(0|[1-9][0-9]*)$'
              AND (${pgSchema.runs.runJson} ->> 'startedAt')::numeric <= 9007199254740991
            ELSE false
          END
        )
        AND (
          NOT (${pgSchema.runs.runJson} ? 'finishedAt')
          OR CASE
            WHEN jsonb_typeof(${pgSchema.runs.runJson} -> 'finishedAt') = 'number' THEN
              ${pgSchema.runs.runJson} ->> 'finishedAt' ~ '^(0|[1-9][0-9]*)$'
              AND (${pgSchema.runs.runJson} ->> 'finishedAt')::numeric <= 9007199254740991
            ELSE false
          END
        )
        AND CASE
          WHEN ${pgSchema.runs.heartbeatAt} IS NULL THEN
            NOT (${pgSchema.runs.runJson} ? 'heartbeatAt')
          ELSE
            ${pgSchema.runs.heartbeatAt} BETWEEN 0 AND 9007199254740991
            AND jsonb_typeof(${pgSchema.runs.runJson} -> 'heartbeatAt') = 'number'
            AND ${pgSchema.runs.runJson} ->> 'heartbeatAt' ~ '^(0|[1-9][0-9]*)$'
            AND ${pgSchema.runs.runJson} -> 'heartbeatAt' = to_jsonb(${pgSchema.runs.heartbeatAt})
        END`;
      const rows = await db
        .update(pgSchema.runs)
        .set({
          status: runForWrite.status,
          runJson: runJsonPreservingManagementAuthority(
            runForWrite as StoredRunRecord,
          ),
          ...(input.clearHeartbeat
            ? { heartbeatAt: null }
            : heartbeatAt === undefined
              ? {}
              : { heartbeatAt }),
          ...leaseSet,
        })
        .where(
          and(
            eq(pgSchema.runs.id, input.id),
            runIdentityFence,
            runAuthorityFence,
            drainWorkspaceFence,
            drainOriginalAuthorityFence,
            drainExpectedSnapshot,
            drainTimestampFence,
            expectedWorkspaceId === undefined
              ? sql`true`
              : eq(pgSchema.runs.workspaceId, expectedWorkspaceId),
            inArray(pgSchema.runs.kind, kinds),
            inArray(pgSchema.runs.status, [...input.expectFrom]),
            input.expectExactRun === undefined
              ? undefined
              : and(
                  eq(
                    pgSchema.runs.runJson,
                    runJsonPreservingManagementAuthority(input.expectExactRun),
                  ),
                  eq(pgSchema.runs.status, input.expectExactRun.status),
                  eq(
                    pgSchema.runs.kind,
                    input.expectExactRun.operation === "destroy" ? "destroy_apply" : "apply",
                  ),
                  input.expectExactRun.capsuleId === undefined
                    ? isNull(pgSchema.runs.capsuleId)
                    : eq(pgSchema.runs.capsuleId, input.expectExactRun.capsuleId),
                  isNull(pgSchema.runs.leaseToken),
                  input.expectExactRun.heartbeatAt === undefined
                    ? isNull(pgSchema.runs.heartbeatAt)
                    : eq(pgSchema.runs.heartbeatAt, input.expectExactRun.heartbeatAt),
                ),
            input.expectLeaseToken === undefined
              ? sql`true`
              : eq(pgSchema.runs.leaseToken, input.expectLeaseToken),
            input.expectHeartbeatAt === undefined
              ? sql`true`
              : input.expectHeartbeatAt === null
                ? isNull(pgSchema.runs.heartbeatAt)
                : eq(pgSchema.runs.heartbeatAt, input.expectHeartbeatAt),
            input.expectStartedAt === undefined
              ? sql`true`
              : input.expectStartedAt === null
                ? sql`${pgSchema.runs.runJson} ->> 'startedAt' IS NULL`
                : sql`${pgSchema.runs.runJson} ->> 'startedAt' = ${String(input.expectStartedAt)}`,
          ),
        )
        .returning({ json: pgSchema.runs.runJson });
      return parseRow(rows[0]) as
        | PlanRun
        | ApplyRun
        | SourceSyncRun
        | Run
        | undefined;
    };
    let won: PlanRun | ApplyRun | SourceSyncRun | Run | undefined;
    if (
      input.setLeaseToken !== undefined ||
      input.expectedWorkspaceManagementAuthority !== undefined ||
      requireStoredManagementAuthority ||
      drainCancellation !== undefined
    ) {
      // The replacement payload is not authority: read the Workspace id from
      // the authoritative existing Run row, then lock that Workspace before
      // attempting the dependent Run CAS.
      won = await this.#client.transaction(async (transaction) => {
        const runRows = await transaction.query<{
          readonly workspaceId: string | null;
        }>(
          `select space_id as "workspaceId"
             from takosumi_runs
            where id = $1
            limit 1`,
          [input.id],
        );
        const workspaceId = runRows.rows[0]?.workspaceId;
        const management = workspaceId
          ? await pgWorkspaceManagementForTransaction(transaction, workspaceId)
          : undefined;
        if (
          !management ||
          (drainCancellation === undefined
            ? management.managementState !== "active"
            : management.managementState !== "draining")
        ) {
          return undefined;
        }
        const expected = input.expectedWorkspaceManagementAuthority ??
          drainCancellation?.management;
        if (
          expected !== undefined &&
          (expected.workspaceId !== management.workspaceId ||
            expected.managementEpoch !== management.managementEpoch)
        ) {
          // State/epoch loss is deliberately represented as the ordinary CAS
          // miss; callers re-read the current Run below.
          return undefined;
        }
        let current: StoredRunRecord | undefined;
        if (
          input.setLeaseToken !== undefined ||
          requireStoredManagementAuthority ||
          drainCancellation !== undefined
        ) {
          const currentRows = await transaction.query<{
            readonly runJson: unknown;
          }>(
            `select run_json as "runJson"
               from takosumi_runs
              where id = $1
              limit 1`,
            [input.id],
          );
          current = parseJson(currentRows.rows[0]?.runJson) as
            | StoredRunRecord
            | undefined;
          if (
            drainCancellation !== undefined &&
            (current === undefined || !runDrainCancellationMatches(current, input))
          ) {
            return undefined;
          }
          const authority = current ? runManagementAuthority(current) : undefined;
          if (
            (input.setLeaseToken !== undefined ||
              requireStoredManagementAuthority) &&
            (authority === undefined ||
              authority.workspaceId !== management.workspaceId ||
              authority.managementEpoch !== management.managementEpoch)
          ) {
            // The persisted original authority, not a caller's optional
            // expectation, fences every fresh lease or explicitly guarded
            // transition. Missing or malformed legacy metadata is an ordinary
            // CAS miss.
            return undefined;
          }
        }
        // The initial Run read did not lock the dependent row. Bind the CAS to
        // that same Workspace so a concurrent row replacement cannot make the
        // locked active Workspace authorize a Run now owned by another one.
        return await update(
          this.#drizzleForClient(transaction),
          management.workspaceId,
          current,
        );
      });
    } else {
      won = await update(this.#db);
    }
    if (won) return { won: true, run: publicStoredRun(won) };
    // Lost the CAS race (or the row vanished): re-read the now-current row so
    // callers observe the winning transition instead of clobbering it.
    const current =
      input.kind === "plan"
        ? await this.getPlanRun(input.id)
        : input.kind === "apply"
          ? await this.getApplyRun(input.id)
          : input.kind === "source_sync"
            ? await this.getSourceSyncRun(input.id)
            : await this.getBackupRun(input.id);
    return { won: false, ...(current ? { run: current } : {}) };
  }

  async commitSourceSyncSuccess(
    input: CommitSourceSyncSuccessInput,
  ): Promise<CommitSourceSyncSuccessResult> {
    assertSourceSyncSuccessCommit(input);
    const snapshot = normalizeSourceSnapshotRecord(input.snapshot);
    const won = await this.#client.transaction(
      async (transaction: SqlTransaction) => {
        const db = this.#drizzleForClient(transaction);
        const currentRows = await db
          .select({ json: pgSchema.runs.runJson })
          .from(pgSchema.runs)
          .where(
            and(
              eq(pgSchema.runs.id, input.terminalRun.id),
              eq(pgSchema.runs.kind, RUN_KIND_SOURCE_SYNC),
            ),
          )
          .limit(1);
        const current = parseRow(currentRows[0]) as
          | StoredRunRecord
          | undefined;
        if (
          current === undefined ||
          !sourceSyncRunStoredIdentityMatches(
            current,
            input.terminalRun as StoredRunRecord,
          )
        ) {
          return false;
        }
        const terminalRun = publicStoredRun(input.terminalRun);
        const terminalCommitted = await pgUpdateTerminalRunWithLease(
          db,
          RUN_KIND_SOURCE_SYNC,
          [RUN_KIND_SOURCE_SYNC],
          terminalRun,
          input.leaseToken,
        );
        if (!terminalCommitted) return false;
        await pgInsertOrAdoptSourceSnapshot(db, snapshot);
        await pgMergeSourceSyncCursor(db, terminalRun, snapshot);
        return true;
      },
    );
    if (won) {
      return { won: true, run: publicStoredRun(input.terminalRun) };
    }
    const current = await this.getSourceSyncRun(input.terminalRun.id);
    return { won: false, ...(current ? { run: current } : {}) };
  }

  async beginSourceSyncRun(
    run: SourceSyncRun,
    expectedWorkspaceManagementAuthority?: WorkspaceManagementAuthority,
  ): Promise<BeginSourceSyncRunResult> {
    ({ run, expectedWorkspaceManagementAuthority } = structuredClone({
      run,
      expectedWorkspaceManagementAuthority,
    }));
    if (expectedWorkspaceManagementAuthority !== undefined) {
      assertWorkspaceManagementAuthorityInput(
        expectedWorkspaceManagementAuthority,
        run.workspaceId,
      );
    }
    return await this.#client.transaction(async (transaction) => {
      const db = this.#drizzleForClient(transaction);

      // Workspace is the outer lock for a new SourceSyncRun admission. An
      // existing exact immutable row is an idempotent read and may be adopted
      // while draining, so the admission check is deliberately after it.
      const management = await pgWorkspaceManagementForTransaction(
        transaction,
        run.workspaceId,
      );
      const existingRows = await db
        .select({
          kind: pgSchema.runs.kind,
          workspaceId: pgSchema.runs.workspaceId,
          sourceId: pgSchema.runs.sourceId,
          json: pgSchema.runs.runJson,
        })
        .from(pgSchema.runs)
        .where(eq(pgSchema.runs.id, run.id))
        .limit(1);
      const existingRow = existingRows[0];
      const existing = parseRow(existingRow) as
        | StoredRunRecord
        | undefined;
      if (existingRow !== undefined) {
        return existingRow.kind === RUN_KIND_SOURCE_SYNC &&
            existingRow.workspaceId === run.workspaceId &&
            existingRow.sourceId === run.sourceId &&
            existing !== undefined &&
            isSourceSyncRunRecord(existing) &&
            sourceSyncRunImmutableIdentityMatches(existing, run)
          ? { status: "existing" as const, run: publicStoredRun(existing) }
          : { status: "conflict" as const };
      }

      if (expectedWorkspaceManagementAuthority === undefined) {
        // New SourceSync rows must carry the authority captured before any
        // asynchronous preparation. Existing exact rows above remain
        // read-only replays and never backfill this private field.
        throw new WorkspaceManagementAdmissionConflictError(run.workspaceId);
      }
      assertWorkspaceManagementAdmission(
        management,
        run.workspaceId,
        expectedWorkspaceManagementAuthority,
      );
      const stored = storeSourceSyncRun(
        run,
        expectedWorkspaceManagementAuthority,
      );
      const inserted = await db
        .insert(pgSchema.runs)
        .values({
          id: run.id,
          kind: RUN_KIND_SOURCE_SYNC,
          workspaceId: run.workspaceId,
          sourceId: run.sourceId,
          capsuleId: null,
          status: run.status,
          leaseToken: null,
          heartbeatAt: run.heartbeatAt ?? null,
          createdAt: String(run.createdAt),
          runJson: stored,
        })
        .onConflictDoNothing({ target: pgSchema.runs.id })
        .returning({ json: pgSchema.runs.runJson });
      if (inserted[0]) {
        return { status: "created" as const, run: publicStoredRun(stored) };
      }

      // A cross-Workspace id collision can bypass the target Workspace lock;
      // adopt only an exact SourceSyncRun identity after the failed insert.
      const currentRows = await db
        .select({
          kind: pgSchema.runs.kind,
          workspaceId: pgSchema.runs.workspaceId,
          sourceId: pgSchema.runs.sourceId,
          json: pgSchema.runs.runJson,
        })
        .from(pgSchema.runs)
        .where(eq(pgSchema.runs.id, run.id))
        .limit(1);
      const currentRow = currentRows[0];
      const current = parseRow(currentRow) as
        | StoredRunRecord
        | undefined;
      return currentRow && currentRow.kind === RUN_KIND_SOURCE_SYNC &&
          currentRow.workspaceId === run.workspaceId &&
          currentRow.sourceId === run.sourceId &&
          current && isSourceSyncRunRecord(current) &&
          sourceSyncRunImmutableIdentityMatches(current, run)
        ? { status: "existing" as const, run: publicStoredRun(current) }
        : { status: "conflict" as const };
    });
  }

  async putSourceSyncRun(run: SourceSyncRun): Promise<SourceSyncRun> {
    if (!isSourceSyncRunRecord(run as StoredRunRecord)) {
      throw new TypeError("SourceSyncRun stored identity cannot change");
    }
    // The caller's payload is always public. On conflict, preserve the
    // existing private authority key in the same PostgreSQL upsert statement.
    const publicRun = publicStoredRun(run);
    const runJson = sourceSyncRunJsonPreservingAuthority(publicRun);
    const written = await this.#db
      .insert(pgSchema.runs)
      .values({
        id: publicRun.id,
        kind: RUN_KIND_SOURCE_SYNC,
        workspaceId: publicRun.workspaceId,
        sourceId: publicRun.sourceId,
        capsuleId: null,
        status: publicRun.status,
        leaseToken: null,
        heartbeatAt: publicRun.heartbeatAt ?? null,
        createdAt: String(publicRun.createdAt),
        runJson: publicRun,
      })
      .onConflictDoUpdate({
        target: pgSchema.runs.id,
        set: {
          kind: RUN_KIND_SOURCE_SYNC,
          workspaceId: publicRun.workspaceId,
          sourceId: publicRun.sourceId,
          capsuleId: null,
          status: publicRun.status,
          leaseToken: null,
          heartbeatAt: publicRun.heartbeatAt ?? null,
          createdAt: String(publicRun.createdAt),
          runJson,
        },
        setWhere: and(
          eq(pgSchema.runs.kind, RUN_KIND_SOURCE_SYNC),
          eq(pgSchema.runs.workspaceId, publicRun.workspaceId),
          sql`${pgSchema.runs.runJson} ->> 'id' = ${publicRun.id}`,
          sql`${pgSchema.runs.runJson} ->> 'workspaceId' = ${publicRun.workspaceId}`,
          sql`${pgSchema.runs.runJson} ->> 'kind' = ${RUN_KIND_SOURCE_SYNC}`,
        ),
      })
      .returning({ id: pgSchema.runs.id });
    if (written.length === 0) {
      const existingRows = await this.#db
        .select({
          kind: pgSchema.runs.kind,
          workspaceId: pgSchema.runs.workspaceId,
          json: pgSchema.runs.runJson,
        })
        .from(pgSchema.runs)
        .where(eq(pgSchema.runs.id, publicRun.id))
        .limit(1);
      const existingRow = existingRows[0];
      const existing = parseRow(existingRow) as StoredRunRecord | undefined;
      if (
        existingRow !== undefined &&
        (existingRow.kind !== RUN_KIND_SOURCE_SYNC ||
          existingRow.workspaceId !== publicRun.workspaceId ||
          existing === undefined ||
          !sourceSyncRunStoredIdentityMatches(existing, publicRun as StoredRunRecord))
      ) {
        throw new TypeError("SourceSyncRun stored identity cannot change");
      }
    }
    return publicRun;
  }

  async getSourceSyncRun(id: string): Promise<SourceSyncRun | undefined> {
    const run = await this.#getRun<StoredRunRecord>(id, RUN_KIND_SOURCE_SYNC);
    return run && isSourceSyncRunRecord(run) ? publicStoredRun(run) : undefined;
  }

  async putCompatibilityCheckRun(run: Run): Promise<Run> {
    if (run.type !== "compatibility_check") {
      throw new Error(
        "putCompatibilityCheckRun only accepts compatibility_check runs",
      );
    }
    await this.#putRunDrizzle(RUN_KIND_COMPATIBILITY_CHECK, {
      id: run.id,
      workspaceId: run.workspaceId,
      sourceId: run.sourceId ?? null,
      capsuleId: run.capsuleId ?? null,
      createdAt: run.createdAt,
      json: run,
    });
    return publicStoredRun(run);
  }

  async getCompatibilityCheckRun(id: string): Promise<Run | undefined> {
    const run = await this.#getRun<StoredRunRecord>(
      id,
      RUN_KIND_COMPATIBILITY_CHECK,
    );
    return run ? (publicStoredRun(run) as Run) : undefined;
  }

  async beginCompatibilityCheckRun(
    inputRun: Run,
    inputExpectedWorkspaceManagementAuthority: WorkspaceManagementAuthority,
  ): Promise<BeginCompatibilityCheckRunResult> {
    const {
      run,
      expectedWorkspaceManagementAuthority,
    } = structuredClone({
      run: inputRun,
      expectedWorkspaceManagementAuthority:
        inputExpectedWorkspaceManagementAuthority,
    });
    assertCompatibilityCheckRunAdmissionInput(
      run,
      expectedWorkspaceManagementAuthority,
    );
    return await this.#client.transaction(async (transaction) => {
      // Workspace is the outer lock for a new compatibility analysis. Existing
      // exact rows are read-only replays and therefore do not re-check the
      // mutable current Workspace state.
      const management = await pgWorkspaceManagementForTransaction(
        transaction,
        run.workspaceId,
      );
      const readRow = async (): Promise<
        PgCompatibilityAdmissionRow | undefined
      > => {
        const rows = await transaction.query<PgCompatibilityAdmissionRow>(
          `select id,
                  kind,
                  space_id as "workspaceId",
                  source_id as "sourceId",
                  installation_id as "capsuleId",
                  status,
                  lease_token as "leaseToken",
                  created_at as "createdAt",
                  run_json as "runJson"
             from takosumi_runs
            where id = $1
            for update`,
          [run.id],
        );
        return rows.rows[0];
      };
      const existingRow = await readRow();
      if (existingRow !== undefined) {
        const current = pgCompatibilityRunFromAdmissionRow(existingRow);
        if (
          current === undefined ||
          !compatibilityCheckRunAdmissionMatches(
            current,
            run,
            expectedWorkspaceManagementAuthority,
          )
        ) {
          return { status: "conflict" as const };
        }
        return {
          status: "existing" as const,
          run: publicStoredRun(current) as Run,
        };
      }

      assertWorkspaceManagementAdmission(
        management,
        run.workspaceId,
        expectedWorkspaceManagementAuthority,
      );
      const stored = storeRunManagementAuthority(
        run,
        expectedWorkspaceManagementAuthority,
      );
      const inserted = await transaction.query<{ readonly id: string }>(
        `insert into takosumi_runs
          (id, kind, space_id, source_id, installation_id, status,
           lease_token, heartbeat_at, created_at, run_json)
         select $1, $2, workspace.id, $4, $5, $6,
                null, $7, $8, $9::jsonb
           from takosumi_workspaces as workspace
          where workspace.id = $3
            and workspace.management_state = 'active'
            and workspace.management_epoch = $10
         on conflict (id) do nothing
         returning id`,
        [
          run.id,
          RUN_KIND_COMPATIBILITY_CHECK,
          run.workspaceId,
          run.sourceId,
          run.capsuleId ?? null,
          run.status,
          run.heartbeatAt ?? null,
          String(run.createdAt),
          JSON.stringify(stored),
          expectedWorkspaceManagementAuthority.managementEpoch,
        ],
      );
      if (inserted.rows.length > 0) {
        return { status: "created" as const, run: publicStoredRun(run) };
      }

      // A raced id collision is never adopted blindly. Re-read the durable
      // row under the same transaction and apply the exact read-only matcher.
      const currentRow = await readRow();
      const current = currentRow
        ? pgCompatibilityRunFromAdmissionRow(currentRow)
        : undefined;
      return currentRow !== undefined && current !== undefined &&
          compatibilityCheckRunAdmissionMatches(
            current,
            run,
            expectedWorkspaceManagementAuthority,
          )
        ? { status: "existing" as const, run: publicStoredRun(current) as Run }
        : { status: "conflict" as const };
    });
  }

  async commitCompatibilityCheckRun(
    input: CommitCompatibilityCheckRunInput,
  ): Promise<CommitCompatibilityCheckRunResult> {
    // Settlement data is caller-owned. Clone and project the report before
    // the first asynchronous operation so a later caller mutation cannot
    // alter the CAS candidate or the returned replay value.
    input = structuredClone(input);
    input = {
      ...input,
      report: compatibilityCheckReportForStorage(input.report),
    };
    assertCommitCompatibilityCheckRunInput(input);

    try {
      return await this.#client.transaction(async (transaction) => {
        // Workspace is the outer lock for every settlement. The mutable
        // Workspace state is intentionally observational here: an admitted
        // analysis may finish while management is draining or frozen.
        await pgWorkspaceManagementForTransaction(
          transaction,
          input.expectedRunningRun.workspaceId,
        );

        const runRows = await transaction.query<PgCompatibilitySettlementRunRow>(
          `select id,
                  kind,
                  space_id as "workspaceId",
                  source_id as "sourceId",
                  installation_id as "capsuleId",
                  status,
                  lease_token as "leaseToken",
                  heartbeat_at as "heartbeatAt",
                  created_at as "createdAt",
                  run_json as "runJson"
             from takosumi_runs
            where id = $1
            for update`,
          [input.expectedRunningRun.id],
        );
        const runRow = runRows.rows[0];
        const current = runRow
          ? pgCompatibilityRunFromAdmissionRow(runRow)
          : undefined;
        if (runRow !== undefined && current === undefined) {
          return { status: "conflict" as const };
        }
        if (runRow === undefined || current === undefined) {
          return { status: "conflict" as const };
        }

        const reportRows = await transaction.query<PgCompatibilitySettlementReportRow>(
          `select id,
                  source_id as "sourceId",
                  installation_id as "capsuleId",
                  source_snapshot_id as "sourceSnapshotId",
                  module_path as "modulePath",
                  level,
                  findings_json as "findingsJson",
                  providers_json as "providersJson",
                  resources_json as "resourcesJson",
                  data_sources_json as "dataSourcesJson",
                  provisioners_json as "provisionersJson",
                  root_module_variables_json as "rootModuleVariablesJson",
                  root_module_variable_declarations_json as "rootModuleVariableDeclarationsJson",
                  root_module_outputs_json as "rootModuleOutputsJson",
                  created_at as "createdAt"
             from takosumi_capsule_compatibility_reports
            where id = $1
            for update`,
          [input.report.id],
        );
        const reportRow = reportRows.rows[0];
        const currentReport = reportRow === undefined
          ? undefined
          : pgCompatibilityReportFromSettlementRow(reportRow);
        if (reportRow !== undefined && currentReport === undefined) {
          return { status: "conflict" as const };
        }

        const disposition = compatibilityCheckRunCommitDisposition(
          current,
          currentReport,
          input,
        );
        if (disposition === "conflict") {
          return { status: "conflict" as const };
        }
        if (disposition === "replay") {
          // A replay is read-only. Returning the parsed durable projection
          // avoids blessing a caller payload when optional storage defaults
          // differ in representation.
          return {
            status: "replayed" as const,
            run: publicStoredRun(input.terminalRun),
            report: currentReport!,
          };
        }

        // Validate the transition against the locked durable authority. The
        // SQL expression below preserves that same private tuple atomically;
        // caller-injected metadata is never written.
        const storedTerminal = preserveStoredRunManagementAuthority(
          input.terminalRun,
          current,
        );
        const terminal = publicStoredRun(storedTerminal);
        const report = input.report;
        const providerGraph = storedCapsuleCompatibilityProviderGraph(report);
        const insertedReport = await transaction.query<{ readonly id: string }>(
          `insert into takosumi_capsule_compatibility_reports
            (id, source_id, installation_id, source_snapshot_id, module_path,
             level, findings_json, providers_json, resources_json,
             data_sources_json, provisioners_json, root_module_variables_json,
             root_module_variable_declarations_json, root_module_outputs_json,
             created_at)
           values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb,
                   $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb,
                   $14::jsonb, $15)
           on conflict (id) do nothing
           returning id`,
          [
            report.id,
            report.sourceId,
            report.capsuleId ?? null,
            report.sourceSnapshotId,
            report.modulePath ?? null,
            report.level,
            JSON.stringify(report.findings),
            JSON.stringify(providerGraph),
            JSON.stringify(report.resources),
            JSON.stringify(report.dataSources),
            JSON.stringify(report.provisioners),
            JSON.stringify(report.rootModuleVariables ?? []),
            report.rootModuleVariableDeclarations === undefined
              ? null
              : JSON.stringify(report.rootModuleVariableDeclarations),
            JSON.stringify(report.rootModuleOutputs ?? []),
            report.createdAt,
          ],
        );
        if (insertedReport.rows.length === 0) {
          // The report id was occupied after the observational read. Roll the
          // whole transaction back rather than turning the collision into a
          // terminal Run update.
          throw new CompatibilityCheckCommitConflictError();
        }

        const updated = await transaction.query<{ readonly id: string }>(
          `update takosumi_runs as run
              set status = $1,
                  lease_token = null,
                  heartbeat_at = $2,
                  run_json = $3::jsonb || case
                    when run.run_json ? 'workspaceManagementAuthority'
                      then jsonb_build_object(
                        'workspaceManagementAuthority',
                        run.run_json -> 'workspaceManagementAuthority'
                      )
                    else '{}'::jsonb
                  end
            where run.id = $4
              and run.kind = 'compatibility_check'
              and run.space_id = $5
              and run.source_id is not distinct from $6
              and run.installation_id is not distinct from $7
              and run.status = 'running'
              and run.lease_token is null
              and run.heartbeat_at is not distinct from $2
              and run.created_at = $8
              and run.run_json = $9::jsonb
           returning run.id`,
          [
            terminal.status,
            terminal.heartbeatAt ?? null,
            JSON.stringify(terminal),
            input.expectedRunningRun.id,
            input.expectedRunningRun.workspaceId,
            input.expectedRunningRun.sourceId ?? null,
            input.expectedRunningRun.capsuleId ?? null,
            String(input.expectedRunningRun.createdAt),
            JSON.stringify(current),
          ],
        );
        if (updated.rows.length === 0) {
          throw new CompatibilityCheckCommitConflictError();
        }
        return {
          status: "committed" as const,
          run: terminal,
          report,
        };
      });
    } catch (error) {
      if (error instanceof CompatibilityCheckCommitConflictError) {
        return { status: "conflict" };
      }
      throw error;
    }
  }

  async putBackupRun(run: Run): Promise<Run> {
    if (run.type !== "backup" && run.type !== "restore") {
      throw new Error("putBackupRun only accepts backup/restore runs");
    }
    await this.#putRunDrizzle(run.type, {
      id: run.id,
      workspaceId: run.workspaceId,
      capsuleId: run.capsuleId ?? null,
      createdAt: run.createdAt,
      json: run,
    });
    return publicStoredRun(run);
  }

  async beginBackupRun(
    inputRun: Run,
    inputExpectedWorkspaceManagementAuthority: WorkspaceManagementAuthority,
  ): Promise<BeginBackupRunResult> {
    const {
      run,
      expectedWorkspaceManagementAuthority,
    } = structuredClone({
      run: inputRun,
      expectedWorkspaceManagementAuthority:
        inputExpectedWorkspaceManagementAuthority,
    });
    if (run.type !== RUN_KIND_BACKUP || run.status !== "running") {
      throw new TypeError("Backup admission requires a new running Backup");
    }
    assertWorkspaceManagementAuthorityInput(
      expectedWorkspaceManagementAuthority,
      run.workspaceId,
    );
    return await this.#client.transaction(async (transaction) => {
      // The Workspace is the outer lock for manual-backup admission. A
      // stopped or epoch-mismatched Workspace rejects even an occupied Run id;
      // the idempotency conflict is checked only after this guard.
      const management = await pgWorkspaceManagementForTransaction(
        transaction,
        run.workspaceId,
      );
      assertWorkspaceManagementAdmission(
        management,
        run.workspaceId,
        expectedWorkspaceManagementAuthority,
      );

      const db = this.#drizzleForClient(transaction);
      const existingRows = await db
        .select({ id: pgSchema.runs.id })
        .from(pgSchema.runs)
        .where(eq(pgSchema.runs.id, run.id))
        .limit(1);
      if (existingRows.length > 0) {
        return { status: "conflict" as const };
      }

      const inserted = await db
        .insert(pgSchema.runs)
        .values({
          id: run.id,
          kind: RUN_KIND_BACKUP,
          workspaceId: run.workspaceId,
          sourceId: run.sourceId ?? null,
          capsuleId: run.capsuleId ?? null,
          status: run.status,
          leaseToken: null,
          heartbeatAt: run.heartbeatAt ?? null,
          createdAt: String(run.createdAt),
          runJson: storeRunManagementAuthority(
            run,
            expectedWorkspaceManagementAuthority,
          ),
        })
        .onConflictDoNothing({ target: pgSchema.runs.id })
        .returning({ json: pgSchema.runs.runJson });
      return inserted.length > 0
        ? { status: "created" as const, run: publicStoredRun(run) }
        : { status: "conflict" as const };
    });
  }

  async commitBackupRun(
    input: CommitBackupRunInput,
  ): Promise<CommitBackupRunResult> {
    // The settlement payload is caller-owned. Clone and validate it before
    // entering the asynchronous transaction so no caller mutation can alter
    // the CAS candidate or the returned replay projection.
    input = structuredClone(input);
    assertCommitBackupRunInput(input);

    try {
      return await this.#client.transaction(async (transaction) => {
        // Workspace is the outer lock for every manual-backup settlement. A
        // terminal commit may finish while the Workspace is draining, so this
        // lock is observational only and deliberately does not assert active
        // state or an epoch.
        await pgWorkspaceManagementForTransaction(
          transaction,
          input.expectedRunningRun.workspaceId,
        );

        // Lock and read the exact Run row after the Workspace lock. The raw
        // JSON is retained for the terminal compare-and-set below; no caller
        // metadata is trusted to supply the durable authority tuple.
        const runRows = await transaction.query<PgBackupSettlementRunRow>(
          `select id,
                  kind,
                  space_id as "workspaceId",
                  source_id as "sourceId",
                  installation_id as "capsuleId",
                  status,
                  lease_token as "leaseToken",
                  created_at as "createdAt",
                  run_json as "runJson"
             from takosumi_runs
            where id = $1
            for update`,
          [input.expectedRunningRun.id],
        );
        const runRow = runRows.rows[0];
        const current = runRow
          ? pgBackupRunFromSettlementRow(runRow)
          : undefined;
        // A present but malformed or physically divergent row is a conflict,
        // never an invitation to repair it with the candidate payload.
        if (runRow !== undefined && current === undefined) {
          return { status: "conflict" as const };
        }
        if (current === undefined || runRow === undefined) {
          return { status: "conflict" as const };
        }

        // Success settles against its candidate Backup id. Failure has no
        // candidate id, so inspect every pointer whose physical or sealed JSON
        // owner names this Run; an existing pointer makes the failure a
        // conflict rather than silently coexisting with a published record.
        const recordRows = input.record
          ? await transaction.query<PgBackupSettlementRecordRow>(
              `select id,
                      space_id as "workspaceId",
                      installation_id as "capsuleId",
                      environment,
                      created_by_run_id as "createdByRunId",
                      backup_json as "backupJson",
                      created_at as "createdAt"
                 from takosumi_backups
                where id = $1
                for update`,
              [input.record.id],
            )
          : await transaction.query<PgBackupSettlementRecordRow>(
              `select id,
                      space_id as "workspaceId",
                      installation_id as "capsuleId",
                      environment,
                      created_by_run_id as "createdByRunId",
                      backup_json as "backupJson",
                      created_at as "createdAt"
                 from takosumi_backups
                where created_by_run_id = $1
                   or backup_json ->> 'createdByRunId' = $1
                order by id
                limit 1
                for update`,
              [input.expectedRunningRun.id],
            );
        let currentRecord: BackupRecord | undefined;
        const recordRow = recordRows.rows[0];
        if (recordRow !== undefined) {
          currentRecord = pgBackupRecordFromSettlementRow(recordRow);
          if (currentRecord === undefined) {
            return { status: "conflict" as const };
          }
        }

        const disposition = backupRunCommitDisposition(
          current,
          currentRecord,
          input,
        );
        if (disposition === "conflict") {
          return { status: "conflict" as const };
        }
        if (disposition === "replay") {
          return {
            status: "replayed" as const,
            run: publicStoredRun(input.terminalRun),
            ...(input.record ? { record: input.record } : {}),
          };
        }

        // This helper verifies that the transition cannot change the durable
        // owner/kind. The SQL expression below preserves the authority from
        // the locked row itself, ignoring any caller-injected private key.
        preserveStoredRunManagementAuthority(input.terminalRun, current);

        if (input.record !== undefined) {
          const record = input.record;
          const inserted = await transaction.query<{ readonly id: string }>(
            `insert into takosumi_backups
              (id, space_id, installation_id, environment,
               created_by_run_id, backup_json, created_at)
             values ($1, $2, $3, $4, $5, $6::jsonb, $7)
             on conflict (id) do nothing
             returning id`,
            [
              record.id,
              record.workspaceId,
              record.capsuleId ?? null,
              record.environment ?? null,
              record.createdByRunId ?? null,
              JSON.stringify(record),
              record.createdAt,
            ],
          );
          if (inserted.rows.length === 0) {
            // A concurrent/colliding pointer must roll back the entire
            // settlement transaction; do not turn it into a replay.
            throw new BackupCommitConflictError();
          }
        }

        const terminal = publicStoredRun(input.terminalRun);
        const updated = await transaction.query<{ readonly id: string }>(
          `update takosumi_runs as run
              set space_id = $1,
                  source_id = $2,
                  installation_id = $3,
                  status = $4,
                  lease_token = null,
                  heartbeat_at = $5,
                  created_at = $6,
                  run_json = $7::jsonb || case
                    when run.run_json ? 'workspaceManagementAuthority'
                      then jsonb_build_object(
                        'workspaceManagementAuthority',
                        run.run_json -> 'workspaceManagementAuthority'
                      )
                    else '{}'::jsonb
                  end
            where run.id = $8
              and run.kind = 'backup'
              and run.space_id = $1
              and run.source_id is not distinct from $2
              and run.installation_id is not distinct from $3
              and run.status = 'running'
              and run.lease_token is null
              and run.created_at = $6
              and run.run_json = $9::jsonb
           returning run.id`,
          [
            terminal.workspaceId,
            terminal.sourceId ?? null,
            terminal.capsuleId ?? null,
            terminal.status,
            terminal.heartbeatAt ?? null,
            terminal.createdAt,
            JSON.stringify(terminal),
            input.expectedRunningRun.id,
            JSON.stringify(current),
          ],
        );
        if (updated.rows.length === 0) {
          throw new BackupCommitConflictError();
        }
        return {
          status: "committed" as const,
          run: terminal,
          ...(input.record ? { record: input.record } : {}),
        };
      });
    } catch (error) {
      if (error instanceof BackupCommitConflictError) {
        return { status: "conflict" };
      }
      throw error;
    }
  }

  async beginRestoreRun(
    inputRun: Run,
    inputExpectedWorkspaceManagementAuthority?: WorkspaceManagementAuthority,
  ): Promise<BeginRestoreRunResult> {
    const {
      run,
      expectedWorkspaceManagementAuthority,
    } = structuredClone({
      run: inputRun,
      expectedWorkspaceManagementAuthority:
        inputExpectedWorkspaceManagementAuthority,
    });
    if (
      run.type !== RUN_KIND_RESTORE ||
      (run.status !== "waiting_approval" && run.status !== "queued")
    ) {
      throw new TypeError("Restore admission requires a new waiting or queued Restore");
    }
    if (expectedWorkspaceManagementAuthority !== undefined) {
      assertWorkspaceManagementAuthorityInput(
        expectedWorkspaceManagementAuthority,
        run.workspaceId,
      );
    }
    return await this.#client.transaction(async (transaction) => {
      const db = this.#drizzleForClient(transaction);
      const existingRows = await db
        .select({
          kind: pgSchema.runs.kind,
          workspaceId: pgSchema.runs.workspaceId,
          json: pgSchema.runs.runJson,
        })
        .from(pgSchema.runs)
        .where(eq(pgSchema.runs.id, run.id))
        .limit(1);
      const existing = parseRow(existingRows[0]) as
        | StoredRunRecord
        | undefined;
      if (existingRows.length > 0) {
        return existing &&
            existingRows[0]?.kind === RUN_KIND_RESTORE &&
            existingRows[0]?.workspaceId === run.workspaceId &&
            restoreRunCreationIdentityMatches(existing as Run, run)
          ? {
              status: "existing" as const,
              run: publicStoredRun(existing) as Run,
            }
          : { status: "conflict" as const };
      }
      const management = await pgWorkspaceManagementForTransaction(
        transaction,
        run.workspaceId,
      );
      if (expectedWorkspaceManagementAuthority === undefined) {
        throw new WorkspaceManagementAdmissionConflictError(run.workspaceId);
      }
      assertWorkspaceManagementAdmission(
        management,
        run.workspaceId,
        expectedWorkspaceManagementAuthority,
      );
      const stored = storeRunManagementAuthority(
        run,
        expectedWorkspaceManagementAuthority,
      );
      const inserted = await db
        .insert(pgSchema.runs)
        .values({
          id: run.id,
          kind: RUN_KIND_RESTORE,
          workspaceId: run.workspaceId,
          sourceId: run.sourceId ?? null,
          capsuleId: run.capsuleId ?? null,
          status: run.status,
          leaseToken: null,
          heartbeatAt: run.heartbeatAt ?? null,
          createdAt: String(run.createdAt),
          runJson: stored,
        })
        .onConflictDoNothing({ target: pgSchema.runs.id })
        .returning({ json: pgSchema.runs.runJson });
      if (inserted.length > 0) {
        return { status: "created" as const, run: publicStoredRun(run) as Run };
      }
      const currentRows = await db
        .select({
          kind: pgSchema.runs.kind,
          workspaceId: pgSchema.runs.workspaceId,
          json: pgSchema.runs.runJson,
        })
        .from(pgSchema.runs)
        .where(eq(pgSchema.runs.id, run.id))
        .limit(1);
      const current = parseRow(currentRows[0]) as
        | StoredRunRecord
        | undefined;
      return current &&
          currentRows[0]?.kind === RUN_KIND_RESTORE &&
          currentRows[0]?.workspaceId === run.workspaceId &&
          restoreRunCreationIdentityMatches(current as Run, run)
        ? {
            status: "existing" as const,
            run: publicStoredRun(current) as Run,
          }
        : { status: "conflict" as const };
    });
  }

  async getBackupRun(id: string): Promise<Run | undefined> {
    const run = await this.#getRun<StoredRunRecord>(id, [
      RUN_KIND_BACKUP,
      RUN_KIND_RESTORE,
    ]);
    return run ? (publicStoredRun(run) as Run) : undefined;
  }

  async listRunsByWorkspace(
    workspaceId: string,
    options: { readonly limit?: number } = {},
  ): Promise<readonly StoredRunRecord[]> {
    const limit = clampRunListLimit(options.limit);
    const rows = await this.#pgManyJson<StoredRunRecord>(
      pgSchema.runs,
      pgSchema.runs.runJson,
      {
        where: eq(pgSchema.runs.workspaceId, workspaceId),
        orderBy: [desc(pgRunCreatedAtMillisOrder()), desc(pgSchema.runs.id)],
        limit,
      },
    );
    return rows.map(publicStoredRun);
  }

  async getCapsuleRuntimeSafety(
    capsuleId: string,
  ): Promise<CapsuleRuntimeSafety | undefined> {
    const rows = await this.#pgManyJson<ApplyRun | Run>(
      pgSchema.runs,
      pgSchema.runs.runJson,
      {
        where: pgRuntimeSafetyCandidateWhere(capsuleId),
        orderBy: [
          desc(pgRunRuntimeSafetyInFlightOrder()),
          desc(pgRunRuntimeSafetyEffectAtMillisOrder()),
          desc(pgRunRuntimeSafetyRiskOrder()),
          desc(pgSchema.runs.id),
        ],
        limit: 1,
      },
    );
    return rows[0] ? capsuleRuntimeSafetyFromRun(rows[0]) : undefined;
  }

  async listRecoverableOpenTofuRuns(
    options: RecoverableOpenTofuRunListOptions,
  ): Promise<readonly StoredRunRecord[]> {
    const createdAt = pgRecoverableRunTimestampMillis(
      sql`${pgSchema.runs.createdAt}`,
    );
    const finishedAt = pgRecoverableRunTimestampMillis(
      sql`${pgSchema.runs.runJson} ->> 'finishedAt'`,
    );
    const updatedAt = pgRecoverableRunTimestampMillis(
      sql`${pgSchema.runs.runJson} ->> 'updatedAt'`,
    );
    const startedAt = pgRecoverableRunTimestampMillis(
      sql`${pgSchema.runs.runJson} ->> 'startedAt'`,
    );
    const committedAt = sql`COALESCE(${finishedAt}, ${updatedAt}, ${createdAt})`;
    const heartbeatAt = sql`CASE
      WHEN jsonb_typeof(${pgSchema.runs.runJson} -> 'heartbeatAt') = 'number'
        THEN ${pgRecoverableRunTimestampMillis(
          sql`${pgSchema.runs.runJson} ->> 'heartbeatAt'`,
        )}
      ELSE NULL
    END`;
    const runningReference = sql`COALESCE(
      ${heartbeatAt},
      ${startedAt},
      ${createdAt}
    )`;
    const dispatchableKinds = [
      ...RUN_KINDS_PLAN,
      "drift_check",
      ...RUN_KINDS_APPLY,
      RUN_KIND_SOURCE_SYNC,
      RUN_KIND_RESTORE,
    ] as const;
    const where = or(
      and(
        eq(pgSchema.runs.status, "queued"),
        inArray(pgSchema.runs.kind, [...dispatchableKinds]),
        sql`${createdAt} > 0`,
        sql`${createdAt} <= ${options.staleQueuedBeforeMs}`,
      ),
      and(
        eq(pgSchema.runs.status, "running"),
        inArray(pgSchema.runs.kind, [...dispatchableKinds]),
        sql`${createdAt} > 0`,
        sql`${runningReference} <= ${options.staleRunningBeforeMs}`,
      ),
      and(
        inArray(pgSchema.runs.kind, [...RUN_KINDS_APPLY]),
        inArray(pgSchema.runs.status, ["succeeded", "failed"]),
        pgRunBillingCapturePending(),
        sql`${committedAt} > 0`,
        sql`${committedAt} <= ${options.staleQueuedBeforeMs}`,
      ),
    );
    const limit = clampRecoverableOpenTofuRunListLimit(options.limit);
    const rows = await this.#db
      .select({ json: pgSchema.runs.runJson })
      .from(pgSchema.runs)
      .where(where)
      .orderBy(asc(createdAt), asc(pgSchema.runs.id))
      .limit(limit);
    return rows
      .map((row) => parseRow(row) as StoredRunRecord)
      .filter((row): row is StoredRunRecord => Boolean(row))
      // Keep the shared predicate as a fail-closed defense for legacy rows or
      // a future dialect drift; SQL performs the actual bound and ordering.
      .filter((row) => isRecoverableOpenTofuRunRecord(row, options))
      .map(publicStoredRun);
  }

  async listPendingRuntimeSecretRetirementRuns(options: {
    readonly staleBeforeMs: number;
    readonly limit?: number;
  }): Promise<readonly ApplyRun[]> {
    const limit = clampRecoverableOpenTofuRunListLimit(options.limit);
    const lastAttempt = sql`COALESCE(
      NULLIF(${pgSchema.runs.runJson} ->> 'updatedAt', '')::double precision,
      NULLIF(${pgSchema.runs.runJson} ->> 'finishedAt', '')::double precision,
      ${pgRunCreatedAtMillisOrder()}
    )`;
    const rows = await this.#db
      .select({ json: pgSchema.runs.runJson })
      .from(pgSchema.runs)
      .where(
        and(
          inArray(pgSchema.runs.kind, [...RUN_KINDS_APPLY]),
          inArray(pgSchema.runs.status, ["succeeded", "failed"]),
          pgRunRuntimeSecretRetirementPending(),
          sql`${lastAttempt} <= ${options.staleBeforeMs}`,
        ),
      )
      .orderBy(asc(lastAttempt), asc(pgSchema.runs.id))
      .limit(limit);
    return rows
      .map((row) => parseRow(row) as StoredRunRecord)
      .filter((row): row is ApplyRun => Boolean(row && isApplyRunRecord(row)))
      .map(publicStoredRun);
  }

  async claimPendingRuntimeSecretRetirementDispatch(
    input: RuntimeSecretRetirementDispatchClaimInput,
  ): Promise<boolean> {
    const observedRaw = await this.#getRun<StoredRunRecord>(
      input.runId,
      RUN_KINDS_APPLY,
    );
    const observed = observedRaw && isApplyRunRecord(observedRaw)
      ? publicStoredRun(observedRaw)
      : undefined;
    const claimed = observed
      ? runtimeSecretRetirementDispatchAttempt(observed, input)
      : undefined;
    if (!claimed) return false;
    const rows = await this.#db
      .update(pgSchema.runs)
      .set({
        status: claimed.status,
        runJson: runJsonPreservingManagementAuthority(
          claimed as StoredRunRecord,
        ),
      })
      .where(
        and(
          eq(pgSchema.runs.id, input.runId),
          inArray(pgSchema.runs.kind, [...RUN_KINDS_APPLY]),
          inArray(pgSchema.runs.status, ["succeeded", "failed"]),
          // This exact JSON fence is the attempt claim. A concurrent sweep or
          // completed retirement changes the row and makes this update lose.
          eq(pgSchema.runs.runJson, observedRaw),
          pgRunRuntimeSecretRetirementPending(),
        ),
      )
      .returning({ id: pgSchema.runs.id });
    return rows.length === 1;
  }

  async listSourceSyncRuns(
    sourceId: string,
  ): Promise<readonly SourceSyncRun[]> {
    const currentRows = await this.#db
      .select({ json: pgSchema.runs.runJson })
      .from(pgSchema.runs)
      .where(
        and(
          eq(pgSchema.runs.kind, RUN_KIND_SOURCE_SYNC),
          eq(pgSchema.runs.sourceId, sourceId),
        ),
      )
      .orderBy(asc(pgSchema.runs.createdAt), asc(pgSchema.runs.id));
    return currentRows
      .map((row) => parseRow(row) as SourceSyncRun)
      .map(publicStoredRun);
  }

  // --- artifact ledger (§30 artifacts) -------------------------------------

  async putArtifactRecord(record: ArtifactRecord): Promise<ArtifactRecord> {
    await this.#pgUpsert(pgSchema.artifacts, {
      id: record.id,
      runId: record.runId,
      kind: record.kind,
      ref: record.ref,
      digest: record.digest,
      sizeBytes: record.sizeBytes,
      createdAt: record.createdAt,
    });
    return record;
  }

  async listArtifactRecordsForRun(
    runId: string,
  ): Promise<readonly ArtifactRecord[]> {
    const rows = await this.#db
      .select()
      .from(pgSchema.artifacts)
      .where(eq(pgSchema.artifacts.runId, runId))
      .orderBy(asc(pgSchema.artifacts.createdAt), asc(pgSchema.artifacts.id));
    return rows.map(artifactRecordFromRow);
  }

  async #putRunDrizzle(
    kind: string,
    fields: {
      readonly id: string;
      readonly workspaceId: string;
      readonly sourceId?: string | null;
      readonly capsuleId: string | null;
      readonly createdAt: number | string;
      readonly json: unknown;
    },
  ): Promise<void> {
    const run = fields.json as {
      readonly status?: string;
      readonly leaseToken?: string | null;
      readonly heartbeatAt?: number | null;
    };
    const publicRun = publicStoredRun(fields.json as StoredRunRecord);
    const values = {
      id: fields.id,
      kind,
      workspaceId: fields.workspaceId,
      sourceId: fields.sourceId ?? null,
      capsuleId: fields.capsuleId,
      // The §27 ledger keeps status / lease coordination as indexed columns; the
      // canonical value still rides in run_json. Default status to `queued` so a
      // run without an explicit status still satisfies the NOT NULL column.
      status: run.status ?? "queued",
      leaseToken: run.leaseToken ?? null,
      heartbeatAt: run.heartbeatAt ?? null,
      // created_at is TEXT so it can hold both the internal epoch-number runs
      // and the ISO-string SourceSyncRun without a per-kind column.
      createdAt: String(fields.createdAt),
      runJson: publicRun,
    };
    const written = await this.#db
      .insert(pgSchema.runs)
      .values(values)
      .onConflictDoUpdate({
        target: pgSchema.runs.id,
        set: {
          kind: values.kind,
          workspaceId: values.workspaceId,
          sourceId: values.sourceId,
          capsuleId: values.capsuleId,
          status: values.status,
          leaseToken: values.leaseToken,
          heartbeatAt: values.heartbeatAt,
          createdAt: values.createdAt,
          runJson: runJsonPreservingManagementAuthority(
            publicRun as StoredRunRecord,
          ),
        },
        setWhere: and(
          eq(pgSchema.runs.kind, kind),
          eq(pgSchema.runs.workspaceId, fields.workspaceId),
          sql`${pgSchema.runs.runJson} ->> 'id' = ${fields.id}`,
          sql`${pgSchema.runs.runJson} ->> 'workspaceId' = ${fields.workspaceId}`,
        ),
      })
      .returning({ id: pgSchema.runs.id });
    if (written.length === 0) {
      throw new TypeError("Run stored identity cannot change");
    }
  }

  async #getRun<T>(
    id: string,
    kinds: string | readonly string[],
  ): Promise<T | undefined> {
    const list = typeof kinds === "string" ? [kinds] : [...kinds];
    const rows = await this.#db
      .select({ json: pgSchema.runs.runJson })
      .from(pgSchema.runs)
      .where(and(eq(pgSchema.runs.id, id), inArray(pgSchema.runs.kind, list)))
      .limit(1);
    return parseRow(rows[0]) as T | undefined;
  }

  // --- plan-run inputs sidecar (never projected into the public ledger) -----

  async putPlanRunInputs(inputs: PlanRunInputs): Promise<void> {
    await this.#db
      .insert(pgSchema.planRunInputs)
      .values({ planRunId: inputs.planRunId, inputsJson: inputs })
      .onConflictDoUpdate({
        target: pgSchema.planRunInputs.planRunId,
        set: { inputsJson: inputs },
      });
  }

  async getPlanRunInputs(
    planRunId: string,
  ): Promise<PlanRunInputs | undefined> {
    const rows = await this.#db
      .select({ json: pgSchema.planRunInputs.inputsJson })
      .from(pgSchema.planRunInputs)
      .where(eq(pgSchema.planRunInputs.planRunId, planRunId))
      .limit(1);
    return parseRow(rows[0]) as PlanRunInputs | undefined;
  }

  async deletePlanRunInputs(planRunId: string): Promise<void> {
    await this.#db
      .delete(pgSchema.planRunInputs)
      .where(eq(pgSchema.planRunInputs.planRunId, planRunId));
  }

  // --- Workspaces (§4) -----------------------------------------------------

  async putWorkspace(workspace: Workspace): Promise<Workspace> {
    await this.#db
      .insert(pgSchema.workspaces)
      .values({
        id: workspace.id,
        handle: workspace.handle,
        spaceJson: workspace,
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
      })
      .onConflictDoUpdate({
        target: pgSchema.workspaces.id,
        set: {
          handle: workspace.handle,
          spaceJson: workspace,
          createdAt: workspace.createdAt,
          updatedAt: workspace.updatedAt,
        },
      });
    return workspace;
  }

  async replaceWorkspace(input: WorkspaceReplacementInput): Promise<boolean> {
    validateWorkspaceReplacement(input);
    const {
      workspace,
      expectedWorkspace,
      expectedWorkspaceManagementAuthority,
    } = input;
    return await this.#client.transaction(async (transaction) => {
      // Workspace management is the outer authority lock. The exact epoch is
      // checked while this row is locked, before the observed public JSON CAS.
      const management = await pgWorkspaceManagementForTransaction(
        transaction,
        workspace.id,
      );
      assertWorkspaceManagementAdmission(
        management,
        workspace.id,
        expectedWorkspaceManagementAuthority,
      );
      const db = this.#drizzleForClient(transaction);
      const rows = await db
        .update(pgSchema.workspaces)
        .set({
          // Metadata replacement deliberately changes only the public JSON
          // and its audit timestamp; private management columns stay intact.
          spaceJson: workspace,
          updatedAt: workspace.updatedAt,
        })
        .where(
          and(
            eq(pgSchema.workspaces.id, expectedWorkspace.id),
            eq(pgSchema.workspaces.handle, expectedWorkspace.handle),
            eq(pgSchema.workspaces.spaceJson, expectedWorkspace),
          ),
        )
        .returning({ id: pgSchema.workspaces.id });
      return rows.length === 1;
    });
  }

  async replaceWorkspaceForAccount(
    input: WorkspaceAccountReplacementInput,
  ): Promise<boolean> {
    // Validate the immutable/public replacement and actor shape before any
    // asynchronous preparation. The transaction below is the sole admission
    // and write boundary; no current authority is recaptured here.
    validateWorkspaceReplacement(input);
    if (!workspaceAccountReplacementAllowed(input)) return false;
    const {
      workspace,
      expectedWorkspace,
      expectedWorkspaceManagementAuthority,
      actorAccountId,
      expectedActor,
    } = input;
    return await this.#client.transaction(async (transaction) => {
      // Workspace management is the outer lock for account-facing metadata
      // writes, matching replaceWorkspace and the member mutation paths.
      const management = await pgWorkspaceManagementForTransaction(
        transaction,
        workspace.id,
      );
      assertWorkspaceManagementAdmission(
        management,
        workspace.id,
        expectedWorkspaceManagementAuthority,
      );

      // The namespace owner is authoritative even when an imported/legacy
      // roster has no derived owner member. Other actors must be re-read under
      // the Workspace lock, with physical identity and the exact observed
      // logical member snapshot checked before the metadata CAS.
      if (expectedWorkspace.ownerUserId !== actorAccountId) {
        if (expectedActor === undefined) return false;
        const snapshot = await this.#workspaceMemberMutationSnapshot(
          transaction,
          expectedWorkspace,
          [actorAccountId],
        );
        if (snapshot === undefined) return false;
        const currentActor = snapshot.members.find(
          (member) => member.accountId === actorAccountId,
        );
        if (
          currentActor === undefined ||
          !workspaceMemberLogicalEquals(currentActor, expectedActor) ||
          !workspaceAccountReplacementAllowed({
            ...input,
            expectedActor: currentActor,
          })
        ) {
          return false;
        }
      }

      const db = this.#drizzleForClient(transaction);
      const rows = await db
        .update(pgSchema.workspaces)
        .set({
          // Account metadata replacement changes only the public JSON and its
          // audit timestamp; private management columns remain untouched.
          spaceJson: workspace,
          updatedAt: workspace.updatedAt,
        })
        .where(
          and(
            eq(pgSchema.workspaces.id, expectedWorkspace.id),
            eq(pgSchema.workspaces.handle, expectedWorkspace.handle),
            eq(pgSchema.workspaces.spaceJson, expectedWorkspace),
          ),
        )
        .returning({ id: pgSchema.workspaces.id });
      return rows.length === 1;
    });
  }

  async getWorkspaceManagement(
    workspaceId: string,
  ): Promise<WorkspaceManagement | undefined> {
    const rows = await this.#db
      .select({
        managementState: pgSchema.workspaces.managementState,
        managementEpoch: pgSchema.workspaces.managementEpoch,
      })
      .from(pgSchema.workspaces)
      .where(eq(pgSchema.workspaces.id, workspaceId))
      .limit(1);
    const row = rows[0];
    return row
      ? normalizeWorkspaceManagement(
          workspaceId,
          row.managementState,
          row.managementEpoch,
        )
      : undefined;
  }

  async beginWorkspaceDraining(
    workspaceId: string,
    expectedInput: WorkspaceManagementAuthority,
  ): Promise<BeginWorkspaceDrainingResult> {
    const expected = { ...expectedInput };
    assertWorkspaceManagementAuthorityInput(expected, workspaceId);
    return await this.#client.transaction(async (transaction) => {
      // Workspace is the outer lock for every management transition. Dependent
      // Run/Capsule locks are acquired only after this row is locked by callers.
      const current = await pgWorkspaceManagementForTransaction(
        transaction,
        workspaceId,
      );
      if (current === undefined) return { status: "not_found" as const };
      if (
        current.managementState === "active" &&
        current.managementEpoch === expected.managementEpoch
      ) {
        if (current.managementEpoch >= Number.MAX_SAFE_INTEGER) {
          throw new TypeError(
            `Workspace ${workspaceId} management epoch cannot advance safely`,
          );
        }
        const rows = await transaction.query<{
          readonly managementState: string | null;
          readonly managementEpoch: number | string | null;
        }>(
          `update takosumi_workspaces
              set management_state = 'draining',
                  management_epoch = management_epoch + 1
            where id = $1
              and management_state = 'active'
              and management_epoch = $2
          returning management_state as "managementState",
                    management_epoch as "managementEpoch"`,
          [workspaceId, expected.managementEpoch],
        );
        const row = rows.rows[0];
        if (row !== undefined) {
          return {
            status: "started" as const,
            management: normalizeWorkspaceManagement(
              workspaceId,
              row.managementState,
              row.managementEpoch,
            ),
          };
        }
      }
      if (
        current.managementState === "draining" &&
        expected.managementEpoch < Number.MAX_SAFE_INTEGER &&
        current.managementEpoch === expected.managementEpoch + 1
      ) {
        return { status: "existing" as const, management: current };
      }
      return { status: "conflict" as const, management: current };
    });
  }

  async freezeWorkspaceManagementIfQuiescent(
    expectedInput: FreezeWorkspaceManagementExpectation,
  ): Promise<FreezeWorkspaceManagementResult> {
    const expected = structuredClone(expectedInput);
    assertWorkspaceFreezeExpectation(expected);
    return await this.#client.transaction(async (transaction) => {
      // Keep the Workspace lock outermost. Every management-fenced admission
      // takes this lock before inserting dependent work, so the blocker scan
      // and draining -> frozen CAS share one serialization boundary.
      const current = await pgWorkspaceManagementForTransaction(
        transaction,
        expected.workspaceId,
      );
      if (current === undefined) return { status: "not_found" as const };
      if (current.managementEpoch !== expected.managementEpoch) {
        return {
          status: "conflict" as const,
          management: current,
        };
      }
      if (current.managementState === "frozen") {
        return { status: "existing" as const, management: current };
      }
      if (current.managementState !== "draining") {
        return {
          status: "conflict" as const,
          management: current,
        };
      }

      const rows = await transaction.query<{
        readonly managementState: string | null;
        readonly managementEpoch: number | string | null;
      }>(
        `update takosumi_workspaces as workspace
            set management_state = 'frozen'
          where workspace.id = $1
            and workspace.management_state = 'draining'
            and workspace.management_epoch = $2
            and not exists (
              select 1
                from takosumi_runs as run
               where run.space_id = workspace.id
                 and (${PG_WORKSPACE_FREEZE_RUN_BLOCKER_SQL})
            )
            and not exists (
              select 1
                from takosumi_capsule_interface_materialization_intents as intent
               where intent.workspace_id = workspace.id
                 and (${PG_WORKSPACE_FREEZE_INTERFACE_BLOCKER_SQL})
            )
            and not exists (
              select 1
                from takosumi_git_install_plans as git_plan
               where git_plan.workspace_id = workspace.id
                 and (${PG_GIT_INSTALL_PLAN_MANAGEMENT_BLOCKER_SQL})
            )
        returning workspace.management_state as "managementState",
                  workspace.management_epoch as "managementEpoch"`,
        [expected.workspaceId, expected.managementEpoch],
      );
      const row = rows.rows[0];
      if (row === undefined) {
        // The row is still locked and was confirmed as the exact draining
        // expectation above; a failed conditional update is therefore a
        // complete, fail-closed blocker result rather than a stale readback.
        return { status: "blocked" as const, management: current };
      }
      return {
        status: "frozen" as const,
        management: normalizeWorkspaceManagement(
          expected.workspaceId,
          row.managementState,
          row.managementEpoch,
        ),
      };
    });
  }

  async claimPersonalWorkspaceBootstrap(
    ownerUserId: string,
    candidate: Workspace,
  ): Promise<Workspace | undefined> {
    const exactClaim = async (): Promise<Workspace | undefined> => {
      const rows = await this.#db
        .select({ json: pgSchema.workspaces.spaceJson })
        .from(pgSchema.workspaces)
        .where(eq(pgSchema.workspaces.personalBootstrapOwnerId, ownerUserId))
        .limit(1);
      return parseRow(rows[0]) as Workspace | undefined;
    };
    const existing = await exactClaim();
    if (existing) return existing;

    const adoptable = await this.#db
      .select({ id: pgSchema.workspaces.id })
      .from(pgSchema.workspaces)
      .where(
        and(
          eq(pgSchema.workspaces.ownerUserId, ownerUserId),
          eq(pgSchema.workspaces.workspaceType, "personal"),
          isNull(pgSchema.workspaces.personalBootstrapOwnerId),
        ),
      )
      .orderBy(asc(pgSchema.workspaces.createdAt), asc(pgSchema.workspaces.id))
      .limit(1);
    const adoptableId = adoptable[0]?.id;
    if (adoptableId !== undefined) {
      try {
        await this.#db
          .update(pgSchema.workspaces)
          .set({ personalBootstrapOwnerId: ownerUserId })
          .where(
            and(
              eq(pgSchema.workspaces.id, adoptableId),
              eq(pgSchema.workspaces.ownerUserId, ownerUserId),
              eq(pgSchema.workspaces.workspaceType, "personal"),
              isNull(pgSchema.workspaces.personalBootstrapOwnerId),
            ),
          );
      } catch (error) {
        const raced = await exactClaim();
        if (raced) return raced;
        throw error;
      }
      const adopted = await exactClaim();
      if (adopted) return adopted;
      throw new Error("personal Workspace bootstrap adoption did not persist");
    }

    await this.#db
      .insert(pgSchema.workspaces)
      .values({
        id: candidate.id,
        handle: candidate.handle,
        spaceJson: candidate,
        createdAt: candidate.createdAt,
        updatedAt: candidate.updatedAt,
        personalBootstrapOwnerId: ownerUserId,
      })
      .onConflictDoNothing();
    return await exactClaim();
  }

  async getWorkspace(id: string): Promise<Workspace | undefined> {
    const rows = await this.#db
      .select({ json: pgSchema.workspaces.spaceJson })
      .from(pgSchema.workspaces)
      .where(eq(pgSchema.workspaces.id, id))
      .limit(1);
    return parseRow(rows[0]) as Workspace | undefined;
  }

  async listWorkspacesByIds(
    ids: readonly string[],
  ): Promise<readonly Workspace[]> {
    if (ids.length === 0) return [];
    const rows = await this.#db
      .select({ json: pgSchema.workspaces.spaceJson })
      .from(pgSchema.workspaces)
      .where(inArray(pgSchema.workspaces.id, [...new Set(ids)]));
    const byId = new Map(
      rows.map((row) => {
        const value = parseRow(row) as Workspace;
        return [value.id, value] as const;
      }),
    );
    return ids
      .map((id) => byId.get(id))
      .filter((row): row is Workspace => row !== undefined);
  }

  async getWorkspaceByHandle(handle: string): Promise<Workspace | undefined> {
    const rows = await this.#db
      .select({ json: pgSchema.workspaces.spaceJson })
      .from(pgSchema.workspaces)
      .where(eq(pgSchema.workspaces.handle, handle))
      .limit(1);
    return parseRow(rows[0]) as Workspace | undefined;
  }

  async listWorkspaces(): Promise<readonly Workspace[]> {
    const rows = await this.#db
      .select({ json: pgSchema.workspaces.spaceJson })
      .from(pgSchema.workspaces)
      .orderBy(asc(pgSchema.workspaces.createdAt), asc(pgSchema.workspaces.id));
    return rows.map((row) => parseRow(row) as Workspace);
  }

  async listWorkspacesPage(params: PageParams): Promise<Page<Workspace>> {
    const limit = clampPageLimit(params.limit);
    const cursor = decodeCursor(params.cursor);
    const rows = cursor
      ? await this.#db
          .select({ json: pgSchema.workspaces.spaceJson })
          .from(pgSchema.workspaces)
          .where(
            or(
              gt(pgSchema.workspaces.createdAt, cursor.createdAt),
              and(
                eq(pgSchema.workspaces.createdAt, cursor.createdAt),
                gt(pgSchema.workspaces.id, cursor.id),
              ),
            ),
          )
          .orderBy(
            asc(pgSchema.workspaces.createdAt),
            asc(pgSchema.workspaces.id),
          )
          .limit(limit + 1)
      : await this.#db
          .select({ json: pgSchema.workspaces.spaceJson })
          .from(pgSchema.workspaces)
          .orderBy(
            asc(pgSchema.workspaces.createdAt),
            asc(pgSchema.workspaces.id),
          )
          .limit(limit + 1);
    return pageFromProbe(
      rows.map((row) => parseRow(row) as Workspace),
      limit,
    );
  }

  async listWorkspacesByOwner(
    ownerUserId: string,
  ): Promise<readonly Workspace[]> {
    const rows = await this.#db
      .select({ json: pgSchema.workspaces.spaceJson })
      .from(pgSchema.workspaces)
      .where(
        sql`${pgSchema.workspaces.spaceJson} ->> 'ownerUserId' = ${ownerUserId}`,
      )
      .orderBy(asc(pgSchema.workspaces.createdAt), asc(pgSchema.workspaces.id));
    return rows.map((row) => parseRow(row) as Workspace);
  }

  async putWorkspaceMember(member: WorkspaceMember): Promise<WorkspaceMember> {
    await this.#db
      .insert(pgSchema.workspaceMembers)
      .values({
        id: member.id,
        workspaceId: member.workspaceId,
        accountId: member.accountId,
        status: member.status,
        memberJson: member,
        createdAt: member.createdAt,
        updatedAt: member.updatedAt,
      })
      .onConflictDoUpdate({
        target: [
          pgSchema.workspaceMembers.workspaceId,
          pgSchema.workspaceMembers.accountId,
        ],
        set: {
          id: member.id,
          status: member.status,
          memberJson: member,
          createdAt: member.createdAt,
          updatedAt: member.updatedAt,
        },
      });
    return member;
  }

  async mutateWorkspaceMember(
    input: WorkspaceMemberMutationInput,
  ): Promise<boolean> {
    validateWorkspaceMemberReplacement(input);
    const {
      member,
      expectedMember,
      expectedActor,
      expectedWorkspace,
      expectedWorkspaceManagementAuthority,
    } = input;
    return await this.#client.transaction(async (transaction) => {
      // Workspace management is the outer authority lock for every membership
      // mutation. A stopped Workspace therefore fails before any member read.
      const management = await pgWorkspaceManagementForTransaction(
        transaction,
        member.workspaceId,
      );
      assertWorkspaceManagementAdmission(
        management,
        member.workspaceId,
        expectedWorkspaceManagementAuthority,
      );
      const snapshot = await this.#workspaceMemberMutationSnapshot(
        transaction,
        expectedWorkspace,
        [
          member.accountId,
          expectedActor.accountId,
          expectedWorkspace.ownerUserId,
        ],
      );
      if (snapshot === undefined) return false;
      const currentTarget = snapshot.members.find(
        (row) => row.accountId === member.accountId,
      );
      const currentActor = snapshot.members.find(
        (row) => row.accountId === expectedActor.accountId,
      );
      if (
        !workspaceMemberMutationAllowed(input) ||
        currentActor === undefined ||
        !workspaceMemberLogicalEquals(currentActor, expectedActor) ||
        !workspaceMemberExpectedMatches(currentTarget, expectedMember)
      ) {
        return false;
      }
      if (
        workspaceMemberMutationDropsOwner(input) &&
        !(await this.#workspaceMemberHasAnotherActiveOwner(
          transaction,
          member.workspaceId,
          member.accountId,
        ))
      ) {
        return false;
      }
      return await this.#writeWorkspaceMemberMutation(
        transaction,
        input,
        currentTarget,
      );
    });
  }

  async repairWorkspaceOwnerMember(
    input: WorkspaceOwnerMemberRepairInput,
  ): Promise<boolean> {
    validateWorkspaceOwnerMemberRepair(input);
    const {
      member,
      expectedMember,
      expectedWorkspace,
      expectedWorkspaceManagementAuthority,
    } = input;
    return await this.#client.transaction(async (transaction) => {
      const management = await pgWorkspaceManagementForTransaction(
        transaction,
        member.workspaceId,
      );
      assertWorkspaceManagementAdmission(
        management,
        member.workspaceId,
        expectedWorkspaceManagementAuthority,
      );
      const snapshot = await this.#workspaceMemberMutationSnapshot(
        transaction,
        expectedWorkspace,
        [member.accountId, expectedWorkspace.ownerUserId],
      );
      if (
        snapshot === undefined ||
        // Derive the namespace owner from the locked stored Workspace, never
        // from a caller-selected account.
        snapshot.workspace.ownerUserId !== member.accountId
      ) {
        return false;
      }
      const currentTarget = snapshot.members.find(
        (row) => row.accountId === member.accountId,
      );
      if (!workspaceMemberExpectedMatches(currentTarget, expectedMember)) {
        return false;
      }
      return await this.#writeWorkspaceMemberMutation(
        transaction,
        input,
        currentTarget,
      );
    });
  }

  async #writeWorkspaceMemberMutation(
    transaction: SqlTransaction,
    input: WorkspaceMemberMutationInput | WorkspaceOwnerMemberRepairInput,
    current: WorkspaceMember | undefined,
  ): Promise<boolean> {
    const member = input.member;
    const db = this.#drizzleForClient(transaction);
    if (current !== undefined) {
      const rows = await db
        .update(pgSchema.workspaceMembers)
        .set({
          id: member.id,
          status: member.status,
          memberJson: member,
          createdAt: member.createdAt,
          updatedAt: member.updatedAt,
        })
        .where(
          and(
            eq(pgSchema.workspaceMembers.id, current.id),
            eq(pgSchema.workspaceMembers.workspaceId, member.workspaceId),
            eq(pgSchema.workspaceMembers.accountId, member.accountId),
          ),
        )
        .returning({ id: pgSchema.workspaceMembers.id });
      return rows.length === 1;
    }
    const rows = await db
      .insert(pgSchema.workspaceMembers)
      .values({
        id: member.id,
        workspaceId: member.workspaceId,
        accountId: member.accountId,
        status: member.status,
        memberJson: member,
        createdAt: member.createdAt,
        updatedAt: member.updatedAt,
      })
      .onConflictDoNothing({
        target: [
          pgSchema.workspaceMembers.workspaceId,
          pgSchema.workspaceMembers.accountId,
        ],
      })
      .returning({ id: pgSchema.workspaceMembers.id });
    return rows.length === 1;
  }

  async #workspaceMemberMutationSnapshot(
    transaction: SqlTransaction,
    expectedWorkspace: Workspace,
    accountIds: readonly string[],
  ): Promise<WorkspaceMemberMutationSnapshot | undefined> {
    const workspaceRows = await transaction.query<PgWorkspaceMutationWorkspaceRow>(
      `select id,
              handle,
              space_json as "spaceJson",
              workspace_type as "workspaceType",
              owner_user_id as "ownerUserId",
              created_at as "createdAt"
         from takosumi_workspaces
        where id = $1
        for update`,
      [expectedWorkspace.id],
    );
    const workspaceRow = workspaceRows.rows[0];
    if (workspaceRow === undefined) return undefined;
    const currentWorkspace = parseJson(workspaceRow.spaceJson) as
      | Workspace
      | undefined;
    if (
      currentWorkspace === undefined ||
      !workspaceMutationRowMatches(
        workspaceRow,
        currentWorkspace,
        expectedWorkspace,
      )
    ) {
      return undefined;
    }
    const sortedAccountIds = [...new Set(accountIds)].sort();
    if (sortedAccountIds.length === 0) {
      // Namespace-owner authority deliberately bypasses the derived member
      // roster. Keep the exact Workspace evidence above while avoiding a
      // malformed/stale owner member row becoming an unrelated dependency.
      return { workspace: currentWorkspace, members: [] };
    }
    const accountPlaceholders = sortedAccountIds
      .map((_, index) => `$${index + 2}`)
      .join(", ");
    const memberRows = await transaction.query<PgWorkspaceMemberRow>(
      `select id,
              workspace_id as "workspaceId",
              account_id as "accountId",
              status,
              member_json as "recordJson",
              created_at as "createdAt",
              updated_at as "updatedAt"
         from takosumi_workspace_members
        where workspace_id = $1
          and account_id in (${accountPlaceholders})
        order by account_id, id
        for update`,
      [expectedWorkspace.id, ...sortedAccountIds],
    );
    const members = memberRows.rows.map((row) =>
      workspaceMemberFromRow(row, {
        workspaceId: expectedWorkspace.id,
        accountId: row.accountId,
      }),
    );
    return { workspace: currentWorkspace, members };
  }

  /**
   * Revalidate an account-facing Connection command against the exact
   * Workspace/member snapshot captured before its asynchronous preparation.
   * The caller already holds the Workspace management lock; this helper then
   * takes the canonical Workspace/member snapshot lock before any
   * Connection/blob lock or write.  A null authority is the explicit trusted
   * internal path and deliberately keeps the historical behavior unchanged.
   */
  async #connectionActorAuthorityMatches(
    transaction: SqlTransaction,
    authority: ConnectionActorAuthority | null,
  ): Promise<boolean> {
    if (authority === null) return true;
    if (!workspaceAccountAuthorityAllowed(authority)) return false;

    let snapshot: WorkspaceMemberMutationSnapshot | undefined;
    try {
      snapshot = await this.#workspaceMemberMutationSnapshot(
        transaction,
        authority.expectedWorkspace,
        authority.expectedWorkspace.ownerUserId === authority.actorAccountId
          ? []
          : [authority.actorAccountId],
      );
    } catch (error) {
      // A malformed canonical member row is an authority denial for this
      // command; unrelated SQL/storage failures must remain visible.
      if (error instanceof WorkspaceMemberRowError) return false;
      throw error;
    }
    if (snapshot === undefined) return false;

    // Namespace owners are authoritative even when the roster has no member
    // row. The exact Workspace snapshot above still fences an owner change.
    if (snapshot.workspace.ownerUserId === authority.actorAccountId) {
      return workspaceAccountAuthorityAllowed({
        actorAccountId: authority.actorAccountId,
        expectedWorkspace: snapshot.workspace,
      });
    }

    const expectedActor = authority.expectedActor;
    const currentActor = snapshot.members.find(
      (member) => member.accountId === authority.actorAccountId,
    );
    if (
      expectedActor === undefined ||
      currentActor === undefined ||
      !workspaceMemberLogicalEquals(currentActor, expectedActor)
    ) {
      return false;
    }
    return workspaceAccountAuthorityAllowed({
      actorAccountId: authority.actorAccountId,
      expectedWorkspace: snapshot.workspace,
      expectedActor: currentActor,
    });
  }

  async #workspaceMemberHasAnotherActiveOwner(
    transaction: SqlTransaction,
    workspaceId: string,
    excludedAccountId: string,
  ): Promise<boolean> {
    const rows = await transaction.query<{ readonly id: string }>(
      `select id
         from takosumi_workspace_members
        where workspace_id = $1
          and account_id <> $2
          and status = 'active'
          and length(id) > 0
          and member_json ->> 'id' = id
          and member_json ->> 'workspaceId' = workspace_id
          and member_json ->> 'accountId' = account_id
          and member_json ->> 'status' = status
          and member_json ->> 'createdAt' = created_at
          and member_json ->> 'updatedAt' = updated_at
          and case
                when pg_input_is_valid(member_json ->> 'createdAt', 'timestamptz')
                  then to_char(
                    (member_json ->> 'createdAt')::timestamptz at time zone 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                  ) = member_json ->> 'createdAt'
                else false
              end
          and case
                when pg_input_is_valid(member_json ->> 'updatedAt', 'timestamptz')
                  then to_char(
                    (member_json ->> 'updatedAt')::timestamptz at time zone 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                  ) = member_json ->> 'updatedAt'
                else false
              end
          and jsonb_typeof(member_json -> 'roles') = 'array'
          and member_json -> 'roles' ? 'owner'
          and (
            select count(*)
              from jsonb_array_elements(
                case
                  when jsonb_typeof(member_json -> 'roles') = 'array'
                    then member_json -> 'roles'
                  else '[]'::jsonb
                end
              ) as role(value)
             where jsonb_typeof(role.value) <> 'string'
                or role.value #>> '{}' not in ('owner', 'admin', 'member', 'viewer')
          ) = 0
          and (
            select count(*)
              from jsonb_array_elements(
                case
                  when jsonb_typeof(member_json -> 'roles') = 'array'
                    then member_json -> 'roles'
                  else '[]'::jsonb
                end
              ) as role(value)
          ) = (
            select count(distinct role.value #>> '{}')
              from jsonb_array_elements(
                case
                  when jsonb_typeof(member_json -> 'roles') = 'array'
                    then member_json -> 'roles'
                  else '[]'::jsonb
                end
              ) as role(value)
          )
        limit 1`,
      [workspaceId, excludedAccountId],
    );
    return rows.rows.length > 0;
  }

  async getWorkspaceMember(
    workspaceId: string,
    accountId: string,
  ): Promise<WorkspaceMember | undefined> {
    // One decoder across both dialects and the bounded PAT reader: a persisted
    // record that is not a well-formed membership is corruption, not a member.
    const record = await this.#pgFirstJson<unknown>(
      pgSchema.workspaceMembers,
      pgSchema.workspaceMembers.memberJson,
      and(
        eq(pgSchema.workspaceMembers.workspaceId, workspaceId),
        eq(pgSchema.workspaceMembers.accountId, accountId),
      ),
    );
    return record === undefined
      ? undefined
      : parseWorkspaceMemberRecord(record);
  }

  async listWorkspaceMembers(
    workspaceId: string,
  ): Promise<readonly WorkspaceMember[]> {
    return await this.#pgManyJson<WorkspaceMember>(
      pgSchema.workspaceMembers,
      pgSchema.workspaceMembers.memberJson,
      {
        where: eq(pgSchema.workspaceMembers.workspaceId, workspaceId),
        orderBy: [
          asc(pgSchema.workspaceMembers.createdAt),
          asc(pgSchema.workspaceMembers.id),
        ],
      },
    );
  }

  async listWorkspaceMembersByAccount(
    accountId: string,
  ): Promise<readonly WorkspaceMember[]> {
    return await this.#pgManyJson<WorkspaceMember>(
      pgSchema.workspaceMembers,
      pgSchema.workspaceMembers.memberJson,
      {
        where: eq(pgSchema.workspaceMembers.accountId, accountId),
        orderBy: [
          asc(pgSchema.workspaceMembers.createdAt),
          asc(pgSchema.workspaceMembers.id),
        ],
      },
    );
  }

  async listWorkspacesForAccountPage(
    accountId: string,
    params: AccountWorkspaceListParams,
  ): Promise<AccountWorkspacePage> {
    const includeArchived = params.includeArchived === true;
    const order = params.order ?? "created_asc";
    const limit = clampPageLimit(params.limit);
    const baseFilter = and(
      eq(pgSchema.workspaceMembers.accountId, accountId),
      eq(pgSchema.workspaceMembers.status, "active"),
      includeArchived
        ? undefined
        : sql`COALESCE(${pgSchema.workspaces.spaceJson} ->> 'archivedAt', '') = ''`,
    );
    const total =
      params.includeTotal === false
        ? undefined
        : Number(
            (
              await this.#db
                .select({ total: sql<number>`count(*)` })
                .from(pgSchema.workspaceMembers)
                .innerJoin(
                  pgSchema.workspaces,
                  eq(
                    pgSchema.workspaces.id,
                    pgSchema.workspaceMembers.workspaceId,
                  ),
                )
                .where(baseFilter)
            )[0]?.total ?? 0,
          );
    const cursor = decodeCursor(params.cursor);
    const pageFilter =
      order === "updated_desc"
        ? pgWorkspaceUpdatedDescKeysetWhere(baseFilter, cursor)
        : pgKeysetWhere(
            baseFilter,
            pgSchema.workspaces.createdAt,
            pgSchema.workspaces.id,
            cursor,
          );
    const query = this.#db
      .select({ json: pgSchema.workspaces.spaceJson })
      .from(pgSchema.workspaceMembers)
      .innerJoin(
        pgSchema.workspaces,
        eq(pgSchema.workspaces.id, pgSchema.workspaceMembers.workspaceId),
      )
      .where(pageFilter)
      .$dynamic();
    const ordered =
      order === "updated_desc"
        ? query.orderBy(
            desc(pgSchema.workspaces.updatedAt),
            asc(pgSchema.workspaces.id),
          )
        : query.orderBy(
            asc(pgSchema.workspaces.createdAt),
            asc(pgSchema.workspaces.id),
          );
    const workspaces = (await ordered.limit(limit + 1)).map(
      (row) => parseRow(row) as Workspace,
    );
    const page = pageFromProbeBy(workspaces, limit, (workspace) => ({
      createdAt:
        order === "updated_desc" ? workspace.updatedAt : workspace.createdAt,
      id: workspace.id,
    }));
    return { ...page, ...(total === undefined ? {} : { total }) };
  }

  async putProject(project: Project): Promise<Project> {
    await this.#db
      .insert(pgSchema.projects)
      .values({
        id: project.id,
        workspaceId: project.workspaceId,
        name: project.name,
        slug: project.slug,
        projectJson: project,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      })
      .onConflictDoUpdate({
        target: pgSchema.projects.id,
        set: {
          workspaceId: project.workspaceId,
          name: project.name,
          slug: project.slug,
          projectJson: project,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
        },
      });
    return project;
  }

  async createProjectRecord(
    input: ProjectCreationInput,
  ): Promise<ProjectCreationResult> {
    const { project, expectedWorkspaceManagementAuthority } = input;
    if (expectedWorkspaceManagementAuthority !== undefined) {
      assertWorkspaceManagementAuthorityInput(
        expectedWorkspaceManagementAuthority,
        project.workspaceId,
      );
    }
    return await this.#client.transaction(async (transaction) => {
      // Workspace is the outer lock for this create-only operation. Existing
      // id/slug observations are classified before the mutable admission
      // check so exact retries and ordinary conflicts remain readable while a
      // Workspace is draining.
      const management = await pgWorkspaceManagementForTransaction(
        transaction,
        project.workspaceId,
      );
      const currentRows = await transaction.query<PgProjectRow>(
        `select id,
                workspace_id as "workspaceId",
                name,
                slug,
                project_json as "projectJson",
                created_at as "createdAt",
                updated_at as "updatedAt"
           from takosumi_projects
          where id = $1
          for update`,
        [project.id],
      );
      const currentRow = currentRows.rows[0];
      if (currentRow) {
        // The persisted physical owner is authoritative; a caller cannot
        // rebind an occupied id to another Workspace or repair JSON drift.
        if (currentRow.workspaceId !== project.workspaceId) {
          return { status: "conflict" as const };
        }
        const current = projectFromPgRow(currentRow);
        if (!current) return { status: "conflict" as const };
        return (await stableJsonDigest(current)) ===
            (await stableJsonDigest(project))
          ? { status: "replayed" as const, project: current }
          : { status: "conflict" as const };
      }

      // A different id occupying this Workspace/slug is a read-only conflict;
      // the database unique index remains the final race-safe authority below.
      const slugRows = await transaction.query<PgProjectRow>(
        `select id,
                workspace_id as "workspaceId",
                name,
                slug,
                project_json as "projectJson",
                created_at as "createdAt",
                updated_at as "updatedAt"
           from takosumi_projects
          where workspace_id = $1
            and slug = $2
          for update`,
        [project.workspaceId, project.slug],
      );
      if (slugRows.rows[0]) return { status: "conflict" as const };

      assertWorkspaceManagementAdmission(
        management,
        project.workspaceId,
        expectedWorkspaceManagementAuthority,
      );
      const expectedEpochPredicate =
        expectedWorkspaceManagementAuthority === undefined
          ? ""
          : "\n            and workspace.management_epoch = $8";
      const inserted = await transaction.query<PgProjectRow>(
        `insert into takosumi_projects
          (id, workspace_id, name, slug, project_json, created_at, updated_at)
         select $1, workspace.id, $2, $3, $4::jsonb, $5, $6
           from takosumi_workspaces as workspace
          where workspace.id = $7
            and workspace.management_state = 'active'${expectedEpochPredicate}
         on conflict do nothing
         returning id,
                   workspace_id as "workspaceId",
                   name,
                   slug,
                   project_json as "projectJson",
                   created_at as "createdAt",
                   updated_at as "updatedAt"`,
        [
          project.id,
          project.name,
          project.slug,
          JSON.stringify(project),
          project.createdAt,
          project.updatedAt,
          project.workspaceId,
          ...(expectedWorkspaceManagementAuthority === undefined
            ? []
            : [expectedWorkspaceManagementAuthority.managementEpoch]),
        ],
      );
      const insertedRow = inserted.rows[0];
      const created = insertedRow
        ? projectFromPgRow(insertedRow)
        : undefined;
      if (created) return { status: "created" as const, project: created };

      // A raw concurrent writer may have won the id/slug race while this
      // transaction was waiting. Classify an exact id candidate as replay,
      // otherwise preserve the create-only conflict boundary.
      const afterIdRows = await transaction.query<PgProjectRow>(
        `select id,
                workspace_id as "workspaceId",
                name,
                slug,
                project_json as "projectJson",
                created_at as "createdAt",
                updated_at as "updatedAt"
           from takosumi_projects
          where id = $1
          limit 1`,
        [project.id],
      );
      const afterId = afterIdRows.rows[0];
      if (afterId) {
        if (afterId.workspaceId !== project.workspaceId) {
          return { status: "conflict" as const };
        }
        const persisted = projectFromPgRow(afterId);
        if (
          persisted &&
          (await stableJsonDigest(persisted)) ===
            (await stableJsonDigest(project))
        ) {
          return { status: "replayed" as const, project: persisted };
        }
        return { status: "conflict" as const };
      }
      const afterSlugRows = await transaction.query<PgProjectRow>(
        `select id,
                workspace_id as "workspaceId",
                name,
                slug,
                project_json as "projectJson",
                created_at as "createdAt",
                updated_at as "updatedAt"
           from takosumi_projects
          where workspace_id = $1
            and slug = $2
          limit 1`,
        [project.workspaceId, project.slug],
      );
      if (afterSlugRows.rows[0]) return { status: "conflict" as const };
      // A row-less insert can only have lost the persisted Workspace predicate
      // (including a missing/stale epoch); surface that as the typed admission
      // refusal rather than claiming a successful create.
      assertWorkspaceManagementAdmission(
        undefined,
        project.workspaceId,
        expectedWorkspaceManagementAuthority,
      );
      return { status: "conflict" as const };
    });
  }

  async getProject(id: string): Promise<Project | undefined> {
    return await this.#pgFirstJson<Project>(
      pgSchema.projects,
      pgSchema.projects.projectJson,
      eq(pgSchema.projects.id, id),
    );
  }

  async getProjectBySlug(
    workspaceId: string,
    slug: string,
  ): Promise<Project | undefined> {
    return await this.#pgFirstJson<Project>(
      pgSchema.projects,
      pgSchema.projects.projectJson,
      and(
        eq(pgSchema.projects.workspaceId, workspaceId),
        eq(pgSchema.projects.slug, slug),
      ),
    );
  }

  async listProjectsByWorkspace(
    workspaceId: string,
  ): Promise<readonly Project[]> {
    return await this.#pgManyJson<Project>(
      pgSchema.projects,
      pgSchema.projects.projectJson,
      {
        where: eq(pgSchema.projects.workspaceId, workspaceId),
        orderBy: [asc(pgSchema.projects.createdAt), asc(pgSchema.projects.id)],
      },
    );
  }

  // --- install_configs (§11) ------------------------------------------------

  async putInstallConfig(config: InstallConfig): Promise<InstallConfig> {
    const publicConfig = publicStoredInstallConfig(config);
    const configJson = installConfigJsonPreservingAuthority(publicConfig);
    const written = await this.#db
      .insert(pgSchema.installConfigs)
      .values({
        id: publicConfig.id,
        workspaceId: publicConfig.workspaceId ?? null,
        configJson: publicConfig,
        createdAt: publicConfig.createdAt,
        updatedAt: publicConfig.updatedAt,
      })
      .onConflictDoUpdate({
        target: pgSchema.installConfigs.id,
        set: {
          workspaceId: publicConfig.workspaceId ?? null,
          configJson,
          createdAt: publicConfig.createdAt,
          updatedAt: publicConfig.updatedAt,
        },
        // A stored private tuple pins the row to its original Workspace. An
        // ordinary config without that key retains the historical full-write
        // behavior; the SQL predicate makes the metadata-bearing decision
        // atomic with the upsert itself.
        setWhere: or(
          sql`NOT (${pgSchema.installConfigs.configJson} ? 'workspaceManagementAuthority')`,
          and(
            publicConfig.workspaceId === undefined
              ? isNull(pgSchema.installConfigs.workspaceId)
              : eq(
                  pgSchema.installConfigs.workspaceId,
                  publicConfig.workspaceId,
                ),
            sql`${pgSchema.installConfigs.configJson} ->> 'id' = ${publicConfig.id}`,
            publicConfig.workspaceId === undefined
              ? sql`${pgSchema.installConfigs.configJson} ->> 'workspaceId' IS NULL`
              : sql`${pgSchema.installConfigs.configJson} ->> 'workspaceId' = ${publicConfig.workspaceId}`,
          ),
        ),
      })
      .returning({ id: pgSchema.installConfigs.id });
    if (written.length === 0) {
      // A zero-row upsert means the private metadata fence rejected the
      // candidate (or the row disappeared between the conflict and return).
      // Never report a successful write when PostgreSQL did not publish one.
      throw new TypeError(
        "InstallConfig management authority belongs to its original Workspace",
      );
    }
    return publicConfig;
  }

  async createInstallConfigIfAbsent(
    config: InstallConfig,
    expectedWorkspaceManagementAuthority?: WorkspaceManagementAuthority,
  ): Promise<boolean> {
    const publicConfig = publicStoredInstallConfig(config);
    const workspaceId = config.workspaceId;
    if (workspaceId === undefined) {
      if (expectedWorkspaceManagementAuthority !== undefined) {
        throw new TypeError(
          "Workspace-neutral InstallConfig cannot carry Workspace management authority",
        );
      }
      const existing = await this.#db
        .select({ id: pgSchema.installConfigs.id })
        .from(pgSchema.installConfigs)
        .where(eq(pgSchema.installConfigs.id, publicConfig.id))
        .limit(1);
      if (existing[0] !== undefined) return false;
      const stored = storeInstallConfig(config);
      const rows = await this.#db
        .insert(pgSchema.installConfigs)
        .values({
          id: stored.id,
          workspaceId: null,
          configJson: stored,
          createdAt: stored.createdAt,
          updatedAt: stored.updatedAt,
        })
        .onConflictDoNothing({ target: pgSchema.installConfigs.id })
        .returning({ id: pgSchema.installConfigs.id });
      return rows.length === 1;
    }

    // Validate caller-captured authority before opening a transaction or
    // issuing any database write. The persisted Workspace row remains the
    // authority for the admission decision below.
    if (expectedWorkspaceManagementAuthority !== undefined) {
      assertWorkspaceManagementAuthorityInput(
        expectedWorkspaceManagementAuthority,
        workspaceId,
      );
    }

    return await this.#client.transaction(async (transaction) => {
      // Workspace is the outer lock for this create-only operation. Existing
      // config ids are read-only observations, so retries remain available
      // while management is draining; only a genuinely new row is admitted.
      const management = await pgWorkspaceManagementForTransaction(
        transaction,
        workspaceId,
      );
      const current = await transaction.query<{ readonly id: string }>(
        `select id
           from takosumi_install_configs
          where id = $1
          for update`,
        [config.id],
      );
      if (current.rows[0] !== undefined) return false;

      assertWorkspaceManagementAdmission(
        management,
        workspaceId,
        expectedWorkspaceManagementAuthority,
      );
      const stored = storeInstallConfig(
        config,
        expectedWorkspaceManagementAuthority,
      );

      // Keep the admission predicate in the write itself. This protects the
      // row publication boundary if a future caller changes the lock scope,
      // and pins an optional captured epoch without introducing a sentinel.
      const expectedEpochPredicate =
        expectedWorkspaceManagementAuthority === undefined
          ? ""
          : "\n            and workspace.management_epoch = $6";
      const inserted = await transaction.query<{ readonly id: string }>(
        `insert into takosumi_install_configs
          (id, space_id, config_json, created_at, updated_at)
         select $1, workspace.id, $2::jsonb, $3, $4
           from takosumi_workspaces as workspace
          where workspace.id = $5
            and workspace.management_state = 'active'${expectedEpochPredicate}
         on conflict (id) do nothing
         returning id`,
        [
          stored.id,
          JSON.stringify(stored),
          stored.createdAt,
          stored.updatedAt,
          workspaceId,
          ...(expectedWorkspaceManagementAuthority === undefined
            ? []
            : [expectedWorkspaceManagementAuthority.managementEpoch]),
        ],
      );
      if (inserted.rows.length > 0) return true;

      // A competing raw writer may have won the id race. Classify that as an
      // ordinary existing row rather than retrying or overwriting it.
      const after = await transaction.query<{ readonly id: string }>(
        `select id
           from takosumi_install_configs
          where id = $1
          limit 1`,
        [config.id],
      );
      if (after.rows[0] !== undefined) return false;

      // No row was published and no competing id exists. This can only be a
      // failed persisted Workspace predicate (missing/stopped/stale), which
      // must remain a typed admission refusal rather than a false success.
      assertWorkspaceManagementAdmission(
        undefined,
        workspaceId,
        expectedWorkspaceManagementAuthority,
      );
      return false;
    });
  }

  async replaceUnreferencedSharedInstallConfig(
    expected: InstallConfig,
    replacement: InstallConfig,
  ): Promise<boolean> {
    const publicExpected = publicStoredInstallConfig(expected);
    const publicReplacement = publicStoredInstallConfig(replacement);
    if (
      publicReplacement.id !== publicExpected.id ||
      publicExpected.workspaceId !== undefined ||
      publicReplacement.workspaceId !== undefined
    ) {
      return false;
    }
    const referenced = this.#db
      .select({ id: pgSchema.capsules.id })
      .from(pgSchema.capsules)
      .where(eq(pgSchema.capsules.installConfigId, expected.id));
    const rows = await this.#db
      .update(pgSchema.installConfigs)
      .set({
        workspaceId: null,
        configJson: publicReplacement,
        updatedAt: publicReplacement.updatedAt,
      })
      .where(
        and(
          eq(pgSchema.installConfigs.id, publicExpected.id),
          isNull(pgSchema.installConfigs.workspaceId),
          eq(pgSchema.installConfigs.configJson, publicExpected),
          notExists(referenced),
        ),
      )
      .returning({ id: pgSchema.installConfigs.id });
    return rows.length === 1;
  }

  async getInstallConfig(id: string): Promise<InstallConfig | undefined> {
    const config = await this.#pgFirstJson<InstallConfig>(
      pgSchema.installConfigs,
      pgSchema.installConfigs.configJson,
      eq(pgSchema.installConfigs.id, id),
    );
    return config ? publicStoredInstallConfig(config) : undefined;
  }

  async getInstallConfigManagementAuthority(
    id: string,
  ): Promise<WorkspaceManagementAuthority | undefined> {
    const config = await this.#pgFirstJson<InstallConfig>(
      pgSchema.installConfigs,
      pgSchema.installConfigs.configJson,
      eq(pgSchema.installConfigs.id, id),
    );
    return config ? installConfigManagementAuthority(config) : undefined;
  }

  async getInstallConfigsByIds(
    ids: readonly string[],
  ): Promise<readonly InstallConfig[]> {
    if (ids.length === 0) return [];
    const rows = await this.#db
      .select({ json: pgSchema.installConfigs.configJson })
      .from(pgSchema.installConfigs)
      .where(inArray(pgSchema.installConfigs.id, [...new Set(ids)]));
    const byId = new Map(
      rows.map((row) => {
        const value = publicStoredInstallConfig(
          parseRow(row) as InstallConfig,
        );
        return [value.id, value] as const;
      }),
    );
    return ids
      .map((id) => byId.get(id))
      .filter((row): row is InstallConfig => row !== undefined);
  }

  async listInstallConfigs(
    workspaceId?: string,
  ): Promise<readonly InstallConfig[]> {
    const configs = await this.#pgManyJson<InstallConfig>(
      pgSchema.installConfigs,
      pgSchema.installConfigs.configJson,
      {
        where:
          workspaceId === undefined
            ? undefined
            : eq(pgSchema.installConfigs.workspaceId, workspaceId),
        orderBy: [
          asc(pgSchema.installConfigs.createdAt),
          asc(pgSchema.installConfigs.id),
        ],
      },
    );
    return configs.map(publicStoredInstallConfig);
  }

  async listSharedInstallConfigs(): Promise<readonly InstallConfig[]> {
    const configs = await this.#pgManyJson<InstallConfig>(
      pgSchema.installConfigs,
      pgSchema.installConfigs.configJson,
      {
        where: isNull(pgSchema.installConfigs.workspaceId),
        orderBy: [
          asc(pgSchema.installConfigs.createdAt),
          asc(pgSchema.installConfigs.id),
        ],
      },
    );
    return configs.map(publicStoredInstallConfig);
  }

  async listInstallConfigsPage(
    workspaceId: string,
    params: PageParams,
  ): Promise<Page<InstallConfig>> {
    return await this.#listExactInstallConfigScopePage(
      eq(pgSchema.installConfigs.workspaceId, workspaceId),
      params,
    );
  }

  async listSharedInstallConfigsPage(
    params: PageParams,
  ): Promise<Page<InstallConfig>> {
    return await this.#listExactInstallConfigScopePage(
      isNull(pgSchema.installConfigs.workspaceId),
      params,
    );
  }

  async #listExactInstallConfigScopePage(
    baseWhere: SQL,
    params: PageParams,
  ): Promise<Page<InstallConfig>> {
    const limit = clampPageLimit(params.limit);
    const rows = await this.#pgManyJson<InstallConfig>(
      pgSchema.installConfigs,
      pgSchema.installConfigs.configJson,
      {
        where: pgKeysetWhere(
          baseWhere,
          pgSchema.installConfigs.createdAt,
          pgSchema.installConfigs.id,
          decodeCursor(params.cursor),
        ),
        orderBy: [
          asc(pgSchema.installConfigs.createdAt),
          asc(pgSchema.installConfigs.id),
        ],
        limit: limit + 1,
      },
    );
    return pageFromProbe(rows.map(publicStoredInstallConfig), limit);
  }

  // --- Capsules (§5 / §27, active UNIQUE(project_id, name, environment)) ---

  async putCapsule(capsule: Capsule): Promise<Capsule> {
    const values = capsuleValues(capsule);
    await this.#db
      .insert(pgSchema.capsules)
      .values(values)
      .onConflictDoUpdate({
        target: pgSchema.capsules.id,
        set: {
          workspaceId: values.workspaceId,
          projectId: values.projectId,
          name: values.name,
          environment: values.environment,
          sourceId: values.sourceId,
          installConfigId: values.installConfigId,
          currentStateVersionId: values.currentStateVersionId,
          status: values.status,
          capsuleJson: values.capsuleJson,
          createdAt: values.createdAt,
          updatedAt: values.updatedAt,
        },
      });
    return normalizeCapsuleRecord(capsule);
  }

  async createCapsuleInitialAuthority(
    input: CapsuleInitialAuthorityInput,
  ): Promise<CapsuleInitialAuthorityResult> {
    const capsule = normalizeCapsuleRecord(input.capsule);
    if (input.expectedWorkspaceManagementAuthority !== undefined) {
      assertWorkspaceManagementAuthorityInput(
        input.expectedWorkspaceManagementAuthority,
        capsule.workspaceId,
      );
    }
    const binding = input.providerBindingSet;
    const installConfig = publicStoredInstallConfig(input.installConfig);
    if (
      installConfig.id !== capsule.installConfigId ||
      installConfig.workspaceId !== capsule.workspaceId ||
      binding.workspaceId !== capsule.workspaceId ||
      binding.capsuleId !== capsule.id ||
      binding.environment !== capsule.environment
    ) {
      return { status: "conflict" };
    }
    return await this.#client.transaction(async (transaction) => {
      const db = this.#drizzleForClient(transaction);
      // Workspace is the outer lock for this multi-row create. Existing exact
      // rows are idempotent reads and may be adopted while draining; a new
      // authority unit is admitted only after this persisted row is locked.
      const management = await pgWorkspaceManagementForTransaction(
        transaction,
        capsule.workspaceId,
      );
      // Initial authority is rare and must be one exact create-or-replay CAS.
      // Serialize every candidate across the three tables so two concurrent
      // first-install requests cannot both observe absence and turn a unique
      // constraint into an indeterminate transport-style failure.
      await transaction.query(
        `lock table takosumi_install_configs,
                    takosumi_capsules,
                    takosumi_provider_env_binding_sets
           in share row exclusive mode`,
      );
      const [configRows, capsuleRows, bindingRows] = await Promise.all([
        db
          .select({ json: pgSchema.installConfigs.configJson })
          .from(pgSchema.installConfigs)
          .where(eq(pgSchema.installConfigs.id, input.installConfig.id))
          .limit(1),
        db
          .select({
            json: pgSchema.capsules.capsuleJson,
            epoch: pgSchema.capsules.executionAuthorityEpoch,
          })
          .from(pgSchema.capsules)
          .where(eq(pgSchema.capsules.id, capsule.id))
          .limit(1),
        db
          .select({ json: pgSchema.providerBindingSets.profileJson })
          .from(pgSchema.providerBindingSets)
          .where(
            or(
              eq(pgSchema.providerBindingSets.id, binding.id),
              and(
                eq(pgSchema.providerBindingSets.capsuleId, capsule.id),
                eq(
                  pgSchema.providerBindingSets.environment,
                  capsule.environment,
                ),
              ),
            ),
          ),
      ]);
      const bindingRow = bindingRows.find((row) => {
        const candidate = parseJson(row.json) as ProviderBindingSet;
        return candidate.id === binding.id;
      });
      const bindingSlotRow = bindingRows.find((row) => {
        const candidate = parseJson(row.json) as ProviderBindingSet;
        return candidate.capsuleId === capsule.id &&
          candidate.environment === capsule.environment;
      });
      if (
        configRows[0] ||
        capsuleRows[0] ||
        bindingRow ||
        bindingSlotRow
      ) {
        if (
          !configRows[0] ||
          !capsuleRows[0] ||
          !bindingRow ||
          bindingSlotRow !== bindingRow
        ) {
          return { status: "conflict" as const };
        }
        const [configDigest, capsuleDigest, bindingDigest] = await Promise.all([
          stableJsonDigest(
            publicStoredInstallConfig(parseJson(configRows[0].json) as InstallConfig),
          ),
          stableJsonDigest(
            normalizeCapsuleRecord(parseJson(capsuleRows[0].json) as Capsule),
          ),
          stableJsonDigest(parseJson(bindingRow.json)),
        ]);
        const [expectedConfig, expectedCapsule, expectedBinding] =
          await Promise.all([
            stableJsonDigest(installConfig),
            stableJsonDigest(capsule),
            stableJsonDigest(binding),
          ]);
        return capsuleRows[0].epoch === 1 &&
            configDigest === expectedConfig &&
            capsuleDigest === expectedCapsule &&
            bindingDigest === expectedBinding
          ? { status: "replayed" as const, capsule }
          : { status: "conflict" as const };
      }
      const duplicate = await db
        .select({ id: pgSchema.capsules.id })
        .from(pgSchema.capsules)
        .where(
          and(
            eq(pgSchema.capsules.projectId, capsule.projectId),
            eq(pgSchema.capsules.name, capsule.name),
            eq(pgSchema.capsules.environment, capsule.environment),
            ne(pgSchema.capsules.status, "destroyed"),
          ),
        )
        .limit(1);
      if (duplicate[0]) return { status: "conflict" as const };
      assertWorkspaceManagementAdmission(
        management,
        capsule.workspaceId,
        input.expectedWorkspaceManagementAuthority,
      );
      await db.insert(pgSchema.installConfigs).values({
        id: installConfig.id,
        workspaceId: installConfig.workspaceId ?? null,
        configJson: installConfig,
        createdAt: installConfig.createdAt,
        updatedAt: installConfig.updatedAt,
      });
      await db.insert(pgSchema.capsules).values(capsuleValues(capsule));
      await db.insert(pgSchema.providerBindingSets).values({
        id: binding.id,
        workspaceId: binding.workspaceId,
        capsuleId: binding.capsuleId,
        environment: binding.environment,
        profileJson: binding,
        createdAt: binding.createdAt,
        updatedAt: binding.updatedAt,
      });
      return { status: "created" as const, capsule };
    });
  }

  async resolveCapsuleExecutionAuthority(
    workspaceId: string,
    capsuleId: string,
  ): Promise<CapsuleExecutionAuthority | undefined> {
    const latestSafety = this.#db
      .select({ json: pgSchema.runs.runJson })
      .from(pgSchema.runs)
      .where(pgRuntimeSafetyCandidateWhere(capsuleId))
      .orderBy(
        desc(pgRunRuntimeSafetyInFlightOrder()),
        desc(pgRunRuntimeSafetyEffectAtMillisOrder()),
        desc(pgRunRuntimeSafetyRiskOrder()),
        desc(pgSchema.runs.id),
      )
      .limit(1)
      .as("latest_capsule_runtime_safety");
    const rows = await this.#db
      .select({
        epoch: pgSchema.capsules.executionAuthorityEpoch,
        safetyJson: latestSafety.json,
      })
      .from(pgSchema.capsules)
      .leftJoin(latestSafety, sql`true`)
      .where(
        and(
          eq(pgSchema.capsules.id, capsuleId),
          eq(pgSchema.capsules.workspaceId, workspaceId),
          ne(pgSchema.capsules.status, "destroyed"),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (row === undefined) return undefined;
    const safety =
      row.safetyJson === null
        ? undefined
        : capsuleRuntimeSafetyFromRun(
            parseJson(row.safetyJson) as ApplyRun | Run,
          );
    return safety !== undefined && safety.phase !== "safe"
      ? undefined
      : {
          workspaceId,
          capsuleId,
          executionAuthorityEpoch: row.epoch,
        };
  }

  async resolveCapsuleExecutionAuthorities(
    inputs: readonly CapsuleExecutionAuthorityInput[],
  ): Promise<readonly (CapsuleExecutionAuthority | undefined)[]> {
    if (inputs.length === 0) return [];
    const rows = await this.#client.query<{
      readonly request_index: number | string;
      readonly epoch: number | string | null;
      readonly safety_json: unknown | null;
    }>(PG_CAPSULE_EXECUTION_AUTHORITY_BATCH_SQL, [JSON.stringify(inputs)]);
    const resolved: (CapsuleExecutionAuthority | undefined)[] = inputs.map(
      () => undefined,
    );
    for (const row of rows.rows) {
      const index = Number(row.request_index);
      const input = inputs[index];
      if (!Number.isSafeInteger(index) || index < 0 || input === undefined) {
        throw new Error(
          "Postgres Capsule execution-authority batch index is invalid",
        );
      }
      if (row.epoch === null) continue;
      const safety =
        row.safety_json === null
          ? undefined
          : capsuleRuntimeSafetyFromRun(
              parseJson(row.safety_json) as ApplyRun | Run,
            );
      if (safety !== undefined && safety.phase !== "safe") continue;
      resolved[index] = {
        workspaceId: input.workspaceId,
        capsuleId: input.capsuleId,
        executionAuthorityEpoch: Number(row.epoch),
      };
    }
    return resolved;
  }

  async getCapsuleExecutionAuthorityEpoch(
    capsuleId: string,
  ): Promise<number | undefined> {
    const rows = await this.#db
      .select({ epoch: pgSchema.capsules.executionAuthorityEpoch })
      .from(pgSchema.capsules)
      .where(eq(pgSchema.capsules.id, capsuleId))
      .limit(1);
    return rows[0]?.epoch;
  }

  async rebindCapsuleInstallConfig(
    input: CapsuleInstallConfigRebindInput,
  ): Promise<CapsuleInstallConfigRebindResult> {
    const expectedManagementAuthority = input.expectedWorkspaceManagementAuthority
      ? { ...input.expectedWorkspaceManagementAuthority }
      : undefined;
    // Validate the shape before opening a transaction, then validate the
    // captured owner again against the Capsule's persisted Workspace below.
    // The current Workspace row is the authority for admission; callers must
    // not refresh a stale captured epoch here.
    if (expectedManagementAuthority !== undefined) {
      assertWorkspaceManagementAuthorityInput(
        expectedManagementAuthority,
        expectedManagementAuthority.workspaceId,
      );
    }
    return await this.#client.transaction(async (transaction) => {
      const db = this.#drizzleForClient(transaction);
      const bindingReplacement = input.providerBindingSetReplacement;
      const capsuleRows = await db
        .select({
          json: pgSchema.capsules.capsuleJson,
          epoch: pgSchema.capsules.executionAuthorityEpoch,
          workspaceId: pgSchema.capsules.workspaceId,
        })
        .from(pgSchema.capsules)
        .where(eq(pgSchema.capsules.id, input.capsuleId))
        .limit(1);
      const capsuleRow = capsuleRows[0];
      if (!capsuleRow) return { status: "not_found" as const };
      const capsule = normalizeCapsuleRecord(
        parseJson(capsuleRow.json) as Capsule,
      );
      if (expectedManagementAuthority !== undefined) {
        assertWorkspaceManagementAuthorityInput(
          expectedManagementAuthority,
          capsuleRow.workspaceId,
        );
      }
      // Workspace is the outer lock for this authority transition. No
      // Capsule, BindingSet, InstallConfig, or intent row is locked before it;
      // this preserves the lock order used by the other guarded writers.
      const management = await pgWorkspaceManagementForTransaction(
        transaction,
        capsuleRow.workspaceId,
      );
      // ProviderBindingSet writers take ROW EXCLUSIVE table locks. This
      // stronger, replacement-only lock makes both an existing row and exact
      // absence stable through the digest check and atomic transition, after
      // the Workspace lock above (avoiding lock inversion).
      if (bindingReplacement) {
        await transaction.query(
          "lock table takosumi_provider_env_binding_sets in share row exclusive mode",
        );
      }
      const bindingRows = bindingReplacement
        ? await transaction.query<{
            readonly id: string;
            readonly capsule_id: string;
            readonly environment: string;
            readonly json: unknown;
          }>(
            `select id,
                    installation_id as capsule_id,
                    environment,
                    profile_json as json
               from takosumi_provider_env_binding_sets
              where (installation_id = $1 and environment = $2)
                 or id = $3
              order by id
              for update`,
            [
              capsule.id,
              capsule.environment,
              bindingReplacement.target.id,
            ],
          )
        : undefined;
      const currentBindingRow = bindingRows?.rows.find(
        (row) =>
          row.capsule_id === capsule.id &&
          row.environment === capsule.environment,
      );
      const currentBindingSet = currentBindingRow
        ? (parseJson(currentBindingRow.json) as ProviderBindingSet)
        : undefined;
      const targetBindingIdRow = bindingRows?.rows.find(
        (row) => row.id === bindingReplacement?.target.id,
      );
      // Lock current and target in stable id order through the Capsule CAS.
      // InstallConfig patching takes a conflicting UPDATE lock, so a patch
      // either wins before these digest checks or waits until rebind commits.
      const configRows = await transaction.query<{
        readonly id: string;
        readonly json: unknown;
      }>(
        `select id, config_json as json
           from takosumi_install_configs
          where id = $1 or id = $2
          order by id
          for share`,
        [capsule.installConfigId, input.targetInstallConfigId],
      );
      const storedConfigsById = new Map<string, StoredInstallConfig>(
        configRows.rows.map((row) => [
          row.id,
          parseJson(row.json) as StoredInstallConfig,
        ]),
      );
      const configsById = new Map<string, InstallConfig>(
        [...storedConfigsById.entries()].map(([id, config]) => [
          id,
          publicStoredInstallConfig(config),
        ] as const),
      );
      const targetStoredConfig = storedConfigsById.get(
        input.targetInstallConfigId,
      );
      const targetConfig = configsById.get(input.targetInstallConfigId);
      const recoveryProof = input.expected.committedPostApplyRecovery;
      if (
        !targetConfig ||
        (await stableJsonDigest(targetConfig)) !==
          input.expected.targetInstallConfigDigest ||
        !exactRecoveryProofsEqual(
          targetConfig.internal?.reAdoption?.committedPostApplyRecovery,
          recoveryProof,
        ) ||
        (bindingReplacement !== undefined &&
          ((await stableJsonDigest(bindingReplacement.target)) !==
              bindingReplacement.targetDigest ||
            !providerBindingSetTargetsCapsule(
              bindingReplacement.target,
              capsule,
            ) ||
            (targetBindingIdRow !== undefined &&
              targetBindingIdRow !== currentBindingRow)))
      ) {
        return { status: "conflict" as const, capsule };
      }
      if (capsule.installConfigId === input.targetInstallConfigId) {
        return bindingReplacement === undefined ||
            (currentBindingSet !== undefined &&
              (await stableJsonDigest(currentBindingSet)) ===
                bindingReplacement.targetDigest)
          ? { status: "replayed" as const, capsule }
          : { status: "conflict" as const, capsule };
      }
      // A successor carrying a re-adoption receipt is admitted only against
      // the private authority captured when that exact row was created. A
      // malformed or missing receipt is fail-closed; exact completed replays
      // above intentionally remain read-only while draining.
      const targetRequiresManagementAuthority = targetStoredConfig !== undefined
        ? installConfigRequiresManagementAuthority(targetStoredConfig)
        : targetConfig !== undefined &&
          installConfigRequiresManagementAuthority(targetConfig);
      const originalAuthority = targetStoredConfig === undefined
        ? undefined
        : installConfigManagementAuthority(targetStoredConfig);
      if (targetRequiresManagementAuthority) {
        if (originalAuthority === undefined) {
          throw new WorkspaceManagementAdmissionConflictError(
            capsuleRow.workspaceId,
          );
        }
        if (expectedManagementAuthority !== undefined) {
          assertWorkspaceManagementAdmission(
            originalAuthority,
            capsuleRow.workspaceId,
            expectedManagementAuthority,
          );
        }
        assertWorkspaceManagementAdmission(
          management,
          capsuleRow.workspaceId,
          originalAuthority,
        );
      } else {
        assertWorkspaceManagementAdmission(
          management,
          capsuleRow.workspaceId,
          expectedManagementAuthority,
        );
      }
      const currentStoredConfig = storedConfigsById.get(
        capsule.installConfigId,
      );
      const currentConfig = configsById.get(capsule.installConfigId) as
        | InstallConfig
        | undefined;
      if (
        !currentConfig ||
        capsule.installConfigId !== input.expected.installConfigId ||
        (await stableJsonDigest(currentConfig)) !==
          input.expected.installConfigDigest ||
        (bindingReplacement !== undefined &&
          ((currentBindingSet !== undefined &&
              !providerBindingSetTargetsCapsule(currentBindingSet, capsule)) ||
            (await providerBindingSetAuthorityDigest(currentBindingSet)) !==
              bindingReplacement.expectedCurrentAuthorityDigest)) ||
        capsule.currentStateGeneration !==
          input.expected.currentStateGeneration ||
        capsule.currentStateVersionId !==
          input.expected.currentStateVersionId ||
        capsule.status !== input.expected.status ||
        capsuleRow.epoch !== input.expected.executionAuthorityEpoch
      ) {
        return { status: "conflict" as const, capsule };
      }
      const safetyRows = await db
        .select({ id: pgSchema.runs.id, json: pgSchema.runs.runJson })
        .from(pgSchema.runs)
        .where(pgRuntimeSafetyCandidateWhere(input.capsuleId))
        .orderBy(
          desc(pgRunRuntimeSafetyInFlightOrder()),
          desc(pgRunRuntimeSafetyEffectAtMillisOrder()),
          desc(pgRunRuntimeSafetyRiskOrder()),
          desc(pgSchema.runs.id),
        )
        .limit(1);
      const safetyCandidate = safetyRows[0]
        ? (parseRow(safetyRows[0]) as ApplyRun | Run)
        : undefined;
      const runtimeSafety = safetyCandidate
        ? capsuleRuntimeSafetyFromRun(safetyCandidate)
        : undefined;
      const recoveryRows = recoveryProof &&
          safetyCandidate &&
          isApplyRunRecord(safetyCandidate) &&
          safetyCandidate.id === recoveryProof.failedApplyRunId
        ? await pgCommittedPostApplyRecoveryRows(
            db,
            safetyCandidate,
            recoveryProof,
          )
        : undefined;
      const committedRecoveryMatches = Boolean(
        recoveryProof &&
          recoveryRows &&
          (await committedPostApplyRecoveryProofMatches(
            recoveryProof,
            capsule,
            recoveryRows,
          )),
      );
      const runtimeSafetyPermitsRebind = recoveryProof === undefined
        ? runtimeSafety === undefined || runtimeSafety.phase === "safe"
        : runtimeSafety?.phase === "unknown" &&
          runtimeSafety.runType === "apply" &&
          runtimeSafety.runId === recoveryProof.failedApplyRunId &&
          committedRecoveryMatches;
      if (!runtimeSafetyPermitsRebind) {
        return { status: "busy" as const, capsule };
      }
      const blocking = db
        .select({ id: pgSchema.runs.id })
        .from(pgSchema.runs)
        .where(pgCapsuleInstallConfigRebindBlocked(
          input.capsuleId,
          input.expected.executionAuthorityEpoch,
        ));
      const currentConfigFence = db
        .select({ id: pgSchema.installConfigs.id })
        .from(pgSchema.installConfigs)
        .where(
          and(
            eq(pgSchema.installConfigs.id, input.expected.installConfigId),
            currentStoredConfig === undefined
              ? sql`false`
              : eq(
                  pgSchema.installConfigs.configJson,
                  currentStoredConfig,
                ),
          ),
        );
      const targetConfigFence = db
        .select({ id: pgSchema.installConfigs.id })
        .from(pgSchema.installConfigs)
        .where(
          and(
            eq(
              pgSchema.installConfigs.id,
              input.targetInstallConfigId,
            ),
            targetStoredConfig === undefined
              ? sql`false`
              : eq(
                  pgSchema.installConfigs.configJson,
                  targetStoredConfig,
                ),
          ),
        );
      const bindingSetAuthorityFence = bindingReplacement === undefined
        ? sql`true`
        : currentBindingRow && currentBindingSet
        ? exists(
            db
              .select({ id: pgSchema.providerBindingSets.id })
              .from(pgSchema.providerBindingSets)
              .where(
                and(
                  eq(pgSchema.providerBindingSets.id, currentBindingRow.id),
                  eq(
                    pgSchema.providerBindingSets.workspaceId,
                    capsule.workspaceId,
                  ),
                  eq(pgSchema.providerBindingSets.capsuleId, capsule.id),
                  eq(
                    pgSchema.providerBindingSets.environment,
                    capsule.environment,
                  ),
                  eq(
                    pgSchema.providerBindingSets.profileJson,
                    currentBindingSet,
                  ),
                ),
              ),
          )
        : notExists(
            db
              .select({ id: pgSchema.providerBindingSets.id })
              .from(pgSchema.providerBindingSets)
              .where(
                and(
                  eq(pgSchema.providerBindingSets.capsuleId, capsule.id),
                  eq(
                    pgSchema.providerBindingSets.environment,
                    capsule.environment,
                  ),
                ),
              ),
          );
      const targetBindingIdAvailableFence = bindingReplacement === undefined
        ? sql`true`
        : currentBindingRow?.id === bindingReplacement.target.id
        ? bindingSetAuthorityFence
        : notExists(
            db
              .select({ id: pgSchema.providerBindingSets.id })
              .from(pgSchema.providerBindingSets)
              .where(
                eq(
                  pgSchema.providerBindingSets.id,
                  bindingReplacement.target.id,
                ),
              ),
          );
      const updated = normalizeCapsuleRecord({
        ...capsule,
        installConfigId: input.targetInstallConfigId,
        updatedAt: input.updatedAt,
      });
      const runtimeSafetyFence = recoveryRows
        ? pgCapsuleCommittedPostApplyRecoveryFence(
            db,
            input.capsuleId,
            recoveryRows,
          )
        : pgCapsuleRuntimeSafetySafeOrAbsent(input.capsuleId);
      const rows = await db
        .update(pgSchema.capsules)
        .set({
          installConfigId: updated.installConfigId,
          capsuleJson: updated,
          updatedAt: updated.updatedAt,
          executionAuthorityEpoch: sql`${pgSchema.capsules.executionAuthorityEpoch} + 1`,
        })
        .where(
          and(
            eq(pgSchema.capsules.id, input.capsuleId),
            eq(pgSchema.capsules.workspaceId, capsuleRow.workspaceId),
            // The replacement record is derived from this exact observed
            // JSON. Fence the whole record so a concurrent non-authority
            // patch cannot be erased by the stale whole-JSON write below.
            // updated_at is ordinary audit time and is not a revision.
            eq(pgSchema.capsules.capsuleJson, capsule),
            eq(
              pgSchema.capsules.installConfigId,
              input.expected.installConfigId,
            ),
            input.expected.currentStateVersionId === undefined
              ? isNull(pgSchema.capsules.currentStateVersionId)
              : eq(
                  pgSchema.capsules.currentStateVersionId,
                  input.expected.currentStateVersionId,
                ),
            eq(pgSchema.capsules.status, input.expected.status),
            eq(
              pgSchema.capsules.executionAuthorityEpoch,
              input.expected.executionAuthorityEpoch,
            ),
            sql`(${pgSchema.capsules.capsuleJson} ->> 'currentStateGeneration')::integer = ${input.expected.currentStateGeneration}`,
            // Also require the row to still exist. The shared lock above makes
            // this exact JSON fence part of the same authority transition.
            exists(currentConfigFence),
            exists(targetConfigFence),
            bindingSetAuthorityFence,
            targetBindingIdAvailableFence,
            runtimeSafetyFence,
            notExists(blocking),
          ),
        )
        .returning({ json: pgSchema.capsules.capsuleJson });
      if (rows[0]) {
        if (bindingReplacement) {
          const bindingTable = pgSchema.providerBindingSets;
          await db
            .delete(bindingTable)
            .where(
              and(
                eq(bindingTable.capsuleId, input.capsuleId),
                eq(bindingTable.environment, capsule.environment),
              ),
            );
          const targetBindingSet = bindingReplacement.target;
          await db.insert(bindingTable).values({
            id: targetBindingSet.id,
            workspaceId: targetBindingSet.workspaceId,
            capsuleId: targetBindingSet.capsuleId,
            environment: targetBindingSet.environment,
            profileJson: targetBindingSet,
            createdAt: targetBindingSet.createdAt,
            updatedAt: targetBindingSet.updatedAt,
          });
        }
        const intentTable =
          pgSchema.capsuleInterfaceMaterializationIntents;
        await db
          .update(intentTable)
          .set({
            status: "completed",
            leaseToken: null,
            leaseExpiresAt: null,
            errorJson: null,
            receiptJson: sql`jsonb_build_object(
              'disposition', 'superseded_before_materialization',
              'blueprintsDigest', ${intentTable.blueprintsDigest},
              'completedAt', ${input.updatedAt}::text
            )`,
            updatedAt: input.updatedAt,
            completedAt: input.updatedAt,
            deadLetteredAt: null,
          })
          .where(
            and(
              eq(intentTable.capsuleId, input.capsuleId),
              inArray(intentTable.status, ["pending", "dead_letter"]),
            ),
          );
        return {
          status: "updated" as const,
          capsule: normalizeCapsuleRecord(parseRow(rows[0]) as Capsule),
        };
      }
      const currentRows = await db
        .select({ json: pgSchema.capsules.capsuleJson })
        .from(pgSchema.capsules)
        .where(eq(pgSchema.capsules.id, input.capsuleId))
        .limit(1);
      const current = normalizeOptionalCapsuleRecord(
        parseRow(currentRows[0]) as Capsule | undefined,
      );
      if (!current) return { status: "not_found" as const };
      if (current.installConfigId === input.targetInstallConfigId) {
        return bindingReplacement === undefined ||
            (currentBindingSet !== undefined &&
              (await stableJsonDigest(currentBindingSet)) ===
                bindingReplacement.targetDigest)
          ? { status: "replayed" as const, capsule: current }
          : { status: "conflict" as const, capsule: current };
      }
      const busyRows = await db
        .select({ id: pgSchema.runs.id })
        .from(pgSchema.runs)
        .where(pgCapsuleInstallConfigRebindBlocked(
          input.capsuleId,
          input.expected.executionAuthorityEpoch,
        ))
        .limit(1);
      const currentSafetyRows = await db
        .select({ id: pgSchema.runs.id, json: pgSchema.runs.runJson })
        .from(pgSchema.runs)
        .where(pgRuntimeSafetyCandidateWhere(input.capsuleId))
        .orderBy(
          desc(pgRunRuntimeSafetyInFlightOrder()),
          desc(pgRunRuntimeSafetyEffectAtMillisOrder()),
          desc(pgRunRuntimeSafetyRiskOrder()),
          desc(pgSchema.runs.id),
        )
        .limit(1);
      const currentSafetyCandidate = currentSafetyRows[0]
        ? (parseRow(currentSafetyRows[0]) as ApplyRun | Run)
        : undefined;
      const currentSafety = currentSafetyCandidate
        ? capsuleRuntimeSafetyFromRun(currentSafetyCandidate)
        : undefined;
      const currentRecoveryRows = recoveryProof &&
          currentSafetyCandidate &&
          isApplyRunRecord(currentSafetyCandidate) &&
          currentSafetyCandidate.id === recoveryProof.failedApplyRunId
        ? await pgCommittedPostApplyRecoveryRows(
            db,
            currentSafetyCandidate,
            recoveryProof,
          )
        : undefined;
      const currentRecoveryMatches = Boolean(
        recoveryProof &&
          currentRecoveryRows &&
          (await committedPostApplyRecoveryProofMatches(
            recoveryProof,
            current,
            currentRecoveryRows,
          )),
      );
      return {
        status: busyRows.length > 0 ||
            (recoveryProof === undefined
              ? currentSafety !== undefined && currentSafety.phase !== "safe"
              : !currentRecoveryMatches)
          ? ("busy" as const)
          : ("conflict" as const),
        capsule: current,
      };
    });
  }

  async getCapsule(id: string): Promise<Capsule | undefined> {
    const rows = await this.#db
      .select({ json: pgSchema.capsules.capsuleJson })
      .from(pgSchema.capsules)
      .where(eq(pgSchema.capsules.id, id))
      .limit(1);
    return normalizeOptionalCapsuleRecord(
      parseRow(rows[0]) as Capsule | undefined,
    );
  }

  async getCapsulesByIds(ids: readonly string[]): Promise<readonly Capsule[]> {
    if (ids.length === 0) return [];
    const rows = await this.#db
      .select({ json: pgSchema.capsules.capsuleJson })
      .from(pgSchema.capsules)
      .where(inArray(pgSchema.capsules.id, [...new Set(ids)]));
    const byId = new Map(
      rows.map((row) => {
        const value = normalizeCapsuleRecord(parseRow(row) as Capsule);
        return [value.id, value] as const;
      }),
    );
    return ids
      .map((id) => byId.get(id))
      .filter((row): row is Capsule => row !== undefined);
  }

  async getCapsuleByName(
    projectId: string,
    name: string,
    environment: string,
  ): Promise<Capsule | undefined> {
    const rows = await this.#db
      .select({ json: pgSchema.capsules.capsuleJson })
      .from(pgSchema.capsules)
      .where(
        and(
          eq(pgSchema.capsules.projectId, projectId),
          eq(pgSchema.capsules.name, name),
          eq(pgSchema.capsules.environment, environment),
          ne(pgSchema.capsules.status, "destroyed"),
        ),
      )
      .limit(1);
    return normalizeOptionalCapsuleRecord(
      parseRow(rows[0]) as Capsule | undefined,
    );
  }

  async listCapsules(workspaceId?: string): Promise<readonly Capsule[]> {
    const query = this.#db
      .select({ json: pgSchema.capsules.capsuleJson })
      .from(pgSchema.capsules)
      .$dynamic();
    const rows = await (
      workspaceId === undefined
        ? query
        : query.where(eq(pgSchema.capsules.workspaceId, workspaceId))
    ).orderBy(asc(pgSchema.capsules.createdAt), asc(pgSchema.capsules.id));
    return rows.map((row) => normalizeCapsuleRecord(parseRow(row) as Capsule));
  }

  async listCapsulesPage(
    workspaceId: string,
    params: CapsuleListPageParams,
  ): Promise<Page<Capsule>> {
    const limit = clampPageLimit(params.limit);
    const baseWhere =
      params.includeDestroyed === false
        ? and(
            eq(pgSchema.capsules.workspaceId, workspaceId),
            ne(pgSchema.capsules.status, "destroyed"),
          )
        : eq(pgSchema.capsules.workspaceId, workspaceId);
    const rows = await this.#pgManyJson<Capsule>(
      pgSchema.capsules,
      pgSchema.capsules.capsuleJson,
      {
        where: pgKeysetWhere(
          baseWhere,
          pgSchema.capsules.createdAt,
          pgSchema.capsules.id,
          decodeCursor(params.cursor),
        ),
        orderBy: [asc(pgSchema.capsules.createdAt), asc(pgSchema.capsules.id)],
        limit: limit + 1,
      },
    );
    return pageFromProbe(rows.map(normalizeCapsuleRecord), limit);
  }

  async getPublicHostReservation(
    hostname: string,
  ): Promise<PublicHostReservation | undefined> {
    const rows = await this.#client.query<Record<string, unknown>>(
      `select hostname, owner_user_id, workspace_id, installation_id,
              installation_name, allocation_kind, status,
              reserved_at, updated_at, released_at
       from takosumi_public_host_reservations
       where hostname = $1`,
      [hostname.toLowerCase()],
    );
    const row = rows.rows[0];
    return row ? publicHostReservationFromRow(row) : undefined;
  }

  async releasePublicHostsForCapsule(
    capsuleId: string,
    now: string,
  ): Promise<void> {
    await this.#client.query(
      `update takosumi_public_host_reservations
       set status = 'released',
           updated_at = $2,
           released_at = $2
       where installation_id = $1
         and status = 'reserved'`,
      [capsuleId, now],
    );
  }

  async patchCapsule(
    id: string,
    patch: CapsulePatch,
    guard?: CapsuleStateVersionGuard,
  ): Promise<Capsule | undefined> {
    const current = await this.getCapsule(id);
    if (!current) return undefined;
    if (
      guard !== undefined &&
      (current.currentStateVersionId !== guard.currentStateVersionId ||
        (guard.status !== undefined && current.status !== guard.status))
    ) {
      throw new CapsuleStateVersionGuardConflict({
        id,
        expectedCurrentStateVersionId: guard.currentStateVersionId,
        actualCurrentStateVersionId: current.currentStateVersionId,
        expectedStatus: guard.status,
        actualStatus: current.status,
      });
    }
    const updated: Capsule = { ...current, ...patch };
    if (!guard) return await this.putCapsule(updated);
    // Guarded path: fence on current_state_version_id (and optionally status) in the
    // UPDATE predicate so a concurrent writer cannot win the race between read and
    // write. `is not distinct from` matches NULL == NULL for the unset cursor.
    const values = capsuleValues(updated);
    const guardedCurrentStateVersion =
      guard.currentStateVersionId === undefined ||
      guard.currentStateVersionId === null
        ? isNull(pgSchema.capsules.currentStateVersionId)
        : eq(
            pgSchema.capsules.currentStateVersionId,
            guard.currentStateVersionId,
          );
    const rows = await this.#db
      .update(pgSchema.capsules)
      .set({
        workspaceId: values.workspaceId,
        name: values.name,
        environment: values.environment,
        sourceId: values.sourceId,
        installConfigId: values.installConfigId,
        currentStateVersionId: values.currentStateVersionId,
        status: values.status,
        capsuleJson: values.capsuleJson,
        updatedAt: values.updatedAt,
      })
      .where(
        and(
          eq(pgSchema.capsules.id, updated.id),
          guardedCurrentStateVersion,
          guard.status === undefined
            ? sql`true`
            : eq(pgSchema.capsules.status, guard.status),
        ),
      )
      .returning({ json: pgSchema.capsules.capsuleJson });
    const patched = normalizeOptionalCapsuleRecord(
      parseRow(rows[0]) as Capsule | undefined,
    );
    if (patched) return patched;
    const actual = await this.getCapsule(id);
    if (!actual) return undefined;
    throw new CapsuleStateVersionGuardConflict({
      id,
      expectedCurrentStateVersionId: guard.currentStateVersionId,
      actualCurrentStateVersionId: actual.currentStateVersionId,
      expectedStatus: guard.status,
      actualStatus: actual.status,
    });
  }

  async markCapsuleStale(
    input: MarkCapsuleStaleCommand,
  ): Promise<MarkCapsuleStaleResult> {
    const expected = normalizeCapsuleRecord(input.expected);
    const updated = normalizeCapsuleRecord({
      ...expected,
      status: "stale",
      updatedAt: input.updatedAt,
    });
    const rows = await this.#db
      .update(pgSchema.capsules)
      .set({
        status: updated.status,
        capsuleJson: updated,
        updatedAt: updated.updatedAt,
      })
      .where(
        and(
          eq(pgSchema.capsules.id, input.capsuleId),
          eq(pgSchema.capsules.capsuleJson, expected),
        ),
      )
      .returning({ json: pgSchema.capsules.capsuleJson });
    if (rows[0]) {
      return {
        kind: "updated",
        capsule: normalizeCapsuleRecord(parseRow(rows[0]) as Capsule),
      };
    }
    const current = await this.getCapsule(input.capsuleId);
    return current
      ? { kind: "conflict", current }
      : { kind: "not-found" };
  }

  async updateCapsuleLifecycle(
    input: UpdateCapsuleLifecycleCommand,
  ): Promise<UpdateCapsuleLifecycleResult> {
    input = structuredClone(input);
    // Capture the caller's original admission tuple before any asynchronous
    // SQL preparation. A later Workspace transition must not change the
    // authority this marker update was admitted with.
    const expectedWorkspaceManagementAuthority =
      input.mutation.kind === "auto-update-claim" &&
          input.mutation.expectedWorkspaceManagementAuthority !== undefined
        ? structuredClone(input.mutation.expectedWorkspaceManagementAuthority)
        : undefined;
    if (expectedWorkspaceManagementAuthority !== undefined) {
      assertWorkspaceManagementAuthorityInput(
        expectedWorkspaceManagementAuthority,
        expectedWorkspaceManagementAuthority.workspaceId,
      );
    }
    const patch = capsuleLifecycleMutationPatch(
      input.mutation,
      input.updatedAt,
    );
    const expectedStateVersion = input.expected.currentStateVersionId ===
        undefined
      ? isNull(pgSchema.capsules.currentStateVersionId)
      : eq(
          pgSchema.capsules.currentStateVersionId,
          input.expected.currentStateVersionId,
        );
    const expectedOutput = input.expected.currentOutputId === undefined
      ? sql`${pgSchema.capsules.capsuleJson} ->> 'currentOutputId' IS NULL`
      : sql`${pgSchema.capsules.capsuleJson} ->> 'currentOutputId' = ${input.expected.currentOutputId}`;
    const expectedAutoUpdate = input.expected.autoUpdate === undefined
      ? sql`${pgSchema.capsules.capsuleJson} ->> 'autoUpdate' IS NULL`
      : sql`${pgSchema.capsules.capsuleJson} ->> 'autoUpdate' = ${String(input.expected.autoUpdate)}`;
    const expectedAutoUpdateAttempt =
      input.expected.autoUpdateAttemptSourceSnapshotId === undefined
        ? sql`${pgSchema.capsules.capsuleJson} ->> 'autoUpdateAttemptSourceSnapshotId' IS NULL`
        : sql`${pgSchema.capsules.capsuleJson} ->> 'autoUpdateAttemptSourceSnapshotId' = ${input.expected.autoUpdateAttemptSourceSnapshotId}`;
    const expectedCompatibilityReport =
      input.expected.compatibilityReportId === undefined
        ? sql`${pgSchema.capsules.capsuleJson} ->> 'compatibilityReportId' IS NULL`
        : sql`${pgSchema.capsules.capsuleJson} ->> 'compatibilityReportId' = ${input.expected.compatibilityReportId}`;
    const expectedCompatibilityStatus =
      input.expected.compatibilityStatus === undefined
        ? sql`${pgSchema.capsules.capsuleJson} ->> 'compatibilityStatus' IS NULL`
        : sql`${pgSchema.capsules.capsuleJson} ->> 'compatibilityStatus' = ${input.expected.compatibilityStatus}`;
    const claimNotAlreadyApplied = input.mutation.kind === "auto-update-claim"
      ? sql`${pgSchema.capsules.capsuleJson} ->> 'autoUpdateAttemptSourceSnapshotId' IS DISTINCT FROM ${input.mutation.sourceSnapshotId}`
      : sql`true`;
    const update = async (
      db: PgRemoteDatabase<typeof pgSchema>,
      expectedWorkspaceId?: string,
    ) =>
      await db
        .update(pgSchema.capsules)
        .set({
          ...(patch.status ? { status: patch.status } : {}),
          capsuleJson:
            sql`${pgSchema.capsules.capsuleJson} || ${JSON.stringify(patch)}::jsonb`,
          updatedAt: input.updatedAt,
        })
        .where(
          and(
            eq(pgSchema.capsules.id, input.capsuleId),
            expectedWorkspaceId === undefined
              ? sql`true`
              : eq(pgSchema.capsules.workspaceId, expectedWorkspaceId),
            eq(
              pgSchema.capsules.executionAuthorityEpoch,
              input.expected.executionAuthorityEpoch,
            ),
            expectedStateVersion,
            sql`COALESCE((${pgSchema.capsules.capsuleJson} ->> 'currentStateGeneration')::integer, 0) = ${input.expected.currentStateGeneration}`,
            expectedOutput,
            eq(pgSchema.capsules.status, input.expected.status),
            expectedAutoUpdate,
            expectedAutoUpdateAttempt,
            expectedCompatibilityReport,
            expectedCompatibilityStatus,
            claimNotAlreadyApplied,
          ),
        )
        .returning({ json: pgSchema.capsules.capsuleJson });
    let rows: Awaited<ReturnType<typeof update>> = [];
    if (input.mutation.kind === "auto-update-claim") {
      // Lock the persisted Capsule Workspace first, then pin that same
      // workspace id in the lifecycle UPDATE. A drain racing this claim
      // therefore loses atomically; no generic drain bypass is introduced.
      rows = await this.#client.transaction(async (transaction) => {
        const capsuleRows = await transaction.query<{
          readonly workspaceId: string | null;
        }>(
          `select space_id as "workspaceId"
             from takosumi_capsules
            where id = $1
            limit 1`,
          [input.capsuleId],
        );
        const workspaceId = capsuleRows.rows[0]?.workspaceId;
        if (!workspaceId) return [];
        const management = await pgWorkspaceManagementForTransaction(
          transaction,
          workspaceId,
        );
        if (!management || management.managementState !== "active") return [];
        if (expectedWorkspaceManagementAuthority === undefined) return [];
        if (
          expectedWorkspaceManagementAuthority.workspaceId !== workspaceId ||
          expectedWorkspaceManagementAuthority.managementEpoch !==
            management.managementEpoch
        ) {
          return [];
        }
        return await update(
          this.#drizzleForClient(transaction),
          management.workspaceId,
        );
      });
    } else {
      rows = await update(this.#db);
    }
    if (rows[0]) {
      return {
        kind: "updated",
        capsule: normalizeCapsuleRecord(parseRow(rows[0]) as Capsule),
      };
    }
    const current = await this.getCapsule(input.capsuleId);
    const epoch = current
      ? await this.getCapsuleExecutionAuthorityEpoch(current.id)
      : undefined;
    if (
      current &&
      epoch !== undefined &&
      capsuleLifecycleMutationAlreadyApplied(current, epoch, input)
    ) {
      return { kind: "unchanged", capsule: current };
    }
    return current
      ? { kind: "conflict", current }
      : { kind: "not-found" };
  }

  /**
   * Atomic provider-applied / destroy-apply ledger commit (spec §20 / §21 / §16). All
   * writes — StateVersion, (apply) Output,
   * and the guarded Capsule advance — run inside ONE Postgres interactive
   * transaction so a mid-sequence failure rolls the whole unit back instead of
   * leaving torn state. The transaction is opened through the {@link SqlClient}
   * `transaction` seam (a pinned connection), which every SqlClient implements.
   *
   * The guard is fenced in the UPDATE predicate exactly as
   * {@link patchCapsule}: a guard miss (no row updated) re-reads to decide
   * between `{ capsule: undefined }` (row gone) and a thrown
   * {@link CapsuleStateVersionGuardConflict} (row moved). A thrown conflict aborts
   * the transaction and rolls back every preceding write.
   */
  async commitRunState(
    input: CommitRunStateInput,
  ): Promise<CommitRunStateResult> {
    await validateCommitRunStateInterfaceMaterializationIntent(input);
    return await this.#client.transaction(
      async (transaction: SqlTransaction) => {
        const txDb = this.#drizzleForClient(transaction);
        return await this.#commitRunStateWrites(txDb, input);
      },
    );
  }

  async commitRestoredState(
    input: CommitRestoredStateInput,
  ): Promise<CommitRestoredStateResult> {
    await validateCommitRestoredStateInterfaceMaterialization(input);
    return await this.#client.transaction(
      async (transaction: SqlTransaction) => {
        const db = this.#drizzleForClient(transaction);
        const { capsulePatch } = input;
        const current = await this.#getCapsuleOn(db, capsulePatch.id);
        if (!current) return { capsule: undefined };
        const guard = capsulePatch.guard;
        if (current.currentStateVersionId !== guard.currentStateVersionId) {
          throw new CapsuleStateVersionGuardConflict({
            id: capsulePatch.id,
            expectedCurrentStateVersionId: guard.currentStateVersionId,
            actualCurrentStateVersionId: current.currentStateVersionId,
            expectedStatus: guard.status,
            actualStatus: current.status,
          });
        }
        if (
          current.currentStateGeneration !== guard.currentStateGeneration ||
          (guard.status !== undefined && current.status !== guard.status)
        ) {
          throw new CapsuleStateGenerationGuardConflict({
            id: capsulePatch.id,
            expectedCurrentStateGeneration: guard.currentStateGeneration,
            actualCurrentStateGeneration: current.currentStateGeneration,
            expectedStatus: guard.status,
            actualStatus: current.status,
          });
        }
        const restoreRunCommitted = await pgUpdateTerminalRunWithLease(
          db,
          RUN_KIND_RESTORE,
          [RUN_KIND_RESTORE],
          input.restoreRunTerminal,
          input.restoreRunLeaseToken,
        );
        if (!restoreRunCommitted) return { restoreRunLeaseLost: true };
        const replacement = input.interfaceMaterializationReplacement;
        if (replacement) {
          const table = pgSchema.capsuleInterfaceMaterializationIntents;
          const [source] = await db
            .select()
            .from(table)
            .where(eq(table.id, replacement.sourceIntentId));
          const [sourceState] = source
            ? await db
                .select()
                .from(pgSchema.stateVersions)
                .where(eq(pgSchema.stateVersions.id, source.stateVersionId))
            : [];
          const [sourceOutput] = source
            ? await db
                .select()
                .from(pgSchema.outputs)
                .where(eq(pgSchema.outputs.id, source.outputId))
            : [];
          const sourceBlueprintsJson = capsuleInterfaceBlueprintsJson(
            replacement.intent.blueprints,
          );
          if (
            !source ||
            source.workspaceId !== replacement.intent.workspaceId ||
            source.capsuleId !== replacement.intent.capsuleId ||
            source.installConfigId !== replacement.intent.installConfigId ||
            source.stateVersionId !==
              input.restoreRunTerminal.restoredFromStateVersionId ||
            !sourceState ||
            sourceState.workspaceId !== source.workspaceId ||
            sourceState.capsuleId !== source.capsuleId ||
            sourceState.generation !== source.stateGeneration ||
            !sourceOutput ||
            sourceOutput.workspaceId !== source.workspaceId ||
            sourceOutput.capsuleId !== source.capsuleId ||
            sourceOutput.stateGeneration !== source.stateGeneration ||
            source.blueprintsDigest !== replacement.intent.blueprintsDigest ||
            source.blueprintsJson !== sourceBlueprintsJson
          ) {
            throw new TypeError(
              "Restore Interface materialization source snapshot is missing or changed",
            );
          }
          await pgInsertOrAdoptCapsuleInterfaceMaterializationIntent(
            db,
            replacement.intent,
          );
          await db
            .update(table)
            .set({
              status: "completed",
              leaseToken: null,
              leaseExpiresAt: null,
              errorJson: null,
              receiptJson: sql`jsonb_build_object(
                'disposition', 'superseded_before_materialization',
                'blueprintsDigest', ${table.blueprintsDigest},
                'completedAt', ${replacement.intent.createdAt}::text
              )`,
              updatedAt: replacement.intent.createdAt,
              completedAt: replacement.intent.createdAt,
              deadLetteredAt: null,
            })
            .where(
              and(
                eq(table.capsuleId, replacement.intent.capsuleId),
                eq(table.status, "pending"),
                ne(table.id, replacement.intent.id),
              ),
            );
        }
        await pgUpsertStateVersion(db, input.stateVersion);
        if (input.output) {
          await pgUpsertOutput(db, input.output);
        }

        const updated: Capsule = {
          ...current,
          ...capsulePatch.patch,
        };
        const values = capsuleValues(updated);
        const rows = await db
          .update(pgSchema.capsules)
          .set({
            workspaceId: values.workspaceId,
            name: values.name,
            environment: values.environment,
            sourceId: values.sourceId,
            installConfigId: values.installConfigId,
            currentStateVersionId: values.currentStateVersionId,
            status: values.status,
            capsuleJson: values.capsuleJson,
            updatedAt: values.updatedAt,
          })
          .where(
            and(
              eq(pgSchema.capsules.id, updated.id),
              guard.currentStateVersionId === undefined
                ? isNull(pgSchema.capsules.currentStateVersionId)
                : eq(
                    pgSchema.capsules.currentStateVersionId,
                    guard.currentStateVersionId,
                  ),
              sql`COALESCE((${pgSchema.capsules.capsuleJson}->>'currentStateGeneration')::integer, 0) = ${guard.currentStateGeneration}`,
              guard.status === undefined
                ? sql`true`
                : eq(pgSchema.capsules.status, guard.status),
            ),
          )
          .returning({ json: pgSchema.capsules.capsuleJson });
        const patched = normalizeOptionalCapsuleRecord(
          parseRow(rows[0]) as Capsule | undefined,
        );
        if (patched) return { capsule: patched };
        const actual = await this.#getCapsuleOn(db, capsulePatch.id);
        if (!actual) {
          throw new Error(
            `Capsule ${capsulePatch.id} disappeared during Restore commit`,
          );
        }
        if (actual.currentStateVersionId !== guard.currentStateVersionId) {
          throw new CapsuleStateVersionGuardConflict({
            id: capsulePatch.id,
            expectedCurrentStateVersionId: guard.currentStateVersionId,
            actualCurrentStateVersionId: actual.currentStateVersionId,
            expectedStatus: guard.status,
            actualStatus: actual.status,
          });
        }
        throw new CapsuleStateGenerationGuardConflict({
          id: capsulePatch.id,
          expectedCurrentStateGeneration: guard.currentStateGeneration,
          actualCurrentStateGeneration: actual.currentStateGeneration,
          expectedStatus: guard.status,
          actualStatus: actual.status,
        });
      },
    );
  }

  /**
   * Runs the apply-commit write set against the given drizzle handle (the shared
   * `#db` or a transaction-bound one). Returns `{ capsule }` patched, or
   * `{ capsule: undefined }` on a guard miss whose Capsule row is gone;
   * throws {@link CapsuleStateVersionGuardConflict} on a guard conflict.
   */
  async #commitRunStateWrites(
    db: PgRemoteDatabase<typeof pgSchema>,
    input: CommitRunStateInput,
  ): Promise<CommitRunStateResult> {
    const { capsulePatch } = input;
    let applyRunCommitted = false;
    if (input.applyRunTerminal && input.applyRunLeaseToken !== undefined) {
      applyRunCommitted = await pgUpdateTerminalRunWithLease(
        db,
        input.applyRunTerminal.operation === "destroy"
          ? "destroy_apply"
          : "apply",
        RUN_KINDS_APPLY,
        input.applyRunTerminal,
        input.applyRunLeaseToken,
      );
      if (!applyRunCommitted) return { applyRunLeaseLost: true };
    }
    if (input.stateVersion) {
      await pgUpsertStateVersion(db, input.stateVersion);
    }
    if (input.output) {
      await pgUpsertOutput(db, input.output);
    }
    if (input.interfaceMaterializationIntent) {
      await pgInsertOrAdoptCapsuleInterfaceMaterializationIntent(
        db,
        input.interfaceMaterializationIntent,
      );
    }
    // Commit-tail fold (S2): the succeeded ApplyRun + the applied PlanRun land in
    // the SAME interactive transaction as the StateVersion. The apply terminal
    // clears its lease fence (`lease_token = NULL`, mirrors transitionRun
    // clearLeaseToken); the plan patch is a plain row write (already terminal).
    if (input.applyRunTerminal && !applyRunCommitted) {
      await pgUpsertRun(
        db,
        input.applyRunTerminal.operation === "destroy"
          ? "destroy_apply"
          : "apply",
        input.applyRunTerminal,
      );
    }
    if (input.planRunApplied) {
      await pgUpsertRun(
        db,
        input.planRunApplied.driftCheck === true
          ? "drift_check"
          : input.planRunApplied.operation === "destroy"
            ? "destroy_plan"
            : "plan",
        input.planRunApplied,
      );
    }
    // Guarded Capsule advance, fenced on current_state_version_id (and
    // optionally status) so the patch lands atomically with the writes above.
    const guard = capsulePatch.guard;
    const current = await this.#getCapsuleOn(db, capsulePatch.id);
    if (!current) return { capsule: undefined };
    if (
      current.currentStateVersionId !== guard.currentStateVersionId ||
      (guard.status !== undefined && current.status !== guard.status)
    ) {
      throw new CapsuleStateVersionGuardConflict({
        id: capsulePatch.id,
        expectedCurrentStateVersionId: guard.currentStateVersionId,
        actualCurrentStateVersionId: current.currentStateVersionId,
        expectedStatus: guard.status,
        actualStatus: current.status,
      });
    }
    const updated: Capsule = { ...current, ...capsulePatch.patch };
    const values = capsuleValues(updated);
    const guardedCurrentStateVersion =
      guard.currentStateVersionId === undefined ||
      guard.currentStateVersionId === null
        ? isNull(pgSchema.capsules.currentStateVersionId)
        : eq(
            pgSchema.capsules.currentStateVersionId,
            guard.currentStateVersionId,
          );
    const rows = await db
      .update(pgSchema.capsules)
      .set({
        workspaceId: values.workspaceId,
        name: values.name,
        environment: values.environment,
        sourceId: values.sourceId,
        installConfigId: values.installConfigId,
        currentStateVersionId: values.currentStateVersionId,
        status: values.status,
        capsuleJson: values.capsuleJson,
        updatedAt: values.updatedAt,
      })
      .where(
        and(
          eq(pgSchema.capsules.id, updated.id),
          guardedCurrentStateVersion,
          guard.status === undefined
            ? sql`true`
            : eq(pgSchema.capsules.status, guard.status),
        ),
      )
      .returning({ json: pgSchema.capsules.capsuleJson });
    const patched = normalizeOptionalCapsuleRecord(
      parseRow(rows[0]) as Capsule | undefined,
    );
    if (patched) return { capsule: patched };
    const actual = await this.#getCapsuleOn(db, capsulePatch.id);
    if (!actual) return { capsule: undefined };
    throw new CapsuleStateVersionGuardConflict({
      id: capsulePatch.id,
      expectedCurrentStateVersionId: guard.currentStateVersionId,
      actualCurrentStateVersionId: actual.currentStateVersionId,
      expectedStatus: guard.status,
      actualStatus: actual.status,
    });
  }

  /** Reads one Capsule by id on the given drizzle handle (tx-aware). */
  async #getCapsuleOn(
    db: PgRemoteDatabase<typeof pgSchema>,
    id: string,
  ): Promise<Capsule | undefined> {
    const rows = await db
      .select({ json: pgSchema.capsules.capsuleJson })
      .from(pgSchema.capsules)
      .where(eq(pgSchema.capsules.id, id))
      .limit(1);
    return normalizeOptionalCapsuleRecord(
      parseRow(rows[0]) as Capsule | undefined,
    );
  }

  /**
   * Builds a drizzle handle whose query callback proxies to the given pinned
   * {@link SqlTransaction}, so the same column-mapped builders run inside the
   * transaction's connection. Mirrors the constructor's `#db` wiring.
   */
  #drizzleForClient(client: SqlClient): PgRemoteDatabase<typeof pgSchema> {
    return drizzle(
      async (query, params, method) => {
        const result = await client.query(query, params);
        if (method !== "all") return { rows: [...result.rows] };
        const columns = selectedDriverColumns(query);
        return {
          rows: result.rows.map((row) =>
            columns.map((column) => (row as Record<string, unknown>)[column]),
          ),
        };
      },
      { schema: pgSchema },
    );
  }

  // --- connections + sealed secret blobs ------------------------------------

  async putConnection(
    connection: ProviderConnection,
  ): Promise<ProviderConnection> {
    await this.#pgUpsert(pgSchema.connections, {
      id: connection.id,
      workspaceId: connection.workspaceId ?? null,
      provider: connection.provider,
      status: connection.status,
      connectionJson: connection,
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt,
    });
    return connection;
  }

  async createConnectionRegistration(
    input: CreateConnectionRegistrationInput,
  ): Promise<boolean> {
    // Snapshot and validate all caller input before opening the transaction;
    // the returned objects are detached from any later caller mutation.
    const {
      connection,
      secretBlob,
      expectedWorkspaceManagementAuthority,
      actorAuthority,
    } = prepareConnectionRegistration(input);

    try {
      return await this.#client.transaction(async (transaction) => {
        if (connection.scope === "workspace") {
          const workspaceId = connection.workspaceId;
          if (workspaceId === undefined) {
            // prepareConnectionRegistration already rejects this shape. Keep
            // the check at the durable boundary so a future helper change
            // cannot accidentally admit an unscoped registration.
            throw new TypeError(
              "Workspace Connection registration requires a Workspace id",
            );
          }
          const management = await pgWorkspaceManagementForTransaction(
            transaction,
            workspaceId,
          );
          assertWorkspaceManagementAdmission(
            management,
            workspaceId,
            expectedWorkspaceManagementAuthority,
          );
          if (
            !(await this.#connectionActorAuthorityMatches(
              transaction,
              actorAuthority,
            ))
          ) {
            return false;
          }
        }

        // Existing orphan blobs are part of the registration identity. Read
        // all occupied identities before either insert; a later unique race
        // is handled by the transaction-level catch below and rolls back both
        // rows rather than leaving a partial pair.
        const collisions = await transaction.query<{ readonly collision: number }>(
          `select 1 as collision
             from takosumi_connections
            where id = $1
           union all
           select 1 as collision
             from takosumi_connection_secret_blobs
            where connection_id = $1
           union all
           select 1 as collision
             from takosumi_connection_secret_blobs
            where id = $2
            limit 1`,
          [connection.id, secretBlob?.id ?? null],
        );
        if (collisions.rows.length > 0) return false;

        const db = this.#drizzleForClient(transaction);
        await db.insert(pgSchema.connections).values({
          id: connection.id,
          workspaceId: connection.workspaceId ?? null,
          provider: connection.provider,
          status: connection.status,
          connectionJson: connection,
          createdAt: connection.createdAt,
          updatedAt: connection.updatedAt,
        });
        if (secretBlob !== undefined) {
          await db.insert(pgSchema.secretBlobs).values({
            id: secretBlob.id,
            connectionId: secretBlob.connectionId,
            workspaceId: secretBlob.workspaceId ?? null,
            kind: secretBlob.kind,
            ciphertext: secretBlob.ciphertext,
            encryptedDek: secretBlob.encryptedDek,
            nonce: secretBlob.nonce,
            aad: secretBlob.aad,
            keyVersion: secretBlob.keyVersion,
            createdAt: secretBlob.createdAt,
            rotatedAt: secretBlob.rotatedAt ?? null,
            blobJson: secretBlob,
          });
        }
        return true;
      });
    } catch (error) {
      // A concurrent connection/blob insert can win after the observation
      // query. The SQL transaction has already rolled back here, so report
      // the create-only collision without exposing a half-written pair.
      if (isUniqueConstraintViolation(error)) return false;
      throw error;
    }
  }

  async createConnectionIfAbsent(
    connection: ProviderConnection,
  ): Promise<boolean> {
    const inserted = await this.#db
      .insert(pgSchema.connections)
      .values({
        id: connection.id,
        workspaceId: connection.workspaceId ?? null,
        provider: connection.provider,
        status: connection.status,
        connectionJson: connection,
        createdAt: connection.createdAt,
        updatedAt: connection.updatedAt,
      })
      .onConflictDoNothing({ target: pgSchema.connections.id })
      .returning({ id: pgSchema.connections.id });
    return inserted.length === 1;
  }

  async replaceConnectionIfUnchanged(
    expected: ProviderConnection,
    replacement: ProviderConnection,
  ): Promise<boolean> {
    if (replacement.id !== expected.id) return false;
    const updated = await this.#db
      .update(pgSchema.connections)
      .set({
        workspaceId: replacement.workspaceId ?? null,
        provider: replacement.provider,
        status: replacement.status,
        connectionJson: replacement,
        createdAt: replacement.createdAt,
        updatedAt: replacement.updatedAt,
      })
      .where(
        and(
          eq(pgSchema.connections.id, expected.id),
          sql`${pgSchema.connections.connectionJson}::jsonb = ${JSON.stringify(expected)}::jsonb`,
        ),
      )
      .returning({ id: pgSchema.connections.id });
    return updated.length === 1;
  }

  async markConnectionExpiredIfUnchanged(
    input: MarkConnectionExpiredIfUnchangedInput,
  ): Promise<boolean> {
    const prepared = prepareConnectionExpiration(input);
    if (prepared === undefined) return false;
    return await this.replaceConnectionIfUnchanged(
      prepared.expectedConnection,
      prepared.replacement,
    );
  }

  async revokeConnectionIfUnchanged(
    input: RevokeConnectionIfUnchangedInput,
  ): Promise<boolean> {
    // Snapshot and validate before opening the transaction. Workspace-scoped
    // callers must supply the authority captured for this exact operation;
    // operator-scoped rows intentionally carry no Workspace fence.
    const {
      expectedConnection,
      expectedWorkspaceManagementAuthority,
      actorAuthority,
    } = prepareConnectionRevocation(input);
    return await this.#client.transaction(async (transaction) => {
      if (expectedConnection.scope === "workspace") {
        const workspaceId = expectedConnection.workspaceId;
        if (workspaceId === undefined) {
          throw new TypeError(
            "Workspace Connection revocation requires a Workspace id",
          );
        }
        const management = await pgWorkspaceManagementForTransaction(
          transaction,
          workspaceId,
        );
        assertWorkspaceManagementAdmission(
          management,
          workspaceId,
          expectedWorkspaceManagementAuthority,
        );
        if (
          !(await this.#connectionActorAuthorityMatches(
            transaction,
            actorAuthority,
          ))
        ) {
          return false;
        }
      }

      // After the Workspace/member authority snapshot above, lock the
      // Connection row before comparing or deleting it. A stale or missing
      // row returns false without touching an orphan/current blob.
      const locked = await transaction.query<{
        readonly id: string;
        readonly connectionJson: unknown;
      }>(
        `select id, connection_json as "connectionJson"
           from takosumi_connections
          where id = $1
          for update`,
        [expectedConnection.id],
      );
      const row = locked.rows[0];
      if (row === undefined) return false;
      const current = parseJson(row.connectionJson);
      if (current === null || typeof current !== "object" || Array.isArray(current)) {
        return false;
      }

      const db = this.#drizzleForClient(transaction);
      const deleted = await db
        .delete(pgSchema.connections)
        .where(
          and(
            eq(pgSchema.connections.id, expectedConnection.id),
            expectedConnection.workspaceId === undefined
              ? isNull(pgSchema.connections.workspaceId)
              : eq(
                  pgSchema.connections.workspaceId,
                  expectedConnection.workspaceId,
                ),
            eq(pgSchema.connections.provider, expectedConnection.provider),
            eq(pgSchema.connections.status, expectedConnection.status),
            sql`${pgSchema.connections.connectionJson}::jsonb = ${JSON.stringify(expectedConnection)}::jsonb`,
            eq(pgSchema.connections.createdAt, expectedConnection.createdAt),
            eq(pgSchema.connections.updatedAt, expectedConnection.updatedAt),
          ),
        )
        .returning({ id: pgSchema.connections.id });
      if (deleted.length === 0) return false;

      // Remove whichever sealed material is currently attached to this exact
      // Connection. Blob rotation is not part of the Connection CAS.
      await db
        .delete(pgSchema.secretBlobs)
        .where(eq(pgSchema.secretBlobs.connectionId, expectedConnection.id));
      return true;
    });
  }

  async commitConnectionTestResult(
    input: CommitConnectionTestResultInput,
  ): Promise<boolean> {
    // Snapshot and validate before opening asynchronous SQL work. The
    // expected blob is an explicit observation: null means the owner was
    // absent, not that the material predicate should be skipped.
    const {
      expectedConnection,
      expectedSecretBlob,
      replacement,
      expectedWorkspaceManagementAuthority,
      actorAuthority,
    } = prepareConnectionTestResult(input);

    return await this.#client.transaction(async (transaction) => {
      if (expectedConnection.workspaceId !== undefined) {
        const management = await pgWorkspaceManagementForTransaction(
          transaction,
          expectedConnection.workspaceId,
        );
        assertWorkspaceManagementAdmission(
          management,
          expectedConnection.workspaceId,
          expectedWorkspaceManagementAuthority,
        );
        if (
          !(await this.#connectionActorAuthorityMatches(
            transaction,
            actorAuthority,
          ))
        ) {
          return false;
        }
      }

      // After the Workspace/member authority snapshot above, lock the
      // Connection first, then whichever sealed-material row is currently
      // attached. Raw blob writers do not acquire the Connection lock, so the
      // final UPDATE below repeats the full blob predicate to linearize a
      // rotation or a null->present insertion that races this observation.
      const lockedConnection = await transaction.query<{
        readonly id: string;
        readonly workspaceId: string | null;
        readonly provider: string;
        readonly status: string;
        readonly connectionJson: unknown;
        readonly createdAt: string;
        readonly updatedAt: string;
      }>(
        `select id,
                space_id as "workspaceId",
                provider,
                status,
                connection_json as "connectionJson",
                created_at as "createdAt",
                updated_at as "updatedAt"
           from takosumi_connections
          where id = $1
          for update`,
        [expectedConnection.id],
      );
      const connectionRow = lockedConnection.rows[0];
      if (connectionRow === undefined) return false;
      const currentJson = parseJson(connectionRow.connectionJson);
      if (
        currentJson === null ||
        typeof currentJson !== "object" ||
        Array.isArray(currentJson)
      ) {
        return false;
      }

      await transaction.query(
        `select id
           from takosumi_connection_secret_blobs
          where connection_id = $1
          for update`,
        [expectedConnection.id],
      );

      const db = this.#drizzleForClient(transaction);
      const connectionFence = and(
        eq(pgSchema.connections.id, expectedConnection.id),
        expectedConnection.workspaceId === undefined
          ? isNull(pgSchema.connections.workspaceId)
          : eq(
              pgSchema.connections.workspaceId,
              expectedConnection.workspaceId,
            ),
        eq(pgSchema.connections.provider, expectedConnection.provider),
        eq(pgSchema.connections.status, expectedConnection.status),
        sql`${pgSchema.connections.connectionJson}::jsonb = ${JSON.stringify(expectedConnection)}::jsonb`,
        eq(pgSchema.connections.createdAt, expectedConnection.createdAt),
        eq(pgSchema.connections.updatedAt, expectedConnection.updatedAt),
      )!;

      const blobFence = expectedSecretBlob === null
        ? notExists(
            db
              .select({ id: pgSchema.secretBlobs.id })
              .from(pgSchema.secretBlobs)
              .where(
                eq(
                  pgSchema.secretBlobs.connectionId,
                  expectedConnection.id,
                ),
              ),
          )
        : exists(
            db
              .select({ id: pgSchema.secretBlobs.id })
              .from(pgSchema.secretBlobs)
              .where(
                and(
                  eq(pgSchema.secretBlobs.id, expectedSecretBlob.id),
                  eq(
                    pgSchema.secretBlobs.connectionId,
                    expectedSecretBlob.connectionId,
                  ),
                  expectedSecretBlob.workspaceId === undefined
                    ? isNull(pgSchema.secretBlobs.workspaceId)
                    : eq(
                        pgSchema.secretBlobs.workspaceId,
                        expectedSecretBlob.workspaceId,
                      ),
                  eq(pgSchema.secretBlobs.kind, expectedSecretBlob.kind),
                  eq(
                    pgSchema.secretBlobs.ciphertext,
                    expectedSecretBlob.ciphertext,
                  ),
                  eq(
                    pgSchema.secretBlobs.encryptedDek,
                    expectedSecretBlob.encryptedDek,
                  ),
                  eq(pgSchema.secretBlobs.nonce, expectedSecretBlob.nonce),
                  eq(pgSchema.secretBlobs.aad, expectedSecretBlob.aad),
                  eq(
                    pgSchema.secretBlobs.keyVersion,
                    expectedSecretBlob.keyVersion,
                  ),
                  eq(
                    pgSchema.secretBlobs.createdAt,
                    expectedSecretBlob.createdAt,
                  ),
                  expectedSecretBlob.rotatedAt === undefined
                    ? isNull(pgSchema.secretBlobs.rotatedAt)
                    : eq(
                        pgSchema.secretBlobs.rotatedAt,
                        expectedSecretBlob.rotatedAt,
                      ),
                  sql`${pgSchema.secretBlobs.blobJson}::jsonb = ${JSON.stringify(expectedSecretBlob)}::jsonb`,
                ),
              ),
          );

      const updated = await db
        .update(pgSchema.connections)
        .set({
          workspaceId: replacement.workspaceId ?? null,
          provider: replacement.provider,
          status: replacement.status,
          connectionJson: replacement,
          createdAt: replacement.createdAt,
          updatedAt: replacement.updatedAt,
        })
        .where(and(connectionFence, blobFence))
        .returning({ id: pgSchema.connections.id });
      return updated.length === 1;
    });
  }

  async getConnection(id: string): Promise<ProviderConnection | undefined> {
    return await this.#pgFirstJson<ProviderConnection>(
      pgSchema.connections,
      pgSchema.connections.connectionJson,
      eq(pgSchema.connections.id, id),
    );
  }

  async listConnections(
    workspaceId: string,
  ): Promise<readonly ProviderConnection[]> {
    return await this.#pgManyJson<ProviderConnection>(
      pgSchema.connections,
      pgSchema.connections.connectionJson,
      {
        where: eq(pgSchema.connections.workspaceId, workspaceId),
        orderBy: [
          asc(pgSchema.connections.createdAt),
          asc(pgSchema.connections.id),
        ],
      },
    );
  }

  async listConnectionsPage(
    workspaceId: string,
    params: PageParams,
  ): Promise<Page<ProviderConnection>> {
    const limit = clampPageLimit(params.limit);
    const rows = await this.#pgManyJson<ProviderConnection>(
      pgSchema.connections,
      pgSchema.connections.connectionJson,
      {
        where: pgKeysetWhere(
          eq(pgSchema.connections.workspaceId, workspaceId),
          pgSchema.connections.createdAt,
          pgSchema.connections.id,
          decodeCursor(params.cursor),
        ),
        orderBy: [
          asc(pgSchema.connections.createdAt),
          asc(pgSchema.connections.id),
        ],
        limit: limit + 1,
      },
    );
    return pageFromProbe(rows, limit);
  }

  async listOperatorConnections(): Promise<readonly ProviderConnection[]> {
    return await this.#pgManyJson<ProviderConnection>(
      pgSchema.connections,
      pgSchema.connections.connectionJson,
      {
        where: isNull(pgSchema.connections.workspaceId),
        orderBy: [
          asc(pgSchema.connections.createdAt),
          asc(pgSchema.connections.id),
        ],
      },
    );
  }

  async deleteConnection(id: string): Promise<boolean> {
    return await this.#pgDelete(
      pgSchema.connections,
      eq(pgSchema.connections.id, id),
    );
  }

  async putSecretBlob(blob: StoredSecretBlob): Promise<StoredSecretBlob> {
    await this.#pgUpsert(
      pgSchema.secretBlobs,
      {
        id: blob.id,
        connectionId: blob.connectionId,
        workspaceId: blob.workspaceId ?? null,
        kind: blob.kind,
        ciphertext: blob.ciphertext,
        encryptedDek: blob.encryptedDek,
        nonce: blob.nonce,
        aad: blob.aad,
        keyVersion: blob.keyVersion,
        createdAt: blob.createdAt,
        rotatedAt: blob.rotatedAt ?? null,
        blobJson: blob,
      },
      {
        id: blob.id,
        workspaceId: blob.workspaceId ?? null,
        kind: blob.kind,
        ciphertext: blob.ciphertext,
        encryptedDek: blob.encryptedDek,
        nonce: blob.nonce,
        aad: blob.aad,
        keyVersion: blob.keyVersion,
        createdAt: blob.createdAt,
        rotatedAt: blob.rotatedAt ?? null,
        blobJson: blob,
      },
      pgSchema.secretBlobs.connectionId,
    );
    return blob;
  }

  async createSecretBlobIfAbsent(blob: StoredSecretBlob): Promise<boolean> {
    const inserted = await this.#db
      .insert(pgSchema.secretBlobs)
      .values({
        id: blob.id,
        connectionId: blob.connectionId,
        workspaceId: blob.workspaceId ?? null,
        kind: blob.kind,
        ciphertext: blob.ciphertext,
        encryptedDek: blob.encryptedDek,
        nonce: blob.nonce,
        aad: blob.aad,
        keyVersion: blob.keyVersion,
        createdAt: blob.createdAt,
        rotatedAt: blob.rotatedAt ?? null,
        blobJson: blob,
      })
      .onConflictDoNothing({ target: pgSchema.secretBlobs.connectionId })
      .returning({ id: pgSchema.secretBlobs.id });
    return inserted.length === 1;
  }

  async getSecretBlob(
    connectionId: string,
  ): Promise<StoredSecretBlob | undefined> {
    return await this.#pgFirstJson<StoredSecretBlob>(
      pgSchema.secretBlobs,
      pgSchema.secretBlobs.blobJson,
      eq(pgSchema.secretBlobs.connectionId, connectionId),
    );
  }

  async deleteSecretBlob(connectionId: string): Promise<boolean> {
    return await this.#pgDelete(
      pgSchema.secretBlobs,
      eq(pgSchema.secretBlobs.connectionId, connectionId),
    );
  }

  // --- sources (public + internal hook-secret hash / lastSeenCommit) --------

  async putSource(source: StoredSource): Promise<StoredSource> {
    await this.#pgUpsert(pgSchema.sources, {
      id: source.id,
      workspaceId: source.workspaceId,
      status: source.status,
      sourceJson: source,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
    });
    return source;
  }

  async writeSourceConfiguration(
    input: SourceConfigurationWriteInput,
  ): Promise<SourceConfigurationWriteResult> {
    assertSourceConfigurationWriteInput(input);
    const source = input.source;
    return await this.#client.transaction(async (transaction) => {
      // Workspace is the outer lock for every guarded Source configuration
      // write. The source row is then locked and compared while that same
      // persisted Workspace remains pinned for the eventual CAS.
      const management = await pgWorkspaceManagementForTransaction(
        transaction,
        source.workspaceId,
      );
      const currentRows = await transaction.query<PgStoredSourceRow>(
        `select id,
                space_id as "workspaceId",
                status,
                source_json as "sourceJson",
                created_at as "createdAt",
                updated_at as "updatedAt"
           from takosumi_sources
          where id = $1
          for update`,
        [source.id],
      );
      const currentRow = currentRows.rows[0];

      // A Source id is globally unique. An id physically owned by another
      // Workspace is a conflict and must never be rebound by the candidate.
      if (currentRow && currentRow.workspaceId !== source.workspaceId) {
        return { status: "conflict" as const };
      }
      const current = currentRow
        ? sourceFromPgRow(currentRow)
        : undefined;
      if (currentRow && !current) {
        // Treat a physically/JSON-inconsistent row as an immutable conflict;
        // no caller payload is allowed to repair its ownership or identity.
        return { status: "conflict" as const };
      }

      if (current) {
        // CREATE-only calls cannot overwrite an existing Source, even when the
        // candidate happens to be byte-for-byte identical. An exact candidate
        // is instead an observation-only replay, including the create-shaped
        // call used to retry a stopped request. This replay intentionally wins
        // before evaluating a stale expectedSource: no write can be performed
        // by this branch, so it remains safe and idempotent.
        const currentDigest = await stableJsonDigest(current);
        const candidateDigest = await stableJsonDigest(source);
        if (candidateDigest === currentDigest) {
          // Exact replay is an observation-only read and remains available
          // while Workspace management is draining or frozen.
          return { status: "replayed" as const, source: current };
        }
        if (input.expectedSource === undefined) {
          return { status: "conflict" as const };
        }
        const expectedDigest = await stableJsonDigest(input.expectedSource);
        if (currentDigest !== expectedDigest) {
          return { status: "conflict" as const };
        }

        assertWorkspaceManagementAdmission(
          management,
          source.workspaceId,
          input.expectedWorkspaceManagementAuthority,
        );
        const expectedEpochPredicate =
          input.expectedWorkspaceManagementAuthority === undefined
            ? ""
            : "\n                   and workspace.management_epoch = $11";
        const updated = await transaction.query<PgStoredSourceRow>(
          `update takosumi_sources as source_row
              set status = $1,
                  source_json = $2::jsonb,
                  created_at = $3,
                  updated_at = $4
            where source_row.id = $5
              and source_row.space_id = $6
              and source_row.status = $8
              and source_row.created_at = $9
              and source_row.updated_at = $10
              and source_row.source_json = $7::jsonb
              and exists (
                select 1
                  from takosumi_workspaces as workspace
                 where workspace.id = source_row.space_id
                   and workspace.management_state = 'active'${expectedEpochPredicate}
              )
          returning source_row.id,
                    source_row.space_id as "workspaceId",
                    source_row.status,
                    source_row.source_json as "sourceJson",
                    source_row.created_at as "createdAt",
                    source_row.updated_at as "updatedAt"`,
          [
            source.status,
            JSON.stringify(source),
            source.createdAt,
            source.updatedAt,
            source.id,
            source.workspaceId,
            JSON.stringify(input.expectedSource),
            input.expectedSource.status,
            input.expectedSource.createdAt,
            input.expectedSource.updatedAt,
            ...(input.expectedWorkspaceManagementAuthority === undefined
              ? []
              : [input.expectedWorkspaceManagementAuthority.managementEpoch]),
          ],
        );
        const updatedRow = updated.rows[0];
        const persisted = updatedRow
          ? sourceFromPgRow(updatedRow)
          : undefined;
        return persisted
          ? { status: "updated" as const, source: persisted }
          : { status: "conflict" as const };
      }

      // A missing expectedSource is the only path that can create a Source.
      if (input.expectedSource !== undefined) {
        return { status: "conflict" as const };
      }
      assertWorkspaceManagementAdmission(
        management,
        source.workspaceId,
        input.expectedWorkspaceManagementAuthority,
      );
      const expectedEpochPredicate =
        input.expectedWorkspaceManagementAuthority === undefined
          ? ""
          : "\n             and workspace.management_epoch = $7";
      const inserted = await transaction.query<PgStoredSourceRow>(
        `insert into takosumi_sources
          (id, space_id, status, source_json, created_at, updated_at)
         select $1, workspace.id, $2, $3::jsonb, $4, $5
           from takosumi_workspaces as workspace
          where workspace.id = $6
            and workspace.management_state = 'active'${expectedEpochPredicate}
         on conflict (id) do nothing
         returning id,
                   space_id as "workspaceId",
                   status,
                   source_json as "sourceJson",
                   created_at as "createdAt",
                   updated_at as "updatedAt"`,
        [
          source.id,
          source.status,
          JSON.stringify(source),
          source.createdAt,
          source.updatedAt,
          source.workspaceId,
          ...(input.expectedWorkspaceManagementAuthority === undefined
            ? []
            : [input.expectedWorkspaceManagementAuthority.managementEpoch]),
        ],
      );
      const insertedRow = inserted.rows[0];
      const persisted = insertedRow
        ? sourceFromPgRow(insertedRow)
        : undefined;
      if (persisted) return { status: "created" as const, source: persisted };

      // Distinguish an id collision from a lost Workspace admission without
      // writing anything in either case.
      const afterRows = await transaction.query<PgStoredSourceRow>(
        `select id,
                space_id as "workspaceId",
                status,
                source_json as "sourceJson",
                created_at as "createdAt",
                updated_at as "updatedAt"
           from takosumi_sources
          where id = $1
          limit 1`,
        [source.id],
      );
      if (afterRows.rows[0]) return { status: "conflict" as const };
      // The preflight assertion above protects normal paths; this second
      // assertion turns a predicate miss (including a stale epoch) into the
      // typed admission error without fabricating a Source result.
      assertWorkspaceManagementAdmission(
        undefined,
        source.workspaceId,
        input.expectedWorkspaceManagementAuthority,
      );
      return { status: "conflict" as const };
    });
  }

  async getSource(id: string): Promise<StoredSource | undefined> {
    return await this.#pgFirstJson<StoredSource>(
      pgSchema.sources,
      pgSchema.sources.sourceJson,
      eq(pgSchema.sources.id, id),
    );
  }

  async listSources(workspaceId?: string): Promise<readonly StoredSource[]> {
    return await this.#pgManyJson<StoredSource>(
      pgSchema.sources,
      pgSchema.sources.sourceJson,
      {
        where:
          workspaceId === undefined
            ? undefined
            : eq(pgSchema.sources.workspaceId, workspaceId),
        orderBy: [asc(pgSchema.sources.createdAt), asc(pgSchema.sources.id)],
      },
    );
  }

  async listSourcesPage(
    workspaceId: string,
    params: PageParams,
  ): Promise<Page<StoredSource>> {
    const limit = clampPageLimit(params.limit);
    const rows = await this.#pgManyJson<StoredSource>(
      pgSchema.sources,
      pgSchema.sources.sourceJson,
      {
        where: pgKeysetWhere(
          eq(pgSchema.sources.workspaceId, workspaceId),
          pgSchema.sources.createdAt,
          pgSchema.sources.id,
          decodeCursor(params.cursor),
        ),
        orderBy: [asc(pgSchema.sources.createdAt), asc(pgSchema.sources.id)],
        limit: limit + 1,
      },
    );
    return pageFromProbe(rows, limit);
  }

  async listAllSourcesPage(params: PageParams): Promise<Page<StoredSource>> {
    const limit = clampPageLimit(params.limit);
    const rows = await this.#pgManyJson<StoredSource>(
      pgSchema.sources,
      pgSchema.sources.sourceJson,
      {
        where: pgKeysetWhere(
          undefined,
          pgSchema.sources.createdAt,
          pgSchema.sources.id,
          decodeCursor(params.cursor),
        ),
        orderBy: [asc(pgSchema.sources.createdAt), asc(pgSchema.sources.id)],
        limit: limit + 1,
      },
    );
    return pageFromProbe(rows, limit);
  }

  async deleteSource(id: string): Promise<boolean> {
    return await this.#pgDelete(pgSchema.sources, eq(pgSchema.sources.id, id));
  }

  async putSourceSnapshot(snapshot: SourceSnapshot): Promise<SourceSnapshot> {
    const normalized = normalizeSourceSnapshotRecord(snapshot);
    await this.#pgUpsert(pgSchema.sourceSnapshots, {
      id: normalized.id,
      sourceId: normalized.sourceId,
      snapshotJson: normalized,
      fetchedAt: normalized.fetchedAt,
    });
    return normalized;
  }

  async getSourceSnapshot(id: string): Promise<SourceSnapshot | undefined> {
    return normalizeOptionalSourceSnapshotRecord(
      await this.#pgFirstJson<SourceSnapshot>(
        pgSchema.sourceSnapshots,
        pgSchema.sourceSnapshots.snapshotJson,
        eq(pgSchema.sourceSnapshots.id, id),
      ),
    );
  }

  async listSourceSnapshots(
    sourceId: string,
  ): Promise<readonly SourceSnapshot[]> {
    return (
      await this.#pgManyJson<SourceSnapshot>(
        pgSchema.sourceSnapshots,
        pgSchema.sourceSnapshots.snapshotJson,
        {
          where: eq(pgSchema.sourceSnapshots.sourceId, sourceId),
          orderBy: [
            asc(pgSchema.sourceSnapshots.fetchedAt),
            asc(pgSchema.sourceSnapshots.id),
          ],
        },
      )
    ).map(normalizeSourceSnapshotRecord);
  }

  async listSourceSnapshotsBySourceIds(
    sourceIds: readonly string[],
  ): Promise<readonly SourceSnapshot[]> {
    if (sourceIds.length === 0) return [];
    return (
      await this.#pgManyJson<SourceSnapshot>(
        pgSchema.sourceSnapshots,
        pgSchema.sourceSnapshots.snapshotJson,
        {
          where: inArray(pgSchema.sourceSnapshots.sourceId, [...sourceIds]),
          orderBy: [
            asc(pgSchema.sourceSnapshots.fetchedAt),
            asc(pgSchema.sourceSnapshots.id),
          ],
        },
      )
    ).map(normalizeSourceSnapshotRecord);
  }

  async listSourceSnapshotsPage(
    sourceId: string,
    params: PageParams,
  ): Promise<Page<SourceSnapshot>> {
    const limit = clampPageLimit(params.limit);
    const rows = await this.#pgManyJson<SourceSnapshot>(
      pgSchema.sourceSnapshots,
      pgSchema.sourceSnapshots.snapshotJson,
      {
        where: pgKeysetWhere(
          eq(pgSchema.sourceSnapshots.sourceId, sourceId),
          pgSchema.sourceSnapshots.fetchedAt,
          pgSchema.sourceSnapshots.id,
          decodeCursor(params.cursor),
        ),
        orderBy: [
          asc(pgSchema.sourceSnapshots.fetchedAt),
          asc(pgSchema.sourceSnapshots.id),
        ],
        limit: limit + 1,
      },
    );
    return pageFromProbeBy(
      rows.map(normalizeSourceSnapshotRecord),
      limit,
      (s) => ({
        createdAt: s.fetchedAt,
        id: s.id,
      }),
    );
  }

  async putCapsuleCompatibilityReport(
    report: CapsuleCompatibilityReport,
  ): Promise<CapsuleCompatibilityReport> {
    const normalized = normalizeStoredCapsuleCompatibilityReport(report);
    await this.#pgUpsert(pgSchema.capsuleCompatibilityReports, {
      id: normalized.id,
      sourceId: normalized.sourceId ?? null,
      capsuleId: normalized.capsuleId ?? null,
      sourceSnapshotId: normalized.sourceSnapshotId,
      modulePath: normalized.modulePath ?? null,
      level: normalized.level,
      findingsJson: normalized.findings,
      providersJson: storedCapsuleCompatibilityProviderGraph(normalized),
      resourcesJson: normalized.resources,
      dataSourcesJson: normalized.dataSources,
      provisionersJson: normalized.provisioners,
      rootModuleVariablesJson: normalized.rootModuleVariables ?? [],
      rootModuleVariableDeclarationsJson:
        normalized.rootModuleVariableDeclarations ?? null,
      rootModuleOutputsJson: normalized.rootModuleOutputs ?? [],
      createdAt: normalized.createdAt,
    });
    return normalized;
  }

  async getCapsuleCompatibilityReport(
    id: string,
  ): Promise<CapsuleCompatibilityReport | undefined> {
    const rows = await this.#db
      .select()
      .from(pgSchema.capsuleCompatibilityReports)
      .where(eq(pgSchema.capsuleCompatibilityReports.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    const providerGraph = parseStoredCapsuleCompatibilityProviderGraph(
      parseJson(row.providersJson),
    );
    return {
      id: row.id,
      sourceId: compatibilityReportSourceId(row.sourceId),
      ...(row.capsuleId ? { capsuleId: row.capsuleId } : {}),
      sourceSnapshotId: row.sourceSnapshotId,
      ...(row.modulePath ? { modulePath: row.modulePath } : {}),
      level: normalizeStoredCapsuleCompatibilityLevel(row.level),
      findings: parseJson(
        row.findingsJson,
      ) as CapsuleCompatibilityReport["findings"],
      ...providerGraph,
      resources: parseJson(
        row.resourcesJson,
      ) as CapsuleCompatibilityReport["resources"],
      dataSources: parseJson(
        row.dataSourcesJson,
      ) as CapsuleCompatibilityReport["dataSources"],
      provisioners: parseJson(
        row.provisionersJson,
      ) as CapsuleCompatibilityReport["provisioners"],
      rootModuleVariables: parseJson(
        row.rootModuleVariablesJson,
      ) as CapsuleCompatibilityReport["rootModuleVariables"],
      ...(row.rootModuleVariableDeclarationsJson === null
        ? {}
        : {
            rootModuleVariableDeclarations:
              parseStoredCapsuleRootModuleVariableDeclarations(
                parseJson(row.rootModuleVariableDeclarationsJson),
              ),
          }),
      rootModuleOutputs: parseJson(
        row.rootModuleOutputsJson,
      ) as CapsuleCompatibilityReport["rootModuleOutputs"],
      createdAt: row.createdAt,
    };
  }

  async getLatestCapsuleCompatibilityReportForSourceSnapshot(
    sourceSnapshotId: string,
    options: {
      readonly sourceId?: string;
      readonly capsuleId?: string;
    } = {},
  ): Promise<CapsuleCompatibilityReport | undefined> {
    const filters = [
      eq(
        pgSchema.capsuleCompatibilityReports.sourceSnapshotId,
        sourceSnapshotId,
      ),
    ];
    if (options.sourceId) {
      filters.push(
        eq(pgSchema.capsuleCompatibilityReports.sourceId, options.sourceId),
      );
    }
    if (options.capsuleId) {
      filters.push(
        or(
          isNull(pgSchema.capsuleCompatibilityReports.capsuleId),
          eq(pgSchema.capsuleCompatibilityReports.capsuleId, options.capsuleId),
        )!,
      );
    }
    const rows = await this.#db
      .select()
      .from(pgSchema.capsuleCompatibilityReports)
      .where(and(...filters))
      .orderBy(
        desc(pgSchema.capsuleCompatibilityReports.createdAt),
        desc(pgSchema.capsuleCompatibilityReports.id),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    const providerGraph = parseStoredCapsuleCompatibilityProviderGraph(
      parseJson(row.providersJson),
    );
    return {
      id: row.id,
      sourceId: compatibilityReportSourceId(row.sourceId),
      ...(row.capsuleId ? { capsuleId: row.capsuleId } : {}),
      sourceSnapshotId: row.sourceSnapshotId,
      ...(row.modulePath ? { modulePath: row.modulePath } : {}),
      level: normalizeStoredCapsuleCompatibilityLevel(row.level),
      findings: parseJson(
        row.findingsJson,
      ) as CapsuleCompatibilityReport["findings"],
      ...providerGraph,
      resources: parseJson(
        row.resourcesJson,
      ) as CapsuleCompatibilityReport["resources"],
      dataSources: parseJson(
        row.dataSourcesJson,
      ) as CapsuleCompatibilityReport["dataSources"],
      provisioners: parseJson(
        row.provisionersJson,
      ) as CapsuleCompatibilityReport["provisioners"],
      rootModuleVariables: parseJson(
        row.rootModuleVariablesJson,
      ) as CapsuleCompatibilityReport["rootModuleVariables"],
      ...(row.rootModuleVariableDeclarationsJson === null
        ? {}
        : {
            rootModuleVariableDeclarations:
              parseStoredCapsuleRootModuleVariableDeclarations(
                parseJson(row.rootModuleVariableDeclarationsJson),
              ),
          }),
      rootModuleOutputs: parseJson(
        row.rootModuleOutputsJson,
      ) as CapsuleCompatibilityReport["rootModuleOutputs"],
      createdAt: row.createdAt,
    };
  }

  // --- Provider Binding sets (physical key: installation_id, environment) --

  async deleteProviderBindingSet(
    capsuleId: string,
    environment: string,
  ): Promise<void> {
    await this.#db
      .delete(pgSchema.providerBindingSets)
      .where(
        and(
          eq(pgSchema.providerBindingSets.capsuleId, capsuleId),
          eq(pgSchema.providerBindingSets.environment, environment),
        ),
      );
  }

  async getProviderBindingSetByCapsule(
    capsuleId: string,
    environment: string,
  ): Promise<ProviderBindingSet | undefined> {
    const rows = await this.#pgManyJson<ProviderBindingSet>(
      pgSchema.providerBindingSets,
      pgSchema.providerBindingSets.profileJson,
      {
        where: and(
          eq(pgSchema.providerBindingSets.capsuleId, capsuleId),
          eq(pgSchema.providerBindingSets.environment, environment),
        ),
        orderBy: [
          desc(pgSchema.providerBindingSets.createdAt),
          desc(pgSchema.providerBindingSets.id),
        ],
        limit: 1,
      },
    );
    return rows[0];
  }

  // --- StateVersion (physical key: installation_id, environment, generation) -

  async putStateVersion(snapshot: StateVersion): Promise<StateVersion> {
    await pgUpsertStateVersion(this.#db, snapshot);
    return snapshot;
  }

  async getStateVersion(id: string): Promise<StateVersion | undefined> {
    return await this.#pgFirstJson<StateVersion>(
      pgSchema.stateVersions,
      pgSchema.stateVersions.snapshotJson,
      eq(pgSchema.stateVersions.id, id),
    );
  }

  async getStateVersionsByIds(
    ids: readonly string[],
  ): Promise<readonly StateVersion[]> {
    if (ids.length === 0) return [];
    const rows = await this.#db
      .select({ json: pgSchema.stateVersions.snapshotJson })
      .from(pgSchema.stateVersions)
      .where(inArray(pgSchema.stateVersions.id, [...new Set(ids)]));
    const byId = new Map(
      rows.map((row) => {
        const value = parseRow(row) as StateVersion;
        return [value.id, value] as const;
      }),
    );
    return ids
      .map((id) => byId.get(id))
      .filter((row): row is StateVersion => row !== undefined);
  }

  async getLatestStateVersion(
    capsuleId: string,
    environment: string,
  ): Promise<StateVersion | undefined> {
    const rows = await this.#pgManyJson<StateVersion>(
      pgSchema.stateVersions,
      pgSchema.stateVersions.snapshotJson,
      {
        where: and(
          eq(pgSchema.stateVersions.capsuleId, capsuleId),
          eq(pgSchema.stateVersions.environment, environment),
        ),
        orderBy: [desc(pgSchema.stateVersions.generation)],
        limit: 1,
      },
    );
    return rows[0];
  }

  async listStateVersions(
    capsuleId: string,
    environment: string,
  ): Promise<readonly StateVersion[]> {
    return await this.#pgManyJson<StateVersion>(
      pgSchema.stateVersions,
      pgSchema.stateVersions.snapshotJson,
      {
        where: and(
          eq(pgSchema.stateVersions.capsuleId, capsuleId),
          eq(pgSchema.stateVersions.environment, environment),
        ),
        orderBy: [asc(pgSchema.stateVersions.generation)],
      },
    );
  }

  async listStateVersionsPage(
    capsuleId: string,
    environment: string,
    params: PageParams,
  ): Promise<Page<StateVersion>> {
    return pageSorted(
      await this.listStateVersions(capsuleId, environment),
      params,
    );
  }

  async listStateVersionsByWorkspace(
    workspaceId: string,
  ): Promise<readonly StateVersion[]> {
    return await this.#pgManyJson<StateVersion>(
      pgSchema.stateVersions,
      pgSchema.stateVersions.snapshotJson,
      {
        where: eq(pgSchema.stateVersions.workspaceId, workspaceId),
        orderBy: [asc(pgSchema.stateVersions.generation)],
      },
    );
  }

  // --- installation_dependencies (§14 / §15) --------------------------------

  async putDependency(dependency: Dependency): Promise<Dependency> {
    await this.#pgUpsert(pgSchema.dependencies, {
      id: dependency.id,
      workspaceId: dependency.workspaceId,
      producerCapsuleId: dependency.producerCapsuleId,
      consumerCapsuleId: dependency.consumerCapsuleId,
      dependencyJson: dependency,
      createdAt: dependency.createdAt,
    });
    return dependency;
  }

  async getDependency(id: string): Promise<Dependency | undefined> {
    return await this.#pgFirstJson<Dependency>(
      pgSchema.dependencies,
      pgSchema.dependencies.dependencyJson,
      eq(pgSchema.dependencies.id, id),
    );
  }

  async listDependenciesByWorkspace(
    workspaceId: string,
  ): Promise<readonly Dependency[]> {
    return await this.#pgManyJson<Dependency>(
      pgSchema.dependencies,
      pgSchema.dependencies.dependencyJson,
      {
        where: eq(pgSchema.dependencies.workspaceId, workspaceId),
        orderBy: [
          asc(pgSchema.dependencies.createdAt),
          asc(pgSchema.dependencies.id),
        ],
      },
    );
  }

  async listDependenciesForConsumer(
    consumerCapsuleId: string,
  ): Promise<readonly Dependency[]> {
    return await this.#pgManyJson<Dependency>(
      pgSchema.dependencies,
      pgSchema.dependencies.dependencyJson,
      {
        where: eq(pgSchema.dependencies.consumerCapsuleId, consumerCapsuleId),
        orderBy: [
          asc(pgSchema.dependencies.createdAt),
          asc(pgSchema.dependencies.id),
        ],
      },
    );
  }

  async listDependenciesForProducer(
    producerCapsuleId: string,
  ): Promise<readonly Dependency[]> {
    return await this.#pgManyJson<Dependency>(
      pgSchema.dependencies,
      pgSchema.dependencies.dependencyJson,
      {
        where: eq(pgSchema.dependencies.producerCapsuleId, producerCapsuleId),
        orderBy: [
          asc(pgSchema.dependencies.createdAt),
          asc(pgSchema.dependencies.id),
        ],
      },
    );
  }

  async deleteDependency(id: string): Promise<boolean> {
    return await this.#pgDelete(
      pgSchema.dependencies,
      eq(pgSchema.dependencies.id, id),
    );
  }

  // --- dependency_snapshots (§17) -------------------------------------------

  async putDependencySnapshot(
    snapshot: DependencySnapshot,
  ): Promise<DependencySnapshot> {
    await this.#pgUpsert(pgSchema.dependencySnapshots, {
      id: snapshot.id,
      runId: snapshot.runId,
      snapshotJson: snapshot,
      createdAt: snapshot.createdAt,
    });
    return snapshot;
  }

  async getDependencySnapshot(
    id: string,
  ): Promise<DependencySnapshot | undefined> {
    return await this.#pgFirstJson<DependencySnapshot>(
      pgSchema.dependencySnapshots,
      pgSchema.dependencySnapshots.snapshotJson,
      eq(pgSchema.dependencySnapshots.id, id),
    );
  }

  // --- output_snapshots (§16) -----------------------------------------------

  async putOutput(snapshot: Output): Promise<Output> {
    await pgUpsertOutput(this.#db, snapshot);
    return snapshot;
  }

  async getOutput(id: string): Promise<Output | undefined> {
    return await this.#pgFirstJson<Output>(
      pgSchema.outputs,
      pgSchema.outputs.snapshotJson,
      eq(pgSchema.outputs.id, id),
    );
  }

  async getCapsuleInterfaceMaterializationIntent(
    id: string,
  ): Promise<CapsuleInterfaceMaterializationIntent | undefined> {
    const rows = await this.#db
      .select()
      .from(pgSchema.capsuleInterfaceMaterializationIntents)
      .where(eq(pgSchema.capsuleInterfaceMaterializationIntents.id, id))
      .limit(1);
    if (!rows[0]) return undefined;
    const intent = capsuleInterfaceMaterializationIntentFromPgRow(rows[0]);
    await validateCapsuleInterfaceMaterializationIntent(intent);
    return intent;
  }

  async listDeadLetteredCapsuleInterfaceMaterializationIntents(
    workspaceId: string,
    limit?: number,
  ): Promise<readonly CapsuleInterfaceMaterializationIntent[]> {
    if (typeof workspaceId !== "string" || workspaceId.trim() === "") {
      throw new TypeError("workspaceId is required");
    }
    const rows = await this.#db
      .select()
      .from(pgSchema.capsuleInterfaceMaterializationIntents)
      .where(
        and(
          eq(
            pgSchema.capsuleInterfaceMaterializationIntents.workspaceId,
            workspaceId,
          ),
          eq(
            pgSchema.capsuleInterfaceMaterializationIntents.status,
            "dead_letter",
          ),
        ),
      )
      .orderBy(
        desc(pgSchema.capsuleInterfaceMaterializationIntents.deadLetteredAt),
        desc(pgSchema.capsuleInterfaceMaterializationIntents.id),
      )
      .limit(capsuleInterfaceMaterializationFailureListLimit(limit));
    const intents = rows.map(capsuleInterfaceMaterializationIntentFromPgRow);
    await Promise.all(intents.map(validateCapsuleInterfaceMaterializationIntent));
    return intents;
  }

  async claimCapsuleInterfaceMaterializationIntent(
    input: ClaimCapsuleInterfaceMaterializationIntentInput,
  ): Promise<CapsuleInterfaceMaterializationIntent | undefined> {
    assertCapsuleInterfaceMaterializationIntentClaimInput(input);
    const table = pgSchema.capsuleInterfaceMaterializationIntents;
    const candidateId = sql<string>`(
      select ${table.id}
      from ${table}
      where ${table.status} = 'pending'
        and ${input.intentId === undefined
          ? sql`true`
          : sql`${table.id} = ${input.intentId}`}
        and ${table.nextRetryAt} <= ${input.claimedAt}
        and (
          ${table.leaseExpiresAt} is null
          or ${table.leaseExpiresAt} <= ${input.claimedAt}
        )
      order by ${table.nextRetryAt}, ${table.createdAt}, ${table.id}
      for update skip locked
      limit 1
    )`;
    const rows = await this.#db
      .update(table)
      .set({
        attempts: sql`${table.attempts} + 1`,
        leaseToken: input.leaseToken,
        leaseExpiresAt: input.leaseExpiresAt,
        updatedAt: input.claimedAt,
      })
      .where(eq(table.id, candidateId))
      .returning();
    if (!rows[0]) return undefined;
    const intent = capsuleInterfaceMaterializationIntentFromPgRow(rows[0]);
    await validateCapsuleInterfaceMaterializationIntent(intent);
    return intent;
  }

  async renewCapsuleInterfaceMaterializationIntentLease(
    input: RenewCapsuleInterfaceMaterializationIntentLeaseInput,
  ): Promise<RenewCapsuleInterfaceMaterializationIntentLeaseResult> {
    assertRenewCapsuleInterfaceMaterializationIntentLeaseInput(input);
    const table = pgSchema.capsuleInterfaceMaterializationIntents;
    const rows = await this.#db
      .update(table)
      .set({
        leaseExpiresAt: input.leaseExpiresAt,
        updatedAt: input.renewedAt,
      })
      .where(
        and(
          eq(table.id, input.id),
          eq(table.status, "pending"),
          eq(table.leaseToken, input.leaseToken),
          eq(table.nextItemIndex, input.expectedNextItemIndex),
          gt(table.leaseExpiresAt, input.renewedAt),
          sql`${input.leaseExpiresAt} > ${table.leaseExpiresAt}`,
        ),
      )
      .returning();
    if (rows[0]) {
      const intent = capsuleInterfaceMaterializationIntentFromPgRow(rows[0]);
      await validateCapsuleInterfaceMaterializationIntent(intent);
      return { kind: "updated", intent };
    }
    return (await this.getCapsuleInterfaceMaterializationIntent(input.id))
      ? { kind: "lease-lost" }
      : { kind: "not-found" };
  }

  async settleCapsuleInterfaceMaterializationIntent(
    input: SettleCapsuleInterfaceMaterializationIntentInput,
  ): Promise<SettleCapsuleInterfaceMaterializationIntentResult> {
    assertCapsuleInterfaceMaterializationIntentSettlementInput(input);
    const table = pgSchema.capsuleInterfaceMaterializationIntents;
    const error =
      input.outcome.kind === "completed" || input.outcome.kind === "progress"
      ? null
      : {
          code: input.outcome.code,
          detailDigest: input.outcome.detailDigest,
          recordedAt: input.settledAt,
        };
    const rows = await this.#db
      .update(table)
      .set({
        status: input.outcome.kind === "completed"
          ? "completed"
          : input.outcome.kind === "retry" || input.outcome.kind === "progress"
            ? "pending"
            : "dead_letter",
        ...(input.outcome.kind === "progress" ? { attempts: 0 } : {}),
        ...(input.outcome.kind !== "progress" || input.outcome.releaseLease
          ? { leaseToken: null, leaseExpiresAt: null }
          : {}),
        errorJson: error,
        updatedAt: input.settledAt,
        ...(input.outcome.kind === "completed"
          ? {
              receiptJson: sql`jsonb_build_object(
                'disposition', ${input.outcome.disposition}::text,
                'blueprintsDigest', ${table.blueprintsDigest},
                'completedAt', ${input.settledAt}::text
              )`,
              completedAt: input.settledAt,
              deadLetteredAt: null,
              nextItemIndex:
                input.outcome.disposition === "materialized"
                  ? sql`${table.totalItems}`
                  : sql`${table.nextItemIndex}`,
            }
          : input.outcome.kind === "progress"
            ? {
                nextItemIndex: input.outcome.nextItemIndex,
                ...(input.outcome.releaseLease
                  ? { nextRetryAt: input.outcome.nextRetryAt! }
                  : {}),
                receiptJson: null,
                completedAt: null,
                deadLetteredAt: null,
              }
          : input.outcome.kind === "retry"
            ? {
                nextRetryAt: input.outcome.nextRetryAt,
                receiptJson: null,
                completedAt: null,
                deadLetteredAt: null,
              }
            : {
                receiptJson: null,
                completedAt: null,
                deadLetteredAt: input.settledAt,
              }),
      })
      .where(
        and(
          eq(table.id, input.id),
          eq(table.status, "pending"),
          eq(table.leaseToken, input.leaseToken),
          eq(table.nextItemIndex, input.expectedNextItemIndex),
          gt(table.leaseExpiresAt, input.settledAt),
          input.outcome.kind === "progress"
            ? sql`${table.totalItems} >= ${input.outcome.nextItemIndex}`
            : sql`true`,
        ),
      )
      .returning();
    if (rows[0]) {
      const intent = capsuleInterfaceMaterializationIntentFromPgRow(rows[0]);
      await validateCapsuleInterfaceMaterializationIntent(intent);
      return { kind: "updated", intent };
    }
    return (await this.getCapsuleInterfaceMaterializationIntent(input.id))
      ? { kind: "lease-lost" }
      : { kind: "not-found" };
  }

  async retryCapsuleInterfaceMaterializationIntent(
    input: RetryCapsuleInterfaceMaterializationIntentInput,
  ): Promise<RetryCapsuleInterfaceMaterializationIntentResult> {
    assertRetryCapsuleInterfaceMaterializationIntentInput(input);
    const table = pgSchema.capsuleInterfaceMaterializationIntents;
    const capsule = pgSchema.capsules;
    const expected = input.expected;
    const rows = await this.#db
      .update(table)
      .set({
        status: "pending",
        nextRetryAt: input.retriedAt,
        leaseToken: null,
        leaseExpiresAt: null,
        errorJson: null,
        receiptJson: null,
        completedAt: null,
        deadLetteredAt: null,
        updatedAt: input.retriedAt,
      })
      .where(
        and(
          eq(table.id, input.id),
          eq(table.workspaceId, input.workspaceId),
          eq(table.status, "dead_letter"),
          eq(table.stateVersionId, input.expectedStateVersionId),
          eq(table.stateGeneration, input.expectedStateGeneration),
          eq(table.outputId, expected.outputId),
          eq(table.blueprintsDigest, expected.blueprintsDigest),
          eq(table.totalItems, expected.totalItems),
          eq(table.nextItemIndex, expected.nextItemIndex),
          eq(table.attempts, expected.attempts),
          eq(table.updatedAt, expected.updatedAt),
          eq(table.deadLetteredAt, expected.deadLetteredAt!),
          sql`${table.errorJson}->>'code' = ${expected.error!.code}`,
          sql`${table.errorJson}->>'detailDigest' = ${expected.error!.detailDigest}`,
          sql`${table.errorJson}->>'recordedAt' = ${expected.error!.recordedAt}`,
          exists(
            this.#db
              .select({ id: capsule.id })
              .from(capsule)
              .where(
                and(
                  eq(capsule.id, table.capsuleId),
                  eq(capsule.workspaceId, input.workspaceId),
                  ne(capsule.status, "destroyed"),
                  eq(capsule.installConfigId, table.installConfigId),
                  eq(
                    capsule.currentStateVersionId,
                    input.expectedStateVersionId,
                  ),
                  sql`(${capsule.capsuleJson}->>'currentStateGeneration')::integer = ${input.expectedStateGeneration}`,
                  sql`${capsule.capsuleJson}->>'currentOutputId' = ${expected.outputId}`,
                ),
              ),
          ),
        ),
      )
      .returning();
    if (rows[0]) {
      const intent = capsuleInterfaceMaterializationIntentFromPgRow(rows[0]);
      await validateCapsuleInterfaceMaterializationIntent(intent);
      return { kind: "updated", intent };
    }
    return (await this.getCapsuleInterfaceMaterializationIntent(input.id))
      ? { kind: "conflict" }
      : { kind: "not-found" };
  }

  async getLatestOutput(capsuleId: string): Promise<Output | undefined> {
    const rows = await this.#pgManyJson<Output>(
      pgSchema.outputs,
      pgSchema.outputs.snapshotJson,
      {
        where: eq(pgSchema.outputs.capsuleId, capsuleId),
        orderBy: [
          desc(pgSchema.outputs.stateGeneration),
          desc(pgSchema.outputs.createdAt),
          desc(pgSchema.outputs.id),
        ],
        limit: 1,
      },
    );
    return rows[0];
  }

  async listOutputs(capsuleId: string): Promise<readonly Output[]> {
    return await this.#pgManyJson<Output>(
      pgSchema.outputs,
      pgSchema.outputs.snapshotJson,
      {
        where: eq(pgSchema.outputs.capsuleId, capsuleId),
        orderBy: [
          pgSchema.outputs.stateGeneration,
          pgSchema.outputs.createdAt,
          pgSchema.outputs.id,
        ],
      },
    );
  }

  async listOutputsByWorkspace(
    workspaceId: string,
  ): Promise<readonly Output[]> {
    return await this.#pgManyJson<Output>(
      pgSchema.outputs,
      pgSchema.outputs.snapshotJson,
      {
        where: eq(pgSchema.outputs.workspaceId, workspaceId),
        orderBy: [
          pgSchema.outputs.stateGeneration,
          pgSchema.outputs.createdAt,
          pgSchema.outputs.id,
        ],
      },
    );
  }

  // --- output_shares (§18) --------------------------------------------------

  async putOutputShare(share: OutputShare): Promise<OutputShare> {
    await this.#pgUpsert(pgSchema.outputShares, {
      id: share.id,
      fromWorkspaceId: share.fromWorkspaceId,
      toWorkspaceId: share.toWorkspaceId,
      producerCapsuleId: share.producerCapsuleId,
      status: share.status,
      shareJson: share,
      createdAt: share.createdAt,
    });
    return share;
  }

  async getOutputShare(id: string): Promise<OutputShare | undefined> {
    return await this.#pgFirstJson<OutputShare>(
      pgSchema.outputShares,
      pgSchema.outputShares.shareJson,
      eq(pgSchema.outputShares.id, id),
    );
  }

  async listOutputSharesFromWorkspace(
    fromWorkspaceId: string,
  ): Promise<readonly OutputShare[]> {
    return await this.#pgManyJson<OutputShare>(
      pgSchema.outputShares,
      pgSchema.outputShares.shareJson,
      {
        where: eq(pgSchema.outputShares.fromWorkspaceId, fromWorkspaceId),
        orderBy: [
          asc(pgSchema.outputShares.createdAt),
          asc(pgSchema.outputShares.id),
        ],
      },
    );
  }

  async listOutputSharesToWorkspace(
    toWorkspaceId: string,
  ): Promise<readonly OutputShare[]> {
    return await this.#pgManyJson<OutputShare>(
      pgSchema.outputShares,
      pgSchema.outputShares.shareJson,
      {
        where: eq(pgSchema.outputShares.toWorkspaceId, toWorkspaceId),
        orderBy: [
          asc(pgSchema.outputShares.createdAt),
          asc(pgSchema.outputShares.id),
        ],
      },
    );
  }

  // --- run_groups (§19 / §24) -----------------------------------------------

  async putRunGroup(group: RunGroup): Promise<RunGroup> {
    await this.#pgUpsert(pgSchema.runGroups, {
      id: group.id,
      workspaceId: group.workspaceId,
      type: group.type,
      groupJson: group,
      createdAt: group.createdAt,
    });
    return group;
  }

  async getRunGroup(id: string): Promise<RunGroup | undefined> {
    return await this.#pgFirstJson<RunGroup>(
      pgSchema.runGroups,
      pgSchema.runGroups.groupJson,
      eq(pgSchema.runGroups.id, id),
    );
  }

  async listRunGroups(workspaceId: string): Promise<readonly RunGroup[]> {
    return await this.#pgManyJson<RunGroup>(
      pgSchema.runGroups,
      pgSchema.runGroups.groupJson,
      {
        where: eq(pgSchema.runGroups.workspaceId, workspaceId),
        orderBy: [
          asc(pgSchema.runGroups.createdAt),
          asc(pgSchema.runGroups.id),
        ],
      },
    );
  }

  // --- audit_events (§27 / §34 Activity) ------------------------------------
  //
  // The §27 audit_events row keeps searchable columns (space_id / created_at)
  // for the list path; the full event (including non-secret metadata) round
  // trips through `event_json`. Listing is newest-first (created_at desc, id
  // desc) with a clamped limit.

  async putActivityEvent(event: ActivityEvent): Promise<ActivityEvent> {
    await this.#pgUpsert(pgSchema.auditEvents, {
      id: event.id,
      workspaceId: event.workspaceId,
      actorId: event.actorId ?? null,
      action: event.action,
      targetType: event.targetType,
      targetId: event.targetId,
      runId: event.runId ?? null,
      eventJson: event,
      createdAt: event.createdAt,
    });
    return event;
  }

  async listActivityEvents(
    workspaceId: string,
    options: { readonly limit?: number } = {},
  ): Promise<readonly ActivityEvent[]> {
    const limit = clampActivityLimit(options.limit);
    return await this.#pgManyJson<ActivityEvent>(
      pgSchema.auditEvents,
      pgSchema.auditEvents.eventJson,
      {
        where: eq(pgSchema.auditEvents.workspaceId, workspaceId),
        orderBy: [
          desc(pgSchema.auditEvents.createdAt),
          desc(pgSchema.auditEvents.id),
        ],
        limit,
      },
    );
  }

  async listActivityEventsForWorkspaces(
    workspaceIds: readonly string[],
    options: { readonly limit?: number } = {},
  ): Promise<readonly ActivityEvent[]> {
    const ids = boundedActivityWorkspaceIds(workspaceIds);
    if (ids.length === 0) return [];
    const limit = clampActivityLimit(options.limit);
    return await this.#pgManyJson<ActivityEvent>(
      pgSchema.auditEvents,
      pgSchema.auditEvents.eventJson,
      {
        where: inArray(pgSchema.auditEvents.workspaceId, ids),
        orderBy: [
          desc(pgSchema.auditEvents.createdAt),
          desc(pgSchema.auditEvents.id),
        ],
        limit,
      },
    );
  }

  async listActivityEventsForTargetPage(
    workspaceId: string,
    targetType: string,
    targetId: string,
    params: PageParams,
  ): Promise<Page<ActivityEvent>> {
    const limit = clampPageLimit(params.limit);
    const cursor = decodeCursor(params.cursor);
    const rows = await this.#pgManyJson<ActivityEvent>(
      pgSchema.auditEvents,
      pgSchema.auditEvents.eventJson,
      {
        where: pgKeysetWhereDesc(
          and(
            eq(pgSchema.auditEvents.workspaceId, workspaceId),
            eq(pgSchema.auditEvents.targetType, targetType),
            eq(pgSchema.auditEvents.targetId, targetId),
          ),
          pgSchema.auditEvents.createdAt,
          pgSchema.auditEvents.id,
          cursor,
        ),
        orderBy: [
          desc(pgSchema.auditEvents.createdAt),
          desc(pgSchema.auditEvents.id),
        ],
        limit: limit + 1,
      },
    );
    return pageFromProbe(rows, limit);
  }

  // --- credential_mint_events (spec invariant 17) ---------------------------
  //
  // Non-secret mint audit rows. The JSON payload carries metadata only:
  // run/space/installation/connection/phase/provider labels.

  async putCredentialMintEvent(
    event: CredentialMintEvent,
  ): Promise<CredentialMintEvent> {
    await this.#pgUpsert(pgSchema.credentialMintEvents, {
      id: event.id,
      runId: event.runId,
      // Physical columns space_id / installation_id are frozen; the contract
      // type renamed to workspaceId / capsuleId.
      workspaceId: event.workspaceId,
      capsuleId: event.capsuleId ?? null,
      sourceId: event.sourceId ?? null,
      connectionId: event.connectionId ?? "",
      phase: event.phase,
      eventJson: event,
      createdAt: event.createdAt,
    });
    return event;
  }

  async listCredentialMintEventsForRun(
    runId: string,
  ): Promise<readonly CredentialMintEvent[]> {
    return await this.#pgManyJson<CredentialMintEvent>(
      pgSchema.credentialMintEvents,
      pgSchema.credentialMintEvents.eventJson,
      {
        where: eq(pgSchema.credentialMintEvents.runId, runId),
        orderBy: [
          asc(pgSchema.credentialMintEvents.createdAt),
          asc(pgSchema.credentialMintEvents.id),
        ],
      },
    );
  }

  async putSecurityFinding(finding: SecurityFinding): Promise<SecurityFinding> {
    await this.#pgUpsert(pgSchema.securityFindings, {
      id: finding.id,
      // Physical columns space_id / installation_id are frozen; the contract
      // type renamed to workspaceId / capsuleId.
      workspaceId: finding.workspaceId,
      capsuleId: finding.capsuleId ?? null,
      runId: finding.runId ?? null,
      severity: finding.severity,
      type: finding.type,
      findingJson: finding,
      createdAt: finding.createdAt,
    });
    return finding;
  }

  async listSecurityFindings(
    workspaceId: string,
    options: { readonly runId?: string; readonly limit?: number } = {},
  ): Promise<readonly SecurityFinding[]> {
    const limit = clampActivityLimit(options.limit);
    return await this.#pgManyJson<SecurityFinding>(
      pgSchema.securityFindings,
      pgSchema.securityFindings.findingJson,
      {
        where:
          options.runId === undefined
            ? eq(pgSchema.securityFindings.workspaceId, workspaceId)
            : and(
                eq(pgSchema.securityFindings.workspaceId, workspaceId),
                eq(pgSchema.securityFindings.runId, options.runId),
              ),
        orderBy: [
          desc(pgSchema.securityFindings.createdAt),
          desc(pgSchema.securityFindings.id),
        ],
        limit,
      },
    );
  }

  // --- provider-neutral OSS showback usage --------------------------------

  async putUsageEvent(event: UsageEvent): Promise<UsageEvent> {
    const existing = await this.#usageEventByIdempotencyKey(
      event.idempotencyKey,
    );
    if (existing) return existing;
    const normalized = normalizeUsageEvent(event);
    await this.#pgUpsert(
      pgSchema.usageEvents,
      {
        id: normalized.id,
        workspaceId: normalized.workspaceId,
        capsuleId: normalized.capsuleId ?? null,
        runId: normalized.runId ?? null,
        meterId: normalized.meterId ?? null,
        resourceFamily: normalized.resourceFamily ?? null,
        resourceId: normalized.resourceId ?? null,
        operation: normalized.operation ?? null,
        resourceMetadataJson: normalized.resourceMetadata ?? null,
        kind: normalized.kind,
        quantity: normalized.quantity,
        usdMicros: normalized.usdMicros,
        ratingStatus: normalized.ratingStatus,
        source: normalized.source,
        idempotencyKey: normalized.idempotencyKey,
        createdAt: normalized.createdAt,
      },
      {
        id: normalized.id,
        workspaceId: normalized.workspaceId,
        capsuleId: normalized.capsuleId ?? null,
        runId: normalized.runId ?? null,
        meterId: normalized.meterId ?? null,
        resourceFamily: normalized.resourceFamily ?? null,
        resourceId: normalized.resourceId ?? null,
        operation: normalized.operation ?? null,
        resourceMetadataJson: normalized.resourceMetadata ?? null,
        kind: normalized.kind,
        quantity: normalized.quantity,
        usdMicros: normalized.usdMicros,
        ratingStatus: normalized.ratingStatus,
        source: normalized.source,
        createdAt: normalized.createdAt,
      },
      pgSchema.usageEvents.idempotencyKey,
    );
    return normalized;
  }

  async #usageEventByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<UsageEvent | undefined> {
    const rows = await this.#db
      .select()
      .from(pgSchema.usageEvents)
      .where(eq(pgSchema.usageEvents.idempotencyKey, idempotencyKey))
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return usageEventFromRow(row);
  }

  async listUsageEvents(workspaceId: string): Promise<readonly UsageEvent[]> {
    const rows = await this.#db
      .select()
      .from(pgSchema.usageEvents)
      .where(eq(pgSchema.usageEvents.workspaceId, workspaceId))
      .orderBy(
        asc(pgSchema.usageEvents.createdAt),
        asc(pgSchema.usageEvents.id),
      );
    return rows.map(usageEventFromRow);
  }

  async listUsageEventsPage(
    workspaceId: string,
    params: PageParams,
  ): Promise<Page<UsageEvent>> {
    const limit = clampPageLimit(params.limit);
    const rows = await this.#db
      .select()
      .from(pgSchema.usageEvents)
      .where(
        pgKeysetWhereDesc(
          eq(pgSchema.usageEvents.workspaceId, workspaceId),
          pgSchema.usageEvents.createdAt,
          pgSchema.usageEvents.id,
          decodeCursor(params.cursor),
        ),
      )
      .orderBy(
        desc(pgSchema.usageEvents.createdAt),
        desc(pgSchema.usageEvents.id),
      )
      .limit(limit + 1);
    return pageFromProbe(rows.map(usageEventFromRow), limit);
  }

  // --- backups (§33 layer 1; bytes live in the configured artifact store) ----
  //
  // One ledger pointer row per sealed control-backup bundle. The bundle bytes
  // live outside the ledger; only the pointer round trips through `backup_json`.
  // Listing is newest-first (created_at desc, id desc).

  async putBackupRecord(record: BackupRecord): Promise<BackupRecord> {
    await this.#pgUpsert(pgSchema.backups, {
      id: record.id,
      workspaceId: record.workspaceId,
      capsuleId: record.capsuleId ?? null,
      environment: record.environment ?? null,
      createdByRunId: record.createdByRunId ?? null,
      backupJson: record,
      createdAt: record.createdAt,
    });
    return record;
  }

  async getBackupRecord(id: string): Promise<BackupRecord | undefined> {
    return await this.#pgFirstJson<BackupRecord>(
      pgSchema.backups,
      pgSchema.backups.backupJson,
      eq(pgSchema.backups.id, id),
    );
  }

  async listBackupRecords(
    workspaceId: string,
  ): Promise<readonly BackupRecord[]> {
    return await this.#pgManyJson<BackupRecord>(
      pgSchema.backups,
      pgSchema.backups.backupJson,
      {
        where: eq(pgSchema.backups.workspaceId, workspaceId),
        orderBy: [desc(pgSchema.backups.createdAt), desc(pgSchema.backups.id)],
      },
    );
  }

  async listBackupRecordsPage(
    workspaceId: string,
    params: PageParams,
  ): Promise<Page<BackupRecord>> {
    const limit = clampPageLimit(params.limit);
    // Newest-first listing ⇒ descending keyset.
    const rows = await this.#pgManyJson<BackupRecord>(
      pgSchema.backups,
      pgSchema.backups.backupJson,
      {
        where: pgKeysetWhereDesc(
          eq(pgSchema.backups.workspaceId, workspaceId),
          pgSchema.backups.createdAt,
          pgSchema.backups.id,
          decodeCursor(params.cursor),
        ),
        orderBy: [desc(pgSchema.backups.createdAt), desc(pgSchema.backups.id)],
        limit: limit + 1,
      },
    );
    return pageFromProbe(rows, limit);
  }

  // Drizzle's `.insert(table).values(...)` demands a per-table insert model, so
  // the table/values stay `any` here; the conflict target is the table's `id`
  // column (or an explicit override) and rides through untyped with them. The
  // read helpers below take the concrete `PgTable` / `PgColumn` types.
  async #pgUpsert(
    table: any,
    values: Record<string, unknown>,
    set: Record<string, unknown> = values,
    target = table.id,
  ): Promise<void> {
    await this.#db
      .insert(table)
      .values(values)
      .onConflictDoUpdate({ target, set });
  }

  async #pgDelete(
    table: PgTable & { readonly id: PgColumn },
    where: SQL | undefined,
  ): Promise<boolean> {
    const rows = await this.#db
      .delete(table)
      .where(where)
      .returning({ id: table.id });
    return rows.length > 0;
  }

  async #pgFirstJson<T>(
    table: PgTable,
    jsonColumn: PgColumn,
    where: SQL | undefined,
  ): Promise<T | undefined> {
    const rows = await this.#db
      .select({ json: jsonColumn })
      .from(table)
      .where(where)
      .limit(1);
    return parseRow(rows[0]) as T | undefined;
  }

  async #pgManyJson<T>(
    table: PgTable,
    jsonColumn: PgColumn,
    input: {
      readonly where?: SQL | undefined;
      readonly orderBy?: readonly (SQL | PgColumn | SQL.Aliased)[];
      readonly limit?: number;
    } = {},
  ): Promise<readonly T[]> {
    let query = this.#db.select({ json: jsonColumn }).from(table).$dynamic();
    if (input.where !== undefined) {
      query = query.where(input.where);
    }
    if (input.orderBy !== undefined) {
      query = query.orderBy(...input.orderBy);
    }
    if (input.limit !== undefined) {
      query = query.limit(input.limit);
    }
    const rows = await query;
    return rows.map((row) => parseRow(row) as T);
  }
}

interface JsonRow extends Record<string, unknown> {
  readonly json: unknown;
}

interface PgWorkspaceMutationWorkspaceRow extends Record<string, unknown> {
  readonly id: string;
  readonly handle: string;
  readonly spaceJson: unknown;
  readonly workspaceType: string | null;
  readonly ownerUserId: string | null;
  readonly createdAt: string;
}

interface PgWorkspaceMemberRow extends Record<string, unknown> {
  readonly id: string;
  readonly workspaceId: string;
  readonly accountId: string;
  readonly status: string;
  readonly recordJson: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface WorkspaceMemberMutationSnapshot {
  readonly workspace: Workspace;
  readonly members: readonly WorkspaceMember[];
}

function workspaceMutationRowMatches(
  row: PgWorkspaceMutationWorkspaceRow,
  current: Workspace,
  expected: Workspace,
): boolean {
  return row.id === expected.id &&
    row.handle === expected.handle &&
    row.workspaceType === expected.type &&
    row.ownerUserId === expected.ownerUserId &&
    row.createdAt === expected.createdAt &&
    current.id === row.id &&
    current.handle === row.handle &&
    stableStringify(current) === stableStringify(expected);
}

function workspaceMemberLogicalEquals(
  left: WorkspaceMember,
  right: WorkspaceMember,
): boolean {
  return left.id === right.id &&
    left.workspaceId === right.workspaceId &&
    left.accountId === right.accountId &&
    left.status === right.status &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.roles.length === right.roles.length &&
    left.roles.every((role, index) => role === right.roles[index]);
}

function workspaceMemberExpectedMatches(
  current: WorkspaceMember | undefined,
  expected: WorkspaceMember | undefined,
): boolean {
  return expected === undefined
    ? current === undefined
    : current !== undefined && workspaceMemberLogicalEquals(current, expected);
}

/** Lock the shared Workspace row before dependent management writes. */
export async function pgWorkspaceManagementForTransaction(
  transaction: SqlTransaction,
  workspaceId: string,
): Promise<WorkspaceManagement | undefined> {
  const rows = await transaction.query<{
    readonly managementState: string | null;
    readonly managementEpoch: number | string | null;
  }>(
    `select management_state as "managementState",
            management_epoch as "managementEpoch"
       from takosumi_workspaces
      where id = $1
      for update`,
    [workspaceId],
  );
  const row = rows.rows[0];
  return row
    ? normalizeWorkspaceManagement(
        workspaceId,
        row.managementState,
        row.managementEpoch,
      )
    : undefined;
}

interface PgCompatibilityAdmissionRow extends Record<string, unknown> {
  readonly id: string;
  readonly kind: string;
  readonly workspaceId: string;
  readonly sourceId: string | null;
  readonly capsuleId: string | null;
  readonly status: string;
  readonly leaseToken: string | null;
  readonly heartbeatAt?: number | null;
  readonly createdAt: string;
  readonly runJson: unknown;
}

interface PgCompatibilitySettlementRunRow extends PgCompatibilityAdmissionRow {
  readonly heartbeatAt: number | null;
}

interface PgCompatibilitySettlementReportRow extends Record<string, unknown> {
  readonly id: string;
  readonly sourceId: string | null;
  readonly capsuleId: string | null;
  readonly sourceSnapshotId: string;
  readonly modulePath: string | null;
  readonly level: string;
  readonly findingsJson: unknown;
  readonly providersJson: unknown;
  readonly resourcesJson: unknown;
  readonly dataSourcesJson: unknown;
  readonly provisionersJson: unknown;
  readonly rootModuleVariablesJson: unknown;
  readonly rootModuleVariableDeclarationsJson: unknown;
  readonly rootModuleOutputsJson: unknown;
  readonly createdAt: string;
}

/** Parse one locked compatibility Run while rejecting physical/JSON drift. */
function pgCompatibilityRunFromAdmissionRow(
  row: PgCompatibilityAdmissionRow,
): StoredRunRecord | undefined {
  let value: unknown;
  try {
    value = parseJson(row.runJson);
  } catch {
    return undefined;
  }
  if (
    row.kind !== RUN_KIND_COMPATIBILITY_CHECK ||
    value === null || typeof value !== "object" || Array.isArray(value)
  ) {
    return undefined;
  }
  const run = value as Partial<Run>;
  return run.id === row.id &&
      run.workspaceId === row.workspaceId &&
      run.type === RUN_KIND_COMPATIBILITY_CHECK &&
      run.status === row.status &&
      row.leaseToken === null &&
      (row.heartbeatAt === undefined ||
        (row.heartbeatAt === null
          ? run.heartbeatAt === undefined || run.heartbeatAt === null
          : run.heartbeatAt === row.heartbeatAt)) &&
      run.createdAt === row.createdAt &&
      nullablePhysicalMatches(run.sourceId, row.sourceId) &&
      nullablePhysicalMatches(run.capsuleId, row.capsuleId)
    ? value as StoredRunRecord
    : undefined;
}

/** Parse one compatibility report while rejecting malformed persisted JSON. */
function pgCompatibilityReportFromSettlementRow(
  row: PgCompatibilitySettlementReportRow,
): CapsuleCompatibilityReport | undefined {
  try {
    const findings = parseJson(row.findingsJson);
    const resources = parseJson(row.resourcesJson);
    const dataSources = parseJson(row.dataSourcesJson);
    const provisioners = parseJson(row.provisionersJson);
    const rootModuleVariables = parseJson(row.rootModuleVariablesJson);
    const rootModuleOutputs = parseJson(row.rootModuleOutputsJson);
    if (
      !Array.isArray(findings) || !Array.isArray(resources) ||
      !Array.isArray(dataSources) || !Array.isArray(provisioners) ||
      !Array.isArray(rootModuleVariables) || !Array.isArray(rootModuleOutputs) ||
      typeof row.id !== "string" || typeof row.sourceSnapshotId !== "string" ||
      typeof row.createdAt !== "string"
    ) {
      return undefined;
    }
    const providerGraph = parseStoredCapsuleCompatibilityProviderGraph(
      parseJson(row.providersJson),
    );
    const report = {
      id: row.id,
      sourceId: compatibilityReportSourceId(row.sourceId),
      ...(row.capsuleId ? { capsuleId: row.capsuleId } : {}),
      sourceSnapshotId: row.sourceSnapshotId,
      ...(row.modulePath ? { modulePath: row.modulePath } : {}),
      level: normalizeStoredCapsuleCompatibilityLevel(row.level),
      findings: findings as CapsuleCompatibilityReport["findings"],
      ...providerGraph,
      resources: resources as CapsuleCompatibilityReport["resources"],
      dataSources: dataSources as CapsuleCompatibilityReport["dataSources"],
      provisioners: provisioners as CapsuleCompatibilityReport["provisioners"],
      rootModuleVariables:
        rootModuleVariables as CapsuleCompatibilityReport["rootModuleVariables"],
      ...(row.rootModuleVariableDeclarationsJson === null
        ? {}
        : {
            rootModuleVariableDeclarations:
              parseStoredCapsuleRootModuleVariableDeclarations(
                parseJson(row.rootModuleVariableDeclarationsJson),
              ),
          }),
      rootModuleOutputs:
        rootModuleOutputs as CapsuleCompatibilityReport["rootModuleOutputs"],
      createdAt: row.createdAt,
    } satisfies CapsuleCompatibilityReport;
    return compatibilityCheckReportForStorage(report);
  } catch {
    return undefined;
  }
}

interface PgBackupSettlementRunRow extends Record<string, unknown> {
  readonly id: string;
  readonly kind: string;
  readonly workspaceId: string;
  readonly sourceId: string | null;
  readonly capsuleId: string | null;
  readonly status: string;
  readonly leaseToken: string | null;
  readonly createdAt: string;
  readonly runJson: unknown;
}

interface PgBackupSettlementRecordRow extends Record<string, unknown> {
  readonly id: string;
  readonly workspaceId: string;
  readonly capsuleId: string | null;
  readonly environment: string | null;
  readonly createdByRunId: string | null;
  readonly backupJson: unknown;
  readonly createdAt: string;
}

function nullablePhysicalMatches(
  logical: unknown,
  physical: string | null,
): boolean {
  return physical === null
    ? logical === undefined || logical === null
    : logical === physical;
}

/** Parse one locked Run while rejecting physical/JSON identity drift. */
function pgBackupRunFromSettlementRow(
  row: PgBackupSettlementRunRow,
): StoredRunRecord | undefined {
  let value: unknown;
  try {
    value = parseJson(row.runJson);
  } catch {
    return undefined;
  }
  if (
    row.kind !== RUN_KIND_BACKUP ||
    typeof value !== "object" || value === null || Array.isArray(value)
  ) {
    return undefined;
  }
  const run = value as Partial<Run>;
  return run.id === row.id &&
      run.workspaceId === row.workspaceId &&
      run.type === RUN_KIND_BACKUP &&
      run.status === row.status &&
      row.leaseToken === null &&
      run.createdAt === row.createdAt &&
      nullablePhysicalMatches(run.sourceId, row.sourceId) &&
      nullablePhysicalMatches(run.capsuleId, row.capsuleId)
    ? (value as StoredRunRecord)
    : undefined;
}

/** Parse one locked Backup pointer while rejecting physical/JSON drift. */
function pgBackupRecordFromSettlementRow(
  row: PgBackupSettlementRecordRow,
): BackupRecord | undefined {
  let value: unknown;
  try {
    value = parseJson(row.backupJson);
  } catch {
    return undefined;
  }
  if (
    typeof value !== "object" || value === null || Array.isArray(value)
  ) {
    return undefined;
  }
  const record = value as Partial<BackupRecord>;
  if (
    row.id !== record.id ||
    row.workspaceId !== record.workspaceId ||
    row.createdAt !== record.createdAt ||
    !nullablePhysicalMatches(record.capsuleId, row.capsuleId) ||
    !nullablePhysicalMatches(record.environment, row.environment) ||
    !nullablePhysicalMatches(record.createdByRunId, row.createdByRunId)
  ) {
    return undefined;
  }
  return value as BackupRecord;
}

interface PgStoredSourceRow extends Record<string, unknown> {
  readonly id: string;
  readonly workspaceId: string;
  readonly status: string;
  readonly sourceJson: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Reconcile the physical Source columns with the sealed JSON record before a
 * configuration CAS. A mismatch is treated as an immutable conflict; callers
 * cannot use a candidate write to repair ownership or identity drift.
 */
function sourceFromPgRow(row: PgStoredSourceRow): StoredSource | undefined {
  const value = parseJson(row.sourceJson);
  if (value === null || typeof value !== "object") return undefined;
  const source = value as Partial<StoredSource>;
  if (
    source.id !== row.id ||
    source.workspaceId !== row.workspaceId ||
    source.status !== row.status ||
    source.createdAt !== row.createdAt ||
    source.updatedAt !== row.updatedAt
  ) {
    return undefined;
  }
  return source as StoredSource;
}

interface PgProjectRow extends Record<string, unknown> {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly slug: string;
  readonly projectJson: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Reconcile physical Project columns with the canonical JSON record. */
function projectFromPgRow(row: PgProjectRow): Project | undefined {
  const value = parseJson(row.projectJson);
  if (value === null || typeof value !== "object") return undefined;
  const project = value as Partial<Project>;
  if (
    project.id !== row.id ||
    project.workspaceId !== row.workspaceId ||
    project.name !== row.name ||
    project.slug !== row.slug ||
    project.createdAt !== row.createdAt ||
    project.updatedAt !== row.updatedAt ||
    project.projectJson === null ||
    typeof project.projectJson !== "object"
  ) {
    return undefined;
  }
  return project as Project;
}

function parseRow(row: JsonRow | undefined): unknown {
  if (!row) return undefined;
  return parseJson(row.json);
}

function parseJson(value: unknown): unknown {
  if (typeof value === "string") {
    if (value === "") return null;
    return JSON.parse(value);
  }
  return value;
}

function isUniqueConstraintViolation(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const candidate = error as {
    readonly code?: unknown;
    readonly message?: unknown;
  };
  return candidate.code === "23505" ||
    (typeof candidate.message === "string" &&
      /duplicate key|unique constraint/iu.test(candidate.message));
}

/**
 * Persist a public Run payload while retaining the row's private original
 * Workspace-management authority. The RHS references the existing PostgreSQL
 * JSONB value, so transitions, terminal commits, and raw puts all preserve
 * that key atomically instead of relying on a pre-read merge.
 */
function runJsonPreservingManagementAuthority(
  run: StoredRunRecord,
): SQL {
  const publicRun = publicStoredRun(run);
  return sql`${JSON.stringify(publicRun)}::jsonb || CASE
    WHEN ${pgSchema.runs.runJson} ? 'workspaceManagementAuthority'
    THEN jsonb_build_object(
      'workspaceManagementAuthority',
      ${pgSchema.runs.runJson} -> 'workspaceManagementAuthority'
    )
    ELSE '{}'::jsonb
  END`;
}

function sourceSyncRunJsonPreservingAuthority(run: SourceSyncRun): SQL {
  return runJsonPreservingManagementAuthority(run);
}

/**
 * Persist a public InstallConfig while retaining the row's private original
 * Workspace-management authority. The existing JSONB key is copied inside
 * the same SQL write, so a public full-record rewrite cannot erase, replace,
 * or mint that metadata through a read/merge/write race.
 */
function installConfigJsonPreservingAuthority(config: InstallConfig): SQL {
  const publicConfig = publicStoredInstallConfig(config);
  return sql`${JSON.stringify(publicConfig)}::jsonb || CASE
    WHEN ${pgSchema.installConfigs.configJson} ? 'workspaceManagementAuthority'
    THEN jsonb_build_object(
      'workspaceManagementAuthority',
      ${pgSchema.installConfigs.configJson} -> 'workspaceManagementAuthority'
    )
    ELSE '{}'::jsonb
  END`;
}

function capsuleValues(capsule: Capsule) {
  const normalized = normalizeCapsuleRecord(capsule);
  return {
    id: normalized.id,
    workspaceId: normalized.workspaceId,
    projectId: normalized.projectId,
    name: normalized.name,
    environment: normalized.environment,
    sourceId: normalized.sourceId,
    installConfigId: normalized.installConfigId,
    currentStateVersionId: normalized.currentStateVersionId ?? null,
    status: normalized.status,
    capsuleJson: normalized,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
  };
}

function stripRunHeartbeat<R extends PlanRun | ApplyRun | SourceSyncRun | Run>(
  run: R,
): R {
  const { heartbeatAt, ...withoutHeartbeat } = run;
  void heartbeatAt;
  return withoutHeartbeat as R;
}

// --- tx-aware upserts -------------------------------------------------------
//
// These mirror the `#pgUpsert(...)` payloads in putStateVersion
// / putOutput but take an explicit drizzle handle so the SAME insert can
// run on either the shared `#db` (the put* methods) or a transaction-bound
// drizzle handle (the atomic commitRunState path). Keeping ONE column
// payload per entity means the transactional and non-transactional writes stay
// byte-for-byte identical.

/**
 * Tx-aware §27 `runs` upsert (the commit-tail fold helper). Writes a PlanRun /
 * ApplyRun row through the given drizzle handle (the transaction-bound one), so
 * the run-status write commits atomically with the StateVersion. Mirrors the
 * `#putRunDrizzle` column payload exactly. `clearLease` nulls the lease fence on
 * the same write (the terminal ApplyRun path); otherwise the lease column rides
 * the run's own `heartbeatAt`.
 *
 * Both rows written through this helper are TERMINAL (the succeeded ApplyRun and
 * the apply-once PlanRun marker), so the lease fence is always nulled — the
 * commit-tail fold never re-stamps a live lease.
 */
async function pgUpsertRun(
  db: PgRemoteDatabase<typeof pgSchema>,
  kind: string,
  run: PlanRun | ApplyRun,
): Promise<void> {
  const publicRun = publicStoredRun(run);
  const values = {
    id: publicRun.id,
    kind,
    workspaceId: publicRun.workspaceId,
    sourceId: null,
    capsuleId: publicRun.capsuleId ?? null,
    status: publicRun.status,
    leaseToken: null as string | null,
    heartbeatAt: publicRun.heartbeatAt ?? null,
    createdAt: String(publicRun.createdAt),
    runJson: publicRun,
  };
  const written = await db
    .insert(pgSchema.runs)
    .values(values)
    .onConflictDoUpdate({
      target: pgSchema.runs.id,
      set: {
        kind: values.kind,
        workspaceId: values.workspaceId,
        sourceId: values.sourceId,
        capsuleId: values.capsuleId,
        status: values.status,
        leaseToken: values.leaseToken,
        heartbeatAt: values.heartbeatAt,
        createdAt: values.createdAt,
        runJson: runJsonPreservingManagementAuthority(
          publicRun as StoredRunRecord,
        ),
      },
      setWhere: and(
        eq(pgSchema.runs.kind, kind),
        eq(pgSchema.runs.workspaceId, publicRun.workspaceId),
        sql`${pgSchema.runs.runJson} ->> 'id' = ${publicRun.id}`,
        sql`${pgSchema.runs.runJson} ->> 'workspaceId' = ${publicRun.workspaceId}`,
      ),
    })
    .returning({ id: pgSchema.runs.id });
  if (written.length === 0) {
    throw new TypeError("Run stored identity cannot change");
  }
}

async function pgUpdateTerminalRunWithLease(
  db: PgRemoteDatabase<typeof pgSchema>,
  kind: string,
  allowedKinds: readonly string[],
  run: PlanRun | ApplyRun | SourceSyncRun | Run,
  leaseToken: string,
): Promise<boolean> {
  const publicRun = publicStoredRun(run as StoredRunRecord);
  const values = {
    kind,
    workspaceId: publicRun.workspaceId,
    sourceId: "sourceId" in publicRun ? (publicRun.sourceId ?? null) : null,
    capsuleId: "capsuleId" in publicRun ? (publicRun.capsuleId ?? null) : null,
    status: publicRun.status,
    leaseToken: null as string | null,
    heartbeatAt: publicRun.heartbeatAt ?? null,
    createdAt: String(publicRun.createdAt),
    runJson: runJsonPreservingManagementAuthority(
      publicRun as StoredRunRecord,
    ),
  };
  const rows = await db
    .update(pgSchema.runs)
    .set(values)
    .where(
      and(
        eq(pgSchema.runs.id, publicRun.id),
        inArray(pgSchema.runs.kind, [...allowedKinds]),
        eq(pgSchema.runs.workspaceId, publicRun.workspaceId),
        sql`${pgSchema.runs.runJson} ->> 'id' = ${publicRun.id}`,
        sql`${pgSchema.runs.runJson} ->> 'workspaceId' = ${publicRun.workspaceId}`,
        kind === RUN_KIND_SOURCE_SYNC
          ? sql`${pgSchema.runs.runJson} ->> 'kind' = ${RUN_KIND_SOURCE_SYNC}`
          : kind === RUN_KIND_RESTORE
            ? sql`${pgSchema.runs.runJson} ->> 'type' = ${RUN_KIND_RESTORE}`
            : sql`true`,
        eq(pgSchema.runs.status, "running"),
        eq(pgSchema.runs.leaseToken, leaseToken),
      ),
    )
    .returning({ id: pgSchema.runs.id });
  return rows.length > 0;
}

async function pgInsertOrAdoptSourceSnapshot(
  db: PgRemoteDatabase<typeof pgSchema>,
  snapshot: SourceSnapshot,
): Promise<void> {
  const inserted = await db
    .insert(pgSchema.sourceSnapshots)
    .values({
      id: snapshot.id,
      sourceId: snapshot.sourceId,
      snapshotJson: snapshot,
      fetchedAt: snapshot.fetchedAt,
    })
    .onConflictDoNothing({ target: pgSchema.sourceSnapshots.id })
    .returning({ id: pgSchema.sourceSnapshots.id });
  if (inserted.length > 0) return;
  const rows = await db
    .select({ json: pgSchema.sourceSnapshots.snapshotJson })
    .from(pgSchema.sourceSnapshots)
    .where(eq(pgSchema.sourceSnapshots.id, snapshot.id))
    .limit(1);
  const existing = normalizeOptionalSourceSnapshotRecord(
    parseRow(rows[0]) as SourceSnapshot | undefined,
  );
  if (!existing || !sourceSnapshotsExactlyMatch(existing, snapshot)) {
    throw new SourceSnapshotConflictError(snapshot.id);
  }
}

/**
 * Fold the successful SourceSync observation into the existing Source row.
 *
 * The address predicates pin the physical Source and its configured default
 * Git address, while the JSON mutation is built from the current row so every
 * other configuration and hook field is preserved. Compliant configuration
 * CAS writes serialize through the Workspace lock; if one advances the row
 * first, this update observes that latest JSON rather than replacing it. This
 * helper never creates a Source row and does not consult Workspace management:
 * it settles the same lease that was already committed above.
 */
async function pgMergeSourceSyncCursor(
  db: PgRemoteDatabase<typeof pgSchema>,
  run: SourceSyncRun,
  snapshot: SourceSnapshot,
): Promise<void> {
  if (snapshot.resolvedCommit === undefined) return;
  await db
    .update(pgSchema.sources)
    .set({
      sourceJson: sql`jsonb_set(
        jsonb_set(
          ${pgSchema.sources.sourceJson},
          '{lastSeenCommit}',
          to_jsonb(${snapshot.resolvedCommit}::text),
          true
        ),
        '{updatedAt}',
        to_jsonb(${snapshot.fetchedAt}::text),
        true
      )`,
      updatedAt: snapshot.fetchedAt,
    })
    .where(
      and(
        eq(pgSchema.sources.id, run.sourceId),
        eq(pgSchema.sources.workspaceId, run.workspaceId),
        sql`${pgSchema.sources.sourceJson} ->> 'workspaceId' = ${run.workspaceId}`,
        sql`${pgSchema.sources.sourceJson} ->> 'url' = ${run.url}`,
        sql`${pgSchema.sources.sourceJson} ->> 'defaultRef' = ${run.ref}`,
        sql`${pgSchema.sources.sourceJson} ->> 'defaultPath' = ${run.path}`,
      ),
    );
}

async function pgUpsertStateVersion(
  db: PgRemoteDatabase<typeof pgSchema>,
  snapshot: StateVersion,
): Promise<void> {
  await db
    .insert(pgSchema.stateVersions)
    .values({
      id: snapshot.id,
      workspaceId: snapshot.workspaceId,
      capsuleId: snapshot.capsuleId,
      environment: snapshot.environment,
      generation: snapshot.generation,
      snapshotJson: snapshot,
      createdAt: snapshot.createdAt,
    })
    .onConflictDoUpdate({
      target: [
        pgSchema.stateVersions.capsuleId,
        pgSchema.stateVersions.environment,
        pgSchema.stateVersions.generation,
      ],
      set: {
        id: snapshot.id,
        workspaceId: snapshot.workspaceId,
        snapshotJson: snapshot,
        createdAt: snapshot.createdAt,
      },
    });
}

async function pgUpsertOutput(
  db: PgRemoteDatabase<typeof pgSchema>,
  snapshot: Output,
): Promise<void> {
  await db
    .insert(pgSchema.outputs)
    .values({
      id: snapshot.id,
      workspaceId: snapshot.workspaceId,
      capsuleId: snapshot.capsuleId,
      stateGeneration: snapshot.stateGeneration,
      snapshotJson: snapshot,
      createdAt: snapshot.createdAt,
    })
    .onConflictDoUpdate({
      target: pgSchema.outputs.id,
      set: {
        id: snapshot.id,
        workspaceId: snapshot.workspaceId,
        capsuleId: snapshot.capsuleId,
        stateGeneration: snapshot.stateGeneration,
        snapshotJson: snapshot,
        createdAt: snapshot.createdAt,
      },
    });
}

async function pgInsertOrAdoptCapsuleInterfaceMaterializationIntent(
  db: PgRemoteDatabase<typeof pgSchema>,
  intent: CapsuleInterfaceMaterializationIntent,
): Promise<void> {
  const blueprintsJson = capsuleInterfaceBlueprintsJson(intent.blueprints);
  await db
    .insert(pgSchema.capsuleInterfaceMaterializationIntents)
    .values({
      id: intent.id,
      applyRunId: intent.applyRunId ?? null,
      restoreRunId: intent.restoreRunId ?? null,
      sourceIntentId: intent.sourceIntentId ?? null,
      workspaceId: intent.workspaceId,
      capsuleId: intent.capsuleId,
      installConfigId: intent.installConfigId,
      stateVersionId: intent.stateVersionId,
      outputId: intent.outputId,
      stateGeneration: intent.stateGeneration,
      blueprintsDigest: intent.blueprintsDigest,
      blueprintsJson,
      totalItems: intent.totalItems,
      nextItemIndex: intent.nextItemIndex,
      status: intent.status,
      attempts: intent.attempts,
      nextRetryAt: intent.nextRetryAt,
      leaseToken: intent.leaseToken ?? null,
      leaseExpiresAt: intent.leaseExpiresAt ?? null,
      errorJson: intent.error ?? null,
      receiptJson: intent.receipt ?? null,
      createdAt: intent.createdAt,
      updatedAt: intent.updatedAt,
      completedAt: intent.completedAt ?? null,
      deadLetteredAt: intent.deadLetteredAt ?? null,
    })
    .onConflictDoNothing();
  const table = pgSchema.capsuleInterfaceMaterializationIntents;
  const collisions = await db
    .select()
    .from(table)
    .where(
      or(
        eq(table.id, intent.id),
        ...(intent.applyRunId
          ? [eq(table.applyRunId, intent.applyRunId)]
          : []),
        ...(intent.restoreRunId
          ? [eq(table.restoreRunId, intent.restoreRunId)]
          : []),
        and(
          eq(table.capsuleId, intent.capsuleId),
          eq(table.stateGeneration, intent.stateGeneration),
        ),
      ),
    );
  if (
    collisions.length !== 1 ||
    collisions[0]?.id !== intent.id ||
    (collisions[0].applyRunId ?? undefined) !== intent.applyRunId ||
    (collisions[0].restoreRunId ?? undefined) !== intent.restoreRunId ||
    (collisions[0].sourceIntentId ?? undefined) !== intent.sourceIntentId ||
    collisions[0].workspaceId !== intent.workspaceId ||
    collisions[0].capsuleId !== intent.capsuleId ||
    collisions[0].installConfigId !== intent.installConfigId ||
    collisions[0].stateVersionId !== intent.stateVersionId ||
    collisions[0].outputId !== intent.outputId ||
    collisions[0].stateGeneration !== intent.stateGeneration ||
    collisions[0].blueprintsDigest !== intent.blueprintsDigest ||
    collisions[0].blueprintsJson !== blueprintsJson ||
    collisions[0].totalItems !== intent.totalItems
  ) {
    throw new Error(
      "capsule Interface materialization intent identity/content conflict",
    );
  }
}

function capsuleInterfaceMaterializationIntentFromPgRow(
  row: typeof pgSchema.capsuleInterfaceMaterializationIntents.$inferSelect,
): CapsuleInterfaceMaterializationIntent {
  return {
    id: row.id,
    ...(row.applyRunId ? { applyRunId: row.applyRunId } : {}),
    ...(row.restoreRunId ? { restoreRunId: row.restoreRunId } : {}),
    ...(row.sourceIntentId ? { sourceIntentId: row.sourceIntentId } : {}),
    workspaceId: row.workspaceId,
    capsuleId: row.capsuleId,
    installConfigId: row.installConfigId,
    stateVersionId: row.stateVersionId,
    outputId: row.outputId,
    stateGeneration: row.stateGeneration,
    blueprintsDigest: row.blueprintsDigest,
    blueprints: parseJson(row.blueprintsJson) as CapsuleInterfaceMaterializationIntent["blueprints"],
    totalItems: row.totalItems,
    nextItemIndex: row.nextItemIndex,
    status: row.status as CapsuleInterfaceMaterializationIntent["status"],
    attempts: row.attempts,
    nextRetryAt: row.nextRetryAt,
    ...(row.leaseToken ? { leaseToken: row.leaseToken } : {}),
    ...(row.leaseExpiresAt ? { leaseExpiresAt: row.leaseExpiresAt } : {}),
    ...(row.errorJson
      ? {
          error: row.errorJson as NonNullable<
            CapsuleInterfaceMaterializationIntent["error"]
          >,
        }
      : {}),
    ...(row.receiptJson
      ? {
          receipt: row.receiptJson as NonNullable<
            CapsuleInterfaceMaterializationIntent["receipt"]
          >,
        }
      : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.completedAt ? { completedAt: row.completedAt } : {}),
    ...(row.deadLetteredAt ? { deadLetteredAt: row.deadLetteredAt } : {}),
  };
}

function selectedDriverColumns(query: string): readonly string[] {
  const lower = query.toLowerCase();
  const select = lower.match(/^select\s+([\s\S]+?)\s+from\s/);
  const returning = lower.match(/\sreturning\s+([\s\S]+)$/);
  const list = select?.[1] ?? returning?.[1];
  if (!list) return [];
  return list.split(",").map((part) => {
    const alias = /\s+as\s+"?([a-z_][a-z0-9_]*)"?\s*$/.exec(part);
    if (alias) return alias[1];
    const identifiers = [...part.matchAll(/"?([a-z_][a-z0-9_]*)"?/g)];
    return identifiers.at(-1)?.[1] ?? part.trim().replaceAll('"', "");
  });
}

function publicHostReservationFromRow(
  row: Record<string, unknown> | undefined,
): PublicHostReservation {
  if (!row) {
    throw new Error("public host reservation row was not returned");
  }
  return {
    hostname: String(row.hostname),
    ownerUserId: String(row.owner_user_id ?? row.workspace_id),
    workspaceId: String(row.workspace_id),
    capsuleId: String(row.installation_id),
    capsuleName: String(row.installation_name),
    allocationKind: row.allocation_kind === "vanity" ? "vanity" : "scoped",
    status:
      row.status === "released" || row.status === "reserved"
        ? row.status
        : "reserved",
    reservedAt: String(row.reserved_at),
    updatedAt: String(row.updated_at),
    ...(row.released_at ? { releasedAt: String(row.released_at) } : {}),
  };
}
