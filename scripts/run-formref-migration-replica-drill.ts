#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  open,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import type { InstalledFormReference } from "takosumi-contract";
import type { ResourceFormPinBackupEntry } from "takosumi-contract/backups";

import { SigstoreTakoformPackageSignatureVerifier } from "../core/adapters/takoform/signature.ts";
import { TakoformDataOnlyPackageVerifier } from "../core/adapters/takoform/package_verifier.ts";
import { ActivityService } from "../core/domains/activity/mod.ts";
import {
  D1FormRegistryStore,
  FormRegistryService,
  type FormPackageArtifactReader,
} from "../core/domains/service-forms/mod.ts";
import {
  collectResourceFormPinBackupEntries,
  ResourceFormPinOperations,
} from "../core/domains/resource-shape/form_pin_operations.ts";
import { createD1ResourceShapeStores } from "../core/domains/resource-shape/d1_stores.ts";
import type { SpaceId } from "../core/shared/ids.ts";
import {
  applyControlD1Schema,
  buildControlD1SchemaPlan,
} from "../deploy/platform/control_d1_schema.ts";
import { CloudflareControlD1RestDatabase } from "../deploy/platform/control_d1_schema_rest.ts";
import { CloudflareD1OpenTofuControlStore } from "../worker/src/d1_opentofu_store.ts";
import {
  loadReviewedPublishedPackageInstallSet,
  type ReviewedPublishedPackageInstallArtifact,
  type ReviewedPublishedPackageInstallSet,
} from "./verify-takoform-published-package-host-proof.ts";

const EVIDENCE_KIND = "takosumi.formref-migration-replica-drill@v1";
const WORKSPACE_ID = "ws_formrefreplica" as SpaceId;
const RESOURCE_ID = "tkrn:ws_formrefreplica:ObjectBucket:legacy-object-bucket";
const ACTIVATION_ID = "activation_formrefreplica_objectbucket";
const ACTOR_ID = "operator:formref-replica-drill";
const DATABASE_NAME_PATTERN =
  /^takosumi-formref-(primary|restore)-[0-9]{8}-[a-z0-9]+$/u;

interface CliOptions {
  readonly sourceCommit: string;
  readonly accountId: string;
  readonly primaryDatabaseId: string;
  readonly primaryDatabaseName: string;
  readonly restoreDatabaseId: string;
  readonly restoreDatabaseName: string;
  readonly takoformRoot: string;
  readonly evidenceDirectory: string;
}

interface ReplicaContext {
  readonly database: CloudflareControlD1RestDatabase;
  readonly stores: ReturnType<typeof createD1ResourceShapeStores>;
  readonly forms: FormRegistryService;
  readonly operations: ResourceFormPinOperations;
  readonly ledger: CloudflareD1OpenTofuControlStore;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const apiToken = required(
    process.env.CLOUDFLARE_API_TOKEN,
    "CLOUDFLARE_API_TOKEN",
  );
  const evidenceDirectory = await verifyEvidenceDirectory(
    options.evidenceDirectory,
  );
  const takoformRoot = await realpath(options.takoformRoot);
  validateDatabaseNames(options);
  await verifySourceCheckout(options.sourceCommit);

  const plan = await buildControlD1SchemaPlan();
  const primaryDatabase = remoteDatabase(
    options.accountId,
    options.primaryDatabaseId,
    apiToken,
  );
  const restoreDatabase = remoteDatabase(
    options.accountId,
    options.restoreDatabaseId,
    apiToken,
  );
  await assertLegacyFixture(primaryDatabase, "primary");
  await assertLegacyFixture(restoreDatabase, "restore");
  const primaryMigration = await migrateReplica(
    primaryDatabase,
    options.primaryDatabaseId,
    options.sourceCommit,
    plan,
  );
  const restoreMigration = await migrateReplica(
    restoreDatabase,
    options.restoreDatabaseId,
    options.sourceCommit,
    plan,
  );

  await exportDatabase(
    options.primaryDatabaseName,
    evidenceDirectory,
    "primary-pre-backfill",
  );
  await exportDatabase(
    options.restoreDatabaseName,
    evidenceDirectory,
    "restore-pre-restore",
  );

  const reviewed = await loadReviewedPublishedPackageInstallSet(takoformRoot);
  const artifact = reviewed.packages.find(
    (entry) => entry.kind === "ObjectBucket",
  );
  if (!artifact) throw new Error("reviewed ObjectBucket package is missing");
  const primary = await createReplicaContext(
    primaryDatabase,
    reviewed,
    artifact,
  );
  const restore = await createReplicaContext(
    restoreDatabase,
    reviewed,
    artifact,
  );
  const identity: InstalledFormReference = {
    formRef: artifact.formRef,
    packageDigest: artifact.packageDigest,
  };

  const preBackfill = await collectResourceFormPinBackupEntries(
    primary.stores,
    WORKSPACE_ID,
  );
  assertReadySidecar(preBackfill, 0, "pre-backfill");
  const preBackfillSidecarPath = await writeEvidence(
    evidenceDirectory,
    "primary-pre-backfill-sidecar.json",
    preBackfill,
  );

  const missingActivation = await primary.operations.backfill({
    workspaceId: WORKSPACE_ID,
    spaceId: WORKSPACE_ID,
    kind: "ObjectBucket",
    activationIds: ["activation_missing"],
    actorId: ACTOR_ID,
  });
  assertReport(missingActivation, {
    scanned: 1,
    refused: 1,
    reason: "activation_missing",
  });
  await assertUnpinned(primary);

  const dryRun = await primary.operations.backfill({
    workspaceId: WORKSPACE_ID,
    spaceId: WORKSPACE_ID,
    kind: "ObjectBucket",
    activationIds: [ACTIVATION_ID],
    actorId: ACTOR_ID,
    dryRun: true,
  });
  assertReport(dryRun, { scanned: 1, wouldPin: 1, reason: "eligible" });
  await assertUnpinned(primary);

  const applied = await primary.operations.backfill({
    workspaceId: WORKSPACE_ID,
    spaceId: WORKSPACE_ID,
    kind: "ObjectBucket",
    activationIds: [ACTIVATION_ID],
    actorId: ACTOR_ID,
  });
  assertReport(applied, { scanned: 1, pinned: 1, reason: "eligible" });
  await assertPinned(primary, identity);

  const retry = await primary.operations.backfill({
    workspaceId: WORKSPACE_ID,
    spaceId: WORKSPACE_ID,
    kind: "ObjectBucket",
    activationIds: [ACTIVATION_ID],
    actorId: ACTOR_ID,
  });
  assertReport(retry, { scanned: 0 });
  await assertPartialPairRejected(primary);

  const postBackfill = await collectResourceFormPinBackupEntries(
    primary.stores,
    WORKSPACE_ID,
  );
  assertReadySidecar(postBackfill, 1, "post-backfill");
  const postBackfillSidecarPath = await writeEvidence(
    evidenceDirectory,
    "primary-post-backfill-sidecar.json",
    postBackfill,
  );
  await exportDatabase(
    options.primaryDatabaseName,
    evidenceDirectory,
    "primary-post-backfill",
  );

  const entry = postBackfill.entries[0]!;
  const wrongScope = await restore.operations.restore({
    workspaceId: WORKSPACE_ID,
    spaceId: WORKSPACE_ID,
    actorId: ACTOR_ID,
    entries: [{ ...entry, resourceScopeId: "ws_formrefreplica_other" }],
  });
  assertReport(wrongScope, {
    scanned: 1,
    refused: 1,
    reason: "backup_scope_mismatch",
  });
  const unverifiable = await restore.operations.restore({
    workspaceId: WORKSPACE_ID,
    spaceId: WORKSPACE_ID,
    actorId: ACTOR_ID,
    entries: [
      {
        ...entry,
        identity: {
          ...entry.identity,
          packageDigest: `sha256:${"0".repeat(64)}`,
        },
      },
    ],
  });
  assertReport(unverifiable, {
    scanned: 1,
    refused: 1,
    reason: "retained_package_unverifiable",
  });
  const missingPair = await restore.operations.restore({
    workspaceId: WORKSPACE_ID,
    spaceId: WORKSPACE_ID,
    actorId: ACTOR_ID,
    entries: [
      {
        ...entry,
        resourceId: "tkrn:ws_formrefreplica:ObjectBucket:missing",
      },
    ],
  });
  assertReport(missingPair, {
    scanned: 1,
    refused: 1,
    reason: "resolution_lock_missing",
  });
  await assertUnpinned(restore);

  const restored = await restore.operations.restore({
    workspaceId: WORKSPACE_ID,
    spaceId: WORKSPACE_ID,
    actorId: ACTOR_ID,
    entries: postBackfill.entries,
  });
  assertReport(restored, { scanned: 1, pinned: 1, reason: "eligible" });
  await assertPinned(restore, identity);
  const restoreRetry = await restore.operations.restore({
    workspaceId: WORKSPACE_ID,
    spaceId: WORKSPACE_ID,
    actorId: ACTOR_ID,
    entries: postBackfill.entries,
  });
  assertReport(restoreRetry, {
    scanned: 1,
    alreadyPinned: 1,
    reason: "eligible",
  });
  await assertPartialPairRejected(restore);

  const restoredSidecar = await collectResourceFormPinBackupEntries(
    restore.stores,
    WORKSPACE_ID,
  );
  assertReadySidecar(restoredSidecar, 1, "post-restore");
  if (stableJson(restoredSidecar) !== stableJson(postBackfill)) {
    throw new Error("restored exact identity sidecar differs from primary");
  }
  const postRestoreSidecarPath = await writeEvidence(
    evidenceDirectory,
    "restore-post-restore-sidecar.json",
    restoredSidecar,
  );
  await exportDatabase(
    options.restoreDatabaseName,
    evidenceDirectory,
    "restore-post-restore",
  );

  const primaryAudit = await countAudit(
    primary,
    "resource.form_pin.backfilled",
  );
  const restoreAudit = await countAudit(restore, "resource.form_pin.restored");
  if (primaryAudit !== 1 || restoreAudit !== 1) {
    throw new Error("idempotent Form pin audit count drifted");
  }

  const evidence = {
    kind: EVIDENCE_KIND,
    status: "passed",
    sourceCommit: options.sourceCommit,
    environment: "isolated-scratch",
    productionTouched: false,
    mainStagingTouched: false,
    schema: {
      manifestDigest: plan.manifestDigest,
      schemaDigest: plan.schemaDigest,
      ledgerDigest: plan.ledgerDigest,
      predecessorVersion: 44,
      successorVersion: plan.migrations.at(-1)?.version,
      primaryAppliedVersions: primaryMigration.appliedMigrationVersions,
      restoreAppliedVersions: restoreMigration.appliedMigrationVersions,
    },
    legacyFixture: {
      primary: "v44-exact-marker-verified",
      restore: "v44-exact-marker-verified",
    },
    databases: {
      primaryFingerprint: sha256(options.primaryDatabaseId),
      restoreFingerprint: sha256(options.restoreDatabaseId),
    },
    package: {
      takoformCheckoutCommit: reviewed.checkoutCommit,
      releaseCommit: reviewed.releaseCommit,
      releaseTag: artifact.releaseTag,
      formRef: artifact.formRef,
      packageDigest: artifact.packageDigest,
      verifierId: reviewed.verifierId,
      activationId: ACTIVATION_ID,
    },
    primary: {
      preBackfillEntries: preBackfill.entries.length,
      missingActivation,
      dryRun,
      applied,
      retry,
      partialPairRejected: true,
      auditCount: primaryAudit,
      postBackfillEntries: postBackfill.entries.length,
    },
    restore: {
      wrongScope,
      unverifiable,
      missingPair,
      restored,
      retry: restoreRetry,
      partialPairRejected: true,
      auditCount: restoreAudit,
      postRestoreEntries: restoredSidecar.entries.length,
    },
    artifacts: {
      preBackfillSidecarSha256: await sha256File(preBackfillSidecarPath),
      postBackfillSidecarSha256: await sha256File(postBackfillSidecarPath),
      postRestoreSidecarSha256: await sha256File(postRestoreSidecarPath),
    },
  } as const;
  await writeEvidence(
    evidenceDirectory,
    "formref-migration-replica-drill.json",
    evidence,
  );
  console.log(
    JSON.stringify({
      kind: evidence.kind,
      status: evidence.status,
      successorVersion: evidence.schema.successorVersion,
      primaryAppliedVersions: evidence.schema.primaryAppliedVersions,
      restoreAppliedVersions: evidence.schema.restoreAppliedVersions,
      primary: {
        dryRun: evidence.primary.dryRun.wouldPin,
        pinned: evidence.primary.applied.pinned,
        idempotentRetryScanned: evidence.primary.retry.scanned,
        refusals: evidence.primary.missingActivation.refused,
      },
      restore: {
        pinned: evidence.restore.restored.pinned,
        alreadyPinned: evidence.restore.retry.alreadyPinned,
        refusals:
          evidence.restore.wrongScope.refused +
          evidence.restore.unverifiable.refused +
          evidence.restore.missingPair.refused,
      },
    }),
  );
}

async function migrateReplica(
  database: CloudflareControlD1RestDatabase,
  databaseId: string,
  sourceCommit: string,
  plan: Awaited<ReturnType<typeof buildControlD1SchemaPlan>>,
) {
  const now = new Date().toISOString();
  const result = await applyControlD1Schema(database, plan, {
    sourceCommit,
    environment: "test",
    activatedAt: now,
    releasedAt: () => new Date().toISOString(),
    maintenanceDrainMilliseconds: 0,
    waitForRequestDrain: async () => undefined,
    databaseRole: "in_place",
    releasePolicy: "in_place",
    databaseId,
  });
  if (
    result.verification.status !== "ready" ||
    result.maintenanceStatus !== "released"
  ) {
    throw new Error("scratch replica schema migration did not finish ready");
  }
  return result;
}

async function assertLegacyFixture(
  database: CloudflareControlD1RestDatabase,
  label: "primary" | "restore",
): Promise<void> {
  const [version, resourceCount, lockCount, resource, lock] = await Promise.all(
    [
      database
        .prepare("select max(version) as version from schema_migrations")
        .first<{ readonly version: number }>(),
      database
        .prepare("select count(*) as count from resource_shapes")
        .first<{ readonly count: number }>(),
      database
        .prepare("select count(*) as count from resolution_locks")
        .first<{ readonly count: number }>(),
      database
        .prepare(
          "select id, space_id, kind, name, spec_json, outputs_json from resource_shapes where id = ? limit 1",
        )
        .bind(RESOURCE_ID)
        .first<{
          readonly id: string;
          readonly space_id: string;
          readonly kind: string;
          readonly name: string;
          readonly spec_json: string;
          readonly outputs_json: string;
        }>(),
      database
        .prepare(
          "select resource_id, selected_implementation, target, reason_json from resolution_locks where resource_id = ? limit 1",
        )
        .bind(RESOURCE_ID)
        .first<{
          readonly resource_id: string;
          readonly selected_implementation: string;
          readonly target: string;
          readonly reason_json: string;
        }>(),
    ],
  );
  if (
    version?.version !== 44 ||
    resourceCount?.count !== 1 ||
    lockCount?.count !== 1 ||
    resource?.id !== RESOURCE_ID ||
    resource.space_id !== WORKSPACE_ID ||
    resource.kind !== "ObjectBucket" ||
    resource.name !== "legacy-object-bucket" ||
    stableJson(JSON.parse(resource.spec_json)) !==
      stableJson({ storageClass: "standard" }) ||
    stableJson(JSON.parse(resource.outputs_json)) !==
      stableJson({ fixture: "redacted-non-secret" }) ||
    lock?.resource_id !== RESOURCE_ID ||
    lock.selected_implementation !== "fixture-object-store" ||
    lock.target !== "fixture-target" ||
    stableJson(JSON.parse(lock.reason_json)) !==
      stableJson(["reviewed-pre-formref-replica-fixture"])
  ) {
    throw new Error(`${label} database is not the exact reviewed v44 fixture`);
  }
  for (const table of ["resource_shapes", "resolution_locks"]) {
    const columns = await database
      .prepare(`pragma table_info(${table})`)
      .all<{ readonly name: string }>();
    const names = new Set((columns.results ?? []).map(({ name }) => name));
    if (names.has("form_ref_json") || names.has("package_digest")) {
      throw new Error(
        `${label} fixture already has exact Form identity columns`,
      );
    }
  }
}

async function createReplicaContext(
  database: CloudflareControlD1RestDatabase,
  reviewed: ReviewedPublishedPackageInstallSet,
  artifact: ReviewedPublishedPackageInstallArtifact,
): Promise<ReplicaContext> {
  const artifactRef = `replica:takoform/${artifact.kind}/${artifact.releaseTag}/${artifact.packageDigest}`;
  const reader: FormPackageArtifactReader = {
    read: async (requested) => {
      if (requested !== artifactRef) {
        throw new Error("replica artifact reference is not retained");
      }
      return artifact.envelopeBytes;
    },
  };
  const verifier = new TakoformDataOnlyPackageVerifier(
    new SigstoreTakoformPackageSignatureVerifier({
      trustedRootDigest: reviewed.trustedRoot.digest as `sha256:${string}`,
      loadTrustedRoot: async () => reviewed.trustedRoot.bytes,
      publishers: [reviewed.publisher],
    }),
  );
  const forms = new FormRegistryService({
    store: new D1FormRegistryStore(database),
    artifactReader: reader,
    verifier,
  });
  await forms.installPackage({
    artifactRef,
    expectedPackageDigest: artifact.packageDigest,
    actorId: ACTOR_ID,
  });
  await forms.createActivation({
    id: ACTIVATION_ID,
    identity: {
      formRef: artifact.formRef,
      packageDigest: artifact.packageDigest,
    },
    scope: { type: "workspace", id: WORKSPACE_ID },
    status: "active",
    actorId: ACTOR_ID,
  });
  const stores = createD1ResourceShapeStores(database);
  const ledger = new CloudflareD1OpenTofuControlStore(database, {
    schemaMode: "predeployed",
  });
  const activity = new ActivityService({ store: ledger });
  return {
    database,
    stores,
    forms,
    operations: new ResourceFormPinOperations({ stores, forms, activity }),
    ledger,
  };
}

async function assertUnpinned(context: ReplicaContext): Promise<void> {
  const [resource, lock] = await Promise.all([
    context.stores.resources.get(RESOURCE_ID),
    context.stores.locks.get(RESOURCE_ID),
  ]);
  if (
    !resource ||
    !lock ||
    resource.form !== undefined ||
    lock.form !== undefined
  ) {
    throw new Error("legacy Resource/ResolutionLock pair is not unpinned");
  }
}

async function assertPinned(
  context: ReplicaContext,
  identity: InstalledFormReference,
): Promise<void> {
  const [resource, lock] = await Promise.all([
    context.stores.resources.get(RESOURCE_ID),
    context.stores.locks.get(RESOURCE_ID),
  ]);
  if (
    !resource ||
    !lock ||
    stableJson(resource.form) !== stableJson(identity) ||
    stableJson(lock.form) !== stableJson(identity)
  ) {
    throw new Error("exact Form identity is not coherent on Resource and lock");
  }
}

async function assertPartialPairRejected(
  context: ReplicaContext,
): Promise<void> {
  let rejected = false;
  try {
    await context.database
      .prepare("update resource_shapes set package_digest = null where id = ?")
      .bind(RESOURCE_ID)
      .run();
  } catch {
    rejected = true;
  }
  if (!rejected)
    throw new Error("D1 accepted a partial exact Form identity pair");
}

async function countAudit(
  context: ReplicaContext,
  action: string,
): Promise<number> {
  const row = await context.database
    .prepare(
      "select count(*) as count from audit_events where space_id = ? and action = ?",
    )
    .bind(WORKSPACE_ID, action)
    .first<{ readonly count: number }>();
  return row?.count ?? 0;
}

function assertReadySidecar(
  value:
    | {
        readonly status: "ready";
        readonly entries: readonly ResourceFormPinBackupEntry[];
      }
    | { readonly status: "incoherent"; readonly resourceId: string },
  expected: number,
  phase: string,
): asserts value is {
  readonly status: "ready";
  readonly entries: readonly ResourceFormPinBackupEntry[];
} {
  if (value.status !== "ready" || value.entries.length !== expected) {
    throw new Error(
      `${phase} sidecar is not coherent with ${expected} entries`,
    );
  }
}

function assertReport(
  report: {
    readonly scanned: number;
    readonly wouldPin: number;
    readonly pinned: number;
    readonly alreadyPinned: number;
    readonly refused: number;
    readonly evidence: readonly { readonly reason: string }[];
  },
  expected: {
    readonly scanned: number;
    readonly wouldPin?: number;
    readonly pinned?: number;
    readonly alreadyPinned?: number;
    readonly refused?: number;
    readonly reason?: string;
  },
): void {
  for (const key of [
    "scanned",
    "wouldPin",
    "pinned",
    "alreadyPinned",
    "refused",
  ] as const) {
    const expectedValue = expected[key];
    if (expectedValue !== undefined && report[key] !== expectedValue) {
      throw new Error(`operation report ${key} drifted`);
    }
  }
  if (
    expected.reason !== undefined &&
    report.evidence.some((entry) => entry.reason !== expected.reason)
  ) {
    throw new Error("operation evidence reason drifted");
  }
}

function remoteDatabase(
  accountId: string,
  databaseId: string,
  apiToken: string,
): CloudflareControlD1RestDatabase {
  return new CloudflareControlD1RestDatabase({
    accountId,
    databaseId,
    apiToken,
  });
}

async function exportDatabase(
  databaseName: string,
  evidenceDirectory: string,
  label: string,
): Promise<void> {
  const output = `${evidenceDirectory}/${label}.sql`;
  await assertMissing(output);
  const child = Bun.spawn(
    [
      "bunx",
      "wrangler",
      "d1",
      "export",
      databaseName,
      "--remote",
      "--output",
      output,
      "--skip-confirmation",
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`scratch D1 export failed for ${label}`);
  await chmod(output, 0o600);
  await writeEvidence(evidenceDirectory, `${label}-export.txt`, {
    status: "exported",
    stdout,
    stderr,
    sqlSha256: await sha256File(output),
  });
}

async function writeEvidence(
  directory: string,
  name: string,
  value: unknown,
): Promise<string> {
  if (!/^[a-z0-9][a-z0-9.-]*$/u.test(name)) {
    throw new Error("invalid evidence filename");
  }
  const path = `${directory}/${name}`;
  const handle = await open(path, "wx", 0o600);
  await handle.close();
  const text =
    typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(path, text, { flag: "r+", mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

async function verifyEvidenceDirectory(input: string): Promise<string> {
  if (!isAbsolute(input))
    throw new Error("evidence directory must be absolute");
  const directory = await realpath(input);
  const stat = await lstat(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) {
    throw new Error("evidence directory must exist with mode 0700");
  }
  return directory;
}

async function assertMissing(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error("output path must be absolute");
  await lstat(path).then(
    () => {
      throw new Error(`refusing to overwrite ${path}`);
    },
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    },
  );
  const parent = await realpath(dirname(path));
  if (parent !== dirname(path))
    throw new Error("output parent must be canonical");
}

function validateDatabaseNames(options: CliOptions): void {
  if (
    !DATABASE_NAME_PATTERN.test(options.primaryDatabaseName) ||
    !DATABASE_NAME_PATTERN.test(options.restoreDatabaseName) ||
    !options.primaryDatabaseName.includes("-primary-") ||
    !options.restoreDatabaseName.includes("-restore-") ||
    options.primaryDatabaseName === options.restoreDatabaseName ||
    options.primaryDatabaseId === options.restoreDatabaseId
  ) {
    throw new Error(
      "only two distinct, purpose-named scratch replicas are allowed",
    );
  }
}

async function verifySourceCheckout(expectedCommit: string): Promise<void> {
  if (!/^[0-9a-f]{40}$/u.test(expectedCommit)) {
    throw new Error("source commit must be an exact lowercase Git SHA");
  }
  const root = fileURLToPath(new URL("../", import.meta.url));
  const [head, status] = await Promise.all([
    git(root, ["rev-parse", "HEAD"]),
    git(root, ["status", "--short", "--untracked-files=all"]),
  ]);
  if (head.trim() !== expectedCommit) {
    throw new Error("source commit does not match the drill checkout HEAD");
  }
  if (status.trim() !== "") {
    throw new Error("FormRef replica drill requires a clean source checkout");
  }
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", cwd, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, code] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error("source checkout verification failed");
  return stdout;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(help());
    }
    if (values.has(key)) throw new Error(help());
    values.set(key, value);
  }
  const requiredKeys = [
    "--source-commit",
    "--account-id",
    "--primary-database-id",
    "--primary-database-name",
    "--restore-database-id",
    "--restore-database-name",
    "--takoform-root",
    "--evidence-directory",
  ] as const;
  if (
    values.size !== requiredKeys.length ||
    requiredKeys.some((key) => !values.get(key))
  ) {
    throw new Error(help());
  }
  return {
    sourceCommit: values.get("--source-commit")!,
    accountId: values.get("--account-id")!,
    primaryDatabaseId: values.get("--primary-database-id")!,
    primaryDatabaseName: values.get("--primary-database-name")!,
    restoreDatabaseId: values.get("--restore-database-id")!,
    restoreDatabaseName: values.get("--restore-database-name")!,
    takoformRoot: values.get("--takoform-root")!,
    evidenceDirectory: values.get("--evidence-directory")!,
  };
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256File(path: string): Promise<string> {
  return sha256(await readFile(path));
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function help(): string {
  return "usage: run-formref-migration-replica-drill.ts --source-commit <clean-exact-head> --account-id <scratch-account> --primary-database-id <scratch-id> --primary-database-name <scratch-name> --restore-database-id <scratch-id> --restore-database-name <scratch-name> --takoform-root <clean-reviewed-checkout> --evidence-directory <absolute-0700-directory>";
}

if (import.meta.main) {
  await main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "replica drill failed",
    );
    process.exitCode = 1;
  });
}
