import { expect, spyOn, test } from "bun:test";
import { chmod, link, readFile, rm, stat, symlink, truncate, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { sha256Digest } from "../../core/adapters/source/digest.ts";
import { commitApprovedLocalStateRecovery } from "../../scripts/lib/local-operator-state-recovery.ts";
import {
  checkLocalStateRecoveryStageApproval,
  stageApprovedLocalStateRecovery,
  type LocalStateRecoveryStageApproval,
} from "../../scripts/lib/local-operator-state-stage.ts";
import { readOwnerPrivateApprovalBytesFile } from "../../scripts/lib/private-evidence-file.ts";
import { LOCAL_RECOVERY_STATE_MAX_BYTES } from "../../deploy/node-postgres/src/local-state-recovery-artifact-store.ts";
import { createLocalOperatorRecoveryFixture, OPERATOR_RECOVERY_TEST_SOURCE_ROOT as ROOT } from "../helpers/deploy-control/local_operator_recovery_fixture.ts";

const STATE = new TextEncoder().encode('{"version":4,"serial":1,"lineage":"123e4567-e89b-42d3-a456-426614174000","terraform_version":"1.9.0","outputs":{},"resources":[]}');

async function fixture() {
  const f = await createLocalOperatorRecoveryFixture();
  // Reuse the synthetic failed ledger; remove its convenience pre-stage so the
  // actual producer starts with no encrypted object or commit approval.
  await rm(join(f.root, "state"), { recursive: true, force: true });
  await unlink(f.path);
  const plaintext = new Uint8Array([0xef, 0xbb, 0xbf, ...STATE]);
  const profile: LocalStateRecoveryStageApproval = {
    format: "takosumi.local-operator-state-stage/v1", purpose: "stage-initial-create-state",
    caseId: f.profile.caseId, approvedOperatorId: f.profile.approvedOperatorId,
    selectedTargetId: f.profile.selectedTargetId, workspaceId: f.profile.workspaceId,
    capsuleId: f.profile.capsuleId, environment: f.profile.environment,
    failedApplyRunId: f.failed.id, recoveryRunId: f.profile.recoveryRunId,
    sourceSnapshotId: f.seeded.snapshot.id, commandTimestamp: f.profile.commandTimestamp,
    expiresAt: f.profile.expiresAt, plaintextSha256: await sha256Digest(plaintext) as `sha256:${string}`,
    custodyEvidenceDigest: `sha256:${"c".repeat(64)}`,
  };
  const approval = join(f.input.approvalDirectory, `${profile.caseId}.stage.json`);
  const capture = join(f.input.approvalDirectory, `${profile.caseId}.tfstate`);
  const receipt = join(f.input.approvalDirectory, `${profile.caseId}.staged.json`);
  const writeApproval = async (value: unknown) => {
    await writeFile(approval, JSON.stringify(value), { mode: 0o600 }); await chmod(approval, 0o600);
  };
  await writeApproval(profile);
  await writeFile(capture, plaintext, { mode: 0o600 });
  return { ...f, profile, approval, capture, receipt, plaintext, writeApproval };
}

async function withFixture(run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const f = await fixture();
  try { await run(f); } finally { await rm(f.root, { recursive: true, force: true }); }
}

test("approved raw capture stages through real crypto and only a separate v1 approval commits", async () => {
  await withFixture(async f => {
    const commit = spyOn(f.store, "commitRecoveredState");
    expect(await f.artifactStore.readRecovery(f.staged.artifact.stateRef)).toBeUndefined();
    const staged = await stageApprovedLocalStateRecovery(f.input);
    expect(commit).not.toHaveBeenCalled();
    expect(existsSync(f.path)).toBeFalse();
    expect(staged.purpose).toBe("staged-initial-create-state");
    expect((await stat(f.receipt)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(f.receipt, "utf8"))).toEqual(staged);
    expect((await f.store.getCapsule(f.seeded.capsule.id))?.currentStateGeneration).toBe(0);
    expect(await f.store.getStateRecoveryRun(f.profile.recoveryRunId)).toBeUndefined();
    const verified = await f.input.verifier.verify({ workspaceId: f.profile.workspaceId, capsuleId: f.profile.capsuleId,
      failedApplyRunId: f.failed.id, recoveryRunId: f.profile.recoveryRunId, artifactHandle: staged.artifactHandle });
    const stored = await f.artifactStore.readRecovery(verified.stateRef);
    expect(stored?.stateBytes).toEqual(f.plaintext); // Includes original UTF-8 BOM.
    expect(verified.plaintextSha256).toBe(f.profile.plaintextSha256);
    expect(verified.encryptedDigest).toBe(staged.encryptedDigest);
    expect(verified.evidenceDigest).toBe(staged.evidenceDigest);
    await unlink(f.receipt); // The same artifact reconciles a missing publish ACK.
    expect(await stageApprovedLocalStateRecovery(f.input)).toEqual(staged);
    await unlink(f.capture);
    const replayWriter = spyOn(f.input.verifier, "stage");
    expect(await stageApprovedLocalStateRecovery(f.input)).toEqual(staged);
    expect(replayWriter).not.toHaveBeenCalled();
    replayWriter.mockRestore();
    await f.write(staged);
    await expect(commitApprovedLocalStateRecovery(f.input)).rejects.toThrow();
    expect(commit).not.toHaveBeenCalled();
    // Test-issued explicit commit approval; production never creates this.
    await f.write({ ...f.profile, format: "takosumi.local-operator-state-recovery/v1",
      purpose: "commit-staged-initial-create-state", artifactHandle: staged.artifactHandle,
      encryptedDigest: staged.encryptedDigest, evidenceDigest: staged.evidenceDigest,
      sourceSnapshotId: undefined, custodyEvidenceDigest: undefined });
    const result = await commitApprovedLocalStateRecovery(f.input);
    expect(result.status).toBe("committed");
    expect((await f.store.getCapsule(f.seeded.capsule.id))?.currentStateGeneration).toBe(1);
    expect((await f.store.getCapsule(f.seeded.capsule.id))?.status).toBe("error");
    expect((await f.store.getCapsule(f.seeded.capsule.id))?.currentOutputId).toBeUndefined();
    expect((await f.store.getApplyRun(f.failed.id))?.status).toBe("failed");
    expect(await f.store.getCapsuleRuntimeSafety(f.seeded.capsule.id)).toMatchObject({ phase: "unknown", runId: f.failed.id });
    const stage = spyOn(f.input.verifier, "stage");
    await expect(stageApprovedLocalStateRecovery(f.input)).rejects.toThrow();
    expect(stage).not.toHaveBeenCalled();
    expect((await commitApprovedLocalStateRecovery(f.input)).status).toBe("replayed");
    stage.mockRestore(); commit.mockRestore();
  });
});

test("stage approval refuses absent, wrong-purpose, wrong-scope and expired cases before artifact writes", async () => {
  await withFixture(async f => {
    const stage = spyOn(f.input.verifier, "stage");
    for (const mutation of [
      { format: "other" }, { purpose: "commit-staged-initial-create-state" }, { caseId: "other" },
      { approvedOperatorId: `local-unix-account:${process.getuid!() + 1}` }, { selectedTargetId: "other" },
      { workspaceId: "other" }, { capsuleId: "other" }, { environment: "other" },
      { failedApplyRunId: "other" }, { recoveryRunId: f.failed.id }, { sourceSnapshotId: "other" },
      { commandTimestamp: new Date(Date.now() + 60_000).toISOString() }, { commandTimestamp: new Date(0).toISOString() },
      { expiresAt: new Date(Date.now() - 1).toISOString() }, { plaintextSha256: `sha256:${"f".repeat(64)}` },
      { custodyEvidenceDigest: "not-a-digest" }, { capturedFile: "/unapproved-path" },
    ]) {
      await f.writeApproval({ ...f.profile, ...mutation });
      await expect(stageApprovedLocalStateRecovery(f.input)).rejects.toThrow();
      expect(stage).not.toHaveBeenCalled();
      expect(existsSync(f.receipt)).toBeFalse();
    }
    await unlink(f.approval);
    await expect(checkLocalStateRecoveryStageApproval(f.input)).rejects.toThrow();
    await expect(checkLocalStateRecoveryStageApproval({ ...f.input, caseId: "../case_one" })).rejects.toThrow();
    stage.mockRestore();
  });
});

test("known stale lineage and current authority changes refuse without occupying an artifact", async () => {
  const cases = ["pending", "generation", "output", "update", "other-apply", "pre-dispatch", "epoch", "management", "later-run"] as const;
  for (const mode of cases) await withFixture(async f => {
    if (mode === "pending") await f.store.patchCapsule(f.seeded.capsule.id, { status: "pending" });
    if (mode === "generation") await f.store.patchCapsule(f.seeded.capsule.id, { currentStateGeneration: 1 });
    if (mode === "output") await f.store.patchCapsule(f.seeded.capsule.id, { currentOutputId: "output_other" });
    if (mode === "update") await f.store.putPlanRun({ ...f.plan, operation: "update" });
    if (mode === "other-apply") await f.store.putPlanRun({ ...f.plan, appliedApplyRunId: "apply_other" });
    if (mode === "pre-dispatch") await f.store.putApplyRun({ ...f.failed,
      auditEvents: [{ id: "event_refused", type: "apply.failed", at: 2, data: { providerDispatched: false } }] });
    if (mode === "epoch") f.store.getCapsuleExecutionAuthorityEpoch = async () => 999;
    if (mode === "management") f.store.getWorkspaceManagement = async () => ({ workspaceId: f.seeded.workspace.id, managementState: "draining", managementEpoch: 999 });
    if (mode === "later-run") await f.store.putPlanRun({ ...f.plan, id: "plan_later", createdAt: f.failed.createdAt + 1 });
    const stage = spyOn(f.input.verifier, "stage");
    await expect(stageApprovedLocalStateRecovery(f.input), mode).rejects.toThrow();
    expect(stage, mode).not.toHaveBeenCalled();
    expect(existsSync(f.receipt), mode).toBeFalse();
    expect(await f.artifactStore.readRecovery(f.staged.artifact.stateRef), mode).toBeUndefined();
    stage.mockRestore();
  });
});

test("protected raw capture refuses aliases, unsafe custody, missing and changed bytes", async () => {
  await withFixture(async f => {
    const stage = spyOn(f.input.verifier, "stage");
    expect(await readOwnerPrivateApprovalBytesFile(f.capture, { sourceRoots: [ROOT], maxBytes: 1024 })).toEqual(f.plaintext);
    const alias = join(f.input.approvalDirectory, "capture-alias");
    await link(f.capture, alias);
    await expect(stageApprovedLocalStateRecovery(f.input)).rejects.toThrow();
    await unlink(alias);
    await chmod(f.capture, 0o644);
    await expect(stageApprovedLocalStateRecovery(f.input)).rejects.toThrow();
    await chmod(f.capture, 0o600);
    await chmod(f.root, 0o777);
    await expect(stageApprovedLocalStateRecovery(f.input)).rejects.toThrow();
    await chmod(f.root, 0o700);
    await expect(stageApprovedLocalStateRecovery({ ...f.input, sourceRoots: [f.root] })).rejects.toThrow();
    await unlink(f.capture);
    await symlink(alias, f.capture);
    await expect(stageApprovedLocalStateRecovery(f.input)).rejects.toThrow();
    await unlink(f.capture);
    await expect(stageApprovedLocalStateRecovery(f.input)).rejects.toThrow();
    await writeFile(f.capture, STATE, { mode: 0o600 });
    await expect(stageApprovedLocalStateRecovery(f.input)).rejects.toThrow();
    await writeFile(f.capture, new Uint8Array(), { mode: 0o600 });
    await expect(stageApprovedLocalStateRecovery(f.input)).rejects.toThrow();
    await truncate(f.capture, LOCAL_RECOVERY_STATE_MAX_BYTES + 1);
    await expect(stageApprovedLocalStateRecovery(f.input)).rejects.toThrow();
    expect(stage).not.toHaveBeenCalled();
    stage.mockRestore();
  });
});

test("approval revocation before publication and immutable conflicts never replace custody", async () => {
  await withFixture(async f => {
    const get = f.store.getCapsule.bind(f.store);
    let reads = 0;
    f.store.getCapsule = async id => {
      if (++reads === 2) await f.writeApproval({ ...f.profile, selectedTargetId: "revoked" });
      return await get(id);
    };
    const stage = spyOn(f.input.verifier, "stage");
    await expect(stageApprovedLocalStateRecovery(f.input)).rejects.toThrow();
    expect(stage).not.toHaveBeenCalled();
    stage.mockRestore();
  });
  await withFixture(async f => {
    const first = await stageApprovedLocalStateRecovery(f.input);
    const originalReceipt = await readFile(f.receipt);
    for (const custodyEvidenceDigest of [`sha256:${"d".repeat(64)}`, `sha256:${"e".repeat(64)}`] as const) {
      await f.writeApproval({ ...f.profile, custodyEvidenceDigest });
      await expect(stageApprovedLocalStateRecovery(f.input)).rejects.toThrow();
      expect(await readFile(f.receipt)).toEqual(originalReceipt);
    }
    await f.writeApproval(f.profile);
    await writeFile(f.receipt, JSON.stringify({ ...first, encryptedDigest: `sha256:${"f".repeat(64)}` }));
    await expect(stageApprovedLocalStateRecovery(f.input)).rejects.toThrow();
    expect((await f.input.verifier.verify({ workspaceId: f.profile.workspaceId, capsuleId: f.profile.capsuleId,
      failedApplyRunId: f.failed.id, recoveryRunId: f.profile.recoveryRunId, artifactHandle: first.artifactHandle })).encryptedDigest).toBe(first.encryptedDigest);
    await writeFile(f.receipt, originalReceipt);
    await rm(join(f.root, "state"), { recursive: true, force: true });
    const stage = spyOn(f.input.verifier, "stage");
    await expect(stageApprovedLocalStateRecovery(f.input)).rejects.toThrow();
    expect(stage).not.toHaveBeenCalled();
    stage.mockRestore();
  });
});

test("stage CLI help and missing stage approval never start a server or open PG", async () => {
  for (const args of [["--help"], ["--stage-case", "missing"]]) {
    const child = Bun.spawn([process.execPath, "--no-env-file", "scripts/operator-state-recovery.ts", ...args], {
      cwd: ROOT, env: { PATH: process.env.PATH, TAKOSUMI_ACCOUNTS_MAIN: "1",
        TAKOSUMI_OPERATOR_STATE_RECOVERY_APPROVAL_DIR: "/nonexistent-stage-approval",
        TAKOSUMI_OPERATOR_STATE_RECOVERY_TARGET_ID: "fixture", TAKOSUMI_ACCOUNTS_DATABASE_URL: "postgres://not-opened@127.0.0.1:1/fixture",
        TAKOSUMI_LOCAL_STATE_ARTIFACT_DIR: "/not-created-stage-state" }, stdout: "pipe", stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(args[0] === "--help" ? 0 : 1);
    if (args[0] === "--help") { expect(out).toContain("--stage-case"); expect(err).toBe(""); }
    else { expect(out).toBe(""); expect(err).toBe("local_state_recovery_refused\n"); }
  }
});
