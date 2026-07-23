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
  predecessor_manifest_digest text
)`;

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
      fence: {
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
      },
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
           environment, activated_at, released_at, database_role, release_policy,
           database_id, source_export_sha256, predecessor_fence_id,
           predecessor_source_commit, predecessor_manifest_digest
         ) values (1, 1, 0, ?, ?, ?, ?, ?, null, ?, ?, ?, ?, null, null, null)
         on conflict(singleton) do update set
           active = 1,
           migration_bypass = 0,
           fence_id = excluded.fence_id,
           source_commit = excluded.source_commit,
           manifest_digest = excluded.manifest_digest,
           environment = excluded.environment,
           activated_at = excluded.activated_at,
           released_at = null,
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
  return {
    fenceId,
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
): Promise<void> {
  if (!(
    (fence.databaseRole === "candidate" && fence.releasePolicy === "cutover") ||
    (fence.databaseRole === "in_place" && fence.releasePolicy === "in_place")
  )) {
    throw new ControlD1MaintenanceError("maintenance_fence_not_releasable");
  }
  const guardedTables = await listGuardedTables(db);
  const statements = [
    db
      .prepare(
        `update ${CONTROL_D1_MAINTENANCE_TABLE}
         set active = case
               when active = 1 and fence_id = ? then 0
               else 2
             end,
             migration_bypass = 0,
             released_at = ?
         where singleton = 1`,
      )
      .bind(fence.fenceId, releasedAt),
    ...guardedTables.flatMap((table) =>
      maintenanceDropTriggerStatements(db, table),
    ),
  ];
  await checkedBatch(db, statements, "maintenance_fence_release_failed");
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
  const existing = await listMaintenanceTriggerNames(db);
  const incomplete = tables.filter((table) =>
    (["insert", "update", "delete"] as const).some(
      (operation) => !existing.has(maintenanceTriggerName(table, operation)),
    ),
  );
  if (incomplete.length === 0) return;
  await checkedBatch(
    db,
    incomplete.flatMap((table) => [
      ...maintenanceDropTriggerStatements(db, table),
      ...maintenanceTriggerStatements(db, table),
    ]),
    "maintenance_guard_repair_failed",
  );
}

async function readMaintenanceRow(
  db: D1Database,
): Promise<ControlD1MaintenanceRow | null> {
  return await db
    .prepare(
      `select active, migration_bypass, fence_id, source_commit, manifest_digest, environment,
              activated_at, released_at, database_role, release_policy,
              database_id, source_export_sha256, predecessor_fence_id,
              predecessor_source_commit, predecessor_manifest_digest
       from ${CONTROL_D1_MAINTENANCE_TABLE}
       where singleton = 1`,
    )
    .first<ControlD1MaintenanceRow>();
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
  const result = await db
    .prepare(
      `select name from sqlite_master
       where type = 'trigger' and name like '_takosumi_schema_fence_%'
       order by name`,
    )
    .all<{ readonly name: string }>();
  return new Set((result.results ?? []).map((row) => String(row.name)));
}

function maintenanceTriggerStatements(
  db: D1Database,
  table: string,
): readonly D1PreparedStatement[] {
  return (["insert", "update", "delete"] as const).map((operation) =>
    db.prepare(
      `create trigger if not exists "${maintenanceTriggerName(table, operation)}"
       before ${operation} on "${table}"
       when not coalesce((
         select (active = 0 and migration_bypass = 0)
             or (active = 1 and migration_bypass = 1)
         from ${CONTROL_D1_MAINTENANCE_TABLE}
         where singleton = 1
       ), 0)
       begin
         select raise(abort, 'takosumi control schema maintenance');
       end;`,
    ),
  );
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
): Promise<void> {
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
}

export class ControlD1MaintenanceError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ControlD1MaintenanceError";
  }
}
