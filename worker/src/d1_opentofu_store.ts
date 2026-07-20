/**
 * D1-backed control-plane ledger (core-spec.md §27) — Workspace-direct Capsule
 * model.
 *
 * This is the Cloudflare D1 backend of {@link OpenTofuControlStore}. It
 * materializes the §27 logical schema as real per-entity tables (`workspaces`,
 * `sources`, `source_snapshots`, `connections`, `secret_blobs`,
 * `install_configs`, `capsules`, `provider_binding_sets`, `runs`,
 * `state_versions`, `outputs`, `artifacts`) created lazily with
 * `CREATE TABLE IF NOT EXISTS` on first use
 * (the schema-init promise is memoized per store instance).
 *
 * Several contract types carry more fields than the §27 columns (the internal
 * PlanRun / ApplyRun records especially, plus ProviderConnection / Source which extend
 * the public row with internal-only data). For those rows the store populates
 * the §27-named indexed columns it filters/sorts on AND a `record_json` /
 * `run_json` TEXT column holding the full contract shape, so a put/get round-trip
 * is exact while list/read paths stay column-indexed. The store never stores
 * secret plaintext: the sealed `secret_blobs` ciphertext is the only credential
 * material, kept off every list path.
 *
 * worker/ is outside the tsc include scope; this file is exercised by
 * `core/domains/deploy-control/store_{sources,connections}_test.ts`
 * through the shared {@link OpenTofuControlStore} contract and bundled by the
 * worker build.
 */
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
  notExists,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import type {
  ApplyRun,
  ProviderConnection,
  InstallConfig,
  Capsule,
  PlanRun,
  RunnerProfile,
  StateVersion,
} from "@takosumi/internal/deploy-control-api";
import type {
  Source,
  SourceSnapshot,
  SourceSyncRun,
} from "takosumi-contract/sources";
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
import type { OutputShare, Output as Output } from "takosumi-contract/outputs";
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
import { usageEventUsdMicros } from "takosumi-contract/billing";
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
} from "../../core/domains/deploy-control/store.ts";
import {
  assertResourceOperationRun,
  assertResourceOperationRunStart,
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
} from "../../core/domains/deploy-control/store.ts";
import {
  artifactRecordFromRow,
  coerceRunRowStatus,
  normalizeCapsuleRecord,
  normalizeOptionalCapsuleRecord,
  normalizeOptionalSourceSnapshotRecord,
  normalizeSourceSnapshotRecord,
  usageEventFromRow,
} from "../../core/domains/deploy-control/store_row_mappers.ts";
import * as schema from "../../core/adapters/storage/drizzle/schema/d1.ts";
import type { D1Database, D1PreparedStatement, D1Result } from "./bindings.ts";
import {
  activeControlD1MaintenanceFence,
  assertControlD1MaintenanceInactive,
  repairControlD1MaintenanceGuards,
  wrapControlD1MaintenanceMigrationBatch,
} from "./d1_schema_maintenance.ts";

/**
 * Discriminator stored in the single §27 `runs.type` column. PlanRun rows use
 * `plan`/`destroy_plan`/`drift_check`, ApplyRun rows use `apply`/`destroy_apply`,
 * and SourceSyncRun rows use `source_sync`. The typed accessors filter on these so
 * the controller keeps its internal shapes.
 */
const RUN_KIND_PLAN = "plan" as const;
const RUN_KIND_APPLY = "apply" as const;
const RUN_KIND_SOURCE_SYNC = "source_sync" as const;
const RUN_KIND_COMPATIBILITY_CHECK = "compatibility_check" as const;
const RUN_KIND_RESOURCE_OPERATION = "resource_operation" as const;
const RUN_KIND_BACKUP = "backup" as const;
const RUN_KIND_RESTORE = "restore" as const;

// D1 rejects statements with more than 100 bound parameters. Leave headroom
// for future predicates instead of allowing a caller/data-sized `IN (...)`
// list to turn an otherwise valid route into a production 500.
const D1_IN_QUERY_VALUE_CHUNK_SIZE = 90;

function d1InQueryChunks<T>(values: readonly T[]): readonly (readonly T[])[] {
  const chunks: T[][] = [];
  for (
    let offset = 0;
    offset < values.length;
    offset += D1_IN_QUERY_VALUE_CHUNK_SIZE
  ) {
    chunks.push(values.slice(offset, offset + D1_IN_QUERY_VALUE_CHUNK_SIZE));
  }
  return chunks;
}

function compatibilityReportSourceId(value: string | null | undefined): string {
  if (!value?.trim()) {
    throw new TypeError(
      "CapsuleCompatibilityReport must reference a registered Git Source",
    );
  }
  return value;
}

function d1RunCreatedAtMillisOrder(): SQL {
  return sql`
    CASE
      WHEN ${schema.runs.createdAt} <> '' AND ${schema.runs.createdAt} NOT GLOB '*[^0-9]*'
        THEN CAST(${schema.runs.createdAt} AS INTEGER)
      ELSE (
        CAST(strftime('%s', ${schema.runs.createdAt}) AS INTEGER) * 1000
        + CAST(substr(strftime('%f', ${schema.runs.createdAt}), 4, 3) AS INTEGER)
      )
    END
  `;
}

/** Mirrors runtimeSafetyCandidateIsInFlight in the shared store model. */
function d1RunRuntimeSafetyInFlightOrder(): SQL {
  return sql`
    CASE
      WHEN ${schema.runs.type} = 'destroy_apply'
        AND ${schema.runs.status} IN ('queued', 'running') THEN 1
      WHEN ${schema.runs.type} = 'restore'
        AND ${schema.runs.status} IN ('queued', 'running') THEN 1
      ELSE 0
    END
  `;
}

/** Mirrors runtimeSafetyCandidateEffectTimestamp in the shared store model. */
function d1RunRuntimeSafetyEffectAtMillisOrder(): SQL {
  return sql`
    CASE
      WHEN ${schema.runs.type} IN ('apply', 'destroy_apply') THEN COALESCE(
        CAST(json_extract(${schema.runs.runJson}, '$.finishedAt') AS REAL),
        CAST(json_extract(${schema.runs.runJson}, '$.updatedAt') AS REAL),
        ${schema.runs.heartbeatAt},
        CAST(json_extract(${schema.runs.runJson}, '$.startedAt') AS REAL),
        ${d1RunCreatedAtMillisOrder()}
      )
      WHEN ${schema.runs.type} = 'restore' THEN COALESCE(
        CAST(
          strftime('%s', json_extract(${schema.runs.runJson}, '$.finishedAt'))
          AS INTEGER
        ) * 1000 + CAST(
          substr(
            strftime('%f', json_extract(${schema.runs.runJson}, '$.finishedAt')),
            4,
            3
          ) AS INTEGER
        ),
        ${schema.runs.heartbeatAt},
        CAST(
          strftime('%s', json_extract(${schema.runs.runJson}, '$.startedAt'))
          AS INTEGER
        ) * 1000 + CAST(
          substr(
            strftime('%f', json_extract(${schema.runs.runJson}, '$.startedAt')),
            4,
            3
          ) AS INTEGER
        ),
        ${d1RunCreatedAtMillisOrder()}
      )
      ELSE ${d1RunCreatedAtMillisOrder()}
    END
  `;
}

/** Mirrors runtimeSafetyCandidateRiskRank in the shared store model. */
function d1RunRuntimeSafetyRiskOrder(): SQL {
  return sql`
    CASE
      WHEN ${schema.runs.type} = 'destroy_apply'
        AND ${schema.runs.status} = 'succeeded' THEN 3
      WHEN ${schema.runs.type} = 'destroy_apply'
        AND ${schema.runs.status} IN ('queued', 'running') THEN 2
      WHEN ${schema.runs.status} IN ('failed', 'expired') THEN 1
      WHEN ${schema.runs.type} = 'restore'
        AND ${schema.runs.status} IN ('queued', 'running') THEN 1
      ELSE 0
    END
  `;
}

/** Mirrors applyRunMutationDispatched in the shared store model. */
function d1RunMutationDispatched(): SQL {
  return sql`
    EXISTS (
      SELECT 1
      FROM json_each(${schema.runs.runJson}, '$.auditEvents') AS audit_event
      WHERE json_extract(
        audit_event.value,
        '$.data.providerDispatched'
      ) = 1
         OR json_extract(
           audit_event.value,
           '$.data.lifecycleActionDispatched'
         ) = 1
    )
  `;
}

/** Mirrors applyRunBillingCapturePending in the shared store model. */
function d1RunBillingCapturePending(): SQL {
  return sql`
    EXISTS (
      SELECT 1
      FROM json_each(${schema.runs.runJson}, '$.auditEvents') AS audit_event
      WHERE json_extract(audit_event.value, '$.type') = 'billing.capture.pending'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(${schema.runs.runJson}, '$.auditEvents') AS audit_event
      WHERE json_extract(audit_event.value, '$.type') = 'billing.capture.completed'
    )
  `;
}

/** An expired apply/destroy is uncertain only after it started. */
function d1RunStarted(): SQL {
  return sql`json_extract(${schema.runs.runJson}, '$.startedAt') IS NOT NULL`;
}

/**
 * Builds the keyset WHERE predicate `(createdAt, id) > (cursor)` over the
 * `(createdAtCol, idCol)` sort columns (mirrors the SQL store's `pgKeysetWhere`
 * for the D1 / SQLite backend). No cursor (first page) returns the filter
 * unchanged.
 */
function d1KeysetWhere(
  filter: SQL | undefined,
  createdAtCol: SQLiteColumn,
  idCol: SQLiteColumn,
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
 * Descending counterpart of {@link d1KeysetWhere} for a newest-first list
 * (`ORDER BY createdAt DESC, id DESC`, e.g. control backups): a row qualifies
 * when its keyset is strictly BEFORE the cursor position.
 */
function d1KeysetWhereDesc(
  filter: SQL | undefined,
  createdAtCol: SQLiteColumn,
  idCol: SQLiteColumn,
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
function d1WorkspaceUpdatedDescKeysetWhere(
  filter: SQL | undefined,
  cursor: { readonly createdAt: string; readonly id: string } | undefined,
): SQL | undefined {
  if (cursor === undefined) return filter;
  const keyset = or(
    lt(schema.workspaces.updatedAt, cursor.createdAt),
    and(
      eq(schema.workspaces.updatedAt, cursor.createdAt),
      gt(schema.workspaces.id, cursor.id),
    ),
  );
  return filter === undefined ? keyset : and(filter, keyset);
}

export type D1OpenTofuControlSchemaMode = "bootstrap" | "predeployed";

export class CloudflareD1OpenTofuControlStore implements OpenTofuControlStore {
  readonly persistence = "durable" as const;
  readonly #orm: DrizzleD1Database<typeof schema>;
  readonly #schemaMode: D1OpenTofuControlSchemaMode;
  #initialized?: Promise<void>;

  constructor(
    private readonly db: D1Database,
    options: {
      readonly schemaMode?: D1OpenTofuControlSchemaMode;
    } = {},
  ) {
    this.#orm = drizzle(db, { schema });
    this.#schemaMode = options.schemaMode ?? "bootstrap";
  }

  // -- RunnerProfile ----------------------------------------------------------

  async putRunnerProfile(profile: RunnerProfile): Promise<RunnerProfile> {
    await this.#drizzleUpsert(schema.runnerProfiles, {
      id: profile.id,
      recordJson: profile,
      createdAt: profile.createdAt,
    });
    return profile;
  }

  async getRunnerProfile(id: string): Promise<RunnerProfile | undefined> {
    return await this.#drizzleFirstJson<RunnerProfile>(
      schema.runnerProfiles,
      schema.runnerProfiles.recordJson,
      eq(schema.runnerProfiles.id, id),
    );
  }

  async listRunnerProfiles(): Promise<readonly RunnerProfile[]> {
    return await this.#drizzleManyJson<RunnerProfile>(
      schema.runnerProfiles,
      schema.runnerProfiles.recordJson,
      { orderBy: [asc(schema.runnerProfiles.id)] },
    );
  }

  // -- Runs (PlanRun / ApplyRun / SourceSyncRun share the §27 `runs` table) ----

  async putPlanRun(run: PlanRun): Promise<PlanRun> {
    await this.#putRun({
      id: run.id,
      runGroupId: null,
      workspaceId: run.workspaceId,
      capsuleId: run.capsuleId ?? null,
      environment: run.capsuleContext?.environment ?? null,
      type: planRunType(run),
      status: run.status,
      runJson: JSON.stringify(run),
    });
    return run;
  }

  async getPlanRun(id: string): Promise<PlanRun | undefined> {
    const run = await this.#getRun<StoredRunRecord>(id, [
      RUN_KIND_PLAN,
      "destroy_plan",
      "drift_check",
    ]);
    return coerceRunRowStatus(run && isPlanRunRecord(run) ? run : undefined);
  }

  async putApplyRun(run: ApplyRun): Promise<ApplyRun> {
    await this.#putRun({
      id: run.id,
      runGroupId: null,
      workspaceId: run.workspaceId,
      capsuleId: run.capsuleId ?? null,
      environment: null,
      type: applyRunType(run),
      status: run.status,
      runJson: JSON.stringify(run),
    });
    return run;
  }

  async getApplyRun(id: string): Promise<ApplyRun | undefined> {
    const run = await this.#getRun<StoredRunRecord>(id, [
      RUN_KIND_APPLY,
      "destroy_apply",
    ]);
    return coerceRunRowStatus(run && isApplyRunRecord(run) ? run : undefined);
  }

  /**
   * Status-conditional, lease-fenced compare-and-set transition (same {won, run}
   * contract as the SQL store). A single conditional UPDATE fences on `id`,
   * `type` (the run family), `status ∈ expectFrom`, and — when set —
   * `lease_token = expectLeaseToken`, and when set the JSON `startedAt` equals
   * `expectStartedAt`, so a concurrent claimer or requeue loses deterministically.
   * On a win the status / run_json advance to `input.run`; `setLeaseToken` /
   * `clearLeaseToken` / `clearHeartbeat` / `heartbeatAt` write the lease and
   * heartbeat columns. A lost race (0 rows changed) re-reads the current row and
   * returns it with `won: false`.
   */
  async transitionRun(input: TransitionRunInput): Promise<TransitionRunResult> {
    await this.#ensureSchema();
    const types =
      input.kind === "plan"
        ? [RUN_KIND_PLAN, "destroy_plan", "drift_check"]
        : input.kind === "apply"
          ? [RUN_KIND_APPLY, "destroy_apply"]
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
    const result = await this.#orm
      .update(schema.runs)
      .set({
        status: persisted.status,
        runJson: persisted as unknown,
        ...(input.clearHeartbeat
          ? { heartbeatAt: null }
          : heartbeatAt === undefined
            ? {}
            : { heartbeatAt }),
        ...leaseSet,
      })
      .where(
        and(
          eq(schema.runs.id, input.id),
          inArray(schema.runs.type, types),
          inArray(schema.runs.status, [...input.expectFrom]),
          input.expectLeaseToken === undefined
            ? undefined
            : eq(schema.runs.leaseToken, input.expectLeaseToken),
          input.expectHeartbeatAt === undefined
            ? undefined
            : input.expectHeartbeatAt === null
              ? isNull(schema.runs.heartbeatAt)
              : eq(schema.runs.heartbeatAt, input.expectHeartbeatAt),
          input.expectStartedAt === undefined
            ? undefined
            : input.expectStartedAt === null
              ? sql`json_extract(${schema.runs.runJson}, '$.startedAt') IS NULL`
              : sql`json_extract(${schema.runs.runJson}, '$.startedAt') = ${input.expectStartedAt}`,
        ),
      )
      .run();
    if (changes(result as D1Result) > 0) {
      return { won: true, run: persisted };
    }
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
    await this.#putRun({
      id: run.id,
      runGroupId: null,
      workspaceId: run.workspaceId,
      sourceId: run.sourceId,
      capsuleId: null,
      environment: null,
      type: RUN_KIND_SOURCE_SYNC,
      status: run.status,
      runJson: JSON.stringify(run),
    });
    return run;
  }

  async getSourceSyncRun(id: string): Promise<SourceSyncRun | undefined> {
    return await this.#getRun<SourceSyncRun>(id, [RUN_KIND_SOURCE_SYNC]);
  }

  async putCompatibilityCheckRun(run: Run): Promise<Run> {
    if (run.type !== RUN_KIND_COMPATIBILITY_CHECK) {
      throw new Error(
        "putCompatibilityCheckRun only accepts compatibility_check runs",
      );
    }
    await this.#putRun({
      id: run.id,
      runGroupId: run.runGroupId ?? null,
      workspaceId: run.workspaceId,
      sourceId: run.sourceId ?? null,
      capsuleId: null,
      environment: null,
      type: RUN_KIND_COMPATIBILITY_CHECK,
      status: run.status,
      runJson: JSON.stringify(run),
    });
    return run;
  }

  async getCompatibilityCheckRun(id: string): Promise<Run | undefined> {
    return await this.#getRun<Run>(id, [RUN_KIND_COMPATIBILITY_CHECK]);
  }

  async beginResourceOperationRun(
    run: ResourceOperationRun,
  ): Promise<BeginResourceOperationRunResult> {
    assertResourceOperationRunStart(run);
    await this.#ensureSchema();
    const inserted = await this.#orm
      .insert(schema.runs)
      .values({
        id: run.id,
        runGroupId: null,
        workspaceId: run.workspaceId,
        sourceId: null,
        capsuleId: null,
        environment: run.environment ?? null,
        type: RUN_KIND_RESOURCE_OPERATION,
        status: run.status,
        leaseToken: null,
        heartbeatAt: null,
        runJson: run as unknown,
        createdAt: String(run.createdAt),
      })
      .onConflictDoNothing({ target: schema.runs.id })
      .run();
    if (changes(inserted as D1Result) > 0) {
      return { status: "created", run };
    }
    const current = await this.getResourceOperationRun(run.id);
    if (!current) return { status: "conflict" };
    return sameResourceOperationIdentity(current, run)
      ? { status: "existing", run: current }
      : { status: "conflict", run: current };
  }

  async getResourceOperationRun(
    id: string,
  ): Promise<ResourceOperationRun | undefined> {
    return await this.#getRun<ResourceOperationRun>(id, [
      RUN_KIND_RESOURCE_OPERATION,
    ]);
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
    await this.#ensureSchema();
    const result = await this.#orm
      .update(schema.runs)
      .set({
        status: input.run.status,
        runJson: input.run as unknown,
      })
      .where(
        and(
          eq(schema.runs.id, input.id),
          eq(schema.runs.type, RUN_KIND_RESOURCE_OPERATION),
          inArray(schema.runs.status, [...input.expectFrom]),
          sql`json_extract(${schema.runs.runJson}, '$.resourceOperationKey') = ${input.operationKey}`,
          sql`json_extract(${schema.runs.runJson}, '$.resourceOperationVersion') = ${input.expectedVersion}`,
        ),
      )
      .run();
    if (changes(result as D1Result) > 0) {
      return { won: true, run: input.run };
    }
    const current = await this.getResourceOperationRun(input.id);
    return { won: false, ...(current ? { run: current } : {}) };
  }

  async listRecoverableResourceOperationRuns(
    options: RecoverableResourceOperationRunListOptions = {},
  ): Promise<readonly ResourceOperationRun[]> {
    const rows = await this.#drizzleManyJson<ResourceOperationRun>(
      schema.runs,
      schema.runs.runJson,
      {
        where: and(
          eq(schema.runs.type, RUN_KIND_RESOURCE_OPERATION),
          options.workspaceId === undefined
            ? undefined
            : eq(schema.runs.workspaceId, options.workspaceId),
          or(
            eq(schema.runs.status, "running"),
            sql`json_extract(${schema.runs.runJson}, '$.resourceOperationAudit.status') = 'pending'`,
          ),
        ),
        orderBy: [asc(d1RunCreatedAtMillisOrder()), asc(schema.runs.id)],
        limit: clampRecoverableResourceOperationRunListLimit(options.limit),
      },
    );
    return rows.filter(resourceOperationRunNeedsRecovery);
  }

  async putBackupRun(run: Run): Promise<Run> {
    if (run.type !== RUN_KIND_BACKUP && run.type !== "restore") {
      throw new Error("putBackupRun only accepts backup/restore runs");
    }
    await this.#putRun({
      id: run.id,
      runGroupId: run.runGroupId ?? null,
      workspaceId: run.workspaceId,
      sourceId: run.sourceId ?? null,
      capsuleId: run.capsuleId ?? null,
      environment: run.environment ?? null,
      type: run.type,
      status: run.status,
      runJson: JSON.stringify(run),
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
    return await this.#drizzleManyJson<StoredRunRecord>(
      schema.runs,
      schema.runs.runJson,
      {
        where: eq(schema.runs.workspaceId, workspaceId),
        orderBy: [desc(d1RunCreatedAtMillisOrder()), desc(schema.runs.id)],
        limit,
      },
    );
  }

  async getCapsuleRuntimeSafety(
    capsuleId: string,
  ): Promise<CapsuleRuntimeSafety | undefined> {
    const rows = await this.#drizzleManyJson<ApplyRun | Run>(
      schema.runs,
      schema.runs.runJson,
      {
        where: and(
          eq(schema.runs.capsuleId, capsuleId),
          or(
            and(
              eq(schema.runs.type, "apply"),
              or(
                eq(schema.runs.status, "succeeded"),
                and(
                  eq(schema.runs.status, "failed"),
                  d1RunMutationDispatched(),
                ),
                and(eq(schema.runs.status, "expired"), d1RunStarted()),
              ),
            ),
            and(
              eq(schema.runs.type, "destroy_apply"),
              or(
                inArray(schema.runs.status, ["queued", "running", "succeeded"]),
                and(
                  eq(schema.runs.status, "failed"),
                  d1RunMutationDispatched(),
                ),
                and(eq(schema.runs.status, "expired"), d1RunStarted()),
              ),
            ),
            and(
              eq(schema.runs.type, RUN_KIND_RESTORE),
              inArray(schema.runs.status, [
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
          desc(d1RunRuntimeSafetyInFlightOrder()),
          desc(d1RunRuntimeSafetyEffectAtMillisOrder()),
          desc(d1RunRuntimeSafetyRiskOrder()),
          desc(schema.runs.id),
        ],
        limit: 1,
      },
    );
    return rows[0] ? capsuleRuntimeSafetyFromRun(rows[0]) : undefined;
  }

  async listRecoverableOpenTofuRuns(
    options: RecoverableOpenTofuRunListOptions,
  ): Promise<readonly StoredRunRecord[]> {
    const rows = await this.#drizzleManyJson<StoredRunRecord>(
      schema.runs,
      schema.runs.runJson,
      {
        where: or(
          and(
            inArray(schema.runs.status, ["queued", "running"]),
            inArray(schema.runs.type, [
              RUN_KIND_PLAN,
              "destroy_plan",
              "drift_check",
              RUN_KIND_APPLY,
              "destroy_apply",
              RUN_KIND_SOURCE_SYNC,
              RUN_KIND_RESTORE,
            ]),
          ),
          and(
            inArray(schema.runs.type, [RUN_KIND_APPLY, "destroy_apply"]),
            inArray(schema.runs.status, ["succeeded", "failed"]),
            d1RunBillingCapturePending(),
          ),
        ),
      },
    );
    const limit = clampRecoverableOpenTofuRunListLimit(options.limit);
    return [...rows]
      .filter((row) => isRecoverableOpenTofuRunRecord(row, options))
      .sort(compareStoredRunRecordsAsc)
      .slice(0, limit);
  }

  async listSourceSyncRuns(
    sourceId: string,
  ): Promise<readonly SourceSyncRun[]> {
    return await this.#drizzleManyJson<SourceSyncRun>(
      schema.runs,
      schema.runs.runJson,
      {
        where: and(
          eq(schema.runs.type, RUN_KIND_SOURCE_SYNC),
          eq(schema.runs.sourceId, sourceId),
        ),
        orderBy: [asc(schema.runs.createdAt), asc(schema.runs.id)],
      },
    );
  }

  // -- Artifact ledger (§30 artifacts) ---------------------------------------

  async putArtifactRecord(record: ArtifactRecord): Promise<ArtifactRecord> {
    await this.#drizzleUpsert(schema.artifacts, {
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
    await this.#ensureSchema();
    const rows = await this.#orm
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.runId, runId))
      .orderBy(asc(schema.artifacts.createdAt), asc(schema.artifacts.id));
    return rows.map(artifactRecordFromRow);
  }

  // -- PlanRunInputs sidecar (internal; never projected) ----------------------

  async putPlanRunInputs(inputs: PlanRunInputs): Promise<void> {
    await this.#drizzleUpsert(
      schema.planRunInputs,
      {
        planRunId: inputs.planRunId,
        inputsJson: inputs,
      },
      {
        inputsJson: inputs,
      },
      schema.planRunInputs.planRunId,
    );
  }

  async getPlanRunInputs(
    planRunId: string,
  ): Promise<PlanRunInputs | undefined> {
    return await this.#drizzleFirstJson<PlanRunInputs>(
      schema.planRunInputs,
      schema.planRunInputs.inputsJson,
      eq(schema.planRunInputs.planRunId, planRunId),
    );
  }

  async deletePlanRunInputs(planRunId: string): Promise<void> {
    await this.#drizzleDelete(
      schema.planRunInputs,
      eq(schema.planRunInputs.planRunId, planRunId),
    );
  }

  // -- Workspace ------------------------------------------------------------------

  async putWorkspace(workspace: Workspace): Promise<Workspace> {
    await this.#drizzleUpsert(schema.workspaces, {
      id: workspace.id,
      handle: workspace.handle,
      recordJson: workspace,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    });
    return workspace;
  }

  async getWorkspace(id: string): Promise<Workspace | undefined> {
    return await this.#drizzleFirstJson<Workspace>(
      schema.workspaces,
      schema.workspaces.recordJson,
      eq(schema.workspaces.id, id),
    );
  }

  async listWorkspacesByIds(
    ids: readonly string[],
  ): Promise<readonly Workspace[]> {
    if (ids.length === 0) return [];
    const uniqueIds = [...new Set(ids)];
    const rows: Workspace[] = [];
    for (const idChunk of d1InQueryChunks(uniqueIds)) {
      rows.push(
        ...(await this.#drizzleManyJson<Workspace>(
          schema.workspaces,
          schema.workspaces.recordJson,
          {
            where: inArray(schema.workspaces.id, [...idChunk]),
          },
        )),
      );
    }
    const byId = new Map(rows.map((row) => [row.id, row] as const));
    return ids
      .map((id) => byId.get(id))
      .filter((row): row is Workspace => row !== undefined);
  }

  async getWorkspaceByHandle(handle: string): Promise<Workspace | undefined> {
    return await this.#drizzleFirstJson<Workspace>(
      schema.workspaces,
      schema.workspaces.recordJson,
      eq(schema.workspaces.handle, handle),
    );
  }

  async listWorkspaces(): Promise<readonly Workspace[]> {
    return await this.#drizzleManyJson<Workspace>(
      schema.workspaces,
      schema.workspaces.recordJson,
      {
        orderBy: [asc(schema.workspaces.createdAt), asc(schema.workspaces.id)],
      },
    );
  }

  async listWorkspacesByOwner(
    ownerUserId: string,
  ): Promise<readonly Workspace[]> {
    return await this.#drizzleManyJson<Workspace>(
      schema.workspaces,
      schema.workspaces.recordJson,
      {
        where: sql`${schema.workspaces.recordJson} ->> 'ownerUserId' = ${ownerUserId}`,
        orderBy: [asc(schema.workspaces.createdAt), asc(schema.workspaces.id)],
      },
    );
  }

  async putWorkspaceMember(member: WorkspaceMember): Promise<WorkspaceMember> {
    await this.#drizzleUpsert(
      schema.workspaceMembers,
      {
        id: member.id,
        workspaceId: member.workspaceId,
        accountId: member.accountId,
        status: member.status,
        recordJson: member,
        createdAt: member.createdAt,
        updatedAt: member.updatedAt,
      },
      {
        id: member.id,
        status: member.status,
        recordJson: member,
        createdAt: member.createdAt,
        updatedAt: member.updatedAt,
      },
      [schema.workspaceMembers.workspaceId, schema.workspaceMembers.accountId],
    );
    return member;
  }

  async getWorkspaceMember(
    workspaceId: string,
    accountId: string,
  ): Promise<WorkspaceMember | undefined> {
    return await this.#drizzleFirstJson<WorkspaceMember>(
      schema.workspaceMembers,
      schema.workspaceMembers.recordJson,
      and(
        eq(schema.workspaceMembers.workspaceId, workspaceId),
        eq(schema.workspaceMembers.accountId, accountId),
      ),
    );
  }

  async listWorkspaceMembers(
    workspaceId: string,
  ): Promise<readonly WorkspaceMember[]> {
    return await this.#drizzleManyJson<WorkspaceMember>(
      schema.workspaceMembers,
      schema.workspaceMembers.recordJson,
      {
        where: eq(schema.workspaceMembers.workspaceId, workspaceId),
        orderBy: [
          asc(schema.workspaceMembers.createdAt),
          asc(schema.workspaceMembers.id),
        ],
      },
    );
  }

  async listWorkspaceMembersByAccount(
    accountId: string,
  ): Promise<readonly WorkspaceMember[]> {
    return await this.#drizzleManyJson<WorkspaceMember>(
      schema.workspaceMembers,
      schema.workspaceMembers.recordJson,
      {
        where: eq(schema.workspaceMembers.accountId, accountId),
        orderBy: [
          asc(schema.workspaceMembers.createdAt),
          asc(schema.workspaceMembers.id),
        ],
      },
    );
  }

  async listWorkspacesForAccountPage(
    accountId: string,
    params: AccountWorkspaceListParams,
  ): Promise<AccountWorkspacePage> {
    await this.#ensureSchema();
    const includeArchived = params.includeArchived === true;
    const order = params.order ?? "created_asc";
    const limit = clampPageLimit(params.limit);
    const baseFilter = and(
      eq(schema.workspaceMembers.accountId, accountId),
      eq(schema.workspaceMembers.status, "active"),
      includeArchived
        ? undefined
        : sql`COALESCE(json_extract(${schema.workspaces.recordJson}, '$.archivedAt'), '') = ''`,
    );
    const countRows = await this.#orm
      .select({ total: sql<number>`count(*)` })
      .from(schema.workspaceMembers)
      .innerJoin(
        schema.workspaces,
        eq(schema.workspaces.id, schema.workspaceMembers.workspaceId),
      )
      .where(baseFilter);
    const cursor = decodeCursor(params.cursor);
    const pageFilter =
      order === "updated_desc"
        ? d1WorkspaceUpdatedDescKeysetWhere(baseFilter, cursor)
        : d1KeysetWhere(
            baseFilter,
            schema.workspaces.createdAt,
            schema.workspaces.id,
            cursor,
          );
    const query = this.#orm
      .select({ value: schema.workspaces.recordJson })
      .from(schema.workspaceMembers)
      .innerJoin(
        schema.workspaces,
        eq(schema.workspaces.id, schema.workspaceMembers.workspaceId),
      )
      .where(pageFilter)
      .$dynamic();
    const ordered =
      order === "updated_desc"
        ? query.orderBy(
            desc(schema.workspaces.updatedAt),
            asc(schema.workspaces.id),
          )
        : query.orderBy(
            asc(schema.workspaces.createdAt),
            asc(schema.workspaces.id),
          );
    const workspaces = (await ordered.limit(limit + 1)).map(
      (row) => row.value as Workspace,
    );
    const page = pageFromProbeBy(workspaces, limit, (workspace) => ({
      createdAt:
        order === "updated_desc" ? workspace.updatedAt : workspace.createdAt,
      id: workspace.id,
    }));
    return { ...page, total: Number(countRows[0]?.total ?? 0) };
  }

  async putProject(project: Project): Promise<Project> {
    await this.#drizzleUpsert(schema.projects, {
      id: project.id,
      workspaceId: project.workspaceId,
      name: project.name,
      slug: project.slug,
      recordJson: project,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    });
    return project;
  }

  async getProject(id: string): Promise<Project | undefined> {
    return await this.#drizzleFirstJson<Project>(
      schema.projects,
      schema.projects.recordJson,
      eq(schema.projects.id, id),
    );
  }

  async getProjectBySlug(
    workspaceId: string,
    slug: string,
  ): Promise<Project | undefined> {
    return await this.#drizzleFirstJson<Project>(
      schema.projects,
      schema.projects.recordJson,
      and(
        eq(schema.projects.workspaceId, workspaceId),
        eq(schema.projects.slug, slug),
      ),
    );
  }

  async listProjectsByWorkspace(
    workspaceId: string,
  ): Promise<readonly Project[]> {
    return await this.#drizzleManyJson<Project>(
      schema.projects,
      schema.projects.recordJson,
      {
        where: eq(schema.projects.workspaceId, workspaceId),
        orderBy: [asc(schema.projects.createdAt), asc(schema.projects.id)],
      },
    );
  }

  // -- InstallConfig ----------------------------------------------------------

  async putInstallConfig(config: InstallConfig): Promise<InstallConfig> {
    await this.#drizzleUpsert(schema.installConfigs, {
      id: config.id,
      workspaceId: config.workspaceId ?? null,
      recordJson: config,
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
    });
    return config;
  }

  async getInstallConfig(id: string): Promise<InstallConfig | undefined> {
    const config = await this.#drizzleFirstJson<InstallConfig>(
      schema.installConfigs,
      schema.installConfigs.recordJson,
      eq(schema.installConfigs.id, id),
    );
    return config;
  }

  async listInstallConfigs(
    workspaceId?: string,
  ): Promise<readonly InstallConfig[]> {
    const configs = await this.#drizzleManyJson<InstallConfig>(
      schema.installConfigs,
      schema.installConfigs.recordJson,
      {
        where:
          workspaceId === undefined
            ? undefined
            : eq(schema.installConfigs.workspaceId, workspaceId),
        orderBy: [
          asc(schema.installConfigs.createdAt),
          asc(schema.installConfigs.id),
        ],
      },
    );
    return configs;
  }

  // -- Capsule -----------------------------------------------------------

  async putCapsule(capsule: Capsule): Promise<Capsule> {
    const normalized = normalizeCapsuleRecord(capsule);
    await this.#drizzleUpsert(schema.capsules, {
      id: normalized.id,
      workspaceId: normalized.workspaceId,
      projectId: normalized.projectId,
      name: normalized.name,
      slug: normalized.slug,
      sourceId: normalized.sourceId,
      installConfigId: normalized.installConfigId,
      environment: normalized.environment,
      currentStateVersionId: normalized.currentStateVersionId ?? null,
      currentStateGeneration: normalized.currentStateGeneration,
      currentOutputId: normalized.currentOutputId ?? null,
      status: normalized.status,
      recordJson: normalized,
      createdAt: normalized.createdAt,
      updatedAt: normalized.updatedAt,
    });
    return normalized;
  }

  async getCapsule(id: string): Promise<Capsule | undefined> {
    return normalizeOptionalCapsuleRecord(
      await this.#drizzleFirstJson<Capsule>(
        schema.capsules,
        schema.capsules.recordJson,
        eq(schema.capsules.id, id),
      ),
    );
  }

  async getCapsuleByName(
    projectId: string,
    name: string,
    environment: string,
  ): Promise<Capsule | undefined> {
    return normalizeOptionalCapsuleRecord(
      await this.#drizzleFirstJson<Capsule>(
        schema.capsules,
        schema.capsules.recordJson,
        and(
          eq(schema.capsules.projectId, projectId),
          eq(schema.capsules.name, name),
          eq(schema.capsules.environment, environment),
          ne(schema.capsules.status, "destroyed"),
        ),
      ),
    );
  }

  async listCapsules(workspaceId?: string): Promise<readonly Capsule[]> {
    return (
      await this.#drizzleManyJson<Capsule>(
        schema.capsules,
        schema.capsules.recordJson,
        {
          where:
            workspaceId === undefined
              ? undefined
              : eq(schema.capsules.workspaceId, workspaceId),
          orderBy: [asc(schema.capsules.createdAt), asc(schema.capsules.id)],
        },
      )
    ).map(normalizeCapsuleRecord);
  }

  async listCapsulesPage(
    workspaceId: string,
    params: CapsuleListPageParams,
  ): Promise<Page<Capsule>> {
    const limit = clampPageLimit(params.limit);
    const baseWhere =
      params.includeDestroyed === false
        ? and(
            eq(schema.capsules.workspaceId, workspaceId),
            ne(schema.capsules.status, "destroyed"),
          )
        : eq(schema.capsules.workspaceId, workspaceId);
    const rows = await this.#drizzleManyJson<Capsule>(
      schema.capsules,
      schema.capsules.recordJson,
      {
        where: d1KeysetWhere(
          baseWhere,
          schema.capsules.createdAt,
          schema.capsules.id,
          decodeCursor(params.cursor),
        ),
        orderBy: [asc(schema.capsules.createdAt), asc(schema.capsules.id)],
        limit: limit + 1,
      },
    );
    return pageFromProbe(rows.map(normalizeCapsuleRecord), limit);
  }

  async reservePublicHost(
    input: ReservePublicHostInput,
  ): Promise<ReservePublicHostResult> {
    await this.#ensureSchema();
    const hostname = input.hostname.toLowerCase();
    const workspace = await this.getWorkspace(input.workspaceId);
    if (!workspace) {
      throw new Error("public host reservation workspace was not found");
    }
    const ownerUserId = workspace.ownerUserId;
    const vanitySlotLimit =
      input.allocationKind === "vanity" && input.vanitySlotLimit !== undefined
        ? Math.max(0, Math.floor(input.vanitySlotLimit))
        : -1;
    await this.db
      .prepare(
        `insert into public_host_reservations (
           hostname, owner_user_id, workspace_id, installation_id,
           installation_name, allocation_kind, status,
           reserved_at, updated_at, released_at
         )
         select ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, null
         where ? < 0
            or (
              select count(*)
              from public_host_reservations
              where owner_user_id = ?
                and allocation_kind = 'vanity'
                and status = 'reserved'
                and hostname != ?
            ) < ?
         on conflict(hostname) do update
         set owner_user_id = excluded.owner_user_id,
             workspace_id = excluded.workspace_id,
             installation_id = excluded.installation_id,
             installation_name = excluded.installation_name,
             allocation_kind = excluded.allocation_kind,
             status = 'reserved',
             reserved_at = case
               when public_host_reservations.installation_id = excluded.installation_id
               then public_host_reservations.reserved_at
               else excluded.reserved_at
             end,
             updated_at = excluded.updated_at,
             released_at = null
         where public_host_reservations.status = 'released'
            or public_host_reservations.installation_id = excluded.installation_id`,
      )
      .bind(
        hostname,
        ownerUserId,
        input.workspaceId,
        input.capsuleId,
        input.capsuleName,
        input.allocationKind,
        input.now,
        input.now,
        vanitySlotLimit,
        ownerUserId,
        hostname,
        vanitySlotLimit,
      )
      .run();
    const reservation = await this.db
      .prepare(
        `select hostname, owner_user_id, workspace_id, installation_id,
                installation_name, allocation_kind, status,
                reserved_at, updated_at, released_at
         from public_host_reservations
         where hostname = ?`,
      )
      .bind(hostname)
      .first<Record<string, unknown>>();
    if (!reservation) {
      return {
        reserved: false,
        reason: "owner_slot_limit_reached",
        vanitySlotLimit: Math.max(0, vanitySlotLimit),
      };
    }
    const normalized = publicHostReservationFromD1Row(reservation);
    if (
      normalized.status === "reserved" &&
      normalized.capsuleId === input.capsuleId &&
      normalized.allocationKind === input.allocationKind
    ) {
      return { reserved: true, reservation: normalized };
    }
    return {
      reserved: false,
      reservation: normalized,
      reason: "already_reserved",
    };
  }

  async getPublicHostReservation(
    hostname: string,
  ): Promise<PublicHostReservation | undefined> {
    await this.#ensureSchema();
    const row = await this.db
      .prepare(
        `select hostname, owner_user_id, workspace_id, installation_id,
                installation_name, allocation_kind, status,
                reserved_at, updated_at, released_at
         from public_host_reservations
         where hostname = ?`,
      )
      .bind(hostname.toLowerCase())
      .first<Record<string, unknown>>();
    return row ? publicHostReservationFromD1Row(row) : undefined;
  }

  async releasePublicHostsForCapsule(
    capsuleId: string,
    now: string,
  ): Promise<void> {
    await this.#ensureSchema();
    await this.db
      .prepare(
        `update public_host_reservations
         set status = 'released',
             updated_at = ?,
             released_at = ?
         where installation_id = ?
           and status = 'reserved'`,
      )
      .bind(now, now, capsuleId)
      .run();
  }

  async patchCapsule(
    id: string,
    patch: CapsulePatch,
    guard?: CapsuleStateVersionGuard,
  ): Promise<Capsule | undefined> {
    const existing = await this.getCapsule(id);
    if (!existing) return undefined;
    if (
      guard !== undefined &&
      (existing.currentStateVersionId !== guard.currentStateVersionId ||
        (guard.status !== undefined && existing.status !== guard.status))
    ) {
      throw new CapsuleStateVersionGuardConflict({
        id,
        expectedCurrentStateVersionId: guard.currentStateVersionId,
        actualCurrentStateVersionId: existing.currentStateVersionId,
        expectedStatus: guard.status,
        actualStatus: existing.status,
      });
    }
    const updated: Capsule = { ...existing, ...patch };
    if (!guard) return await this.putCapsule(updated);
    // Guarded path: a single conditional UPDATE so a concurrent writer that
    // moved currentStateVersionId/status loses the race deterministically.
    await this.#ensureSchema();
    const result = await this.#orm
      .update(schema.capsules)
      .set({
        currentStateVersionId: updated.currentStateVersionId ?? null,
        currentStateGeneration: updated.currentStateGeneration,
        currentOutputId: updated.currentOutputId ?? null,
        status: updated.status,
        recordJson: normalizeCapsuleRecord(updated),
        updatedAt: updated.updatedAt,
      })
      .where(
        and(
          eq(schema.capsules.id, id),
          guard.currentStateVersionId === undefined
            ? isNull(schema.capsules.currentStateVersionId)
            : eq(
                schema.capsules.currentStateVersionId,
                guard.currentStateVersionId,
              ),
          guard.status === undefined
            ? undefined
            : eq(schema.capsules.status, guard.status),
        ),
      )
      .run();
    if (changes(result as D1Result) > 0) {
      return normalizeCapsuleRecord(updated);
    }
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
   * Atomic provider-applied / destroy-apply ledger commit (spec §20 / §21 / §16) for D1.
   *
   * D1 has NO interactive transaction, but `batch([...])` commits a set of
   * statements atomically (all-or-nothing). So every WRITE — new/superseded
   * StateVersion, (apply) Output, and the Capsule
   * advance — is committed in ONE `this.#orm.batch(...)` call; a crash between
   * statements can no longer leave torn state.
   *
   * The guarded Capsule advance is still evaluated before the batch because
   * D1 cannot branch a batch on an UPDATE row count. Apply ownership is stricter:
   * when an apply terminal row carries a lease token, the batch starts with a
   * guard statement that raises a deliberate SQL error unless the current run
   * row is still `running` with that token. That error rolls the whole batch
   * back, so a stale owner cannot write StateVersion/Output rows after
   * another worker has taken the run over.
   *
   * The Capsule guard mirrors {@link patchCapsule}:
   *   - row gone -> `{ capsule: undefined }` (no writes), same as today;
   *   - guard mismatch -> throw {@link CapsuleStateVersionGuardConflict} (no writes);
   *   - guard match -> batch all writes + the (now-safe) unconditional UPDATE.
   */
  async commitRunState(
    input: CommitRunStateInput,
  ): Promise<CommitRunStateResult> {
    await this.#ensureSchema();
    const { capsulePatch } = input;
    if (input.applyRunTerminal && input.applyRunLeaseToken !== undefined) {
      const row = await this.#orm
        .select({ leaseToken: schema.runs.leaseToken })
        .from(schema.runs)
        .where(
          and(
            eq(schema.runs.id, input.applyRunTerminal.id),
            inArray(schema.runs.type, [RUN_KIND_APPLY, "destroy_apply"]),
          ),
        )
        .get();
      if (row?.leaseToken !== input.applyRunLeaseToken) {
        return { applyRunLeaseLost: true };
      }
    }
    const current = await this.getCapsule(capsulePatch.id);
    if (!current) return { capsule: undefined };
    const guard = capsulePatch.guard;
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
    const statements = [
      ...(input.applyRunTerminal && input.applyRunLeaseToken !== undefined
        ? [
            d1RunLeaseGuardStmt(
              this.#orm,
              input.applyRunTerminal.id,
              input.applyRunLeaseToken,
              [RUN_KIND_APPLY, "destroy_apply"],
            ),
          ]
        : []),
      d1UpsertStateVersionStmt(this.#orm, input.stateVersion),
      ...(input.output ? [d1UpsertOutputStmt(this.#orm, input.output)] : []),
      // Commit-tail fold (S2): the terminal ApplyRun + the applied PlanRun join
      // the SAME atomic batch as the StateVersion so a torn tail can no longer
      // leave a stuck `running` Run over finished state. The apply
      // terminal clears its lease fence (lease_token = NULL); the plan patch is a
      // plain row write (already terminal succeeded, no lease).
      ...(input.applyRunTerminal
        ? [
            d1UpsertRunStmt(
              this.#orm,
              applyRunType(input.applyRunTerminal),
              input.applyRunTerminal,
            ),
          ]
        : []),
      ...(input.planRunApplied
        ? [
            d1UpsertRunStmt(
              this.#orm,
              planRunType(input.planRunApplied),
              input.planRunApplied,
            ),
          ]
        : []),
      this.#orm
        .update(schema.capsules)
        .set({
          currentStateVersionId: updated.currentStateVersionId ?? null,
          currentStateGeneration: updated.currentStateGeneration,
          currentOutputId: updated.currentOutputId ?? null,
          status: updated.status,
          recordJson: updated,
          updatedAt: updated.updatedAt,
        })
        .where(eq(schema.capsules.id, updated.id)),
    ];
    // D1's atomic batch. The binding always exposes batch in production; when a
    // (test) binding omits it, fall back to the prior non-atomic sequence — the
    // same behavior as before this fix, never worse.
    if (typeof this.db.batch === "function") {
      try {
        await this.#orm.batch(
          statements as [(typeof statements)[number], ...typeof statements],
        );
      } catch (error) {
        if (isD1RunLeaseLostError(error)) {
          return { applyRunLeaseLost: true };
        }
        throw error;
      }
    } else {
      try {
        for (const statement of statements) await statement;
      } catch (error) {
        if (isD1RunLeaseLostError(error)) {
          return { applyRunLeaseLost: true };
        }
        throw error;
      }
    }
    return { capsule: updated };
  }

  async commitResourceRun(
    input: CommitResourceRunInput,
  ): Promise<CommitResourceRunResult> {
    await this.#ensureSchema();
    const row = await this.#orm
      .select({ leaseToken: schema.runs.leaseToken })
      .from(schema.runs)
      .where(
        and(
          eq(schema.runs.id, input.applyRunTerminal.id),
          inArray(schema.runs.type, [RUN_KIND_APPLY, "destroy_apply"]),
        ),
      )
      .get();
    if (row?.leaseToken !== input.applyRunLeaseToken) {
      return { applyRunLeaseLost: true };
    }
    const statements = [
      d1RunLeaseGuardStmt(
        this.#orm,
        input.applyRunTerminal.id,
        input.applyRunLeaseToken,
        [RUN_KIND_APPLY, "destroy_apply"],
      ),
      d1UpsertRunStmt(
        this.#orm,
        applyRunType(input.applyRunTerminal),
        input.applyRunTerminal,
      ),
      d1UpsertRunStmt(
        this.#orm,
        planRunType(input.planRunApplied),
        input.planRunApplied,
      ),
    ];
    try {
      if (typeof this.db.batch === "function") {
        await this.#orm.batch(
          statements as [(typeof statements)[number], ...typeof statements],
        );
      } else {
        for (const statement of statements) await statement;
      }
    } catch (error) {
      if (isD1RunLeaseLostError(error)) {
        return { applyRunLeaseLost: true };
      }
      throw error;
    }
    return {};
  }

  async commitRestoredState(
    input: CommitRestoredStateInput,
  ): Promise<CommitRestoredStateResult> {
    await this.#ensureSchema();
    const { capsulePatch } = input;
    const row = await this.#orm
      .select({ leaseToken: schema.runs.leaseToken })
      .from(schema.runs)
      .where(
        and(
          eq(schema.runs.id, input.restoreRunTerminal.id),
          eq(schema.runs.type, RUN_KIND_RESTORE),
        ),
      )
      .get();
    if (row?.leaseToken !== input.restoreRunLeaseToken) {
      return { restoreRunLeaseLost: true };
    }
    const current = await this.getCapsule(capsulePatch.id);
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
    const updated: Capsule = { ...current, ...capsulePatch.patch };
    const statements = [
      d1RunLeaseGuardStmt(
        this.#orm,
        input.restoreRunTerminal.id,
        input.restoreRunLeaseToken,
        [RUN_KIND_RESTORE],
      ),
      d1CapsuleStateGuardStmt(
        this.#orm,
        capsulePatch.id,
        guard.currentStateGeneration,
        guard.status,
      ),
      d1UpsertStateVersionStmt(this.#orm, input.stateVersion),
      d1UpsertRunStmt(this.#orm, RUN_KIND_RESTORE, input.restoreRunTerminal),
      this.#orm
        .update(schema.capsules)
        .set({
          currentStateVersionId: updated.currentStateVersionId ?? null,
          currentStateGeneration: updated.currentStateGeneration,
          currentOutputId: updated.currentOutputId ?? null,
          status: updated.status,
          recordJson: updated,
          updatedAt: updated.updatedAt,
        })
        .where(eq(schema.capsules.id, updated.id)),
    ];
    const runBatch = async (): Promise<void> => {
      if (typeof this.db.batch === "function") {
        await this.#orm.batch(
          statements as [(typeof statements)[number], ...typeof statements],
        );
        return;
      }
      for (const statement of statements) await statement;
    };
    try {
      await runBatch();
    } catch (error) {
      if (isD1RunLeaseLostError(error)) {
        return { restoreRunLeaseLost: true };
      }
      if (isD1CapsuleStateGuardError(error)) {
        const actual = await this.getCapsule(capsulePatch.id);
        if (!actual) return { capsule: undefined };
        throw new CapsuleStateGenerationGuardConflict({
          id: capsulePatch.id,
          expectedCurrentStateGeneration: guard.currentStateGeneration,
          actualCurrentStateGeneration: actual.currentStateGeneration,
          expectedStatus: guard.status,
          actualStatus: actual.status,
        });
      }
      throw error;
    }
    return { capsule: updated };
  }

  // -- ProviderConnection (+ sealed secret blob) --------------------------------------

  async putConnection(
    connection: ProviderConnection,
  ): Promise<ProviderConnection> {
    await this.#drizzleUpsert(schema.connections, {
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
    return await this.#drizzleFirstJson<ProviderConnection>(
      schema.connections,
      schema.connections.connectionJson,
      eq(schema.connections.id, id),
    );
  }

  async listConnections(
    workspaceId: string,
  ): Promise<readonly ProviderConnection[]> {
    return await this.#drizzleManyJson<ProviderConnection>(
      schema.connections,
      schema.connections.connectionJson,
      {
        where: eq(schema.connections.workspaceId, workspaceId),
        orderBy: [
          asc(schema.connections.createdAt),
          asc(schema.connections.id),
        ],
      },
    );
  }

  async listConnectionsPage(
    workspaceId: string,
    params: PageParams,
  ): Promise<Page<ProviderConnection>> {
    const limit = clampPageLimit(params.limit);
    const rows = await this.#drizzleManyJson<ProviderConnection>(
      schema.connections,
      schema.connections.connectionJson,
      {
        where: d1KeysetWhere(
          eq(schema.connections.workspaceId, workspaceId),
          schema.connections.createdAt,
          schema.connections.id,
          decodeCursor(params.cursor),
        ),
        orderBy: [
          asc(schema.connections.createdAt),
          asc(schema.connections.id),
        ],
        limit: limit + 1,
      },
    );
    return pageFromProbe(rows, limit);
  }

  async listOperatorConnections(): Promise<readonly ProviderConnection[]> {
    const rows = await this.#drizzleManyJson<ProviderConnection>(
      schema.connections,
      schema.connections.connectionJson,
      {
        where: isNull(schema.connections.workspaceId),
        orderBy: [
          asc(schema.connections.createdAt),
          asc(schema.connections.id),
        ],
      },
    );
    return rows.filter((row) => row.scope === "operator");
  }

  async deleteConnection(id: string): Promise<boolean> {
    return await this.#drizzleDelete(
      schema.connections,
      eq(schema.connections.id, id),
    );
  }

  async putSecretBlob(blob: StoredSecretBlob): Promise<StoredSecretBlob> {
    // Sealed ciphertext only; keyed by connection id and intentionally NOT on
    // any list path so the blob is never list-indexable.
    await this.#drizzleUpsert(
      schema.secretBlobs,
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
      schema.secretBlobs.connectionId,
    );
    return blob;
  }

  async getSecretBlob(
    connectionId: string,
  ): Promise<StoredSecretBlob | undefined> {
    return await this.#drizzleFirstJson<StoredSecretBlob>(
      schema.secretBlobs,
      schema.secretBlobs.blobJson,
      eq(schema.secretBlobs.connectionId, connectionId),
    );
  }

  async deleteSecretBlob(connectionId: string): Promise<boolean> {
    return await this.#drizzleDelete(
      schema.secretBlobs,
      eq(schema.secretBlobs.connectionId, connectionId),
    );
  }

  // -- Source (+ snapshots) ---------------------------------------------------

  async putSource(source: StoredSource): Promise<StoredSource> {
    await this.#drizzleUpsert(schema.sources, {
      id: source.id,
      workspaceId: source.workspaceId,
      status: source.status,
      recordJson: source,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
    });
    return source;
  }

  async getSource(id: string): Promise<StoredSource | undefined> {
    return await this.#drizzleFirstJson<StoredSource>(
      schema.sources,
      schema.sources.recordJson,
      eq(schema.sources.id, id),
    );
  }

  async listSources(workspaceId?: string): Promise<readonly StoredSource[]> {
    return await this.#drizzleManyJson<StoredSource>(
      schema.sources,
      schema.sources.recordJson,
      {
        where:
          workspaceId === undefined
            ? undefined
            : eq(schema.sources.workspaceId, workspaceId),
        orderBy: [asc(schema.sources.createdAt), asc(schema.sources.id)],
      },
    );
  }

  async listSourcesPage(
    workspaceId: string,
    params: PageParams,
  ): Promise<Page<StoredSource>> {
    const limit = clampPageLimit(params.limit);
    const rows = await this.#drizzleManyJson<StoredSource>(
      schema.sources,
      schema.sources.recordJson,
      {
        where: d1KeysetWhere(
          eq(schema.sources.workspaceId, workspaceId),
          schema.sources.createdAt,
          schema.sources.id,
          decodeCursor(params.cursor),
        ),
        orderBy: [asc(schema.sources.createdAt), asc(schema.sources.id)],
        limit: limit + 1,
      },
    );
    return pageFromProbe(rows, limit);
  }

  async deleteSource(id: string): Promise<boolean> {
    return await this.#drizzleDelete(schema.sources, eq(schema.sources.id, id));
  }

  async putSourceSnapshot(snapshot: SourceSnapshot): Promise<SourceSnapshot> {
    const normalized = normalizeSourceSnapshotRecord(snapshot);
    await this.#drizzleUpsert(schema.sourceSnapshots, {
      id: normalized.id,
      sourceId: normalized.sourceId,
      recordJson: normalized,
      fetchedAt: normalized.fetchedAt,
    });
    return normalized;
  }

  async getSourceSnapshot(id: string): Promise<SourceSnapshot | undefined> {
    return normalizeOptionalSourceSnapshotRecord(
      await this.#drizzleFirstJson<SourceSnapshot>(
        schema.sourceSnapshots,
        schema.sourceSnapshots.recordJson,
        eq(schema.sourceSnapshots.id, id),
      ),
    );
  }

  async listSourceSnapshots(
    sourceId: string,
  ): Promise<readonly SourceSnapshot[]> {
    return (
      await this.#drizzleManyJson<SourceSnapshot>(
        schema.sourceSnapshots,
        schema.sourceSnapshots.recordJson,
        {
          where: eq(schema.sourceSnapshots.sourceId, sourceId),
          orderBy: [
            asc(schema.sourceSnapshots.fetchedAt),
            asc(schema.sourceSnapshots.id),
          ],
        },
      )
    ).map(normalizeSourceSnapshotRecord);
  }

  async listSourceSnapshotsBySourceIds(
    sourceIds: readonly string[],
  ): Promise<readonly SourceSnapshot[]> {
    if (sourceIds.length === 0) return [];
    const rows: SourceSnapshot[] = [];
    for (const sourceIdChunk of d1InQueryChunks([...new Set(sourceIds)])) {
      rows.push(
        ...(await this.#drizzleManyJson<SourceSnapshot>(
          schema.sourceSnapshots,
          schema.sourceSnapshots.recordJson,
          {
            where: inArray(schema.sourceSnapshots.sourceId, [...sourceIdChunk]),
            orderBy: [
              asc(schema.sourceSnapshots.fetchedAt),
              asc(schema.sourceSnapshots.id),
            ],
          },
        )),
      );
    }
    return rows
      .map(normalizeSourceSnapshotRecord)
      .sort(
        (a, b) =>
          a.fetchedAt.localeCompare(b.fetchedAt) || a.id.localeCompare(b.id),
      );
  }

  async listSourceSnapshotsPage(
    sourceId: string,
    params: PageParams,
  ): Promise<Page<SourceSnapshot>> {
    const limit = clampPageLimit(params.limit);
    const rows = await this.#drizzleManyJson<SourceSnapshot>(
      schema.sourceSnapshots,
      schema.sourceSnapshots.recordJson,
      {
        where: d1KeysetWhere(
          eq(schema.sourceSnapshots.sourceId, sourceId),
          schema.sourceSnapshots.fetchedAt,
          schema.sourceSnapshots.id,
          decodeCursor(params.cursor),
        ),
        orderBy: [
          asc(schema.sourceSnapshots.fetchedAt),
          asc(schema.sourceSnapshots.id),
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
    await this.#drizzleUpsert(schema.capsuleCompatibilityReports, {
      id: normalized.id,
      sourceId: normalized.sourceId ?? null,
      capsuleId: normalized.capsuleId ?? null,
      sourceSnapshotId: normalized.sourceSnapshotId,
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
    await this.#ensureSchema();
    const rows = await this.#orm
      .select()
      .from(schema.capsuleCompatibilityReports)
      .where(eq(schema.capsuleCompatibilityReports.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      sourceId: compatibilityReportSourceId(row.sourceId),
      ...(row.capsuleId ? { capsuleId: row.capsuleId } : {}),
      sourceSnapshotId: row.sourceSnapshotId,
      level: normalizeStoredCapsuleCompatibilityLevel(row.level),
      findings: row.findingsJson as CapsuleCompatibilityReport["findings"],
      providers: row.providersJson as CapsuleCompatibilityReport["providers"],
      resources: row.resourcesJson as CapsuleCompatibilityReport["resources"],
      dataSources:
        row.dataSourcesJson as CapsuleCompatibilityReport["dataSources"],
      provisioners:
        row.provisionersJson as CapsuleCompatibilityReport["provisioners"],
      rootModuleVariables:
        row.rootModuleVariablesJson as CapsuleCompatibilityReport["rootModuleVariables"],
      rootModuleOutputs:
        row.rootModuleOutputsJson as CapsuleCompatibilityReport["rootModuleOutputs"],
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
    await this.#ensureSchema();
    const filters = [
      eq(schema.capsuleCompatibilityReports.sourceSnapshotId, sourceSnapshotId),
    ];
    if (options.sourceId) {
      filters.push(
        eq(schema.capsuleCompatibilityReports.sourceId, options.sourceId),
      );
    }
    if (options.capsuleId) {
      filters.push(
        or(
          isNull(schema.capsuleCompatibilityReports.capsuleId),
          eq(schema.capsuleCompatibilityReports.capsuleId, options.capsuleId),
        )!,
      );
    }
    const rows = await this.#orm
      .select()
      .from(schema.capsuleCompatibilityReports)
      .where(and(...filters))
      .orderBy(
        desc(schema.capsuleCompatibilityReports.createdAt),
        desc(schema.capsuleCompatibilityReports.id),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      sourceId: compatibilityReportSourceId(row.sourceId),
      ...(row.capsuleId ? { capsuleId: row.capsuleId } : {}),
      sourceSnapshotId: row.sourceSnapshotId,
      level: normalizeStoredCapsuleCompatibilityLevel(row.level),
      findings: row.findingsJson as CapsuleCompatibilityReport["findings"],
      providers: row.providersJson as CapsuleCompatibilityReport["providers"],
      resources: row.resourcesJson as CapsuleCompatibilityReport["resources"],
      dataSources:
        row.dataSourcesJson as CapsuleCompatibilityReport["dataSources"],
      provisioners:
        row.provisionersJson as CapsuleCompatibilityReport["provisioners"],
      rootModuleVariables:
        row.rootModuleVariablesJson as CapsuleCompatibilityReport["rootModuleVariables"],
      rootModuleOutputs:
        row.rootModuleOutputsJson as CapsuleCompatibilityReport["rootModuleOutputs"],
      createdAt: row.createdAt,
    };
  }

  // -- ProviderBindingSet ------------------------------------------------------

  async putProviderBindingSet(
    profile: ProviderBindingSet,
  ): Promise<ProviderBindingSet> {
    // One profile per (installation, environment): drop any stale row for the
    // same pair under a different id before upserting.
    await this.#ensureSchema();
    await this.#orm
      .delete(schema.providerBindingSets)
      .where(
        and(
          eq(schema.providerBindingSets.capsuleId, profile.capsuleId),
          eq(schema.providerBindingSets.environment, profile.environment),
        ),
      )
      .run();
    await this.#drizzleUpsert(schema.providerBindingSets, {
      id: profile.id,
      workspaceId: profile.workspaceId,
      capsuleId: profile.capsuleId,
      environment: profile.environment,
      recordJson: profile,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    });
    return profile;
  }

  async deleteProviderBindingSet(
    capsuleId: string,
    environment: string,
  ): Promise<void> {
    await this.#ensureSchema();
    await this.#orm
      .delete(schema.providerBindingSets)
      .where(
        and(
          eq(schema.providerBindingSets.capsuleId, capsuleId),
          eq(schema.providerBindingSets.environment, environment),
        ),
      )
      .run();
  }

  async getProviderBindingSetByCapsule(
    capsuleId: string,
    environment: string,
  ): Promise<ProviderBindingSet | undefined> {
    const rows = await this.#drizzleManyJson<ProviderBindingSet>(
      schema.providerBindingSets,
      schema.providerBindingSets.recordJson,
      {
        where: and(
          eq(schema.providerBindingSets.capsuleId, capsuleId),
          eq(schema.providerBindingSets.environment, environment),
        ),
        orderBy: [
          desc(schema.providerBindingSets.createdAt),
          desc(schema.providerBindingSets.id),
        ],
        limit: 1,
      },
    );
    return rows[0];
  }

  // -- StateVersion ----------------------------------------------------------

  async putStateVersion(snapshot: StateVersion): Promise<StateVersion> {
    await this.#drizzleUpsert(
      schema.stateVersions,
      {
        id: snapshot.id,
        workspaceId: snapshot.workspaceId,
        capsuleId: snapshot.capsuleId,
        environment: snapshot.environment,
        generation: snapshot.generation,
        stateRef: snapshot.stateRef,
        digest: snapshot.digest,
        createdByRunId: snapshot.createdByRunId,
        createdAt: snapshot.createdAt,
      },
      {
        id: snapshot.id,
        workspaceId: snapshot.workspaceId,
        stateRef: snapshot.stateRef,
        digest: snapshot.digest,
        createdByRunId: snapshot.createdByRunId,
        createdAt: snapshot.createdAt,
      },
      [
        schema.stateVersions.capsuleId,
        schema.stateVersions.environment,
        schema.stateVersions.generation,
      ],
    );
    return snapshot;
  }

  async getStateVersion(id: string): Promise<StateVersion | undefined> {
    await this.#ensureSchema();
    const row = await this.#orm
      .select()
      .from(schema.stateVersions)
      .where(eq(schema.stateVersions.id, id))
      .get();
    return row ? stateVersionFromDrizzleRow(row) : undefined;
  }

  async getLatestStateVersion(
    capsuleId: string,
    environment: string,
  ): Promise<StateVersion | undefined> {
    await this.#ensureSchema();
    const row = await this.#orm
      .select()
      .from(schema.stateVersions)
      .where(
        and(
          eq(schema.stateVersions.capsuleId, capsuleId),
          eq(schema.stateVersions.environment, environment),
        ),
      )
      .orderBy(desc(schema.stateVersions.generation))
      .limit(1)
      .get();
    return row ? stateVersionFromDrizzleRow(row) : undefined;
  }

  async listStateVersions(
    capsuleId: string,
    environment: string,
  ): Promise<readonly StateVersion[]> {
    await this.#ensureSchema();
    const rows = await this.#orm
      .select()
      .from(schema.stateVersions)
      .where(
        and(
          eq(schema.stateVersions.capsuleId, capsuleId),
          eq(schema.stateVersions.environment, environment),
        ),
      )
      .orderBy(asc(schema.stateVersions.generation));
    return rows.map(stateVersionFromDrizzleRow);
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
    await this.#ensureSchema();
    const rows = await this.#orm
      .select()
      .from(schema.stateVersions)
      .where(eq(schema.stateVersions.workspaceId, workspaceId))
      .orderBy(asc(schema.stateVersions.generation));
    return rows.map(stateVersionFromDrizzleRow);
  }

  // -- Dependency DAG (§14 / §15 / §27 installation_dependencies) --------------

  async putDependency(dependency: Dependency): Promise<Dependency> {
    await this.#drizzleUpsert(schema.dependencies, {
      id: dependency.id,
      workspaceId: dependency.workspaceId,
      producerCapsuleId: dependency.producerCapsuleId,
      consumerCapsuleId: dependency.consumerCapsuleId,
      recordJson: dependency,
      createdAt: dependency.createdAt,
    });
    return dependency;
  }

  async getDependency(id: string): Promise<Dependency | undefined> {
    return await this.#drizzleFirstJson<Dependency>(
      schema.dependencies,
      schema.dependencies.recordJson,
      eq(schema.dependencies.id, id),
    );
  }

  async listDependenciesByWorkspace(
    workspaceId: string,
  ): Promise<readonly Dependency[]> {
    return await this.#drizzleManyJson<Dependency>(
      schema.dependencies,
      schema.dependencies.recordJson,
      {
        where: eq(schema.dependencies.workspaceId, workspaceId),
        orderBy: [
          asc(schema.dependencies.createdAt),
          asc(schema.dependencies.id),
        ],
      },
    );
  }

  async listDependenciesForConsumer(
    consumerCapsuleId: string,
  ): Promise<readonly Dependency[]> {
    return await this.#drizzleManyJson<Dependency>(
      schema.dependencies,
      schema.dependencies.recordJson,
      {
        where: eq(schema.dependencies.consumerCapsuleId, consumerCapsuleId),
        orderBy: [
          asc(schema.dependencies.createdAt),
          asc(schema.dependencies.id),
        ],
      },
    );
  }

  async listDependenciesForProducer(
    producerCapsuleId: string,
  ): Promise<readonly Dependency[]> {
    return await this.#drizzleManyJson<Dependency>(
      schema.dependencies,
      schema.dependencies.recordJson,
      {
        where: eq(schema.dependencies.producerCapsuleId, producerCapsuleId),
        orderBy: [
          asc(schema.dependencies.createdAt),
          asc(schema.dependencies.id),
        ],
      },
    );
  }

  async deleteDependency(id: string): Promise<boolean> {
    return await this.#drizzleDelete(
      schema.dependencies,
      eq(schema.dependencies.id, id),
    );
  }

  // -- DependencySnapshot (§17 / §27 dependency_snapshots) ---------------------

  async putDependencySnapshot(
    snapshot: DependencySnapshot,
  ): Promise<DependencySnapshot> {
    await this.#drizzleUpsert(schema.dependencySnapshots, {
      id: snapshot.id,
      runId: snapshot.runId,
      recordJson: snapshot,
      createdAt: snapshot.createdAt,
    });
    return snapshot;
  }

  async getDependencySnapshot(
    id: string,
  ): Promise<DependencySnapshot | undefined> {
    return await this.#drizzleFirstJson<DependencySnapshot>(
      schema.dependencySnapshots,
      schema.dependencySnapshots.recordJson,
      eq(schema.dependencySnapshots.id, id),
    );
  }

  // -- Output (§16 / §27 output_snapshots) -----------------------------

  async putOutput(snapshot: Output): Promise<Output> {
    await this.#drizzleUpsert(schema.outputs, {
      id: snapshot.id,
      workspaceId: snapshot.workspaceId,
      capsuleId: snapshot.capsuleId,
      stateGeneration: snapshot.stateGeneration,
      recordJson: snapshot,
      createdAt: snapshot.createdAt,
    });
    return snapshot;
  }

  async getOutput(id: string): Promise<Output | undefined> {
    return await this.#drizzleFirstJson<Output>(
      schema.outputs,
      schema.outputs.recordJson,
      eq(schema.outputs.id, id),
    );
  }

  async getLatestOutput(capsuleId: string): Promise<Output | undefined> {
    const rows = await this.#drizzleManyJson<Output>(
      schema.outputs,
      schema.outputs.recordJson,
      {
        where: eq(schema.outputs.capsuleId, capsuleId),
        orderBy: [
          desc(schema.outputs.stateGeneration),
          desc(schema.outputs.createdAt),
          desc(schema.outputs.id),
        ],
        limit: 1,
      },
    );
    return rows[0];
  }

  async listOutputs(capsuleId: string): Promise<readonly Output[]> {
    return await this.#drizzleManyJson<Output>(
      schema.outputs,
      schema.outputs.recordJson,
      {
        where: eq(schema.outputs.capsuleId, capsuleId),
        orderBy: [
          schema.outputs.stateGeneration,
          schema.outputs.createdAt,
          schema.outputs.id,
        ],
      },
    );
  }

  async listOutputsByWorkspace(
    workspaceId: string,
  ): Promise<readonly Output[]> {
    return await this.#drizzleManyJson<Output>(
      schema.outputs,
      schema.outputs.recordJson,
      {
        where: eq(schema.outputs.workspaceId, workspaceId),
        orderBy: [
          schema.outputs.stateGeneration,
          schema.outputs.createdAt,
          schema.outputs.id,
        ],
      },
    );
  }

  // -- OutputShare (§18 / §27 output_shares) -----------------------------------

  async putOutputShare(share: OutputShare): Promise<OutputShare> {
    await this.#drizzleUpsert(schema.outputShares, {
      id: share.id,
      fromWorkspaceId: share.fromWorkspaceId,
      toWorkspaceId: share.toWorkspaceId,
      producerCapsuleId: share.producerCapsuleId,
      status: share.status,
      recordJson: share,
      createdAt: share.createdAt,
    });
    return share;
  }

  async getOutputShare(id: string): Promise<OutputShare | undefined> {
    return await this.#drizzleFirstJson<OutputShare>(
      schema.outputShares,
      schema.outputShares.recordJson,
      eq(schema.outputShares.id, id),
    );
  }

  async listOutputSharesFromWorkspace(
    fromWorkspaceId: string,
  ): Promise<readonly OutputShare[]> {
    return await this.#drizzleManyJson<OutputShare>(
      schema.outputShares,
      schema.outputShares.recordJson,
      {
        where: eq(schema.outputShares.fromWorkspaceId, fromWorkspaceId),
        orderBy: [
          asc(schema.outputShares.createdAt),
          asc(schema.outputShares.id),
        ],
      },
    );
  }

  async listOutputSharesToWorkspace(
    toWorkspaceId: string,
  ): Promise<readonly OutputShare[]> {
    return await this.#drizzleManyJson<OutputShare>(
      schema.outputShares,
      schema.outputShares.recordJson,
      {
        where: eq(schema.outputShares.toWorkspaceId, toWorkspaceId),
        orderBy: [
          asc(schema.outputShares.createdAt),
          asc(schema.outputShares.id),
        ],
      },
    );
  }

  // -- RunGroup (§19 / §24 / §27 run_groups) -----------------------------------

  async putRunGroup(group: RunGroup): Promise<RunGroup> {
    await this.#drizzleUpsert(schema.runGroups, {
      id: group.id,
      workspaceId: group.workspaceId,
      type: group.type,
      recordJson: group,
      createdAt: group.createdAt,
    });
    return group;
  }

  async getRunGroup(id: string): Promise<RunGroup | undefined> {
    return await this.#drizzleFirstJson<RunGroup>(
      schema.runGroups,
      schema.runGroups.recordJson,
      eq(schema.runGroups.id, id),
    );
  }

  async listRunGroups(workspaceId: string): Promise<readonly RunGroup[]> {
    return await this.#drizzleManyJson<RunGroup>(
      schema.runGroups,
      schema.runGroups.recordJson,
      {
        where: eq(schema.runGroups.workspaceId, workspaceId),
        orderBy: [asc(schema.runGroups.createdAt), asc(schema.runGroups.id)],
      },
    );
  }

  // -- Activity audit_events (§27 audit_events / §34 Activity) ------------------
  //
  // The §27 audit_events table keeps searchable columns (space_id / created_at)
  // for the Workspace-scoped Activity list; the full non-secret event round trips
  // through record_json. Listing is newest-first with a clamped limit.

  async putActivityEvent(event: ActivityEvent): Promise<ActivityEvent> {
    await this.#drizzleUpsert(schema.auditEvents, {
      id: event.id,
      workspaceId: event.workspaceId,
      actorId: event.actorId ?? null,
      action: event.action,
      targetType: event.targetType,
      targetId: event.targetId,
      runId: event.runId ?? null,
      recordJson: event,
      createdAt: event.createdAt,
    });
    return event;
  }

  async listActivityEvents(
    workspaceId: string,
    options: { readonly limit?: number } = {},
  ): Promise<readonly ActivityEvent[]> {
    const limit = clampActivityLimit(options.limit);
    return await this.#drizzleManyJson<ActivityEvent>(
      schema.auditEvents,
      schema.auditEvents.recordJson,
      {
        where: eq(schema.auditEvents.workspaceId, workspaceId),
        orderBy: [
          desc(schema.auditEvents.createdAt),
          desc(schema.auditEvents.id),
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
    const rows = await this.#drizzleManyJson<ActivityEvent>(
      schema.auditEvents,
      schema.auditEvents.recordJson,
      {
        where: d1KeysetWhereDesc(
          and(
            eq(schema.auditEvents.workspaceId, workspaceId),
            eq(schema.auditEvents.targetType, targetType),
            eq(schema.auditEvents.targetId, targetId),
          ),
          schema.auditEvents.createdAt,
          schema.auditEvents.id,
          cursor,
        ),
        orderBy: [
          desc(schema.auditEvents.createdAt),
          desc(schema.auditEvents.id),
        ],
        limit: limit + 1,
      },
    );
    return pageFromProbe(rows, limit);
  }

  // -- credential_mint_events (spec invariant 17) -----------------------------

  async putCredentialMintEvent(
    event: CredentialMintEvent,
  ): Promise<CredentialMintEvent> {
    await this.#drizzleUpsert(schema.credentialMintEvents, {
      id: event.id,
      runId: event.runId,
      // Physical columns space_id / installation_id are frozen; the contract
      // type renamed to workspaceId / capsuleId.
      workspaceId: event.workspaceId,
      capsuleId: event.capsuleId,
      sourceId: event.sourceId,
      connectionId: event.connectionId ?? "",
      phase: event.phase,
      recordJson: event,
      createdAt: event.createdAt,
    });
    return event;
  }

  async listCredentialMintEventsForRun(
    runId: string,
  ): Promise<readonly CredentialMintEvent[]> {
    return await this.#drizzleManyJson<CredentialMintEvent>(
      schema.credentialMintEvents,
      schema.credentialMintEvents.recordJson,
      {
        where: eq(schema.credentialMintEvents.runId, runId),
        orderBy: [
          asc(schema.credentialMintEvents.createdAt),
          asc(schema.credentialMintEvents.id),
        ],
      },
    );
  }

  // -- security_findings ------------------------------------------------------

  async putSecurityFinding(finding: SecurityFinding): Promise<SecurityFinding> {
    await this.#drizzleUpsert(schema.securityFindings, {
      id: finding.id,
      // Physical columns space_id / installation_id are frozen; the contract
      // type renamed to workspaceId / capsuleId.
      workspaceId: finding.workspaceId,
      capsuleId: finding.capsuleId ?? null,
      runId: finding.runId ?? null,
      severity: finding.severity,
      type: finding.type,
      recordJson: finding,
      createdAt: finding.createdAt,
    });
    return finding;
  }

  async listSecurityFindings(
    workspaceId: string,
    options: { readonly runId?: string; readonly limit?: number } = {},
  ): Promise<readonly SecurityFinding[]> {
    const limit = clampActivityLimit(options.limit);
    return await this.#drizzleManyJson<SecurityFinding>(
      schema.securityFindings,
      schema.securityFindings.recordJson,
      {
        where:
          options.runId === undefined
            ? eq(schema.securityFindings.workspaceId, workspaceId)
            : and(
                eq(schema.securityFindings.workspaceId, workspaceId),
                eq(schema.securityFindings.runId, options.runId),
              ),
        orderBy: [
          desc(schema.securityFindings.createdAt),
          desc(schema.securityFindings.id),
        ],
        limit,
      },
    );
  }

  // -- usage ledger -----------------------------------------------------------

  async putUsageEvent(event: UsageEvent): Promise<UsageEvent> {
    usageEventUsdMicros(event);
    const existing = await this.#usageEventByIdempotencyKey(
      event.idempotencyKey,
    );
    if (existing) return existing;
    await this.#ensureSchema();
    try {
      await this.#orm
        .insert(schema.usageEvents)
        .values({
          id: event.id,
          workspaceId: event.workspaceId,
          capsuleId: event.capsuleId ?? null,
          runId: event.runId ?? null,
          meterId: event.meterId ?? null,
          resourceFamily: event.resourceFamily ?? null,
          resourceId: event.resourceId ?? null,
          operation: event.operation ?? null,
          resourceMetadataJson: event.resourceMetadata ?? null,
          kind: event.kind,
          quantity: event.quantity,
          usdMicros: event.usdMicros,
          ratingStatus: event.ratingStatus,
          source: event.source,
          idempotencyKey: event.idempotencyKey,
          createdAt: event.createdAt,
        })
        .run();
    } catch (error) {
      const raced = await this.#usageEventByIdempotencyKey(
        event.idempotencyKey,
      );
      if (raced && isD1UsageEventIdempotencyError(error)) return raced;
      throw error;
    }
    return event;
  }

  async listUsageEvents(workspaceId: string): Promise<readonly UsageEvent[]> {
    await this.#ensureSchema();
    const rows = await this.#orm
      .select()
      .from(schema.usageEvents)
      .where(eq(schema.usageEvents.workspaceId, workspaceId))
      .orderBy(asc(schema.usageEvents.createdAt), asc(schema.usageEvents.id));
    return rows.map(usageEventFromRow);
  }

  async listUsageEventsPage(
    workspaceId: string,
    params: PageParams,
  ): Promise<Page<UsageEvent>> {
    await this.#ensureSchema();
    const limit = clampPageLimit(params.limit);
    const rows = await this.#orm
      .select()
      .from(schema.usageEvents)
      .where(
        d1KeysetWhereDesc(
          eq(schema.usageEvents.workspaceId, workspaceId),
          schema.usageEvents.createdAt,
          schema.usageEvents.id,
          decodeCursor(params.cursor),
        ),
      )
      .orderBy(desc(schema.usageEvents.createdAt), desc(schema.usageEvents.id))
      .limit(limit + 1);
    return pageFromProbe(rows.map(usageEventFromRow), limit);
  }

  async #usageEventByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<UsageEvent | undefined> {
    await this.#ensureSchema();
    const row = await this.#orm
      .select()
      .from(schema.usageEvents)
      .where(eq(schema.usageEvents.idempotencyKey, idempotencyKey))
      .get();
    return row ? usageEventFromRow(row) : undefined;
  }

  // -- backups (§33 layer 1 / §26 R2_BACKUPS) ----------------------------------
  //
  // One pointer row per sealed control-backup bundle written to R2_BACKUPS. The
  // bundle bytes live in object storage; only the pointer round trips through
  // record_json. Listing is newest-first (created_at desc, id desc).

  async putBackupRecord(record: BackupRecord): Promise<BackupRecord> {
    await this.#drizzleUpsert(schema.backups, {
      id: record.id,
      workspaceId: record.workspaceId,
      capsuleId: record.capsuleId ?? null,
      environment: record.environment ?? null,
      createdByRunId: record.createdByRunId,
      recordJson: record,
      createdAt: record.createdAt,
    });
    return record;
  }

  async getBackupRecord(id: string): Promise<BackupRecord | undefined> {
    return await this.#drizzleFirstJson<BackupRecord>(
      schema.backups,
      schema.backups.recordJson,
      eq(schema.backups.id, id),
    );
  }

  async listBackupRecords(
    workspaceId: string,
  ): Promise<readonly BackupRecord[]> {
    return await this.#drizzleManyJson<BackupRecord>(
      schema.backups,
      schema.backups.recordJson,
      {
        where: eq(schema.backups.workspaceId, workspaceId),
        orderBy: [desc(schema.backups.createdAt), desc(schema.backups.id)],
      },
    );
  }

  async listBackupRecordsPage(
    workspaceId: string,
    params: PageParams,
  ): Promise<Page<BackupRecord>> {
    const limit = clampPageLimit(params.limit);
    // Newest-first listing ⇒ descending keyset.
    const rows = await this.#drizzleManyJson<BackupRecord>(
      schema.backups,
      schema.backups.recordJson,
      {
        where: d1KeysetWhereDesc(
          eq(schema.backups.workspaceId, workspaceId),
          schema.backups.createdAt,
          schema.backups.id,
          decodeCursor(params.cursor),
        ),
        orderBy: [desc(schema.backups.createdAt), desc(schema.backups.id)],
        limit: limit + 1,
      },
    );
    return pageFromProbe(rows, limit);
  }

  // -- shared D1 helpers ------------------------------------------------------

  async #putRun(row: {
    readonly id: string;
    readonly runGroupId: string | null;
    readonly workspaceId: string;
    readonly sourceId?: string | null;
    readonly capsuleId: string | null;
    readonly environment: string | null;
    readonly type: string;
    readonly status: string;
    readonly runJson: string;
  }): Promise<void> {
    // The §27 `runs` table physically stores PlanRun / ApplyRun / SourceSyncRun
    // rows discriminated by `type`; the full internal record lives in `run_json`.
    // created_at is the internal record's createdAt (epoch number for plan/apply
    // runs, ISO string for source_sync) — stored verbatim so the typed get round
    // trips, and used only for stable list ordering.
    const parsed = JSON.parse(row.runJson) as {
      readonly createdAt?: number | string;
      readonly leaseToken?: string | null;
      readonly heartbeatAt?: number | null;
    };
    const createdAt = parsed.createdAt ?? 0;
    await this.#drizzleUpsert(schema.runs, {
      id: row.id,
      runGroupId: row.runGroupId,
      workspaceId: row.workspaceId,
      sourceId: row.sourceId ?? null,
      capsuleId: row.capsuleId,
      environment: row.environment,
      type: row.type,
      status: row.status,
      leaseToken: parsed.leaseToken ?? null,
      heartbeatAt: parsed.heartbeatAt ?? null,
      runJson: parsed as unknown,
      createdAt: String(createdAt),
    });
  }

  // Drizzle's `.insert(table).values(...)` demands a per-table insert model, so
  // the table/values stay `any` here; the conflict target is the table's `id`
  // column (or an explicit override) and rides through untyped with them. The
  // read helpers below take the concrete `SQLiteTable` / `SQLiteColumn` types.
  async #drizzleUpsert(
    table: any,
    values: Record<string, unknown>,
    set: Record<string, unknown> = values,
    target = table.id,
  ): Promise<void> {
    await this.#ensureSchema();
    await this.#orm
      .insert(table)
      .values(values)
      .onConflictDoUpdate({ target, set })
      .run();
  }

  async #drizzleDelete(
    table: SQLiteTable,
    where: SQL | undefined,
  ): Promise<boolean> {
    await this.#ensureSchema();
    const result = await this.#orm.delete(table).where(where).run();
    return changes(result as D1Result) > 0;
  }

  async #drizzleFirstJson<T>(
    table: SQLiteTable,
    jsonColumn: SQLiteColumn,
    where: SQL | undefined,
  ): Promise<T | undefined> {
    await this.#ensureSchema();
    const row = await this.#orm
      .select({ value: jsonColumn })
      .from(table)
      .where(where)
      .get();
    return row?.value as T | undefined;
  }

  async #drizzleManyJson<T>(
    table: SQLiteTable,
    jsonColumn: SQLiteColumn,
    input: {
      readonly where?: SQL | undefined;
      readonly orderBy?: readonly (SQL | SQLiteColumn)[];
      readonly limit?: number;
    } = {},
  ): Promise<readonly T[]> {
    await this.#ensureSchema();
    let query = this.#orm.select({ value: jsonColumn }).from(table).$dynamic();
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
    return rows.map((row) => row.value as T);
  }

  async #getRun<T>(
    id: string,
    types: readonly string[],
  ): Promise<T | undefined> {
    await this.#ensureSchema();
    const row = await this.#orm
      .select({ runJson: schema.runs.runJson })
      .from(schema.runs)
      .where(and(eq(schema.runs.id, id), inArray(schema.runs.type, [...types])))
      .get();
    return row?.runJson as T | undefined;
  }

  async #ensureSchema(): Promise<void> {
    // This is deliberately outside the memoized schema check: an operator can
    // acquire the maintenance fence after an isolate has warmed. Every store
    // operation must therefore re-check the durable fence before it issues a
    // read or write, so no request can race a destructive predeploy rebuild.
    await assertControlD1MaintenanceInactive(this.db);
    // Serialize concurrent callers onto the one in-flight bootstrap, but never
    // cache a REJECTED promise: a transient failure (e.g. a contended DDL) would
    // otherwise poison the isolate so every later method rejects forever. On
    // failure, clear the memo so the next call retries; on success, the resolved
    // promise stays cached and bootstrap runs exactly once.
    if (this.#initialized === undefined) {
      const attempt = (
        this.#schemaMode === "predeployed"
          ? verifyD1OpenTofuLedgerSchemaPredeployed(this.db)
          : ensureD1OpenTofuLedgerSchema(this.db)
      ).catch((error: unknown) => {
        if (this.#initialized === attempt) this.#initialized = undefined;
        throw error;
      });
      this.#initialized = attempt;
    }
    await this.#initialized;
  }
}

export function createCloudflareD1OpenTofuControlStore(
  db: D1Database,
  options: {
    readonly schemaMode?: D1OpenTofuControlSchemaMode;
  } = {},
): OpenTofuControlStore {
  return new CloudflareD1OpenTofuControlStore(db, options);
}

// -- atomic-commit statement builders ------------------------------------------
//
// These return the UNAWAITED drizzle insert builders the atomic
// commitRunState batch feeds to this.#orm.batch(...). The column
// payloads mirror the #drizzleUpsert calls in
// put{StateVersion,Output} exactly so a record written
// through the atomic batch is byte-for-byte identical to one written through the
// individual put* path.

/**
 * Batch-able §27 `runs` upsert (the commit-tail fold helper). Mirrors the
 * `#putRun` column payload so a run written through the atomic batch is
 * identical to one written through `putPlanRun` / `putApplyRun`. Both rows fed
 * to this helper are TERMINAL (the succeeded ApplyRun and the apply-once PlanRun
 * marker), so the lease fence is always nulled — the fold never re-stamps a live
 * lease.
 */
function d1UpsertRunStmt(
  orm: DrizzleD1Database<typeof schema>,
  type: string,
  run: PlanRun | ApplyRun | Run,
) {
  const generic = run as Partial<Run>;
  const values = {
    id: run.id,
    runGroupId: generic.runGroupId ?? null,
    workspaceId: run.workspaceId,
    sourceId: generic.sourceId ?? null,
    capsuleId: run.capsuleId ?? null,
    environment: generic.environment ?? null,
    type,
    status: run.status,
    leaseToken: null,
    heartbeatAt: run.heartbeatAt ?? null,
    runJson: run as unknown,
    createdAt: String(run.createdAt),
  };
  return orm
    .insert(schema.runs)
    .values(values)
    .onConflictDoUpdate({ target: schema.runs.id, set: values });
}

function d1RunLeaseGuardStmt(
  orm: DrizzleD1Database<typeof schema>,
  runId: string,
  leaseToken: string,
  types: readonly string[],
) {
  const expectedLease = orm
    .select({ one: sql`1` })
    .from(schema.runs)
    .where(
      and(
        eq(schema.runs.id, runId),
        inArray(schema.runs.type, [...types]),
        eq(schema.runs.status, "running"),
        eq(schema.runs.leaseToken, leaseToken),
      ),
    );
  return orm.insert(schema.runs).select(
    orm
      .select({
        id: schema.runs.id,
        runGroupId: schema.runs.runGroupId,
        workspaceId: schema.runs.workspaceId,
        sourceId: schema.runs.sourceId,
        capsuleId: schema.runs.capsuleId,
        environment: schema.runs.environment,
        type: schema.runs.type,
        status: schema.runs.status,
        leaseToken: schema.runs.leaseToken,
        heartbeatAt: schema.runs.heartbeatAt,
        runJson: schema.runs.runJson,
        createdAt: schema.runs.createdAt,
      })
      .from(schema.runs)
      .where(and(eq(schema.runs.id, runId), notExists(expectedLease))),
  );
}

function d1CapsuleStateGuardStmt(
  orm: DrizzleD1Database<typeof schema>,
  capsuleId: string,
  currentStateGeneration: number,
  status: Capsule["status"] | undefined,
) {
  const expected = orm
    .select({ one: sql`1` })
    .from(schema.capsules)
    .where(
      and(
        eq(schema.capsules.id, capsuleId),
        eq(schema.capsules.currentStateGeneration, currentStateGeneration),
        status === undefined ? undefined : eq(schema.capsules.status, status),
      ),
    );
  return orm.insert(schema.capsules).select(
    orm
      .select({
        id: schema.capsules.id,
        workspaceId: schema.capsules.workspaceId,
        projectId: schema.capsules.projectId,
        name: schema.capsules.name,
        slug: schema.capsules.slug,
        sourceId: schema.capsules.sourceId,
        installConfigId: schema.capsules.installConfigId,
        environment: schema.capsules.environment,
        currentStateVersionId: schema.capsules.currentStateVersionId,
        currentStateGeneration: schema.capsules.currentStateGeneration,
        currentOutputId: schema.capsules.currentOutputId,
        status: schema.capsules.status,
        recordJson: schema.capsules.recordJson,
        createdAt: schema.capsules.createdAt,
        updatedAt: schema.capsules.updatedAt,
      })
      .from(schema.capsules)
      .where(and(eq(schema.capsules.id, capsuleId), notExists(expected))),
  );
}

function isD1RunLeaseLostError(error: unknown): boolean {
  return error instanceof Error
    ? error.message.includes("UNIQUE constraint failed: runs.id") ||
        error.message.includes("constraint failed: runs.id")
    : false;
}

function isD1CapsuleStateGuardError(error: unknown): boolean {
  // The conflicting-insert guard (see d1CapsuleStateGuardStmt) trips the
  // canonical `capsules.id` primary-key constraint. Schema migrations run
  // before this path, so an unrenamed pre-v1 table is never runtime authority.
  return error instanceof Error
    ? error.message.includes("UNIQUE constraint failed: capsules.id") ||
        error.message.includes("constraint failed: capsules.id")
    : false;
}

function isD1UsageEventIdempotencyError(error: unknown): boolean {
  return error instanceof Error
    ? error.message.includes(
        "UNIQUE constraint failed: usage_events.idempotency_key",
      ) ||
        error.message.includes(
          "constraint failed: usage_events.idempotency_key",
        )
    : false;
}

function d1UpsertStateVersionStmt(
  orm: DrizzleD1Database<typeof schema>,
  snapshot: StateVersion,
) {
  return orm
    .insert(schema.stateVersions)
    .values({
      id: snapshot.id,
      workspaceId: snapshot.workspaceId,
      capsuleId: snapshot.capsuleId,
      environment: snapshot.environment,
      generation: snapshot.generation,
      stateRef: snapshot.stateRef,
      digest: snapshot.digest,
      createdByRunId: snapshot.createdByRunId,
      createdAt: snapshot.createdAt,
    })
    .onConflictDoUpdate({
      target: [
        schema.stateVersions.capsuleId,
        schema.stateVersions.environment,
        schema.stateVersions.generation,
      ],
      set: {
        id: snapshot.id,
        workspaceId: snapshot.workspaceId,
        stateRef: snapshot.stateRef,
        digest: snapshot.digest,
        createdByRunId: snapshot.createdByRunId,
        createdAt: snapshot.createdAt,
      },
    });
}

function d1UpsertOutputStmt(
  orm: DrizzleD1Database<typeof schema>,
  snapshot: Output,
) {
  const values = {
    id: snapshot.id,
    workspaceId: snapshot.workspaceId,
    capsuleId: snapshot.capsuleId,
    stateGeneration: snapshot.stateGeneration,
    recordJson: snapshot,
    createdAt: snapshot.createdAt,
  };
  return orm
    .insert(schema.outputs)
    .values(values)
    .onConflictDoUpdate({ target: schema.outputs.id, set: values });
}

function stripRunHeartbeat<R extends PlanRun | ApplyRun | SourceSyncRun | Run>(
  run: R,
): R {
  const { heartbeatAt, ...withoutHeartbeat } = run;
  void heartbeatAt;
  return withoutHeartbeat as R;
}

// -- run-kind discriminators ---------------------------------------------------

function planRunType(run: PlanRun): string {
  if (run.driftCheck === true) return "drift_check";
  return run.operation === "destroy" ? "destroy_plan" : RUN_KIND_PLAN;
}

function applyRunType(run: ApplyRun): string {
  return run.operation === "destroy" ? "destroy_apply" : RUN_KIND_APPLY;
}

function jsonRecordFromD1Value(value: unknown): Record<string, unknown> {
  const parsed =
    typeof value === "string" && value.trim().length > 0
      ? parseD1JsonColumn(value)
      : value;
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function parseD1JsonColumn(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function stateVersionFromDrizzleRow(row: {
  readonly id: string;
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly environment: string;
  readonly generation: number;
  readonly stateRef: string;
  readonly digest: string;
  readonly createdByRunId: string;
  readonly createdAt: string;
}): StateVersion {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    capsuleId: row.capsuleId,
    environment: row.environment,
    generation: row.generation,
    stateRef: row.stateRef,
    digest: row.digest,
    createdByRunId: row.createdByRunId,
    createdAt: row.createdAt,
  };
}

function changes(result: D1Result): number {
  return result.meta?.changes ?? 0;
}

const D1_SERVICE_FORM_REGISTRY_STATEMENTS = [
  `create table if not exists service_form_packages (
    package_digest text primary key,
    status text not null check (status in ('installed','deprecated','revoked')),
    record_json text not null,
    installed_at text not null,
    updated_at text not null
  )`,
  `create index if not exists service_form_packages_status_updated_digest_idx
    on service_form_packages (status, updated_at, package_digest)`,
  `create table if not exists service_form_definitions (
    form_ref_key text primary key,
    package_digest text not null,
    api_version text not null,
    kind text not null,
    definition_version text not null,
    schema_digest text not null,
    record_json text not null,
    installed_at text not null,
    foreign key (package_digest) references service_form_packages(package_digest)
  )`,
  `create index if not exists service_form_definitions_package_idx
    on service_form_definitions (package_digest)`,
  `create unique index if not exists service_form_definitions_ref_package_unique
    on service_form_definitions (form_ref_key, package_digest)`,
  `create index if not exists service_form_definitions_kind_installed_ref_idx
    on service_form_definitions (kind, installed_at, form_ref_key)`,
  `create table if not exists service_form_activations (
    id text primary key,
    form_ref_key text not null,
    package_digest text not null,
    scope_type text not null check (scope_type in ('operator','workspace','space')),
    scope_id text,
    status text not null check (status in ('active','inactive')),
    revision integer not null check (revision >= 1),
    record_json text not null,
    created_at text not null,
    updated_at text not null,
    foreign key (form_ref_key, package_digest)
      references service_form_definitions(form_ref_key, package_digest),
    check (
      (scope_type = 'operator' and scope_id is null)
      or (scope_type in ('workspace','space') and length(trim(scope_id)) > 0)
    )
  )`,
  `create index if not exists service_form_activations_scope_status_updated_id_idx
    on service_form_activations (scope_type, scope_id, status, updated_at, id)`,
  `create index if not exists service_form_activations_identity_idx
    on service_form_activations (form_ref_key, package_digest)`,
] as const;

/**
 * Bootstrap the §27 control-plane tables for the default self-host mode.
 * Idempotent (`IF NOT EXISTS`) and called once per store instance via the
 * memoized init promise. Hosts using `predeployed` mode call the strict
 * read-only ledger verifier instead. Rich internal
 * records (runner profiles, runs, install configs, connections, sources,
 * snapshots, Provider Binding sets, Workspaces, and provider resolution
 * records) keep a `record_json` / `run_json` TEXT column carrying the full
 * contract shape alongside indexed columns. `runs_inputs` is the internal PlanRun
 * inputs sidecar (never projected); `secret_blobs` holds sealed ciphertext only.
 */
export async function ensureD1OpenTofuLedgerSchema(
  db: D1Database,
): Promise<void> {
  const statements = [
    `create table if not exists workspaces (
      id text primary key,
      handle text not null,
      record_json text not null,
      created_at text not null,
      updated_at text not null
    )`,
    `create unique index if not exists workspaces_handle_unique
      on workspaces (handle)`,
    `create table if not exists workspace_members (
      id text primary key,
      workspace_id text not null,
      account_id text not null,
      status text not null,
      record_json text not null,
      created_at text not null,
      updated_at text not null
    )`,
    `create unique index if not exists workspace_members_workspace_account_unique
      on workspace_members (workspace_id, account_id)`,
    `create index if not exists workspace_members_workspace_status_idx
      on workspace_members (workspace_id, status)`,
    `create index if not exists workspace_members_account_status_idx
      on workspace_members (account_id, status)`,
    `create table if not exists projects (
      id text primary key,
      workspace_id text not null,
      name text not null,
      slug text not null,
      record_json text not null,
      created_at text not null,
      updated_at text not null
    )`,
    `create unique index if not exists projects_workspace_slug_unique
      on projects (workspace_id, slug)`,
    `create index if not exists projects_workspace_idx
      on projects (workspace_id)`,
    `create table if not exists sources (
      id text primary key,
      space_id text not null,
      status text not null,
      record_json text not null,
      created_at text not null,
      updated_at text not null
    )`,
    `create index if not exists sources_space_idx
      on sources (space_id)`,
    `create index if not exists sources_status_idx
      on sources (status)`,
    `create table if not exists source_snapshots (
      id text primary key,
      source_id text,
      record_json text not null,
      fetched_at text not null
    )`,
    `create index if not exists source_snapshots_source_idx
      on source_snapshots (source_id)`,
    `create table if not exists connections (
      id text primary key,
      space_id text,
      provider text not null,
      status text not null,
      connection_json text not null,
      created_at text not null,
      updated_at text not null
    )`,
    `create index if not exists connections_space_idx
      on connections (space_id)`,
    `create index if not exists connections_provider_idx
      on connections (provider)`,
    `create index if not exists connections_status_idx
      on connections (status)`,
    `create table if not exists secret_blobs (
      id text primary key,
      connection_id text not null,
      space_id text,
      kind text not null,
      ciphertext text not null,
      encrypted_dek text not null,
      nonce text not null,
      aad text not null,
      key_version integer not null,
      created_at text not null,
      rotated_at text,
      blob_json text not null
    )`,
    `create unique index if not exists secret_blobs_connection_idx
      on secret_blobs (connection_id)`,
    `create table if not exists install_configs (
      id text primary key,
      space_id text,
      record_json text not null,
      created_at text not null,
      updated_at text not null
    )`,
    `create index if not exists install_configs_space_idx
      on install_configs (space_id)`,
    `create table if not exists capsules (
      id text primary key,
      space_id text not null,
      project_id text,
      name text not null,
      slug text not null,
      source_id text,
      install_type text not null,
      install_config_id text not null,
      environment text not null,
      current_state_version_id text,
      current_state_generation integer not null default 0,
      current_output_snapshot_id text,
      status text not null,
      record_json text not null,
      created_at text not null,
      updated_at text not null
    )`,
    `drop index if exists capsules_space_name_environment_unique`,
    `drop index if exists installations_space_name_environment_unique`,
    `create unique index if not exists capsules_project_name_environment_active_unique
      on capsules (project_id, name, environment)
      where status != 'destroyed'`,
    `create index if not exists capsules_space_idx
      on capsules (space_id)`,
    `create index if not exists capsules_project_idx
      on capsules (project_id)`,
    `create index if not exists capsules_current_state_version_idx
      on capsules (current_state_version_id)`,
    `create table if not exists capsule_compatibility_reports (
      id text primary key,
      source_id text,
      installation_id text,
      source_snapshot_id text not null,
      level text not null,
      findings_json text not null,
      providers_json text not null,
      resources_json text not null,
      data_sources_json text not null,
      provisioners_json text not null,
      root_module_variables_json text not null default '[]',
      root_module_outputs_json text not null default '[]',
      created_at text not null
    )`,
    `create index if not exists capsule_compatibility_reports_source_snapshot_idx
      on capsule_compatibility_reports (source_snapshot_id)`,
    `create index if not exists capsule_compatibility_reports_source_idx
      on capsule_compatibility_reports (source_id)`,
    `create index if not exists capsule_compatibility_reports_installation_idx
      on capsule_compatibility_reports (installation_id)`,
    `create index if not exists capsule_compatibility_reports_level_idx
      on capsule_compatibility_reports (level)`,
    `create table if not exists provider_env_binding_sets (
      id text primary key,
      space_id text not null,
      installation_id text not null,
      environment text not null,
      record_json text not null,
      created_at text not null,
      updated_at text not null
    )`,
    `create unique index if not exists provider_env_binding_sets_installation_environment_unique
      on provider_env_binding_sets (installation_id, environment)`,
    `create index if not exists provider_env_binding_sets_installation_idx
      on provider_env_binding_sets (installation_id)`,
    `create table if not exists runs (
      id text primary key,
      run_group_id text,
      space_id text not null,
      source_id text,
      installation_id text,
      environment text,
      type text not null,
      status text not null,
      lease_token text,
      heartbeat_at integer,
      run_json text not null,
      created_at text not null default ""
    )`,
    `create index if not exists runs_space_idx
      on runs (space_id)`,
    `create index if not exists runs_source_idx
      on runs (source_id)`,
    `create index if not exists runs_installation_idx
      on runs (installation_id)`,
    `create index if not exists runs_installation_created_at_idx
      on runs (installation_id, created_at)`,
    `create index if not exists runs_type_idx
      on runs (type)`,
    `create index if not exists runs_created_at_idx
      on runs (created_at)`,
    `create table if not exists runs_inputs (
      plan_run_id text primary key,
      inputs_json text not null
    )`,
    `create table if not exists state_versions (
      id text primary key,
      space_id text not null,
      installation_id text not null,
      environment text not null,
      generation integer not null,
      object_key text not null,
      digest text not null,
      created_by_run_id text not null,
      created_at text not null
    )`,
    `create unique index if not exists state_versions_installation_environment_generation_unique
      on state_versions (installation_id, environment, generation)`,
    `create index if not exists state_versions_installation_idx
      on state_versions (installation_id)`,
    `create table if not exists deployments (
      id text primary key,
      space_id text not null,
      installation_id text not null,
      environment text not null,
      apply_run_id text not null,
      source_snapshot_id text not null,
      dependency_snapshot_id text,
      state_generation integer not null,
      output_snapshot_id text not null,
      outputs_public_json text not null,
      status text not null,
      created_at text not null
    )`,
    `create index if not exists deployments_space_idx
      on deployments (space_id)`,
    `create index if not exists deployments_installation_idx
      on deployments (installation_id)`,
    `create index if not exists deployments_apply_idx
      on deployments (apply_run_id)`,
    `create table if not exists artifacts (
      id text primary key,
      run_id text not null,
      kind text not null,
      object_key text not null,
      digest text not null,
      size_bytes integer not null,
      created_at text not null
    )`,
    `create index if not exists artifacts_run_idx
      on artifacts (run_id)`,
    `create table if not exists runner_profiles (
      id text primary key,
      record_json text not null,
      created_at text not null
    )`,
    `create table if not exists installation_dependencies (
      id text primary key,
      space_id text not null,
      producer_installation_id text not null,
      consumer_installation_id text not null,
      record_json text not null,
      created_at text not null
    )`,
    `create index if not exists installation_dependencies_space_idx
      on installation_dependencies (space_id)`,
    `create index if not exists installation_dependencies_consumer_idx
      on installation_dependencies (consumer_installation_id)`,
    `create index if not exists installation_dependencies_producer_idx
      on installation_dependencies (producer_installation_id)`,
    `create table if not exists dependency_snapshots (
      id text primary key,
      run_id text not null,
      record_json text not null,
      created_at text not null
    )`,
    `create index if not exists dependency_snapshots_run_idx
      on dependency_snapshots (run_id)`,
    `create table if not exists outputs (
      id text primary key,
      space_id text not null,
      installation_id text not null,
      state_generation integer not null,
      record_json text not null,
      created_at text not null
    )`,
    `create index if not exists outputs_installation_idx
      on outputs (installation_id)`,
    `create table if not exists output_shares (
      id text primary key,
      from_space_id text not null,
      to_space_id text not null,
      producer_installation_id text not null,
      status text not null,
      record_json text not null,
      created_at text not null
    )`,
    `create index if not exists output_shares_from_space_idx
      on output_shares (from_space_id)`,
    `create index if not exists output_shares_to_space_idx
      on output_shares (to_space_id)`,
    `create index if not exists output_shares_producer_idx
      on output_shares (producer_installation_id)`,
    `create table if not exists run_groups (
      id text primary key,
      space_id text not null,
      type text not null,
      record_json text not null,
      created_at text not null
    )`,
    `create index if not exists run_groups_space_idx
      on run_groups (space_id)`,
    `create table if not exists audit_events (
      id text primary key,
      space_id text not null,
      actor_id text,
      action text not null,
      target_type text not null,
      target_id text not null,
      run_id text,
      created_at text not null,
      record_json text not null
    )`,
    `create index if not exists audit_events_space_idx
      on audit_events (space_id)`,
    `create index if not exists audit_events_space_target_created_id_idx
      on audit_events (space_id, target_type, target_id, created_at, id)`,
    `create table if not exists credential_mint_events (
      id text primary key,
      run_id text not null,
      space_id text not null,
      installation_id text,
      source_id text,
      connection_id text not null,
      phase text not null,
      record_json text not null,
      created_at text not null
    )`,
    `create index if not exists credential_mint_events_run_idx
      on credential_mint_events (run_id)`,
    `create index if not exists credential_mint_events_space_idx
      on credential_mint_events (space_id)`,
    `create index if not exists credential_mint_events_source_idx
      on credential_mint_events (source_id)`,
    `create table if not exists security_findings (
      id text primary key,
      space_id text not null,
      installation_id text,
      run_id text,
      severity text not null,
      type text not null,
      record_json text not null,
      created_at text not null
    )`,
    `create index if not exists security_findings_space_idx
      on security_findings (space_id)`,
    `create index if not exists security_findings_run_idx
      on security_findings (run_id)`,
    `create index if not exists security_findings_severity_idx
      on security_findings (severity)`,
    `create table if not exists usage_events (
      id text primary key,
      workspace_id text not null,
      capsule_id text,
      run_id text,
      meter_id text,
      resource_family text,
      resource_id text,
      operation text,
      resource_metadata_json text,
      kind text not null,
      quantity real not null,
      usd_micros integer not null,
      source text not null,
      idempotency_key text not null,
      created_at text not null
    )`,
    `create index if not exists usage_events_workspace_idx
      on usage_events (workspace_id)`,
    `create index if not exists usage_events_run_idx
      on usage_events (run_id)`,
    `create unique index if not exists usage_events_idempotency_key_unique
      on usage_events (idempotency_key)`,
    `create table if not exists public_host_reservations (
      hostname text primary key,
      owner_user_id text not null,
      workspace_id text not null,
      installation_id text not null,
      installation_name text not null,
      allocation_kind text not null,
      status text not null,
      reserved_at text not null,
      updated_at text not null,
      released_at text
    )`,
    `create index if not exists public_host_reservations_workspace_idx
      on public_host_reservations (workspace_id)`,
    `create index if not exists public_host_reservations_owner_kind_idx
      on public_host_reservations (owner_user_id, allocation_kind, status)`,
    `create index if not exists public_host_reservations_installation_idx
      on public_host_reservations (installation_id)`,
    `create index if not exists public_host_reservations_status_idx
      on public_host_reservations (status)`,
    `create table if not exists backups (
      id text primary key,
      space_id text not null,
      installation_id text,
      environment text,
      created_by_run_id text,
      record_json text not null,
      created_at text not null
    )`,
    `create index if not exists backups_space_idx
      on backups (space_id)`,
    `create index if not exists backups_installation_idx
      on backups (installation_id)`,
    // Resource Shape flow (`takosumi.dev/v1alpha1`) durable projections.
    `create table if not exists resource_shapes (
      id text primary key,
      space_id text not null,
      project text,
      environment text,
      kind text not null,
      form_ref_json text,
      package_digest text,
      name text not null,
      managed_by text not null,
      spec_json text not null,
      phase text not null,
      generation integer not null,
      observed_generation integer not null,
      outputs_json text,
      execution_json text,
      state_adoption_json text,
      conditions_json text,
      labels_json text,
      created_at text not null,
      updated_at text not null,
      observation_lease_id text,
      observation_claimed_at text,
      last_observation_attempt_at text
    )`,
    `create unique index if not exists resource_shapes_space_kind_name_unique
      on resource_shapes (space_id, kind, name)`,
    `create index if not exists resource_shapes_space_idx
      on resource_shapes (space_id)`,
    `create index if not exists resource_shapes_space_created_id_idx
      on resource_shapes (space_id, created_at, id)`,
    `create index if not exists resource_shapes_ready_kind_created_id_idx
      on resource_shapes (kind, phase, created_at, id)`,
    `create index if not exists resource_shapes_observation_due_idx
      on resource_shapes (
        phase, last_observation_attempt_at, observation_claimed_at, id
      )`,
    `create index if not exists resource_shapes_unpinned_form_kind_id_idx
      on resource_shapes (kind, id) where form_ref_json is null`,
    `create table if not exists resolution_locks (
      resource_id text primary key,
      form_ref_json text,
      package_digest text,
      selected_implementation text not null,
      target_pool text,
      target text not null,
      target_snapshot_json text,
      implementation_snapshot_json text,
      implementation_plugin text,
      implementation_options_json text,
      implementation_fingerprint text,
      locked integer not null,
      reason_json text not null,
      portability text,
      native_resources_json text,
      locked_at text not null,
      updated_at text not null
    )`,
    `create index if not exists resolution_locks_unpinned_form_resource_idx
      on resolution_locks (resource_id) where form_ref_json is null`,
    `create table if not exists target_pools (
      id text primary key,
      space_id text not null,
      name text not null,
      spec_json text not null,
      created_at text not null,
      updated_at text not null
    )`,
    `create unique index if not exists target_pools_space_name_unique
      on target_pools (space_id, name)`,
    `create index if not exists target_pools_space_idx
      on target_pools (space_id)`,
    `create index if not exists target_pools_space_created_id_idx
      on target_pools (space_id, created_at, id)`,
    `create table if not exists space_policies (
      id text primary key,
      space_id text not null,
      name text not null,
      spec_json text not null,
      created_at text not null,
      updated_at text not null
    )`,
    `create unique index if not exists space_policies_space_name_unique
      on space_policies (space_id, name)`,
    `create index if not exists space_policies_space_idx
      on space_policies (space_id)`,
    // Runtime declaration layer. Values are non-secret declaration documents
    // and resolved public output inputs; credentials remain references only.
    `create table if not exists interfaces (
      id text primary key,
      workspace_id text not null,
      owner_kind text not null,
      owner_id text not null,
      name text not null,
      interface_type text not null,
      phase text not null,
      generation integer not null,
      resolved_revision integer not null,
      oauth_resource_uri text,
      form_ref_key text,
      form_schema_digest text,
      descriptor_name text,
      descriptor_version text,
      record_json text not null,
      created_at text not null,
      updated_at text not null
    )`,
    `create unique index if not exists interfaces_active_name_unique
      on interfaces (workspace_id, owner_kind, owner_id, name)
      where phase <> 'Retired'`,
    `create index if not exists interfaces_workspace_type_phase_idx
      on interfaces (workspace_id, interface_type, phase)`,
    `create unique index if not exists interfaces_oauth_resource_claim_unique
      on interfaces (workspace_id, owner_kind, owner_id, oauth_resource_uri)
      where oauth_resource_uri is not null`,
    `create index if not exists interfaces_form_descriptor_idx
      on interfaces (
        workspace_id, form_ref_key, form_schema_digest,
        descriptor_name, descriptor_version
      ) where form_ref_key is not null`,
    `create table if not exists interface_bindings (
      id text primary key,
      workspace_id text not null,
      interface_id text not null,
      subject_kind text not null,
      subject_id text not null,
      phase text not null,
      generation integer not null,
      record_json text not null,
      created_at text not null,
      updated_at text not null
    )`,
    `create unique index if not exists interface_bindings_active_subject_unique
      on interface_bindings (interface_id, subject_kind, subject_id)
      where phase <> 'Revoked'`,
    `create index if not exists interface_bindings_interface_idx
      on interface_bindings (interface_id)`,
    `create index if not exists interface_bindings_workspace_subject_idx
      on interface_bindings (workspace_id, subject_kind, subject_id)`,
    ...D1_SERVICE_FORM_REGISTRY_STATEMENTS,
  ];
  const tableStatements = statements.filter((sql) => !isD1IndexStatement(sql));
  const indexStatements = statements.filter((sql) => isD1IndexStatement(sql));
  // Guarded table renames run BEFORE the final-name `create table if not exists`
  // ensure-DDL so a rename (e.g. spaces -> workspaces) renames the existing
  // populated table instead of colliding with a freshly-created empty
  // final-name table. Each entry no-ops unless its source exists and its target
  // does not, so the pass converges identically on fresh, existing, and
  // already-renamed databases. (Empty until the 17-noun rename populates it.)
  await applyD1PreCreateRenames(db);
  for (const sql of tableStatements) {
    await db.prepare(sql).run();
  }
  await migrateD1OpenTofuLedgerSchema(db);
  for (const sql of indexStatements) {
    await db.prepare(sql).run();
  }
}

/**
 * Final-name table renames applied before the ensure-DDL in
 * {@link ensureD1OpenTofuLedgerSchema}. P4 17-noun rename: a pre-existing
 * (populated) ledger table is renamed to its final name BEFORE the
 * `create table if not exists <final>` ensure-DDL would otherwise create an
 * empty final-name table beside it. Guarded so the pass is a no-op on fresh
 * databases (no source table) and on already-renamed databases (target exists).
 * Column-level renames + the project_id add + value-translation + record_json
 * blob-key rewrites are then applied by the versioned migration
 * `d1_opentofu_workspace_capsule_rename` (version 17).
 */
const D1_OPEN_TOFU_PRE_CREATE_RENAMES: readonly {
  readonly from: string;
  readonly to: string;
}[] = [
  { from: "spaces", to: "workspaces" },
  { from: "installations", to: "capsules" },
  { from: "state_snapshots", to: "state_versions" },
  { from: "output_snapshots", to: "outputs" },
];

async function applyD1PreCreateRenames(db: D1Database): Promise<void> {
  await applyD1GuardedTableRenames(db, D1_OPEN_TOFU_PRE_CREATE_RENAMES);
}

/**
 * Applies each `{ from, to }` table rename only when `from` exists and `to` does
 * not, making the pass an idempotent no-op on fresh and already-renamed
 * databases. Exported for boot-convergence tests.
 */
export async function applyD1GuardedTableRenames(
  db: D1Database,
  renames: readonly { readonly from: string; readonly to: string }[],
): Promise<void> {
  for (const { from, to } of renames) {
    if ((await d1TableExists(db, from)) && !(await d1TableExists(db, to))) {
      await db.prepare(`alter table ${from} rename to ${to}`).run();
    }
  }
}

async function migrateD1OpenTofuLedgerSchema(db: D1Database): Promise<void> {
  await ensureD1SchemaMigrationLedger(db);
  // A legacy/empty database can acquire the fence before this ledger exists.
  // Cover the newly created table before the migration chain yields.
  await repairControlD1MaintenanceGuards(db);
  await prepareRetiredD1WorkspaceOutputSyncMigration(db);
  for (const migration of D1_OPEN_TOFU_SCHEMA_MIGRATIONS) {
    await applyD1OpenTofuSchemaMigration(db, migration);
  }
}

/**
 * Migration 26 is immutable history and originally backfilled a table created
 * by the then-current bootstrap schema. The table is no longer part of the
 * current schema, so a fresh database needs this transient compatibility table
 * only while replaying migration 26; migration 27 removes it immediately.
 */
async function prepareRetiredD1WorkspaceOutputSyncMigration(
  db: D1Database,
): Promise<void> {
  const applied = await db
    .prepare(`select version from schema_migrations where version = ?`)
    .bind(26)
    .first<{ readonly version: number }>();
  if (applied || (await d1TableExists(db, "workspace_output_sync"))) {
    return;
  }
  const create = db.prepare(
    `create table workspace_output_sync (
        workspace_id text primary key,
        enabled integer not null default 1,
        output_revision integer not null default 0,
        reconciled_revision integer not null default 0,
        active_run_group_id text,
        consecutive_passes integer not null default 0,
        updated_at text not null
      )`,
  );
  const fence = await activeControlD1MaintenanceFence(db);
  if (!fence) {
    await create.run();
    return;
  }
  await runD1AtomicStatements(
    db,
    await wrapControlD1MaintenanceMigrationBatch(db, fence, [create], {
      newlyCreatedTables: new Set(["workspace_output_sync"]),
    }),
  );
}

function isD1IndexStatement(sql: string): boolean {
  const normalized = sql.trimStart().toLowerCase();
  return (
    normalized.startsWith("create index") ||
    normalized.startsWith("create unique index")
  );
}

type D1OpenTofuSchemaMigration = {
  readonly version: number;
  readonly name: string;
  readonly checksumSource: string | (() => string);
  readonly apply: (db: D1Database) => Promise<void>;
  /**
   * Destructive migrations expose their complete statement set before any
   * write. The migration runner appends the ledger INSERT and submits the
   * whole set through one D1 batch transaction.
   */
  readonly atomicStatements?: (db: D1Database) => Promise<readonly string[]>;
  readonly atomicPreparedStatements?: (
    db: D1Database,
  ) => Promise<readonly D1PreparedStatement[]>;
  readonly permanentlyDroppedTables?: readonly string[];
};

const D1_OPEN_TOFU_SCHEMA_MIGRATIONS = [
  {
    version: 1,
    name: "d1_opentofu_connections_and_secret_blobs_shape",
    checksumSource: `
connections.space_id nullable
connections record_json -> provider + connection_json
secret_blobs blob_json compatibility shape -> canonical secret_blobs columns
`,
    async apply(db) {
      await ensureD1Column(db, "connections", "space_id", "text");
      await rebuildConnectionsTableIfNeeded(db);
      await migrateD1ConnectionsJsonShape(db);
      await migrateD1SecretBlobsShape(db);
    },
  },
  {
    version: 2,
    name: "d1_opentofu_installations_output_snapshot_pointer",
    checksumSource: `
installations.current_output_snapshot_id nullable output snapshot pointer
`,
    async apply(db) {
      // P4: on a fresh post-rename DB the ledger table is created as `capsules`
      // (already carrying current_output_snapshot_id), so the legacy
      // `installations` table is absent — skip rather than ALTER a missing table.
      // (checksumSource is unchanged so already-migrated ledgers stay stable.)
      if (!(await d1TableExists(db, "installations"))) return;
      await ensureD1Column(
        db,
        "installations",
        "current_output_snapshot_id",
        "text",
      );
    },
  },
  {
    version: 3,
    name: "d1_opentofu_runs_projection_columns",
    checksumSource: `
runs.source_id nullable
runs.installation_id nullable
runs.environment nullable
runs.lease_token nullable
runs.heartbeat_at integer nullable
legacy source_sync rows backfill source_id from run_json.sourceId or installation_id and clear installation_id
`,
    async apply(db) {
      await ensureD1Column(db, "runs", "source_id", "text");
      await ensureD1Column(db, "runs", "installation_id", "text");
      await ensureD1Column(db, "runs", "environment", "text");
      await ensureD1Column(db, "runs", "lease_token", "text");
      await ensureD1Column(db, "runs", "heartbeat_at", "integer");
      await rebuildRunsTableIfNeeded(db);
      await backfillD1SourceScopedRuns(db);
    },
  },
  {
    version: 4,
    name: "d1_opentofu_credential_mint_source_scope",
    checksumSource: `
credential_mint_events.source_id nullable source-scoped git mint audit pointer
`,
    async apply(db) {
      await ensureD1Column(db, "credential_mint_events", "source_id", "text");
    },
  },
  {
    version: 6,
    name: "d1_opentofu_backups_installation_run_projection",
    checksumSource: `
backups.installation_id nullable
backups.environment nullable
backups.created_by_run_id nullable Run pointer
`,
    async apply(db) {
      await ensureD1Column(db, "backups", "installation_id", "text");
      await ensureD1Column(db, "backups", "environment", "text");
      await ensureD1Column(db, "backups", "created_by_run_id", "text");
    },
  },
  {
    version: 7,
    name: "d1_opentofu_provider_catalog_table",
    checksumSource: `
provider_templates renamed to provider_catalog
provider catalog indexes renamed to provider_catalog_*
`,
    async apply(db) {
      await ensureD1ProviderCatalogTable(db);
    },
  },
  {
    version: 8,
    name: "d1_opentofu_provider_materialization_values",
    checksumSource: () => `
	provider_catalog.primary_materialization uses oauth/secret only
	provider_envs.materialization uses oauth/secret only
	global provider_envs rows are removed in OSS
${D1_PROVIDER_MATERIALIZATION_CANONICALIZATION_STATEMENTS.join("\n---\n")}
`,
    async apply(db) {
      // `provider_envs` is no longer created by the boot ensure-DDL (it is
      // retired and renamed aside by migration 16). On a FRESH database this
      // historical canonicalization still needs the table to operate on, so
      // create it here (apply-body only; the checksumSource is unchanged so
      // already-migrated databases keep a stable ledger checksum).
      await db
        .prepare(
          `create table if not exists provider_envs (
            id text primary key,
            space_id text not null,
            provider_source text not null,
            materialization text not null check (materialization in ('oauth','secret')),
            status text not null,
            record_json text not null,
            created_at text not null,
            updated_at text not null
          )`,
        )
        .run();
      for (const statement of D1_PROVIDER_MATERIALIZATION_CANONICALIZATION_STATEMENTS) {
        await db.prepare(statement).run();
      }
    },
  },
  {
    version: 9,
    name: "d1_opentofu_drizzle_index_parity",
    checksumSource: () => `
canonical named indexes match the Drizzle D1 schema
old composite bootstrap indexes are dropped and recreated with canonical columns
provider_env_binding_sets unique index uses the public Drizzle name
${D1_OPEN_TOFU_CANONICAL_INDEX_STATEMENTS.join("\n---\n")}
`,
    async apply(db) {
      await ensureD1OpenTofuCanonicalIndexes(db);
    },
  },
  {
    version: 10,
    name: "d1_opentofu_provider_materialization_constraints",
    checksumSource: () => `
	provider_catalog.primary_materialization CHECK oauth/secret
	provider_envs.materialization CHECK oauth/secret
	provider_envs rows require a Space in OSS
${D1_PROVIDER_MATERIALIZATION_CANONICALIZATION_STATEMENTS.join("\n---\n")}
`,
    async apply(db) {
      for (const statement of D1_PROVIDER_MATERIALIZATION_CANONICALIZATION_STATEMENTS) {
        await db.prepare(statement).run();
      }
      await rebuildD1ProviderCatalogWithConstraints(db);
      await rebuildD1ProviderEnvsWithConstraints(db);
      await ensureD1OpenTofuCanonicalIndexes(db);
    },
  },
  {
    version: 11,
    name: "d1_opentofu_provider_catalog_ownership_repair",
    checksumSource: () => `
provider_catalog rows copied from legacy provider_templates repair old ownership/gateway eligibility flags
${D1_PROVIDER_CATALOG_OWNERSHIP_REPAIR_STATEMENTS.join("\n---\n")}
`,
    async apply(db) {
      for (const statement of D1_PROVIDER_CATALOG_OWNERSHIP_REPAIR_STATEMENTS) {
        await db.prepare(statement).run();
      }
    },
  },
  {
    version: 12,
    name: "d1_opentofu_upload_origin_nullable_source_repair",
    checksumSource: `
source_snapshots.source_id nullable for upload-origin snapshots
installations.source_id nullable for upload-origin installations
`,
    async apply(db) {
      await rebuildSourceSnapshotsTableIfNeeded(db);
      await rebuildInstallationsTableIfNeeded(db);
    },
  },
  {
    version: 13,
    name: "d1_opentofu_usage_event_meter_metadata",
    checksumSource: `
usage_events.meter_id nullable provider/runtime meter id
usage_events.resource_family nullable open managed resource family
usage_events.resource_id nullable provider/runtime resource id
usage_events.operation nullable provider/runtime operation
usage_events.resource_metadata_json nullable non-secret resource metadata
`,
    async apply(db) {
      await ensureD1Column(db, "usage_events", "meter_id", "text");
      await ensureD1Column(db, "usage_events", "resource_family", "text");
      await ensureD1Column(db, "usage_events", "resource_id", "text");
      await ensureD1Column(db, "usage_events", "operation", "text");
      await ensureD1Column(
        db,
        "usage_events",
        "resource_metadata_json",
        "text",
      );
    },
  },
  {
    version: 16,
    name: "d1_opentofu_provider_credential_collapse",
    checksumSource: `
provider_envs.materialization merged onto connections.connection_json (id-equal join)
connection_json.materialization/providerSource backfilled (default secret / provider)
provider_catalog renamed aside to provider_catalog_retired (non-destructive)
provider_envs renamed aside to provider_envs_retired (non-destructive)
`,
    async apply(db) {
      // Fold the retired ProviderEnv resolver projection onto the unified
      // Connection row. `provider_envs.id == connections.id`, so merge by id.
      // Connections with no matching provider_envs row (git source connections)
      // default to materialization 'secret' and providerSource = provider.
      if (await d1TableExists(db, "provider_envs")) {
        await db
          .prepare(
            `update connections set connection_json = json_set(
               json_set(
                 connection_json,
                 '$.materialization',
                 coalesce(
                   (select pe.materialization from provider_envs pe where pe.id = connections.id),
                   json_extract(connection_json, '$.materialization'),
                   case
                     when json_extract(connection_json, '$.credentialDriver') in ('cloudflare_oauth', 'gcp_oauth_bootstrap')
                     then 'oauth'
                   end,
                   'secret'
                 )
               ),
               '$.providerSource',
               coalesce(
                 (select pe.provider_source from provider_envs pe where pe.id = connections.id),
                 json_extract(connection_json, '$.providerSource'),
                 json_extract(connection_json, '$.provider')
               )
             )`,
          )
          .run();
      } else {
        await db
          .prepare(
            `update connections set connection_json = json_set(
               json_set(
                 connection_json,
                 '$.materialization',
                 coalesce(
                   json_extract(connection_json, '$.materialization'),
                   case
                     when json_extract(connection_json, '$.credentialDriver') in ('cloudflare_oauth', 'gcp_oauth_bootstrap')
                     then 'oauth'
                   end,
                   'secret'
                 )
               ),
               '$.providerSource',
               coalesce(
                 json_extract(connection_json, '$.providerSource'),
                 json_extract(connection_json, '$.provider')
               )
             )`,
          )
          .run();
      }
      // Rename-aside (non-destructive): the live Provider Catalog / Provider Env
      // tables are retired. Guarded so the pass converges on fresh, existing, and
      // already-renamed databases.
      await applyD1GuardedTableRenames(db, [
        { from: "provider_catalog", to: "provider_catalog_retired" },
        { from: "provider_envs", to: "provider_envs_retired" },
      ]);
    },
  },
  {
    version: 17,
    name: "d1_opentofu_workspace_capsule_rename",
    checksumSource: `
P4 17-noun rename (table renames applied by applyD1PreCreateRenames before ensure-DDL):
  spaces -> workspaces, installations -> capsules,
  state_snapshots -> state_versions, output_snapshots -> outputs.
capsules.current_deployment_id renamed to current_state_version_id (guarded).
capsules.project_id added (nullable, Workspace-owned Project pointer).
projects table + one default Project (prj_default_<workspaceId>) backfilled per Workspace;
capsules.project_id backfilled to the default Project.
retire_deployment_tracking value-translation: capsules.current_state_version_id set from the
  highest-generation StateVersion per (capsule, environment); the column previously held a
  retired deployments.id.
record_json blob-key rewrites (rename-aside, replacement semantics):
  capsules: spaceId->workspaceId, currentOutputSnapshotId->currentOutputId,
            currentDeploymentId->currentStateVersionId (value from the translated column),
            projectId set from the column;
  state_versions/outputs: spaceId->workspaceId, installationId->capsuleId;
  output_shares: fromSpaceId->fromWorkspaceId, toSpaceId->toWorkspaceId,
                 producerInstallationId->producerCapsuleId.
stale pre-rename named indexes dropped (the canonical new-name indexes are (re)created by the
  ensure-DDL index tail).
`,
    async apply(db) {
      // 1. capsules column moves (the table itself was renamed by the
      //    pre-create rename; on a fresh DB the ensure-DDL already created the
      //    final column shape so each step below is a guarded no-op).
      await renameD1ColumnIfNeeded(
        db,
        "capsules",
        "current_deployment_id",
        "current_state_version_id",
      );
      if (await d1TableExists(db, "capsules")) {
        await ensureD1Column(db, "capsules", "project_id", "text");
        // The pre-create rename can move `installations` -> `capsules` before the
        // historical column-add migrations (e.g. v2's current_output_snapshot_id,
        // which guards on the now-absent `installations` name) get a chance to
        // run, so re-assert the canonical nullable pointer columns here.
        await ensureD1Column(
          db,
          "capsules",
          "current_state_version_id",
          "text",
        );
        await ensureD1Column(
          db,
          "capsules",
          "current_output_snapshot_id",
          "text",
        );
      }

      // 2. projects table (also created by the ensure-DDL table pass; defensive).
      await db
        .prepare(
          `create table if not exists projects (
            id text primary key,
            workspace_id text not null,
            name text not null,
            slug text not null,
            record_json text not null,
            created_at text not null,
            updated_at text not null
          )`,
        )
        .run();

      // 3. Backfill one default Project per Workspace, then point every
      //    pre-Project Capsule at its Workspace's default Project.
      if (await d1TableExists(db, "workspaces")) {
        await db
          .prepare(
            `insert into projects (id, workspace_id, name, slug, record_json, created_at, updated_at)
             select
               'prj_default_' || w.id,
               w.id,
               'Default',
               'default',
               json_object(
                 'id', 'prj_default_' || w.id,
                 'workspaceId', w.id,
                 'name', 'Default',
                 'slug', 'default',
                 'projectJson', json_object(),
                 'createdAt', w.created_at,
                 'updatedAt', w.updated_at
               ),
               w.created_at,
               w.updated_at
             from workspaces w
             where not exists (
               select 1 from projects p where p.id = 'prj_default_' || w.id
             )`,
          )
          .run();
      }
      if (await d1TableExists(db, "capsules")) {
        await db
          .prepare(
            `update capsules set project_id = 'prj_default_' || space_id
             where project_id is null
               and exists (
                 select 1 from projects p
                 where p.id = 'prj_default_' || capsules.space_id
               )`,
          )
          .run();
      }

      // 4. retire_deployment_tracking value-translation: rewrite the pointer that
      //    used to be a deployments.id into the highest-generation StateVersion id
      //    for the Capsule's current environment.
      if (
        (await d1TableExists(db, "capsules")) &&
        (await d1TableExists(db, "state_versions"))
      ) {
        await db
          .prepare(
            `update capsules set current_state_version_id = (
               select sv.id from state_versions sv
               where sv.installation_id = capsules.id
                 and sv.environment = capsules.environment
               order by sv.generation desc limit 1
             )
             where exists (
               select 1 from state_versions sv
               where sv.installation_id = capsules.id
                 and sv.environment = capsules.environment
             )`,
          )
          .run();
      }

      // 5. record_json blob-key rewrites (so getCapsule / getStateVersion /
      //    getOutput deserialize the renamed contract fields).
      await renameD1JsonKey(db, "capsules", "spaceId", "workspaceId");
      await renameD1JsonKey(
        db,
        "capsules",
        "currentOutputSnapshotId",
        "currentOutputId",
      );
      if (await d1TableExists(db, "capsules")) {
        // currentStateVersionId carries the value-translated column (not the old
        // currentDeploymentId value); set it from the column, then drop the
        // stale key.
        await db
          .prepare(
            `update capsules
             set record_json = json_set(
               record_json, '$.currentStateVersionId', current_state_version_id
             )
             where current_state_version_id is not null`,
          )
          .run();
        await db
          .prepare(
            `update capsules
             set record_json = json_remove(record_json, '$.currentDeploymentId')
             where json_extract(record_json, '$.currentDeploymentId') is not null`,
          )
          .run();
        await db
          .prepare(
            `update capsules
             set record_json = json_set(record_json, '$.projectId', project_id)
             where project_id is not null`,
          )
          .run();
      }
      // state_versions is stored columnar (no record_json blob), so it carries
      // no JSON keys to rewrite — only outputs / output_shares / capsules do.
      await renameD1JsonKey(db, "outputs", "spaceId", "workspaceId");
      await renameD1JsonKey(db, "outputs", "installationId", "capsuleId");
      await renameD1JsonKey(
        db,
        "output_shares",
        "fromSpaceId",
        "fromWorkspaceId",
      );
      await renameD1JsonKey(db, "output_shares", "toSpaceId", "toWorkspaceId");
      await renameD1JsonKey(
        db,
        "output_shares",
        "producerInstallationId",
        "producerCapsuleId",
      );

      // 6. Drop stale pre-rename named indexes carried over by the table rename;
      //    the ensure-DDL index tail recreates the canonical new-name indexes.
      for (const indexName of [
        "spaces_handle_unique",
        "installations_space_name_environment_unique",
        "installations_space_idx",
        "installations_current_deployment_idx",
        "state_snapshots_installation_environment_generation_unique",
        "state_snapshots_installation_idx",
        "output_snapshots_installation_idx",
      ]) {
        await db.prepare(`drop index if exists ${indexName}`).run();
      }
    },
  },
  {
    version: 18,
    name: "d1_opentofu_compatibility_report_root_interface",
    checksumSource: `
capsule_compatibility_reports.root_module_variables_json text not null default []
capsule_compatibility_reports.root_module_outputs_json text not null default []
`,
    async apply(db) {
      await ensureD1Column(
        db,
        "capsule_compatibility_reports",
        "root_module_variables_json",
        "text not null default '[]'",
      );
      await ensureD1Column(
        db,
        "capsule_compatibility_reports",
        "root_module_outputs_json",
        "text not null default '[]'",
      );
    },
  },
  {
    version: 19,
    name: "d1_opentofu_public_host_reservations",
    checksumSource: `
public_host_reservations table for atomic hostname claims
hostname primary key
workspace / installation / status indexes
`,
    async apply(db) {
      await db
        .prepare(
          `create table if not exists public_host_reservations (
            hostname text primary key,
            workspace_id text not null,
            installation_id text not null,
            installation_name text not null,
            status text not null,
            reserved_at text not null,
            updated_at text not null,
            released_at text
          )`,
        )
        .run();
      await db
        .prepare(
          `create index if not exists public_host_reservations_workspace_idx
            on public_host_reservations (workspace_id)`,
        )
        .run();
      await db
        .prepare(
          `create index if not exists public_host_reservations_installation_idx
            on public_host_reservations (installation_id)`,
        )
        .run();
      await db
        .prepare(
          `create index if not exists public_host_reservations_status_idx
            on public_host_reservations (status)`,
        )
        .run();
    },
  },
  {
    version: 20,
    name: "d1_opentofu_public_host_reservations_backfill",
    checksumSource: `
backfill public_host_reservations from existing Capsule output URLs
dedupe url launch_url app_url per Capsule
prefer active over stale over error over pending over disabled
skip workers.dev hosts
`,
    async apply(db) {
      await db
        .prepare(
          `with raw_hosts as (
            select c.id as installation_id,
                   c.space_id as workspace_id,
                   c.name as installation_name,
                   c.status as installation_status,
                   c.created_at as installation_created_at,
                   json_extract(o.record_json, '$.publicOutputs.url') as url
            from capsules c
            join outputs o on o.id = c.current_output_snapshot_id
            where c.status != 'destroyed'
            union all
            select c.id, c.space_id, c.name, c.status, c.created_at,
                   json_extract(o.record_json, '$.publicOutputs.launch_url')
            from capsules c
            join outputs o on o.id = c.current_output_snapshot_id
            where c.status != 'destroyed'
            union all
            select c.id, c.space_id, c.name, c.status, c.created_at,
                   json_extract(o.record_json, '$.publicOutputs.app_url')
            from capsules c
            join outputs o on o.id = c.current_output_snapshot_id
            where c.status != 'destroyed'
          ),
          parsed_hosts as (
            select installation_id,
                   workspace_id,
                   installation_name,
                   installation_status,
                   installation_created_at,
                   lower(
                     case
                       when url like 'https://%' then
                         case
                           when instr(substr(url, 9), '/') > 0
                             then substr(substr(url, 9), 1, instr(substr(url, 9), '/') - 1)
                           else substr(url, 9)
                         end
                       else null
                     end
                   ) as hostname,
                   case installation_status
                     when 'active' then 400
                     when 'stale' then 300
                     when 'error' then 200
                     when 'pending' then 100
                     when 'disabled' then 50
                     else 0
                   end as priority
            from raw_hosts
            where url is not null
          ),
          distinct_hosts as (
            select hostname,
                   installation_id,
                   workspace_id,
                   installation_name,
                   installation_status,
                   installation_created_at,
                   max(priority) as priority
            from parsed_hosts
            where hostname is not null
              and hostname != ''
              and hostname not like '%.workers.dev'
            group by hostname, installation_id
          ),
          ranked as (
            select *,
                   row_number() over (
                     partition by hostname
                     order by priority desc, installation_created_at desc, installation_id desc
                   ) as rn
            from distinct_hosts
          ),
          migration_clock as (
            select strftime('%Y-%m-%dT%H:%M:%fZ', 'now') as now
          )
          insert into public_host_reservations (
            hostname, workspace_id, installation_id, installation_name,
            status, reserved_at, updated_at, released_at
          )
          select hostname,
                 workspace_id,
                 installation_id,
                 installation_name,
                 'reserved',
                 migration_clock.now,
                 migration_clock.now,
                 null
          from ranked
          cross join migration_clock
          where rn = 1
          on conflict(hostname) do update set
            workspace_id = excluded.workspace_id,
            installation_id = excluded.installation_id,
            installation_name = excluded.installation_name,
            status = 'reserved',
            updated_at = excluded.updated_at,
            released_at = null
          where public_host_reservations.status = 'released'
             or public_host_reservations.installation_id = excluded.installation_id`,
        )
        .run();
    },
  },
  {
    version: 21,
    name: "d1_opentofu_capsule_active_name_unique",
    checksumSource: `
Capsule name uniqueness applies only to non-destroyed rows
drop old full-row capsules/installation unique indexes
create partial active unique index on space/name/environment where status != destroyed
`,
    async apply(db) {
      await db
        .prepare(`drop index if exists capsules_space_name_environment_unique`)
        .run();
      await db
        .prepare(
          `drop index if exists installations_space_name_environment_unique`,
        )
        .run();
      await db
        .prepare(
          `create unique index if not exists capsules_space_name_environment_active_unique
          on capsules (space_id, name, environment)
          where status != 'destroyed'`,
        )
        .run();
    },
  },
  {
    version: 22,
    name: "d1_opentofu_install_config_store_key",
    checksumSource: `
install_configs.config_json top-level catalog key renamed to store
existing store value wins when both keys are present
catalog key removed after convergence
`,
    async apply(db) {
      await db
        .prepare(
          `update install_configs
           set record_json = case
             when json_type(record_json, '$.store') is not null
               then json_remove(record_json, '$.catalog')
             else json_remove(
               json_set(
                 record_json,
                 '$.store',
                 json_extract(record_json, '$.catalog')
               ),
               '$.catalog'
             )
           end
           where json_type(record_json, '$.catalog') is not null`,
        )
        .run();
    },
  },
  {
    version: 23,
    name: "d1_opentofu_public_host_owner_slots",
    checksumSource: `
public_host_reservations.owner_user_id owner account attribution
public_host_reservations.allocation_kind scoped or vanity
existing rows classified from the Workspace handle and attributed to ownerUserId
`,
    async apply(db) {
      await ensureD1Column(
        db,
        "public_host_reservations",
        "owner_user_id",
        "text",
      );
      await ensureD1Column(
        db,
        "public_host_reservations",
        "allocation_kind",
        "text not null default 'scoped'",
      );
      await db
        .prepare(
          `update public_host_reservations
           set owner_user_id = (
                 select json_extract(workspaces.record_json, '$.ownerUserId')
                 from workspaces
                 where workspaces.id = public_host_reservations.workspace_id
               ),
               allocation_kind = case
                 when exists (
                   select 1
                   from workspaces
                   where workspaces.id = public_host_reservations.workspace_id
                     and substr(
                       public_host_reservations.hostname,
                       1,
                       length(json_extract(workspaces.record_json, '$.handle')) + 1
                     ) = json_extract(workspaces.record_json, '$.handle') || '-'
                 ) then 'scoped'
                 else 'vanity'
               end
           where owner_user_id is null or owner_user_id = ''`,
        )
        .run();
      const orphaned = await db
        .prepare(
          `select count(*) as count
           from public_host_reservations
           where owner_user_id is null or owner_user_id = ''`,
        )
        .first<{ count: number | string }>();
      if (Number(orphaned?.count ?? 0) > 0) {
        throw new Error(
          "public host owner-slot migration found a reservation without a Workspace owner",
        );
      }
      await db
        .prepare(`drop table if exists public_host_reservations__owner_slots`)
        .run();
      await db
        .prepare(
          `create table public_host_reservations__owner_slots (
            hostname text primary key,
            owner_user_id text not null,
            workspace_id text not null,
            installation_id text not null,
            installation_name text not null,
            allocation_kind text not null
              check (allocation_kind in ('scoped','vanity')),
            status text not null
              check (status in ('reserved','released')),
            reserved_at text not null,
            updated_at text not null,
            released_at text
          )`,
        )
        .run();
      await db
        .prepare(
          `insert into public_host_reservations__owner_slots (
             hostname, owner_user_id, workspace_id, installation_id,
             installation_name, allocation_kind, status,
             reserved_at, updated_at, released_at
           )
           select hostname, owner_user_id, workspace_id, installation_id,
                  installation_name, allocation_kind, status,
                  reserved_at, updated_at, released_at
           from public_host_reservations`,
        )
        .run();
      await db.prepare(`drop table public_host_reservations`).run();
      await db
        .prepare(
          `alter table public_host_reservations__owner_slots
           rename to public_host_reservations`,
        )
        .run();
      await db
        .prepare(
          `create index if not exists public_host_reservations_workspace_idx
           on public_host_reservations (workspace_id)`,
        )
        .run();
      await db
        .prepare(
          `create index if not exists public_host_reservations_installation_idx
           on public_host_reservations (installation_id)`,
        )
        .run();
      await db
        .prepare(
          `create index if not exists public_host_reservations_status_idx
           on public_host_reservations (status)`,
        )
        .run();
      await db
        .prepare(
          `create index if not exists public_host_reservations_owner_kind_idx
           on public_host_reservations (owner_user_id, allocation_kind, status)`,
        )
        .run();
    },
  },
  {
    version: 24,
    name: "d1_opentofu_public_host_legacy_grandfather",
    checksumSource: `
pre-owner-slot public host reservations are grandfathered as scoped
only reservations created after this migration can consume vanity slots
`,
    async atomicStatements() {
      return [
        `update public_host_reservations
           set allocation_kind = 'scoped'
           where allocation_kind != 'scoped'`,
      ];
    },
    async apply(db) {
      await db
        .prepare(
          `update public_host_reservations
           set allocation_kind = 'scoped'
           where allocation_kind != 'scoped'`,
        )
        .run();
    },
  },
  {
    version: 25,
    name: "d1_opentofu_install_config_runner_profile",
    checksumSource: `
current install_configs runnerId values converge from retired provider-specific profiles
opentofu-default is the only built-in provider-neutral runner profile
custom runner profiles and historical runs remain unchanged
`,
    async atomicStatements() {
      return [
        `update install_configs
           set record_json = json_set(
             record_json,
             '$.runnerId',
             'opentofu-default'
           )
           where json_extract(record_json, '$.runnerId') in (
             'cloudflare-default',
             'aws-provider-env-candidate',
             'gcp-provider-env-candidate',
             'azure-provider-env-candidate',
             'kubernetes-provider-env-candidate',
             'github-provider-env-candidate',
             'digitalocean-provider-env-candidate',
             'hcloud-provider-env-candidate',
             'vultr-provider-env-candidate',
             'scaleway-provider-env-candidate',
             'openstack-provider-env-candidate',
             'docker-custom-example',
             'generic-opentofu-provider'
           )`,
      ];
    },
    async apply(db) {
      await db
        .prepare(
          `update install_configs
           set record_json = json_set(
             record_json,
             '$.runnerId',
             'opentofu-default'
           )
           where json_extract(record_json, '$.runnerId') in (
             'cloudflare-default',
             'aws-provider-env-candidate',
             'gcp-provider-env-candidate',
             'azure-provider-env-candidate',
             'kubernetes-provider-env-candidate',
             'github-provider-env-candidate',
             'digitalocean-provider-env-candidate',
             'hcloud-provider-env-candidate',
             'vultr-provider-env-candidate',
             'scaleway-provider-env-candidate',
             'openstack-provider-env-candidate',
             'docker-custom-example',
             'generic-opentofu-provider'
           )`,
        )
        .run();
    },
  },
  {
    version: 26,
    name: "d1_opentofu_workspace_output_sync",
    checksumSource: `
workspace_output_sync tracks Takosumi-specific Workspace reconciliation state
existing Workspaces default enabled and start at revision 1 when a Capsule has a current Output
OpenTofu outputs remain authoritative in the outputs table
`,
    async atomicStatements() {
      return [
        `insert into workspace_output_sync (
             workspace_id, enabled, output_revision, reconciled_revision,
             active_run_group_id, consecutive_passes, updated_at
           )
           select w.id,
                  1,
                  case when exists (
                    select 1 from capsules c
                    where c.space_id = w.id
                      and coalesce(
                        json_extract(c.record_json, '$.currentOutputId'),
                        c.current_output_snapshot_id,
                        json_extract(c.record_json, '$.currentOutputId')
                      ) is not null
                  ) then 1 else 0 end,
                  0,
                  null,
                  0,
                  w.updated_at
           from workspaces w
           where true
           on conflict(workspace_id) do nothing`,
      ];
    },
    async apply(db) {
      await db
        .prepare(
          `insert into workspace_output_sync (
             workspace_id, enabled, output_revision, reconciled_revision,
             active_run_group_id, consecutive_passes, updated_at
           )
           select w.id,
                  1,
                  case when exists (
                    select 1 from capsules c
                    where c.space_id = w.id
                      and coalesce(
                        json_extract(c.record_json, '$.currentOutputId'),
                        c.current_output_snapshot_id,
                        json_extract(c.record_json, '$.currentOutputId')
                      ) is not null
                  ) then 1 else 0 end,
                  0,
                  null,
                  0,
                  w.updated_at
           from workspaces w
           where true
           on conflict(workspace_id) do nothing`,
        )
        .run();
    },
  },
  {
    version: 27,
    name: "d1_opentofu_workspace_output_sync_retire",
    checksumSource: `
workspace_output_sync execution state is retired
ordinary OpenTofu outputs remain in the outputs table
historical migration 26 remains immutable
`,
    async atomicStatements() {
      return [
        `drop index if exists workspace_output_sync_pending_idx`,
        `drop table if exists workspace_output_sync`,
      ];
    },
    permanentlyDroppedTables: ["workspace_output_sync"],
    async apply(db) {
      await db
        .prepare(`drop index if exists workspace_output_sync_pending_idx`)
        .run();
      await db.prepare(`drop table if exists workspace_output_sync`).run();
    },
  },
  {
    version: 28,
    name: "d1_resource_shape_resolution_lock_identity",
    checksumSource: `
resolution_locks.target_pool nullable legacy-compatible TargetPool identity
resolution_locks.target_snapshot_json nullable immutable non-secret Target snapshot
resolution_locks.implementation_snapshot_json nullable immutable non-secret implementation descriptor snapshot
resolution_locks.implementation_plugin nullable pinned adapter plugin
resolution_locks.implementation_options_json nullable pinned non-secret plugin options
resolution_locks.implementation_fingerprint nullable canonical selected implementation identity
`,
    async atomicStatements(db) {
      return await d1ResolutionLockIdentityStatements(db);
    },
    async apply(db) {
      await ensureD1Column(db, "resolution_locks", "target_pool", "text");
      await ensureD1Column(
        db,
        "resolution_locks",
        "target_snapshot_json",
        "text",
      );
      await ensureD1Column(
        db,
        "resolution_locks",
        "implementation_snapshot_json",
        "text",
      );
      await ensureD1Column(
        db,
        "resolution_locks",
        "implementation_plugin",
        "text",
      );
      await ensureD1Column(
        db,
        "resolution_locks",
        "implementation_options_json",
        "text",
      );
      await ensureD1Column(
        db,
        "resolution_locks",
        "implementation_fingerprint",
        "text",
      );
    },
  },
  {
    version: 29,
    name: "d1_capsule_compatibility_auto_rewrite_retire",
    checksumSource: `
legacy auto_capsulized reports normalize to ready
legacy Capsule compatibilityStatus normalizes to ready
normalized module artifact pointers are retired
current Runs always dispatch the immutable SourceSnapshot archive
`,
    async atomicStatements(db) {
      return await d1CompatibilityAutoRewriteRetireStatements(db);
    },
    async apply(db) {
      const columns = await d1ColumnNames(db, "capsule_compatibility_reports");
      if (columns.size === 0) return;
      const clearsLegacyPointers =
        columns.has("normalized_object_key") &&
        columns.has("normalized_digest");
      await db
        .prepare(
          clearsLegacyPointers
            ? `update capsule_compatibility_reports
               set level = 'ready',
                   normalized_object_key = null,
                   normalized_digest = null
               where level = 'auto_capsulized'`
            : `update capsule_compatibility_reports
               set level = 'ready'
               where level = 'auto_capsulized'`,
        )
        .run();
      await db
        .prepare(
          `update capsules
           set record_json = json_set(
             record_json,
             '$.compatibilityStatus',
             'ready'
           )
           where json_extract(
             record_json,
             '$.compatibilityStatus'
           ) = 'auto_capsulized'`,
        )
        .run();
    },
  },
  {
    version: 30,
    name: "d1_workspace_members_create",
    checksumSource: `
workspace_members is the canonical Workspace membership ledger
every Workspace namespace owner is backfilled as an active owner member
the separate membership snapshot and no-op outbox are retired
`,
    async atomicStatements() {
      return D1_WORKSPACE_MEMBERS_CREATE_STATEMENTS;
    },
    async apply(db) {
      await db
        .prepare(
          `create table if not exists workspace_members (
            id text primary key,
            workspace_id text not null,
            account_id text not null,
            status text not null,
            record_json text not null,
            created_at text not null,
            updated_at text not null
          )`,
        )
        .run();
      await db
        .prepare(
          `create unique index if not exists workspace_members_workspace_account_unique
             on workspace_members (workspace_id, account_id)`,
        )
        .run();
      await db
        .prepare(
          `create index if not exists workspace_members_workspace_status_idx
             on workspace_members (workspace_id, status)`,
        )
        .run();
      await db
        .prepare(
          `create index if not exists workspace_members_account_status_idx
             on workspace_members (account_id, status)`,
        )
        .run();
      await db
        .prepare(
          `insert into workspace_members (
             id, workspace_id, account_id, status, record_json, created_at, updated_at
           )
           select
             'wsm_' || id || '_' || json_extract(record_json, '$.ownerUserId'),
             id,
             json_extract(record_json, '$.ownerUserId'),
             'active',
             json_object(
               'id', 'wsm_' || id || '_' || json_extract(record_json, '$.ownerUserId'),
               'workspaceId', id,
               'accountId', json_extract(record_json, '$.ownerUserId'),
               'roles', json_array('owner'),
               'status', 'active',
               'createdAt', created_at,
               'updatedAt', updated_at
             ),
             created_at,
             updated_at
           from workspaces
           where nullif(json_extract(record_json, '$.ownerUserId'), '') is not null
           on conflict(workspace_id, account_id) do nothing`,
        )
        .run();
    },
  },
  {
    version: 31,
    name: "d1_capsule_install_discriminators_retire",
    checksumSource: `
install_configs.install_type physical discriminator removed
capsules.install_type physical discriminator removed
legacy installType/sourceKind/templateBinding JSON keys removed
Git Source plus DB InstallConfig are the only Capsule execution authority
`,
    async atomicStatements(db) {
      return [
        ...(await d1InstallConfigsWithoutInstallTypeStatements(db)),
        ...(await d1CapsulesWithoutInstallTypeStatements(db)),
      ];
    },
    async apply(db) {
      await runD1AtomicSql(db, [
        ...(await d1InstallConfigsWithoutInstallTypeStatements(db)),
        ...(await d1CapsulesWithoutInstallTypeStatements(db)),
      ]);
    },
  },
  {
    version: 32,
    name: "d1_capsule_project_boundary_enforce",
    // This text is immutable: valid v32-v42 ledgers persist its digest. The
    // idempotent implementation may repair a missing default Project while a
    // not-yet-applied v32 runs, but that repair must not rewrite the accepted
    // identity of databases which already applied this migration.
    checksumSource: `
capsules.project_id is required for every current Capsule
existing null project_id values point to the Workspace default Project
active Capsule name uniqueness is scoped to project_id/name/environment
source_id remains nullable only for historical pre-Git-only operator migration rows
`,
    async atomicStatements(db) {
      return await d1CapsulesWithRequiredProjectStatements(db);
    },
    async apply(db) {
      await runD1AtomicSql(
        db,
        await d1CapsulesWithRequiredProjectStatements(db),
      );
    },
  },
  {
    version: 33,
    name: "d1_resource_execution_state_add",
    checksumSource: `
resource_shapes.execution_json stores the latest Resource-owned run and state pointer
no backing Capsule, Capsule StateVersion, or Capsule Output is created
`,
    async atomicStatements(db) {
      return await d1EnsureColumnStatements(
        db,
        "resource_shapes",
        "execution_json",
        "text",
      );
    },
    async apply(db) {
      if (!(await d1TableExists(db, "resource_shapes"))) return;
      const columns = await d1ColumnNames(db, "resource_shapes");
      if (!columns.has("execution_json")) {
        await db
          .prepare(`alter table resource_shapes add column execution_json text`)
          .run();
      }
    },
  },
  {
    version: 34,
    name: "d1_connection_secret_partition_backfill",
    checksumSource: `
historical Connection rows receive their explicit encryption partition once
provider-family inference is confined to this migration and absent current partitions fail closed
secret blob kind metadata is normalized to the explicit partition token
`,
    async atomicStatements(db) {
      return await d1ConnectionSecretPartitionBackfillStatements(db);
    },
    async apply(db) {
      if (!(await d1TableExists(db, "connections"))) return;
      await db
        .prepare(
          `update connections
           set connection_json = json_set(
             connection_json,
             '$.secretPartition',
             case
               when json_extract(connection_json, '$.kind') in ('source_git_https_token', 'source_git_ssh_key')
                 then 'source:git'
               when lower(coalesce(json_extract(connection_json, '$.providerSource'), json_extract(connection_json, '$.provider'), provider)) = 'cloudflare'
                 or lower(coalesce(json_extract(connection_json, '$.providerSource'), json_extract(connection_json, '$.provider'), provider)) like '%/cloudflare/cloudflare'
                 then 'cloudflare'
               when lower(coalesce(json_extract(connection_json, '$.providerSource'), json_extract(connection_json, '$.provider'), provider)) = 'aws'
                 or lower(coalesce(json_extract(connection_json, '$.providerSource'), json_extract(connection_json, '$.provider'), provider)) like '%/hashicorp/aws'
                 then 'aws'
               when lower(coalesce(json_extract(connection_json, '$.providerSource'), json_extract(connection_json, '$.provider'), provider)) in ('google', 'gcp')
                 or lower(coalesce(json_extract(connection_json, '$.providerSource'), json_extract(connection_json, '$.provider'), provider)) like '%/hashicorp/google'
                 or lower(coalesce(json_extract(connection_json, '$.providerSource'), json_extract(connection_json, '$.provider'), provider)) like '%/hashicorp/google-beta'
                 then 'gcp'
               when lower(coalesce(json_extract(connection_json, '$.providerSource'), json_extract(connection_json, '$.provider'), provider)) in ('kubernetes', 'helm')
                 or lower(coalesce(json_extract(connection_json, '$.providerSource'), json_extract(connection_json, '$.provider'), provider)) like '%/hashicorp/kubernetes'
                 or lower(coalesce(json_extract(connection_json, '$.providerSource'), json_extract(connection_json, '$.provider'), provider)) like '%/hashicorp/helm'
                 then 'k8s'
               else 'local-adapters'
             end
           )
           where nullif(json_extract(connection_json, '$.secretPartition'), '') is null`,
        )
        .run();
      if (!(await d1TableExists(db, "secret_blobs"))) return;
      await db
        .prepare(
          `update secret_blobs
           set kind = (
                 select json_extract(connection_json, '$.secretPartition')
                 from connections
                 where connections.id = secret_blobs.connection_id
               ),
               blob_json = json_set(
                 blob_json,
                 '$.kind',
                 (
                   select json_extract(connection_json, '$.secretPartition')
                   from connections
                   where connections.id = secret_blobs.connection_id
                 )
               )
           where exists (
             select 1 from connections
             where connections.id = secret_blobs.connection_id
               and nullif(json_extract(connection_json, '$.secretPartition'), '') is not null
           )`,
        )
        .run();
    },
  },
  {
    version: 35,
    name: "d1_resource_legacy_state_adoption_add",
    checksumSource: `
resource_shapes.state_adoption_json stores only an operator-confirmed one-shot descriptor
candidate reporting is read-only and Resource execution never scans for a legacy Capsule
`,
    async atomicStatements(db) {
      return await d1EnsureColumnStatements(
        db,
        "resource_shapes",
        "state_adoption_json",
        "text",
      );
    },
    async apply(db) {
      if (!(await d1TableExists(db, "resource_shapes"))) return;
      const columns = await d1ColumnNames(db, "resource_shapes");
      if (!columns.has("state_adoption_json")) {
        await db
          .prepare(
            `alter table resource_shapes add column state_adoption_json text`,
          )
          .run();
      }
    },
  },
  {
    version: 36,
    name: "d1_install_config_trust_level_retire",
    checksumSource: `
install_configs no longer stores trust_level
InstallConfig record_json no longer carries trustLevel
Store discovery requires an explicit store.source and trust labels never grant execution authority
`,
    async atomicStatements(db) {
      return await d1InstallConfigsWithoutTrustLevelStatements(db);
    },
    async apply(db) {
      await runD1AtomicSql(
        db,
        await d1InstallConfigsWithoutTrustLevelStatements(db),
      );
    },
  },
  {
    version: 37,
    name: "d1_oss_usage_ledger_clean_cut",
    checksumSource: `
usage_events uses canonical workspace_id and capsule_id columns
usage_events.usd_micros is required and no commercial balance fields remain
OSS commercial account plan subscription balance reservation and recharge tables are retired
`,
    async atomicStatements(db) {
      return [
        ...(await d1UsageEventsCanonicalStatements(db)),
        ...[
          "billing_accounts",
          "plans",
          "space_subscriptions",
          "credit_balances",
          "billing_auto_recharge_attempts",
          "credit_reservations",
        ].map((table) => `drop table if exists ${table}`),
      ];
    },
    permanentlyDroppedTables: [
      "billing_accounts",
      "plans",
      "space_subscriptions",
      "credit_balances",
      "billing_auto_recharge_attempts",
      "credit_reservations",
    ],
    async apply(db) {
      await runD1AtomicSql(db, [
        ...(await d1UsageEventsCanonicalStatements(db)),
        ...[
          "billing_accounts",
          "plans",
          "space_subscriptions",
          "credit_balances",
          "billing_auto_recharge_attempts",
          "credit_reservations",
        ].map((table) => `drop table if exists ${table}`),
      ]);
    },
  },
  {
    version: 38,
    name: "d1_install_config_variable_defaults_normalize",
    checksumSource: `
pre-v1 InstallConfig variablePresentation string defaults are normalized once
reserved service-name strings become explicit Capsule-derived default descriptors
all other strings become literal descriptors and current reads perform no compatibility interpretation
`,
    async atomicPreparedStatements(db) {
      return await d1InstallConfigVariableDefaultStatements(db);
    },
    async apply(db) {
      await normalizeD1InstallConfigVariableDefaults(db);
    },
  },
  {
    version: 39,
    name: "d1_usage_event_rating_status",
    checksumSource: `
usage_events.rating_status is explicit rated or unrated evidence
pre-migration amounts had no explicit host rating authority and are reset to zero/unrated
`,
    async atomicStatements(db) {
      return await d1UsageEventsWithRatingStatusStatements(db);
    },
    async apply(db) {
      await runD1AtomicSql(
        db,
        await d1UsageEventsWithRatingStatusStatements(db),
      );
    },
  },
  {
    version: 40,
    name: "d1_resource_list_keyset_indexes",
    checksumSource: `
Resource and TargetPool public lists use bounded keyset pagination
Space plus created_at plus id indexes serve both first and cursor pages
`,
    async atomicStatements() {
      return [
        `create index if not exists resource_shapes_space_created_id_idx
         on resource_shapes (space_id, created_at, id)`,
        `create index if not exists target_pools_space_created_id_idx
         on target_pools (space_id, created_at, id)`,
      ];
    },
    async apply(db) {
      await db
        .prepare(
          `create index if not exists resource_shapes_space_created_id_idx
           on resource_shapes (space_id, created_at, id)`,
        )
        .run();
      await db
        .prepare(
          `create index if not exists target_pools_space_created_id_idx
           on target_pools (space_id, created_at, id)`,
        )
        .run();
    },
  },
  {
    version: 41,
    name: "d1_resource_event_target_keyset_index",
    checksumSource: `
Resource event reads project one target from the shared Activity ledger
Space plus target_type plus target_id plus created_at plus id serves newest-first keyset pages
`,
    async atomicStatements() {
      return [
        `create index if not exists audit_events_space_target_created_id_idx
         on audit_events (space_id, target_type, target_id, created_at, id)`,
      ];
    },
    async apply(db) {
      await db
        .prepare(
          `create index if not exists audit_events_space_target_created_id_idx
           on audit_events (space_id, target_type, target_id, created_at, id)`,
        )
        .run();
    },
  },
  {
    version: 42,
    name: "d1_resource_observation_schedule_lease",
    checksumSource: `
Scheduled Resource observation uses a durable internal lease and last-attempt timestamp
Ready current-generation candidates are ordered globally without creating another Resource ledger
Abandoned claims expire and exact lease tokens fence completion
`,
    async atomicStatements(db) {
      return await d1ResourceObservationScheduleLeaseStatements(db);
    },
    async apply(db) {
      if (!(await d1TableExists(db, "resource_shapes"))) return;
      const columns = await d1ColumnNames(db, "resource_shapes");
      if (!columns.has("observation_lease_id")) {
        await db
          .prepare(
            `alter table resource_shapes add column observation_lease_id text`,
          )
          .run();
      }
      if (!columns.has("observation_claimed_at")) {
        await db
          .prepare(
            `alter table resource_shapes add column observation_claimed_at text`,
          )
          .run();
      }
      if (!columns.has("last_observation_attempt_at")) {
        await db
          .prepare(
            `alter table resource_shapes add column last_observation_attempt_at text`,
          )
          .run();
      }
      await db
        .prepare(
          `create index if not exists resource_shapes_observation_due_idx
           on resource_shapes (
             phase, last_observation_attempt_at, observation_claimed_at, id
           )`,
        )
        .run();
    },
  },
  {
    version: 43,
    name: "d1_resource_ready_kind_inventory_index",
    checksumSource: `
Host-operated reconciliation reads canonical fully observed Ready Resources by exact kind
Kind plus phase plus created_at plus id bounds the global inventory keyset scan
`,
    async atomicStatements(db) {
      if (!(await d1TableExists(db, "resource_shapes"))) return [];
      return [
        `create index if not exists resource_shapes_ready_kind_created_id_idx
         on resource_shapes (kind, phase, created_at, id)`,
      ];
    },
    async apply(db) {
      if (!(await d1TableExists(db, "resource_shapes"))) return;
      await db
        .prepare(
          `create index if not exists resource_shapes_ready_kind_created_id_idx
           on resource_shapes (kind, phase, created_at, id)`,
        )
        .run();
    },
  },
  {
    version: 44,
    name: "d1_pre_ga_canonical_schema_convergence",
    checksumSource: `
historical request-time bootstrap and ALTER order are converged to one canonical table shape
capsule compatibility normalized artifact pointers are physically removed
resolution lock Resource execution Run StateVersion and Workspace rows and constraints are preserved
named indexes replace equivalent historical inline unique constraints
`,
    async atomicStatements() {
      return D1_PRE_GA_CANONICAL_SCHEMA_CONVERGENCE_STATEMENTS;
    },
    async apply(db) {
      await runD1AtomicSql(
        db,
        D1_PRE_GA_CANONICAL_SCHEMA_CONVERGENCE_STATEMENTS,
      );
    },
  },
  {
    version: 45,
    name: "d1_service_form_registry",
    checksumSource: () => `
optional zero-form-capable Service Form registry
exact package and FormRef identities persist separately from activations
no offering price managed-capacity or Cloud commercial state
${D1_SERVICE_FORM_REGISTRY_STATEMENTS.join("\n---\n")}
`,
    async atomicStatements() {
      return D1_SERVICE_FORM_REGISTRY_STATEMENTS;
    },
    async apply(db) {
      for (const statement of D1_SERVICE_FORM_REGISTRY_STATEMENTS) {
        await db.prepare(statement).run();
      }
    },
  },
  {
    version: 46,
    name: "d1_resource_exact_form_identity_add",
    checksumSource: `
Resource and ResolutionLock store the exact installed FormRef and package digest pair
legacy null/null rows remain readable and discoverable for bounded explicit backfill
partial or invalid exact identities fail closed in durable Resource stores
`,
    async atomicStatements(db) {
      return await d1ResourceExactFormIdentityStatements(db);
    },
    async apply(db) {
      await runD1AtomicSql(db, await d1ResourceExactFormIdentityStatements(db));
    },
  },
  {
    version: 47,
    name: "d1_interface_oauth_resource_claim",
    checksumSource: `
one canonical OAuth resource can be claimed by at most one Interface under the same Workspace owner
the nullable projection is populated only through exact Interface generation revision and record CAS
legacy resolved Interfaces stay unclaimed until Binding refresh issuance or introspection revalidates them
`,
    async atomicStatements(db) {
      if (!(await d1TableExists(db, "interfaces"))) return [];
      const columns = await d1ColumnNames(db, "interfaces");
      return [
        ...(columns.has("oauth_resource_uri")
          ? []
          : [`alter table interfaces add column oauth_resource_uri text`]),
        `create unique index if not exists interfaces_oauth_resource_claim_unique
         on interfaces (workspace_id, owner_kind, owner_id, oauth_resource_uri)
         where oauth_resource_uri is not null`,
      ];
    },
    async apply(db) {
      if (!(await d1TableExists(db, "interfaces"))) return;
      await ensureD1Column(db, "interfaces", "oauth_resource_uri", "text");
      await db
        .prepare(
          `create unique index if not exists interfaces_oauth_resource_claim_unique
           on interfaces (workspace_id, owner_kind, owner_id, oauth_resource_uri)
           where oauth_resource_uri is not null`,
        )
        .run();
    },
  },
  {
    version: 48,
    name: "d1_interface_form_descriptor_lineage",
    checksumSource: `
portable Form descriptor Interfaces project exact FormRef schema and descriptor name version
all four columns remain null for every other Interface materialization source
the immutable Interface record remains authority and the columns are query projections only
`,
    async atomicStatements(db) {
      if (!(await d1TableExists(db, "interfaces"))) return [];
      const columns = await d1ColumnNames(db, "interfaces");
      return [
        ...(columns.has("form_ref_key")
          ? []
          : [`alter table interfaces add column form_ref_key text`]),
        ...(columns.has("form_schema_digest")
          ? []
          : [`alter table interfaces add column form_schema_digest text`]),
        ...(columns.has("descriptor_name")
          ? []
          : [`alter table interfaces add column descriptor_name text`]),
        ...(columns.has("descriptor_version")
          ? []
          : [`alter table interfaces add column descriptor_version text`]),
        `create index if not exists interfaces_form_descriptor_idx
         on interfaces (
           workspace_id, form_ref_key, form_schema_digest,
           descriptor_name, descriptor_version
         ) where form_ref_key is not null`,
      ];
    },
    async apply(db) {
      if (!(await d1TableExists(db, "interfaces"))) return;
      await ensureD1Column(db, "interfaces", "form_ref_key", "text");
      await ensureD1Column(db, "interfaces", "form_schema_digest", "text");
      await ensureD1Column(db, "interfaces", "descriptor_name", "text");
      await ensureD1Column(db, "interfaces", "descriptor_version", "text");
      await db
        .prepare(
          `create index if not exists interfaces_form_descriptor_idx
           on interfaces (
             workspace_id, form_ref_key, form_schema_digest,
             descriptor_name, descriptor_version
           ) where form_ref_key is not null`,
        )
        .run();
    },
  },
  {
    version: 49,
    name: "d1_interface_canonical_table_convergence",
    checksumSource: () => `
historical Interfaces created before v47 and v48 appended projection columns after the record columns
the canonical table order matches the current D1 schema while preserving every Interface and InterfaceBinding row
the complete rebuild index recreation and migration ledger insert execute in one D1 batch transaction
${D1_INTERFACE_CANONICAL_TABLE_CONVERGENCE_STATEMENTS.join("\n---\n")}
`,
    permanentlyDroppedTables: ["interfaces__takosumi_v49"],
    async atomicStatements() {
      return D1_INTERFACE_CANONICAL_TABLE_CONVERGENCE_STATEMENTS;
    },
    async apply(db) {
      await runD1AtomicSql(
        db,
        D1_INTERFACE_CANONICAL_TABLE_CONVERGENCE_STATEMENTS,
      );
    },
  },
] as const satisfies readonly D1OpenTofuSchemaMigration[];

/**
 * v47/v48 added nullable Interface projections with ALTER TABLE on already
 * initialized databases. SQLite appends those columns, while a fresh current
 * database creates them before record_json/created_at/updated_at. The control
 * schema verifier intentionally treats column order as physical authority, so
 * converge the two layouts without changing row values.
 *
 * D1 batch() is the transaction boundary. The reserved temporary table is
 * excluded from maintenance-trigger recreation because it is renamed away
 * before the atomic batch commits; the canonical `interfaces` guard is
 * recreated by the maintenance wrapper.
 */
const D1_INTERFACE_CANONICAL_TABLE_CONVERGENCE_STATEMENTS = [
  `drop table if exists interfaces__takosumi_v49`,
  `create table interfaces__takosumi_v49 (
    id text primary key,
    workspace_id text not null,
    owner_kind text not null,
    owner_id text not null,
    name text not null,
    interface_type text not null,
    phase text not null,
    generation integer not null,
    resolved_revision integer not null,
    oauth_resource_uri text,
    form_ref_key text,
    form_schema_digest text,
    descriptor_name text,
    descriptor_version text,
    record_json text not null,
    created_at text not null,
    updated_at text not null
  )`,
  `insert into interfaces__takosumi_v49 (
     id, workspace_id, owner_kind, owner_id, name, interface_type, phase,
     generation, resolved_revision, oauth_resource_uri, form_ref_key,
     form_schema_digest, descriptor_name, descriptor_version, record_json,
     created_at, updated_at
   )
   select id, workspace_id, owner_kind, owner_id, name, interface_type, phase,
          generation, resolved_revision, oauth_resource_uri, form_ref_key,
          form_schema_digest, descriptor_name, descriptor_version, record_json,
          created_at, updated_at
   from interfaces`,
  `drop table interfaces`,
  `alter table interfaces__takosumi_v49 rename to interfaces`,
  `create unique index interfaces_active_name_unique
     on interfaces (workspace_id, owner_kind, owner_id, name)
     where phase <> 'Retired'`,
  `create index interfaces_workspace_type_phase_idx
     on interfaces (workspace_id, interface_type, phase)`,
  `create unique index interfaces_oauth_resource_claim_unique
     on interfaces (workspace_id, owner_kind, owner_id, oauth_resource_uri)
     where oauth_resource_uri is not null`,
  `create index interfaces_form_descriptor_idx
     on interfaces (
       workspace_id, form_ref_key, form_schema_digest,
       descriptor_name, descriptor_version
     ) where form_ref_key is not null`,
] as const;

/**
 * v1..v24 were historically executed from request-time bootstrap code. Two
 * live databases therefore have an identical immutable migration ledger but
 * different physical CREATE TABLE shapes (ALTER-appended columns and inline
 * UNIQUE constraints). Candidate migration must converge the physical schema,
 * not merely advance the ledger. Every rebuild is data preserving and the
 * complete set, including the v44 ledger insert, is one D1 batch transaction.
 */
const D1_PRE_GA_CANONICAL_SCHEMA_CONVERGENCE_STATEMENTS = [
  `drop table if exists capsule_compatibility_reports__takosumi_v44`,
  `create table capsule_compatibility_reports__takosumi_v44 (
    id text primary key,
    source_id text,
    installation_id text,
    source_snapshot_id text not null,
    level text not null,
    findings_json text not null,
    providers_json text not null,
    resources_json text not null,
    data_sources_json text not null,
    provisioners_json text not null,
    root_module_variables_json text not null default '[]',
    root_module_outputs_json text not null default '[]',
    created_at text not null
  )`,
  `insert into capsule_compatibility_reports__takosumi_v44 (
     id, source_id, installation_id, source_snapshot_id, level,
     findings_json, providers_json, resources_json, data_sources_json,
     provisioners_json, root_module_variables_json, root_module_outputs_json,
     created_at
   ) select id, source_id, installation_id, source_snapshot_id, level,
            findings_json, providers_json, resources_json, data_sources_json,
            provisioners_json, root_module_variables_json,
            root_module_outputs_json, created_at
     from capsule_compatibility_reports`,
  `drop table capsule_compatibility_reports`,
  `alter table capsule_compatibility_reports__takosumi_v44
   rename to capsule_compatibility_reports`,
  `create index capsule_compatibility_reports_source_snapshot_idx
   on capsule_compatibility_reports (source_snapshot_id)`,
  `create index capsule_compatibility_reports_source_idx
   on capsule_compatibility_reports (source_id)`,
  `create index capsule_compatibility_reports_installation_idx
   on capsule_compatibility_reports (installation_id)`,
  `create index capsule_compatibility_reports_level_idx
   on capsule_compatibility_reports (level)`,

  `drop table if exists resolution_locks__takosumi_v44`,
  `create table resolution_locks__takosumi_v44 (
    resource_id text primary key,
    selected_implementation text not null,
    target_pool text,
    target text not null,
    target_snapshot_json text,
    implementation_snapshot_json text,
    implementation_plugin text,
    implementation_options_json text,
    implementation_fingerprint text,
    locked integer not null,
    reason_json text not null,
    portability text,
    native_resources_json text,
    locked_at text not null,
    updated_at text not null
  )`,
  `insert into resolution_locks__takosumi_v44 (
     resource_id, selected_implementation, target_pool, target,
     target_snapshot_json, implementation_snapshot_json,
     implementation_plugin, implementation_options_json,
     implementation_fingerprint, locked, reason_json, portability,
     native_resources_json, locked_at, updated_at
   ) select resource_id, selected_implementation, target_pool, target,
            target_snapshot_json, implementation_snapshot_json,
            implementation_plugin, implementation_options_json,
            implementation_fingerprint, locked, reason_json, portability,
            native_resources_json, locked_at, updated_at
     from resolution_locks`,
  `drop table resolution_locks`,
  `alter table resolution_locks__takosumi_v44 rename to resolution_locks`,

  `drop table if exists resource_shapes__takosumi_v44`,
  `create table resource_shapes__takosumi_v44 (
    id text primary key,
    space_id text not null,
    project text,
    environment text,
    kind text not null,
    name text not null,
    managed_by text not null,
    spec_json text not null,
    phase text not null,
    generation integer not null,
    observed_generation integer not null,
    outputs_json text,
    execution_json text,
    state_adoption_json text,
    conditions_json text,
    labels_json text,
    created_at text not null,
    updated_at text not null,
    observation_lease_id text,
    observation_claimed_at text,
    last_observation_attempt_at text
  )`,
  `insert into resource_shapes__takosumi_v44 (
     id, space_id, project, environment, kind, name, managed_by, spec_json,
     phase, generation, observed_generation, outputs_json, execution_json,
     state_adoption_json, conditions_json, labels_json, created_at, updated_at,
     observation_lease_id, observation_claimed_at,
     last_observation_attempt_at
   ) select id, space_id, project, environment, kind, name, managed_by,
            spec_json, phase, generation, observed_generation, outputs_json,
            execution_json, state_adoption_json, conditions_json, labels_json,
            created_at, updated_at, observation_lease_id,
            observation_claimed_at, last_observation_attempt_at
     from resource_shapes`,
  `drop table resource_shapes`,
  `alter table resource_shapes__takosumi_v44 rename to resource_shapes`,
  `create unique index resource_shapes_space_kind_name_unique
   on resource_shapes (space_id, kind, name)`,
  `create index resource_shapes_space_idx on resource_shapes (space_id)`,
  `create index resource_shapes_space_created_id_idx
   on resource_shapes (space_id, created_at, id)`,
  `create index resource_shapes_ready_kind_created_id_idx
   on resource_shapes (kind, phase, created_at, id)`,
  `create index resource_shapes_observation_due_idx
   on resource_shapes (
     phase, last_observation_attempt_at, observation_claimed_at, id
   )`,

  `drop table if exists runs__takosumi_v44`,
  `create table runs__takosumi_v44 (
    id text primary key,
    run_group_id text,
    space_id text not null,
    source_id text,
    installation_id text,
    environment text,
    type text not null,
    status text not null,
    lease_token text,
    heartbeat_at integer,
    run_json text not null,
    created_at text not null default ""
  )`,
  `insert into runs__takosumi_v44 (
     id, run_group_id, space_id, source_id, installation_id, environment,
     type, status, lease_token, heartbeat_at, run_json, created_at
   ) select id, run_group_id, space_id, source_id, installation_id,
            environment, type, status, lease_token, heartbeat_at, run_json,
            created_at
     from runs`,
  `drop table runs`,
  `alter table runs__takosumi_v44 rename to runs`,
  `create index runs_space_idx on runs (space_id)`,
  `create index runs_source_idx on runs (source_id)`,
  `create index runs_installation_idx on runs (installation_id)`,
  `create index runs_installation_created_at_idx
   on runs (installation_id, created_at)`,
  `create index runs_type_idx on runs (type)`,
  `create index runs_created_at_idx on runs (created_at)`,

  `drop table if exists state_versions__takosumi_v44`,
  `create table state_versions__takosumi_v44 (
    id text primary key,
    space_id text not null,
    installation_id text not null,
    environment text not null,
    generation integer not null,
    object_key text not null,
    digest text not null,
    created_by_run_id text not null,
    created_at text not null
  )`,
  `insert into state_versions__takosumi_v44 (
     id, space_id, installation_id, environment, generation, object_key,
     digest, created_by_run_id, created_at
   ) select id, space_id, installation_id, environment, generation,
            object_key, digest, created_by_run_id, created_at
     from state_versions`,
  `drop table state_versions`,
  `alter table state_versions__takosumi_v44 rename to state_versions`,
  `create unique index state_versions_installation_environment_generation_unique
   on state_versions (installation_id, environment, generation)`,
  `create index state_versions_installation_idx
   on state_versions (installation_id)`,

  `drop table if exists workspaces__takosumi_v44`,
  `create table workspaces__takosumi_v44 (
    id text primary key,
    handle text not null,
    record_json text not null,
    created_at text not null,
    updated_at text not null
  )`,
  `insert into workspaces__takosumi_v44 (
     id, handle, record_json, created_at, updated_at
   ) select id, handle, record_json, created_at, updated_at from workspaces`,
  `drop table workspaces`,
  `alter table workspaces__takosumi_v44 rename to workspaces`,
  `create unique index workspaces_handle_unique on workspaces (handle)`,
] as const;

const D1_WORKSPACE_MEMBERS_CREATE_STATEMENTS = [
  `create table if not exists workspace_members (
    id text primary key,
    workspace_id text not null,
    account_id text not null,
    status text not null,
    record_json text not null,
    created_at text not null,
    updated_at text not null
  )`,
  `create unique index if not exists workspace_members_workspace_account_unique
   on workspace_members (workspace_id, account_id)`,
  `create index if not exists workspace_members_workspace_status_idx
   on workspace_members (workspace_id, status)`,
  `create index if not exists workspace_members_account_status_idx
   on workspace_members (account_id, status)`,
  `insert into workspace_members (
     id, workspace_id, account_id, status, record_json, created_at, updated_at
   )
   select
     'wsm_' || id || '_' || json_extract(record_json, '$.ownerUserId'),
     id,
     json_extract(record_json, '$.ownerUserId'),
     'active',
     json_object(
       'id', 'wsm_' || id || '_' || json_extract(record_json, '$.ownerUserId'),
       'workspaceId', id,
       'accountId', json_extract(record_json, '$.ownerUserId'),
       'roles', json_array('owner'),
       'status', 'active',
       'createdAt', created_at,
       'updatedAt', updated_at
     ),
     created_at,
     updated_at
   from workspaces
   where nullif(json_extract(record_json, '$.ownerUserId'), '') is not null
   on conflict(workspace_id, account_id) do nothing`,
] as const;

async function d1EnsureColumnStatements(
  db: D1Database,
  table: string,
  column: string,
  definition: string,
): Promise<readonly string[]> {
  if (!(await d1TableExists(db, table))) return [];
  const columns = await d1ColumnNames(db, table);
  return columns.has(column)
    ? []
    : [`alter table ${table} add column ${column} ${definition}`];
}

async function d1ResolutionLockIdentityStatements(
  db: D1Database,
): Promise<readonly string[]> {
  const definitions = [
    ["target_pool", "text"],
    ["target_snapshot_json", "text"],
    ["implementation_snapshot_json", "text"],
    ["implementation_plugin", "text"],
    ["implementation_options_json", "text"],
    ["implementation_fingerprint", "text"],
  ] as const;
  const statements: string[] = [];
  for (const [column, definition] of definitions) {
    statements.push(
      ...(await d1EnsureColumnStatements(
        db,
        "resolution_locks",
        column,
        definition,
      )),
    );
  }
  return statements;
}

async function d1CompatibilityAutoRewriteRetireStatements(
  db: D1Database,
): Promise<readonly string[]> {
  const columns = await d1ColumnNames(db, "capsule_compatibility_reports");
  if (columns.size === 0) return [];
  const clearsLegacyPointers =
    columns.has("normalized_object_key") && columns.has("normalized_digest");
  return [
    clearsLegacyPointers
      ? `update capsule_compatibility_reports
         set level = 'ready',
             normalized_object_key = null,
             normalized_digest = null
         where level = 'auto_capsulized'`
      : `update capsule_compatibility_reports
         set level = 'ready'
         where level = 'auto_capsulized'`,
    `update capsules
     set record_json = json_set(
       record_json,
       '$.compatibilityStatus',
       'ready'
     )
     where json_extract(record_json, '$.compatibilityStatus') = 'auto_capsulized'`,
  ];
}

async function d1ConnectionSecretPartitionBackfillStatements(
  db: D1Database,
): Promise<readonly string[]> {
  if (!(await d1TableExists(db, "connections"))) return [];
  const statements = [
    `update connections
     set connection_json = json_set(
       connection_json,
       '$.secretPartition',
       case
         when json_extract(connection_json, '$.kind') in ('source_git_https_token', 'source_git_ssh_key')
           then 'source:git'
         when lower(coalesce(json_extract(connection_json, '$.providerSource'), json_extract(connection_json, '$.provider'), provider)) = 'cloudflare'
           or lower(coalesce(json_extract(connection_json, '$.providerSource'), json_extract(connection_json, '$.provider'), provider)) like '%/cloudflare/cloudflare'
           then 'cloudflare'
         when lower(coalesce(json_extract(connection_json, '$.providerSource'), json_extract(connection_json, '$.provider'), provider)) = 'aws'
           or lower(coalesce(json_extract(connection_json, '$.providerSource'), json_extract(connection_json, '$.provider'), provider)) like '%/hashicorp/aws'
           then 'aws'
         when lower(coalesce(json_extract(connection_json, '$.providerSource'), json_extract(connection_json, '$.provider'), provider)) in ('google', 'gcp')
           or lower(coalesce(json_extract(connection_json, '$.providerSource'), json_extract(connection_json, '$.provider'), provider)) like '%/hashicorp/google'
           or lower(coalesce(json_extract(connection_json, '$.providerSource'), json_extract(connection_json, '$.provider'), provider)) like '%/hashicorp/google-beta'
           then 'gcp'
         when lower(coalesce(json_extract(connection_json, '$.providerSource'), json_extract(connection_json, '$.provider'), provider)) in ('kubernetes', 'helm')
           or lower(coalesce(json_extract(connection_json, '$.providerSource'), json_extract(connection_json, '$.provider'), provider)) like '%/hashicorp/kubernetes'
           or lower(coalesce(json_extract(connection_json, '$.providerSource'), json_extract(connection_json, '$.provider'), provider)) like '%/hashicorp/helm'
           then 'k8s'
         else 'local-adapters'
       end
     )
     where nullif(json_extract(connection_json, '$.secretPartition'), '') is null`,
  ];
  if (await d1TableExists(db, "secret_blobs")) {
    statements.push(
      `update secret_blobs
       set kind = (
             select json_extract(connection_json, '$.secretPartition')
             from connections
             where connections.id = secret_blobs.connection_id
           ),
           blob_json = json_set(
             blob_json,
             '$.kind',
             (
               select json_extract(connection_json, '$.secretPartition')
               from connections
               where connections.id = secret_blobs.connection_id
             )
           )
       where exists (
         select 1 from connections
         where connections.id = secret_blobs.connection_id
           and nullif(json_extract(connection_json, '$.secretPartition'), '') is not null
       )`,
    );
  }
  return statements;
}

async function d1InstallConfigVariableDefaultStatements(
  db: D1Database,
): Promise<readonly D1PreparedStatement[]> {
  if (!(await d1TableExists(db, "install_configs"))) return [];
  const rows = await db
    .prepare(`select id, record_json from install_configs`)
    .all<{ readonly id: string; readonly record_json: string }>();
  const statements: D1PreparedStatement[] = [];
  for (const row of rows.results ?? []) {
    const normalized = normalizedInstallConfigVariableDefaults(row);
    if (normalized === null) continue;
    statements.push(
      db
        .prepare(`update install_configs set record_json = ? where id = ?`)
        .bind(normalized, row.id),
    );
  }
  return statements;
}

function normalizedInstallConfigVariableDefaults(row: {
  readonly id: string;
  readonly record_json: string;
}): string | null {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(row.record_json) as Record<string, unknown>;
  } catch {
    throw new Error(`InstallConfig ${row.id} contains invalid JSON`);
  }
  const presentation = record.variablePresentation;
  if (!Array.isArray(presentation)) return null;
  let changed = false;
  const normalized = presentation.map((entry) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      typeof (entry as { readonly defaultValue?: unknown }).defaultValue !==
        "string"
    ) {
      return entry;
    }
    changed = true;
    const value = (entry as { readonly defaultValue: string }).defaultValue;
    const defaultValue =
      value === "service-name"
        ? { source: "capsule_name" }
        : value === "service-name-with-workspace" ||
            value === "service-name-with-space"
          ? { source: "workspace_scoped_capsule_name" }
          : { source: "literal", value };
    return { ...entry, defaultValue };
  });
  return changed
    ? JSON.stringify({ ...record, variablePresentation: normalized })
    : null;
}

async function d1ResourceObservationScheduleLeaseStatements(
  db: D1Database,
): Promise<readonly string[]> {
  if (!(await d1TableExists(db, "resource_shapes"))) return [];
  const columns = await d1ColumnNames(db, "resource_shapes");
  const statements: string[] = [];
  if (!columns.has("observation_lease_id")) {
    statements.push(
      `alter table resource_shapes add column observation_lease_id text`,
    );
  }
  if (!columns.has("observation_claimed_at")) {
    statements.push(
      `alter table resource_shapes add column observation_claimed_at text`,
    );
  }
  if (!columns.has("last_observation_attempt_at")) {
    statements.push(
      `alter table resource_shapes add column last_observation_attempt_at text`,
    );
  }
  statements.push(
    `create index if not exists resource_shapes_observation_due_idx
     on resource_shapes (
       phase, last_observation_attempt_at, observation_claimed_at, id
     )`,
  );
  return statements;
}

async function d1ResourceExactFormIdentityStatements(
  db: D1Database,
): Promise<readonly string[]> {
  const statements: string[] = [];
  if (await d1TableExists(db, "resource_shapes")) {
    const columns = await d1ColumnNames(db, "resource_shapes");
    if (!columns.has("form_ref_json")) {
      statements.push(
        `alter table resource_shapes add column form_ref_json text`,
      );
    }
    if (!columns.has("package_digest")) {
      statements.push(
        `alter table resource_shapes add column package_digest text`,
      );
    }
    statements.push(
      `create index if not exists resource_shapes_unpinned_form_kind_id_idx
       on resource_shapes (kind, id) where form_ref_json is null`,
      `create trigger if not exists resource_shapes_form_identity_pair_insert
       before insert on resource_shapes
       when (new.form_ref_json is null) <> (new.package_digest is null)
       begin
         select raise(abort, 'Resource form identity must be a complete pair');
       end`,
      `create trigger if not exists resource_shapes_form_identity_pair_update
       before update of form_ref_json, package_digest on resource_shapes
       when (new.form_ref_json is null) <> (new.package_digest is null)
       begin
         select raise(abort, 'Resource form identity must be a complete pair');
       end`,
    );
  }
  if (await d1TableExists(db, "resolution_locks")) {
    const columns = await d1ColumnNames(db, "resolution_locks");
    if (!columns.has("form_ref_json")) {
      statements.push(
        `alter table resolution_locks add column form_ref_json text`,
      );
    }
    if (!columns.has("package_digest")) {
      statements.push(
        `alter table resolution_locks add column package_digest text`,
      );
    }
    statements.push(
      `create index if not exists resolution_locks_unpinned_form_resource_idx
       on resolution_locks (resource_id) where form_ref_json is null`,
      `create trigger if not exists resolution_locks_form_identity_pair_insert
       before insert on resolution_locks
       when (new.form_ref_json is null) <> (new.package_digest is null)
       begin
         select raise(abort, 'ResolutionLock form identity must be a complete pair');
       end`,
      `create trigger if not exists resolution_locks_form_identity_pair_update
       before update of form_ref_json, package_digest on resolution_locks
       when (new.form_ref_json is null) <> (new.package_digest is null)
       begin
         select raise(abort, 'ResolutionLock form identity must be a complete pair');
       end`,
    );
  }
  return statements;
}

async function normalizeD1InstallConfigVariableDefaults(
  db: D1Database,
): Promise<void> {
  if (!(await d1TableExists(db, "install_configs"))) return;
  const rows = await db
    .prepare(`select id, record_json from install_configs`)
    .all<{ readonly id: string; readonly record_json: string }>();
  for (const row of rows.results ?? []) {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(row.record_json) as Record<string, unknown>;
    } catch {
      throw new Error(`InstallConfig ${row.id} contains invalid JSON`);
    }
    const presentation = record.variablePresentation;
    if (!Array.isArray(presentation)) continue;
    let changed = false;
    const normalized = presentation.map((entry) => {
      if (
        !entry ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        typeof (entry as { readonly defaultValue?: unknown }).defaultValue !==
          "string"
      ) {
        return entry;
      }
      changed = true;
      const value = (entry as { readonly defaultValue: string }).defaultValue;
      const defaultValue =
        value === "service-name"
          ? { source: "capsule_name" }
          : value === "service-name-with-workspace" ||
              value === "service-name-with-space"
            ? { source: "workspace_scoped_capsule_name" }
            : { source: "literal", value };
      return { ...entry, defaultValue };
    });
    if (!changed) continue;
    await db
      .prepare(`update install_configs set record_json = ? where id = ?`)
      .bind(
        JSON.stringify({ ...record, variablePresentation: normalized }),
        row.id,
      )
      .run();
  }
}

/**
 * P4 helper: rename a D1 column only when the legacy column exists and the
 * target does not (idempotent on fresh / already-migrated databases, no-op when
 * the table is absent).
 */
async function renameD1ColumnIfNeeded(
  db: D1Database,
  table: string,
  from: string,
  to: string,
): Promise<void> {
  if (!(await d1TableExists(db, table))) return;
  const columns = await d1ColumnNames(db, table);
  if (columns.has(from) && !columns.has(to)) {
    await db
      .prepare(`alter table ${table} rename column ${from} to ${to}`)
      .run();
  }
}

/**
 * P4 helper: rename a top-level key inside a JSON text column (replacement
 * semantics — set the new key from the old value, then drop the old key). Only
 * rows that actually carry the legacy key are touched, so it is idempotent and a
 * no-op once converged (or when the table is absent).
 */
async function renameD1JsonKey(
  db: D1Database,
  table: string,
  fromKey: string,
  toKey: string,
  column = "record_json",
): Promise<void> {
  if (!(await d1TableExists(db, table))) return;
  await db
    .prepare(
      `update ${table}
       set ${column} = json_remove(
         json_set(${column}, '$.${toKey}', json_extract(${column}, '$.${fromKey}')),
         '$.${fromKey}'
       )
       where json_extract(${column}, '$.${fromKey}') is not null`,
    )
    .run();
}

async function ensureD1SchemaMigrationLedger(db: D1Database): Promise<void> {
  await db
    .prepare(
      `create table if not exists schema_migrations (
      version integer primary key,
      name text not null,
      checksum text not null,
      applied_at text not null
    )`,
    )
    .run();
  assertD1SchemaMigrationLedgerShape(
    await d1ColumnInfo(db, "schema_migrations"),
  );
  await validateD1SchemaMigrationLedgerRows(db);
}

function assertD1SchemaMigrationLedgerShape(
  rows: readonly D1TableInfoRow[],
): void {
  const info = new Map(rows.map((row) => [row.name, row]));
  const version = info.get("version");
  const name = info.get("name");
  const checksum = info.get("checksum");
  const appliedAt = info.get("applied_at");
  if (
    !version ||
    version.pk !== 1 ||
    d1ColumnType(version) !== "integer" ||
    !name ||
    name.notnull !== 1 ||
    d1ColumnType(name) !== "text" ||
    !checksum ||
    checksum.notnull !== 1 ||
    d1ColumnType(checksum) !== "text" ||
    !appliedAt ||
    appliedAt.notnull !== 1 ||
    d1ColumnType(appliedAt) !== "text"
  ) {
    throw new Error(
      "D1 OpenTofu schema_migrations table does not match the canonical ledger shape",
    );
  }
}

type D1SchemaMigrationRow = {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly applied_at: string;
};

/**
 * Strict read-only readiness check for hosts that predeploy the OSS control
 * schema. Unlike {@link ensureD1OpenTofuLedgerSchema}, this function never
 * executes DDL or data migration. It requires the complete current migration
 * catalog with exact names/checksums before any store query is allowed.
 */
export async function verifyD1OpenTofuLedgerSchemaPredeployed(
  db: D1Database,
): Promise<void> {
  let rows: readonly D1SchemaMigrationRow[];
  try {
    assertD1SchemaMigrationLedgerShape(
      await d1ColumnInfo(db, "schema_migrations"),
    );
    const result = await db
      .prepare(
        `select version, name, checksum, applied_at
         from schema_migrations
         order by version`,
      )
      .all<D1SchemaMigrationRow>();
    rows = result.results ?? [];
  } catch {
    throw new Error("D1 OpenTofu predeployed schema verification failed");
  }

  if (rows.length !== D1_OPEN_TOFU_SCHEMA_MIGRATIONS.length) {
    throw new Error("D1 OpenTofu predeployed schema verification failed");
  }
  for (
    let index = 0;
    index < D1_OPEN_TOFU_SCHEMA_MIGRATIONS.length;
    index += 1
  ) {
    const migration = D1_OPEN_TOFU_SCHEMA_MIGRATIONS[index];
    const row = rows[index];
    if (
      !migration ||
      !row ||
      row.version !== migration.version ||
      row.name !== migration.name ||
      row.checksum !== (await d1OpenTofuSchemaMigrationChecksum(migration))
    ) {
      throw new Error("D1 OpenTofu predeployed schema verification failed");
    }
  }
}

async function validateD1SchemaMigrationLedgerRows(
  db: D1Database,
): Promise<void> {
  const rows = await db
    .prepare(
      `select version, name, checksum, applied_at
      from schema_migrations
      order by version`,
    )
    .all<D1SchemaMigrationRow>();
  const knownMigrations: ReadonlyMap<number, D1OpenTofuSchemaMigration> =
    new Map(
      D1_OPEN_TOFU_SCHEMA_MIGRATIONS.map((migration) => [
        migration.version,
        migration,
      ]),
    );
  for (const row of rows.results ?? []) {
    const migration = knownMigrations.get(row.version);
    if (!migration) {
      throw new Error(
        `D1 OpenTofu schema migration ${row.version} is not present in the current migration catalog`,
      );
    }
    if (row.name !== migration.name) {
      throw new Error(
        `D1 OpenTofu schema migration ${row.version} name mismatch: ledger has ${row.name}, code has ${migration.name}`,
      );
    }
  }
}

async function applyD1OpenTofuSchemaMigration(
  db: D1Database,
  migration: D1OpenTofuSchemaMigration,
): Promise<void> {
  const checksum = await d1OpenTofuSchemaMigrationChecksum(migration);
  const existing = await db
    .prepare(
      `select version, name, checksum, applied_at
      from schema_migrations
      where version = ?`,
    )
    .bind(migration.version)
    .first<D1SchemaMigrationRow>();
  if (existing) {
    if (existing.name !== migration.name) {
      throw new Error(
        `D1 OpenTofu schema migration ${migration.version} name mismatch: ledger has ${existing.name}, code has ${migration.name}`,
      );
    }
    if (existing.checksum !== checksum) {
      throw new Error(
        `D1 OpenTofu schema migration ${migration.version} checksum mismatch: ledger has ${existing.checksum}, code has ${checksum}`,
      );
    }
    return;
  }

  const ledgerInsert = db
    .prepare(
      `insert into schema_migrations (version, name, checksum, applied_at)
      values (?, ?, ?, ?)`,
    )
    .bind(
      migration.version,
      migration.name,
      checksum,
      new Date().toISOString(),
    );
  if (migration.atomicStatements || migration.atomicPreparedStatements) {
    const atomicSql = migration.atomicStatements
      ? await migration.atomicStatements(db)
      : undefined;
    const migrationStatements = migration.atomicPreparedStatements
      ? await migration.atomicPreparedStatements(db)
      : atomicSql!.map((statement) => db.prepare(statement));
    let batch: readonly D1PreparedStatement[] = [
      ...migrationStatements,
      ledgerInsert,
    ];
    const fence = await activeControlD1MaintenanceFence(db);
    if (fence) {
      batch = await wrapControlD1MaintenanceMigrationBatch(db, fence, batch, {
        permanentlyDroppedTables: new Set(
          migration.permanentlyDroppedTables ?? [],
        ),
        newlyCreatedTables: atomicSql
          ? d1TablesCreatedByAtomicSql(atomicSql)
          : new Set(),
      });
    }
    await runD1AtomicStatements(db, batch);
    return;
  }

  if (migration.version >= 24 && (await activeControlD1MaintenanceFence(db))) {
    throw new Error(
      `D1 OpenTofu schema migration ${migration.version} is not atomic under the maintenance fence`,
    );
  }

  await migration.apply(db);
  await ledgerInsert.run();
}

function d1TablesCreatedByAtomicSql(
  statements: readonly string[],
): ReadonlySet<string> {
  const created = new Set<string>();
  for (const statement of statements) {
    for (const match of statement.matchAll(
      /\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?(?:"([a-z_][a-z0-9_]*)"|([a-z_][a-z0-9_]*))/giu,
    )) {
      const table = (match[1] ?? match[2])?.toLowerCase();
      if (table) created.add(table);
    }
    for (const match of statement.matchAll(
      /\balter\s+table\s+(?:"([a-z_][a-z0-9_]*)"|([a-z_][a-z0-9_]*))\s+rename\s+to\s+(?:"([a-z_][a-z0-9_]*)"|([a-z_][a-z0-9_]*))/giu,
    )) {
      const from = (match[1] ?? match[2])?.toLowerCase();
      const to = (match[3] ?? match[4])?.toLowerCase();
      if (from && to && created.delete(from)) created.add(to);
    }
    for (const match of statement.matchAll(
      /\bdrop\s+table\s+(?:if\s+exists\s+)?(?:"([a-z_][a-z0-9_]*)"|([a-z_][a-z0-9_]*))/giu,
    )) {
      const table = (match[1] ?? match[2])?.toLowerCase();
      if (table) created.delete(table);
    }
  }
  return created;
}

async function d1OpenTofuSchemaMigrationChecksum(
  migration: D1OpenTofuSchemaMigration,
): Promise<string> {
  const checksumSource =
    typeof migration.checksumSource === "function"
      ? migration.checksumSource()
      : migration.checksumSource;
  return await sha256Digest(
    `${migration.version}\n${migration.name}\n${checksumSource.trim()}\n`,
  );
}

const D1_PROVIDER_MATERIALIZATION_CANONICALIZATION_STATEMENTS = [
  `update provider_catalog
          set primary_materialization = case
            when primary_materialization in ('takosumi_managed','gateway') then 'secret'
            when primary_materialization = 'user_env_set' then 'secret'
            when primary_materialization in ('oauth','secret') then primary_materialization
            else 'secret'
          end
          where primary_materialization not in ('oauth','secret')
             or primary_materialization = 'gateway'`,
  `delete from provider_envs
          where space_id is null`,
  `update provider_envs
          set materialization = case
            when materialization in ('takosumi_managed','user_env_set','gateway') then 'secret'
            when materialization in ('oauth','secret') then materialization
            else 'secret'
          end
          where materialization not in ('oauth','secret')
             or materialization = 'gateway'`,
] as const;

const D1_PROVIDER_CATALOG_OWNERSHIP_REPAIR_STATEMENTS = [
  `update provider_catalog
          set primary_materialization = 'secret',
              gateway_eligible = 0
          where primary_materialization <> 'secret'
             or gateway_eligible <> 0`,
] as const;

// Historical checksum source for migration 9. Do not add new indexes here:
// live ledgers already store this migration checksum. New indexes belong in the
// initial ensure-DDL tail and in a new additive migration.
const D1_OPEN_TOFU_CANONICAL_INDEX_STATEMENTS = [
  `create unique index if not exists spaces_handle_unique
      on spaces (handle)`,
  `create index if not exists sources_space_idx
      on sources (space_id)`,
  `create index if not exists sources_status_idx
      on sources (status)`,
  `create index if not exists source_snapshots_source_idx
      on source_snapshots (source_id)`,
  `create index if not exists connections_space_idx
      on connections (space_id)`,
  `create index if not exists connections_provider_idx
      on connections (provider)`,
  `create index if not exists connections_status_idx
      on connections (status)`,
  `create unique index if not exists secret_blobs_connection_idx
      on secret_blobs (connection_id)`,
  `create index if not exists provider_envs_space_idx
      on provider_envs (space_id)`,
  `create index if not exists provider_envs_provider_source_idx
      on provider_envs (provider_source)`,
  `create index if not exists provider_envs_materialization_idx
      on provider_envs (materialization)`,
  `create index if not exists provider_envs_status_idx
      on provider_envs (status)`,
  `create unique index if not exists provider_catalog_source_unique
      on provider_catalog (provider_source)`,
  `create index if not exists provider_catalog_primary_materialization_idx
      on provider_catalog (primary_materialization)`,
  `create index if not exists provider_catalog_gateway_eligible_idx
      on provider_catalog (gateway_eligible)`,
  `create index if not exists install_configs_space_idx
      on install_configs (space_id)`,
  `create index if not exists install_configs_install_type_idx
      on install_configs (install_type)`,
  `create unique index if not exists installations_space_name_environment_unique
      on installations (space_id, name, environment)`,
  `create index if not exists installations_space_idx
      on installations (space_id)`,
  `create index if not exists installations_current_deployment_idx
      on installations (current_deployment_id)`,
  `create index if not exists capsule_compatibility_reports_source_snapshot_idx
      on capsule_compatibility_reports (source_snapshot_id)`,
  `create index if not exists capsule_compatibility_reports_source_idx
      on capsule_compatibility_reports (source_id)`,
  `create index if not exists capsule_compatibility_reports_installation_idx
      on capsule_compatibility_reports (installation_id)`,
  `create index if not exists capsule_compatibility_reports_level_idx
      on capsule_compatibility_reports (level)`,
  `create unique index if not exists provider_env_binding_sets_installation_environment_unique
      on provider_env_binding_sets (installation_id, environment)`,
  `create index if not exists provider_env_binding_sets_installation_idx
      on provider_env_binding_sets (installation_id)`,
  `create index if not exists runs_space_idx
      on runs (space_id)`,
  `create index if not exists runs_source_idx
      on runs (source_id)`,
  `create index if not exists runs_installation_idx
      on runs (installation_id)`,
  `create index if not exists runs_installation_created_at_idx
      on runs (installation_id, created_at)`,
  `create index if not exists runs_type_idx
      on runs (type)`,
  `create index if not exists runs_created_at_idx
      on runs (created_at)`,
  `create unique index if not exists state_snapshots_installation_environment_generation_unique
      on state_snapshots (installation_id, environment, generation)`,
  `create index if not exists state_snapshots_installation_idx
      on state_snapshots (installation_id)`,
  `create index if not exists deployments_space_idx
      on deployments (space_id)`,
  `create index if not exists deployments_installation_idx
      on deployments (installation_id)`,
  `create index if not exists deployments_apply_idx
      on deployments (apply_run_id)`,
  `create index if not exists artifacts_run_idx
      on artifacts (run_id)`,
  `create index if not exists installation_dependencies_space_idx
      on installation_dependencies (space_id)`,
  `create index if not exists installation_dependencies_consumer_idx
      on installation_dependencies (consumer_installation_id)`,
  `create index if not exists installation_dependencies_producer_idx
      on installation_dependencies (producer_installation_id)`,
  `create index if not exists dependency_snapshots_run_idx
      on dependency_snapshots (run_id)`,
  `create index if not exists output_snapshots_installation_idx
      on output_snapshots (installation_id)`,
  `create index if not exists output_shares_from_space_idx
      on output_shares (from_space_id)`,
  `create index if not exists output_shares_to_space_idx
      on output_shares (to_space_id)`,
  `create index if not exists output_shares_producer_idx
      on output_shares (producer_installation_id)`,
  `create index if not exists run_groups_space_idx
      on run_groups (space_id)`,
  `create index if not exists audit_events_space_idx
      on audit_events (space_id)`,
  `create index if not exists audit_events_space_target_created_id_idx
      on audit_events (space_id, target_type, target_id, created_at, id)`,
  `create index if not exists credential_mint_events_run_idx
      on credential_mint_events (run_id)`,
  `create index if not exists credential_mint_events_space_idx
      on credential_mint_events (space_id)`,
  `create index if not exists credential_mint_events_source_idx
      on credential_mint_events (source_id)`,
  `create index if not exists security_findings_space_idx
      on security_findings (space_id)`,
  `create index if not exists security_findings_run_idx
      on security_findings (run_id)`,
  `create index if not exists security_findings_severity_idx
      on security_findings (severity)`,
  `create index if not exists usage_events_workspace_idx
      on usage_events (workspace_id)`,
  `create index if not exists usage_events_run_idx
      on usage_events (run_id)`,
  `create unique index if not exists usage_events_idempotency_key_unique
      on usage_events (idempotency_key)`,
  `create index if not exists backups_space_idx
      on backups (space_id)`,
  `create index if not exists backups_installation_idx
      on backups (installation_id)`,
] as const;

async function ensureD1OpenTofuCanonicalIndexes(db: D1Database): Promise<void> {
  for (const statement of D1_OPEN_TOFU_CANONICAL_INDEX_STATEMENTS) {
    // P4: this historical index-parity pass names the pre-rename tables
    // (spaces / installations / state_snapshots / output_snapshots). On a fresh
    // post-rename DB those tables are created under their final names, so the
    // legacy-named target is absent — skip it rather than CREATE INDEX on a
    // missing table. The canonical NEW-name indexes are created by the
    // ensure-DDL index tail. (The statement strings — and thus this migration's
    // checksumSource — are unchanged, so already-migrated ledgers stay stable.)
    const tableName = parseD1CreateIndexTable(statement);
    if (!(await d1TableExists(db, tableName))) continue;
    const tableColumns = await d1ColumnNames(db, tableName);
    const indexColumns = parseD1CreateIndexColumns(statement);
    if (indexColumns.some((column) => !tableColumns.has(column))) continue;
    const indexName = parseD1CreateIndexName(statement);
    await db.prepare(`drop index if exists ${indexName}`).run();
    await db.prepare(statement).run();
  }
}

function parseD1CreateIndexName(statement: string): string {
  const match = /\bindex\s+if\s+not\s+exists\s+([a-z_][a-z0-9_]*)\b/i.exec(
    statement,
  );
  if (!match) {
    throw new Error(`Unable to parse D1 index name from: ${statement}`);
  }
  return match[1];
}

function parseD1CreateIndexTable(statement: string): string {
  const match = /\bon\s+([a-z_][a-z0-9_]*)\s*\(/i.exec(statement);
  if (!match) {
    throw new Error(`Unable to parse D1 index target table from: ${statement}`);
  }
  return match[1];
}

function parseD1CreateIndexColumns(statement: string): readonly string[] {
  const match = /\bon\s+[a-z_][a-z0-9_]*\s*\(([^)]+)\)/i.exec(statement);
  if (!match) {
    throw new Error(`Unable to parse D1 index columns from: ${statement}`);
  }
  return match[1].split(",").map((column) => column.trim());
}

async function sha256Digest(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

async function migrateD1SecretBlobsShape(db: D1Database): Promise<void> {
  const columns = await d1ColumnNames(db, "secret_blobs");
  if (columns.has("id")) return;
  await db
    .prepare(`alter table secret_blobs rename to secret_blobs_legacy`)
    .run();
  await db
    .prepare(
      `create table secret_blobs (
      id text primary key,
      connection_id text not null,
      space_id text,
      kind text not null,
      ciphertext text not null,
      encrypted_dek text not null,
      nonce text not null,
      aad text not null,
      key_version integer not null,
      created_at text not null,
      rotated_at text,
      blob_json text not null
    )`,
    )
    .run();
  await db
    .prepare(
      `insert into secret_blobs (
      id,
      connection_id,
      space_id,
      kind,
      ciphertext,
      encrypted_dek,
      nonce,
      aad,
      key_version,
      created_at,
      rotated_at,
      blob_json
    )
    select
      'secret_' || connection_id,
      connection_id,
      null,
      'static_secret',
      json_extract(blob_json, '$.ciphertext'),
      coalesce(json_extract(blob_json, '$.encryptedDek'), json_extract(blob_json, '$.keyVersion'), 'legacy'),
      coalesce(json_extract(blob_json, '$.nonce'), json_extract(blob_json, '$.iv'), ''),
      case
        when json_type(json_extract(blob_json, '$.aad')) = 'object' then json(json_extract(blob_json, '$.aad'))
        else coalesce(json_extract(blob_json, '$.aad'), '{}')
      end,
      coalesce(json_extract(blob_json, '$.keyVersion'), 1),
      coalesce(json_extract(blob_json, '$.createdAt'), '1970-01-01T00:00:00.000Z'),
      json_extract(blob_json, '$.rotatedAt'),
      blob_json
    from secret_blobs_legacy`,
    )
    .run();
  await db
    .prepare(
      `create unique index if not exists secret_blobs_connection_idx on secret_blobs (connection_id)`,
    )
    .run();
  await db.prepare(`drop table secret_blobs_legacy`).run();
}

async function ensureD1Column(
  db: D1Database,
  table: string,
  column: string,
  definition: string,
): Promise<void> {
  const names = await d1ColumnNames(db, table);
  if (names.has(column)) return;
  await db
    .prepare(`alter table ${table} add column ${column} ${definition}`)
    .run();
}

async function ensureD1ProviderCatalogTable(db: D1Database): Promise<void> {
  await db
    .prepare(
      `create table if not exists provider_catalog (
        id text primary key,
        provider_source text not null,
        primary_materialization text not null check (primary_materialization in ('oauth','secret')),
        gateway_eligible integer not null,
        record_json text not null,
        created_at text not null,
        updated_at text not null
      )`,
    )
    .run();
  if (await d1TableExists(db, "provider_templates")) {
    await db
      .prepare(
        `insert or ignore into provider_catalog
          (id, provider_source, primary_materialization, gateway_eligible, record_json, created_at, updated_at)
          select
            id,
            provider_source,
            case
              when primary_credential_source in ('takosumi_managed','gateway') then 'secret'
              when primary_credential_source = 'user_env_set' then 'secret'
              when primary_credential_source in ('oauth','secret') then primary_credential_source
              else 'secret'
            end,
            0,
            record_json,
            created_at,
            updated_at
            from provider_templates`,
      )
      .run();
    await db
      .prepare(`drop index if exists provider_templates_source_unique`)
      .run();
    await db
      .prepare(
        `drop index if exists provider_templates_primary_credential_source_idx`,
      )
      .run();
    await db
      .prepare(`drop index if exists provider_templates_default_eligible_idx`)
      .run();
    await db.prepare(`drop table if exists provider_templates`).run();
  }
  await db
    .prepare(
      `create unique index if not exists provider_catalog_source_unique
        on provider_catalog (provider_source)`,
    )
    .run();
  await db
    .prepare(
      `create index if not exists provider_catalog_primary_materialization_idx
        on provider_catalog (primary_materialization)`,
    )
    .run();
  await db
    .prepare(
      `create index if not exists provider_catalog_gateway_eligible_idx
        on provider_catalog (gateway_eligible)`,
    )
    .run();
}

async function rebuildD1ProviderCatalogWithConstraints(
  db: D1Database,
): Promise<void> {
  await db.prepare(`drop index if exists provider_catalog_source_unique`).run();
  await db
    .prepare(
      `drop index if exists provider_catalog_primary_materialization_idx`,
    )
    .run();
  await db
    .prepare(`drop index if exists provider_catalog_gateway_eligible_idx`)
    .run();
  await db
    .prepare(`alter table provider_catalog rename to provider_catalog_v9`)
    .run();
  await db
    .prepare(
      `create table provider_catalog (
        id text primary key,
        provider_source text not null,
        primary_materialization text not null check (primary_materialization in ('oauth','secret')),
        gateway_eligible integer not null check (gateway_eligible in (0,1)),
        record_json text not null,
        created_at text not null,
        updated_at text not null
      )`,
    )
    .run();
  await db
    .prepare(
      `insert into provider_catalog
        (id, provider_source, primary_materialization, gateway_eligible, record_json, created_at, updated_at)
      select
        id,
        provider_source,
        case
          when primary_materialization in ('takosumi_managed','gateway') then 'secret'
          when primary_materialization = 'user_env_set' then 'secret'
          when primary_materialization in ('oauth','secret') then primary_materialization
          else 'secret'
        end,
        0,
        record_json,
        created_at,
        updated_at
      from provider_catalog_v9`,
    )
    .run();
  await db.prepare(`drop table provider_catalog_v9`).run();
}

async function rebuildD1ProviderEnvsWithConstraints(
  db: D1Database,
): Promise<void> {
  await db.prepare(`drop index if exists provider_envs_space_idx`).run();
  await db
    .prepare(`drop index if exists provider_envs_provider_source_idx`)
    .run();
  await db
    .prepare(`drop index if exists provider_envs_materialization_idx`)
    .run();
  await db.prepare(`drop index if exists provider_envs_status_idx`).run();
  await db
    .prepare(`alter table provider_envs rename to provider_envs_v9`)
    .run();
  await db
    .prepare(
      `create table provider_envs (
        id text primary key,
        space_id text not null,
        provider_source text not null,
        materialization text not null check (materialization in ('oauth','secret')),
        status text not null,
        record_json text not null,
        created_at text not null,
        updated_at text not null
      )`,
    )
    .run();
  await db
    .prepare(
      `insert into provider_envs
        (id, space_id, provider_source, materialization, status, record_json, created_at, updated_at)
      select
        id,
        space_id,
        provider_source,
        case
          when materialization in ('takosumi_managed','user_env_set','gateway') then 'secret'
          when materialization in ('oauth','secret') then materialization
          else 'secret'
        end,
        status,
        record_json,
        created_at,
        updated_at
      from provider_envs_v9
      where space_id is not null`,
    )
    .run();
  await db.prepare(`drop table provider_envs_v9`).run();
}

async function d1TableExists(db: D1Database, table: string): Promise<boolean> {
  const result = await db
    .prepare(`select name from sqlite_master where type = 'table' and name = ?`)
    .bind(table)
    .first<{ name?: string }>();
  return result?.name === table;
}

async function d1ColumnNames(
  db: D1Database,
  table: string,
): Promise<Set<string>> {
  const rows = await d1ColumnInfo(db, table);
  return new Set(
    rows
      .map((row) => row.name)
      .filter((name): name is string => typeof name === "string"),
  );
}

type D1TableInfoRow = {
  readonly name?: string;
  readonly type?: string;
  readonly notnull?: number;
  readonly pk?: number;
};

function d1ColumnType(row: D1TableInfoRow): string {
  return (row.type ?? "").toLowerCase();
}

async function d1ColumnInfo(
  db: D1Database,
  table: string,
): Promise<readonly D1TableInfoRow[]> {
  const result = await db
    .prepare(`pragma table_info(${table})`)
    .all<D1TableInfoRow>();
  return result.results ?? [];
}

/**
 * D1 `batch()` executes the statements as one transaction. Destructive table
 * rebuilds must use this helper so a transport failure cannot strand the
 * database between copy/drop/rename steps or expose a partial schema to a
 * concurrent request.
 */
async function runD1AtomicSql(
  db: D1Database,
  statements: readonly string[],
): Promise<void> {
  await runD1AtomicStatements(
    db,
    statements.map((statement) => db.prepare(statement)),
  );
}

async function runD1AtomicStatements(
  db: D1Database,
  statements: readonly D1PreparedStatement[],
): Promise<void> {
  if (statements.length === 0) return;
  if (!db.batch) {
    throw new Error("D1 atomic schema migration requires batch support");
  }
  const results = await db.batch(statements);
  if (
    results.length !== statements.length ||
    results.some((result) => result.success === false)
  ) {
    throw new Error("D1 atomic schema rebuild failed");
  }
}

async function d1UsageEventsCanonicalStatements(
  db: D1Database,
): Promise<readonly string[]> {
  const columns = await d1ColumnNames(db, "usage_events");
  if (columns.size === 0) return [];
  if (
    columns.has("workspace_id") &&
    columns.has("capsule_id") &&
    !columns.has("space_id") &&
    !columns.has("installation_id")
  ) {
    return [];
  }
  return [
    `drop table if exists usage_events__current`,
    `create table usage_events__current (
        id text primary key,
        workspace_id text not null,
        capsule_id text,
        run_id text,
        meter_id text,
        resource_family text,
        resource_id text,
        operation text,
        resource_metadata_json text,
        kind text not null,
        quantity real not null,
        usd_micros integer not null,
        source text not null,
        idempotency_key text not null,
        created_at text not null
      )`,
    `insert into usage_events__current (
        id, workspace_id, capsule_id, run_id, meter_id, resource_family,
        resource_id, operation, resource_metadata_json, kind, quantity,
        usd_micros, source, idempotency_key, created_at
      )
      select id, space_id, installation_id, run_id, meter_id, resource_family,
             resource_id, operation, resource_metadata_json, kind, quantity,
             usd_micros, source, idempotency_key, created_at
      from usage_events
      where usd_micros is not null`,
    `drop table usage_events`,
    `alter table usage_events__current rename to usage_events`,
    `create index if not exists usage_events_workspace_idx
       on usage_events (workspace_id)`,
    `create index if not exists usage_events_run_idx
       on usage_events (run_id)`,
    `create unique index if not exists usage_events_idempotency_key_unique
       on usage_events (idempotency_key)`,
  ];
}

async function d1UsageEventsWithRatingStatusStatements(
  db: D1Database,
): Promise<readonly string[]> {
  if (!(await d1TableExists(db, "usage_events"))) return [];
  const columns = await d1ColumnNames(db, "usage_events");
  if (columns.has("rating_status")) return [];
  return [
    `drop table if exists usage_events__rated`,
    `create table usage_events__rated (
        id text primary key,
        workspace_id text not null,
        capsule_id text,
        run_id text,
        meter_id text,
        resource_family text,
        resource_id text,
        operation text,
        resource_metadata_json text,
        kind text not null,
        quantity real not null,
        usd_micros integer not null,
        rating_status text not null
          check (
            rating_status in ('rated', 'unrated')
            and (rating_status = 'rated' or usd_micros = 0)
          ),
        source text not null,
        idempotency_key text not null,
        created_at text not null
      )`,
    `insert into usage_events__rated (
        id, workspace_id, capsule_id, run_id, meter_id, resource_family,
        resource_id, operation, resource_metadata_json, kind, quantity,
        usd_micros, rating_status, source, idempotency_key, created_at
      )
      select id, workspace_id, capsule_id, run_id, meter_id, resource_family,
             resource_id, operation, resource_metadata_json, kind, quantity,
             0, 'unrated', source, idempotency_key, created_at
      from usage_events`,
    `drop table usage_events`,
    `alter table usage_events__rated rename to usage_events`,
    `create index if not exists usage_events_workspace_idx
       on usage_events (workspace_id)`,
    `create index if not exists usage_events_run_idx
       on usage_events (run_id)`,
    `create unique index if not exists usage_events_idempotency_key_unique
       on usage_events (idempotency_key)`,
  ];
}

async function d1InstallConfigsWithoutInstallTypeStatements(
  db: D1Database,
): Promise<readonly string[]> {
  const columns = await d1ColumnNames(db, "install_configs");
  if (!columns.has("install_type")) return [];
  return [
    `drop table if exists install_configs__current`,
    `create table install_configs__current (
        id text primary key,
        space_id text,
        trust_level text not null,
        record_json text not null,
        created_at text not null,
        updated_at text not null
      )`,
    `insert into install_configs__current
        (id, space_id, trust_level, record_json, created_at, updated_at)
       select id,
              space_id,
              trust_level,
              json_remove(record_json, '$.installType', '$.sourceKind', '$.templateBinding'),
              created_at,
              updated_at
       from install_configs`,
    `drop table install_configs`,
    `alter table install_configs__current rename to install_configs`,
    `create index if not exists install_configs_space_idx
       on install_configs (space_id)`,
  ];
}

async function d1InstallConfigsWithoutTrustLevelStatements(
  db: D1Database,
): Promise<readonly string[]> {
  const columns = await d1ColumnNames(db, "install_configs");
  if (!columns.has("trust_level")) return [];
  return [
    `drop table if exists install_configs__current`,
    `create table install_configs__current (
        id text primary key,
        space_id text,
        record_json text not null,
        created_at text not null,
        updated_at text not null
      )`,
    `insert into install_configs__current
        (id, space_id, record_json, created_at, updated_at)
       select id,
              space_id,
              json_remove(record_json, '$.trustLevel'),
              created_at,
              updated_at
       from install_configs`,
    `drop table install_configs`,
    `alter table install_configs__current rename to install_configs`,
    `create index if not exists install_configs_space_idx
       on install_configs (space_id)`,
  ];
}

async function d1CapsulesWithoutInstallTypeStatements(
  db: D1Database,
): Promise<readonly string[]> {
  const columns = await d1ColumnNames(db, "capsules");
  if (!columns.has("install_type")) return [];
  return [
    `drop table if exists capsules__current`,
    `create table capsules__current (
        id text primary key,
        space_id text not null,
        project_id text,
        name text not null,
        slug text not null,
        source_id text,
        install_config_id text not null,
        environment text not null,
        current_state_version_id text,
        current_state_generation integer not null default 0,
        current_output_snapshot_id text,
        status text not null,
        record_json text not null,
        created_at text not null,
        updated_at text not null
      )`,
    `insert into capsules__current
        (id, space_id, project_id, name, slug, source_id, install_config_id,
         environment, current_state_version_id, current_state_generation,
         current_output_snapshot_id, status, record_json, created_at, updated_at)
       select id,
              space_id,
              project_id,
              name,
              slug,
              source_id,
              install_config_id,
              environment,
              current_state_version_id,
              current_state_generation,
              current_output_snapshot_id,
              status,
              json_remove(record_json, '$.installType'),
              created_at,
              updated_at
       from capsules`,
    `drop table capsules`,
    `alter table capsules__current rename to capsules`,
    `create unique index if not exists capsules_space_name_environment_active_unique
       on capsules (space_id, name, environment)
       where status != 'destroyed'`,
    `create index if not exists capsules_space_idx on capsules (space_id)`,
    `create index if not exists capsules_project_idx on capsules (project_id)`,
    `create index if not exists capsules_current_state_version_idx
       on capsules (current_state_version_id)`,
  ];
}

async function d1CapsulesWithRequiredProjectStatements(
  db: D1Database,
): Promise<readonly string[]> {
  if (!(await d1TableExists(db, "capsules"))) return [];
  if (
    !(await d1TableExists(db, "projects")) ||
    !(await d1TableExists(db, "workspaces"))
  ) {
    throw new Error(
      "cannot enforce Capsule Project boundary: Project or Workspace storage is absent",
    );
  }
  const info = await d1ColumnInfo(db, "capsules");
  const projectId = info.find((column) => column.name === "project_id");
  if (!projectId) {
    throw new Error(
      "cannot enforce Capsule Project boundary: project_id is absent",
    );
  }

  const ensureDefaultProjects = `insert into projects
       (id, workspace_id, name, slug, record_json, created_at, updated_at)
       select
         'prj_default_' || w.id,
         w.id,
         'Default',
         'default',
         json_object(
           'id', 'prj_default_' || w.id,
           'workspaceId', w.id,
           'name', 'Default',
           'slug', 'default',
           'projectJson', json_object(),
           'createdAt', w.created_at,
           'updatedAt', w.updated_at
         ),
         w.created_at,
         w.updated_at
       from workspaces w
       where exists (
         select 1 from capsules c
         where c.space_id = w.id and c.project_id is null
       )
         and not exists (
           select 1 from projects p
           where p.id = 'prj_default_' || w.id
         )`;
  const backfill = `update capsules
       set project_id = 'prj_default_' || space_id
       where project_id is null
         and exists (
           select 1 from projects p
           where p.id = 'prj_default_' || capsules.space_id
         )`;

  if (projectId.notnull === 1) {
    return [
      ensureDefaultProjects,
      backfill,
      `drop index if exists capsules_space_name_environment_active_unique`,
      `create unique index if not exists capsules_project_name_environment_active_unique
         on capsules (project_id, name, environment)
         where status != 'destroyed'`,
    ];
  }

  return [
    ensureDefaultProjects,
    backfill,
    `drop table if exists capsules__project_current`,
    `create table capsules__project_current (
        id text primary key,
        space_id text not null,
        project_id text not null,
        name text not null,
        slug text not null,
        source_id text,
        install_config_id text not null,
        environment text not null,
        current_state_version_id text,
        current_state_generation integer not null default 0,
        current_output_snapshot_id text,
        status text not null,
        record_json text not null,
        created_at text not null,
        updated_at text not null
      )`,
    `insert into capsules__project_current
        (id, space_id, project_id, name, slug, source_id, install_config_id,
         environment, current_state_version_id, current_state_generation,
         current_output_snapshot_id, status, record_json, created_at, updated_at)
       select id,
              space_id,
              project_id,
              name,
              slug,
              source_id,
              install_config_id,
              environment,
              current_state_version_id,
              current_state_generation,
              current_output_snapshot_id,
              status,
              json_set(record_json, '$.projectId', project_id),
              created_at,
              updated_at
       from capsules`,
    `drop table capsules`,
    `alter table capsules__project_current rename to capsules`,
    `create unique index if not exists capsules_project_name_environment_active_unique
       on capsules (project_id, name, environment)
       where status != 'destroyed'`,
    `create index if not exists capsules_space_idx on capsules (space_id)`,
    `create index if not exists capsules_project_idx on capsules (project_id)`,
    `create index if not exists capsules_current_state_version_idx
       on capsules (current_state_version_id)`,
  ];
}

async function rebuildConnectionsTableIfNeeded(db: D1Database): Promise<void> {
  const info = await d1ColumnInfo(db, "connections");
  const spaceId = info.find((row) => row.name === "space_id");
  if (!spaceId || spaceId.notnull !== 1) return;
  await db
    .prepare(
      `create table connections__takosumi_migrate (
	      id text primary key,
	      space_id text,
	      provider text not null,
	      status text not null,
	      connection_json text not null,
	      created_at text not null,
	      updated_at text not null
	    )`,
    )
    .run();
  await db
    .prepare(
      `insert into connections__takosumi_migrate
	      (id, space_id, provider, status, connection_json, created_at, updated_at)
	      select id,
	             space_id,
	             coalesce(json_extract(record_json, '$.provider'), ''),
	             status,
	             record_json,
	             created_at,
	             updated_at
	      from connections`,
    )
    .run();
  await db.prepare(`drop table connections`).run();
  await db
    .prepare(`alter table connections__takosumi_migrate rename to connections`)
    .run();
}

async function migrateD1ConnectionsJsonShape(db: D1Database): Promise<void> {
  const columns = await d1ColumnNames(db, "connections");
  if (columns.has("connection_json") && columns.has("provider")) return;
  await db
    .prepare(
      `create table connections__takosumi_json_migrate (
      id text primary key,
      space_id text,
      provider text not null,
      status text not null,
      connection_json text not null,
      created_at text not null,
      updated_at text not null
    )`,
    )
    .run();
  const jsonColumn = columns.has("connection_json")
    ? "connection_json"
    : "record_json";
  const providerExpression = columns.has("provider")
    ? "provider"
    : `coalesce(json_extract(${jsonColumn}, '$.provider'), '')`;
  await db
    .prepare(
      `insert into connections__takosumi_json_migrate
      (id, space_id, provider, status, connection_json, created_at, updated_at)
      select id,
             space_id,
             ${providerExpression},
             status,
             ${jsonColumn},
             created_at,
             updated_at
      from connections`,
    )
    .run();
  await db.prepare(`drop table connections`).run();
  await db
    .prepare(
      `alter table connections__takosumi_json_migrate rename to connections`,
    )
    .run();
}

async function rebuildRunsTableIfNeeded(db: D1Database): Promise<void> {
  const info = await d1ColumnInfo(db, "runs");
  const byName = new Map(info.map((row) => [row.name, row]));
  if (
    byName.get("installation_id")?.notnull !== 1 &&
    byName.get("environment")?.notnull !== 1
  ) {
    return;
  }
  const hasSourceId = byName.has("source_id");
  const hasLeaseToken = byName.has("lease_token");
  const hasHeartbeatAt = byName.has("heartbeat_at");
  await db
    .prepare(
      `create table runs__takosumi_migrate (
      id text primary key,
      run_group_id text,
      space_id text not null,
      source_id text,
      installation_id text,
      environment text,
      type text not null,
      status text not null,
      lease_token text,
      heartbeat_at integer,
      run_json text not null,
      created_at text not null default ""
    )`,
    )
    .run();
  await db
    .prepare(
      `insert into runs__takosumi_migrate
      (id, run_group_id, space_id, source_id, installation_id, environment, type, status, lease_token, heartbeat_at, run_json, created_at)
      select id, run_group_id, space_id, ${hasSourceId ? "source_id" : "null"}, installation_id, environment, type, status, ${hasLeaseToken ? "lease_token" : "null"}, ${hasHeartbeatAt ? "heartbeat_at" : "null"}, run_json, created_at
      from runs`,
    )
    .run();
  await db.prepare(`drop table runs`).run();
  await db.prepare(`alter table runs__takosumi_migrate rename to runs`).run();
}

async function rebuildSourceSnapshotsTableIfNeeded(
  db: D1Database,
): Promise<void> {
  const info = await d1ColumnInfo(db, "source_snapshots");
  const sourceId = info.find((row) => row.name === "source_id");
  if (!sourceId || sourceId.notnull !== 1) return;
  await db
    .prepare(`drop table if exists source_snapshots__takosumi_migrate`)
    .run();
  await db
    .prepare(
      `create table source_snapshots__takosumi_migrate (
      id text primary key,
      source_id text,
      record_json text not null,
      fetched_at text not null
    )`,
    )
    .run();
  await db
    .prepare(
      `insert into source_snapshots__takosumi_migrate
      (id, source_id, record_json, fetched_at)
      select id, source_id, record_json, fetched_at
      from source_snapshots`,
    )
    .run();
  await db.prepare(`drop table source_snapshots`).run();
  await db
    .prepare(
      `alter table source_snapshots__takosumi_migrate rename to source_snapshots`,
    )
    .run();
  await db
    .prepare(
      `create index if not exists source_snapshots_source_idx
      on source_snapshots (source_id)`,
    )
    .run();
}

async function rebuildInstallationsTableIfNeeded(
  db: D1Database,
): Promise<void> {
  const info = await d1ColumnInfo(db, "installations");
  const sourceId = info.find((row) => row.name === "source_id");
  if (!sourceId || sourceId.notnull !== 1) return;
  const columns = await d1ColumnNames(db, "installations");
  const hasCurrentOutputId = columns.has("current_output_snapshot_id");
  await db
    .prepare(`drop table if exists installations__takosumi_migrate`)
    .run();
  await db
    .prepare(
      `create table installations__takosumi_migrate (
      id text primary key,
      space_id text not null,
      name text not null,
      slug text not null,
      source_id text,
      install_type text not null,
      install_config_id text not null,
      environment text not null,
      current_deployment_id text,
      current_state_generation integer not null default 0,
      current_output_snapshot_id text,
      status text not null,
      record_json text not null,
      created_at text not null,
      updated_at text not null
    )`,
    )
    .run();
  await db
    .prepare(
      `insert into installations__takosumi_migrate
      (id, space_id, name, slug, source_id, install_type, install_config_id, environment, current_deployment_id, current_state_generation, current_output_snapshot_id, status, record_json, created_at, updated_at)
      select id,
             space_id,
             name,
             slug,
             source_id,
             install_type,
             install_config_id,
             environment,
             current_deployment_id,
             current_state_generation,
             ${hasCurrentOutputId ? "current_output_snapshot_id" : "null"},
             status,
             record_json,
             created_at,
             updated_at
      from installations`,
    )
    .run();
  await db.prepare(`drop table installations`).run();
  await db
    .prepare(
      `alter table installations__takosumi_migrate rename to installations`,
    )
    .run();
  await db
    .prepare(
      `create unique index if not exists installations_space_name_environment_active_unique
      on installations (space_id, name, environment)
      where status != 'destroyed'`,
    )
    .run();
  await db
    .prepare(
      `create index if not exists installations_space_idx
      on installations (space_id)`,
    )
    .run();
  await db
    .prepare(
      `create index if not exists installations_current_deployment_idx
      on installations (current_deployment_id)`,
    )
    .run();
}

/**
 * Back-fill source-scoped `source_sync` runs into the `runs.source_id` column,
 * matching the Postgres ledger migration v42 step
 * (`deploy.takosumi_d1_schema_projection_columns.create`).
 *
 * Before the Source-scoped ledger split, `source_sync` rows were written with
 * the source id stored in `installation_id` (and `run_json.sourceId`). The D1
 * column-add path (`ensureD1Column` / `rebuildRunsTableIfNeeded`) only
 * materializes the `source_id` column; it never normalizes those legacy rows.
 * This normalizes every historical row before current readers use the canonical
 * `source_id` key, exactly like Postgres v42. Current read paths have no retired
 * `installation_id == sourceId` fallback.
 *
 * Idempotent: the `source_id is null` guard means re-running is a no-op once a
 * row has been normalized. Mirrors the Postgres
 * `set source_id = coalesce(run_json->>'sourceId', installation_id), installation_id = null`
 * semantics with the SQLite `json_extract(run_json, '$.sourceId')` accessor.
 */
async function backfillD1SourceScopedRuns(db: D1Database): Promise<void> {
  await db
    .prepare(
      `update runs
      set source_id = coalesce(json_extract(run_json, '$.sourceId'), installation_id),
          installation_id = null
      where type = ?
        and source_id is null`,
    )
    .bind(RUN_KIND_SOURCE_SYNC)
    .run();
}

function publicHostReservationFromD1Row(
  row: Record<string, unknown> | null,
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
