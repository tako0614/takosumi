import { describe, expect, test } from "bun:test";
import {
  capsuleArtifactRoot,
  ObjectKeyArtifactReferenceAllocator,
} from "../../../../core/adapters/storage/artifact-references.ts";

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

  test("new Capsules use the persisted apps root while legacy and Resource keys stay stable", () => {
    expect(allocator.allocate({ kind: "state", workspaceId: "ws_1", subject: { kind: "capsule", id: "cap_1" }, environment: "live", generation: 1, storageRoot: "apps/cap_1" }))
      .toBe("apps/cap_1/environments/live/state-versions/00000001.tfstate.enc");
    expect(allocator.allocate({ kind: "raw_output", workspaceId: "ws_1", subject: { kind: "capsule", id: "cap_1" }, runId: "run_1", storageRoot: "apps/cap_1" }))
      .toBe("apps/cap_1/runs/run_1/outputs.raw.json.enc");
    expect(allocator.allocate({ kind: "state", workspaceId: "ws_1", subject: { kind: "resource", id: "res_1" }, environment: "live", generation: 1, storageRoot: "apps/cap_1" }))
      .toBe("workspaces/ws_1/resources/res_1/environments/live/state-versions/00000001.tfstate.enc");
    expect(() => allocator.allocate({ kind: "state", workspaceId: "ws_1", subject: { kind: "capsule", id: "cap_1" }, environment: "live", generation: 1, storageRoot: "apps/other" })).toThrow();
  });

  test("a persisted legacy root is the authority, whatever the live Workspace id", () => {
    // Allocation names the moved authority Workspace; the root stays where the
    // ownership backfill froze it.
    expect(allocator.allocate({ kind: "state", workspaceId: "ws_after", subject: { kind: "capsule", id: "cap_1" }, environment: "live", generation: 1, storageRoot: "workspaces/ws_before/capsules/cap_1" }))
      .toBe("workspaces/ws_before/capsules/cap_1/environments/live/state-versions/00000001.tfstate.enc");
    expect(allocator.allocate({ kind: "raw_output", workspaceId: "ws_after", subject: { kind: "capsule", id: "cap_1" }, runId: "run_1", storageRoot: "workspaces/ws_before/capsules/cap_1" }))
      .toBe("workspaces/ws_before/capsules/cap_1/runs/run_1/outputs.raw.json.enc");
  });
});

describe("capsuleArtifactRoot", () => {
  test("derives a missing root from the frozen scope and keeps a persisted one", () => {
    expect(capsuleArtifactRoot("ws_frozen", "cap_1")).toBe("workspaces/ws_frozen/capsules/cap_1");
    expect(capsuleArtifactRoot("ws/odd", "cap:1")).toBe("workspaces/ws_odd/capsules/cap_1");
    expect(capsuleArtifactRoot("ws_frozen", "cap_1", "apps/cap_1")).toBe("apps/cap_1");
    expect(capsuleArtifactRoot("ws_frozen", "cap_1", "workspaces/ws_frozen/capsules/cap_1"))
      .toBe("workspaces/ws_frozen/capsules/cap_1");
    expect(capsuleArtifactRoot("ws_frozen", "cap_1", "workspaces/ws_before/capsules/cap_1"))
      .toBe("workspaces/ws_before/capsules/cap_1");
  });

  test("a persisted root must still be this Capsule's exact root", () => {
    for (const root of [
      "workspaces/ws_before/capsules/cap_2",
      "apps/cap_2",
      "workspaces/../capsules/cap_1",
      "workspaces/./capsules/cap_1",
      "workspaces//capsules/cap_1",
      "workspaces/ws_before/capsules/cap_1/extra",
      "workspaces/ws_before/resources/cap_1",
      "tenants/ws_before/capsules/cap_1",
      "",
    ]) {
      expect(() => capsuleArtifactRoot("ws_frozen", "cap_1", root), root).toThrow("not canonical");
    }
    // An `apps/` root is only valid for an id that is already a key segment.
    expect(() => capsuleArtifactRoot("ws_frozen", "cap:1", "apps/cap_1")).toThrow("not canonical");
  });

  test("no Capsule or scope segment may be empty or a dot-only path step", () => {
    for (const capsuleId of ["..", ".", "..."]) {
      expect(() => capsuleArtifactRoot("ws_frozen", capsuleId, `apps/${capsuleId}`), capsuleId).toThrow("not canonical");
      expect(() => capsuleArtifactRoot("ws_frozen", capsuleId, `workspaces/ws_before/capsules/${capsuleId}`), capsuleId)
        .toThrow("not canonical");
      expect(() => capsuleArtifactRoot("ws_frozen", capsuleId), capsuleId).toThrow("not canonical");
    }
    expect(() => capsuleArtifactRoot("ws_frozen", "")).toThrow("not canonical");
    expect(() => capsuleArtifactRoot("..", "cap_1")).toThrow("not canonical");
    expect(() => capsuleArtifactRoot("", "cap_1")).toThrow("not canonical");
    // Dots inside a segment are ordinary characters.
    expect(capsuleArtifactRoot("ws.frozen", "cap.1", "apps/cap.1")).toBe("apps/cap.1");
    expect(capsuleArtifactRoot("ws.frozen", "cap.1")).toBe("workspaces/ws.frozen/capsules/cap.1");
  });
});
