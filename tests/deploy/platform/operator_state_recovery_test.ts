import { expect, test } from "bun:test";
import type { ApplyRun, PlanRun } from "@takosumi/internal/deploy-control-api";
import { stableJsonDigest } from "../../../core/adapters/source/digest.ts";
import { InMemoryOpenTofuControlStore } from "../../../core/domains/deploy-control/store.ts";
import { seedCapsuleModel } from "../../helpers/deploy-control/model_fixture.ts";
import { digestBytes } from "../../../worker/src/state_crypto.ts";
import { StateArtifactCrypto } from "../../../worker/src/state_crypto.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../core/adapters/storage/artifact-references.ts";
import { R2RecoveryStateArtifactStore } from "../../../worker/src/state_recovery_artifact_store.ts";
import type { R2Bucket, R2Object, R2ObjectBody, R2Objects, R2PutOptions } from "../../../worker/src/bindings.ts";
import {
  composeOperatorSourceRecovery,
  type OperatorRecoveryAuthorization,
  type OperatorRecoveryBinding,
  type OperatorRecoveryJournal,
  type OperatorRecoveryJournalIntent,
  type OperatorRecoveryJournalStaged,
  type OperatorSourceRecoveryPorts,
} from "../../../deploy/platform/operator_state_recovery.ts";

const NOW = "2026-09-30T00:00:00.000Z";
const D = `sha256:${"a".repeat(64)}` as const;
const CUSTODY = `sha256:${"c".repeat(64)}` as const;
const STATE = new TextEncoder().encode(JSON.stringify({
  version: 4, terraform_version: "1.9.8", serial: 1,
  lineage: "b8d6c5f4-8f27-4d16-8b90-839c7f770001", outputs: {}, resources: [],
}));

class PrivateJournalDouble implements OperatorRecoveryJournal {
  intent?: OperatorRecoveryJournalIntent;
  staged?: OperatorRecoveryJournalStaged;
  intentWrites = 0;
  stagedWrites = 0;
  async read() { return this.intent ? { intent: this.intent, staged: this.staged } : undefined; }
  async putIntentIfAbsent(value: OperatorRecoveryJournalIntent) {
    this.intentWrites++;
    return this.intent ??= value;
  }
  async putStagedIfAbsent(value: OperatorRecoveryJournalStaged) {
    this.stagedWrites++;
    return this.staged ??= value;
  }
}

class RecoveryR2BucketDouble implements R2Bucket {
  readonly objects = new Map<string, { bytes: Uint8Array; metadata: Record<string, string>; contentType: string }>();
  puts = 0;
  deletes = 0;
  async put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null,
    options?: R2PutOptions): Promise<R2Object | null> {
    if (options?.onlyIf?.etagDoesNotMatch === "*" && this.objects.has(key)) return null;
    if (!ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer)) throw new Error("bytes required");
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value.slice(0)) :
      new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    this.objects.set(key, { bytes, metadata: { ...options?.customMetadata },
      contentType: options?.httpMetadata?.contentType ?? "application/octet-stream" });
    this.puts++;
    return this.object(key)!;
  }
  async head(key: string): Promise<R2Object | null> { return this.object(key); }
  async get(key: string): Promise<R2ObjectBody | null> {
    const object = this.object(key);
    const stored = this.objects.get(key);
    if (!object || !stored) return null;
    const bytes = stored.bytes.slice();
    return { ...object,
      body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
      arrayBuffer: async () => bytes.slice().buffer,
    } as R2ObjectBody;
  }
  async list(): Promise<R2Objects> { return { objects: [], truncated: false }; }
  async delete(key: string): Promise<void> { this.deletes++; this.objects.delete(key); }
  private object(key: string): R2Object | null {
    const stored = this.objects.get(key);
    if (!stored) return null;
    return { key, version: "v1", size: stored.bytes.byteLength, etag: "opaque-etag",
      httpEtag: '"opaque-etag"', checksums: {}, uploaded: new Date(0),
      httpMetadata: { contentType: stored.contentType }, customMetadata: { ...stored.metadata },
      storageClass: "Standard", writeHttpMetadata(headers: Headers) { headers.set("content-type", stored.contentType); },
    } as R2Object;
  }
}

async function fixture(label: string) {
  const store = new InMemoryOpenTofuControlStore();
  const seeded = await seedCapsuleModel(store, {
    workspaceId: `ws_operator_${label}`, capsuleId: `cap_operator_${label}`,
    sourceId: `src_operator_${label}`, snapshotId: `snap_operator_${label}`,
    installConfigId: `cfg_operator_${label}`,
  });
  const epoch = await store.getCapsuleExecutionAuthorityEpoch(seeded.capsule.id);
  if (epoch === undefined) throw new Error("missing fixture epoch");
  const plan: PlanRun = {
    id: `plan_operator_${label}`, workspaceId: seeded.workspace.id,
    capsuleId: seeded.capsule.id, capsuleCurrentStateVersionId: null,
    capsuleExecutionAuthorityEpoch: epoch,
    capsuleContext: { workspaceId: seeded.workspace.id, capsuleId: seeded.capsule.id, environment: seeded.capsule.environment },
    source: { kind: "git", url: seeded.snapshot.url, commit: seeded.snapshot.resolvedCommit },
    sourceDigest: D, operation: "create", runnerProfileId: "opentofu-default",
    variablesDigest: D, executionInputsDigest: D, requiredProviders: [], status: "succeeded",
    policy: { status: "passed", reasons: [], checkedAt: 1 }, policyDecisionDigest: D,
    planDigest: D, planArtifact: { kind: "object-storage", ref: "opaque_plan_artifact", digest: D },
    sourceSnapshotId: seeded.snapshot.id, baseStateGeneration: 0,
    appliedApplyRunId: `apply_operator_${label}`,
    planResourceChanges: [], auditEvents: [], createdAt: 1, updatedAt: 1,
  };
  const failed: ApplyRun = {
    id: `apply_operator_${label}`, planRunId: plan.id, workspaceId: seeded.workspace.id,
    capsuleId: seeded.capsule.id, operation: "create", runnerProfileId: plan.runnerProfileId,
    status: "failed", expected: {
      planRunId: plan.id, capsuleId: seeded.capsule.id, currentStateVersionId: null,
      capsuleExecutionAuthorityEpoch: epoch, runnerProfileId: plan.runnerProfileId,
      sourceDigest: D, variablesDigest: D, policyDecisionDigest: D,
      planDigest: D, planArtifactDigest: D,
    },
    stateBackend: { kind: "operator-managed", ref: "opaque_backend" },
    stateLock: { status: "recorded", backendRef: "opaque_backend" },
    auditEvents: [{ id: `event_${label}`, type: "apply.failed", at: 2, data: { providerDispatched: true } }],
    createdAt: 2, updatedAt: 3, finishedAt: 3,
  };
  await store.putPlanRun(plan);
  await store.putApplyRun(failed);
  await store.patchCapsule(seeded.capsule.id, { status: "error", updatedAt: NOW },
    { currentStateVersionId: undefined, status: "pending" });

  const plaintextSha256 = await digestBytes(STATE) as `sha256:${string}`;
  const request = { failedApplyRunId: failed.id, plaintextSha256, custodyEvidenceDigest: CUSTODY };
  const journal = new PrivateJournalDouble();
  const bucket = new RecoveryR2BucketDouble();
  const adapter = new R2RecoveryStateArtifactStore({
    bucket, allocator: new ObjectKeyArtifactReferenceAllocator(),
    crypto: StateArtifactCrypto.fromEnv({
      TAKOSUMI_SECRET_STORE_PASSPHRASE: "synthetic-operator-recovery-test-passphrase-0123456789",
    }),
  });
  const handles = new Map<string, { binding: OperatorRecoveryBinding; digest: string }>();
  let loads = 0;
  let stages = 0;
  let verifies = 0;
  let authCalls = 0;
  let deny = false;
  let stageInterrupted = false;
  let authMismatch = false;
  let tamperHandle = false;
  const authorization: OperatorRecoveryAuthorization = {
    async verify(binding) {
      authCalls++;
      if (deny) throw new Error("secret authorization evidence");
      return {
        format: "takosumi.verified-operator-source-recovery-decision@v1",
        requestDigest: authMismatch ? D : await stableJsonDigest({
          kind: "takosumi.operator-source-recovery-authorization@v1", binding,
        }) as `sha256:${string}`,
        actorId: "verified_operator",
      };
    },
  };
  const ports: OperatorSourceRecoveryPorts = {
    store, authorization, journal,
    newRecoveryRunId: () => `run_operator_${label}`,
    now: () => NOW,
    loadSelectedPlaintext: async () => { loads++; return STATE; },
    artifacts: {
      async stage(input) {
        stages++;
        const staged = await adapter.stage(input);
        handles.set(staged.handle, { binding: input, digest: input.plaintextSha256 });
        if (stageInterrupted) throw new Error("lost stage acknowledgement with secret data");
        return staged;
      },
      async verify(input) {
        verifies++;
        const entry = handles.get(input.artifactHandle);
        if (!entry || tamperHandle || entry.binding.workspaceId !== input.workspaceId ||
          entry.binding.capsuleId !== input.capsuleId ||
          entry.binding.failedApplyRunId !== input.failedApplyRunId ||
          entry.binding.recoveryRunId !== input.recoveryRunId) throw new Error("secret artifact data");
        return await adapter.verify(input);
      },
    },
  };
  return {
    store, seeded, failed, request, journal, handles, bucket, ports,
    get loads() { return loads; }, get stages() { return stages; },
    get verifies() { return verifies; }, get authCalls() { return authCalls; },
    set deny(value: boolean) { deny = value; },
    set stageInterrupted(value: boolean) { stageInterrupted = value; },
    set authMismatch(value: boolean) { authMismatch = value; },
    set tamperHandle(value: boolean) { tamperHandle = value; },
  };
}

test("SOURCE-only composition commits and exact-replays without Output or inferred success", async () => {
  const f = await fixture("commit");
  expect(await composeOperatorSourceRecovery(f.ports, f.request)).toEqual({
    status: "committed", recoveryRunId: "run_operator_commit",
  });
  const capsule = await f.store.getCapsule(f.seeded.capsule.id);
  expect(capsule?.status).toBe("error");
  expect(capsule?.currentStateGeneration).toBe(1);
  expect(capsule?.currentOutputId).toBeUndefined();
  expect((await f.store.getApplyRun(f.failed.id))?.status).toBe("failed");
  expect(await composeOperatorSourceRecovery(f.ports, f.request)).toEqual({
    status: "replayed", recoveryRunId: "run_operator_commit",
  });
  expect(f.loads).toBe(1);
  expect(f.stages).toBe(1);
  expect(f.authCalls).toBe(4);
});

test("denied or wrong-scope authorization cannot load or stage plaintext", async () => {
  for (const label of ["denied", "wrong_scope"]) {
    const f = await fixture(label);
    if (label === "denied") f.deny = true; else f.authMismatch = true;
    await expect(composeOperatorSourceRecovery(f.ports, f.request)).rejects.toThrow(/refused/);
    expect(f.loads).toBe(0);
    expect(f.stages).toBe(0);
    expect(f.journal.intent).toBeUndefined();
  }
});

test("lost stage acknowledgement retries the same journaled identity and occupied coordinate", async () => {
  const f = await fixture("interrupted");
  f.stageInterrupted = true;
  await expect(composeOperatorSourceRecovery(f.ports, f.request)).rejects.toThrow(/refused/);
  expect(f.journal.intent?.recoveryRunId).toBe("run_operator_interrupted");
  expect(f.journal.staged).toBeUndefined();
  expect(f.handles.size).toBe(1);
  f.stageInterrupted = false;
  expect((await composeOperatorSourceRecovery(f.ports, f.request)).status).toBe("committed");
  expect(f.journal.intentWrites).toBe(2);
  expect(f.handles.size).toBe(1);
  expect(f.stages).toBe(2);
});

test("final CAS conflict leaves only value-free possible-orphan inventory", async () => {
  const f = await fixture("race");
  const originalCommit = f.store.commitRecoveredState.bind(f.store);
  f.store.commitRecoveredState = async (input) => {
    await f.store.patchCapsule(f.seeded.capsule.id, { updatedAt: "2026-10-01T00:00:00.000Z" });
    return await originalCommit(input);
  };
  const result = await composeOperatorSourceRecovery(f.ports, f.request);
  expect(["conflict", "needs_reconciliation"]).toContain(result.status);
  expect(JSON.stringify(result)).not.toMatch(/secret|provider|resources|outputs/);
  if (result.status === "conflict" || result.status === "needs_reconciliation") {
    expect(result.possibleOrphan.artifactHandle).toContain("recovery-state-v1.");
  }
  expect((await f.store.getCapsule(f.seeded.capsule.id))?.currentStateVersionId).toBeUndefined();
});

test("a newer Run blocks Core recovery after staging", async () => {
  const f = await fixture("newer_run");
  const originalCommit = f.store.commitRecoveredState.bind(f.store);
  f.store.commitRecoveredState = async (input) => {
    const plan = await f.store.getPlanRun(input.expectedPlanRun.id);
    if (!plan) throw new Error("missing fixture Plan");
    await f.store.putPlanRun({
      ...plan, id: "plan_newer_than_failed", status: "queued", createdAt: 4,
      updatedAt: 4, appliedApplyRunId: undefined,
    });
    return await originalCommit(input);
  };
  const result = await composeOperatorSourceRecovery(f.ports, f.request);
  expect(["conflict", "needs_reconciliation"]).toContain(result.status);
  expect(await f.store.getStateRecoveryRun("run_operator_newer_run")).toBeUndefined();
  expect((await f.store.getCapsule(f.seeded.capsule.id))?.currentOutputId).toBeUndefined();
});

test("tampered journal/replay and handle are refused without a second state mutation", async () => {
  const f = await fixture("tamper");
  expect((await composeOperatorSourceRecovery(f.ports, f.request)).status).toBe("committed");
  f.journal.intent = { ...f.journal.intent!, actorId: "caller_asserted_actor" };
  await expect(composeOperatorSourceRecovery(f.ports, f.request)).rejects.toThrow(/refused/);
  f.journal.intent = { ...f.journal.intent!, actorId: "verified_operator" };
  f.tamperHandle = true;
  await expect(composeOperatorSourceRecovery(f.ports, f.request)).rejects.toThrow(/refused/);
});

test("authorization is rechecked after stage and before Core commit", async () => {
  const f = await fixture("reauthorize");
  const original = f.ports.authorization.verify.bind(f.ports.authorization);
  const ports = { ...f.ports, authorization: {
    verify: async (binding: OperatorRecoveryBinding) => {
      if (f.authCalls >= 1) throw new Error("private revocation evidence");
      return await original(binding);
    },
  } };
  await expect(composeOperatorSourceRecovery(ports, f.request)).rejects.toThrow(/refused/);
  expect(f.stages).toBe(1);
  expect(f.journal.staged).toBeDefined();
  expect(await f.store.getStateRecoveryRun("run_operator_reauthorize")).toBeUndefined();
  expect((await f.store.getCapsule(f.seeded.capsule.id))?.currentOutputId).toBeUndefined();
});

test("verifier cannot mutate the authorized binding before journal or stage", async () => {
  const f = await fixture("auth_mutation");
  const ports = { ...f.ports, authorization: {
    verify: async (binding: OperatorRecoveryBinding) => {
      const requestDigest = await stableJsonDigest({ kind: "takosumi.operator-source-recovery-authorization@v1", binding });
      (binding as { capsuleId: string }).capsuleId = "attacker_capsule";
      return { format: "takosumi.verified-operator-source-recovery-decision@v1" as const,
        requestDigest: requestDigest as `sha256:${string}`, actorId: "verified_operator" };
    },
  } };
  await expect(composeOperatorSourceRecovery(ports, f.request)).rejects.toThrow(/refused/);
  expect(f.journal.intent).toBeUndefined();
  expect(f.loads).toBe(0);
  expect(f.stages).toBe(0);
  expect(await f.store.getStateRecoveryRun("run_operator_auth_mutation")).toBeUndefined();
});

test("authorization snapshots actor before a retained decision changes after resolve", async () => {
  const f = await fixture("decision_mutation");
  const ports = { ...f.ports, authorization: {
    verify(binding: OperatorRecoveryBinding) {
      return stableJsonDigest({
        kind: "takosumi.operator-source-recovery-authorization@v1", binding,
      }).then((requestDigest) => new Promise<Awaited<ReturnType<OperatorRecoveryAuthorization["verify"]>>>((resolve) => {
        const decision = {
          format: "takosumi.verified-operator-source-recovery-decision@v1" as const,
          requestDigest: requestDigest as `sha256:${string}`,
          actorId: "verified_operator",
        };
        resolve(decision);
        // Promise assimilation adds jobs before the await continuation. Delay
        // the mutation until after the composition snapshots the decision.
        const mutateAfter = (remaining: number) => queueMicrotask(() => {
          if (remaining > 0) mutateAfter(remaining - 1);
          else decision.actorId = "attacker_actor";
        });
        mutateAfter(6);
      }));
    },
  } };
  expect((await composeOperatorSourceRecovery(ports, f.request)).status).toBe("committed");
  expect(f.journal.intent?.actorId).toBe("verified_operator");
  expect((await f.store.getStateRecoveryRun("run_operator_decision_mutation"))?.createdBy)
    .toBe("verified_operator");
});

test("loader or recheck cannot mutate the previously authorized binding", async () => {
  const loader = await fixture("loader_mutation");
  const loaderPorts = { ...loader.ports, loadSelectedPlaintext: async (binding: OperatorRecoveryBinding) => {
    (binding as { custodyEvidenceDigest: string }).custodyEvidenceDigest = D;
    return STATE;
  } };
  await expect(composeOperatorSourceRecovery(loaderPorts, loader.request)).rejects.toThrow(/refused/);
  expect(loader.journal.intent?.custodyEvidenceDigest).toBe(CUSTODY);
  expect(loader.stages).toBe(0);
  expect(await loader.store.getStateRecoveryRun("run_operator_loader_mutation")).toBeUndefined();

  const recheck = await fixture("recheck_mutation");
  const original = recheck.ports.authorization.verify.bind(recheck.ports.authorization);
  const ports = { ...recheck.ports, authorization: {
    verify: async (binding: OperatorRecoveryBinding) => {
      if (recheck.authCalls > 0) (binding as { workspaceId: string }).workspaceId = "attacker_workspace";
      return await original(binding);
    },
  } };
  await expect(composeOperatorSourceRecovery(ports, recheck.request)).rejects.toThrow(/refused/);
  expect(recheck.journal.intent?.workspaceId).toBe(recheck.seeded.workspace.id);
  expect(recheck.stages).toBe(1);
  expect(await recheck.store.getStateRecoveryRun("run_operator_recheck_mutation")).toBeUndefined();
});

test("real R2 handle from foreign custody cannot replay a journaled intent", async () => {
  const f = await fixture("foreign_custody");
  const bucket = new RecoveryR2BucketDouble();
  const adapter = new R2RecoveryStateArtifactStore({
    bucket, allocator: new ObjectKeyArtifactReferenceAllocator(),
    crypto: StateArtifactCrypto.fromEnv({
      TAKOSUMI_SECRET_STORE_PASSPHRASE: "synthetic-operator-recovery-test-passphrase-0123456789",
    }),
  });
  const ports = { ...f.ports, artifacts: adapter,
    loadSelectedPlaintext: async () => { throw new Error("seed intent only"); } };
  await expect(composeOperatorSourceRecovery(ports, f.request)).rejects.toThrow(/refused/);
  const intent = f.journal.intent!;
  const foreignCustody = `sha256:${"e".repeat(64)}` as const;
  const foreign = await adapter.stage({
    workspaceId: intent.workspaceId, capsuleId: intent.capsuleId,
    environment: intent.environment, failedApplyRunId: intent.failedApplyRunId,
    recoveryRunId: intent.recoveryRunId, generation: 1,
    plaintextSha256: intent.plaintextSha256, custodyEvidenceDigest: foreignCustody,
    plaintext: STATE,
  });
  f.journal.staged = { intent, artifactHandle: foreign.handle };
  await expect(composeOperatorSourceRecovery(ports, f.request)).rejects.toThrow(/refused/);
  expect(bucket.puts).toBe(1);
  expect(bucket.deletes).toBe(0);
  expect(await f.store.getStateRecoveryRun(intent.recoveryRunId)).toBeUndefined();
});

test("a changed replay digest or custody cannot reuse the first journal", async () => {
  const f = await fixture("replay_scope");
  expect((await composeOperatorSourceRecovery(f.ports, f.request)).status).toBe("committed");
  await expect(composeOperatorSourceRecovery(f.ports, {
    ...f.request, custodyEvidenceDigest: `sha256:${"e".repeat(64)}`,
  })).rejects.toThrow(/refused/);
  expect(f.stages).toBe(1);
  expect(f.journal.stagedWrites).toBe(1);
});

test("plaintext is bounded and never surfaced in refusal", async () => {
  const f = await fixture("bounds");
  const ports = { ...f.ports, loadSelectedPlaintext: async () => new Uint8Array(16 * 1024 * 1024 + 1) };
  await expect(composeOperatorSourceRecovery(ports, f.request)).rejects.toThrow(/refused/);
  expect(f.stages).toBe(0);
  expect(f.journal.intent).toBeDefined();
});
