import { expect, test } from "bun:test";

import {
  OpenTofuDeploymentController,
  type OpenTofuApplyResult,
} from "./mod.ts";
import {
  type AcquireInstallationLeaseInput,
  type InstallationCoordination,
  InMemoryInstallationCoordination,
  type InstallationLease,
  type RenewInstallationLeaseInput,
  type ReleaseInstallationLeaseInput,
} from "./installation_lease.ts";
import { InMemoryOpenTofuDeploymentStore } from "./store.ts";
import { seedInstallationModel } from "./test_model_fixture.ts";
import type {
  ApplyRun,
  PlanRun,
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
 * Seeds the Space-direct Installation model plus a succeeded PlanRun and a
 * QUEUED ApplyRun bound to the same Installation (mirrors apply_lease_test.ts's
 * fixture). Returns the environment so the lease scope can be reconstructed.
 */
async function seedApply(
  store: InMemoryOpenTofuDeploymentStore,
  ids: {
    installationId: string;
    planRunId: string;
    applyRunId: string;
    environment?: string;
  },
): Promise<{ environment: string }> {
  const environment = ids.environment ?? "production";
  const seedDeploymentId = `dep_seed_${ids.installationId}`;
  const { installation, source, snapshot } = await seedInstallationModel(store, {
    installationId: ids.installationId,
    spaceId: `space_${ids.installationId}`,
    sourceId: `src_${ids.installationId}`,
    snapshotId: `snap_${ids.installationId}`,
    installConfigId: `cfg_${ids.installationId}`,
    environment,
  });
  await store.putInstallation({
    ...installation,
    currentDeploymentId: seedDeploymentId,
    currentStateGeneration: 0,
    status: "active",
  });
  const planRun: PlanRun = {
    id: ids.planRunId,
    spaceId: installation.spaceId,
    installationId: ids.installationId,
    installationCurrentDeploymentId: seedDeploymentId,
    source: {
      kind: "git",
      url: source.url,
      commit: "abcdef0123456789abcdef0123456789abcdef01",
    },
    sourceSnapshotId: snapshot.id,
    sourceDigest: "sha256:src",
    operation: "update",
    runnerProfileId: "cloudflare-default",
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
      files: { "main.tf": 'module "app" { source = "./template-module" }' },
      moduleFiles: [{ path: "main.tf", text: "# fixture module" }],
    },
  });
  const applyRun: ApplyRun = {
    id: ids.applyRunId,
    planRunId: ids.planRunId,
    spaceId: installation.spaceId,
    installationId: ids.installationId,
    operation: "update",
    runnerProfileId: "cloudflare-default",
    status: "queued",
    expected: {
      planRunId: ids.planRunId,
      installationId: ids.installationId,
      currentDeploymentId: seedDeploymentId,
      runnerProfileId: "cloudflare-default",
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
  store: InMemoryOpenTofuDeploymentStore,
  options: {
    coordination?: InstallationCoordination;
    now?: () => number;
    apply?: () => Promise<OpenTofuApplyResult>;
    runRenewalIntervalMs?: number;
  } = {},
) {
  return new OpenTofuDeploymentController({
    store,
    ...(options.coordination
      ? { installationCoordination: options.coordination }
      : {}),
    ...(options.runRenewalIntervalMs !== undefined
      ? { runRenewalIntervalMs: options.runRenewalIntervalMs }
      : {}),
    now: options.now ?? (() => 1),
    newId: ((): ((p: string) => string) => {
      let n = 0;
      return (p) => `${p}_${(n += 1).toString().padStart(4, "0")}`;
    })(),
    runner: {
      plan: () => Promise.reject(new Error("not used")),
      apply: options.apply ?? (() => Promise.resolve({})),
    },
  });
}

// --- cancel-vs-claim ---

test("cancel that wins forces a later consumer claim to lose (no dispatch, no resurrection)", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedApply(store, {
    installationId: "ins_cancel_first",
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
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedApply(store, {
    installationId: "ins_claim_first",
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

test("cancel that wins forces a later PLAN claim to lose (no dispatch)", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  // Seed a queued plan directly so we can race cancel vs the plan claim.
  const { installation } = await seedInstallationModel(store, {
    installationId: "ins_plan_cancel",
  });
  const planRun: PlanRun = {
    id: "plan_pc",
    spaceId: installation.spaceId,
    installationId: installation.id,
    source: { kind: "git", url: "https://example.test/x.git", ref: "main" },
    operation: "update",
    runnerProfileId: "cloudflare-default",
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
  const controller = new OpenTofuDeploymentController({
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
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedApply(store, {
    installationId: "ins_race",
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
  expect(statuses.every((s) => s === "running" || s === "succeeded")).toBe(true);
  expect((await store.getApplyRun("apply_race"))?.status).toBe("succeeded");
});

// --- heartbeat + lease renewal during a long apply ---

test("the run heartbeat is re-stamped AND the lease renewed while a long apply blocks in the runner", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedApply(store, {
    installationId: "ins_hb",
    planRunId: "plan_hb",
    applyRunId: "apply_hb",
  });

  // A monotonically advancing clock so each renewal tick stamps a strictly later
  // heartbeat than the claim's startedAt heartbeat.
  let clock = 1000;
  const now = () => (clock += 1);
  const coordination = new InMemoryInstallationCoordination({ now });

  // Count renewLease calls (the renewal harness should fire at least once while
  // the apply blocks) without changing the in-memory renew semantics.
  let renewCalls = 0;
  const observingCoordination: InstallationCoordination = {
    acquireLease: (input: AcquireInstallationLeaseInput) =>
      coordination.acquireLease(input),
    releaseLease: (input: ReleaseInstallationLeaseInput) =>
      coordination.releaseLease(input),
    renewLease: (
      input: RenewInstallationLeaseInput,
    ): Promise<InstallationLease> => {
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
  // installation lease while the apply was blocked in the runner.
  expect(renewCalls).toBeGreaterThan(0);
  expect(midFlightHeartbeat).toBeGreaterThan(claimHeartbeat);
});
