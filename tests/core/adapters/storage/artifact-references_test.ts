import { describe, expect, test } from "bun:test";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";

describe("ObjectKeyArtifactReferenceAllocator", () => {
  const allocator = new ObjectKeyArtifactReferenceAllocator();

  test("keeps every physical layout inside the host storage adapter", () => {
    expect(
      allocator.allocate({
        kind: "source_archive",
        workspaceId: "workspace/one",
        sourceId: "source:one",
        snapshotId: "snapshot one",
      }),
    ).toBe(
      "workspaces/workspace_one/sources/source_one/snapshots/snapshot_one/source.tar.zst",
    );

    expect(
      allocator.allocate({
        kind: "state",
        workspaceId: "workspace_1",
        subject: { kind: "capsule", id: "capsule_1" },
        environment: "production",
        generation: 12,
      }),
    ).toBe(
      "workspaces/workspace_1/capsules/capsule_1/environments/production/state-versions/00000012.tfstate.enc",
    );

    expect(
      allocator.allocate({
        kind: "state",
        workspaceId: "workspace_1",
        subject: { kind: "resource", id: "tkrn:workspace_1:EdgeWorker:api" },
        environment: "preview/us",
        generation: 3,
      }),
    ).toBe(
      "workspaces/workspace_1/resources/tkrn_workspace_1_EdgeWorker_api/environments/preview_us/state-versions/00000003.tfstate.enc",
    );

    expect(
      allocator.allocate({
        kind: "raw_output",
        workspaceId: "workspace_1",
        subject: { kind: "capsule", id: "capsule_1" },
        runId: "apply_1",
      }),
    ).toBe(
      "workspaces/workspace_1/capsules/capsule_1/runs/apply_1/outputs.raw.json.enc",
    );
  });

  test("allocates each backup sidecar without leaking its layout into Core", () => {
    const common = { workspaceId: "workspace_1", backupId: "backup_1" };

    expect(allocator.allocate({ kind: "backup_control", ...common })).toBe(
      "workspaces/workspace_1/backups/backup_1/control.json.zst.enc",
    );
    expect(allocator.allocate({ kind: "backup_state", ...common })).toBe(
      "workspaces/workspace_1/backups/backup_1/state.tar.zst.enc",
    );
    expect(
      allocator.allocate({ kind: "backup_artifacts_manifest", ...common }),
    ).toBe("workspaces/workspace_1/backups/backup_1/artifacts.manifest.json");
    expect(allocator.allocate({ kind: "backup_service_data", ...common })).toBe(
      "workspaces/workspace_1/backups/backup_1/service-data.tar.zst.enc",
    );
  });
});
