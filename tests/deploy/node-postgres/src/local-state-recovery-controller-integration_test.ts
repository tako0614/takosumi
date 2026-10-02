import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OpenTofuController,
  type OpenTofuPlanJob,
  type OpenTofuRunner,
} from "../../../../core/domains/deploy-control/mod.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import { sha256Digest } from "../../../../core/adapters/source/digest.ts";
import { PartitionedSecretBoundaryCrypto } from "../../../../core/adapters/secret-store/memory.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { recoverFailedInitialCreateState } from "../../../../core/domains/deploy-control/operator_state_recovery.ts";
import {
  FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
  seedCapsuleModel,
} from "../../../helpers/deploy-control/model_fixture.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import {
  createFileOpenTofuStateArtifactStore,
  createHttpOpenTofuRunner,
  createLocalOpenTofuRunnerProfile,
} from "../../../../deploy/node-postgres/src/local-opentofu-runner.ts";
import { LocalOpenTofuStateRecoveryArtifactStore } from "../../../../deploy/node-postgres/src/local-state-recovery-artifact-store.ts";

const TEST_STATE = new TextEncoder().encode(
  '{"version":4,"serial":1,"lineage":"123e4567-e89b-42d3-a456-426614174000","terraform_version":"1.9.0","outputs":{},"resources":[]}',
);
const PLAN_BYTES = new TextEncoder().encode("controller-issued destroy plan");
const PLAN_DIGEST = `sha256:${createHash("sha256").update(PLAN_BYTES).digest("hex")}` as const;
const SOURCE_DIGEST = `sha256:${"d".repeat(64)}` as const;
const CUSTODY_DIGEST = `sha256:${"c".repeat(64)}` as const;

test("committed local state recovery flows through Core destroy planning into the HTTP runner", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "takosumi-local-recovery-controller-"));
  const client = await PGliteSqlClient.create();
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const store = new SqlOpenTofuControlStore({ client });
    const seeded = await seedCapsuleModel(store, {
      workspaceId: "workspace_recovery_controller",
      capsuleId: "capsule_recovery_controller",
      sourceId: "source_recovery_controller",
      snapshotId: "snapshot_recovery_controller",
      installConfigId: "config_recovery_controller",
      environment: "production",
    });
    const sourceArchiveBytes = new TextEncoder().encode("captured source archive");
    const sourceArchiveDigest = await sha256Digest(sourceArchiveBytes) as `sha256:${string}`;
    await store.putSourceSnapshot({
      ...seeded.snapshot,
      archiveDigest: sourceArchiveDigest,
      archiveSizeBytes: sourceArchiveBytes.byteLength,
    });
    const epoch = await store.getCapsuleExecutionAuthorityEpoch(seeded.capsule.id);
    if (epoch === undefined) throw new Error("missing fixture execution epoch");

    const failedApplyRunId = "apply_recovery_controller";
    const recoveryRunId = "recovery_controller";
    const planRunId = "plan_recovery_controller";
    const planDigest = SOURCE_DIGEST;
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
      sourceDigest: SOURCE_DIGEST,
      operation: "create" as const,
      runnerProfileId: "local-opentofu",
      variablesDigest: SOURCE_DIGEST,
      executionInputsDigest: SOURCE_DIGEST,
      requiredProviders: [],
      status: "succeeded" as const,
      policy: { status: "passed" as const, reasons: [], checkedAt: 1 },
      policyDecisionDigest: SOURCE_DIGEST,
      planDigest,
      planArtifact: { kind: "object-storage" as const, ref: "opaque-pinned-create-plan", digest: planDigest },
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
        sourceDigest: planRun.sourceDigest,
        variablesDigest: planRun.variablesDigest,
        policyDecisionDigest: planRun.policyDecisionDigest,
        planDigest: planRun.planDigest,
        planArtifactDigest: planRun.planArtifact.digest,
      },
      stateBackend: { kind: "operator-managed" as const, ref: "opaque-backend" },
      stateLock: { status: "recorded" as const, backendRef: "opaque-backend" },
      auditEvents: [{ id: "event_recovery_controller", type: "apply.failed" as const, at: 2, data: { providerDispatched: true } }],
      createdAt: 2,
      updatedAt: 3,
      startedAt: 2,
      finishedAt: 3,
    };
    await store.putPlanRun(planRun);
    await store.putApplyRun(failedApplyRun);
    await store.patchCapsule(seeded.capsule.id, {
      status: "error",
      updatedAt: "2026-06-07T00:00:00.000Z",
    }, {
      currentStateVersionId: undefined,
      status: "pending",
    });

    const stateArtifactStore = createFileOpenTofuStateArtifactStore(
      join(tempDir, "state"),
      new PartitionedSecretBoundaryCrypto({
        globalPassphrase: "local-recovery-controller-passphrase-32-bytes-minimum",
      }),
    );
    const recoveryArtifacts = new LocalOpenTofuStateRecoveryArtifactStore({
      store: stateArtifactStore,
      allocator: new ObjectKeyArtifactReferenceAllocator(),
    });
    const plaintextSha256 = await sha256Digest(TEST_STATE) as `sha256:${string}`;
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

    const planUploads: Array<{ runId: string; bytes: Uint8Array }> = [];
    const planRequests: Array<{ runId: string; action: string }> = [];
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const match = /^\/runs\/([^/]+)(?:\/(.*))?$/u.exec(url.pathname);
        if (!match) return new Response("not found", { status: 404 });
        const runId = decodeURIComponent(match[1]!);
        const suffix = match[2] ?? "";
        if (request.method === "PUT" && suffix === "source-archive/restore") {
          return new Response(null, { status: 204 });
        }
        if (request.method === "PUT" && suffix === "artifacts/tfstate") {
          planUploads.push({ runId, bytes: new Uint8Array(await request.arrayBuffer()) });
          return new Response(null, { status: 204 });
        }
        if (request.method === "POST" && suffix === "") {
          const payload = await request.json() as { action?: string };
          planRequests.push({ runId, action: payload.action ?? "" });
          if (payload.action !== "plan") return new Response("mutation not expected", { status: 409 });
          return Response.json({
            planDigest: PLAN_DIGEST,
            planArtifact: {
              kind: "runner-local",
              ref: `runner-local://${runId}/tfplan`,
              digest: PLAN_DIGEST,
            },
          });
        }
        if (request.method === "GET" && suffix === "artifacts/tfplan") {
          return new Response(PLAN_BYTES, { status: 200 });
        }
        if (request.method === "POST" && suffix === "plan-state-metadata") {
          return Response.json({
            lineage: "123e4567-e89b-42d3-a456-426614174000",
            serial: 1,
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    const httpRunner = createHttpOpenTofuRunner({
      archiveStore: { write: async () => {}, read: async () => sourceArchiveBytes },
      stateStore: stateArtifactStore,
      baseUrl: server.url.href,
    });
    let controllerPlanJob: OpenTofuPlanJob | undefined;
    let forbiddenMutationCalls = 0;
    const runner: OpenTofuRunner = {
      plan: async (job, control) => {
        controllerPlanJob = job;
        return await httpRunner.plan(job, control);
      },
      apply: async () => {
        forbiddenMutationCalls += 1;
        throw new Error("Apply is outside this recovered-state planning proof");
      },
      destroy: async () => {
        forbiddenMutationCalls += 1;
        throw new Error("Destroy is outside this recovered-state planning proof");
      },
    };
    const profile = createLocalOpenTofuRunnerProfile(1);
    let id = 0;
    const controller = new OpenTofuController({
      store,
      runner,
      runnerProfiles: [profile],
      defaultRunnerProfileId: profile.id,
      artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
      executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
      newId: (prefix) => `${prefix}_controller_${++id}`,
      now: (() => { let value = 10; return () => value++; })(),
    });

    const recovered = await recoverFailedInitialCreateState({
      store,
      verifier: recoveryArtifacts,
      artifactHandle: staged.handle,
      failedApplyRunId,
      recoveryRunId,
      createdBy: "operator_fixture",
      now: "2026-06-07T00:00:00.000Z",
    });
    expect(recovered.status).toBe("committed");
    if (recovered.status !== "committed") throw new Error("Core recovery did not commit");

    const destroyPlan = await controller.createCapsuleDestroyPlan(seeded.capsule.id);
    expect(destroyPlan.planRun.status).toBe("waiting_approval");
    expect(destroyPlan.planRun.operation).toBe("destroy");
    expect(destroyPlan.planRun.sourceSnapshotId).toBe(seeded.snapshot.id);
    expect(destroyPlan.planRun.requiredProviders).toEqual([]);
    expect(controllerPlanJob?.planRun.capsuleCurrentStateVersionId).toBe(recovered.stateVersion.id);
    expect(controllerPlanJob?.stateScope?.priorState).toEqual({
      generation: 1,
      stateRef: staged.artifact.stateRef,
      digest: plaintextSha256,
      createdByRunId: recoveryRunId,
    });
    expect(planUploads).toEqual([{ runId: destroyPlan.planRun.id, bytes: TEST_STATE }]);
    expect(planRequests).toEqual([{ runId: destroyPlan.planRun.id, action: "plan" }]);
    expect(forbiddenMutationCalls).toBe(0);

    const failed = await store.getApplyRun(failedApplyRunId);
    expect(failed?.status).toBe("failed");
    expect(failed?.stateVersionId).toBeUndefined();
    expect(failed?.outputId).toBeUndefined();
    expect(await store.getStateVersion(recovered.stateVersion.id)).toEqual(recovered.stateVersion);
    const capsule = await store.getCapsule(seeded.capsule.id);
    expect(capsule?.currentStateVersionId).toBe(recovered.stateVersion.id);
    expect(capsule?.currentOutputId).toBeUndefined();
  } finally {
    server?.stop(true);
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});
