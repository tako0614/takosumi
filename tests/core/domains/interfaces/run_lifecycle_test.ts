import { expect, test } from "bun:test";
import { createTakosumiService } from "../../../../core/bootstrap.ts";
import {
  applyExpectedGuardFromPlanRun,
  type OpenTofuRunner,
} from "../../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import {
  fakeProviderVault,
  seedCapsuleModel,
  seedProviderConnections,
} from "../../../helpers/deploy-control/model_fixture.ts";
import { CAPSULE_LIFECYCLE_COMMAND_CAPABILITY } from "takosumi-contract/install-configs";

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
} as const;

test("failed post-apply lifecycle actions never materialize Interface blueprints as Ready", async () => {
  const store = new InMemoryOpenTofuControlStore();
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
    apply: () =>
      Promise.resolve({
        outputs: {
          endpoint: {
            sensitive: false,
            value: "https://runtime-gated.example.test/mcp",
          },
        },
        stateDigest: LOCK_DIGEST,
        providerInstallation: [CLOUDFLARE_MIRROR_EVIDENCE],
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
  expect(
    await operations.interfaces.list({
      workspaceId: capsule.workspaceId,
      includeRetired: true,
    }),
  ).toEqual([]);
});

test("restore and queued-destroy lifecycles keep Interface delivery fail-closed", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { capsule } = await seedCapsuleModel(store, {
    workspaceId: "workspace_lifecycle",
    capsuleId: "capsule_lifecycle",
    name: "runtime-app",
  });
  await seedProviderConnections(store, capsule);
  await store.putStateVersion({
    id: "state_lifecycle_1",
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    environment: capsule.environment,
    generation: 1,
    stateRef: "states/lifecycle/1.tfstate.enc",
    digest: LOCK_DIGEST,
    createdByRunId: "apply_lifecycle_1",
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
  await store.reservePublicHost({
    hostname: "runtime.example.test",
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    capsuleName: capsule.name,
    allocationKind: "scoped",
    now: "2026-07-13T00:00:00.000Z",
  });

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
    restore: async ({ stateScope }) => {
      restoreAttempt += 1;
      if (restoreAttempt === 1) {
        signalFirstRestoreStarted();
        await firstRestoreCompletion;
        return {
          state: {
            stateRef: stateScope.stateRef,
            digest: PLAN_DIGEST,
          },
        };
      }
      throw new Error("restore provider failed");
    },
  };
  const { operations } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuControlStore: store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    opentofuRunner: runner,
    opentofuConnectionVault: fakeProviderVault() as never,
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
  // is invoked. A successful restore reconciles against the restored Capsule,
  // which remains NotReady while the Capsule is intentionally stale.
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
  expect(afterRestore.status.phase).toBe("NotReady");
  expect(afterRestore.status.resolvedInputs).toBeUndefined();

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
