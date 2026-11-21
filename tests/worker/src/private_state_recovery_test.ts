import { expect, spyOn, test } from "bun:test";
import { rm } from "node:fs/promises";
import { ObjectKeyArtifactReferenceAllocator } from "../../../core/adapters/storage/artifact-references.ts";
import { stableStringify } from "../../../core/adapters/source/digest.ts";
import { createLocalOperatorRecoveryFixture } from "../../helpers/deploy-control/local_operator_recovery_fixture.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";
import type { ArtifactStorageUsagePort } from "../../../worker/src/artifact-storage-usage.ts";
import type { R2Bucket, R2Object, R2ObjectBody, R2PutOptions, D1Database } from "../../../worker/src/bindings.ts";
import { R2RecoveryStateArtifactStore } from "../../../worker/src/state_recovery_artifact_store.ts";
import { StateArtifactCrypto, digestBytes } from "../../../worker/src/state_crypto.ts";
import { createSignedStateRecoveryApprovalIssuer, createSignedStateRecoveryApprovalReader,
  type CurrentSignedStateRecoveryApprovalLookup } from "../../../worker/src/signed-state-recovery-approval.ts";
import { createPrivateStateRecoveryOperator, createPrivateR2StateRecoveryOperator,
  type PrivateStateStageApproval, type PrivateStateCommitApproval,
  type PrivateStateStageReceipt } from "../../../worker/src/private-state-recovery.ts";

type Digest = PrivateStateStageApproval["plaintextSha256"];
const STATE = new TextEncoder().encode('{"version":4,"serial":1,"lineage":"00000000-0000-0000-0000-000000000000","terraform_version":"1.12.3","outputs":{},"resources":[]}');
const KEY = "synthetic-private-worker-state-recovery-test-key-0123456789abcdef";
class Bucket implements R2Bucket {
  puts = 0;
  deletes = 0;
  readonly objects = new Map<string, { bytes: Uint8Array; metadata: Record<string, string>; contentType?: string }>();
  async put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null, options?: R2PutOptions) {
    this.puts++;
    if (options?.onlyIf?.etagDoesNotMatch === "*" && this.objects.has(key)) return null;
    if (!(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)) throw new Error("fixture bytes required");
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value.slice(0)) :
      new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    this.objects.set(key, { bytes, metadata: { ...options?.customMetadata }, contentType: options?.httpMetadata?.contentType });
    return this.head(key);
  }
  async head(key: string): Promise<R2Object | null> {
    const found = this.objects.get(key);
    return found ? { key, size: found.bytes.length, etag: "fixture", version: "fixture", uploaded: new Date(0),
      customMetadata: { ...found.metadata }, httpMetadata: { contentType: found.contentType } } : null;
  }
  async get(key: string): Promise<R2ObjectBody | null> {
    const head = await this.head(key);
    const bytes = this.objects.get(key)?.bytes.slice();
    return head && bytes ? { ...head, body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }),
      arrayBuffer: async () => bytes.slice().buffer } : null;
  }
  async list() { return { objects: await Promise.all([...this.objects.keys()].map(key => this.head(key) as Promise<R2Object>)), truncated: false }; }
  async delete(key: string) { this.deletes++; this.objects.delete(key); }
}

async function fixture() {
  const f = await createLocalOperatorRecoveryFixture();
  const bucket = new Bucket();
  const crypto = StateArtifactCrypto.fromEnv({ TAKOSUMI_SECRET_STORE_PASSPHRASE: KEY });
  const artifacts = new R2RecoveryStateArtifactStore({ bucket, crypto,
    allocator: new ObjectKeyArtifactReferenceAllocator(), capsules: f.store });
  const stage: PrivateStateStageApproval = {
    format: "takosumi.private-worker-state-recovery-approval/v1", purpose: "stage-initial-create-state",
    approvedOperatorId: "test-qualified-operator", selectedTargetId: "test-selected-target",
    workspaceId: f.seeded.workspace.id, capsuleId: f.seeded.capsule.id, environment: f.seeded.capsule.environment,
    failedApplyRunId: f.failed.id, recoveryRunId: "worker_private_recovery",
    sourceSnapshotId: f.seeded.snapshot.id, commandTimestamp: f.profile.commandTimestamp, expiresAt: f.profile.expiresAt,
    plaintextSha256: await digestBytes(STATE) as Digest, custodyEvidenceDigest: ("sha256:" + "c".repeat(64)) as Digest,
  };
  const approvals = new Map<string, unknown>([["stage-proof", stage]]);
  let reads = 0, opens = 0, now = Date.now();
  const hooks: { beforeRead?: (count: number) => Promise<void>; beforeOpen?: () => Promise<void> } = {};
  const selectedPort = { async readApprovedStateRecovery(input: { approvalRef: string; purpose: string; selectedTargetId: string }) {
    reads++;
    expect(input.selectedTargetId).toBe(stage.selectedTargetId);
    await hooks.beforeRead?.(reads);
    return approvals.get(input.approvalRef);
  } };
  const operator = createPrivateStateRecoveryOperator({ selectedTargetId: stage.selectedTargetId, approvals: selectedPort,
    now: () => now, openResources: async () => { opens++; await hooks.beforeOpen?.(); return { store: f.store, artifacts }; } });
  const issueCommit = (receipt: PrivateStateStageReceipt): PrivateStateCommitApproval => {
    const value: PrivateStateCommitApproval = { ...stage, purpose: "commit-staged-initial-create-state",
      artifactHandle: receipt.artifactHandle, encryptedDigest: receipt.encryptedDigest, evidenceDigest: receipt.evidenceDigest };
    approvals.set("commit-proof", value);
    return value;
  };
  return { ...f, bucket, crypto, artifacts, stage, approvals, selectedPort, operator, hooks, issueCommit,
    get reads() { return reads; }, get opens() { return opens; }, setNow(value: number) { now = value; } };
}
async function use(run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const f = await fixture();
  try { await run(f); } finally { await rm(f.root, { recursive: true, force: true }); }
}

test("private operator stages immutable bytes and requires a separate qualified commit with exact replay", async () => {
  await use(async f => {
    const before = stableStringify(await f.store.getCapsule(f.stage.capsuleId));
    const staged = await f.operator.stageRecoveryState({ approvalRef: "stage-proof", plaintext: STATE });
    expect(staged.purpose).toBe("staged-initial-create-state");
    expect("approvalRef" in staged).toBeFalse();
    expect(await f.operator.stageRecoveryState({ approvalRef: "stage-proof", plaintext: STATE })).toEqual(staged);
    expect(f.bucket.puts).toBe(1);
    expect(stableStringify(await f.store.getCapsule(f.stage.capsuleId))).toBe(before);
    await expect(f.operator.commitRecoveryState({ approvalRef: "stage-proof" })).rejects.toThrow("private state recovery approval");
    f.approvals.set("receipt-is-not-approval", staged);
    await expect(f.operator.commitRecoveryState({ approvalRef: "receipt-is-not-approval" })).rejects.toThrow();
    expect(await f.store.getStateRecoveryRun(f.stage.recoveryRunId)).toBeUndefined();
    f.issueCommit(staged); // Explicit test authority action, never production issuance.
    const result = await f.operator.commitRecoveryState({ approvalRef: "commit-proof" });
    expect(result.status).toBe("committed");
    if (result.status === "conflict") throw new Error("fixture commit must succeed");
    expect(Object.keys(result).sort()).toEqual(["capsuleId", "recoveryRunId", "stateVersionId", "status"]);
    const run = await f.store.getStateRecoveryRun(f.stage.recoveryRunId);
    expect(run?.createdBy).toBe(f.stage.approvedOperatorId);
    expect((await f.store.getCapsule(f.stage.capsuleId))?.currentStateGeneration).toBe(1);
    expect((await f.store.getCapsule(f.stage.capsuleId))?.status).toBe("error");
    expect((await f.store.getApplyRun(f.stage.failedApplyRunId))?.status).toBe("failed");
    expect(await f.operator.commitRecoveryState({ approvalRef: "commit-proof" })).toEqual({ ...result, status: "replayed" });
    expect(f.bucket.puts).toBe(1);
    expect(f.bucket.deletes).toBe(0);
  });
});

test("private operator refuses absent or malformed qualified evidence before opening ledger or crypto", async () => {
  await use(async f => {
    const mutations = [undefined, f.profile, true, { ...f.stage, format: "other" },
      { ...f.stage, purpose: "commit-staged-initial-create-state" }, { ...f.stage, role: "admin" },
      { ...f.stage, approvedOperatorId: "" }, { ...f.stage, selectedTargetId: "other" },
      { ...f.stage, expiresAt: new Date(0).toISOString() },
      { ...f.stage, commandTimestamp: new Date(Date.now() + 60_000).toISOString() },
      { ...f.stage, plaintextSha256: "bad" }, { ...f.stage, custodyEvidenceDigest: "bad" }];
    for (const value of mutations) {
      f.approvals.set("stage-proof", value);
      await expect(f.operator.stageRecoveryState({ approvalRef: "stage-proof", plaintext: STATE })).rejects.toThrow();
      expect(f.opens).toBe(0);
    }
    f.approvals.set("stage-proof", f.stage);
    await expect(f.operator.stageRecoveryState({ approvalRef: "stage-proof", plaintext: STATE, workspaceId: "caller-scope" })).rejects.toThrow();
    await expect(f.operator.stageRecoveryState({ approvalRef: "stage-proof", plaintext: new Uint8Array([1, 2]) })).rejects.toThrow();
    expect(f.opens).toBe(0);
    expect(f.bucket.puts).toBe(0);
  });
});

test("private R2 composition refuses an unprepared schema without bootstrap writes", async () => {
  await use(async f => {
    const db = new SqliteFakeD1();
    const queries: string[] = [];
    const originalPrepare = db.prepare.bind(db);
    const prepare = spyOn(db, "prepare").mockImplementation(query => {
      queries.push(query);
      return originalPrepare(query);
    });
    const exec = spyOn(db, "exec");
    try {
      const operator = createPrivateR2StateRecoveryOperator({ selectedTargetId: f.stage.selectedTargetId, approvals: f.selectedPort,
        openBindings: () => ({ database: db, bucket: f.bucket, cryptoEnv: { TAKOSUMI_SECRET_STORE_PASSPHRASE: KEY }, storageProfile: { kind: "oss-r2" } }) });
      await expect(operator.stageRecoveryState({ approvalRef: "stage-proof", plaintext: STATE })).rejects.toThrow();
      expect(queries.length).toBeGreaterThan(0);
      expect(queries.every(sql => /^\s*(SELECT|PRAGMA)\b/iu.test(sql))).toBeTrue();
      expect(exec).not.toHaveBeenCalled();
      expect(f.bucket.puts).toBe(0);
    } finally { prepare.mockRestore(); exec.mockRestore(); }
  });
});

test("private approval digest mismatch precedes metered retention preparation and acknowledgement", async () => {
  await use(async f => {
    const calls: string[] = [];
    const usage: ArtifactStorageUsagePort = {
      async readArtifactRetention() { throw new Error("not used"); },
      async prepareArtifactRetention() { calls.push("prepare"); return { operationRef: "test-retention", state: "pending" }; },
      async confirmArtifactRetention() { calls.push("confirm"); },
      async prepareArtifactRelease() { throw new Error("no delete"); },
      async confirmArtifactRelease() { throw new Error("no delete"); },
    };
    const artifacts = new R2RecoveryStateArtifactStore({ bucket: f.bucket, crypto: f.crypto, capsules: f.store,
      allocator: new ObjectKeyArtifactReferenceAllocator(), storageUsage: usage });
    const staged = await artifacts.stage({ workspaceId: f.stage.workspaceId, capsuleId: f.stage.capsuleId,
      environment: f.stage.environment, generation: 1, failedApplyRunId: f.stage.failedApplyRunId,
      recoveryRunId: f.stage.recoveryRunId, plaintextSha256: f.stage.plaintextSha256,
      custodyEvidenceDigest: f.stage.custodyEvidenceDigest, plaintext: STATE });
    const expected = { workspaceId: f.stage.workspaceId, capsuleId: f.stage.capsuleId,
      failedApplyRunId: f.stage.failedApplyRunId, recoveryRunId: f.stage.recoveryRunId,
      artifactHandle: staged.handle, plaintextSha256: f.stage.plaintextSha256,
      custodyEvidenceDigest: f.stage.custodyEvidenceDigest, encryptedDigest: staged.artifact.encryptedDigest,
      evidenceDigest: staged.artifact.evidenceDigest };
    calls.length = 0;
    const wrong = ("sha256:" + "f".repeat(64)) as Digest;
    for (const change of [{ plaintextSha256: wrong }, { custodyEvidenceDigest: wrong },
      { encryptedDigest: wrong }, { evidenceDigest: wrong }]) {
      await expect(artifacts.verify({ ...expected, ...change })).rejects.toThrow();
      expect(calls).toEqual([]);
    }
    expect(await artifacts.verify(expected)).toEqual(staged.artifact);
    expect(calls).toEqual(["prepare", "confirm"]);
    expect(f.bucket.puts).toBe(1);
  });
});

test("private stage snapshots caller bytes and rejects approval or current failure changes before publication", async () => {
  await use(async f => {
    const bytes = STATE.slice();
    const pending = f.operator.stageRecoveryState({ approvalRef: "stage-proof", plaintext: bytes });
    bytes.fill(0);
    const staged = await pending;
    expect(staged.plaintextSha256).toBe(f.stage.plaintextSha256);
    expect(f.bucket.puts).toBe(1);
  });
  await use(async f => {
    f.hooks.beforeRead = async count => {
      if (count === 2) f.approvals.set("stage-proof", { ...f.stage, approvedOperatorId: "different-operator" });
    };
    await expect(f.operator.stageRecoveryState({ approvalRef: "stage-proof", plaintext: STATE })).rejects.toThrow();
    expect(f.opens).toBe(0);
    expect(f.bucket.puts).toBe(0);
  });
  await use(async f => {
    f.hooks.beforeOpen = async () => { await f.store.patchCapsule(f.stage.capsuleId, { status: "pending" }); };
    await expect(f.operator.stageRecoveryState({ approvalRef: "stage-proof", plaintext: STATE })).rejects.toThrow();
    expect(f.bucket.puts).toBe(0);
  });
});

test("private commit binds snapshot and all artifact digests without writing on mismatch", async () => {
  await use(async f => {
    const staged = await f.operator.stageRecoveryState({ approvalRef: "stage-proof", plaintext: STATE });
    const commit = f.issueCommit(staged);
    const write = spyOn(f.store, "commitRecoveredState");
    try {
      for (const change of [{ sourceSnapshotId: "other" }, { plaintextSha256: "sha256:" + "f".repeat(64) },
        { custodyEvidenceDigest: "sha256:" + "f".repeat(64) }, { encryptedDigest: "sha256:" + "f".repeat(64) },
        { evidenceDigest: "sha256:" + "f".repeat(64) }]) {
        f.approvals.set("commit-proof", { ...commit, ...change });
        await expect(f.operator.commitRecoveryState({ approvalRef: "commit-proof" })).rejects.toThrow();
        expect(write).not.toHaveBeenCalled();
        expect(f.bucket.puts).toBe(1);
        expect((await f.store.getCapsule(f.stage.capsuleId))?.currentStateGeneration).toBe(0);
      }
    } finally { write.mockRestore(); }
  });
});

test("private commit rechecks authority after artifact read and holds unknown acknowledgement to exact replay", async () => {
  await use(async f => {
    const staged = await f.operator.stageRecoveryState({ approvalRef: "stage-proof", plaintext: STATE });
    f.issueCommit(staged);
    const originalVerify = f.artifacts.verify.bind(f.artifacts);
    const verify = spyOn(f.artifacts, "verify").mockImplementation(async input => {
      const result = await originalVerify(input);
      f.approvals.delete("commit-proof");
      return result;
    });
    const write = spyOn(f.store, "commitRecoveredState");
    try {
      await expect(f.operator.commitRecoveryState({ approvalRef: "commit-proof" })).rejects.toThrow();
      expect(write).not.toHaveBeenCalled();
    } finally { verify.mockRestore(); write.mockRestore(); }
    f.issueCommit(staged);
    const originalCommit = f.store.commitRecoveredState.bind(f.store);
    const commit = spyOn(f.store, "commitRecoveredState").mockImplementation(async input => {
      const result = await originalCommit(input);
      f.approvals.delete("commit-proof");
      return result;
    });
    try { await expect(f.operator.commitRecoveryState({ approvalRef: "commit-proof" })).rejects.toThrow(); }
    finally { commit.mockRestore(); }
    expect((await f.store.getCapsule(f.stage.capsuleId))?.currentStateGeneration).toBe(1);
    f.issueCommit(staged);
    expect((await f.operator.commitRecoveryState({ approvalRef: "commit-proof" })).status).toBe("replayed");
    expect(f.bucket.puts).toBe(1);
  });
});

test("private R2 composition cannot downgrade missing key or selected storage profile to bootstrap access", async () => {
  await use(async f => {
    let dbReads = 0;
    const db = new Proxy({} as D1Database, { get() { dbReads++; throw new Error("unexpected database access"); } });
    const missingKey = createPrivateR2StateRecoveryOperator({ selectedTargetId: f.stage.selectedTargetId, approvals: f.selectedPort,
      openBindings: () => ({ database: db, bucket: f.bucket, cryptoEnv: { TAKOSUMI_DEV_MODE: "1" }, storageProfile: { kind: "oss-r2" } }) });
    await expect(missingKey.stageRecoveryState({ approvalRef: "stage-proof", plaintext: STATE })).rejects.toThrow();
    expect(dbReads).toBe(0);
    expect(f.bucket.puts).toBe(0);
    const bindings: ReturnType<Parameters<typeof createPrivateR2StateRecoveryOperator>[0]["openBindings"]> = {
      database: db, bucket: f.bucket, cryptoEnv: { TAKOSUMI_SECRET_STORE_PASSPHRASE: KEY }, storageProfile: { kind: "oss-r2" },
    };
    Reflect.deleteProperty(bindings, "storageProfile");
    const missingProfile = createPrivateR2StateRecoveryOperator({ selectedTargetId: f.stage.selectedTargetId,
      approvals: f.selectedPort, openBindings: () => bindings });
    await expect(missingProfile.stageRecoveryState({ approvalRef: "stage-proof", plaintext: STATE })).rejects.toThrow();
    expect(dbReads).toBe(0);
    expect(f.bucket.puts).toBe(0);
  });
});

test("signed holder approval drives the existing private stage and separate commit while revocation blocks exact replay admission", async () => {
  await use(async f => {
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const identity = { issuer: "test-private-recovery-issuer", keyId: "test-p256", selectedTargetId: f.stage.selectedTargetId };
    const issuer = createSignedStateRecoveryApprovalIssuer({ ...identity, signingKey: keys.privateKey });
    const rows = new Map<string, unknown>();
    const lookups: string[][] = [];
    const currentLookup: CurrentSignedStateRecoveryApprovalLookup = {
      async readCurrentSignedStateRecoveryApproval(input) {
        lookups.push(Object.keys(input));
        return rows.get(input.holderProofDigest);
      },
    };
    const approvals = createSignedStateRecoveryApprovalReader({ ...identity, publicKey: keys.publicKey, currentLookup });
    let opens = 0;
    const operator = createPrivateStateRecoveryOperator({ selectedTargetId: f.stage.selectedTargetId, approvals,
      openResources: async () => { opens++; return { store: f.store, artifacts: f.artifacts }; } });
    const stage = await issuer.issueStageApproval(f.stage);
    rows.set(stage.holderProofDigest, { status: "active", record: stage.record }); // Explicit test publication.
    const receipt = await operator.stageRecoveryState({ approvalRef: stage.approvalRef, plaintext: STATE });
    expect(receipt.plaintextSha256).toBe(f.stage.plaintextSha256);
    expect(f.bucket.puts).toBe(1);
    const commitRecord = f.issueCommit(receipt); // Human-intent fixture action, never automatic issuance.
    const commit = await issuer.issueCommitApproval(commitRecord);
    rows.set(commit.holderProofDigest, { status: "active", record: commit.record });
    expect((await operator.commitRecoveryState({ approvalRef: commit.approvalRef })).status).toBe("committed");
    expect((await operator.commitRecoveryState({ approvalRef: commit.approvalRef })).status).toBe("replayed");
    const before = opens;
    rows.set(commit.holderProofDigest, { status: "revoked" });
    await expect(operator.commitRecoveryState({ approvalRef: commit.approvalRef })).rejects.toThrow();
    expect(opens).toBe(before);
    expect(lookups.every(keys => keys.join(",") === "holderProofDigest")).toBeTrue();
    expect(f.bucket.puts).toBe(1);
    expect(f.bucket.deletes).toBe(0);
    expect((await f.store.getCapsule(f.stage.capsuleId))?.currentStateGeneration).toBe(1);
  });
});
