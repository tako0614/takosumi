import { expect, test } from "bun:test";
import { OpenTofuDeploymentController } from "../../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "../../../../core/domains/deploy-control/store.ts";
import { OutputSyncService } from "../../../../core/domains/output-sync/mod.ts";
import { RunGroupsService } from "../../../../core/domains/run-groups/mod.ts";
import { seedInstallationModel } from "../../../helpers/deploy-control/model_fixture.ts";
import type { RunGroupWithRuns } from "takosumi-contract/runs";

class RecordingRunGroups extends RunGroupsService {
  createCount = 0;

  override async createWorkspaceOutputSync(
    workspaceId: string,
    targetRevision: number,
    pass = 1,
    requestedRunGroupId = `rg_${this.createCount + 1}`,
  ): Promise<RunGroupWithRuns> {
    this.createCount += 1;
    const runGroup = {
      id: requestedRunGroupId,
      workspaceId,
      spaceId: workspaceId,
      type: "workspace_output_sync" as const,
      status: "running" as const,
      graphJson: JSON.stringify({
        mode: "workspace_output_sync",
        targetRevision,
        pass,
        currentLayer: 0,
        order: [["inst_race"]],
        runs: {},
        sourceSnapshotIds: { inst_race: "snap_race" },
      }),
      createdAt: "2026-07-13T00:01:00.000Z",
    };
    await this.store.putRunGroup(runGroup);
    return { runGroup, runs: [] };
  }

  override async advanceWorkspaceOutputSync(
    id: string,
  ): Promise<RunGroupWithRuns | undefined> {
    if (id === "rg_missing") return undefined;
    const runGroup = await this.store.getRunGroup(id);
    return runGroup ? { runGroup, runs: [] } : undefined;
  }

  constructor(
    private readonly store: InMemoryOpenTofuDeploymentStore,
    controller: OpenTofuDeploymentController,
  ) {
    super({ store, controller });
  }
}

test("Output Sync defaults on, can be disabled, and snapshots current non-secret outputs", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const seeded = await seedInstallationModel(store, {
    installationId: "inst_app",
    sourceId: "src_app",
    snapshotId: "snap_app",
    installConfigId: "cfg_app",
    name: "app",
    environment: "production",
  });
  await store.putOutputSnapshot({
    id: "out_1",
    workspaceId: seeded.installation.workspaceId,
    spaceId: seeded.installation.spaceId,
    capsuleId: seeded.installation.id,
    installationId: seeded.installation.id,
    stateGeneration: 1,
    rawOutputArtifactKey: "sealed/outputs/out_1",
    publicOutputs: { url: "https://app.example.com" },
    workspaceOutputs: { service_exports: [] },
    spaceOutputs: { service_exports: [] },
    outputDigest: "sha256:output-1",
    createdAt: "2026-07-13T00:00:00.000Z",
  });
  await store.patchInstallation(seeded.installation.id, {
    currentOutputSnapshotId: "out_1",
  });
  const controller = new OpenTofuDeploymentController({ store });
  const service = new OutputSyncService({
    store,
    runGroups: new RunGroupsService({ store, controller }),
    now: () => "2026-07-13T00:01:00.000Z",
  });

  expect((await service.getStatus("space_test")).state.enabled).toBe(true);
  const snapshot = await service.getSnapshot("space_test");
  expect(snapshot.revision).toBe(0);
  expect(snapshot.outputs).toEqual([
    expect.objectContaining({
      capsuleId: "inst_app",
      outputId: "out_1",
      publicOutputs: { url: "https://app.example.com" },
    }),
  ]);

  expect((await service.setEnabled("space_test", false)).state.enabled).toBe(
    false,
  );
  await expect(service.reconcile("space_test")).rejects.toThrow(
    "output_sync_disabled",
  );
});

test("Output Sync CAS does not overwrite a concurrent revision bump", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const initial = {
    workspaceId: "space_test",
    enabled: true,
    outputRevision: 2,
    reconciledRevision: 1,
    consecutivePasses: 0,
    updatedAt: "2026-07-13T00:00:00.000Z",
  } as const;
  await store.putWorkspaceOutputSyncState(initial);
  const bumped = { ...initial, outputRevision: 3, updatedAt: "later" };
  await store.putWorkspaceOutputSyncState(bumped);
  expect(
    await store.compareAndSetWorkspaceOutputSyncState(initial, {
      ...initial,
      enabled: false,
      updatedAt: "toggle",
    }),
  ).toBe(false);
  expect(
    (await store.getWorkspaceOutputSyncState("space_test"))?.outputRevision,
  ).toBe(3);
});

test("Output Sync converges an empty Workspace without creating a RunGroup", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await store.putWorkspaceOutputSyncState({
    workspaceId: "space_empty",
    enabled: true,
    outputRevision: 3,
    reconciledRevision: 2,
    consecutivePasses: 1,
    updatedAt: "2026-07-13T00:00:00.000Z",
  });
  const controller = new OpenTofuDeploymentController({ store });
  const service = new OutputSyncService({
    store,
    runGroups: new RunGroupsService({ store, controller }),
    now: () => "2026-07-13T00:01:00.000Z",
  });
  const result = await service.reconcile("space_empty");
  expect(result.reconciliation).toBeUndefined();
  expect(result.state.reconciledRevision).toBe(3);
  expect(result.state.consecutivePasses).toBe(0);
});

test("empty observation cannot acknowledge a concurrently published Output revision", async () => {
  class EmptyObservationRaceStore extends InMemoryOpenTofuDeploymentStore {
    armed = false;
    fired = false;

    override async listInstallations(workspaceId: string) {
      if (this.armed && !this.fired) {
        this.fired = true;
        await this.patchInstallation("inst_race", { status: "active" });
        await this.putWorkspaceOutputSyncState({
          workspaceId,
          enabled: true,
          outputRevision: 3,
          reconciledRevision: 1,
          consecutivePasses: 0,
          updatedAt: "2026-07-13T00:00:01.000Z",
        });
        return [];
      }
      return await super.listInstallations(workspaceId);
    }
  }
  const store = new EmptyObservationRaceStore();
  const seeded = await seedInstallationModel(store, {
    installationId: "inst_race",
    sourceId: "src_race",
    snapshotId: "snap_race",
    installConfigId: "cfg_race",
    name: "race",
    environment: "production",
  });
  await store.patchInstallation(seeded.installation.id, { status: "disabled" });
  await store.putWorkspaceOutputSyncState({
    workspaceId: "space_test",
    enabled: true,
    outputRevision: 2,
    reconciledRevision: 1,
    consecutivePasses: 0,
    updatedAt: "2026-07-13T00:00:00.000Z",
  });
  const controller = new OpenTofuDeploymentController({ store });
  const groups = new RecordingRunGroups(store, controller);
  const service = new OutputSyncService({ store, runGroups: groups });
  store.armed = true;

  const result = await service.reconcile("space_test");
  expect(result.state.reconciledRevision).toBe(1);
  expect(result.state.outputRevision).toBe(3);
  expect(groups.createCount).toBe(1);
});

test("missing-group recovery never clears a concurrently claimed newer group", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const seeded = await seedInstallationModel(store, {
    installationId: "inst_race",
    sourceId: "src_race",
    snapshotId: "snap_race",
    installConfigId: "cfg_race",
    name: "race",
    environment: "production",
  });
  await store.patchInstallation(seeded.installation.id, { status: "active" });
  await store.putWorkspaceOutputSyncState({
    workspaceId: "space_test",
    enabled: true,
    outputRevision: 2,
    reconciledRevision: 1,
    activeRunGroupId: "rg_missing",
    consecutivePasses: 0,
    updatedAt: "2026-07-13T00:00:00.000Z",
  });
  const controller = new OpenTofuDeploymentController({ store });
  const groups = new RecordingRunGroups(store, controller);
  let next = 0;
  const service = new OutputSyncService({
    store,
    runGroups: groups,
    newId: () => `rg_new_${++next}`,
  });

  await Promise.all([
    service.reconcile("space_test"),
    service.reconcile("space_test"),
  ]);
  const state = await store.getWorkspaceOutputSyncState("space_test");
  expect(groups.createCount).toBe(1);
  expect(state?.activeRunGroupId).toBe("rg_new_1");
});
