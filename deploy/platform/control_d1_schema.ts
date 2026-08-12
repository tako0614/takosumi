import { Database, type SQLQueryBindings } from "bun:sqlite";

import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
} from "../../worker/src/bindings.ts";
import { ensureD1OpenTofuLedgerSchema } from "../../worker/src/d1_opentofu_store.ts";
import {
  acquireControlD1MaintenanceFence,
  adoptControlD1LegacyCloneAsCandidate,
  digestControlD1MaintenanceFence,
  digestControlD1MaintenanceGuardInventory,
  digestControlD1MaintenanceGuardTriggerSql,
  digestControlD1MaintenanceGuardTriggerInventory,
  readControlD1MaintenanceGuardInventory,
  repairControlD1MaintenanceGuards,
  type ControlD1MaintenanceFence,
  type ControlD1MaintenanceGuardInventory,
  type ControlD1MaintenanceDatabaseRole,
  type ControlD1MaintenanceReleasePolicy,
  isControlD1MaintenanceFenceActive,
  releaseControlD1MaintenanceFence,
  readControlD1MaintenanceReleaseReceiptDetails,
  readControlD1MaintenanceReleaseReceipt,
  readControlD1MaintenanceState,
  supersedeActiveControlD1MaintenanceFence,
} from "../../worker/src/d1_schema_maintenance.ts";

export { adoptControlD1LegacyCloneAsCandidate, readControlD1MaintenanceState };
export {
  digestControlD1MaintenanceFence,
  digestControlD1MaintenanceGuardInventory,
  digestControlD1MaintenanceGuardTriggerSql,
  digestControlD1MaintenanceGuardTriggerInventory,
  readControlD1MaintenanceGuardInventory,
};

export const CONTROL_D1_SCHEMA_MANIFEST_VERSION = 2 as const;

/**
 * Tables deliberately retired by the current OSS control-ledger migration
 * chain. Host extensions may add their own tables, so verification rejects
 * only these known retired names and otherwise checks the OSS-owned schema as
 * a required subset.
 */
export const CONTROL_D1_RETIRED_TABLES = [
  "spaces",
  "installations",
  "state_snapshots",
  "output_snapshots",
  "workspace_output_sync",
  "provider_envs",
  "provider_catalog",
  "billing_accounts",
  "plans",
  "space_subscriptions",
  "credit_balances",
  "billing_auto_recharge_attempts",
  "credit_reservations",
] as const;

export interface ControlD1MigrationLedgerRow {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

interface ControlD1ColumnDescriptor {
  readonly columnId: number;
  readonly name: string;
  readonly type: string;
  readonly notNull: boolean;
  readonly defaultValue: string | null;
  readonly primaryKeyPosition: number;
  readonly hidden: number;
}

interface ControlD1IndexColumnDescriptor {
  readonly sequence: number;
  readonly columnId: number;
  readonly name: string | null;
  readonly descending: boolean;
  readonly collation: string | null;
  readonly key: boolean;
}

interface ControlD1IndexDescriptor {
  readonly name: string;
  readonly unique: boolean;
  readonly partial: boolean;
  readonly origin: string;
  readonly columns: readonly ControlD1IndexColumnDescriptor[];
  readonly sql: string | null;
  readonly where: string | null;
}

interface ControlD1ForeignKeyDescriptor {
  readonly id: number;
  readonly sequence: number;
  readonly table: string;
  readonly from: string;
  readonly to: string | null;
  readonly onUpdate: string;
  readonly onDelete: string;
  readonly match: string;
}

export interface ControlD1TableDescriptor {
  readonly name: string;
  readonly sql: string;
  readonly columns: readonly ControlD1ColumnDescriptor[];
  readonly indexes: readonly ControlD1IndexDescriptor[];
  readonly foreignKeys: readonly ControlD1ForeignKeyDescriptor[];
}

export interface ControlD1AttachedSchemaObjectDescriptor {
  readonly type: "trigger" | "view";
  readonly name: string;
  readonly table: string;
  readonly sql: string;
}

export interface ControlD1SchemaPlan {
  readonly kind: "takosumi.control-d1-schema-plan@v1";
  readonly manifestVersion: typeof CONTROL_D1_SCHEMA_MANIFEST_VERSION;
  readonly manifestDigest: string;
  readonly schemaDigest: string;
  readonly ledgerDigest: string;
  readonly tables: readonly ControlD1TableDescriptor[];
  readonly attachedSchemaObjects: readonly ControlD1AttachedSchemaObjectDescriptor[];
  readonly migrations: readonly ControlD1MigrationLedgerRow[];
  readonly retiredTables: typeof CONTROL_D1_RETIRED_TABLES;
}

export interface ControlD1SchemaVerification {
  readonly status: "ready" | "mismatch";
  readonly schemaDigest: string;
  readonly ledgerDigest: string;
  readonly latestMigrationVersion: number;
  readonly migrationCount: number;
  readonly tableCount: number;
  readonly issues: readonly string[];
}

export interface ControlD1CandidateVerificationOptions {
  readonly environment: string;
  readonly sourceCommit: string;
  readonly manifestDigest: string;
  readonly candidateDatabaseId: string;
  readonly sourceExportSha256: string;
  /** Exact retained candidate fence id supplied by Cloud evidence. */
  readonly expectedFenceId?: string;
  /** Digest of the complete retained candidate fence identity. */
  readonly expectedFenceDigest?: string;
  /** Compatibility aliases for callers using confirmation vocabulary. */
  readonly confirmFenceId?: string;
  readonly confirmFenceDigest?: string;
  readonly fenceId?: string;
  readonly fenceDigest?: string;
}

export interface ControlD1CandidateIntegrityVerification {
  readonly status: "ready" | "unsupported" | "mismatch";
  readonly integrityCheck: "ok" | "unsupported" | "mismatch";
  readonly foreignKeyCheck: "ok" | "unsupported" | "mismatch";
  readonly foreignKeyViolationCount: number;
}

export interface ControlD1CandidateVerification {
  readonly status: "ready" | "mismatch";
  readonly environment: string;
  readonly sourceCommit: string;
  readonly manifestDigest: string;
  readonly candidateDatabaseId: string;
  readonly sourceExportSha256: string;
  readonly maintenanceStatus: "retained" | "not_retained";
  readonly maintenanceFence: ControlD1MaintenanceFence | null;
  readonly candidateFenceDigest: string | null;
  readonly guardInventory: ControlD1MaintenanceGuardInventory | null;
  readonly integrity: ControlD1CandidateIntegrityVerification;
  readonly verification: ControlD1SchemaVerification;
  readonly issues: readonly string[];
}

export interface ControlD1CandidateReleaseOptions
  extends ControlD1CandidateVerificationOptions {
  /** Exact external Cloud promotion/readiness confirmation digest. */
  readonly releaseReadinessDigest?: string;
  readonly confirmReleaseReadinessDigest?: string;
  readonly promotionReadinessDigest?: string;
  readonly releasedAt: string;
}

export interface ControlD1CandidateReleaseResult {
  readonly status: "released";
  readonly environment: string;
  readonly sourceCommit: string;
  readonly manifestDigest: string;
  readonly candidateDatabaseId: string;
  readonly sourceExportSha256: string;
  readonly releaseReadinessDigest: string;
  readonly maintenanceStatus: "released";
  readonly maintenanceFence: ControlD1MaintenanceFence;
  readonly candidateFenceDigest: string;
  readonly guardInventory: ControlD1MaintenanceGuardInventory;
  readonly integrity: ControlD1CandidateIntegrityVerification;
  readonly verification: ControlD1SchemaVerification;
  readonly lostAcknowledgementReconciled: boolean;
}

/** Tables whose logical content must remain byte-logically stable at transfer. */
export const CONTROL_D1_TRANSFER_PROTECTED_TABLES = [
  "capsule_compatibility_reports",
  "resolution_locks",
  "resource_shapes",
  "runs",
  "state_versions",
  "workspaces",
] as const;

export interface ControlD1TransferSourceVerificationOptions {
  readonly environment: "staging" | "production";
  readonly sourceCommit: string;
  readonly manifestDigest: string;
  readonly sourceDatabaseId: string;
  readonly sourceExportSha256: string;
  readonly sourceExportBookmark: string;
}

export interface ControlD1TransferLogicalTableDigest {
  readonly table: string;
  readonly columns: readonly string[];
  readonly rowCount: number;
  readonly rowDigest: string;
  readonly contentDigest: string;
}

export interface ControlD1TransferLogicalDatabaseDigest {
  readonly kind: "takosumi.sqlite-logical-content@v1";
  readonly algorithm: "sha256";
  readonly databaseDigest: string;
  readonly tables: readonly ControlD1TransferLogicalTableDigest[];
  readonly excludedTables: readonly { readonly table: string; readonly reason: "cloudflare_internal" }[];
}

export interface ControlD1TransferSourceVerification {
  readonly kind: "takosumi.control-d1-transfer-source-verify@v1";
  readonly status: "ready" | "mismatch";
  readonly environment: "staging" | "production";
  readonly sourceCommit: string;
  readonly manifestDigest: string;
  readonly sourceDatabaseId: string;
  readonly sourceFence: ControlD1MaintenanceFence | null;
  readonly sourceFenceDigest: string | null;
  readonly guardInventory: ControlD1MaintenanceGuardInventory | null;
  readonly integrity: ControlD1CandidateIntegrityVerification;
  readonly verification: ControlD1SchemaVerification;
  readonly logical: ControlD1TransferLogicalDatabaseDigest;
  readonly protectedContentDigest: string | null;
  readonly sourceExport: {
    readonly bookmark: string;
    readonly sha256: string;
    readonly lineage: {
      readonly databaseId: string;
      readonly sourceFenceDigest: string | null;
      readonly sourceCommit: string;
      readonly manifestDigest: string;
    };
  };
  readonly captureAuthorityDigest: string | null;
  readonly issues: readonly string[];
  readonly evidenceDigest: string;
}

/** Explicit transferred-candidate aliases for Cloud's programmatic seam. */
export type ControlD1TransferredCandidateVerificationOptions =
  ControlD1CandidateVerificationOptions;
export type ControlD1TransferredCandidateVerification =
  ControlD1CandidateVerification;
export type ControlD1TransferredCandidateReleaseOptions =
  ControlD1CandidateReleaseOptions;
export type ControlD1TransferredCandidateReleaseResult =
  ControlD1CandidateReleaseResult;

export interface ControlD1SchemaApplyResult {
  readonly beforeMigrationVersions: readonly number[];
  readonly appliedMigrationVersions: readonly number[];
  readonly verification: ControlD1SchemaVerification;
  readonly maintenanceDrainMilliseconds: number;
  readonly maintenanceFence: ControlD1MaintenanceFence;
  readonly predecessorMaintenanceFence?: ControlD1MaintenanceFence;
  readonly maintenanceStatus: "retained" | "released";
}

export interface ControlD1SchemaApplyOptions {
  readonly sourceCommit: string;
  readonly environment: "staging" | "production" | "test";
  readonly activatedAt: string;
  readonly releasedAt: () => string;
  readonly maintenanceDrainMilliseconds: number;
  readonly waitForRequestDrain: (milliseconds: number) => Promise<void>;
  /** Official Cloud blue/green candidates retain this through Worker cutover. */
  readonly retainMaintenanceFence?: boolean;
  readonly databaseRole?: ControlD1MaintenanceDatabaseRole;
  readonly releasePolicy?: ControlD1MaintenanceReleasePolicy;
  readonly databaseId?: string;
  readonly sourceExportSha256?: string;
  /**
   * Explicit recovery for one already-active immediate-predecessor fence.
   * Both values must be copied from the retained predecessor transcript.
   */
  readonly activePredecessorFence?: {
    readonly sourceCommit: string;
    readonly manifestDigest: string;
  };
}

export interface ControlD1SchemaFenceResult {
  readonly maintenanceFence: ControlD1MaintenanceFence;
  readonly maintenanceDrainMilliseconds: number;
}

/**
 * Freeze a legacy database without mutating its application schema. Official
 * Cloud keeps this fence forever and clones from the resulting read-only
 * bookmark; only the offline candidate is migrated.
 */
export async function fenceControlD1Schema(
  database: D1Database,
  plan: ControlD1SchemaPlan,
  options: ControlD1SchemaApplyOptions,
): Promise<ControlD1SchemaFenceResult> {
  const maintenanceFence = await acquireControlD1MaintenanceFence(
    database,
    {
      sourceCommit: options.sourceCommit,
      manifestDigest: plan.manifestDigest,
      environment: options.environment,
      databaseRole: options.databaseRole ?? "legacy",
      releasePolicy: options.releasePolicy ?? "never",
      databaseId: options.databaseId,
      sourceExportSha256: options.sourceExportSha256,
    },
    options.activatedAt,
  );
  await options.waitForRequestDrain(options.maintenanceDrainMilliseconds);
  return {
    maintenanceFence,
    maintenanceDrainMilliseconds: options.maintenanceDrainMilliseconds,
  };
}

export async function buildControlD1SchemaPlan(
  options: { readonly throughMigrationVersion?: number } = {},
): Promise<ControlD1SchemaPlan> {
  const database = new SqliteControlD1Database();
  try {
    await ensureD1OpenTofuLedgerSchema(database, options);
    const tables = await inspectOwnedTables(database);
    const attachedSchemaObjects = await inspectAttachedSchemaObjects(
      database,
      new Set(tables.map((table) => table.name)),
    );
    const migrations = await readControlD1MigrationLedger(database);
    const schemaDigest = await digest({ tables, attachedSchemaObjects });
    const ledgerDigest = await digest(migrations);
    const manifestDigest = await digest({
      manifestVersion: CONTROL_D1_SCHEMA_MANIFEST_VERSION,
      schemaDigest,
      ledgerDigest,
      retiredTables: CONTROL_D1_RETIRED_TABLES,
    });
    return {
      kind: "takosumi.control-d1-schema-plan@v1",
      manifestVersion: CONTROL_D1_SCHEMA_MANIFEST_VERSION,
      manifestDigest,
      schemaDigest,
      ledgerDigest,
      tables,
      attachedSchemaObjects,
      migrations,
      retiredTables: CONTROL_D1_RETIRED_TABLES,
    };
  } finally {
    database.close();
  }
}

/**
 * Apply the canonical OSS control-ledger bootstrap/migration chain to a D1
 * target selected by the operator, then run the same read-only verification as
 * the standalone verify command.
 */
export async function applyControlD1Schema(
  database: D1Database,
  plan: ControlD1SchemaPlan,
  options: ControlD1SchemaApplyOptions,
): Promise<ControlD1SchemaApplyResult> {
  const before = await readControlD1MigrationLedger(database);
  const successorIdentity = {
    sourceCommit: options.sourceCommit,
    manifestDigest: plan.manifestDigest,
    environment: options.environment,
    databaseRole: options.databaseRole ?? "in_place",
    releasePolicy: options.releasePolicy ?? "in_place",
    databaseId: options.databaseId,
    sourceExportSha256: options.sourceExportSha256,
  } as const;
  let predecessorMaintenanceFence: ControlD1MaintenanceFence | undefined;
  let fence: ControlD1MaintenanceFence;
  if (options.activePredecessorFence) {
    const recoveryLedger = predecessorRecoveryMigrationLedger(before, plan);
    const superseded = await supersedeActiveControlD1MaintenanceFence(
      database,
      options.activePredecessorFence,
      successorIdentity,
      { requireExistingSuccessor: recoveryLedger === "successor" },
    );
    predecessorMaintenanceFence = superseded.predecessorFence;
    fence = superseded.maintenanceFence;
  } else {
    fence = await acquireControlD1MaintenanceFence(
      database,
      successorIdentity,
      options.activatedAt,
    );
  }
  await options.waitForRequestDrain(options.maintenanceDrainMilliseconds);

  // Any failure before the explicit release deliberately leaves the durable
  // fence active and all request writes blocked. A retry of the same exact
  // source/manifest resumes the deterministic fence.
  const plannedMigrationVersion = plan.migrations.at(-1)?.version;
  if (plannedMigrationVersion === undefined) {
    throw new ControlD1SchemaError("schema_plan_migration_ledger_empty");
  }
  await ensureD1OpenTofuLedgerSchema(database, {
    throughMigrationVersion: plannedMigrationVersion,
  });
  await repairControlD1MaintenanceGuards(database);
  const fencedVerification = await verifyControlD1Schema(database, plan, {
    allowActiveMaintenanceFence: true,
  });
  if (fencedVerification.status !== "ready") {
    throw new ControlD1SchemaError("post_apply_verification_failed");
  }
  if (!options.retainMaintenanceFence) {
    const releasedAt = options.releasedAt();
    try {
      await releaseControlD1MaintenanceFence(
        database,
        fence,
        releasedAt,
      );
    } catch (error) {
      // A transport can lose the response after D1 committed the release
      // batch. Accept only the exact durable receipt and released guard state;
      // some other inactive fence never reconciles this acknowledgement.
      if (!(await matchesExactInPlaceReleaseReceipt(
        database,
        fence,
        releasedAt,
      ))) {
        throw error;
      }
    }
    if (await isControlD1MaintenanceFenceActive(database)) {
      throw new ControlD1SchemaError("maintenance_fence_release_failed");
    }
  } else if (!(await isControlD1MaintenanceFenceActive(database))) {
    throw new ControlD1SchemaError("maintenance_fence_not_retained");
  }
  const verification = fencedVerification;
  const beforeVersions = new Set(before.map((row) => row.version));
  return {
    beforeMigrationVersions: before.map((row) => row.version),
    appliedMigrationVersions: plan.migrations
      .filter((row) => !beforeVersions.has(row.version))
      .map((row) => row.version),
    verification,
    maintenanceDrainMilliseconds: options.maintenanceDrainMilliseconds,
    maintenanceFence: fence,
    ...(predecessorMaintenanceFence ? { predecessorMaintenanceFence } : {}),
    maintenanceStatus: options.retainMaintenanceFence ? "retained" : "released",
  };
}

async function matchesExactInPlaceReleaseReceipt(
  database: D1Database,
  fence: ControlD1MaintenanceFence,
  releasedAt: string,
): Promise<boolean> {
  try {
    const receipt = await readControlD1MaintenanceReleaseReceiptDetails(database);
    const guards = await readControlD1MaintenanceGuardInventory(database);
    const expectedTriggerSqlDigest =
      await digestControlD1MaintenanceGuardTriggerInventory([]);
    const expectedGuardDigest = await digestControlD1MaintenanceGuardInventory({
      tables: guards.tables,
      triggers: [],
      triggerSqlDigests: [],
    });
    return (
      receipt !== null &&
      (await digestControlD1MaintenanceFence(receipt.fence)) ===
        (await digestControlD1MaintenanceFence(fence)) &&
      receipt.releasedAt === releasedAt &&
      receipt.releaseReadinessDigest === null &&
      guards.guardedTableCount === guards.tables.length &&
      guards.guardTriggerCount === 0 &&
      guards.triggers.length === 0 &&
      guards.triggerSqlDigests.length === 0 &&
      guards.triggerSqlDigest === expectedTriggerSqlDigest &&
      guards.digest === expectedGuardDigest
    );
  } catch {
    return false;
  }
}

function predecessorRecoveryMigrationLedger(
  actual: readonly ControlD1MigrationLedgerRow[],
  plan: ControlD1SchemaPlan,
): "predecessor" | "successor" {
  const predecessor = plan.migrations.slice(0, -1);
  const predecessorTail = predecessor.at(-1);
  const successorTail = plan.migrations.at(-1);
  const isPredecessorLedger = stableJson(actual) === stableJson(predecessor);
  const isSuccessorLedger = stableJson(actual) === stableJson(plan.migrations);
  if (
    !predecessorTail ||
    !successorTail ||
    successorTail.version !== predecessorTail.version + 1 ||
    (!isPredecessorLedger && !isSuccessorLedger)
  ) {
    throw new ControlD1SchemaError(
      "maintenance_fence_predecessor_not_immediate",
    );
  }
  return isPredecessorLedger ? "predecessor" : "successor";
}

/** Read-only verification of the complete OSS-owned control D1 subset. */
export async function verifyControlD1Schema(
  database: D1Database,
  plan: ControlD1SchemaPlan,
  options: {
    readonly allowActiveMaintenanceFence?: boolean;
  } = {},
): Promise<ControlD1SchemaVerification> {
  const issues: string[] = [];
  if (
    !options.allowActiveMaintenanceFence &&
    (await isControlD1MaintenanceFenceActive(database))
  ) {
    issues.push("maintenance_fence_active");
  }
  const existingTables = await listUserTableNames(database);
  const actualTables: ControlD1TableDescriptor[] = [];

  for (const expected of plan.tables) {
    if (!existingTables.has(expected.name)) {
      issues.push(`schema_table_missing:${expected.name}`);
      continue;
    }
    const actual = await inspectTable(database, expected.name);
    actualTables.push(actual);
    if (stableJson(actual) !== stableJson(expected)) {
      issues.push(`schema_table_mismatch:${expected.name}`);
    }
  }

  const actualAttachedSchemaObjects = await inspectAttachedSchemaObjects(
    database,
    new Set(plan.tables.map((table) => table.name)),
    { ignoreMaintenanceTriggers: options.allowActiveMaintenanceFence === true },
  );
  if (
    stableJson(actualAttachedSchemaObjects) !==
    stableJson(plan.attachedSchemaObjects)
  ) {
    issues.push("schema_attached_object_mismatch");
  }

  for (const retired of plan.retiredTables) {
    if (existingTables.has(retired)) {
      issues.push(`retired_table_present:${retired}`);
    }
  }

  const migrations = await readControlD1MigrationLedger(database);
  if (stableJson(migrations) !== stableJson(plan.migrations)) {
    issues.push("migration_ledger_mismatch");
  }

  return {
    status: issues.length === 0 ? "ready" : "mismatch",
    schemaDigest: await digest({
      tables: actualTables,
      attachedSchemaObjects: actualAttachedSchemaObjects,
    }),
    ledgerDigest: await digest(migrations),
    latestMigrationVersion: migrations.at(-1)?.version ?? 0,
    migrationCount: migrations.length,
    tableCount: actualTables.length,
    issues,
  };
}

/**
 * Verify one transferred Control candidate without opening its request path.
 *
 * This is deliberately narrower than the generic schema verifier: only an
 * active `candidate`/`cutover` fence bound to the exact candidate database and
 * source export is accepted. The candidate remains fenced while Cloud proves
 * promotion, and all returned evidence is metadata/digest-only.
 */
export async function verifyControlD1Candidate(
  database: D1Database,
  plan: ControlD1SchemaPlan,
  options: ControlD1CandidateVerificationOptions,
): Promise<ControlD1CandidateVerification> {
  const expected = normalizeCandidateVerificationOptions(options);
  const state = await readControlD1MaintenanceState(database);
  const issues: string[] = [];
  if (plan.manifestDigest !== expected.manifestDigest) {
    issues.push("schema_plan_manifest_mismatch");
  }
  let fence: ControlD1MaintenanceFence | null = null;
  let candidateFenceDigest: string | null = null;
  let guardInventory: ControlD1MaintenanceGuardInventory | null = null;

  if (state.status !== "active") {
    issues.push("candidate_fence_not_active");
  } else {
    fence = state.fence;
    candidateFenceDigest = await digestControlD1MaintenanceFence(fence);
    if (fence.sourceCommit !== expected.sourceCommit) {
      issues.push("candidate_fence_source_commit_mismatch");
    }
    if (fence.manifestDigest !== expected.manifestDigest) {
      issues.push("candidate_fence_manifest_mismatch");
    }
    if (fence.environment !== expected.environment) {
      issues.push("candidate_fence_environment_mismatch");
    }
    if (fence.databaseRole !== "candidate") {
      issues.push("candidate_fence_role_mismatch");
    }
    if (fence.releasePolicy !== "cutover") {
      issues.push("candidate_fence_policy_mismatch");
    }
    if (fence.databaseId !== expected.candidateDatabaseId) {
      issues.push("candidate_fence_database_id_mismatch");
    }
    if (fence.sourceExportSha256 !== expected.sourceExportSha256) {
      issues.push("candidate_fence_source_export_mismatch");
    }
    if (
      expected.expectedFenceId !== null &&
      fence.fenceId !== expected.expectedFenceId
    ) {
      issues.push("candidate_fence_id_mismatch");
    }
    if (candidateFenceDigest !== expected.expectedFenceDigest) {
      issues.push("candidate_fence_digest_mismatch");
    }
    guardInventory = await readControlD1MaintenanceGuardInventory(database);
    const expectedTriggers = expectedMaintenanceGuardTriggers(
      guardInventory.tables,
    );
    const expectedTriggerSqlDigests = await expectedMaintenanceGuardTriggerSqlDigests(
      guardInventory.tables,
    );
    if (
      JSON.stringify(guardInventory.triggers) !==
        JSON.stringify(expectedTriggers) ||
      JSON.stringify(guardInventory.triggerSqlDigests) !==
        JSON.stringify(expectedTriggerSqlDigests) ||
      guardInventory.triggerSqlDigest !==
        (await digestControlD1MaintenanceGuardTriggerInventory(
          expectedTriggerSqlDigests,
        )) ||
      guardInventory.digest !==
        (await digestControlD1MaintenanceGuardInventory({
          tables: guardInventory.tables,
          triggers: expectedTriggers,
          triggerSqlDigests: expectedTriggerSqlDigests,
        }))
    ) {
      issues.push("maintenance_guard_inventory_mismatch");
    }
  }

  const verification = await verifyControlD1Schema(database, plan, {
    allowActiveMaintenanceFence: true,
  });
  if (verification.status !== "ready") {
    issues.push(...verification.issues);
  }
  const integrity = await verifyControlD1Integrity(database);
  if (integrity.status === "mismatch") {
    issues.push("database_integrity_mismatch");
  }

  return {
    status: issues.length === 0 ? "ready" : "mismatch",
    environment: expected.environment,
    sourceCommit: expected.sourceCommit,
    manifestDigest: expected.manifestDigest,
    candidateDatabaseId: expected.candidateDatabaseId,
    sourceExportSha256: expected.sourceExportSha256,
    maintenanceStatus:
      state.status === "active" ? "retained" : "not_retained",
    maintenanceFence: fence,
    candidateFenceDigest,
    guardInventory,
    integrity,
    verification,
    issues,
  };
}

/** Alias used by Cloud's transferred-candidate controller. */
export const verifyControlD1TransferredCandidate = verifyControlD1Candidate;

/**
 * Read-only source authority proof for the Cloud transfer controller. This
 * accepts only the permanent legacy/never fence and emits digests/metadata;
 * it never exports rows, mutates D1, or opens the Accounts database.
 */
export async function verifyControlD1TransferSource(
  database: D1Database,
  plan: ControlD1SchemaPlan,
  options: ControlD1TransferSourceVerificationOptions,
): Promise<ControlD1TransferSourceVerification> {
  const expected = normalizeTransferSourceVerificationOptions(options);
  const state = await readControlD1MaintenanceState(database);
  const issues: string[] = [];
  if (plan.manifestDigest !== expected.manifestDigest) {
    issues.push("schema_plan_manifest_mismatch");
  }
  let sourceFence: ControlD1MaintenanceFence | null = null;
  let sourceFenceDigest: string | null = null;
  let guardInventory: ControlD1MaintenanceGuardInventory | null = null;
  if (state.status !== "active") {
    issues.push("source_fence_not_active");
  } else {
    sourceFence = state.fence;
    sourceFenceDigest = await digestControlD1MaintenanceFence(sourceFence);
    if (sourceFence.sourceCommit !== expected.sourceCommit) {
      issues.push("source_fence_source_commit_mismatch");
    }
    if (sourceFence.manifestDigest !== expected.manifestDigest) {
      issues.push("source_fence_manifest_mismatch");
    }
    if (sourceFence.environment !== expected.environment) {
      issues.push("source_fence_environment_mismatch");
    }
    if (sourceFence.databaseRole !== "legacy") {
      issues.push("source_fence_role_mismatch");
    }
    if (sourceFence.releasePolicy !== "never") {
      issues.push("source_fence_policy_mismatch");
    }
    if (sourceFence.databaseId !== expected.sourceDatabaseId) {
      issues.push("source_fence_database_id_mismatch");
    }
    if (sourceFence.sourceExportSha256 !== null) {
      issues.push("source_fence_export_binding_unexpected");
    }
    if (sourceFence.predecessor !== null) {
      issues.push("source_fence_predecessor_unexpected");
    }
    guardInventory = await readControlD1MaintenanceGuardInventory(database);
    const expectedTriggers = expectedMaintenanceGuardTriggers(guardInventory.tables);
    const expectedTriggerSqlDigests = await expectedMaintenanceGuardTriggerSqlDigests(
      guardInventory.tables,
    );
    const expectedTriggerSqlDigest = await digestControlD1MaintenanceGuardTriggerInventory(
      expectedTriggerSqlDigests,
    );
    const expectedInventoryDigest = await digestControlD1MaintenanceGuardInventory({
      tables: [...guardInventory.tables].sort(),
      triggers: expectedTriggers,
      triggerSqlDigests: expectedTriggerSqlDigests,
    });
    if (
      JSON.stringify(guardInventory.tables) !== JSON.stringify([...guardInventory.tables].sort()) ||
      JSON.stringify(guardInventory.triggers) !== JSON.stringify(expectedTriggers) ||
      JSON.stringify(guardInventory.triggerSqlDigests) !== JSON.stringify(expectedTriggerSqlDigests) ||
      guardInventory.guardedTableCount !== guardInventory.tables.length ||
      guardInventory.guardTriggerCount !== guardInventory.tables.length * 3 ||
      guardInventory.triggerSqlDigest !== expectedTriggerSqlDigest ||
      guardInventory.digest !== expectedInventoryDigest
    ) {
      issues.push("maintenance_guard_inventory_mismatch");
    }
  }
  const verification = await verifyControlD1Schema(database, plan, {
    allowActiveMaintenanceFence: true,
  });
  if (verification.status !== "ready") issues.push(...verification.issues);
  const integrity = await verifyControlD1Integrity(database);
  if (integrity.status !== "ready") issues.push("database_integrity_mismatch");
  const logical = await readControlD1TransferLogicalDatabaseDigest(database);
  const protectedTables = CONTROL_D1_TRANSFER_PROTECTED_TABLES.map((table) =>
    logical.tables.find((entry) => entry.table === table),
  );
  if (protectedTables.some((table) => !table)) {
    issues.push("protected_table_missing");
  }
  const protectedContentDigest = protectedTables.every(Boolean)
    ? await digestTransferValue({
        kind: "takosumi.cloud-control-d1-protected-content@v1",
        policy: CONTROL_D1_TRANSFER_PROTECTED_TABLES,
        tables: protectedTables.map((table) => ({
          table: table!.table,
          columns: table!.columns,
          rowCount: table!.rowCount,
          contentDigest: table!.contentDigest,
        })),
      })
    : null;
  const sourceExport = {
    bookmark: expected.sourceExportBookmark,
    sha256: expected.sourceExportSha256,
    lineage: {
      databaseId: expected.sourceDatabaseId,
      sourceFenceDigest,
      sourceCommit: expected.sourceCommit,
      manifestDigest: expected.manifestDigest,
    },
  } as const;
  const captureAuthorityDigest = sourceFenceDigest
    ? await digestTransferValue({
        kind: "takosumi.cloud-control-d1-source-capture-authority@v1",
        environment: expected.environment,
        sourceCommit: expected.sourceCommit,
        manifestDigest: expected.manifestDigest,
        databaseId: expected.sourceDatabaseId,
        sourceFenceDigest,
        bookmark: expected.sourceExportBookmark,
        exportDigest: expected.sourceExportSha256,
      })
    : null;
  const evidence = {
    kind: "takosumi.control-d1-transfer-source-verify@v1" as const,
    status: issues.length === 0 ? ("ready" as const) : ("mismatch" as const),
    environment: expected.environment,
    sourceCommit: expected.sourceCommit,
    manifestDigest: expected.manifestDigest,
    sourceDatabaseId: expected.sourceDatabaseId,
    sourceFence,
    sourceFenceDigest,
    guardInventory,
    integrity,
    verification,
    logical,
    protectedContentDigest,
    sourceExport,
    captureAuthorityDigest,
    issues,
  };
  return { ...evidence, evidenceDigest: await digestTransferValue(evidence) };
}

function normalizeTransferSourceVerificationOptions(
  options: ControlD1TransferSourceVerificationOptions,
): Required<ControlD1TransferSourceVerificationOptions> {
  const normalized = {
    environment: stringOption(options?.environment),
    sourceCommit: stringOption(options?.sourceCommit),
    manifestDigest: stringOption(options?.manifestDigest),
    sourceDatabaseId: stringOption(options?.sourceDatabaseId),
    sourceExportSha256: stringOption(options?.sourceExportSha256),
    sourceExportBookmark: stringOption(options?.sourceExportBookmark),
  } as const;
  if (
    (normalized.environment !== "staging" && normalized.environment !== "production") ||
    !/^[0-9a-f]{40}$/u.test(normalized.sourceCommit) ||
    !/^sha256:[0-9a-f]{64}$/u.test(normalized.manifestDigest) ||
    !/^[A-Za-z0-9_:.=-]{1,256}$/u.test(normalized.sourceDatabaseId) ||
    !/^sha256:[0-9a-f]{64}$/u.test(normalized.sourceExportSha256) ||
    !/^[A-Za-z0-9_:.=-]{1,256}$/u.test(normalized.sourceExportBookmark)
  ) {
    throw new ControlD1SchemaError("transfer_source_confirmation_invalid");
  }
  return normalized as Required<ControlD1TransferSourceVerificationOptions>;
}

/**
 * Read-only reconciliation for a candidate release whose response may have
 * been lost after commit. It never calls the release primitive and accepts
 * only the exact inactive receipt plus deterministic post-release evidence.
 */
export async function reconcileControlD1CandidateRelease(
  database: D1Database,
  plan: ControlD1SchemaPlan,
  options: ControlD1CandidateReleaseOptions,
): Promise<ControlD1CandidateReleaseResult> {
  const releaseReadinessDigest = normalizeReleaseReadinessDigest(options);
  const state = await readControlD1MaintenanceState(database);
  if (state.status !== "inactive") {
    throw new ControlD1SchemaError("candidate_release_receipt_unavailable");
  }
  const receipt = await readControlD1MaintenanceReleaseReceiptDetails(database);
  if (!receipt) {
    throw new ControlD1SchemaError("candidate_release_receipt_mismatch");
  }
  const reconciled = await verifyReleasedControlD1Candidate(
    database,
    plan,
    options,
    releaseReadinessDigest,
    receipt,
  );
  return { ...reconciled, lostAcknowledgementReconciled: true };
}

export const reconcileControlD1TransferredCandidateRelease =
  reconcileControlD1CandidateRelease;

/**
 * Release exactly one verified Control candidate. There is intentionally no
 * retry or readback adoption on an indeterminate release transport result;
 * callers must retain the fence and investigate that outcome.
 */
export async function releaseControlD1Candidate(
  database: D1Database,
  plan: ControlD1SchemaPlan,
  options: ControlD1CandidateReleaseOptions,
): Promise<ControlD1CandidateReleaseResult> {
  const releaseReadinessDigest = normalizeReleaseReadinessDigest(options);
  const currentState = await readControlD1MaintenanceState(database);
  if (currentState.status === "inactive") {
    return reconcileControlD1CandidateRelease(database, plan, options);
  }
  const verification = await verifyControlD1Candidate(database, plan, options);
  if (
    verification.status !== "ready" ||
    !verification.maintenanceFence ||
    !verification.guardInventory ||
    !verification.candidateFenceDigest
  ) {
    throw new ControlD1SchemaError("candidate_verification_failed");
  }

  // This is the only mutation in the candidate lane. The primitive performs
  // its own exact active-fence identity check and is called once.
  await releaseControlD1MaintenanceFence(
    database,
    verification.maintenanceFence,
    options.releasedAt,
    { releaseReadinessDigest },
  );
  const receipt = await readControlD1MaintenanceReleaseReceiptDetails(database);
  if (!receipt) {
    throw new ControlD1SchemaError("candidate_release_receipt_mismatch");
  }
  const released = await verifyReleasedControlD1Candidate(
    database,
    plan,
    options,
    releaseReadinessDigest,
    receipt,
  );
  return { ...released, lostAcknowledgementReconciled: false };
}

async function verifyReleasedControlD1Candidate(
  database: D1Database,
  plan: ControlD1SchemaPlan,
  options: ControlD1CandidateReleaseOptions,
  releaseReadinessDigest: string,
  receipt: Awaited<ReturnType<typeof readControlD1MaintenanceReleaseReceiptDetails>>,
): Promise<Omit<ControlD1CandidateReleaseResult, "lostAcknowledgementReconciled">> {
  if (!receipt) {
    throw new ControlD1SchemaError("candidate_release_receipt_mismatch");
  }
  const expected = normalizeCandidateVerificationOptions(options);
  const fence = receipt.fence;
  if (
    fence.sourceCommit !== expected.sourceCommit ||
    fence.manifestDigest !== expected.manifestDigest ||
    fence.environment !== expected.environment ||
    fence.databaseRole !== "candidate" ||
    fence.releasePolicy !== "cutover" ||
    fence.databaseId !== expected.candidateDatabaseId ||
    fence.sourceExportSha256 !== expected.sourceExportSha256 ||
    (expected.expectedFenceId !== null &&
      fence.fenceId !== expected.expectedFenceId) ||
    (await digestControlD1MaintenanceFence(fence)) !==
      expected.expectedFenceDigest ||
    receipt.releasedAt !== options.releasedAt ||
    receipt.releaseReadinessDigest !== releaseReadinessDigest
  ) {
    throw new ControlD1SchemaError("candidate_release_receipt_mismatch");
  }
  const verification = await verifyControlD1Schema(database, plan);
  const guardInventory = await readControlD1MaintenanceGuardInventory(database);
  const expectedTriggers = expectedMaintenanceGuardTriggers(guardInventory.tables);
  const expectedTriggerSqlDigests = await expectedMaintenanceGuardTriggerSqlDigests(
    guardInventory.tables,
  );
  const expectedGuardInventory = {
    tables: [...guardInventory.tables].sort(),
    triggers: expectedTriggers,
    triggerSqlDigests: expectedTriggerSqlDigests,
    triggerSqlDigest: await digestControlD1MaintenanceGuardTriggerInventory(
      expectedTriggerSqlDigests,
    ),
    guardedTableCount: guardInventory.tables.length,
    guardTriggerCount: expectedTriggers.length,
    digest: await digestControlD1MaintenanceGuardInventory({
      tables: [...guardInventory.tables].sort(),
      triggers: expectedTriggers,
      triggerSqlDigests: expectedTriggerSqlDigests,
    }),
  } satisfies ControlD1MaintenanceGuardInventory;
  const expectedPostReleaseDigest = await digestControlD1MaintenanceGuardInventory({
    tables: guardInventory.tables,
    triggers: [],
    triggerSqlDigests: [],
  });
  const expectedPostReleaseTriggerSqlDigest =
    await digestControlD1MaintenanceGuardTriggerInventory([]);
  if (
    verification.status !== "ready" ||
    guardInventory.guardedTableCount !== guardInventory.tables.length ||
    guardInventory.triggers.length !== 0 ||
    guardInventory.guardTriggerCount !== 0 ||
    guardInventory.triggerSqlDigests.length !== 0 ||
    guardInventory.triggerSqlDigest !== expectedPostReleaseTriggerSqlDigest ||
    guardInventory.digest !== expectedPostReleaseDigest ||
    expectedTriggers.length !== guardInventory.tables.length * 3 ||
    expectedTriggerSqlDigests.length !== expectedTriggers.length
  ) {
    throw new ControlD1SchemaError("candidate_release_receipt_mismatch");
  }
  const integrity = await verifyControlD1Integrity(database);
  if (integrity.status !== "ready") {
    throw new ControlD1SchemaError("candidate_release_receipt_mismatch");
  }
  return {
    status: "released",
    environment: expected.environment,
    sourceCommit: expected.sourceCommit,
    manifestDigest: expected.manifestDigest,
    candidateDatabaseId: expected.candidateDatabaseId,
    sourceExportSha256: expected.sourceExportSha256,
    releaseReadinessDigest,
    maintenanceStatus: "released",
    maintenanceFence: fence,
    candidateFenceDigest: expected.expectedFenceDigest,
    guardInventory: expectedGuardInventory,
    integrity,
    verification,
  };
}

/** Alias used by Cloud's transferred-candidate controller. */
export const releaseControlD1TransferredCandidate = releaseControlD1Candidate;

function normalizeCandidateVerificationOptions(
  options: ControlD1CandidateVerificationOptions,
): Required<
  Pick<
    ControlD1CandidateVerificationOptions,
    | "environment"
    | "sourceCommit"
    | "manifestDigest"
    | "candidateDatabaseId"
    | "sourceExportSha256"
  >
> & {
  readonly expectedFenceId: string | null;
  readonly expectedFenceDigest: string;
} {
  if (!options || typeof options !== "object") {
    throw new ControlD1SchemaError("candidate_confirmation_invalid");
  }
  const expectedFenceId =
    options.expectedFenceId ?? options.confirmFenceId ?? options.fenceId;
  const expectedFenceDigest =
    options.expectedFenceDigest ?? options.confirmFenceDigest ?? options.fenceDigest;
  const normalized = {
    environment: stringOption(options.environment),
    sourceCommit: stringOption(options.sourceCommit),
    manifestDigest: stringOption(options.manifestDigest),
    candidateDatabaseId: stringOption(options.candidateDatabaseId),
    sourceExportSha256: stringOption(options.sourceExportSha256),
    expectedFenceId: stringOption(expectedFenceId) || null,
    expectedFenceDigest: stringOption(expectedFenceDigest),
  } as const;
  if (
    !/^[a-z][a-z0-9_-]{0,31}$/u.test(normalized.environment) ||
    !/^[0-9a-f]{40}$/u.test(normalized.sourceCommit) ||
    !/^sha256:[0-9a-f]{64}$/u.test(normalized.manifestDigest) ||
    !/^[A-Za-z0-9_:.=-]{1,256}$/u.test(normalized.candidateDatabaseId) ||
    !/^sha256:[0-9a-f]{64}$/u.test(normalized.sourceExportSha256) ||
    (normalized.expectedFenceId !== null &&
      !/^sha256:[0-9a-f]{64}$/u.test(normalized.expectedFenceId)) ||
    !/^sha256:[0-9a-f]{64}$/u.test(normalized.expectedFenceDigest)
  ) {
    throw new ControlD1SchemaError("candidate_confirmation_invalid");
  }
  return normalized;
}

function normalizeReleaseReadinessDigest(
  options: ControlD1CandidateReleaseOptions,
): string {
  if (!options || typeof options !== "object") {
    throw new ControlD1SchemaError("candidate_release_confirmation_invalid");
  }
  const digest =
    options.releaseReadinessDigest ??
    options.confirmReleaseReadinessDigest ??
    options.promotionReadinessDigest;
  if (
    typeof digest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(digest.trim())
  ) {
    throw new ControlD1SchemaError("candidate_release_readiness_required");
  }
  if (!validIsoTimestamp(options.releasedAt)) {
    throw new ControlD1SchemaError("candidate_release_time_invalid");
  }
  return digest.trim();
}

function expectedMaintenanceGuardTriggers(
  tables: readonly string[],
): readonly string[] {
  return tables
    .flatMap((table) =>
      (["insert", "update", "delete"] as const).map(
        (operation) => `_takosumi_schema_fence_${table}_${operation}`,
      ),
    )
    .sort();
}

async function expectedMaintenanceGuardTriggerSqlDigests(
  tables: readonly string[],
): Promise<ControlD1MaintenanceGuardInventory["triggerSqlDigests"]> {
  const entries = await Promise.all(
    tables.flatMap((table) =>
      (["insert", "update", "delete"] as const).map(async (operation) => ({
        name: `_takosumi_schema_fence_${table}_${operation}`,
        table,
        operation,
        digest: await digestControlD1MaintenanceGuardTriggerSql(
          table,
          operation,
        ),
      })),
    ),
  );
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

async function verifyControlD1Integrity(
  database: D1Database,
): Promise<ControlD1CandidateIntegrityVerification> {
  let integrityCheck: ControlD1CandidateIntegrityVerification["integrityCheck"] =
    "unsupported";
  try {
    const result = await database
      .prepare("pragma integrity_check")
      .all<{ readonly integrity_check?: unknown }>();
    const values = (result.results ?? []).map((row) =>
      String(row.integrity_check ?? "").trim().toLowerCase(),
    );
    integrityCheck = values.length === 1 && values[0] === "ok" ? "ok" : "mismatch";
  } catch {
    integrityCheck = "unsupported";
  }

  let foreignKeyCheck: ControlD1CandidateIntegrityVerification["foreignKeyCheck"] =
    "unsupported";
  let foreignKeyViolationCount = 0;
  try {
    const result = await database.prepare("pragma foreign_key_check").all();
    if (!Array.isArray(result.results)) {
      foreignKeyCheck = "mismatch";
    } else {
      foreignKeyViolationCount = result.results.length;
      foreignKeyCheck =
        foreignKeyViolationCount === 0 ? "ok" : "mismatch";
    }
  } catch {
    foreignKeyCheck = "mismatch";
  }
  return {
    status:
      integrityCheck !== "ok" || foreignKeyCheck !== "ok"
        ? "mismatch"
        : "ready",
    integrityCheck,
    foreignKeyCheck,
    foreignKeyViolationCount,
  };
}

function validIsoTimestamp(value: string): boolean {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
}

function stringOption(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** D1 logical-content evidence uses the same length-prefixed SQLite encoding
 * as the Cloud transfer module, while keeping rows out of the transcript. */
async function readControlD1TransferLogicalDatabaseDigest(
  database: D1Database,
): Promise<ControlD1TransferLogicalDatabaseDigest> {
  const inventory = await database
    .prepare(
      `select name from sqlite_master
       where type = 'table' and name not like 'sqlite_%'
       order by name`,
    )
    .all<{ readonly name: string }>();
  const names = (inventory.results ?? []).map((row) => String(row.name));
  const tables: ControlD1TransferLogicalTableDigest[] = [];
  const excludedTables: Array<{
    readonly table: string;
    readonly reason: "cloudflare_internal";
  }> = [];
  for (const table of names) {
    if (table === "_cf_KV") {
      excludedTables.push({ table, reason: "cloudflare_internal" });
      continue;
    }
    const columnsResult = await database
      .prepare(`pragma table_xinfo(${quoteSqlString(table)})`)
      .all<{ readonly cid: number | string; readonly name: string }>();
    const columns = [...(columnsResult.results ?? [])]
      .sort((left, right) => Number(left.cid) - Number(right.cid))
      .map((column) => String(column.name));
    if (columns.length === 0 || columns.some((column) => !/^[a-z_][a-z0-9_]{0,127}$/u.test(column))) {
      throw new ControlD1SchemaError(`logical_table_columns_invalid:${table}`);
    }
    const expression = transferCanonicalRowExpression(columns);
    const hasher = new Bun.CryptoHasher("sha256");
    let rowCount = 0;
    for (let offset = 0; ; offset += 1_000) {
      const page = await database
        .prepare(
          `select ${expression} as canonical_row
          from ${transferQuotedIdentifier(table)}
           order by canonical_row limit ? offset ?`,
        )
        .bind(1_000, offset)
        .all<{ readonly canonical_row: string }>();
      const rows = page.results ?? [];
      for (const row of rows) {
        if (typeof row.canonical_row !== "string") {
          throw new ControlD1SchemaError(`logical_remote_row_invalid:${table}`);
        }
        const bytes = new TextEncoder().encode(row.canonical_row);
        hasher.update(`${bytes.byteLength}:`);
        hasher.update(bytes);
        rowCount += 1;
      }
      if (rows.length < 1_000) break;
    }
    const rowDigest = `sha256:${hasher.digest("hex")}`;
    const contentDigest = await digestTransferValue({
      table,
      columns,
      rowCount,
      rowDigest,
    });
    tables.push({ table, columns, rowCount, rowDigest, contentDigest });
  }
  const databaseDigest = await digestTransferValue({
    kind: "takosumi.sqlite-logical-content@v1",
    tables: tables.map((table) => ({
      table: table.table,
      columns: table.columns,
      rowCount: table.rowCount,
      contentDigest: table.contentDigest,
    })),
    excludedTables,
  });
  return {
    kind: "takosumi.sqlite-logical-content@v1",
    algorithm: "sha256",
    databaseDigest,
    tables,
    excludedTables,
  };
}

function transferCanonicalRowExpression(columns: readonly string[]): string {
  return columns
    .map((column) => {
      const identifier = transferQuotedIdentifier(column);
      const encoded =
        `case typeof(${identifier}) ` +
        `when 'null' then 'N' ` +
        `when 'integer' then 'I' || printf('%lld', ${identifier}) ` +
        `when 'real' then 'R' || printf('%!.17g', ${identifier}) ` +
        `when 'text' then 'T' || hex(cast(${identifier} as blob)) ` +
        `when 'blob' then 'B' || hex(${identifier}) ` +
        `else 'X' || typeof(${identifier}) end`;
      return `length(${encoded}) || ':' || ${encoded}`;
    })
    .join(" || ");
}

function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function transferQuotedIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(value)) {
    throw new ControlD1SchemaError("logical_identifier_invalid");
  }
  return `"${value.replaceAll('"', '""')}"`;
}

export async function readControlD1MigrationLedger(
  database: D1Database,
): Promise<readonly ControlD1MigrationLedgerRow[]> {
  const tables = await listUserTableNames(database);
  if (!tables.has("schema_migrations")) return [];
  const result = await database
    .prepare(
      `select version, name, checksum
       from schema_migrations
       order by version`,
    )
    .all<{
      readonly version: number | string;
      readonly name: string;
      readonly checksum: string;
    }>();
  return (result.results ?? []).map((row) => ({
    version: Number(row.version),
    name: String(row.name),
    checksum: String(row.checksum),
  }));
}

async function inspectOwnedTables(
  database: D1Database,
): Promise<readonly ControlD1TableDescriptor[]> {
  const names = [...(await listUserTableNames(database))].sort();
  const tables = [];
  for (const name of names) tables.push(await inspectTable(database, name));
  return tables;
}

async function listUserTableNames(
  database: D1Database,
): Promise<ReadonlySet<string>> {
  const result = await database
    .prepare(
      `select name
       from sqlite_master
       where type = 'table' and name not like 'sqlite_%'
       order by name`,
    )
    .all<{ readonly name: string }>();
  return new Set((result.results ?? []).map((row) => String(row.name)));
}

async function inspectTable(
  database: D1Database,
  tableName: string,
): Promise<ControlD1TableDescriptor> {
  const table = quotedIdentifier(tableName);
  const tableSqlRow = await database
    .prepare(
      `select sql from sqlite_master
       where type = 'table' and name = ?
       limit 1`,
    )
    .bind(tableName)
    .first<{ readonly sql: string | null }>();
  if (!tableSqlRow?.sql) {
    throw new ControlD1SchemaError("schema_table_sql_missing");
  }
  const columnResult = await database
    .prepare(`pragma table_xinfo(${table})`)
    .all<{
      readonly cid: number | string;
      readonly name: string;
      readonly type: string;
      readonly notnull: number | string;
      readonly dflt_value: unknown;
      readonly pk: number | string;
      readonly hidden: number | string;
    }>();
  const columns = (columnResult.results ?? [])
    .map((row) => ({
      columnId: Number(row.cid),
      name: String(row.name),
      type: String(row.type ?? "")
        .trim()
        .toLowerCase(),
      notNull: Number(row.notnull) !== 0,
      defaultValue: normalizedDefault(row.dflt_value),
      primaryKeyPosition: Number(row.pk),
      hidden: Number(row.hidden),
    }))
    .sort((left, right) => left.columnId - right.columnId);

  const indexList = await database.prepare(`pragma index_list(${table})`).all<{
    readonly name: string;
    readonly unique: number | string;
    readonly partial: number | string;
    readonly origin: string;
  }>();
  const indexes: ControlD1IndexDescriptor[] = [];
  for (const row of indexList.results ?? []) {
    const name = String(row.name);
    const index = quotedIdentifier(name);
    const indexInfo = await database
      .prepare(`pragma index_xinfo(${index})`)
      .all<{
        readonly seqno: number | string;
        readonly cid: number | string;
        readonly name: string | null;
        readonly desc: number | string;
        readonly coll: string | null;
        readonly key: number | string;
      }>();
    const sqlRow = await database
      .prepare(
        `select sql
         from sqlite_master
         where type = 'index' and name = ?
         limit 1`,
      )
      .bind(name)
      .first<{ readonly sql: string | null }>();
    indexes.push({
      name,
      unique: Number(row.unique) !== 0,
      partial: Number(row.partial) !== 0,
      origin: String(row.origin ?? "").toLowerCase(),
      columns: [...(indexInfo.results ?? [])]
        .sort((left, right) => Number(left.seqno) - Number(right.seqno))
        .map((entry) => ({
          sequence: Number(entry.seqno),
          columnId: Number(entry.cid),
          name: entry.name === null ? null : String(entry.name),
          descending: Number(entry.desc) !== 0,
          collation: entry.coll === null ? null : String(entry.coll),
          key: Number(entry.key) !== 0,
        })),
      sql: sqlRow?.sql ? canonicalSql(sqlRow.sql) : null,
      where: normalizedWhere(sqlRow?.sql ?? null),
    });
  }
  indexes.sort((left, right) => left.name.localeCompare(right.name));

  const foreignKeyResult = await database
    .prepare(`pragma foreign_key_list(${table})`)
    .all<{
      readonly id: number | string;
      readonly seq: number | string;
      readonly table: string;
      readonly from: string;
      readonly to: string | null;
      readonly on_update: string;
      readonly on_delete: string;
      readonly match: string;
    }>();
  const foreignKeys = (foreignKeyResult.results ?? [])
    .map((row) => ({
      id: Number(row.id),
      sequence: Number(row.seq),
      table: String(row.table),
      from: String(row.from),
      to: row.to === null ? null : String(row.to),
      onUpdate: String(row.on_update).toLowerCase(),
      onDelete: String(row.on_delete).toLowerCase(),
      match: String(row.match).toLowerCase(),
    }))
    .sort(
      (left, right) => left.id - right.id || left.sequence - right.sequence,
    );

  return {
    name: tableName,
    sql: canonicalTableDefinition(tableSqlRow.sql),
    columns,
    indexes,
    foreignKeys,
  };
}

async function inspectAttachedSchemaObjects(
  database: D1Database,
  ownedTables: ReadonlySet<string>,
  options: {
    readonly ignoreMaintenanceTriggers?: boolean;
  } = {},
): Promise<readonly ControlD1AttachedSchemaObjectDescriptor[]> {
  const result = await database
    .prepare(
      `select type, name, tbl_name, sql
       from sqlite_master
       where type in ('trigger', 'view') and sql is not null
       order by type, name`,
    )
    .all<{
      readonly type: "trigger" | "view";
      readonly name: string;
      readonly tbl_name: string;
      readonly sql: string;
    }>();
  return (result.results ?? [])
    .filter((row) => {
      if (
        options.ignoreMaintenanceTriggers &&
        row.name.startsWith("_takosumi_schema_fence_")
      ) {
        return false;
      }
      if (row.type === "trigger") return ownedTables.has(row.tbl_name);
      const sql = canonicalSql(row.sql);
      return [...ownedTables].some((table) =>
        sqlMentionsIdentifier(sql, table),
      );
    })
    .map((row) => ({
      type: row.type,
      name: String(row.name),
      table: String(row.tbl_name),
      sql: canonicalSql(row.sql),
    }))
    .sort((left, right) =>
      `${left.type}:${left.name}`.localeCompare(`${right.type}:${right.name}`),
    );
}

function normalizedDefault(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return String(value).trim().replace(/\s+/gu, " ");
}

function normalizedWhere(sql: string | null): string | null {
  if (!sql) return null;
  const match = /\bwhere\b([\s\S]+)$/iu.exec(sql);
  return match?.[1] ? canonicalSql(match[1]) : null;
}

function canonicalTableDefinition(value: string): string {
  const open = value.indexOf("(");
  const close = value.lastIndexOf(")");
  if (open < 0 || close <= open) return canonicalSql(value);
  const definitions = splitTopLevel(value.slice(open + 1, close))
    .map(canonicalSql)
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
  return stableJson({
    definitions,
    suffix: canonicalSql(value.slice(close + 1)),
  });
}

function splitTopLevel(value: string): string[] {
  const entries: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: "'" | '"' | "`" | "]" | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (quote === "]") {
        if (character === "]") quote = undefined;
      } else if (character === quote) {
        if (value[index + 1] === quote) index += 1;
        else quote = undefined;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "[") {
      quote = "]";
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (character === "," && depth === 0) {
      entries.push(value.slice(start, index));
      start = index + 1;
    }
  }
  entries.push(value.slice(start));
  return entries;
}

function canonicalSql(value: string): string {
  const quoted: string[] = [];
  const placeholders = value.replace(
    /'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]/gu,
    (literal) => {
      const placeholder = `__TAKOSUMI_QUOTED_${quoted.length}__`;
      quoted.push(literal);
      return placeholder;
    },
  );
  let canonical = placeholders
    .trim()
    .replace(/;$/u, "")
    .toUpperCase()
    .replace(/\s+/gu, " ")
    .replace(/\s*([(),=<>!+*/-])\s*/gu, "$1");
  quoted.forEach((literal, index) => {
    canonical = canonical.replace(`__TAKOSUMI_QUOTED_${index}__`, literal);
  });
  return canonical;
}

function sqlMentionsIdentifier(sql: string, identifier: string): boolean {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(
    `(?:^|[^A-Z0-9_])(?:"${escaped}"|${escaped})(?:$|[^A-Z0-9_])`,
    "iu",
  ).test(sql);
}

function quotedIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/u.test(value)) {
    throw new ControlD1SchemaError("schema_identifier_invalid");
  }
  return `"${value}"`;
}

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableJson(value));
  const valueDigest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(valueDigest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

async function digestTransferValue(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalTransferJson(value));
  const valueDigest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(valueDigest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function canonicalTransferJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalTransferJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalTransferJson(object[key])}`)
    .join(",")}}`;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

export class ControlD1SchemaError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ControlD1SchemaError";
  }
}

/** Bun SQLite adapter used only for deterministic planning and tests. */
export class SqliteControlD1Database implements D1Database {
  readonly #database: Database;

  constructor(filename = ":memory:") {
    this.#database = new Database(filename);
  }

  close(): void {
    this.#database.close();
  }

  /** Test/planning fixture loader; remote D1 execution never uses this path. */
  exec(sql: string): void {
    this.#database.exec(sql);
  }

  prepare(query: string): D1PreparedStatement {
    return new SqliteControlD1Statement(this.#database, query);
  }

  async batch<T = unknown>(
    statements: readonly D1PreparedStatement[],
  ): Promise<readonly D1Result<T>[]> {
    this.#database.exec("begin immediate");
    try {
      const results: D1Result<T>[] = [];
      for (const statement of statements) {
        results.push(await statement.run<T>());
      }
      this.#database.exec("commit");
      return results;
    } catch (error) {
      this.#database.exec("rollback");
      throw error;
    }
  }
}

class SqliteControlD1Statement implements D1PreparedStatement {
  readonly #database: Database;
  readonly #query: string;
  #values: readonly unknown[] = [];

  constructor(database: Database, query: string) {
    this.#database = database;
    this.#query = query;
  }

  bind(...values: readonly unknown[]): D1PreparedStatement {
    this.#values = values;
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    return (this.#database.query(this.#query).get(...bindings(this.#values)) ??
      null) as T | null;
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    return {
      success: true,
      results: this.#database
        .query(this.#query)
        .all(...bindings(this.#values)) as T[],
    };
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    const result = this.#database.run(this.#query, bindings(this.#values));
    return {
      success: true,
      meta: {
        changes: result.changes,
        last_row_id: Number(result.lastInsertRowid),
      },
    };
  }
}

function bindings(values: readonly unknown[]): SQLQueryBindings[] {
  return values.map((value) =>
    value === undefined ? null : (value as SQLQueryBindings),
  );
}
