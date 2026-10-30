import { describe, expect, test } from "bun:test";
import {
  appSourceArchiveRootsFromEnv,
  capsuleArtifactRoot,
  ObjectKeyArtifactReferenceAllocator,
  sourceArchiveCustodyPrefixes,
  sourceArchiveSnapshotSegment,
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

describe("Source archives and backups follow an apps root (TASK-0118 P9.1-f)", () => {
  const enabled = new ObjectKeyArtifactReferenceAllocator({ appSourceArchiveRoots: true });
  const disabled = new ObjectKeyArtifactReferenceAllocator();
  const app = { capsuleId: "cap_1", storageRoot: "apps/cap_1" };
  const legacy = { capsuleId: "cap_1", storageRoot: "workspaces/ws_before/capsules/cap_1" };
  const archive = { kind: "source_archive" as const, workspaceId: "ws_1", sourceId: "src_1", snapshotId: "snap_1" };

  test("a Source archive goes under the owner's apps root only when enabled", () => {
    expect(enabled.allocate({ ...archive, owner: app }))
      .toBe("apps/cap_1/sources/src_1/snapshots/snap_1/source.tar.zst");
    // Off until the Runner image accepts `apps/` keys.
    expect(disabled.allocate({ ...archive, owner: app }))
      .toBe("workspaces/ws_1/sources/src_1/snapshots/snap_1/source.tar.zst");
    // A legacy owner, or none, keeps the Workspace layout byte for byte.
    expect(enabled.allocate({ ...archive, owner: legacy }))
      .toBe("workspaces/ws_1/sources/src_1/snapshots/snap_1/source.tar.zst");
    expect(enabled.allocate(archive)).toBe("workspaces/ws_1/sources/src_1/snapshots/snap_1/source.tar.zst");
  });

  test("a backup goes under the owner's apps root, or a legacy owner's frozen Workspace segment", () => {
    for (const allocator of [enabled, disabled]) {
      expect(allocator.allocate({ kind: "backup_control", workspaceId: "ws_1", backupId: "bkp_1", owner: app }))
        .toBe("apps/cap_1/backups/bkp_1/control.json.zst.enc");
      expect(allocator.allocate({ kind: "backup_service_data", workspaceId: "ws_1", backupId: "bkp_1", owner: app }))
        .toBe("apps/cap_1/backups/bkp_1/service-data.tar.zst.enc");
      // Not the live (moved) Workspace id of the allocation.
      expect(allocator.allocate({ kind: "backup_state", workspaceId: "ws_after", backupId: "bkp_1", owner: legacy }))
        .toBe("workspaces/ws_before/backups/bkp_1/state.tar.zst.enc");
      expect(allocator.allocate({ kind: "backup_artifacts_manifest", workspaceId: "ws_1", backupId: "bkp_1" }))
        .toBe("workspaces/ws_1/backups/bkp_1/artifacts.manifest.json");
    }
  });

  test("an owner root that is not this Capsule's canonical root is refused", () => {
    for (const storageRoot of ["apps/cap_2", "workspaces/ws_1/capsules/cap_2", "apps/../cap_1", "tenants/cap_1"]) {
      expect(() => enabled.allocate({ ...archive, owner: { capsuleId: "cap_1", storageRoot } }), storageRoot)
        .toThrow("not canonical");
      expect(() => enabled.allocate({ kind: "backup_control", workspaceId: "ws_1", backupId: "bkp_1",
        owner: { capsuleId: "cap_1", storageRoot } }), storageRoot).toThrow("not canonical");
    }
  });

  test("a Source's custody covers its apps prefix and its Workspace prefix, in key order", () => {
    expect(sourceArchiveCustodyPrefixes({ id: "src_1", workspaceId: "ws_1" }))
      .toEqual(["workspaces/ws_1/sources/src_1/snapshots/"]);
    const prefixes = sourceArchiveCustodyPrefixes({ id: "src_1", workspaceId: "ws_1", ownerCapsuleId: "cap_1" });
    expect(prefixes).toEqual(["apps/cap_1/sources/src_1/snapshots/", "workspaces/ws_1/sources/src_1/snapshots/"]);
    expect([...prefixes].sort()).toEqual(prefixes);
    // An owner id that is not a key segment has no apps prefix.
    expect(sourceArchiveCustodyPrefixes({ id: "src_1", workspaceId: "ws_1", ownerCapsuleId: "cap:1" }))
      .toEqual(["workspaces/ws_1/sources/src_1/snapshots/"]);
    expect(sourceArchiveSnapshotSegment("apps/cap_1/sources/src_1/snapshots/snap_1/source.tar.zst", prefixes)).toBe("snap_1");
    expect(sourceArchiveSnapshotSegment("workspaces/ws_1/sources/src_1/snapshots/snap_2/source.tar.zst", prefixes)).toBe("snap_2");
    for (const ref of [
      "apps/cap_2/sources/src_1/snapshots/snap_1/source.tar.zst",
      "apps/cap_1/sources/src_2/snapshots/snap_1/source.tar.zst",
      "apps/cap_1/sources/src_1/snapshots/../source.tar.zst",
      "apps/cap_1/sources/src_1/snapshots/snap_1/other.tar.zst",
      "apps/cap_1/sources/src_1/snapshots/snap_1/x/source.tar.zst",
    ]) expect(sourceArchiveSnapshotSegment(ref, prefixes), ref).toBeUndefined();
  });

  test("TAKOSUMI_APP_SOURCE_ARCHIVE_ROOTS is enabled, disabled or absent", () => {
    expect(appSourceArchiveRootsFromEnv(undefined)).toBe(false);
    expect(appSourceArchiveRootsFromEnv("")).toBe(false);
    expect(appSourceArchiveRootsFromEnv("disabled")).toBe(false);
    expect(appSourceArchiveRootsFromEnv("enabled")).toBe(true);
    for (const value of ["true", "1", "Enabled"]) expect(() => appSourceArchiveRootsFromEnv(value), value).toThrow();
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
