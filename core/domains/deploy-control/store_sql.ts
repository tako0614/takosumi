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
  gt,
  inArray,
  isNull,
  lt,
  ne,
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
  CommitRunStateInput,
  CommitRunStateResult,
  CommitResourceRunInput,
  CommitResourceRunResult,
  CommitRestoredStateInput,
  CommitRestoredStateResult,
  BeginResourceOperationRunResult,
  CapsuleRuntimeSafety,
  CapsulePatch,
  CapsuleStateVersionGuard,
  OpenTofuControlStore,
  PlanRunInputs,
  PublicHostReservation,
  RecoverableOpenTofuRunListOptions,
  RecoverableResourceOperationRunListOptions,
  ResourceOperationRun,
  ReservePublicHostInput,
  ReservePublicHostResult,
  StoredRunRecord,
  StoredSecretBlob,
  StoredSource,
  CapsuleListPageParams,
  TransitionRunInput,
  TransitionRunResult,
  TransitionResourceOperationRunInput,
  TransitionResourceOperationRunResult,
} from "./store.ts";
import {
  assertResourceOperationRun,
  assertResourceOperationRunStart,
  boundedActivityWorkspaceIds,
  clampActivityLimit,
  clampRecoverableOpenTofuRunListLimit,
  clampRecoverableResourceOperationRunListLimit,
  clampRunListLimit,
  capsuleRuntimeSafetyFromRun,
  compareStoredRunRecordsAsc,
  CapsuleStateVersionGuardConflict,
  CapsuleStateGenerationGuardConflict,
  isApplyRunRecord,
  isPlanRunRecord,
  isRecoverableOpenTofuRunRecord,
  resourceOperationRunTransitionAllowed,
  resourceOperationRunNeedsRecovery,
  sameResourceOperationIdentity,
  normalizeStoredCapsuleCompatibilityLevel,
  normalizeStoredCapsuleCompatibilityReport,
} from "./store.ts";
import {
  artifactRecordFromRow,
  coerceRunRowStatus,
  normalizeCapsuleRecord,
  normalizeOptionalCapsuleRecord,
  normalizeOptionalSourceSnapshotRecord,
  normalizeSourceSnapshotRecord,
  normalizeUsageEvent,
  usageEventFromRow,
  usageResourceMetadataFromRow,
} from "./store_row_mappers.ts";
import type { SqlTransaction } from "../../adapters/storage/sql.ts";

/** Discriminator stored in the single `runs` table (§27). */
// §27 runs.type values. Destroy runs persist their own discriminator
// (destroy_plan / destroy_apply) so the raw table matches the spec enum and
// the D1 backend; the typed accessors read both kinds of their family.
const RUN_KINDS_PLAN = ["plan", "destroy_plan"] as const;
const RUN_KINDS_APPLY = ["apply", "destroy_apply"] as const;
const RUN_KIND_SOURCE_SYNC = "source_sync";
const RUN_KIND_COMPATIBILITY_CHECK = "compatibility_check";
const RUN_KIND_RESOURCE_OPERATION = "resource_operation";

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

/** Mirrors applyRunMutationDispatched in the shared store model. */
function pgRunMutationDispatched(): SQL {
  return sql`
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        COALESCE(${pgSchema.runs.runJson} -> 'auditEvents', '[]'::jsonb)
      ) AS audit_event
      WHERE audit_event -> 'data' ->> 'providerDispatched' = 'true'
         OR audit_event -> 'data' ->> 'lifecycleActionDispatched' = 'true'
    )
  `;
}

/** Mirrors applyRunBillingCapturePending in the shared store model. */
function pgRunBillingCapturePending(): SQL {
  return sql`
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        COALESCE(${pgSchema.runs.runJson} -> 'auditEvents', '[]'::jsonb)
      ) AS audit_event
      WHERE audit_event ->> 'type' = 'billing.capture.pending'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        COALESCE(${pgSchema.runs.runJson} -> 'auditEvents', '[]'::jsonb)
      ) AS audit_event
      WHERE audit_event ->> 'type' = 'billing.capture.completed'
    )
  `;
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
    return run;
  }

  async getPlanRun(id: string): Promise<PlanRun | undefined> {
    const run = await this.#getRun<StoredRunRecord>(id, [
      ...RUN_KINDS_PLAN,
      "drift_check",
    ]);
    return coerceRunRowStatus(run && isPlanRunRecord(run) ? run : undefined);
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
    return run;
  }

  async getApplyRun(id: string): Promise<ApplyRun | undefined> {
    const run = await this.#getRun<StoredRunRecord>(id, RUN_KINDS_APPLY);
    return coerceRunRowStatus(run && isApplyRunRecord(run) ? run : undefined);
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
    const kinds =
      input.kind === "plan"
        ? [...RUN_KINDS_PLAN, "drift_check"]
        : input.kind === "apply"
          ? [...RUN_KINDS_APPLY]
          : input.kind === "source_sync"
            ? [RUN_KIND_SOURCE_SYNC]
            : [RUN_KIND_RESTORE];
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
    const rows = await this.#db
      .update(pgSchema.runs)
      .set({
        status: persisted.status,
        runJson: persisted,
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
          inArray(pgSchema.runs.kind, kinds),
          inArray(pgSchema.runs.status, [...input.expectFrom]),
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
    const won = parseRow(rows[0]) as
      PlanRun | ApplyRun | SourceSyncRun | Run | undefined;
    if (won) return { won: true, run: won };
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

  async putSourceSyncRun(run: SourceSyncRun): Promise<SourceSyncRun> {
    await this.#putRunDrizzle(RUN_KIND_SOURCE_SYNC, {
      id: run.id,
      workspaceId: run.workspaceId,
      sourceId: run.sourceId,
      capsuleId: null,
      createdAt: run.createdAt,
      json: run,
    });
    return run;
  }

  async getSourceSyncRun(id: string): Promise<SourceSyncRun | undefined> {
    return await this.#getRun<SourceSyncRun>(id, RUN_KIND_SOURCE_SYNC);
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
      capsuleId: null,
      createdAt: run.createdAt,
      json: run,
    });
    return run;
  }

  async getCompatibilityCheckRun(id: string): Promise<Run | undefined> {
    return await this.#getRun<Run>(id, RUN_KIND_COMPATIBILITY_CHECK);
  }

  async beginResourceOperationRun(
    run: ResourceOperationRun,
  ): Promise<BeginResourceOperationRunResult> {
    assertResourceOperationRunStart(run);
    const inserted = await this.#db
      .insert(pgSchema.runs)
      .values({
        id: run.id,
        kind: RUN_KIND_RESOURCE_OPERATION,
        workspaceId: run.workspaceId,
        sourceId: null,
        capsuleId: null,
        status: run.status,
        leaseToken: null,
        heartbeatAt: null,
        createdAt: String(run.createdAt),
        runJson: run,
      })
      .onConflictDoNothing({ target: pgSchema.runs.id })
      .returning({ json: pgSchema.runs.runJson });
    if (inserted[0]) return { status: "created", run };
    const current = await this.getResourceOperationRun(run.id);
    if (!current) return { status: "conflict" };
    return sameResourceOperationIdentity(current, run)
      ? { status: "existing", run: current }
      : { status: "conflict", run: current };
  }

  async getResourceOperationRun(
    id: string,
  ): Promise<ResourceOperationRun | undefined> {
    return await this.#getRun<ResourceOperationRun>(
      id,
      RUN_KIND_RESOURCE_OPERATION,
    );
  }

  async transitionResourceOperationRun(
    input: TransitionResourceOperationRunInput,
  ): Promise<TransitionResourceOperationRunResult> {
    assertResourceOperationRun(input.run);
    if (
      input.run.resourceOperationKey !== input.operationKey ||
      input.run.resourceOperationVersion !== input.expectedVersion + 1
    ) {
      throw new TypeError("invalid Resource operation Run transition identity");
    }
    const expected = await this.getResourceOperationRun(input.id);
    if (
      !expected ||
      expected.resourceOperationVersion !== input.expectedVersion ||
      !input.expectFrom.includes(expected.status) ||
      !resourceOperationRunTransitionAllowed(expected, input.run)
    ) {
      return { won: false, ...(expected ? { run: expected } : {}) };
    }
    const rows = await this.#db
      .update(pgSchema.runs)
      .set({ status: input.run.status, runJson: input.run })
      .where(
        and(
          eq(pgSchema.runs.id, input.id),
          eq(pgSchema.runs.kind, RUN_KIND_RESOURCE_OPERATION),
          inArray(pgSchema.runs.status, [...input.expectFrom]),
          sql`${pgSchema.runs.runJson} ->> 'resourceOperationKey' = ${input.operationKey}`,
          sql`${pgSchema.runs.runJson} ->> 'resourceOperationVersion' = ${String(input.expectedVersion)}`,
        ),
      )
      .returning({ json: pgSchema.runs.runJson });
    const won = parseRow(rows[0]) as ResourceOperationRun | undefined;
    if (won) return { won: true, run: won };
    const current = await this.getResourceOperationRun(input.id);
    return { won: false, ...(current ? { run: current } : {}) };
  }

  async listRecoverableResourceOperationRuns(
    options: RecoverableResourceOperationRunListOptions = {},
  ): Promise<readonly ResourceOperationRun[]> {
    const rows = await this.#pgManyJson<ResourceOperationRun>(
      pgSchema.runs,
      pgSchema.runs.runJson,
      {
        where: and(
          eq(pgSchema.runs.kind, RUN_KIND_RESOURCE_OPERATION),
          options.workspaceId === undefined
            ? sql`true`
            : eq(pgSchema.runs.workspaceId, options.workspaceId),
          or(
            and(
              eq(pgSchema.runs.status, "running"),
              sql`${pgSchema.runs.runJson} ->> 'resourceOperation' <> 'artifact'`,
            ),
            sql`${pgSchema.runs.runJson} -> 'resourceOperationAudit' ->> 'status' = 'pending'`,
          ),
        ),
        orderBy: [asc(pgRunCreatedAtMillisOrder()), asc(pgSchema.runs.id)],
        limit: clampRecoverableResourceOperationRunListLimit(options.limit),
      },
    );
    return rows.filter(resourceOperationRunNeedsRecovery);
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
    return run;
  }

  async getBackupRun(id: string): Promise<Run | undefined> {
    return await this.#getRun<Run>(id, [RUN_KIND_BACKUP, RUN_KIND_RESTORE]);
  }

  async listRunsByWorkspace(
    workspaceId: string,
    options: { readonly limit?: number } = {},
  ): Promise<readonly StoredRunRecord[]> {
    const limit = clampRunListLimit(options.limit);
    return await this.#pgManyJson<StoredRunRecord>(
      pgSchema.runs,
      pgSchema.runs.runJson,
      {
        where: eq(pgSchema.runs.workspaceId, workspaceId),
        orderBy: [desc(pgRunCreatedAtMillisOrder()), desc(pgSchema.runs.id)],
        limit,
      },
    );
  }

  async getCapsuleRuntimeSafety(
    capsuleId: string,
  ): Promise<CapsuleRuntimeSafety | undefined> {
    const rows = await this.#pgManyJson<ApplyRun | Run>(
      pgSchema.runs,
      pgSchema.runs.runJson,
      {
        where: and(
          eq(pgSchema.runs.capsuleId, capsuleId),
          or(
            and(
              eq(pgSchema.runs.kind, "apply"),
              or(
                eq(pgSchema.runs.status, "succeeded"),
                and(
                  eq(pgSchema.runs.status, "failed"),
                  pgRunMutationDispatched(),
                ),
                and(eq(pgSchema.runs.status, "expired"), pgRunStarted()),
              ),
            ),
            and(
              eq(pgSchema.runs.kind, "destroy_apply"),
              or(
                inArray(pgSchema.runs.status, [
                  "queued",
                  "running",
                  "succeeded",
                ]),
                and(
                  eq(pgSchema.runs.status, "failed"),
                  pgRunMutationDispatched(),
                ),
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
        ),
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
    const rows = await this.#db
      .select({ json: pgSchema.runs.runJson })
      .from(pgSchema.runs)
      .where(
        or(
          and(
            inArray(pgSchema.runs.status, ["queued", "running"]),
            inArray(pgSchema.runs.kind, [
              ...RUN_KINDS_PLAN,
              "drift_check",
              ...RUN_KINDS_APPLY,
              RUN_KIND_SOURCE_SYNC,
              RUN_KIND_RESTORE,
            ]),
          ),
          and(
            inArray(pgSchema.runs.kind, [...RUN_KINDS_APPLY]),
            inArray(pgSchema.runs.status, ["succeeded", "failed"]),
            pgRunBillingCapturePending(),
          ),
        ),
      );
    const limit = clampRecoverableOpenTofuRunListLimit(options.limit);
    return rows
      .map((row) => parseRow(row) as StoredRunRecord)
      .filter((row): row is StoredRunRecord => Boolean(row))
      .filter((row) => isRecoverableOpenTofuRunRecord(row, options))
      .sort(compareStoredRunRecordsAsc)
      .slice(0, limit);
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
    return currentRows.map((row) => parseRow(row) as SourceSyncRun);
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
      runJson: fields.json,
    };
    await this.#db
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
          runJson: values.runJson,
        },
      });
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

  async getWorkspaceMember(
    workspaceId: string,
    accountId: string,
  ): Promise<WorkspaceMember | undefined> {
    return await this.#pgFirstJson<WorkspaceMember>(
      pgSchema.workspaceMembers,
      pgSchema.workspaceMembers.memberJson,
      and(
        eq(pgSchema.workspaceMembers.workspaceId, workspaceId),
        eq(pgSchema.workspaceMembers.accountId, accountId),
      ),
    );
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
    await this.#pgUpsert(pgSchema.installConfigs, {
      id: config.id,
      workspaceId: config.workspaceId ?? null,
      configJson: config,
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
    });
    return config;
  }

  async getInstallConfig(id: string): Promise<InstallConfig | undefined> {
    const config = await this.#pgFirstJson<InstallConfig>(
      pgSchema.installConfigs,
      pgSchema.installConfigs.configJson,
      eq(pgSchema.installConfigs.id, id),
    );
    return config;
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
        const value = parseRow(row) as InstallConfig;
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
    return configs;
  }

  async listSharedInstallConfigs(): Promise<readonly InstallConfig[]> {
    return await this.#pgManyJson<InstallConfig>(
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
    return pageFromProbe(rows, limit);
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

  async reservePublicHost(
    input: ReservePublicHostInput,
  ): Promise<ReservePublicHostResult> {
    const hostname = input.hostname.toLowerCase();
    const workspace = await this.getWorkspace(input.workspaceId);
    if (!workspace) {
      throw new Error("public host reservation workspace was not found");
    }
    const ownerUserId = workspace.ownerUserId;
    const reserve = async (
      client: SqlClient,
    ): Promise<ReservePublicHostResult> => {
      const rows = await client.query<Record<string, unknown>>(
        `insert into takosumi_public_host_reservations (
           hostname, owner_user_id, workspace_id, installation_id,
           installation_name, allocation_kind, status,
           reserved_at, updated_at, released_at
         )
         values ($1, $2, $3, $4, $5, $6, 'reserved', $7, $7, null)
         on conflict (hostname) do update
         set owner_user_id = excluded.owner_user_id,
             workspace_id = excluded.workspace_id,
             installation_id = excluded.installation_id,
             installation_name = excluded.installation_name,
             allocation_kind = excluded.allocation_kind,
             status = 'reserved',
             reserved_at = case
               when takosumi_public_host_reservations.installation_id = excluded.installation_id
               then takosumi_public_host_reservations.reserved_at
               else excluded.reserved_at
             end,
             updated_at = excluded.updated_at,
             released_at = null
         where takosumi_public_host_reservations.status = 'released'
            or takosumi_public_host_reservations.installation_id = excluded.installation_id
         returning hostname, owner_user_id, workspace_id, installation_id,
                   installation_name, allocation_kind, status,
                   reserved_at, updated_at, released_at`,
        [
          hostname,
          ownerUserId,
          input.workspaceId,
          input.capsuleId,
          input.capsuleName,
          input.allocationKind,
          input.now,
        ],
      );
      const won = rows.rows[0];
      if (won) {
        return {
          reserved: true,
          reservation: publicHostReservationFromRow(won),
        };
      }
      const existing = await client.query<Record<string, unknown>>(
        `select hostname, owner_user_id, workspace_id, installation_id,
                installation_name, allocation_kind, status,
                reserved_at, updated_at, released_at
         from takosumi_public_host_reservations
         where hostname = $1`,
        [hostname],
      );
      const reservation = publicHostReservationFromRow(existing.rows[0]);
      return { reserved: false, reservation, reason: "already_reserved" };
    };

    if (
      input.allocationKind !== "vanity" ||
      input.vanitySlotLimit === undefined
    ) {
      return await reserve(this.#client);
    }

    const limit = Math.max(0, Math.floor(input.vanitySlotLimit));
    return await this.#client.transaction(async (transaction) => {
      await transaction.query(
        `select pg_advisory_xact_lock(hashtext($1::text))`,
        [`takosumi:public-host-vanity:${ownerUserId}`],
      );
      const count = await transaction.query<{ count: string | number }>(
        `select count(*) as count
         from takosumi_public_host_reservations
         where owner_user_id = $1
           and allocation_kind = 'vanity'
           and status = 'reserved'
           and hostname <> $2`,
        [ownerUserId, hostname],
      );
      if (Number(count.rows[0]?.count ?? 0) >= limit) {
        return {
          reserved: false,
          reason: "owner_slot_limit_reached",
          vanitySlotLimit: limit,
        };
      }
      return await reserve(transaction);
    });
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
    return await this.#client.transaction(
      async (transaction: SqlTransaction) => {
        const txDb = this.#drizzleForClient(transaction);
        return await this.#commitRunStateWrites(txDb, input);
      },
    );
  }

  async commitResourceRun(
    input: CommitResourceRunInput,
  ): Promise<CommitResourceRunResult> {
    return await this.#client.transaction(
      async (transaction: SqlTransaction) => {
        const db = this.#drizzleForClient(transaction);
        const committed = await pgUpdateTerminalRunWithLease(
          db,
          input.applyRunTerminal.operation === "destroy"
            ? "destroy_apply"
            : "apply",
          RUN_KINDS_APPLY,
          input.applyRunTerminal,
          input.applyRunLeaseToken,
        );
        if (!committed) return { applyRunLeaseLost: true };
        await pgUpsertRun(
          db,
          input.planRunApplied.operation === "destroy"
            ? "destroy_plan"
            : "plan",
          input.planRunApplied,
        );
        return {};
      },
    );
  }

  async commitRestoredState(
    input: CommitRestoredStateInput,
  ): Promise<CommitRestoredStateResult> {
    return await this.#client.transaction(
      async (transaction: SqlTransaction) => {
        const db = this.#drizzleForClient(transaction);
        const restoreRunCommitted = await pgUpdateTerminalRunWithLease(
          db,
          RUN_KIND_RESTORE,
          [RUN_KIND_RESTORE],
          input.restoreRunTerminal,
          input.restoreRunLeaseToken,
        );
        if (!restoreRunCommitted) return { restoreRunLeaseLost: true };
        await pgUpsertStateVersion(db, input.stateVersion);

        const { capsulePatch } = input;
        const current = await this.#getCapsuleOn(db, capsulePatch.id);
        if (!current) return { capsule: undefined };
        const guard = capsulePatch.guard;
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
        if (!actual) return { capsule: undefined };
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
    await pgUpsertStateVersion(db, input.stateVersion);
    if (input.output) {
      await pgUpsertOutput(db, input.output);
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
      providersJson: normalized.providers,
      resourcesJson: normalized.resources,
      dataSourcesJson: normalized.dataSources,
      provisionersJson: normalized.provisioners,
      rootModuleVariablesJson: normalized.rootModuleVariables ?? [],
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
      providers: parseJson(
        row.providersJson,
      ) as CapsuleCompatibilityReport["providers"],
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
      providers: parseJson(
        row.providersJson,
      ) as CapsuleCompatibilityReport["providers"],
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
      rootModuleOutputs: parseJson(
        row.rootModuleOutputsJson,
      ) as CapsuleCompatibilityReport["rootModuleOutputs"],
      createdAt: row.createdAt,
    };
  }

  // --- Provider Binding sets (physical key: installation_id, environment) --

  async putProviderBindingSet(
    profile: ProviderBindingSet,
  ): Promise<ProviderBindingSet> {
    // One profile per (Capsule, environment): delete any stale row for the
    // same pair under a different id before upserting.
    await this.#db
      .delete(pgSchema.providerBindingSets)
      .where(
        and(
          eq(pgSchema.providerBindingSets.capsuleId, profile.capsuleId),
          eq(pgSchema.providerBindingSets.environment, profile.environment),
          ne(pgSchema.providerBindingSets.id, profile.id),
        ),
      );
    await this.#pgUpsert(pgSchema.providerBindingSets, {
      id: profile.id,
      workspaceId: profile.workspaceId,
      capsuleId: profile.capsuleId,
      environment: profile.environment,
      profileJson: profile,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    });
    return profile;
  }

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
  const values = {
    id: run.id,
    kind,
    workspaceId: run.workspaceId,
    sourceId: null,
    capsuleId: run.capsuleId ?? null,
    status: run.status,
    leaseToken: null as string | null,
    heartbeatAt: run.heartbeatAt ?? null,
    createdAt: String(run.createdAt),
    runJson: run,
  };
  await db
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
        runJson: values.runJson,
      },
    });
}

async function pgUpdateTerminalRunWithLease(
  db: PgRemoteDatabase<typeof pgSchema>,
  kind: string,
  allowedKinds: readonly string[],
  run: PlanRun | ApplyRun | SourceSyncRun | Run,
  leaseToken: string,
): Promise<boolean> {
  const values = {
    kind,
    workspaceId: run.workspaceId,
    sourceId: "sourceId" in run ? (run.sourceId ?? null) : null,
    capsuleId: "capsuleId" in run ? (run.capsuleId ?? null) : null,
    status: run.status,
    leaseToken: null as string | null,
    heartbeatAt: run.heartbeatAt ?? null,
    createdAt: String(run.createdAt),
    runJson: run,
  };
  const rows = await db
    .update(pgSchema.runs)
    .set(values)
    .where(
      and(
        eq(pgSchema.runs.id, run.id),
        inArray(pgSchema.runs.kind, [...allowedKinds]),
        eq(pgSchema.runs.status, "running"),
        eq(pgSchema.runs.leaseToken, leaseToken),
      ),
    )
    .returning({ id: pgSchema.runs.id });
  return rows.length > 0;
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
