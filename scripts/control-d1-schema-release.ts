import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

import type { D1Database } from "../worker/src/bindings.ts";
import {
  applyControlD1Schema,
  buildControlD1SchemaPlan,
  digestControlD1MaintenanceFence,
  type ControlD1MigrationLedgerRow,
  type ControlD1SchemaPlan,
  readControlD1MaintenanceState,
  readControlD1MigrationLedger,
  verifyControlD1Schema,
} from "../deploy/platform/control_d1_schema.ts";
import { CONTROL_D1_BRIDGE_CHALLENGE_PATH } from "../deploy/platform/control_d1_bridge_challenge.ts";
import { CloudflareControlD1RestDatabase } from "../deploy/platform/control_d1_schema_rest.ts";
import {
  releaseControlD1MaintenanceFence,
  readControlD1MaintenanceReleaseReceiptDetails,
  type ControlD1MaintenanceFence,
} from "../worker/src/d1_schema_maintenance.ts";
import {
  assertPlatformReleaseArtifactPathGraph,
  assertPlatformRestoreReconciled,
  assertPlatformTargetMutationAuthorityAvailable,
  platformTargetMutationIdentityFromEnvironment,
  platformTargetMutationAuthorityDirectoryIdentityDigest,
  platformTargetMutationLockPath,
  platformTargetForEnvironment,
  readPlatformReleaseReadyEvidenceAuthority,
  readPlatformReleasePlanMutationState,
  retirePlatformRestoreForControlD1Schema,
  withPlatformTargetMutationLock,
  withPlatformReleasePlanRestoreLock,
} from "./platform-worker-release.ts";

export type ControlD1SchemaReleaseEnvironment = "staging" | "production";

type SourceInspection = Readonly<{
  head: string;
  branch: string;
  clean: boolean;
  pushed: boolean;
  authorEmail: string;
}>;

type RemoteDatabase = Readonly<{
  database: D1Database;
  readTimeTravelBookmark: () => Promise<string>;
}>;

type ReleaseCredentials = Readonly<{
  accountId: string;
  databaseId: string;
  apiToken: string;
}>;

export interface ControlD1SchemaReleaseDependencies {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  readonly inspectSource?: () => SourceInspection | Promise<SourceInspection>;
  readonly createRemoteDatabase?: (
    credentials: ReleaseCredentials,
  ) => RemoteDatabase | Promise<RemoteDatabase>;
  readonly now?: () => string;
  readonly waitForRequestDrain?: (milliseconds: number) => Promise<void>;
  readonly applySchema?: typeof applyControlD1Schema;
  readonly releaseFence?: typeof releaseControlD1MaintenanceFence;
  /** Test seam; the CLI always uses the repository-backed Git validator. */
  readonly inspectBridgeSourceCompatibility?: (
    predecessorSourceCommit: string,
    bridgeSourceCommit: string,
    reviewer: string,
  ) => ControlD1BridgeSourceClosure;
  readonly write?: (value: string) => void;
}

type Target = Readonly<{
  workerName: string;
  bindingName: "TAKOSUMI_CONTROL_DB";
}>;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const GIT_TREE = /^[0-9a-f]{40}$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TARGETS = {
  staging: {
    workerName: "takosumi-staging",
    bindingName: "TAKOSUMI_CONTROL_DB",
  },
  production: {
    workerName: "takosumi",
    bindingName: "TAKOSUMI_CONTROL_DB",
  },
} as const satisfies Record<ControlD1SchemaReleaseEnvironment, Target>;

type PlanOptions = Readonly<{
  action: "plan";
  planOut: string;
  servingCompatibilityProof: string;
  stagingPlan?: string;
  stagingReceipt?: string;
}>;

type ExecuteOptions = Readonly<{
  action: "execute";
  plan: string;
  confirmation: string;
  reviewer: string;
  evidence: string;
}>;

type RecoverOptions = Readonly<{
  action: "recover";
  plan: string;
  confirmation: string;
  evidence: string;
  confirmRelease?: string;
  reviewer?: string;
}>;

type Options = PlanOptions | ExecuteOptions | RecoverOptions;

interface ControlD1SchemaReleasePlan {
  readonly kind: "takosumi.control-d1-schema-release-plan@v3";
  readonly createdAt: string;
  readonly environment: ControlD1SchemaReleaseEnvironment;
  readonly sourceCommit: string;
  readonly sourceBranch: string;
  readonly sourceAuthorEmail: string;
  readonly target: {
    readonly accountId: string;
    readonly databaseId: string;
    readonly workerName: string;
    readonly bindingName: "TAKOSUMI_CONTROL_DB";
    readonly servingVersionId: string;
  };
  readonly targetDigest: string;
  readonly credentialDigest: string;
  readonly credentialCustodyDigest: string;
  readonly bridgePlanPath: string;
  readonly bridgePlanConfirmation: string;
  readonly bridgeReleaseEvidencePath: string;
  readonly bridgeSourceCommit: string;
  readonly bridgeSourceCompatibility: ControlD1BridgeSourceCompatibility;
  readonly bridgeSourceCompatibilityDigest: string;
  readonly manifestDigest: string;
  readonly schemaDigest: string;
  readonly ledgerDigest: string;
  readonly predecessorManifestDigest: string;
  readonly predecessorSchemaDigest: string;
  readonly predecessorLedgerDigest: string;
  readonly currentMigrationVersion: 66;
  readonly currentMigrationCount: number;
  readonly currentTableCount: number;
  readonly currentLedger: readonly ControlD1MigrationLedgerRow[];
  readonly pendingMigrationVersions: readonly [67];
  readonly pendingLedger: readonly [ControlD1MigrationLedgerRow];
  readonly finalMigrationVersion: 67;
  readonly finalMigrationCount: 64;
  readonly finalTableCount: 38;
  readonly timeTravelBookmark: string;
  readonly timeTravelBookmarkDigest: string;
  readonly servingCompatibilityProofPath: string;
  readonly servingCompatibilityProofDigest: string;
  readonly servingCompatibilityProofConfirmation: string;
  readonly predecessorCompatibilityChallenge: ControlD1BridgeChallengeEvidence;
  readonly stagingRehearsalPlanPath: string | null;
  readonly stagingRehearsalPlanDigest: string | null;
  readonly stagingRehearsalPlanConfirmation: string | null;
  readonly stagingRehearsalCheckpointDigest: string | null;
  readonly stagingRehearsalReceiptPath: string | null;
  readonly stagingRehearsalReceiptDigest: string | null;
  readonly stagingRehearsalTarget: {
    readonly accountId: string;
    readonly databaseId: string;
    readonly targetDigest: string;
    readonly credentialCustodyDigest: string;
  } | null;
  readonly mutationCheckpointPath: string;
  readonly targetMutationAuthorityPath: string;
  readonly targetMutationAuthorityDirectoryIdentityDigest: string;
  readonly confirmation: string;
}

interface ControlD1BridgeChallengeResponse {
  readonly kind: "takosumi.control-d1-schema-compatibility-challenge@v1";
  readonly status: "ready";
  readonly nonce: string;
  readonly environment: ControlD1SchemaReleaseEnvironment;
  readonly workerVersionId: string;
  readonly bindingName: "TAKOSUMI_CONTROL_DB";
  readonly schemaMode: "predeployed-bridge";
  readonly ledger: readonly ControlD1MigrationLedgerRow[];
  readonly accepted: {
    readonly migrationVersion: 66 | 67;
    readonly ledgerDigest: string;
  };
  readonly allowset: readonly [
    { readonly migrationVersion: 66; readonly ledgerDigest: string },
    { readonly migrationVersion: 67; readonly ledgerDigest: string },
  ];
}

interface ControlD1BridgeChallengeEvidence {
  readonly kind: "takosumi.control-d1-schema-compatibility-challenge-evidence@v1";
  readonly observedAt: string;
  readonly responseDigest: string;
  readonly response: ControlD1BridgeChallengeResponse;
}

interface ControlD1BridgeSourceCommitClosureEntry {
  readonly sourceCommit: string;
  readonly parentSourceCommit: string;
  readonly treeObjectId: string;
  readonly canonicalPatchDigest: string;
  readonly changedPaths: readonly string[];
}

interface ControlD1BridgeSourceClosure {
  readonly kind: "takosumi.control-d1-bridge-source-compatibility@v2";
  readonly predecessorSourceCommit: string;
  readonly predecessorTreeObjectId: string;
  readonly bridgeSourceCommit: string;
  readonly commits: readonly ControlD1BridgeSourceCommitClosureEntry[];
  readonly compatibilityClosureDigest: string;
  readonly reviewer: string;
}

interface ControlD1BridgeSourceCompatibility
  extends ControlD1BridgeSourceClosure {
  readonly predecessorServingVersionId: string;
  readonly predecessorPlatformPlanPath: string;
  readonly predecessorPlatformPlanConfirmation: string;
  readonly predecessorPlatformReleaseEvidencePath: string;
  readonly predecessorPlatformReleaseEvidenceDigest: string;
}

interface ControlD1ServingCompatibilityProof {
  readonly kind: "takosumi.control-d1-serving-compatibility-proof@v3";
  readonly status: "ready";
  readonly completedAt: string;
  readonly environment: ControlD1SchemaReleaseEnvironment;
  readonly bridgeSourceCommit: string;
  readonly bridgePlanPath: string;
  readonly bridgePlanConfirmation: string;
  readonly bridgeReleaseEvidencePath: string;
  readonly bridgeReleaseEvidenceDigest: string;
  readonly bridgePlanDigest: string;
  readonly bridgeSourceCompatibility: ControlD1BridgeSourceCompatibility;
  readonly bridgeSourceCompatibilityDigest: string;
  readonly workerName: string;
  readonly bindingName: "TAKOSUMI_CONTROL_DB";
  readonly servingVersionId: string;
  readonly targetDigest: string;
  readonly schemaMode: "predeployed-bridge";
  readonly compatibilityCatalogDigest: string;
  readonly predecessorChallenge: ControlD1BridgeChallengeEvidence;
  readonly predecessor: {
    readonly migrationVersion: 66;
    readonly ledgerDigest: string;
    readonly status: "ready";
  };
  readonly candidate: {
    readonly migrationVersion: 67;
    readonly ledgerDigest: string;
    readonly status: "ready";
  };
  readonly reviewer: string;
  readonly confirmation: string;
}

export async function runControlD1SchemaRelease(
  argv: readonly string[],
  environment: ControlD1SchemaReleaseEnvironment = "staging",
  dependencies: ControlD1SchemaReleaseDependencies = {},
): Promise<void> {
  const options = parseArgs(argv, environment);
  if (options.action === "plan") {
    await createPlan(options, environment, dependencies);
  } else if (options.action === "execute") {
    await execute(options, environment, dependencies);
  } else {
    await recover(options, environment, dependencies);
  }
}

type ServingCompatibilityProofOptions = Readonly<{
  predecessorPlan: string;
  predecessorConfirmation: string;
  predecessorEvidence: string;
  bridgePlan: string;
  confirmation: string;
  bridgeEvidence: string;
  closureConfirmation: string;
  reviewer: string;
  proofOut: string;
}>;

/**
 * Official read-only bridge-proof producer. It changes no provider or D1
 * state; its only write is one new private proof artifact.
 */
export async function runControlD1ServingCompatibilityProof(
  argv: readonly string[],
  environment: ControlD1SchemaReleaseEnvironment = "staging",
  dependencies: ControlD1SchemaReleaseDependencies = {},
): Promise<void> {
  const options = parseServingCompatibilityProofArgs(argv);
  const targetMutationTarget = schemaTargetMutationIdentity(
    environment,
    dependencies,
  );
  assertPlatformTargetMutationAuthorityAvailable(targetMutationTarget);
  assertExternalAbsent(options.proofOut);
  try {
    assertPlatformReleaseArtifactPathGraph(
      options.predecessorPlan,
      options.predecessorConfirmation,
      [
        {
          label: "predecessor-release-evidence",
          path: options.predecessorEvidence,
        },
        { label: "bridge-plan", path: options.bridgePlan },
        { label: "bridge-release-evidence", path: options.bridgeEvidence },
        { label: "serving-compatibility-proof", path: options.proofOut },
      ],
    );
    assertPlatformReleaseArtifactPathGraph(
      options.bridgePlan,
      options.confirmation,
      [
        { label: "predecessor-plan", path: options.predecessorPlan },
        {
          label: "predecessor-release-evidence",
          path: options.predecessorEvidence,
        },
        { label: "bridge-release-evidence", path: options.bridgeEvidence },
        { label: "serving-compatibility-proof", path: options.proofOut },
      ],
    );
  } catch (error) {
    throw new Error(
      "control_d1_serving_compatibility_proof_artifact_path_alias",
      { cause: error },
    );
  }
  const bridge = readPlatformReleasePlanMutationState(
    options.bridgePlan,
    options.confirmation,
  );
  const evidence = readPlatformReleaseReadyEvidenceAuthority(
    options.bridgePlan,
    options.confirmation,
    options.bridgeEvidence,
  );
  const predecessorRelease = readPlatformReleasePlanMutationState(
    options.predecessorPlan,
    options.predecessorConfirmation,
  );
  const predecessorEvidence = readPlatformReleaseReadyEvidenceAuthority(
    options.predecessorPlan,
    options.predecessorConfirmation,
    options.predecessorEvidence,
  );
  if (
    bridge.authority.environment !== environment ||
    bridge.authority.targetMutationAuthorityPath !==
      platformTargetMutationLockPath(targetMutationTarget) ||
    bridge.authority.targetMutationAuthorityDirectoryIdentityDigest !==
      platformTargetMutationAuthorityDirectoryIdentityDigest(
        targetMutationTarget,
      ) ||
    bridge.fence?.outcome !== "accepted" ||
    bridge.fence.versionId !== evidence.deployedVersionId ||
    predecessorRelease.authority.environment !== environment ||
    predecessorRelease.authority.targetMutationAuthorityPath !==
      bridge.authority.targetMutationAuthorityPath ||
    predecessorRelease.authority
      .targetMutationAuthorityDirectoryIdentityDigest !==
      bridge.authority.targetMutationAuthorityDirectoryIdentityDigest ||
    predecessorRelease.fence?.outcome !== "accepted" ||
    predecessorRelease.fence.versionId !==
      predecessorEvidence.deployedVersionId ||
    predecessorEvidence.deployedVersionId !==
      bridge.authority.predecessorVersionId ||
    predecessorEvidence.sourceCommit !==
      predecessorRelease.authority.sourceCommit ||
    Date.parse(predecessorEvidence.completedAt) >
      Date.parse(evidence.completedAt)
  ) {
    throw new Error(
      "control_d1_serving_compatibility_proof_bridge_release_invalid",
    );
  }
  const bridgeSourceClosure = (
    dependencies.inspectBridgeSourceCompatibility ??
    inspectControlD1BridgeSourceCompatibility
  )(
    predecessorEvidence.sourceCommit,
    bridge.authority.sourceCommit,
    options.reviewer,
  );
  if (
    evidence.reviewer !== options.reviewer ||
    bridgeSourceClosure.compatibilityClosureDigest !==
      options.closureConfirmation
  ) {
    throw new Error(
      "control_d1_serving_compatibility_proof_source_review_invalid",
    );
  }
  const boundBridgeSourceCompatibility: ControlD1BridgeSourceCompatibility = {
    ...bridgeSourceClosure,
    predecessorServingVersionId: predecessorEvidence.deployedVersionId,
    predecessorPlatformPlanPath: options.predecessorPlan,
    predecessorPlatformPlanConfirmation: options.predecessorConfirmation,
    predecessorPlatformReleaseEvidencePath: options.predecessorEvidence,
    predecessorPlatformReleaseEvidenceDigest: predecessorEvidence.digest,
  };
  assertControlD1BridgeSourceCompatibility(boundBridgeSourceCompatibility, {
    predecessorSourceCommit: predecessorEvidence.sourceCommit,
    bridgeSourceCommit: bridge.authority.sourceCommit,
    predecessorServingVersionId: predecessorEvidence.deployedVersionId,
    predecessorPlatformPlanPath: options.predecessorPlan,
    predecessorPlatformPlanConfirmation: options.predecessorConfirmation,
    predecessorPlatformReleaseEvidencePath: options.predecessorEvidence,
    predecessorPlatformReleaseEvidenceDigest: predecessorEvidence.digest,
    reviewer: options.reviewer,
  });
  const credentials = releaseCredentials(
    environment,
    dependencies.env ?? process.env,
  );
  const target = TARGETS[environment];
  const serving = await readServingControlD1Binding(
    credentials,
    target,
    dependencies.fetch ?? fetch,
  );
  if (serving.versionId !== evidence.deployedVersionId) {
    throw new Error(
      "control_d1_serving_compatibility_proof_serving_version_invalid",
    );
  }
  const [candidate, predecessor] = await Promise.all([
    buildControlD1SchemaPlan(),
    buildControlD1SchemaPlan({ throughMigrationVersion: 66 }),
  ]);
  assertTask0042Candidate(candidate, predecessor);
  const predecessorChallenge = await readControlD1BridgeChallenge(
    environment,
    serving.versionId,
    predecessor.ledgerDigest,
    candidate.ledgerDigest,
    66,
    dependencies.fetch ?? fetch,
    dependencies.now ?? now,
    "control_d1_serving_compatibility_proof_challenge_invalid",
  );
  const completedAt = validTimestamp((dependencies.now ?? now)());
  if (Date.parse(evidence.completedAt) > Date.parse(completedAt)) {
    throw new Error(
      "control_d1_serving_compatibility_proof_bridge_release_invalid",
    );
  }
  const targetDigest = digestJson({
    environment,
    accountId: credentials.accountId,
    databaseId: credentials.databaseId,
    workerName: target.workerName,
    bindingName: target.bindingName,
    servingVersionId: serving.versionId,
  });
  const compatibilityCatalogDigest = controlD1CompatibilityCatalogDigest(
    predecessor.ledgerDigest,
    candidate.ledgerDigest,
  );
  const identity = {
    kind: "takosumi.control-d1-serving-compatibility-proof@v3" as const,
    status: "ready" as const,
    completedAt,
    environment,
    bridgeSourceCommit: bridge.authority.sourceCommit,
    bridgePlanPath: options.bridgePlan,
    bridgePlanConfirmation: bridge.authority.confirmation,
    bridgeReleaseEvidencePath: options.bridgeEvidence,
    bridgeReleaseEvidenceDigest: evidence.digest,
    bridgePlanDigest: digestBytes(readStablePrivateBytes(options.bridgePlan)),
    bridgeSourceCompatibility: boundBridgeSourceCompatibility,
    bridgeSourceCompatibilityDigest: digestJson(
      boundBridgeSourceCompatibility,
    ),
    workerName: target.workerName,
    bindingName: target.bindingName,
    servingVersionId: serving.versionId,
    targetDigest,
    schemaMode: serving.schemaMode,
    compatibilityCatalogDigest,
    predecessorChallenge,
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
    reviewer: evidence.reviewer,
  };
  const proof: ControlD1ServingCompatibilityProof = {
    ...identity,
    confirmation: digestJson(identity),
  };
  const serialized = `${JSON.stringify(proof, null, 2)}\n`;
  if (serialized.includes(credentials.apiToken)) {
    throw new Error(
      "control_d1_serving_compatibility_proof_token_serialization_blocked",
    );
  }
  writePrivate(options.proofOut, new TextEncoder().encode(serialized));
  writePublic(dependencies, {
    kind: proof.kind,
    status: proof.status,
    environment,
    bridgeReleaseEvidenceDigest: proof.bridgeReleaseEvidenceDigest,
    bridgeSourceCompatibilityDigest: proof.bridgeSourceCompatibilityDigest,
    compatibilityClosureDigest:
      proof.bridgeSourceCompatibility.compatibilityClosureDigest,
    predecessorLedgerDigest: proof.predecessor.ledgerDigest,
    candidateLedgerDigest: proof.candidate.ledgerDigest,
    confirmation: proof.confirmation,
  });
}

function parseServingCompatibilityProofArgs(
  argv: readonly string[],
): ServingCompatibilityProofOptions {
  const [action, ...rest] = argv;
  if (action !== "create") {
    throw new Error("control_d1_serving_compatibility_proof_action_invalid");
  }
  const values = argumentMap(rest);
  const allowed = [
    "--predecessor-plan",
    "--predecessor-confirm",
    "--predecessor-evidence",
    "--bridge-plan",
    "--confirm",
    "--bridge-evidence",
    "--confirm-closure",
    "--review",
    "--proof-out",
  ];
  if (
    values.size !== allowed.length ||
    allowed.some((key) => !values.has(key)) ||
    [...values.keys()].some((key) => !allowed.includes(key))
  ) {
    throw new Error(
      "control_d1_serving_compatibility_proof_arguments_invalid",
    );
  }
  return {
    predecessorPlan: absolute(values.get("--predecessor-plan")!),
    predecessorConfirmation: digestValue(
      values.get("--predecessor-confirm")!,
    ),
    predecessorEvidence: absolute(values.get("--predecessor-evidence")!),
    bridgePlan: absolute(values.get("--bridge-plan")!),
    confirmation: digestValue(values.get("--confirm")!),
    bridgeEvidence: absolute(values.get("--bridge-evidence")!),
    closureConfirmation: digestValue(values.get("--confirm-closure")!),
    reviewer: reviewerValue(values.get("--review")!),
    proofOut: absolute(values.get("--proof-out")!),
  };
}

async function recover(
  options: RecoverOptions,
  environment: ControlD1SchemaReleaseEnvironment,
  dependencies: ControlD1SchemaReleaseDependencies,
): Promise<void> {
  const targetMutationTarget = schemaTargetMutationIdentity(
    environment,
    dependencies,
  );
  assertExternalAbsent(options.evidence);
  const plan = readPlan(options.plan, options.confirmation, environment);
  assertSchemaTargetMutationAuthority(plan, targetMutationTarget);
  assertControlD1SchemaArtifactPathGraph({
    bridgePlanPath: plan.bridgePlanPath,
    bridgePlanConfirmation: plan.bridgePlanConfirmation,
    schemaPlanPath: options.plan,
    schemaCheckpointPath: plan.mutationCheckpointPath,
    servingCompatibilityProofPath: plan.servingCompatibilityProofPath,
    bridgeReleaseEvidencePath: plan.bridgeReleaseEvidencePath,
    predecessorPlatformPlanPath:
      plan.bridgeSourceCompatibility.predecessorPlatformPlanPath,
    predecessorPlatformPlanConfirmation:
      plan.bridgeSourceCompatibility.predecessorPlatformPlanConfirmation,
    predecessorPlatformReleaseEvidencePath:
      plan.bridgeSourceCompatibility.predecessorPlatformReleaseEvidencePath,
    evidencePath: options.evidence,
    ...stagingArtifactPaths(plan),
  });
  const credentials = releaseCredentials(
    environment,
    dependencies.env ?? process.env,
  );
  assertCredentialsMatchPlan(credentials, plan);
  const remote = await (
    dependencies.createRemoteDatabase ?? createRemoteDatabase
  )(credentials);

  // Recovery's first remote operation is an authoritative read. It never
  // infers state from an execute error, checkpoint, or intended migration.
  const [ledger, maintenance] = await Promise.all([
    readControlD1MigrationLedger(remote.database),
    readControlD1MaintenanceState(remote.database),
  ]);
  const { candidate, predecessor } = await assertPlanCandidate(plan);

  if (
    JSON.stringify(ledger) === JSON.stringify(plan.currentLedger) &&
    maintenance.status === "absent"
  ) {
    if (options.confirmRelease || options.reviewer) {
      await blockRecovery(
        options,
        plan,
        ledger,
        maintenance.status,
        dependencies,
        "control_d1_schema_release_recovery_confirmation_not_applicable",
      );
    }
    let retainTargetLockOnError = schemaMutationCheckpointExists(
      plan.mutationCheckpointPath,
    );
    await withPlatformTargetMutationLock(
      targetMutationTarget,
      schemaTargetMutationLockRequest(plan, "recover"),
      async () => {
        const [lockedLedger, lockedMaintenance] = await Promise.all([
          readControlD1MigrationLedger(remote.database),
          readControlD1MaintenanceState(remote.database),
        ]);
        if (
          JSON.stringify(lockedLedger) !==
            JSON.stringify(plan.currentLedger) ||
          lockedMaintenance.status !== "absent"
        ) {
          retainTargetLockOnError = true;
          await blockRecovery(
            options,
            plan,
            lockedLedger,
            lockedMaintenance.status,
            dependencies,
            "control_d1_schema_release_recovery_prestate_drift",
          );
        }
        await assertExactPredecessor(remote.database, predecessor, plan);
        writeRecoveryEvidence(options.evidence, {
          status: "untouched",
          environment,
          sourceCommit: plan.sourceCommit,
          planConfirmation: plan.confirmation,
          targetDigest: plan.targetDigest,
          manifestDigest: plan.manifestDigest,
          schemaDigest: plan.schemaDigest,
          ledgerDigest: plan.ledgerDigest,
          servingCompatibilityProofDigest:
            plan.servingCompatibilityProofDigest,
          bridgeSourceCompatibilityDigest:
            plan.bridgeSourceCompatibilityDigest,
          currentMigrationVersion: 66,
          currentMigrationCount: plan.currentMigrationCount,
          currentTableCount: plan.currentTableCount,
          maintenanceStatus: "absent",
          recoveryAction: "none",
        });
        writePublic(dependencies, {
          kind: "takosumi.control-d1-schema-recovery-evidence@v1",
          status: "untouched",
          environment,
          currentMigrationVersion: 66,
          planConfirmation: plan.confirmation,
          timeTravelRestoreAuthority: "separate-incident-boundary",
        });
      },
      {
        shouldRetainAfterError: () => retainTargetLockOnError,
      },
    );
    return;
  }

  if (
    JSON.stringify(ledger) === JSON.stringify(candidate.migrations) &&
    maintenance.status === "inactive"
  ) {
    if (options.confirmRelease || options.reviewer) {
      await blockRecovery(
        options,
        plan,
        ledger,
        maintenance.status,
        dependencies,
        "control_d1_schema_release_recovery_confirmation_not_applicable",
      );
    }
    await withPlatformTargetMutationLock(
      targetMutationTarget,
      schemaTargetMutationLockRequest(plan, "recover"),
      async () => {
        let startedMutationCheckpoint: ReturnType<
          typeof readStartedMutationCheckpoint
        >;
        try {
          startedMutationCheckpoint = readStartedMutationCheckpoint(
            plan.mutationCheckpointPath,
            plan.confirmation,
            plan.bridgeSourceCompatibilityDigest,
          );
          const maintenanceRelease =
            await readControlD1MaintenanceReleaseReceiptDetails(
              remote.database,
            );
          if (
            maintenanceRelease === null ||
            !fenceMatchesPlan(maintenanceRelease.fence, plan) ||
            maintenanceRelease.releaseReadinessDigest !==
              startedMutationCheckpoint.releaseReadinessDigest
          ) {
            throw new Error("release_receipt_invalid");
          }
        } catch {
          await blockRecovery(
            options,
            plan,
            ledger,
            maintenance.status,
            dependencies,
            "control_d1_schema_release_recovery_release_receipt_invalid",
          );
        }
        await assertRecoveryServingCompatibility(
          options,
          plan,
          candidate,
          predecessor,
          credentials,
          ledger,
          maintenance.status,
          dependencies,
        );
        await assertExactCandidate(remote.database, candidate, false);
        writeRecoveryEvidence(options.evidence, {
          status: "ready",
          environment,
          sourceCommit: plan.sourceCommit,
          planConfirmation: plan.confirmation,
          targetDigest: plan.targetDigest,
          manifestDigest: plan.manifestDigest,
          schemaDigest: plan.schemaDigest,
          ledgerDigest: plan.ledgerDigest,
          servingCompatibilityProofDigest: plan.servingCompatibilityProofDigest,
          bridgeSourceCompatibilityDigest:
            plan.bridgeSourceCompatibilityDigest,
          currentMigrationVersion: 67,
          currentMigrationCount: 64,
          currentTableCount: 38,
          maintenanceStatus: "inactive",
          recoveryAction: "observed-ready",
        });
        writePublic(dependencies, {
          kind: "takosumi.control-d1-schema-recovery-evidence@v1",
          status: "ready",
          environment,
          currentMigrationVersion: 67,
          currentMigrationCount: 64,
          currentTableCount: 38,
          planConfirmation: plan.confirmation,
        });
      },
      { shouldRetainAfterError: () => true },
    );
    return;
  }

  if (
    JSON.stringify(ledger) === JSON.stringify(candidate.migrations) &&
    maintenance.status === "active" &&
    fenceMatchesPlan(maintenance.fence, plan)
  ) {
    await assertExactCandidate(remote.database, candidate, true);
    const fenceDigest = await digestControlD1MaintenanceFence(
      maintenance.fence,
    );
    const releaseConfirmation = digestJson({
      kind: "takosumi.control-d1-schema-fence-release-confirmation@v1",
      environment,
      planConfirmation: plan.confirmation,
      fenceDigest,
      ledgerDigest: plan.ledgerDigest,
    });
    if (!options.confirmRelease && !options.reviewer) {
      writePublic(dependencies, {
        kind: "takosumi.control-d1-schema-recovery@v1",
        status: "release-confirmation-required",
        environment,
        currentMigrationVersion: 67,
        releaseConfirmation,
        planConfirmation: plan.confirmation,
      });
      return;
    }
    if (
      options.confirmRelease !== releaseConfirmation ||
      options.reviewer === undefined
    ) {
      await blockRecovery(
        options,
        plan,
        ledger,
        maintenance.status,
        dependencies,
        "control_d1_schema_release_recovery_confirmation_mismatch",
      );
    }
    assertReviewer(options.reviewer, plan.sourceAuthorEmail);
    const source = await (
      dependencies.inspectSource ?? inspectSourceCheckout
    )();
    assertSourceReady(source);
    if (
      source.head !== plan.sourceCommit ||
      source.branch !== plan.sourceBranch ||
      source.authorEmail !== plan.sourceAuthorEmail
    ) {
      await blockRecovery(
        options,
        plan,
        ledger,
        maintenance.status,
        dependencies,
        "control_d1_schema_release_recovery_source_drift",
      );
    }
    await withPlatformTargetMutationLock(
      targetMutationTarget,
      schemaTargetMutationLockRequest(plan, "recover"),
      async () => {
        let startedMutationCheckpoint: ReturnType<
          typeof readStartedMutationCheckpoint
        >;
        try {
          startedMutationCheckpoint = readStartedMutationCheckpoint(
            plan.mutationCheckpointPath,
            plan.confirmation,
            plan.bridgeSourceCompatibilityDigest,
          );
          if (startedMutationCheckpoint.acceptedAt !== undefined) {
            throw new Error("active_checkpoint_already_accepted");
          }
        } catch {
          await blockRecovery(
            options,
            plan,
            ledger,
            maintenance.status,
            dependencies,
            "control_d1_schema_release_recovery_checkpoint_invalid",
          );
        }
        await assertRecoveryServingCompatibility(
          options,
          plan,
          candidate,
          predecessor,
          credentials,
          ledger,
          maintenance.status,
          dependencies,
        );
        const stateImmediatelyBeforeRelease =
          await readControlD1MaintenanceState(remote.database);
        const ledgerImmediatelyBeforeRelease =
          await readControlD1MigrationLedger(remote.database);
        if (
          stateImmediatelyBeforeRelease.status !== "active" ||
          (await digestControlD1MaintenanceFence(
            stateImmediatelyBeforeRelease.fence,
          )) !== fenceDigest ||
          JSON.stringify(ledgerImmediatelyBeforeRelease) !==
            JSON.stringify(candidate.migrations)
        ) {
          await blockRecovery(
            options,
            plan,
            ledgerImmediatelyBeforeRelease,
            stateImmediatelyBeforeRelease.status,
            dependencies,
            "control_d1_schema_release_recovery_prestate_drift",
          );
        }
        let lostReleaseAcknowledgement = false;
        try {
          await (dependencies.releaseFence ?? releaseControlD1MaintenanceFence)(
            remote.database,
            stateImmediatelyBeforeRelease.fence,
            validTimestamp((dependencies.now ?? now)()),
            {
              releaseReadinessDigest:
                startedMutationCheckpoint.releaseReadinessDigest,
            },
          );
        } catch {
          // The release batch may have committed before transport acknowledgement
          // was lost. Never retry it: read the authoritative fence and schema.
          const observed = await readControlD1MaintenanceState(remote.database);
          if (observed.status !== "inactive") {
            await blockRecovery(
              options,
              plan,
              await readControlD1MigrationLedger(remote.database),
              observed.status,
              dependencies,
              "control_d1_schema_release_recovery_release_indeterminate",
            );
          }
          await assertExactCandidate(remote.database, candidate, false);
          lostReleaseAcknowledgement = true;
        }
        const releasedState = await readControlD1MaintenanceState(
          remote.database,
        );
        if (releasedState.status !== "inactive") {
          await blockRecovery(
            options,
            plan,
            candidate.migrations,
            releasedState.status,
            dependencies,
            "control_d1_schema_release_recovery_release_readback_failed",
          );
        }
        await assertExactCandidate(remote.database, candidate, false);
        const maintenanceRelease =
          await readControlD1MaintenanceReleaseReceiptDetails(remote.database);
        if (
          maintenanceRelease === null ||
          !fenceMatchesPlan(maintenanceRelease.fence, plan) ||
          maintenanceRelease.releaseReadinessDigest !==
            startedMutationCheckpoint.releaseReadinessDigest
        ) {
          await blockRecovery(
            options,
            plan,
            candidate.migrations,
            releasedState.status,
            dependencies,
            "control_d1_schema_release_recovery_release_receipt_invalid",
          );
        }
        writeRecoveryEvidence(options.evidence, {
          status: "ready",
          environment,
          sourceCommit: plan.sourceCommit,
          planConfirmation: plan.confirmation,
          targetDigest: plan.targetDigest,
          manifestDigest: plan.manifestDigest,
          schemaDigest: plan.schemaDigest,
          ledgerDigest: plan.ledgerDigest,
          servingCompatibilityProofDigest: plan.servingCompatibilityProofDigest,
          bridgeSourceCompatibilityDigest:
            plan.bridgeSourceCompatibilityDigest,
          currentMigrationVersion: 67,
          currentMigrationCount: 64,
          currentTableCount: 38,
          maintenanceStatus: "inactive",
          recoveryAction: "released-existing-fence",
          releaseConfirmation,
          reviewer: options.reviewer,
          lostReleaseAcknowledgement,
        });
        writePublic(dependencies, {
          kind: "takosumi.control-d1-schema-recovery-evidence@v1",
          status: "ready",
          environment,
          currentMigrationVersion: 67,
          recoveryAction: "released-existing-fence",
          releaseConfirmation,
          lostReleaseAcknowledgement,
          planConfirmation: plan.confirmation,
        });
      },
      { shouldRetainAfterError: () => true },
    );
    return;
  }

  await blockRecovery(
    options,
    plan,
    ledger,
    maintenance.status,
    dependencies,
    "control_d1_schema_release_recovery_state_unrecognized",
  );
}

async function assertRecoveryServingCompatibility(
  options: RecoverOptions,
  plan: ControlD1SchemaReleasePlan,
  candidate: ControlD1SchemaPlan,
  predecessor: ControlD1SchemaPlan,
  credentials: ReleaseCredentials,
  ledger: readonly ControlD1MigrationLedgerRow[],
  maintenanceStatus: "inactive" | "active",
  dependencies: ControlD1SchemaReleaseDependencies,
): Promise<void> {
  let compatibility: ControlD1ServingCompatibilityProof;
  try {
    compatibility = assertPlanServingCompatibilityProof(
      plan,
      candidate,
      predecessor,
      dependencies,
    );
  } catch {
    await blockRecovery(
      options,
      plan,
      ledger,
      maintenanceStatus,
      dependencies,
      "control_d1_schema_release_recovery_compatibility_proof_drift",
    );
  }
  try {
    await withPlatformReleasePlanRestoreLock(
      compatibility.bridgePlanPath,
      compatibility.bridgePlanConfirmation,
      {
        environment: plan.environment,
        sourceCommit: compatibility.bridgeSourceCommit,
      },
      async () => {
        let serving: Awaited<ReturnType<typeof readServingControlD1Binding>>;
        try {
          serving = await readServingControlD1Binding(
            credentials,
            TARGETS[plan.environment],
            dependencies.fetch ?? fetch,
          );
        } catch (error) {
          if (
            error instanceof Error &&
            error.message ===
              "control_d1_schema_release_worker_binding_mismatch"
          ) {
            await blockRecovery(
              options,
              plan,
              ledger,
              maintenanceStatus,
              dependencies,
              "control_d1_schema_release_recovery_serving_binding_drift",
            );
          }
          throw error;
        }
        if (serving.versionId !== plan.target.servingVersionId) {
          await blockRecovery(
            options,
            plan,
            ledger,
            maintenanceStatus,
            dependencies,
            "control_d1_schema_release_recovery_serving_version_drift",
          );
        }
        try {
          const lockedCompatibility = assertPlanServingCompatibilityProof(
            plan,
            candidate,
            predecessor,
            dependencies,
          );
          if (
            lockedCompatibility.bridgePlanPath !==
              compatibility.bridgePlanPath ||
            lockedCompatibility.bridgePlanConfirmation !==
              compatibility.bridgePlanConfirmation
          ) {
            throw new Error("compatibility_identity_drift");
          }
        } catch {
          await blockRecovery(
            options,
            plan,
            ledger,
            maintenanceStatus,
            dependencies,
            "control_d1_schema_release_recovery_compatibility_proof_drift",
          );
        }
        try {
          await readControlD1BridgeChallenge(
            plan.environment,
            serving.versionId,
            predecessor.ledgerDigest,
            candidate.ledgerDigest,
            67,
            dependencies.fetch ?? fetch,
            dependencies.now ?? now,
            "control_d1_schema_release_recovery_serving_challenge_invalid",
          );
        } catch {
          await blockRecovery(
            options,
            plan,
            ledger,
            maintenanceStatus,
            dependencies,
            "control_d1_schema_release_recovery_serving_challenge_invalid",
          );
        }
        try {
          assertPlatformRestoreReconciled(
            compatibility.bridgePlanPath,
            compatibility.bridgePlanConfirmation,
          );
        } catch {
          await blockRecovery(
            options,
            plan,
            ledger,
            maintenanceStatus,
            dependencies,
            "control_d1_schema_release_recovery_restore_reconciliation_required",
          );
        }
        retirePlatformRestoreForControlD1Schema(
          compatibility.bridgePlanPath,
          compatibility.bridgePlanConfirmation,
          {
            environment: plan.environment,
            bridgeSourceCommit: compatibility.bridgeSourceCommit,
            servingBridgeVersionId: plan.target.servingVersionId,
            targetDigest: plan.targetDigest,
            candidateMigrationVersion: 67,
            candidateLedgerDigest: plan.ledgerDigest,
            recordedAt: validTimestamp((dependencies.now ?? now)()),
          },
        );
      },
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "control_d1_schema_release_recovery_blocked"
    ) {
      throw error;
    }
    await blockRecovery(
      options,
      plan,
      ledger,
      maintenanceStatus,
      dependencies,
      "control_d1_schema_release_recovery_bridge_restore_authority_unavailable",
    );
  }
}

async function execute(
  options: ExecuteOptions,
  environment: ControlD1SchemaReleaseEnvironment,
  dependencies: ControlD1SchemaReleaseDependencies,
): Promise<void> {
  const targetMutationTarget = schemaTargetMutationIdentity(
    environment,
    dependencies,
  );
  assertExternalAbsent(options.evidence);
  const plan = readPlan(options.plan, options.confirmation, environment);
  assertSchemaTargetMutationAuthority(plan, targetMutationTarget);
  assertControlD1SchemaArtifactPathGraph({
    bridgePlanPath: plan.bridgePlanPath,
    bridgePlanConfirmation: plan.bridgePlanConfirmation,
    schemaPlanPath: options.plan,
    schemaCheckpointPath: plan.mutationCheckpointPath,
    servingCompatibilityProofPath: plan.servingCompatibilityProofPath,
    bridgeReleaseEvidencePath: plan.bridgeReleaseEvidencePath,
    predecessorPlatformPlanPath:
      plan.bridgeSourceCompatibility.predecessorPlatformPlanPath,
    predecessorPlatformPlanConfirmation:
      plan.bridgeSourceCompatibility.predecessorPlatformPlanConfirmation,
    predecessorPlatformReleaseEvidencePath:
      plan.bridgeSourceCompatibility.predecessorPlatformReleaseEvidencePath,
    evidencePath: options.evidence,
    ...stagingArtifactPaths(plan),
  });
  assertReviewer(options.reviewer, plan.sourceAuthorEmail);
  const source = await (dependencies.inspectSource ?? inspectSourceCheckout)();
  assertSourceReady(source);
  if (
    source.head !== plan.sourceCommit ||
    source.branch !== plan.sourceBranch ||
    source.authorEmail !== plan.sourceAuthorEmail
  ) {
    throw new Error("control_d1_schema_release_source_drift");
  }
  const credentials = releaseCredentials(
    environment,
    dependencies.env ?? process.env,
  );
  assertCredentialsMatchPlan(credentials, plan);
  const remote = await (
    dependencies.createRemoteDatabase ?? createRemoteDatabase
  )(credentials);
  const { candidate, predecessor } = await assertPlanCandidate(plan);
  const compatibility = assertPlanServingCompatibilityProof(
    plan,
    candidate,
    predecessor,
    dependencies,
  );
  await assertPlanStagingReceiptAuthority(
    plan,
    candidate,
    source,
    credentials,
    dependencies,
  );
  await withPlatformTargetMutationLock(
    targetMutationTarget,
    schemaTargetMutationLockRequest(plan, "execute"),
    () =>
      withPlatformReleasePlanRestoreLock(
        compatibility.bridgePlanPath,
        compatibility.bridgePlanConfirmation,
        {
          environment,
          sourceCommit: compatibility.bridgeSourceCommit,
        },
        async () => {
          const lockedCompatibility = assertPlanServingCompatibilityProof(
            plan,
            candidate,
            predecessor,
            dependencies,
          );
          if (
            lockedCompatibility.bridgePlanPath !==
              compatibility.bridgePlanPath ||
            lockedCompatibility.bridgePlanConfirmation !==
              compatibility.bridgePlanConfirmation
          ) {
            throw new Error(
              "control_d1_schema_release_serving_compatibility_proof_drift",
            );
          }
          const target = TARGETS[environment];
          const serving = await readServingControlD1Binding(
            credentials,
            target,
            dependencies.fetch ?? fetch,
          );
          if (serving.versionId !== plan.target.servingVersionId) {
            throw new Error("control_d1_schema_release_serving_version_drift");
          }
          const executionPredecessorChallenge =
            await readControlD1BridgeChallenge(
            environment,
            serving.versionId,
            predecessor.ledgerDigest,
            candidate.ledgerDigest,
            66,
            dependencies.fetch ?? fetch,
            dependencies.now ?? now,
            "control_d1_schema_release_serving_compatibility_challenge_invalid",
          );
          await assertPlanStagingReceiptAuthority(
            plan,
            candidate,
            source,
            credentials,
            dependencies,
          );
          await assertExactPredecessor(remote.database, predecessor, plan);
          const bookmark = validBookmark(await remote.readTimeTravelBookmark());
          if (bookmark !== plan.timeTravelBookmark) {
            throw new Error("control_d1_schema_release_bookmark_drift");
          }
          try {
            assertPlatformRestoreReconciled(
              compatibility.bridgePlanPath,
              compatibility.bridgePlanConfirmation,
            );
          } catch (error) {
            throw new Error(
              "control_d1_schema_release_restore_reconciliation_required",
              { cause: error },
            );
          }

          // Permanently retire this bridge plan's v66-only predecessor restore
          // while holding the shared target lock outside the plan-scoped restore
          // authority. Any forward or restore path that won the target lock first
          // must finish before the serving-Version recheck above; a later path
          // cannot enter provider mutation until exact v67 readback completes.
          retirePlatformRestoreForControlD1Schema(
            compatibility.bridgePlanPath,
            compatibility.bridgePlanConfirmation,
            {
              environment,
              bridgeSourceCommit: compatibility.bridgeSourceCommit,
              servingBridgeVersionId: plan.target.servingVersionId,
              targetDigest: plan.targetDigest,
              candidateMigrationVersion: 67,
              candidateLedgerDigest: plan.ledgerDigest,
              recordedAt: validTimestamp((dependencies.now ?? now)()),
            },
          );

          // This checkpoint belongs to the plan rather than the chosen evidence path.
          // Once it exists, execute can never call apply again; recovery must read D1.
          assertExternalAbsent(plan.mutationCheckpointPath);
          writePrivate(
            plan.mutationCheckpointPath,
            new TextEncoder().encode(
              `${JSON.stringify({
                kind: "takosumi.control-d1-schema-mutation-checkpoint@v3",
                outcome: "unknown",
                planConfirmation: plan.confirmation,
                bridgeSourceCompatibilityDigest:
                  plan.bridgeSourceCompatibilityDigest,
                predecessorChallengeEvidenceDigest: digestJson(
                  executionPredecessorChallenge,
                ),
                recordedAt: validTimestamp((dependencies.now ?? now)()),
              })}\n`,
            ),
          );
          const startedMutationCheckpoint = readStartedMutationCheckpoint(
            plan.mutationCheckpointPath,
            plan.confirmation,
            plan.bridgeSourceCompatibilityDigest,
          );

          let applied: Awaited<ReturnType<typeof applyControlD1Schema>>;
          try {
            applied = await (dependencies.applySchema ?? applyControlD1Schema)(
              remote.database,
              candidate,
              {
                sourceCommit: plan.sourceCommit,
                environment,
                activatedAt: validTimestamp((dependencies.now ?? now)()),
                releasedAt: () => validTimestamp((dependencies.now ?? now)()),
                maintenanceDrainMilliseconds: 5_000,
                waitForRequestDrain:
                  dependencies.waitForRequestDrain ?? waitForRequestDrain,
                retainMaintenanceFence: false,
                databaseRole: "in_place",
                releasePolicy: "in_place",
                databaseId: credentials.databaseId,
                releaseReadinessDigest:
                  startedMutationCheckpoint.releaseReadinessDigest,
              },
            );
          } catch (error) {
            writeIncompleteEvidence(
              options,
              plan,
              "post-mutation-unknown",
              error,
            );
            throw new Error("control_d1_schema_release_execute_incomplete", {
              cause: error,
            });
          }

          try {
            if (
              JSON.stringify(applied.appliedMigrationVersions) !==
                JSON.stringify([67]) ||
              applied.maintenanceStatus !== "released" ||
              applied.verification.status !== "ready" ||
              applied.verification.latestMigrationVersion !== 67 ||
              applied.verification.migrationCount !== 64 ||
              applied.verification.tableCount !== 38 ||
              applied.verification.schemaDigest !== plan.schemaDigest ||
              applied.verification.ledgerDigest !== plan.ledgerDigest
            ) {
              throw new Error(
                "control_d1_schema_release_apply_result_mismatch",
              );
            }
            const finalState = await readControlD1MaintenanceState(
              remote.database,
            );
            if (finalState.status !== "inactive") {
              throw new Error("control_d1_schema_release_fence_not_released");
            }
            const finalLedger = await readControlD1MigrationLedger(
              remote.database,
            );
            if (
              JSON.stringify(finalLedger) !==
              JSON.stringify(candidate.migrations)
            ) {
              throw new Error(
                "control_d1_schema_release_final_ledger_mismatch",
              );
            }
            const verification = await verifyControlD1Schema(
              remote.database,
              candidate,
            );
            if (
              verification.status !== "ready" ||
              verification.latestMigrationVersion !== 67 ||
              verification.migrationCount !== 64 ||
              verification.tableCount !== 38 ||
              verification.schemaDigest !== plan.schemaDigest ||
              verification.ledgerDigest !== plan.ledgerDigest
            ) {
              throw new Error(
                "control_d1_schema_release_final_verification_failed",
              );
            }
            const candidateChallenge = await readControlD1BridgeChallenge(
              environment,
              serving.versionId,
              predecessor.ledgerDigest,
              candidate.ledgerDigest,
              67,
              dependencies.fetch ?? fetch,
              dependencies.now ?? now,
              "control_d1_schema_release_serving_compatibility_challenge_invalid",
            );
            const maintenanceRelease =
              await readControlD1MaintenanceReleaseReceiptDetails(
                remote.database,
              );
            if (
              maintenanceRelease === null ||
              !fenceMatchesPlan(maintenanceRelease.fence, plan) ||
              maintenanceRelease.releaseReadinessDigest !==
                startedMutationCheckpoint.releaseReadinessDigest
            ) {
              throw new Error(
                "control_d1_schema_release_maintenance_release_receipt_invalid",
              );
            }
            appendPrivate(
              plan.mutationCheckpointPath,
              new TextEncoder().encode(
                `${JSON.stringify({
                  kind: "takosumi.control-d1-schema-mutation-checkpoint@v3",
                  outcome: "accepted",
                  planConfirmation: plan.confirmation,
                  bridgeSourceCompatibilityDigest:
                    plan.bridgeSourceCompatibilityDigest,
                  appliedMigrationVersions: [67],
                  candidateChallengeEvidenceDigest:
                    digestJson(candidateChallenge),
                  recordedAt: validTimestamp((dependencies.now ?? now)()),
                })}\n`,
              ),
            );
            const acceptedMutationCheckpoint = readAcceptedMutationCheckpoint(
              plan.mutationCheckpointPath,
              plan.confirmation,
              plan.bridgeSourceCompatibilityDigest,
            );
            const completedAt = validTimestamp((dependencies.now ?? now)());
            if (
              Date.parse(maintenanceRelease.releasedAt) >
                Date.parse(completedAt) ||
              Date.parse(candidateChallenge.observedAt) > Date.parse(completedAt)
            ) {
              throw new Error(
                "control_d1_schema_release_evidence_time_invalid",
              );
            }
            const evidence = {
              kind: "takosumi.control-d1-schema-release-evidence@v3" as const,
              status: "ready" as const,
              completedAt,
              environment,
              sourceCommit: plan.sourceCommit,
              planConfirmation: plan.confirmation,
              targetDigest: plan.targetDigest,
              physicalTarget: {
                accountId: plan.target.accountId,
                databaseId: plan.target.databaseId,
              },
              credentialDigest: plan.credentialDigest,
              credentialCustodyDigest: plan.credentialCustodyDigest,
              timeTravelBookmarkDigest: plan.timeTravelBookmarkDigest,
              servingCompatibilityProofDigest:
                plan.servingCompatibilityProofDigest,
              bridgeSourceCompatibilityDigest:
                plan.bridgeSourceCompatibilityDigest,
              bridgePredecessorSourceCommit:
                plan.bridgeSourceCompatibility.predecessorSourceCommit,
              bridgeSourceCommit:
                plan.bridgeSourceCompatibility.bridgeSourceCommit,
              bridgeCompatibilityClosureDigest:
                plan.bridgeSourceCompatibility.compatibilityClosureDigest,
              compatibilityCatalogDigest:
                compatibility.compatibilityCatalogDigest,
              predecessorChallenge: executionPredecessorChallenge,
              candidateChallenge,
              mutationCheckpointDigest: acceptedMutationCheckpoint.digest,
              maintenanceReleaseReceiptDigest:
                digestJson(maintenanceRelease),
              stagingRehearsalReceiptDigest: plan.stagingRehearsalReceiptDigest,
              manifestDigest: plan.manifestDigest,
              schemaDigest: plan.schemaDigest,
              ledgerDigest: plan.ledgerDigest,
              appliedMigrationVersions: [67] as const,
              finalMigrationVersion: 67 as const,
              finalMigrationCount: 64 as const,
              finalTableCount: 38 as const,
              reviewer: options.reviewer,
              maintenanceStatus: "inactive" as const,
              recovery: {
                surface:
                  environment === "staging"
                    ? "takosumi-control-d1-schema-staging"
                    : "takosumi-control-d1-schema",
                action: "recover",
                timeTravelRestoreAuthority: "separate-incident-boundary",
              },
            };
            const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
            if (serialized.includes(credentials.apiToken)) {
              throw new Error(
                "control_d1_schema_release_token_serialization_blocked",
              );
            }
            writePrivate(
              options.evidence,
              new TextEncoder().encode(serialized),
            );
            writePublic(dependencies, {
              kind: evidence.kind,
              status: evidence.status,
              environment,
              appliedMigrationVersions: evidence.appliedMigrationVersions,
              finalMigrationVersion: evidence.finalMigrationVersion,
              finalMigrationCount: evidence.finalMigrationCount,
              finalTableCount: evidence.finalTableCount,
              manifestDigest: evidence.manifestDigest,
              schemaDigest: evidence.schemaDigest,
              ledgerDigest: evidence.ledgerDigest,
              planConfirmation: evidence.planConfirmation,
            });
          } catch (error) {
            writeIncompleteEvidence(
              options,
              plan,
              "post-mutation-readback",
              error,
            );
            throw new Error("control_d1_schema_release_execute_incomplete", {
              cause: error,
            });
          }
        },
      ),
    {
      shouldRetainAfterError: () =>
        schemaMutationCheckpointExists(plan.mutationCheckpointPath),
    },
  );
}

function schemaTargetMutationLockRequest(
  plan: ControlD1SchemaReleasePlan,
  mode: "execute" | "recover",
) {
  return {
    operationKind: "control-d1-schema" as const,
    planConfirmation: plan.confirmation,
    checkpointPath: plan.mutationCheckpointPath,
    mode,
  };
}

function schemaTargetMutationIdentity(
  environment: ControlD1SchemaReleaseEnvironment,
  dependencies: ControlD1SchemaReleaseDependencies,
) {
  return platformTargetMutationIdentityFromEnvironment(
    environment,
    dependencies.env ?? process.env,
  );
}

function assertSchemaTargetMutationAuthority(
  plan: ControlD1SchemaReleasePlan,
  target: ReturnType<typeof platformTargetMutationIdentityFromEnvironment>,
): void {
  if (
    platformTargetMutationLockPath(target) !==
      plan.targetMutationAuthorityPath ||
    platformTargetMutationAuthorityDirectoryIdentityDigest(target) !==
      plan.targetMutationAuthorityDirectoryIdentityDigest
  ) {
    throw new Error(
      "control_d1_schema_release_target_mutation_authority_drift",
    );
  }
}

function schemaMutationCheckpointExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function createPlan(
  options: PlanOptions,
  environment: ControlD1SchemaReleaseEnvironment,
  dependencies: ControlD1SchemaReleaseDependencies,
): Promise<void> {
  const targetMutationTarget = schemaTargetMutationIdentity(
    environment,
    dependencies,
  );
  assertPlatformTargetMutationAuthorityAvailable(targetMutationTarget);
  assertExternalAbsent(options.planOut);
  const checkpointPath = `${options.planOut}.mutation.jsonl`;
  assertExternalAbsent(checkpointPath);

  const source = await (dependencies.inspectSource ?? inspectSourceCheckout)();
  assertSourceReady(source);
  const credentials = releaseCredentials(
    environment,
    dependencies.env ?? process.env,
  );
  const target = TARGETS[environment];
  const serving = await readServingControlD1Binding(
    credentials,
    target,
    dependencies.fetch ?? fetch,
  );
  const remote = await (
    dependencies.createRemoteDatabase ?? createRemoteDatabase
  )(credentials);

  const [candidate, predecessor] = await Promise.all([
    buildControlD1SchemaPlan(),
    buildControlD1SchemaPlan({ throughMigrationVersion: 66 }),
  ]);
  assertTask0042Candidate(candidate, predecessor);

  const currentLedger = await readControlD1MigrationLedger(remote.database);
  if (
    JSON.stringify(currentLedger) !== JSON.stringify(predecessor.migrations)
  ) {
    throw new Error("control_d1_schema_release_predecessor_ledger_mismatch");
  }
  const maintenance = await readControlD1MaintenanceState(remote.database);
  if (maintenance.status !== "absent") {
    throw new Error("control_d1_schema_release_predecessor_fence_present");
  }
  const currentVerification = await verifyControlD1Schema(
    remote.database,
    predecessor,
  );
  if (
    currentVerification.status !== "ready" ||
    currentVerification.latestMigrationVersion !== 66 ||
    currentVerification.migrationCount !== predecessor.migrations.length ||
    currentVerification.schemaDigest !== predecessor.schemaDigest ||
    currentVerification.ledgerDigest !== predecessor.ledgerDigest
  ) {
    throw new Error("control_d1_schema_release_predecessor_schema_mismatch");
  }

  const bookmark = validBookmark(await remote.readTimeTravelBookmark());
  const timestamp = validTimestamp((dependencies.now ?? now)());
  const targetIdentity = {
    environment,
    accountId: credentials.accountId,
    databaseId: credentials.databaseId,
    workerName: target.workerName,
    bindingName: target.bindingName,
    servingVersionId: serving.versionId,
  } as const;
  const targetDigest = digestJson(targetIdentity);
  const servingCompatibilityProof = requiredServingCompatibilityProof(
    options.servingCompatibilityProof,
    {
      environment,
      target,
      servingVersionId: serving.versionId,
      targetDigest,
      sourceAuthorEmail: source.authorEmail,
      predecessorLedgerDigest: predecessor.ledgerDigest,
      candidateLedgerDigest: candidate.ledgerDigest,
      targetMutationAuthorityPath: platformTargetMutationLockPath(
        targetMutationTarget,
      ),
      targetMutationAuthorityDirectoryIdentityDigest:
        platformTargetMutationAuthorityDirectoryIdentityDigest(
          targetMutationTarget,
        ),
      inspectBridgeSourceCompatibility:
        dependencies.inspectBridgeSourceCompatibility,
    },
  );
  const predecessorCompatibilityChallenge =
    await readControlD1BridgeChallenge(
      environment,
      serving.versionId,
      predecessor.ledgerDigest,
      candidate.ledgerDigest,
      66,
      dependencies.fetch ?? fetch,
      dependencies.now ?? now,
      "control_d1_schema_release_serving_compatibility_challenge_invalid",
    );
  const credentialDigest = digestJson({
    environment,
    accountId: credentials.accountId,
    databaseId: credentials.databaseId,
    apiToken: credentials.apiToken,
  });
  const custodyDigest = credentialCustodyDigest(credentials.apiToken);
  const stagingRehearsal =
    environment === "production"
      ? await requiredStagingReceipt(
          options.stagingPlan,
          options.stagingReceipt,
          candidate,
          source,
          {
            accountId: credentials.accountId,
            databaseId: credentials.databaseId,
          },
          custodyDigest,
          dependencies,
        )
      : null;
  assertControlD1SchemaArtifactPathGraph({
    bridgePlanPath: servingCompatibilityProof.proof.bridgePlanPath,
    bridgePlanConfirmation:
      servingCompatibilityProof.proof.bridgePlanConfirmation,
    bridgeReleaseEvidencePath:
      servingCompatibilityProof.proof.bridgeReleaseEvidencePath,
    schemaPlanPath: options.planOut,
    schemaCheckpointPath: checkpointPath,
    servingCompatibilityProofPath: options.servingCompatibilityProof,
    predecessorPlatformPlanPath:
      servingCompatibilityProof.proof.bridgeSourceCompatibility
        .predecessorPlatformPlanPath,
    predecessorPlatformPlanConfirmation:
      servingCompatibilityProof.proof.bridgeSourceCompatibility
        .predecessorPlatformPlanConfirmation,
    predecessorPlatformReleaseEvidencePath:
      servingCompatibilityProof.proof.bridgeSourceCompatibility
        .predecessorPlatformReleaseEvidencePath,
    ...(options.stagingReceipt
      ? { stagingReceiptPath: options.stagingReceipt }
      : {}),
    ...(stagingRehearsal
      ? {
          stagingPlanPath: stagingRehearsal.planPath,
          stagingCheckpointPath:
            stagingRehearsal.plan.mutationCheckpointPath,
          stagingServingCompatibilityProofPath:
            stagingRehearsal.plan.servingCompatibilityProofPath,
          stagingBridgePlanPath: stagingRehearsal.plan.bridgePlanPath,
          stagingBridgeReleaseEvidencePath:
            stagingRehearsal.plan.bridgeReleaseEvidencePath,
        }
      : {}),
  });
  const pending = candidate.migrations.slice(predecessor.migrations.length);
  const identity = {
    kind: "takosumi.control-d1-schema-release-plan@v3" as const,
    createdAt: timestamp,
    environment,
    sourceCommit: source.head,
    sourceBranch: source.branch,
    sourceAuthorEmail: source.authorEmail,
    target: {
      accountId: credentials.accountId,
      databaseId: credentials.databaseId,
      workerName: target.workerName,
      bindingName: target.bindingName,
      servingVersionId: serving.versionId,
    },
    targetDigest,
    credentialDigest,
    credentialCustodyDigest: custodyDigest,
    bridgePlanPath: servingCompatibilityProof.proof.bridgePlanPath,
    bridgePlanConfirmation:
      servingCompatibilityProof.proof.bridgePlanConfirmation,
    bridgeReleaseEvidencePath:
      servingCompatibilityProof.proof.bridgeReleaseEvidencePath,
    bridgeSourceCommit: servingCompatibilityProof.proof.bridgeSourceCommit,
    bridgeSourceCompatibility:
      servingCompatibilityProof.proof.bridgeSourceCompatibility,
    bridgeSourceCompatibilityDigest:
      servingCompatibilityProof.proof.bridgeSourceCompatibilityDigest,
    manifestDigest: candidate.manifestDigest,
    schemaDigest: candidate.schemaDigest,
    ledgerDigest: candidate.ledgerDigest,
    predecessorManifestDigest: predecessor.manifestDigest,
    predecessorSchemaDigest: predecessor.schemaDigest,
    predecessorLedgerDigest: predecessor.ledgerDigest,
    currentMigrationVersion: 66 as const,
    currentMigrationCount: currentVerification.migrationCount,
    currentTableCount: currentVerification.tableCount,
    currentLedger,
    pendingMigrationVersions: [67] as const,
    pendingLedger: pending as unknown as readonly [ControlD1MigrationLedgerRow],
    finalMigrationVersion: 67 as const,
    finalMigrationCount: 64 as const,
    finalTableCount: 38 as const,
    timeTravelBookmark: bookmark,
    timeTravelBookmarkDigest: digestJson({ bookmark }),
    servingCompatibilityProofPath: options.servingCompatibilityProof,
    servingCompatibilityProofDigest: servingCompatibilityProof.digest,
    servingCompatibilityProofConfirmation:
      servingCompatibilityProof.proof.confirmation,
    predecessorCompatibilityChallenge,
    stagingRehearsalPlanPath: stagingRehearsal?.planPath ?? null,
    stagingRehearsalPlanDigest: stagingRehearsal?.planDigest ?? null,
    stagingRehearsalPlanConfirmation:
      stagingRehearsal?.plan.confirmation ?? null,
    stagingRehearsalCheckpointDigest:
      stagingRehearsal?.checkpointDigest ?? null,
    stagingRehearsalReceiptPath: options.stagingReceipt ?? null,
    stagingRehearsalReceiptDigest: stagingRehearsal?.digest ?? null,
    stagingRehearsalTarget: stagingRehearsal
      ? {
          accountId: stagingRehearsal.accountId,
          databaseId: stagingRehearsal.databaseId,
          targetDigest: stagingRehearsal.targetDigest,
          credentialCustodyDigest: stagingRehearsal.credentialCustodyDigest,
        }
      : null,
    mutationCheckpointPath: checkpointPath,
    targetMutationAuthorityPath: platformTargetMutationLockPath(
      targetMutationTarget,
    ),
    targetMutationAuthorityDirectoryIdentityDigest:
      platformTargetMutationAuthorityDirectoryIdentityDigest(
        targetMutationTarget,
      ),
  };
  const plan: ControlD1SchemaReleasePlan = {
    ...identity,
    confirmation: digestJson(identity),
  };
  const serialized = `${JSON.stringify(plan, null, 2)}\n`;
  if (serialized.includes(credentials.apiToken)) {
    throw new Error("control_d1_schema_release_token_serialization_blocked");
  }
  writePrivate(options.planOut, new TextEncoder().encode(serialized));
  writePublic(dependencies, {
    kind: plan.kind,
    status: "planned",
    environment,
    currentMigrationVersion: plan.currentMigrationVersion,
    pendingMigrationVersions: plan.pendingMigrationVersions,
    manifestDigest: plan.manifestDigest,
    schemaDigest: plan.schemaDigest,
    ledgerDigest: plan.ledgerDigest,
    servingCompatibilityProofDigest: plan.servingCompatibilityProofDigest,
    confirmation: plan.confirmation,
  });
}

function parseArgs(
  argv: readonly string[],
  environment: ControlD1SchemaReleaseEnvironment,
): Options {
  if (environment !== "staging" && environment !== "production") {
    throw new Error("control_d1_schema_release_environment_invalid");
  }
  const [action, ...rest] = argv;
  if (action !== "plan" && action !== "execute" && action !== "recover") {
    throw new Error("control_d1_schema_release_action_invalid");
  }
  const values = argumentMap(rest);
  if (action === "recover") {
    const base = ["--plan", "--confirm", "--evidence"];
    const release = [...base, "--confirm-release", "--review"];
    const allowed = values.size === base.length ? base : release;
    if (
      values.size !== allowed.length ||
      allowed.some((key) => !values.has(key)) ||
      [...values.keys()].some((key) => !allowed.includes(key))
    ) {
      throw new Error("control_d1_schema_release_arguments_invalid");
    }
    return {
      action,
      plan: absolute(values.get("--plan")!),
      confirmation: digestValue(values.get("--confirm")!),
      evidence: absolute(values.get("--evidence")!),
      ...(values.has("--confirm-release")
        ? {
            confirmRelease: digestValue(values.get("--confirm-release")!),
            reviewer: values.get("--review")!,
          }
        : {}),
    };
  }
  if (action === "execute") {
    const allowed = ["--plan", "--confirm", "--review", "--evidence"];
    if (
      values.size !== allowed.length ||
      allowed.some((key) => !values.has(key)) ||
      [...values.keys()].some((key) => !allowed.includes(key))
    ) {
      throw new Error("control_d1_schema_release_arguments_invalid");
    }
    return {
      action,
      plan: absolute(values.get("--plan")!),
      confirmation: digestValue(values.get("--confirm")!),
      reviewer: values.get("--review")!,
      evidence: absolute(values.get("--evidence")!),
    };
  }
  const allowed =
    environment === "production"
      ? [
          "--plan-out",
          "--serving-compatibility-proof",
          "--staging-plan",
          "--staging-receipt",
        ]
      : ["--plan-out", "--serving-compatibility-proof"];
  if (
    values.size !== allowed.length ||
    allowed.some((key) => !values.has(key)) ||
    [...values.keys()].some((key) => !allowed.includes(key))
  ) {
    throw new Error("control_d1_schema_release_arguments_invalid");
  }
  return {
    action,
    planOut: absolute(values.get("--plan-out")!),
    servingCompatibilityProof: absolute(
      values.get("--serving-compatibility-proof")!,
    ),
    ...(environment === "production"
      ? {
          stagingPlan: absolute(values.get("--staging-plan")!),
          stagingReceipt: absolute(values.get("--staging-receipt")!),
        }
      : {}),
  };
}

function argumentMap(rest: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (
      !key?.startsWith("--") ||
      value === undefined ||
      value.startsWith("--") ||
      values.has(key)
    ) {
      throw new Error("control_d1_schema_release_arguments_invalid");
    }
    values.set(key, value);
  }
  return values;
}

function readPlan(
  path: string,
  confirmation: string,
  environment: ControlD1SchemaReleaseEnvironment,
): ControlD1SchemaReleasePlan {
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        readStablePrivateBytes(path),
      ),
    ) as unknown;
  } catch {
    throw new Error("control_d1_schema_release_plan_invalid");
  }
  if (!record(value)) {
    throw new Error("control_d1_schema_release_plan_invalid");
  }
  const expectedKeys = [
    "bridgePlanConfirmation",
    "bridgePlanPath",
    "bridgeReleaseEvidencePath",
    "bridgeSourceCommit",
    "bridgeSourceCompatibility",
    "bridgeSourceCompatibilityDigest",
    "confirmation",
    "createdAt",
    "credentialCustodyDigest",
    "credentialDigest",
    "currentLedger",
    "currentMigrationCount",
    "currentMigrationVersion",
    "currentTableCount",
    "environment",
    "finalMigrationCount",
    "finalMigrationVersion",
    "finalTableCount",
    "kind",
    "ledgerDigest",
    "manifestDigest",
    "mutationCheckpointPath",
    "pendingLedger",
    "pendingMigrationVersions",
    "predecessorCompatibilityChallenge",
    "predecessorLedgerDigest",
    "predecessorManifestDigest",
    "predecessorSchemaDigest",
    "schemaDigest",
    "servingCompatibilityProofConfirmation",
    "servingCompatibilityProofDigest",
    "servingCompatibilityProofPath",
    "sourceAuthorEmail",
    "sourceBranch",
    "sourceCommit",
    "stagingRehearsalCheckpointDigest",
    "stagingRehearsalPlanConfirmation",
    "stagingRehearsalPlanDigest",
    "stagingRehearsalPlanPath",
    "stagingRehearsalReceiptPath",
    "stagingRehearsalReceiptDigest",
    "stagingRehearsalTarget",
    "target",
    "targetDigest",
    "targetMutationAuthorityPath",
    "targetMutationAuthorityDirectoryIdentityDigest",
    "timeTravelBookmark",
    "timeTravelBookmarkDigest",
  ].sort();
  if (
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(expectedKeys) ||
    value.kind !== "takosumi.control-d1-schema-release-plan@v3" ||
    value.environment !== environment ||
    value.confirmation !== confirmation ||
    typeof value.createdAt !== "string" ||
    !COMMIT.test(String(value.sourceCommit)) ||
    typeof value.sourceBranch !== "string" ||
    typeof value.sourceAuthorEmail !== "string" ||
    !record(value.target) ||
    typeof value.target.accountId !== "string" ||
    typeof value.target.databaseId !== "string" ||
    value.target.workerName !== TARGETS[environment].workerName ||
    value.target.bindingName !== TARGETS[environment].bindingName ||
    typeof value.target.servingVersionId !== "string" ||
    !UUID.test(value.target.servingVersionId) ||
    !SHA256.test(String(value.targetDigest)) ||
    !SHA256.test(String(value.credentialDigest)) ||
    !SHA256.test(String(value.credentialCustodyDigest)) ||
    typeof value.bridgePlanPath !== "string" ||
    !isAbsolute(value.bridgePlanPath) ||
    resolve(value.bridgePlanPath) !== value.bridgePlanPath ||
    !SHA256.test(String(value.bridgePlanConfirmation)) ||
    typeof value.bridgeReleaseEvidencePath !== "string" ||
    !isAbsolute(value.bridgeReleaseEvidencePath) ||
    resolve(value.bridgeReleaseEvidencePath) !==
      value.bridgeReleaseEvidencePath ||
    !COMMIT.test(String(value.bridgeSourceCommit)) ||
    !record(value.bridgeSourceCompatibility) ||
    value.bridgeSourceCompatibility.bridgeSourceCommit !==
      value.bridgeSourceCommit ||
    !SHA256.test(String(value.bridgeSourceCompatibilityDigest)) ||
    value.bridgeSourceCompatibilityDigest !==
      digestJson(value.bridgeSourceCompatibility) ||
    !SHA256.test(String(value.manifestDigest)) ||
    !SHA256.test(String(value.schemaDigest)) ||
    !SHA256.test(String(value.ledgerDigest)) ||
    !SHA256.test(String(value.predecessorManifestDigest)) ||
    !SHA256.test(String(value.predecessorSchemaDigest)) ||
    !SHA256.test(String(value.predecessorLedgerDigest)) ||
    typeof value.servingCompatibilityProofPath !== "string" ||
    !isAbsolute(value.servingCompatibilityProofPath) ||
    resolve(value.servingCompatibilityProofPath) !==
      value.servingCompatibilityProofPath ||
    value.servingCompatibilityProofPath === path ||
    !SHA256.test(String(value.servingCompatibilityProofDigest)) ||
    !SHA256.test(String(value.servingCompatibilityProofConfirmation)) ||
    !assertControlD1BridgeChallengeEvidence(
      value.predecessorCompatibilityChallenge,
      {
        environment,
        servingVersionId: value.target.servingVersionId as string,
        predecessorLedgerDigest: value.predecessorLedgerDigest as string,
        candidateLedgerDigest: value.ledgerDigest as string,
        acceptedMigrationVersion: 66,
      },
    ) ||
    value.currentMigrationVersion !== 66 ||
    !Number.isSafeInteger(value.currentMigrationCount) ||
    !Number.isSafeInteger(value.currentTableCount) ||
    !validLedger(value.currentLedger) ||
    JSON.stringify(value.pendingMigrationVersions) !== JSON.stringify([67]) ||
    !validLedger(value.pendingLedger) ||
    value.pendingLedger.length !== 1 ||
    value.pendingLedger[0]?.version !== 67 ||
    value.finalMigrationVersion !== 67 ||
    value.finalMigrationCount !== 64 ||
    value.finalTableCount !== 38 ||
    typeof value.timeTravelBookmark !== "string" ||
    !SHA256.test(String(value.timeTravelBookmarkDigest)) ||
    (value.stagingRehearsalReceiptDigest !== null &&
      !SHA256.test(String(value.stagingRehearsalReceiptDigest))) ||
    (value.stagingRehearsalPlanDigest !== null &&
      !SHA256.test(String(value.stagingRehearsalPlanDigest))) ||
    (value.stagingRehearsalPlanConfirmation !== null &&
      !SHA256.test(String(value.stagingRehearsalPlanConfirmation))) ||
    (value.stagingRehearsalCheckpointDigest !== null &&
      !SHA256.test(String(value.stagingRehearsalCheckpointDigest))) ||
    (value.stagingRehearsalPlanPath !== null &&
      (typeof value.stagingRehearsalPlanPath !== "string" ||
        !isAbsolute(value.stagingRehearsalPlanPath) ||
        resolve(value.stagingRehearsalPlanPath) !==
          value.stagingRehearsalPlanPath)) ||
    (value.stagingRehearsalReceiptPath !== null &&
      (typeof value.stagingRehearsalReceiptPath !== "string" ||
        !isAbsolute(value.stagingRehearsalReceiptPath) ||
        resolve(value.stagingRehearsalReceiptPath) !==
          value.stagingRehearsalReceiptPath)) ||
    !validStagingRehearsalTarget(value.stagingRehearsalTarget) ||
    typeof value.mutationCheckpointPath !== "string" ||
    value.mutationCheckpointPath !== `${path}.mutation.jsonl` ||
    typeof value.targetMutationAuthorityPath !== "string" ||
    !isAbsolute(value.targetMutationAuthorityPath) ||
    resolve(value.targetMutationAuthorityPath) !==
      value.targetMutationAuthorityPath ||
    typeof value.targetMutationAuthorityDirectoryIdentityDigest !==
      "string" ||
    !SHA256.test(value.targetMutationAuthorityDirectoryIdentityDigest)
  ) {
    throw new Error("control_d1_schema_release_plan_invalid");
  }
  validTimestamp(value.createdAt);
  validBookmark(value.timeTravelBookmark);
  const { confirmation: recorded, ...identity } = value;
  if (
    recorded !== digestJson(identity) ||
    digestJson({ environment, ...value.target }) !== value.targetDigest ||
    digestJson({ bookmark: value.timeTravelBookmark }) !==
      value.timeTravelBookmarkDigest ||
    (environment === "production") !==
      (value.stagingRehearsalReceiptDigest !== null) ||
    (environment === "production") !==
      (value.stagingRehearsalPlanPath !== null) ||
    (environment === "production") !==
      (value.stagingRehearsalPlanDigest !== null) ||
    (environment === "production") !==
      (value.stagingRehearsalPlanConfirmation !== null) ||
    (environment === "production") !==
      (value.stagingRehearsalCheckpointDigest !== null) ||
    (environment === "production") !==
      (value.stagingRehearsalReceiptPath !== null) ||
    (environment === "production") !==
      (value.stagingRehearsalTarget !== null) ||
    (record(value.stagingRehearsalTarget) &&
      value.stagingRehearsalTarget.accountId === value.target.accountId &&
      value.stagingRehearsalTarget.databaseId === value.target.databaseId) ||
    (record(value.stagingRehearsalTarget) &&
      value.stagingRehearsalTarget.credentialCustodyDigest ===
        value.credentialCustodyDigest)
  ) {
    throw new Error("control_d1_schema_release_plan_invalid");
  }
  return value as unknown as ControlD1SchemaReleasePlan;
}

async function assertPlanCandidate(plan: ControlD1SchemaReleasePlan): Promise<{
  readonly candidate: ControlD1SchemaPlan;
  readonly predecessor: ControlD1SchemaPlan;
}> {
  const [candidate, predecessor] = await Promise.all([
    buildControlD1SchemaPlan(),
    buildControlD1SchemaPlan({ throughMigrationVersion: 66 }),
  ]);
  assertTask0042Candidate(candidate, predecessor);
  if (
    plan.manifestDigest !== candidate.manifestDigest ||
    plan.schemaDigest !== candidate.schemaDigest ||
    plan.ledgerDigest !== candidate.ledgerDigest ||
    plan.predecessorManifestDigest !== predecessor.manifestDigest ||
    plan.predecessorSchemaDigest !== predecessor.schemaDigest ||
    plan.predecessorLedgerDigest !== predecessor.ledgerDigest ||
    plan.currentMigrationCount !== predecessor.migrations.length ||
    plan.currentTableCount !== predecessor.tables.length ||
    JSON.stringify(plan.currentLedger) !==
      JSON.stringify(predecessor.migrations) ||
    JSON.stringify(plan.pendingLedger) !==
      JSON.stringify(candidate.migrations.slice(predecessor.migrations.length))
  ) {
    throw new Error("control_d1_schema_release_source_manifest_drift");
  }
  return { candidate, predecessor };
}

async function assertExactPredecessor(
  database: D1Database,
  predecessor: ControlD1SchemaPlan,
  plan: ControlD1SchemaReleasePlan,
): Promise<void> {
  const ledger = await readControlD1MigrationLedger(database);
  if (JSON.stringify(ledger) !== JSON.stringify(plan.currentLedger)) {
    throw new Error("control_d1_schema_release_predecessor_ledger_drift");
  }
  const state = await readControlD1MaintenanceState(database);
  if (state.status !== "absent") {
    throw new Error("control_d1_schema_release_predecessor_fence_drift");
  }
  const verification = await verifyControlD1Schema(database, predecessor);
  if (
    verification.status !== "ready" ||
    verification.latestMigrationVersion !== 66 ||
    verification.migrationCount !== plan.currentMigrationCount ||
    verification.tableCount !== plan.currentTableCount ||
    verification.schemaDigest !== plan.predecessorSchemaDigest ||
    verification.ledgerDigest !== plan.predecessorLedgerDigest
  ) {
    throw new Error("control_d1_schema_release_predecessor_schema_drift");
  }
}

async function assertExactCandidate(
  database: D1Database,
  candidate: ControlD1SchemaPlan,
  allowActiveMaintenanceFence: boolean,
): Promise<void> {
  const verification = await verifyControlD1Schema(database, candidate, {
    allowActiveMaintenanceFence,
  });
  if (
    verification.status !== "ready" ||
    verification.latestMigrationVersion !== 67 ||
    verification.migrationCount !== 64 ||
    verification.tableCount !== 38 ||
    verification.schemaDigest !== candidate.schemaDigest ||
    verification.ledgerDigest !== candidate.ledgerDigest
  ) {
    throw new Error("control_d1_schema_release_candidate_schema_mismatch");
  }
}

function fenceMatchesPlan(
  fence: ControlD1MaintenanceFence,
  plan: ControlD1SchemaReleasePlan,
): boolean {
  return (
    fence.sourceCommit === plan.sourceCommit &&
    fence.manifestDigest === plan.manifestDigest &&
    fence.environment === plan.environment &&
    fence.databaseRole === "in_place" &&
    fence.releasePolicy === "in_place" &&
    fence.databaseId === plan.target.databaseId &&
    fence.sourceExportSha256 === null &&
    fence.predecessor === null
  );
}

interface RecoveryEvidenceInput {
  readonly status: "untouched" | "ready";
  readonly environment: ControlD1SchemaReleaseEnvironment;
  readonly sourceCommit: string;
  readonly planConfirmation: string;
  readonly targetDigest: string;
  readonly manifestDigest: string;
  readonly schemaDigest: string;
  readonly ledgerDigest: string;
  readonly servingCompatibilityProofDigest: string;
  readonly bridgeSourceCompatibilityDigest: string;
  readonly currentMigrationVersion: 66 | 67;
  readonly currentMigrationCount: number;
  readonly currentTableCount: number;
  readonly maintenanceStatus: "absent" | "inactive";
  readonly recoveryAction:
    "none" | "observed-ready" | "released-existing-fence";
  readonly releaseConfirmation?: string;
  readonly reviewer?: string;
  readonly lostReleaseAcknowledgement?: boolean;
}

function writeRecoveryEvidence(
  path: string,
  input: RecoveryEvidenceInput,
): void {
  writePrivate(
    path,
    new TextEncoder().encode(
      `${JSON.stringify(
        {
          kind: "takosumi.control-d1-schema-recovery-evidence@v1",
          ...input,
          timeTravelRestoreAuthority: "separate-incident-boundary",
        },
        null,
        2,
      )}\n`,
    ),
  );
}

async function blockRecovery(
  options: RecoverOptions,
  plan: ControlD1SchemaReleasePlan,
  ledger: readonly ControlD1MigrationLedgerRow[],
  maintenanceStatus: string,
  dependencies: ControlD1SchemaReleaseDependencies,
  failureCode: string,
): Promise<never> {
  const latest = ledger.at(-1)?.version ?? null;
  const evidence = {
    kind: "takosumi.control-d1-schema-recovery-evidence@v1",
    status: "blocked",
    environment: plan.environment,
    sourceCommit: plan.sourceCommit,
    planConfirmation: plan.confirmation,
    targetDigest: plan.targetDigest,
    manifestDigest: plan.manifestDigest,
    schemaDigest: plan.schemaDigest,
    ledgerDigest: plan.ledgerDigest,
    servingCompatibilityProofDigest: plan.servingCompatibilityProofDigest,
    bridgeSourceCompatibilityDigest: plan.bridgeSourceCompatibilityDigest,
    currentMigrationVersion: latest,
    currentMigrationCount: ledger.length,
    maintenanceStatus,
    recoveryAction: "none",
    failureCode,
    blindRetry: "forbidden",
    timeTravelRestoreAuthority: "separate-incident-authorization-required",
  } as const;
  writePrivate(
    options.evidence,
    new TextEncoder().encode(`${JSON.stringify(evidence, null, 2)}\n`),
  );
  writePublic(dependencies, {
    kind: evidence.kind,
    status: evidence.status,
    environment: plan.environment,
    currentMigrationVersion: latest,
    maintenanceStatus,
    failureCode,
    blindRetry: evidence.blindRetry,
    timeTravelRestoreAuthority: evidence.timeTravelRestoreAuthority,
  });
  throw new Error("control_d1_schema_release_recovery_blocked");
}

function assertCredentialsMatchPlan(
  credentials: ReleaseCredentials,
  plan: ControlD1SchemaReleasePlan,
): void {
  if (
    credentials.accountId !== plan.target.accountId ||
    credentials.databaseId !== plan.target.databaseId ||
    digestJson({
      environment: plan.environment,
      accountId: credentials.accountId,
      databaseId: credentials.databaseId,
      apiToken: credentials.apiToken,
    }) !== plan.credentialDigest ||
    credentialCustodyDigest(credentials.apiToken) !==
      plan.credentialCustodyDigest
  ) {
    throw new Error("control_d1_schema_release_credential_or_target_drift");
  }
}

function assertReviewer(reviewer: string, sourceAuthorEmail: string): void {
  if (
    !/^operator:[A-Za-z0-9._@-]{3,128}$/u.test(reviewer) ||
    reviewer.slice("operator:".length).toLowerCase() ===
      sourceAuthorEmail.toLowerCase()
  ) {
    throw new Error("control_d1_schema_release_reviewer_not_independent");
  }
}

function writeIncompleteEvidence(
  options: ExecuteOptions,
  plan: ControlD1SchemaReleasePlan,
  failureBoundary: "post-mutation-unknown" | "post-mutation-readback",
  error: unknown,
): void {
  const failureCode =
    error instanceof Error && /^[a-z][a-z0-9_]{0,127}$/u.test(error.message)
      ? error.message
      : "control_d1_schema_release_failed";
  const evidence = {
    kind: "takosumi.control-d1-schema-release-evidence@v3",
    status: "incomplete",
    environment: plan.environment,
    sourceCommit: plan.sourceCommit,
    planConfirmation: plan.confirmation,
    targetDigest: plan.targetDigest,
    manifestDigest: plan.manifestDigest,
    schemaDigest: plan.schemaDigest,
    ledgerDigest: plan.ledgerDigest,
    servingCompatibilityProofDigest: plan.servingCompatibilityProofDigest,
    bridgeSourceCompatibilityDigest: plan.bridgeSourceCompatibilityDigest,
    bridgePredecessorSourceCommit:
      plan.bridgeSourceCompatibility.predecessorSourceCommit,
    bridgeSourceCommit: plan.bridgeSourceCompatibility.bridgeSourceCommit,
    bridgeCompatibilityClosureDigest:
      plan.bridgeSourceCompatibility.compatibilityClosureDigest,
    reviewer: options.reviewer,
    mutationOutcome: "unknown",
    failureBoundary,
    failureCode,
    recovery: {
      action: "recover",
      blindRetry: "forbidden",
      timeTravelRestoreAuthority: "separate-incident-boundary",
    },
  } as const;
  try {
    writePrivate(
      options.evidence,
      new TextEncoder().encode(`${JSON.stringify(evidence, null, 2)}\n`),
    );
  } catch {
    // Preserve the schema failure when the separately requested evidence path
    // is unusable; the plan-bound checkpoint still prevents another apply.
  }
}

function validLedger(value: unknown): value is ControlD1MigrationLedgerRow[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (row) =>
        record(row) &&
        Number.isSafeInteger(row.version) &&
        typeof row.name === "string" &&
        row.name.length > 0 &&
        typeof row.checksum === "string" &&
        SHA256.test(row.checksum),
    )
  );
}

function validStagingRehearsalTarget(value: unknown): boolean {
  if (value === null) return true;
  return (
    record(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify(
        [
          "accountId",
          "credentialCustodyDigest",
          "databaseId",
          "targetDigest",
        ].sort(),
      ) &&
    typeof value.accountId === "string" &&
    value.accountId.length > 0 &&
    typeof value.databaseId === "string" &&
    value.databaseId.length > 0 &&
    SHA256.test(String(value.targetDigest)) &&
    SHA256.test(String(value.credentialCustodyDigest))
  );
}

function digestValue(value: string): string {
  if (!SHA256.test(value)) {
    throw new Error("control_d1_schema_release_confirmation_invalid");
  }
  return value;
}

function reviewerValue(value: string): string {
  if (!/^operator:[A-Za-z0-9._@-]{3,128}$/u.test(value)) {
    throw new Error("control_d1_schema_release_reviewer_invalid");
  }
  return value;
}

function assertTask0042Candidate(
  candidate: ControlD1SchemaPlan,
  predecessor: ControlD1SchemaPlan,
): void {
  const pending = candidate.migrations.slice(predecessor.migrations.length);
  if (
    candidate.migrations.length !== 64 ||
    candidate.tables.length !== 38 ||
    candidate.migrations.at(-1)?.version !== 67 ||
    predecessor.migrations.at(-1)?.version !== 66 ||
    pending.length !== 1 ||
    pending[0]?.version !== 67 ||
    ![candidate.manifestDigest, candidate.schemaDigest, candidate.ledgerDigest]
      .concat([
        predecessor.manifestDigest,
        predecessor.schemaDigest,
        predecessor.ledgerDigest,
      ])
      .every((value) => SHA256.test(value))
  ) {
    throw new Error("control_d1_schema_release_candidate_invalid");
  }
}

async function readServingControlD1Binding(
  credentials: ReleaseCredentials,
  target: Target,
  fetcher: typeof fetch,
): Promise<{
  readonly versionId: string;
  readonly schemaMode: "predeployed-bridge";
}> {
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(credentials.accountId)}/workers/scripts/${encodeURIComponent(target.workerName)}`;
  const deployments = await cloudflareJson(
    `${base}/deployments`,
    credentials.apiToken,
    fetcher,
  );
  const deploymentResult = record(deployments.result)
    ? deployments.result
    : undefined;
  const list = deploymentResult?.deployments;
  if (!Array.isArray(list) || list.length === 0 || !record(list[0])) {
    throw new Error("control_d1_schema_release_deployment_invalid");
  }
  const versions = list[0].versions;
  if (
    !Array.isArray(versions) ||
    versions.length !== 1 ||
    !record(versions[0]) ||
    versions[0].percentage !== 100 ||
    typeof versions[0].version_id !== "string" ||
    !UUID.test(versions[0].version_id)
  ) {
    throw new Error("control_d1_schema_release_deployment_invalid");
  }
  const versionId = versions[0].version_id;
  const version = await cloudflareJson(
    `${base}/versions/${encodeURIComponent(versionId)}`,
    credentials.apiToken,
    fetcher,
  );
  const detail = record(version.result) ? version.result : undefined;
  const resources = record(detail?.resources) ? detail.resources : undefined;
  const bindings = resources?.bindings;
  if (detail?.id !== versionId || !Array.isArray(bindings)) {
    throw new Error("control_d1_schema_release_worker_version_invalid");
  }
  const matches = bindings.filter(
    (binding) =>
      record(binding) &&
      binding.name === target.bindingName &&
      binding.type === "d1",
  );
  if (
    matches.length !== 1 ||
    !record(matches[0]) ||
    matches[0].database_id !== credentials.databaseId
  ) {
    throw new Error("control_d1_schema_release_worker_binding_mismatch");
  }
  const schemaModes = bindings.filter(
    (binding) =>
      record(binding) &&
      binding.name === "TAKOSUMI_CONTROL_D1_SCHEMA_MODE" &&
      binding.type === "plain_text",
  );
  if (
    schemaModes.length !== 1 ||
    !record(schemaModes[0]) ||
    schemaModes[0].text !== "predeployed-bridge"
  ) {
    throw new Error("control_d1_schema_release_worker_schema_mode_invalid");
  }
  return { versionId, schemaMode: "predeployed-bridge" };
}

function controlD1CompatibilityCatalogDigest(
  predecessorLedgerDigest: string,
  candidateLedgerDigest: string,
): string {
  return digestJson({
    kind: "takosumi.control-d1-schema-compatibility-catalog@v1",
    allowset: [
      { migrationVersion: 66, ledgerDigest: predecessorLedgerDigest },
      { migrationVersion: 67, ledgerDigest: candidateLedgerDigest },
    ],
  });
}

async function readControlD1BridgeChallenge(
  environment: ControlD1SchemaReleaseEnvironment,
  servingVersionId: string,
  predecessorLedgerDigest: string,
  candidateLedgerDigest: string,
  acceptedMigrationVersion: 66 | 67,
  fetcher: typeof fetch,
  clock: () => string,
  failureCode: string,
): Promise<ControlD1BridgeChallengeEvidence> {
  const nonce = randomBytes(32).toString("hex");
  const origin = platformTargetForEnvironment(environment).origin;
  const url = new URL(CONTROL_D1_BRIDGE_CHALLENGE_PATH, origin);
  url.searchParams.set("nonce", nonce);
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        "cache-control": "no-cache",
      },
      redirect: "manual",
    });
  } catch (error) {
    throw new Error(failureCode, { cause: error });
  }
  let bytes: Uint8Array;
  try {
    const body = await response.arrayBuffer();
    if (body.byteLength === 0 || body.byteLength > 32_768) {
      throw new Error("challenge_size_invalid");
    }
    bytes = new Uint8Array(body);
  } catch (error) {
    throw new Error(failureCode, { cause: error });
  }
  let value: unknown;
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(failureCode, { cause: error });
  }
  try {
    if (
      !response.ok ||
      response.status !== 200 ||
      response.redirected ||
      response.headers.get("cache-control") !== "no-store" ||
      response.headers.get("pragma") !== "no-cache" ||
      response.headers.get("x-takosumi-version-id") !== servingVersionId ||
      !/^application\/json(?:;|$)/iu.test(
        response.headers.get("content-type") ?? "",
      ) ||
      !record(value) ||
      raw !== JSON.stringify(value) ||
      JSON.stringify(Object.keys(value).sort()) !==
        JSON.stringify(
          [
            "accepted",
            "allowset",
            "bindingName",
            "environment",
            "kind",
            "ledger",
            "nonce",
            "schemaMode",
            "status",
            "workerVersionId",
          ].sort(),
        )
    ) {
      throw new Error("challenge_envelope_invalid");
    }
    const expectedAllowset = [
      { migrationVersion: 66, ledgerDigest: predecessorLedgerDigest },
      { migrationVersion: 67, ledgerDigest: candidateLedgerDigest },
    ];
    const expectedAccepted = expectedAllowset.find(
      (entry) => entry.migrationVersion === acceptedMigrationVersion,
    );
    if (
      value.kind !==
        "takosumi.control-d1-schema-compatibility-challenge@v1" ||
      value.status !== "ready" ||
      value.nonce !== nonce ||
      value.environment !== environment ||
      value.workerVersionId !== servingVersionId ||
      value.bindingName !== "TAKOSUMI_CONTROL_DB" ||
      value.schemaMode !== "predeployed-bridge" ||
      !validLedger(value.ledger) ||
      digestJson(value.ledger) !== expectedAccepted?.ledgerDigest ||
      JSON.stringify(value.allowset) !== JSON.stringify(expectedAllowset) ||
      JSON.stringify(value.accepted) !== JSON.stringify(expectedAccepted)
    ) {
      throw new Error("challenge_binding_invalid");
    }
    return {
      kind: "takosumi.control-d1-schema-compatibility-challenge-evidence@v1",
      observedAt: validTimestamp(clock()),
      responseDigest: digestBytes(bytes),
      response: value as unknown as ControlD1BridgeChallengeResponse,
    };
  } catch (error) {
    throw new Error(failureCode, { cause: error });
  }
}

function assertControlD1BridgeChallengeEvidence(
  value: unknown,
  context: Readonly<{
    environment: ControlD1SchemaReleaseEnvironment;
    servingVersionId: string;
    predecessorLedgerDigest: string;
    candidateLedgerDigest: string;
    acceptedMigrationVersion: 66 | 67;
  }>,
): value is ControlD1BridgeChallengeEvidence {
  if (
    !record(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(["kind", "observedAt", "response", "responseDigest"]) ||
    value.kind !==
      "takosumi.control-d1-schema-compatibility-challenge-evidence@v1" ||
    typeof value.observedAt !== "string" ||
    !SHA256.test(String(value.responseDigest)) ||
    !record(value.response)
  ) {
    return false;
  }
  try {
    validTimestamp(value.observedAt);
  } catch {
    return false;
  }
  const response = value.response;
  const expectedAllowset = [
    {
      migrationVersion: 66,
      ledgerDigest: context.predecessorLedgerDigest,
    },
    { migrationVersion: 67, ledgerDigest: context.candidateLedgerDigest },
  ];
  const expectedAccepted = expectedAllowset.find(
    (entry) => entry.migrationVersion === context.acceptedMigrationVersion,
  );
  return (
    JSON.stringify(Object.keys(response).sort()) ===
      JSON.stringify(
        [
          "accepted",
          "allowset",
          "bindingName",
          "environment",
          "kind",
          "ledger",
          "nonce",
          "schemaMode",
          "status",
          "workerVersionId",
        ].sort(),
      ) &&
    response.kind ===
      "takosumi.control-d1-schema-compatibility-challenge@v1" &&
    response.status === "ready" &&
    typeof response.nonce === "string" &&
    /^[0-9a-f]{64}$/u.test(response.nonce) &&
    response.environment === context.environment &&
    response.workerVersionId === context.servingVersionId &&
    response.bindingName === "TAKOSUMI_CONTROL_DB" &&
    response.schemaMode === "predeployed-bridge" &&
    validLedger(response.ledger) &&
    digestJson(response.ledger) === expectedAccepted?.ledgerDigest &&
    JSON.stringify(response.allowset) === JSON.stringify(expectedAllowset) &&
    JSON.stringify(response.accepted) === JSON.stringify(expectedAccepted) &&
    value.responseDigest === digestJson(response)
  );
}

async function cloudflareJson(
  url: string,
  apiToken: string,
  fetcher: typeof fetch,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers: { authorization: `Bearer ${apiToken}` },
    });
  } catch {
    throw new Error("control_d1_schema_release_cloudflare_request_failed");
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error("control_d1_schema_release_cloudflare_response_invalid");
  }
  if (!response.ok || !record(value) || value.success !== true) {
    throw new Error("control_d1_schema_release_cloudflare_read_failed");
  }
  return value;
}

function releaseCredentials(
  environment: ControlD1SchemaReleaseEnvironment,
  env: Readonly<Record<string, string | undefined>>,
): ReleaseCredentials {
  const prefix = `TAKOSUMI_CONTROL_D1_${environment.toUpperCase()}`;
  return {
    accountId: opaqueSegment(
      env[`${prefix}_CLOUDFLARE_ACCOUNT_ID`],
      "control_d1_schema_release_account_id_invalid",
    ),
    databaseId: opaqueSegment(
      env[`${prefix}_DATABASE_ID`],
      "control_d1_schema_release_database_id_invalid",
    ),
    apiToken: secret(
      env[`${prefix}_CLOUDFLARE_API_TOKEN`],
      "control_d1_schema_release_api_token_missing",
    ),
  };
}

function createRemoteDatabase(credentials: ReleaseCredentials): RemoteDatabase {
  const database = new CloudflareControlD1RestDatabase(credentials);
  return {
    database,
    readTimeTravelBookmark: () => database.readTimeTravelBookmark(),
  };
}

type ServingCompatibilityContext = Readonly<{
  environment: ControlD1SchemaReleaseEnvironment;
  target: Target;
  servingVersionId: string;
  targetDigest: string;
  sourceAuthorEmail: string;
  predecessorLedgerDigest: string;
  candidateLedgerDigest: string;
  targetMutationAuthorityPath: string;
  targetMutationAuthorityDirectoryIdentityDigest: string;
  inspectBridgeSourceCompatibility?: ControlD1SchemaReleaseDependencies["inspectBridgeSourceCompatibility"];
}>;

function requiredServingCompatibilityProof(
  path: string,
  context: ServingCompatibilityContext,
): Readonly<{
  proof: ControlD1ServingCompatibilityProof;
  digest: string;
}> {
  let bytes: Uint8Array;
  let value: unknown;
  try {
    bytes = readStablePrivateBytes(path);
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    throw new Error(
      "control_d1_schema_release_serving_compatibility_proof_invalid",
    );
  }
  const expectedKeys = [
    "bindingName",
    "bridgePlanDigest",
    "bridgePlanConfirmation",
    "bridgePlanPath",
    "bridgeReleaseEvidencePath",
    "bridgeReleaseEvidenceDigest",
    "bridgeSourceCommit",
    "bridgeSourceCompatibility",
    "bridgeSourceCompatibilityDigest",
    "candidate",
    "compatibilityCatalogDigest",
    "completedAt",
    "confirmation",
    "environment",
    "kind",
    "predecessor",
    "predecessorChallenge",
    "reviewer",
    "schemaMode",
    "servingVersionId",
    "status",
    "targetDigest",
    "workerName",
  ].sort();
  const readinessKeys = ["ledgerDigest", "migrationVersion", "status"].sort();
  if (
    !record(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(expectedKeys) ||
    value.kind !== "takosumi.control-d1-serving-compatibility-proof@v3" ||
    value.status !== "ready" ||
    value.environment !== context.environment ||
    !COMMIT.test(String(value.bridgeSourceCommit)) ||
    !SHA256.test(String(value.bridgeSourceCompatibilityDigest)) ||
    !record(value.bridgeSourceCompatibility) ||
    value.bridgeSourceCompatibility.bridgeSourceCommit !==
      value.bridgeSourceCommit ||
    value.bridgeSourceCompatibilityDigest !==
      digestJson(value.bridgeSourceCompatibility) ||
    typeof value.bridgePlanPath !== "string" ||
    !isAbsolute(value.bridgePlanPath) ||
    resolve(value.bridgePlanPath) !== value.bridgePlanPath ||
    !SHA256.test(String(value.bridgePlanConfirmation)) ||
    typeof value.bridgeReleaseEvidencePath !== "string" ||
    !isAbsolute(value.bridgeReleaseEvidencePath) ||
    resolve(value.bridgeReleaseEvidencePath) !==
      value.bridgeReleaseEvidencePath ||
    !SHA256.test(String(value.bridgeReleaseEvidenceDigest)) ||
    !SHA256.test(String(value.bridgePlanDigest)) ||
    value.workerName !== context.target.workerName ||
    value.bindingName !== context.target.bindingName ||
    value.servingVersionId !== context.servingVersionId ||
    !UUID.test(String(value.servingVersionId)) ||
    value.targetDigest !== context.targetDigest ||
    value.schemaMode !== "predeployed-bridge" ||
    value.compatibilityCatalogDigest !==
      controlD1CompatibilityCatalogDigest(
        context.predecessorLedgerDigest,
        context.candidateLedgerDigest,
      ) ||
    !assertControlD1BridgeChallengeEvidence(value.predecessorChallenge, {
      environment: context.environment,
      servingVersionId: context.servingVersionId,
      predecessorLedgerDigest: context.predecessorLedgerDigest,
      candidateLedgerDigest: context.candidateLedgerDigest,
      acceptedMigrationVersion: 66,
    }) ||
    !record(value.predecessor) ||
    JSON.stringify(Object.keys(value.predecessor).sort()) !==
      JSON.stringify(readinessKeys) ||
    value.predecessor.migrationVersion !== 66 ||
    value.predecessor.ledgerDigest !== context.predecessorLedgerDigest ||
    value.predecessor.status !== "ready" ||
    !record(value.candidate) ||
    JSON.stringify(Object.keys(value.candidate).sort()) !==
      JSON.stringify(readinessKeys) ||
    value.candidate.migrationVersion !== 67 ||
    value.candidate.ledgerDigest !== context.candidateLedgerDigest ||
    value.candidate.status !== "ready" ||
    typeof value.reviewer !== "string" ||
    !/^operator:[A-Za-z0-9._@-]{3,128}$/u.test(value.reviewer) ||
    value.reviewer.slice("operator:".length).toLowerCase() ===
      context.sourceAuthorEmail.toLowerCase() ||
    !SHA256.test(String(value.confirmation)) ||
    typeof value.completedAt !== "string"
  ) {
    throw new Error(
      "control_d1_schema_release_serving_compatibility_proof_invalid",
    );
  }
  try {
    validTimestamp(value.completedAt);
    if (
      !record(value.predecessorChallenge) ||
      typeof value.predecessorChallenge.observedAt !== "string" ||
      Date.parse(value.predecessorChallenge.observedAt) >
        Date.parse(value.completedAt)
    ) {
      throw new Error("challenge_time_invalid");
    }
  } catch {
    throw new Error(
      "control_d1_schema_release_serving_compatibility_proof_invalid",
    );
  }
  const { confirmation, ...identity } = value;
  if (confirmation !== digestJson(identity)) {
    throw new Error(
      "control_d1_schema_release_serving_compatibility_proof_invalid",
    );
  }
  try {
    const bridgeRelease = readPlatformReleasePlanMutationState(
      value.bridgePlanPath as string,
      value.bridgePlanConfirmation as string,
    );
    const bridgeEvidence = readPlatformReleaseReadyEvidenceAuthority(
      value.bridgePlanPath as string,
      value.bridgePlanConfirmation as string,
      value.bridgeReleaseEvidencePath as string,
    );
    const sourceCompatibility = value.bridgeSourceCompatibility as Record<
      string,
      unknown
    >;
    const predecessorRelease = readPlatformReleasePlanMutationState(
      String(sourceCompatibility.predecessorPlatformPlanPath),
      String(sourceCompatibility.predecessorPlatformPlanConfirmation),
    );
    const predecessorEvidence = readPlatformReleaseReadyEvidenceAuthority(
      String(sourceCompatibility.predecessorPlatformPlanPath),
      String(sourceCompatibility.predecessorPlatformPlanConfirmation),
      String(sourceCompatibility.predecessorPlatformReleaseEvidencePath),
    );
    assertControlD1BridgeSourceCompatibility(sourceCompatibility, {
      predecessorSourceCommit: predecessorEvidence.sourceCommit,
      bridgeSourceCommit: bridgeRelease.authority.sourceCommit,
      predecessorServingVersionId: predecessorEvidence.deployedVersionId,
      predecessorPlatformPlanPath: String(
        sourceCompatibility.predecessorPlatformPlanPath,
      ),
      predecessorPlatformPlanConfirmation: String(
        sourceCompatibility.predecessorPlatformPlanConfirmation,
      ),
      predecessorPlatformReleaseEvidencePath: String(
        sourceCompatibility.predecessorPlatformReleaseEvidencePath,
      ),
      predecessorPlatformReleaseEvidenceDigest: predecessorEvidence.digest,
      reviewer: bridgeEvidence.reviewer,
    });
    const recomputedClosure = (
      context.inspectBridgeSourceCompatibility ??
      inspectControlD1BridgeSourceCompatibility
    )(
      predecessorEvidence.sourceCommit,
      bridgeRelease.authority.sourceCommit,
      bridgeEvidence.reviewer,
    );
    if (
      bridgeRelease.authority.environment !== context.environment ||
      bridgeRelease.authority.sourceCommit !== value.bridgeSourceCommit ||
      bridgeRelease.authority.confirmation !== value.bridgePlanConfirmation ||
      bridgeRelease.authority.targetMutationAuthorityPath !==
        context.targetMutationAuthorityPath ||
      bridgeRelease.authority.targetMutationAuthorityDirectoryIdentityDigest !==
        context.targetMutationAuthorityDirectoryIdentityDigest ||
      bridgeEvidence.digest !== value.bridgeReleaseEvidenceDigest ||
      digestBytes(readStablePrivateBytes(value.bridgePlanPath as string)) !==
        value.bridgePlanDigest ||
      bridgeEvidence.deployedVersionId !== context.servingVersionId ||
      bridgeEvidence.reviewer !== value.reviewer ||
      predecessorRelease.authority.environment !== context.environment ||
      predecessorRelease.authority.targetMutationAuthorityPath !==
        context.targetMutationAuthorityPath ||
      predecessorRelease.authority
        .targetMutationAuthorityDirectoryIdentityDigest !==
        context.targetMutationAuthorityDirectoryIdentityDigest ||
      predecessorRelease.fence?.outcome !== "accepted" ||
      predecessorRelease.fence.versionId !==
        predecessorEvidence.deployedVersionId ||
      predecessorEvidence.deployedVersionId !==
        bridgeRelease.authority.predecessorVersionId ||
      Date.parse(predecessorEvidence.completedAt) >
        Date.parse(bridgeEvidence.completedAt) ||
      Date.parse(bridgeEvidence.completedAt) > Date.parse(value.completedAt) ||
      predecessorEvidence.digest !==
        sourceCompatibility.predecessorPlatformReleaseEvidenceDigest ||
      JSON.stringify(recomputedClosure) !==
        JSON.stringify({
          kind: sourceCompatibility.kind,
          predecessorSourceCommit:
            sourceCompatibility.predecessorSourceCommit,
          predecessorTreeObjectId:
            sourceCompatibility.predecessorTreeObjectId,
          bridgeSourceCommit: sourceCompatibility.bridgeSourceCommit,
          commits: sourceCompatibility.commits,
          reviewer: sourceCompatibility.reviewer,
          compatibilityClosureDigest:
            sourceCompatibility.compatibilityClosureDigest,
        }) ||
      bridgeRelease.fence?.outcome !== "accepted" ||
      bridgeRelease.fence.versionId !== context.servingVersionId
    ) {
      throw new Error("bridge_release_not_ready");
    }
  } catch {
    throw new Error(
      "control_d1_schema_release_serving_compatibility_proof_invalid",
    );
  }
  return {
    proof: value as unknown as ControlD1ServingCompatibilityProof,
    digest: digestBytes(bytes),
  };
}

function assertPlanServingCompatibilityProof(
  plan: ControlD1SchemaReleasePlan,
  candidate: ControlD1SchemaPlan,
  predecessor: ControlD1SchemaPlan,
  dependencies: ControlD1SchemaReleaseDependencies,
): ControlD1ServingCompatibilityProof {
  const retained = requiredServingCompatibilityProof(
    plan.servingCompatibilityProofPath,
    {
      environment: plan.environment,
      target: TARGETS[plan.environment],
      servingVersionId: plan.target.servingVersionId,
      targetDigest: plan.targetDigest,
      sourceAuthorEmail: plan.sourceAuthorEmail,
      predecessorLedgerDigest: predecessor.ledgerDigest,
      candidateLedgerDigest: candidate.ledgerDigest,
      targetMutationAuthorityPath: plan.targetMutationAuthorityPath,
      targetMutationAuthorityDirectoryIdentityDigest:
        plan.targetMutationAuthorityDirectoryIdentityDigest,
      inspectBridgeSourceCompatibility:
        dependencies.inspectBridgeSourceCompatibility,
    },
  );
  if (
    retained.digest !== plan.servingCompatibilityProofDigest ||
    retained.proof.confirmation !==
      plan.servingCompatibilityProofConfirmation ||
    retained.proof.bridgePlanPath !== plan.bridgePlanPath ||
    retained.proof.bridgePlanConfirmation !== plan.bridgePlanConfirmation ||
    retained.proof.bridgeReleaseEvidencePath !==
      plan.bridgeReleaseEvidencePath ||
    retained.proof.bridgeSourceCommit !== plan.bridgeSourceCommit ||
    retained.proof.bridgeSourceCompatibilityDigest !==
      plan.bridgeSourceCompatibilityDigest ||
    JSON.stringify(retained.proof.bridgeSourceCompatibility) !==
      JSON.stringify(plan.bridgeSourceCompatibility)
  ) {
    throw new Error(
      "control_d1_schema_release_serving_compatibility_proof_drift",
    );
  }
  return retained.proof;
}

async function assertPlanStagingReceiptAuthority(
  plan: ControlD1SchemaReleasePlan,
  candidate: ControlD1SchemaPlan,
  source: SourceInspection,
  productionCredentials: ReleaseCredentials,
  dependencies: ControlD1SchemaReleaseDependencies,
): Promise<void> {
  if (plan.environment !== "production") return;
  if (
    plan.stagingRehearsalPlanPath === null ||
    plan.stagingRehearsalPlanDigest === null ||
    plan.stagingRehearsalPlanConfirmation === null ||
    plan.stagingRehearsalCheckpointDigest === null ||
    plan.stagingRehearsalReceiptPath === null ||
    plan.stagingRehearsalReceiptDigest === null
  ) {
    throw new Error(
      "control_d1_schema_release_staging_receipt_authority_invalid",
    );
  }
  await requiredStagingReceipt(
    plan.stagingRehearsalPlanPath,
    plan.stagingRehearsalReceiptPath,
    candidate,
    source,
    {
      accountId: productionCredentials.accountId,
      databaseId: productionCredentials.databaseId,
    },
    plan.credentialCustodyDigest,
    dependencies,
    {
      planDigest: plan.stagingRehearsalPlanDigest,
      planConfirmation: plan.stagingRehearsalPlanConfirmation,
      checkpointDigest: plan.stagingRehearsalCheckpointDigest,
      receiptDigest: plan.stagingRehearsalReceiptDigest,
    },
  );
}

async function requiredStagingReceipt(
  planPath: string | undefined,
  path: string | undefined,
  candidate: ControlD1SchemaPlan,
  source: SourceInspection,
  productionTarget: Readonly<{ accountId: string; databaseId: string }>,
  productionCredentialCustodyDigest: string,
  dependencies: ControlD1SchemaReleaseDependencies,
  expected?: Readonly<{
    planDigest: string;
    planConfirmation: string;
    checkpointDigest: string;
    receiptDigest: string;
  }>,
): Promise<
  Readonly<{
    planPath: string;
    planDigest: string;
    checkpointDigest: string;
    plan: ControlD1SchemaReleasePlan;
    digest: string;
    accountId: string;
    databaseId: string;
    targetDigest: string;
    credentialCustodyDigest: string;
  }>
> {
  if (!path || !planPath) {
    throw new Error("control_d1_schema_release_staging_receipt_required");
  }
  const bytes = readStablePrivateBytes(path);
  let receipt: unknown;
  try {
    receipt = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    throw new Error("control_d1_schema_release_staging_receipt_invalid");
  }
  const receiptKeys = [
    "appliedMigrationVersions",
    "bridgeCompatibilityClosureDigest",
    "bridgePredecessorSourceCommit",
    "bridgeSourceCommit",
    "bridgeSourceCompatibilityDigest",
    "completedAt",
    "compatibilityCatalogDigest",
    "credentialCustodyDigest",
    "credentialDigest",
    "environment",
    "finalMigrationCount",
    "finalMigrationVersion",
    "finalTableCount",
    "kind",
    "ledgerDigest",
    "maintenanceReleaseReceiptDigest",
    "maintenanceStatus",
    "manifestDigest",
    "planConfirmation",
    "physicalTarget",
    "candidateChallenge",
    "mutationCheckpointDigest",
    "predecessorChallenge",
    "recovery",
    "reviewer",
    "schemaDigest",
    "servingCompatibilityProofDigest",
    "sourceCommit",
    "stagingRehearsalReceiptDigest",
    "status",
    "targetDigest",
    "timeTravelBookmarkDigest",
  ].sort();
  if (
    !record(receipt) ||
    JSON.stringify(Object.keys(receipt).sort()) !==
      JSON.stringify(receiptKeys) ||
    receipt.kind !== "takosumi.control-d1-schema-release-evidence@v3" ||
    receipt.status !== "ready" ||
    receipt.environment !== "staging" ||
    receipt.sourceCommit !== source.head ||
    receipt.manifestDigest !== candidate.manifestDigest ||
    receipt.schemaDigest !== candidate.schemaDigest ||
    receipt.ledgerDigest !== candidate.ledgerDigest ||
    JSON.stringify(receipt.appliedMigrationVersions) !== JSON.stringify([67]) ||
    receipt.finalMigrationVersion !== 67 ||
    receipt.finalMigrationCount !== 64 ||
    receipt.finalTableCount !== 38 ||
    receipt.maintenanceStatus !== "inactive" ||
    receipt.stagingRehearsalReceiptDigest !== null ||
    typeof receipt.completedAt !== "string" ||
    typeof receipt.planConfirmation !== "string" ||
    !SHA256.test(receipt.planConfirmation) ||
    typeof receipt.targetDigest !== "string" ||
    !SHA256.test(receipt.targetDigest) ||
    typeof receipt.credentialDigest !== "string" ||
    !SHA256.test(receipt.credentialDigest) ||
    typeof receipt.credentialCustodyDigest !== "string" ||
    !SHA256.test(receipt.credentialCustodyDigest) ||
    !record(receipt.physicalTarget) ||
    JSON.stringify(Object.keys(receipt.physicalTarget).sort()) !==
      JSON.stringify(["accountId", "databaseId"]) ||
    typeof receipt.physicalTarget.accountId !== "string" ||
    receipt.physicalTarget.accountId.length === 0 ||
    typeof receipt.physicalTarget.databaseId !== "string" ||
    receipt.physicalTarget.databaseId.length === 0 ||
    typeof receipt.timeTravelBookmarkDigest !== "string" ||
    !SHA256.test(receipt.timeTravelBookmarkDigest) ||
    typeof receipt.servingCompatibilityProofDigest !== "string" ||
    !SHA256.test(receipt.servingCompatibilityProofDigest) ||
    typeof receipt.bridgeSourceCompatibilityDigest !== "string" ||
    !SHA256.test(receipt.bridgeSourceCompatibilityDigest) ||
    typeof receipt.bridgePredecessorSourceCommit !== "string" ||
    !COMMIT.test(receipt.bridgePredecessorSourceCommit) ||
    typeof receipt.bridgeSourceCommit !== "string" ||
    !COMMIT.test(receipt.bridgeSourceCommit) ||
    typeof receipt.bridgeCompatibilityClosureDigest !== "string" ||
    !SHA256.test(receipt.bridgeCompatibilityClosureDigest) ||
    typeof receipt.compatibilityCatalogDigest !== "string" ||
    !SHA256.test(receipt.compatibilityCatalogDigest) ||
    typeof receipt.mutationCheckpointDigest !== "string" ||
    !SHA256.test(receipt.mutationCheckpointDigest) ||
    typeof receipt.maintenanceReleaseReceiptDigest !== "string" ||
    !SHA256.test(receipt.maintenanceReleaseReceiptDigest) ||
    typeof receipt.reviewer !== "string" ||
    !/^operator:[A-Za-z0-9._@-]{3,128}$/u.test(receipt.reviewer) ||
    !record(receipt.recovery) ||
    JSON.stringify(receipt.recovery) !==
      JSON.stringify({
        surface: "takosumi-control-d1-schema-staging",
        action: "recover",
        timeTravelRestoreAuthority: "separate-incident-boundary",
      })
  ) {
    throw new Error("control_d1_schema_release_staging_receipt_invalid");
  }
  validTimestamp(receipt.completedAt);
  if (
    (receipt.physicalTarget.accountId === productionTarget.accountId &&
      receipt.physicalTarget.databaseId === productionTarget.databaseId) ||
    receipt.credentialCustodyDigest === productionCredentialCustodyDigest
  ) {
    throw new Error(
      "control_d1_schema_release_staging_rehearsal_isolation_invalid",
    );
  }
  try {
    const stagingPlan = readPlan(
      planPath,
      receipt.planConfirmation as string,
      "staging",
    );
    assertControlD1SchemaArtifactPathGraph({
      bridgePlanPath: stagingPlan.bridgePlanPath,
      bridgePlanConfirmation: stagingPlan.bridgePlanConfirmation,
      schemaPlanPath: planPath,
      schemaCheckpointPath: stagingPlan.mutationCheckpointPath,
      servingCompatibilityProofPath:
        stagingPlan.servingCompatibilityProofPath,
      bridgeReleaseEvidencePath: stagingPlan.bridgeReleaseEvidencePath,
      predecessorPlatformPlanPath:
        stagingPlan.bridgeSourceCompatibility.predecessorPlatformPlanPath,
      predecessorPlatformPlanConfirmation:
        stagingPlan.bridgeSourceCompatibility
          .predecessorPlatformPlanConfirmation,
      predecessorPlatformReleaseEvidencePath:
        stagingPlan.bridgeSourceCompatibility
          .predecessorPlatformReleaseEvidencePath,
      evidencePath: path,
    });
    const planDigest = digestBytes(readStablePrivateBytes(planPath));
    const { candidate: retainedCandidate, predecessor } =
      await assertPlanCandidate(stagingPlan);
    if (
      stagingPlan.sourceCommit !== source.head ||
      stagingPlan.sourceBranch !== source.branch ||
      stagingPlan.sourceAuthorEmail !== source.authorEmail ||
      retainedCandidate.manifestDigest !== candidate.manifestDigest ||
      retainedCandidate.schemaDigest !== candidate.schemaDigest ||
      retainedCandidate.ledgerDigest !== candidate.ledgerDigest
    ) {
      throw new Error("staging_plan_source_invalid");
    }
    const compatibility = assertPlanServingCompatibilityProof(
      stagingPlan,
      retainedCandidate,
      predecessor,
      dependencies,
    );
    const checkpoint = readAcceptedMutationCheckpoint(
      stagingPlan.mutationCheckpointPath,
      stagingPlan.confirmation,
      stagingPlan.bridgeSourceCompatibilityDigest,
    );
    const stagingCredentials = releaseCredentials(
      "staging",
      dependencies.env ?? process.env,
    );
    assertCredentialsMatchPlan(stagingCredentials, stagingPlan);
    const remote = await (
      dependencies.createRemoteDatabase ?? createRemoteDatabase
    )(stagingCredentials);
    const serving = await readServingControlD1Binding(
      stagingCredentials,
      TARGETS.staging,
      dependencies.fetch ?? fetch,
    );
    if (serving.versionId !== stagingPlan.target.servingVersionId) {
      throw new Error("staging_serving_version_invalid");
    }
    await assertExactCandidate(remote.database, retainedCandidate, false);
    const maintenanceRelease =
      await readControlD1MaintenanceReleaseReceiptDetails(remote.database);
    if (
      maintenanceRelease === null ||
      !fenceMatchesPlan(maintenanceRelease.fence, stagingPlan) ||
      maintenanceRelease.releaseReadinessDigest !==
        checkpoint.releaseReadinessDigest
    ) {
      throw new Error("staging_maintenance_receipt_invalid");
    }
    const freshCandidateChallenge = await readControlD1BridgeChallenge(
      "staging",
      serving.versionId,
      predecessor.ledgerDigest,
      retainedCandidate.ledgerDigest,
      67,
      dependencies.fetch ?? fetch,
      dependencies.now ?? now,
      "staging_candidate_challenge_invalid",
    );
    if (
      receipt.planConfirmation !== stagingPlan.confirmation ||
      receipt.targetDigest !== stagingPlan.targetDigest ||
      receipt.physicalTarget.accountId !== stagingPlan.target.accountId ||
      receipt.physicalTarget.databaseId !== stagingPlan.target.databaseId ||
      receipt.credentialDigest !== stagingPlan.credentialDigest ||
      receipt.credentialCustodyDigest !==
        stagingPlan.credentialCustodyDigest ||
      receipt.timeTravelBookmarkDigest !==
        stagingPlan.timeTravelBookmarkDigest ||
      receipt.servingCompatibilityProofDigest !==
        stagingPlan.servingCompatibilityProofDigest ||
      receipt.bridgeSourceCompatibilityDigest !==
        stagingPlan.bridgeSourceCompatibilityDigest ||
      receipt.bridgePredecessorSourceCommit !==
        stagingPlan.bridgeSourceCompatibility.predecessorSourceCommit ||
      receipt.bridgeSourceCommit !==
        stagingPlan.bridgeSourceCompatibility.bridgeSourceCommit ||
      receipt.bridgeCompatibilityClosureDigest !==
        stagingPlan.bridgeSourceCompatibility.compatibilityClosureDigest ||
      receipt.compatibilityCatalogDigest !==
        compatibility.compatibilityCatalogDigest ||
      receipt.mutationCheckpointDigest !== checkpoint.digest ||
      receipt.maintenanceReleaseReceiptDigest !==
        digestJson(maintenanceRelease) ||
      !assertControlD1BridgeChallengeEvidence(receipt.predecessorChallenge, {
        environment: "staging",
        servingVersionId: stagingPlan.target.servingVersionId,
        predecessorLedgerDigest: predecessor.ledgerDigest,
        candidateLedgerDigest: retainedCandidate.ledgerDigest,
        acceptedMigrationVersion: 66,
      }) ||
      !assertControlD1BridgeChallengeEvidence(receipt.candidateChallenge, {
        environment: "staging",
        servingVersionId: stagingPlan.target.servingVersionId,
        predecessorLedgerDigest: predecessor.ledgerDigest,
        candidateLedgerDigest: retainedCandidate.ledgerDigest,
        acceptedMigrationVersion: 67,
      }) ||
      checkpoint.predecessorChallengeEvidenceDigest !==
        digestJson(receipt.predecessorChallenge) ||
      checkpoint.candidateChallengeEvidenceDigest !==
        digestJson(receipt.candidateChallenge) ||
      JSON.stringify(
        (receipt.candidateChallenge as ControlD1BridgeChallengeEvidence)
          .response.allowset,
      ) !== JSON.stringify(freshCandidateChallenge.response.allowset) ||
      (receipt.candidateChallenge as ControlD1BridgeChallengeEvidence).response
        .accepted.ledgerDigest !==
        freshCandidateChallenge.response.accepted.ledgerDigest ||
      Date.parse(stagingPlan.createdAt) > Date.parse(checkpoint.startedAt) ||
      Date.parse(stagingPlan.createdAt) >
        Date.parse(
          (receipt.predecessorChallenge as ControlD1BridgeChallengeEvidence)
            .observedAt,
        ) ||
      Date.parse(
        (receipt.predecessorChallenge as ControlD1BridgeChallengeEvidence)
          .observedAt,
      ) > Date.parse(checkpoint.startedAt) ||
      Date.parse(checkpoint.startedAt) > Date.parse(checkpoint.acceptedAt) ||
      Date.parse(checkpoint.acceptedAt) > Date.parse(receipt.completedAt) ||
      Date.parse(maintenanceRelease.releasedAt) >
        Date.parse(receipt.completedAt) ||
      Date.parse(
        (receipt.candidateChallenge as ControlD1BridgeChallengeEvidence)
          .observedAt,
      ) > Date.parse(receipt.completedAt)
    ) {
      throw new Error("staging_receipt_binding_invalid");
    }
    assertReviewer(receipt.reviewer as string, source.authorEmail);
    const receiptDigest = digestBytes(bytes);
    if (
      expected &&
      (expected.planDigest !== planDigest ||
        expected.planConfirmation !== stagingPlan.confirmation ||
        expected.checkpointDigest !== checkpoint.digest ||
        expected.receiptDigest !== receiptDigest)
    ) {
      throw new Error("staging_receipt_plan_drift");
    }
    return {
      planPath,
      planDigest,
      checkpointDigest: checkpoint.digest,
      plan: stagingPlan,
      digest: receiptDigest,
      accountId: receipt.physicalTarget.accountId,
      databaseId: receipt.physicalTarget.databaseId,
      targetDigest: receipt.targetDigest,
      credentialCustodyDigest: receipt.credentialCustodyDigest,
    };
  } catch (error) {
    throw new Error(
      "control_d1_schema_release_staging_receipt_authority_invalid",
      { cause: error },
    );
  }
}

function readAcceptedMutationCheckpoint(
  path: string,
  planConfirmation: string,
  bridgeSourceCompatibilityDigest: string,
): Readonly<{
  digest: string;
  startedDigest: string;
  releaseReadinessDigest: string;
  predecessorChallengeEvidenceDigest: string;
  candidateChallengeEvidenceDigest: string;
  startedAt: string;
  acceptedAt: string;
}> {
  const checkpoint = readMutationCheckpoint(
    path,
    planConfirmation,
    bridgeSourceCompatibilityDigest,
  );
  if (
    checkpoint.acceptedAt === undefined ||
    checkpoint.candidateChallengeEvidenceDigest === undefined
  ) {
    throw new Error("control_d1_schema_release_mutation_checkpoint_invalid");
  }
  return {
    ...checkpoint,
    candidateChallengeEvidenceDigest:
      checkpoint.candidateChallengeEvidenceDigest,
    acceptedAt: checkpoint.acceptedAt,
  };
}

function readStartedMutationCheckpoint(
  path: string,
  planConfirmation: string,
  bridgeSourceCompatibilityDigest: string,
): Readonly<{
  digest: string;
  startedDigest: string;
  releaseReadinessDigest: string;
  predecessorChallengeEvidenceDigest: string;
  candidateChallengeEvidenceDigest?: string;
  startedAt: string;
  acceptedAt?: string;
}> {
  return readMutationCheckpoint(
    path,
    planConfirmation,
    bridgeSourceCompatibilityDigest,
  );
}

function readMutationCheckpoint(
  path: string,
  planConfirmation: string,
  bridgeSourceCompatibilityDigest: string,
): Readonly<{
  digest: string;
  startedDigest: string;
  releaseReadinessDigest: string;
  predecessorChallengeEvidenceDigest: string;
  candidateChallengeEvidenceDigest?: string;
  startedAt: string;
  acceptedAt?: string;
}> {
  const bytes = readStablePrivateBytes(path);
  let records: unknown[];
  let lines: string[];
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!text.endsWith("\n")) throw new Error("checkpoint_newline_invalid");
    lines = text.slice(0, -1).split("\n");
    records = lines.map((line) => JSON.parse(line) as unknown);
    if (lines.some((line, index) => line !== JSON.stringify(records[index]))) {
      throw new Error("checkpoint_not_canonical");
    }
  } catch (error) {
    throw new Error("control_d1_schema_release_mutation_checkpoint_invalid", {
      cause: error,
    });
  }
  const [started, accepted] = records;
  if (
    (records.length !== 1 && records.length !== 2) ||
    !record(started) ||
    JSON.stringify(Object.keys(started).sort()) !==
      JSON.stringify(
        [
          "bridgeSourceCompatibilityDigest",
          "kind",
          "outcome",
          "planConfirmation",
          "predecessorChallengeEvidenceDigest",
          "recordedAt",
        ].sort(),
      ) ||
    started.kind !== "takosumi.control-d1-schema-mutation-checkpoint@v3" ||
    started.outcome !== "unknown" ||
    started.planConfirmation !== planConfirmation ||
    started.bridgeSourceCompatibilityDigest !==
      bridgeSourceCompatibilityDigest ||
    !SHA256.test(String(started.bridgeSourceCompatibilityDigest)) ||
    !SHA256.test(String(started.predecessorChallengeEvidenceDigest)) ||
    typeof started.recordedAt !== "string" ||
    (records.length === 2 &&
      (!record(accepted) ||
        JSON.stringify(Object.keys(accepted).sort()) !==
          JSON.stringify(
            [
              "appliedMigrationVersions",
              "bridgeSourceCompatibilityDigest",
              "candidateChallengeEvidenceDigest",
              "kind",
              "outcome",
              "planConfirmation",
              "recordedAt",
            ].sort(),
          ) ||
        accepted.kind !==
          "takosumi.control-d1-schema-mutation-checkpoint@v3" ||
        accepted.outcome !== "accepted" ||
        accepted.planConfirmation !== planConfirmation ||
        accepted.bridgeSourceCompatibilityDigest !==
          bridgeSourceCompatibilityDigest ||
        JSON.stringify(accepted.appliedMigrationVersions) !==
          JSON.stringify([67]) ||
        !SHA256.test(String(accepted.candidateChallengeEvidenceDigest)) ||
        typeof accepted.recordedAt !== "string"))
  ) {
    throw new Error("control_d1_schema_release_mutation_checkpoint_invalid");
  }
  try {
    const startedAt = validTimestamp(started.recordedAt);
    const acceptedAt =
      record(accepted) && typeof accepted.recordedAt === "string"
        ? validTimestamp(accepted.recordedAt)
        : undefined;
    if (acceptedAt !== undefined && Date.parse(startedAt) > Date.parse(acceptedAt)) {
      throw new Error("checkpoint_time_invalid");
    }
    const startedDigest = digestBytes(
      new TextEncoder().encode(`${lines[0]}\n`),
    );
    return {
      digest: digestBytes(bytes),
      startedDigest,
      releaseReadinessDigest: digestJson({
        kind: "takosumi.control-d1-schema-release-readiness@v1",
        planConfirmation,
        bridgeSourceCompatibilityDigest,
        mutationCheckpointStartedDigest: startedDigest,
      }),
      predecessorChallengeEvidenceDigest:
        started.predecessorChallengeEvidenceDigest as string,
      ...(record(accepted)
        ? {
            candidateChallengeEvidenceDigest:
              accepted.candidateChallengeEvidenceDigest as string,
          }
        : {}),
      startedAt,
      ...(acceptedAt === undefined ? {} : { acceptedAt }),
    };
  } catch (error) {
    throw new Error("control_d1_schema_release_mutation_checkpoint_invalid", {
      cause: error,
    });
  }
}

/**
 * Canonical repository proof from the exact previously serving source to the
 * bridge source. Every descendant must form one linear history edge, and each
 * edge binds its parent, tree, path list, and deterministic full-index binary
 * patch. The aggregate is therefore reviewable even when the safe bridge is a
 * multi-commit closure; no fixed path allowlist or caller-authored summary can
 * stand in for the actual Git objects.
 */
export function inspectControlD1BridgeSourceCompatibility(
  predecessorSourceCommit: string,
  bridgeSourceCommit: string,
  reviewer: string,
): ControlD1BridgeSourceClosure {
  assertGitObjectReplacementUnavailable();
  if (
    !COMMIT.test(predecessorSourceCommit) ||
    !COMMIT.test(bridgeSourceCommit) ||
    predecessorSourceCommit === bridgeSourceCommit ||
    !/^operator:[A-Za-z0-9._@-]{3,128}$/u.test(reviewer) ||
    git(["cat-file", "-t", predecessorSourceCommit]).trim() !== "commit" ||
    git(["cat-file", "-t", bridgeSourceCommit]).trim() !== "commit" ||
    !gitCommitIsAncestor(predecessorSourceCommit, bridgeSourceCommit)
  ) {
    throw new Error(
      "control_d1_serving_compatibility_proof_source_lineage_invalid",
    );
  }
  const predecessorTreeObjectId = git([
    "show",
    "-s",
    "--format=%T",
    predecessorSourceCommit,
  ]).trim();
  const sourceCommits = git([
    "rev-list",
    "--reverse",
    `${predecessorSourceCommit}..${bridgeSourceCommit}`,
  ])
    .trim()
    .split("\n")
    .filter(Boolean);
  if (
    !GIT_TREE.test(predecessorTreeObjectId) ||
    sourceCommits.length === 0 ||
    sourceCommits.at(-1) !== bridgeSourceCommit
  ) {
    throw new Error(
      "control_d1_serving_compatibility_proof_source_lineage_invalid",
    );
  }

  const reviewerEmail = reviewer.slice("operator:".length).toLowerCase();
  const commits: ControlD1BridgeSourceCommitClosureEntry[] = [];
  let expectedParent = predecessorSourceCommit;
  for (const sourceCommit of sourceCommits) {
    const parents = git(["show", "-s", "--format=%P", sourceCommit])
      .trim()
      .split(" ")
      .filter(Boolean);
    const treeObjectId = git([
      "show",
      "-s",
      "--format=%T",
      sourceCommit,
    ]).trim();
    const authorEmail = git(["show", "-s", "--format=%ae", sourceCommit])
      .trim()
      .toLowerCase();
    if (
      !COMMIT.test(sourceCommit) ||
      parents.length !== 1 ||
      parents[0] !== expectedParent ||
      !GIT_TREE.test(treeObjectId) ||
      authorEmail === reviewerEmail
    ) {
      throw new Error(
        "control_d1_serving_compatibility_proof_source_lineage_invalid",
      );
    }
    const changedPaths = canonicalGitChangedPaths(
      expectedParent,
      sourceCommit,
    );
    const patch = canonicalGitPatch(expectedParent, sourceCommit);
    if (changedPaths.length === 0 || patch.byteLength === 0) {
      throw new Error(
        "control_d1_serving_compatibility_proof_patch_scope_invalid",
      );
    }
    commits.push({
      sourceCommit,
      parentSourceCommit: expectedParent,
      treeObjectId,
      canonicalPatchDigest: digestBytes(patch),
      changedPaths,
    });
    expectedParent = sourceCommit;
  }

  const identity = {
    kind: "takosumi.control-d1-bridge-source-compatibility@v2" as const,
    predecessorSourceCommit,
    predecessorTreeObjectId,
    bridgeSourceCommit,
    commits,
    reviewer,
  };
  return {
    ...identity,
    compatibilityClosureDigest: digestJson(identity),
  };
}

function canonicalGitChangedPaths(
  parentSourceCommit: string,
  sourceCommit: string,
): readonly string[] {
  const paths = new TextDecoder("utf-8", { fatal: true })
    .decode(
      gitBytes([
        "diff",
        "--name-only",
        "-z",
        "--no-renames",
        parentSourceCommit,
        sourceCommit,
        "--",
      ]),
    )
    .split("\0")
    .filter((path) => path.length > 0);
  if (
    paths.some(
      (path) =>
        path.startsWith("/") ||
        path.split("/").some((segment) => segment === ".."),
    ) ||
    new Set(paths).size !== paths.length
  ) {
    throw new Error(
      "control_d1_serving_compatibility_proof_patch_scope_invalid",
    );
  }
  return paths;
}

function canonicalGitPatch(
  parentSourceCommit: string,
  sourceCommit: string,
): Uint8Array {
  return gitBytes([
    "diff",
    "--binary",
    "--full-index",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--diff-algorithm=myers",
    "--no-indent-heuristic",
    "--unified=3",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    parentSourceCommit,
    sourceCommit,
    "--",
  ]);
}

function assertControlD1BridgeSourceCompatibility(
  value: unknown,
  expected: Omit<
    ControlD1BridgeSourceCompatibility,
    | "kind"
    | "predecessorTreeObjectId"
    | "commits"
    | "compatibilityClosureDigest"
  >,
): asserts value is ControlD1BridgeSourceCompatibility {
  const keys = [
    "bridgeSourceCommit",
    "commits",
    "compatibilityClosureDigest",
    "kind",
    "predecessorPlatformPlanConfirmation",
    "predecessorPlatformPlanPath",
    "predecessorPlatformReleaseEvidenceDigest",
    "predecessorPlatformReleaseEvidencePath",
    "predecessorServingVersionId",
    "predecessorSourceCommit",
    "predecessorTreeObjectId",
    "reviewer",
  ].sort();
  const commits = record(value) && Array.isArray(value.commits)
    ? value.commits
    : [];
  let expectedParent = record(value)
    ? String(value.predecessorSourceCommit)
    : "";
  let commitsValid = commits.length > 0;
  const seenCommits = new Set<string>();
  for (const entry of commits) {
    const entryKeys = [
      "canonicalPatchDigest",
      "changedPaths",
      "parentSourceCommit",
      "sourceCommit",
      "treeObjectId",
    ].sort();
    if (
      !record(entry) ||
      JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(entryKeys) ||
      !COMMIT.test(String(entry.sourceCommit)) ||
      entry.parentSourceCommit !== expectedParent ||
      !COMMIT.test(String(entry.parentSourceCommit)) ||
      !GIT_TREE.test(String(entry.treeObjectId)) ||
      !SHA256.test(String(entry.canonicalPatchDigest)) ||
      !Array.isArray(entry.changedPaths) ||
      entry.changedPaths.length === 0 ||
      entry.changedPaths.some(
        (path) =>
          typeof path !== "string" ||
          path.length === 0 ||
          path.startsWith("/") ||
          path.split("/").some((segment) => segment === ".."),
      ) ||
      new Set(entry.changedPaths).size !== entry.changedPaths.length ||
      seenCommits.has(String(entry.sourceCommit))
    ) {
      commitsValid = false;
      break;
    }
    seenCommits.add(String(entry.sourceCommit));
    expectedParent = String(entry.sourceCommit);
  }
  const closureIdentity = record(value)
    ? {
        kind: value.kind,
        predecessorSourceCommit: value.predecessorSourceCommit,
        predecessorTreeObjectId: value.predecessorTreeObjectId,
        bridgeSourceCommit: value.bridgeSourceCommit,
        commits: value.commits,
        reviewer: value.reviewer,
      }
    : undefined;
  if (
    !record(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys) ||
    value.kind !== "takosumi.control-d1-bridge-source-compatibility@v2" ||
    value.predecessorSourceCommit !== expected.predecessorSourceCommit ||
    value.bridgeSourceCommit !== expected.bridgeSourceCommit ||
    value.predecessorServingVersionId !==
      expected.predecessorServingVersionId ||
    value.predecessorPlatformPlanPath !==
      expected.predecessorPlatformPlanPath ||
    value.predecessorPlatformPlanConfirmation !==
      expected.predecessorPlatformPlanConfirmation ||
    value.predecessorPlatformReleaseEvidencePath !==
      expected.predecessorPlatformReleaseEvidencePath ||
    value.predecessorPlatformReleaseEvidenceDigest !==
      expected.predecessorPlatformReleaseEvidenceDigest ||
    value.reviewer !== expected.reviewer ||
    !COMMIT.test(String(value.predecessorSourceCommit)) ||
    !COMMIT.test(String(value.bridgeSourceCommit)) ||
    value.predecessorSourceCommit === value.bridgeSourceCommit ||
    !GIT_TREE.test(String(value.predecessorTreeObjectId)) ||
    !commitsValid ||
    expectedParent !== value.bridgeSourceCommit ||
    !UUID.test(String(value.predecessorServingVersionId)) ||
    !isAbsolute(String(value.predecessorPlatformPlanPath)) ||
    resolve(String(value.predecessorPlatformPlanPath)) !==
      value.predecessorPlatformPlanPath ||
    !SHA256.test(String(value.predecessorPlatformPlanConfirmation)) ||
    !isAbsolute(String(value.predecessorPlatformReleaseEvidencePath)) ||
    resolve(String(value.predecessorPlatformReleaseEvidencePath)) !==
      value.predecessorPlatformReleaseEvidencePath ||
    !SHA256.test(String(value.predecessorPlatformReleaseEvidenceDigest)) ||
    !SHA256.test(String(value.compatibilityClosureDigest)) ||
    value.compatibilityClosureDigest !== digestJson(closureIdentity) ||
    !/^operator:[A-Za-z0-9._@-]{3,128}$/u.test(String(value.reviewer))
  ) {
    throw new Error(
      "control_d1_serving_compatibility_proof_source_lineage_invalid",
    );
  }
}

function inspectSourceCheckout(): SourceInspection {
  const head = git(["rev-parse", "HEAD"]).trim();
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  const clean =
    git(["status", "--porcelain", "--untracked-files=all"]).trim() === "";
  const remote = git([
    "ls-remote",
    "--heads",
    "origin",
    `refs/heads/${branch}`,
  ]);
  const pushed = remote
    .split("\n")
    .some((line) => line.trim() === `${head}\trefs/heads/${branch}`);
  const authorEmail = git(["show", "-s", "--format=%ae", "HEAD"]).trim();
  return { head, branch, clean, pushed, authorEmail };
}

function assertSourceReady(source: SourceInspection): void {
  if (
    !COMMIT.test(source.head) ||
    !/^[A-Za-z0-9._/-]{1,200}$/u.test(source.branch) ||
    source.branch === "HEAD" ||
    !source.clean ||
    !source.pushed ||
    !/^[^\s@]+@[^\s@]+$/u.test(source.authorEmail)
  ) {
    throw new Error("control_d1_schema_release_source_not_clean_pushed");
  }
}

function git(args: readonly string[]): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(gitBytes(args));
}

function gitBytes(args: readonly string[]): Uint8Array {
  const result = gitSpawn(args);
  if (result.exitCode !== 0) {
    throw new Error("control_d1_schema_release_git_failed");
  }
  return result.stdout;
}

function gitCommitIsAncestor(ancestor: string, descendant: string): boolean {
  const result = gitSpawn(["merge-base", "--is-ancestor", ancestor, descendant]);
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw new Error("control_d1_schema_release_git_failed");
}

function gitSpawn(args: readonly string[]): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(["git", "--no-replace-objects", ...args], {
    cwd: ROOT,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: process.env.HOME ?? "/root",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
    },
  });
}

/**
 * Replacement refs and legacy grafts can make two Git commands in the same
 * checkout agree on a caller-substituted graph. Every command already ignores
 * replacement objects, but the presence of either mechanism is itself
 * provenance drift and therefore rejects the bridge closure before any object
 * or ancestry inspection.
 */
function assertGitObjectReplacementUnavailable(): void {
  const replacementRefs = git([
    "for-each-ref",
    "--format=%(refname)",
    "refs/replace",
  ]).trim();
  const graftPath = git([
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "info/grafts",
  ]).trim();
  let graftExists = false;
  try {
    lstatSync(graftPath);
    graftExists = true;
  } catch (error) {
    if (
      !record(error) ||
      typeof error.code !== "string" ||
      error.code !== "ENOENT"
    ) {
      throw new Error(
        "control_d1_serving_compatibility_proof_source_replacement_invalid",
      );
    }
  }
  if (
    replacementRefs.length > 0 ||
    !isAbsolute(graftPath) ||
    resolve(graftPath) !== graftPath ||
    graftExists
  ) {
    throw new Error(
      "control_d1_serving_compatibility_proof_source_replacement_invalid",
    );
  }
}

function validTimestamp(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error("control_d1_schema_release_time_invalid");
  }
  return value;
}

function validBookmark(value: string): string {
  if (
    value.length === 0 ||
    value.length > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("control_d1_schema_release_bookmark_invalid");
  }
  return value;
}

function opaqueSegment(value: string | undefined, code: string): string {
  const normalized = value?.trim();
  if (!normalized || !/^[A-Za-z0-9_-]{1,128}$/u.test(normalized)) {
    throw new Error(code);
  }
  return normalized;
}

function secret(value: string | undefined, code: string): string {
  const normalized = value?.trim();
  if (
    !normalized ||
    normalized.length > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new Error(code);
  }
  return normalized;
}

function writePublic(
  dependencies: ControlD1SchemaReleaseDependencies,
  value: unknown,
): void {
  const serialized = JSON.stringify(value);
  if (dependencies.write) dependencies.write(serialized);
  else process.stdout.write(`${serialized}\n`);
}

function digestJson(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function credentialCustodyDigest(apiToken: string): string {
  return digestJson({
    kind: "takosumi.control-d1-credential-custody@v1",
    apiToken,
  });
}

function digestBytes(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function absolute(value: string): string {
  if (!isAbsolute(value) || resolve(value) !== value) {
    throw new Error("control_d1_schema_release_path_invalid");
  }
  return value;
}

function assertControlD1SchemaArtifactPathGraph(
  input: Readonly<{
    bridgePlanPath: string;
    bridgePlanConfirmation: string;
    schemaPlanPath: string;
    schemaCheckpointPath: string;
    servingCompatibilityProofPath: string;
    bridgeReleaseEvidencePath: string;
    predecessorPlatformPlanPath: string;
    predecessorPlatformPlanConfirmation: string;
    predecessorPlatformReleaseEvidencePath: string;
    evidencePath?: string;
    stagingReceiptPath?: string;
    stagingPlanPath?: string;
    stagingCheckpointPath?: string;
    stagingServingCompatibilityProofPath?: string;
    stagingBridgePlanPath?: string;
    stagingBridgeReleaseEvidencePath?: string;
  }>,
): void {
  try {
    assertPlatformReleaseArtifactPathGraph(
      input.predecessorPlatformPlanPath,
      input.predecessorPlatformPlanConfirmation,
      [
        {
          label: "predecessor-release-evidence",
          path: input.predecessorPlatformReleaseEvidencePath,
        },
      ],
    );
    assertPlatformReleaseArtifactPathGraph(
      input.bridgePlanPath,
      input.bridgePlanConfirmation,
      [
        { label: "schema-plan", path: input.schemaPlanPath },
        { label: "schema-checkpoint", path: input.schemaCheckpointPath },
        {
          label: "schema-serving-compatibility-proof",
          path: input.servingCompatibilityProofPath,
        },
        {
          label: "bridge-release-evidence",
          path: input.bridgeReleaseEvidencePath,
        },
        {
          label: "predecessor-platform-plan",
          path: input.predecessorPlatformPlanPath,
        },
        {
          label: "predecessor-platform-release-evidence",
          path: input.predecessorPlatformReleaseEvidencePath,
        },
        ...(input.evidencePath
          ? [{ label: "schema-evidence", path: input.evidencePath }]
          : []),
        ...(input.stagingReceiptPath
          ? [
              {
                label: "schema-staging-receipt",
                path: input.stagingReceiptPath,
              },
            ]
          : []),
        ...(input.stagingPlanPath
          ? [{ label: "schema-staging-plan", path: input.stagingPlanPath }]
          : []),
        ...(input.stagingCheckpointPath
          ? [
              {
                label: "schema-staging-checkpoint",
                path: input.stagingCheckpointPath,
              },
            ]
          : []),
        ...(input.stagingServingCompatibilityProofPath
          ? [
              {
                label: "schema-staging-serving-compatibility-proof",
                path: input.stagingServingCompatibilityProofPath,
              },
            ]
          : []),
        ...(input.stagingBridgePlanPath
          ? [
              {
                label: "schema-staging-bridge-plan",
                path: input.stagingBridgePlanPath,
              },
            ]
          : []),
        ...(input.stagingBridgeReleaseEvidencePath
          ? [
              {
                label: "schema-staging-bridge-release-evidence",
                path: input.stagingBridgeReleaseEvidencePath,
              },
            ]
          : []),
      ],
    );
  } catch (error) {
    throw new Error("control_d1_schema_release_artifact_path_alias", {
      cause: error,
    });
  }
}

function stagingArtifactPaths(
  plan: ControlD1SchemaReleasePlan,
): Readonly<{
  stagingReceiptPath?: string;
  stagingPlanPath?: string;
  stagingCheckpointPath?: string;
  stagingServingCompatibilityProofPath?: string;
  stagingBridgePlanPath?: string;
  stagingBridgeReleaseEvidencePath?: string;
}> {
  if (
    plan.environment !== "production" ||
    plan.stagingRehearsalReceiptPath === null ||
    plan.stagingRehearsalPlanPath === null
  ) {
    return {};
  }
  const stagingPlan = readPlan(
    plan.stagingRehearsalPlanPath,
    plan.stagingRehearsalPlanConfirmation!,
    "staging",
  );
  return {
    stagingReceiptPath: plan.stagingRehearsalReceiptPath,
    stagingPlanPath: plan.stagingRehearsalPlanPath,
    stagingCheckpointPath: stagingPlan.mutationCheckpointPath,
    stagingServingCompatibilityProofPath:
      stagingPlan.servingCompatibilityProofPath,
    stagingBridgePlanPath: stagingPlan.bridgePlanPath,
    stagingBridgeReleaseEvidencePath: stagingPlan.bridgeReleaseEvidencePath,
  };
}

function assertExternalAbsent(path: string): void {
  if (insideRoot(path)) {
    throw new Error("control_d1_schema_release_output_must_be_external");
  }
  assertOutsideGitWorktree(path);
  const parent = dirname(path);
  const status = lstatSync(parent);
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    status.uid !== process.getuid?.() ||
    (status.mode & 0o077) !== 0 ||
    realpathSync(parent) !== parent
  ) {
    throw new Error("control_d1_schema_release_output_parent_invalid");
  }
  try {
    lstatSync(path);
    throw new Error("control_d1_schema_release_output_exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function assertPrivateFile(path: string): void {
  assertOutsideGitWorktree(path);
  const status = lstatSync(path);
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    status.nlink !== 1 ||
    status.uid !== process.getuid?.() ||
    (status.mode & 0o777) !== 0o600 ||
    realpathSync(path) !== path
  ) {
    throw new Error("control_d1_schema_release_private_file_invalid");
  }
}

function assertOutsideGitWorktree(path: string): void {
  let cursor = dirname(resolve(path));
  for (;;) {
    try {
      lstatSync(join(cursor, ".git"));
      throw new Error(
        "control_d1_schema_release_output_must_be_globally_external",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

function writePrivate(path: string, bytes: Uint8Array): void {
  const directory = dirname(path);
  const pendingPath = join(
    directory,
    `${basename(path)}.pending-${process.pid}-${randomBytes(16).toString("hex")}`,
  );
  const descriptor = openSync(
    pendingPath,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  let descriptorOpen = true;
  let canonicalLinked = false;
  let publicationComplete = false;
  let fileIdentity: Readonly<{ dev: bigint; ino: bigint }> | null = null;
  try {
    fchmodSync(descriptor, 0o600);
    const before = fstatSync(descriptor, { bigint: true });
    fileIdentity = { dev: before.dev, ino: before.ino };
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.uid !== BigInt(process.getuid?.() ?? -1) ||
      (before.mode & 0o777n) !== 0o600n
    ) {
      throw new Error("control_d1_schema_release_private_file_invalid");
    }
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    const complete = fstatSync(descriptor, { bigint: true });
    const pending = lstatSync(pendingPath, { bigint: true });
    if (
      before.dev !== complete.dev ||
      before.ino !== complete.ino ||
      complete.dev !== pending.dev ||
      complete.ino !== pending.ino ||
      complete.nlink !== 1n ||
      pending.nlink !== 1n
    ) {
      throw new Error("control_d1_schema_release_private_file_invalid");
    }
    try {
      linkSync(pendingPath, path);
      canonicalLinked = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("control_d1_schema_release_output_exists", {
          cause: error,
        });
      }
      throw error;
    }
    syncPrivateDirectory(directory);
    const published = lstatSync(path, { bigint: true });
    const publishedPending = lstatSync(pendingPath, { bigint: true });
    const openedPublished = fstatSync(descriptor, { bigint: true });
    if (
      !published.isFile() ||
      published.isSymbolicLink() ||
      published.uid !== BigInt(process.getuid?.() ?? -1) ||
      (published.mode & 0o777n) !== 0o600n ||
      published.dev !== openedPublished.dev ||
      published.ino !== openedPublished.ino ||
      published.dev !== publishedPending.dev ||
      published.ino !== publishedPending.ino ||
      published.nlink !== 2n ||
      openedPublished.nlink !== 2n
    ) {
      throw new Error("control_d1_schema_release_private_file_invalid");
    }
    unlinkSync(pendingPath);
    syncPrivateDirectory(directory);
    const finalOpened = fstatSync(descriptor, { bigint: true });
    const finalPublished = lstatSync(path, { bigint: true });
    if (
      finalOpened.dev !== finalPublished.dev ||
      finalOpened.ino !== finalPublished.ino ||
      finalOpened.nlink !== 1n ||
      finalPublished.nlink !== 1n
    ) {
      throw new Error("control_d1_schema_release_private_file_invalid");
    }
    publicationComplete = true;
  } finally {
    if (descriptorOpen) {
      closeSync(descriptor);
      descriptorOpen = false;
    }
    if (canonicalLinked && fileIdentity !== null) {
      let canonical: ReturnType<typeof lstatSync> | null = null;
      try {
        canonical = lstatSync(path, { bigint: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (
        canonical !== null &&
        (canonical.dev !== fileIdentity.dev ||
          canonical.ino !== fileIdentity.ino)
      ) {
        throw new Error("control_d1_schema_release_private_file_invalid");
      }
      if (!publicationComplete && canonical !== null) unlinkSync(path);
    }
    try {
      unlinkSync(pendingPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    syncPrivateDirectory(directory);
  }
}

function syncPrivateDirectory(directory: string): void {
  const descriptor = openSync(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function appendPrivate(path: string, bytes: Uint8Array): void {
  assertPrivateFile(path);
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
  );
  try {
    const before = fstatSync(descriptor, { bigint: true });
    const pathBefore = lstatSync(path, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.dev !== pathBefore.dev ||
      before.ino !== pathBefore.ino
    ) {
      throw new Error("control_d1_schema_release_private_file_invalid");
    }
    writeSync(descriptor, bytes);
    fsyncSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(path, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      after.dev !== pathAfter.dev ||
      after.ino !== pathAfter.ino ||
      after.nlink !== 1n
    ) {
      throw new Error("control_d1_schema_release_private_file_invalid");
    }
  } finally {
    closeSync(descriptor);
  }
}

function readStablePrivateBytes(path: string): Uint8Array {
  assertPrivateFile(path);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor, { bigint: true });
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(path, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      after.dev !== pathAfter.dev ||
      after.ino !== pathAfter.ino ||
      after.size !== BigInt(bytes.byteLength)
    ) {
      throw new Error("control_d1_schema_release_private_file_invalid");
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function insideRoot(path: string): boolean {
  const child = relative(ROOT, path);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function now(): string {
  return new Date().toISOString();
}

async function waitForRequestDrain(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveWait) =>
    setTimeout(resolveWait, milliseconds),
  );
}
