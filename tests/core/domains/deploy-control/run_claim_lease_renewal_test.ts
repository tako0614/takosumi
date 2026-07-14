import { expect, test } from "bun:test";

import {
  OpenTofuController,
  type OpenTofuPlanResult,
  type OpenTofuApplyResult,
} from "../../../../core/domains/deploy-control/mod.ts";
import {
  type AcquireCapsuleLeaseInput,
  type CapsuleCoordination,
  InMemoryCapsuleCoordination,
  type CapsuleLease,
  type RenewCapsuleLeaseInput,
  type ReleaseCapsuleLeaseInput,
} from "../../../../core/domains/deploy-control/capsule_lease.ts";
import {
  InMemoryOpenTofuControlStore,
  type TransitionRunInput,
  type TransitionRunResult,
} from "../../../../core/domains/deploy-control/store.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";
import type {
  ApplyRun,
  PlanRun,
  RunnerProfile,
} from "@takosumi/internal/deploy-control-api";

const PLAN_DIGEST =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function planArtifact() {
  return {
    kind: "runner-local" as const,
    ref: "runner-local://plan/tfplan",
    digest: PLAN_DIGEST,
  };
}

/**
 * Seeds the Workspace-direct Capsule model plus a succeeded PlanRun and a
 * QUEUED ApplyRun bound to the same Capsule (mirrors apply_lease_test.ts's
 * fixture). Returns the environment so the lease scope can be reconstructed.
 */
async function seedApply(
  store: InMemoryOpenTofuControlStore,
  ids: {
    capsuleId: string;
    planRunId: string;
    applyRunId: string;
    environment?: string;
  },
): Promise<{ environment: string }> {
  const environment = ids.environment ?? "production";
  const seedStateVersionId = `state_seed_${ids.capsuleId}`;
  const { capsule, source, snapshot } = await seedCapsuleModel(store, {
    capsuleId: ids.capsuleId,
    workspaceId: `ws_${ids.capsuleId}`,
    sourceId: `src_${ids.capsuleId}`,
    snapshotId: `snap_${ids.capsuleId}`,
    installConfigId: `cfg_${ids.capsuleId}`,
    environment,
  });
  await store.putCapsule({
    ...capsule,
    currentStateVersionId: seedStateVersionId,
    currentStateGeneration: 0,
    status: "active",
  });
  const planRun: PlanRun = {
    id: ids.planRunId,
    workspaceId: capsule.workspaceId,
    capsuleId: ids.capsuleId,
    capsuleCurrentStateVersionId: seedStateVersionId,
    capsuleContext: {
      workspaceId: capsule.workspaceId,
      capsuleId: ids.capsuleId,
      environment,
    },
    source: {
      kind: "git",
      url: source.url,
      commit: "abcdef0123456789abcdef0123456789abcdef01",
    },
    sourceSnapshotId: snapshot.id,
    sourceDigest: "sha256:src",
    operation: "update",
    runnerProfileId: "opentofu-default",
    variablesDigest: "sha256:vars",
    requiredProviders: [],
    status: "succeeded",
    policy: { status: "passed", reasons: [], checkedAt: 1 },
    policyDecisionDigest: "sha256:policy",
    planDigest: PLAN_DIGEST,
    planArtifact: planArtifact(),
    baseStateGeneration: 0,
    auditEvents: [],
    createdAt: 1,
    updatedAt: 1,
  };
  await store.putPlanRun(planRun);
  await store.putPlanRunInputs({
    planRunId: planRun.id,
    variables: {},
    generatedRoot: {
      files: { "main.tf": 'module "child" { source = "./module" }' },
      moduleFiles: [{ path: "main.tf", text: "# fixture module" }],
    },
  });
  const applyRun: ApplyRun = {
    id: ids.applyRunId,
    planRunId: ids.planRunId,
    workspaceId: capsule.workspaceId,
    capsuleId: ids.capsuleId,
    operation: "update",
    runnerProfileId: "opentofu-default",
    status: "queued",
    expected: {
      planRunId: ids.planRunId,
      capsuleId: ids.capsuleId,
      currentStateVersionId: seedStateVersionId,
      runnerProfileId: "opentofu-default",
      sourceDigest: "sha256:src",
      variablesDigest: "sha256:vars",
      policyDecisionDigest: "sha256:policy",
      planDigest: PLAN_DIGEST,
      planArtifactDigest: PLAN_DIGEST,
    },
    stateBackend: { kind: "managed", ref: "state" } as never,
    stateLock: { status: "pending", backendRef: "state" },
    auditEvents: [],
    createdAt: 1,
    updatedAt: 1,
  };
  await store.putApplyRun(applyRun);
  return { environment };
}

function controllerWith(
  store: InMemoryOpenTofuControlStore,
  options: {
    coordination?: CapsuleCoordination;
    now?: () => number;
    plan?: () => Promise<OpenTofuPlanResult>;
    apply?: () => Promise<OpenTofuApplyResult>;
    runRenewalIntervalMs?: number;
    runnerProfiles?: readonly RunnerProfile[];
    defaultRunnerProfileId?: string;
  } = {},
) {
  return new OpenTofuController({
    store,
    ...(options.runnerProfiles
      ? { runnerProfiles: options.runnerProfiles }
      : {}),
    ...(options.defaultRunnerProfileId
      ? { defaultRunnerProfileId: options.defaultRunnerProfileId }
      : {}),
    ...(options.coordination
      ? { capsuleCoordination: options.coordination }
      : {}),
    ...(options.runRenewalIntervalMs !== undefined
      ? { runRenewalIntervalMs: options.runRenewalIntervalMs }
      : {}),
    now: options.now ?? (() => 1),
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    newId: ((): ((p: string) => string) => {
      let n = 0;
      return (p) => `${p}_${(n += 1).toString().padStart(4, "0")}`;
    })(),
    runner: {
      plan: options.plan ?? (() => Promise.reject(new Error("not used"))),
      apply: options.apply ?? (() => Promise.resolve({})),
    },
  });
}

// --- cancel-vs-claim ---

test("cancel that wins forces a later consumer claim to lose (no dispatch, no resurrection)", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await seedApply(store, {
    capsuleId: "cap_cancel_first",
    planRunId: "plan_cf",
    applyRunId: "apply_cf",
  });
  let applied = false;
  const controller = controllerWith(store, {
    apply: () => {
      applied = true;
      return Promise.resolve({});
    },
  });

  // Cancel wins the queued row first.
  const cancelled = await controller.cancelRun("apply_cf");
  expect(cancelled.status).toBe("cancelled");

  // A consumer claim now races: the claim CAS (expectFrom 'queued') loses, so the
  // runner is NEVER dispatched and the cancelled run is not resurrected.
  const response = await controller.runQueuedApply("apply_cf");
  expect(applied).toBe(false);
  expect(response.applyRun.status).toBe("cancelled");
  expect((await store.getApplyRun("apply_cf"))?.status).toBe("cancelled");
});

test("a consumer claim that wins forces a concurrent cancel to be rejected (never clobbers the running apply)", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await seedApply(store, {
    capsuleId: "cap_claim_first",
    planRunId: "plan_clf",
    applyRunId: "apply_clf",
  });
  // Gate the runner so the apply stays 'running' while we attempt the cancel.
  let releaseApply!: () => void;
  const applyHolds = new Promise<void>((resolve) => {
    releaseApply = resolve;
  });
  const controller = controllerWith(store, {
    apply: async () => {
      await applyHolds;
      return {};
    },
  });

  // Start the claim; it moves the row to 'running' and blocks in the runner.
  const claimPromise = controller.runQueuedApply("apply_clf");
  // Let the claim mark running (flush microtasks + a macrotask) before the cancel.
  await new Promise((r) => setTimeout(r, 5));
  expect((await store.getApplyRun("apply_clf"))?.status).toBe("running");

  // The cancel CAS (expectFrom 'queued') now loses: a running apply is not
  // cancellable, and the cancel must not clobber it.
  await expect(controller.cancelRun("apply_clf")).rejects.toThrow(
    /only queued runs can be cancelled/,
  );

  releaseApply();
  const response = await claimPromise;
  expect(response.applyRun.status).toBe("succeeded");
});

test("a requeued destroy after successful pre_destroy cannot be cancelled or clear runtime safety", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await seedApply(store, {
    capsuleId: "cap_destroy_requeued",
    planRunId: "plan_destroy_requeued",
    applyRunId: "apply_destroy_requeued",
  });
  const planRun = (await store.getPlanRun("plan_destroy_requeued"))!;
  await store.putPlanRun({ ...planRun, operation: "destroy" });
  const applyRun = (await store.getApplyRun("apply_destroy_requeued"))!;
  await store.putApplyRun({
    ...applyRun,
    operation: "destroy",
    status: "queued",
    startedAt: 10,
    heartbeatAt: undefined,
    auditEvents: [
      ...applyRun.auditEvents,
      {
        id: "audit_pre_destroy_succeeded",
        type: "lifecycle_action.pre_destroy.succeeded",
        at: 11,
        data: {
          phase: "pre_destroy",
          status: "succeeded",
          commandCount: 1,
          actionDispatched: true,
        },
      },
      {
        id: "audit_destroy_retry",
        type: "destroy.retry_scheduled",
        at: 12,
        data: { reason: "runner_infrastructure_error" },
      },
    ],
    updatedAt: 12,
  });
  const controller = controllerWith(store);

  await expect(controller.cancelRun("apply_destroy_requeued")).rejects.toThrow(
    /has already started/,
  );
  expect((await store.getApplyRun("apply_destroy_requeued"))?.status).toBe(
    "queued",
  );
  expect(
    await store.getCapsuleRuntimeSafety("cap_destroy_requeued"),
  ).toMatchObject({
    phase: "terminating",
    runId: "apply_destroy_requeued",
    runType: "destroy_apply",
  });
});

test("cancel loses when an apply is started and requeued between its read and CAS", async () => {
  class RequeueBeforeCancelStore extends InMemoryOpenTofuControlStore {
    #interceptCancel = true;

    override async transitionRun(
      input: TransitionRunInput,
    ): Promise<TransitionRunResult> {
      if (
        this.#interceptCancel &&
        input.kind === "apply" &&
        input.run.status === "cancelled"
      ) {
        this.#interceptCancel = false;
        const current = await this.getApplyRun(input.id);
        if (current) {
          await this.putApplyRun({
            ...current,
            status: "queued",
            startedAt: 10,
            updatedAt: 12,
          });
        }
      }
      return await super.transitionRun(input);
    }
  }

  const store = new RequeueBeforeCancelStore();
  await seedApply(store, {
    capsuleId: "cap_cancel_requeue_race",
    planRunId: "plan_cancel_requeue_race",
    applyRunId: "apply_cancel_requeue_race",
  });
  const controller = controllerWith(store);

  await expect(
    controller.cancelRun("apply_cancel_requeue_race"),
  ).rejects.toThrow(/has already started/);
  expect(await store.getApplyRun("apply_cancel_requeue_race")).toMatchObject({
    status: "queued",
    startedAt: 10,
    updatedAt: 12,
  });
});

test("cancel that wins forces a later PLAN claim to lose (no dispatch)", async () => {
  const store = new InMemoryOpenTofuControlStore();
  // Seed a queued plan directly so we can race cancel vs the plan claim.
  const { capsule } = await seedCapsuleModel(store, {
    workspaceId: "ws_plan_cancel",
    capsuleId: "cap_plan_cancel",
  });
  const planRun: PlanRun = {
    id: "plan_pc",
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    source: { kind: "git", url: "https://example.test/x.git", ref: "main" },
    sourceDigest: "sha256:src",
    variablesDigest: "sha256:vars",
    operation: "update",
    runnerProfileId: "opentofu-default",
    requiredProviders: [],
    status: "queued",
    policy: { status: "passed", reasons: [], checkedAt: 1 },
    baseStateGeneration: 0,
    auditEvents: [],
    createdAt: 1,
    updatedAt: 1,
  };
  await store.putPlanRun(planRun);
  let planned = false;
  const controller = new OpenTofuController({
    store,
    now: () => 1,
    newId: (p) => `${p}_x`,
    runner: {
      plan: () => {
        planned = true;
        return Promise.resolve({
          planDigest: PLAN_DIGEST,
          planArtifact: planArtifact(),
        });
      },
      apply: () => Promise.resolve({}),
    },
  });

  const cancelled = await controller.cancelRun("plan_pc");
  expect(cancelled.status).toBe("cancelled");

  const result = await controller.runQueuedPlan("plan_pc");
  expect(planned).toBe(false);
  expect(result?.status).toBe("cancelled");
});

test("two concurrent queued claims for the same apply: exactly one dispatches", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await seedApply(store, {
    capsuleId: "cap_race0001",
    planRunId: "plan_race",
    applyRunId: "apply_race",
  });
  let applyCalls = 0;
  const controller = controllerWith(store, {
    apply: () => {
      applyCalls += 1;
      return Promise.resolve({});
    },
  });

  // Race two consumers claiming the SAME queued apply. The fenced claim CAS
  // (expectFrom 'queued') lets exactly one win; the loser must not dispatch.
  const [a, b] = await Promise.all([
    controller.runQueuedApply("apply_race"),
    controller.runQueuedApply("apply_race"),
  ]);

  expect(applyCalls).toBe(1);
  const statuses = [a.applyRun.status, b.applyRun.status].sort();
  // The winner reaches `succeeded`; the loser observes the winner's row (either
  // still `running` if it lost mid-flight, or the final `succeeded`). It never
  // re-runs the apply.
  expect(statuses.every((s) => s === "running" || s === "succeeded")).toBe(
    true,
  );
  expect((await store.getApplyRun("apply_race"))?.status).toBe("succeeded");
});

// --- heartbeat + lease renewal during a long apply ---

test("the run heartbeat is re-stamped AND the lease renewed while a long apply blocks in the runner", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await seedApply(store, {
    capsuleId: "cap_hb000001",
    planRunId: "plan_hb",
    applyRunId: "apply_hb",
  });

  // A monotonically advancing clock so each renewal tick stamps a strictly later
  // heartbeat than the claim's startedAt heartbeat.
  let clock = 1000;
  const now = () => (clock += 1);
  const coordination = new InMemoryCapsuleCoordination({ now });

  // Count renewLease calls (the renewal harness should fire at least once while
  // the apply blocks) without changing the in-memory renew semantics.
  let renewCalls = 0;
  const observingCoordination: CapsuleCoordination = {
    acquireLease: (input: AcquireCapsuleLeaseInput) =>
      coordination.acquireLease(input),
    releaseLease: (input: ReleaseCapsuleLeaseInput) =>
      coordination.releaseLease(input),
    renewLease: (input: RenewCapsuleLeaseInput): Promise<CapsuleLease> => {
      renewCalls += 1;
      return coordination.renewLease(input);
    },
  };

  // The runner blocks (driving a "long apply") long enough for the renewal timer
  // (small injected interval) to fire at least one tick, then returns. We capture
  // the claim heartbeat and the LATER mid-flight heartbeat INSIDE the runner —
  // the terminal write resets heartbeatAt to the final value, so the observation
  // must happen while the run is still `running`.
  let claimHeartbeat = 0;
  let midFlightHeartbeat = 0;
  const controller = controllerWith(store, {
    coordination: observingCoordination,
    now,
    runRenewalIntervalMs: 5,
    apply: async () => {
      claimHeartbeat = (await store.getApplyRun("apply_hb"))?.heartbeatAt ?? 0;
      const deadline = Date.now() + 1000;
      while (Date.now() < deadline) {
        const current = (await store.getApplyRun("apply_hb"))?.heartbeatAt ?? 0;
        if (current > claimHeartbeat && renewCalls > 0) {
          midFlightHeartbeat = current;
          break;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      return {};
    },
  });

  const response = await controller.runQueuedApply("apply_hb");

  expect(response.applyRun.status).toBe("succeeded");
  // A renewal tick re-stamped the heartbeat past the claim value and renewed the
  // capsule lease while the apply was blocked in the runner.
  expect(renewCalls).toBeGreaterThan(0);
  expect(midFlightHeartbeat).toBeGreaterThan(claimHeartbeat);
});

test("the plan heartbeat is re-stamped while a long plan blocks in the runner", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { capsule, source, snapshot } = await seedCapsuleModel(store, {
    workspaceId: "ws_plan_hb",
    capsuleId: "cap_plan_hb",
  });
  await store.putCapsule({
    ...capsule,
    currentStateVersionId: "state_seed_plan_hb",
    currentStateGeneration: 0,
    status: "active",
  });
  const planRun: PlanRun = {
    id: "plan_hb_long",
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    capsuleCurrentStateVersionId: "state_seed_plan_hb",
    capsuleContext: {
      workspaceId: capsule.workspaceId,
      capsuleId: capsule.id,
      environment: capsule.environment,
    },
    source: {
      kind: "git",
      url: source.url,
      commit: "abcdef0123456789abcdef0123456789abcdef01",
    },
    sourceSnapshotId: snapshot.id,
    sourceDigest: "sha256:src",
    variablesDigest: "sha256:vars",
    operation: "update",
    runnerProfileId: "provider-free",
    requiredProviders: [],
    status: "queued",
    policy: { status: "passed", reasons: [], checkedAt: 1 },
    baseStateGeneration: 0,
    auditEvents: [],
    createdAt: 1,
    updatedAt: 1,
  };
  await store.putPlanRun(planRun);
  await store.putPlanRunInputs({
    planRunId: planRun.id,
    variables: {},
    generatedRoot: {
      files: { "main.tf": 'module "child" { source = "./module" }' },
      moduleFiles: [{ path: "main.tf", text: "# fixture module" }],
    },
  });

  let clock = 2000;
  const now = () => (clock += 1);
  let claimHeartbeat = 0;
  let midFlightHeartbeat = 0;
  const controller = controllerWith(store, {
    now,
    runRenewalIntervalMs: 5,
    runnerProfiles: [
      {
        id: "provider-free",
        name: "Provider-free",
        substrate: "test",
        executorId: "opentofu.default",
        lifecycle: { state: "active" },
        availability: { state: "available" },
        stateBackend: { kind: "local", ref: "state://test" } as never,
        allowedProviders: [],
        createdAt: 1,
      },
    ],
    defaultRunnerProfileId: "provider-free",
    plan: async () => {
      claimHeartbeat =
        (await store.getPlanRun("plan_hb_long"))?.heartbeatAt ?? 0;
      const deadline = Date.now() + 1000;
      while (Date.now() < deadline) {
        const current =
          (await store.getPlanRun("plan_hb_long"))?.heartbeatAt ?? 0;
        if (current > claimHeartbeat) {
          midFlightHeartbeat = current;
          break;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      return {
        planDigest: PLAN_DIGEST,
        planArtifact: planArtifact(),
      };
    },
  });

  const response = await controller.runQueuedPlan("plan_hb_long");

  expect(response?.status).toBe("succeeded");
  expect(midFlightHeartbeat).toBeGreaterThan(claimHeartbeat);
});
