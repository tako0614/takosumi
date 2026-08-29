import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import type { ApplyRun, Capsule, Run } from "@takosumi/internal/deploy-control-api";
import type { CapsuleInterfaceBlueprint } from "takosumi-contract";
import type { Output } from "takosumi-contract/outputs";
import type { StateVersion } from "takosumi-contract/state-versions";
import type { RecordActivityInput } from "../../../../core/domains/activity/mod.ts";

import {
  createCapsuleInterfaceMaterializationIntent,
  createRestoredCapsuleInterfaceMaterializationIntent,
  pinCapsuleInterfaceBlueprints,
  restoredCapsuleInterfaceMaterializationIntentId,
  type CapsuleInterfaceMaterializationIntent,
} from "../../../../core/domains/deploy-control/interface_materialization_intent.ts";
import {
  OpenTofuController,
  type OpenTofuRestoreJob,
  type OpenTofuRestoreResult,
} from "../../../../core/domains/deploy-control/mod.ts";
import {
  InMemoryOpenTofuControlStore,
  type OpenTofuControlStore,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { InMemoryCapsuleCoordination } from "../../../../core/domains/deploy-control/capsule_lease.ts";
import {
  CapsuleInterfaceMaterializationIntentDrainer,
  type CapsuleInterfaceMaterializationTarget,
} from "../../../../core/domains/interfaces/materialization_intent_drain.ts";
import { CapsuleInterfaceMaterializationFailureService } from "../../../../core/domains/interfaces/materialization_intent_failures.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import { fakeProviderVault } from "../../../helpers/deploy-control/model_fixture.ts";

setDefaultTimeout(30_000);

const APPLY_AT = "2026-08-29T11:00:00.000Z";
const RESTORE_AT = "2026-08-29T11:10:00.000Z";
const pgClients: PGliteSqlClient[] = [];

function restoreAck(
  job: OpenTofuRestoreJob,
  digest: string,
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

afterEach(async () => {
  await Promise.all(pgClients.splice(0).map((client) => client.close()));
});

async function stores(): Promise<readonly [string, OpenTofuControlStore][]> {
  const pgClient = await PGliteSqlClient.create();
  pgClients.push(pgClient);
  return [
    ["memory", new InMemoryOpenTofuControlStore()],
    ["postgres", new SqlOpenTofuControlStore({ client: pgClient })],
    ["d1", new CloudflareD1OpenTofuControlStore(new SqliteFakeD1())],
  ];
}

class MissingExactRestoreOutputStore extends InMemoryOpenTofuControlStore {
  missingOutputId: string | undefined;

  override getOutput(id: string): Promise<Output | undefined> {
    if (id === this.missingOutputId) return Promise.resolve(undefined);
    return super.getOutput(id);
  }
}

function blueprint(): CapsuleInterfaceBlueprint {
  return {
    key: "runtime",
    name: "runtime",
    spec: {
      type: "mcp.server",
      version: "2025-11-25",
      document: { transport: "streamable-http" },
      inputs: {
        endpoint: { source: "capsule_output", outputName: "endpoint" },
      },
      access: { visibility: "workspace", resourceUriInput: "endpoint" },
    },
  };
}

async function commitApplyIntent(
  store: OpenTofuControlStore,
  capsule: Capsule,
  label: string,
  blueprints: readonly CapsuleInterfaceBlueprint[] = [blueprint()],
): Promise<CapsuleInterfaceMaterializationIntent> {
  const applyRunId = `apply_restore_source_${label}`;
  const stateVersion: StateVersion = {
    id: `state_restore_source_${label}`,
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    environment: capsule.environment,
    generation: 1,
    stateRef: `state/restore-source/${label}`,
    digest: `sha256:${"a".repeat(64)}`,
    createdByRunId: applyRunId,
    createdAt: APPLY_AT,
  };
  const output: Output = {
    id: `output_restore_source_${label}`,
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    stateGeneration: 1,
    rawArtifactRef: `output/restore-source/${label}`,
    publicOutputs: { endpoint: "https://source.example.test/mcp" },
    workspaceOutputs: { endpoint: "https://source.example.test/mcp" },
    outputDigest: `sha256:${"b".repeat(64)}`,
    createdAt: APPLY_AT,
  };
  const planRunId = `plan_restore_source_${label}`;
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
      sourceDigest: `sha256:${"c".repeat(64)}`,
      variablesDigest: `sha256:${"d".repeat(64)}`,
      policyDecisionDigest: `sha256:${"e".repeat(64)}`,
      planDigest: `sha256:${"f".repeat(64)}`,
      planArtifactDigest: `sha256:${"f".repeat(64)}`,
    },
    stateBackend: { kind: "managed", ref: "state" } as never,
    stateLock: { status: "recorded", backendRef: "state" },
    auditEvents: [],
    createdAt: Date.parse(APPLY_AT),
    updatedAt: Date.parse(APPLY_AT),
    startedAt: Date.parse(APPLY_AT),
    finishedAt: Date.parse(APPLY_AT),
  };
  const pinned = await pinCapsuleInterfaceBlueprints({
    installConfigId: capsule.installConfigId,
    blueprints,
  });
  const intent = createCapsuleInterfaceMaterializationIntent({
    applyRunId,
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    stateVersionId: stateVersion.id,
    outputId: output.id,
    stateGeneration: 1,
    pinned: pinned!,
    createdAt: APPLY_AT,
  });
  await store.commitRunState({
    stateVersion,
    output,
    capsulePatch: {
      id: capsule.id,
      patch: {
        currentStateVersionId: stateVersion.id,
        currentStateGeneration: 1,
        currentOutputId: output.id,
        status: "active",
        updatedAt: APPLY_AT,
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

async function claimRestore(
  store: OpenTofuControlStore,
  capsule: Capsule,
  label: string,
): Promise<{ readonly running: Run; readonly leaseToken: string }> {
  const queued: Run = {
    id: `restore_interface_intent_${label}`,
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    environment: capsule.environment,
    type: "restore",
    status: "queued",
    backupId: `backup_interface_intent_${label}`,
    restoreStateGeneration: 1,
    createdBy: "operator",
    createdAt: RESTORE_AT,
  };
  await store.putBackupRun(queued);
  const running: Run = {
    ...queued,
    status: "running",
    startedAt: RESTORE_AT,
  };
  const leaseToken = `restore_interface_intent_lease_${label}`;
  const claimed = await store.transitionRun({
    id: queued.id,
    kind: "restore",
    expectFrom: ["queued"],
    run: running,
    setLeaseToken: leaseToken,
    heartbeatAt: Date.parse(RESTORE_AT),
  });
  expect(claimed.won, label).toBe(true);
  return { running, leaseToken };
}

test("Restore atomically supersedes the old pending intent and creates the current-generation obligation", async () => {
  for (const [label, store] of await stores()) {
    const seeded = await seedCapsuleModel(store, {
      workspaceId: `workspace_restore_intent_${label}`,
      capsuleId: `capsule_restore_intent_${label}`,
    });
    const sourceIntent = await commitApplyIntent(store, seeded.capsule, label);
    const current = (await store.getCapsule(seeded.capsule.id))!;
    const { running, leaseToken } = await claimRestore(store, current, label);
    const stateVersion: StateVersion = {
      id: `state_restored_interface_intent_${label}`,
      workspaceId: current.workspaceId,
      capsuleId: current.id,
      environment: current.environment,
      generation: 2,
      stateRef: `state/restored-interface-intent/${label}`,
      digest: `sha256:${"a".repeat(64)}`,
      createdByRunId: running.id,
      createdAt: RESTORE_AT,
    };
    const output: Output = {
      id: `output_restored_interface_intent_${label}`,
      workspaceId: current.workspaceId,
      capsuleId: current.id,
      stateGeneration: 2,
      rawArtifactRef: `output/restored-interface-intent/${label}`,
      publicOutputs: { endpoint: "https://source.example.test/mcp" },
      workspaceOutputs: { endpoint: "https://source.example.test/mcp" },
      outputDigest: `sha256:${"b".repeat(64)}`,
      createdAt: RESTORE_AT,
    };
    const replacement = createRestoredCapsuleInterfaceMaterializationIntent({
      restoreRunId: running.id,
      sourceIntent,
      stateVersionId: stateVersion.id,
      outputId: output.id,
      stateGeneration: 2,
      createdAt: RESTORE_AT,
    });

    await store.commitRestoredState({
      stateVersion,
      output,
      capsulePatch: {
        id: current.id,
        patch: {
          currentStateVersionId: stateVersion.id,
          currentStateGeneration: 2,
          currentOutputId: output.id,
          status: "stale",
          updatedAt: RESTORE_AT,
        },
        guard: {
          currentStateVersionId: current.currentStateVersionId,
          currentStateGeneration: current.currentStateGeneration,
          status: current.status,
        },
      },
      restoreRunTerminal: {
        ...running,
        status: "succeeded",
        restoredFromStateVersionId: sourceIntent.stateVersionId,
        restoredStateVersionId: stateVersion.id,
        finishedAt: RESTORE_AT,
      },
      restoreRunLeaseToken: leaseToken,
      interfaceMaterializationReplacement: {
        sourceIntentId: sourceIntent.id,
        intent: replacement,
      },
    });

    expect(
      await store.getCapsuleInterfaceMaterializationIntent(sourceIntent.id),
      `${label}:source`,
    ).toMatchObject({
      status: "completed",
      receipt: { disposition: "superseded_before_materialization" },
    });
    expect(
      await store.getCapsuleInterfaceMaterializationIntent(replacement.id),
      `${label}:replacement`,
    ).toMatchObject({
      restoreRunId: running.id,
      sourceIntentId: sourceIntent.id,
      stateGeneration: 2,
      stateVersionId: stateVersion.id,
      outputId: output.id,
      status: "pending",
      nextItemIndex: 0,
    });
  }
});

test("Postgres Restore missing-Capsule guard leaves the terminal Run and ledger writes untouched", async () => {
  const client = await PGliteSqlClient.create();
  pgClients.push(client);
  const store = new SqlOpenTofuControlStore({ client });
  const { capsule } = await seedCapsuleModel(store, {
    workspaceId: "workspace_restore_missing_capsule_pg",
    capsuleId: "capsule_restore_missing_capsule_pg",
  });
  const { running, leaseToken } = await claimRestore(
    store,
    capsule,
    "missing_capsule_pg",
  );
  const stateVersion: StateVersion = {
    id: "state_restore_missing_capsule_pg",
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    environment: capsule.environment,
    generation: 1,
    stateRef: "state/restore-missing-capsule-pg",
    digest: `sha256:${"7".repeat(64)}`,
    createdByRunId: running.id,
    createdAt: RESTORE_AT,
  };
  const output: Output = {
    id: "output_restore_missing_capsule_pg",
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    stateGeneration: 1,
    rawArtifactRef: "output/restore-missing-capsule-pg",
    publicOutputs: {},
    workspaceOutputs: {},
    outputDigest: `sha256:${"8".repeat(64)}`,
    createdAt: RESTORE_AT,
  };
  await client.query(
    "delete from takosumi_capsules where id = $1",
    [capsule.id],
  );

  const committed = await store.commitRestoredState({
    stateVersion,
    output,
    capsulePatch: {
      id: capsule.id,
      patch: {
        currentStateVersionId: stateVersion.id,
        currentStateGeneration: 1,
        currentOutputId: output.id,
        status: "stale",
        updatedAt: RESTORE_AT,
      },
      guard: {
        currentStateVersionId: capsule.currentStateVersionId,
        currentStateGeneration: capsule.currentStateGeneration,
        status: capsule.status,
      },
    },
    restoreRunTerminal: {
      ...running,
      status: "succeeded",
      restoredStateVersionId: stateVersion.id,
      finishedAt: RESTORE_AT,
    },
    restoreRunLeaseToken: leaseToken,
  });

  expect(committed.capsule).toBeUndefined();
  expect(await store.getStateVersion(stateVersion.id)).toBeUndefined();
  expect(await store.getOutput(output.id)).toBeUndefined();
  expect((await store.getBackupRun(running.id))?.status).toBe("running");
});

test("RunEngine records failed, never succeeded, when the Postgres Capsule disappears before Restore commit", async () => {
  const client = await PGliteSqlClient.create();
  pgClients.push(client);
  const store = new SqlOpenTofuControlStore({ client });
  const seeded = await seedCapsuleModel(store, {
    workspaceId: "workspace_restore_disappears_pg",
    capsuleId: "capsule_restore_disappears_pg",
  });
  const sourceIntent = await commitApplyIntent(
    store,
    seeded.capsule,
    "disappears_pg",
  );
  const backupId = "backup_restore_disappears_pg";
  await store.putBackupRecord({
    id: backupId,
    workspaceId: seeded.capsule.workspaceId,
    capsuleId: seeded.capsule.id,
    environment: seeded.capsule.environment,
    ref: "backups/restore-disappears-pg.json.zst.enc",
    digest: `sha256:${"9".repeat(64)}`,
    sizeBytes: 1,
    createdAt: RESTORE_AT,
  });
  const activities: RecordActivityInput[] = [];
  const phases: Array<"started" | "succeeded" | "failed"> = [];
  let id = 0;
  let now = Date.parse(RESTORE_AT);
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    store,
    activity: {
      record: (event) => {
        activities.push(event);
        return Promise.resolve();
      },
    },
    enqueueRun: () => Promise.resolve(),
    now: () => now++,
    newId: (prefix) => `${prefix}_restore_disappears_${++id}`,
    runner: {
      restore: async (job) => {
        await client.query(
          "delete from takosumi_capsules where id = $1",
          [seeded.capsule.id],
        );
        return restoreAck(job, `sha256:${"a".repeat(64)}`);
      },
    },
  });
  controller.setRestoreRunObserver((event) => {
    phases.push(event.phase);
    return Promise.resolve();
  });
  const restore = await controller.createRestoreRun(
    seeded.capsule.workspaceId,
    backupId,
    {
      capsuleId: seeded.capsule.id,
      environment: seeded.capsule.environment,
      stateGeneration: sourceIntent.stateGeneration,
    },
  );
  await controller.approveRun(restore.id, { approvedBy: "operator" });

  await expect(controller.runQueuedRestore(restore.id)).rejects.toThrow(
    /Capsule .* disappeared before Restore commit/u,
  );

  expect(await store.getBackupRun(restore.id)).toMatchObject({
    status: "failed",
  });
  expect(phases).toEqual(["started", "failed"]);
  expect(
    activities.filter((event) => event.action === "restore.succeeded"),
  ).toEqual([]);
  const stateRows = await client.query<{ readonly id: string }>(
    "select id from takosumi_state_versions where installation_id = $1 order by id",
    [seeded.capsule.id],
  );
  expect(stateRows.rows).toEqual([{ id: sourceIntent.stateVersionId }]);
});

test("Restore replacement rejects a source intent whose StateVersion is not the run's exact restoredFrom row", async () => {
  for (const [label, store] of await stores()) {
    const seeded = await seedCapsuleModel(store, {
      workspaceId: `workspace_restore_source_fence_${label}`,
      capsuleId: `capsule_restore_source_fence_${label}`,
    });
    const sourceIntent = await commitApplyIntent(
      store,
      seeded.capsule,
      `source_fence_${label}`,
    );
    const current = (await store.getCapsule(seeded.capsule.id))!;
    const { running, leaseToken } = await claimRestore(
      store,
      current,
      `source_fence_${label}`,
    );
    const stateVersion: StateVersion = {
      id: `state_restore_source_fence_${label}`,
      workspaceId: current.workspaceId,
      capsuleId: current.id,
      environment: current.environment,
      generation: 2,
      stateRef: `state/restore-source-fence/${label}`,
      digest: `sha256:${"2".repeat(64)}`,
      createdByRunId: running.id,
      createdAt: RESTORE_AT,
    };
    const output: Output = {
      id: `output_restore_source_fence_${label}`,
      workspaceId: current.workspaceId,
      capsuleId: current.id,
      stateGeneration: 2,
      rawArtifactRef: `output/restore-source-fence/${label}`,
      publicOutputs: { endpoint: "https://source.example.test/mcp" },
      workspaceOutputs: { endpoint: "https://source.example.test/mcp" },
      outputDigest: `sha256:${"3".repeat(64)}`,
      createdAt: RESTORE_AT,
    };
    const replacement = createRestoredCapsuleInterfaceMaterializationIntent({
      restoreRunId: running.id,
      sourceIntent,
      stateVersionId: stateVersion.id,
      outputId: output.id,
      stateGeneration: 2,
      createdAt: RESTORE_AT,
    });

    await expect(
      store.commitRestoredState({
        stateVersion,
        output,
        capsulePatch: {
          id: current.id,
          patch: {
            currentStateVersionId: stateVersion.id,
            currentStateGeneration: 2,
            currentOutputId: output.id,
            status: "stale",
            updatedAt: RESTORE_AT,
          },
          guard: {
            currentStateVersionId: current.currentStateVersionId,
            currentStateGeneration: current.currentStateGeneration,
            status: current.status,
          },
        },
        restoreRunTerminal: {
          ...running,
          status: "succeeded",
          restoredFromStateVersionId: `state_not_source_${label}`,
          restoredStateVersionId: stateVersion.id,
          finishedAt: RESTORE_AT,
        },
        restoreRunLeaseToken: leaseToken,
        interfaceMaterializationReplacement: {
          sourceIntentId: sourceIntent.id,
          intent: replacement,
        },
      }),
      label,
    ).rejects.toThrow();
    expect(await store.getCapsule(current.id), `${label}:capsule rollback`).toMatchObject({
      currentStateVersionId: sourceIntent.stateVersionId,
      currentStateGeneration: sourceIntent.stateGeneration,
      currentOutputId: sourceIntent.outputId,
    });
    expect(
      await store.getCapsuleInterfaceMaterializationIntent(replacement.id),
      `${label}:intent rollback`,
    ).toBeUndefined();
  }
});

test("RunEngine Restore carries the exact pending Interface snapshot into the new generation", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const seeded = await seedCapsuleModel(store, {
    workspaceId: "workspace_restore_intent_controller",
    capsuleId: "capsule_restore_intent_controller",
  });
  const sourceIntent = await commitApplyIntent(
    store,
    seeded.capsule,
    "controller",
  );
  const backupId = "backup_restore_intent_controller";
  await store.putBackupRecord({
    id: backupId,
    workspaceId: seeded.capsule.workspaceId,
    capsuleId: seeded.capsule.id,
    environment: seeded.capsule.environment,
    ref: "backups/restore-intent-controller.json.zst.enc",
    digest: `sha256:${"7".repeat(64)}`,
    sizeBytes: 1,
    createdAt: RESTORE_AT,
  });
  let id = 0;
  let now = Date.parse(RESTORE_AT);
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    store,
    now: () => now++,
    newId: (prefix) => `${prefix}_restore_intent_${++id}`,
    runner: {
      restore: (job) =>
        Promise.resolve(restoreAck(job, `sha256:${"a".repeat(64)}`)),
    },
  });
  const restore = await controller.createRestoreRun(
    seeded.capsule.workspaceId,
    backupId,
    {
      capsuleId: seeded.capsule.id,
      environment: seeded.capsule.environment,
      stateGeneration: sourceIntent.stateGeneration,
    },
  );
  await controller.approveRun(restore.id, { approvedBy: "operator" });

  await controller.runQueuedRestore(restore.id);

  const restored = (await store.getCapsule(seeded.capsule.id))!;
  expect(
    await store.getCapsuleInterfaceMaterializationIntent(sourceIntent.id),
  ).toMatchObject({
    status: "completed",
    receipt: { disposition: "superseded_before_materialization" },
  });
  expect(
    await store.getCapsuleInterfaceMaterializationIntent(
      restoredCapsuleInterfaceMaterializationIntentId(restore.id),
    ),
  ).toMatchObject({
    sourceIntentId: sourceIntent.id,
    stateVersionId: restored.currentStateVersionId,
    outputId: restored.currentOutputId,
    stateGeneration: restored.currentStateGeneration,
    status: "pending",
  });
});

test("RunEngine Restore fails before dispatch when the intent's exact Output is missing even if a newer Output shares its generation", async () => {
  const store = new MissingExactRestoreOutputStore();
  const seeded = await seedCapsuleModel(store, {
    workspaceId: "workspace_restore_exact_output",
    capsuleId: "capsule_restore_exact_output",
  });
  const sourceIntent = await commitApplyIntent(
    store,
    seeded.capsule,
    "exact_output",
  );
  await store.putOutput({
    id: "output_same_generation_but_not_pinned",
    workspaceId: seeded.capsule.workspaceId,
    capsuleId: seeded.capsule.id,
    stateGeneration: sourceIntent.stateGeneration,
    rawArtifactRef: "output/same-generation-but-not-pinned",
    publicOutputs: { endpoint: "https://wrong.example.test/mcp" },
    workspaceOutputs: { endpoint: "https://wrong.example.test/mcp" },
    outputDigest: `sha256:${"4".repeat(64)}`,
    createdAt: "2026-08-29T11:01:00.000Z",
  });
  store.missingOutputId = sourceIntent.outputId;
  const backupId = "backup_restore_exact_output";
  await store.putBackupRecord({
    id: backupId,
    workspaceId: seeded.capsule.workspaceId,
    capsuleId: seeded.capsule.id,
    environment: seeded.capsule.environment,
    ref: "backups/restore-exact-output.json.zst.enc",
    digest: `sha256:${"5".repeat(64)}`,
    sizeBytes: 1,
    createdAt: RESTORE_AT,
  });
  let runnerCalls = 0;
  let id = 0;
  let now = Date.parse(RESTORE_AT);
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    store,
    now: () => now++,
    newId: (prefix) => `${prefix}_restore_exact_output_${++id}`,
    runner: {
      restore: (job) => {
        runnerCalls += 1;
        return Promise.resolve(restoreAck(job, `sha256:${"6".repeat(64)}`));
      },
    },
  });
  const restore = await controller.createRestoreRun(
    seeded.capsule.workspaceId,
    backupId,
    {
      capsuleId: seeded.capsule.id,
      environment: seeded.capsule.environment,
      stateGeneration: sourceIntent.stateGeneration,
    },
  );
  let restoreError: unknown;
  try {
    await controller.approveRun(restore.id, { approvedBy: "operator" });
    await controller.runQueuedRestore(restore.id);
  } catch (error) {
    restoreError = error;
  }
  expect(restoreError).toBeInstanceOf(Error);
  expect((restoreError as Error).message).toContain(
    "restore_interface_output_missing",
  );
  expect(runnerCalls).toBe(0);
  expect(await store.getCapsule(seeded.capsule.id)).toMatchObject({
    currentStateVersionId: sourceIntent.stateVersionId,
    currentStateGeneration: sourceIntent.stateGeneration,
    currentOutputId: sourceIntent.outputId,
  });
  expect(
    await store.getCapsuleInterfaceMaterializationIntent(sourceIntent.id),
  ).toMatchObject({ status: "pending" });
});

function maximalBlueprints(): readonly CapsuleInterfaceBlueprint[] {
  return Array.from({ length: 64 }, (_, interfaceIndex) => ({
    key: `runtime-${interfaceIndex}`,
    name: `runtime-${interfaceIndex}`,
    spec: {
      type: "mcp.server",
      version: "2025-11-25",
      document: { transport: "streamable-http" },
      inputs: {
        endpoint: {
          source: "literal" as const,
          value: `https://runtime-${interfaceIndex}.example.test/mcp`,
        },
      },
      access: {
        visibility: "workspace" as const,
        resourceUriInput: "endpoint",
      },
    },
    bindings: Array.from({ length: 64 }, (_, bindingIndex) => ({
      key: `principal-${bindingIndex}`,
      subjectRef: {
        kind: "Principal" as const,
        id: `principal_${interfaceIndex}_${bindingIndex}`,
      },
      permissions: ["mcp.invoke"],
      delivery: { type: "none" as const },
    })),
  }));
}

test("a maximal declaration checkpoints bounded item work and resumes without replay", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const seeded = await seedCapsuleModel(store, {
    workspaceId: "workspace_intent_budget",
    capsuleId: "capsule_intent_budget",
  });
  const intent = await commitApplyIntent(
    store,
    seeded.capsule,
    "budget",
    maximalBlueprints(),
  );
  const visited: number[] = [];
  const target: CapsuleInterfaceMaterializationTarget = {
    materializeItem: (input) => {
      visited.push(input.itemIndex);
      return Promise.resolve({ kind: "materialized" });
    },
  };
  let lease = 0;
  const drainer = new CapsuleInterfaceMaterializationIntentDrainer({
    store,
    coordination: new InMemoryCapsuleCoordination({
      now: () => Date.parse(RESTORE_AT),
    }),
    target,
    now: () => RESTORE_AT,
    newLeaseToken: () => `lease_budget_${++lease}`,
    maxItemsPerClaim: 8,
  });

  expect(
    await drainer.drain({ limit: 4, maxWorkItems: 16, timeBudgetMs: 10_000 }),
  ).toMatchObject({
    claimed: 2,
    progressed: 2,
    workItemsCompleted: 16,
    completed: 0,
  });
  expect(visited).toEqual(Array.from({ length: 16 }, (_, index) => index));
  expect(
    await store.getCapsuleInterfaceMaterializationIntent(intent.id),
  ).toMatchObject({
    status: "pending",
    totalItems: 4_160,
    nextItemIndex: 16,
  });

  await drainer.drain({ limit: 1, maxWorkItems: 8, timeBudgetMs: 10_000 });
  expect(visited.slice(16)).toEqual(
    Array.from({ length: 8 }, (_, index) => index + 16),
  );
});

test("a progress checkpoint rotates behind already-due intents across stores", async () => {
  for (const [label, store] of await stores()) {
    const firstSeed = await seedCapsuleModel(store, {
      workspaceId: `workspace_intent_fair_first_${label}`,
      capsuleId: `capsule_intent_fair_first_${label}`,
    });
    const secondSeed = await seedCapsuleModel(store, {
      workspaceId: `workspace_intent_fair_second_${label}`,
      capsuleId: `capsule_intent_fair_second_${label}`,
    });
    const first = await commitApplyIntent(
      store,
      firstSeed.capsule,
      `fair_first_${label}`,
      [
        blueprint(),
        {
          ...blueprint(),
          key: "runtime-second",
          name: "runtime-second",
        },
      ],
    );
    const second = await commitApplyIntent(
      store,
      secondSeed.capsule,
      `fair_second_${label}`,
    );
    const leaseToken = `lease_fair_first_${label}`;
    expect(
      await store.claimCapsuleInterfaceMaterializationIntent({
        leaseToken,
        claimedAt: RESTORE_AT,
        leaseExpiresAt: "2026-08-29T11:11:00.000Z",
      }),
      label,
    ).toMatchObject({ id: first.id, nextItemIndex: 0 });
    expect(
      await store.settleCapsuleInterfaceMaterializationIntent({
        id: first.id,
        leaseToken,
        expectedNextItemIndex: 0,
        settledAt: RESTORE_AT,
        outcome: {
          kind: "progress",
          nextItemIndex: 1,
          releaseLease: true,
          nextRetryAt: RESTORE_AT,
        },
      }),
      label,
    ).toMatchObject({
      kind: "updated",
      intent: { id: first.id, nextItemIndex: 1 },
    });
    expect(
      await store.claimCapsuleInterfaceMaterializationIntent({
        leaseToken: `lease_fair_second_${label}`,
        claimedAt: RESTORE_AT,
        leaseExpiresAt: "2026-08-29T11:11:00.000Z",
      }),
      label,
    ).toMatchObject({ id: second.id });
  }
});

test("dead-letter visibility is value-free and retry is digest plus Capsule-state CAS across stores", async () => {
  for (const [label, store] of await stores()) {
    const seeded = await seedCapsuleModel(store, {
      workspaceId: `workspace_intent_dlq_${label}`,
      capsuleId: `capsule_intent_dlq_${label}`,
    });
    const intent = await commitApplyIntent(store, seeded.capsule, `dlq_${label}`);
    const leaseToken = `lease_intent_dlq_${label}`;
    await store.claimCapsuleInterfaceMaterializationIntent({
      leaseToken,
      claimedAt: RESTORE_AT,
      leaseExpiresAt: "2026-08-29T11:11:00.000Z",
    });
    await store.settleCapsuleInterfaceMaterializationIntent({
      id: intent.id,
      leaseToken,
      expectedNextItemIndex: 0,
      settledAt: RESTORE_AT,
      outcome: {
        kind: "dead-letter",
        code: "interface_provenance_conflict",
        detailDigest: `sha256:${"9".repeat(64)}`,
      },
    });
    const service = new CapsuleInterfaceMaterializationFailureService({
      store,
      now: () => RESTORE_AT,
    });

    const [failure] = await service.list(seeded.capsule.workspaceId);
    expect(failure, label).toMatchObject({
      id: intent.id,
      capsuleId: seeded.capsule.id,
      stateVersionId: intent.stateVersionId,
      stateGeneration: intent.stateGeneration,
      nextItemIndex: 0,
      totalItems: 1,
      error: {
        code: "interface_provenance_conflict",
        detailDigest: `sha256:${"9".repeat(64)}`,
      },
    });
    const publicPayload = JSON.stringify(failure);
    expect(publicPayload, `${label}:no declaration`).not.toContain(
      '"blueprints":',
    );
    expect(publicPayload, `${label}:no output value`).not.toContain(
      "source.example.test",
    );

    await expect(
      service.retry(seeded.capsule.workspaceId, intent.id, {
        failureDigest: `sha256:${"0".repeat(64)}`,
        stateVersionId: intent.stateVersionId,
        stateGeneration: intent.stateGeneration,
      }),
      `${label}:digest CAS`,
    ).rejects.toMatchObject({ code: "failed_precondition" });
    expect(
      await service.retry(seeded.capsule.workspaceId, intent.id, {
        failureDigest: failure!.failureDigest,
        stateVersionId: intent.stateVersionId,
        stateGeneration: intent.stateGeneration,
      }),
      label,
    ).toMatchObject({ status: "pending", nextItemIndex: 0 });
    await expect(
      service.retry(seeded.capsule.workspaceId, intent.id, {
        failureDigest: failure!.failureDigest,
        stateVersionId: intent.stateVersionId,
        stateGeneration: intent.stateGeneration,
      }),
      `${label}:no replay`,
    ).rejects.toMatchObject({ code: "failed_precondition" });
  }
});

test("dead-letter forward retry cannot revive an intent after Capsule state advances", async () => {
  for (const [label, store] of await stores()) {
    const seeded = await seedCapsuleModel(store, {
      workspaceId: `workspace_intent_stale_dlq_${label}`,
      capsuleId: `capsule_intent_stale_dlq_${label}`,
    });
    const intent = await commitApplyIntent(
      store,
      seeded.capsule,
      `stale_dlq_${label}`,
    );
    const leaseToken = `lease_intent_stale_dlq_${label}`;
    await store.claimCapsuleInterfaceMaterializationIntent({
      leaseToken,
      claimedAt: RESTORE_AT,
      leaseExpiresAt: "2026-08-29T11:11:00.000Z",
    });
    await store.settleCapsuleInterfaceMaterializationIntent({
      id: intent.id,
      leaseToken,
      expectedNextItemIndex: 0,
      settledAt: RESTORE_AT,
      outcome: {
        kind: "dead-letter",
        code: "interface_provenance_conflict",
        detailDigest: `sha256:${"8".repeat(64)}`,
      },
    });
    const service = new CapsuleInterfaceMaterializationFailureService({
      store,
      now: () => RESTORE_AT,
    });
    const [failure] = await service.list(seeded.capsule.workspaceId);
    const current = (await store.getCapsule(seeded.capsule.id))!;
    await store.putCapsule({
      ...current,
      currentStateVersionId: `state_newer_${label}`,
      currentStateGeneration: 2,
      currentOutputId: `output_newer_${label}`,
      updatedAt: RESTORE_AT,
    });

    await expect(
      service.retry(seeded.capsule.workspaceId, intent.id, {
        failureDigest: failure!.failureDigest,
        stateVersionId: intent.stateVersionId,
        stateGeneration: intent.stateGeneration,
      }),
      label,
    ).rejects.toMatchObject({ code: "failed_precondition" });
    expect(
      await store.getCapsuleInterfaceMaterializationIntent(intent.id),
      label,
    ).toMatchObject({ status: "dead_letter" });
  }
});
