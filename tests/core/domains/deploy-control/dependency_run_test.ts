/**
 * Dependency variable_injection + DependencySnapshot integration tests (Core
 * Specification §15 / §17 / invariant 9).
 *
 * A producer Capsule applies (gen 1) and records an Output whose
 * workspaceOutputs carry `base_domain`. A consumer Capsule declares a
 * `variable_injection` Dependency on that output; its plan injects `base_domain`
 * into the runner variables and pins a DependencySnapshot (digests only, no
 * values in diagnostics). The §19 Run projects the dependencySnapshotId.
 *
 * Then the security behavior: in a PRODUCTION consumer (strict mode), the
 * consumer's apply fails `dependency_snapshot_stale` once the producer's state
 * generation moves after plan; in a PREVIEW consumer (pinned mode) the apply
 * succeeds despite the producer moving, applying the frozen values.
 */

import { expect, test } from "bun:test";
import type {
  OpenTofuApplyJob,
  OpenTofuPlanJob,
  OpenTofuRunner,
} from "../../../../core/domains/deploy-control/mod.ts";
import {
  applyExpectedGuardFromPlanRun,
  type DependencyValueSealer,
  OpenTofuController,
} from "../../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import type { OpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { DependenciesService } from "../../../../core/domains/dependencies/mod.ts";
import type { SensitiveOutputResolver } from "../../../../core/domains/output-shares/mod.ts";
import type { JsonValue } from "takosumi-contract";
import {
  CredentialBundle,
  PhaseMintBundle,
} from "../../../../core/adapters/vault/mod.ts";
import {
  FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE,
  FIXTURE_CLOUDFLARE_PROVIDER,
  type SeedCapsuleModelOptions,
  seedCapsuleModel,
  seedProviderConnections,
} from "../../../helpers/deploy-control/model_fixture.ts";
import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";

const PLAN_DIGEST =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const LOCK_DIGEST =
  "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

function deterministicIds(): (prefix: string) => string {
  let next = 1;
  return (prefix) => `${prefix}_${String(next++).padStart(4, "0")}`;
}

function sequenceNow(start: number): () => number {
  let value = start;
  return () => value++;
}

interface RecordingRunner extends OpenTofuRunner {
  readonly planJobs: OpenTofuPlanJob[];
  readonly applyJobs: OpenTofuApplyJob[];
}

/**
 * A runner whose apply emits `base_domain` (a generic non-sensitive output that
 * lands in workspaceOutputs) so a downstream consumer can inject it. Records every
 * plan/apply job so the test can assert the injected variables.
 */
function recordingRunner(): RecordingRunner {
  const planJobs: OpenTofuPlanJob[] = [];
  const applyJobs: OpenTofuApplyJob[] = [];
  return {
    planJobs,
    applyJobs,
    plan: (job) => {
      planJobs.push(job);
      return Promise.resolve({
        planDigest: PLAN_DIGEST,
        planArtifact: {
          kind: "runner-local",
          ref: "runner-local://plan/tfplan",
          digest: PLAN_DIGEST,
          contentType: "application/vnd.opentofu.plan",
        },
        providerLockDigest: LOCK_DIGEST,
        requiredProviders: [FIXTURE_CLOUDFLARE_PROVIDER],
        providerInstallation: [FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE],
        // A delete/replace change so the §25 action policy flags the plan
        // requiresApproval -> a production plan parks waiting_approval, keeping
        // the `approveRun` calls in the strict-staleness test valid. Approval is
        // no longer gated by the environment alone. (Preview plans also require
        // approval now, but the preview tests apply directly — apply is not
        // approval-gated.)
        planResourceChanges: [
          {
            address: "module.child.cloudflare_workers_script.this",
            type: "cloudflare_workers_script",
            actions: ["delete", "create"],
          },
        ],
      });
    },
    apply: (job) => {
      applyJobs.push(job);
      return Promise.resolve({
        outputs: {
          base_domain: { sensitive: false, value: "shota.example.com" },
        } as never,
        stateDigest:
          "sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
      });
    },
    destroy: () => Promise.resolve({}),
  };
}

function sensitiveOutputRunner(): RecordingRunner {
  const runner = recordingRunner();
  return {
    ...runner,
    apply: (job) => {
      runner.applyJobs.push(job);
      return Promise.resolve({
        outputs: {
          admin_token: { sensitive: true, value: "super-secret-token" },
        } as never,
        stateDigest:
          "sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
      });
    },
  };
}

function staticSensitiveResolver(): SensitiveOutputResolver {
  return {
    resolve: (input) =>
      Promise.resolve(
        input.outputName === "admin_token"
          ? { value: "super-secret-token", sensitive: true }
          : undefined,
      ),
  };
}

/**
 * In-test stand-in for the worker's at-rest value sealer. It does NOT exercise
 * the real AES-GCM envelope (that round-trip + tamper behavior is covered in
 * worker/src/dependency_value_sealer_test.ts); it base64-wraps a JSON blob plus
 * a content digest so the controller integration tests stay deterministic. open()
 * verifies the digest, so a mutated ciphertext fails closed exactly like the
 * real sealer's AES-GCM auth tag.
 */
function fakeValueSealer(): DependencyValueSealer {
  const digest = (text: string): string => {
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) {
      hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    }
    return `fake:${hash.toString(16)}`;
  };
  return {
    seal: (values) => {
      const json = JSON.stringify(values);
      return Promise.resolve({
        ciphertext: btoa(json),
        contentDigest: digest(json),
        names: Object.keys(values),
      });
    },
    open: (sealed) => {
      let json: string;
      try {
        json = atob(sealed.ciphertext);
      } catch {
        throw new Error(
          "sealed dependency values ciphertext is not valid base64",
        );
      }
      if (digest(json) !== sealed.contentDigest) {
        throw new Error("sealed dependency values content digest mismatch");
      }
      return Promise.resolve(JSON.parse(json) as Record<string, JsonValue>);
    },
  };
}

function controllerWith(
  store: OpenTofuControlStore,
  runner: OpenTofuRunner,
  options: {
    readonly sensitiveOutputResolver?: SensitiveOutputResolver;
    readonly dependencyValueSealer?: DependencyValueSealer;
  } = {},
): OpenTofuController {
  return new OpenTofuController({
    store,
    runner,
    vault: fakeProviderVault() as never,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    now: sequenceNow(1),
    newId: deterministicIds(),
    ...(options.sensitiveOutputResolver
      ? { sensitiveOutputResolver: options.sensitiveOutputResolver }
      : {}),
    ...(options.dependencyValueSealer
      ? { dependencyValueSealer: options.dependencyValueSealer }
      : {}),
  });
}

function fakeProviderVault() {
  const sharedEvidence = {
    provider: FIXTURE_CLOUDFLARE_PROVIDER,
    connectionId: "conn_cf",
    temporary: true,
    ttlEnforced: true,
    phase: "plan" as const,
  };
  return {
    register: () => Promise.reject(new Error("not used")),
    test: () => Promise.resolve({ status: "verified" }),
    revoke: () => Promise.resolve(true),
    mint: () =>
      Promise.resolve(
        new CredentialBundle(
          {
            CLOUDFLARE_API_TOKEN: "fixture-provider-token",
          },
          [],
          [sharedEvidence],
        ),
      ),
    mintForCapsuleProviderBindings: () =>
      Promise.resolve(
        new PhaseMintBundle(
          {
            env: {
              CLOUDFLARE_API_TOKEN: "fixture-provider-token",
            },
          },
          [],
          [sharedEvidence],
        ),
      ),
  };
}

async function seedRunnableCapsuleModel(
  store: OpenTofuControlStore,
  options: SeedCapsuleModelOptions,
) {
  const seeded = await seedCapsuleModel(store, {
    workspaceId: options.workspaceId ?? "ws_test001",
    ...options,
  });
  await seedProviderConnections(store, seeded.capsule);
  return seeded;
}

/**
 * Seeds a producer + consumer in the same Workspace (distinct sources/snapshots) at
 * the given environment, plus a `variable_injection` Dependency from producer's
 * `base_domain` to the consumer's `base_domain` input.
 */
async function seedGraph(
  store: OpenTofuControlStore,
  environment: string,
): Promise<{ producer: string; consumer: string }> {
  const producer = await seedCapsuleModel(store, {
    workspaceId: "ws_test001",
    environment,
    sourceId: "src_producer",
    snapshotId: "snap_producer",
    installConfigId: "cfg_producer",
    capsuleId: "cap_producer1",
    name: "producer",
    installConfig: {
      outputAllowlist: {
        base_domain: { from: "base_domain", type: "hostname", required: true },
      },
    },
  });
  await seedProviderConnections(store, producer.capsule);
  const consumer = await seedCapsuleModel(store, {
    workspaceId: "ws_test001",
    environment,
    sourceId: "src_consumer",
    snapshotId: "snap_consumer",
    installConfigId: "cfg_consumer",
    capsuleId: "cap_consumer1",
    name: "consumer",
  });
  await seedProviderConnections(store, consumer.capsule);
  const deps = new DependenciesService({
    store,
    newId: (prefix) => `${prefix}_edge0001`,
    now: () => "2026-06-06T00:00:00.000Z",
  });
  await deps.createDependency({
    workspaceId: "ws_test001",
    producerCapsuleId: "cap_producer1",
    consumerCapsuleId: "cap_consumer1",
    mode: "variable_injection",
    visibility: "workspace",
    outputs: {
      base_domain: { from: "base_domain", to: "base_domain", required: true },
    },
  });
  return { producer: "cap_producer1", consumer: "cap_consumer1" };
}

test("consumer plan injects the producer output and pins a DependencySnapshot", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  const { consumer } = await seedGraph(store, "preview");
  const controller = controllerWith(store, runner);

  // Producer applies first -> gen 1 + Output with base_domain.
  const producerPlan = await controller.createCapsulePlan("cap_producer1");
  const producerApply = await controller.createApplyRun({
    planRunId: producerPlan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(producerPlan.planRun),
  });
  const producer = (await controller.getCapsule("cap_producer1")).capsule;
  expect(producer.currentStateGeneration).toEqual(1);
  expect(producerApply.applyRun.outputId).toBeDefined();

  // Consumer plan: injects base_domain into the runner variables and pins a snapshot.
  const consumerPlan = await controller.createCapsulePlan(consumer);
  expect(consumerPlan.planRun.dependencySnapshotId).toBeDefined();

  // The runner plan job for the consumer carries the injected variable.
  const consumerPlanJob = runner.planJobs.find(
    (job) => job.planRun.capsuleId === consumer,
  );
  expect(consumerPlanJob?.variables.base_domain).toEqual("shota.example.com");

  // The DependencySnapshot pins the producer state generation + digests.
  const snapshot = await store.getDependencySnapshot(
    consumerPlan.planRun.dependencySnapshotId!,
  );
  expect(snapshot?.mode).toEqual("pinned"); // preview consumer
  expect(snapshot?.dependencies).toHaveLength(1);
  const entry = snapshot!.dependencies[0]!;
  expect(entry.producerCapsuleId).toEqual("cap_producer1");
  expect(entry.producerStateGeneration).toEqual(1);
  expect(entry.producerOutputId).toEqual(producerApply.applyRun.outputId);
  expect(entry.values).toEqual({ base_domain: "shota.example.com" });
  expect(entry.valuesDigest).toEqual(
    await stableJsonDigest({ base_domain: "shota.example.com" }),
  );

  // The §19 Run projects the dependencySnapshotId.
  const run = await controller.getRun(consumerPlan.planRun.id);
  expect(run.dependencySnapshotId).toEqual(
    consumerPlan.planRun.dependencySnapshotId,
  );
});

test("strict consumer apply fails dependency_snapshot_stale after the producer moves", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  await seedGraph(store, "production");
  const controller = controllerWith(store, runner);

  // Producer applies -> gen 1. The plan's delete/replace change flags
  // requiresApproval so it parks waiting_approval; approve BEFORE the apply
  // (apply marks the plan applied, clearing the gate).
  const producerPlan = await controller.createCapsulePlan("cap_producer1");
  await controller.approveRun(producerPlan.planRun.id);
  await controller.createApplyRun({
    planRunId: producerPlan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(producerPlan.planRun),
  });

  // Consumer plan (production -> strict snapshot).
  const consumerPlan = await controller.createCapsulePlan("cap_consumer1");
  const snapshot = await store.getDependencySnapshot(
    consumerPlan.planRun.dependencySnapshotId!,
  );
  expect(snapshot?.mode).toEqual("strict");

  // Producer re-applies -> gen 2 (its state generation moves under the snapshot).
  const producerPlan2 = await controller.createCapsulePlan("cap_producer1");
  await controller.approveRun(producerPlan2.planRun.id);
  await controller.createApplyRun({
    planRunId: producerPlan2.planRun.id,
    expected: applyExpectedGuardFromPlanRun(producerPlan2.planRun),
  });
  expect(
    (await controller.getCapsule("cap_producer1")).capsule
      .currentStateGeneration,
  ).toEqual(2);

  // The consumer's strict apply now fails dependency_snapshot_stale.
  await controller.approveRun(consumerPlan.planRun.id);
  const staleApply = await controller.createApplyRun({
    planRunId: consumerPlan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(consumerPlan.planRun),
  });
  expect(staleApply.applyRun.status).toBe("failed");
  expect(staleApply.applyRun.diagnostics?.[0]?.message).toContain(
    "dependency_snapshot_stale",
  );
});

test("pinned consumer apply succeeds despite the producer moving", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  await seedGraph(store, "preview");
  const controller = controllerWith(store, runner);

  // Producer applies -> gen 1 (preview: no approval gate).
  const producerPlan = await controller.createCapsulePlan("cap_producer1");
  await controller.createApplyRun({
    planRunId: producerPlan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(producerPlan.planRun),
  });

  // Consumer plan (preview -> pinned snapshot).
  const consumerPlan = await controller.createCapsulePlan("cap_consumer1");
  const snapshot = await store.getDependencySnapshot(
    consumerPlan.planRun.dependencySnapshotId!,
  );
  expect(snapshot?.mode).toEqual("pinned");

  // Producer re-applies -> gen 2.
  const producerPlan2 = await controller.createCapsulePlan("cap_producer1");
  await controller.createApplyRun({
    planRunId: producerPlan2.planRun.id,
    expected: applyExpectedGuardFromPlanRun(producerPlan2.planRun),
  });

  // The consumer's pinned apply tolerates the producer movement and succeeds,
  // applying the values frozen at plan time.
  const consumerApply = await controller.createApplyRun({
    planRunId: consumerPlan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(consumerPlan.planRun),
  });
  expect(consumerApply.applyRun.status).toEqual("succeeded");
  const consumerApplyRun = await controller.getRun(consumerApply.applyRun.id);
  expect(consumerApplyRun.dependencySnapshotId).toEqual(
    consumerPlan.planRun.dependencySnapshotId,
  );
});

test("a required dependency with no producer Output is dependency_outputs_unavailable", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  await seedGraph(store, "preview");
  const controller = controllerWith(store, runner);

  // The producer has NOT applied yet, so it has no Output. The consumer
  // plan's required mapping cannot be satisfied.
  await expect(controller.createCapsulePlan("cap_consumer1")).rejects.toThrow(
    /dependency_outputs_unavailable/,
  );
});

test("plan diagnostics never carry injected dependency values", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  await seedGraph(store, "preview");
  const controller = controllerWith(store, runner);

  const producerPlan = await controller.createCapsulePlan("cap_producer1");
  await controller.createApplyRun({
    planRunId: producerPlan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(producerPlan.planRun),
  });
  const consumerPlan = await controller.createCapsulePlan("cap_consumer1");

  // The public PlanRun keeps only digests: the injected value must not appear in
  // the variablesDigest field name, audit events, or anywhere on the public run.
  const serialized = JSON.stringify(consumerPlan.planRun);
  expect(serialized).not.toContain("shota.example.com");
});

// ---------------------------------------------------------------------------
// published_output (spec §18): cross-Workspace output consumption via an OutputShare.
// ---------------------------------------------------------------------------

/**
 * Seeds a producer in `space_producer` + a consumer in `space_consumer`, an
 * ACTIVE OutputShare from the producer.s Workspace to the consumer.s Workspace covering
 * `base_domain`, and a `published_output` cross_space Dependency mapping the
 * SHARED name `base_domain` into the consumer's `base_domain` input.
 */
async function seedCrossSpaceGraph(
  store: OpenTofuControlStore,
  consumerEnvironment: string,
): Promise<{ producer: string; consumer: string }> {
  const producer = await seedCapsuleModel(store, {
    workspaceId: "ws_producer",
    environment: "production",
    sourceId: "src_producer",
    snapshotId: "snap_producer",
    installConfigId: "cfg_producer",
    capsuleId: "cap_producer1",
    name: "producer",
    installConfig: {
      outputAllowlist: {
        base_domain: { from: "base_domain", type: "hostname", required: true },
      },
    },
  });
  await seedProviderConnections(store, producer.capsule);
  const consumer = await seedCapsuleModel(store, {
    workspaceId: "ws_consumer",
    environment: consumerEnvironment,
    sourceId: "src_consumer",
    snapshotId: "snap_consumer",
    installConfigId: "cfg_consumer",
    capsuleId: "cap_consumer1",
    name: "consumer",
  });
  await seedProviderConnections(store, consumer.capsule);
  const deps = new DependenciesService({
    store,
    newId: (prefix) => `${prefix}_edge0001`,
    now: () => "2026-06-06T00:00:00.000Z",
  });
  // Grant first (createDependency for published_output requires an active share).
  await store.putOutputShare({
    id: "oshare_1",
    fromWorkspaceId: "ws_producer",
    toWorkspaceId: "ws_consumer",
    producerCapsuleId: "cap_producer1",
    outputs: [{ name: "base_domain", sensitive: false }],
    status: "active",
    createdAt: "2026-06-06T00:00:00.000Z",
  });
  await deps.createDependency({
    workspaceId: "ws_consumer",
    producerCapsuleId: "cap_producer1",
    consumerCapsuleId: "cap_consumer1",
    mode: "published_output",
    visibility: "cross_workspace",
    outputs: {
      base_domain: { from: "base_domain", to: "base_domain", required: true },
    },
  });
  return { producer: "cap_producer1", consumer: "cap_consumer1" };
}

test("cross-Workspace published_output injects the shared output and pins a snapshot", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  const { consumer } = await seedCrossSpaceGraph(store, "preview");
  const controller = controllerWith(store, runner);

  // Producer applies (in space_producer) -> gen 1 + Output base_domain.
  const producerPlan = await controller.createCapsulePlan("cap_producer1");
  await controller.createApplyRun({
    planRunId: producerPlan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(producerPlan.planRun),
  });

  // Consumer plan: the published_output edge injects base_domain across the
  // Workspace boundary (authorized by the active share) and pins a snapshot.
  const consumerPlan = await controller.createCapsulePlan(consumer);
  expect(consumerPlan.planRun.dependencySnapshotId).toBeDefined();
  const consumerPlanJob = runner.planJobs.find(
    (job) => job.planRun.capsuleId === consumer,
  );
  expect(consumerPlanJob?.variables.base_domain).toEqual("shota.example.com");

  // The consumer applies successfully using the shared value.
  const consumerApply = await controller.createApplyRun({
    planRunId: consumerPlan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(consumerPlan.planRun),
  });
  expect(consumerApply.applyRun.status).toEqual("succeeded");
});

test("revoking the share between plan and apply fails the consumer apply output_share_revoked", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  const { consumer } = await seedCrossSpaceGraph(store, "preview");
  const controller = controllerWith(store, runner);

  const producerPlan = await controller.createCapsulePlan("cap_producer1");
  await controller.createApplyRun({
    planRunId: producerPlan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(producerPlan.planRun),
  });

  // Consumer plan succeeds while the share is active.
  const consumerPlan = await controller.createCapsulePlan(consumer);
  expect(consumerPlan.planRun.dependencySnapshotId).toBeDefined();

  // Revoke the share AFTER plan, BEFORE apply.
  const share = await store.getOutputShare("oshare_1");
  await store.putOutputShare({
    ...share!,
    status: "revoked",
    revokedAt: "2026-06-06T02:00:00.000Z",
  });

  // The consumer's apply now fails: the published_output edge re-verifies the
  // share at apply, and a revoked grant is output_share_revoked.
  const revokedApply = await controller.createApplyRun({
    planRunId: consumerPlan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(consumerPlan.planRun),
  });
  expect(revokedApply.applyRun.status).toBe("failed");
  expect(revokedApply.applyRun.diagnostics?.[0]?.message).toContain(
    "output_share_revoked",
  );
});

test("pending share does not authorize cross-Workspace published_output planning", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  const { consumer } = await seedCrossSpaceGraph(store, "preview");
  const controller = controllerWith(store, runner);

  const share = await store.getOutputShare("oshare_1");
  await store.putOutputShare({ ...share!, status: "pending" });

  const producerPlan = await controller.createCapsulePlan("cap_producer1");
  await controller.createApplyRun({
    planRunId: producerPlan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(producerPlan.planRun),
  });

  await expect(controller.createCapsulePlan(consumer)).rejects.toThrow(
    /output_share_revoked/,
  );
});

test("sensitive published_output injects only through explicit share resolver and never leaks on public run/activity", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = sensitiveOutputRunner();
  const { consumer } = await seedCrossSpaceGraph(store, "preview");
  const producerConfig = await store.getInstallConfig("cfg_producer");
  await store.putInstallConfig({ ...producerConfig!, outputAllowlist: {} });
  const share = await store.getOutputShare("oshare_1");
  await store.putOutputShare({
    ...share!,
    outputs: [{ name: "admin_token", sensitive: true }],
  });
  const dependency = await store.getDependency("dep_edge0001");
  await store.putDependency({
    ...dependency!,
    outputs: {
      admin_token: {
        from: "admin_token",
        to: "admin_token",
        required: true,
      },
    },
  });
  const controller = controllerWith(store, runner, {
    sensitiveOutputResolver: staticSensitiveResolver(),
    dependencyValueSealer: fakeValueSealer(),
  });

  const producerPlan = await controller.createCapsulePlan("cap_producer1");
  await controller.createApplyRun({
    planRunId: producerPlan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(producerPlan.planRun),
  });
  const producer = (await controller.getCapsule("cap_producer1")).capsule;
  const output = await store.getOutput(producer.currentOutputId!);
  expect(output?.workspaceOutputs).not.toHaveProperty("admin_token");
  expect(output?.publicOutputs).not.toHaveProperty("admin_token");

  const consumerPlan = await controller.createCapsulePlan(consumer);
  const consumerPlanJob = runner.planJobs.find(
    (job) => job.planRun.capsuleId === consumer,
  );
  expect(consumerPlanJob?.variables.admin_token).toEqual("super-secret-token");
  expect(JSON.stringify(consumerPlan.planRun)).not.toContain(
    "super-secret-token",
  );
  expect(
    JSON.stringify(await store.listActivityEvents("ws_consumer")),
  ).not.toContain("super-secret-token");

  // At-rest: the persisted DependencySnapshot row must NOT carry the sensitive
  // value in cleartext anywhere (it lives sealed in `sealedValues`).
  const snap = await store.getDependencySnapshot(
    consumerPlan.planRun.dependencySnapshotId!,
  );
  expect(JSON.stringify(snap)).not.toContain("super-secret-token");
  const sealedEntry = snap!.dependencies[0];
  expect(sealedEntry.values).not.toHaveProperty("admin_token");
  expect(sealedEntry.sealedValues?.names).toEqual(["admin_token"]);
  expect(sealedEntry.sealedValues?.ciphertext).toBeTruthy();

  // At-rest residual: the runs_inputs sidecar ALSO carries the injected value —
  // both in `variables` and baked as a literal into the generated `main.tf` — so
  // a SUCCEEDED generated-root plan that retains the sidecar must NOT round-trip
  // the secret in cleartext (spec §11 / §18). The whole payload is sealed.
  const sidecar = await store.getPlanRunInputs(consumerPlan.planRun.id);
  expect(sidecar).toBeTruthy();
  expect(JSON.stringify(sidecar)).not.toContain("super-secret-token");
  expect(sidecar?.sealed?.ciphertext).toBeTruthy();
  expect(sidecar?.variables).not.toHaveProperty("admin_token");
  // The consumer apply still succeeds: the sealed value round-trips at verify.
  const consumerApply = await controller.createApplyRun({
    planRunId: consumerPlan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(consumerPlan.planRun),
  });
  expect(consumerApply.applyRun.status).toBe("succeeded");
});

test("sensitive published_output fails closed when no value sealer is configured", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = sensitiveOutputRunner();
  const { consumer } = await seedCrossSpaceGraph(store, "preview");
  const producerConfig = await store.getInstallConfig("cfg_producer");
  await store.putInstallConfig({ ...producerConfig!, outputAllowlist: {} });
  const share = await store.getOutputShare("oshare_1");
  await store.putOutputShare({
    ...share!,
    outputs: [{ name: "admin_token", sensitive: true }],
  });
  const dependency = await store.getDependency("dep_edge0001");
  await store.putDependency({
    ...dependency!,
    outputs: {
      admin_token: { from: "admin_token", to: "admin_token", required: true },
    },
  });
  // Resolver present (so the value resolves) but NO sealer: cleartext would leak,
  // so the plan must fail closed rather than persist it.
  const controller = controllerWith(store, runner, {
    sensitiveOutputResolver: staticSensitiveResolver(),
  });
  const producerPlan = await controller.createCapsulePlan("cap_producer1");
  await controller.createApplyRun({
    planRunId: producerPlan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(producerPlan.planRun),
  });
  await expect(controller.createCapsulePlan(consumer)).rejects.toThrow(
    /dependency_value_sealer_unavailable/,
  );
});

test("tampered sealed dependency values fail the apply closed", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = sensitiveOutputRunner();
  const { consumer } = await seedCrossSpaceGraph(store, "preview");
  const producerConfig = await store.getInstallConfig("cfg_producer");
  await store.putInstallConfig({ ...producerConfig!, outputAllowlist: {} });
  const share = await store.getOutputShare("oshare_1");
  await store.putOutputShare({
    ...share!,
    outputs: [{ name: "admin_token", sensitive: true }],
  });
  const dependency = await store.getDependency("dep_edge0001");
  await store.putDependency({
    ...dependency!,
    outputs: {
      admin_token: { from: "admin_token", to: "admin_token", required: true },
    },
  });
  const controller = controllerWith(store, runner, {
    sensitiveOutputResolver: staticSensitiveResolver(),
    dependencyValueSealer: fakeValueSealer(),
  });
  const producerPlan = await controller.createCapsulePlan("cap_producer1");
  await controller.createApplyRun({
    planRunId: producerPlan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(producerPlan.planRun),
  });
  const consumerPlan = await controller.createCapsulePlan(consumer);
  // Tamper the persisted sealed ciphertext: the sealer's open() must fail closed
  // (AES-GCM auth-tag / content-digest analogue), and the apply must reject.
  const snap = await store.getDependencySnapshot(
    consumerPlan.planRun.dependencySnapshotId!,
  );
  const entry = snap!.dependencies[0];
  await store.putDependencySnapshot({
    ...snap!,
    dependencies: [
      {
        ...entry,
        sealedValues: {
          ...entry.sealedValues!,
          ciphertext: `${entry.sealedValues!.ciphertext}TAMPER`,
        },
      },
    ],
  });
  const tamperedApply = await controller.createApplyRun({
    planRunId: consumerPlan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(consumerPlan.planRun),
  });
  // Fail-closed: the apply must NOT succeed once the sealed values are tampered.
  expect(tamperedApply.applyRun.status).not.toBe("succeeded");
  expect(tamperedApply.applyRun.status).toBe("failed");
  // And the failure comes from opening the sealed blob (the AES-GCM auth-tag /
  // content-digest layer rejects the tampered ciphertext before the values are
  // ever recovered), not from some unrelated guard.
  expect(
    JSON.stringify(tamperedApply.applyRun.diagnostics).toLowerCase(),
  ).toContain("digest mismatch");
});

test("tampered sealed runs_inputs sidecar fails the apply closed", async () => {
  // Sibling of the dependency-snapshot tamper test above, but targeting the
  // OTHER at-rest sensitive surface: the runs_inputs sidecar. A sensitive
  // dependency value flows into `variables` AND is baked as a literal into the
  // generated root, so the controller seals the WHOLE sidecar payload at rest
  // (spec §11 / §18) and unseals it transparently at apply dispatch via
  // #getPlanRunInputs. Here we leave the DependencySnapshot intact and tamper
  // ONLY the persisted `runs_inputs.sealed.ciphertext`; the apply must fail
  // closed at the sidecar open() (the same AES-GCM auth-tag / content-digest
  // layer) before any plaintext is recovered or dispatched.
  const store = new InMemoryOpenTofuControlStore();
  const runner = sensitiveOutputRunner();
  const { consumer } = await seedCrossSpaceGraph(store, "preview");
  const producerConfig = await store.getInstallConfig("cfg_producer");
  await store.putInstallConfig({ ...producerConfig!, outputAllowlist: {} });
  const share = await store.getOutputShare("oshare_1");
  await store.putOutputShare({
    ...share!,
    outputs: [{ name: "admin_token", sensitive: true }],
  });
  const dependency = await store.getDependency("dep_edge0001");
  await store.putDependency({
    ...dependency!,
    outputs: {
      admin_token: { from: "admin_token", to: "admin_token", required: true },
    },
  });
  const controller = controllerWith(store, runner, {
    sensitiveOutputResolver: staticSensitiveResolver(),
    dependencyValueSealer: fakeValueSealer(),
  });
  const producerPlan = await controller.createCapsulePlan("cap_producer1");
  await controller.createApplyRun({
    planRunId: producerPlan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(producerPlan.planRun),
  });
  const consumerPlan = await controller.createCapsulePlan(consumer);

  // The retained sidecar of the succeeded generated-root plan is sealed: confirm
  // the at-rest precondition, then tamper ONLY its ciphertext.
  const sidecar = await store.getPlanRunInputs(consumerPlan.planRun.id);
  expect(sidecar?.sealed?.ciphertext).toBeTruthy();
  await store.putPlanRunInputs({
    planRunId: consumerPlan.planRun.id,
    variables: {},
    sealed: {
      ...sidecar!.sealed!,
      ciphertext: `${sidecar!.sealed!.ciphertext}TAMPER`,
    },
  });

  // Fail-closed: the sidecar is unsealed at apply DISPATCH (#getPlanRunInputs,
  // before any tofu runs), so a tampered blob throws at the content-digest /
  // auth-tag layer and the apply dispatch rejects — no cleartext is ever
  // recovered or handed to the runner. (This differs from the dependency-snapshot
  // tamper above, which fails inside the runner execution and records a `failed`
  // run; the sidecar guard fires earlier, at dispatch.)
  await expect(
    controller.createApplyRun({
      planRunId: consumerPlan.planRun.id,
      expected: applyExpectedGuardFromPlanRun(consumerPlan.planRun),
    }),
  ).rejects.toThrow(/ciphertext is not valid base64|digest mismatch/i);
  // The apply never reached a successful generation.
  const consumerInstallation = (await controller.getCapsule(consumer)).capsule;
  expect(consumerInstallation.currentStateGeneration ?? 0).toBe(0);
  // The runner was never handed the secret on the tampered dispatch.
  expect(JSON.stringify(runner.applyJobs)).not.toContain("super-secret-token");
});

test("sensitive published_output fails closed when controller has no resolver", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = sensitiveOutputRunner();
  const { consumer } = await seedCrossSpaceGraph(store, "preview");
  const producerConfig = await store.getInstallConfig("cfg_producer");
  await store.putInstallConfig({ ...producerConfig!, outputAllowlist: {} });
  const share = await store.getOutputShare("oshare_1");
  await store.putOutputShare({
    ...share!,
    outputs: [{ name: "admin_token", sensitive: true }],
  });
  const dependency = await store.getDependency("dep_edge0001");
  await store.putDependency({
    ...dependency!,
    outputs: {
      admin_token: {
        from: "admin_token",
        to: "admin_token",
        required: true,
      },
    },
  });
  const controller = controllerWith(store, runner);

  const producerPlan = await controller.createCapsulePlan("cap_producer1");
  await controller.createApplyRun({
    planRunId: producerPlan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(producerPlan.planRun),
  });

  await expect(controller.createCapsulePlan(consumer)).rejects.toThrow(
    /sensitive_output_resolver_unavailable/,
  );
});

// ---------------------------------------------------------------------------
// remote_state (spec §15): producer state materialized via the depStates dispatch.
// ---------------------------------------------------------------------------

test("remote_state dispatch carries depStates from the producer's pinned StateVersion", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  // Same-Workspace producer + consumer with a remote_state edge (empty mapping).
  await seedRunnableCapsuleModel(store, {
    environment: "preview",
    sourceId: "src_producer",
    snapshotId: "snap_producer",
    installConfigId: "cfg_producer",
    capsuleId: "cap_producer1",
    name: "producer",
  });
  await seedRunnableCapsuleModel(store, {
    environment: "preview",
    sourceId: "src_consumer",
    snapshotId: "snap_consumer",
    installConfigId: "cfg_consumer",
    capsuleId: "cap_consumer1",
    name: "consumer",
  });
  const deps = new DependenciesService({
    store,
    newId: (prefix) => `${prefix}_edge0001`,
    now: () => "2026-06-06T00:00:00.000Z",
  });
  await deps.createDependency({
    workspaceId: "ws_test001",
    producerCapsuleId: "cap_producer1",
    consumerCapsuleId: "cap_consumer1",
    mode: "remote_state",
    visibility: "workspace",
    outputs: {},
  });
  const controller = controllerWith(store, runner);

  // Producer applies -> records a StateVersion (gen 1) the depState points at.
  const producerPlan = await controller.createCapsulePlan("cap_producer1");
  await controller.createApplyRun({
    planRunId: producerPlan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(producerPlan.planRun),
  });
  const producerState = await store.getLatestStateVersion(
    "cap_producer1",
    "preview",
  );
  expect(producerState?.generation).toEqual(1);

  // Consumer plan: the plan job carries a depState for the producer state.
  const consumerPlan = await controller.createCapsulePlan("cap_consumer1");
  const planJob = runner.planJobs.find(
    (job) => job.planRun.capsuleId === "cap_consumer1",
  );
  expect(planJob?.depStates).toBeDefined();
  expect(planJob?.depStates).toHaveLength(1);
  const dep = planJob!.depStates![0]!;
  expect(dep.name).toEqual("producer");
  expect(dep.capsuleId).toEqual("cap_producer1");
  expect(dep.environment).toEqual("preview");
  expect(dep.generation).toEqual(1);
  expect(dep.stateRef).toEqual(producerState!.stateRef);
  expect(dep.digest).toEqual(producerState!.digest);
  const pinned = await store.getDependencySnapshot(
    consumerPlan.planRun.dependencySnapshotId!,
  );
  const pinnedEntry = pinned!.dependencies[0]!;
  expect(pinnedEntry.producerStateGeneration).toEqual(1);
  expect(pinnedEntry.producerStateVersionId).toEqual(producerState!.id);
  expect(pinnedEntry.producerStateRef).toEqual(producerState!.stateRef);
  expect(pinnedEntry.producerStateDigest).toEqual(producerState!.digest);

  // The producer can advance after the consumer plan in preview/pinned mode, but
  // the consumer apply still restores the producer state bytes pinned above.
  const producerPlan2 = await controller.createCapsulePlan("cap_producer1");
  await controller.createApplyRun({
    planRunId: producerPlan2.planRun.id,
    expected: applyExpectedGuardFromPlanRun(producerPlan2.planRun),
  });
  const producerState2 = await store.getLatestStateVersion(
    "cap_producer1",
    "preview",
  );
  expect(producerState2?.generation).toEqual(2);
  expect(producerState2?.stateRef).not.toEqual(producerState!.stateRef);

  // The consumer apply ALSO carries the depState (materialized before apply).
  const consumerApply = await controller.createApplyRun({
    planRunId: consumerPlan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(consumerPlan.planRun),
  });
  expect(consumerApply.applyRun.status).toEqual("succeeded");
  const applyJob = runner.applyJobs.find(
    (job) => job.planRun.capsuleId === "cap_consumer1",
  );
  expect(applyJob?.depStates).toHaveLength(1);
  expect(applyJob!.depStates![0]!.stateRef).toEqual(producerState!.stateRef);
  expect(applyJob!.depStates![0]!.generation).toEqual(1);
});

test("remote_state dispatch fails dependency_state_unavailable when the producer never applied", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  await seedRunnableCapsuleModel(store, {
    environment: "preview",
    sourceId: "src_producer",
    snapshotId: "snap_producer",
    installConfigId: "cfg_producer",
    capsuleId: "cap_producer1",
    name: "producer",
  });
  await seedRunnableCapsuleModel(store, {
    environment: "preview",
    sourceId: "src_consumer",
    snapshotId: "snap_consumer",
    installConfigId: "cfg_consumer",
    capsuleId: "cap_consumer1",
    name: "consumer",
  });
  const deps = new DependenciesService({
    store,
    newId: (prefix) => `${prefix}_edge0001`,
    now: () => "2026-06-06T00:00:00.000Z",
  });
  await deps.createDependency({
    workspaceId: "ws_test001",
    producerCapsuleId: "cap_producer1",
    consumerCapsuleId: "cap_consumer1",
    mode: "remote_state",
    visibility: "workspace",
    outputs: {},
  });
  const controller = controllerWith(store, runner);

  // The producer has NO StateVersion (never applied). remote_state pinning now
  // fails before the PlanRun is queued, so no reviewed plan can exist without
  // pinned producer state bytes.
  await expect(controller.createCapsulePlan("cap_consumer1")).rejects.toThrow(
    /dependency_state_unavailable/,
  );
});

test("remote_state apply fails when the pinned StateVersion object is tampered", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  await seedRunnableCapsuleModel(store, {
    environment: "preview",
    sourceId: "src_producer",
    snapshotId: "snap_producer",
    installConfigId: "cfg_producer",
    capsuleId: "cap_producer1",
    name: "producer",
  });
  await seedRunnableCapsuleModel(store, {
    environment: "preview",
    sourceId: "src_consumer",
    snapshotId: "snap_consumer",
    installConfigId: "cfg_consumer",
    capsuleId: "cap_consumer1",
    name: "consumer",
  });
  const deps = new DependenciesService({
    store,
    newId: (prefix) => `${prefix}_edge0001`,
    now: () => "2026-06-06T00:00:00.000Z",
  });
  await deps.createDependency({
    workspaceId: "ws_test001",
    producerCapsuleId: "cap_producer1",
    consumerCapsuleId: "cap_consumer1",
    mode: "remote_state",
    visibility: "workspace",
    outputs: {},
  });
  const controller = controllerWith(store, runner);

  const producerPlan = await controller.createCapsulePlan("cap_producer1");
  await controller.createApplyRun({
    planRunId: producerPlan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(producerPlan.planRun),
  });
  const consumerPlan = await controller.createCapsulePlan("cap_consumer1");
  const snapshot = await store.getDependencySnapshot(
    consumerPlan.planRun.dependencySnapshotId!,
  );
  await store.putDependencySnapshot({
    ...snapshot!,
    dependencies: [
      {
        ...snapshot!.dependencies[0]!,
        producerStateRef: "opaque-tampered-state-ref",
      },
    ],
  });

  const tamperedApply = await controller.createApplyRun({
    planRunId: consumerPlan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(consumerPlan.planRun),
  });
  expect(tamperedApply.applyRun.status).toBe("failed");
  expect(tamperedApply.applyRun.diagnostics?.[0]?.message).toContain(
    "dependency_snapshot_tampered",
  );
});
