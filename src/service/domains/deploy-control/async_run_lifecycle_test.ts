import { expect, test } from "bun:test";
import {
  applyExpectedGuardFromPlanRun,
  type EnqueueRun,
  type OpenTofuApplyJob,
  type OpenTofuDestroyJob,
  type OpenTofuPlanJob,
  OpenTofuDeploymentController,
  type OpenTofuRunner,
} from "./mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "./store.ts";
import { seedInstallationModel } from "./test_model_fixture.ts";
import {
  type ConnectionVault,
  CredentialBundle,
  type RegisterConnectionInput,
  type TestConnectionResult,
} from "../../adapters/vault/mod.ts";
import type {
  Connection,
  CreatePlanRunRequest,
} from "takosumi-contract/deploy-control-api";

const SOURCE = {
  kind: "git",
  url: "https://github.com/example/app.git",
  ref: "main",
} as const;

const PLAN_DIGEST =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const LOCK_DIGEST =
  "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const CLOUDFLARE = "registry.opentofu.org/cloudflare/cloudflare";
const SECRET_TOKEN = "cf-token-super-secret-value";

/**
 * Seeds the Space-direct Installation model (spec §5) and returns an UPDATE
 * plan-run request bound to the seeded Installation (raw `createPlanRun` now
 * requires an existing installationId). The Installation is seeded WITH a
 * current deployment + state generation `gen` so the apply-expected guard is
 * well-formed and the plan's base generation matches.
 */
async function seedUpdatable(
  store: InMemoryOpenTofuDeploymentStore,
  options: { installationId: string; generation?: number },
): Promise<CreatePlanRunRequest> {
  const generation = options.generation ?? 0;
  const { installation } = await seedInstallationModel(store, {
    installationId: options.installationId,
  });
  await store.putInstallation({
    ...installation,
    currentDeploymentId: `dep_seed_${options.installationId}`,
    currentStateGeneration: generation,
    status: "active",
  });
  return {
    spaceId: installation.spaceId,
    installationId: installation.id,
    operation: "update",
    source: SOURCE,
    requiredProviders: [CLOUDFLARE],
  };
}

// --- happy-path plan + apply: credentials reach the dispatch, never the store ---

test("consumer plan + apply: credentials reach the dispatch payload but never the store or logs", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const captured: { plan?: OpenTofuPlanJob; apply?: OpenTofuApplyJob } = {};
  const controller = new OpenTofuDeploymentController({
    store,
    now: monotonicNow(1000),
    newId: deterministicIds(),
    runner: capturingRunner(captured),
    vault: fakeVault({ [CLOUDFLARE]: { CLOUDFLARE_API_TOKEN: SECRET_TOKEN } }),
  });
  const request = await seedUpdatable(store, { installationId: "inst_happy" });

  const { planRun } = await controller.createPlanRun(request);
  expect(planRun.status).toEqual("succeeded");

  // The plan job saw the minted credential...
  expect(captured.plan?.credentials).toEqual({
    CLOUDFLARE_API_TOKEN: SECRET_TOKEN,
  });
  // ...but the persisted PlanRun never carries it.
  const persistedPlan = await store.getPlanRun(planRun.id);
  expect(JSON.stringify(persistedPlan)).not.toContain(SECRET_TOKEN);

  const applied = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });
  expect(applied.applyRun.status).toEqual("succeeded");
  expect(captured.apply?.credentials).toEqual({
    CLOUDFLARE_API_TOKEN: SECRET_TOKEN,
  });

  // Neither the apply run, the deployment, nor the installation leak the secret.
  const dump = JSON.stringify({
    applyRun: await store.getApplyRun(applied.applyRun.id),
    deployment: applied.deployment,
    installation: applied.installation,
  });
  expect(dump).not.toContain(SECRET_TOKEN);

  // The plan inputs sidecar is cleared after the run completes.
  expect(await store.getPlanRunInputs(planRun.id)).toBeUndefined();
});

test("a minted CredentialBundle never serializes its values", () => {
  const bundle = new CredentialBundle({ CLOUDFLARE_API_TOKEN: SECRET_TOKEN });
  expect(JSON.stringify({ bundle })).not.toContain(SECRET_TOKEN);
  expect(`${bundle}`).toEqual("[credential-bundle]");
  expect(bundle.env.CLOUDFLARE_API_TOKEN).toEqual(SECRET_TOKEN);
});

// --- idempotency ---

test("idempotency: dispatching a terminal run no-ops", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  let planCalls = 0;
  const controller = new OpenTofuDeploymentController({
    store,
    now: monotonicNow(2000),
    newId: deterministicIds(),
    runner: countingRunner(() => planCalls++),
  });
  const request = await seedUpdatable(store, { installationId: "inst_idem" });
  const { planRun } = await controller.createPlanRun(request);
  expect(planRun.status).toEqual("succeeded");
  expect(planCalls).toEqual(1);

  // Re-dispatch the same (now terminal) run: must not re-run the plan.
  await controller.dispatchQueuedRun({
    action: "plan",
    runId: planRun.id,
    spaceId: planRun.spaceId,
  });
  expect(planCalls).toEqual(1);
});

test("idempotency: a fresh-heartbeat running run is not taken over", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const clock = controllableClock(3000);
  let planCalls = 0;
  const controller = new OpenTofuDeploymentController({
    store,
    now: clock.now,
    newId: deterministicIds(),
    runner: countingRunner(() => planCalls++),
    // Hold dispatch so the run stays queued; we drive the consumer by hand.
    enqueueRun: noopEnqueue,
  });
  const request = await seedUpdatable(store, { installationId: "inst_fresh" });
  const { planRun } = await controller.createPlanRun(request);
  // Simulate a sibling consumer that marked it running with a fresh heartbeat.
  await store.putPlanRun({
    ...(await store.getPlanRun(planRun.id))!,
    status: "running",
    heartbeatAt: clock.value(),
  });
  await controller.dispatchQueuedRun({
    action: "plan",
    runId: planRun.id,
    spaceId: planRun.spaceId,
  });
  expect(planCalls).toEqual(0); // fresh heartbeat -> sibling owns it
});

test("stale-heartbeat running run is taken over by the consumer", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const clock = controllableClock(4000);
  let planCalls = 0;
  const controller = new OpenTofuDeploymentController({
    store,
    now: clock.now,
    newId: deterministicIds(),
    runner: countingRunner(() => planCalls++),
    enqueueRun: noopEnqueue,
  });
  const request = await seedUpdatable(store, { installationId: "inst_stale" });
  const { planRun } = await controller.createPlanRun(request);
  // Marked running by a consumer that then crashed; heartbeat is far in the past.
  await store.putPlanRun({
    ...(await store.getPlanRun(planRun.id))!,
    status: "running",
    heartbeatAt: clock.value() - 11 * 60 * 1000,
  });
  await controller.dispatchQueuedRun({
    action: "plan",
    runId: planRun.id,
    spaceId: planRun.spaceId,
  });
  expect(planCalls).toEqual(1); // stale heartbeat -> taken over
});

// --- retry semantics + DLQ ---

test("a runner failure records the run failed and never persists the minted credential", async () => {
  // The plan/apply consumers convert runner failures into a recorded `failed`
  // run (they do not rethrow infrastructure errors into the store path; the
  // queue-level retry-on-rethrow is exercised in the worker test). The minted
  // credential is on the dispatch job only, so it must not appear on the
  // persisted (failed) run.
  const store = new InMemoryOpenTofuDeploymentStore();
  const controller = new OpenTofuDeploymentController({
    store,
    now: monotonicNow(5000),
    newId: deterministicIds(),
    runner: {
      plan: () => Promise.reject(new Error("opentofu init failed: exit 1")),
      apply: () => Promise.resolve({}),
    },
    vault: fakeVault({ [CLOUDFLARE]: { CLOUDFLARE_API_TOKEN: SECRET_TOKEN } }),
  });
  const request = await seedUpdatable(store, { installationId: "inst_fail" });
  const { planRun } = await controller.createPlanRun(request);
  expect(planRun.status).toEqual("failed");
  expect(planRun.diagnostics?.[0]?.severity).toEqual("error");
  const dump = JSON.stringify(await store.getPlanRun(planRun.id));
  expect(dump).not.toContain(SECRET_TOKEN);
});

test("DLQ backstop marks a non-terminal run failed (retries-exhausted)", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const controller = new OpenTofuDeploymentController({
    store,
    now: monotonicNow(6000),
    newId: deterministicIds(),
    runner: stubRunner(),
    enqueueRun: noopEnqueue, // leave the run queued
  });
  const request = await seedUpdatable(store, { installationId: "inst_dlq" });
  const { planRun } = await controller.createPlanRun(request);
  expect(planRun.status).toEqual("queued");

  const transitioned = await controller.markRunFailed(
    "plan",
    planRun.id,
    "retries-exhausted",
  );
  expect(transitioned).toEqual(true);
  const failed = await store.getPlanRun(planRun.id);
  expect(failed?.status).toEqual("failed");

  // Idempotent: a terminal run is not re-failed.
  expect(
    await controller.markRunFailed("plan", planRun.id, "retries-exhausted"),
  ).toEqual(false);
});

// --- state generation guard ---

test("state generation: a successful apply increments the installation generation", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const controller = new OpenTofuDeploymentController({
    store,
    now: monotonicNow(7000),
    newId: deterministicIds(),
    runner: stubRunner(),
  });
  const request = await seedUpdatable(store, { installationId: "inst_gen" });
  const { planRun } = await controller.createPlanRun(request);
  const applied = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });
  expect(applied.installation?.currentStateGeneration).toEqual(1);
});

test("state generation: a stale plan is rejected at apply (state_generation_mismatch)", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const controller = new OpenTofuDeploymentController({
    store,
    now: monotonicNow(8000),
    newId: deterministicIds(),
    runner: stubRunner(),
  });
  // Installation seeded at generation 0 with a current deployment.
  const request = await seedUpdatable(store, { installationId: "inst_stale_gen" });
  const installationId = request.installationId!;

  // First update against generation 0 -> apply advances to generation 1.
  const updateA = (await controller.createPlanRun(request)).planRun;
  expect(updateA.baseStateGeneration).toEqual(0);
  await controller.createApplyRun({
    planRunId: updateA.id,
    expected: applyExpectedGuardFromPlanRun(updateA),
  });
  const afterA = await store.getInstallation(installationId);
  expect(afterA?.currentStateGeneration).toEqual(1);

  // Second update created against generation 1.
  const updateB = (await controller.createPlanRun({
    spaceId: request.spaceId,
    installationId,
    operation: "update",
    source: { ...SOURCE, ref: "release-2" },
    requiredProviders: [CLOUDFLARE],
  })).planRun;
  expect(updateB.baseStateGeneration).toEqual(1);

  // Apply updateB -> generation advances to 2.
  await controller.createApplyRun({
    planRunId: updateB.id,
    expected: applyExpectedGuardFromPlanRun(updateB),
  });
  const installation = await store.getInstallation(installationId);
  expect(installation?.currentStateGeneration).toEqual(2);

  // Forge a stale plan that still claims generation 1, bypassing the
  // currentDeployment guard, to prove the generation guard fires inside execute.
  const stalePlan = (await store.getPlanRun(updateB.id))!;
  const forgedId = "plan_forged_stale";
  await store.putPlanRun({
    ...stalePlan,
    id: forgedId,
    baseStateGeneration: 1,
    installationCurrentDeploymentId: installation!.currentDeploymentId,
    appliedApplyRunId: undefined,
    status: "succeeded",
  });
  await expect(
    controller.createApplyRun({
      planRunId: forgedId,
      expected: applyExpectedGuardFromPlanRun(
        (await store.getPlanRun(forgedId))!,
      ),
    }),
  ).rejects.toThrow(/state_generation_mismatch/);
});

// --- fakes / helpers ---

function capturingRunner(
  captured: { plan?: OpenTofuPlanJob; apply?: OpenTofuApplyJob; destroy?: OpenTofuDestroyJob },
): OpenTofuRunner {
  return {
    plan: (job) => {
      captured.plan = job;
      return Promise.resolve({
        planDigest: PLAN_DIGEST,
        planArtifact: planArtifact(),
        providerLockDigest: LOCK_DIGEST,
        requiredProviders: [CLOUDFLARE],
      });
    },
    apply: (job) => {
      captured.apply = job;
      return Promise.resolve({
        outputs: {
          launch_url: { sensitive: false, value: "https://app.example.test" },
        },
      });
    },
    destroy: (job) => {
      captured.destroy = job;
      return Promise.resolve({});
    },
  };
}

function countingRunner(onPlan: () => void): OpenTofuRunner {
  return {
    plan: () => {
      onPlan();
      return Promise.resolve({
        planDigest: PLAN_DIGEST,
        planArtifact: planArtifact(),
        requiredProviders: [CLOUDFLARE],
      });
    },
    apply: () => Promise.resolve({}),
  };
}

function stubRunner(): OpenTofuRunner {
  return {
    plan: () =>
      Promise.resolve({
        planDigest: PLAN_DIGEST,
        planArtifact: planArtifact(),
        requiredProviders: [CLOUDFLARE],
      }),
    apply: () =>
      Promise.resolve({
        outputs: {
          launch_url: { sensitive: false, value: "https://app.example.test" },
        },
      }),
    destroy: () => Promise.resolve({}),
  };
}

function planArtifact() {
  return {
    kind: "runner-local",
    ref: "runner-local://plan_async/tfplan",
    digest: PLAN_DIGEST,
    contentType: "application/vnd.opentofu.plan",
  } as const;
}

/** Minimal Vault fake: mint returns the configured env per provider. */
function fakeVault(
  byProvider: Readonly<Record<string, Readonly<Record<string, string>>>>,
): ConnectionVault {
  return {
    register: (_input: RegisterConnectionInput): Promise<Connection> => {
      throw new Error("not used");
    },
    test: (): Promise<TestConnectionResult> => {
      throw new Error("not used");
    },
    revoke: () => Promise.resolve(false),
    mint: (_spaceId, providers) => {
      const env: Record<string, string> = {};
      for (const provider of providers) {
        Object.assign(env, byProvider[provider] ?? {});
      }
      return Promise.resolve(new CredentialBundle(env));
    },
  };
}

const noopEnqueue: EnqueueRun = () => Promise.resolve();

function deterministicIds(): (prefix: string) => string {
  let next = 1;
  return (prefix) => `${prefix}_${String(next++).padStart(4, "0")}`;
}

// A clock that advances by 1 per call; good enough for ordering audit events.
function monotonicNow(start: number): () => number {
  let value = start;
  return () => value++;
}

// A clock the test can read without advancing it, for heartbeat-window math.
function controllableClock(start: number): {
  now: () => number;
  value: () => number;
} {
  let value = start;
  return {
    now: () => value++,
    value: () => value,
  };
}
