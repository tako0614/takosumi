/**
 * D1-backed control-plane ledger (core-spec.md §27) — Space-direct Installation
 * model.
 *
 * This is the Cloudflare D1 backend of {@link OpenTofuDeploymentStore}. It
 * materializes the §27 logical schema as real per-entity tables (`spaces`,
 * `sources`, `source_snapshots`, `connections`, `secret_blobs`,
 * `provider_envs`, `install_configs`, `installations`,
 * `provider_env_binding_sets`, `runs`, `state_snapshots`, `deployments`,
 * `artifacts`) created lazily with `CREATE TABLE IF NOT EXISTS` on first use
 * (the schema-init promise is memoized per store instance).
 *
 * Several contract types carry more fields than the §27 columns (the internal
 * PlanRun / ApplyRun records especially, plus Connection / Source which extend
 * the public row with internal-only data). For those rows the store populates
 * the §27-named indexed columns it filters/sorts on AND a `record_json` /
 * `run_json` TEXT column holding the full contract shape, so a put/get round-trip
 * is exact while list/read paths stay column-indexed. The store never stores
 * secret plaintext: the sealed `secret_blobs` ciphertext is the only credential
 * material, kept off every list path.
 *
 * worker/ is outside the tsc include scope; this file is exercised by
 * `core/domains/deploy-control/store_{sources,connections}_test.ts`
 * through the shared {@link OpenTofuDeploymentStore} contract and bundled by the
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
  Connection,
  Deployment,
  InstallConfig,
  Installation,
  PlanRun,
  RunnerProfile,
  StateSnapshot,
} from "@takosumi/internal/deploy-control-api";
import type {
  Source,
  SourceSnapshot,
  SourceSyncRun,
} from "takosumi-contract/sources";
import type { CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import type { Workspace as Space } from "takosumi-contract/workspaces";
import type { InstallationProviderEnvBindingSet } from "takosumi-contract/connections";
import type {
  Dependency,
  DependencySnapshot,
} from "takosumi-contract/dependencies";
import type {
  OutputShare,
  Output as OutputSnapshot,
} from "takosumi-contract/outputs";
import type { ArtifactRecord, Run, RunGroup } from "takosumi-contract/runs";
import type { ActivityEvent } from "takosumi-contract/activity";
import {
  clampPageLimit,
  decodeCursor,
  type Page,
  type PageParams,
  pageFromProbe,
  pageFromProbeBy,
} from "takosumi-contract/pagination";
import type { BackupRecord } from "takosumi-contract/backups";
import type {
  BillingAccount,
  BillingAutoRechargeAttempt,
  BillingPlan,
  CreditBalance,
  CreditReservation,
  SpaceSubscription,
  UsageEvent,
} from "takosumi-contract/billing";
import { legacyCreditsToUsdMicros } from "takosumi-contract/billing";
import type {
  CredentialMintEvent,
  SecurityFinding,
} from "takosumi-contract/security";
import type {
  CommitAppliedDeploymentInput,
  CommitAppliedDeploymentResult,
  CommitRestoredStateInput,
  CommitRestoredStateResult,
  InstallationPatch,
  InstallationPatchGuard,
  OpenTofuDeploymentStore,
  PlanRunInputs,
  PutUsageEventAndSpendCreditsResult,
  RecoverableOpenTofuRunListOptions,
  StoredRunRecord,
  StoredSecretBlob,
  StoredSource,
  ClaimBillingAutoRechargeAttemptInput,
  ClaimBillingAutoRechargeAttemptResult,
  CapsuleListPageParams,
  CreditAmountInput,
  SettleBillingAutoRechargeAttemptInput,
  SettleBillingAutoRechargeAttemptResult,
  TransitionRunInput,
  TransitionRunResult,
} from "../../core/domains/deploy-control/store.ts";
import {
  clampActivityLimit,
  clampRecoverableOpenTofuRunListLimit,
  clampRunListLimit,
  compareStoredRunRecordsAsc,
  InstallationPatchGuardConflict,
  InstallationStateGenerationGuardConflict,
  isRecoverableOpenTofuRunRecord,
} from "../../core/domains/deploy-control/store.ts";
import {
  artifactRecordFromRow,
  coerceRunRowStatus,
  creditAmountUsdMicros,
  creditBalanceFromRow,
  legacyStorageCreditsFromUsdMicros,
  normalizeBillingAutoRechargeAttempt,
  normalizeBillingPlan,
  normalizeCreditBalance,
  normalizeCreditReservation,
  normalizeInstallationRecord,
  normalizeOptionalInstallationRecord,
  normalizeOptionalSourceSnapshotRecord,
  normalizeSourceSnapshotRecord,
  normalizeUsageEvent,
  usageEventFromRow,
  usageResourceMetadataFromRow,
  workspaceKeyOf,
} from "../../core/domains/deploy-control/store_row_mappers.ts";
import * as schema from "../../core/adapters/storage/drizzle/schema/d1.ts";
import type { D1Database, D1Result } from "./bindings.ts";

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
const RUN_KIND_BACKUP = "backup" as const;
const RUN_KIND_RESTORE = "restore" as const;

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

export class CloudflareD1OpenTofuDeploymentStore implements OpenTofuDeploymentStore {
  readonly #orm: DrizzleD1Database<typeof schema>;
  #initialized?: Promise<void>;

  constructor(private readonly db: D1Database) {
    this.#orm = drizzle(db, { schema });
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

  // -- Provider Catalog ------------------------------------------------------

  // -- Runs (PlanRun / ApplyRun / SourceSyncRun share the §27 `runs` table) ----

  async putPlanRun(run: PlanRun): Promise<PlanRun> {
    await this.#putRun({
      id: run.id,
      runGroupId: null,
      spaceId: run.workspaceId ?? run.spaceId,
      installationId: run.installationId ?? null,
      environment: run.installationContext?.environment ?? null,
      type: planRunType(run),
      status: run.status,
      runJson: JSON.stringify(run),
    });
    return run;
  }

  async getPlanRun(id: string): Promise<PlanRun | undefined> {
    return coerceRunRowStatus(
      await this.#getRun<PlanRun>(id, [
        RUN_KIND_PLAN,
        "destroy_plan",
        "drift_check",
      ]),
    );
  }

  async putApplyRun(run: ApplyRun): Promise<ApplyRun> {
    await this.#putRun({
      id: run.id,
      runGroupId: null,
      spaceId: run.workspaceId ?? run.spaceId,
      installationId: run.installationId ?? null,
      environment: null,
      type: applyRunType(run),
      status: run.status,
      runJson: JSON.stringify(run),
    });
    return run;
  }

  async getApplyRun(id: string): Promise<ApplyRun | undefined> {
    return coerceRunRowStatus(
      await this.#getRun<ApplyRun>(id, [RUN_KIND_APPLY, "destroy_apply"]),
    );
  }

  /**
   * Status-conditional, lease-fenced compare-and-set transition (same {won, run}
   * contract as the SQL store). A single conditional UPDATE fences on `id`,
   * `type` (the run family), `status ∈ expectFrom`, and — when set —
   * `lease_token = expectLeaseToken`, so a concurrent claimer that already moved
   * the row loses deterministically. On a win the status / run_json advance to
   * `input.run`; `setLeaseToken` / `clearLeaseToken` / `clearHeartbeat` /
   * `heartbeatAt` write the lease and heartbeat columns. A lost race (0 rows
   * changed) re-reads the current row and returns it with `won: false`.
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
      spaceId: run.spaceId,
      sourceId: run.sourceId,
      installationId: null,
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
      spaceId: run.spaceId,
      sourceId: run.sourceId ?? null,
      installationId: null,
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

  async putBackupRun(run: Run): Promise<Run> {
    if (run.type !== RUN_KIND_BACKUP && run.type !== "restore") {
      throw new Error("putBackupRun only accepts backup/restore runs");
    }
    await this.#putRun({
      id: run.id,
      runGroupId: run.runGroupId ?? null,
      spaceId: run.spaceId,
      sourceId: run.sourceId ?? null,
      installationId: run.installationId ?? null,
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

  async listRunsBySpace(
    spaceId: string,
    options: { readonly limit?: number } = {},
  ): Promise<readonly StoredRunRecord[]> {
    const limit = clampRunListLimit(options.limit);
    return await this.#drizzleManyJson<StoredRunRecord>(
      schema.runs,
      schema.runs.runJson,
      {
        where: eq(schema.runs.spaceId, spaceId),
        orderBy: [desc(d1RunCreatedAtMillisOrder()), desc(schema.runs.id)],
        limit,
      },
    );
  }

  async listRecoverableOpenTofuRuns(
    options: RecoverableOpenTofuRunListOptions,
  ): Promise<readonly StoredRunRecord[]> {
    const rows = await this.#drizzleManyJson<StoredRunRecord>(
      schema.runs,
      schema.runs.runJson,
      {
        where: and(
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
    const currentRows = await this.#drizzleManyJson<SourceSyncRun>(
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
    const legacyRows = await this.#drizzleManyJson<SourceSyncRun>(
      schema.runs,
      schema.runs.runJson,
      {
        where: and(
          eq(schema.runs.type, RUN_KIND_SOURCE_SYNC),
          eq(schema.runs.installationId, sourceId),
        ),
        orderBy: [asc(schema.runs.createdAt), asc(schema.runs.id)],
      },
    );
    const byId = new Map<string, SourceSyncRun>();
    for (const row of [...currentRows, ...legacyRows]) byId.set(row.id, row);
    return [...byId.values()].sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  }

  // -- Artifact ledger (§30 artifacts) ---------------------------------------

  async putArtifactRecord(record: ArtifactRecord): Promise<ArtifactRecord> {
    await this.#drizzleUpsert(schema.artifacts, {
      id: record.id,
      runId: record.runId,
      kind: record.kind,
      objectKey: record.objectKey,
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
      schema.runsInputs,
      {
        planRunId: inputs.planRunId,
        inputsJson: inputs,
      },
      {
        inputsJson: inputs,
      },
      schema.runsInputs.planRunId,
    );
  }

  async getPlanRunInputs(
    planRunId: string,
  ): Promise<PlanRunInputs | undefined> {
    return await this.#drizzleFirstJson<PlanRunInputs>(
      schema.runsInputs,
      schema.runsInputs.inputsJson,
      eq(schema.runsInputs.planRunId, planRunId),
    );
  }

  async deletePlanRunInputs(planRunId: string): Promise<void> {
    await this.#drizzleDelete(
      schema.runsInputs,
      eq(schema.runsInputs.planRunId, planRunId),
    );
  }

  // -- Space ------------------------------------------------------------------

  async putSpace(space: Space): Promise<Space> {
    await this.#drizzleUpsert(schema.spaces, {
      id: space.id,
      handle: space.handle,
      recordJson: space,
      createdAt: space.createdAt,
      updatedAt: space.updatedAt,
    });
    return space;
  }

  async getSpace(id: string): Promise<Space | undefined> {
    return await this.#drizzleFirstJson<Space>(
      schema.spaces,
      schema.spaces.recordJson,
      eq(schema.spaces.id, id),
    );
  }

  async listSpacesByIds(ids: readonly string[]): Promise<readonly Space[]> {
    if (ids.length === 0) return [];
    const rows = await this.#drizzleManyJson<Space>(
      schema.spaces,
      schema.spaces.recordJson,
      { where: inArray(schema.spaces.id, [...new Set(ids)]) },
    );
    const byId = new Map(rows.map((row) => [row.id, row] as const));
    return ids
      .map((id) => byId.get(id))
      .filter((row): row is Space => row !== undefined);
  }

  async getSpaceByHandle(handle: string): Promise<Space | undefined> {
    return await this.#drizzleFirstJson<Space>(
      schema.spaces,
      schema.spaces.recordJson,
      eq(schema.spaces.handle, handle),
    );
  }

  async listSpaces(): Promise<readonly Space[]> {
    return await this.#drizzleManyJson<Space>(
      schema.spaces,
      schema.spaces.recordJson,
      { orderBy: [asc(schema.spaces.createdAt), asc(schema.spaces.id)] },
    );
  }

  async listSpacesByOwner(ownerUserId: string): Promise<readonly Space[]> {
    return await this.#drizzleManyJson<Space>(
      schema.spaces,
      schema.spaces.recordJson,
      {
        where: sql`${schema.spaces.recordJson} ->> 'ownerUserId' = ${ownerUserId}`,
        orderBy: [asc(schema.spaces.createdAt), asc(schema.spaces.id)],
      },
    );
  }

  // -- InstallConfig ----------------------------------------------------------

  async putInstallConfig(config: InstallConfig): Promise<InstallConfig> {
    await this.#drizzleUpsert(schema.installConfigs, {
      id: config.id,
      spaceId: config.spaceId ?? null,
      installType: config.installType,
      trustLevel: config.trustLevel,
      recordJson: config,
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
    });
    return config;
  }

  async getInstallConfig(id: string): Promise<InstallConfig | undefined> {
    return await this.#drizzleFirstJson<InstallConfig>(
      schema.installConfigs,
      schema.installConfigs.recordJson,
      eq(schema.installConfigs.id, id),
    );
  }

  async listInstallConfigs(
    spaceId?: string,
  ): Promise<readonly InstallConfig[]> {
    return await this.#drizzleManyJson<InstallConfig>(
      schema.installConfigs,
      schema.installConfigs.recordJson,
      {
        where:
          spaceId === undefined
            ? undefined
            : eq(schema.installConfigs.spaceId, spaceId),
        orderBy: [
          asc(schema.installConfigs.createdAt),
          asc(schema.installConfigs.id),
        ],
      },
    );
  }

  // -- Installation -----------------------------------------------------------

  async putInstallation(installation: Installation): Promise<Installation> {
    const normalized = normalizeInstallationRecord(installation);
    await this.#drizzleUpsert(schema.installations, {
      id: normalized.id,
      spaceId: normalized.workspaceId,
      name: normalized.name,
      slug: normalized.slug,
      sourceId: normalized.sourceId ?? null,
      installType: normalized.installType,
      installConfigId: normalized.installConfigId,
      environment: normalized.environment,
      currentDeploymentId: normalized.currentDeploymentId ?? null,
      currentStateGeneration: normalized.currentStateGeneration,
      currentOutputSnapshotId: normalized.currentOutputSnapshotId ?? null,
      status: normalized.status,
      recordJson: normalized,
      createdAt: normalized.createdAt,
      updatedAt: normalized.updatedAt,
    });
    return normalized;
  }

  async getInstallation(id: string): Promise<Installation | undefined> {
    return normalizeOptionalInstallationRecord(
      await this.#drizzleFirstJson<Installation>(
        schema.installations,
        schema.installations.recordJson,
        eq(schema.installations.id, id),
      ),
    );
  }

  async getInstallationByName(
    spaceId: string,
    name: string,
    environment: string,
  ): Promise<Installation | undefined> {
    return normalizeOptionalInstallationRecord(
      await this.#drizzleFirstJson<Installation>(
        schema.installations,
        schema.installations.recordJson,
        and(
          eq(schema.installations.spaceId, spaceId),
          eq(schema.installations.name, name),
          eq(schema.installations.environment, environment),
        ),
      ),
    );
  }

  async listInstallations(spaceId?: string): Promise<readonly Installation[]> {
    return (
      await this.#drizzleManyJson<Installation>(
        schema.installations,
        schema.installations.recordJson,
        {
          where:
            spaceId === undefined
              ? undefined
              : eq(schema.installations.spaceId, spaceId),
          orderBy: [
            asc(schema.installations.createdAt),
            asc(schema.installations.id),
          ],
        },
      )
    ).map(normalizeInstallationRecord);
  }

  async listInstallationsPage(
    spaceId: string,
    params: CapsuleListPageParams,
  ): Promise<Page<Installation>> {
    const limit = clampPageLimit(params.limit);
    const baseWhere =
      params.includeDestroyed === false
        ? and(
            eq(schema.installations.spaceId, spaceId),
            ne(schema.installations.status, "destroyed"),
          )
        : eq(schema.installations.spaceId, spaceId);
    const rows = await this.#drizzleManyJson<Installation>(
      schema.installations,
      schema.installations.recordJson,
      {
        where: d1KeysetWhere(
          baseWhere,
          schema.installations.createdAt,
          schema.installations.id,
          decodeCursor(params.cursor),
        ),
        orderBy: [
          asc(schema.installations.createdAt),
          asc(schema.installations.id),
        ],
        limit: limit + 1,
      },
    );
    return pageFromProbe(rows.map(normalizeInstallationRecord), limit);
  }

  async patchInstallation(
    id: string,
    patch: InstallationPatch,
    guard?: InstallationPatchGuard,
  ): Promise<Installation | undefined> {
    const existing = await this.getInstallation(id);
    if (!existing) return undefined;
    if (
      guard !== undefined &&
      (existing.currentDeploymentId !== guard.currentDeploymentId ||
        (guard.status !== undefined && existing.status !== guard.status))
    ) {
      throw new InstallationPatchGuardConflict({
        id,
        expectedCurrentDeploymentId: guard.currentDeploymentId,
        actualCurrentDeploymentId: existing.currentDeploymentId,
        expectedStatus: guard.status,
        actualStatus: existing.status,
      });
    }
    const updated: Installation = { ...existing, ...patch };
    if (!guard) return await this.putInstallation(updated);
    // Guarded path: a single conditional UPDATE so a concurrent writer that
    // moved currentDeploymentId/status loses the race deterministically.
    await this.#ensureSchema();
    const result = await this.#orm
      .update(schema.installations)
      .set({
        currentDeploymentId: updated.currentDeploymentId ?? null,
        currentStateGeneration: updated.currentStateGeneration,
        currentOutputSnapshotId: updated.currentOutputSnapshotId ?? null,
        status: updated.status,
        recordJson: normalizeInstallationRecord(updated),
        updatedAt: updated.updatedAt,
      })
      .where(
        and(
          eq(schema.installations.id, id),
          guard.currentDeploymentId === undefined
            ? isNull(schema.installations.currentDeploymentId)
            : eq(
                schema.installations.currentDeploymentId,
                guard.currentDeploymentId,
              ),
          guard.status === undefined
            ? undefined
            : eq(schema.installations.status, guard.status),
        ),
      )
      .run();
    if (changes(result as D1Result) > 0) {
      return normalizeInstallationRecord(updated);
    }
    const actual = await this.getInstallation(id);
    if (!actual) return undefined;
    throw new InstallationPatchGuardConflict({
      id,
      expectedCurrentDeploymentId: guard.currentDeploymentId,
      actualCurrentDeploymentId: actual.currentDeploymentId,
      expectedStatus: guard.status,
      actualStatus: actual.status,
    });
  }

  /**
   * Atomic apply / destroy-apply ledger commit (spec §20 / §21 / §16) for D1.
   *
   * D1 has NO interactive transaction, but `batch([...])` commits a set of
   * statements atomically (all-or-nothing). So every WRITE — new/superseded
   * Deployment(s), StateSnapshot, (apply) OutputSnapshot, and the Installation
   * advance — is committed in ONE `this.#orm.batch(...)` call; a crash between
   * statements can no longer leave torn state.
   *
   * The guarded Installation advance is still evaluated before the batch because
   * D1 cannot branch a batch on an UPDATE row count. Apply ownership is stricter:
   * when an apply terminal row carries a lease token, the batch starts with a
   * guard statement that raises a deliberate SQL error unless the current run
   * row is still `running` with that token. That error rolls the whole batch
   * back, so a stale owner cannot write Deployment/State/Output rows after
   * another worker has taken the run over.
   *
   * The Installation guard mirrors {@link patchInstallation}:
   *   - row gone -> `{ installation: undefined }` (no writes), same as today;
   *   - guard mismatch -> throw {@link InstallationPatchGuardConflict} (no writes);
   *   - guard match -> batch all writes + the (now-safe) unconditional UPDATE.
   */
  async commitAppliedDeployment(
    input: CommitAppliedDeploymentInput,
  ): Promise<CommitAppliedDeploymentResult> {
    await this.#ensureSchema();
    const { installationPatch } = input;
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
    const current = await this.getInstallation(installationPatch.id);
    if (!current) return { installation: undefined };
    const guard = installationPatch.guard;
    if (
      current.currentDeploymentId !== guard.currentDeploymentId ||
      (guard.status !== undefined && current.status !== guard.status)
    ) {
      throw new InstallationPatchGuardConflict({
        id: installationPatch.id,
        expectedCurrentDeploymentId: guard.currentDeploymentId,
        actualCurrentDeploymentId: current.currentDeploymentId,
        expectedStatus: guard.status,
        actualStatus: current.status,
      });
    }
    const updated: Installation = { ...current, ...installationPatch.patch };
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
      ...(input.newDeployment
        ? [d1UpsertDeploymentStmt(this.#orm, input.newDeployment)]
        : []),
      ...(input.supersededDeployment
        ? [d1UpsertDeploymentStmt(this.#orm, input.supersededDeployment)]
        : []),
      d1UpsertStateSnapshotStmt(this.#orm, input.stateSnapshot),
      ...(input.outputSnapshot
        ? [d1UpsertOutputSnapshotStmt(this.#orm, input.outputSnapshot)]
        : []),
      // Commit-tail fold (S2): the succeeded ApplyRun + the applied PlanRun join
      // the SAME atomic batch as the Deployment so a torn tail can no longer
      // leave a stuck `running` run over a finished Deployment. The apply
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
        .update(schema.installations)
        .set({
          currentDeploymentId: updated.currentDeploymentId ?? null,
          currentStateGeneration: updated.currentStateGeneration,
          currentOutputSnapshotId: updated.currentOutputSnapshotId ?? null,
          status: updated.status,
          recordJson: updated,
          updatedAt: updated.updatedAt,
        })
        .where(eq(schema.installations.id, updated.id)),
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
    return { installation: updated };
  }

  async commitRestoredState(
    input: CommitRestoredStateInput,
  ): Promise<CommitRestoredStateResult> {
    await this.#ensureSchema();
    const { installationPatch } = input;
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
    const current = await this.getInstallation(installationPatch.id);
    if (!current) return { installation: undefined };
    const guard = installationPatch.guard;
    if (
      current.currentStateGeneration !== guard.currentStateGeneration ||
      (guard.status !== undefined && current.status !== guard.status)
    ) {
      throw new InstallationStateGenerationGuardConflict({
        id: installationPatch.id,
        expectedCurrentStateGeneration: guard.currentStateGeneration,
        actualCurrentStateGeneration: current.currentStateGeneration,
        expectedStatus: guard.status,
        actualStatus: current.status,
      });
    }
    const updated: Installation = { ...current, ...installationPatch.patch };
    const statements = [
      d1RunLeaseGuardStmt(
        this.#orm,
        input.restoreRunTerminal.id,
        input.restoreRunLeaseToken,
        [RUN_KIND_RESTORE],
      ),
      d1InstallationStateGuardStmt(
        this.#orm,
        installationPatch.id,
        guard.currentStateGeneration,
        guard.status,
      ),
      d1UpsertStateSnapshotStmt(this.#orm, input.stateSnapshot),
      d1UpsertRunStmt(this.#orm, RUN_KIND_RESTORE, input.restoreRunTerminal),
      this.#orm
        .update(schema.installations)
        .set({
          currentDeploymentId: updated.currentDeploymentId ?? null,
          currentStateGeneration: updated.currentStateGeneration,
          currentOutputSnapshotId: updated.currentOutputSnapshotId ?? null,
          status: updated.status,
          recordJson: updated,
          updatedAt: updated.updatedAt,
        })
        .where(eq(schema.installations.id, updated.id)),
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
      if (isD1InstallationStateGuardError(error)) {
        const actual = await this.getInstallation(installationPatch.id);
        if (!actual) return { installation: undefined };
        throw new InstallationStateGenerationGuardConflict({
          id: installationPatch.id,
          expectedCurrentStateGeneration: guard.currentStateGeneration,
          actualCurrentStateGeneration: actual.currentStateGeneration,
          expectedStatus: guard.status,
          actualStatus: actual.status,
        });
      }
      throw error;
    }
    return { installation: updated };
  }

  // -- Deployment -------------------------------------------------------------

  async putDeployment(deployment: Deployment): Promise<Deployment> {
    await this.#drizzleUpsert(schema.deployments, {
      id: deployment.id,
      spaceId: deployment.spaceId,
      installationId: deployment.installationId,
      environment: deployment.environment,
      applyRunId: deployment.applyRunId,
      sourceSnapshotId: deployment.sourceSnapshotId,
      dependencySnapshotId: deployment.dependencySnapshotId ?? null,
      stateGeneration: deployment.stateGeneration,
      outputSnapshotId: deployment.outputSnapshotId,
      outputsPublicJson: deployment.outputsPublic,
      status: deployment.status,
      createdAt: deployment.createdAt,
    });
    return deployment;
  }

  async getDeployment(id: string): Promise<Deployment | undefined> {
    await this.#ensureSchema();
    const row = await this.#orm
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, id))
      .get();
    return row ? deploymentFromDrizzleRow(row) : undefined;
  }

  async listDeploymentsByIds(
    ids: readonly string[],
  ): Promise<readonly Deployment[]> {
    await this.#ensureSchema();
    const uniqueIds = [...new Set(ids.filter((id) => id.length > 0))];
    if (uniqueIds.length === 0) return [];
    const rows = await this.#orm
      .select()
      .from(schema.deployments)
      .where(inArray(schema.deployments.id, uniqueIds));
    return rows.map(deploymentFromDrizzleRow);
  }

  async listDeployments(
    installationId: string,
  ): Promise<readonly Deployment[]> {
    await this.#ensureSchema();
    const rows = await this.#orm
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.installationId, installationId))
      .orderBy(asc(schema.deployments.createdAt), asc(schema.deployments.id));
    return rows.map(deploymentFromDrizzleRow);
  }

  async listDeploymentsBySpace(
    spaceId: string,
  ): Promise<readonly Deployment[]> {
    await this.#ensureSchema();
    const rows = await this.#orm
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.spaceId, spaceId))
      .orderBy(asc(schema.deployments.createdAt), asc(schema.deployments.id));
    return rows.map(deploymentFromDrizzleRow);
  }

  async listDeploymentsPage(
    installationId: string,
    params: PageParams,
  ): Promise<Page<Deployment>> {
    await this.#ensureSchema();
    const limit = clampPageLimit(params.limit);
    const rows = await this.#orm
      .select()
      .from(schema.deployments)
      .where(
        d1KeysetWhere(
          eq(schema.deployments.installationId, installationId),
          schema.deployments.createdAt,
          schema.deployments.id,
          decodeCursor(params.cursor),
        ),
      )
      .orderBy(asc(schema.deployments.createdAt), asc(schema.deployments.id))
      .limit(limit + 1);
    return pageFromProbe(rows.map(deploymentFromDrizzleRow), limit);
  }

  // -- Connection (+ sealed secret blob) --------------------------------------

  async putConnection(connection: Connection): Promise<Connection> {
    await this.#drizzleUpsert(schema.connections, {
      id: connection.id,
      spaceId: connection.spaceId,
      provider: connection.provider,
      status: connection.status,
      connectionJson: connection,
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt,
    });
    return connection;
  }

  async getConnection(id: string): Promise<Connection | undefined> {
    return await this.#drizzleFirstJson<Connection>(
      schema.connections,
      schema.connections.connectionJson,
      eq(schema.connections.id, id),
    );
  }

  async listConnections(spaceId: string): Promise<readonly Connection[]> {
    return await this.#drizzleManyJson<Connection>(
      schema.connections,
      schema.connections.connectionJson,
      {
        where: eq(schema.connections.spaceId, spaceId),
        orderBy: [
          asc(schema.connections.createdAt),
          asc(schema.connections.id),
        ],
      },
    );
  }

  async listConnectionsPage(
    spaceId: string,
    params: PageParams,
  ): Promise<Page<Connection>> {
    const limit = clampPageLimit(params.limit);
    const rows = await this.#drizzleManyJson<Connection>(
      schema.connections,
      schema.connections.connectionJson,
      {
        where: d1KeysetWhere(
          eq(schema.connections.spaceId, spaceId),
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

  async listOperatorConnections(): Promise<readonly Connection[]> {
    const rows = await this.#drizzleManyJson<Connection>(
      schema.connections,
      schema.connections.connectionJson,
      {
        where: isNull(schema.connections.spaceId),
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
        spaceId: blob.spaceId ?? null,
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
        spaceId: blob.spaceId ?? null,
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
      spaceId: source.spaceId,
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

  async listSources(spaceId?: string): Promise<readonly StoredSource[]> {
    return await this.#drizzleManyJson<StoredSource>(
      schema.sources,
      schema.sources.recordJson,
      {
        where:
          spaceId === undefined
            ? undefined
            : eq(schema.sources.spaceId, spaceId),
        orderBy: [asc(schema.sources.createdAt), asc(schema.sources.id)],
      },
    );
  }

  async listSourcesPage(
    spaceId: string,
    params: PageParams,
  ): Promise<Page<StoredSource>> {
    const limit = clampPageLimit(params.limit);
    const rows = await this.#drizzleManyJson<StoredSource>(
      schema.sources,
      schema.sources.recordJson,
      {
        where: d1KeysetWhere(
          eq(schema.sources.spaceId, spaceId),
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
      sourceId: normalized.sourceId ?? null,
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
    return (
      await this.#drizzleManyJson<SourceSnapshot>(
        schema.sourceSnapshots,
        schema.sourceSnapshots.recordJson,
        {
          where: inArray(schema.sourceSnapshots.sourceId, [...sourceIds]),
          orderBy: [
            asc(schema.sourceSnapshots.fetchedAt),
            asc(schema.sourceSnapshots.id),
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
    await this.#drizzleUpsert(schema.capsuleCompatibilityReports, {
      id: report.id,
      sourceId: report.sourceId ?? null,
      installationId: report.installationId ?? null,
      sourceSnapshotId: report.sourceSnapshotId,
      level: report.level,
      findingsJson: report.findings,
      providersJson: report.providers,
      resourcesJson: report.resources,
      dataSourcesJson: report.dataSources,
      provisionersJson: report.provisioners,
      normalizedObjectKey: report.normalizedObjectKey ?? null,
      normalizedDigest: report.normalizedDigest ?? null,
      createdAt: report.createdAt,
    });
    return report;
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
      ...(row.sourceId ? { sourceId: row.sourceId } : {}),
      ...(row.installationId ? { installationId: row.installationId } : {}),
      sourceSnapshotId: row.sourceSnapshotId,
      level: row.level as CapsuleCompatibilityReport["level"],
      findings: row.findingsJson as CapsuleCompatibilityReport["findings"],
      providers: row.providersJson as CapsuleCompatibilityReport["providers"],
      resources: row.resourcesJson as CapsuleCompatibilityReport["resources"],
      dataSources:
        row.dataSourcesJson as CapsuleCompatibilityReport["dataSources"],
      provisioners:
        row.provisionersJson as CapsuleCompatibilityReport["provisioners"],
      ...(row.normalizedObjectKey
        ? { normalizedObjectKey: row.normalizedObjectKey }
        : {}),
      ...(row.normalizedDigest
        ? { normalizedDigest: row.normalizedDigest }
        : {}),
      createdAt: row.createdAt,
    };
  }

  async getLatestCapsuleCompatibilityReportForSourceSnapshot(
    sourceSnapshotId: string,
    options: {
      readonly sourceId?: string;
      readonly installationId?: string;
    } = {},
  ): Promise<CapsuleCompatibilityReport | undefined> {
    await this.#ensureSchema();
    const filters = [
      eq(schema.capsuleCompatibilityReports.sourceSnapshotId, sourceSnapshotId),
    ];
    if (options.sourceId) {
      filters.push(
        or(
          isNull(schema.capsuleCompatibilityReports.sourceId),
          eq(schema.capsuleCompatibilityReports.sourceId, options.sourceId),
        )!,
      );
    }
    if (options.installationId) {
      filters.push(
        or(
          isNull(schema.capsuleCompatibilityReports.installationId),
          eq(
            schema.capsuleCompatibilityReports.installationId,
            options.installationId,
          ),
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
      ...(row.sourceId ? { sourceId: row.sourceId } : {}),
      ...(row.installationId ? { installationId: row.installationId } : {}),
      sourceSnapshotId: row.sourceSnapshotId,
      level: row.level as CapsuleCompatibilityReport["level"],
      findings: row.findingsJson as CapsuleCompatibilityReport["findings"],
      providers: row.providersJson as CapsuleCompatibilityReport["providers"],
      resources: row.resourcesJson as CapsuleCompatibilityReport["resources"],
      dataSources:
        row.dataSourcesJson as CapsuleCompatibilityReport["dataSources"],
      provisioners:
        row.provisionersJson as CapsuleCompatibilityReport["provisioners"],
      ...(row.normalizedObjectKey
        ? { normalizedObjectKey: row.normalizedObjectKey }
        : {}),
      ...(row.normalizedDigest
        ? { normalizedDigest: row.normalizedDigest }
        : {}),
      createdAt: row.createdAt,
    };
  }

  // -- InstallationProviderEnvBindingSet ------------------------------------------------------

  async putInstallationProviderEnvBindingSet(
    profile: InstallationProviderEnvBindingSet,
  ): Promise<InstallationProviderEnvBindingSet> {
    // One profile per (installation, environment): drop any stale row for the
    // same pair under a different id before upserting.
    await this.#ensureSchema();
    await this.#orm
      .delete(schema.providerEnvBindingSets)
      .where(
        and(
          eq(
            schema.providerEnvBindingSets.installationId,
            profile.installationId,
          ),
          eq(schema.providerEnvBindingSets.environment, profile.environment),
        ),
      )
      .run();
    await this.#drizzleUpsert(schema.providerEnvBindingSets, {
      id: profile.id,
      spaceId: profile.spaceId,
      installationId: profile.installationId,
      environment: profile.environment,
      recordJson: profile,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    });
    return profile;
  }

  async getInstallationProviderEnvBindingSetByInstallation(
    installationId: string,
    environment: string,
  ): Promise<InstallationProviderEnvBindingSet | undefined> {
    const rows = await this.#drizzleManyJson<InstallationProviderEnvBindingSet>(
      schema.providerEnvBindingSets,
      schema.providerEnvBindingSets.recordJson,
      {
        where: and(
          eq(schema.providerEnvBindingSets.installationId, installationId),
          eq(schema.providerEnvBindingSets.environment, environment),
        ),
        orderBy: [
          desc(schema.providerEnvBindingSets.createdAt),
          desc(schema.providerEnvBindingSets.id),
        ],
        limit: 1,
      },
    );
    return rows[0];
  }

  // -- StateSnapshot ----------------------------------------------------------

  async putStateSnapshot(snapshot: StateSnapshot): Promise<StateSnapshot> {
    await this.#drizzleUpsert(
      schema.stateSnapshots,
      {
        id: snapshot.id,
        spaceId: snapshot.spaceId,
        installationId: snapshot.installationId,
        environment: snapshot.environment,
        generation: snapshot.generation,
        objectKey: snapshot.objectKey,
        digest: snapshot.digest,
        createdByRunId: snapshot.createdByRunId,
        createdAt: snapshot.createdAt,
      },
      {
        id: snapshot.id,
        spaceId: snapshot.spaceId,
        objectKey: snapshot.objectKey,
        digest: snapshot.digest,
        createdByRunId: snapshot.createdByRunId,
        createdAt: snapshot.createdAt,
      },
      [
        schema.stateSnapshots.installationId,
        schema.stateSnapshots.environment,
        schema.stateSnapshots.generation,
      ],
    );
    return snapshot;
  }

  async getLatestStateSnapshot(
    installationId: string,
    environment: string,
  ): Promise<StateSnapshot | undefined> {
    await this.#ensureSchema();
    const row = await this.#orm
      .select()
      .from(schema.stateSnapshots)
      .where(
        and(
          eq(schema.stateSnapshots.installationId, installationId),
          eq(schema.stateSnapshots.environment, environment),
        ),
      )
      .orderBy(desc(schema.stateSnapshots.generation))
      .limit(1)
      .get();
    return row ? stateSnapshotFromDrizzleRow(row) : undefined;
  }

  async listStateSnapshots(
    installationId: string,
    environment: string,
  ): Promise<readonly StateSnapshot[]> {
    await this.#ensureSchema();
    const rows = await this.#orm
      .select()
      .from(schema.stateSnapshots)
      .where(
        and(
          eq(schema.stateSnapshots.installationId, installationId),
          eq(schema.stateSnapshots.environment, environment),
        ),
      )
      .orderBy(asc(schema.stateSnapshots.generation));
    return rows.map(stateSnapshotFromDrizzleRow);
  }

  async listStateSnapshotsBySpace(
    spaceId: string,
  ): Promise<readonly StateSnapshot[]> {
    await this.#ensureSchema();
    const rows = await this.#orm
      .select()
      .from(schema.stateSnapshots)
      .where(eq(schema.stateSnapshots.spaceId, spaceId))
      .orderBy(asc(schema.stateSnapshots.generation));
    return rows.map(stateSnapshotFromDrizzleRow);
  }

  // -- Dependency DAG (§14 / §15 / §27 installation_dependencies) --------------

  async putDependency(dependency: Dependency): Promise<Dependency> {
    await this.#drizzleUpsert(schema.installationDependencies, {
      id: dependency.id,
      spaceId: dependency.spaceId,
      producerInstallationId: dependency.producerInstallationId,
      consumerInstallationId: dependency.consumerInstallationId,
      recordJson: dependency,
      createdAt: dependency.createdAt,
    });
    return dependency;
  }

  async getDependency(id: string): Promise<Dependency | undefined> {
    return await this.#drizzleFirstJson<Dependency>(
      schema.installationDependencies,
      schema.installationDependencies.recordJson,
      eq(schema.installationDependencies.id, id),
    );
  }

  async listDependenciesBySpace(
    spaceId: string,
  ): Promise<readonly Dependency[]> {
    return await this.#drizzleManyJson<Dependency>(
      schema.installationDependencies,
      schema.installationDependencies.recordJson,
      {
        where: eq(schema.installationDependencies.spaceId, spaceId),
        orderBy: [
          asc(schema.installationDependencies.createdAt),
          asc(schema.installationDependencies.id),
        ],
      },
    );
  }

  async listDependenciesForConsumer(
    consumerInstallationId: string,
  ): Promise<readonly Dependency[]> {
    return await this.#drizzleManyJson<Dependency>(
      schema.installationDependencies,
      schema.installationDependencies.recordJson,
      {
        where: eq(
          schema.installationDependencies.consumerInstallationId,
          consumerInstallationId,
        ),
        orderBy: [
          asc(schema.installationDependencies.createdAt),
          asc(schema.installationDependencies.id),
        ],
      },
    );
  }

  async listDependenciesForProducer(
    producerInstallationId: string,
  ): Promise<readonly Dependency[]> {
    return await this.#drizzleManyJson<Dependency>(
      schema.installationDependencies,
      schema.installationDependencies.recordJson,
      {
        where: eq(
          schema.installationDependencies.producerInstallationId,
          producerInstallationId,
        ),
        orderBy: [
          asc(schema.installationDependencies.createdAt),
          asc(schema.installationDependencies.id),
        ],
      },
    );
  }

  async deleteDependency(id: string): Promise<boolean> {
    return await this.#drizzleDelete(
      schema.installationDependencies,
      eq(schema.installationDependencies.id, id),
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

  // -- OutputSnapshot (§16 / §27 output_snapshots) -----------------------------

  async putOutputSnapshot(snapshot: OutputSnapshot): Promise<OutputSnapshot> {
    await this.#drizzleUpsert(schema.outputSnapshots, {
      id: snapshot.id,
      spaceId: snapshot.spaceId,
      installationId: snapshot.installationId,
      stateGeneration: snapshot.stateGeneration,
      recordJson: snapshot,
      createdAt: snapshot.createdAt,
    });
    return snapshot;
  }

  async getOutputSnapshot(id: string): Promise<OutputSnapshot | undefined> {
    return await this.#drizzleFirstJson<OutputSnapshot>(
      schema.outputSnapshots,
      schema.outputSnapshots.recordJson,
      eq(schema.outputSnapshots.id, id),
    );
  }

  async getLatestOutputSnapshot(
    installationId: string,
  ): Promise<OutputSnapshot | undefined> {
    const rows = await this.#drizzleManyJson<OutputSnapshot>(
      schema.outputSnapshots,
      schema.outputSnapshots.recordJson,
      {
        where: eq(schema.outputSnapshots.installationId, installationId),
        orderBy: [
          desc(schema.outputSnapshots.stateGeneration),
          desc(schema.outputSnapshots.createdAt),
          desc(schema.outputSnapshots.id),
        ],
        limit: 1,
      },
    );
    return rows[0];
  }

  async listOutputSnapshots(
    installationId: string,
  ): Promise<readonly OutputSnapshot[]> {
    return await this.#drizzleManyJson<OutputSnapshot>(
      schema.outputSnapshots,
      schema.outputSnapshots.recordJson,
      {
        where: eq(schema.outputSnapshots.installationId, installationId),
        orderBy: [
          schema.outputSnapshots.stateGeneration,
          schema.outputSnapshots.createdAt,
          schema.outputSnapshots.id,
        ],
      },
    );
  }

  async listOutputSnapshotsBySpace(
    spaceId: string,
  ): Promise<readonly OutputSnapshot[]> {
    return await this.#drizzleManyJson<OutputSnapshot>(
      schema.outputSnapshots,
      schema.outputSnapshots.recordJson,
      {
        where: eq(schema.outputSnapshots.spaceId, spaceId),
        orderBy: [
          schema.outputSnapshots.stateGeneration,
          schema.outputSnapshots.createdAt,
          schema.outputSnapshots.id,
        ],
      },
    );
  }

  // -- OutputShare (§18 / §27 output_shares) -----------------------------------

  async putOutputShare(share: OutputShare): Promise<OutputShare> {
    await this.#drizzleUpsert(schema.outputShares, {
      id: share.id,
      fromSpaceId: share.fromSpaceId,
      toSpaceId: share.toSpaceId,
      producerInstallationId: share.producerInstallationId,
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

  async listOutputSharesFromSpace(
    fromSpaceId: string,
  ): Promise<readonly OutputShare[]> {
    return await this.#drizzleManyJson<OutputShare>(
      schema.outputShares,
      schema.outputShares.recordJson,
      {
        where: eq(schema.outputShares.fromSpaceId, fromSpaceId),
        orderBy: [
          asc(schema.outputShares.createdAt),
          asc(schema.outputShares.id),
        ],
      },
    );
  }

  async listOutputSharesToSpace(
    toSpaceId: string,
  ): Promise<readonly OutputShare[]> {
    return await this.#drizzleManyJson<OutputShare>(
      schema.outputShares,
      schema.outputShares.recordJson,
      {
        where: eq(schema.outputShares.toSpaceId, toSpaceId),
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
      spaceId: group.spaceId,
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

  async listRunGroups(spaceId: string): Promise<readonly RunGroup[]> {
    return await this.#drizzleManyJson<RunGroup>(
      schema.runGroups,
      schema.runGroups.recordJson,
      {
        where: eq(schema.runGroups.spaceId, spaceId),
        orderBy: [asc(schema.runGroups.createdAt), asc(schema.runGroups.id)],
      },
    );
  }

  // -- Activity audit_events (§27 audit_events / §34 Activity) ------------------
  //
  // The §27 audit_events table keeps searchable columns (space_id / created_at)
  // for the Space-scoped Activity list; the full non-secret event round trips
  // through record_json. Listing is newest-first with a clamped limit.

  async putActivityEvent(event: ActivityEvent): Promise<ActivityEvent> {
    await this.#drizzleUpsert(schema.auditEvents, {
      id: event.id,
      spaceId: event.spaceId,
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
    spaceId: string,
    options: { readonly limit?: number } = {},
  ): Promise<readonly ActivityEvent[]> {
    const limit = clampActivityLimit(options.limit);
    return await this.#drizzleManyJson<ActivityEvent>(
      schema.auditEvents,
      schema.auditEvents.recordJson,
      {
        where: eq(schema.auditEvents.spaceId, spaceId),
        orderBy: [
          desc(schema.auditEvents.createdAt),
          desc(schema.auditEvents.id),
        ],
        limit,
      },
    );
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
      spaceId: event.workspaceId,
      installationId: event.capsuleId,
      sourceId: event.sourceId,
      connectionId: event.connectionId ?? event.providerEnvId ?? "",
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
      spaceId: finding.workspaceId,
      installationId: finding.capsuleId ?? null,
      runId: finding.runId ?? null,
      severity: finding.severity,
      type: finding.type,
      recordJson: finding,
      createdAt: finding.createdAt,
    });
    return finding;
  }

  async listSecurityFindings(
    spaceId: string,
    options: { readonly runId?: string; readonly limit?: number } = {},
  ): Promise<readonly SecurityFinding[]> {
    const limit = clampActivityLimit(options.limit);
    return await this.#drizzleManyJson<SecurityFinding>(
      schema.securityFindings,
      schema.securityFindings.recordJson,
      {
        where:
          options.runId === undefined
            ? eq(schema.securityFindings.spaceId, spaceId)
            : and(
                eq(schema.securityFindings.spaceId, spaceId),
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

  // -- billing ledger ---------------------------------------------------------

  async putBillingPlan(plan: BillingPlan): Promise<BillingPlan> {
    const normalized = normalizeBillingPlan(plan);
    await this.#drizzleUpsert(schema.billingPlans, {
      id: normalized.id,
      name: normalized.name,
      monthlyBasePrice: normalized.monthlyBasePrice,
      includedUsdMicros: normalized.includedUsdMicros,
      includedCredits: legacyStorageCreditsFromUsdMicros(
        normalized.includedUsdMicros ?? 0,
      ),
      limitsJson: normalized.limits,
      recordJson: normalized,
      createdAt: normalized.createdAt,
      updatedAt: normalized.updatedAt,
    });
    return normalized;
  }

  async getBillingPlan(id: string): Promise<BillingPlan | undefined> {
    const plan = await this.#drizzleFirstJson<BillingPlan>(
      schema.billingPlans,
      schema.billingPlans.recordJson,
      eq(schema.billingPlans.id, id),
    );
    return plan ? normalizeBillingPlan(plan) : undefined;
  }

  async putBillingAccount(account: BillingAccount): Promise<BillingAccount> {
    await this.#drizzleUpsert(schema.billingAccounts, {
      id: account.id,
      ownerType: account.ownerType,
      ownerId: account.ownerId,
      provider: account.provider,
      status: account.status,
      recordJson: account,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    });
    return account;
  }

  async getBillingAccount(id: string): Promise<BillingAccount | undefined> {
    return await this.#drizzleFirstJson<BillingAccount>(
      schema.billingAccounts,
      schema.billingAccounts.recordJson,
      eq(schema.billingAccounts.id, id),
    );
  }

  async getBillingAccountForOwner(
    ownerType: BillingAccount["ownerType"],
    ownerId: string,
  ): Promise<BillingAccount | undefined> {
    const rows = await this.#drizzleManyJson<BillingAccount>(
      schema.billingAccounts,
      schema.billingAccounts.recordJson,
      {
        where: and(
          eq(schema.billingAccounts.ownerType, ownerType),
          eq(schema.billingAccounts.ownerId, ownerId),
        ),
        limit: 1,
      },
    );
    return rows[0];
  }

  async putSpaceSubscription(
    subscription: SpaceSubscription,
  ): Promise<SpaceSubscription> {
    await this.#drizzleUpsert(schema.spaceSubscriptions, {
      id: subscription.id,
      spaceId: subscription.spaceId,
      billingAccountId: subscription.billingAccountId,
      planId: subscription.planId,
      status: subscription.status,
      recordJson: subscription,
      createdAt: subscription.createdAt,
      updatedAt: subscription.updatedAt,
    });
    return subscription;
  }

  async getSpaceSubscription(
    spaceId: string,
  ): Promise<SpaceSubscription | undefined> {
    const rows = await this.#drizzleManyJson<SpaceSubscription>(
      schema.spaceSubscriptions,
      schema.spaceSubscriptions.recordJson,
      {
        where: eq(schema.spaceSubscriptions.spaceId, spaceId),
        orderBy: [
          desc(schema.spaceSubscriptions.updatedAt),
          desc(schema.spaceSubscriptions.id),
        ],
        limit: 1,
      },
    );
    return rows[0];
  }

  async putCreditBalance(balance: CreditBalance): Promise<CreditBalance> {
    const normalized = normalizeCreditBalance(balance);
    await this.#drizzleUpsert(
      schema.creditBalances,
      {
        spaceId: normalized.spaceId,
        availableUsdMicros: normalized.availableUsdMicros,
        reservedUsdMicros: normalized.reservedUsdMicros,
        monthlyIncludedUsdMicros: normalized.monthlyIncludedUsdMicros,
        purchasedUsdMicros: normalized.purchasedUsdMicros,
        availableCredits: legacyStorageCreditsFromUsdMicros(
          normalized.availableUsdMicros ?? 0,
        ),
        reservedCredits: legacyStorageCreditsFromUsdMicros(
          normalized.reservedUsdMicros ?? 0,
        ),
        monthlyIncludedCredits: legacyStorageCreditsFromUsdMicros(
          normalized.monthlyIncludedUsdMicros ?? 0,
        ),
        purchasedCredits: legacyStorageCreditsFromUsdMicros(
          normalized.purchasedUsdMicros ?? 0,
        ),
        updatedAt: normalized.updatedAt,
      },
      {
        availableUsdMicros: normalized.availableUsdMicros,
        reservedUsdMicros: normalized.reservedUsdMicros,
        monthlyIncludedUsdMicros: normalized.monthlyIncludedUsdMicros,
        purchasedUsdMicros: normalized.purchasedUsdMicros,
        availableCredits: legacyStorageCreditsFromUsdMicros(
          normalized.availableUsdMicros ?? 0,
        ),
        reservedCredits: legacyStorageCreditsFromUsdMicros(
          normalized.reservedUsdMicros ?? 0,
        ),
        monthlyIncludedCredits: legacyStorageCreditsFromUsdMicros(
          normalized.monthlyIncludedUsdMicros ?? 0,
        ),
        purchasedCredits: legacyStorageCreditsFromUsdMicros(
          normalized.purchasedUsdMicros ?? 0,
        ),
        updatedAt: normalized.updatedAt,
      },
      schema.creditBalances.spaceId,
    );
    return normalized;
  }

  async getCreditBalance(spaceId: string): Promise<CreditBalance | undefined> {
    await this.#ensureSchema();
    const row = await this.#orm
      .select()
      .from(schema.creditBalances)
      .where(eq(schema.creditBalances.spaceId, spaceId))
      .get();
    return row ? creditBalanceFromRow(row) : undefined;
  }

  async reserveCredits(
    spaceId: string,
    input: CreditAmountInput & { readonly updatedAt: string },
  ): Promise<CreditBalance | undefined> {
    await this.#ensureSchema();
    const usdMicros = creditAmountUsdMicros(input);
    const legacyCredits = legacyStorageCreditsFromUsdMicros(usdMicros);
    const result = await this.db
      .prepare(
        `update credit_balances
         set available_usd_micros = coalesce(available_usd_micros, available_credits * 1000000) - ?,
             reserved_usd_micros = coalesce(reserved_usd_micros, reserved_credits * 1000000) + ?,
             available_credits = available_credits - ?,
             reserved_credits = reserved_credits + ?,
             updated_at = ?
         where space_id = ?
           and coalesce(available_usd_micros, available_credits * 1000000) >= ?`,
      )
      .bind(
        usdMicros,
        usdMicros,
        legacyCredits,
        legacyCredits,
        input.updatedAt,
        spaceId,
        usdMicros,
      )
      .run();
    if (changes(result) <= 0) return undefined;
    return await this.getCreditBalance(spaceId);
  }

  async addCredits(
    spaceId: string,
    input: CreditAmountInput & { readonly updatedAt: string },
  ): Promise<CreditBalance> {
    await this.#ensureSchema();
    const usdMicros = creditAmountUsdMicros(input);
    const legacyCredits = legacyStorageCreditsFromUsdMicros(usdMicros);
    // Seed a zero row so the first grant lands (INSERT OR IGNORE).
    await this.db
      .prepare(
        `insert or ignore into credit_balances
           (space_id, available_usd_micros, reserved_usd_micros,
            monthly_included_usd_micros, purchased_usd_micros,
            available_credits, reserved_credits,
            monthly_included_credits, purchased_credits, updated_at)
         values (?, 0, 0, 0, 0, 0, 0, 0, 0, ?)`,
      )
      .bind(spaceId, input.updatedAt)
      .run();
    await this.db
      .prepare(
        `update credit_balances
         set available_usd_micros = coalesce(available_usd_micros, available_credits * 1000000) + ?,
             purchased_usd_micros = coalesce(purchased_usd_micros, purchased_credits * 1000000) + ?,
             available_credits = available_credits + ?,
             purchased_credits = purchased_credits + ?,
             updated_at = ?
         where space_id = ?`,
      )
      .bind(
        usdMicros,
        usdMicros,
        legacyCredits,
        legacyCredits,
        input.updatedAt,
        spaceId,
      )
      .run();
    // The seed + update guarantees a row exists.
    return (await this.getCreditBalance(spaceId))!;
  }

  async reconcileMonthlyCredits(
    spaceId: string,
    input: {
      readonly newMonthly: number;
      readonly periodStartIso: string;
      readonly updatedAt: string;
    },
  ): Promise<CreditBalance | undefined> {
    await this.#ensureSchema();
    const newMonthlyUsdMicros = legacyCreditsToUsdMicros(input.newMonthly);
    const newMonthlyLegacyCredits =
      legacyStorageCreditsFromUsdMicros(newMonthlyUsdMicros);
    // Monthly RESET: carry over purchased credits, reset monthly to full.
    // Column-relative, no read: available = max(0, available - oldMonthly) + new.
    const result = await this.db
      .prepare(
        `update credit_balances
         set available_usd_micros =
               max(0, coalesce(available_usd_micros, available_credits * 1000000) -
                      coalesce(monthly_included_usd_micros, monthly_included_credits * 1000000)) + ?,
             monthly_included_usd_micros = ?,
             available_credits =
               max(0, available_credits - monthly_included_credits) + ?,
             monthly_included_credits = ?,
             updated_at = ?
         where space_id = ?
           and (monthly_included_credits != ? or updated_at < ?)`,
      )
      .bind(
        newMonthlyUsdMicros,
        newMonthlyUsdMicros,
        newMonthlyLegacyCredits,
        newMonthlyLegacyCredits,
        input.updatedAt,
        spaceId,
        newMonthlyLegacyCredits,
        input.periodStartIso,
      )
      .run();
    if (changes(result) <= 0) return undefined;
    return await this.getCreditBalance(spaceId);
  }

  async putCreditReservation(
    reservation: CreditReservation,
  ): Promise<CreditReservation> {
    const normalized = normalizeCreditReservation(reservation);
    await this.#drizzleUpsert(schema.creditReservations, {
      id: normalized.id,
      spaceId: normalized.spaceId,
      runId: normalized.runId,
      estimatedUsdMicros: normalized.estimatedUsdMicros,
      estimatedCredits: legacyStorageCreditsFromUsdMicros(
        normalized.estimatedUsdMicros ?? 0,
      ),
      status: normalized.status,
      mode: normalized.mode,
      recordJson: normalized,
      createdAt: normalized.createdAt,
      expiresAt: normalized.expiresAt,
    });
    return normalized;
  }

  async getCreditReservationForRun(
    runId: string,
  ): Promise<CreditReservation | undefined> {
    const rows = await this.#drizzleManyJson<CreditReservation>(
      schema.creditReservations,
      schema.creditReservations.recordJson,
      {
        where: eq(schema.creditReservations.runId, runId),
        orderBy: [
          desc(schema.creditReservations.createdAt),
          desc(schema.creditReservations.id),
        ],
        limit: 1,
      },
    );
    return rows[0] ? normalizeCreditReservation(rows[0]) : undefined;
  }

  async listCreditReservations(
    spaceId: string,
    options: { readonly limit?: number } = {},
  ): Promise<readonly CreditReservation[]> {
    const rows = await this.#drizzleManyJson<CreditReservation>(
      schema.creditReservations,
      schema.creditReservations.recordJson,
      {
        where: eq(schema.creditReservations.spaceId, spaceId),
        orderBy: [
          desc(schema.creditReservations.createdAt),
          desc(schema.creditReservations.id),
        ],
        limit: options.limit ?? 100,
      },
    );
    return rows.map(normalizeCreditReservation);
  }

  async claimBillingAutoRechargeAttempt(
    input: ClaimBillingAutoRechargeAttemptInput,
  ): Promise<ClaimBillingAutoRechargeAttemptResult> {
    await this.#ensureSchema();
    const normalized = normalizeBillingAutoRechargeAttempt(input.attempt);
    const existing = await this.#billingAutoRechargeAttemptByIdempotencyKey(
      normalized.idempotencyKey,
    );
    if (existing) {
      return {
        claimed: false,
        attempt: existing,
        skippedReason: "already_claimed",
      };
    }
    const result = await this.db
      .prepare(
        `insert into billing_auto_recharge_attempts (
           id, space_id, run_id, billing_account_id, idempotency_key,
           period_start, period_end, requested_usd_micros,
           monthly_limit_usd_micros, charged_usd_micros, status,
           stripe_payment_intent_id, provider_status, failure_reason,
           record_json, created_at, updated_at
         )
         select
           ?, ?, ?, ?, ?,
           ?, ?, ?,
           ?, ?, ?,
           ?, ?, ?,
           ?, ?, ?
         where (
           ? is null
           or coalesce((
             select sum(
               case
                 when status = 'succeeded'
                   then coalesce(charged_usd_micros, requested_usd_micros)
                 else requested_usd_micros
               end
             )
             from billing_auto_recharge_attempts
             where space_id = ?
               and period_start = ?
               and status in ('pending', 'pending_unknown', 'succeeded')
           ), 0) + ? <= ?
         )
         on conflict(idempotency_key) do nothing`,
      )
      .bind(
        normalized.id,
        normalized.spaceId,
        normalized.runId,
        normalized.billingAccountId,
        normalized.idempotencyKey,
        normalized.periodStart,
        normalized.periodEnd ?? null,
        normalized.requestedUsdMicros,
        normalized.monthlyLimitUsdMicros ?? null,
        normalized.chargedUsdMicros ?? null,
        normalized.status,
        normalized.stripePaymentIntentId ?? null,
        normalized.providerStatus ?? null,
        normalized.failureReason ?? null,
        JSON.stringify(normalized),
        normalized.createdAt,
        normalized.updatedAt,
        input.monthlyLimitUsdMicros ?? null,
        normalized.spaceId,
        normalized.periodStart,
        normalized.requestedUsdMicros,
        input.monthlyLimitUsdMicros ?? null,
      )
      .run();
    if (changes(result) > 0) {
      return { claimed: true, attempt: normalized };
    }
    const raced = await this.#billingAutoRechargeAttemptByIdempotencyKey(
      normalized.idempotencyKey,
    );
    if (raced) {
      return {
        claimed: false,
        attempt: raced,
        skippedReason: "already_claimed",
      };
    }
    return { claimed: false, skippedReason: "monthly_limit_exceeded" };
  }

  async settleBillingAutoRechargeAttempt(
    input: SettleBillingAutoRechargeAttemptInput,
  ): Promise<SettleBillingAutoRechargeAttemptResult> {
    await this.#ensureSchema();
    const existing = await this.#billingAutoRechargeAttemptById(
      input.attemptId,
    );
    if (!existing) {
      return {
        settled: false,
        skippedReason: "attempt_not_found",
      };
    }
    if (existing.status === "succeeded") {
      return {
        settled: false,
        attempt: existing,
        balance: await this.getCreditBalance(
          existing.workspaceId ?? existing.spaceId,
        ),
        skippedReason: "already_succeeded",
      };
    }
    const next = normalizeBillingAutoRechargeAttempt({
      ...existing,
      status: input.status,
      ...(input.chargedUsdMicros !== undefined
        ? { chargedUsdMicros: input.chargedUsdMicros }
        : {}),
      ...(input.stripePaymentIntentId
        ? { stripePaymentIntentId: input.stripePaymentIntentId }
        : {}),
      ...(input.providerStatus ? { providerStatus: input.providerStatus } : {}),
      ...(input.failureReason ? { failureReason: input.failureReason } : {}),
      updatedAt: input.updatedAt,
    });
    const updateAttempt = this.db
      .prepare(
        `update billing_auto_recharge_attempts
         set charged_usd_micros = ?,
             status = ?,
             stripe_payment_intent_id = ?,
             provider_status = ?,
             failure_reason = ?,
             record_json = ?,
             updated_at = ?
         where id = ?
           and status <> 'succeeded'`,
      )
      .bind(
        next.chargedUsdMicros ?? null,
        next.status,
        next.stripePaymentIntentId ?? null,
        next.providerStatus ?? null,
        next.failureReason ?? null,
        JSON.stringify(next),
        next.updatedAt,
        next.id,
      );
    if (next.status !== "succeeded") {
      const result = await updateAttempt.run();
      if (changes(result) <= 0) {
        return {
          settled: false,
          attempt: await this.#billingAutoRechargeAttemptById(next.id),
          balance: await this.getCreditBalance(
            next.workspaceId ?? next.spaceId,
          ),
          skippedReason: "already_succeeded",
        };
      }
      return { settled: true, attempt: next };
    }
    const chargedUsdMicros = next.chargedUsdMicros ?? next.requestedUsdMicros;
    const legacyCredits = legacyStorageCreditsFromUsdMicros(chargedUsdMicros);
    const seedBalance = this.db
      .prepare(
        `insert or ignore into credit_balances
           (space_id, available_usd_micros, reserved_usd_micros,
            monthly_included_usd_micros, purchased_usd_micros,
            available_credits, reserved_credits,
            monthly_included_credits, purchased_credits, updated_at)
         values (?, 0, 0, 0, 0, 0, 0, 0, 0, ?)`,
      )
      .bind(next.spaceId, input.updatedAt);
    const grantBalance = this.db
      .prepare(
        `update credit_balances
         set available_usd_micros = coalesce(available_usd_micros, available_credits * 1000000) + ?,
             purchased_usd_micros = coalesce(purchased_usd_micros, purchased_credits * 1000000) + ?,
             available_credits = available_credits + ?,
             purchased_credits = purchased_credits + ?,
             updated_at = ?
         where space_id = ?`,
      )
      .bind(
        chargedUsdMicros,
        chargedUsdMicros,
        legacyCredits,
        legacyCredits,
        input.updatedAt,
        next.spaceId,
      );
    if (typeof this.db.batch !== "function") {
      throw new Error(
        "D1 batch support is required to settle billing auto recharge attempts",
      );
    }
    try {
      await this.db.batch([
        d1BillingAutoRechargePendingGuardStmt(this.db, next.id),
        updateAttempt,
        seedBalance,
        grantBalance,
      ]);
    } catch (error) {
      if (isD1BillingAutoRechargeAlreadySettledError(error)) {
        return {
          settled: false,
          attempt: await this.#billingAutoRechargeAttemptById(next.id),
          balance: await this.getCreditBalance(
            next.workspaceId ?? next.spaceId,
          ),
          skippedReason: "already_succeeded",
        };
      }
      throw error;
    }
    return {
      settled: true,
      attempt: next,
      balance: await this.getCreditBalance(next.workspaceId ?? next.spaceId),
    };
  }

  async listBillingAutoRechargeAttempts(
    spaceId: string,
    options: { readonly limit?: number } = {},
  ): Promise<readonly BillingAutoRechargeAttempt[]> {
    const rows = await this.#drizzleManyJson<BillingAutoRechargeAttempt>(
      schema.billingAutoRechargeAttempts,
      schema.billingAutoRechargeAttempts.recordJson,
      {
        where: eq(schema.billingAutoRechargeAttempts.spaceId, spaceId),
        orderBy: [
          desc(schema.billingAutoRechargeAttempts.createdAt),
          desc(schema.billingAutoRechargeAttempts.id),
        ],
        limit: options.limit ?? 100,
      },
    );
    return rows.map(normalizeBillingAutoRechargeAttempt);
  }

  async putUsageEvent(event: UsageEvent): Promise<UsageEvent> {
    const existing = await this.#usageEventByIdempotencyKey(
      event.idempotencyKey,
    );
    if (existing) return existing;
    await this.#ensureSchema();
    const normalized = normalizeUsageEvent(event);
    try {
      await this.#orm
        .insert(schema.usageEvents)
        .values({
          id: normalized.id,
          spaceId: normalized.workspaceId ?? normalized.spaceId,
          installationId: normalized.installationId ?? null,
          runId: normalized.runId ?? null,
          meterId: normalized.meterId ?? null,
          resourceFamily: normalized.resourceFamily ?? null,
          resourceId: normalized.resourceId ?? null,
          operation: normalized.operation ?? null,
          resourceMetadataJson: normalized.resourceMetadata ?? null,
          kind: normalized.kind,
          quantity: normalized.quantity,
          usdMicros: normalized.usdMicros,
          credits: legacyStorageCreditsFromUsdMicros(normalized.usdMicros ?? 0),
          source: normalized.source,
          idempotencyKey: normalized.idempotencyKey,
          createdAt: normalized.createdAt,
        })
        .run();
    } catch {
      return (
        (await this.#usageEventByIdempotencyKey(event.idempotencyKey)) ??
        normalized
      );
    }
    return normalized;
  }

  async putUsageEventAndSpendCredits(
    event: UsageEvent,
    input: CreditAmountInput & { readonly updatedAt: string },
  ): Promise<PutUsageEventAndSpendCreditsResult | undefined> {
    const existing = await this.#usageEventByIdempotencyKey(
      event.idempotencyKey,
    );
    if (existing) {
      return {
        usageEvent: existing,
        balance: await this.getCreditBalance(
          existing.workspaceId ?? existing.spaceId,
        ),
        inserted: false,
      };
    }
    await this.#ensureSchema();
    if (typeof this.db.batch !== "function") {
      throw new Error(
        "D1 batch support is required to spend credits for usage events",
      );
    }
    const normalized = normalizeUsageEvent(event);
    const usdMicros = creditAmountUsdMicros(input);
    const legacyCredits = legacyStorageCreditsFromUsdMicros(usdMicros);
    const spendBalance = this.db
      .prepare(
        `update credit_balances
         set available_usd_micros = coalesce(available_usd_micros, available_credits * 1000000) - ?,
             available_credits = available_credits - ?,
             updated_at = ?
         where space_id = ?
           and coalesce(available_usd_micros, available_credits * 1000000) >= ?
           and not exists (
             select 1 from usage_events where idempotency_key = ?
           )`,
      )
      .bind(
        usdMicros,
        legacyCredits,
        input.updatedAt,
        normalized.spaceId,
        usdMicros,
        normalized.idempotencyKey,
      );
    const insertUsageEvent = this.db
      .prepare(
        `insert into usage_events (
           id, space_id, installation_id, run_id, meter_id,
           resource_family, resource_id, operation, resource_metadata_json,
           kind, quantity, usd_micros, credits, source,
           idempotency_key, created_at
         )
         select
           ?, ?, ?, ?, ?,
           ?, ?, ?, ?,
           ?, ?, ?, ?, ?,
           ?, ?
         where changes() > 0`,
      )
      .bind(
        normalized.id,
        normalized.spaceId,
        normalized.installationId ?? null,
        normalized.runId ?? null,
        normalized.meterId ?? null,
        normalized.resourceFamily ?? null,
        normalized.resourceId ?? null,
        normalized.operation ?? null,
        normalized.resourceMetadata
          ? JSON.stringify(normalized.resourceMetadata)
          : null,
        normalized.kind,
        normalized.quantity,
        normalized.usdMicros ?? null,
        legacyStorageCreditsFromUsdMicros(normalized.usdMicros ?? 0),
        normalized.source,
        normalized.idempotencyKey,
        normalized.createdAt,
      );
    try {
      await this.db.batch([spendBalance, insertUsageEvent]);
    } catch (error) {
      const raced = await this.#usageEventByIdempotencyKey(
        normalized.idempotencyKey,
      );
      if (raced && isD1UsageEventIdempotencyError(error)) {
        return {
          usageEvent: raced,
          balance: await this.getCreditBalance(
            raced.workspaceId ?? raced.spaceId,
          ),
          inserted: false,
        };
      }
      throw error;
    }
    const recorded = await this.#usageEventByIdempotencyKey(
      normalized.idempotencyKey,
    );
    if (!recorded) return undefined;
    return {
      usageEvent: recorded,
      balance: await this.getCreditBalance(
        recorded.workspaceId ?? recorded.spaceId,
      ),
      inserted: recorded.id === normalized.id,
    };
  }

  async listUsageEvents(spaceId: string): Promise<readonly UsageEvent[]> {
    await this.#ensureSchema();
    const rows = await this.#orm
      .select()
      .from(schema.usageEvents)
      .where(eq(schema.usageEvents.spaceId, spaceId))
      .orderBy(asc(schema.usageEvents.createdAt), asc(schema.usageEvents.id));
    return rows.map(usageEventFromRow);
  }

  async listUsageEventsPage(
    spaceId: string,
    params: PageParams,
  ): Promise<Page<UsageEvent>> {
    await this.#ensureSchema();
    const limit = clampPageLimit(params.limit);
    const rows = await this.#orm
      .select()
      .from(schema.usageEvents)
      .where(
        d1KeysetWhereDesc(
          eq(schema.usageEvents.spaceId, spaceId),
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

  async #billingAutoRechargeAttemptById(
    id: string,
  ): Promise<BillingAutoRechargeAttempt | undefined> {
    return await this.#drizzleFirstJson<BillingAutoRechargeAttempt>(
      schema.billingAutoRechargeAttempts,
      schema.billingAutoRechargeAttempts.recordJson,
      eq(schema.billingAutoRechargeAttempts.id, id),
    ).then((row) =>
      row ? normalizeBillingAutoRechargeAttempt(row) : undefined,
    );
  }

  async #billingAutoRechargeAttemptByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<BillingAutoRechargeAttempt | undefined> {
    return await this.#drizzleFirstJson<BillingAutoRechargeAttempt>(
      schema.billingAutoRechargeAttempts,
      schema.billingAutoRechargeAttempts.recordJson,
      eq(schema.billingAutoRechargeAttempts.idempotencyKey, idempotencyKey),
    ).then((row) =>
      row ? normalizeBillingAutoRechargeAttempt(row) : undefined,
    );
  }

  // -- backups (§33 layer 1 / §26 R2_BACKUPS) ----------------------------------
  //
  // One pointer row per sealed control-backup bundle written to R2_BACKUPS. The
  // bundle bytes live in object storage; only the pointer round trips through
  // record_json. Listing is newest-first (created_at desc, id desc).

  async putBackupRecord(record: BackupRecord): Promise<BackupRecord> {
    await this.#drizzleUpsert(schema.backups, {
      id: record.id,
      spaceId: record.spaceId,
      installationId: record.installationId ?? null,
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

  async listBackupRecords(spaceId: string): Promise<readonly BackupRecord[]> {
    return await this.#drizzleManyJson<BackupRecord>(
      schema.backups,
      schema.backups.recordJson,
      {
        where: eq(schema.backups.spaceId, spaceId),
        orderBy: [desc(schema.backups.createdAt), desc(schema.backups.id)],
      },
    );
  }

  async listBackupRecordsPage(
    spaceId: string,
    params: PageParams,
  ): Promise<Page<BackupRecord>> {
    const limit = clampPageLimit(params.limit);
    // Newest-first listing ⇒ descending keyset.
    const rows = await this.#drizzleManyJson<BackupRecord>(
      schema.backups,
      schema.backups.recordJson,
      {
        where: d1KeysetWhereDesc(
          eq(schema.backups.spaceId, spaceId),
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
    readonly spaceId: string;
    readonly sourceId?: string | null;
    readonly installationId: string | null;
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
      spaceId: row.spaceId,
      sourceId: row.sourceId ?? null,
      installationId: row.installationId,
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
    // Serialize concurrent callers onto the one in-flight bootstrap, but never
    // cache a REJECTED promise: a transient failure (e.g. a contended DDL) would
    // otherwise poison the isolate so every later method rejects forever. On
    // failure, clear the memo so the next call retries; on success, the resolved
    // promise stays cached and bootstrap runs exactly once.
    if (this.#initialized === undefined) {
      const attempt = ensureD1OpenTofuLedgerSchema(this.db).catch(
        (error: unknown) => {
          if (this.#initialized === attempt) this.#initialized = undefined;
          throw error;
        },
      );
      this.#initialized = attempt;
    }
    await this.#initialized;
  }
}

export function createCloudflareD1OpenTofuDeploymentStore(
  db: D1Database,
): OpenTofuDeploymentStore {
  return new CloudflareD1OpenTofuDeploymentStore(db);
}

// -- atomic-commit statement builders ------------------------------------------
//
// These return the UNAWAITED drizzle insert builders the atomic
// commitAppliedDeployment batch feeds to this.#orm.batch(...). The column
// payloads mirror the #drizzleUpsert calls in
// put{Deployment,StateSnapshot,OutputSnapshot} exactly so a record written
// through the atomic batch is byte-for-byte identical to one written through the
// individual put* path.

function d1UpsertDeploymentStmt(
  orm: DrizzleD1Database<typeof schema>,
  deployment: Deployment,
) {
  const values = {
    id: deployment.id,
    spaceId: deployment.spaceId,
    installationId: deployment.installationId,
    environment: deployment.environment,
    applyRunId: deployment.applyRunId,
    sourceSnapshotId: deployment.sourceSnapshotId,
    dependencySnapshotId: deployment.dependencySnapshotId ?? null,
    stateGeneration: deployment.stateGeneration,
    outputSnapshotId: deployment.outputSnapshotId,
    outputsPublicJson: deployment.outputsPublic,
    status: deployment.status,
    createdAt: deployment.createdAt,
  };
  return orm
    .insert(schema.deployments)
    .values(values)
    .onConflictDoUpdate({ target: schema.deployments.id, set: values });
}

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
    spaceId: run.workspaceId ?? run.spaceId,
    sourceId: generic.sourceId ?? null,
    installationId: run.installationId ?? null,
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
        spaceId: schema.runs.spaceId,
        sourceId: schema.runs.sourceId,
        installationId: schema.runs.installationId,
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

function d1InstallationStateGuardStmt(
  orm: DrizzleD1Database<typeof schema>,
  installationId: string,
  currentStateGeneration: number,
  status: Installation["status"] | undefined,
) {
  const expected = orm
    .select({ one: sql`1` })
    .from(schema.installations)
    .where(
      and(
        eq(schema.installations.id, installationId),
        eq(schema.installations.currentStateGeneration, currentStateGeneration),
        status === undefined
          ? undefined
          : eq(schema.installations.status, status),
      ),
    );
  return orm.insert(schema.installations).select(
    orm
      .select({
        id: schema.installations.id,
        spaceId: schema.installations.spaceId,
        projectId: schema.installations.projectId,
        name: schema.installations.name,
        slug: schema.installations.slug,
        sourceId: schema.installations.sourceId,
        installType: schema.installations.installType,
        installConfigId: schema.installations.installConfigId,
        environment: schema.installations.environment,
        currentDeploymentId: schema.installations.currentDeploymentId,
        currentStateGeneration: schema.installations.currentStateGeneration,
        currentOutputSnapshotId: schema.installations.currentOutputSnapshotId,
        status: schema.installations.status,
        recordJson: schema.installations.recordJson,
        createdAt: schema.installations.createdAt,
        updatedAt: schema.installations.updatedAt,
      })
      .from(schema.installations)
      .where(
        and(eq(schema.installations.id, installationId), notExists(expected)),
      ),
  );
}

function d1BillingAutoRechargePendingGuardStmt(
  db: D1Database,
  attemptId: string,
) {
  return db
    .prepare(
      `insert into billing_auto_recharge_attempts (
         id, space_id, run_id, billing_account_id, idempotency_key,
         period_start, period_end, requested_usd_micros,
         monthly_limit_usd_micros, charged_usd_micros, status,
         stripe_payment_intent_id, provider_status, failure_reason,
         record_json, created_at, updated_at
       )
       select
         id, space_id, run_id, billing_account_id, idempotency_key,
         period_start, period_end, requested_usd_micros,
         monthly_limit_usd_micros, charged_usd_micros, status,
         stripe_payment_intent_id, provider_status, failure_reason,
         record_json, created_at, updated_at
       from billing_auto_recharge_attempts
       where id = ?
         and not exists (
           select 1
           from billing_auto_recharge_attempts
           where id = ?
             and status <> 'succeeded'
         )`,
    )
    .bind(attemptId, attemptId);
}

function isD1RunLeaseLostError(error: unknown): boolean {
  return error instanceof Error
    ? error.message.includes("UNIQUE constraint failed: runs.id") ||
        error.message.includes("constraint failed: runs.id")
    : false;
}

function isD1InstallationStateGuardError(error: unknown): boolean {
  // P4: the ledger table is physically `capsules`; the conflicting-insert guard
  // (see d1InstallationStateGuardStmt) trips the `capsules.id` primary-key
  // constraint. The pre-rename `installations.id` form is matched too so the
  // guard keeps working on a database that has not yet applied the rename.
  return error instanceof Error
    ? error.message.includes("UNIQUE constraint failed: capsules.id") ||
        error.message.includes("constraint failed: capsules.id") ||
        error.message.includes("UNIQUE constraint failed: installations.id") ||
        error.message.includes("constraint failed: installations.id")
    : false;
}

function isD1BillingAutoRechargeAlreadySettledError(error: unknown): boolean {
  return error instanceof Error
    ? error.message.includes(
        "UNIQUE constraint failed: billing_auto_recharge_attempts.id",
      ) ||
        error.message.includes(
          "constraint failed: billing_auto_recharge_attempts.id",
        )
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

function d1UpsertStateSnapshotStmt(
  orm: DrizzleD1Database<typeof schema>,
  snapshot: StateSnapshot,
) {
  return orm
    .insert(schema.stateSnapshots)
    .values({
      id: snapshot.id,
      spaceId: snapshot.workspaceId ?? snapshot.spaceId,
      installationId: snapshot.capsuleId ?? snapshot.installationId,
      environment: snapshot.environment,
      generation: snapshot.generation,
      objectKey: snapshot.objectKey,
      digest: snapshot.digest,
      createdByRunId: snapshot.createdByRunId,
      createdAt: snapshot.createdAt,
    })
    .onConflictDoUpdate({
      target: [
        schema.stateSnapshots.installationId,
        schema.stateSnapshots.environment,
        schema.stateSnapshots.generation,
      ],
      set: {
        id: snapshot.id,
        spaceId: snapshot.spaceId,
        objectKey: snapshot.objectKey,
        digest: snapshot.digest,
        createdByRunId: snapshot.createdByRunId,
        createdAt: snapshot.createdAt,
      },
    });
}

function d1UpsertOutputSnapshotStmt(
  orm: DrizzleD1Database<typeof schema>,
  snapshot: OutputSnapshot,
) {
  const values = {
    id: snapshot.id,
    spaceId: snapshot.spaceId,
    installationId: snapshot.capsuleId ?? snapshot.installationId,
    stateGeneration: snapshot.stateGeneration,
    recordJson: snapshot,
    createdAt: snapshot.createdAt,
  };
  return orm
    .insert(schema.outputSnapshots)
    .values(values)
    .onConflictDoUpdate({ target: schema.outputSnapshots.id, set: values });
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

// -- Deployment / StateSnapshot row mapping ------------------------------------
//
// The columnar deployments / state_snapshots tables carry every contract field
// in §27 columns (no record_json), so Drizzle rows are reconstructed field-by-field.

function deploymentFromDrizzleRow(row: {
  readonly id: string;
  readonly spaceId: string;
  readonly installationId: string;
  readonly environment: string;
  readonly applyRunId: string;
  readonly sourceSnapshotId: string;
  readonly dependencySnapshotId: string | null;
  readonly stateGeneration: number;
  readonly outputSnapshotId: string;
  readonly outputsPublicJson: unknown;
  readonly status: string;
  readonly createdAt: string;
}): Deployment {
  return {
    id: row.id,
    spaceId: row.spaceId,
    installationId: row.installationId,
    environment: row.environment,
    applyRunId: row.applyRunId,
    sourceSnapshotId: row.sourceSnapshotId,
    ...(row.dependencySnapshotId !== null
      ? { dependencySnapshotId: row.dependencySnapshotId }
      : {}),
    stateGeneration: row.stateGeneration,
    outputSnapshotId: row.outputSnapshotId,
    outputsPublic: row.outputsPublicJson as Record<string, unknown>,
    status: row.status as Deployment["status"],
    createdAt: row.createdAt,
  };
}

function stateSnapshotFromDrizzleRow(row: {
  readonly id: string;
  readonly spaceId: string;
  readonly installationId: string;
  readonly environment: string;
  readonly generation: number;
  readonly objectKey: string;
  readonly digest: string;
  readonly createdByRunId: string;
  readonly createdAt: string;
}): StateSnapshot {
  return {
    id: row.id,
    workspaceId: row.spaceId,
    capsuleId: row.installationId,
    spaceId: row.spaceId,
    installationId: row.installationId,
    environment: row.environment,
    generation: row.generation,
    objectKey: row.objectKey,
    digest: row.digest,
    createdByRunId: row.createdByRunId,
    createdAt: row.createdAt,
  };
}

function changes(result: D1Result): number {
  return result.meta?.changes ?? 0;
}

/**
 * Lazily create the §27 control-plane tables. Idempotent (`IF NOT EXISTS`);
 * called once per store instance via the memoized init promise. Rich internal
 * records (runner profiles, runs, install configs, connections, sources,
 * snapshots, internal provider resolver binding sets, spaces, provider resolver records) keep a `record_json`
 * / `run_json` TEXT column carrying the full contract shape alongside the §27
 * indexed columns; the columnar `deployments` / `state_snapshots` tables carry
 * every field in §27 columns directly. `runs_inputs` is the internal PlanRun
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
      install_type text not null,
      trust_level text not null,
      record_json text not null,
      created_at text not null,
      updated_at text not null
    )`,
    `create index if not exists install_configs_space_idx
      on install_configs (space_id)`,
    `create index if not exists install_configs_install_type_idx
      on install_configs (install_type)`,
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
    `create unique index if not exists capsules_space_name_environment_unique
      on capsules (space_id, name, environment)`,
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
      normalized_object_key text,
      normalized_digest text,
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
    `create table if not exists billing_accounts (
      id text primary key,
      owner_type text not null,
      owner_id text not null,
      provider text not null,
      status text not null,
      record_json text not null,
      created_at text not null,
      updated_at text not null
    )`,
    `create index if not exists billing_accounts_owner_idx
      on billing_accounts (owner_type, owner_id)`,
    `create index if not exists billing_accounts_status_idx
      on billing_accounts (status)`,
    `create table if not exists plans (
      id text primary key,
      name text not null,
      monthly_base_price integer not null,
      included_usd_micros integer,
      included_credits integer not null,
      limits_json text not null,
      record_json text not null,
      created_at text not null,
      updated_at text not null
    )`,
    `create table if not exists space_subscriptions (
      id text primary key,
      space_id text not null,
      billing_account_id text not null,
      plan_id text not null,
      status text not null,
      record_json text not null,
      created_at text not null,
      updated_at text not null
    )`,
    `create index if not exists space_subscriptions_space_idx
      on space_subscriptions (space_id)`,
    `create index if not exists space_subscriptions_billing_account_idx
      on space_subscriptions (billing_account_id)`,
    `create table if not exists credit_balances (
      space_id text primary key,
      available_usd_micros integer,
      reserved_usd_micros integer,
      monthly_included_usd_micros integer,
      purchased_usd_micros integer,
      available_credits integer not null,
      reserved_credits integer not null,
      monthly_included_credits integer not null,
      purchased_credits integer not null,
      updated_at text not null
    )`,
    `create table if not exists billing_auto_recharge_attempts (
      id text primary key,
      space_id text not null,
      run_id text not null,
      billing_account_id text not null,
      idempotency_key text not null,
      period_start text not null,
      period_end text,
      requested_usd_micros integer not null,
      monthly_limit_usd_micros integer,
      charged_usd_micros integer,
      status text not null,
      stripe_payment_intent_id text,
      provider_status text,
      failure_reason text,
      record_json text not null,
      created_at text not null,
      updated_at text not null
    )`,
    `create unique index if not exists billing_auto_recharge_attempts_idempotency_unique
      on billing_auto_recharge_attempts (idempotency_key)`,
    `create index if not exists billing_auto_recharge_attempts_space_period_status_idx
      on billing_auto_recharge_attempts (space_id, period_start, status)`,
    `create index if not exists billing_auto_recharge_attempts_run_idx
      on billing_auto_recharge_attempts (run_id)`,
    `create table if not exists usage_events (
      id text primary key,
      space_id text not null,
      installation_id text,
      run_id text,
      meter_id text,
      resource_family text,
      resource_id text,
      operation text,
      resource_metadata_json text,
      kind text not null,
      quantity real not null,
      usd_micros integer,
      credits integer not null,
      source text not null,
      idempotency_key text not null,
      created_at text not null
    )`,
    `create index if not exists usage_events_space_idx
      on usage_events (space_id)`,
    `create index if not exists usage_events_run_idx
      on usage_events (run_id)`,
    `create unique index if not exists usage_events_idempotency_key_unique
      on usage_events (idempotency_key)`,
    `create table if not exists credit_reservations (
      id text primary key,
      space_id text not null,
      run_id text not null,
      estimated_usd_micros integer,
      estimated_credits integer not null,
      status text not null,
      mode text not null,
      record_json text not null,
      created_at text not null,
      expires_at text not null
    )`,
    `create index if not exists credit_reservations_space_idx
      on credit_reservations (space_id)`,
    `create index if not exists credit_reservations_run_idx
      on credit_reservations (run_id)`,
    `create index if not exists credit_reservations_status_idx
      on credit_reservations (status)`,
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
      name text not null,
      managed_by text not null,
      spec_json text not null,
      phase text not null,
      generation integer not null,
      observed_generation integer not null,
      outputs_json text,
      conditions_json text,
      labels_json text,
      created_at text not null,
      updated_at text not null
    )`,
    `create unique index if not exists resource_shapes_space_kind_name_unique
      on resource_shapes (space_id, kind, name)`,
    `create index if not exists resource_shapes_space_idx
      on resource_shapes (space_id)`,
    `create table if not exists resolution_locks (
      resource_id text primary key,
      selected_implementation text not null,
      target text not null,
      locked integer not null,
      reason_json text not null,
      portability text,
      native_resources_json text,
      locked_at text not null,
      updated_at text not null
    )`,
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
  for (const migration of D1_OPEN_TOFU_SCHEMA_MIGRATIONS) {
    await applyD1OpenTofuSchemaMigration(db, migration);
  }
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
    version: 5,
    name: "d1_opentofu_credit_reservation_mode",
    checksumSource: `
credit_reservations.mode text not null default disabled
`,
    async apply(db) {
      await ensureD1Column(
        db,
        "credit_reservations",
        "mode",
        "text not null default 'disabled'",
      );
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
    version: 14,
    name: "d1_opentofu_billing_usd_micros",
    checksumSource: `
plans.included_usd_micros nullable USD micros grant
credit_balances USD micros columns nullable with legacy-credit backfill
usage_events.usd_micros nullable with legacy-credit backfill
credit_reservations.estimated_usd_micros nullable with legacy-credit backfill
`,
    async apply(db) {
      await ensureD1Column(db, "plans", "included_usd_micros", "integer");
      await db
        .prepare(
          `update plans
           set included_usd_micros = included_credits * 1000000
           where included_usd_micros is null`,
        )
        .run();
      await ensureD1Column(
        db,
        "credit_balances",
        "available_usd_micros",
        "integer",
      );
      await ensureD1Column(
        db,
        "credit_balances",
        "reserved_usd_micros",
        "integer",
      );
      await ensureD1Column(
        db,
        "credit_balances",
        "monthly_included_usd_micros",
        "integer",
      );
      await ensureD1Column(
        db,
        "credit_balances",
        "purchased_usd_micros",
        "integer",
      );
      await db
        .prepare(
          `update credit_balances
           set available_usd_micros = coalesce(available_usd_micros, available_credits * 1000000),
               reserved_usd_micros = coalesce(reserved_usd_micros, reserved_credits * 1000000),
               monthly_included_usd_micros = coalesce(monthly_included_usd_micros, monthly_included_credits * 1000000),
               purchased_usd_micros = coalesce(purchased_usd_micros, purchased_credits * 1000000)`,
        )
        .run();
      await ensureD1Column(db, "usage_events", "usd_micros", "integer");
      await db
        .prepare(
          `update usage_events
           set usd_micros = credits * 1000000
           where usd_micros is null`,
        )
        .run();
      await ensureD1Column(
        db,
        "credit_reservations",
        "estimated_usd_micros",
        "integer",
      );
      await db
        .prepare(
          `update credit_reservations
           set estimated_usd_micros = estimated_credits * 1000000
           where estimated_usd_micros is null`,
        )
        .run();
    },
  },
  {
    version: 15,
    name: "d1_opentofu_billing_auto_recharge_attempts",
    checksumSource: `
billing_auto_recharge_attempts table with unique idempotency key
monthly cap index over space_id, period_start, status
`,
    async apply(db) {
      await db
        .prepare(
          `create table if not exists billing_auto_recharge_attempts (
            id text primary key,
            space_id text not null,
            run_id text not null,
            billing_account_id text not null,
            idempotency_key text not null,
            period_start text not null,
            period_end text,
            requested_usd_micros integer not null,
            monthly_limit_usd_micros integer,
            charged_usd_micros integer,
            status text not null,
            stripe_payment_intent_id text,
            provider_status text,
            failure_reason text,
            record_json text not null,
            created_at text not null,
            updated_at text not null
          )`,
        )
        .run();
      await db
        .prepare(
          `create unique index if not exists billing_auto_recharge_attempts_idempotency_unique
            on billing_auto_recharge_attempts (idempotency_key)`,
        )
        .run();
      await db
        .prepare(
          `create index if not exists billing_auto_recharge_attempts_space_period_status_idx
            on billing_auto_recharge_attempts (space_id, period_start, status)`,
        )
        .run();
      await db
        .prepare(
          `create index if not exists billing_auto_recharge_attempts_run_idx
            on billing_auto_recharge_attempts (run_id)`,
        )
        .run();
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
] as const satisfies readonly D1OpenTofuSchemaMigration[];

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
  const info = new Map(
    (await d1ColumnInfo(db, "schema_migrations")).map((row) => [row.name, row]),
  );
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
  await validateD1SchemaMigrationLedgerRows(db);
}

type D1SchemaMigrationRow = {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly applied_at: string;
};

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

  await migration.apply(db);
  await db
    .prepare(
      `insert into schema_migrations (version, name, checksum, applied_at)
      values (?, ?, ?, ?)`,
    )
    .bind(migration.version, migration.name, checksum, new Date().toISOString())
    .run();
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
  `create index if not exists billing_accounts_owner_idx
      on billing_accounts (owner_type, owner_id)`,
  `create index if not exists billing_accounts_status_idx
      on billing_accounts (status)`,
  `create index if not exists space_subscriptions_space_idx
      on space_subscriptions (space_id)`,
  `create index if not exists space_subscriptions_billing_account_idx
      on space_subscriptions (billing_account_id)`,
  `create index if not exists usage_events_space_idx
      on usage_events (space_id)`,
  `create index if not exists usage_events_run_idx
      on usage_events (run_id)`,
  `create unique index if not exists usage_events_idempotency_key_unique
      on usage_events (idempotency_key)`,
  `create index if not exists credit_reservations_space_idx
      on credit_reservations (space_id)`,
  `create index if not exists credit_reservations_run_idx
      on credit_reservations (run_id)`,
  `create index if not exists credit_reservations_status_idx
      on credit_reservations (status)`,
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
  const hasCurrentOutputSnapshotId = columns.has("current_output_snapshot_id");
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
             ${hasCurrentOutputSnapshotId ? "current_output_snapshot_id" : "null"},
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
      `create unique index if not exists installations_space_name_environment_unique
      on installations (space_id, name, environment)`,
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
 * Without this back-fill the only reader of historical rows would be the legacy
 * dual-read branch in {@link CloudflareD1OpenTofuDeploymentStore.listSourceSyncRuns}
 * (`installation_id == sourceId`), so dropping that branch later would silently
 * drop history. This normalizes the rows so `source_id` is the canonical key,
 * exactly like Postgres v42; the dual-read branch is intentionally kept for
 * backward compatibility until a separate change verifies a live DB.
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
