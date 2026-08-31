import { afterAll, afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  applyControlD1Schema,
  buildControlD1SchemaPlan,
  readControlD1MaintenanceState,
  readControlD1MigrationLedger,
  SqliteControlD1Database,
  verifyControlD1Schema,
} from "../../deploy/platform/control_d1_schema.ts";
import {
  inspectControlD1BridgeSourceCompatibility,
  runControlD1ServingCompatibilityProof,
  runControlD1SchemaRelease as runReleaseSurface,
  type ControlD1SchemaReleaseDependencies,
} from "../../scripts/control-d1-schema-release.ts";
import {
  appendPlatformMutationFence,
  appendPlatformRestoreFence,
  assertPlatformRestoreNotRetired,
  platformRestoreCheckpointPath,
  platformRestoreLockPath,
  platformRestoreRetirementPath,
  platformTargetMutationLockPath,
  platformTargetMutationAuthorityDirectoryIdentityDigest,
  withPlatformTargetMutationLock,
  readPlatformRestoreFence,
  withPlatformRestoreLock,
} from "../../scripts/platform-worker-release.ts";
import { ensureD1OpenTofuLedgerSchema } from "../../worker/src/d1_opentofu_store.ts";
import { releaseControlD1MaintenanceFence } from "../../worker/src/d1_schema_maintenance.ts";

const COMMIT = "a".repeat(40);
const ACCOUNT_ID = "account_123";
const DATABASE_ID = "database_456";
const TOKEN = "api-token-must-never-be-recorded";
const PRODUCTION_ACCOUNT_ID = "account_production_789";
const PRODUCTION_DATABASE_ID = "database_production_987";
const PRODUCTION_TOKEN = "production-api-token-must-never-be-recorded";
const VERSION_ID = "11111111-1111-4111-8111-111111111111";
const DRIFTED_VERSION_ID = "33333333-3333-4333-8333-333333333333";
const BOOKMARK = "opaque-time-travel-bookmark";
const CLOSURE_COMMIT_ONE = "b".repeat(40);
const CLOSURE_COMMIT_TWO = "c".repeat(40);
const BRIDGE_COMMIT = "d".repeat(40);

interface BridgeProofArtifactFixture {
  readonly bridgePlanPath: string;
  readonly bridgePlanConfirmation: string;
  readonly bridgeReleaseEvidencePath: string;
  readonly bridgeSourceCompatibility: {
    readonly predecessorPlatformPlanPath: string;
    readonly predecessorPlatformPlanConfirmation: string;
    readonly predecessorPlatformReleaseEvidencePath: string;
    readonly compatibilityClosureDigest: string;
    readonly reviewer: string;
  };
}

function predecessorProofArguments(
  fixture: BridgeProofArtifactFixture,
): readonly string[] {
  return [
    "--predecessor-plan",
    fixture.bridgeSourceCompatibility.predecessorPlatformPlanPath,
    "--predecessor-confirm",
    fixture.bridgeSourceCompatibility.predecessorPlatformPlanConfirmation,
    "--predecessor-evidence",
    fixture.bridgeSourceCompatibility.predecessorPlatformReleaseEvidencePath,
    "--confirm-closure",
    fixture.bridgeSourceCompatibility.compatibilityClosureDigest,
    "--review",
    fixture.bridgeSourceCompatibility.reviewer,
  ];
}
const roots: string[] = [];
const AUTHORITY_DIRECTORY = mkdtempSync(
  join(homedir(), ".takosumi-schema-authority-test-"),
);
chmodSync(AUTHORITY_DIRECTORY, 0o700);

afterAll(() => {
  rmSync(AUTHORITY_DIRECTORY, { recursive: true, force: true });
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function privateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "takosumi-schema-release-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function withInterceptedGit<T>(
  mode: "passthrough" | "replace" | "graft",
  operation: () => T,
): T {
  const root = privateRoot();
  const executable = join(root, "git");
  const graftPath = join(root, "substituted-grafts");
  const realGit = Bun.which("git");
  if (realGit === null) throw new Error("test_git_missing");
  if (mode === "graft") {
    writeFileSync(graftPath, `${"e".repeat(40)} ${"f".repeat(40)}\n`, {
      mode: 0o600,
    });
  }
  writeFileSync(
    executable,
    `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args[0] !== "--no-replace-objects") process.exit(91);
if (${JSON.stringify(mode)} === "replace" && args[1] === "for-each-ref") {
  process.stdout.write("refs/replace/${"a".repeat(40)}\\n");
  process.exit(0);
}
if (
  ${JSON.stringify(mode)} === "graft" &&
  args[1] === "rev-parse" &&
  args.at(-1) === "info/grafts"
) {
  process.stdout.write(${JSON.stringify(`${graftPath}\n`)});
  process.exit(0);
}
const result = Bun.spawnSync([${JSON.stringify(realGit)}, ...args], {
  stdin: "ignore",
  stdout: "pipe",
  stderr: "pipe",
});
if (result.stdout.byteLength > 0) process.stdout.write(result.stdout);
if (result.stderr.byteLength > 0) process.stderr.write(result.stderr);
process.exit(result.exitCode ?? 1);
`,
    { mode: 0o700 },
  );
  chmodSync(executable, 0o700);
  const previousPath = process.env.PATH;
  process.env.PATH = `${root}:${previousPath ?? ""}`;
  try {
    return operation();
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
}

async function subprocessExitWithin(
  child: { readonly exited: Promise<number>; kill(signal?: number): void },
  timeoutMs: number,
): Promise<number> {
  const timeout = Symbol("subprocess-timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    child.exited,
    new Promise<typeof timeout>((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout(timeout), timeoutMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (result !== timeout) return result;
  child.kill(9);
  await child.exited;
  throw new Error("test_subprocess_exit_timeout");
}

async function predecessorDatabase(): Promise<SqliteControlD1Database> {
  const database = new SqliteControlD1Database();
  await ensureD1OpenTofuLedgerSchema(database, {
    throughMigrationVersion: 66,
  });
  return database;
}

function environment(
  releaseEnvironment: "staging" | "production" = "staging",
): Record<string, string> {
  const prefix = `TAKOSUMI_CONTROL_D1_${releaseEnvironment.toUpperCase()}`;
  const target =
    releaseEnvironment === "staging"
      ? { accountId: ACCOUNT_ID, databaseId: DATABASE_ID, apiToken: TOKEN }
      : {
          accountId: PRODUCTION_ACCOUNT_ID,
          databaseId: PRODUCTION_DATABASE_ID,
          apiToken: PRODUCTION_TOKEN,
        };
  return {
    TAKOSUMI_PLATFORM_MUTATION_AUTHORITY_DIR: AUTHORITY_DIRECTORY,
    [`${prefix}_CLOUDFLARE_ACCOUNT_ID`]: target.accountId,
    [`${prefix}_DATABASE_ID`]: target.databaseId,
    [`${prefix}_CLOUDFLARE_API_TOKEN`]: target.apiToken,
  };
}

function digestJson(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function inspectBridgeSourceCompatibility(
  predecessorSourceCommit: string,
  bridgeSourceCommit: string,
  reviewer: string,
) {
  const commits = [
    {
      sourceCommit: CLOSURE_COMMIT_ONE,
      parentSourceCommit: predecessorSourceCommit,
      treeObjectId: "1".repeat(40),
      canonicalPatchDigest: digestJson({
        parentSourceCommit: predecessorSourceCommit,
        sourceCommit: CLOSURE_COMMIT_ONE,
        patch: "lifecycle",
      }),
      changedPaths: ["core/domains/deploy-control/store.ts"],
    },
    {
      sourceCommit: CLOSURE_COMMIT_TWO,
      parentSourceCommit: CLOSURE_COMMIT_ONE,
      treeObjectId: "2".repeat(40),
      canonicalPatchDigest: digestJson({
        parentSourceCommit: CLOSURE_COMMIT_ONE,
        sourceCommit: CLOSURE_COMMIT_TWO,
        patch: "release",
      }),
      changedPaths: ["scripts/platform-worker-release.ts"],
    },
    {
      sourceCommit: bridgeSourceCommit,
      parentSourceCommit: CLOSURE_COMMIT_TWO,
      treeObjectId: "3".repeat(40),
      canonicalPatchDigest: digestJson({
        parentSourceCommit: CLOSURE_COMMIT_TWO,
        sourceCommit: bridgeSourceCommit,
        patch: "bridge",
      }),
      changedPaths: [
        "scripts/control-d1-schema-release.ts",
        "worker/src/d1_opentofu_store.ts",
      ],
    },
  ] as const;
  const identity = {
    kind: "takosumi.control-d1-bridge-source-compatibility@v2" as const,
    predecessorSourceCommit,
    predecessorTreeObjectId: "0".repeat(40),
    bridgeSourceCommit,
    commits,
    reviewer,
  };
  return {
    ...identity,
    compatibilityClosureDigest: digestJson(identity),
  };
}

function writeStartedMutationCheckpoint(
  path: string,
  planConfirmation: string,
  bridgeSourceCompatibilityDigest: string,
  recordedAt = "2026-08-30T12:00:00.000Z",
  predecessorChallengeEvidenceDigest = digestJson({
    test: "predecessor-challenge",
  }),
): string {
  const serialized = `${JSON.stringify({
    kind: "takosumi.control-d1-schema-mutation-checkpoint@v3",
    outcome: "unknown",
    planConfirmation,
    bridgeSourceCompatibilityDigest,
    predecessorChallengeEvidenceDigest,
    recordedAt,
  })}\n`;
  writeFileSync(path, serialized, { flag: "wx", mode: 0o600 });
  const startedDigest = `sha256:${createHash("sha256")
    .update(serialized)
    .digest("hex")}`;
  return digestJson({
    kind: "takosumi.control-d1-schema-release-readiness@v1",
    planConfirmation,
    bridgeSourceCompatibilityDigest,
    mutationCheckpointStartedDigest: startedDigest,
  });
}

function competingPlatformTargetRequest(root: string, label: string) {
  const checkpointPath = join(root, `${label}.checkpoint.jsonl`);
  return {
    operationKind: "platform-forward" as const,
    planConfirmation: digestJson({ kind: "competing-platform-plan", label }),
    checkpointPath,
    mode: "execute" as const,
  };
}

function cleanupRetainedStagingTargetLock(): void {
  rmSync(
    platformTargetMutationLockPath({
      environment: "staging",
      workerName: "takosumi-staging",
      authorityDirectory: AUTHORITY_DIRECTORY,
    }),
    { force: true },
  );
}

async function servingCompatibilityProof(
  root: string,
  releaseEnvironment: "staging" | "production" = "staging",
  options: Readonly<{
    platformPlanShape?: "full" | "synthetic";
    platformPlanEnvironment?: "staging" | "production";
    platformPlanSourceCommit?: string;
    accountId?: string;
    databaseId?: string;
  }> = {},
): Promise<string> {
  const [candidate, predecessor] = await Promise.all([
    buildControlD1SchemaPlan(),
    buildControlD1SchemaPlan({ throughMigrationVersion: 66 }),
  ]);
  const workerName =
    releaseEnvironment === "staging" ? "takosumi-staging" : "takosumi";
  const predecessorPlanPath = join(
    root,
    `${releaseEnvironment}-predecessor-platform-plan.json`,
  );
  const predecessorCheckpointPath = join(
    root,
    `${releaseEnvironment}-predecessor-platform-checkpoint.jsonl`,
  );
  const predecessorPlanConfirmation = writeBridgePlatformPlan(
    predecessorPlanPath,
    predecessorCheckpointPath,
    { environment: releaseEnvironment, sourceCommit: COMMIT },
  );
  appendPlatformMutationFence(
    predecessorPlanPath,
    predecessorPlanConfirmation,
    { outcome: "unknown", versionId: null },
    "2026-08-30T11:20:00.000Z",
  );
  appendPlatformMutationFence(
    predecessorPlanPath,
    predecessorPlanConfirmation,
    { outcome: "accepted", versionId: DRIFTED_VERSION_ID },
    "2026-08-30T11:21:00.000Z",
  );
  const predecessorReleaseEvidencePath = join(
    root,
    `${releaseEnvironment}-predecessor-platform-evidence.json`,
  );
  writeBridgePlatformReadyEvidence(
    predecessorPlanPath,
    predecessorReleaseEvidencePath,
    DRIFTED_VERSION_ID,
    "2026-08-30T11:22:00.000Z",
  );
  const bridgePlanPath = join(root, `${releaseEnvironment}-bridge-plan.json`);
  const bridgeCheckpointPath = join(
    root,
    `${releaseEnvironment}-bridge-checkpoint.jsonl`,
  );
  const bridgePlanConfirmation =
    options.platformPlanShape === "synthetic"
      ? digestJson({ bridge: "plan" })
      : writeBridgePlatformPlan(bridgePlanPath, bridgeCheckpointPath, {
          environment: options.platformPlanEnvironment ?? releaseEnvironment,
          sourceCommit: options.platformPlanSourceCommit ?? BRIDGE_COMMIT,
        });
  if (options.platformPlanShape === "synthetic") {
    writeFileSync(
      bridgePlanPath,
      `${JSON.stringify({
        confirmation: bridgePlanConfirmation,
        checkpointPath: bridgeCheckpointPath,
      })}\n`,
      { flag: "wx", mode: 0o600 },
    );
  }
  appendPlatformMutationFence(
    bridgePlanPath,
    bridgePlanConfirmation,
    { outcome: "unknown", versionId: null },
    "2026-08-30T11:50:00.000Z",
  );
  appendPlatformMutationFence(
    bridgePlanPath,
    bridgePlanConfirmation,
    { outcome: "accepted", versionId: VERSION_ID },
    "2026-08-30T11:51:00.000Z",
  );
  const bridgeReleaseEvidencePath = join(
    root,
    `${releaseEnvironment}-bridge-release-evidence.json`,
  );
  if (options.platformPlanShape === "synthetic") {
    writeFileSync(bridgeReleaseEvidencePath, '{"status":"synthetic"}\n', {
      flag: "wx",
      mode: 0o600,
    });
  } else {
    writeBridgePlatformReadyEvidence(
      bridgePlanPath,
      bridgeReleaseEvidencePath,
      VERSION_ID,
    );
  }
  const targetDigest = digestJson({
    environment: releaseEnvironment,
    accountId:
      options.accountId ??
      (releaseEnvironment === "staging" ? ACCOUNT_ID : PRODUCTION_ACCOUNT_ID),
    databaseId:
      options.databaseId ??
      (releaseEnvironment === "staging" ? DATABASE_ID : PRODUCTION_DATABASE_ID),
    workerName,
    bindingName: "TAKOSUMI_CONTROL_DB",
    servingVersionId: VERSION_ID,
  });
  const allowset = [
    { migrationVersion: 66, ledgerDigest: predecessor.ledgerDigest },
    { migrationVersion: 67, ledgerDigest: candidate.ledgerDigest },
  ] as const;
  const challengeResponse = {
    kind: "takosumi.control-d1-schema-compatibility-challenge@v1" as const,
    status: "ready" as const,
    nonce: "d".repeat(64),
    environment: releaseEnvironment,
    workerVersionId: VERSION_ID,
    bindingName: "TAKOSUMI_CONTROL_DB" as const,
    schemaMode: "predeployed-bridge" as const,
    ledger: predecessor.migrations,
    accepted: allowset[0],
    allowset,
  };
  const sourceCompatibility = {
    ...inspectBridgeSourceCompatibility(
      COMMIT,
      BRIDGE_COMMIT,
      "operator:bridge-reviewer@example.com",
    ),
    predecessorServingVersionId: DRIFTED_VERSION_ID,
    predecessorPlatformPlanPath: predecessorPlanPath,
    predecessorPlatformPlanConfirmation: predecessorPlanConfirmation,
    predecessorPlatformReleaseEvidencePath: predecessorReleaseEvidencePath,
    predecessorPlatformReleaseEvidenceDigest: `sha256:${createHash("sha256")
      .update(readFileSync(predecessorReleaseEvidencePath))
      .digest("hex")}`,
  };
  const identity = {
    kind: "takosumi.control-d1-serving-compatibility-proof@v3" as const,
    status: "ready" as const,
    completedAt: "2026-08-30T11:55:00.000Z",
    environment: releaseEnvironment,
    bridgeSourceCommit: BRIDGE_COMMIT,
    bridgePlanPath,
    bridgePlanConfirmation,
    bridgeReleaseEvidencePath,
    bridgeReleaseEvidenceDigest: `sha256:${createHash("sha256")
      .update(readFileSync(bridgeReleaseEvidencePath))
      .digest("hex")}`,
    bridgePlanDigest: `sha256:${createHash("sha256")
      .update(readFileSync(bridgePlanPath))
      .digest("hex")}`,
    bridgeSourceCompatibility: sourceCompatibility,
    bridgeSourceCompatibilityDigest: digestJson(sourceCompatibility),
    workerName,
    bindingName: "TAKOSUMI_CONTROL_DB" as const,
    servingVersionId: VERSION_ID,
    targetDigest,
    schemaMode: "predeployed-bridge" as const,
    compatibilityCatalogDigest: digestJson({
      kind: "takosumi.control-d1-schema-compatibility-catalog@v1",
      allowset,
    }),
    predecessorChallenge: {
      kind: "takosumi.control-d1-schema-compatibility-challenge-evidence@v1",
      observedAt: "2026-08-30T11:54:00.000Z",
      responseDigest: digestJson(challengeResponse),
      response: challengeResponse,
    },
    predecessor: {
      migrationVersion: 66 as const,
      ledgerDigest: predecessor.ledgerDigest,
      status: "ready" as const,
    },
    candidate: {
      migrationVersion: 67 as const,
      ledgerDigest: candidate.ledgerDigest,
      status: "ready" as const,
    },
    reviewer: "operator:bridge-reviewer@example.com",
  };
  const proof = { ...identity, confirmation: digestJson(identity) };
  const path = join(root, `${releaseEnvironment}-serving-proof.json`);
  if (
    options.platformPlanShape !== "synthetic" &&
    (options.platformPlanEnvironment ?? releaseEnvironment) ===
      releaseEnvironment &&
    (options.platformPlanSourceCommit ?? BRIDGE_COMMIT) === BRIDGE_COMMIT
  ) {
    const proofEnvironment = {
      ...environment(releaseEnvironment),
      ...(options.accountId
        ? {
            [`TAKOSUMI_CONTROL_D1_${releaseEnvironment.toUpperCase()}_CLOUDFLARE_ACCOUNT_ID`]:
              options.accountId,
          }
        : {}),
      ...(options.databaseId
        ? {
            [`TAKOSUMI_CONTROL_D1_${releaseEnvironment.toUpperCase()}_DATABASE_ID`]:
              options.databaseId,
          }
        : {}),
    };
    await runControlD1ServingCompatibilityProof(
      [
        "create",
        "--predecessor-plan",
        predecessorPlanPath,
        "--predecessor-confirm",
        predecessorPlanConfirmation,
        "--predecessor-evidence",
        predecessorReleaseEvidencePath,
        "--bridge-plan",
        bridgePlanPath,
        "--confirm",
        bridgePlanConfirmation,
        "--bridge-evidence",
        bridgeReleaseEvidencePath,
        "--confirm-closure",
        sourceCompatibility.compatibilityClosureDigest,
        "--review",
        sourceCompatibility.reviewer,
        "--proof-out",
        path,
      ],
      releaseEnvironment,
      {
        env: proofEnvironment,
        fetch: workerFetch(
          [],
          () => VERSION_ID,
          () =>
            options.databaseId ??
            (releaseEnvironment === "staging"
              ? DATABASE_ID
              : PRODUCTION_DATABASE_ID),
        ),
        now: () => "2026-08-30T11:55:00.000Z",
        inspectBridgeSourceCompatibility,
        write: () => {},
      },
    );
    return path;
  }
  writeFileSync(path, `${JSON.stringify(proof, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return path;
}

function writeBridgePlatformReadyEvidence(
  planPath: string,
  evidencePath: string,
  deployedVersionId: string,
  completedAt = "2026-08-30T11:52:00.000Z",
): void {
  const plan = JSON.parse(readFileSync(planPath, "utf8")) as Record<
    string,
    unknown
  >;
  const predecessorContainer = plan.predecessorContainer;
  const environment = plan.environment as "staging" | "production";
  const evidence = {
    kind: "takosumi.platform-worker-release-evidence@v2",
    status: "ready",
    completedAt,
    environment,
    sourceCommit: plan.sourceCommit,
    configPath: plan.configPath,
    configSha256: plan.configSha256,
    sealedConfigSha256: plan.sealedConfigSha256,
    closureSha256: (plan.closure as { readonly digest: string }).digest,
    dashboardAssetsSha256: (
      plan.dashboardAssets as { readonly digest: string }
    ).digest,
    dryRunSha256: (plan.dryRun as { readonly digest: string }).digest,
    secretNamesSha256: plan.secretNamesSha256,
    predecessorVersionId: plan.predecessorVersionId,
    predecessorContainer,
    deployedVersionId,
    deployedContainer: predecessorContainer,
    releaseTag: plan.releaseTag,
    planConfirmation: plan.confirmation,
    reviewer: "operator:bridge-reviewer@example.com",
    lostAcknowledgement: false,
    reversal: {
      surface:
        environment === "staging"
          ? "takosumi-platform-staging"
          : "takosumi-platform",
      action: "restore",
      planConfirmation: plan.confirmation,
      predecessorVersionId: plan.predecessorVersionId,
      predecessorContainer,
    },
  };
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}

function writeBridgePlatformPlan(
  path: string,
  checkpointPath: string,
  input: Readonly<{
    environment: "staging" | "production";
    sourceCommit: string;
  }>,
): string {
  const root = join(path, "..");
  const closurePath = join(root, `${input.environment}-bridge-closure`);
  const restoreClosurePath = join(
    root,
    `${input.environment}-bridge-restore-closure`,
  );
  const entry = {
    path: "index.js",
    size: 1,
    sha256: digestJson({ bytes: "bridge" }),
  };
  const dryRun = {
    digest: digestJson({
      kind: "takosumi.dashboard-asset-tree@v1",
      entries: [entry],
    }),
    entries: [entry],
  };
  const closureEntry = { ...entry, path: "dry-run/index.js" };
  const closure = {
    digest: digestJson({
      kind: "takosumi.dashboard-asset-tree@v1",
      entries: [closureEntry],
    }),
    entries: [closureEntry],
  };
  const identity = {
    kind: "takosumi.platform-worker-release-plan@v5" as const,
    createdAt: "2026-08-30T11:40:00.000Z",
    environment: input.environment,
    sourceCommit: input.sourceCommit,
    releaseNonce: "c".repeat(32),
    configPath: join(root, `${input.environment}-wrangler.toml`),
    configSha256: digestJson({ config: input.environment }),
    closurePath,
    closure,
    sealedConfigPath: join(closurePath, "wrangler.toml"),
    sealedConfigSha256: digestJson({ sealedConfig: input.environment }),
    uploadEntrypointPath: join(closurePath, "dry-run", "index.js"),
    checkpointPath,
    targetMutationAuthorityPath: platformTargetMutationLockPath({
      environment: input.environment,
      workerName:
        input.environment === "staging" ? "takosumi-staging" : "takosumi",
      authorityDirectory: AUTHORITY_DIRECTORY,
    }),
    targetMutationAuthorityDirectoryIdentityDigest:
      platformTargetMutationAuthorityDirectoryIdentityDigest({
        environment: input.environment,
        workerName:
          input.environment === "staging" ? "takosumi-staging" : "takosumi",
        authorityDirectory: AUTHORITY_DIRECTORY,
      }),
    restoreClosurePath,
    restoreClosure: closure,
    restoreSealedConfigPath: join(restoreClosurePath, "wrangler.toml"),
    restoreSealedConfigSha256: digestJson({
      restoreConfig: input.environment,
    }),
    restoreUploadEntrypointPath: join(
      restoreClosurePath,
      "dry-run",
      "index.js",
    ),
    restoreDryRun: dryRun,
    dashboardAssets: closure,
    dryRun,
    secretNamesSha256: digestJson({ secrets: [] }),
    predecessorVersionId: DRIFTED_VERSION_ID,
    predecessorContainer: {
      id: "bridge-predecessor-container",
      name: `${input.environment}-bridge-runner`,
      state: "ready",
      image: `registry.cloudflare.com/${"a".repeat(32)}/takosumi-runner@sha256:${"b".repeat(64)}`,
      version: 1,
      hasActiveRollout: false,
      health: { failed: 0, starting: 0, scheduling: 0, errorCount: 0 },
    },
  };
  const releaseTag = `tks-${input.environment === "staging" ? "stg" : "prod"}-${digestJson(identity).slice("sha256:".length, "sha256:".length + 48)}`;
  const subject = { ...identity, releaseTag };
  const confirmation = digestJson(subject);
  writeFileSync(
    path,
    `${JSON.stringify({ ...subject, confirmation }, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return confirmation;
}

function workerFetch(
  calls: Array<{ url: string; authorization: string | null }>,
  servingVersionId: (url: URL) => string = () => VERSION_ID,
  servingDatabaseId: (url: URL) => string = () => DATABASE_ID,
  servingSchemaMode: (url: URL) => string = () => "predeployed-bridge",
  acceptedMigrationVersion: (
    url: URL,
  ) => 66 | 67 | Promise<66 | 67> = () => 66,
) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const requestUrl = new URL(request.url);
    const currentVersionId = servingVersionId(requestUrl);
    calls.push({
      url: request.url,
      authorization: request.headers.get("authorization"),
    });
    if (
      requestUrl.pathname ===
      "/__takosumi/control-d1-schema-compatibility"
    ) {
      const [candidate, predecessor] = await Promise.all([
        buildControlD1SchemaPlan(),
        buildControlD1SchemaPlan({ throughMigrationVersion: 66 }),
      ]);
      const migrationVersion = await acceptedMigrationVersion(requestUrl);
      const allowset = [
        { migrationVersion: 66, ledgerDigest: predecessor.ledgerDigest },
        { migrationVersion: 67, ledgerDigest: candidate.ledgerDigest },
      ] as const;
      return Response.json(
        {
          kind: "takosumi.control-d1-schema-compatibility-challenge@v1",
          status: "ready",
          nonce: requestUrl.searchParams.get("nonce"),
          environment: requestUrl.hostname.includes("staging")
            ? "staging"
            : "production",
          workerVersionId: currentVersionId,
          bindingName: "TAKOSUMI_CONTROL_DB",
          schemaMode: "predeployed-bridge",
          ledger:
            migrationVersion === 66
              ? predecessor.migrations
              : candidate.migrations,
          accepted: migrationVersion === 66 ? allowset[0] : allowset[1],
          allowset,
        },
        {
          headers: {
            "cache-control": "no-store",
            pragma: "no-cache",
            "x-takosumi-version-id": currentVersionId,
          },
        },
      );
    }
    if (request.url.endsWith("/deployments")) {
      return Response.json({
        success: true,
        result: {
          deployments: [
            {
              id: "22222222-2222-4222-8222-222222222222",
              versions: [{ percentage: 100, version_id: currentVersionId }],
            },
          ],
        },
      });
    }
    if (request.url.endsWith(`/versions/${currentVersionId}`)) {
      return Response.json({
        success: true,
        result: {
          id: currentVersionId,
          resources: {
            bindings: [
              {
                name: "TAKOSUMI_CONTROL_DB",
                type: "d1",
                database_id: servingDatabaseId(requestUrl),
              },
              {
                name: "TAKOSUMI_CONTROL_D1_SCHEMA_MODE",
                type: "plain_text",
                text: servingSchemaMode(requestUrl),
              },
            ],
          },
        },
      });
    }
    return Response.json({ success: false }, { status: 404 });
  };
}

function dependencies(
  database: SqliteControlD1Database,
  calls: Array<{ url: string; authorization: string | null }>,
  releaseEnvironment: "staging" | "production" = "staging",
  stagingDatabase?: SqliteControlD1Database,
): ControlD1SchemaReleaseDependencies {
  const databaseId =
    releaseEnvironment === "staging" ? DATABASE_ID : PRODUCTION_DATABASE_ID;
  return {
    env:
      releaseEnvironment === "production"
        ? { ...environment("staging"), ...environment("production") }
        : environment("staging"),
    fetch: workerFetch(
      calls,
      () => VERSION_ID,
      (url) =>
        url.hostname.includes("app-staging") ||
        url.pathname.includes("/takosumi-staging/")
          ? DATABASE_ID
          : databaseId,
      () => "predeployed-bridge",
      async (url) =>
        (
          await readControlD1MigrationLedger(
            url.hostname.includes("app-staging") && stagingDatabase
              ? stagingDatabase
              : database,
          )
        ).at(-1)?.version === 67
          ? 67
          : 66,
    ),
    inspectSource: () => ({
      head: COMMIT,
      branch: "fix/TASK-0042-takosumi-control-schema-surface",
      clean: true,
      pushed: true,
      authorEmail: "author@example.com",
    }),
    inspectBridgeSourceCompatibility,
    createRemoteDatabase: (credentials) => ({
      database:
        credentials.databaseId === DATABASE_ID && stagingDatabase
          ? stagingDatabase
          : database,
      readTimeTravelBookmark: async () => BOOKMARK,
    }),
    now: () => "2026-08-30T12:00:00.000Z",
    waitForRequestDrain: async () => {},
  };
}

test("staging plan is external, exact, REST-bound, and secret-free on stdout", async () => {
  const root = privateRoot();
  const planPath = join(root, "plan.json");
  const database = await predecessorDatabase();
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const stdout: string[] = [];
  const proofPath = await servingCompatibilityProof(root);
  try {
    await expect(
      runReleaseSurface(
        ["plan", "--plan-out", planPath],
        "staging",
        dependencies(database, calls),
      ),
    ).rejects.toThrow("control_d1_schema_release_arguments_invalid");
    await runReleaseSurface(
      [
        "plan",
        "--plan-out",
        planPath,
        "--serving-compatibility-proof",
        proofPath,
      ],
      "staging",
      {
        ...dependencies(database, calls),
        write: (value) => stdout.push(value),
      },
    );
    const planText = readFileSync(planPath, "utf8");
    const plan = JSON.parse(planText) as Record<string, unknown>;
    expect(statSync(planPath).mode & 0o777).toBe(0o600);
    expect(plan.kind).toBe("takosumi.control-d1-schema-release-plan@v3");
    expect(plan.environment).toBe("staging");
    expect(plan.sourceCommit).toBe(COMMIT);
    expect(plan.currentMigrationVersion).toBe(66);
    expect(plan.pendingMigrationVersions).toEqual([67]);
    expect(plan.finalMigrationVersion).toBe(67);
    expect(plan.finalMigrationCount).toBe(64);
    expect(plan.finalTableCount).toBe(38);
    expect(plan.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(plan.schemaDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(plan.ledgerDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(plan.servingCompatibilityProofDigest).toMatch(
      /^sha256:[0-9a-f]{64}$/u,
    );
    expect(plan.servingCompatibilityProofPath).toBe(proofPath);
    expect(plan.predecessorCompatibilityChallenge).toMatchObject({
      response: {
        workerVersionId: VERSION_ID,
        accepted: { migrationVersion: 66 },
      },
    });
    expect(plan.confirmation).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(planText).toContain(BOOKMARK);
    expect(planText).not.toContain(TOKEN);
    const publicText = stdout.join("\n");
    for (const privateValue of [
      ACCOUNT_ID,
      DATABASE_ID,
      VERSION_ID,
      BOOKMARK,
      TOKEN,
    ]) {
      expect(publicText).not.toContain(privateValue);
    }
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      `/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/takosumi-staging/deployments`,
      `/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/takosumi-staging/versions/${VERSION_ID}`,
      "/__takosumi/control-d1-schema-compatibility",
    ]);
    expect(
      calls.filter((call) => call.authorization === `Bearer ${TOKEN}`),
    ).toHaveLength(2);
    expect(calls.filter((call) => call.authorization === null)).toHaveLength(1);
  } finally {
    database.close();
  }
});

test("official bridge proof producer binds the full plan, raw ready evidence, and live immutable bindings", async () => {
  const root = privateRoot();
  const fixtureProofPath = await servingCompatibilityProof(root);
  const fixture = JSON.parse(
    readFileSync(fixtureProofPath, "utf8"),
  ) as BridgeProofArtifactFixture;
  rmSync(fixtureProofPath);
  const proofPath = join(root, "official-bridge-proof.json");
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const stdout: string[] = [];

  await runControlD1ServingCompatibilityProof(
    [
      "create",
      ...predecessorProofArguments(fixture),
      "--bridge-plan",
      fixture.bridgePlanPath,
      "--confirm",
      fixture.bridgePlanConfirmation,
      "--bridge-evidence",
      fixture.bridgeReleaseEvidencePath,
      "--proof-out",
      proofPath,
    ],
    "staging",
    {
      env: environment(),
      fetch: workerFetch(calls),
      now: () => "2026-08-30T11:55:00.000Z",
      inspectBridgeSourceCompatibility,
      write: (value) => stdout.push(value),
    },
  );

  const proofText = readFileSync(proofPath, "utf8");
  const proof = JSON.parse(proofText) as Record<string, unknown>;
  expect(statSync(proofPath).mode & 0o777).toBe(0o600);
  expect(statSync(proofPath).nlink).toBe(1);
  expect(proof).toMatchObject({
    kind: "takosumi.control-d1-serving-compatibility-proof@v3",
    status: "ready",
    environment: "staging",
    bridgePlanPath: fixture.bridgePlanPath,
    bridgePlanConfirmation: fixture.bridgePlanConfirmation,
    bridgeReleaseEvidencePath: fixture.bridgeReleaseEvidencePath,
    servingVersionId: VERSION_ID,
    schemaMode: "predeployed-bridge",
    reviewer: "operator:bridge-reviewer@example.com",
    bridgeSourceCommit: BRIDGE_COMMIT,
    bridgeSourceCompatibility: {
      predecessorSourceCommit: COMMIT,
      bridgeSourceCommit: BRIDGE_COMMIT,
      predecessorServingVersionId: DRIFTED_VERSION_ID,
      commits: [
        { sourceCommit: CLOSURE_COMMIT_ONE, parentSourceCommit: COMMIT },
        {
          sourceCommit: CLOSURE_COMMIT_TWO,
          parentSourceCommit: CLOSURE_COMMIT_ONE,
        },
        {
          sourceCommit: BRIDGE_COMMIT,
          parentSourceCommit: CLOSURE_COMMIT_TWO,
        },
      ],
      reviewer: "operator:bridge-reviewer@example.com",
    },
    predecessor: { migrationVersion: 66, status: "ready" },
    candidate: { migrationVersion: 67, status: "ready" },
  });
  expect(proof.bridgeReleaseEvidenceDigest).toMatch(
    /^sha256:[0-9a-f]{64}$/u,
  );
  expect(proof.confirmation).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(proof.bridgePlanDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(proof.bridgeSourceCompatibilityDigest).toMatch(
    /^sha256:[0-9a-f]{64}$/u,
  );
  expect(
    (proof.bridgeSourceCompatibility as Record<string, unknown>)
      .compatibilityClosureDigest,
  ).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(proof.compatibilityCatalogDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(proof.predecessorChallenge).toMatchObject({
    kind: "takosumi.control-d1-schema-compatibility-challenge-evidence@v1",
    response: {
      workerVersionId: VERSION_ID,
      accepted: { migrationVersion: 66 },
      allowset: [{ migrationVersion: 66 }, { migrationVersion: 67 }],
    },
  });
  expect(proofText).not.toContain(TOKEN);
  const publicText = stdout.join("\n");
  for (const privateValue of [ACCOUNT_ID, DATABASE_ID, VERSION_ID, TOKEN]) {
    expect(publicText).not.toContain(privateValue);
  }
  expect(calls.filter((call) => call.authorization === `Bearer ${TOKEN}`)).toHaveLength(2);
  expect(calls.filter((call) => call.authorization === null)).toHaveLength(1);
});

test("repository compatibility closure binds the genuine v66 serving predecessor through every linear descendant", () => {
  const predecessorSourceCommit =
    "24ea16d626f540260f496649cbdc5ffd7aa2a1f9";
  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    cwd: join(import.meta.dir, "../.."),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(head.exitCode).toBe(0);
  const bridgeSourceCommit = new TextDecoder("utf-8", { fatal: true })
    .decode(head.stdout)
    .trim();
  const closure = inspectControlD1BridgeSourceCompatibility(
    predecessorSourceCommit,
    bridgeSourceCommit,
    "operator:independent-bridge-reviewer@example.com",
  );

  expect(closure).toMatchObject({
    kind: "takosumi.control-d1-bridge-source-compatibility@v2",
    predecessorSourceCommit,
    bridgeSourceCommit,
  });
  expect(closure.commits.length).toBeGreaterThan(1);
  expect(closure.commits[0]?.parentSourceCommit).toBe(
    predecessorSourceCommit,
  );
  expect(closure.commits.at(-1)?.sourceCommit).toBe(bridgeSourceCommit);
  for (let index = 1; index < closure.commits.length; index += 1) {
    expect(closure.commits[index]?.parentSourceCommit).toBe(
      closure.commits[index - 1]?.sourceCommit,
    );
  }
  expect(
    closure.commits.flatMap((entry) => entry.changedPaths),
  ).toContain("core/domains/deploy-control/store.ts");
  expect(closure.compatibilityClosureDigest).toMatch(
    /^sha256:[0-9a-f]{64}$/u,
  );
});

test("repository compatibility closure ignores and rejects Git graph replacement mechanisms", () => {
  const predecessorSourceCommit =
    "24ea16d626f540260f496649cbdc5ffd7aa2a1f9";
  const bridgeSourceCommit = "5833fe43795e37b45f39b787c27ade6aebbcd04d";
  const inspect = () =>
    inspectControlD1BridgeSourceCompatibility(
      predecessorSourceCommit,
      bridgeSourceCommit,
      "operator:independent-bridge-reviewer@example.com",
    );

  expect(
    withInterceptedGit("passthrough", inspect).commits.length,
  ).toBeGreaterThan(1);
  for (const mode of ["replace", "graft"] as const) {
    expect(() => withInterceptedGit(mode, inspect), mode).toThrow(
      "control_d1_serving_compatibility_proof_source_replacement_invalid",
    );
  }
});

test("a valid nonce and schema challenge cannot replace reviewed bridge source compatibility", async () => {
  const root = privateRoot();
  const fixtureProofPath = await servingCompatibilityProof(root);
  const fixture = JSON.parse(
    readFileSync(fixtureProofPath, "utf8"),
  ) as BridgeProofArtifactFixture;
  rmSync(fixtureProofPath);
  const proofPath = join(root, "must-not-exist.json");
  const calls: Array<{ url: string; authorization: string | null }> = [];

  await expect(
    runControlD1ServingCompatibilityProof(
      [
        "create",
        ...predecessorProofArguments(fixture),
        "--bridge-plan",
        fixture.bridgePlanPath,
        "--confirm",
        fixture.bridgePlanConfirmation,
        "--bridge-evidence",
        fixture.bridgeReleaseEvidencePath,
        "--proof-out",
        proofPath,
      ],
      "staging",
      {
        env: environment(),
        fetch: workerFetch(calls),
        inspectBridgeSourceCompatibility: (
          predecessorSourceCommit,
          bridgeSourceCommit,
          reviewer,
        ) => ({
          kind: "takosumi.control-d1-bridge-source-compatibility@v2",
          predecessorSourceCommit,
          predecessorTreeObjectId: "0".repeat(40),
          bridgeSourceCommit,
          commits: inspectBridgeSourceCompatibility(
            predecessorSourceCommit,
            bridgeSourceCommit,
            reviewer,
          ).commits.slice(0, 1),
          compatibilityClosureDigest: inspectBridgeSourceCompatibility(
            predecessorSourceCommit,
            bridgeSourceCommit,
            reviewer,
          ).compatibilityClosureDigest,
          reviewer,
        }),
      },
    ),
  ).rejects.toThrow(
    "control_d1_serving_compatibility_proof_source_lineage_invalid",
  );
  expect(calls).toHaveLength(0);
  expect(existsSync(proofPath)).toBeFalse();
});

test("bridge proof producer requires the reviewer-confirmed compatibility closure digest", async () => {
  const root = privateRoot();
  const fixtureProofPath = await servingCompatibilityProof(root);
  const fixture = JSON.parse(
    readFileSync(fixtureProofPath, "utf8"),
  ) as BridgeProofArtifactFixture;
  rmSync(fixtureProofPath);
  const proofPath = join(root, "must-not-exist.json");
  const sourceArguments = [...predecessorProofArguments(fixture)];
  sourceArguments[sourceArguments.indexOf("--confirm-closure") + 1] = digestJson({
    forged: "unreviewed-patch",
  });

  await expect(
    runControlD1ServingCompatibilityProof(
      [
        "create",
        ...sourceArguments,
        "--bridge-plan",
        fixture.bridgePlanPath,
        "--confirm",
        fixture.bridgePlanConfirmation,
        "--bridge-evidence",
        fixture.bridgeReleaseEvidencePath,
        "--proof-out",
        proofPath,
      ],
      "staging",
      {
        env: environment(),
        fetch: workerFetch([]),
        inspectBridgeSourceCompatibility,
      },
    ),
  ).rejects.toThrow(
    "control_d1_serving_compatibility_proof_source_review_invalid",
  );
  expect(existsSync(proofPath)).toBeFalse();
});

test("bridge proof producer binds the exact previously serving Version to its validated source", async () => {
  const root = privateRoot();
  const fixtureProofPath = await servingCompatibilityProof(root);
  const fixture = JSON.parse(
    readFileSync(fixtureProofPath, "utf8"),
  ) as BridgeProofArtifactFixture;
  rmSync(fixtureProofPath);
  const predecessorPlan = JSON.parse(
    readFileSync(
      fixture.bridgeSourceCompatibility.predecessorPlatformPlanPath,
      "utf8",
    ),
  ) as { readonly checkpointPath: string };
  const otherVersionId = "44444444-4444-4444-8444-444444444444";
  rmSync(predecessorPlan.checkpointPath);
  appendPlatformMutationFence(
    fixture.bridgeSourceCompatibility.predecessorPlatformPlanPath,
    fixture.bridgeSourceCompatibility.predecessorPlatformPlanConfirmation,
    { outcome: "unknown", versionId: null },
    "2026-08-30T11:20:00.000Z",
  );
  appendPlatformMutationFence(
    fixture.bridgeSourceCompatibility.predecessorPlatformPlanPath,
    fixture.bridgeSourceCompatibility.predecessorPlatformPlanConfirmation,
    { outcome: "accepted", versionId: otherVersionId },
    "2026-08-30T11:21:00.000Z",
  );
  const predecessorEvidence = JSON.parse(
    readFileSync(
      fixture.bridgeSourceCompatibility.predecessorPlatformReleaseEvidencePath,
      "utf8",
    ),
  ) as Record<string, unknown>;
  predecessorEvidence.deployedVersionId = otherVersionId;
  writeFileSync(
    fixture.bridgeSourceCompatibility.predecessorPlatformReleaseEvidencePath,
    `${JSON.stringify(predecessorEvidence, null, 2)}\n`,
    { mode: 0o600 },
  );
  const proofPath = join(root, "must-not-exist.json");

  await expect(
    runControlD1ServingCompatibilityProof(
      [
        "create",
        ...predecessorProofArguments(fixture),
        "--bridge-plan",
        fixture.bridgePlanPath,
        "--confirm",
        fixture.bridgePlanConfirmation,
        "--bridge-evidence",
        fixture.bridgeReleaseEvidencePath,
        "--proof-out",
        proofPath,
      ],
      "staging",
      {
        env: environment(),
        fetch: workerFetch([]),
        inspectBridgeSourceCompatibility,
      },
    ),
  ).rejects.toThrow(
    "control_d1_serving_compatibility_proof_bridge_release_invalid",
  );
  expect(existsSync(proofPath)).toBeFalse();
});

test("schema plan recomputes the bridge closure instead of trusting a copied digest", async () => {
  const root = privateRoot();
  const proofPath = await servingCompatibilityProof(root);
  const proof = JSON.parse(readFileSync(proofPath, "utf8")) as Record<
    string,
    any
  >;
  proof.bridgeSourceCompatibility.compatibilityClosureDigest = digestJson({
    forged: "copied-review-label",
  });
  proof.bridgeSourceCompatibilityDigest = digestJson(
    proof.bridgeSourceCompatibility,
  );
  const { confirmation: _discardedConfirmation, ...proofIdentity } = proof;
  proof.confirmation = digestJson(proofIdentity);
  writeFileSync(proofPath, `${JSON.stringify(proof, null, 2)}\n`, {
    mode: 0o600,
  });

  const database = await predecessorDatabase();
  const planPath = join(root, "must-not-exist-plan.json");
  try {
    await expect(
      runReleaseSurface(
        [
          "plan",
          "--plan-out",
          planPath,
          "--serving-compatibility-proof",
          proofPath,
        ],
        "staging",
        dependencies(database, []),
      ),
    ).rejects.toThrow(
      "control_d1_schema_release_serving_compatibility_proof_invalid",
    );
    expect(existsSync(planPath)).toBeFalse();
  } finally {
    database.close();
  }
});

test("schema plan rejects every compatibility-closure omission, reorder, addition, merge, and identity drift", async () => {
  type MutableClosureEntry = {
    sourceCommit: string;
    parentSourceCommit: string;
    treeObjectId: string;
    canonicalPatchDigest: string;
    changedPaths: string[];
    mergeParentSourceCommit?: string;
  };
  type MutableClosure = {
    kind: string;
    predecessorSourceCommit: string;
    predecessorTreeObjectId: string;
    bridgeSourceCommit: string;
    commits: MutableClosureEntry[];
    compatibilityClosureDigest: string;
    reviewer: string;
    [key: string]: unknown;
  };
  const mutations: readonly {
    readonly name: string;
    readonly rehashClosure?: boolean;
    readonly mutate: (closure: MutableClosure) => void;
  }[] = [
    {
      name: "missing commit",
      mutate(closure) {
        closure.commits.splice(1, 1);
        closure.commits[1]!.parentSourceCommit =
          closure.commits[0]!.sourceCommit;
      },
    },
    {
      name: "reordered commits",
      mutate(closure) {
        closure.commits = [
          closure.commits[1]!,
          closure.commits[0]!,
          closure.commits[2]!,
        ];
        let parent = closure.predecessorSourceCommit;
        for (const entry of closure.commits) {
          entry.parentSourceCommit = parent;
          parent = entry.sourceCommit;
        }
      },
    },
    {
      name: "extra commit",
      mutate(closure) {
        const bridge = closure.commits.pop()!;
        const parent = closure.commits.at(-1)!.sourceCommit;
        const extra = {
          sourceCommit: "e".repeat(40),
          parentSourceCommit: parent,
          treeObjectId: "4".repeat(40),
          canonicalPatchDigest: digestJson({ extra: "patch" }),
          changedPaths: ["extra/unreviewed.ts"],
        };
        bridge.parentSourceCommit = extra.sourceCommit;
        closure.commits.push(extra, bridge);
      },
    },
    {
      name: "merge parent",
      mutate(closure) {
        closure.commits[1]!.mergeParentSourceCommit = "e".repeat(40);
      },
    },
    {
      name: "path drift",
      mutate(closure) {
        closure.commits[0]!.changedPaths = ["unreviewed/path.ts"];
      },
    },
    {
      name: "tree drift",
      mutate(closure) {
        closure.commits[0]!.treeObjectId = "e".repeat(40);
      },
    },
    {
      name: "patch drift",
      mutate(closure) {
        closure.commits[0]!.canonicalPatchDigest = digestJson({
          forged: "patch",
        });
      },
    },
    {
      name: "alternate predecessor",
      mutate(closure) {
        closure.predecessorSourceCommit = "e".repeat(40);
        closure.commits[0]!.parentSourceCommit =
          closure.predecessorSourceCommit;
      },
    },
    {
      name: "reviewer digest mismatch",
      rehashClosure: false,
      mutate(closure) {
        closure.reviewer = "operator:substituted-reviewer@example.com";
      },
    },
  ];

  for (const mutation of mutations) {
    const root = privateRoot();
    const proofPath = await servingCompatibilityProof(root);
    const proof = JSON.parse(readFileSync(proofPath, "utf8")) as Record<
      string,
      any
    >;
    const closure = proof.bridgeSourceCompatibility as MutableClosure;
    mutation.mutate(closure);
    if (mutation.rehashClosure !== false) {
      closure.compatibilityClosureDigest = digestJson({
        kind: closure.kind,
        predecessorSourceCommit: closure.predecessorSourceCommit,
        predecessorTreeObjectId: closure.predecessorTreeObjectId,
        bridgeSourceCommit: closure.bridgeSourceCommit,
        commits: closure.commits,
        reviewer: closure.reviewer,
      });
    }
    proof.bridgeSourceCompatibilityDigest = digestJson(closure);
    const { confirmation: _oldConfirmation, ...identity } = proof;
    proof.confirmation = digestJson(identity);
    writeFileSync(proofPath, `${JSON.stringify(proof, null, 2)}\n`, {
      mode: 0o600,
    });

    const database = await predecessorDatabase();
    try {
      const planPath = join(root, `must-not-exist-${mutation.name}.json`);
      await expect(
        runReleaseSurface(
          [
            "plan",
            "--plan-out",
            planPath,
            "--serving-compatibility-proof",
            proofPath,
          ],
          "staging",
          dependencies(database, []),
        ),
        mutation.name,
      ).rejects.toThrow(
        "control_d1_schema_release_serving_compatibility_proof_invalid",
      );
      expect(existsSync(planPath), mutation.name).toBeFalse();
    } finally {
      database.close();
    }
  }
});

test("bridge proof producer rejects hand-authored or incomplete platform evidence without creating output", async () => {
  const root = privateRoot();
  const fixtureProofPath = await servingCompatibilityProof(root);
  const fixture = JSON.parse(
    readFileSync(fixtureProofPath, "utf8"),
  ) as BridgeProofArtifactFixture;
  const evidence = JSON.parse(
    readFileSync(fixture.bridgeReleaseEvidencePath, "utf8"),
  ) as Record<string, unknown>;
  evidence.status = "incomplete";
  writeFileSync(
    fixture.bridgeReleaseEvidencePath,
    `${JSON.stringify(evidence, null, 2)}\n`,
    { mode: 0o600 },
  );
  const proofPath = join(root, "must-not-exist.json");
  await expect(
    runControlD1ServingCompatibilityProof(
      [
        "create",
        ...predecessorProofArguments(fixture),
        "--bridge-plan",
        fixture.bridgePlanPath,
        "--confirm",
        fixture.bridgePlanConfirmation,
        "--bridge-evidence",
        fixture.bridgeReleaseEvidencePath,
        "--proof-out",
        proofPath,
      ],
      "staging",
      {
        env: environment(),
        fetch: workerFetch([]),
        inspectBridgeSourceCompatibility,
      },
    ),
  ).rejects.toThrow("platform_worker_release_evidence_invalid");
  expect(existsSync(proofPath)).toBeFalse();
});

test("bridge proof producer refuses a live immutable Version without predeployed schema mode", async () => {
  const root = privateRoot();
  const fixtureProofPath = await servingCompatibilityProof(root);
  const fixture = JSON.parse(
    readFileSync(fixtureProofPath, "utf8"),
  ) as BridgeProofArtifactFixture;
  const proofPath = join(root, "must-not-exist.json");
  await expect(
    runControlD1ServingCompatibilityProof(
      [
        "create",
        ...predecessorProofArguments(fixture),
        "--bridge-plan",
        fixture.bridgePlanPath,
        "--confirm",
        fixture.bridgePlanConfirmation,
        "--bridge-evidence",
        fixture.bridgeReleaseEvidencePath,
        "--proof-out",
        proofPath,
      ],
      "staging",
      {
        env: environment(),
        fetch: workerFetch(
          [],
          () => VERSION_ID,
          () => DATABASE_ID,
          () => "bootstrap",
        ),
        inspectBridgeSourceCompatibility,
      },
    ),
  ).rejects.toThrow("control_d1_schema_release_worker_schema_mode_invalid");
  expect(existsSync(proofPath)).toBeFalse();
});

test("bridge proof producer rejects a live Version whose challenge accepts only v66", async () => {
  const root = privateRoot();
  const fixtureProofPath = await servingCompatibilityProof(root);
  const fixture = JSON.parse(
    readFileSync(fixtureProofPath, "utf8"),
  ) as BridgeProofArtifactFixture;
  const proofPath = join(root, "must-not-exist.json");
  const baseFetch = workerFetch(
    [],
    () => VERSION_ID,
    () => DATABASE_ID,
    () => "predeployed-bridge",
  );
  const predecessor = await buildControlD1SchemaPlan({
    throughMigrationVersion: 66,
  });
  const forgedFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    if (
      request.url.startsWith(
        "https://app-staging.takosumi.com/__takosumi/control-d1-schema-compatibility?",
      )
    ) {
      const nonce = new URL(request.url).searchParams.get("nonce");
      return Response.json(
        {
          kind: "takosumi.control-d1-schema-compatibility-challenge@v1",
          status: "ready",
          nonce,
          environment: "staging",
          workerVersionId: VERSION_ID,
          schemaMode: "predeployed-bridge",
          accepted: {
            migrationVersion: 66,
            ledgerDigest: predecessor.ledgerDigest,
          },
          allowset: [
            {
              migrationVersion: 66,
              ledgerDigest: predecessor.ledgerDigest,
            },
          ],
        },
        {
          headers: {
            "cache-control": "no-store",
            pragma: "no-cache",
            "x-takosumi-version-id": VERSION_ID,
          },
        },
      );
    }
    return await baseFetch(input, init);
  };

  await expect(
    runControlD1ServingCompatibilityProof(
      [
        "create",
        ...predecessorProofArguments(fixture),
        "--bridge-plan",
        fixture.bridgePlanPath,
        "--confirm",
        fixture.bridgePlanConfirmation,
        "--bridge-evidence",
        fixture.bridgeReleaseEvidencePath,
        "--proof-out",
        proofPath,
      ],
      "staging",
      {
        env: environment(),
        fetch: forgedFetch,
        inspectBridgeSourceCompatibility,
      },
    ),
  ).rejects.toThrow(
    "control_d1_serving_compatibility_proof_challenge_invalid",
  );
  expect(existsSync(proofPath)).toBeFalse();
});

test("schema plan independently rejects a proof-bound Version whose live challenge accepts only v66", async () => {
  const root = privateRoot();
  const planPath = join(root, "must-not-exist.json");
  const database = await predecessorDatabase();
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const proofPath = await servingCompatibilityProof(root);
  const baseDependencies = dependencies(database, calls);
  const predecessor = await buildControlD1SchemaPlan({
    throughMigrationVersion: 66,
  });
  const forgedFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (
      url.pathname === "/__takosumi/control-d1-schema-compatibility"
    ) {
      return Response.json(
        {
          kind: "takosumi.control-d1-schema-compatibility-challenge@v1",
          status: "ready",
          nonce: url.searchParams.get("nonce"),
          environment: "staging",
          workerVersionId: VERSION_ID,
          schemaMode: "predeployed-bridge",
          accepted: {
            migrationVersion: 66,
            ledgerDigest: predecessor.ledgerDigest,
          },
          allowset: [
            {
              migrationVersion: 66,
              ledgerDigest: predecessor.ledgerDigest,
            },
          ],
        },
        {
          headers: {
            "cache-control": "no-store",
            pragma: "no-cache",
            "x-takosumi-version-id": VERSION_ID,
          },
        },
      );
    }
    return await baseDependencies.fetch!(request);
  };
  try {
    await expect(
      runReleaseSurface(
        [
          "plan",
          "--plan-out",
          planPath,
          "--serving-compatibility-proof",
          proofPath,
        ],
        "staging",
        { ...baseDependencies, fetch: forgedFetch },
      ),
    ).rejects.toThrow(
      "control_d1_schema_release_serving_compatibility_challenge_invalid",
    );
    expect(existsSync(planPath)).toBeFalse();
  } finally {
    database.close();
  }
});

test("schema plan command refuses an unresolved target owner before source, provider, or D1 reads", async () => {
  const root = privateRoot();
  const planPath = join(root, "plan.json");
  const database = await predecessorDatabase();
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const proofPath = await servingCompatibilityProof(root);
  const target = {
    environment: "staging" as const,
    workerName: "takosumi-staging",
    authorityDirectory: AUTHORITY_DIRECTORY,
  };
  try {
    await expect(
      withPlatformTargetMutationLock(
        target,
        competingPlatformTargetRequest(root, "unresolved-plan-owner"),
        async () => {
          throw new Error("provider_outcome_unknown");
        },
        { shouldRetainAfterError: () => true },
      ),
    ).rejects.toThrow("provider_outcome_unknown");

    await expect(
      runReleaseSurface(
        [
          "plan",
          "--plan-out",
          planPath,
          "--serving-compatibility-proof",
          proofPath,
        ],
        "staging",
        dependencies(database, calls),
      ),
    ).rejects.toThrow(
      "platform_worker_target_mutation_reconciliation_required",
    );
    expect(calls).toEqual([]);
    expect(existsSync(planPath)).toBeFalse();
  } finally {
    cleanupRetainedStagingTargetLock();
    database.close();
  }
});

test("plan rejects a serving proof backed only by synthetic confirmation/checkpoint JSON", async () => {
  const root = privateRoot();
  const planPath = join(root, "plan.json");
  const database = await predecessorDatabase();
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const proofPath = await servingCompatibilityProof(root, "staging", {
    platformPlanShape: "synthetic",
  });
  try {
    await expect(
      runReleaseSurface(
        [
          "plan",
          "--plan-out",
          planPath,
          "--serving-compatibility-proof",
          proofPath,
        ],
        "staging",
        dependencies(database, calls),
      ),
    ).rejects.toThrow(
      "control_d1_schema_release_serving_compatibility_proof_invalid",
    );
    expect(existsSync(planPath)).toBeFalse();
  } finally {
    database.close();
  }
});

test("plan rejects a compatibility proof misdirected to a different platform source", async () => {
  const root = privateRoot();
  const planPath = join(root, "plan.json");
  const database = await predecessorDatabase();
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const proofPath = await servingCompatibilityProof(root, "staging", {
    platformPlanSourceCommit: "e".repeat(40),
  });
  try {
    await expect(
      runReleaseSurface(
        [
          "plan",
          "--plan-out",
          planPath,
          "--serving-compatibility-proof",
          proofPath,
        ],
        "staging",
        dependencies(database, calls),
      ),
    ).rejects.toThrow(
      "control_d1_schema_release_serving_compatibility_proof_invalid",
    );
    expect(existsSync(planPath)).toBeFalse();
  } finally {
    database.close();
  }
});

test("plan rejects a compatibility proof backed by another environment's platform plan", async () => {
  const root = privateRoot();
  const planPath = join(root, "plan.json");
  const database = await predecessorDatabase();
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const proofPath = await servingCompatibilityProof(root, "staging", {
    platformPlanEnvironment: "production",
  });
  try {
    await expect(
      runReleaseSurface(
        [
          "plan",
          "--plan-out",
          planPath,
          "--serving-compatibility-proof",
          proofPath,
        ],
        "staging",
        dependencies(database, calls),
      ),
    ).rejects.toThrow(
      "control_d1_schema_release_serving_compatibility_proof_invalid",
    );
    expect(existsSync(planPath)).toBeFalse();
  } finally {
    database.close();
  }
});

test("plan cannot use the bridge restore checkpoint as its output", async () => {
  const root = privateRoot();
  const database = await predecessorDatabase();
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const proofPath = await servingCompatibilityProof(root);
  const proof = JSON.parse(readFileSync(proofPath, "utf8")) as {
    readonly bridgePlanPath: string;
    readonly bridgePlanConfirmation: string;
  };
  const restoreCheckpointPath = platformRestoreCheckpointPath(
    proof.bridgePlanPath,
    proof.bridgePlanConfirmation,
  );
  try {
    await expect(
      runReleaseSurface(
        [
          "plan",
          "--plan-out",
          restoreCheckpointPath,
          "--serving-compatibility-proof",
          proofPath,
        ],
        "staging",
        dependencies(database, calls),
      ),
    ).rejects.toThrow("control_d1_schema_release_artifact_path_alias");
    expect(existsSync(restoreCheckpointPath)).toBeFalse();
    expect(
      readPlatformRestoreFence(
        proof.bridgePlanPath,
        proof.bridgePlanConfirmation,
      ),
    ).toEqual({});
  } finally {
    database.close();
  }
});

test("plan cannot use the bridge retirement marker as its output", async () => {
  const root = privateRoot();
  const database = await predecessorDatabase();
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const proofPath = await servingCompatibilityProof(root);
  const proof = JSON.parse(readFileSync(proofPath, "utf8")) as {
    readonly bridgePlanPath: string;
    readonly bridgePlanConfirmation: string;
  };
  const retirementPath = platformRestoreRetirementPath(
    proof.bridgePlanPath,
    proof.bridgePlanConfirmation,
  );
  try {
    await expect(
      runReleaseSurface(
        [
          "plan",
          "--plan-out",
          retirementPath,
          "--serving-compatibility-proof",
          proofPath,
        ],
        "staging",
        dependencies(database, calls),
      ),
    ).rejects.toThrow("control_d1_schema_release_artifact_path_alias");
    expect(existsSync(retirementPath)).toBeFalse();
  } finally {
    database.close();
  }
});

test("plan cannot claim any future bridge recovery or closure artifact", async () => {
  const root = privateRoot();
  const database = await predecessorDatabase();
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const proofPath = await servingCompatibilityProof(root);
  const proof = JSON.parse(readFileSync(proofPath, "utf8")) as {
    readonly bridgePlanPath: string;
    readonly bridgePlanConfirmation: string;
  };
  const bridgePlan = JSON.parse(readFileSync(proof.bridgePlanPath, "utf8")) as {
    readonly closurePath: string;
    readonly restoreClosurePath: string;
  };
  const targetLockPath = platformTargetMutationLockPath({
    environment: "staging",
    workerName: "takosumi-staging",
    authorityDirectory: AUTHORITY_DIRECTORY,
  });
  await withPlatformTargetMutationLock(
    {
      environment: "staging",
      workerName: "takosumi-staging",
      authorityDirectory: AUTHORITY_DIRECTORY,
    },
    competingPlatformTargetRequest(root, "artifact-graph-owner"),
    async () => {},
  );
  const futurePaths = [
    platformRestoreLockPath(proof.bridgePlanPath, proof.bridgePlanConfirmation),
    targetLockPath,
    `${targetLockPath}.pending-untrusted`,
    bridgePlan.closurePath,
    bridgePlan.restoreClosurePath,
  ];
  try {
    for (const planOut of futurePaths) {
      await expect(
        runReleaseSurface(
          [
            "plan",
            "--plan-out",
            planOut,
            "--serving-compatibility-proof",
            proofPath,
          ],
          "staging",
          dependencies(database, calls),
        ),
      ).rejects.toThrow("control_d1_schema_release_artifact_path_alias");
      expect(existsSync(planOut)).toBeFalse();
    }
    expect(
      readPlatformRestoreFence(
        proof.bridgePlanPath,
        proof.bridgePlanConfirmation,
      ),
    ).toEqual({});
  } finally {
    database.close();
  }
});

test("execute applies only v67 once and writes exact ready evidence", async () => {
  const root = privateRoot();
  const planPath = join(root, "plan.json");
  const evidencePath = join(root, "evidence.json");
  const database = await predecessorDatabase();
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const stdout: string[] = [];
  let applyCalls = 0;
  const base = dependencies(database, calls);
  const proofPath = await servingCompatibilityProof(root);
  const deps: ControlD1SchemaReleaseDependencies = {
    ...base,
    write: (value) => stdout.push(value),
    applySchema: async (...args) => {
      applyCalls += 1;
      return await applyControlD1Schema(...args);
    },
  };
  try {
    await runReleaseSurface(
      [
        "plan",
        "--plan-out",
        planPath,
        "--serving-compatibility-proof",
        proofPath,
      ],
      "staging",
      deps,
    );
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as {
      readonly confirmation: string;
      readonly bridgeSourceCompatibilityDigest: string;
      readonly bridgeSourceCompatibility: {
        readonly predecessorSourceCommit: string;
        readonly bridgeSourceCommit: string;
        readonly compatibilityClosureDigest: string;
      };
      readonly mutationCheckpointPath: string;
    };
    stdout.length = 0;

    await runReleaseSurface(
      [
        "execute",
        "--plan",
        planPath,
        "--confirm",
        plan.confirmation,
        "--review",
        "operator:reviewer@example.com",
        "--evidence",
        evidencePath,
      ],
      "staging",
      deps,
    );

    expect(applyCalls).toBe(1);
    expect(statSync(evidencePath).mode & 0o777).toBe(0o600);
    expect(statSync(plan.mutationCheckpointPath).mode & 0o777).toBe(0o600);
    const evidenceText = readFileSync(evidencePath, "utf8");
    const evidence = JSON.parse(evidenceText) as Record<string, unknown>;
    expect(evidence.kind).toBe(
      "takosumi.control-d1-schema-release-evidence@v3",
    );
    expect(evidence.status).toBe("ready");
    expect(evidence.appliedMigrationVersions).toEqual([67]);
    expect(evidence.finalMigrationVersion).toBe(67);
    expect(evidence.finalMigrationCount).toBe(64);
    expect(evidence.finalTableCount).toBe(38);
    expect(evidence.servingCompatibilityProofDigest).toMatch(
      /^sha256:[0-9a-f]{64}$/u,
    );
    expect(evidence.bridgeSourceCompatibilityDigest).toBe(
      plan.bridgeSourceCompatibilityDigest,
    );
    expect(evidence.bridgePredecessorSourceCommit).toBe(
      plan.bridgeSourceCompatibility.predecessorSourceCommit,
    );
    expect(evidence.bridgeSourceCommit).toBe(
      plan.bridgeSourceCompatibility.bridgeSourceCommit,
    );
    expect(evidence.bridgeCompatibilityClosureDigest).toBe(
      plan.bridgeSourceCompatibility.compatibilityClosureDigest,
    );
    expect(evidence.mutationCheckpointDigest).toMatch(
      /^sha256:[0-9a-f]{64}$/u,
    );
    expect(evidence.maintenanceReleaseReceiptDigest).toMatch(
      /^sha256:[0-9a-f]{64}$/u,
    );
    expect(evidence.predecessorChallenge).toMatchObject({
      response: { accepted: { migrationVersion: 66 } },
    });
    expect(evidence.candidateChallenge).toMatchObject({
      response: {
        workerVersionId: VERSION_ID,
        accepted: { migrationVersion: 67 },
        allowset: [{ migrationVersion: 66 }, { migrationVersion: 67 }],
      },
    });
    expect(evidence.physicalTarget).toEqual({
      accountId: ACCOUNT_ID,
      databaseId: DATABASE_ID,
    });
    expect(evidence.credentialCustodyDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(evidence.reviewer).toBe("operator:reviewer@example.com");
    const checkpointRecords = readFileSync(
      plan.mutationCheckpointPath,
      "utf8",
    )
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(checkpointRecords).toHaveLength(2);
    for (const checkpoint of checkpointRecords) {
      expect(checkpoint).toMatchObject({
        kind: "takosumi.control-d1-schema-mutation-checkpoint@v3",
        planConfirmation: plan.confirmation,
        bridgeSourceCompatibilityDigest:
          plan.bridgeSourceCompatibilityDigest,
      });
    }
    for (const privateValue of [BOOKMARK, TOKEN]) {
      expect(evidenceText).not.toContain(privateValue);
    }
    for (const privateValue of [
      ACCOUNT_ID,
      DATABASE_ID,
      VERSION_ID,
      BOOKMARK,
      TOKEN,
    ]) {
      expect(stdout.join("\n")).not.toContain(privateValue);
    }
    const ledger = await readControlD1MigrationLedger(database);
    expect(ledger).toHaveLength(64);
    expect(ledger.at(-1)?.version).toBe(67);
    expect((await readControlD1MaintenanceState(database)).status).toBe(
      "inactive",
    );
    const candidate = await buildControlD1SchemaPlan();
    const verification = await verifyControlD1Schema(database, candidate);
    expect(verification).toMatchObject({
      status: "ready",
      latestMigrationVersion: 67,
      migrationCount: 64,
      tableCount: 38,
      schemaDigest: candidate.schemaDigest,
      ledgerDigest: candidate.ledgerDigest,
    });
  } finally {
    database.close();
  }
});

test("execute rejects evidence that aliases the absent bridge restore checkpoint before apply", async () => {
  const root = privateRoot();
  const planPath = join(root, "plan.json");
  const database = await predecessorDatabase();
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const proofPath = await servingCompatibilityProof(root);
  const proof = JSON.parse(readFileSync(proofPath, "utf8")) as {
    readonly bridgePlanPath: string;
    readonly bridgePlanConfirmation: string;
  };
  const evidencePath = platformRestoreCheckpointPath(
    proof.bridgePlanPath,
    proof.bridgePlanConfirmation,
  );
  let applyCalls = 0;
  const deps: ControlD1SchemaReleaseDependencies = {
    ...dependencies(database, calls),
    write: () => {},
    applySchema: async (...args) => {
      applyCalls += 1;
      return applyControlD1Schema(...args);
    },
  };
  try {
    await runReleaseSurface(
      [
        "plan",
        "--plan-out",
        planPath,
        "--serving-compatibility-proof",
        proofPath,
      ],
      "staging",
      deps,
    );
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as {
      readonly confirmation: string;
      readonly mutationCheckpointPath: string;
    };
    await expect(
      runReleaseSurface(
        [
          "execute",
          "--plan",
          planPath,
          "--confirm",
          plan.confirmation,
          "--review",
          "operator:reviewer@example.com",
          "--evidence",
          evidencePath,
        ],
        "staging",
        deps,
      ),
    ).rejects.toThrow("control_d1_schema_release_artifact_path_alias");
    expect(applyCalls).toBe(0);
    expect(existsSync(evidencePath)).toBeFalse();
    expect(existsSync(plan.mutationCheckpointPath)).toBeFalse();
    expect((await readControlD1MigrationLedger(database)).at(-1)?.version).toBe(
      66,
    );
  } finally {
    database.close();
  }
});

test("execute rejects retained serving bridge proof drift before apply", async () => {
  const root = privateRoot();
  const planPath = join(root, "plan.json");
  const evidencePath = join(root, "evidence.json");
  const database = await predecessorDatabase();
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const proofPath = await servingCompatibilityProof(root);
  let applyCalls = 0;
  const deps: ControlD1SchemaReleaseDependencies = {
    ...dependencies(database, calls),
    write: () => {},
    applySchema: async (...args) => {
      applyCalls += 1;
      return await applyControlD1Schema(...args);
    },
  };
  try {
    await runReleaseSurface(
      [
        "plan",
        "--plan-out",
        planPath,
        "--serving-compatibility-proof",
        proofPath,
      ],
      "staging",
      deps,
    );
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as {
      readonly confirmation: string;
      readonly mutationCheckpointPath: string;
    };
    const proof = JSON.parse(readFileSync(proofPath, "utf8")) as Record<
      string,
      unknown
    >;
    const { confirmation: _confirmation, ...identity } = proof;
    const changedIdentity = {
      ...identity,
      bridgeReleaseEvidenceDigest: digestJson({ bridge: "other-evidence" }),
    };
    writeFileSync(
      proofPath,
      `${JSON.stringify(
        {
          ...changedIdentity,
          confirmation: digestJson(changedIdentity),
        },
        null,
        2,
      )}\n`,
    );

    await expect(
      runReleaseSurface(
        [
          "execute",
          "--plan",
          planPath,
          "--confirm",
          plan.confirmation,
          "--review",
          "operator:reviewer@example.com",
          "--evidence",
          evidencePath,
        ],
        "staging",
        deps,
      ),
    ).rejects.toThrow(
      "control_d1_schema_release_serving_compatibility_proof_invalid",
    );
    expect(applyCalls).toBe(0);
    expect(existsSync(plan.mutationCheckpointPath)).toBeFalse();
    expect(existsSync(evidencePath)).toBeFalse();
    expect((await readControlD1MigrationLedger(database)).at(-1)?.version).toBe(
      66,
    );
  } finally {
    database.close();
  }
});

test("execute rereads and rejects raw platform ready-evidence drift before apply", async () => {
  const root = privateRoot();
  const planPath = join(root, "plan.json");
  const evidencePath = join(root, "schema-evidence.json");
  const database = await predecessorDatabase();
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const proofPath = await servingCompatibilityProof(root);
  const deps = { ...dependencies(database, calls), write: () => {} };
  let applyCalls = 0;
  try {
    await runReleaseSurface(
      [
        "plan",
        "--plan-out",
        planPath,
        "--serving-compatibility-proof",
        proofPath,
      ],
      "staging",
      deps,
    );
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as {
      readonly confirmation: string;
      readonly mutationCheckpointPath: string;
      readonly bridgeReleaseEvidencePath: string;
    };
    const rawEvidence = JSON.parse(
      readFileSync(plan.bridgeReleaseEvidencePath, "utf8"),
    ) as Record<string, unknown>;
    rawEvidence.reviewer = "operator:unreviewed@example.com";
    writeFileSync(
      plan.bridgeReleaseEvidencePath,
      `${JSON.stringify(rawEvidence, null, 2)}\n`,
      { mode: 0o600 },
    );

    await expect(
      runReleaseSurface(
        [
          "execute",
          "--plan",
          planPath,
          "--confirm",
          plan.confirmation,
          "--review",
          "operator:reviewer@example.com",
          "--evidence",
          evidencePath,
        ],
        "staging",
        {
          ...deps,
          applySchema: async (...args) => {
            applyCalls += 1;
            return applyControlD1Schema(...args);
          },
        },
      ),
    ).rejects.toThrow(
      "control_d1_schema_release_serving_compatibility_proof_invalid",
    );
    expect(applyCalls).toBe(0);
    expect(existsSync(plan.mutationCheckpointPath)).toBeFalse();
  } finally {
    database.close();
  }
});

test("schema execute cannot race the bridge plan's official restore authority", async () => {
  const root = privateRoot();
  const planPath = join(root, "plan.json");
  const evidencePath = join(root, "evidence.json");
  const database = await predecessorDatabase();
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const proofPath = await servingCompatibilityProof(root);
  let applyCalls = 0;
  const deps: ControlD1SchemaReleaseDependencies = {
    ...dependencies(database, calls),
    write: () => {},
    applySchema: async (...args) => {
      applyCalls += 1;
      return applyControlD1Schema(...args);
    },
  };
  try {
    await runReleaseSurface(
      [
        "plan",
        "--plan-out",
        planPath,
        "--serving-compatibility-proof",
        proofPath,
      ],
      "staging",
      deps,
    );
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as {
      readonly confirmation: string;
      readonly mutationCheckpointPath: string;
    };
    const proof = JSON.parse(readFileSync(proofPath, "utf8")) as {
      readonly bridgePlanPath: string;
      readonly bridgePlanConfirmation: string;
    };

    await withPlatformRestoreLock(
      proof.bridgePlanPath,
      proof.bridgePlanConfirmation,
      async () => {
        await expect(
          runReleaseSurface(
            [
              "execute",
              "--plan",
              planPath,
              "--confirm",
              plan.confirmation,
              "--review",
              "operator:reviewer@example.com",
              "--evidence",
              evidencePath,
            ],
            "staging",
            deps,
          ),
        ).rejects.toThrow("platform_worker_restore_locked");
      },
    );
    expect(applyCalls).toBe(0);
    expect(existsSync(plan.mutationCheckpointPath)).toBeFalse();
    expect(existsSync(evidencePath)).toBeFalse();
    expect(
      existsSync(
        platformRestoreRetirementPath(
          proof.bridgePlanPath,
          proof.bridgePlanConfirmation,
        ),
      ),
    ).toBeFalse();
  } finally {
    database.close();
  }
});

test("schema execute excludes a forward Worker mutation through v67 release and readback", async () => {
  const root = privateRoot();
  const planPath = join(root, "plan.json");
  const evidencePath = join(root, "evidence.json");
  const database = await predecessorDatabase();
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const proofPath = await servingCompatibilityProof(root);
  let competingPlatformMutations = 0;
  const deps: ControlD1SchemaReleaseDependencies = {
    ...dependencies(database, calls),
    write: () => {},
    applySchema: async (...args) => {
      const applied = await applyControlD1Schema(...args);
      expect(applied.maintenanceStatus).toBe("released");
      await expect(
        withPlatformTargetMutationLock(
          {
            environment: "staging",
            workerName: "takosumi-staging",
            authorityDirectory: AUTHORITY_DIRECTORY,
          },
          competingPlatformTargetRequest(root, "execute-probe"),
          async () => {
            competingPlatformMutations += 1;
          },
        ),
      ).rejects.toThrow("platform_worker_target_mutation_locked");
      return applied;
    },
  };
  try {
    await runReleaseSurface(
      [
        "plan",
        "--plan-out",
        planPath,
        "--serving-compatibility-proof",
        proofPath,
      ],
      "staging",
      deps,
    );
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as {
      readonly confirmation: string;
      readonly mutationCheckpointPath: string;
    };
    await runReleaseSurface(
      [
        "execute",
        "--plan",
        planPath,
        "--confirm",
        plan.confirmation,
        "--review",
        "operator:reviewer@example.com",
        "--evidence",
        evidencePath,
      ],
      "staging",
      deps,
    );
    expect(competingPlatformMutations).toBe(0);
    expect(
      (JSON.parse(readFileSync(evidencePath, "utf8")) as { status: string })
        .status,
    ).toBe("ready");
    expect((await readControlD1MigrationLedger(database)).at(-1)?.version).toBe(
      67,
    );
    expect((await readControlD1MaintenanceState(database)).status).toBe(
      "inactive",
    );
  } finally {
    database.close();
  }
});

test("schema execute reclaims a stale restore lock but refuses its unresolved worker checkpoint", async () => {
  const root = privateRoot();
  const planPath = join(root, "plan.json");
  const evidencePath = join(root, "evidence.json");
  const database = await predecessorDatabase();
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const proofPath = await servingCompatibilityProof(root);
  let applyCalls = 0;
  const deps: ControlD1SchemaReleaseDependencies = {
    ...dependencies(database, calls),
    write: () => {},
    applySchema: async (...args) => {
      applyCalls += 1;
      return applyControlD1Schema(...args);
    },
  };
  try {
    await runReleaseSurface(
      [
        "plan",
        "--plan-out",
        planPath,
        "--serving-compatibility-proof",
        proofPath,
      ],
      "staging",
      deps,
    );
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as {
      readonly confirmation: string;
      readonly mutationCheckpointPath: string;
    };
    const proof = JSON.parse(readFileSync(proofPath, "utf8")) as {
      readonly bridgePlanPath: string;
      readonly bridgePlanConfirmation: string;
    };
    const actorPath = join(root, "crashed-restore.ts");
    const moduleUrl = pathToFileURL(
      join(import.meta.dir, "../../scripts/platform-worker-release.ts"),
    ).href;
    writeFileSync(
      actorPath,
      `import { appendPlatformRestoreFence, withPlatformRestoreLock } from ${JSON.stringify(moduleUrl)};
const [plan, confirmation] = process.argv.slice(2);
await withPlatformRestoreLock(plan, confirmation, async () => {
  appendPlatformRestoreFence(plan, confirmation, "container", { outcome: "unknown", versionId: null });
  appendPlatformRestoreFence(plan, confirmation, "container", { outcome: "accepted", versionId: ${JSON.stringify(DRIFTED_VERSION_ID)} });
  appendPlatformRestoreFence(plan, confirmation, "worker", { outcome: "unknown", versionId: null });
  process.exit(86);
});
`,
      { mode: 0o600 },
    );
    const crashed = Bun.spawn(
      [
        process.execPath,
        actorPath,
        proof.bridgePlanPath,
        proof.bridgePlanConfirmation,
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    expect(await subprocessExitWithin(crashed, 10_000)).toBe(86);
    expect(
      existsSync(
        platformRestoreLockPath(
          proof.bridgePlanPath,
          proof.bridgePlanConfirmation,
        ),
      ),
    ).toBeTrue();
    expect(
      readPlatformRestoreFence(
        proof.bridgePlanPath,
        proof.bridgePlanConfirmation,
      ),
    ).toMatchObject({ worker: { outcome: "unknown", versionId: null } });

    await expect(
      runReleaseSurface(
        [
          "execute",
          "--plan",
          planPath,
          "--confirm",
          plan.confirmation,
          "--review",
          "operator:reviewer@example.com",
          "--evidence",
          evidencePath,
        ],
        "staging",
        deps,
      ),
    ).rejects.toThrow(
      "control_d1_schema_release_restore_reconciliation_required",
    );
    expect(applyCalls).toBe(0);
    expect(existsSync(plan.mutationCheckpointPath)).toBeFalse();
    expect(existsSync(evidencePath)).toBeFalse();
    expect(
      existsSync(
        platformRestoreRetirementPath(
          proof.bridgePlanPath,
          proof.bridgePlanConfirmation,
        ),
      ),
    ).toBeFalse();
    expect((await readControlD1MigrationLedger(database)).at(-1)?.version).toBe(
      66,
    );
  } finally {
    database.close();
  }
}, 15_000);

test("v67 schema transition retires the bridge plan's v66-only predecessor restore before provider mutation", async () => {
  const root = privateRoot();
  const planPath = join(root, "plan.json");
  const evidencePath = join(root, "evidence.json");
  const database = await predecessorDatabase();
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const proofPath = await servingCompatibilityProof(root);
  const proof = JSON.parse(readFileSync(proofPath, "utf8")) as {
    readonly bridgePlanPath: string;
    readonly bridgePlanConfirmation: string;
  };
  const retirementPath = platformRestoreRetirementPath(
    proof.bridgePlanPath,
    proof.bridgePlanConfirmation,
  );
  let schemaMutationSawRetirement = false;
  const deps = {
    ...dependencies(database, calls),
    write: () => {},
    applySchema: async (
      ...args: Parameters<typeof applyControlD1Schema>
    ): ReturnType<typeof applyControlD1Schema> => {
      schemaMutationSawRetirement = existsSync(retirementPath);
      return applyControlD1Schema(...args);
    },
  };
  try {
    await runReleaseSurface(
      [
        "plan",
        "--plan-out",
        planPath,
        "--serving-compatibility-proof",
        proofPath,
      ],
      "staging",
      deps,
    );
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as {
      readonly confirmation: string;
      readonly mutationCheckpointPath: string;
    };
    await runReleaseSurface(
      [
        "execute",
        "--plan",
        planPath,
        "--confirm",
        plan.confirmation,
        "--review",
        "operator:reviewer@example.com",
        "--evidence",
        evidencePath,
      ],
      "staging",
      deps,
    );
    expect(schemaMutationSawRetirement).toBeTrue();
    expect(existsSync(retirementPath)).toBeTrue();
    let providerMutations = 0;
    await expect(
      withPlatformRestoreLock(
        proof.bridgePlanPath,
        proof.bridgePlanConfirmation,
        async () => {
          assertPlatformRestoreNotRetired(
            proof.bridgePlanPath,
            proof.bridgePlanConfirmation,
          );
          providerMutations += 1;
        },
      ),
    ).rejects.toThrow("platform_worker_restore_retired_by_control_schema");
    expect(providerMutations).toBe(0);
    expect((await readControlD1MigrationLedger(database)).at(-1)?.version).toBe(
      67,
    );
    expect((await readControlD1MaintenanceState(database)).status).toBe(
      "inactive",
    );
  } finally {
    database.close();
  }
});

test("production plan requires and seals the exact staging rehearsal receipt", async () => {
  const root = privateRoot();
  const stagingPlanPath = join(root, "staging-plan.json");
  const stagingEvidencePath = join(root, "staging-evidence.json");
  const productionPlanPath = join(root, "production-plan.json");
  const stagingDatabase = await predecessorDatabase();
  const productionDatabase = await predecessorDatabase();
  const stagingCalls: Array<{ url: string; authorization: string | null }> = [];
  const productionCalls: Array<{ url: string; authorization: string | null }> =
    [];
  const stagingProofPath = await servingCompatibilityProof(root);
  const productionProofPath = await servingCompatibilityProof(
    root,
    "production",
  );
  try {
    const stagingDependencies = dependencies(stagingDatabase, stagingCalls);
    await runReleaseSurface(
      [
        "plan",
        "--plan-out",
        stagingPlanPath,
        "--serving-compatibility-proof",
        stagingProofPath,
      ],
      "staging",
      stagingDependencies,
    );
    const stagingPlan = JSON.parse(readFileSync(stagingPlanPath, "utf8")) as {
      readonly confirmation: string;
    };
    await runReleaseSurface(
      [
        "execute",
        "--plan",
        stagingPlanPath,
        "--confirm",
        stagingPlan.confirmation,
        "--review",
        "operator:reviewer@example.com",
        "--evidence",
        stagingEvidencePath,
      ],
      "staging",
      stagingDependencies,
    );

    const productionDependencies: ControlD1SchemaReleaseDependencies = {
      ...dependencies(
        productionDatabase,
        productionCalls,
        "production",
        stagingDatabase,
      ),
    };
    await expect(
      runReleaseSurface(
        [
          "plan",
          "--plan-out",
          productionPlanPath,
          "--serving-compatibility-proof",
          productionProofPath,
        ],
        "production",
        productionDependencies,
      ),
    ).rejects.toThrow("control_d1_schema_release_arguments_invalid");
    await runReleaseSurface(
      [
        "plan",
        "--plan-out",
        productionPlanPath,
        "--staging-plan",
        stagingPlanPath,
        "--staging-receipt",
        stagingEvidencePath,
        "--serving-compatibility-proof",
        productionProofPath,
      ],
      "production",
      productionDependencies,
    );
    const productionPlan = JSON.parse(
      readFileSync(productionPlanPath, "utf8"),
    ) as Record<string, unknown>;
    const stagingEvidence = JSON.parse(
      readFileSync(stagingEvidencePath, "utf8"),
    ) as Record<string, unknown>;
    expect(productionPlan.environment).toBe("production");
    expect(productionPlan.target).toMatchObject({
      accountId: PRODUCTION_ACCOUNT_ID,
      databaseId: PRODUCTION_DATABASE_ID,
    });
    expect(productionPlan.stagingRehearsalReceiptDigest).toMatch(
      /^sha256:[0-9a-f]{64}$/u,
    );
    expect(productionPlan.stagingRehearsalReceiptDigest).not.toBeNull();
    expect(productionPlan.stagingRehearsalPlanPath).toBe(stagingPlanPath);
    expect(productionPlan.stagingRehearsalReceiptPath).toBe(
      stagingEvidencePath,
    );
    for (const field of [
      "stagingRehearsalPlanDigest",
      "stagingRehearsalPlanConfirmation",
      "stagingRehearsalCheckpointDigest",
    ]) {
      expect(productionPlan[field]).toMatch(/^sha256:[0-9a-f]{64}$/u);
    }
    expect(productionPlan.stagingRehearsalTarget).toMatchObject({
      accountId: ACCOUNT_ID,
      databaseId: DATABASE_ID,
      targetDigest: stagingEvidence.targetDigest,
      credentialCustodyDigest: stagingEvidence.credentialCustodyDigest,
    });
    expect(productionPlan.credentialCustodyDigest).not.toBe(
      stagingEvidence.credentialCustodyDigest,
    );
    const editedStagingEvidence = {
      ...stagingEvidence,
      reviewer: "operator:receipt-editor@example.com",
    };
    writeFileSync(
      stagingEvidencePath,
      `${JSON.stringify(editedStagingEvidence, null, 2)}\n`,
      { mode: 0o600 },
    );
    let productionApplyCalls = 0;
    await expect(
      runReleaseSurface(
        [
          "execute",
          "--plan",
          productionPlanPath,
          "--confirm",
          productionPlan.confirmation as string,
          "--review",
          "operator:reviewer@example.com",
          "--evidence",
          join(root, "production-evidence-must-not-exist.json"),
        ],
        "production",
        {
          ...productionDependencies,
          applySchema: async (...args) => {
            productionApplyCalls += 1;
            return await applyControlD1Schema(...args);
          },
        },
      ),
    ).rejects.toThrow(
      "control_d1_schema_release_staging_receipt_authority_invalid",
    );
    expect(productionApplyCalls).toBe(0);
    expect((await readControlD1MigrationLedger(productionDatabase)).at(-1)?.version).toBe(66);
  } finally {
    stagingDatabase.close();
    productionDatabase.close();
  }
});

test("production never accepts observed-ready staging adoption as an execution receipt", async () => {
  const root = privateRoot();
  const planPath = join(root, "production-plan.json");
  const adoptionPath = join(root, "staging-adoption.json");
  const productionDatabase = await predecessorDatabase();
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const proofPath = await servingCompatibilityProof(root, "production");
  writeFileSync(
    adoptionPath,
    `${JSON.stringify({
      kind: "takosumi.control-d1-schema-adoption-evidence@v1",
      status: "observed-ready",
      environment: "staging",
      finalMigrationVersion: 67,
      finalMigrationCount: 64,
      finalTableCount: 38,
    })}\n`,
    { flag: "wx", mode: 0o600 },
  );
  try {
    await expect(
      runReleaseSurface(
        [
          "plan",
          "--plan-out",
          planPath,
          "--serving-compatibility-proof",
          proofPath,
          "--staging-plan",
          adoptionPath,
          "--staging-receipt",
          adoptionPath,
        ],
        "production",
        dependencies(productionDatabase, calls, "production"),
      ),
    ).rejects.toThrow("control_d1_schema_release_staging_receipt_invalid");
    expect(existsSync(planPath)).toBeFalse();
  } finally {
    productionDatabase.close();
  }
});

test("production rejects a hand-authored official receipt without the rehearsal mutation authority", async () => {
  const root = privateRoot();
  const stagingPlanPath = join(root, "staging-plan.json");
  const forgedReceiptPath = join(root, "forged-staging-receipt.json");
  const productionPlanPath = join(root, "production-plan.json");
  const stagingDatabase = await predecessorDatabase();
  const productionDatabase = await predecessorDatabase();
  const stagingCalls: Array<{ url: string; authorization: string | null }> = [];
  const productionCalls: Array<{ url: string; authorization: string | null }> =
    [];
  const stagingProofPath = await servingCompatibilityProof(root);
  const productionProofPath = await servingCompatibilityProof(
    root,
    "production",
  );
  try {
    await runReleaseSurface(
      [
        "plan",
        "--plan-out",
        stagingPlanPath,
        "--serving-compatibility-proof",
        stagingProofPath,
      ],
      "staging",
      dependencies(stagingDatabase, stagingCalls),
    );
    const stagingPlan = JSON.parse(
      readFileSync(stagingPlanPath, "utf8"),
    ) as Record<string, any>;
    const stagingProof = JSON.parse(
      readFileSync(stagingPlan.servingCompatibilityProofPath, "utf8"),
    ) as Record<string, any>;
    const forgedChallengeResponse = {
      kind: "takosumi.control-d1-schema-compatibility-challenge@v1",
      status: "ready",
      nonce: "e".repeat(64),
      environment: "staging",
      workerVersionId: stagingPlan.target.servingVersionId,
      schemaMode: "predeployed-bridge",
      accepted: {
        migrationVersion: stagingProof.candidate.migrationVersion,
        ledgerDigest: stagingProof.candidate.ledgerDigest,
      },
      allowset: [stagingProof.predecessor, stagingProof.candidate].map(
        ({ migrationVersion, ledgerDigest }) => ({
          migrationVersion,
          ledgerDigest,
        }),
      ),
    };
    writeFileSync(
      forgedReceiptPath,
      `${JSON.stringify(
        {
          kind: "takosumi.control-d1-schema-release-evidence@v3",
          status: "ready",
          completedAt: "2026-08-30T12:01:00.000Z",
          environment: "staging",
          sourceCommit: stagingPlan.sourceCommit,
          planConfirmation: stagingPlan.confirmation,
          targetDigest: stagingPlan.targetDigest,
          physicalTarget: {
            accountId: stagingPlan.target.accountId,
            databaseId: stagingPlan.target.databaseId,
          },
          credentialDigest: stagingPlan.credentialDigest,
          credentialCustodyDigest: stagingPlan.credentialCustodyDigest,
          timeTravelBookmarkDigest: stagingPlan.timeTravelBookmarkDigest,
          servingCompatibilityProofDigest:
            stagingPlan.servingCompatibilityProofDigest,
          bridgeSourceCompatibilityDigest:
            stagingPlan.bridgeSourceCompatibilityDigest,
          bridgePredecessorSourceCommit:
            stagingPlan.bridgeSourceCompatibility.predecessorSourceCommit,
          bridgeSourceCommit:
            stagingPlan.bridgeSourceCompatibility.bridgeSourceCommit,
          bridgeCompatibilityClosureDigest:
            stagingPlan.bridgeSourceCompatibility.compatibilityClosureDigest,
          compatibilityCatalogDigest:
            stagingProof.compatibilityCatalogDigest,
          predecessorChallenge: stagingProof.predecessorChallenge,
          candidateChallenge: {
            kind: "takosumi.control-d1-schema-compatibility-challenge-evidence@v1",
            observedAt: "2026-08-30T12:01:00.000Z",
            responseDigest: digestJson(forgedChallengeResponse),
            response: forgedChallengeResponse,
          },
          mutationCheckpointDigest: digestJson({ forged: "checkpoint" }),
          maintenanceReleaseReceiptDigest: digestJson({
            forged: "maintenance-release",
          }),
          stagingRehearsalReceiptDigest: null,
          manifestDigest: stagingPlan.manifestDigest,
          schemaDigest: stagingPlan.schemaDigest,
          ledgerDigest: stagingPlan.ledgerDigest,
          appliedMigrationVersions: [67],
          finalMigrationVersion: 67,
          finalMigrationCount: 64,
          finalTableCount: 38,
          reviewer: "operator:receipt-forger@example.com",
          maintenanceStatus: "inactive",
          recovery: {
            surface: "takosumi-control-d1-schema-staging",
            action: "recover",
            timeTravelRestoreAuthority: "separate-incident-boundary",
          },
        },
        null,
        2,
      )}\n`,
      { flag: "wx", mode: 0o600 },
    );

    await expect(
      runReleaseSurface(
        [
          "plan",
          "--plan-out",
          productionPlanPath,
          "--staging-plan",
          stagingPlanPath,
          "--staging-receipt",
          forgedReceiptPath,
          "--serving-compatibility-proof",
          productionProofPath,
        ],
        "production",
        dependencies(productionDatabase, productionCalls, "production"),
      ),
    ).rejects.toThrow(
      "control_d1_schema_release_staging_receipt_authority_invalid",
    );
    expect(existsSync(productionPlanPath)).toBeFalse();
  } finally {
    stagingDatabase.close();
    productionDatabase.close();
  }
});

test("production rejects a rewritten checkpoint and receipt layered onto genuine staging readback", async () => {
  const root = privateRoot();
  const stagingPlanPath = join(root, "staging-plan.json");
  const stagingEvidencePath = join(root, "staging-evidence.json");
  const productionPlanPath = join(root, "production-plan.json");
  const stagingDatabase = await predecessorDatabase();
  const productionDatabase = await predecessorDatabase();
  const stagingCalls: Array<{ url: string; authorization: string | null }> = [];
  const productionCalls: Array<{ url: string; authorization: string | null }> =
    [];
  const stagingProofPath = await servingCompatibilityProof(root);
  const productionProofPath = await servingCompatibilityProof(
    root,
    "production",
  );
  try {
    const stagingDependencies = dependencies(stagingDatabase, stagingCalls);
    await runReleaseSurface(
      [
        "plan",
        "--plan-out",
        stagingPlanPath,
        "--serving-compatibility-proof",
        stagingProofPath,
      ],
      "staging",
      stagingDependencies,
    );
    const stagingPlan = JSON.parse(
      readFileSync(stagingPlanPath, "utf8"),
    ) as {
      readonly confirmation: string;
      readonly mutationCheckpointPath: string;
    };
    await runReleaseSurface(
      [
        "execute",
        "--plan",
        stagingPlanPath,
        "--confirm",
        stagingPlan.confirmation,
        "--review",
        "operator:reviewer@example.com",
        "--evidence",
        stagingEvidencePath,
      ],
      "staging",
      stagingDependencies,
    );

    const [startedLine, acceptedLine] = readFileSync(
      stagingPlan.mutationCheckpointPath,
      "utf8",
    )
      .trimEnd()
      .split("\n");
    const started = JSON.parse(startedLine!) as Record<string, unknown>;
    const rewrittenCheckpoint = `${JSON.stringify({
      recordedAt: started.recordedAt,
      predecessorChallengeEvidenceDigest:
        started.predecessorChallengeEvidenceDigest,
      planConfirmation: started.planConfirmation,
      outcome: started.outcome,
      kind: started.kind,
    })}\n${acceptedLine}\n`;
    writeFileSync(
      stagingPlan.mutationCheckpointPath,
      rewrittenCheckpoint,
      { mode: 0o600 },
    );
    const stagingEvidence = JSON.parse(
      readFileSync(stagingEvidencePath, "utf8"),
    ) as Record<string, unknown>;
    stagingEvidence.mutationCheckpointDigest = `sha256:${createHash("sha256")
      .update(rewrittenCheckpoint)
      .digest("hex")}`;
    writeFileSync(
      stagingEvidencePath,
      `${JSON.stringify(stagingEvidence, null, 2)}\n`,
      { mode: 0o600 },
    );

    await expect(
      runReleaseSurface(
        [
          "plan",
          "--plan-out",
          productionPlanPath,
          "--staging-plan",
          stagingPlanPath,
          "--staging-receipt",
          stagingEvidencePath,
          "--serving-compatibility-proof",
          productionProofPath,
        ],
        "production",
        dependencies(
          productionDatabase,
          productionCalls,
          "production",
          stagingDatabase,
        ),
      ),
    ).rejects.toThrow(
      "control_d1_schema_release_staging_receipt_authority_invalid",
    );
    expect(existsSync(productionPlanPath)).toBeFalse();
  } finally {
    stagingDatabase.close();
    productionDatabase.close();
  }
});

test("production rejects a staging rehearsal that reused the same physical target", async () => {
  const root = privateRoot();
  const stagingPlanPath = join(root, "staging-plan.json");
  const stagingEvidencePath = join(root, "staging-evidence.json");
  const productionPlanPath = join(root, "production-plan.json");
  const stagingDatabase = await predecessorDatabase();
  const productionDatabase = await predecessorDatabase();
  const stagingCalls: Array<{ url: string; authorization: string | null }> = [];
  const productionCalls: Array<{ url: string; authorization: string | null }> =
    [];
  const stagingProofPath = await servingCompatibilityProof(root);
  const productionProofPath = await servingCompatibilityProof(
    root,
    "production",
    { accountId: ACCOUNT_ID, databaseId: DATABASE_ID },
  );
  try {
    const stagingDependencies = dependencies(stagingDatabase, stagingCalls);
    await runReleaseSurface(
      [
        "plan",
        "--plan-out",
        stagingPlanPath,
        "--serving-compatibility-proof",
        stagingProofPath,
      ],
      "staging",
      stagingDependencies,
    );
    const stagingPlan = JSON.parse(readFileSync(stagingPlanPath, "utf8")) as {
      readonly confirmation: string;
    };
    await runReleaseSurface(
      [
        "execute",
        "--plan",
        stagingPlanPath,
        "--confirm",
        stagingPlan.confirmation,
        "--review",
        "operator:reviewer@example.com",
        "--evidence",
        stagingEvidencePath,
      ],
      "staging",
      stagingDependencies,
    );

    await expect(
      runReleaseSurface(
        [
          "plan",
          "--plan-out",
          productionPlanPath,
          "--staging-plan",
          stagingPlanPath,
          "--staging-receipt",
          stagingEvidencePath,
          "--serving-compatibility-proof",
          productionProofPath,
        ],
        "production",
        {
          ...dependencies(productionDatabase, productionCalls, "production"),
          env: {
            ...environment("staging"),
            TAKOSUMI_CONTROL_D1_PRODUCTION_CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
            TAKOSUMI_CONTROL_D1_PRODUCTION_DATABASE_ID: DATABASE_ID,
            TAKOSUMI_CONTROL_D1_PRODUCTION_CLOUDFLARE_API_TOKEN:
              PRODUCTION_TOKEN,
          },
          fetch: workerFetch(
            productionCalls,
            () => VERSION_ID,
            () => DATABASE_ID,
          ),
        },
      ),
    ).rejects.toThrow(
      "control_d1_schema_release_staging_rehearsal_isolation_invalid",
    );
    expect(existsSync(productionPlanPath)).toBeFalse();
  } finally {
    stagingDatabase.close();
    productionDatabase.close();
  }
});

test("production rejects reused staging credential custody for a distinct physical target", async () => {
  const root = privateRoot();
  const stagingPlanPath = join(root, "staging-plan.json");
  const stagingEvidencePath = join(root, "staging-evidence.json");
  const productionPlanPath = join(root, "production-plan.json");
  const stagingDatabase = await predecessorDatabase();
  const productionDatabase = await predecessorDatabase();
  const stagingCalls: Array<{ url: string; authorization: string | null }> = [];
  const productionCalls: Array<{ url: string; authorization: string | null }> =
    [];
  const stagingProofPath = await servingCompatibilityProof(root);
  const productionProofPath = await servingCompatibilityProof(
    root,
    "production",
  );
  try {
    const stagingDependencies = dependencies(stagingDatabase, stagingCalls);
    await runReleaseSurface(
      [
        "plan",
        "--plan-out",
        stagingPlanPath,
        "--serving-compatibility-proof",
        stagingProofPath,
      ],
      "staging",
      stagingDependencies,
    );
    const stagingPlan = JSON.parse(readFileSync(stagingPlanPath, "utf8")) as {
      readonly confirmation: string;
    };
    await runReleaseSurface(
      [
        "execute",
        "--plan",
        stagingPlanPath,
        "--confirm",
        stagingPlan.confirmation,
        "--review",
        "operator:reviewer@example.com",
        "--evidence",
        stagingEvidencePath,
      ],
      "staging",
      stagingDependencies,
    );

    await expect(
      runReleaseSurface(
        [
          "plan",
          "--plan-out",
          productionPlanPath,
          "--staging-plan",
          stagingPlanPath,
          "--staging-receipt",
          stagingEvidencePath,
          "--serving-compatibility-proof",
          productionProofPath,
        ],
        "production",
        {
          ...dependencies(productionDatabase, productionCalls, "production"),
          env: {
            ...environment("staging"),
            TAKOSUMI_CONTROL_D1_PRODUCTION_CLOUDFLARE_ACCOUNT_ID:
              PRODUCTION_ACCOUNT_ID,
            TAKOSUMI_CONTROL_D1_PRODUCTION_DATABASE_ID: PRODUCTION_DATABASE_ID,
            TAKOSUMI_CONTROL_D1_PRODUCTION_CLOUDFLARE_API_TOKEN: TOKEN,
          },
        },
      ),
    ).rejects.toThrow(
      "control_d1_schema_release_staging_rehearsal_isolation_invalid",
    );
    expect(existsSync(productionPlanPath)).toBeFalse();
  } finally {
    stagingDatabase.close();
    productionDatabase.close();
  }
});

test("recover leaves exact v66 without a fence untouched", async () => {
  const root = privateRoot();
  const planPath = join(root, "plan.json");
  const evidencePath = join(root, "recover-evidence.json");
  const database = await predecessorDatabase();
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const stdout: string[] = [];
  const proofPath = await servingCompatibilityProof(root);
  const deps = {
    ...dependencies(database, calls),
    write: (value: string) => stdout.push(value),
  };
  try {
    await runReleaseSurface(
      [
        "plan",
        "--plan-out",
        planPath,
        "--serving-compatibility-proof",
        proofPath,
      ],
      "staging",
      deps,
    );
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as {
      readonly confirmation: string;
      readonly mutationCheckpointPath: string;
    };
    stdout.length = 0;
    await runReleaseSurface(
      [
        "recover",
        "--plan",
        planPath,
        "--confirm",
        plan.confirmation,
        "--evidence",
        evidencePath,
      ],
      "staging",
      deps,
    );
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(evidence.status).toBe("untouched");
    expect(evidence.currentMigrationVersion).toBe(66);
    expect((await readControlD1MaintenanceState(database)).status).toBe(
      "absent",
    );
    expect((await readControlD1MigrationLedger(database)).at(-1)?.version).toBe(
      66,
    );
    expect(stdout.join("\n")).toContain('"status":"untouched"');
  } finally {
    database.close();
  }
});

test("exact schema recovery reconciles a dead pre-checkpoint owner before reporting v66 untouched", async () => {
  const root = privateRoot();
  const planPath = join(root, "plan.json");
  const evidencePath = join(root, "recover-evidence.json");
  const database = await predecessorDatabase();
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const proofPath = await servingCompatibilityProof(root);
  const deps = { ...dependencies(database, calls), write: () => {} };
  try {
    await runReleaseSurface(
      [
        "plan",
        "--plan-out",
        planPath,
        "--serving-compatibility-proof",
        proofPath,
      ],
      "staging",
      deps,
    );
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as {
      readonly confirmation: string;
      readonly mutationCheckpointPath: string;
      readonly target: { readonly workerName: string };
    };
    const actorPath = join(root, "crashed-schema-before-checkpoint.ts");
    const moduleUrl = pathToFileURL(
      join(import.meta.dir, "../../scripts/platform-worker-release.ts"),
    ).href;
    writeFileSync(
      actorPath,
      `import { withPlatformTargetMutationLock } from ${JSON.stringify(moduleUrl)};
const [confirmation, checkpointPath, workerName, authorityDirectory] = process.argv.slice(2);
await withPlatformTargetMutationLock(
  { environment: "staging", workerName, authorityDirectory },
  {
    operationKind: "control-d1-schema",
    planConfirmation: confirmation,
    checkpointPath,
    mode: "execute",
  },
  async () => process.exit(86),
);
`,
      { mode: 0o600 },
    );
    const crashed = Bun.spawn(
      [
        process.execPath,
        actorPath,
        plan.confirmation,
        plan.mutationCheckpointPath,
        plan.target.workerName,
        AUTHORITY_DIRECTORY,
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    expect(await subprocessExitWithin(crashed, 10_000)).toBe(86);
    expect(existsSync(plan.mutationCheckpointPath)).toBeFalse();
    expect(
      existsSync(
        platformTargetMutationLockPath({
          environment: "staging",
          workerName: plan.target.workerName,
          authorityDirectory: AUTHORITY_DIRECTORY,
        }),
      ),
    ).toBeTrue();

    await runReleaseSurface(
      [
        "recover",
        "--plan",
        planPath,
        "--confirm",
        plan.confirmation,
        "--evidence",
        evidencePath,
      ],
      "staging",
      deps,
    );
    expect(JSON.parse(readFileSync(evidencePath, "utf8"))).toMatchObject({
      status: "untouched",
      currentMigrationVersion: 66,
    });
    expect(
      existsSync(
        platformTargetMutationLockPath({
          environment: "staging",
          workerName: plan.target.workerName,
          authorityDirectory: AUTHORITY_DIRECTORY,
        }),
      ),
    ).toBeFalse();
  } finally {
    cleanupRetainedStagingTargetLock();
    database.close();
  }
}, 15_000);

test("recover rejects evidence that aliases the absent bridge restore checkpoint", async () => {
  const root = privateRoot();
  const planPath = join(root, "plan.json");
  const database = await predecessorDatabase();
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const proofPath = await servingCompatibilityProof(root);
  const proof = JSON.parse(readFileSync(proofPath, "utf8")) as {
    readonly bridgePlanPath: string;
    readonly bridgePlanConfirmation: string;
  };
  const restoreCheckpointPath = platformRestoreCheckpointPath(
    proof.bridgePlanPath,
    proof.bridgePlanConfirmation,
  );
  try {
    const deps = dependencies(database, calls);
    await runReleaseSurface(
      [
        "plan",
        "--plan-out",
        planPath,
        "--serving-compatibility-proof",
        proofPath,
      ],
      "staging",
      deps,
    );
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as {
      readonly confirmation: string;
    };
    await expect(
      runReleaseSurface(
        [
          "recover",
          "--plan",
          planPath,
          "--confirm",
          plan.confirmation,
          "--evidence",
          restoreCheckpointPath,
        ],
        "staging",
        deps,
      ),
    ).rejects.toThrow("control_d1_schema_release_artifact_path_alias");
    expect(existsSync(restoreCheckpointPath)).toBeFalse();
    expect(
      readPlatformRestoreFence(
        proof.bridgePlanPath,
        proof.bridgePlanConfirmation,
      ),
    ).toEqual({});
    expect((await readControlD1MigrationLedger(database)).at(-1)?.version).toBe(
      66,
    );
  } finally {
    database.close();
  }
});

test("recover releases only an exact active v67 fence after separate review", async () => {
  const root = privateRoot();
  const planPath = join(root, "plan.json");
  const evidencePath = join(root, "recover-evidence.json");
  const database = await predecessorDatabase();
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const stdout: string[] = [];
  let releaseCalls = 0;
  let competingForwardMutations = 0;
  const proofPath = await servingCompatibilityProof(root);
  const deps: ControlD1SchemaReleaseDependencies = {
    ...dependencies(database, calls),
    write: (value) => stdout.push(value),
    releaseFence: async (...args) => {
      await expect(
        withPlatformTargetMutationLock(
          {
            environment: "staging",
            workerName: "takosumi-staging",
            authorityDirectory: AUTHORITY_DIRECTORY,
          },
          competingPlatformTargetRequest(root, "fence-release-probe"),
          async () => {
            competingForwardMutations += 1;
          },
        ),
      ).rejects.toThrow("platform_worker_target_mutation_locked");
      releaseCalls += 1;
      await releaseControlD1MaintenanceFence(...args);
    },
  };
  try {
    await runReleaseSurface(
      [
        "plan",
        "--plan-out",
        planPath,
        "--serving-compatibility-proof",
        proofPath,
      ],
      "staging",
      deps,
    );
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as {
      readonly confirmation: string;
      readonly bridgeSourceCompatibilityDigest: string;
      readonly manifestDigest: string;
      readonly mutationCheckpointPath: string;
    };
    writeStartedMutationCheckpoint(
      plan.mutationCheckpointPath,
      plan.confirmation,
      plan.bridgeSourceCompatibilityDigest,
    );
    const candidate = await buildControlD1SchemaPlan();
    await applyControlD1Schema(database, candidate, {
      sourceCommit: COMMIT,
      environment: "staging",
      activatedAt: "2026-08-30T12:00:00.000Z",
      releasedAt: () => "2026-08-30T12:00:00.000Z",
      maintenanceDrainMilliseconds: 0,
      waitForRequestDrain: async () => {},
      retainMaintenanceFence: true,
      databaseRole: "in_place",
      releasePolicy: "in_place",
      databaseId: DATABASE_ID,
    });
    stdout.length = 0;

    await runReleaseSurface(
      [
        "recover",
        "--plan",
        planPath,
        "--confirm",
        plan.confirmation,
        "--evidence",
        evidencePath,
      ],
      "staging",
      deps,
    );
    expect(releaseCalls).toBe(0);
    expect(existsSync(evidencePath)).toBeFalse();
    const confirmationOutput = JSON.parse(stdout.at(-1)!) as {
      readonly status: string;
      readonly releaseConfirmation: string;
    };
    expect(confirmationOutput.status).toBe("release-confirmation-required");
    expect(confirmationOutput.releaseConfirmation).toMatch(
      /^sha256:[0-9a-f]{64}$/u,
    );

    stdout.length = 0;
    await runReleaseSurface(
      [
        "recover",
        "--plan",
        planPath,
        "--confirm",
        plan.confirmation,
        "--evidence",
        evidencePath,
        "--confirm-release",
        confirmationOutput.releaseConfirmation,
        "--review",
        "operator:reviewer@example.com",
      ],
      "staging",
      deps,
    );
    expect(releaseCalls).toBe(1);
    expect(competingForwardMutations).toBe(0);
    expect((await readControlD1MaintenanceState(database)).status).toBe(
      "inactive",
    );
    const evidenceText = readFileSync(evidencePath, "utf8");
    const evidence = JSON.parse(evidenceText) as Record<string, unknown>;
    expect(evidence.status).toBe("ready");
    expect(evidence.recoveryAction).toBe("released-existing-fence");
    expect(evidence.releaseConfirmation).toBe(
      confirmationOutput.releaseConfirmation,
    );
    for (const privateValue of [
      ACCOUNT_ID,
      DATABASE_ID,
      VERSION_ID,
      BOOKMARK,
      TOKEN,
    ]) {
      expect(evidenceText).not.toContain(privateValue);
      expect(stdout.join("\n")).not.toContain(privateValue);
    }
  } finally {
    database.close();
  }
});

test("lost apply acknowledgement never permits a second apply and recover reads ready state", async () => {
  const root = privateRoot();
  const planPath = join(root, "plan.json");
  const failedEvidencePath = join(root, "failed-evidence.json");
  const retryEvidencePath = join(root, "retry-evidence.json");
  const recoverEvidencePath = join(root, "recover-evidence.json");
  const database = await predecessorDatabase();
  const calls: Array<{ url: string; authorization: string | null }> = [];
  let applyCalls = 0;
  let probeRecoveryTargetLock = false;
  let competingForwardMutations = 0;
  const proofPath = await servingCompatibilityProof(root);
  const fetchWorker = workerFetch(
    calls,
    () => VERSION_ID,
    () => DATABASE_ID,
    () => "predeployed-bridge",
    async () =>
      (await readControlD1MigrationLedger(database)).at(-1)?.version === 67
        ? 67
        : 66,
  );
  const deps: ControlD1SchemaReleaseDependencies = {
    ...dependencies(database, calls),
    fetch: async (input, init) => {
      const request = new Request(input, init);
      if (probeRecoveryTargetLock && request.url.endsWith("/deployments")) {
        probeRecoveryTargetLock = false;
        await expect(
          withPlatformTargetMutationLock(
            {
              environment: "staging",
              workerName: "takosumi-staging",
              authorityDirectory: AUTHORITY_DIRECTORY,
            },
            competingPlatformTargetRequest(root, "recovery-probe"),
            async () => {
              competingForwardMutations += 1;
            },
          ),
        ).rejects.toThrow("platform_worker_target_mutation_locked");
      }
      return fetchWorker(request);
    },
    write: () => {},
    applySchema: async (...args) => {
      applyCalls += 1;
      await applyControlD1Schema(...args);
      throw new Error("simulated_acknowledgement_loss");
    },
  };
  try {
    await runReleaseSurface(
      [
        "plan",
        "--plan-out",
        planPath,
        "--serving-compatibility-proof",
        proofPath,
      ],
      "staging",
      deps,
    );
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as {
      readonly confirmation: string;
      readonly bridgeSourceCompatibilityDigest: string;
      readonly mutationCheckpointPath: string;
    };
    const executeArgs = (evidence: string) => [
      "execute",
      "--plan",
      planPath,
      "--confirm",
      plan.confirmation,
      "--review",
      "operator:reviewer@example.com",
      "--evidence",
      evidence,
    ];
    await expect(
      runReleaseSurface(executeArgs(failedEvidencePath), "staging", deps),
    ).rejects.toThrow("control_d1_schema_release_execute_incomplete");
    expect(applyCalls).toBe(1);
    expect(JSON.parse(readFileSync(failedEvidencePath, "utf8"))).toMatchObject({
      status: "incomplete",
      mutationOutcome: "unknown",
      failureBoundary: "post-mutation-unknown",
    });
    expect(existsSync(plan.mutationCheckpointPath)).toBeTrue();
    expect(
      existsSync(
        platformTargetMutationLockPath({
          environment: "staging",
          workerName: "takosumi-staging",
          authorityDirectory: AUTHORITY_DIRECTORY,
        }),
      ),
    ).toBeTrue();

    let otherPlanStarted = false;
    await expect(
      withPlatformTargetMutationLock(
        {
          environment: "staging",
          workerName: "takosumi-staging",
          authorityDirectory: AUTHORITY_DIRECTORY,
        },
        {
          ...competingPlatformTargetRequest(root, "other-schema-plan"),
          operationKind: "control-d1-schema",
          mode: "recover",
        },
        async () => {
          otherPlanStarted = true;
        },
      ),
    ).rejects.toThrow(
      "platform_worker_target_mutation_reconciliation_required",
    );
    expect(otherPlanStarted).toBeFalse();

    await expect(
      runReleaseSurface(executeArgs(retryEvidencePath), "staging", deps),
    ).rejects.toThrow(
      "platform_worker_target_mutation_reconciliation_required",
    );
    expect(applyCalls).toBe(1);
    expect(existsSync(retryEvidencePath)).toBeFalse();

    probeRecoveryTargetLock = true;
    await runReleaseSurface(
      [
        "recover",
        "--plan",
        planPath,
        "--confirm",
        plan.confirmation,
        "--evidence",
        recoverEvidencePath,
      ],
      "staging",
      deps,
    );
    expect(JSON.parse(readFileSync(recoverEvidencePath, "utf8"))).toMatchObject(
      {
        status: "ready",
        currentMigrationVersion: 67,
        recoveryAction: "observed-ready",
      },
    );
    expect(probeRecoveryTargetLock).toBeFalse();
    expect(competingForwardMutations).toBe(0);
    expect(
      existsSync(
        platformTargetMutationLockPath({
          environment: "staging",
          workerName: "takosumi-staging",
          authorityDirectory: AUTHORITY_DIRECTORY,
        }),
      ),
    ).toBeFalse();
  } finally {
    cleanupRetainedStagingTargetLock();
    database.close();
  }
}, 15_000);

test("v67 inactive recovery refuses an unresolved official restore checkpoint", async () => {
  const root = privateRoot();
  const planPath = join(root, "plan.json");
  const recoveryEvidencePath = join(root, "recovery-evidence.json");
  const database = await predecessorDatabase();
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const proofPath = await servingCompatibilityProof(root);
  const deps = {
    ...dependencies(database, calls),
    write: () => {},
  };
  try {
    await runReleaseSurface(
      [
        "plan",
        "--plan-out",
        planPath,
        "--serving-compatibility-proof",
        proofPath,
      ],
      "staging",
      deps,
    );
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as {
      readonly confirmation: string;
      readonly mutationCheckpointPath: string;
    };
    const proof = JSON.parse(readFileSync(proofPath, "utf8")) as {
      readonly bridgePlanPath: string;
      readonly bridgePlanConfirmation: string;
    };
    const candidate = await buildControlD1SchemaPlan();
    const releaseReadinessDigest = writeStartedMutationCheckpoint(
      plan.mutationCheckpointPath,
      plan.confirmation,
      plan.bridgeSourceCompatibilityDigest,
    );
    await applyControlD1Schema(database, candidate, {
      sourceCommit: COMMIT,
      environment: "staging",
      activatedAt: "2026-08-30T12:00:00.000Z",
      releasedAt: () => "2026-08-30T12:00:01.000Z",
      maintenanceDrainMilliseconds: 0,
      waitForRequestDrain: async () => {},
      retainMaintenanceFence: false,
      databaseRole: "in_place",
      releasePolicy: "in_place",
      databaseId: DATABASE_ID,
      releaseReadinessDigest,
    });
    appendPlatformRestoreFence(
      proof.bridgePlanPath,
      proof.bridgePlanConfirmation,
      "container",
      { outcome: "unknown", versionId: null },
    );
    appendPlatformRestoreFence(
      proof.bridgePlanPath,
      proof.bridgePlanConfirmation,
      "container",
      { outcome: "accepted", versionId: DRIFTED_VERSION_ID },
    );
    appendPlatformRestoreFence(
      proof.bridgePlanPath,
      proof.bridgePlanConfirmation,
      "worker",
      { outcome: "unknown", versionId: null },
    );

    await expect(
      runReleaseSurface(
        [
          "recover",
          "--plan",
          planPath,
          "--confirm",
          plan.confirmation,
          "--evidence",
          recoveryEvidencePath,
        ],
        "staging",
        deps,
      ),
    ).rejects.toThrow("control_d1_schema_release_recovery_blocked");
    expect(
      JSON.parse(readFileSync(recoveryEvidencePath, "utf8")),
    ).toMatchObject({
      status: "blocked",
      failureCode:
        "control_d1_schema_release_recovery_restore_reconciliation_required",
    });
    expect(
      existsSync(
        platformRestoreRetirementPath(
          proof.bridgePlanPath,
          proof.bridgePlanConfirmation,
        ),
      ),
    ).toBeFalse();
    expect((await readControlD1MigrationLedger(database)).at(-1)?.version).toBe(
      67,
    );
    expect((await readControlD1MaintenanceState(database)).status).toBe(
      "inactive",
    );
    expect(
      existsSync(
        platformTargetMutationLockPath({
          environment: "staging",
          workerName: "takosumi-staging",
          authorityDirectory: AUTHORITY_DIRECTORY,
        }),
      ),
    ).toBeTrue();
  } finally {
    cleanupRetainedStagingTargetLock();
    database.close();
  }
});

test("v67 inactive recovery rejects retained bridge proof drift before ready evidence", async () => {
  const root = privateRoot();
  const planPath = join(root, "plan.json");
  const executeEvidencePath = join(root, "execute-evidence.json");
  const recoveryEvidencePath = join(root, "recovery-evidence.json");
  const database = await predecessorDatabase();
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const proofPath = await servingCompatibilityProof(root);
  const deps = {
    ...dependencies(database, calls),
    write: () => {},
  };
  try {
    await runReleaseSurface(
      [
        "plan",
        "--plan-out",
        planPath,
        "--serving-compatibility-proof",
        proofPath,
      ],
      "staging",
      deps,
    );
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as {
      readonly confirmation: string;
    };
    await runReleaseSurface(
      [
        "execute",
        "--plan",
        planPath,
        "--confirm",
        plan.confirmation,
        "--review",
        "operator:reviewer@example.com",
        "--evidence",
        executeEvidencePath,
      ],
      "staging",
      deps,
    );

    const proof = JSON.parse(readFileSync(proofPath, "utf8")) as Record<
      string,
      unknown
    >;
    const { confirmation: _confirmation, ...identity } = proof;
    const changedIdentity = {
      ...identity,
      bridgeReleaseEvidenceDigest: digestJson({ bridge: "drifted-evidence" }),
    };
    writeFileSync(
      proofPath,
      `${JSON.stringify(
        {
          ...changedIdentity,
          confirmation: digestJson(changedIdentity),
        },
        null,
        2,
      )}\n`,
    );

    await expect(
      runReleaseSurface(
        [
          "recover",
          "--plan",
          planPath,
          "--confirm",
          plan.confirmation,
          "--evidence",
          recoveryEvidencePath,
        ],
        "staging",
        deps,
      ),
    ).rejects.toThrow("control_d1_schema_release_recovery_blocked");
    expect(
      JSON.parse(readFileSync(recoveryEvidencePath, "utf8")),
    ).toMatchObject({
      status: "blocked",
      failureCode:
        "control_d1_schema_release_recovery_compatibility_proof_drift",
    });
  } finally {
    cleanupRetainedStagingTargetLock();
    database.close();
  }
});

test("v67 inactive recovery rejects serving bridge Version drift before ready evidence", async () => {
  const root = privateRoot();
  const planPath = join(root, "plan.json");
  const executeEvidencePath = join(root, "execute-evidence.json");
  const recoveryEvidencePath = join(root, "recovery-evidence.json");
  const database = await predecessorDatabase();
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const proofPath = await servingCompatibilityProof(root);
  let servingVersionId = VERSION_ID;
  const deps = {
    ...dependencies(database, calls),
    fetch: workerFetch(
      calls,
      () => servingVersionId,
      () => DATABASE_ID,
      () => "predeployed-bridge",
      async () =>
        (await readControlD1MigrationLedger(database)).at(-1)?.version === 67
          ? 67
          : 66,
    ),
    write: () => {},
  };
  try {
    await runReleaseSurface(
      [
        "plan",
        "--plan-out",
        planPath,
        "--serving-compatibility-proof",
        proofPath,
      ],
      "staging",
      deps,
    );
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as {
      readonly confirmation: string;
    };
    await runReleaseSurface(
      [
        "execute",
        "--plan",
        planPath,
        "--confirm",
        plan.confirmation,
        "--review",
        "operator:reviewer@example.com",
        "--evidence",
        executeEvidencePath,
      ],
      "staging",
      deps,
    );

    servingVersionId = DRIFTED_VERSION_ID;
    await expect(
      runReleaseSurface(
        [
          "recover",
          "--plan",
          planPath,
          "--confirm",
          plan.confirmation,
          "--evidence",
          recoveryEvidencePath,
        ],
        "staging",
        deps,
      ),
    ).rejects.toThrow("control_d1_schema_release_recovery_blocked");
    expect(
      JSON.parse(readFileSync(recoveryEvidencePath, "utf8")),
    ).toMatchObject({
      status: "blocked",
      failureCode: "control_d1_schema_release_recovery_serving_version_drift",
    });
  } finally {
    cleanupRetainedStagingTargetLock();
    database.close();
  }
});

test("v67 inactive recovery rejects serving bridge D1 binding drift before ready evidence", async () => {
  const root = privateRoot();
  const planPath = join(root, "plan.json");
  const executeEvidencePath = join(root, "execute-evidence.json");
  const recoveryEvidencePath = join(root, "recovery-evidence.json");
  const database = await predecessorDatabase();
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const proofPath = await servingCompatibilityProof(root);
  let servingDatabaseId = DATABASE_ID;
  const deps = {
    ...dependencies(database, calls),
    fetch: workerFetch(
      calls,
      () => VERSION_ID,
      () => servingDatabaseId,
      () => "predeployed-bridge",
      async () =>
        (await readControlD1MigrationLedger(database)).at(-1)?.version === 67
          ? 67
          : 66,
    ),
    write: () => {},
  };
  try {
    await runReleaseSurface(
      [
        "plan",
        "--plan-out",
        planPath,
        "--serving-compatibility-proof",
        proofPath,
      ],
      "staging",
      deps,
    );
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as {
      readonly confirmation: string;
    };
    await runReleaseSurface(
      [
        "execute",
        "--plan",
        planPath,
        "--confirm",
        plan.confirmation,
        "--review",
        "operator:reviewer@example.com",
        "--evidence",
        executeEvidencePath,
      ],
      "staging",
      deps,
    );

    servingDatabaseId = "database_drifted";
    await expect(
      runReleaseSurface(
        [
          "recover",
          "--plan",
          planPath,
          "--confirm",
          plan.confirmation,
          "--evidence",
          recoveryEvidencePath,
        ],
        "staging",
        deps,
      ),
    ).rejects.toThrow("control_d1_schema_release_recovery_blocked");
    expect(
      JSON.parse(readFileSync(recoveryEvidencePath, "utf8")),
    ).toMatchObject({
      status: "blocked",
      failureCode: "control_d1_schema_release_recovery_serving_binding_drift",
    });
  } finally {
    cleanupRetainedStagingTargetLock();
    database.close();
  }
});

test("recover fails closed on a mismatched active fence and names Time Travel authority", async () => {
  const root = privateRoot();
  const planPath = join(root, "plan.json");
  const evidencePath = join(root, "blocked-evidence.json");
  const database = await predecessorDatabase();
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const stdout: string[] = [];
  const proofPath = await servingCompatibilityProof(root);
  const deps = {
    ...dependencies(database, calls),
    write: (value: string) => stdout.push(value),
  };
  try {
    await runReleaseSurface(
      [
        "plan",
        "--plan-out",
        planPath,
        "--serving-compatibility-proof",
        proofPath,
      ],
      "staging",
      deps,
    );
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as {
      readonly confirmation: string;
    };
    const candidate = await buildControlD1SchemaPlan();
    await applyControlD1Schema(database, candidate, {
      sourceCommit: "b".repeat(40),
      environment: "staging",
      activatedAt: "2026-08-30T12:00:00.000Z",
      releasedAt: () => "2026-08-30T12:00:00.000Z",
      maintenanceDrainMilliseconds: 0,
      waitForRequestDrain: async () => {},
      retainMaintenanceFence: true,
      databaseRole: "in_place",
      releasePolicy: "in_place",
      databaseId: DATABASE_ID,
    });
    stdout.length = 0;

    await expect(
      runReleaseSurface(
        [
          "recover",
          "--plan",
          planPath,
          "--confirm",
          plan.confirmation,
          "--evidence",
          evidencePath,
        ],
        "staging",
        deps,
      ),
    ).rejects.toThrow("control_d1_schema_release_recovery_blocked");
    const evidenceText = readFileSync(evidencePath, "utf8");
    expect(JSON.parse(evidenceText)).toMatchObject({
      status: "blocked",
      blindRetry: "forbidden",
      timeTravelRestoreAuthority: "separate-incident-authorization-required",
    });
    expect(stdout.join("\n")).toContain(
      '"timeTravelRestoreAuthority":"separate-incident-authorization-required"',
    );
    for (const privateValue of [
      ACCOUNT_ID,
      DATABASE_ID,
      VERSION_ID,
      BOOKMARK,
      TOKEN,
    ]) {
      expect(evidenceText).not.toContain(privateValue);
      expect(stdout.join("\n")).not.toContain(privateValue);
    }
  } finally {
    database.close();
  }
});
