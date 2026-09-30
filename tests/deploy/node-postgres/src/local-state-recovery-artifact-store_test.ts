import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import { sha256Digest } from "../../../../core/adapters/source/digest.ts";
import { PartitionedSecretBoundaryCrypto } from "../../../../core/adapters/secret-store/memory.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { recoverFailedInitialCreateState } from "../../../../core/domains/deploy-control/operator_state_recovery.ts";
import {
  createFileOpenTofuStateArtifactStore,
  createHttpOpenTofuRunner,
  createLocalOpenTofuRunnerProfile,
  type LocalOpenTofuRecoveryCommitStore,
} from "../../../../deploy/node-postgres/src/local-opentofu-runner.ts";
import {
  LocalOpenTofuStateRecoveryArtifactStore,
  LOCAL_RECOVERY_STATE_MAX_BYTES,
} from "../../../../deploy/node-postgres/src/local-state-recovery-artifact-store.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";

const TEST_STATE_CRYPTO = new PartitionedSecretBoundaryCrypto({
  globalPassphrase: "local-recovery-adapter-test-passphrase-32-bytes-minimum",
});
const CUSTODY_DIGEST = `sha256:${"c".repeat(64)}` as const;
const TEST_STATE = new TextEncoder().encode(
  '{"version":4,"serial":1,"lineage":"123e4567-e89b-42d3-a456-426614174000","terraform_version":"1.9.0","outputs":{},"resources":[]}',
);

function scope(override: Partial<{
  workspaceId: string;
  capsuleId: string;
  environment: string;
  failedApplyRunId: string;
  recoveryRunId: string;
}> = {}) {
  return {
    workspaceId: "workspace.local",
    capsuleId: "capsule.local",
    environment: "prod.blue",
    generation: 1 as const,
    failedApplyRunId: "apply.failed-1",
    recoveryRunId: "recovery.run-1",
    plaintextSha256: "" as `sha256:${string}`,
    custodyEvidenceDigest: CUSTODY_DIGEST,
    ...override,
  };
}

async function adapter(store: ReturnType<typeof createFileOpenTofuStateArtifactStore>) {
  return new LocalOpenTofuStateRecoveryArtifactStore({
    store,
    allocator: new ObjectKeyArtifactReferenceAllocator(),
  });
}

test("local recovery adapter stages encrypted state, verifies exact readback, and adopts only exact retries", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "takosumi-local-state-recovery-adapter-"));
  try {
    const fileStore = createFileOpenTofuStateArtifactStore(join(tempDir, "state"), TEST_STATE_CRYPTO);
    const recoveryStore = await adapter(fileStore);
    const plaintextSha256 = await sha256Digest(TEST_STATE) as `sha256:${string}`;
    const staged = await recoveryStore.stage({ ...scope(), plaintextSha256, plaintext: TEST_STATE });
    expect(staged.artifact.stateRef).toBe(
      "workspaces/workspace.local/capsules/capsule.local/environments/prod.blue/state-versions/00000001.tfstate.enc",
    );
    expect(staged.artifact.encryptedDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(staged.handle).not.toContain(staged.artifact.stateRef);
    expect(await recoveryStore.verify({
      workspaceId: "workspace.local",
      capsuleId: "capsule.local",
      failedApplyRunId: "apply.failed-1",
      recoveryRunId: "recovery.run-1",
      artifactHandle: staged.handle,
    })).toEqual(staged.artifact);

    const retry = await recoveryStore.stage({ ...scope(), plaintextSha256, plaintext: TEST_STATE });
    expect(retry).toEqual(staged);
    await expect(recoveryStore.stage({
      ...scope({ failedApplyRunId: "apply.other" }),
      plaintextSha256,
      plaintext: TEST_STATE,
    })).rejects.toThrow();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("local recovery adapter rejects unroundtrippable scope and oversized or invalid state", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "takosumi-local-state-recovery-invalid-"));
  try {
    const recoveryStore = await adapter(createFileOpenTofuStateArtifactStore(join(tempDir, "state"), TEST_STATE_CRYPTO));
    const plaintextSha256 = await sha256Digest(TEST_STATE) as `sha256:${string}`;
    await expect(recoveryStore.stage({
      ...scope({ capsuleId: "capsule:unsupported" }),
      plaintextSha256,
      plaintext: TEST_STATE,
    })).rejects.toThrow();
    await expect(recoveryStore.stage({
      ...scope(),
      plaintextSha256: CUSTODY_DIGEST,
      plaintext: TEST_STATE,
    })).rejects.toThrow();
    await expect(recoveryStore.stage({
      ...scope(),
      plaintextSha256,
      plaintext: new Uint8Array(LOCAL_RECOVERY_STATE_MAX_BYTES + 1),
    })).rejects.toThrow();
    await expect(recoveryStore.stage({
      ...scope(),
      plaintextSha256,
      plaintext: new TextEncoder().encode("not state"),
    })).rejects.toThrow();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("local recovery ciphertext and authenticated scope metadata tampering fail closed", async () => {
  for (const tamper of ["ciphertext", "aad-metadata"] as const) {
    const tempDir = await mkdtemp(join(tmpdir(), `takosumi-local-recovery-${tamper}-`));
    try {
      const root = join(tempDir, "state");
      const fileStore = createFileOpenTofuStateArtifactStore(root, TEST_STATE_CRYPTO);
      const recoveryStore = await adapter(fileStore);
      const plaintextSha256 = await sha256Digest(TEST_STATE) as `sha256:${string}`;
      const staged = await recoveryStore.stage({
        ...scope({ capsuleId: `capsule-${tamper}` }),
        plaintextSha256,
        plaintext: TEST_STATE,
      });
      const stateRefDigest = createHash("sha256").update(staged.artifact.stateRef).digest("hex");
      const path = join(root, stateRefDigest.slice(0, 2), `${stateRefDigest}.json`);
      const envelope = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      if (tamper === "ciphertext") {
        const ciphertext = Buffer.from(String(envelope.ciphertextBase64), "base64");
        ciphertext[12] = ciphertext[12]! ^ 1;
        envelope.ciphertextBase64 = ciphertext.toString("base64");
        envelope.encryptedDigest = await sha256Digest(new Uint8Array(ciphertext));
      } else {
        envelope.workspaceId = "workspace.tampered";
      }
      await writeFile(path, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
      await expect(fileStore.read(staged.artifact.stateRef)).rejects.toThrow();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
});

test("concurrent exact local recovery stages converge and conflicting digest or owner never overwrites", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "takosumi-local-recovery-race-"));
  try {
    const fileStore = createFileOpenTofuStateArtifactStore(join(tempDir, "state"), TEST_STATE_CRYPTO);
    const recoveryStore = await adapter(fileStore);
    const plaintextSha256 = await sha256Digest(TEST_STATE) as `sha256:${string}`;
    const exactInput = { ...scope(), plaintextSha256, plaintext: TEST_STATE };
    const [left, right] = await Promise.all([
      recoveryStore.stage(exactInput),
      recoveryStore.stage(exactInput),
    ]);
    expect(left).toEqual(right);

    const originalOnDisk = await fileStore.read(left.artifact.stateRef);
    expect(originalOnDisk?.action).toBe("state_recovery");
    const conflictingBytes = new TextEncoder().encode(
      '{"version":4,"serial":2,"lineage":"123e4567-e89b-42d3-a456-426614174000","terraform_version":"1.9.0","outputs":{},"resources":[]}',
    );
    const conflictingDigest = await sha256Digest(conflictingBytes) as `sha256:${string}`;
    await expect(recoveryStore.stage({
      ...scope(),
      plaintextSha256: conflictingDigest,
      plaintext: conflictingBytes,
    })).rejects.toThrow();
    await expect(recoveryStore.stage({
      ...scope({ recoveryRunId: "recovery.other-owner" }),
      plaintextSha256,
      plaintext: TEST_STATE,
    })).rejects.toThrow();
    expect(await fileStore.read(left.artifact.stateRef)).toEqual(originalOnDisk);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("local recovery exact retry reconciles a lost commit acknowledgement without replacing ciphertext", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "takosumi-local-recovery-lost-ack-"));
  try {
    const fileStore = createFileOpenTofuStateArtifactStore(join(tempDir, "state"), TEST_STATE_CRYPTO);
    let commitCalls = 0;
    let acknowledgedCiphertextDigest: string | undefined;
    const lostAckStore: LocalOpenTofuRecoveryCommitStore = {
      ...fileStore,
      async commitRecovery(input) {
        const committed = await fileStore.commitRecovery(input);
        commitCalls += 1;
        if (commitCalls === 1) {
          acknowledgedCiphertextDigest = committed.encryptedDigest;
          throw new Error("simulated lost commit acknowledgement");
        }
        return committed;
      },
    };
    const recoveryStore = await adapter(lostAckStore);
    const plaintextSha256 = await sha256Digest(TEST_STATE) as `sha256:${string}`;
    const input = { ...scope(), plaintextSha256, plaintext: TEST_STATE };
    await expect(recoveryStore.stage(input)).rejects.toThrow("simulated lost commit acknowledgement");
    const retry = await recoveryStore.stage(input);
    const repeatedRetry = await recoveryStore.stage(input);
    expect(commitCalls).toBe(3);
    expect(retry).toEqual(repeatedRetry);
    expect(retry.artifact.encryptedDigest).toBe(acknowledgedCiphertextDigest);
    expect(await recoveryStore.verify({
      workspaceId: input.workspaceId,
      capsuleId: input.capsuleId,
      failedApplyRunId: input.failedApplyRunId,
      recoveryRunId: input.recoveryRunId,
      artifactHandle: retry.handle,
    })).toEqual(retry.artifact);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("local recovery verifier bounds oversized occupied v2-prefixed files before allocation", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "takosumi-local-recovery-verify-oversize-"));
  try {
    const root = join(tempDir, "state");
    const fileStore = createFileOpenTofuStateArtifactStore(root, TEST_STATE_CRYPTO);
    const recoveryStore = await adapter(fileStore);
    const plaintextSha256 = await sha256Digest(TEST_STATE) as `sha256:${string}`;
    const staged = await recoveryStore.stage({ ...scope(), plaintextSha256, plaintext: TEST_STATE });
    const stateRefDigest = createHash("sha256").update(staged.artifact.stateRef).digest("hex");
    const path = join(root, stateRefDigest.slice(0, 2), `${stateRefDigest}.json`);
    await writeFile(path, '{"version":2,"kind":"spoofed-v2-prefix"');
    const file = await open(path, "r+");
    try {
      await file.truncate(33 * 1024 * 1024);
    } finally {
      await file.close();
    }
    await expect(recoveryStore.verify({
      workspaceId: staged.artifact.workspaceId,
      capsuleId: staged.artifact.capsuleId,
      failedApplyRunId: "apply.failed-1",
      recoveryRunId: staged.artifact.recoveryRunId,
      artifactHandle: staged.handle,
    })).rejects.toThrow(/recovery artifact exceeds envelope size limit/u);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("staged local recovery commits Core generation one and local Plan receives the exact recovered bytes", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "takosumi-local-state-recovery-plan-"));
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const stateArtifactStore = createFileOpenTofuStateArtifactStore(join(tempDir, "state"), TEST_STATE_CRYPTO);
    const recoveryArtifacts = await adapter(stateArtifactStore);
    const controlStore = new InMemoryOpenTofuControlStore();
    const seeded = await seedCapsuleModel(controlStore, {
      workspaceId: "workspace_recovery_local",
      capsuleId: "capsule_recovery_local",
      sourceId: "source_recovery_local",
      snapshotId: "snapshot_recovery_local",
      installConfigId: "config_recovery_local",
    });
    const failedApplyRunId = "apply_recovery_local";
    const recoveryRunId = "recovery_local";
    const planRunId = "plan_recovery_local";
    const epoch = await controlStore.getCapsuleExecutionAuthorityEpoch(seeded.capsule.id);
    if (epoch === undefined) throw new Error("missing fixture execution epoch");
    const digest = "sha256:" + createHash("sha256").update(TEST_STATE).digest("hex");
    const planRun = {
      id: planRunId,
      workspaceId: seeded.workspace.id,
      capsuleId: seeded.capsule.id,
      capsuleCurrentStateVersionId: null,
      capsuleExecutionAuthorityEpoch: epoch,
      capsuleContext: {
        workspaceId: seeded.workspace.id,
        capsuleId: seeded.capsule.id,
        environment: seeded.capsule.environment,
      },
      source: { kind: "git" as const, url: seeded.snapshot.url, commit: seeded.snapshot.resolvedCommit },
      sourceDigest: digest,
      operation: "create" as const,
      runnerProfileId: "opentofu-default",
      variablesDigest: digest,
      executionInputsDigest: digest,
      requiredProviders: [],
      status: "succeeded" as const,
      policy: { status: "passed" as const, reasons: [], checkedAt: 1 },
      policyDecisionDigest: digest,
      planDigest: digest,
      planArtifact: { kind: "object-storage", ref: "opaque-plan", digest },
      sourceSnapshotId: seeded.snapshot.id,
      baseStateGeneration: 0,
      appliedApplyRunId: failedApplyRunId,
      planResourceChanges: [{ address: "example_resource.a", type: "example_resource", actions: ["create"] }],
      auditEvents: [],
      createdAt: 1,
      updatedAt: 1,
    };
    const failedApplyRun = {
      id: failedApplyRunId,
      planRunId,
      workspaceId: seeded.workspace.id,
      capsuleId: seeded.capsule.id,
      operation: "create" as const,
      runnerProfileId: planRun.runnerProfileId,
      status: "failed" as const,
      expected: {
        planRunId,
        capsuleId: seeded.capsule.id,
        currentStateVersionId: null,
        capsuleExecutionAuthorityEpoch: epoch,
        runnerProfileId: planRun.runnerProfileId,
        sourceDigest: digest,
        variablesDigest: digest,
        policyDecisionDigest: digest,
        planDigest: digest,
        planArtifactDigest: digest,
      },
      stateBackend: { kind: "operator-managed" as const, ref: "opaque-backend" },
      stateLock: { status: "recorded" as const, backendRef: "opaque-backend" },
      auditEvents: [{ id: "event_recovery_local", type: "apply.failed" as const, at: 2, data: { providerDispatched: true } }],
      createdAt: 2,
      updatedAt: 3,
      startedAt: 2,
      finishedAt: 3,
    };
    await controlStore.putPlanRun(planRun as never);
    await controlStore.putApplyRun(failedApplyRun as never);
    await controlStore.patchCapsule(seeded.capsule.id, { status: "error", updatedAt: "2026-06-07T00:00:00.000Z" }, {
      currentStateVersionId: undefined,
      status: "pending",
    });

    const plaintextSha256 = await sha256Digest(TEST_STATE) as `sha256:${string}`;
    const planBytes = new TextEncoder().encode("fixture reviewed plan");
    const planDigest = `sha256:${createHash("sha256").update(planBytes).digest("hex")}`;
    let restoredState: Uint8Array | undefined;
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (request.method === "PUT" && url.pathname === `/runs/${planRunId}/artifacts/tfstate`) {
          restoredState = new Uint8Array(await request.arrayBuffer());
          return new Response(null, { status: 204 });
        }
        if (request.method === "POST" && url.pathname === `/runs/${planRunId}`) {
          return Response.json({
            planDigest,
            planArtifact: { kind: "runner-local", ref: `runner-local://${planRunId}/tfplan`, digest: planDigest },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const runner = createHttpOpenTofuRunner({
      archiveStore: { write: async () => {}, read: async () => new Uint8Array() },
      stateStore: stateArtifactStore,
      baseUrl: server.url.href,
    });
    const planJob = (stateRef: string, createdByRunId: string) => ({
      planRun: { ...planRun, id: planRunId, workspaceId: seeded.workspace.id } as never,
      runnerProfile: createLocalOpenTofuRunnerProfile(),
      variables: {},
      stateScope: {
        workspaceId: seeded.workspace.id,
        subject: { kind: "capsule" as const, id: seeded.capsule.id },
        environment: seeded.capsule.environment,
        generation: 1,
        stateRef,
        priorState: { generation: 1, stateRef, digest: plaintextSha256, createdByRunId },
      },
    });
    const canonicalStateRef = "workspaces/workspace_recovery_local/capsules/capsule_recovery_local/environments/production/state-versions/00000001.tfstate.enc";
    await expect(runner.plan(planJob(canonicalStateRef, recoveryRunId))).rejects.toThrow(
      "was not found",
    );

    const staged = await recoveryArtifacts.stage({
      workspaceId: seeded.workspace.id,
      capsuleId: seeded.capsule.id,
      environment: seeded.capsule.environment,
      generation: 1,
      failedApplyRunId,
      recoveryRunId,
      plaintextSha256,
      custodyEvidenceDigest: CUSTODY_DIGEST,
      plaintext: TEST_STATE,
    });
    const recovered = await recoverFailedInitialCreateState({
      store: controlStore,
      verifier: recoveryArtifacts,
      artifactHandle: staged.handle,
      failedApplyRunId,
      recoveryRunId,
      createdBy: "operator_fixture",
      now: "2026-06-07T00:00:00.000Z",
    });
    expect(recovered.status).toBe("committed");
    if (recovered.status !== "committed") throw new Error("Core recovery did not commit");
    expect((await controlStore.getApplyRun(failedApplyRunId))?.status).toBe("failed");
    expect((await controlStore.getStateVersion(recovered.stateVersion.id))?.stateRef).toBe(staged.artifact.stateRef);

    const planResult = await runner.plan(planJob(staged.artifact.stateRef, recoveryRunId));
    expect(planResult.planDigest).toBe(planDigest);
    expect(restoredState).toEqual(TEST_STATE);
  } finally {
    server?.stop(true);
    await rm(tempDir, { recursive: true, force: true });
  }
});
