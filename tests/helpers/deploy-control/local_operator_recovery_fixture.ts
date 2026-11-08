import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ApplyRun, PlanRun } from "@takosumi/internal/deploy-control-api";
import { ObjectKeyArtifactReferenceAllocator } from "../../../core/adapters/storage/artifact-references.ts";
import { PartitionedSecretBoundaryCrypto } from "../../../core/adapters/secret-store/memory.ts";
import { sha256Digest } from "../../../core/adapters/source/digest.ts";
import { InMemoryOpenTofuControlStore, type OpenTofuControlStore } from "../../../core/domains/deploy-control/store.ts";
import { createFileOpenTofuStateArtifactStore } from "../../../deploy/node-postgres/src/local-opentofu-runner.ts";
import { LocalOpenTofuStateRecoveryArtifactStore } from "../../../deploy/node-postgres/src/local-state-recovery-artifact-store.ts";
import type { LocalStateRecoveryApproval } from "../../../scripts/lib/local-operator-state-recovery.ts";
import { seedCapsuleModel } from "./model_fixture.ts";

export const OPERATOR_RECOVERY_TEST_SOURCE_ROOT = resolve(import.meta.dir, "../../..");
const DIGEST = `sha256:${"a".repeat(64)}` as const;
const STATE = new TextEncoder().encode('{"version":4,"serial":1,"lineage":"123e4567-e89b-42d3-a456-426614174000","terraform_version":"1.9.0","outputs":{},"resources":[]}');

export async function createLocalOperatorRecoveryFixture(store: OpenTofuControlStore = new InMemoryOpenTofuControlStore()) {
  // Approval custody cannot use /tmp's world-writable ancestry, even when
  // the immediate mkdtemp directory is private. Local runs may select NVMe.
  const root = await mkdtemp(join(process.env.TAKOSUMI_OPERATOR_RECOVERY_TEST_ROOT ?? homedir(), ".takosumi-operator-recovery-test-"));
  const approvalDirectory = join(root, "approvals");
  await mkdir(approvalDirectory, { mode: 0o700 });
  const seeded = await seedCapsuleModel(store, { workspaceId: "ws_operator_recovery", capsuleId: "cap_operator_recovery",
    sourceId: "src_operator_recovery", snapshotId: "snap_operator_recovery", installConfigId: "cfg_operator_recovery" });
  const epoch = (await store.getCapsuleExecutionAuthorityEpoch(seeded.capsule.id))!;
  const plan: PlanRun = { id: "plan_operator_recovery", workspaceId: seeded.workspace.id, capsuleId: seeded.capsule.id,
    capsuleCurrentStateVersionId: null, capsuleExecutionAuthorityEpoch: epoch,
    capsuleContext: { workspaceId: seeded.workspace.id, capsuleId: seeded.capsule.id, environment: seeded.capsule.environment },
    source: { kind: "git", url: seeded.snapshot.url, commit: seeded.snapshot.resolvedCommit }, sourceDigest: DIGEST,
    operation: "create", runnerProfileId: "opentofu-default", variablesDigest: DIGEST, executionInputsDigest: DIGEST,
    requiredProviders: [], status: "succeeded", policy: { status: "passed", reasons: [], checkedAt: 1 },
    policyDecisionDigest: DIGEST, planDigest: DIGEST, planArtifact: { kind: "object-storage", ref: "fixture_plan", digest: DIGEST },
    sourceSnapshotId: seeded.snapshot.id, baseStateGeneration: 0, appliedApplyRunId: "apply_operator_recovery",
    planResourceChanges: [{ address: "example_resource.a", type: "example_resource", actions: ["create"] }],
    auditEvents: [], createdAt: 1, updatedAt: 1 };
  const failed: ApplyRun = { id: "apply_operator_recovery", planRunId: plan.id, workspaceId: seeded.workspace.id,
    capsuleId: seeded.capsule.id, operation: "create", runnerProfileId: plan.runnerProfileId, status: "failed",
    expected: { planRunId: plan.id, capsuleId: seeded.capsule.id, currentStateVersionId: null,
      capsuleExecutionAuthorityEpoch: epoch, runnerProfileId: plan.runnerProfileId, sourceDigest: DIGEST,
      variablesDigest: DIGEST, policyDecisionDigest: DIGEST, planDigest: DIGEST, planArtifactDigest: DIGEST },
    stateBackend: { kind: "operator-managed", ref: "fixture_backend" }, stateLock: { status: "recorded", backendRef: "fixture_backend" },
    auditEvents: [{ id: "event_operator_recovery", type: "apply.failed", at: 2, data: { providerDispatched: true } }],
    createdAt: 2, updatedAt: 3, startedAt: 2, finishedAt: 3 };
  await store.putPlanRun(plan); await store.putApplyRun(failed);
  await store.patchCapsule(seeded.capsule.id, { status: "error", updatedAt: "2026-06-07T00:00:00.000Z" }, { status: "pending" });
  const artifactStore = createFileOpenTofuStateArtifactStore(join(root, "state"), new PartitionedSecretBoundaryCrypto({
    globalPassphrase: "synthetic-operator-recovery-test-key-at-least-32-bytes",
  }));
  const verifier = new LocalOpenTofuStateRecoveryArtifactStore({ store: artifactStore,
    allocator: new ObjectKeyArtifactReferenceAllocator(), capsules: store });
  // Synthetic initial custody, separate from the commit-only command under test.
  const staged = await verifier.stage({ workspaceId: seeded.workspace.id, capsuleId: seeded.capsule.id,
    environment: seeded.capsule.environment, generation: 1, failedApplyRunId: failed.id, recoveryRunId: "recovery_operator_case",
    plaintextSha256: await sha256Digest(STATE), custodyEvidenceDigest: DIGEST, plaintext: STATE });
  const profile: LocalStateRecoveryApproval = { format: "takosumi.local-operator-state-recovery/v1",
    purpose: "commit-staged-initial-create-state", caseId: "case_one", approvedOperatorId: `local-unix-account:${process.getuid!()}`,
    selectedTargetId: "fixture-target", workspaceId: seeded.workspace.id, capsuleId: seeded.capsule.id,
    environment: seeded.capsule.environment, failedApplyRunId: failed.id, recoveryRunId: "recovery_operator_case",
    commandTimestamp: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    artifactHandle: staged.handle, plaintextSha256: staged.artifact.plaintextSha256,
    encryptedDigest: staged.artifact.encryptedDigest, evidenceDigest: staged.artifact.evidenceDigest };
  const path = join(approvalDirectory, "case_one.json");
  const write = async (value: unknown) => { await writeFile(path, JSON.stringify(value), { mode: 0o600 }); await chmod(path, 0o600); };
  await write(profile);
  return { root, store, seeded, plan, failed, staged, profile, path, write, artifactStore,
    input: { approvalDirectory, caseId: "case_one", selectedTargetId: "fixture-target", sourceRoots: [OPERATOR_RECOVERY_TEST_SOURCE_ROOT], store, verifier } };
}
