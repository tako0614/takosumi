import { expect, test } from "bun:test";
import { OpenTofuDeploymentController } from "../../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "../../../../core/domains/deploy-control/store.ts";
import { OutputSyncService } from "../../../../core/domains/output-sync/mod.ts";
import { RunGroupsService } from "../../../../core/domains/run-groups/mod.ts";
import { seedInstallationModel } from "../../../helpers/deploy-control/model_fixture.ts";

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
