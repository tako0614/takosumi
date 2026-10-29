import { expect, test } from "bun:test";
import { deterministicInitialCapsuleId, deterministicInstallSourceId } from "../../../core/domains/install-plans/source-reservation.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../worker/src/d1_opentofu_store.ts";
import { assertStoredRetiredSourceArchiveDeletion, assertStoredRetiredSourceArchiveDeletions } from "../../../worker/src/stored-service-owner-context.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";

const NOW = "2026-10-29T00:00:00.000Z";

test("physical archive retirement accepts only the exact uncreated install reservation", async () => {
  const db = new SqliteFakeD1();
  const store = new CloudflareD1OpenTofuControlStore(db);
  const planId = "git_retirement_reserved";
  const sourceId = deterministicInstallSourceId(planId);
  const ownerCapsuleId = deterministicInitialCapsuleId(planId);
  const workspaceId = "ws_reservation";
  const archiveRef = `workspaces/${workspaceId}/sources/${sourceId}/snapshots/snapshot_reserved/source.tar.zst`;
  await store.putWorkspace({ id: workspaceId, handle: workspaceId, displayName: workspaceId,
    ownerUserId: "user_reserved", type: "personal", createdAt: NOW, updatedAt: NOW });
  const source = { id: sourceId, workspaceId, name: "Reserved", url: "https://example.com/repo.git",
    defaultRef: "main", defaultPath: ".", status: "disabled" as const, autoSync: false,
    ownerCapsuleId, createdByInstallPlanId: planId, retiringAt: NOW, hookSecretHash: "hash",
    createdAt: NOW, updatedAt: NOW };
  await store.putSource(source);
  await store.putSourceSnapshot({ id: "snapshot_reserved", workspaceId, sourceId, origin: "git",
    url: source.url, ref: "main", path: ".", resolvedCommit: "abc", archiveRef,
    archiveDigest: "sha256:abc", archiveSizeBytes: 1, fetchedByRunId: "sync_reserved", fetchedAt: NOW });
  const input = { workspaceId, sourceId, archiveRef };
  expect(await assertStoredRetiredSourceArchiveDeletion(db, input)).toBe(true);
  expect(await assertStoredRetiredSourceArchiveDeletions(db, { ...input, archiveRefs: [archiveRef] })).toBe(true);
  await db.prepare("update sources set record_json = json_set(record_json, '$.createdByInstallPlanId', ?) where id = ?")
    .bind("git_wrong", sourceId).run();
  await expect(assertStoredRetiredSourceArchiveDeletion(db, input)).rejects.toThrow();
  await db.prepare("update sources set record_json = json_set(record_json, '$.createdByInstallPlanId', ?) where id = ?")
    .bind(planId, sourceId).run();
  await store.putCapsule({ id: "cap_reference", workspaceId, sourceId, status: "destroyed",
    projectId: "project_reserved", name: "Reserved", slug: "reserved", installConfigId: "config_reserved",
    environment: "production", currentStateGeneration: 0, createdAt: NOW, updatedAt: NOW });
  await expect(assertStoredRetiredSourceArchiveDeletions(db, { ...input, archiveRefs: [archiveRef] })).rejects.toThrow();
  await db.prepare("update capsules set source_id = null where id = ?").bind("cap_reference").run();
  await expect(assertStoredRetiredSourceArchiveDeletion(db, input)).rejects.toThrow();
});
