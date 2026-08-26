import {
  applyD1AccountsMigrationBatch,
  backfillD1AccountsActivationDigests,
  D1AccountsMigrationError,
  digestD1AccountsValue,
  loadD1AccountsMigrationCatalog,
  readD1AccountsMigrationState,
  type D1AccountsMigrationCatalog,
  type D1AccountsMigrationDatabase,
  type D1AccountsMigrationState,
} from "../../accounts/service/src/d1-migrations.ts";
import {
  OwnerPrivateEvidenceError,
  writeNewOwnerPrivateEvidenceJson,
} from "./owner-private-evidence.ts";

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;

export type D1AccountsRemoteEnvironment = "staging" | "production";

export interface D1AccountsMigrationPlan {
  readonly kind: "takosumi.accounts.d1-migration@v2";
  readonly mode: "plan";
  readonly status: "planned";
  readonly sourceCommit: string;
  readonly environment: D1AccountsRemoteEnvironment;
  readonly sourceDigest: string;
  readonly catalogDigest: string;
  readonly targetDigest: string;
  readonly migrationPolicyDigest: string;
  readonly configurationDigest: string;
  readonly backupEvidenceDigest?: string;
  readonly expectedHead: number;
  readonly expectedCount: number;
  readonly applied: readonly number[];
  readonly skipped: readonly number[];
  readonly lostAcknowledgementReconciled: readonly number[];
  readonly issues: readonly string[];
}

export interface D1AccountsMigrationReport {
  readonly kind: "takosumi.accounts.d1-migration@v2";
  readonly mode: "apply" | "status" | "verify";
  readonly status: "applied" | "pending" | "verified" | "invalid";
  readonly sourceCommit: string;
  readonly environment: D1AccountsRemoteEnvironment;
  readonly sourceDigest: string;
  readonly catalogDigest: string;
  readonly targetDigest: string;
  readonly migrationPolicyDigest: string;
  readonly configurationDigest: string;
  readonly backupEvidenceDigest?: string;
  readonly expectedHead: number;
  readonly expectedCount: number;
  readonly ledgerDigest: string;
  readonly schemaDigest: string;
  readonly missingActivationDigestCount: number | null;
  readonly applied: readonly number[];
  readonly skipped: readonly number[];
  readonly lostAcknowledgementReconciled: readonly number[];
  readonly issues: readonly string[];
  readonly failureCode?: string;
  readonly activationDigestBackfill?: {
    readonly inventoryCount: number;
    readonly candidateCount: number;
    readonly chunkCount: number;
    readonly lostAcknowledgementReconciledChunks: number;
    readonly cutoverReconciled: boolean;
    readonly missingAfter: number;
  };
}

export interface D1AccountsApplyConfirmations {
  readonly confirmSourceDigest: string;
  readonly confirmCatalogDigest: string;
  readonly confirmTargetDigest: string;
  readonly confirmConfigurationDigest: string;
}

export interface D1AccountsBackupEvidence {
  readonly kind: "takosumi.accounts.d1-backup-evidence@v1";
  readonly sourceCommit: string;
  readonly environment: D1AccountsRemoteEnvironment;
  readonly sourceDigest: string;
  readonly catalogDigest: string;
  readonly targetDigest: string;
  readonly migrationPolicyDigest: string;
  readonly bookmark: string;
  readonly capturedAt: string;
  readonly backupEvidenceDigest: string;
}

export interface D1AccountsBackupStatusTranscript {
  readonly kind: "takosumi.accounts.d1-backup-status@v1";
  readonly mode: "backup-status";
  readonly status: "captured";
  readonly sourceCommit: string;
  readonly environment: D1AccountsRemoteEnvironment;
  readonly sourceDigest: string;
  readonly catalogDigest: string;
  readonly targetDigest: string;
  readonly migrationPolicyDigest: string;
  readonly backupEvidenceDigest: string;
  readonly privateFileMode: "0600";
  readonly issues: readonly string[];
}

export async function buildD1AccountsMigrationPlan(input: {
  readonly sourceCommit: string;
  readonly environment: D1AccountsRemoteEnvironment;
  readonly accountId: string;
  readonly databaseId: string;
  readonly backupEvidenceDigest?: string;
}): Promise<D1AccountsMigrationPlan> {
  const sourceCommit = validatedCommit(input.sourceCommit);
  const accountId = opaqueTargetPart(input.accountId, "account_id_invalid");
  const databaseId = opaqueTargetPart(input.databaseId, "database_id_invalid");
  const backupEvidenceDigest = input.backupEvidenceDigest
    ? validatedDigest(input.backupEvidenceDigest, "backup_evidence_digest_invalid")
    : undefined;
  const catalog = await loadD1AccountsMigrationCatalog();
  const sourceDigest = await digestD1AccountsValue({ sourceCommit });
  const targetDigest = await digestD1AccountsValue({
    apiOrigin: "https://api.cloudflare.com",
    environment: input.environment,
    accountId,
    databaseId,
  });
  const configurationDigest = await digestD1AccountsValue({
    sourceDigest,
    catalogDigest: catalog.digest,
    targetDigest,
    migrationPolicyDigest: catalog.policyDigest,
    backupEvidenceDigest: backupEvidenceDigest ?? null,
  });
  return {
    kind: "takosumi.accounts.d1-migration@v2",
    mode: "plan",
    status: "planned",
    sourceCommit,
    environment: input.environment,
    sourceDigest,
    catalogDigest: catalog.digest,
    targetDigest,
    migrationPolicyDigest: catalog.policyDigest,
    configurationDigest,
    ...(backupEvidenceDigest ? { backupEvidenceDigest } : {}),
    expectedHead: catalog.headVersion,
    expectedCount: catalog.migrations.length,
    applied: [],
    skipped: [],
    lostAcknowledgementReconciled: [],
    issues: [],
  };
}

export async function captureD1AccountsBackupEvidence(input: {
  readonly plan: D1AccountsMigrationPlan;
  readonly bookmark: string;
  readonly capturedAt: string;
  readonly out: string;
  readonly sourceRoots: readonly string[];
}): Promise<D1AccountsBackupStatusTranscript> {
  const bookmark = validatedBookmark(input.bookmark);
  const capturedAt = validatedTimestamp(input.capturedAt);
  const evidenceBody = {
    kind: "takosumi.accounts.d1-backup-evidence@v1" as const,
    sourceCommit: input.plan.sourceCommit,
    environment: input.plan.environment,
    sourceDigest: input.plan.sourceDigest,
    catalogDigest: input.plan.catalogDigest,
    targetDigest: input.plan.targetDigest,
    migrationPolicyDigest: input.plan.migrationPolicyDigest,
    bookmark,
    capturedAt,
  };
  const backupEvidenceDigest = await digestD1AccountsValue(evidenceBody);
  const evidence: D1AccountsBackupEvidence = {
    ...evidenceBody,
    backupEvidenceDigest,
  };
  try {
    await writeNewOwnerPrivateEvidenceJson(input.out, evidence, {
      sourceRoots: input.sourceRoots,
    });
  } catch (error) {
    if (error instanceof OwnerPrivateEvidenceError) {
      throw new D1AccountsMigrationError(error.code);
    }
    throw new D1AccountsMigrationError("owner_private_evidence_write_failed");
  }
  return {
    kind: "takosumi.accounts.d1-backup-status@v1",
    mode: "backup-status",
    status: "captured",
    sourceCommit: input.plan.sourceCommit,
    environment: input.plan.environment,
    sourceDigest: input.plan.sourceDigest,
    catalogDigest: input.plan.catalogDigest,
    targetDigest: input.plan.targetDigest,
    migrationPolicyDigest: input.plan.migrationPolicyDigest,
    backupEvidenceDigest,
    privateFileMode: "0600",
    issues: [],
  };
}

export async function applyPlannedD1AccountsMigrations(input: {
  readonly database: D1AccountsMigrationDatabase;
  readonly catalog: D1AccountsMigrationCatalog;
  readonly plan: D1AccountsMigrationPlan;
  readonly confirmSourceDigest: string;
  readonly confirmCatalogDigest: string;
  readonly confirmTargetDigest: string;
  readonly confirmConfigurationDigest: string;
  readonly now?: () => number;
}): Promise<D1AccountsMigrationReport> {
  assertPlanMatchesCatalog(input.plan, input.catalog);
  await assertD1AccountsApplyConfirmations(input.plan, input);

  let activationDigestBackfill:
    | D1AccountsMigrationReport["activationDigestBackfill"]
    | undefined;

  let state = await readD1AccountsMigrationState(input.database, input.catalog);
  assertApplyableState(state);
  const prefixLength = state.exactPrefixLength ?? 0;
  const skipped = input.catalog.migrations
    .slice(0, prefixLength)
    .map(({ version }) => version);
  const applied: number[] = [];
  const reconciled: number[] = [];
  const now = input.now ?? Date.now;

  for (const migration of input.catalog.migrations.slice(prefixLength)) {
    const expectedPreLength = migration.version;
    if (!isExactPrefix(state, expectedPreLength)) {
      throw new D1AccountsMigrationError("migration_pre_state_invalid");
    }
    if (migration.version === 4) {
      activationDigestBackfill =
        await backfillD1AccountsActivationDigests(input.database);
    }
    try {
      await applyD1AccountsMigrationBatch(input.database, migration, now());
    } catch {
      let reconciledState: D1AccountsMigrationState;
      try {
        reconciledState = await readD1AccountsMigrationState(
          input.database,
          input.catalog,
        );
      } catch {
        throw new D1AccountsMigrationError("migration_state_indeterminate");
      }
      if (isExactPrefix(reconciledState, expectedPreLength + 1)) {
        reconciled.push(migration.version);
        state = reconciledState;
        continue;
      }
      if (isExactPrefix(reconciledState, expectedPreLength)) {
        throw new D1AccountsMigrationError(
          "migration_batch_not_committed_retry_required",
        );
      }
      throw new D1AccountsMigrationError("migration_state_indeterminate");
    }

    try {
      state = await readD1AccountsMigrationState(input.database, input.catalog);
    } catch {
      throw new D1AccountsMigrationError("migration_state_indeterminate");
    }
    if (!isExactPrefix(state, expectedPreLength + 1)) {
      throw new D1AccountsMigrationError("migration_state_indeterminate");
    }
    applied.push(migration.version);
  }

  return reportFromState({
    plan: input.plan,
    mode: "apply",
    status: "applied",
    state,
    applied,
    skipped,
    reconciled,
    activationDigestBackfill,
  });
}

export async function assertD1AccountsApplyConfirmations(
  plan: D1AccountsMigrationPlan,
  confirmations: D1AccountsApplyConfirmations,
): Promise<void> {
  if (!plan.backupEvidenceDigest) {
    throw new D1AccountsMigrationError("backup_evidence_digest_required");
  }
  assertConfirmation(
    confirmations.confirmSourceDigest,
    plan.sourceDigest,
    "source_confirmation_mismatch",
  );
  assertConfirmation(
    confirmations.confirmCatalogDigest,
    plan.catalogDigest,
    "catalog_confirmation_mismatch",
  );
  assertConfirmation(
    confirmations.confirmTargetDigest,
    plan.targetDigest,
    "target_confirmation_mismatch",
  );
  assertConfirmation(
    confirmations.confirmConfigurationDigest,
    plan.configurationDigest,
    "configuration_confirmation_mismatch",
  );
  const expectedConfigurationDigest = await digestD1AccountsValue({
    sourceDigest: plan.sourceDigest,
    catalogDigest: plan.catalogDigest,
    targetDigest: plan.targetDigest,
    migrationPolicyDigest: plan.migrationPolicyDigest,
    backupEvidenceDigest: plan.backupEvidenceDigest,
  });
  if (plan.configurationDigest !== expectedConfigurationDigest) {
    throw new D1AccountsMigrationError("configuration_confirmation_mismatch");
  }
}

export async function statusPlannedD1AccountsMigrations(input: {
  readonly database: D1AccountsMigrationDatabase;
  readonly catalog: D1AccountsMigrationCatalog;
  readonly plan: D1AccountsMigrationPlan;
}): Promise<D1AccountsMigrationReport> {
  assertPlanMatchesCatalog(input.plan, input.catalog);
  const state = await readD1AccountsMigrationState(input.database, input.catalog);
  const validPrefix = state.exactPrefixLength !== null && state.issues.length === 0;
  const currentLength = state.exactPrefixLength ?? 0;
  const atHead = validPrefix && currentLength === input.catalog.migrations.length;
  return reportFromState({
    plan: input.plan,
    mode: "status",
    status: !validPrefix ? "invalid" : atHead ? "verified" : "pending",
    state,
    skipped: input.catalog.migrations
      .slice(0, currentLength)
      .map(({ version }) => version),
    ...(!validPrefix ? { failureCode: "migration_state_invalid" } : {}),
  });
}

export async function verifyPlannedD1AccountsMigrations(input: {
  readonly database: D1AccountsMigrationDatabase;
  readonly catalog: D1AccountsMigrationCatalog;
  readonly plan: D1AccountsMigrationPlan;
}): Promise<D1AccountsMigrationReport> {
  assertPlanMatchesCatalog(input.plan, input.catalog);
  const state = await readD1AccountsMigrationState(input.database, input.catalog);
  const exactV4 =
    state.exactPrefixLength === input.catalog.migrations.length &&
    state.headVersion === input.catalog.headVersion &&
    state.ledgerShape === "checksummed" &&
    state.issues.length === 0;
  return reportFromState({
    plan: input.plan,
    mode: "verify",
    status: exactV4 ? "verified" : "invalid",
    state,
    skipped: exactV4
      ? input.catalog.migrations.map(({ version }) => version)
      : [],
    ...(!exactV4
      ? {
          issues: [...state.issues, "exact_v4_required"],
          failureCode: "exact_v4_required",
        }
      : {}),
  });
}

function reportFromState(input: {
  readonly plan: D1AccountsMigrationPlan;
  readonly mode: D1AccountsMigrationReport["mode"];
  readonly status: D1AccountsMigrationReport["status"];
  readonly state: D1AccountsMigrationState;
  readonly applied?: readonly number[];
  readonly skipped?: readonly number[];
  readonly reconciled?: readonly number[];
  readonly issues?: readonly string[];
  readonly failureCode?: string;
  readonly activationDigestBackfill?: D1AccountsMigrationReport["activationDigestBackfill"];
}): D1AccountsMigrationReport {
  return {
    kind: input.plan.kind,
    mode: input.mode,
    status: input.status,
    sourceCommit: input.plan.sourceCommit,
    environment: input.plan.environment,
    sourceDigest: input.plan.sourceDigest,
    catalogDigest: input.plan.catalogDigest,
    targetDigest: input.plan.targetDigest,
    migrationPolicyDigest: input.plan.migrationPolicyDigest,
    configurationDigest: input.plan.configurationDigest,
    ...(input.plan.backupEvidenceDigest
      ? { backupEvidenceDigest: input.plan.backupEvidenceDigest }
      : {}),
    expectedHead: input.plan.expectedHead,
    expectedCount: input.plan.expectedCount,
    ledgerDigest: input.state.ledgerDigest,
    schemaDigest: input.state.schemaDigest,
    missingActivationDigestCount: input.state.missingActivationDigestCount,
    applied: input.applied ?? [],
    skipped: input.skipped ?? [],
    lostAcknowledgementReconciled: input.reconciled ?? [],
    issues: input.issues ?? input.state.issues,
    ...(input.failureCode ? { failureCode: input.failureCode } : {}),
    ...(input.activationDigestBackfill
      ? { activationDigestBackfill: input.activationDigestBackfill }
      : {}),
  };
}

function assertPlanMatchesCatalog(
  plan: D1AccountsMigrationPlan,
  catalog: D1AccountsMigrationCatalog,
): void {
  if (
    plan.catalogDigest !== catalog.digest ||
    plan.migrationPolicyDigest !== catalog.policyDigest ||
    plan.expectedHead !== catalog.headVersion ||
    plan.expectedCount !== catalog.migrations.length
  ) {
    throw new D1AccountsMigrationError("plan_catalog_mismatch");
  }
}

function assertApplyableState(state: D1AccountsMigrationState): void {
  if (state.exactPrefixLength === null || state.issues.length > 0) {
    throw new D1AccountsMigrationError("migration_pre_state_invalid");
  }
}

function isExactPrefix(
  state: D1AccountsMigrationState,
  expectedLength: number,
): boolean {
  return state.exactPrefixLength === expectedLength && state.issues.length === 0;
}

function assertConfirmation(
  actual: string,
  expected: string,
  code: string,
): void {
  if (!DIGEST.test(actual) || actual !== expected) {
    throw new D1AccountsMigrationError(code);
  }
}

function validatedCommit(value: string): string {
  const normalized = value.trim();
  if (!COMMIT.test(normalized)) {
    throw new D1AccountsMigrationError("source_commit_invalid");
  }
  return normalized;
}

function validatedDigest(value: string, code: string): string {
  const normalized = value.trim();
  if (!DIGEST.test(normalized)) throw new D1AccountsMigrationError(code);
  return normalized;
}

function opaqueTargetPart(value: string, code: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(normalized)) {
    throw new D1AccountsMigrationError(code);
  }
  return normalized;
}

function validatedBookmark(value: string): string {
  if (value.length === 0 || value.length > 4_096 || /[\r\n]/u.test(value)) {
    throw new D1AccountsMigrationError("backup_bookmark_invalid");
  }
  return value;
}

function validatedTimestamp(value: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    new Date(value).toISOString() !== value
  ) {
    throw new D1AccountsMigrationError("backup_captured_at_invalid");
  }
  return value;
}
