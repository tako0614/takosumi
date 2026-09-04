import { expect, test } from "bun:test";

import {
  OpenTofuController,
  type OpenTofuApplyJob,
  type OpenTofuApplyResult,
} from "../../../../core/domains/deploy-control/mod.ts";
import {
  type AcquireCapsuleLeaseInput,
  type CapsuleLease,
  CapsuleLeaseBusyError,
  type CapsuleCoordination,
  InMemoryCapsuleCoordination,
  type ReleaseCapsuleLeaseInput,
  type RenewCapsuleLeaseInput,
  capsuleLeaseScope,
  withCapsuleLease,
} from "../../../../core/domains/deploy-control/capsule_lease.ts";
import {
  InMemoryOpenTofuControlStore,
  planRunExecutionInputsDigestMaterial,
} from "../../../../core/domains/deploy-control/store.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";
import {
  FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
  fixtureExecutionEvidence,
  fixtureStateCommit,
  seedCapsuleModel,
} from "../../../helpers/deploy-control/model_fixture.ts";
import type { ApplyRun, PlanRun } from "@takosumi/internal/deploy-control-api";

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
 * Seeds the Workspace-direct Capsule model (spec §5) plus a succeeded PlanRun
 * and a queued ApplyRun, all bound to the same Capsule (= one
 * `capsule:{capsuleId}:{environment}` lease lane), so the apply
 * consumer takes that lease. The Capsule is seeded WITH a current
 * StateVersion so the update plan's current-StateVersion guard is well-formed and
 * the state generation (0) matches the plan's base generation.
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
  const moduleSource = {
    kind: "git" as const,
    url: source.url,
    commit: "abcdef0123456789abcdef0123456789abcdef01",
  };
  const inputs = {
    planRunId: ids.planRunId,
    variables: {},
    generatedRoot: {
      files: {
        "main.tf": 'module "child" { source = "./module" }',
      },
      moduleFiles: [{ path: "main.tf", text: "# fixture module" }],
    },
  } as const;
  const planRun: PlanRun = {
    id: ids.planRunId,
    workspaceId: capsule.workspaceId,
    capsuleId: ids.capsuleId,
    capsuleContext: {
      workspaceId: capsule.workspaceId,
      capsuleId: ids.capsuleId,
      environment,
    },
    capsuleCurrentStateVersionId: seedStateVersionId,
    source: moduleSource,
    sourceSnapshotId: snapshot.id,
    sourceDigest: "sha256:src",
    operation: "update",
    runnerProfileId: "opentofu-default",
    variablesDigest: await stableJsonDigest(inputs.variables),
    executionInputsDigest: await stableJsonDigest(
      planRunExecutionInputsDigestMaterial(inputs, undefined),
    ),
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
  await store.preparePlanRun({ run: planRun, inputs });
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
      variablesDigest: planRun.variablesDigest,
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
  coordination: CapsuleCoordination,
  runner: { apply: (job: OpenTofuApplyJob) => Promise<OpenTofuApplyResult> },
) {
  return new OpenTofuController({
    store,
    capsuleCoordination: coordination,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    now: () => 1,
    newId: ((): ((p: string) => string) => {
      let n = 0;
      return (p) => `${p}_${(n += 1).toString().padStart(4, "0")}`;
    })(),
    executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
    runner: {
      plan: () => Promise.reject(new Error("not used")),
      apply: async (job) => {
        const result = await runner.apply(job);
        return {
          ...result,
          rawOutputRef: job.rawOutputRef,
          executionEvidence:
            result.executionEvidence ?? fixtureExecutionEvidence(job, "apply"),
        };
      },
    },
  });
}

test("a second write run for the same environment is blocked while the lease is held", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { environment } = await seedApply(store, {
    capsuleId: "cap_shared01",
    planRunId: "plan_a",
    applyRunId: "apply_a",
  });
  // A second apply targeting the SAME capsule/environment.
  await seedApply(store, {
    capsuleId: "cap_shared01",
    planRunId: "plan_b",
    applyRunId: "apply_b",
  });

  const coordination = new InMemoryCapsuleCoordination();
  // Pre-hold the capsule lease as if a sibling consumer were running.
  const held = await coordination.acquireLease({
    scope: capsuleLeaseScope("cap_shared01", environment),
    holderId: "other-run",
    ttlMs: 60_000,
  });
  expect(held.acquired).toBe(true);

  const controller = controllerWith(store, coordination, {
    apply: () => Promise.resolve({}),
  });

  // The consumer cannot acquire the busy lease -> rethrows for redelivery.
  await expect(controller.runQueuedApply("apply_b")).rejects.toBeInstanceOf(
    CapsuleLeaseBusyError,
  );
  // The apply did not run; the run stays queued for the redelivery.
  expect((await store.getApplyRun("apply_b"))?.status).toBe("queued");
});

test("write runs for DIFFERENT environments are not blocked by each other's lease", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { environment: envOne } = await seedApply(store, {
    capsuleId: "cap_one00001",
    planRunId: "plan_one",
    applyRunId: "apply_one",
  });
  const coordination = new InMemoryCapsuleCoordination();
  // Hold a DIFFERENT capsule/environment's lease.
  await coordination.acquireLease({
    scope: capsuleLeaseScope("cap_two00001", envOne),
    holderId: "other-run",
    ttlMs: 60_000,
  });

  let applied = false;
  const controller = controllerWith(store, coordination, {
    apply: () => {
      applied = true;
      return Promise.resolve(fixtureStateCommit());
    },
  });

  const response = await controller.runQueuedApply("apply_one");
  expect(applied).toBe(true);
  expect(response.applyRun.status).toBe("succeeded");
});

test("the lease is released after a successful apply so the next run can acquire it", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { environment } = await seedApply(store, {
    capsuleId: "cap_seq00001",
    planRunId: "plan_seq",
    applyRunId: "apply_seq",
  });
  const coordination = new InMemoryCapsuleCoordination();
  const controller = controllerWith(store, coordination, {
    apply: () => Promise.resolve(fixtureStateCommit()),
  });

  const response = await controller.runQueuedApply("apply_seq");
  expect(response.applyRun.status).toBe("succeeded");

  // The lease was released in finally; a fresh holder can take it.
  const after = await coordination.acquireLease({
    scope: capsuleLeaseScope("cap_seq00001", environment),
    holderId: "next-run",
    ttlMs: 60_000,
  });
  expect(after.acquired).toBe(true);
});

test("ordinary leases keep legacy holder-token renew and release semantics", async () => {
  let referenceCalls = 0;
  const coordination = new InMemoryCapsuleCoordination({
    now: () => 1_000,
    newToken: () => "ordinary-generation",
    newReferenceId: () => {
      referenceCalls += 1;
      return "unexpected-reference";
    },
  });
  const input = {
    scope: capsuleLeaseScope("cap_ordinary", "production"),
    holderId: "ordinary-holder",
    ttlMs: 60_000,
  } as const;

  const lease = await coordination.acquireLease(input);
  expect(lease).toMatchObject({
    acquired: true,
    holderId: input.holderId,
    token: "ordinary-generation",
  });
  expect(lease.referenceId).toBeUndefined();
  expect(referenceCalls).toBe(0);

  const renewed = await coordination.renewLease({
    scope: input.scope,
    holderId: input.holderId,
    token: lease.token,
    ttlMs: input.ttlMs,
  });
  expect(renewed.acquired).toBe(true);
  expect(renewed.referenceId).toBeUndefined();
  expect(
    await coordination.releaseLease({
      scope: input.scope,
      holderId: input.holderId,
      token: lease.token,
    }),
  ).toBe(true);
});

test("an old exclusive DO lease waits for the same stable holder but never runs concurrently", async () => {
  const coordination = new LegacyLeaseCoordination();
  const input = {
    capsuleId: "cap_legacy_do",
    environment: "production",
    holderId: "capsule-rebind_exact-operation",
    ttlMs: 60_000,
    joinExistingHolder: true,
  } as const;
  let active = 0;
  let maxActive = 0;
  let finishLeader!: () => void;
  const leaderFinished = new Promise<void>((resolve) => {
    finishLeader = resolve;
  });
  let leaderEntered!: () => void;
  const leaderStarted = new Promise<void>((resolve) => {
    leaderEntered = resolve;
  });
  const leader = withCapsuleLease(coordination, input, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    leaderEntered();
    await leaderFinished;
    active -= 1;
    return "leader";
  });
  await leaderStarted;

  let followerRan = false;
  const follower = withCapsuleLease(coordination, input, async () => {
    followerRan = true;
    active += 1;
    maxActive = Math.max(maxActive, active);
    active -= 1;
    return "follower";
  });
  await coordination.sameHolderBusy;
  expect(followerRan).toBe(false);
  finishLeader();

  expect(await leader).toBe("leader");
  expect(await follower).toBe("follower");
  expect(maxActive).toBe(1);
  expect(coordination.acquireCalls).toBeGreaterThan(2);
});

test("a different holder remains immediately busy even when joining is requested", async () => {
  const coordination = new LegacyLeaseCoordination();
  const held = await coordination.acquireLease({
    scope: capsuleLeaseScope("cap_legacy_different", "production"),
    holderId: "incumbent",
    ttlMs: 60_000,
  });
  let ran = false;
  await expect(
    withCapsuleLease(
      coordination,
      {
        capsuleId: "cap_legacy_different",
        environment: "production",
        holderId: "different-holder",
        ttlMs: 60_000,
        joinExistingHolder: true,
      },
      async () => {
        ran = true;
      },
    ),
  ).rejects.toBeInstanceOf(CapsuleLeaseBusyError);
  expect(ran).toBe(false);
  expect(coordination.acquireCalls).toBe(2);
  expect(
    await coordination.releaseLease({
      scope: held.scope,
      holderId: held.holderId,
      token: held.token,
    }),
  ).toBe(true);
});

test("same-holder joining gives up after the bounded compatibility wait", async () => {
  const realNow = Date.now;
  const realSetTimeout = globalThis.setTimeout;
  let now = 1_000_000;
  Date.now = () => now;
  globalThis.setTimeout = ((callback: TimerHandler, milliseconds?: number) => {
    now += Number(milliseconds ?? 0);
    if (typeof callback === "function") callback();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof globalThis.setTimeout;
  try {
    const coordination = new LegacyLeaseCoordination();
    await coordination.acquireLease({
      scope: capsuleLeaseScope("cap_legacy_timeout", "production"),
      holderId: "same-holder",
      ttlMs: 60_000,
    });
    let ran = false;
    await expect(
      withCapsuleLease(
        coordination,
        {
          capsuleId: "cap_legacy_timeout",
          environment: "production",
          holderId: "same-holder",
          ttlMs: 60_000,
          joinExistingHolder: true,
        },
        async () => {
          ran = true;
        },
      ),
    ).rejects.toBeInstanceOf(CapsuleLeaseBusyError);
    expect(ran).toBe(false);
    expect(now - 1_000_000).toBeGreaterThanOrEqual(5_000);
    expect(now - 1_000_000).toBeLessThanOrEqual(5_250);
  } finally {
    Date.now = realNow;
    globalThis.setTimeout = realSetTimeout;
  }
});

test("an explicitly joinable same-holder lease keeps exclusion until every reference releases", async () => {
  let reference = 0;
  const coordination = new InMemoryCapsuleCoordination({
    now: () => 1_000,
    newToken: () => "generation-token",
    newReferenceId: () => `reference-${++reference}`,
  });
  const scope = capsuleLeaseScope("cap_joinable", "production");
  const acquire = () =>
    coordination.acquireLease({
      scope,
      holderId: "capsule-rebind_exact-operation",
      ttlMs: 60_000,
      joinExistingHolder: true,
    });

  const leader = await acquire();
  const follower = await acquire();
  expect(leader).toMatchObject({
    acquired: true,
    token: "generation-token",
    referenceId: "reference-1",
  });
  expect(follower).toMatchObject({
    acquired: true,
    token: "generation-token",
    referenceId: "reference-2",
  });

  expect(
    await coordination.releaseLease({
      scope,
      holderId: leader.holderId,
      token: leader.token,
      referenceId: leader.referenceId!,
    }),
  ).toBe(true);
  expect(
    await coordination.acquireLease({
      scope,
      holderId: "interface-materializer",
      ttlMs: 60_000,
      joinExistingHolder: true,
    }),
  ).toMatchObject({ acquired: false });
  expect(
    await coordination.releaseLease({
      scope,
      holderId: leader.holderId,
      token: leader.token,
      referenceId: leader.referenceId!,
    }),
  ).toBe(false);
  expect(
    await coordination.acquireLease({
      scope,
      holderId: "interface-materializer",
      ttlMs: 60_000,
    }),
  ).toMatchObject({ acquired: false });

  expect(
    await coordination.releaseLease({
      scope,
      holderId: follower.holderId,
      token: follower.token,
      referenceId: follower.referenceId!,
    }),
  ).toBe(true);
  expect(
    await coordination.acquireLease({
      scope,
      holderId: "interface-materializer",
      ttlMs: 60_000,
    }),
  ).toMatchObject({ acquired: true });
});

test("same-holder leases remain exclusive unless the stored generation opted into joining", async () => {
  const coordination = new InMemoryCapsuleCoordination({ now: () => 1_000 });
  const scope = capsuleLeaseScope("cap_exclusive", "production");
  const leader = await coordination.acquireLease({
    scope,
    holderId: "apply_same_holder",
    ttlMs: 60_000,
  });
  expect(leader.acquired).toBe(true);
  expect(
    await coordination.acquireLease({
      scope,
      holderId: leader.holderId,
      ttlMs: 60_000,
      joinExistingHolder: true,
    }),
  ).toMatchObject({ acquired: false });
});

test("a throwing joinable leader cannot release exclusion while its exact follower still runs", async () => {
  const coordination = new InMemoryCapsuleCoordination({ now: () => 1_000 });
  const input = {
    capsuleId: "cap_join_failure",
    environment: "production",
    holderId: "capsule-rebind_exact-operation",
    ttlMs: 60_000,
    joinExistingHolder: true,
  } as const;
  let followerEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    followerEntered = resolve;
  });
  let finishFollower!: () => void;
  const holdFollower = new Promise<void>((resolve) => {
    finishFollower = resolve;
  });

  const leader = withCapsuleLease(coordination, input, async () => {
    await entered;
    throw new Error("leader store failure");
  });
  const follower = withCapsuleLease(coordination, input, async () => {
    followerEntered();
    await holdFollower;
    return "replayed";
  });
  await expect(leader).rejects.toThrow("leader store failure");

  expect(
    await coordination.acquireLease({
      scope: capsuleLeaseScope(input.capsuleId, input.environment),
      holderId: "interface-materializer",
      ttlMs: 60_000,
    }),
  ).toMatchObject({ acquired: false });
  finishFollower();
  expect(await follower).toBe("replayed");
  expect(
    await coordination.acquireLease({
      scope: capsuleLeaseScope(input.capsuleId, input.environment),
      holderId: "interface-materializer",
      ttlMs: 60_000,
    }),
  ).toMatchObject({ acquired: true });
});

test("a same-operation join refreshes expiry and stale member releases cannot damage its successor", async () => {
  let now = 1_000;
  let token = 0;
  let reference = 0;
  const coordination = new InMemoryCapsuleCoordination({
    now: () => now,
    newToken: () => `generation-${++token}`,
    newReferenceId: () => `reference-${++reference}`,
  });
  const scope = capsuleLeaseScope("cap_join_expiry", "production");
  const leader = await coordination.acquireLease({
    scope,
    holderId: "capsule-rebind_exact-operation",
    ttlMs: 100,
    joinExistingHolder: true,
  });
  now = 1_050;
  const follower = await coordination.acquireLease({
    scope,
    holderId: leader.holderId,
    ttlMs: 200,
    joinExistingHolder: true,
  });
  expect(follower.expiresAt).toBe(new Date(1_250).toISOString());
  now = 1_150;
  expect(
    await coordination.acquireLease({
      scope,
      holderId: "interface-materializer",
      ttlMs: 100,
    }),
  ).toMatchObject({ acquired: false });

  now = 1_251;
  const successor = await coordination.acquireLease({
    scope,
    holderId: "interface-materializer",
    ttlMs: 100,
  });
  expect(successor).toMatchObject({ acquired: true, token: "generation-2" });
  for (const stale of [leader, follower]) {
    expect(
      await coordination.releaseLease({
        scope,
        holderId: stale.holderId,
        token: stale.token,
        referenceId: stale.referenceId!,
      }),
    ).toBe(false);
  }
  expect(
    await coordination.acquireLease({
      scope,
      holderId: "another-operation",
      ttlMs: 100,
    }),
  ).toMatchObject({ acquired: false, token: successor.token });
});

/** Minimal pre-reference-counting CoordinationObject behavior for skew tests. */
class LegacyLeaseCoordination implements CapsuleCoordination {
  #held: CapsuleLease | undefined;
  #resolveSameHolderBusy!: () => void;
  readonly sameHolderBusy = new Promise<void>((resolve) => {
    this.#resolveSameHolderBusy = resolve;
  });
  acquireCalls = 0;

  acquireLease(input: AcquireCapsuleLeaseInput): Promise<CapsuleLease> {
    this.acquireCalls += 1;
    if (this.#held) {
      if (this.#held.holderId === input.holderId) {
        this.#resolveSameHolderBusy();
      }
      return Promise.resolve({ ...this.#held, acquired: false });
    }
    this.#held = {
      scope: input.scope,
      holderId: input.holderId,
      token: "legacy-generation",
      acquired: true,
      expiresAt: new Date(Date.now() + input.ttlMs).toISOString(),
    };
    return Promise.resolve(this.#held);
  }

  renewLease(input: RenewCapsuleLeaseInput): Promise<CapsuleLease> {
    if (
      !this.#held ||
      this.#held.holderId !== input.holderId ||
      this.#held.token !== input.token
    ) {
      return Promise.resolve({
        scope: input.scope,
        holderId: input.holderId,
        token: input.token,
        acquired: false,
        expiresAt: new Date(0).toISOString(),
      });
    }
    this.#held = {
      ...this.#held,
      expiresAt: new Date(Date.now() + input.ttlMs).toISOString(),
    };
    return Promise.resolve(this.#held);
  }

  releaseLease(input: ReleaseCapsuleLeaseInput): Promise<boolean> {
    if (
      !this.#held ||
      this.#held.holderId !== input.holderId ||
      this.#held.token !== input.token
    ) {
      return Promise.resolve(false);
    }
    this.#held = undefined;
    return Promise.resolve(true);
  }
}
