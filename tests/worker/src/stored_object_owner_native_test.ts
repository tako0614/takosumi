import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { storedDigest } from "../../../worker/src/stored-service-usage.ts";
import { createBackupStoredOwnerContext } from "../../../worker/src/stored-service-owner-context.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../core/adapters/storage/artifact-references.ts";
import { composeStorageStagingEnv, readStorageRuntimeVersion } from "../../../deploy/platform/storage-staging-profile.ts";
import type { StorageStagingEnv } from "../../../deploy/platform/storage-staging-profile.ts";

const ROOT = resolve(import.meta.dir, "../../..");
const NATIVE = `
import { createStoredObjectOwnerResolver } from ${JSON.stringify(join(ROOT, "worker/src/stored-object-owner-resolver.ts"))};
import { storedNativeVersion } from ${JSON.stringify(join(ROOT, "worker/src/stored-service-usage.ts"))};
import { runnerStoredServiceBucket, createBackupStoredOwnerContext } from ${JSON.stringify(join(ROOT, "worker/src/stored-service-owner-context.ts"))};
import { createStoredInventoryProducer } from ${JSON.stringify(join(ROOT, "worker/src/artifact-storage-inventory.ts"))};
import { ObjectKeyArtifactReferenceAllocator } from ${JSON.stringify(join(ROOT, "core/adapters/storage/artifact-references.ts"))};
import { R2PrivateRunFileBlobStore } from ${JSON.stringify(join(ROOT, "worker/src/private_run_file_r2_blob_store.ts"))};
import { D1PrivateRunFileRepository } from ${JSON.stringify(join(ROOT, "worker/src/d1_private_run_file_repository.ts"))};
import { PartitionedSecretBoundaryCrypto } from ${JSON.stringify(join(ROOT, "core/adapters/secret-store/memory.ts"))};
const digest = "sha256:" + "a".repeat(64);
function composition(env, owners) {
  const usage = {
    async readStoredSource(input) { return {sourceRef:"source_"+input.bucketRole,epochRef:"epoch_one",qualificationDigest:digest}; },
    async readStoredObject(input) {
      let row = await env.DB.prepare("select snapshot from fixture_usage where object_ref=?").bind(input.objectRef).first();
      return row ? JSON.parse(row.snapshot) : {workspaceId:input.workspaceId,revision:0,bytes:"0",versionDigest:null};
    },
    async prepareStoredObject(input) {
      const intent = {operationRef:input.operationRef,expectedRevision:input.expectedRevision,kind:input.desired===null?"delete":"put",bytes:input.desired?.bytes??"0",contentDigest:input.desired?.contentDigest??null,state:"pending"};
      const snapshot = {workspaceId:input.workspaceId,revision:0,bytes:"0",versionDigest:null,pending:intent};
      await env.DB.prepare("insert into fixture_usage(object_ref,owner,snapshot,request) values(?,?,?,?)").bind(input.objectRef,input.workspaceId,JSON.stringify(snapshot),JSON.stringify(input)).run();
      const control = await env.DB.prepare("select value from fixture_control where name='swap_lease'").first();
      if(control?.value) await env.DB.prepare("update runs set lease_token='lease_taken_over' where id=?").bind(control.value).run();
      const rotate = await env.DB.prepare("select value from fixture_control where name='rotate_private'").first();
      if(rotate?.value === 'epoch') await env.DB.prepare("update capsules set execution_authority_epoch=execution_authority_epoch+1").run();
      if(rotate?.value === 'freeze') await env.DB.prepare("update workspaces set management_state='frozen',management_epoch=management_epoch+1").run();
      return {dispatch:true,intent,dispatchToken:"f".repeat(64)};
    },
    async confirmStoredObject(input) {
      const fail = await env.DB.prepare("select value from fixture_control where name='confirm_lost'").first();
      if(fail?.value === 'yes') throw new Error('synthetic committed R2 effect without catalogue ACK');
      const row = await env.DB.prepare("select request from fixture_usage where object_ref=?").bind(input.objectRef).first();
      const request = JSON.parse(row.request);
      const snapshot = {workspaceId:input.workspaceId,revision:1,bytes:request.desired?.bytes??"0",versionDigest:input.newVersionDigest};
      await env.DB.prepare("update fixture_usage set snapshot=? where object_ref=?").bind(JSON.stringify(snapshot),input.objectRef).run();
    },
    async cancelStoredObject() { throw new Error("unexpected fixture cancellation"); }
  };
  return {usage,owners};
}
export default {
  async fetch(request, env) {
    const input = await request.json();
    const buckets = {state:env.STATE,artifacts:env.ARTIFACTS,source:env.SOURCE,backups:env.BACKUPS};
    const sourceReader = {async readStoredSource(input) {return {sourceRef:"source_"+input.bucketRole,epochRef:"epoch_one",qualificationDigest:digest};}};
    const originalOwners = {async readOriginalStoredObjectOwner(input) {
      if(Object.keys(input).sort().join(',') !== 'bucketRole,objectRef') throw new Error('untrusted owner assertion');
      const row = await env.DB.prepare("select owner,request from fixture_usage where object_ref=?").bind(input.objectRef).first();
      if(!row) return null;
      const request = JSON.parse(row.request);
      if(request.bucketRole !== input.bucketRole || request.sourceRef !== 'source_'+input.bucketRole) throw new Error('foreign source');
      return {workspaceId:row.owner,sourceRef:request.sourceRef,epochRef:'epoch_one',qualificationDigest:digest};
    }};
    const owners = createStoredObjectOwnerResolver({database:env.DB,buckets,privateRunFilePrefix:"private",sources:sourceReader,originalOwners});
    try {
      let result;
      if(input.operation === "resolve") result = await owners.resolveStoredObjectOwner(input);
      else if(input.operation === "inventory") result = await createStoredInventoryProducer({buckets,owners,fences:{async readStoredInventoryFence(input) {return {sourceRef:"source_"+input.bucketRole,inventoryRef:input.inventoryRef,bucketRole:input.bucketRole,qualificationDigest:digest,fenceDigest:digest,phase:"inventory",cursor:null};}}}).readStoredInventoryPage({...input,cursor:null});
      else if(input.operation === "runner") {
        const bucket = runnerStoredServiceBucket(buckets[input.bucketRole],composition(env,owners),env.DB,input);
        await bucket.put(input.key,new Uint8Array([9,8,7]),{customMetadata:{"takosumi-run-id":input.runId}});
        result = {ok:true};
      } else if(input.operation === "retire") {
        const usage = {
          ...composition(env,owners).usage,
          async readStoredObject(ctx) {
            const object = await buckets.source.head(input.key);
            return {workspaceId:ctx.workspaceId,revision:0,bytes:String(object?.size??0),versionDigest:object?await storedNativeVersion(object):null};
          },
          async prepareStoredObject(ctx) {
            const intent = {operationRef:ctx.operationRef,expectedRevision:ctx.expectedRevision,kind:"delete",bytes:"0",contentDigest:null,state:"pending"};
            return {dispatch:true,intent,dispatchToken:"f".repeat(64)};
          },
          async confirmStoredObject() {},
        };
        const bucket = runnerStoredServiceBucket(buckets.source,{usage,owners},env.DB,{bucketRole:"source",sourceRetirement:input.sourceRetirement});
        await bucket.delete(input.key);
        result = {ok:true};
      } else if(input.operation === "backup") {
        const context = createBackupStoredOwnerContext(new ObjectKeyArtifactReferenceAllocator(),composition(env,owners),env.BACKUPS);
        const key = await context.allocator.allocate({kind:"backup_control",workspaceId:"workspace_original",backupId:"backup_prefinal"});
        await context.bucket.put(key,new Uint8Array([1,2,3,4]));
        result = {key};
      } else if(input.operation === "private") {
        const store = new R2PrivateRunFileBlobStore({bucket:env.ARTIFACTS,prefix:'private',storageUsage:composition(env,owners),writeAuthority:new D1PrivateRunFileRepository(env.DB),cryptoBoundary:new PartitionedSecretBoundaryCrypto({globalPassphrase:'native-private-file-test-passphrase-0123456789'}),maxBytes:16*1024*1024});
        const bytes = new Uint8Array([1,2,3]);
        const hash = await crypto.subtle.digest('SHA-256',bytes);
        const digest = 'sha256:'+Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('');
        result = await store.putEncryptedImmutable({scope:input.scope,authority:input.authority,bytes,digest});
      } else throw new Error("fixture method unavailable");
      return Response.json({result});
    } catch { return Response.json({error:"closed"},{status:503}); }
  }
};
`;

async function nativeFixture() {
  const directory = await mkdtemp(join(tmpdir(), "takosumi-stored-owner-native-"));
  const entry = join(directory, "entry.ts");
  await writeFile(entry, NATIVE);
  const built = await Bun.build({ entrypoints: [entry], outdir: directory, target: "browser", format: "esm", external: ["cloudflare:workers"] });
  if (!built.success) throw new Error(built.logs.map(log => log.message).join("\n"));
  const runtime = new Miniflare({ modules: [{ type: "ESModule", path: "owner-native.mjs", contents: await built.outputs[0]!.text() }], compatibilityDate: "2026-06-01", d1Databases: { DB: "owner-database" }, r2Buckets: ["STATE", "ARTIFACTS", "SOURCE", "BACKUPS"] });
  const db = await runtime.getD1Database("DB").catch(async error => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); throw error; });
  for (const sql of [
    "create table runs(id text primary key,space_id text,installation_id text,source_id text,environment text,type text,status text,lease_token text,run_json text)",
    "create table state_versions(id text primary key,space_id text,installation_id text,environment text,generation integer,object_key text)",
    "create table artifacts(id text primary key,run_id text,object_key text)",
    "create table sources(id text primary key,space_id text,record_json text)",
    "create table source_snapshots(id text primary key,source_id text,record_json text)",
    "create table backups(id text primary key,space_id text,record_json text)",
    "create table private_run_file_pointers(workspace_id text,capsule_id text,environment text,slot text,digest text,blob_id text,version integer)",
    "create table private_run_file_receipts(workspace_id text,capsule_id text,environment text,slot text,digest text,blob_id text)",
    "create table capsules(id text primary key,space_id text,environment text,current_state_generation integer,current_state_version_id text,execution_authority_epoch integer,record_json text)",
    "create table workspaces(id text primary key,management_state text,management_epoch integer)",
    "create table fixture_usage(object_ref text primary key,owner text,snapshot text,request text)",
    "create table fixture_control(name text primary key,value text)",
  ]) await db.prepare(sql).run();
  const call = async (input: unknown) => {
    const response = await runtime.dispatchFetch("http://fixture.test", { method: "POST", body: JSON.stringify(input) });
    return { status: response.status, body: await response.json() as { result?: unknown; error?: string } };
  };
  return { runtime, db, call, async close() { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); } };
}

test("native inventory uses original retained exact allocations, blocks key UID inference and private metadata forgery", async () => {
  const fixture = await nativeFixture();
  try {
    const { db, runtime, call } = fixture;
    const source = await runtime.getR2Bucket("SOURCE");
    const state = await runtime.getR2Bucket("STATE");
    const backups = await runtime.getR2Bucket("BACKUPS");
    const artifacts = await runtime.getR2Bucket("ARTIFACTS");
    const workspaceId = "workspace_original";
    const stateRef = `workspaces/${workspaceId}/capsules/capsule_one/environments/live/state-versions/00000001.tfstate.enc`;
    await db.prepare("insert into state_versions values('state_one',?,'capsule_one','live',1,?)").bind(workspaceId, stateRef).run();
    await state.put(stateRef, "state");
    await state.put(stateRef + ".execution-evidence.json", "receipt");
    await state.put(stateRef.replace("00000001.tfstate.enc", "current.json"), "pointer");
    const sourceRef = "old-layout/source-archive-one";
    const run = { id: "sync_one", kind: "source_sync", workspaceId, sourceId: "source_one", archiveRef: sourceRef, status: "failed" };
    await db.prepare("insert into runs(id,space_id,type,status,run_json) values(?,?,?,?,?)").bind(run.id, workspaceId, "source_sync", run.status, JSON.stringify(run)).run();
    await source.put(sourceRef, "source");
    const backupRef = "historical-layout/backup-original";
    await db.prepare("insert into backups values('backup_one',?,?)").bind(workspaceId, JSON.stringify({ id: "backup_one", workspaceId, ref: backupRef })).run();
    await backups.put(backupRef, "backup");
    const scope = [workspaceId, "capsule_one", "live", "state"];
    const plaintextDigest = "sha256:" + "b".repeat(64);
    const blobId = await storedDigest(JSON.stringify([...scope, plaintextDigest]));
    const privateKey = `private/${blobId.slice(7)}`;
    const metadata = { format: "takosumi-private-run-file-r2@v1", scope: await storedDigest(JSON.stringify(scope)), digest: plaintextDigest, byteLength: "3" };
    await db.prepare("insert into private_run_file_receipts values(?,?,?,?,?,?)").bind(...scope, plaintextDigest, blobId).run();
    await artifacts.put(privateKey, new Uint8Array(32), { customMetadata: metadata });
    for (const [bucketRole, key] of [["state", stateRef], ["source", sourceRef], ["backups", backupRef], ["artifacts", privateKey]]) {
      expect(await call({ operation: "resolve", bucketRole, key })).toEqual({ status: 200, body: { result: { workspaceId } } });
      const inventory = await call({ operation: "inventory", bucketRole, inventoryRef: "inventory_one" });
      expect(inventory.status).toBe(200);
      const page = inventory.body.result as { objects: { workspaceId: string; bytes: string }[]; nextCursor: null };
      expect(page.objects.length).toBeGreaterThan(0);
      expect(page.objects.every(object => object.workspaceId === workspaceId && BigInt(object.bytes) > 0n)).toBe(true);
      expect(page.nextCursor).toBeNull();
    }
    const orphan = `workspaces/${workspaceId}/capsules/capsule_one/orphan`;
    await state.put(orphan, "unowned", { customMetadata: { "takosumi-workspace-id": workspaceId } });
    expect((await call({ operation: "resolve", bucketRole: "state", key: orphan })).body.result).toBeNull();
    expect((await call({ operation: "inventory", bucketRole: "state", inventoryRef: "inventory_one" })).status).toBe(503);
    await artifacts.put(privateKey, new Uint8Array(32), { customMetadata: { ...metadata, scope: "sha256:" + "c".repeat(64) } });
    expect((await call({ operation: "resolve", bucketRole: "artifacts", key: privateKey })).status).toBe(503);
    await db.prepare("insert into state_versions values('state_conflict','workspace_other','capsule_other','live',1,?)").bind(stateRef).run();
    expect((await call({ operation: "resolve", bucketRole: "state", key: stateRef })).status).toBe(503);
  } finally { await fixture.close(); }
}, 30_000);

test("native preledger source write pins the original Run owner; forged ref and taken-over lease dispatch nothing", async () => {
  const fixture = await nativeFixture();
  try {
    const { db, runtime, call } = fixture;
    await db.prepare("insert into sources values('source_one','workspace_original',?)").bind(JSON.stringify({ id: "source_one", workspaceId: "workspace_original" })).run();
    async function run(id: string, key: string) {
      const value = { id, kind: "source_sync", workspaceId: "workspace_original", sourceId: "source_one", archiveRef: key, status: "running" };
      await db.prepare("insert into runs(id,space_id,source_id,type,status,lease_token,run_json) values(?,'workspace_original','source_one','source_sync','running','lease_original',?)").bind(id, JSON.stringify(value)).run();
    }
    const key = "allocated/source-before-final-snapshot";
    await run("sync_new", key);
    expect((await call({ operation: "runner", bucketRole: "source", runId: "sync_new", expectedLeaseToken: "lease_original", key })).status).toBe(200);
    const stored = await (await runtime.getR2Bucket("SOURCE")).get(key);
    expect(stored?.size).toBe(3);
    expect(await db.prepare("select count(*) as n from source_snapshots").first("n")).toBe(0);
    expect(await db.prepare("select owner from fixture_usage").first("owner")).toBe("workspace_original");
    await db.prepare("update runs set status='failed',lease_token=null,run_json=json_set(run_json,'$.status','failed') where id='sync_new'").run();
    const retainedSnapshot = await db.prepare("select snapshot from fixture_usage").first("snapshot");
    expect((await call({ operation: "runner", bucketRole: "source", runId: "sync_new", expectedLeaseToken: "lease_original", key })).status).toBe(503);
    expect(await db.prepare("select snapshot from fixture_usage").first("snapshot")).toBe(retainedSnapshot);
    expect((await (await runtime.getR2Bucket("SOURCE")).head(key))?.version).toBe(stored?.version);
    expect((await call({ operation: "runner", bucketRole: "source", runId: "sync_new", expectedLeaseToken: "lease_original", key: "allocated/forged" })).status).toBe(503);
    expect(await (await runtime.getR2Bucket("SOURCE")).head("allocated/forged")).toBeNull();
    await run("sync_taken", "allocated/taken-over");
    await db.prepare("insert into fixture_control values('swap_lease','sync_taken')").run();
    expect((await call({ operation: "runner", bucketRole: "source", runId: "sync_taken", expectedLeaseToken: "lease_original", key: "allocated/taken-over" })).status).toBe(503);
    expect(await (await runtime.getR2Bucket("SOURCE")).head("allocated/taken-over")).toBeNull();
    expect(await db.prepare("select count(*) as n from fixture_usage").first("n")).toBe(2);
    await run("sync_stale_before_first_lookup", "allocated/stale-before-lookup");
    await db.prepare("update runs set lease_token='lease_successor' where id='sync_stale_before_first_lookup'").run();
    expect((await call({ operation: "runner", bucketRole: "source", runId: "sync_stale_before_first_lookup", expectedLeaseToken: "lease_original", key: "allocated/stale-before-lookup" })).status).toBe(503);
    expect(await db.prepare("select count(*) as n from fixture_usage").first("n")).toBe(2);
    expect((await call({ operation: "backup" })).status).toBe(503);
    expect(await db.prepare("select count(*) as n from backups").first("n")).toBe(0);
    expect(await (await runtime.getR2Bucket("BACKUPS")).head("workspaces/workspace_original/backups/backup_prefinal/control.json.zst.enc")).toBeNull();
  } finally { await fixture.close(); }
}, 30_000);

test("native stored-service custody rechecks Source retirement before R2 deletion", async () => {
  const fixture = await nativeFixture();
  try {
    const { db, runtime, call } = fixture;
    await db.prepare("alter table sources add column status text").run();
    await db.prepare("alter table capsules add column source_id text").run();
    await db.prepare("alter table capsules add column status text").run();
    const workspaceId = "workspace_original", sourceId = "source_one";
    const key = `workspaces/${workspaceId}/sources/${sourceId}/snapshots/snap_one/source.tar.zst`;
    const source = { id: sourceId, workspaceId, status: "disabled", autoSync: false,
      retiringAt: "2026-10-28T00:00:00.000Z", ownerCapsuleId: "capsule_one" };
    await db.prepare("insert into sources(id,space_id,status,record_json) values(?,?,?,?)")
      .bind(sourceId, workspaceId, "disabled", JSON.stringify(source)).run();
    await db.prepare("insert into capsules(id,space_id,source_id,status) values(?,?,?,?)")
      .bind("capsule_one", workspaceId, sourceId, "destroyed").run();
    await db.prepare("insert into source_snapshots values(?,?,?)")
      .bind("snap_one", sourceId, JSON.stringify({ id: "snap_one", sourceId, workspaceId, archiveRef: key })).run();
    const bucket = await runtime.getR2Bucket("SOURCE");
    await bucket.put(key, "source bytes");
    const request = { operation: "retire", key,
      sourceRetirement: { workspaceId, sourceId, archiveRef: key } };
    await db.prepare("update capsules set status='active' where id='capsule_one'").run();
    expect((await call(request)).status).toBe(503);
    expect(await bucket.head(key)).not.toBeNull();
    await db.prepare("update capsules set status='destroyed' where id='capsule_one'").run();
    await db.prepare("insert into source_snapshots values(?,?,?)")
      .bind("snap_shared", "source_other", JSON.stringify({ id: "snap_shared", sourceId: "source_other", workspaceId: "workspace_other", archiveRef: key })).run();
    expect((await call(request)).status).toBe(503);
    expect(await bucket.head(key)).not.toBeNull();
    await db.prepare("delete from source_snapshots where id='snap_shared'").run();
    expect((await call(request)).status).toBe(200);
    expect(await bucket.head(key)).toBeNull();
  } finally { await fixture.close(); }
}, 30_000);

test("staging selection preserves the default; native runtime Version never falls back to a source var", async () => {
  const original = { TAKOSUMI_ENVIRONMENT: "production" } as StorageStagingEnv;
  expect(composeStorageStagingEnv(original)).toBe(original);
  expect(() => composeStorageStagingEnv({ ...original, TAKOSUMI_OSS_STORAGE_PROFILE: "stored-service-staging-v1" })).toThrow();
  const native = "01234567-89ab-cdef-0123-456789abcdef";
  expect(await readStorageRuntimeVersion({ TAKOSUMI_VERSION_METADATA: { id: native } })).toEqual({ versionIdSha256: await storedDigest(native) });
  expect(await readStorageRuntimeVersion({})).toBeNull();
  expect(await readStorageRuntimeVersion({ TAKOSUMI_VERSION_METADATA: { id: "source_commit_hash" } })).toBeNull();
  const allocator = new ObjectKeyArtifactReferenceAllocator();
  expect(createBackupStoredOwnerContext(allocator, undefined, undefined)).toEqual({ allocator, bucket: undefined });
});

test("native generation write requires canonical Plan, Capsule epoch and Run lease before the StateVersion exists", async () => {
  const fixture = await nativeFixture();
  try {
    const { db, runtime, call } = fixture;
    const workspaceId = "workspace_original", capsuleId = "capsule_one";
    const capsule = { id: capsuleId, workspaceId, environment: "live", currentStateGeneration: 0 };
    await db.prepare("insert into capsules values(?,?,'live',0,null,1,?)").bind(capsuleId, workspaceId, JSON.stringify(capsule)).run();
    const plan = { id: "plan_one", workspaceId, capsuleId, status: "succeeded", capsuleCurrentStateVersionId: null, capsuleExecutionAuthorityEpoch: 1, capsuleContext: { workspaceId, capsuleId, environment: "live" } };
    await db.prepare("insert into runs(id,space_id,installation_id,type,status,run_json) values(?,?,?,'plan','succeeded',?)").bind(plan.id, workspaceId, capsuleId, JSON.stringify(plan)).run();
    const apply = { id: "apply_one", workspaceId, capsuleId, planRunId: plan.id, status: "running", expected: { planRunId: plan.id, currentStateVersionId: null, capsuleExecutionAuthorityEpoch: 1 } };
    await db.prepare("insert into runs(id,space_id,installation_id,type,status,lease_token,run_json) values(?,?,?,'apply','running','lease_one',?)").bind(apply.id, workspaceId, capsuleId, JSON.stringify(apply)).run();
    const key = `workspaces/${workspaceId}/capsules/${capsuleId}/environments/live/state-versions/00000001.tfstate.enc`;
    const scope = { workspaceId, subjectKind: "capsule", subjectId: capsuleId, environment: "live", generation: 1, stateRef: key };
    const request = { operation: "runner", bucketRole: "state", runId: apply.id, expectedLeaseToken: "lease_one", key, scope };
    expect((await call({ ...request, scope: { ...scope, workspaceId: "workspace_forged" } })).status).toBe(503);
    expect(await db.prepare("select count(*) as n from fixture_usage").first("n")).toBe(0);
    expect((await call(request)).status).toBe(200);
    expect(await db.prepare("select count(*) as n from state_versions").first("n")).toBe(0);
    expect(await db.prepare("select owner from fixture_usage").first("owner")).toBe(workspaceId);
    expect((await (await runtime.getR2Bucket("STATE")).head(key))?.size).toBe(3);
    await db.prepare("update capsules set execution_authority_epoch=2").run();
    expect((await call({ ...request, key: key + ".execution-evidence.json" })).status).toBe(503);
    expect(await (await runtime.getR2Bucket("STATE")).head(key + ".execution-evidence.json")).toBeNull();
  } finally { await fixture.close(); }
}, 30_000);

test("native Workspace/ref-only backup capture has no accepted Backup Run mutation authority", async () => {
  const fixture = await nativeFixture();
  try {
    const { db, runtime, call } = fixture;
    expect((await call({ operation: "backup" })).status).toBe(503);
    const key = "workspaces/workspace_original/backups/backup_prefinal/control.json.zst.enc";
    const bucket = await runtime.getR2Bucket("BACKUPS");
    expect(await bucket.head(key)).toBeNull();
    expect(await db.prepare("select count(*) as n from backups").first("n")).toBe(0);
    expect((await call({ operation: "resolve", bucketRole: "backups", key })).body.result).toBeNull();
    expect(await db.prepare("select count(*) as n from fixture_usage").first("n")).toBe(0);
    expect((await call({ operation: "backup" })).status).toBe(503);
    expect(await bucket.head(key)).toBeNull();
    expect(await db.prepare("select count(*) as n from fixture_usage").first("n")).toBe(0);
    expect((await call({ operation: "resolve", bucketRole: "backups", key: key + "-unknown-before-profile" })).body.result).toBeNull();
  } finally { await fixture.close(); }
}, 30_000);

test("native private-file authority rejects original lease, epoch and freeze drift before custody or R2 effects", async () => {
  for (const mode of ["stale_before", "lease_during", "epoch_during", "freeze_during", "valid"] as const) {
    const fixture = await nativeFixture();
    try {
      const { db, runtime, call } = fixture;
      const workspaceId = "workspace_private", capsuleId = "capsule_private", runId = "plan_private";
      const scope = { workspaceId, capsuleId, environment: "live", slot: "checkpoint" };
      const authority = { runId, leaseToken: "lease_original", executionAuthorityEpoch: 1 };
      const run = { id: runId, workspaceId, capsuleId, environment: "live", status: "running", capsuleExecutionAuthorityEpoch: 1, workspaceManagementAuthority: { workspaceId, managementState: "active", managementEpoch: 1 } };
      await db.prepare("insert into workspaces values(?,'active',1)").bind(workspaceId).run();
      await db.prepare("insert into capsules values(?,?,'live',0,null,1,?)").bind(capsuleId, workspaceId, JSON.stringify({ id: capsuleId, workspaceId, environment: "live" })).run();
      await db.prepare("insert into runs(id,space_id,installation_id,environment,type,status,lease_token,run_json) values(?,?,?,'live','plan','running','lease_original',?)").bind(runId, workspaceId, capsuleId, JSON.stringify(run)).run();
      if (mode === "stale_before") await db.prepare("update runs set lease_token='lease_successor'").run();
      if (mode === "lease_during") await db.prepare("insert into fixture_control values('swap_lease',?)").bind(runId).run();
      if (mode === "epoch_during") await db.prepare("insert into fixture_control values('rotate_private','epoch')").run();
      if (mode === "freeze_during") await db.prepare("insert into fixture_control values('rotate_private','freeze')").run();
      const response = await call({ operation: "private", scope, authority });
      const bucket = await runtime.getR2Bucket("ARTIFACTS");
      const objects = await bucket.list();
      const intents = await db.prepare("select snapshot,request from fixture_usage").all<{ snapshot: string; request: string }>();
      if (mode === "valid") {
        expect(response.status).toBe(200);
        expect(objects.objects).toHaveLength(1);
        const object = await bucket.head(objects.objects[0]!.key);
        expect(Object.keys(object!.customMetadata!).sort()).toEqual(["byteLength", "digest", "format", "scope"]);
        expect(object!.size).toBe(32);
      } else {
        expect(response.status).toBe(503);
        expect(objects.objects).toHaveLength(0);
        expect(intents.results).toHaveLength(mode === "stale_before" ? 0 : 1);
        if (mode !== "stale_before") {
          const pending = JSON.parse(intents.results[0]!.snapshot);
          expect(pending.pending.state).toBe("pending");
          const request = JSON.parse(intents.results[0]!.request);
          expect(request.workspaceId).toBe(workspaceId);
          // Retry keeps the original authority; it cannot reacquire the newer
          // lease/epoch or settle the unknown existing custody intent.
          expect((await call({ operation: "private", scope, authority })).status).toBe(503);
          expect(await db.prepare("select snapshot from fixture_usage").first("snapshot")).toBe(intents.results[0]!.snapshot);
        }
      }
    } finally { await fixture.close(); }
  }
}, 30_000);
