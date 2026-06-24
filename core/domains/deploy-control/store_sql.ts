/**
 * SQL-backed OpenTofu deployment-control-plane ledger (core-spec.md §27).
 *
 * The store keeps searchable columns for common list/read paths and persists
 * the contract object as JSON so the public run ledger can evolve without a
 * schema migration for every non-indexed field.
 *
 * Logical schema is the Space-direct Installation model: spaces, install_configs,
 * provider_envs, installations (UNIQUE(space_id, name,
 * environment)), provider_env_binding_sets (keyed (installation_id, environment)),
 * state_snapshots (keyed (installation_id, environment, generation) UNIQUE),
 * deployments (new shape), and a SINGLE `runs` table — the internal PlanRun
 * (kind `plan`), ApplyRun (kind `apply`), SourceSyncRun (kind `source_sync`),
 * CompatibilityCheck Run (kind `compatibility_check`), and Backup Run records
 * persist as rows discriminated by `kind`; the typed accessors verify the row
 * kind before parsing.
 */
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
import { coerceRunStatus } from "@takosumi/internal/deploy-control-api";
import type { SqlClient } from "../../adapters/storage/sql.ts";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
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
import type { Space } from "takosumi-contract/spaces";
import type {
  InstallationProviderEnvBindingSet,
  ProviderEnv,
} from "takosumi-contract/provider-envs";
import type {
  Dependency,
  DependencySnapshot,
} from "takosumi-contract/dependencies";
import type {
  OutputShare,
  OutputSnapshot,
} from "takosumi-contract/output-snapshots";
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
  BillingPlan,
  CreditBalance,
  CreditReservation,
  SpaceSubscription,
  UsageEvent,
} from "takosumi-contract/billing";
import type {
  CredentialMintEvent,
  SecurityFinding,
} from "takosumi-contract/security";
import type { ProviderCatalogEntry } from "takosumi-contract/providers";
import type {
  CommitAppliedDeploymentInput,
  CommitAppliedDeploymentResult,
  CommitRestoredStateInput,
  CommitRestoredStateResult,
  InstallationPatch,
  InstallationPatchGuard,
  OpenTofuDeploymentStore,
  PlanRunInputs,
  StoredSecretBlob,
  StoredSource,
  TransitionRunInput,
  TransitionRunResult,
} from "./store.ts";
import {
  clampActivityLimit,
  InstallationPatchGuardConflict,
  InstallationStateGenerationGuardConflict,
} from "./store.ts";
import type { SqlTransaction } from "../../adapters/storage/sql.ts";

/** Discriminator stored in the single `runs` table (§27). */
// §27 runs.type values. Destroy runs persist their own discriminator
// (destroy_plan / destroy_apply) so the raw table matches the spec enum and
// the D1 backend; the typed accessors read both kinds of their family.
const RUN_KINDS_PLAN = ["plan", "destroy_plan"] as const;
const RUN_KINDS_APPLY = ["apply", "destroy_apply"] as const;
const RUN_KIND_SOURCE_SYNC = "source_sync";
const RUN_KIND_COMPATIBILITY_CHECK = "compatibility_check";
const RUN_KIND_BACKUP = "backup";
const RUN_KIND_RESTORE = "restore";

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

export class SqlOpenTofuDeploymentStore implements OpenTofuDeploymentStore {
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

  async putProviderCatalogEntry(
    entry: ProviderCatalogEntry,
  ): Promise<ProviderCatalogEntry> {
    await this.#pgUpsert(pgSchema.providerCatalog, {
      id: entry.id,
      providerSource: entry.providerSource,
      primaryMaterialization: "secret",
      gatewayEligible: 0,
      entryJson: entry,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    });
    return entry;
  }

  async getProviderCatalogEntry(
    id: string,
  ): Promise<ProviderCatalogEntry | undefined> {
    return await this.#pgFirstJson<ProviderCatalogEntry>(
      pgSchema.providerCatalog,
      pgSchema.providerCatalog.entryJson,
      eq(pgSchema.providerCatalog.id, id),
    );
  }

  async listProviderCatalogEntries(): Promise<readonly ProviderCatalogEntry[]> {
    return await this.#pgManyJson<ProviderCatalogEntry>(
      pgSchema.providerCatalog,
      pgSchema.providerCatalog.entryJson,
      {
        orderBy: [
          asc(pgSchema.providerCatalog.primaryMaterialization),
          asc(pgSchema.providerCatalog.id),
        ],
      },
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
        spaceId: run.spaceId,
        installationId: run.installationId ?? null,
        createdAt: run.createdAt,
        json: run,
      },
    );
    return run;
  }

  async getPlanRun(id: string): Promise<PlanRun | undefined> {
    return coerceRunRowStatus(
      await this.#getRun<PlanRun>(id, [...RUN_KINDS_PLAN, "drift_check"]),
    );
  }

  async putApplyRun(run: ApplyRun): Promise<ApplyRun> {
    await this.#putRunDrizzle(
      run.operation === "destroy" ? "destroy_apply" : "apply",
      {
        id: run.id,
        spaceId: run.spaceId,
        installationId: run.installationId ?? null,
        createdAt: run.createdAt,
        json: run,
      },
    );
    return run;
  }

  async getApplyRun(id: string): Promise<ApplyRun | undefined> {
    return coerceRunRowStatus(
      await this.#getRun<ApplyRun>(id, RUN_KINDS_APPLY),
    );
  }

  /**
   * Status-conditional, lease-fenced compare-and-set transition (the queue
   * consumer's correctness-critical claim primitive). Mirrors the CAS shape of
   * the revoke-debt `#updateMutable`: a guarded drizzle UPDATE that only matches
   * the row when its `status` is still in `expectFrom` (and, when set, its
   * `leaseToken` still equals `expectLeaseToken`). On a win the row's status /
   * run JSON advance to `input.run`; `setLeaseToken` / `clearLeaseToken` /
   * `heartbeatAt` write the lease and heartbeat columns. A lost race (0 rows)
   * re-reads the current row and returns it with `won: false`.
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
    // Resolve the heartbeat (input override wins over the value on `run`) and
    // bake it into the persisted run JSON so the column and run_json agree.
    const heartbeatAt = input.heartbeatAt ?? input.run.heartbeatAt;
    const persisted: PlanRun | ApplyRun | SourceSyncRun | Run =
      heartbeatAt === undefined
        ? input.run
        : ({ ...input.run, heartbeatAt } as
            | PlanRun
            | ApplyRun
            | SourceSyncRun
            | Run);
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
        ...(heartbeatAt === undefined ? {} : { heartbeatAt }),
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
        ),
      )
      .returning({ json: pgSchema.runs.runJson });
    const won = parseRow(rows[0]) as
      | PlanRun
      | ApplyRun
      | SourceSyncRun
      | Run
      | undefined;
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
      spaceId: run.spaceId,
      sourceId: run.sourceId,
      installationId: null,
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
      spaceId: run.spaceId,
      sourceId: run.sourceId ?? null,
      installationId: null,
      createdAt: run.createdAt,
      json: run,
    });
    return run;
  }

  async getCompatibilityCheckRun(id: string): Promise<Run | undefined> {
    return await this.#getRun<Run>(id, RUN_KIND_COMPATIBILITY_CHECK);
  }

  async putBackupRun(run: Run): Promise<Run> {
    if (run.type !== "backup" && run.type !== "restore") {
      throw new Error("putBackupRun only accepts backup/restore runs");
    }
    await this.#putRunDrizzle(run.type, {
      id: run.id,
      spaceId: run.spaceId,
      installationId: run.installationId ?? null,
      createdAt: run.createdAt,
      json: run,
    });
    return run;
  }

  async getBackupRun(id: string): Promise<Run | undefined> {
    return await this.#getRun<Run>(id, [RUN_KIND_BACKUP, RUN_KIND_RESTORE]);
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
    const legacyRows = await this.#db
      .select({ json: pgSchema.runs.runJson })
      .from(pgSchema.runs)
      .where(
        and(
          eq(pgSchema.runs.kind, RUN_KIND_SOURCE_SYNC),
          eq(pgSchema.runs.installationId, sourceId),
        ),
      )
      .orderBy(asc(pgSchema.runs.createdAt), asc(pgSchema.runs.id));
    const byId = new Map<string, SourceSyncRun>();
    for (const row of [...currentRows, ...legacyRows]) {
      const parsed = parseRow(row) as SourceSyncRun;
      byId.set(parsed.id, parsed);
    }
    return [...byId.values()].sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  }

  // --- artifact ledger (§30 artifacts) -------------------------------------

  async putArtifactRecord(record: ArtifactRecord): Promise<ArtifactRecord> {
    await this.#pgUpsert(pgSchema.artifacts, {
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
      readonly spaceId: string;
      readonly sourceId?: string | null;
      readonly installationId: string | null;
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
      spaceId: fields.spaceId,
      sourceId: fields.sourceId ?? null,
      installationId: fields.installationId,
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
          spaceId: values.spaceId,
          sourceId: values.sourceId,
          installationId: values.installationId,
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
      .insert(pgSchema.runsInputs)
      .values({ planRunId: inputs.planRunId, inputsJson: inputs })
      .onConflictDoUpdate({
        target: pgSchema.runsInputs.planRunId,
        set: { inputsJson: inputs },
      });
  }

  async getPlanRunInputs(
    planRunId: string,
  ): Promise<PlanRunInputs | undefined> {
    const rows = await this.#db
      .select({ json: pgSchema.runsInputs.inputsJson })
      .from(pgSchema.runsInputs)
      .where(eq(pgSchema.runsInputs.planRunId, planRunId))
      .limit(1);
    return parseRow(rows[0]) as PlanRunInputs | undefined;
  }

  async deletePlanRunInputs(planRunId: string): Promise<void> {
    await this.#db
      .delete(pgSchema.runsInputs)
      .where(eq(pgSchema.runsInputs.planRunId, planRunId));
  }

  // --- spaces (§4) ----------------------------------------------------------

  async putSpace(space: Space): Promise<Space> {
    await this.#db
      .insert(pgSchema.spaces)
      .values({
        id: space.id,
        handle: space.handle,
        spaceJson: space,
        createdAt: space.createdAt,
        updatedAt: space.updatedAt,
      })
      .onConflictDoUpdate({
        target: pgSchema.spaces.id,
        set: {
          handle: space.handle,
          spaceJson: space,
          createdAt: space.createdAt,
          updatedAt: space.updatedAt,
        },
      });
    return space;
  }

  async getSpace(id: string): Promise<Space | undefined> {
    const rows = await this.#db
      .select({ json: pgSchema.spaces.spaceJson })
      .from(pgSchema.spaces)
      .where(eq(pgSchema.spaces.id, id))
      .limit(1);
    return parseRow(rows[0]) as Space | undefined;
  }

  async getSpaceByHandle(handle: string): Promise<Space | undefined> {
    const rows = await this.#db
      .select({ json: pgSchema.spaces.spaceJson })
      .from(pgSchema.spaces)
      .where(eq(pgSchema.spaces.handle, handle))
      .limit(1);
    return parseRow(rows[0]) as Space | undefined;
  }

  async listSpaces(): Promise<readonly Space[]> {
    const rows = await this.#db
      .select({ json: pgSchema.spaces.spaceJson })
      .from(pgSchema.spaces)
      .orderBy(asc(pgSchema.spaces.createdAt), asc(pgSchema.spaces.id));
    return rows.map((row) => parseRow(row) as Space);
  }

  async listSpacesByOwner(ownerUserId: string): Promise<readonly Space[]> {
    const rows = await this.#db
      .select({ json: pgSchema.spaces.spaceJson })
      .from(pgSchema.spaces)
      .where(
        sql`${pgSchema.spaces.spaceJson} ->> 'ownerUserId' = ${ownerUserId}`,
      )
      .orderBy(asc(pgSchema.spaces.createdAt), asc(pgSchema.spaces.id));
    return rows.map((row) => parseRow(row) as Space);
  }

  // --- install_configs (§11) ------------------------------------------------

  async putInstallConfig(config: InstallConfig): Promise<InstallConfig> {
    await this.#pgUpsert(pgSchema.installConfigs, {
      id: config.id,
      spaceId: config.spaceId ?? null,
      installType: config.installType,
      trustLevel: config.trustLevel,
      configJson: config,
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
    });
    return config;
  }

  async getInstallConfig(id: string): Promise<InstallConfig | undefined> {
    return await this.#pgFirstJson<InstallConfig>(
      pgSchema.installConfigs,
      pgSchema.installConfigs.configJson,
      eq(pgSchema.installConfigs.id, id),
    );
  }

  async listInstallConfigs(
    spaceId?: string,
  ): Promise<readonly InstallConfig[]> {
    return await this.#pgManyJson<InstallConfig>(
      pgSchema.installConfigs,
      pgSchema.installConfigs.configJson,
      {
        where:
          spaceId === undefined
            ? undefined
            : eq(pgSchema.installConfigs.spaceId, spaceId),
        orderBy: [
          asc(pgSchema.installConfigs.createdAt),
          asc(pgSchema.installConfigs.id),
        ],
      },
    );
  }

  // --- installations (§5 / §27, UNIQUE(space_id, name, environment)) --------

  async putInstallation(installation: Installation): Promise<Installation> {
    const values = installationValues(installation);
    await this.#db
      .insert(pgSchema.installations)
      .values(values)
      .onConflictDoUpdate({
        target: pgSchema.installations.id,
        set: {
          spaceId: values.spaceId,
          name: values.name,
          environment: values.environment,
          sourceId: values.sourceId,
          installConfigId: values.installConfigId,
          currentDeploymentId: values.currentDeploymentId,
          status: values.status,
          installationJson: values.installationJson,
          createdAt: values.createdAt,
          updatedAt: values.updatedAt,
        },
      });
    return installation;
  }

  async getInstallation(id: string): Promise<Installation | undefined> {
    const rows = await this.#db
      .select({ json: pgSchema.installations.installationJson })
      .from(pgSchema.installations)
      .where(eq(pgSchema.installations.id, id))
      .limit(1);
    return parseRow(rows[0]) as Installation | undefined;
  }

  async getInstallationByName(
    spaceId: string,
    name: string,
    environment: string,
  ): Promise<Installation | undefined> {
    const rows = await this.#db
      .select({ json: pgSchema.installations.installationJson })
      .from(pgSchema.installations)
      .where(
        and(
          eq(pgSchema.installations.spaceId, spaceId),
          eq(pgSchema.installations.name, name),
          eq(pgSchema.installations.environment, environment),
        ),
      )
      .limit(1);
    return parseRow(rows[0]) as Installation | undefined;
  }

  async listInstallations(spaceId?: string): Promise<readonly Installation[]> {
    const query = this.#db
      .select({ json: pgSchema.installations.installationJson })
      .from(pgSchema.installations)
      .$dynamic();
    const rows = await (
      spaceId === undefined
        ? query
        : query.where(eq(pgSchema.installations.spaceId, spaceId))
    ).orderBy(
      asc(pgSchema.installations.createdAt),
      asc(pgSchema.installations.id),
    );
    return rows.map((row) => parseRow(row) as Installation);
  }

  async listInstallationsPage(
    spaceId: string,
    params: PageParams,
  ): Promise<Page<Installation>> {
    const limit = clampPageLimit(params.limit);
    const rows = await this.#pgManyJson<Installation>(
      pgSchema.installations,
      pgSchema.installations.installationJson,
      {
        where: pgKeysetWhere(
          eq(pgSchema.installations.spaceId, spaceId),
          pgSchema.installations.createdAt,
          pgSchema.installations.id,
          decodeCursor(params.cursor),
        ),
        orderBy: [
          asc(pgSchema.installations.createdAt),
          asc(pgSchema.installations.id),
        ],
        limit: limit + 1,
      },
    );
    return pageFromProbe(rows, limit);
  }

  async patchInstallation(
    id: string,
    patch: InstallationPatch,
    guard?: InstallationPatchGuard,
  ): Promise<Installation | undefined> {
    const current = await this.getInstallation(id);
    if (!current) return undefined;
    if (
      guard !== undefined &&
      (current.currentDeploymentId !== guard.currentDeploymentId ||
        (guard.status !== undefined && current.status !== guard.status))
    ) {
      throw new InstallationPatchGuardConflict({
        id,
        expectedCurrentDeploymentId: guard.currentDeploymentId,
        actualCurrentDeploymentId: current.currentDeploymentId,
        expectedStatus: guard.status,
        actualStatus: current.status,
      });
    }
    const updated: Installation = { ...current, ...patch };
    if (!guard) return await this.putInstallation(updated);
    // Guarded path: fence on current_deployment_id (and optionally status) in the
    // UPDATE predicate so a concurrent writer cannot win the race between read and
    // write. `is not distinct from` matches NULL == NULL for the unset cursor.
    const values = installationValues(updated);
    const guardedCurrentDeployment =
      guard.currentDeploymentId === undefined ||
      guard.currentDeploymentId === null
        ? isNull(pgSchema.installations.currentDeploymentId)
        : eq(
            pgSchema.installations.currentDeploymentId,
            guard.currentDeploymentId,
          );
    const rows = await this.#db
      .update(pgSchema.installations)
      .set({
        spaceId: values.spaceId,
        name: values.name,
        environment: values.environment,
        sourceId: values.sourceId,
        installConfigId: values.installConfigId,
        currentDeploymentId: values.currentDeploymentId,
        status: values.status,
        installationJson: values.installationJson,
        updatedAt: values.updatedAt,
      })
      .where(
        and(
          eq(pgSchema.installations.id, updated.id),
          guardedCurrentDeployment,
          guard.status === undefined
            ? sql`true`
            : eq(pgSchema.installations.status, guard.status),
        ),
      )
      .returning({ json: pgSchema.installations.installationJson });
    const patched = parseRow(rows[0]) as Installation | undefined;
    if (patched) return patched;
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
   * Atomic apply / destroy-apply ledger commit (spec §20 / §21 / §16). All
   * writes — new/superseded Deployment(s), StateSnapshot, (apply) OutputSnapshot,
   * and the guarded Installation advance — run inside ONE Postgres interactive
   * transaction so a mid-sequence failure rolls the whole unit back instead of
   * leaving torn state. The transaction is opened through the {@link SqlClient}
   * `transaction` seam (a pinned connection), which every SqlClient implements.
   *
   * The guard is fenced in the UPDATE predicate exactly as
   * {@link patchInstallation}: a guard miss (no row updated) re-reads to decide
   * between `{ installation: undefined }` (row gone) and a thrown
   * {@link InstallationPatchGuardConflict} (row moved). A thrown conflict aborts
   * the transaction and rolls back every preceding write.
   */
  async commitAppliedDeployment(
    input: CommitAppliedDeploymentInput,
  ): Promise<CommitAppliedDeploymentResult> {
    return await this.#client.transaction(
      async (transaction: SqlTransaction) => {
        const txDb = this.#drizzleForClient(transaction);
        return await this.#commitAppliedDeploymentWrites(txDb, input);
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
        await pgUpsertStateSnapshot(db, input.stateSnapshot);

        const { installationPatch } = input;
        const current = await this.#getInstallationOn(db, installationPatch.id);
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

        const updated: Installation = {
          ...current,
          ...installationPatch.patch,
        };
        const values = installationValues(updated);
        const rows = await db
          .update(pgSchema.installations)
          .set({
            spaceId: values.spaceId,
            name: values.name,
            environment: values.environment,
            sourceId: values.sourceId,
            installConfigId: values.installConfigId,
            currentDeploymentId: values.currentDeploymentId,
            status: values.status,
            installationJson: values.installationJson,
            updatedAt: values.updatedAt,
          })
          .where(
            and(
              eq(pgSchema.installations.id, updated.id),
              sql`COALESCE((${pgSchema.installations.installationJson}->>'currentStateGeneration')::integer, 0) = ${guard.currentStateGeneration}`,
              guard.status === undefined
                ? sql`true`
                : eq(pgSchema.installations.status, guard.status),
            ),
          )
          .returning({ json: pgSchema.installations.installationJson });
        const patched = parseRow(rows[0]) as Installation | undefined;
        if (patched) return { installation: patched };
        const actual = await this.#getInstallationOn(db, installationPatch.id);
        if (!actual) return { installation: undefined };
        throw new InstallationStateGenerationGuardConflict({
          id: installationPatch.id,
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
   * `#db` or a transaction-bound one). Returns `{ installation }` patched, or
   * `{ installation: undefined }` on a guard miss whose installation row is gone;
   * throws {@link InstallationPatchGuardConflict} on a guard conflict.
   */
  async #commitAppliedDeploymentWrites(
    db: PgRemoteDatabase<typeof pgSchema>,
    input: CommitAppliedDeploymentInput,
  ): Promise<CommitAppliedDeploymentResult> {
    const { installationPatch } = input;
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
    if (input.newDeployment) {
      await pgUpsertDeployment(db, input.newDeployment);
    }
    if (input.supersededDeployment) {
      await pgUpsertDeployment(db, input.supersededDeployment);
    }
    await pgUpsertStateSnapshot(db, input.stateSnapshot);
    if (input.outputSnapshot) {
      await pgUpsertOutputSnapshot(db, input.outputSnapshot);
    }
    // Commit-tail fold (S2): the succeeded ApplyRun + the applied PlanRun land in
    // the SAME interactive transaction as the Deployment. The apply terminal
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
    // Guarded Installation advance, fenced on current_deployment_id (and
    // optionally status) so the patch lands atomically with the writes above.
    const guard = installationPatch.guard;
    const current = await this.#getInstallationOn(db, installationPatch.id);
    if (!current) return { installation: undefined };
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
    const values = installationValues(updated);
    const guardedCurrentDeployment =
      guard.currentDeploymentId === undefined ||
      guard.currentDeploymentId === null
        ? isNull(pgSchema.installations.currentDeploymentId)
        : eq(
            pgSchema.installations.currentDeploymentId,
            guard.currentDeploymentId,
          );
    const rows = await db
      .update(pgSchema.installations)
      .set({
        spaceId: values.spaceId,
        name: values.name,
        environment: values.environment,
        sourceId: values.sourceId,
        installConfigId: values.installConfigId,
        currentDeploymentId: values.currentDeploymentId,
        status: values.status,
        installationJson: values.installationJson,
        updatedAt: values.updatedAt,
      })
      .where(
        and(
          eq(pgSchema.installations.id, updated.id),
          guardedCurrentDeployment,
          guard.status === undefined
            ? sql`true`
            : eq(pgSchema.installations.status, guard.status),
        ),
      )
      .returning({ json: pgSchema.installations.installationJson });
    const patched = parseRow(rows[0]) as Installation | undefined;
    if (patched) return { installation: patched };
    const actual = await this.#getInstallationOn(db, installationPatch.id);
    if (!actual) return { installation: undefined };
    throw new InstallationPatchGuardConflict({
      id: installationPatch.id,
      expectedCurrentDeploymentId: guard.currentDeploymentId,
      actualCurrentDeploymentId: actual.currentDeploymentId,
      expectedStatus: guard.status,
      actualStatus: actual.status,
    });
  }

  /** Reads one Installation by id on the given drizzle handle (tx-aware). */
  async #getInstallationOn(
    db: PgRemoteDatabase<typeof pgSchema>,
    id: string,
  ): Promise<Installation | undefined> {
    const rows = await db
      .select({ json: pgSchema.installations.installationJson })
      .from(pgSchema.installations)
      .where(eq(pgSchema.installations.id, id))
      .limit(1);
    return parseRow(rows[0]) as Installation | undefined;
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

  // --- deployments (§21, new shape) -----------------------------------------

  async putDeployment(deployment: Deployment): Promise<Deployment> {
    await pgUpsertDeployment(this.#db, deployment);
    return deployment;
  }

  async getDeployment(id: string): Promise<Deployment | undefined> {
    return await this.#pgFirstJson<Deployment>(
      pgSchema.deployments,
      pgSchema.deployments.deploymentJson,
      eq(pgSchema.deployments.id, id),
    );
  }

  async listDeployments(
    installationId: string,
  ): Promise<readonly Deployment[]> {
    return await this.#pgManyJson<Deployment>(
      pgSchema.deployments,
      pgSchema.deployments.deploymentJson,
      {
        where: eq(pgSchema.deployments.installationId, installationId),
        orderBy: [
          asc(pgSchema.deployments.createdAt),
          asc(pgSchema.deployments.id),
        ],
      },
    );
  }

  async listDeploymentsBySpace(
    spaceId: string,
  ): Promise<readonly Deployment[]> {
    return await this.#pgManyJson<Deployment>(
      pgSchema.deployments,
      pgSchema.deployments.deploymentJson,
      {
        where: eq(pgSchema.deployments.spaceId, spaceId),
        orderBy: [
          asc(pgSchema.deployments.createdAt),
          asc(pgSchema.deployments.id),
        ],
      },
    );
  }

  async listDeploymentsPage(
    installationId: string,
    params: PageParams,
  ): Promise<Page<Deployment>> {
    const limit = clampPageLimit(params.limit);
    const rows = await this.#pgManyJson<Deployment>(
      pgSchema.deployments,
      pgSchema.deployments.deploymentJson,
      {
        where: pgKeysetWhere(
          eq(pgSchema.deployments.installationId, installationId),
          pgSchema.deployments.createdAt,
          pgSchema.deployments.id,
          decodeCursor(params.cursor),
        ),
        orderBy: [
          asc(pgSchema.deployments.createdAt),
          asc(pgSchema.deployments.id),
        ],
        limit: limit + 1,
      },
    );
    return pageFromProbe(rows, limit);
  }

  // --- connections + sealed secret blobs ------------------------------------

  async putConnection(connection: Connection): Promise<Connection> {
    await this.#pgUpsert(pgSchema.connections, {
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
    return await this.#pgFirstJson<Connection>(
      pgSchema.connections,
      pgSchema.connections.connectionJson,
      eq(pgSchema.connections.id, id),
    );
  }

  async listConnections(spaceId: string): Promise<readonly Connection[]> {
    return await this.#pgManyJson<Connection>(
      pgSchema.connections,
      pgSchema.connections.connectionJson,
      {
        where: eq(pgSchema.connections.spaceId, spaceId),
        orderBy: [
          asc(pgSchema.connections.createdAt),
          asc(pgSchema.connections.id),
        ],
      },
    );
  }

  async listConnectionsPage(
    spaceId: string,
    params: PageParams,
  ): Promise<Page<Connection>> {
    const limit = clampPageLimit(params.limit);
    const rows = await this.#pgManyJson<Connection>(
      pgSchema.connections,
      pgSchema.connections.connectionJson,
      {
        where: pgKeysetWhere(
          eq(pgSchema.connections.spaceId, spaceId),
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

  async listOperatorConnections(): Promise<readonly Connection[]> {
    return await this.#pgManyJson<Connection>(
      pgSchema.connections,
      pgSchema.connections.connectionJson,
      {
        where: isNull(pgSchema.connections.spaceId),
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

  // --- provider_envs ---------------------------------------------------------

  async putProviderEnv(env: ProviderEnv): Promise<ProviderEnv> {
    assertProviderEnvGlobalBoundary(env);
    await this.#pgUpsert(pgSchema.providerEnvs, {
      id: env.id,
      spaceId: env.spaceId ?? null,
      providerSource: env.providerSource,
      materialization: env.materialization,
      status: env.status,
      envJson: env,
      createdAt: env.createdAt,
      updatedAt: env.updatedAt,
    });
    return env;
  }

  async getProviderEnv(id: string): Promise<ProviderEnv | undefined> {
    return await this.#pgFirstJson<ProviderEnv>(
      pgSchema.providerEnvs,
      pgSchema.providerEnvs.envJson,
      eq(pgSchema.providerEnvs.id, id),
    );
  }

  async listProviderEnvs(spaceId?: string): Promise<readonly ProviderEnv[]> {
    return await this.#pgManyJson<ProviderEnv>(
      pgSchema.providerEnvs,
      pgSchema.providerEnvs.envJson,
      {
        where:
          spaceId === undefined
            ? isNull(pgSchema.providerEnvs.spaceId)
            : eq(pgSchema.providerEnvs.spaceId, spaceId),
        orderBy: [
          asc(pgSchema.providerEnvs.providerSource),
          asc(pgSchema.providerEnvs.materialization),
          asc(pgSchema.providerEnvs.id),
        ],
      },
    );
  }

  // --- sources (public + internal hook-secret hash / lastSeenCommit) --------

  async putSource(source: StoredSource): Promise<StoredSource> {
    await this.#pgUpsert(pgSchema.sources, {
      id: source.id,
      spaceId: source.spaceId,
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

  async listSources(spaceId?: string): Promise<readonly StoredSource[]> {
    return await this.#pgManyJson<StoredSource>(
      pgSchema.sources,
      pgSchema.sources.sourceJson,
      {
        where:
          spaceId === undefined
            ? undefined
            : eq(pgSchema.sources.spaceId, spaceId),
        orderBy: [asc(pgSchema.sources.createdAt), asc(pgSchema.sources.id)],
      },
    );
  }

  async listSourcesPage(
    spaceId: string,
    params: PageParams,
  ): Promise<Page<StoredSource>> {
    const limit = clampPageLimit(params.limit);
    const rows = await this.#pgManyJson<StoredSource>(
      pgSchema.sources,
      pgSchema.sources.sourceJson,
      {
        where: pgKeysetWhere(
          eq(pgSchema.sources.spaceId, spaceId),
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
    await this.#pgUpsert(pgSchema.sourceSnapshots, {
      id: snapshot.id,
      sourceId: snapshot.sourceId ?? null,
      snapshotJson: snapshot,
      fetchedAt: snapshot.fetchedAt,
    });
    return snapshot;
  }

  async getSourceSnapshot(id: string): Promise<SourceSnapshot | undefined> {
    return await this.#pgFirstJson<SourceSnapshot>(
      pgSchema.sourceSnapshots,
      pgSchema.sourceSnapshots.snapshotJson,
      eq(pgSchema.sourceSnapshots.id, id),
    );
  }

  async listSourceSnapshots(
    sourceId: string,
  ): Promise<readonly SourceSnapshot[]> {
    return await this.#pgManyJson<SourceSnapshot>(
      pgSchema.sourceSnapshots,
      pgSchema.sourceSnapshots.snapshotJson,
      {
        where: eq(pgSchema.sourceSnapshots.sourceId, sourceId),
        orderBy: [
          asc(pgSchema.sourceSnapshots.fetchedAt),
          asc(pgSchema.sourceSnapshots.id),
        ],
      },
    );
  }

  async listSourceSnapshotsBySourceIds(
    sourceIds: readonly string[],
  ): Promise<readonly SourceSnapshot[]> {
    if (sourceIds.length === 0) return [];
    return await this.#pgManyJson<SourceSnapshot>(
      pgSchema.sourceSnapshots,
      pgSchema.sourceSnapshots.snapshotJson,
      {
        where: inArray(pgSchema.sourceSnapshots.sourceId, [...sourceIds]),
        orderBy: [
          asc(pgSchema.sourceSnapshots.fetchedAt),
          asc(pgSchema.sourceSnapshots.id),
        ],
      },
    );
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
    return pageFromProbeBy(rows, limit, (s) => ({
      createdAt: s.fetchedAt,
      id: s.id,
    }));
  }

  async putCapsuleCompatibilityReport(
    report: CapsuleCompatibilityReport,
  ): Promise<CapsuleCompatibilityReport> {
    await this.#pgUpsert(pgSchema.capsuleCompatibilityReports, {
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
    const rows = await this.#db
      .select()
      .from(pgSchema.capsuleCompatibilityReports)
      .where(eq(pgSchema.capsuleCompatibilityReports.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      ...(row.sourceId ? { sourceId: row.sourceId } : {}),
      ...(row.installationId ? { installationId: row.installationId } : {}),
      sourceSnapshotId: row.sourceSnapshotId,
      level: row.level as CapsuleCompatibilityReport["level"],
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
    const filters = [
      eq(
        pgSchema.capsuleCompatibilityReports.sourceSnapshotId,
        sourceSnapshotId,
      ),
    ];
    if (options.sourceId) {
      filters.push(
        or(
          isNull(pgSchema.capsuleCompatibilityReports.sourceId),
          eq(pgSchema.capsuleCompatibilityReports.sourceId, options.sourceId),
        )!,
      );
    }
    if (options.installationId) {
      filters.push(
        or(
          isNull(pgSchema.capsuleCompatibilityReports.installationId),
          eq(
            pgSchema.capsuleCompatibilityReports.installationId,
            options.installationId,
          ),
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
      ...(row.sourceId ? { sourceId: row.sourceId } : {}),
      ...(row.installationId ? { installationId: row.installationId } : {}),
      sourceSnapshotId: row.sourceSnapshotId,
      level: row.level as CapsuleCompatibilityReport["level"],
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
      ...(row.normalizedObjectKey
        ? { normalizedObjectKey: row.normalizedObjectKey }
        : {}),
      ...(row.normalizedDigest
        ? { normalizedDigest: row.normalizedDigest }
        : {}),
      createdAt: row.createdAt,
    };
  }

  // --- provider env binding sets (§9, keyed (installation_id, environment)) --

  async putInstallationProviderEnvBindingSet(
    profile: InstallationProviderEnvBindingSet,
  ): Promise<InstallationProviderEnvBindingSet> {
    // One profile per (installation, environment): delete any stale row for the
    // same pair under a different id before upserting.
    await this.#db
      .delete(pgSchema.providerEnvBindingSets)
      .where(
        and(
          eq(
            pgSchema.providerEnvBindingSets.installationId,
            profile.installationId,
          ),
          eq(pgSchema.providerEnvBindingSets.environment, profile.environment),
          ne(pgSchema.providerEnvBindingSets.id, profile.id),
        ),
      );
    await this.#pgUpsert(pgSchema.providerEnvBindingSets, {
      id: profile.id,
      spaceId: profile.spaceId,
      installationId: profile.installationId,
      environment: profile.environment,
      profileJson: profile,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    });
    return profile;
  }

  async getInstallationProviderEnvBindingSetByInstallation(
    installationId: string,
    environment: string,
  ): Promise<InstallationProviderEnvBindingSet | undefined> {
    const rows = await this.#pgManyJson<InstallationProviderEnvBindingSet>(
      pgSchema.providerEnvBindingSets,
      pgSchema.providerEnvBindingSets.profileJson,
      {
        where: and(
          eq(pgSchema.providerEnvBindingSets.installationId, installationId),
          eq(pgSchema.providerEnvBindingSets.environment, environment),
        ),
        orderBy: [
          desc(pgSchema.providerEnvBindingSets.createdAt),
          desc(pgSchema.providerEnvBindingSets.id),
        ],
        limit: 1,
      },
    );
    return rows[0];
  }

  // --- state_snapshots (§20, keyed (installation_id, environment, generation)) -

  async putStateSnapshot(snapshot: StateSnapshot): Promise<StateSnapshot> {
    await pgUpsertStateSnapshot(this.#db, snapshot);
    return snapshot;
  }

  async getLatestStateSnapshot(
    installationId: string,
    environment: string,
  ): Promise<StateSnapshot | undefined> {
    const rows = await this.#pgManyJson<StateSnapshot>(
      pgSchema.stateSnapshots,
      pgSchema.stateSnapshots.snapshotJson,
      {
        where: and(
          eq(pgSchema.stateSnapshots.installationId, installationId),
          eq(pgSchema.stateSnapshots.environment, environment),
        ),
        orderBy: [desc(pgSchema.stateSnapshots.generation)],
        limit: 1,
      },
    );
    return rows[0];
  }

  async listStateSnapshots(
    installationId: string,
    environment: string,
  ): Promise<readonly StateSnapshot[]> {
    return await this.#pgManyJson<StateSnapshot>(
      pgSchema.stateSnapshots,
      pgSchema.stateSnapshots.snapshotJson,
      {
        where: and(
          eq(pgSchema.stateSnapshots.installationId, installationId),
          eq(pgSchema.stateSnapshots.environment, environment),
        ),
        orderBy: [asc(pgSchema.stateSnapshots.generation)],
      },
    );
  }

  async listStateSnapshotsBySpace(
    spaceId: string,
  ): Promise<readonly StateSnapshot[]> {
    return await this.#pgManyJson<StateSnapshot>(
      pgSchema.stateSnapshots,
      pgSchema.stateSnapshots.snapshotJson,
      {
        where: eq(pgSchema.stateSnapshots.spaceId, spaceId),
        orderBy: [asc(pgSchema.stateSnapshots.generation)],
      },
    );
  }

  // --- installation_dependencies (§14 / §15) --------------------------------

  async putDependency(dependency: Dependency): Promise<Dependency> {
    await this.#pgUpsert(pgSchema.installationDependencies, {
      id: dependency.id,
      spaceId: dependency.spaceId,
      producerInstallationId: dependency.producerInstallationId,
      consumerInstallationId: dependency.consumerInstallationId,
      dependencyJson: dependency,
      createdAt: dependency.createdAt,
    });
    return dependency;
  }

  async getDependency(id: string): Promise<Dependency | undefined> {
    return await this.#pgFirstJson<Dependency>(
      pgSchema.installationDependencies,
      pgSchema.installationDependencies.dependencyJson,
      eq(pgSchema.installationDependencies.id, id),
    );
  }

  async listDependenciesBySpace(
    spaceId: string,
  ): Promise<readonly Dependency[]> {
    return await this.#pgManyJson<Dependency>(
      pgSchema.installationDependencies,
      pgSchema.installationDependencies.dependencyJson,
      {
        where: eq(pgSchema.installationDependencies.spaceId, spaceId),
        orderBy: [
          asc(pgSchema.installationDependencies.createdAt),
          asc(pgSchema.installationDependencies.id),
        ],
      },
    );
  }

  async listDependenciesForConsumer(
    consumerInstallationId: string,
  ): Promise<readonly Dependency[]> {
    return await this.#pgManyJson<Dependency>(
      pgSchema.installationDependencies,
      pgSchema.installationDependencies.dependencyJson,
      {
        where: eq(
          pgSchema.installationDependencies.consumerInstallationId,
          consumerInstallationId,
        ),
        orderBy: [
          asc(pgSchema.installationDependencies.createdAt),
          asc(pgSchema.installationDependencies.id),
        ],
      },
    );
  }

  async listDependenciesForProducer(
    producerInstallationId: string,
  ): Promise<readonly Dependency[]> {
    return await this.#pgManyJson<Dependency>(
      pgSchema.installationDependencies,
      pgSchema.installationDependencies.dependencyJson,
      {
        where: eq(
          pgSchema.installationDependencies.producerInstallationId,
          producerInstallationId,
        ),
        orderBy: [
          asc(pgSchema.installationDependencies.createdAt),
          asc(pgSchema.installationDependencies.id),
        ],
      },
    );
  }

  async deleteDependency(id: string): Promise<boolean> {
    return await this.#pgDelete(
      pgSchema.installationDependencies,
      eq(pgSchema.installationDependencies.id, id),
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

  async putOutputSnapshot(snapshot: OutputSnapshot): Promise<OutputSnapshot> {
    await pgUpsertOutputSnapshot(this.#db, snapshot);
    return snapshot;
  }

  async getOutputSnapshot(id: string): Promise<OutputSnapshot | undefined> {
    return await this.#pgFirstJson<OutputSnapshot>(
      pgSchema.outputSnapshots,
      pgSchema.outputSnapshots.snapshotJson,
      eq(pgSchema.outputSnapshots.id, id),
    );
  }

  async getLatestOutputSnapshot(
    installationId: string,
  ): Promise<OutputSnapshot | undefined> {
    const rows = await this.#pgManyJson<OutputSnapshot>(
      pgSchema.outputSnapshots,
      pgSchema.outputSnapshots.snapshotJson,
      {
        where: eq(pgSchema.outputSnapshots.installationId, installationId),
        orderBy: [
          desc(pgSchema.outputSnapshots.stateGeneration),
          desc(pgSchema.outputSnapshots.createdAt),
          desc(pgSchema.outputSnapshots.id),
        ],
        limit: 1,
      },
    );
    return rows[0];
  }

  async listOutputSnapshots(
    installationId: string,
  ): Promise<readonly OutputSnapshot[]> {
    return await this.#pgManyJson<OutputSnapshot>(
      pgSchema.outputSnapshots,
      pgSchema.outputSnapshots.snapshotJson,
      {
        where: eq(pgSchema.outputSnapshots.installationId, installationId),
        orderBy: [
          pgSchema.outputSnapshots.stateGeneration,
          pgSchema.outputSnapshots.createdAt,
          pgSchema.outputSnapshots.id,
        ],
      },
    );
  }

  async listOutputSnapshotsBySpace(
    spaceId: string,
  ): Promise<readonly OutputSnapshot[]> {
    return await this.#pgManyJson<OutputSnapshot>(
      pgSchema.outputSnapshots,
      pgSchema.outputSnapshots.snapshotJson,
      {
        where: eq(pgSchema.outputSnapshots.spaceId, spaceId),
        orderBy: [
          pgSchema.outputSnapshots.stateGeneration,
          pgSchema.outputSnapshots.createdAt,
          pgSchema.outputSnapshots.id,
        ],
      },
    );
  }

  // --- output_shares (§18) --------------------------------------------------

  async putOutputShare(share: OutputShare): Promise<OutputShare> {
    await this.#pgUpsert(pgSchema.outputShares, {
      id: share.id,
      fromSpaceId: share.fromSpaceId,
      toSpaceId: share.toSpaceId,
      producerInstallationId: share.producerInstallationId,
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

  async listOutputSharesFromSpace(
    fromSpaceId: string,
  ): Promise<readonly OutputShare[]> {
    return await this.#pgManyJson<OutputShare>(
      pgSchema.outputShares,
      pgSchema.outputShares.shareJson,
      {
        where: eq(pgSchema.outputShares.fromSpaceId, fromSpaceId),
        orderBy: [
          asc(pgSchema.outputShares.createdAt),
          asc(pgSchema.outputShares.id),
        ],
      },
    );
  }

  async listOutputSharesToSpace(
    toSpaceId: string,
  ): Promise<readonly OutputShare[]> {
    return await this.#pgManyJson<OutputShare>(
      pgSchema.outputShares,
      pgSchema.outputShares.shareJson,
      {
        where: eq(pgSchema.outputShares.toSpaceId, toSpaceId),
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
      spaceId: group.spaceId,
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

  async listRunGroups(spaceId: string): Promise<readonly RunGroup[]> {
    return await this.#pgManyJson<RunGroup>(
      pgSchema.runGroups,
      pgSchema.runGroups.groupJson,
      {
        where: eq(pgSchema.runGroups.spaceId, spaceId),
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
      spaceId: event.spaceId,
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
    spaceId: string,
    options: { readonly limit?: number } = {},
  ): Promise<readonly ActivityEvent[]> {
    const limit = clampActivityLimit(options.limit);
    return await this.#pgManyJson<ActivityEvent>(
      pgSchema.auditEvents,
      pgSchema.auditEvents.eventJson,
      {
        where: eq(pgSchema.auditEvents.spaceId, spaceId),
        orderBy: [
          desc(pgSchema.auditEvents.createdAt),
          desc(pgSchema.auditEvents.id),
        ],
        limit,
      },
    );
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
      spaceId: event.spaceId,
      installationId: event.installationId ?? null,
      sourceId: event.sourceId ?? null,
      connectionId: event.connectionId ?? event.providerEnvId ?? "",
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
      spaceId: finding.spaceId,
      installationId: finding.installationId ?? null,
      runId: finding.runId ?? null,
      severity: finding.severity,
      type: finding.type,
      findingJson: finding,
      createdAt: finding.createdAt,
    });
    return finding;
  }

  async listSecurityFindings(
    spaceId: string,
    options: { readonly runId?: string; readonly limit?: number } = {},
  ): Promise<readonly SecurityFinding[]> {
    const limit = clampActivityLimit(options.limit);
    return await this.#pgManyJson<SecurityFinding>(
      pgSchema.securityFindings,
      pgSchema.securityFindings.findingJson,
      {
        where:
          options.runId === undefined
            ? eq(pgSchema.securityFindings.spaceId, spaceId)
            : and(
                eq(pgSchema.securityFindings.spaceId, spaceId),
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

  // --- billing ledger (§28) -------------------------------------------------

  async putBillingPlan(plan: BillingPlan): Promise<BillingPlan> {
    await this.#pgUpsert(
      pgSchema.billingPlans,
      {
        id: plan.id,
        name: plan.name,
        monthlyBasePrice: plan.monthlyBasePrice,
        includedCredits: plan.includedCredits,
        limitsJson: plan.limits,
        planJson: plan,
        createdAt: plan.createdAt,
        updatedAt: plan.updatedAt,
      },
      {
        name: plan.name,
        monthlyBasePrice: plan.monthlyBasePrice,
        includedCredits: plan.includedCredits,
        limitsJson: plan.limits,
        planJson: plan,
        updatedAt: plan.updatedAt,
      },
      pgSchema.billingPlans.id,
    );
    return plan;
  }

  async getBillingPlan(id: string): Promise<BillingPlan | undefined> {
    const rows = await this.#pgManyJson<BillingPlan>(
      pgSchema.billingPlans,
      pgSchema.billingPlans.planJson,
      {
        where: eq(pgSchema.billingPlans.id, id),
        limit: 1,
      },
    );
    return rows[0];
  }

  async putBillingAccount(account: BillingAccount): Promise<BillingAccount> {
    await this.#pgUpsert(
      pgSchema.billingAccounts,
      {
        id: account.id,
        ownerType: account.ownerType,
        ownerId: account.ownerId,
        provider: account.provider,
        status: account.status,
        accountJson: account,
        createdAt: account.createdAt,
        updatedAt: account.updatedAt,
      },
      {
        ownerType: account.ownerType,
        ownerId: account.ownerId,
        provider: account.provider,
        status: account.status,
        accountJson: account,
        updatedAt: account.updatedAt,
      },
      pgSchema.billingAccounts.id,
    );
    return account;
  }

  async getBillingAccount(id: string): Promise<BillingAccount | undefined> {
    const rows = await this.#pgManyJson<BillingAccount>(
      pgSchema.billingAccounts,
      pgSchema.billingAccounts.accountJson,
      {
        where: eq(pgSchema.billingAccounts.id, id),
        limit: 1,
      },
    );
    return rows[0];
  }

  async getBillingAccountForOwner(
    ownerType: BillingAccount["ownerType"],
    ownerId: string,
  ): Promise<BillingAccount | undefined> {
    const rows = await this.#pgManyJson<BillingAccount>(
      pgSchema.billingAccounts,
      pgSchema.billingAccounts.accountJson,
      {
        where: and(
          eq(pgSchema.billingAccounts.ownerType, ownerType),
          eq(pgSchema.billingAccounts.ownerId, ownerId),
        ),
        limit: 1,
      },
    );
    return rows[0];
  }

  async putSpaceSubscription(
    subscription: SpaceSubscription,
  ): Promise<SpaceSubscription> {
    await this.#pgUpsert(
      pgSchema.spaceSubscriptions,
      {
        id: subscription.id,
        spaceId: subscription.spaceId,
        billingAccountId: subscription.billingAccountId,
        planId: subscription.planId,
        status: subscription.status,
        subscriptionJson: subscription,
        createdAt: subscription.createdAt,
        updatedAt: subscription.updatedAt,
      },
      {
        spaceId: subscription.spaceId,
        billingAccountId: subscription.billingAccountId,
        planId: subscription.planId,
        status: subscription.status,
        subscriptionJson: subscription,
        updatedAt: subscription.updatedAt,
      },
      pgSchema.spaceSubscriptions.id,
    );
    return subscription;
  }

  async getSpaceSubscription(
    spaceId: string,
  ): Promise<SpaceSubscription | undefined> {
    const rows = await this.#pgManyJson<SpaceSubscription>(
      pgSchema.spaceSubscriptions,
      pgSchema.spaceSubscriptions.subscriptionJson,
      {
        where: eq(pgSchema.spaceSubscriptions.spaceId, spaceId),
        orderBy: [
          desc(pgSchema.spaceSubscriptions.updatedAt),
          desc(pgSchema.spaceSubscriptions.id),
        ],
        limit: 1,
      },
    );
    return rows[0];
  }

  async putCreditBalance(balance: CreditBalance): Promise<CreditBalance> {
    await this.#pgUpsert(
      pgSchema.creditBalances,
      {
        spaceId: balance.spaceId,
        availableCredits: balance.availableCredits,
        reservedCredits: balance.reservedCredits,
        monthlyIncludedCredits: balance.monthlyIncludedCredits,
        purchasedCredits: balance.purchasedCredits,
        updatedAt: balance.updatedAt,
      },
      {
        availableCredits: balance.availableCredits,
        reservedCredits: balance.reservedCredits,
        monthlyIncludedCredits: balance.monthlyIncludedCredits,
        purchasedCredits: balance.purchasedCredits,
        updatedAt: balance.updatedAt,
      },
      pgSchema.creditBalances.spaceId,
    );
    return balance;
  }

  async getCreditBalance(spaceId: string): Promise<CreditBalance | undefined> {
    const rows = await this.#db
      .select()
      .from(pgSchema.creditBalances)
      .where(eq(pgSchema.creditBalances.spaceId, spaceId))
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return {
      spaceId: row.spaceId,
      availableCredits: row.availableCredits,
      reservedCredits: row.reservedCredits,
      monthlyIncludedCredits: row.monthlyIncludedCredits,
      purchasedCredits: row.purchasedCredits,
      updatedAt: row.updatedAt,
    };
  }

  async reserveCredits(
    spaceId: string,
    input: { readonly credits: number; readonly updatedAt: string },
  ): Promise<CreditBalance | undefined> {
    const rows = await this.#db
      .update(pgSchema.creditBalances)
      .set({
        availableCredits: sql`${pgSchema.creditBalances.availableCredits} - ${input.credits}`,
        reservedCredits: sql`${pgSchema.creditBalances.reservedCredits} + ${input.credits}`,
        updatedAt: input.updatedAt,
      })
      .where(
        and(
          eq(pgSchema.creditBalances.spaceId, spaceId),
          gte(pgSchema.creditBalances.availableCredits, input.credits),
        ),
      )
      .returning();
    const row = rows[0];
    if (!row) return undefined;
    return {
      spaceId: row.spaceId,
      availableCredits: row.availableCredits,
      reservedCredits: row.reservedCredits,
      monthlyIncludedCredits: row.monthlyIncludedCredits,
      purchasedCredits: row.purchasedCredits,
      updatedAt: row.updatedAt,
    };
  }

  async addCredits(
    spaceId: string,
    input: { readonly credits: number; readonly updatedAt: string },
  ): Promise<CreditBalance> {
    // Ensure a row exists so the first grant lands (a no-op upsert seeds zero).
    await this.#db
      .insert(pgSchema.creditBalances)
      .values({
        spaceId,
        availableCredits: 0,
        reservedCredits: 0,
        monthlyIncludedCredits: 0,
        purchasedCredits: 0,
        updatedAt: input.updatedAt,
      })
      .onConflictDoNothing({ target: pgSchema.creditBalances.spaceId });
    const rows = await this.#db
      .update(pgSchema.creditBalances)
      .set({
        availableCredits: sql`${pgSchema.creditBalances.availableCredits} + ${input.credits}`,
        purchasedCredits: sql`${pgSchema.creditBalances.purchasedCredits} + ${input.credits}`,
        updatedAt: input.updatedAt,
      })
      .where(eq(pgSchema.creditBalances.spaceId, spaceId))
      .returning();
    const row = rows[0]!;
    return {
      spaceId: row.spaceId,
      availableCredits: row.availableCredits,
      reservedCredits: row.reservedCredits,
      monthlyIncludedCredits: row.monthlyIncludedCredits,
      purchasedCredits: row.purchasedCredits,
      updatedAt: row.updatedAt,
    };
  }

  async reconcileMonthlyCredits(
    spaceId: string,
    input: {
      readonly newMonthly: number;
      readonly periodStartIso: string;
      readonly updatedAt: string;
    },
  ): Promise<CreditBalance | undefined> {
    // Conditional, idempotent-per-period monthly RESET: carry over purchased
    // credits and reset the monthly allotment to full. Column-relative so no
    // read is needed: available = max(0, available - oldMonthly) + newMonthly.
    const rows = await this.#db
      .update(pgSchema.creditBalances)
      .set({
        availableCredits: sql`greatest(0, ${pgSchema.creditBalances.availableCredits} - ${pgSchema.creditBalances.monthlyIncludedCredits}) + ${input.newMonthly}`,
        monthlyIncludedCredits: input.newMonthly,
        updatedAt: input.updatedAt,
      })
      .where(
        and(
          eq(pgSchema.creditBalances.spaceId, spaceId),
          or(
            ne(
              pgSchema.creditBalances.monthlyIncludedCredits,
              input.newMonthly,
            ),
            lt(pgSchema.creditBalances.updatedAt, input.periodStartIso),
          ),
        ),
      )
      .returning();
    const row = rows[0];
    if (!row) return undefined;
    return {
      spaceId: row.spaceId,
      availableCredits: row.availableCredits,
      reservedCredits: row.reservedCredits,
      monthlyIncludedCredits: row.monthlyIncludedCredits,
      purchasedCredits: row.purchasedCredits,
      updatedAt: row.updatedAt,
    };
  }

  async putCreditReservation(
    reservation: CreditReservation,
  ): Promise<CreditReservation> {
    await this.#pgUpsert(pgSchema.creditReservations, {
      id: reservation.id,
      spaceId: reservation.spaceId,
      runId: reservation.runId,
      estimatedCredits: reservation.estimatedCredits,
      status: reservation.status,
      mode: reservation.mode,
      reservationJson: reservation,
      createdAt: reservation.createdAt,
      expiresAt: reservation.expiresAt,
    });
    return reservation;
  }

  async getCreditReservationForRun(
    runId: string,
  ): Promise<CreditReservation | undefined> {
    const rows = await this.#pgManyJson<CreditReservation>(
      pgSchema.creditReservations,
      pgSchema.creditReservations.reservationJson,
      {
        where: eq(pgSchema.creditReservations.runId, runId),
        orderBy: [
          desc(pgSchema.creditReservations.createdAt),
          desc(pgSchema.creditReservations.id),
        ],
        limit: 1,
      },
    );
    return rows[0];
  }

  async listCreditReservations(
    spaceId: string,
    options: { readonly limit?: number } = {},
  ): Promise<readonly CreditReservation[]> {
    return await this.#pgManyJson<CreditReservation>(
      pgSchema.creditReservations,
      pgSchema.creditReservations.reservationJson,
      {
        where: eq(pgSchema.creditReservations.spaceId, spaceId),
        orderBy: [
          desc(pgSchema.creditReservations.createdAt),
          desc(pgSchema.creditReservations.id),
        ],
        limit: options.limit ?? 100,
      },
    );
  }

  async putUsageEvent(event: UsageEvent): Promise<UsageEvent> {
    const existing = await this.#usageEventByIdempotencyKey(
      event.idempotencyKey,
    );
    if (existing) return existing;
    await this.#pgUpsert(
      pgSchema.usageEvents,
      {
        id: event.id,
        spaceId: event.spaceId,
        installationId: event.installationId ?? null,
        runId: event.runId ?? null,
        kind: event.kind,
        quantity: event.quantity,
        credits: event.credits,
        source: event.source,
        idempotencyKey: event.idempotencyKey,
        createdAt: event.createdAt,
      },
      {
        id: event.id,
        spaceId: event.spaceId,
        installationId: event.installationId ?? null,
        runId: event.runId ?? null,
        kind: event.kind,
        quantity: event.quantity,
        credits: event.credits,
        source: event.source,
        createdAt: event.createdAt,
      },
      pgSchema.usageEvents.idempotencyKey,
    );
    return event;
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

  async listUsageEvents(spaceId: string): Promise<readonly UsageEvent[]> {
    const rows = await this.#db
      .select()
      .from(pgSchema.usageEvents)
      .where(eq(pgSchema.usageEvents.spaceId, spaceId))
      .orderBy(
        asc(pgSchema.usageEvents.createdAt),
        asc(pgSchema.usageEvents.id),
      );
    return rows.map(usageEventFromRow);
  }

  async listUsageEventsPage(
    spaceId: string,
    params: PageParams,
  ): Promise<Page<UsageEvent>> {
    const limit = clampPageLimit(params.limit);
    const rows = await this.#db
      .select()
      .from(pgSchema.usageEvents)
      .where(
        pgKeysetWhere(
          eq(pgSchema.usageEvents.spaceId, spaceId),
          pgSchema.usageEvents.createdAt,
          pgSchema.usageEvents.id,
          decodeCursor(params.cursor),
        ),
      )
      .orderBy(
        asc(pgSchema.usageEvents.createdAt),
        asc(pgSchema.usageEvents.id),
      )
      .limit(limit + 1);
    return pageFromProbe(rows.map(usageEventFromRow), limit);
  }

  // --- backups (§33 layer 1 / §26 R2_BACKUPS) -------------------------------
  //
  // One ledger pointer row per sealed control-backup bundle. The bundle bytes
  // live in R2_BACKUPS; only the pointer round trips through `backup_json`.
  // Listing is newest-first (created_at desc, id desc).

  async putBackupRecord(record: BackupRecord): Promise<BackupRecord> {
    await this.#pgUpsert(pgSchema.backups, {
      id: record.id,
      spaceId: record.spaceId,
      installationId: record.installationId ?? null,
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

  async listBackupRecords(spaceId: string): Promise<readonly BackupRecord[]> {
    return await this.#pgManyJson<BackupRecord>(
      pgSchema.backups,
      pgSchema.backups.backupJson,
      {
        where: eq(pgSchema.backups.spaceId, spaceId),
        orderBy: [desc(pgSchema.backups.createdAt), desc(pgSchema.backups.id)],
      },
    );
  }

  async listBackupRecordsPage(
    spaceId: string,
    params: PageParams,
  ): Promise<Page<BackupRecord>> {
    const limit = clampPageLimit(params.limit);
    // Newest-first listing ⇒ descending keyset.
    const rows = await this.#pgManyJson<BackupRecord>(
      pgSchema.backups,
      pgSchema.backups.backupJson,
      {
        where: pgKeysetWhereDesc(
          eq(pgSchema.backups.spaceId, spaceId),
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

function usageEventFromRow(row: {
  readonly id: string;
  readonly spaceId: string;
  readonly installationId: string | null;
  readonly runId: string | null;
  readonly kind: string;
  readonly quantity: number;
  readonly credits: number;
  readonly source: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
}): UsageEvent {
  return {
    id: row.id,
    spaceId: row.spaceId,
    ...(row.installationId ? { installationId: row.installationId } : {}),
    ...(row.runId ? { runId: row.runId } : {}),
    kind: row.kind as UsageEvent["kind"],
    quantity: row.quantity,
    credits: row.credits,
    source: row.source as UsageEvent["source"],
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt,
  };
}

function artifactRecordFromRow(row: {
  readonly id: string;
  readonly runId: string;
  readonly kind: string;
  readonly objectKey: string;
  readonly digest: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
}): ArtifactRecord {
  return {
    id: row.id,
    runId: row.runId,
    kind: row.kind,
    objectKey: row.objectKey,
    digest: row.digest,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt,
  };
}

function installationValues(installation: Installation) {
  return {
    id: installation.id,
    spaceId: installation.spaceId,
    name: installation.name,
    environment: installation.environment,
    sourceId: installation.sourceId ?? null,
    installConfigId: installation.installConfigId,
    currentDeploymentId: installation.currentDeploymentId ?? null,
    status: installation.status,
    installationJson: installation,
    createdAt: installation.createdAt,
    updatedAt: installation.updatedAt,
  };
}

// --- tx-aware upserts -------------------------------------------------------
//
// These mirror the `#pgUpsert(...)` payloads in putDeployment / putStateSnapshot
// / putOutputSnapshot but take an explicit drizzle handle so the SAME insert can
// run on either the shared `#db` (the put* methods) or a transaction-bound
// drizzle handle (the atomic commitAppliedDeployment path). Keeping ONE column
// payload per entity means the transactional and non-transactional writes stay
// byte-for-byte identical.

/**
 * Read-coerces a persisted PlanRun / ApplyRun's `status` to the unified
 * {@link RunStatus} (RunStatus unify, S2). A legacy row written before the
 * `blocked` → `failed` collapse stored `status: "blocked"`; this maps it to
 * `failed` on read so old rows read back in the new model. Undefined passes
 * through.
 */
function coerceRunRowStatus<R extends PlanRun | ApplyRun>(
  run: R | undefined,
): R | undefined {
  if (!run || run.status !== ("blocked" as unknown as R["status"])) return run;
  return { ...run, status: coerceRunStatus(run.status) } as R;
}

/**
 * Tx-aware §27 `runs` upsert (the commit-tail fold helper). Writes a PlanRun /
 * ApplyRun row through the given drizzle handle (the transaction-bound one), so
 * the run-status write commits atomically with the Deployment. Mirrors the
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
    spaceId: run.spaceId,
    sourceId: null,
    installationId:
      "installationId" in run ? (run.installationId ?? null) : null,
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
        spaceId: values.spaceId,
        sourceId: values.sourceId,
        installationId: values.installationId,
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
    spaceId: run.spaceId,
    sourceId: "sourceId" in run ? (run.sourceId ?? null) : null,
    installationId:
      "installationId" in run ? (run.installationId ?? null) : null,
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

async function pgUpsertDeployment(
  db: PgRemoteDatabase<typeof pgSchema>,
  deployment: Deployment,
): Promise<void> {
  await db
    .insert(pgSchema.deployments)
    .values({
      id: deployment.id,
      spaceId: deployment.spaceId,
      installationId: deployment.installationId,
      environment: deployment.environment,
      applyRunId: deployment.applyRunId,
      sourceSnapshotId: deployment.sourceSnapshotId,
      dependencySnapshotId: deployment.dependencySnapshotId ?? null,
      stateGeneration: deployment.stateGeneration,
      outputSnapshotId: deployment.outputSnapshotId,
      status: deployment.status,
      deploymentJson: deployment,
      createdAt: deployment.createdAt,
    })
    .onConflictDoUpdate({
      target: pgSchema.deployments.id,
      set: {
        id: deployment.id,
        spaceId: deployment.spaceId,
        installationId: deployment.installationId,
        environment: deployment.environment,
        applyRunId: deployment.applyRunId,
        sourceSnapshotId: deployment.sourceSnapshotId,
        dependencySnapshotId: deployment.dependencySnapshotId ?? null,
        stateGeneration: deployment.stateGeneration,
        outputSnapshotId: deployment.outputSnapshotId,
        status: deployment.status,
        deploymentJson: deployment,
        createdAt: deployment.createdAt,
      },
    });
}

async function pgUpsertStateSnapshot(
  db: PgRemoteDatabase<typeof pgSchema>,
  snapshot: StateSnapshot,
): Promise<void> {
  await db
    .insert(pgSchema.stateSnapshots)
    .values({
      id: snapshot.id,
      spaceId: snapshot.spaceId,
      installationId: snapshot.installationId,
      environment: snapshot.environment,
      generation: snapshot.generation,
      snapshotJson: snapshot,
      createdAt: snapshot.createdAt,
    })
    .onConflictDoUpdate({
      target: [
        pgSchema.stateSnapshots.installationId,
        pgSchema.stateSnapshots.environment,
        pgSchema.stateSnapshots.generation,
      ],
      set: {
        id: snapshot.id,
        spaceId: snapshot.spaceId,
        snapshotJson: snapshot,
        createdAt: snapshot.createdAt,
      },
    });
}

async function pgUpsertOutputSnapshot(
  db: PgRemoteDatabase<typeof pgSchema>,
  snapshot: OutputSnapshot,
): Promise<void> {
  await db
    .insert(pgSchema.outputSnapshots)
    .values({
      id: snapshot.id,
      spaceId: snapshot.spaceId,
      installationId: snapshot.installationId,
      stateGeneration: snapshot.stateGeneration,
      snapshotJson: snapshot,
      createdAt: snapshot.createdAt,
    })
    .onConflictDoUpdate({
      target: pgSchema.outputSnapshots.id,
      set: {
        id: snapshot.id,
        spaceId: snapshot.spaceId,
        installationId: snapshot.installationId,
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

function assertProviderEnvGlobalBoundary(env: ProviderEnv): void {
  if (env.spaceId === undefined) {
    throw new Error(
      "global provider resolver records are not supported in OSS Takosumi",
    );
  }
}
