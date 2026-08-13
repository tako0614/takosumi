import type { D1Database, D1PreparedStatement, D1Result } from "./bindings.ts";

export const CONTROL_D1_MAINTENANCE_TABLE =
  "_takosumi_control_schema_maintenance" as const;

export interface ControlD1MaintenanceFenceIdentity {
  readonly sourceCommit: string;
  readonly manifestDigest: string;
  readonly environment: string;
  readonly databaseRole?: ControlD1MaintenanceDatabaseRole;
  readonly releasePolicy?: ControlD1MaintenanceReleasePolicy;
  readonly databaseId?: string | null;
  readonly sourceExportSha256?: string | null;
}

export type ControlD1MaintenanceDatabaseRole =
  "legacy" | "candidate" | "in_place";
export type ControlD1MaintenanceReleasePolicy =
  "never" | "cutover" | "in_place";

export interface ControlD1MaintenanceFence {
  readonly fenceId: string;
  readonly sourceCommit: string;
  readonly manifestDigest: string;
  readonly environment: string;
  readonly activatedAt: string;
  readonly databaseRole: ControlD1MaintenanceDatabaseRole;
  readonly releasePolicy: ControlD1MaintenanceReleasePolicy;
  readonly databaseId: string | null;
  readonly sourceExportSha256: string | null;
  readonly predecessor: {
    readonly fenceId: string;
    readonly sourceCommit: string;
    readonly manifestDigest: string;
  } | null;
}

interface ControlD1MaintenanceRow {
  readonly active: number | string;
  readonly migration_bypass: number | string;
  readonly fence_id: string;
  readonly source_commit: string;
  readonly manifest_digest: string;
  readonly environment: string;
  readonly activated_at: string;
  readonly released_at: string | null;
  readonly database_role: string;
  readonly release_policy: string;
  readonly database_id: string | null;
  readonly source_export_sha256: string | null;
  readonly predecessor_fence_id: string | null;
  readonly predecessor_source_commit: string | null;
  readonly predecessor_manifest_digest: string | null;
}

export type ControlD1MaintenanceState =
  | { readonly status: "absent" }
  | { readonly status: "inactive" }
  | {
      readonly status: "active";
      readonly fence: ControlD1MaintenanceFence;
    };

export interface ControlD1MaintenanceGuardTriggerDigest {
  readonly name: string;
  readonly table: string;
  readonly operation: "insert" | "update" | "delete" | "unknown";
  readonly digest: string;
}

/**
 * Read-only inventory of the request-path maintenance guards. Trigger SQL is
 * represented only by canonical digests; no application rows or values are
 * exposed.
 */
export interface ControlD1MaintenanceGuardInventory {
  readonly tables: readonly string[];
  readonly triggers: readonly string[];
  readonly triggerSqlDigests: readonly ControlD1MaintenanceGuardTriggerDigest[];
  readonly triggerSqlDigest: string;
  readonly guardedTableCount: number;
  readonly guardTriggerCount: number;
  readonly digest: string;
}

const CREATE_MAINTENANCE_TABLE = `create table if not exists ${CONTROL_D1_MAINTENANCE_TABLE} (
  singleton integer primary key check (singleton = 1),
  active integer not null check (active in (0, 1)),
  migration_bypass integer not null check (migration_bypass in (0, 1)),
  fence_id text not null,
  source_commit text not null,
  manifest_digest text not null,
  environment text not null,
  activated_at text not null,
  released_at text,
  database_role text not null default 'legacy',
  release_policy text not null default 'never',
  database_id text,
  source_export_sha256 text,
  predecessor_fence_id text,
  predecessor_source_commit text,
  predecessor_manifest_digest text,
  release_readiness_digest text
)`;

const READ_MAINTENANCE_ROW = `select active, migration_bypass, fence_id, source_commit, manifest_digest, environment,
       activated_at, released_at, database_role, release_policy,
       database_id, source_export_sha256, predecessor_fence_id,
       predecessor_source_commit, predecessor_manifest_digest
from ${CONTROL_D1_MAINTENANCE_TABLE}
where singleton = 1`;

/**
 * Request-path fail-closed check. The operator fence table is intentionally an
 * out-of-band control object rather than part of the OSS application schema;
 * an inactive row can remain between deploys so acquiring the next fence is a
 * single transactional upsert.
 */
export async function assertControlD1MaintenanceInactive(
  db: D1Database,
): Promise<void> {
  try {
    const state = await readControlD1MaintenanceState(db);
    if (state.status === "active") {
      throw new ControlD1MaintenanceError("maintenance_fence_active");
    }
  } catch (error) {
    if (error instanceof ControlD1MaintenanceError) throw error;
    throw new ControlD1MaintenanceError("maintenance_fence_check_failed");
  }
}

/** Validate one co-read maintenance singleton without weakening fencing. */
export async function assertControlD1MaintenanceResultInactive(
  result: D1Result<unknown>,
): Promise<void> {
  try {
    const rows = result.results;
    if (!Array.isArray(rows) || rows.length !== 1) {
      throw new ControlD1MaintenanceError("maintenance_fence_invalid");
    }
    const state = await controlD1MaintenanceStateFromRow(
      rows[0] as ControlD1MaintenanceRow,
    );
    if (state.status === "active") {
      throw new ControlD1MaintenanceError("maintenance_fence_active");
    }
  } catch (error) {
    if (error instanceof ControlD1MaintenanceError) throw error;
    throw new ControlD1MaintenanceError("maintenance_fence_check_failed");
  }
}

/**
 * Strictly decode the durable state. Once the table exists, a missing row,
 * non-binary flag, stale bypass, malformed identity, or contradictory release
 * timestamp is corruption and never means "maintenance is inactive".
 */
export async function readControlD1MaintenanceState(
  db: D1Database,
): Promise<ControlD1MaintenanceState> {
  let row: ControlD1MaintenanceRow | null;
  try {
    row = await readMaintenanceRow(db);
  } catch {
    // Bootstrap mode is allowed to start before the out-of-band fence table
    // exists. Probe sqlite_master only on that exceptional path. Once the table
    // exists, ordinary release-managed reads use the singleton primary key in
    // one statement and any read failure remains fail-closed.
    let table: { readonly name?: string } | null;
    try {
      table = await db
        .prepare(
          `select name from sqlite_master where type = 'table' and name = ?`,
        )
        .bind(CONTROL_D1_MAINTENANCE_TABLE)
        .first<{ readonly name?: string }>();
    } catch {
      throw new ControlD1MaintenanceError("maintenance_fence_check_failed");
    }
    if (table?.name !== CONTROL_D1_MAINTENANCE_TABLE) {
      return { status: "absent" };
    }
    throw new ControlD1MaintenanceError("maintenance_fence_invalid");
  }
  return await controlD1MaintenanceStateFromRow(row);
}

/**
 * Read the immutable identity retained by an already-released fence. This is
 * deliberately separate from the request-path state so inactive still means
 * only that writes are open, while release tooling can reconcile a lost
 * acknowledgement without guessing which fence was removed.
 */
export async function readControlD1MaintenanceReleaseReceipt(
  db: D1Database,
): Promise<ControlD1MaintenanceFence | null> {
  return (await readControlD1MaintenanceReleaseReceiptDetails(db))?.fence ?? null;
}

export interface ControlD1MaintenanceReleaseReceipt {
  readonly fence: ControlD1MaintenanceFence;
  readonly releasedAt: string;
  readonly releaseReadinessDigest: string | null;
}

/** Read the exact durable release timestamp and opaque readiness confirmation. */
export async function readControlD1MaintenanceReleaseReceiptDetails(
  db: D1Database,
): Promise<ControlD1MaintenanceReleaseReceipt | null> {
  const state = await readControlD1MaintenanceState(db);
  if (state.status !== "inactive") return null;
  const row = await readMaintenanceRow(db);
  if (!row || !row.released_at || !validTimestamp(row.released_at)) {
    throw new ControlD1MaintenanceError("maintenance_fence_invalid");
  }
  return {
    fence: maintenanceFenceFromRow(row),
    releasedAt: row.released_at,
    releaseReadinessDigest: await readReleaseReadinessDigest(db),
  };
}

/**
 * Return the complete sorted maintenance guard inventory for candidate
 * verification. A healthy active fence has three canonical triggers for each
 * guarded application table.
 */
export async function readControlD1MaintenanceGuardInventory(
  db: D1Database,
): Promise<ControlD1MaintenanceGuardInventory> {
  const tables = [...(await listGuardedTables(db))].sort();
  const triggerRows = await listMaintenanceTriggers(db);
  const triggers = triggerRows.map((row) => row.name).sort();
  const triggerSqlDigests = await Promise.all(
    [...triggerRows]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(async (row) => ({
        name: row.name,
        table: row.table,
        operation: maintenanceTriggerOperation(row.name, row.table),
        digest: await digestMaintenanceTriggerSql(row.sql),
      })),
  );
  const triggerSqlDigest = await sha256Json(triggerSqlDigests);
  return {
    tables,
    triggers,
    triggerSqlDigests,
    triggerSqlDigest,
    guardedTableCount: tables.length,
    guardTriggerCount: triggerSqlDigests.length,
    digest: await digestMaintenanceGuardInventory({
      tables,
      triggers,
      triggerSqlDigests,
    }),
  };
}

/** Digest the canonical reviewed SQL for one maintenance guard trigger. */
export async function digestControlD1MaintenanceGuardTriggerSql(
  table: string,
  operation: "insert" | "update" | "delete",
): Promise<string> {
  return digestMaintenanceTriggerSql(
    maintenanceTriggerSql(table, operation),
  );
}

export async function digestControlD1MaintenanceGuardTriggerInventory(
  entries: readonly ControlD1MaintenanceGuardTriggerDigest[],
): Promise<string> {
  return sha256Json(entries);
}

export async function digestControlD1MaintenanceGuardInventory(
  input: Pick<
    ControlD1MaintenanceGuardInventory,
    "tables" | "triggers" | "triggerSqlDigests"
  >,
): Promise<string> {
  return digestMaintenanceGuardInventory(input);
}

/**
 * Canonical digest used by transferred-candidate evidence. The full parsed
 * fence identity, including predecessor lineage, is covered by the digest.
 */
export async function digestControlD1MaintenanceFence(
  fence: ControlD1MaintenanceFence,
): Promise<string> {
  return sha256Json(fence);
}

async function controlD1MaintenanceStateFromRow(
  row: ControlD1MaintenanceRow | null,
): Promise<Exclude<ControlD1MaintenanceState, { readonly status: "absent" }>> {
  if (
    !row ||
    !validMaintenanceIdentity(row) ||
    !(await validMaintenancePredecessorIdentity(row))
  ) {
    throw new ControlD1MaintenanceError("maintenance_fence_invalid");
  }
  const active = strictBinary(row.active);
  const bypass = strictBinary(row.migration_bypass);
  if (active === 0 && bypass === 0 && validTimestamp(row.released_at)) {
    return { status: "inactive" };
  }
  if (active === 1 && bypass === 0 && row.released_at === null) {
    return {
      status: "active",
      fence: maintenanceFenceFromRow(row),
    };
  }
  throw new ControlD1MaintenanceError("maintenance_fence_invalid");
}

/** Acquire or resume the deterministic fence for one reviewed source/plan. */
export async function acquireControlD1MaintenanceFence(
  db: D1Database,
  identity: ControlD1MaintenanceFenceIdentity,
  activatedAt: string,
): Promise<ControlD1MaintenanceFence> {
  const normalizedIdentity = normalizeMaintenanceIdentity(identity);
  const fenceId = await maintenanceFenceId(normalizedIdentity);
  const guardedTables = await listGuardedTables(db);
  const maintenanceUpgrade = await maintenanceTableUpgradeStatements(db);
  const statements = [
    db.prepare(CREATE_MAINTENANCE_TABLE),
    ...maintenanceUpgrade,
    db
      .prepare(
        `insert into ${CONTROL_D1_MAINTENANCE_TABLE} (
         singleton, active, migration_bypass, fence_id, source_commit, manifest_digest,
           environment, activated_at, released_at, release_readiness_digest,
           database_role, release_policy,
           database_id, source_export_sha256, predecessor_fence_id,
           predecessor_source_commit, predecessor_manifest_digest
         ) values (1, 1, 0, ?, ?, ?, ?, ?, null, null, ?, ?, ?, ?, null, null, null)
         on conflict(singleton) do update set
           active = 1,
           migration_bypass = 0,
           fence_id = excluded.fence_id,
           source_commit = excluded.source_commit,
           manifest_digest = excluded.manifest_digest,
           environment = excluded.environment,
           activated_at = excluded.activated_at,
           released_at = null,
           release_readiness_digest = null,
           database_role = excluded.database_role,
           release_policy = excluded.release_policy,
           database_id = excluded.database_id,
           source_export_sha256 = excluded.source_export_sha256,
           predecessor_fence_id = case
             when ${CONTROL_D1_MAINTENANCE_TABLE}.active = 1
              and ${CONTROL_D1_MAINTENANCE_TABLE}.fence_id = excluded.fence_id
             then ${CONTROL_D1_MAINTENANCE_TABLE}.predecessor_fence_id
             else null
           end,
           predecessor_source_commit = case
             when ${CONTROL_D1_MAINTENANCE_TABLE}.active = 1
              and ${CONTROL_D1_MAINTENANCE_TABLE}.fence_id = excluded.fence_id
             then ${CONTROL_D1_MAINTENANCE_TABLE}.predecessor_source_commit
             else null
           end,
           predecessor_manifest_digest = case
             when ${CONTROL_D1_MAINTENANCE_TABLE}.active = 1
              and ${CONTROL_D1_MAINTENANCE_TABLE}.fence_id = excluded.fence_id
             then ${CONTROL_D1_MAINTENANCE_TABLE}.predecessor_manifest_digest
             else null
           end
         where ${CONTROL_D1_MAINTENANCE_TABLE}.active = 0
            or ${CONTROL_D1_MAINTENANCE_TABLE}.fence_id = excluded.fence_id`,
      )
      .bind(
        fenceId,
        normalizedIdentity.sourceCommit,
        normalizedIdentity.manifestDigest,
        normalizedIdentity.environment,
        activatedAt,
        normalizedIdentity.databaseRole,
        normalizedIdentity.releasePolicy,
        normalizedIdentity.databaseId,
        normalizedIdentity.sourceExportSha256,
      ),
    // Recreate instead of trusting an identically named historical trigger.
    // The fence transition and trigger replacement are one D1 transaction, so
    // no observer can see active=1 without the canonical guards installed.
    ...guardedTables.flatMap((table) => [
      ...maintenanceDropTriggerStatements(db, table),
      ...maintenanceTriggerStatements(db, table),
    ]),
  ];
  await checkedBatch(db, statements, "maintenance_fence_acquire_failed");

  const row = await readMaintenanceRow(db);
  if (
    !row ||
    Number(row.active) !== 1 ||
    row.fence_id !== fenceId ||
    row.source_commit !== normalizedIdentity.sourceCommit ||
    row.manifest_digest !== normalizedIdentity.manifestDigest ||
    row.environment !== normalizedIdentity.environment ||
    row.database_role !== normalizedIdentity.databaseRole ||
    row.release_policy !== normalizedIdentity.releasePolicy ||
    row.database_id !== normalizedIdentity.databaseId ||
    row.source_export_sha256 !== normalizedIdentity.sourceExportSha256
  ) {
    throw new ControlD1MaintenanceError("maintenance_fence_occupied");
  }
  return maintenanceFenceFromRow(row);
}

/**
 * Atomically replace one exact active predecessor fence with its reviewed
 * successor identity without ever setting active=0 or migration_bypass=1.
 *
 * The schema-plan layer must first prove that the live migration ledger is the
 * exact immediate predecessor of the new plan. This lower-level operation
 * only accepts the caller-reviewed old source/manifest pair and requires every
 * database authority dimension to remain unchanged.
 */
export async function supersedeActiveControlD1MaintenanceFence(
  db: D1Database,
  predecessor: {
    readonly sourceCommit: string;
    readonly manifestDigest: string;
  },
  successor: ControlD1MaintenanceFenceIdentity,
  options: { readonly requireExistingSuccessor?: boolean } = {},
): Promise<{
  readonly predecessorFence: ControlD1MaintenanceFence;
  readonly maintenanceFence: ControlD1MaintenanceFence;
}> {
  if (
    !/^[0-9a-f]{40}$/u.test(predecessor.sourceCommit) ||
    !/^sha256:[0-9a-f]{64}$/u.test(predecessor.manifestDigest)
  ) {
    throw new ControlD1MaintenanceError(
      "maintenance_fence_predecessor_invalid",
    );
  }
  const normalizedSuccessor = normalizeMaintenanceIdentity(successor);
  if (!(await maintenanceTableExists(db))) {
    throw new ControlD1MaintenanceError(
      "maintenance_fence_predecessor_mismatch",
    );
  }
  const guardedTables = await listGuardedTables(db);
  const canonicalGuardStatements = guardedTables.flatMap((table) => [
    ...maintenanceDropTriggerStatements(db, table),
    ...maintenanceTriggerStatements(db, table),
  ]);
  const maintenanceUpgrade = await maintenanceTableUpgradeStatements(db);
  // Canonicalize every guard in the same transaction that upgrades the old
  // maintenance table. A retained predecessor with incomplete historical
  // guard coverage must be fully fail-closed before the first state read.
  await checkedBatch(
    db,
    [...maintenanceUpgrade, ...canonicalGuardStatements],
    "maintenance_fence_supersession_failed",
  );
  const state = await readControlD1MaintenanceState(db);
  if (
    state.status === "active" &&
    state.fence.sourceCommit === normalizedSuccessor.sourceCommit &&
    state.fence.manifestDigest === normalizedSuccessor.manifestDigest &&
    state.fence.environment === normalizedSuccessor.environment &&
    state.fence.databaseRole === normalizedSuccessor.databaseRole &&
    state.fence.releasePolicy === normalizedSuccessor.releasePolicy &&
    state.fence.databaseId === normalizedSuccessor.databaseId &&
    state.fence.sourceExportSha256 === normalizedSuccessor.sourceExportSha256 &&
    state.fence.predecessor?.sourceCommit === predecessor.sourceCommit &&
    state.fence.predecessor.manifestDigest === predecessor.manifestDigest
  ) {
    await checkedBatch(
      db,
      canonicalGuardStatements,
      "maintenance_fence_supersession_failed",
    );
    return {
      predecessorFence: predecessorFenceFromTransition(state.fence),
      maintenanceFence: state.fence,
    };
  }
  if (options.requireExistingSuccessor) {
    // A full migration ledger is valid only after a prior supersession and
    // migration batch committed but its response was lost. Never reinterpret
    // a full ledger behind the exact old fence as a fresh transition.
    throw new ControlD1MaintenanceError(
      "maintenance_fence_predecessor_not_immediate",
    );
  }
  if (
    state.status !== "active" ||
    state.fence.sourceCommit !== predecessor.sourceCommit ||
    state.fence.manifestDigest !== predecessor.manifestDigest ||
    state.fence.environment !== normalizedSuccessor.environment ||
    state.fence.databaseRole !== normalizedSuccessor.databaseRole ||
    state.fence.releasePolicy !== normalizedSuccessor.releasePolicy ||
    state.fence.databaseId !== normalizedSuccessor.databaseId ||
    state.fence.sourceExportSha256 !== normalizedSuccessor.sourceExportSha256
  ) {
    throw new ControlD1MaintenanceError(
      "maintenance_fence_predecessor_mismatch",
    );
  }
  const predecessorFence = state.fence;
  const successorFenceId = await maintenanceFenceId(normalizedSuccessor);
  if (successorFenceId === predecessorFence.fenceId) {
    throw new ControlD1MaintenanceError(
      "maintenance_fence_supersession_invalid",
    );
  }

  await checkedBatch(
    db,
    [
      db
        .prepare(
          `update ${CONTROL_D1_MAINTENANCE_TABLE}
           set fence_id = ?, source_commit = ?, manifest_digest = ?,
               predecessor_fence_id = ?, predecessor_source_commit = ?,
               predecessor_manifest_digest = ?
           where singleton = 1 and active = 1 and migration_bypass = 0
             and fence_id = ? and source_commit = ? and manifest_digest = ?
             and environment = ? and database_role = ? and release_policy = ?
             and database_id is ? and source_export_sha256 is ?`,
        )
        .bind(
          successorFenceId,
          normalizedSuccessor.sourceCommit,
          normalizedSuccessor.manifestDigest,
          predecessorFence.fenceId,
          predecessor.sourceCommit,
          predecessor.manifestDigest,
          predecessorFence.fenceId,
          predecessor.sourceCommit,
          predecessor.manifestDigest,
          normalizedSuccessor.environment,
          normalizedSuccessor.databaseRole,
          normalizedSuccessor.releasePolicy,
          normalizedSuccessor.databaseId,
          normalizedSuccessor.sourceExportSha256,
        ),
      ...canonicalGuardStatements,
    ],
    "maintenance_fence_supersession_failed",
  );

  const updated = await readControlD1MaintenanceState(db);
  if (
    updated.status !== "active" ||
    updated.fence.fenceId !== successorFenceId ||
    updated.fence.sourceCommit !== normalizedSuccessor.sourceCommit ||
    updated.fence.manifestDigest !== normalizedSuccessor.manifestDigest ||
    updated.fence.environment !== predecessorFence.environment ||
    updated.fence.databaseRole !== predecessorFence.databaseRole ||
    updated.fence.releasePolicy !== predecessorFence.releasePolicy ||
    updated.fence.databaseId !== predecessorFence.databaseId ||
    updated.fence.sourceExportSha256 !== predecessorFence.sourceExportSha256 ||
    updated.fence.activatedAt !== predecessorFence.activatedAt ||
    updated.fence.predecessor?.fenceId !== predecessorFence.fenceId ||
    updated.fence.predecessor.sourceCommit !== predecessor.sourceCommit ||
    updated.fence.predecessor.manifestDigest !== predecessor.manifestDigest
  ) {
    throw new ControlD1MaintenanceError(
      "maintenance_fence_supersession_failed",
    );
  }
  return {
    predecessorFence,
    maintenanceFence: updated.fence,
  };
}

/**
 * Convert only a permanently fenced, unbound legacy export clone into a
 * releasable candidate. Callers must use a local SQLite clone; the durable role
 * transition prevents the original legacy database from ever being released.
 */
export async function adoptControlD1LegacyCloneAsCandidate(
  db: D1Database,
  legacyFence: ControlD1MaintenanceFence,
  input: {
    readonly candidateDatabaseId: string;
    readonly sourceExportSha256: string;
    readonly activatedAt: string;
  },
): Promise<ControlD1MaintenanceFence> {
  if (
    legacyFence.databaseRole !== "legacy" ||
    legacyFence.releasePolicy !== "never" ||
    !opaqueDatabaseId(input.candidateDatabaseId) ||
    !/^sha256:[0-9a-f]{64}$/u.test(input.sourceExportSha256) ||
    !validTimestamp(input.activatedAt)
  ) {
    throw new ControlD1MaintenanceError("candidate_adoption_invalid");
  }
  const identity = normalizeMaintenanceIdentity({
    sourceCommit: legacyFence.sourceCommit,
    manifestDigest: legacyFence.manifestDigest,
    environment: legacyFence.environment,
    databaseRole: "candidate",
    releasePolicy: "cutover",
    databaseId: input.candidateDatabaseId,
    sourceExportSha256: input.sourceExportSha256,
  });
  const fenceId = await maintenanceFenceId(identity);
  await checkedBatch(
    db,
    [
      db
        .prepare(
          `update ${CONTROL_D1_MAINTENANCE_TABLE}
           set fence_id = ?, database_role = 'candidate',
               release_policy = 'cutover', database_id = ?,
               source_export_sha256 = ?, activated_at = ?
           where singleton = 1 and active = 1 and migration_bypass = 0
             and fence_id = ? and database_role = 'legacy'
             and release_policy = 'never'`,
        )
        .bind(
          fenceId,
          identity.databaseId,
          identity.sourceExportSha256,
          input.activatedAt,
          legacyFence.fenceId,
        ),
    ],
    "candidate_adoption_failed",
  );
  const state = await readControlD1MaintenanceState(db);
  if (
    state.status !== "active" ||
    state.fence.fenceId !== fenceId ||
    state.fence.databaseRole !== "candidate" ||
    state.fence.releasePolicy !== "cutover"
  ) {
    throw new ControlD1MaintenanceError("candidate_adoption_failed");
  }
  return state.fence;
}

/**
 * Release only the exact fence acquired by this reviewed migration. A failed
 * migration deliberately skips this call and leaves all request writes fenced.
 */
export async function releaseControlD1MaintenanceFence(
  db: D1Database,
  fence: ControlD1MaintenanceFence,
  releasedAt: string,
  options: {
    readonly releaseReadinessDigest?: string | null;
  } = {},
): Promise<void> {
  if (!(
    (fence.databaseRole === "candidate" && fence.releasePolicy === "cutover") ||
    (fence.databaseRole === "in_place" && fence.releasePolicy === "in_place")
  )) {
    throw new ControlD1MaintenanceError("maintenance_fence_not_releasable");
  }
  const maintenanceUpgrade = await maintenanceTableUpgradeStatements(db);
  if (maintenanceUpgrade.length > 0) {
    await checkedBatch(
      db,
      maintenanceUpgrade,
      "maintenance_fence_release_failed",
    );
  }
  const current = await readControlD1MaintenanceState(db);
  if (
    current.status !== "active" ||
    !sameMaintenanceFenceIdentity(current.fence, fence)
  ) {
    throw new ControlD1MaintenanceError("maintenance_fence_release_mismatch");
  }
  const strictCandidateRelease = fence.databaseRole === "candidate";
  // Historical in-place migrations can carry a trigger name across a table
  // rename. Canonicalize that legacy guard shape before the generic in-place
  // release; the transferred-candidate lane remains strictly read-only here
  // and rejects any reviewed-guard drift instead.
  if (!strictCandidateRelease) {
    await repairControlD1MaintenanceGuards(db);
  }
  const guardedTables = await listGuardedTables(db);
  const guardInventory = await readControlD1MaintenanceGuardInventory(db);
  const expectedTriggers = expectedMaintenanceGuardTriggerRows(guardedTables);
  if (!(await matchesExpectedMaintenanceGuardInventory(
    guardInventory,
    guardedTables,
    expectedTriggers,
  ))) {
    throw new ControlD1MaintenanceError("maintenance_fence_release_mismatch");
  }
  const releasePredicate = maintenanceFenceReleasePredicate(
    fence,
    guardedTables,
    expectedTriggers,
  );
  const releaseCondition = releasePredicate.sql.replace(
    /^singleton = 1 and /u,
    "",
  );
  const releaseStatements = [
    db.prepare(
      `insert into ${CONTROL_D1_MAINTENANCE_TABLE} (
         singleton, active, migration_bypass, fence_id, source_commit,
         manifest_digest, environment, activated_at
       )
       select 1, 2, 2, 'invalid', 'invalid', 'invalid', 'invalid', 'invalid'
       where not exists (
         select 1 from ${CONTROL_D1_MAINTENANCE_TABLE} where singleton = 1
       )`,
    ),
    db
      .prepare(
        // Evaluate the large identity/inventory predicate only once. A failed
        // predicate writes migration_bypass=2, which violates the table CHECK
        // constraint and rolls back this update and every trigger drop in the
        // same D1 transaction, keeping the active fence fail-closed.
        `update ${CONTROL_D1_MAINTENANCE_TABLE}
         set active = 0,
             migration_bypass = case
               when ${releaseCondition} then 0 else 2 end,
             released_at = ?,
             release_readiness_digest = ?
         where singleton = 1`,
      )
      .bind(releasedAt, options.releaseReadinessDigest ?? null),
    ...guardedTables.flatMap((table) =>
      maintenanceDropTriggerStatements(db, table),
    ),
  ];
  let releaseResults: readonly D1Result[];
  try {
    releaseResults = await checkedBatch(
      db,
      releaseStatements,
      "maintenance_fence_release_failed",
    );
  } catch (error) {
    if (strictCandidateRelease) {
      const afterFailure = await readControlD1MaintenanceState(db);
      if (afterFailure.status === "active") {
        throw new ControlD1MaintenanceError(
          "maintenance_fence_release_mismatch",
        );
      }
    }
    throw error;
  }
  const releaseMeta = releaseResults[1]?.meta;
  if (releaseMeta !== undefined && releaseMeta.changes !== 1) {
    throw new ControlD1MaintenanceError("maintenance_fence_release_mismatch");
  }
  let receipt: ControlD1MaintenanceReleaseReceipt | null;
  let postReleaseGuardInventory: ControlD1MaintenanceGuardInventory;
  try {
    receipt = await readControlD1MaintenanceReleaseReceiptDetails(db);
    postReleaseGuardInventory =
      await readControlD1MaintenanceGuardInventory(db);
  } catch {
    throw new ControlD1MaintenanceError("maintenance_fence_release_failed");
  }
  if (
    !receipt ||
    !sameMaintenanceFenceIdentity(receipt.fence, fence) ||
    receipt.releasedAt !== releasedAt ||
    receipt.releaseReadinessDigest !==
      (options.releaseReadinessDigest ?? null) ||
    !(await matchesReleasedMaintenanceGuardInventory(
      postReleaseGuardInventory,
      guardedTables,
    ))
  ) {
    throw new ControlD1MaintenanceError("maintenance_fence_release_failed");
  }
}

function sameMaintenanceFenceIdentity(
  left: ControlD1MaintenanceFence,
  right: ControlD1MaintenanceFence,
): boolean {
  return (
    left.fenceId === right.fenceId &&
    left.sourceCommit === right.sourceCommit &&
    left.manifestDigest === right.manifestDigest &&
    left.environment === right.environment &&
    left.activatedAt === right.activatedAt &&
    left.databaseRole === right.databaseRole &&
    left.releasePolicy === right.releasePolicy &&
    left.databaseId === right.databaseId &&
    left.sourceExportSha256 === right.sourceExportSha256 &&
    JSON.stringify(left.predecessor) === JSON.stringify(right.predecessor)
  );
}

export async function isControlD1MaintenanceFenceActive(
  db: D1Database,
): Promise<boolean> {
  return (await readControlD1MaintenanceState(db)).status === "active";
}

/** Return the active fence so the migration runner can enter its DB-only bypass. */
export async function activeControlD1MaintenanceFence(
  db: D1Database,
): Promise<ControlD1MaintenanceFence | null> {
  const state = await readControlD1MaintenanceState(db);
  return state.status === "active" ? state.fence : null;
}

/**
 * Wrap one complete migration (including its ledger INSERT) in the fence-only
 * bypass. The bypass toggles and trigger recreation commit in the same D1
 * transaction, so request writes only ever observe bypass=0.
 */
export async function wrapControlD1MaintenanceMigrationBatch(
  db: D1Database,
  fence: ControlD1MaintenanceFence,
  migrationStatements: readonly D1PreparedStatement[],
  options: {
    readonly permanentlyDroppedTables?: ReadonlySet<string>;
    readonly newlyCreatedTables?: ReadonlySet<string>;
  } = {},
): Promise<readonly D1PreparedStatement[]> {
  const permanentlyDroppedTables =
    options.permanentlyDroppedTables ?? new Set<string>();
  const guardedTables = new Set(
    (await listGuardedTables(db)).filter(
      (table) => !permanentlyDroppedTables.has(table),
    ),
  );
  for (const table of options.newlyCreatedTables ?? []) {
    if (!permanentlyDroppedTables.has(table)) {
      guardedTables.add(guardedIdentifier(table));
    }
  }
  return [
    db
      .prepare(
        `update ${CONTROL_D1_MAINTENANCE_TABLE}
         set migration_bypass = case
           when active = 1 and fence_id = ? and migration_bypass = 0 then 1
           else 2
         end
         where singleton = 1`,
      )
      .bind(fence.fenceId),
    ...migrationStatements,
    db
      .prepare(
        `update ${CONTROL_D1_MAINTENANCE_TABLE}
         set migration_bypass = case
           when active = 1 and fence_id = ? and migration_bypass = 1 then 0
           else 2
         end
         where singleton = 1`,
      )
      .bind(fence.fenceId),
    ...[...guardedTables]
      .sort()
      .flatMap((table) => maintenanceTriggerStatements(db, table)),
  ];
}

/** Repair guard coverage without opening the application write path. */
export async function repairControlD1MaintenanceGuards(
  db: D1Database,
): Promise<void> {
  const state = await readControlD1MaintenanceState(db);
  if (state.status !== "active") return;
  const tables = await listGuardedTables(db);
  const expected = expectedMaintenanceGuardTriggerRows(tables);
  const existing = await listMaintenanceTriggers(db);
  const existingByName = new Map(
    existing.map((trigger) => [trigger.name, trigger] as const),
  );
  const repair = expected.filter((trigger) => {
    const current = existingByName.get(trigger.name);
    return !current || current.table !== trigger.table || current.sql !== trigger.sql;
  });
  if (repair.length === 0) return;
  await checkedBatch(
    db,
    repair.flatMap((trigger) => [
      db.prepare(`drop trigger if exists "${trigger.name}"`),
      db.prepare(trigger.sql),
    ]),
    "maintenance_guard_repair_failed",
  );
}

async function readMaintenanceRow(
  db: D1Database,
): Promise<ControlD1MaintenanceRow | null> {
  return await db
    .prepare(READ_MAINTENANCE_ROW)
    .first<ControlD1MaintenanceRow>();
}

async function readReleaseReadinessDigest(
  db: D1Database,
): Promise<string | null> {
  const columns = await db
    .prepare(`pragma table_info("${CONTROL_D1_MAINTENANCE_TABLE}")`)
    .all<{ readonly name: string }>();
  if (
    !(columns.results ?? []).some(
      (column) => column.name === "release_readiness_digest",
    )
  ) {
    return null;
  }
  const row = await db
    .prepare(
      `select release_readiness_digest
       from ${CONTROL_D1_MAINTENANCE_TABLE}
       where singleton = 1`,
    )
    .first<{ readonly release_readiness_digest: string | null }>();
  if (!row || row.release_readiness_digest === null) return null;
  if (!/^sha256:[0-9a-f]{64}$/u.test(row.release_readiness_digest)) {
    throw new ControlD1MaintenanceError("maintenance_fence_invalid");
  }
  return row.release_readiness_digest;
}

async function listGuardedTables(db: D1Database): Promise<readonly string[]> {
  // `_cf_KV` is a Cloudflare-managed D1 table. It is not application state
  // and must never receive Takosumi maintenance triggers.
  const result = await db
    .prepare(
      `select name from sqlite_master
       where type = 'table' and name not like 'sqlite_%' and name != ?
         and name != 'schema_migrations'
         and name != '_cf_KV'
       order by name`,
    )
    .bind(CONTROL_D1_MAINTENANCE_TABLE)
    .all<{ readonly name: string }>();
  return (result.results ?? []).map((row) => guardedIdentifier(row.name));
}

async function listMaintenanceTriggerNames(
  db: D1Database,
): Promise<ReadonlySet<string>> {
  const rows = await listMaintenanceTriggers(db);
  return new Set(rows.map((row) => row.name));
}

interface MaintenanceTriggerRow {
  readonly name: string;
  readonly table: string;
  readonly sql: string | null;
}

interface ExpectedMaintenanceTriggerRow {
  readonly name: string;
  readonly table: string;
  readonly operation: "insert" | "update" | "delete";
  readonly sql: string;
}

function expectedMaintenanceGuardTriggerRows(
  tables: readonly string[],
): readonly ExpectedMaintenanceTriggerRow[] {
  return tables
    .flatMap((table) =>
      (["insert", "update", "delete"] as const).map((operation) => ({
        name: maintenanceTriggerName(table, operation),
        table,
        operation,
        sql: maintenanceTriggerSql(table, operation)
          .replace(/^create trigger if not exists /u, "CREATE TRIGGER ")
          .replace(/;\s*$/u, ""),
      })),
    )
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function matchesExpectedMaintenanceGuardInventory(
  actual: ControlD1MaintenanceGuardInventory,
  tables: readonly string[],
  expectedTriggers: readonly ExpectedMaintenanceTriggerRow[],
): Promise<boolean> {
  const expectedTriggerSqlDigests = await Promise.all(
    expectedTriggers.map(async (trigger) => ({
      name: trigger.name,
      table: trigger.table,
      operation: trigger.operation,
      digest: await digestMaintenanceTriggerSql(trigger.sql),
    })),
  );
  const expectedNames = expectedTriggers.map((trigger) => trigger.name);
  const expectedTriggerSqlDigest = await sha256Json(expectedTriggerSqlDigests);
  const expectedDigest = await digestMaintenanceGuardInventory({
    tables: [...tables].sort(),
    triggers: expectedNames,
    triggerSqlDigests: expectedTriggerSqlDigests,
  });
  return (
    actual.guardedTableCount === tables.length &&
    actual.guardTriggerCount === expectedTriggers.length &&
    JSON.stringify(actual.tables) === JSON.stringify([...tables].sort()) &&
    JSON.stringify(actual.triggers) === JSON.stringify(expectedNames) &&
    JSON.stringify(actual.triggerSqlDigests) ===
      JSON.stringify(expectedTriggerSqlDigests) &&
    actual.triggerSqlDigest === expectedTriggerSqlDigest &&
    actual.digest === expectedDigest
  );
}

async function matchesReleasedMaintenanceGuardInventory(
  actual: ControlD1MaintenanceGuardInventory,
  tables: readonly string[],
): Promise<boolean> {
  const expectedTables = [...tables].sort();
  const expectedTriggerSqlDigest = await sha256Json([]);
  const expectedDigest = await digestMaintenanceGuardInventory({
    tables: expectedTables,
    triggers: [],
    triggerSqlDigests: [],
  });
  return (
    actual.guardedTableCount === expectedTables.length &&
    actual.guardTriggerCount === 0 &&
    JSON.stringify(actual.tables) === JSON.stringify(expectedTables) &&
    actual.triggers.length === 0 &&
    actual.triggerSqlDigests.length === 0 &&
    actual.triggerSqlDigest === expectedTriggerSqlDigest &&
    actual.digest === expectedDigest
  );
}

function maintenanceFenceReleasePredicate(
  fence: ControlD1MaintenanceFence,
  guardedTables: readonly string[],
  expectedTriggers: readonly ExpectedMaintenanceTriggerRow[],
): { readonly sql: string; readonly bindings: readonly unknown[] } {
  const predicates = [
    "singleton = 1",
    "active = 1",
    "migration_bypass = 0",
    "released_at is null",
    "release_readiness_digest is null",
    `fence_id = ${sqlLiteral(fence.fenceId)}`,
    `source_commit = ${sqlLiteral(fence.sourceCommit)}`,
    `manifest_digest = ${sqlLiteral(fence.manifestDigest)}`,
    `environment = ${sqlLiteral(fence.environment)}`,
    `activated_at = ${sqlLiteral(fence.activatedAt)}`,
    `database_role = ${sqlLiteral(fence.databaseRole)}`,
    `release_policy = ${sqlLiteral(fence.releasePolicy)}`,
    `database_id is ${sqlNullableLiteral(fence.databaseId)}`,
    `source_export_sha256 is ${sqlNullableLiteral(fence.sourceExportSha256)}`,
    `predecessor_fence_id is ${sqlNullableLiteral(fence.predecessor?.fenceId)}`,
    `predecessor_source_commit is ${sqlNullableLiteral(
      fence.predecessor?.sourceCommit,
    )}`,
    `predecessor_manifest_digest is ${sqlNullableLiteral(
      fence.predecessor?.manifestDigest,
    )}`,
  ];
  const tableFilter =
    "type = 'table' and name not like 'sqlite_%' and name != " +
    sqlLiteral(CONTROL_D1_MAINTENANCE_TABLE) +
    " and name != 'schema_migrations' and name != '_cf_KV'";
  predicates.push(
    `(select count(*) from sqlite_master where ${tableFilter}) = ${
      guardedTables.length
    }`,
  );
  if (guardedTables.length > 0) {
    predicates.push(
      `(select count(*) from sqlite_master where ${tableFilter}` +
        ` and name in (${guardedTables.map(sqlLiteral).join(", ")})) = ${
          guardedTables.length
        }`,
    );
  }
  const triggerFilter =
    "type = 'trigger' and name like '_takosumi_schema_fence_%'";
  predicates.push(
    `(select count(*) from sqlite_master where ${triggerFilter}) = ${
      expectedTriggers.length
    }`,
  );
  if (expectedTriggers.length > 0) {
    const expectedMatches = boundedSqlOr(
      expectedTriggers.map(
        (trigger) =>
          `(name = ${sqlLiteral(trigger.name)} and sql = ${sqlLiteral(
            trigger.sql,
          )})`,
      ),
    );
    predicates.push(
      `(select count(*) from sqlite_master where ${triggerFilter}` +
        ` and (${expectedMatches})) = ${expectedTriggers.length}`,
    );
  }
  return {
    sql: predicates.join(" and "),
    bindings: [],
  };
}

/**
 * Build a balanced OR tree for D1's SQLite expression-depth limit.
 *
 * A long left-associated `a or b or c ...` expression can exceed D1's
 * maximum expression depth even while remaining below the 100 KB statement
 * limit. The release predicate is generated from the exact guard inventory,
 * so balancing the equivalent leaves preserves the atomic fail-closed check.
 */
function boundedSqlOr(expressions: readonly string[]): string {
  if (expressions.length === 0) return "0";
  let level = [...expressions];
  while (level.length > 1) {
    const next: string[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index]!;
      const right = level[index + 1];
      next.push(right === undefined ? left : `(${left} or ${right})`);
    }
    level = next;
  }
  return level[0]!;
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

function sqlNullableLiteral(value: string | null | undefined): string {
  return value === null || value === undefined ? "null" : sqlLiteral(value);
}

async function listMaintenanceTriggers(
  db: D1Database,
): Promise<readonly MaintenanceTriggerRow[]> {
  const result = await db
    .prepare(
      `select name, tbl_name, sql from sqlite_master
       where type = 'trigger' and name like '_takosumi_schema_fence_%'
       order by name`,
    )
    .all<{
      readonly name: string;
      readonly tbl_name: string;
      readonly sql: string | null;
    }>();
  return (result.results ?? []).map((row) => ({
    name: String(row.name),
    table: String(row.tbl_name),
    sql: row.sql === null ? null : String(row.sql),
  }));
}

async function digestMaintenanceGuardInventory(input: {
  readonly tables: readonly string[];
  readonly triggers: readonly string[];
  readonly triggerSqlDigests: readonly ControlD1MaintenanceGuardTriggerDigest[];
}): Promise<string> {
  return sha256Json(input);
}

async function digestMaintenanceTriggerSql(
  sql: string | null,
): Promise<string> {
  return sha256Json(
    sql === null ? null : canonicalMaintenanceTriggerSql(sql),
  );
}

function canonicalMaintenanceTriggerSql(sql: string): string {
  return sql
    .trim()
    .replace(/\s+/gu, " ")
    .replace(/^create trigger if not exists /iu, "create trigger ")
    .replace(/;$/u, "")
    .toLowerCase();
}

async function sha256Json(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(value)),
  );
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return "null";
}

function maintenanceTriggerStatements(
  db: D1Database,
  table: string,
): readonly D1PreparedStatement[] {
  return (["insert", "update", "delete"] as const).map((operation) =>
    db.prepare(maintenanceTriggerSql(table, operation)),
  );
}

function maintenanceTriggerSql(
  table: string,
  operation: "insert" | "update" | "delete",
): string {
  return `create trigger if not exists "${maintenanceTriggerName(table, operation)}"
       before ${operation} on "${table}"
       when not coalesce((
         select (active = 0 and migration_bypass = 0)
             or (active = 1 and migration_bypass = 1)
         from ${CONTROL_D1_MAINTENANCE_TABLE}
         where singleton = 1
       ), 0)
       begin
         select raise(abort, 'takosumi control schema maintenance');
       end;`;
}

function maintenanceTriggerOperation(
  name: string,
  table: string,
): "insert" | "update" | "delete" | "unknown" {
  const prefix = `_takosumi_schema_fence_${table}_`;
  const operation = name.startsWith(prefix) ? name.slice(prefix.length) : "";
  if (operation === "insert" || operation === "update" || operation === "delete") {
    return operation;
  }
  return "unknown";
}

function strictBinary(value: number | string): 0 | 1 {
  if (value === 0 || value === "0") return 0;
  if (value === 1 || value === "1") return 1;
  throw new ControlD1MaintenanceError("maintenance_fence_invalid");
}

function validMaintenanceIdentity(row: ControlD1MaintenanceRow): boolean {
  return (
    /^sha256:[0-9a-f]{64}$/u.test(row.fence_id) &&
    /^[0-9a-f]{40}$/u.test(row.source_commit) &&
    /^sha256:[0-9a-f]{64}$/u.test(row.manifest_digest) &&
    /^[a-z][a-z0-9_-]{0,31}$/u.test(row.environment) &&
    validTimestamp(row.activated_at) &&
    validRolePolicy(
      row.database_role,
      row.release_policy,
      row.database_id,
      row.source_export_sha256,
    )
  );
}

function maintenancePredecessor(
  row: ControlD1MaintenanceRow,
): ControlD1MaintenanceFence["predecessor"] {
  if (
    row.predecessor_fence_id === null &&
    row.predecessor_source_commit === null &&
    row.predecessor_manifest_digest === null
  ) {
    return null;
  }
  if (
    typeof row.predecessor_fence_id !== "string" ||
    typeof row.predecessor_source_commit !== "string" ||
    typeof row.predecessor_manifest_digest !== "string"
  ) {
    return null;
  }
  return {
    fenceId: row.predecessor_fence_id,
    sourceCommit: row.predecessor_source_commit,
    manifestDigest: row.predecessor_manifest_digest,
  };
}

function maintenanceFenceFromRow(
  row: ControlD1MaintenanceRow,
): ControlD1MaintenanceFence {
  return {
    fenceId: row.fence_id,
    sourceCommit: row.source_commit,
    manifestDigest: row.manifest_digest,
    environment: row.environment,
    activatedAt: row.activated_at,
    databaseRole: databaseRole(row.database_role),
    releasePolicy: releasePolicy(row.release_policy),
    databaseId: row.database_id,
    sourceExportSha256: row.source_export_sha256,
    predecessor: maintenancePredecessor(row),
  };
}

async function validMaintenancePredecessorIdentity(
  row: ControlD1MaintenanceRow,
): Promise<boolean> {
  const predecessor = maintenancePredecessor(row);
  const allNull =
    row.predecessor_fence_id === null &&
    row.predecessor_source_commit === null &&
    row.predecessor_manifest_digest === null;
  if (!predecessor) return allNull;
  if (
    !/^sha256:[0-9a-f]{64}$/u.test(predecessor.fenceId) ||
    !/^[0-9a-f]{40}$/u.test(predecessor.sourceCommit) ||
    !/^sha256:[0-9a-f]{64}$/u.test(predecessor.manifestDigest)
  ) {
    return false;
  }
  return (
    predecessor.fenceId ===
    (await maintenanceFenceId({
      sourceCommit: predecessor.sourceCommit,
      manifestDigest: predecessor.manifestDigest,
      environment: row.environment,
      databaseRole: databaseRole(row.database_role),
      releasePolicy: releasePolicy(row.release_policy),
      databaseId: row.database_id,
      sourceExportSha256: row.source_export_sha256,
    }))
  );
}

function predecessorFenceFromTransition(
  successor: ControlD1MaintenanceFence,
): ControlD1MaintenanceFence {
  if (!successor.predecessor) {
    throw new ControlD1MaintenanceError(
      "maintenance_fence_supersession_failed",
    );
  }
  return {
    fenceId: successor.predecessor.fenceId,
    sourceCommit: successor.predecessor.sourceCommit,
    manifestDigest: successor.predecessor.manifestDigest,
    environment: successor.environment,
    activatedAt: successor.activatedAt,
    databaseRole: successor.databaseRole,
    releasePolicy: successor.releasePolicy,
    databaseId: successor.databaseId,
    sourceExportSha256: successor.sourceExportSha256,
    predecessor: null,
  };
}

function validTimestamp(value: string | null): boolean {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
}

function maintenanceDropTriggerStatements(
  db: D1Database,
  table: string,
): readonly D1PreparedStatement[] {
  return (["insert", "update", "delete"] as const).map((operation) =>
    db.prepare(
      `drop trigger if exists "${maintenanceTriggerName(table, operation)}"`,
    ),
  );
}

function maintenanceTriggerName(
  table: string,
  operation: "insert" | "update" | "delete",
): string {
  return `_takosumi_schema_fence_${table}_${operation}`;
}

function guardedIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,127}$/u.test(value)) {
    throw new ControlD1MaintenanceError("maintenance_table_name_invalid");
  }
  return value;
}

async function maintenanceFenceId(
  identity: ControlD1MaintenanceFenceIdentity,
): Promise<string> {
  const normalized = normalizeMaintenanceIdentity(identity);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `takosumi-control-d1-maintenance@v2\n${normalized.sourceCommit}\n${normalized.manifestDigest}\n${normalized.environment}\n${normalized.databaseRole}\n${normalized.releasePolicy}\n${normalized.databaseId ?? ""}\n${normalized.sourceExportSha256 ?? ""}\n`,
    ),
  );
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

async function maintenanceTableUpgradeStatements(
  db: D1Database,
): Promise<readonly D1PreparedStatement[]> {
  const table = await db
    .prepare(`select name from sqlite_master where type = 'table' and name = ?`)
    .bind(CONTROL_D1_MAINTENANCE_TABLE)
    .first<{ readonly name?: string }>();
  if (!table) return [];
  const columns = await db
    .prepare(`pragma table_info("${CONTROL_D1_MAINTENANCE_TABLE}")`)
    .all<{ readonly name: string }>();
  const names = new Set((columns.results ?? []).map((row) => String(row.name)));
  const additions = [
    ["database_role", "text not null default 'legacy'"],
    ["release_policy", "text not null default 'never'"],
    ["database_id", "text"],
    ["source_export_sha256", "text"],
    ["release_readiness_digest", "text"],
    ["predecessor_fence_id", "text"],
    ["predecessor_source_commit", "text"],
    ["predecessor_manifest_digest", "text"],
  ] as const;
  return additions
    .filter(([name]) => !names.has(name))
    .map(([name, definition]) =>
      db.prepare(
        `alter table "${CONTROL_D1_MAINTENANCE_TABLE}" add column "${name}" ${definition}`,
      ),
    );
}

async function maintenanceTableExists(db: D1Database): Promise<boolean> {
  const table = await db
    .prepare(`select name from sqlite_master where type = 'table' and name = ?`)
    .bind(CONTROL_D1_MAINTENANCE_TABLE)
    .first<{ readonly name?: string }>();
  return table?.name === CONTROL_D1_MAINTENANCE_TABLE;
}

function normalizeMaintenanceIdentity(
  identity: ControlD1MaintenanceFenceIdentity,
): Required<
  Pick<
    ControlD1MaintenanceFenceIdentity,
    "sourceCommit" | "manifestDigest" | "environment"
  >
> & {
  readonly databaseRole: ControlD1MaintenanceDatabaseRole;
  readonly releasePolicy: ControlD1MaintenanceReleasePolicy;
  readonly databaseId: string | null;
  readonly sourceExportSha256: string | null;
} {
  const databaseRole = identity.databaseRole ?? "in_place";
  const releasePolicy = identity.releasePolicy ?? "in_place";
  const databaseId = identity.databaseId?.trim() || null;
  const sourceExportSha256 = identity.sourceExportSha256?.trim() || null;
  if (
    !/^[0-9a-f]{40}$/u.test(identity.sourceCommit) ||
    !/^sha256:[0-9a-f]{64}$/u.test(identity.manifestDigest) ||
    !/^[a-z][a-z0-9_-]{0,31}$/u.test(identity.environment) ||
    !validRolePolicy(
      databaseRole,
      releasePolicy,
      databaseId,
      sourceExportSha256,
    )
  ) {
    throw new ControlD1MaintenanceError("maintenance_identity_invalid");
  }
  return {
    sourceCommit: identity.sourceCommit,
    manifestDigest: identity.manifestDigest,
    environment: identity.environment,
    databaseRole,
    releasePolicy,
    databaseId,
    sourceExportSha256,
  };
}

function validRolePolicy(
  roleValue: string,
  policyValue: string,
  databaseIdValue: string | null,
  sourceExportSha256Value: string | null,
): boolean {
  const pair = `${roleValue}:${policyValue}`;
  if (pair === "in_place:in_place") {
    return (
      (databaseIdValue === null || opaqueDatabaseId(databaseIdValue)) &&
      sourceExportSha256Value === null
    );
  }
  if (pair === "legacy:never") {
    return (
      (databaseIdValue === null || opaqueDatabaseId(databaseIdValue)) &&
      sourceExportSha256Value === null
    );
  }
  return (
    pair === "candidate:cutover" &&
    databaseIdValue !== null &&
    opaqueDatabaseId(databaseIdValue) &&
    sourceExportSha256Value !== null &&
    /^sha256:[0-9a-f]{64}$/u.test(sourceExportSha256Value)
  );
}

function databaseRole(value: string): ControlD1MaintenanceDatabaseRole {
  if (value === "legacy" || value === "candidate" || value === "in_place") {
    return value;
  }
  throw new ControlD1MaintenanceError("maintenance_fence_invalid");
}

function releasePolicy(value: string): ControlD1MaintenanceReleasePolicy {
  if (value === "never" || value === "cutover" || value === "in_place") {
    return value;
  }
  throw new ControlD1MaintenanceError("maintenance_fence_invalid");
}

function opaqueDatabaseId(value: string): boolean {
  return /^[A-Za-z0-9_:.=-]{1,256}$/u.test(value);
}

async function checkedBatch(
  db: D1Database,
  statements: readonly D1PreparedStatement[],
  code: string,
): Promise<readonly D1Result[]> {
  let results: readonly D1Result[];
  try {
    if (!db.batch) throw new Error("D1 batch unavailable");
    results = await db.batch(statements);
  } catch {
    throw new ControlD1MaintenanceError(code);
  }
  if (
    results.length !== statements.length ||
    results.some((result) => result.success === false)
  ) {
    throw new ControlD1MaintenanceError(code);
  }
  return results;
}

export class ControlD1MaintenanceError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ControlD1MaintenanceError";
  }
}
