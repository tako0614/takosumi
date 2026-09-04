import { expect, test } from "bun:test";

import type {
  ApplyRun,
  Capsule,
  PlanRun,
} from "@takosumi/internal/deploy-control-api";
import type { Output } from "takosumi-contract/outputs";
import type { StateVersion } from "takosumi-contract/state-versions";
import { createTakosumiService } from "../../../../core/bootstrap.ts";
import {
  applyExpectedGuardFromPlanRun,
  type OpenTofuRestoreJob,
  type OpenTofuRestoreResult,
  type OpenTofuRunner,
} from "../../../../core/domains/deploy-control/mod.ts";
import {
  capsuleInterfaceMaterializationIntentId,
  createCapsuleInterfaceMaterializationIntent,
  pinCapsuleInterfaceBlueprints,
  type CapsuleInterfaceMaterializationIntent,
} from "../../../../core/domains/deploy-control/interface_materialization_intent.ts";
import {
  capsuleLeaseScope,
  InMemoryCapsuleCoordination,
  type ReleaseCapsuleLeaseInput,
} from "../../../../core/domains/deploy-control/capsule_lease.ts";
import {
  type CommitRunStateInput,
  type CommitRunStateResult,
  type ClaimCapsuleInterfaceMaterializationIntentInput,
  InMemoryOpenTofuControlStore,
} from "../../../../core/domains/deploy-control/store.ts";
import { createInMemoryInterfaceStores } from "../../../../core/domains/interfaces/stores.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import {
  FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
  fixtureExecutionEvidence,
  fakeProviderVault,
  providerRequirementsForFixture,
  seedCapsuleModel,
  seedProviderConnections,
} from "../../../helpers/deploy-control/model_fixture.ts";
import { CAPSULE_LIFECYCLE_COMMAND_CAPABILITY } from "takosumi-contract/install-configs";
import { withHistoricalPublicHostReservations } from "../../../helpers/deploy-control/historical_public_host_store.ts";

const PLAN_DIGEST =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const LOCK_DIGEST =
  "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const CLOUDFLARE = "registry.opentofu.org/cloudflare/cloudflare";
const CLOUDFLARE_MIRROR_EVIDENCE = {
  provider: CLOUDFLARE,
  mirrored: true,
  installationMethod: "filesystem_mirror",
  attested: true,
  attestationMethod: "forced_filesystem_mirror_init",
  mirrorPath:
    "/opt/opentofu/provider-mirror/registry.opentofu.org/cloudflare/cloudflare",
  installedDigest: `sha256:${"e".repeat(64)}`,
} as const;

function restoreAck(
  job: OpenTofuRestoreJob,
  digest = PLAN_DIGEST,
): OpenTofuRestoreResult {
  return {
    state: {
      generation: job.stateScope.generation,
      stateRef: `runner-local://restore/${job.runId}`,
      logicalTargetStateRef: job.stateScope.stateRef,
      digest,
      runId: job.runId,
      ciphertextLength: 0,
      restoreAuthority: {
        kind: "takosumi.runner-restore-ack@v1",
        version: 1,
        fence: 1,
        operationId: `test-restore:${job.runId}`,
        stateEtag: digest,
      },
    },
  };
}

class CapturingInterfaceIntentStore extends InMemoryOpenTofuControlStore {
  interfaceMaterializationIntent?: CapsuleInterfaceMaterializationIntent;

  override commitRunState(
    input: CommitRunStateInput,
  ): Promise<CommitRunStateResult> {
    this.interfaceMaterializationIntent = input.interfaceMaterializationIntent;
    return super.commitRunState(input);
  }
}

class LeaseTrackingCapsuleCoordination extends InMemoryCapsuleCoordination {
  readonly releasedScopes: string[] = [];

  override async releaseLease(
    input: ReleaseCapsuleLeaseInput,
  ): Promise<boolean> {
    this.releasedScopes.push(input.scope);
    return await super.releaseLease(input);
  }
}

class LeaseAwareInterfaceIntentStore extends CapturingInterfaceIntentStore {
  readonly claimEvents: Array<{
    readonly intentId: string | undefined;
    readonly capsuleLeaseReleased: boolean;
  }> = [];

  constructor(
    private readonly coordination: LeaseTrackingCapsuleCoordination,
    private readonly capsuleScope: string,
  ) {
    super();
  }

  override claimCapsuleInterfaceMaterializationIntent(
    input: ClaimCapsuleInterfaceMaterializationIntentInput,
  ): Promise<CapsuleInterfaceMaterializationIntent | undefined> {
    this.claimEvents.push({
      intentId: input.intentId,
      capsuleLeaseReleased: this.coordination.releasedScopes.includes(
        this.capsuleScope,
      ),
    });
    return super.claimCapsuleInterfaceMaterializationIntent(input);
  }
}

async function seedPendingIntent(
  store: InMemoryOpenTofuControlStore,
  capsule: Capsule,
  applyRunId: string,
  committedAt: string,
): Promise<CapsuleInterfaceMaterializationIntent> {
  const state: StateVersion = {
    id: `state_${applyRunId}`,
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    environment: capsule.environment,
    generation: 1,
    stateRef: `state/${applyRunId}`,
    digest: LOCK_DIGEST,
    createdByRunId: applyRunId,
    createdAt: committedAt,
  };
  const output: Output = {
    id: `output_${applyRunId}`,
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    stateGeneration: 1,
    rawArtifactRef: `raw/${applyRunId}`,
    publicOutputs: { endpoint: "https://older-intent.example.test/mcp" },
    workspaceOutputs: { endpoint: "https://older-intent.example.test/mcp" },
    outputDigest: PLAN_DIGEST,
    createdAt: committedAt,
  };
  const planRunId = `plan_${applyRunId}`;
  const applyRun: ApplyRun = {
    id: applyRunId,
    planRunId,
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    operation: "update",
    runnerProfileId: "opentofu-default",
    status: "succeeded",
    expected: {
      planRunId,
      capsuleId: capsule.id,
      runnerProfileId: "opentofu-default",
      sourceDigest: PLAN_DIGEST,
      variablesDigest: PLAN_DIGEST,
      policyDecisionDigest: PLAN_DIGEST,
      planDigest: PLAN_DIGEST,
      planArtifactDigest: PLAN_DIGEST,
    },
    stateBackend: { kind: "managed", ref: "state" } as never,
    stateLock: { status: "recorded", backendRef: "state" },
    auditEvents: [],
    createdAt: Date.parse(committedAt),
    updatedAt: Date.parse(committedAt),
    startedAt: Date.parse(committedAt),
    finishedAt: Date.parse(committedAt),
  };
  const pinned = await pinCapsuleInterfaceBlueprints({
    installConfigId: capsule.installConfigId,
    blueprints: [
      {
        key: "older-runtime-mcp-v1",
        name: "older-runtime-mcp",
        spec: {
          type: "mcp.server",
          version: "2025-11-25",
          document: { transport: "streamable-http" },
          inputs: {
            endpoint: {
              source: "capsule_output",
              outputName: "endpoint",
            },
          },
          access: {
            visibility: "workspace",
            resourceUriInput: "endpoint",
          },
        },
      },
    ],
  });
  const intent = createCapsuleInterfaceMaterializationIntent({
    applyRunId,
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    stateVersionId: state.id,
    outputId: output.id,
    stateGeneration: 1,
    pinned: pinned!,
    createdAt: committedAt,
  });
  await store.commitRunState({
    stateVersion: state,
    output,
    capsulePatch: {
      id: capsule.id,
      patch: {
        currentStateVersionId: state.id,
        currentStateGeneration: 1,
        currentOutputId: output.id,
        status: "active",
        updatedAt: committedAt,
      },
      guard: {
        currentStateVersionId: capsule.currentStateVersionId,
        status: capsule.status,
      },
    },
    applyRunTerminal: applyRun,
    interfaceMaterializationIntent: intent,
  });
  return intent;
}

test("successful Apply promptly drains its Interface materialization intent", async () => {
  const capsuleId = "capsule_interface_intent_fast_path";
  const coordination = new LeaseTrackingCapsuleCoordination();
  const store = new LeaseAwareInterfaceIntentStore(
    coordination,
    capsuleLeaseScope(capsuleId, "preview"),
  );
  const { capsule } = await seedCapsuleModel(store, {
    workspaceId: "workspace_interface_intent_fast_path",
    capsuleId,
    name: "intent-app",
    environment: "preview",
    installConfig: {
      interfaceBlueprints: [
        {
          key: "runtime-mcp-v1",
          name: "runtime-mcp",
          spec: {
            type: "mcp.server",
            version: "2025-11-25",
            document: { transport: "streamable-http" },
            inputs: {
              endpoint: {
                source: "capsule_output",
                outputName: "endpoint",
              },
            },
            access: {
              visibility: "workspace",
              resourceUriInput: "endpoint",
            },
          },
        },
      ],
    },
  });
  const { capsule: olderCapsule } = await seedCapsuleModel(store, {
    workspaceId: "workspace_interface_intent_fast_path_older",
    capsuleId: "capsule_interface_intent_fast_path_older",
    sourceId: "src_interface_intent_fast_path_older",
    snapshotId: "snap_interface_intent_fast_path_older",
    installConfigId: "cfg_interface_intent_fast_path_older",
    name: "older-intent-app",
    environment: "preview",
  });
  const olderIntent = await seedPendingIntent(
    store,
    olderCapsule,
    "apply_interface_intent_fast_path_older",
    "2026-06-06T00:00:01.000Z",
  );
  await seedProviderConnections(store, capsule);
  const runner: OpenTofuRunner = {
    readCapsuleSourceFiles: () =>
      Promise.resolve([
        {
          path: "main.tf",
          text: `
terraform {
  required_providers {
    cloudflare = { source = "cloudflare/cloudflare" }
  }
}

output "endpoint" {
  value = "https://intent-fast-path.example.test/mcp"
}
`,
        },
      ]),
    plan: () =>
      Promise.resolve({
        planDigest: PLAN_DIGEST,
        planArtifact: {
          kind: "runner-local",
          ref: "runner-local://plan_interface_intent_fast_path/tfplan",
          digest: PLAN_DIGEST,
          contentType: "application/vnd.opentofu.plan",
        },
        providerLockDigest: LOCK_DIGEST,
        requiredProviders: [CLOUDFLARE],
        providerInstallation: [CLOUDFLARE_MIRROR_EVIDENCE],
      }),
    apply: (job) =>
      Promise.resolve({
        outputs: {
          endpoint: {
            sensitive: false,
            value: "https://intent-fast-path.example.test/mcp",
          },
        },
        stateDigest: LOCK_DIGEST,
        rawOutputRef: job.rawOutputRef,
        providerInstallation: [CLOUDFLARE_MIRROR_EVIDENCE],
        executionEvidence: fixtureExecutionEvidence(job, "apply"),
      }),
    destroy: () => Promise.resolve({}),
  };
  const interfaceStores = createInMemoryInterfaceStores({
    materializationAuthority: store,
  });
  const { operations } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuControlStore: store,
    interfaceStores,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    opentofuRunner: runner,
    opentofuConnectionVault: fakeProviderVault() as never,
    executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
    capsuleCoordination: coordination,
  });

  const { planRun } = await operations.controller.createCapsulePlan(capsule.id);
  const { applyRun } = await operations.controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  expect(applyRun.status).toBe("succeeded");
  expect(store.claimEvents).toEqual([
    {
      intentId: capsuleInterfaceMaterializationIntentId(applyRun.id),
      capsuleLeaseReleased: true,
    },
  ]);
  expect(
    await store.getCapsuleInterfaceMaterializationIntent(olderIntent.id),
  ).toMatchObject({ status: "pending", attempts: 0 });
  expect(
    await store.getCapsuleInterfaceMaterializationIntent(`cimi_${applyRun.id}`),
  ).toMatchObject({
    capsuleId: capsule.id,
    status: "completed",
    receipt: { disposition: "materialized" },
  });
  expect(
    await operations.interfaces.list({
      workspaceId: capsule.workspaceId,
      ownerKind: "Capsule",
      ownerId: capsule.id,
      includeRetired: true,
    }),
  ).toEqual([
    expect.objectContaining({
      metadata: expect.objectContaining({
        materializedFrom: {
          source: "capsule_blueprint",
          key: "runtime-mcp-v1",
        },
      }),
      status: expect.objectContaining({ phase: "Resolved" }),
    }),
  ]);

  operations.controller.setPostApplyLeaseReleasedObserver(async () => {
    throw new Error("simulated post-lease fast-path failure");
  });
  const { planRun: failedFastPathPlan } =
    await operations.controller.createCapsulePlan(capsule.id);
  const { applyRun: failedFastPathApply } =
    await operations.controller.createApplyRun({
      planRunId: failedFastPathPlan.id,
      expected: applyExpectedGuardFromPlanRun(failedFastPathPlan),
    });
  expect(failedFastPathApply.status).toBe("succeeded");
  expect(
    await store.getCapsuleInterfaceMaterializationIntent(
      capsuleInterfaceMaterializationIntentId(failedFastPathApply.id),
    ),
  ).toMatchObject({ status: "pending", attempts: 0 });

  // A second queued ApplyRun can reach the serialized executor after the
  // original Apply already marked the Plan applied. Its idempotent replay must
  // drain the original durable intent, not a cimi row derived from the replay
  // ApplyRun id.
  const replayApply: ApplyRun = {
    ...failedFastPathApply,
    id: "apply_interface_intent_fast_path_replay",
    status: "queued",
    stateVersionId: undefined,
    outputId: undefined,
    startedAt: undefined,
    finishedAt: undefined,
    heartbeatAt: undefined,
    diagnostics: undefined,
    auditEvents: [],
    createdAt: failedFastPathApply.createdAt + 1,
    updatedAt: failedFastPathApply.updatedAt + 1,
  };
  await store.putApplyRun(replayApply);
  const replayService = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuControlStore: store,
    interfaceStores,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    opentofuRunner: runner,
    opentofuConnectionVault: fakeProviderVault() as never,
    executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
    capsuleCoordination: coordination,
  });
  const claimsBeforeReplay = store.claimEvents.length;
  const replayed = await replayService.operations.controller.runQueuedApply(
    replayApply.id,
  );

  expect(replayed.applyRun.status).toBe("succeeded");
  expect(store.claimEvents.slice(claimsBeforeReplay)).toEqual([
    {
      intentId: capsuleInterfaceMaterializationIntentId(
        failedFastPathApply.id,
      ),
      capsuleLeaseReleased: true,
    },
  ]);
  expect(
    await store.getCapsuleInterfaceMaterializationIntent(
      capsuleInterfaceMaterializationIntentId(failedFastPathApply.id),
    ),
  ).toMatchObject({
    status: "completed",
    receipt: { disposition: "materialized" },
  });
  expect(
    await store.getCapsuleInterfaceMaterializationIntent(
      capsuleInterfaceMaterializationIntentId(replayApply.id),
    ),
  ).toBeUndefined();
});

test("successful Apply atomically records Plan-pinned Interface materialization before a terminal observer crash", async () => {
  const store = new CapturingInterfaceIntentStore();
  const { capsule } = await seedCapsuleModel(store, {
    workspaceId: "workspace_interface_intent_crash",
    capsuleId: "capsule_interface_intent_crash",
    name: "intent-app",
    environment: "preview",
    installConfig: {
      interfaceBlueprints: [
        {
          key: "runtime-mcp-v1",
          name: "runtime-mcp",
          spec: {
            type: "mcp.server",
            version: "2025-11-25",
            document: { transport: "streamable-http" },
            inputs: {
              endpoint: {
                source: "capsule_output",
                outputName: "endpoint",
              },
            },
            access: {
              visibility: "workspace",
              resourceUriInput: "endpoint",
            },
          },
        },
      ],
    },
  });
  await seedProviderConnections(store, capsule);
  const runner: OpenTofuRunner = {
    readCapsuleSourceFiles: () =>
      Promise.resolve([
        {
          path: "main.tf",
          text: `
terraform {
  required_providers {
    cloudflare = { source = "cloudflare/cloudflare" }
  }
}

output "endpoint" {
  value = "https://intent-crash.example.test/mcp"
}
`,
        },
      ]),
    plan: () =>
      Promise.resolve({
        planDigest: PLAN_DIGEST,
        planArtifact: {
          kind: "runner-local",
          ref: "runner-local://plan_interface_intent_crash/tfplan",
          digest: PLAN_DIGEST,
          contentType: "application/vnd.opentofu.plan",
        },
        providerLockDigest: LOCK_DIGEST,
        requiredProviders: [CLOUDFLARE],
        providerInstallation: [CLOUDFLARE_MIRROR_EVIDENCE],
      }),
    apply: (job) =>
      Promise.resolve({
        outputs: {
          endpoint: {
            sensitive: false,
            value: "https://intent-crash.example.test/mcp",
          },
        },
        stateDigest: LOCK_DIGEST,
        rawOutputRef: job.rawOutputRef,
        providerInstallation: [CLOUDFLARE_MIRROR_EVIDENCE],
        executionEvidence: fixtureExecutionEvidence(job, "apply"),
      }),
    destroy: () => Promise.resolve({}),
  };
  const { operations } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuControlStore: store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    opentofuRunner: runner,
    opentofuConnectionVault: fakeProviderVault() as never,
    executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
  });

  const { planRun } = await operations.controller.createCapsulePlan(capsule.id);
  const pinnedInterfaceMaterialization = (
    await store.getPlanRunInputs(planRun.id)
  )?.interfaceMaterialization;
  expect(pinnedInterfaceMaterialization).toBeDefined();
  operations.controller.setTerminalRunObserver(async (run) => {
    if ("planRunId" in run && run.status === "succeeded") {
      throw new Error("simulated terminal observer crash");
    }
  });
  operations.controller.setPostApplyLeaseReleasedObserver(undefined);
  try {
    await operations.controller.createApplyRun({
      planRunId: planRun.id,
      expected: applyExpectedGuardFromPlanRun(planRun),
    });
  } catch (error) {
    expect(String(error)).toContain("simulated terminal observer crash");
  }

  expect(store.interfaceMaterializationIntent).toMatchObject({
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    installConfigId: pinnedInterfaceMaterialization!.installConfigId,
    status: "pending",
    attempts: 0,
    blueprints: pinnedInterfaceMaterialization!.blueprints,
  });
  expect(store.interfaceMaterializationIntent?.blueprintsDigest).toMatch(
    /^sha256:[0-9a-f]{64}$/,
  );
  expect(
    await store.getCapsuleInterfaceMaterializationIntent(
      store.interfaceMaterializationIntent!.id,
    ),
  ).toEqual(store.interfaceMaterializationIntent);
  expect(JSON.stringify(store.interfaceMaterializationIntent)).not.toContain(
    "https://intent-crash.example.test/mcp",
  );
  expect(
    await operations.interfaces.list({
      workspaceId: capsule.workspaceId,
      ownerKind: "Capsule",
      ownerId: capsule.id,
      includeRetired: true,
    }),
  ).toHaveLength(0);

  const recoveryResult =
    await operations.drainInterfaceMaterializationIntents({ limit: 1 });
  expect(recoveryResult).toMatchObject({ claimed: 1, completed: 1 });
  expect(
    await operations.interfaces.list({
      workspaceId: capsule.workspaceId,
      ownerKind: "Capsule",
      ownerId: capsule.id,
      includeRetired: true,
    }),
  ).toEqual([
    expect.objectContaining({
      metadata: expect.objectContaining({
        materializedFrom: {
          source: "capsule_blueprint",
          key: "runtime-mcp-v1",
        },
      }),
      status: expect.objectContaining({ phase: "Resolved" }),
    }),
  ]);
  expect(
    await store.getCapsuleInterfaceMaterializationIntent(
      store.interfaceMaterializationIntent!.id,
    ),
  ).toMatchObject({
    status: "completed",
    receipt: { disposition: "materialized" },
  });
});

test("failed post-apply lifecycle actions never materialize Interface blueprints as Ready", async () => {
  const store = new CapturingInterfaceIntentStore();
  const { capsule } = await seedCapsuleModel(store, {
    workspaceId: "workspace_lifecycle_gate",
    capsuleId: "capsule_lifecycle_gate",
    name: "runtime-gated-app",
    environment: "preview",
    installConfig: {
      interfaceBlueprints: [
        {
          key: "runtime-mcp-v1",
          name: "runtime-mcp",
          spec: {
            type: "mcp.server",
            version: "2025-11-25",
            document: { transport: "streamable-http" },
            inputs: {
              endpoint: {
                source: "capsule_output",
                outputName: "endpoint",
              },
            },
            access: {
              visibility: "workspace",
              resourceUriInput: "endpoint",
            },
          },
        },
      ],
      lifecycleActions: [
        {
          apiVersion: "takosumi.dev/v1alpha1",
          kind: "command",
          id: "activate",
          phase: "post_apply",
          executor: "operator",
          command: ["bun", "run", "release"],
          runnerCapability: CAPSULE_LIFECYCLE_COMMAND_CAPABILITY,
        },
      ],
      policy: {
        lifecycleActions: {
          allowedExecutors: ["operator"],
          allowedRunnerCapabilities: [CAPSULE_LIFECYCLE_COMMAND_CAPABILITY],
        },
      },
    },
  });
  await seedProviderConnections(store, capsule);
  const runner: OpenTofuRunner = {
    readCapsuleSourceFiles: () =>
      Promise.resolve([
        {
          path: "main.tf",
          text: `
terraform {
  required_providers {
    cloudflare = { source = "cloudflare/cloudflare" }
  }
}

output "endpoint" {
  value = "https://runtime-gated.example.test/mcp"
}
`,
        },
      ]),
    plan: () =>
      Promise.resolve({
        planDigest: PLAN_DIGEST,
        planArtifact: {
          kind: "runner-local",
          ref: "runner-local://plan_lifecycle_gate/tfplan",
          digest: PLAN_DIGEST,
          contentType: "application/vnd.opentofu.plan",
        },
        providerLockDigest: LOCK_DIGEST,
        requiredProviders: [CLOUDFLARE],
        providerInstallation: [CLOUDFLARE_MIRROR_EVIDENCE],
      }),
    apply: (job) =>
      Promise.resolve({
        outputs: {
          endpoint: {
            sensitive: false,
            value: "https://runtime-gated.example.test/mcp",
          },
        },
        stateDigest: LOCK_DIGEST,
        rawOutputRef: job.rawOutputRef,
        providerInstallation: [CLOUDFLARE_MIRROR_EVIDENCE],
        executionEvidence: fixtureExecutionEvidence(job, "apply"),
      }),
    destroy: () => Promise.resolve({}),
  };
  const { operations } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuControlStore: store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    opentofuRunner: runner,
    opentofuConnectionVault: fakeProviderVault() as never,
    executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
    releaseActivator: {
      activate: () =>
        Promise.resolve({ status: "failed", message: "not healthy" }),
    },
  });

  const { planRun } = await operations.controller.createCapsulePlan(capsule.id);
  const { applyRun, capsule: failedCapsule } =
    await operations.controller.createApplyRun({
      planRunId: planRun.id,
      expected: applyExpectedGuardFromPlanRun(planRun),
    });

  expect(applyRun.status).toBe("failed");
  expect(failedCapsule?.status).toBe("error");
  expect(applyRun.stateVersionId).toBeDefined();
  expect(applyRun.outputId).toBeDefined();
  expect(store.interfaceMaterializationIntent).toBeUndefined();
  expect(
    await operations.interfaces.list({
      workspaceId: capsule.workspaceId,
      includeRetired: true,
    }),
  ).toEqual([]);
});

test("restore and queued-destroy lifecycles keep Interface delivery fail-closed", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { capsule, source, snapshot } = await seedCapsuleModel(store, {
    workspaceId: "workspace_lifecycle",
    capsuleId: "capsule_lifecycle",
    name: "runtime-app",
  });
  await seedProviderConnections(store, capsule);
  const initialPlan: PlanRun = {
    id: "plan_lifecycle_1",
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    capsuleCurrentStateVersionId: null,
    capsuleContext: {
      workspaceId: capsule.workspaceId,
      capsuleId: capsule.id,
      environment: capsule.environment,
    },
    source: {
      kind: "git",
      url: source.url,
      commit: snapshot.resolvedCommit,
    },
    sourceSnapshotId: snapshot.id,
    sourceDigest: "sha256:source-lifecycle",
    operation: "create",
    runnerProfileId: "opentofu-default",
    variablesDigest: "sha256:variables-lifecycle",
    requiredProviders: [],
    status: "succeeded",
    policy: { status: "passed", reasons: [], checkedAt: 1 },
    policyDecisionDigest: "sha256:policy-lifecycle",
    planDigest: PLAN_DIGEST,
    auditEvents: [],
    createdAt: 1,
    updatedAt: 1,
    appliedApplyRunId: "apply_lifecycle_1",
  };
  const initialApply: ApplyRun = {
    id: "apply_lifecycle_1",
    planRunId: initialPlan.id,
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    stateVersionId: "state_lifecycle_1",
    operation: initialPlan.operation,
    runnerProfileId: initialPlan.runnerProfileId,
    status: "succeeded",
    expected: {
      planRunId: initialPlan.id,
      capsuleId: capsule.id,
      currentStateVersionId: null,
      runnerProfileId: initialPlan.runnerProfileId,
      sourceDigest: initialPlan.sourceDigest,
      variablesDigest: initialPlan.variablesDigest,
      policyDecisionDigest: initialPlan.policyDecisionDigest,
      planDigest: initialPlan.planDigest!,
      planArtifactDigest: PLAN_DIGEST,
    },
    stateBackend: { kind: "operator-managed", ref: "state://test" },
    stateLock: { status: "recorded", backendRef: "state://test" },
    auditEvents: [],
    createdAt: 1,
    updatedAt: 1,
  };
  await store.putPlanRun(initialPlan);
  await store.putApplyRun(initialApply);
  await store.putStateVersion({
    id: "state_lifecycle_1",
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    environment: capsule.environment,
    generation: 1,
    stateRef: "states/lifecycle/1.tfstate.enc",
    digest: LOCK_DIGEST,
    createdByRunId: initialApply.id,
    createdAt: "2026-07-13T00:00:00.000Z",
  });
  await store.putOutput({
    id: "output_lifecycle_1",
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    stateGeneration: 1,
    rawArtifactRef: "sealed/output_lifecycle_1",
    publicOutputs: {},
    workspaceOutputs: {
      endpoint: "https://runtime.example.test/mcp",
    },
    outputDigest: `sha256:${"c".repeat(64)}`,
    createdAt: "2026-07-13T00:00:00.000Z",
  });
  await store.putBackupRecord({
    id: "backup_lifecycle_1",
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    environment: capsule.environment,
    ref: "workspaces/workspace_lifecycle/backups/backup_lifecycle_1/control.json.zst.enc",
    digest: PLAN_DIGEST,
    sizeBytes: 1,
    createdAt: "2026-07-13T00:00:00.000Z",
  });
  await store.putCapsule({
    ...capsule,
    status: "active",
    currentStateVersionId: "state_lifecycle_1",
    currentStateGeneration: 1,
    currentOutputId: "output_lifecycle_1",
    updatedAt: "2026-07-13T00:00:00.000Z",
  });
  const storeWithHistoricalHost = withHistoricalPublicHostReservations(store, [
    {
      hostname: "runtime.example.test",
      ownerUserId: "owner_lifecycle",
      workspaceId: capsule.workspaceId,
      capsuleId: capsule.id,
      capsuleName: capsule.name,
      allocationKind: "scoped",
      status: "reserved",
      reservedAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T00:00:00.000Z",
    },
  ]);

  let restoreAttempt = 0;
  let nextPlanSummary:
    | {
        readonly add?: number;
        readonly change?: number;
        readonly destroy?: number;
      }
    | undefined;
  let signalFirstRestoreStarted!: () => void;
  let completeFirstRestore!: () => void;
  const firstRestoreStarted = new Promise<void>((resolve) => {
    signalFirstRestoreStarted = resolve;
  });
  const firstRestoreCompletion = new Promise<void>((resolve) => {
    completeFirstRestore = resolve;
  });
  const runner: OpenTofuRunner = {
    readCapsuleSourceFiles: () =>
      Promise.resolve([
        {
          path: "main.tf",
          text: `
terraform {
  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
    }
  }
}

resource "cloudflare_workers_script" "app" {
  account_id = "account"
  name       = "runtime-app"
  content    = "export default { fetch() { return new Response('ok') } }"
}

output "endpoint" {
  value = "https://runtime.example.test/mcp"
}
`,
        },
      ]),
    plan: () =>
      Promise.resolve({
        planDigest: PLAN_DIGEST,
        planArtifact: {
          kind: "runner-local",
          ref: "runner-local://plan_lifecycle/tfplan",
          digest: PLAN_DIGEST,
          contentType: "application/vnd.opentofu.plan",
        },
        providerLockDigest: LOCK_DIGEST,
        requiredProviders: [CLOUDFLARE],
        providerInstallation: [CLOUDFLARE_MIRROR_EVIDENCE],
        ...(nextPlanSummary ? { summary: nextPlanSummary } : {}),
      }),
    apply: () => Promise.resolve({}),
    destroy: () => Promise.resolve({}),
    restore: async (job) => {
      restoreAttempt += 1;
      if (restoreAttempt === 1) {
        signalFirstRestoreStarted();
        await firstRestoreCompletion;
        return restoreAck(job);
      }
      throw new Error("restore provider failed");
    },
  };
  const { operations } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuControlStore: storeWithHistoricalHost,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    opentofuRunner: runner,
    opentofuConnectionVault: fakeProviderVault() as never,
    executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
    interfaceCredentialIssuer: {
      issuePrincipalOAuth2Token: () =>
        Promise.resolve({
          accessToken: "taksrv_lifecycle_test",
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
        }),
    },
    enqueueRun: () => Promise.resolve(),
  });
  const iface = await operations.interfaces.create({
    workspaceId: capsule.workspaceId,
    name: "runtime-mcp",
    ownerRef: { kind: "Capsule", id: capsule.id },
    spec: {
      type: "mcp.server",
      version: "2025-11-25",
      document: { transport: "streamable-http" },
      inputs: {
        endpoint: {
          source: "capsule_output",
          capsuleId: capsule.id,
          outputName: "endpoint",
        },
      },
      access: { visibility: "workspace", resourceUriInput: "endpoint" },
    },
  });
  const binding = await operations.interfaces.createBinding(iface.metadata.id, {
    subjectRef: { kind: "Principal", id: "runtime-principal" },
    permissions: ["mcp.invoke"],
    delivery: { type: "none" },
  });
  expect(iface.status.phase).toBe("Resolved");
  expect(binding.status.phase).toBe("Ready");

  const ownedOAuthBinding = await operations.interfaces.createBinding(
    iface.metadata.id,
    {
      subjectRef: { kind: "Principal", id: "oauth-principal" },
      permissions: ["mcp.invoke"],
      delivery: { type: "oauth2" },
    },
  );
  expect(ownedOAuthBinding.status.phase).toBe("Ready");

  const unowned = await operations.interfaces.create({
    workspaceId: capsule.workspaceId,
    name: "unowned-runtime-mcp",
    ownerRef: { kind: "Capsule", id: capsule.id },
    spec: {
      type: "mcp.server",
      version: "2025-11-25",
      document: { transport: "streamable-http" },
      inputs: {
        endpoint: {
          source: "literal",
          value: "https://victim.example.test/mcp",
        },
      },
      access: { visibility: "workspace", resourceUriInput: "endpoint" },
    },
  });
  const unownedOAuthBinding = await operations.interfaces.createBinding(
    unowned.metadata.id,
    {
      subjectRef: { kind: "Principal", id: "oauth-principal" },
      permissions: ["mcp.invoke"],
      delivery: { type: "oauth2" },
    },
  );
  expect(unownedOAuthBinding.status).toMatchObject({
    phase: "NotReady",
    conditions: [{ reason: "OAuthResourceUnauthorized" }],
  });

  // Source sync may mark the Capsule stale while the pinned StateVersion and
  // Output remain valid. That must not stop the current runtime revision.
  await store.patchCapsule(capsule.id, { status: "stale" });
  await operations.interfaces.reconcileCapsule(capsule.workspaceId, capsule.id);
  expect(
    (await operations.interfaces.get(iface.metadata.id)).status.phase,
  ).toBe("Resolved");
  await store.patchCapsule(capsule.id, { status: "active" });

  // A queued plan reports pending observation without revoking the currently
  // pinned runtime revision or its binding. Plan completion removes only the
  // matching observation condition.
  const beforePlan = await operations.interfaces.get(iface.metadata.id);
  const { planRun: observationPlan } =
    await operations.controller.createPlanRun({
      workspaceId: capsule.workspaceId,
      capsuleId: capsule.id,
      source: {
        kind: "git",
        url: "https://git.example.com/example/app.git",
        ref: "main",
      },
      operation: "update",
      requiredProviderRequirements:
        providerRequirementsForFixture([CLOUDFLARE]),
      requiredProviders: [CLOUDFLARE],
    });
  const duringPlan = await operations.interfaces.get(iface.metadata.id);
  expect(duringPlan.status.phase).toBe("Resolved");
  expect(duringPlan.status.resolvedRevision).toBe(
    beforePlan.status.resolvedRevision,
  );
  expect(
    duringPlan.status.conditions?.some(
      (condition) => condition.type === "ObservationPending",
    ),
  ).toBe(true);
  expect(
    (
      await operations.interfaces.getBinding(
        iface.metadata.id,
        binding.metadata.id,
      )
    ).status.phase,
  ).toBe("Ready");
  await operations.controller.dispatchQueuedRun({
    action: "plan",
    runId: observationPlan.id,
    workspaceId: observationPlan.workspaceId,
  });
  const afterPlan = await operations.interfaces.get(iface.metadata.id);
  expect(
    afterPlan.status.conditions?.some(
      (condition) => condition.type === "ObservationPending",
    ),
  ).toBe(false);
  expect(afterPlan.status.resolvedRevision).toBe(
    beforePlan.status.resolvedRevision,
  );

  // A read-only drift plan keeps the same endpoint revision, annotates drift,
  // and leaves runtime delivery Ready. A later clean drift observation clears
  // only the Drifted condition.
  nextPlanSummary = { change: 1 };
  const { planRun: driftPlan } =
    await operations.controller.createCapsuleDriftCheck(capsule.id);
  await operations.controller.dispatchQueuedRun({
    action: "plan",
    runId: driftPlan.id,
    workspaceId: driftPlan.workspaceId,
  });
  const afterDrift = await operations.interfaces.get(iface.metadata.id);
  expect(afterDrift.status.phase).toBe("Resolved");
  expect(afterDrift.status.resolvedRevision).toBe(
    beforePlan.status.resolvedRevision,
  );
  expect(
    afterDrift.status.conditions?.some(
      (condition) =>
        condition.type === "Drifted" && condition.status === "true",
    ),
  ).toBe(true);
  expect(
    (
      await operations.interfaces.getBinding(
        iface.metadata.id,
        binding.metadata.id,
      )
    ).status.phase,
  ).toBe("Ready");

  nextPlanSummary = { add: 0, change: 0, destroy: 0 };
  const { planRun: cleanDriftPlan } =
    await operations.controller.createCapsuleDriftCheck(capsule.id);
  await operations.controller.dispatchQueuedRun({
    action: "plan",
    runId: cleanDriftPlan.id,
    workspaceId: cleanDriftPlan.workspaceId,
  });
  const afterCleanDrift = await operations.interfaces.get(iface.metadata.id);
  expect(
    afterCleanDrift.status.conditions?.some(
      (condition) => condition.type === "Drifted",
    ),
  ).toBe(false);
  expect(afterCleanDrift.status.resolvedRevision).toBe(
    beforePlan.status.resolvedRevision,
  );
  nextPlanSummary = undefined;

  // A queued destroy fences the owner immediately, while cancelling it before
  // provider dispatch restores the still-valid pinned output revision.
  const { planRun: queuedDestroyPlan } =
    await operations.controller.createPlanRun({
      workspaceId: capsule.workspaceId,
      capsuleId: capsule.id,
      source: {
        kind: "git",
        url: "https://git.example.com/example/app.git",
        ref: "main",
      },
      operation: "destroy",
      requiredProviderRequirements:
        providerRequirementsForFixture([CLOUDFLARE]),
      requiredProviders: [CLOUDFLARE],
    });
  await operations.controller.dispatchQueuedRun({
    action: "plan",
    runId: queuedDestroyPlan.id,
    workspaceId: queuedDestroyPlan.workspaceId,
  });
  const destroyPlan = (await store.getPlanRun(queuedDestroyPlan.id))!;
  expect(destroyPlan.diagnostics).toBeUndefined();
  expect(destroyPlan.status).toBe("waiting_approval");
  await operations.controller.approveRun(destroyPlan.id, {
    approvedBy: "ops",
  });
  const approvedDestroyPlan = (await store.getPlanRun(destroyPlan.id))!;
  const { applyRun: queuedDestroy } =
    await operations.controller.createApplyRun({
      planRunId: approvedDestroyPlan.id,
      expected: applyExpectedGuardFromPlanRun(approvedDestroyPlan),
    });
  expect(
    (await operations.interfaces.get(iface.metadata.id)).status.phase,
  ).toBe("Terminating");
  expect(
    (
      await operations.interfaces.getBinding(
        iface.metadata.id,
        binding.metadata.id,
      )
    ).status.phase,
  ).toBe("NotReady");

  await operations.controller.cancelRun(queuedDestroy.id);
  expect(
    (await operations.interfaces.get(iface.metadata.id)).status.phase,
  ).toBe("Resolved");
  expect(
    (
      await operations.interfaces.getBinding(
        iface.metadata.id,
        binding.metadata.id,
      )
    ).status.phase,
  ).toBe("Ready");

  // Restore start clears resolved inputs and revokes delivery before the runner
  // is invoked. A successful restore atomically re-pins both StateVersion and
  // its matching Output, so reconciliation may recover that exact revision
  // even though the Capsule remains stale relative to its desired source.
  const firstRestore = await operations.controller.createRestoreRun(
    capsule.workspaceId,
    "backup_lifecycle_1",
    {
      capsuleId: capsule.id,
      environment: capsule.environment,
      stateGeneration: 1,
      expectedBackupDigest: PLAN_DIGEST,
    },
  );
  await operations.controller.approveRun(firstRestore.id, {
    approvedBy: "ops",
  });
  const firstDispatch = operations.controller.runQueuedRestore(firstRestore.id);
  await firstRestoreStarted;
  const duringRestore = await operations.interfaces.get(iface.metadata.id);
  expect(duringRestore.status.phase).toBe("Unknown");
  expect(duringRestore.status.resolvedInputs).toBeUndefined();
  expect(
    (
      await operations.interfaces.getBinding(
        iface.metadata.id,
        binding.metadata.id,
      )
    ).status.phase,
  ).toBe("NotReady");

  completeFirstRestore();
  await firstDispatch;
  const afterRestore = await operations.interfaces.get(iface.metadata.id);
  expect(afterRestore.status.phase).toBe("Resolved");
  expect(afterRestore.status.resolvedInputs).toEqual({
    endpoint: "https://runtime.example.test/mcp",
  });
  expect(
    (
      await operations.interfaces.getBinding(
        iface.metadata.id,
        binding.metadata.id,
      )
    ).status.phase,
  ).toBe("Ready");

  // Re-activate only for the failure exercise. The second restore starts from a
  // healthy resolved revision, then its runner failure must leave it Unknown.
  await store.putOutput({
    id: "output_lifecycle_2",
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    stateGeneration: 2,
    rawArtifactRef: "sealed/output_lifecycle_2",
    publicOutputs: {},
    workspaceOutputs: {
      endpoint: "https://runtime.example.test/mcp",
    },
    outputDigest: `sha256:${"d".repeat(64)}`,
    createdAt: "2026-07-13T00:00:01.000Z",
  });
  await store.patchCapsule(capsule.id, {
    status: "active",
    currentStateGeneration: 2,
    currentOutputId: "output_lifecycle_2",
  });
  await operations.interfaces.reconcileCapsule(capsule.workspaceId, capsule.id);
  const reactivated = await operations.interfaces.get(iface.metadata.id);
  expect(reactivated.status.phase).toBe("Resolved");
  const failedRestore = await operations.controller.createRestoreRun(
    capsule.workspaceId,
    "backup_lifecycle_1",
    {
      capsuleId: capsule.id,
      environment: capsule.environment,
      stateGeneration: 1,
      expectedBackupDigest: PLAN_DIGEST,
    },
  );
  await operations.controller.approveRun(failedRestore.id, {
    approvedBy: "ops",
  });

  await expect(
    operations.controller.runQueuedRestore(failedRestore.id),
  ).rejects.toThrow("restore provider failed");
  const afterFailure = await operations.interfaces.get(iface.metadata.id);
  expect(afterFailure.status.phase).toBe("Unknown");
  expect(afterFailure.status.resolvedInputs).toBeUndefined();
  expect(afterFailure.status.conditions?.[0]?.message).toBe(
    "OpenTofu restore failed",
  );
  expect(
    (
      await operations.interfaces.getBinding(
        iface.metadata.id,
        binding.metadata.id,
      )
    ).status.phase,
  ).toBe("NotReady");

  // The durable Run ledger fences records created after the observer event as
  // well, including a Workspace-owned Interface that references the Capsule.
  const createdAfterFailure = await operations.interfaces.create({
    workspaceId: capsule.workspaceId,
    name: "runtime-after-failed-restore",
    ownerRef: { kind: "Workspace", id: capsule.workspaceId },
    spec: {
      type: "mcp.server",
      version: "2025-11-25",
      document: { transport: "streamable-http" },
      inputs: {
        endpoint: {
          source: "capsule_output",
          capsuleId: capsule.id,
          outputName: "endpoint",
        },
      },
      access: { visibility: "workspace", resourceUriInput: "endpoint" },
    },
  });
  expect(createdAfterFailure.status.phase).toBe("Unknown");
  expect(createdAfterFailure.status.resolvedInputs).toBeUndefined();
  expect(createdAfterFailure.status.conditions?.[0]?.reason).toBe(
    "RunLedgerUnsafe",
  );
});
