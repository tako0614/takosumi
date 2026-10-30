/**
 * TASK-0118 P9.1-f: an object under an app's `apps/{cap}` root is attributed
 * to that Capsule (owner resolution and every write path), proven by its
 * ledger record; a legacy `workspaces/{ws}/…` object keeps its Workspace. No
 * `apps/` object falls back to a Workspace.
 */
import { expect, test } from "bun:test";
import { ObjectKeyArtifactReferenceAllocator } from "../../../core/adapters/storage/artifact-references.ts";
import type { R2Bucket, R2Object } from "../../../worker/src/bindings.ts";
import { createStoredObjectOwnerResolver, storedOwnerForKey } from "../../../worker/src/stored-object-owner-resolver.ts";
import { createBackupStoredOwnerContext, runnerStoredServiceBucket } from "../../../worker/src/stored-service-owner-context.ts";
import type { StoredObjectContext, StoredServiceComposition } from "../../../worker/src/stored-service-usage.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";

const DIGEST = `sha256:${"a".repeat(64)}`;

async function ledger(): Promise<SqliteFakeD1> {
  const db = new SqliteFakeD1();
  await db.exec(`create table state_versions (id text, space_id text, installation_id text, environment text, generation integer, object_key text);
    create table artifacts (run_id text, object_key text);
    create table runs (id text, space_id text, source_id text, installation_id text, environment text, type text, status text, lease_token text, run_json text);
    create table sources (id text, space_id text, status text, record_json text);
    create table source_snapshots (id text, source_id text, record_json text);
    create table backups (id text, space_id text, record_json text);
    create table capsules (id text, space_id text, environment text, record_json text)`);
  return db;
}

const noBuckets = { state: undefined, artifacts: undefined, source: undefined, backups: undefined };

test("storedOwnerForKey: an apps/ key belongs to its ledger Capsule, any other key to the Workspace", () => {
  expect(storedOwnerForKey("apps/cap_1/environments/live/state-versions/00000001.tfstate.enc", { workspaceId: "ws_1", capsuleId: "cap_1" }))
    .toEqual({ capsuleId: "cap_1" });
  expect(storedOwnerForKey("workspaces/ws_1/capsules/cap_1/environments/live/state-versions/00000001.tfstate.enc", { workspaceId: "ws_1", capsuleId: "cap_1" }))
    .toEqual({ workspaceId: "ws_1" });
  // The key alone is not proof: the ledger must name the same Capsule.
  expect(() => storedOwnerForKey("apps/cap_1/backups/bkp_1/control.json.zst.enc", { workspaceId: "ws_1", capsuleId: "cap_2" })).toThrow();
  expect(() => storedOwnerForKey("apps/cap_1/backups/bkp_1/control.json.zst.enc", { workspaceId: "ws_1" })).toThrow();
});

test("owner resolution reads the Capsule of an apps/ object from its ledger, never its Workspace", async () => {
  const db = await ledger();
  const owners = createStoredObjectOwnerResolver({ database: db, buckets: noBuckets });
  const resolve = (bucketRole: "state" | "source" | "backups", key: string) => owners.resolveStoredObjectOwner({ bucketRole, key });

  // State versions and the current pointer beside the latest one.
  const appState = "apps/cap_app/environments/live/state-versions/00000001.tfstate.enc";
  const legacyState = "workspaces/ws_before/capsules/cap_old/environments/live/state-versions/00000002.tfstate.enc";
  await db.prepare("insert into state_versions values (?,?,?,?,?,?)").bind("sv_app", "ws_1", "cap_app", "live", 1, appState).run();
  // The legacy Capsule's ledger Workspace column moved; its frozen root did not.
  await db.prepare("insert into state_versions values (?,?,?,?,?,?)").bind("sv_old", "ws_after", "cap_old", "live", 2, legacyState).run();
  expect(await resolve("state", appState)).toEqual({ capsuleId: "cap_app" });
  expect(await resolve("state", `${appState}.execution-evidence.json`)).toEqual({ capsuleId: "cap_app" });
  expect(await resolve("state", "apps/cap_app/environments/live/state-versions/current.json")).toEqual({ capsuleId: "cap_app" });
  expect(await resolve("state", legacyState)).toEqual({ workspaceId: "ws_after" });
  // The pointer is matched against the version's own persisted root, not a
  // root rebuilt from the Workspace column.
  expect(await resolve("state", "workspaces/ws_before/capsules/cap_old/environments/live/state-versions/current.json"))
    .toEqual({ workspaceId: "ws_after" });
  await expect(resolve("state", "workspaces/ws_after/capsules/cap_old/environments/live/state-versions/current.json")).rejects.toThrow();

  // Source archives: the persisted Source's owner, through the snapshot or the sync Run.
  const sourceRecord = { id: "src_app", workspaceId: "ws_1", ownerCapsuleId: "cap_app" };
  await db.prepare("insert into sources values (?,?,?,?)").bind("src_app", "ws_1", "active", JSON.stringify(sourceRecord)).run();
  const archive = "apps/cap_app/sources/src_app/snapshots/snap_1/source.tar.zst";
  await db.prepare("insert into source_snapshots values (?,?,?)")
    .bind("snap_1", "src_app", JSON.stringify({ id: "snap_1", sourceId: "src_app", workspaceId: "ws_1", archiveRef: archive })).run();
  expect(await resolve("source", archive)).toEqual({ capsuleId: "cap_app" });
  const runArchive = "apps/cap_app/sources/src_app/snapshots/snap_run/source.tar.zst";
  await db.prepare("insert into runs (id, space_id, source_id, type, status, run_json) values (?,?,?,?,?,?)")
    .bind("sync_1", "ws_1", "src_app", "source_sync", "failed",
      JSON.stringify({ id: "sync_1", workspaceId: "ws_1", sourceId: "src_app", kind: "source_sync", status: "failed", archiveRef: runArchive })).run();
  expect(await resolve("source", runArchive)).toEqual({ capsuleId: "cap_app" });
  // A Source owned by another Capsule is no proof for this key.
  await db.prepare("update sources set record_json = ? where id = ?")
    .bind(JSON.stringify({ ...sourceRecord, ownerCapsuleId: "cap_other" }), "src_app").run();
  await expect(resolve("source", archive)).rejects.toThrow();
  await expect(resolve("source", runArchive)).rejects.toThrow();
  // Without the Source there is no owner evidence for an apps/ archive.
  await db.prepare("delete from sources where id = ?").bind("src_app").run();
  await expect(resolve("source", archive)).rejects.toThrow();

  // Backups: the Capsule the backup record names.
  const backupKey = "apps/cap_app/backups/bkp_1/control.json.zst.enc";
  await db.prepare("insert into backups values (?,?,?)")
    .bind("bkp_1", "ws_1", JSON.stringify({ id: "bkp_1", workspaceId: "ws_1", capsuleId: "cap_app", ref: backupKey })).run();
  expect(await resolve("backups", backupKey)).toEqual({ capsuleId: "cap_app" });
  const legacyBackup = "workspaces/ws_1/backups/bkp_2/control.json.zst.enc";
  await db.prepare("insert into backups values (?,?,?)")
    .bind("bkp_2", "ws_1", JSON.stringify({ id: "bkp_2", workspaceId: "ws_1", capsuleId: "cap_old", ref: legacyBackup })).run();
  expect(await resolve("backups", legacyBackup)).toEqual({ workspaceId: "ws_1" });
  const foreignBackup = "apps/cap_app/backups/bkp_3/control.json.zst.enc";
  await db.prepare("insert into backups values (?,?,?)")
    .bind("bkp_3", "ws_1", JSON.stringify({ id: "bkp_3", workspaceId: "ws_1", capsuleId: "cap_other", ref: foreignBackup })).run();
  await expect(resolve("backups", foreignBackup)).rejects.toThrow();
});

class MemoryBucket {
  readonly objects = new Map<string, Uint8Array>();
  async head(key: string): Promise<R2Object | null> {
    const bytes = this.objects.get(key);
    return bytes ? { key, size: bytes.byteLength, etag: "e", version: "v1", uploaded: new Date(0), customMetadata: {}, httpMetadata: {} } as unknown as R2Object : null;
  }
  async get(key: string) { return await this.head(key); }
  async list() { return { objects: [], truncated: false }; }
  async put(key: string, value: ArrayBuffer | ArrayBufferView) {
    this.objects.set(key, new Uint8Array(ArrayBuffer.isView(value) ? value.buffer : value));
    return await this.head(key);
  }
  async delete(key: string) { this.objects.delete(key); }
}

/** Records the owner context of every custody call; refuses before any PREPARE. */
function recordingComposition(): { composition: StoredServiceComposition; contexts: StoredObjectContext[] } {
  const contexts: StoredObjectContext[] = [];
  return {
    contexts,
    composition: {
      usage: {
        async readStoredSource() { return { sourceRef: "source_one", epochRef: "epoch_one", qualificationDigest: DIGEST }; },
        async readStoredObject(ctx) {
          contexts.push(ctx);
          const owner = ctx.capsuleId !== undefined ? { capsuleId: ctx.capsuleId } : { workspaceId: ctx.workspaceId! };
          return { ...owner, revision: 0, bytes: "0", versionDigest: null };
        },
        async prepareStoredObject() { throw new Error("prepare is not reached by these reads"); },
        async confirmStoredObject() { throw new Error("unexpected confirm"); },
        async cancelStoredObject() { throw new Error("unexpected cancel"); },
      },
      owners: { async resolveStoredObjectOwner() { return null; } },
    },
  };
}

test("a backup allocated under an app's root is custody of that Capsule", async () => {
  const { composition, contexts } = recordingComposition();
  const bucket = new MemoryBucket();
  const context = createBackupStoredOwnerContext(new ObjectKeyArtifactReferenceAllocator(), composition, bucket as unknown as R2Bucket);
  const appRef = await context.allocator.allocate({ kind: "backup_control", workspaceId: "ws_1", backupId: "bkp_app",
    owner: { capsuleId: "cap_app", storageRoot: "apps/cap_app" } });
  const legacyRef = await context.allocator.allocate({ kind: "backup_control", workspaceId: "ws_1", backupId: "bkp_old",
    owner: { capsuleId: "cap_old", storageRoot: "workspaces/ws_1/capsules/cap_old" } });
  expect(appRef).toBe("apps/cap_app/backups/bkp_app/control.json.zst.enc");
  expect(legacyRef).toBe("workspaces/ws_1/backups/bkp_old/control.json.zst.enc");
  await context.bucket!.head(appRef);
  await context.bucket!.head(legacyRef);
  expect(contexts.map((ctx) => ({ workspaceId: ctx.workspaceId, capsuleId: ctx.capsuleId })))
    .toEqual([{ workspaceId: undefined, capsuleId: "cap_app" }, { workspaceId: "ws_1", capsuleId: undefined }]);
  // A Workspace context keeps the exact key order of every operation digest.
  expect(Object.keys(contexts[1]!)).toEqual(["sourceRef", "bucketRole", "writerId", "workspaceId", "objectRef"]);
  expect(Object.keys(contexts[0]!)).toEqual(["sourceRef", "bucketRole", "writerId", "capsuleId", "objectRef"]);
});

test("a Source sync writing an apps/ archive is custody of the Source's owner, and only under its prefix", async () => {
  const db = await ledger();
  await db.prepare("insert into sources values (?,?,?,?)")
    .bind("src_app", "ws_1", "active", JSON.stringify({ id: "src_app", workspaceId: "ws_1", ownerCapsuleId: "cap_app" })).run();
  const archive = "apps/cap_app/sources/src_app/snapshots/snap_1/source.tar.zst";
  const foreign = "apps/cap_other/sources/src_app/snapshots/snap_2/source.tar.zst";
  for (const [id, archiveRef] of [["sync_app", archive], ["sync_foreign", foreign]] as const) {
    await db.prepare("insert into runs (id, space_id, source_id, type, status, lease_token, run_json) values (?,?,?,?,?,?,?)")
      .bind(id, "ws_1", "src_app", "source_sync", "running", "lease_1",
        JSON.stringify({ id, workspaceId: "ws_1", sourceId: "src_app", kind: "source_sync", status: "running", archiveRef })).run();
  }
  const writes: { owner: unknown; key: string }[] = [];
  const { composition } = recordingComposition();
  const recording: StoredServiceComposition = {
    owners: composition.owners,
    usage: {
      ...composition.usage,
      async prepareStoredObject(input) {
        writes.push({ owner: input.capsuleId !== undefined ? { capsuleId: input.capsuleId } : { workspaceId: input.workspaceId }, key: input.objectRef });
        throw new Error("stop after the owner is known");
      },
    },
  };
  const write = (runId: string, key: string) => runnerStoredServiceBucket(new MemoryBucket() as unknown as R2Bucket, recording, db,
    { bucketRole: "source", runId, expectedLeaseToken: "lease_1" }).put(key, new Uint8Array([1]));
  await expect(write("sync_app", archive)).rejects.toThrow();
  expect(writes.map((entry) => entry.owner)).toEqual([{ capsuleId: "cap_app" }]);
  // An apps/ archive under another Capsule's prefix never reaches PREPARE.
  await expect(write("sync_foreign", foreign)).rejects.toThrow();
  expect(writes).toHaveLength(1);
});
