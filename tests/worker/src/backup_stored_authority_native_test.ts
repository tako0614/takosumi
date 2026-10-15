import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CloudflareD1OpenTofuControlStore, ensureD1OpenTofuLedgerSchema } from "../../../worker/src/d1_opentofu_store.ts";
import type { D1Database } from "../../../worker/src/bindings.ts";
import { acquireControlD1MaintenanceFence, releaseControlD1MaintenanceFence } from "../../../worker/src/d1_schema_maintenance.ts";
import { seedCapsuleModel } from "../../helpers/deploy-control/model_fixture.ts";
import type { BackupArtifactWriteControl } from "../../../core/domains/backups/mod.ts";
import type { BackupRecord } from "takosumi-contract/backups";
import type { Run } from "takosumi-contract/runs";
import type { WorkspaceManagementAuthority } from "../../../core/domains/deploy-control/store.ts";

interface ServiceProof {
  readonly record: BackupRecord;
  readonly observed: readonly { readonly run: Run; readonly authority: WorkspaceManagementAuthority; readonly frozen: boolean }[];
  readonly controls: readonly BackupArtifactWriteControl[];
}

const ROOT = resolve(import.meta.dir, "../../..");
// The catalogue below is an isolated protocol fixture, not Hosted graph
// qualification. Admission, settlement, primary D1 reads, crypto and R2 are real.
const NATIVE = `
import { BackupsService } from ${JSON.stringify(join(ROOT, "core/domains/backups/mod.ts"))};
import { CloudflareD1OpenTofuControlStore } from ${JSON.stringify(join(ROOT, "worker/src/d1_opentofu_store.ts"))};
import { createBackupStoredOwnerContext } from ${JSON.stringify(join(ROOT, "worker/src/stored-service-owner-context.ts"))};
import { createStoredObjectOwnerResolver } from ${JSON.stringify(join(ROOT, "worker/src/stored-object-owner-resolver.ts"))};
import { ObjectKeyArtifactReferenceAllocator } from ${JSON.stringify(join(ROOT, "core/adapters/storage/artifact-references.ts"))};
import { R2BackupArtifactStore } from ${JSON.stringify(join(ROOT, "worker/src/backup_artifact_store.ts"))};
import { StateArtifactCrypto } from ${JSON.stringify(join(ROOT, "worker/src/state_crypto.ts"))};
const digest='sha256:'+'a'.repeat(64), now='2026-10-14T00:00:00.000Z';
async function mutate(env, action, runId) {
  if(action==='terminal') await env.DB.prepare("update runs set status='failed',run_json=json_set(run_json,'$.status','failed','$.finishedAt',?) where id=?").bind(now,runId).run();
  else if(action==='replace') await env.DB.prepare("update runs set created_at='2026-10-13T00:00:00.000Z',run_json=json_set(run_json,'$.createdAt','2026-10-13T00:00:00.000Z') where id=?").bind(runId).run();
  else if(action==='type') await env.DB.prepare("update runs set type='apply',run_json=json_set(run_json,'$.type','apply') where id=?").bind(runId).run();
  else if(action==='management') await env.DB.prepare("update runs set run_json=json_set(run_json,'$.workspaceManagementAuthority.managementEpoch',2) where id=?").bind(runId).run();
  else if(action==='lease') await env.DB.prepare("update runs set lease_token='synthetic-not-admitted' where id=?").bind(runId).run();
  else if(action==='maintenance') await env.DB.prepare("update _takosumi_control_schema_maintenance set active=1,released_at=null where singleton=1").run();
  else if(action==='missing_index') await env.DB.prepare("drop index backups_created_by_run_id_idx").run();
  else if(action==='future_head') await env.DB.prepare("insert into schema_migrations values(75,'unknown_future',?,?)").bind('sha256:'+'f'.repeat(64),now).run();
  else if(action==='wrong_expression') {
    await env.DB.prepare("drop index backups_legacy_created_by_run_text_idx").run();
    await env.DB.prepare("create index backups_legacy_created_by_run_text_idx on backups((cast((case when json_valid(record_json) = 1 then json_extract(record_json, '$.createdbyrunid') else null end) as text)))").run();
  }
  else if(action==='drain') await env.DB.prepare("update workspaces set management_state='draining',management_epoch=management_epoch+1 where id='workspace_backup'").run();
  else if(action) throw new Error('unknown fixture mutation');
}
function composition(env, input) {
  const usage={
    async readStoredSource() {return {sourceRef:'source_backups',epochRef:'epoch_one',qualificationDigest:digest};},
    async readStoredObject(input) {
      const row=await env.DB.prepare('select snapshot from fixture_usage where object_ref=?').bind(input.objectRef).first();
      return row?JSON.parse(row.snapshot):{workspaceId:input.workspaceId,revision:0,bytes:'0',versionDigest:null};
    },
    async prepareStoredObject(request) {
      // Every PREPARE must still precede final Core BackupRecord publication.
      const records=await env.DB.prepare('select count(*) as n from backups').first();
      if(records.n!==0) throw new Error('unexpected final backup publication');
      const intent={operationRef:request.operationRef,expectedRevision:request.expectedRevision,kind:'put',bytes:request.desired.bytes,contentDigest:request.desired.contentDigest,state:'pending'};
      const snapshot={workspaceId:request.workspaceId,revision:0,bytes:'0',versionDigest:null,pending:intent};
      await env.DB.prepare('insert into fixture_usage values(?,?,?,?)').bind(request.objectRef,request.workspaceId,JSON.stringify(snapshot),JSON.stringify(request)).run();
      await mutate(env,input.duringPrepare,input.runId);
      return {dispatch:true,intent,dispatchToken:'f'.repeat(64)};
    },
    async confirmStoredObject(input) {
      if(input.workspaceId!=='workspace_backup') throw new Error('foreign owner');
      const row=await env.DB.prepare('select request from fixture_usage where object_ref=?').bind(input.objectRef).first();
      const request=JSON.parse(row.request);
      if(request.desired===null) throw new Error('unexpected deletion');
      if(input.operationRef!==request.operationRef) throw new Error('foreign operation');
      if(input.dispatchToken!=='f'.repeat(64)) throw new Error('foreign dispatch');
      if(env.FAIL_CONFIRM==='yes') throw new Error('lost acknowledgement');
      await env.DB.prepare('update fixture_usage set snapshot=? where object_ref=?').bind(JSON.stringify({workspaceId:input.workspaceId,revision:1,bytes:request.desired.bytes,versionDigest:input.newVersionDigest}),input.objectRef).run();
    },
    async cancelStoredObject() {throw new Error('unexpected cancellation');}
  };
  const originalOwners={async readOriginalStoredObjectOwner(input) {
    if(Object.keys(input).sort().join(',')!=='bucketRole,objectRef') throw new Error('caller ownership assertion');
    const row=await env.DB.prepare('select owner,request from fixture_usage where object_ref=?').bind(input.objectRef).first();
    if(!row) return null;
    const request=JSON.parse(row.request);
    return {workspaceId:row.owner,sourceRef:request.sourceRef,epochRef:'epoch_one',qualificationDigest:digest};
  }};
  const owners=createStoredObjectOwnerResolver({database:env.DB,buckets:{backups:env.BACKUPS},sources:usage,originalOwners});
  return {usage,owners};
}
export default {async fetch(request, env) {
  const input=await request.json();
  const store=new CloudflareD1OpenTofuControlStore(env.DB,{schemaMode:'predeployed'});
  const comp=composition(env,input);
  if(input.operation==='resolve') return Response.json(await comp.owners.resolveStoredObjectOwner({bucketRole:'backups',key:input.key}));
  const context=createBackupStoredOwnerContext(new ObjectKeyArtifactReferenceAllocator(),comp,env.BACKUPS,env.DB);
  const artifactStore=new R2BackupArtifactStore(context.bucket,StateArtifactCrypto.fromEnv({TAKOSUMI_SECRET_STORE_PASSPHRASE:'native-backup-artifact-test-passphrase-0123456789'}),context.writeBucket);
  try {
    let result;
    if(input.operation==='service') {
      const observed=[];
      const wrappedStore=new Proxy(store,{get(target,key) {
        if(key==='beginBackupRun') return async (run,authority)=>{
          const original=structuredClone(authority);
          const admission=await target.beginBackupRun(run,authority);
          if(admission.status==='created') {
            input.runId=admission.run.id;
            observed.push({run:admission.run,authority:original,frozen:Object.isFrozen(authority)});
            await mutate(env,input.afterAdmission,admission.run.id);
          }
          return admission;
        };
        const value=Reflect.get(target,key); return typeof value==='function'?value.bind(target):value;
      }});
      let counter=0;
      const controls=[];
      const captured={
        async put(input) {controls.push(structuredClone(input.writeControl));return await artifactStore.put(input);},
        async putPlain(input) {controls.push(structuredClone(input.writeControl));return await artifactStore.putPlain(input);}
      };
      const service=new BackupsService({store:wrappedStore,artifactReferenceAllocator:context.allocator,artifactStore:captured,stateObjectReader:{async get(){return new TextEncoder().encode('SEALED-ORIGINAL-STATE');}},now:()=>new Date(now),newId:prefix=>prefix+'_'+(++counter)});
      result={record:await service.createBackup({workspaceId:'workspace_backup'}),observed,controls};
    } else if(input.operation==='put') {
      const authority={workspaceId:'workspace_backup',managementState:'active',managementEpoch:1};
      const run={id:input.runId,workspaceId:'workspace_backup',type:'backup',status:'running',createdBy:'system',createdAt:now,startedAt:now};
      const admission=await store.beginBackupRun(run,authority);
      if(admission.status!=='created') throw new Error('not admitted');
      const allocation={kind:input.kind??'backup_control',workspaceId:'workspace_backup',backupId:'backup_'+input.runId};
      const ref=await context.allocator.allocate(allocation);
      const control={expectedRunningRun:admission.run,expectedWorkspaceManagementAuthority:authority,allocation:{kind:allocation.kind,backupId:allocation.backupId,ref}};
      if(input.invalid==='allocation') control.allocation.kind='backup_state';
      if(input.invalid==='backupId') control.allocation.backupId='different_backup';
      if(input.invalid==='ref') control.allocation.ref='different/ref';
      if(input.invalid==='workspace') control.expectedRunningRun.workspaceId='workspace_forged';
      if(input.invalid==='management') control.expectedWorkspaceManagementAuthority.managementEpoch=2;
      if(input.invalid==='type') control.expectedRunningRun.type='apply';
      await mutate(env,input.before,input.runId);
      if(input.invalid==='settled') await env.DB.prepare("insert into backups(id,space_id,record_json,created_at) values(?,'workspace_backup','{}',?)").bind(allocation.backupId,now).run();
      if(input.invalid==='settled_other_id') await env.DB.prepare("insert into backups(id,space_id,created_by_run_id,record_json,created_at) values(?,'workspace_backup',?,'{}',?)").bind('other_'+allocation.backupId,input.runId,now).run();
      if(input.invalid==='legacy_record') await env.DB.prepare("insert into backups(id,space_id,record_json,created_at) values(?,'workspace_backup',?,?)").bind('legacy_'+allocation.backupId,JSON.stringify({createdByRunId:input.runId}),now).run();
      if(input.invalid==='malformed_record') await env.DB.prepare("insert into backups(id,space_id,created_by_run_id,record_json,created_at) values(?,'workspace_backup',?,'malformed-json',?)").bind('corrupt_'+allocation.backupId,input.runId,now).run();
      const bytes=new Uint8Array([1,2,3,4]);
      const put=allocation.kind==='backup_artifacts_manifest'?artifactStore.putPlain.bind(artifactStore):artifactStore.put.bind(artifactStore);
      const pending=put({ref,payload:bytes,contentType:'application/octet-stream',...(input.invalid==='missing'?{}:{writeControl:control})});
      if(input.mutateCaller) {control.expectedRunningRun.workspaceId='workspace_forged';control.expectedWorkspaceManagementAuthority.managementEpoch=999;control.allocation.ref='forged';bytes.fill(9);}
      result=await pending;
    } else if(input.operation==='unproved') {
      const ref=await context.allocator.allocate({kind:'backup_control',workspaceId:'workspace_backup',backupId:'backup_unproved'});
      await context.bucket.put(ref,new Uint8Array([1]));
    } else throw new Error('unknown fixture operation');
    return Response.json({result});
  } catch(error) {return Response.json({error:error instanceof Error?error.message:String(error)},{status:503});}
}};
`;

async function fixture(options: { readonly failConfirm?: boolean; readonly capsule?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "takosumi-backup-authority-"));
  const entry = join(directory, "entry.ts");
  await writeFile(entry, NATIVE);
  const built = await Bun.build({ entrypoints: [entry], outdir: directory, target: "browser", format: "esm", external: ["cloudflare:workers"] });
  if (!built.success) throw new Error(built.logs.map(log => log.message).join("\n"));
  const runtime = new Miniflare({ modules: [{ type: "ESModule", path: "backup-native.mjs", contents: await built.outputs[0]!.text() }], compatibilityDate: "2026-06-01", d1Databases: { DB: "backup-native" }, r2Buckets: ["BACKUPS"], bindings: { FAIL_CONFIRM: options.failConfirm ? "yes" : "no" } });
  try {
    const db = await runtime.getD1Database("DB");
    await ensureD1OpenTofuLedgerSchema(db as unknown as D1Database);
    const maintenance = await acquireControlD1MaintenanceFence(db as unknown as D1Database, {
      sourceCommit: "a".repeat(40), manifestDigest: "sha256:" + "b".repeat(64), environment: "backup-native-test", databaseRole: "in_place", releasePolicy: "in_place",
    }, "2026-10-14T00:00:00.000Z");
    await releaseControlD1MaintenanceFence(db as unknown as D1Database, maintenance, "2026-10-14T00:01:00.000Z");
    await db.prepare("create table fixture_usage(object_ref text primary key,owner text,snapshot text,request text)").run();
    const store = new CloudflareD1OpenTofuControlStore(db as unknown as D1Database, { schemaMode: "predeployed" });
    if (options.capsule) {
      const seeded = await seedCapsuleModel(store, { workspaceId: "workspace_backup", installConfig: { backup: { enabled: true, mode: "artifact_export", outputPath: "backup.artifact" } } });
      await store.putStateVersion({ id: "state_backup", workspaceId: "workspace_backup", capsuleId: seeded.capsule.id, environment: seeded.capsule.environment, generation: 1, stateRef: "original/state/encrypted", digest: "sha256:" + "b".repeat(64), createdByRunId: "apply_original", createdAt: "2026-10-14T00:00:00.000Z" });
      await store.putOutput({ id: "output_backup", workspaceId: "workspace_backup", capsuleId: seeded.capsule.id, stateGeneration: 1, rawArtifactRef: "original/output/encrypted", publicOutputs: {}, workspaceOutputs: { backup: { artifact: { ref: "external-provider://original-export", digest: "sha256:" + "c".repeat(64), sizeBytes: 123 } } }, outputDigest: "sha256:" + "d".repeat(64), createdAt: "2026-10-14T00:00:00.000Z" });
    } else {
      await store.putWorkspace({ id: "workspace_backup", handle: "workspace-backup", displayName: "Backup authority fixture", type: "personal", ownerUserId: "original_owner", createdAt: "2026-10-14T00:00:00.000Z", updatedAt: "2026-10-14T00:00:00.000Z" });
    }
    const call = async <T = unknown>(input: unknown) => {
      const response = await runtime.dispatchFetch("http://fixture.test", { method: "POST", body: JSON.stringify(input) });
      return { status: response.status, body: await response.json() as T };
    };
    return { db, store, runtime, call, async close() { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); } };
  } catch (error) { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); throw error; }
}

test("genuine native Core Backup admission writes all four artifacts and settles during accepted drain", async () => {
  const f = await fixture({ capsule: true });
  try {
    const response = await f.call<{ result: ServiceProof }>({ operation: "service", afterAdmission: "drain" });
    expect(response).toMatchObject({ status: 200 });
    const { record, observed, controls } = response.body.result;
    expect(observed).toHaveLength(1);
    expect(observed[0].frozen).toBe(true);
    expect(observed[0].authority).toEqual({ workspaceId: "workspace_backup", managementState: "active", managementEpoch: 1 });
    expect(controls.map(control => control.allocation.kind).sort()).toEqual(["backup_artifacts_manifest", "backup_control", "backup_service_data", "backup_state"]);
    expect(controls.every(control => JSON.stringify(control.expectedRunningRun) === JSON.stringify(observed[0]!.run))).toBe(true);
    expect(controls.every(control => control.allocation.backupId === record.id)).toBe(true);
    const objects = await (await f.runtime.getR2Bucket("BACKUPS")).list();
    expect(objects.objects).toHaveLength(4);
    expect(objects.objects.every(object => object.size > 0)).toBe(true);
    expect(objects.objects.map(object => object.key).sort()).toEqual([record.ref, record.stateArchive.ref, record.artifactsManifest.ref, record.serviceData.ref].sort());
    const rows = await f.db.prepare("select owner,snapshot,request from fixture_usage").all<{ owner: string; snapshot: string; request: string }>();
    expect(rows.results).toHaveLength(4);
    expect(rows.results.every(row => row.owner === "workspace_backup" && JSON.parse(row.snapshot).revision === 1 && JSON.parse(row.request).writerId === "control-backup")).toBe(true);
    expect(await f.db.prepare("select lease_token from runs where id=?").bind(record.createdByRunId).first("lease_token")).toBeNull();
    expect(await f.db.prepare("select status from runs where id=?").bind(record.createdByRunId).first("status")).toBe("succeeded");
    expect(await f.store.getWorkspaceManagement("workspace_backup")).toEqual({ workspaceId: "workspace_backup", managementState: "draining", managementEpoch: 2 });
  } finally { await f.close(); }
}, 60_000);

test("native Backup rejects stale or forged accepted-work witnesses before PREPARE and native effects", async () => {
  const f = await fixture();
  try {
    const negatives = [
      ...["terminal", "replace", "type", "management", "lease"].map(before => ({ before })),
      ...["allocation", "backupId", "ref", "workspace", "management", "type", "missing", "settled", "settled_other_id", "legacy_record", "malformed_record"].map(invalid => ({ invalid })),
    ];
    for (const [index, negative] of negatives.entries()) {
      const response = await f.call({ operation: "put", runId: "backup_negative_" + index, ...negative });
      expect(response.status).toBe(503);
      expect(await f.db.prepare("select count(*) as n from runs where id=?").bind("backup_negative_" + index).first("n")).toBe(1);
      expect(await f.db.prepare("select count(*) as n from fixture_usage").first("n")).toBe(0);
      expect((await (await f.runtime.getR2Bucket("BACKUPS")).list()).objects).toHaveLength(0);
    }
    expect((await f.call({ operation: "unproved" })).status).toBe(503);
    expect(await f.db.prepare("select count(*) as n from fixture_usage").first("n")).toBe(0);
  } finally { await f.close(); }
}, 60_000);

test("native Backup rechecks original Run and management after PREPARE; pending custody never reacquires", async () => {
  const f = await fixture();
  try {
    for (const [index, duringPrepare] of ["terminal", "replace", "type", "management", "lease"].entries()) {
      const runId = "backup_interleave_" + index;
      expect((await f.call({ operation: "put", runId, duringPrepare })).status).toBe(503);
      const rows = await f.db.prepare("select owner,snapshot from fixture_usage").all<{ owner: string; snapshot: string }>();
      expect(rows.results).toHaveLength(index + 1);
      expect(rows.results.every(row => row.owner === "workspace_backup" && JSON.parse(row.snapshot).pending.state === "pending")).toBe(true);
      expect((await (await f.runtime.getR2Bucket("BACKUPS")).list()).objects).toHaveLength(0);
    }
  } finally { await f.close(); }
}, 60_000);

test("native Backup freezes the caller before sealing and accepts an original Run across prepare-time drain", async () => {
  const f = await fixture();
  try {
    const response = await f.call({ operation: "put", runId: "backup_original", kind: "backup_artifacts_manifest", duringPrepare: "drain", mutateCaller: true });
    expect(response).toMatchObject({ status: 200 });
    const object = await (await f.runtime.getR2Bucket("BACKUPS")).get("workspaces/workspace_backup/backups/backup_backup_original/artifacts.manifest.json");
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(await f.db.prepare("select status from runs where id='backup_original'").first("status")).toBe("running");
    expect(await f.store.getWorkspaceManagement("workspace_backup")).toEqual({ workspaceId: "workspace_backup", managementState: "draining", managementEpoch: 2 });
    const snapshot = await f.db.prepare("select snapshot from fixture_usage").first<string>("snapshot");
    expect(JSON.parse(snapshot!).revision).toBe(1);
  } finally { await f.close(); }
}, 60_000);

test("a partial native Backup with lost ACK retains original preledger owner for a cold resolver", async () => {
  const f = await fixture({ failConfirm: true, capsule: true });
  try {
    const response = await f.call({ operation: "service" });
    expect(response.status).toBe(503);
    const objects = await (await f.runtime.getR2Bucket("BACKUPS")).list();
    expect(objects.objects).toHaveLength(1);
    expect(await f.db.prepare("select count(*) as n from backups").first("n")).toBe(0);
    expect(await f.db.prepare("select status from runs where type='backup'").first("status")).toBe("failed");
    await f.db.prepare("delete from workspaces where id='workspace_backup'").run();
    expect(await f.call({ operation: "resolve", key: objects.objects[0]!.key })).toEqual({ status: 200, body: { workspaceId: "workspace_backup" } });
    const retained = await f.db.prepare("select snapshot from fixture_usage").first<string>("snapshot");
    expect(JSON.parse(retained!).pending.state).toBe("pending");
    expect(JSON.parse(retained!).revision).toBe(0);
    expect(objects.objects[0]!.size).toBeGreaterThan(0);
  } finally { await f.close(); }
}, 60_000);


test("native Backup warm readiness refuses maintenance, index drift or a future head before PREPARE and after its ACK", async () => {
  for (const action of ["maintenance", "missing_index", "wrong_expression", "future_head"]) for (const timing of ["before", "duringPrepare"] as const) {
    const f = await fixture();
    try {
      // Warm the actual indexed helper through a genuine admitted Backup PUT.
      expect((await f.call({ operation: "put", runId: "backup_warm" })).status).toBe(200);
      const prior = await (await f.runtime.getR2Bucket("BACKUPS")).list();
      const response = await f.call({ operation: "put", runId: "backup_readiness", [timing]: action });
      expect(response.status, `${action}/${timing}`).toBe(503);
      expect((await (await f.runtime.getR2Bucket("BACKUPS")).list()).objects.map(object => object.version)).toEqual(prior.objects.map(object => object.version));
      expect(await f.db.prepare("select count(*) as n from fixture_usage").first("n")).toBe(timing === "before" ? 1 : 2);
      if (timing === "duringPrepare") {
        const rows = await f.db.prepare("select snapshot from fixture_usage").all<{ snapshot: string }>();
        expect(rows.results.filter(row => JSON.parse(row.snapshot).pending?.state === "pending")).toHaveLength(1);
      }
    } finally { await f.close(); }
  }
}, 60_000);
