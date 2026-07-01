import { expect, test } from "bun:test";
import {
  applyExpectedGuardFromPlanRun,
  type EnqueueRun,
  type OpenTofuApplyJob,
  type OpenTofuDestroyJob,
  type OpenTofuPlanJob,
  OpenTofuDeploymentController,
  type OpenTofuRunner,
} from "../../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "../../../../core/domains/deploy-control/store.ts";
import { seedInstallationModel } from "../../../helpers/deploy-control/model_fixture.ts";
import {
  type ConnectionVault,
  CredentialBundle,
  PhaseMintBundle,
  type InstallationProviderEnvBindingMintEntry,
  type RegisterConnectionInput,
  type TestConnectionResult,
} from "../../../../core/adapters/vault/mod.ts";
import type {
  Connection,
  CreatePlanRunRequest,
} from "@takosumi/internal/deploy-control-api";

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
const CLOUDFLARE_MIRROR_EVIDENCE = {
  provider: CLOUDFLARE,
  mirrored: true,
  installationMethod: "filesystem_mirror",
  attested: true,
  attestationMethod: "forced_filesystem_mirror_init",
  mirrorPath:
    "/opt/opentofu/provider-mirror/registry.opentofu.org/cloudflare/cloudflare",
} as const;

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
  await store.putConnection({
    id: `conn_${options.installationId}`,
    scope: "space",
    spaceId: installation.spaceId,
    provider: "cloudflare",
    providerSource: CLOUDFLARE,
    kind: "cloudflare_api_token",
    displayName: "Lifecycle Cloudflare",
    status: "verified",
    materialization: "secret",
    envNames: ["CLOUDFLARE_API_TOKEN"],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
    verifiedAt: "2026-06-06T00:00:00.000Z",
  });
  await store.putInstallationProviderEnvBindingSet({
    id: `profile_${options.installationId}`,
    spaceId: installation.spaceId,
    installationId: installation.id,
    environment: installation.environment,
    bindings: [
      {
        provider: "cloudflare",
        alias: "main",
        connectionId: `conn_${options.installationId}`,
      },
    ],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
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
    TF_VAR_cloudflare_main_api_token: SECRET_TOKEN,
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
    TF_VAR_cloudflare_main_api_token: SECRET_TOKEN,
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
    vault: fakeVault({ [CLOUDFLARE]: { CLOUDFLARE_API_TOKEN: SECRET_TOKEN } }),
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
    vault: fakeVault({ [CLOUDFLARE]: { CLOUDFLARE_API_TOKEN: SECRET_TOKEN } }),
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
    vault: fakeVault({ [CLOUDFLARE]: { CLOUDFLARE_API_TOKEN: SECRET_TOKEN } }),
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

test("a retryable runner infrastructure reset requeues apply without failing terminally", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  let applyCalls = 0;
  const controller = new OpenTofuDeploymentController({
    store,
    now: monotonicNow(5500),
    newId: deterministicIds(),
    runner: {
      plan: () =>
        Promise.resolve({
          planDigest: PLAN_DIGEST,
          planArtifact: planArtifact(),
          providerLockDigest: LOCK_DIGEST,
          requiredProviders: [CLOUDFLARE],
          providerInstallation: [CLOUDFLARE_MIRROR_EVIDENCE],
        }),
      apply: () => {
        applyCalls++;
        if (applyCalls === 1) {
          return Promise.reject(
            new Error("Durable Object reset because its code was updated."),
          );
        }
        return Promise.resolve({
          outputs: {
            launch_url: {
              sensitive: false,
              value: "https://app.example.test",
            },
          },
        });
      },
    },
    vault: fakeVault({ [CLOUDFLARE]: { CLOUDFLARE_API_TOKEN: SECRET_TOKEN } }),
    enqueueRun: noopEnqueue,
  });
  const request = await seedUpdatable(store, { installationId: "inst_retry" });
  const { planRun: queuedPlan } = await controller.createPlanRun(request);
  expect(queuedPlan.status).toEqual("queued");

  await controller.dispatchQueuedRun({
    action: "plan",
    runId: queuedPlan.id,
    spaceId: queuedPlan.spaceId,
  });
  const planRun = (await store.getPlanRun(queuedPlan.id))!;
  expect(planRun.status).toEqual("succeeded");

  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });
  expect(applyRun.status).toEqual("queued");

  await expect(
    controller.dispatchQueuedRun({
      action: "apply",
      runId: applyRun.id,
      spaceId: applyRun.spaceId,
    }),
  ).rejects.toThrow(/retryable_runner_infrastructure_error/);

  const requeued = (await store.getApplyRun(applyRun.id))!;
  expect(requeued.status).toEqual("queued");
  expect(requeued.diagnostics).toBeUndefined();
  expect(
    requeued.auditEvents.some(
      (event) => event.type === "apply.retry_scheduled",
    ),
  ).toEqual(true);
  expect(applyCalls).toEqual(1);

  await controller.dispatchQueuedRun({
    action: "apply",
    runId: applyRun.id,
    spaceId: applyRun.spaceId,
  });
  const completed = (await store.getApplyRun(applyRun.id))!;
  expect(completed.status).toEqual("succeeded");
  expect(applyCalls).toEqual(2);
  expect(
    (await store.getInstallation(request.installationId!))
      ?.currentStateGeneration,
  ).toEqual(1);
});

test("DLQ backstop marks a non-terminal run failed (retries-exhausted)", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const controller = new OpenTofuDeploymentController({
    store,
    now: monotonicNow(6000),
    newId: deterministicIds(),
    runner: stubRunner(),
    vault: fakeVault({ [CLOUDFLARE]: { CLOUDFLARE_API_TOKEN: SECRET_TOKEN } }),
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

test("DLQ backstop does not clobber a running run with a fresh owner", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const controller = new OpenTofuDeploymentController({
    store,
    now: monotonicNow(6500),
    newId: deterministicIds(),
    runner: stubRunner(),
    vault: fakeVault({ [CLOUDFLARE]: { CLOUDFLARE_API_TOKEN: SECRET_TOKEN } }),
    enqueueRun: noopEnqueue,
  });
  const request = await seedUpdatable(store, {
    installationId: "inst_dlq_live",
  });
  const { planRun } = await controller.createPlanRun(request);
  expect(planRun.status).toEqual("queued");

  const claimed = await store.transitionRun({
    id: planRun.id,
    kind: "plan",
    expectFrom: ["queued"],
    setLeaseToken: "lease_live",
    heartbeatAt: 6501,
    run: {
      ...planRun,
      status: "running",
      heartbeatAt: 6501,
      updatedAt: 6501,
      startedAt: 6501,
    },
  });
  expect(claimed.won).toEqual(true);

  const transitioned = await controller.markRunFailed(
    "plan",
    planRun.id,
    "retries-exhausted",
  );

  expect(transitioned).toEqual(false);
  expect((await store.getPlanRun(planRun.id))?.status).toEqual("running");
});

// --- state generation guard ---

test("state generation: a successful apply increments the installation generation", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const controller = new OpenTofuDeploymentController({
    store,
    now: monotonicNow(7000),
    newId: deterministicIds(),
    runner: stubRunner(),
    vault: fakeVault({ [CLOUDFLARE]: { CLOUDFLARE_API_TOKEN: SECRET_TOKEN } }),
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
    vault: fakeVault({ [CLOUDFLARE]: { CLOUDFLARE_API_TOKEN: SECRET_TOKEN } }),
  });
  // Installation seeded at generation 0 with a current deployment.
  const request = await seedUpdatable(store, {
    installationId: "inst_stale_gen",
  });
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
  const updateB = (
    await controller.createPlanRun({
      spaceId: request.spaceId,
      installationId,
      operation: "update",
      source: { ...SOURCE, ref: "release-2" },
      requiredProviders: [CLOUDFLARE],
    })
  ).planRun;
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
  const staleApply = await controller.createApplyRun({
    planRunId: forgedId,
    expected: applyExpectedGuardFromPlanRun(
      (await store.getPlanRun(forgedId))!,
    ),
  });
  expect(staleApply.applyRun.status).toBe("failed");
  expect(staleApply.applyRun.diagnostics?.[0]?.message).toContain(
    "state_generation_mismatch",
  );
});

// --- fakes / helpers ---

function capturingRunner(captured: {
  plan?: OpenTofuPlanJob;
  apply?: OpenTofuApplyJob;
  destroy?: OpenTofuDestroyJob;
}): OpenTofuRunner {
  return {
    plan: (job) => {
      captured.plan = job;
      return Promise.resolve({
        planDigest: PLAN_DIGEST,
        planArtifact: planArtifact(),
        providerLockDigest: LOCK_DIGEST,
        requiredProviders: [CLOUDFLARE],
        providerInstallation: [CLOUDFLARE_MIRROR_EVIDENCE],
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
        providerLockDigest: LOCK_DIGEST,
        requiredProviders: [CLOUDFLARE],
        providerInstallation: [CLOUDFLARE_MIRROR_EVIDENCE],
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
        providerLockDigest: LOCK_DIGEST,
        requiredProviders: [CLOUDFLARE],
        providerInstallation: [CLOUDFLARE_MIRROR_EVIDENCE],
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
      const evidence = [];
      for (const provider of providers) {
        Object.assign(env, byProvider[provider] ?? {});
        evidence.push({
          provider,
          connectionId: "conn_shared",
          delivery: "provider_env" as const,
          rootOnly: false,
          temporary: true,
          ttlEnforced: true,
          phase: "plan" as const,
        });
      }
      return Promise.resolve(new PhaseMintBundle({ env }, [], evidence));
    },
    mintForPhase: () =>
      Promise.resolve(new PhaseMintBundle({ env: {} }, [], [])),
    mintForInstallationProviderEnvBindings: (
      _spaceId: string,
      entries: readonly InstallationProviderEnvBindingMintEntry[],
    ) => {
      const env: Record<string, string> = {};
      const evidence = [];
      for (const entry of entries) {
        const alias = entry.alias ? `_${entry.alias}` : "";
        env[`TF_VAR_cloudflare${alias}_api_token`] = SECRET_TOKEN;
        evidence.push({
          provider: CLOUDFLARE,
          connectionId: entry.connectionId,
          delivery: "generated_root_variable" as const,
          rootOnly: true,
          temporary: true,
          ttlEnforced: true,
          phase: "plan" as const,
        });
      }
      return Promise.resolve(new PhaseMintBundle({ env }, [], evidence));
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
