import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  storedNativeVersion,
  storedObjectReference,
  type StoredBucketRole,
} from "../../../worker/src/stored-service-usage.ts";

// This is an isolated protocol fixture, not the Hosted custody implementation.
// D1 makes its intent/token/ACK state durable across actual workerd RPC calls.
const RECEIVER = String.raw`
  import { WorkerEntrypoint } from "cloudflare:workers";
  const source = role => "source_" + role;
  async function control(db, name) {
    return (await db.prepare("SELECT value FROM fixture_controls WHERE name=?").bind(name).first())?.value;
  }
  async function audit(db, method, input) {
    await db.prepare("INSERT INTO fixture_audit(method,input) VALUES(?,?)").bind(method,JSON.stringify(input)).run();
  }
  async function object(db, input) {
    const row = await db.prepare("SELECT * FROM fixture_objects WHERE role=? AND object_ref=?").bind(input.bucketRole,input.objectRef).first();
    if (!row || row.workspace !== input.workspaceId || row.source_ref !== input.sourceRef) throw new Error("synthetic foreign or unregistered object");
    return row;
  }
  function intent(row) {
    return {...JSON.parse(row.intent),state:row.state};
  }
  export class Custody extends WorkerEntrypoint {
    async readStoredSource(input) {
      await audit(this.env.DB,"readStoredSource",input);
      if (await control(this.env.DB,"stall_source") === "yes") await new Promise(resolve=>setTimeout(resolve,17_000));
      return {sourceRef:source(input.bucketRole),epochRef:"inventory_one",qualificationDigest:"sha256:"+"a".repeat(64)};
    }
    async readStoredObject(input) {
      await audit(this.env.DB,"readStoredObject",input);
      const row = await object(this.env.DB,input);
      const pending = row.pending_ref ? await this.env.DB.prepare("SELECT * FROM fixture_intents WHERE operation_ref=?").bind(row.pending_ref).first() : null;
      const snapshot = {workspaceId:row.workspace,revision:row.revision,bytes:row.bytes,versionDigest:row.version_digest,...(pending?{pending:intent(pending)}:{})};
      // Both contenders retain the same pre-intent snapshot. The winner then
      // pauses before sending R2; the loser must refuse its dispatch=false DTO.
      if (await control(this.env.DB,"snapshot_barrier") === "yes") {
        await this.env.DB.prepare("UPDATE fixture_controls SET value=CAST(value AS INTEGER)+1 WHERE name='snapshot_readers'").run();
        while (Number(await control(this.env.DB,"snapshot_readers")) < 2) await new Promise(resolve=>setTimeout(resolve,2));
      }
      return snapshot;
    }
    async prepareStoredObject(input) {
      await audit(this.env.DB,"prepareStoredObject",input);
      const row = await object(this.env.DB,input);
      const previous = await this.env.DB.prepare("SELECT * FROM fixture_intents WHERE operation_ref=?").bind(input.operationRef).first();
      if (previous) {
        if (previous.request !== JSON.stringify(input)) throw new Error("synthetic mutation conflict");
        return {dispatch:false,intent:intent(previous)};
      }
      if (row.revision !== input.expectedRevision || row.version_digest !== input.expectedVersionDigest || row.pending_ref) throw new Error("synthetic CAS conflict");
      const prepared = {operationRef:input.operationRef,expectedRevision:input.expectedRevision,kind:input.desired===null?"delete":"put",bytes:input.desired?.bytes??"0",contentDigest:input.desired?.contentDigest??null,state:"pending"};
      const token = Array.from(crypto.getRandomValues(new Uint8Array(32)),byte=>byte.toString(16).padStart(2,"0")).join("");
      const writes = await this.env.DB.batch([
        this.env.DB.prepare("INSERT INTO fixture_intents(operation_ref,request,intent,token,state) SELECT ?,?,?,?,'pending' FROM fixture_objects WHERE role=? AND object_ref=? AND revision=? AND version_digest IS ? AND pending_ref IS NULL ON CONFLICT(operation_ref) DO NOTHING")
          .bind(input.operationRef,JSON.stringify(input),JSON.stringify(prepared),token,input.bucketRole,input.objectRef,input.expectedRevision,input.expectedVersionDigest),
        this.env.DB.prepare("UPDATE fixture_objects SET pending_ref=? WHERE role=? AND object_ref=? AND revision=? AND pending_ref IS NULL AND EXISTS(SELECT 1 FROM fixture_intents WHERE operation_ref=? AND token=?)")
          .bind(input.operationRef,input.bucketRole,input.objectRef,input.expectedRevision,input.operationRef,token),
      ]);
      if (writes[0].meta.changes !== 1) {
        const winner = await this.env.DB.prepare("SELECT * FROM fixture_intents WHERE operation_ref=?").bind(input.operationRef).first();
        if (!winner || winner.request !== JSON.stringify(input)) throw new Error("synthetic CAS loser");
        return {dispatch:false,intent:intent(winner)};
      }
      if (writes[1].meta.changes !== 1) throw new Error("fixture did not persist its winning intent");
      if (await control(this.env.DB,"prepare_ack") === "lost") throw new Error("synthetic lost prepare ACK after commit");
      return {dispatch:true,intent:prepared,dispatchToken:token};
    }
    async confirmStoredObject(input) {
      await audit(this.env.DB,"confirmStoredObject",input);
      const row = await object(this.env.DB,input);
      const pending = await this.env.DB.prepare("SELECT * FROM fixture_intents WHERE operation_ref=?").bind(input.operationRef).first();
      if (!pending || pending.token !== input.dispatchToken || pending.state !== "pending" || row.pending_ref !== input.operationRef) throw new Error("synthetic token refusal");
      const original = JSON.parse(pending.request);
      for (const field of ["sourceRef","bucketRole","writerId","workspaceId","objectRef"]) if (original[field] !== input[field]) throw new Error("synthetic context refusal");
      if (await control(this.env.DB,"confirm_ack") === "before") throw new Error("synthetic uncommitted confirm ACK");
      const writes = await this.env.DB.batch([
        this.env.DB.prepare("UPDATE fixture_objects SET revision=revision+1,bytes=?,version_digest=?,pending_ref=NULL WHERE role=? AND object_ref=? AND pending_ref=?")
          .bind(original.desired?.bytes??"0",input.newVersionDigest,input.bucketRole,input.objectRef,input.operationRef),
        this.env.DB.prepare("UPDATE fixture_intents SET state='confirmed',ack=? WHERE operation_ref=? AND token=? AND state='pending'").bind(input.acknowledgementDigest,input.operationRef,input.dispatchToken),
      ]);
      if (writes.some(write=>write.meta.changes!==1)) throw new Error("fixture confirmation race");
      if (await control(this.env.DB,"confirm_ack") === "after") throw new Error("synthetic committed confirm ACK loss");
    }
    async cancelStoredObject(input) {
      await audit(this.env.DB,"cancelStoredObject",input);
      const row = await object(this.env.DB,input);
      const pending = await this.env.DB.prepare("SELECT * FROM fixture_intents WHERE operation_ref=?").bind(input.operationRef).first();
      if (!pending || pending.token!==input.dispatchToken || pending.state!=="pending" || row.pending_ref!==input.operationRef || row.version_digest!==input.observedVersionDigest) throw new Error("synthetic cancellation refusal");
      await this.env.DB.batch([
        this.env.DB.prepare("UPDATE fixture_objects SET pending_ref=NULL,revision=revision+1 WHERE role=? AND object_ref=? AND pending_ref=?").bind(input.bucketRole,input.objectRef,input.operationRef),
        this.env.DB.prepare("UPDATE fixture_intents SET state='cancelled',ack=? WHERE operation_ref=? AND token=?").bind(input.refusalAcknowledgementDigest,input.operationRef,input.dispatchToken),
      ]);
    }
    async resolveStoredObjectOwner(input) {
      await audit(this.env.DB,"resolveStoredObjectOwner",input);
      const owner = await this.env.DB.prepare("SELECT workspace FROM fixture_owners WHERE role=? AND key=?").bind(input.bucketRole,input.key).first();
      return owner ? {workspaceId:owner.workspace} : null;
    }
    async readStoredInventoryFence(input) {
      await audit(this.env.DB,"readStoredInventoryFence",input);
      const row = await this.env.DB.prepare("SELECT value FROM fixture_fences WHERE role=?").bind(input.bucketRole).first();
      if (!row) return null;
      const value = JSON.parse(row.value);
      if (await control(this.env.DB,"fence_race") === "yes") {
        const count = await this.env.DB.prepare("SELECT count(*) AS n FROM fixture_audit WHERE method='readStoredInventoryFence'").first();
        if (count.n > 1) value.fenceDigest="sha256:"+"b".repeat(64);
      }
      return value;
    }
  }
  // Native R2 can truncate early for response-byte limits. Keep real R2 and
  // its actual cursors, but request two entries behind this plain fixture port
  // so the actual inventory Worker receives short, still-truncated pages.
  export class ShortStatePages extends WorkerEntrypoint {
    async list(options) {
      await audit(this.env.DB,"inventoryNativeList",options);
      const page = await this.env.STATE.list({...options,limit:2});
      return {...page,objects:page.objects.map(object=>({key:object.key,size:object.size,etag:object.etag,version:object.version,uploaded:object.uploaded,httpMetadata:object.httpMetadata,customMetadata:object.customMetadata}))};
    }
  }
  export default {fetch(){return new Response(null,{status:404})}};
`;

let bundles: Promise<{ caller: string; inventory: string }> | undefined;
async function buildBundles() {
  if (bundles) return await bundles;
  bundles = (async () => {
    const dir = await mkdtemp(join(tmpdir(), "takosumi-stored-service-build-"));
    try {
      const usage = fileURLToPath(new URL("../../../worker/src/stored-service-usage.ts", import.meta.url));
      const inventory = fileURLToPath(new URL("../../../worker/src/stored-service-inventory-worker.ts", import.meta.url));
      const entry = join(dir, "caller.ts");
      await Bun.write(entry, `
        import {storedServiceUsageBucket,storedServiceCompositionFromEnv} from ${JSON.stringify(usage)};
        const bindings={state:"STATE",artifacts:"ARTIFACTS",source:"SOURCE",backups:"BACKUPS"};
        async function control(db,name){return (await db.prepare("SELECT value FROM fixture_controls WHERE name=?").bind(name).first())?.value}
        async function event(db,kind,role,key){await db.prepare("INSERT INTO fixture_effects(kind,role,key) VALUES(?,?,?)").bind(kind,role,key).run()}
        export default {async fetch(request,env){
          const input=await request.json();const role=input.role??"state";const key=input.key??"objects/value";
          try{
            if(input.action==="inventory")return Response.json(await env.INVENTORY.readStoredInventoryPage(input.page));
            if(input.action==="inventory-http")return new Response(null,{status:(await env.INVENTORY.fetch("https://fixture.test/ingest")).status});
            if(input.action==="composition"){
              storedServiceCompositionFromEnv({TAKOSUMI_STORED_SERVICE_USAGE:env.CUSTODY,...(input.owners?{TAKOSUMI_STORED_OBJECT_OWNERS:env.CUSTODY}:{}),...(input.legacy?{TAKOSUMI_ARTIFACT_STORAGE_USAGE:{}}:{})});
              return Response.json({composed:true});
            }
            const native=env[bindings[role]];
            const raw={
              async get(k){await event(env.DB,"get",role,k);return await native.get(k)},
              async head(k){await event(env.DB,"head",role,k);const object=await native.head(k);return object&&input.missingVersion?{key:object.key,size:object.size,etag:object.etag,uploaded:object.uploaded,httpMetadata:object.httpMetadata,customMetadata:object.customMetadata}:object},
              list:o=>native.list(o),
              async put(k,value,options){
                if(await control(env.DB,"pause_dispatch")==="yes"){
                  await env.DB.prepare("INSERT INTO fixture_controls VALUES('dispatch_waiting','yes') ON CONFLICT(name) DO UPDATE SET value='yes'").run();
                  while(await control(env.DB,"pause_dispatch")==="yes")await new Promise(resolve=>setTimeout(resolve,2));
                }
                await event(env.DB,"put",role,k);
                const effect=await native.put(k,value,await control(env.DB,"refuse_put")==="yes"?{...options,onlyIf:{etagMatches:"never-current-etag"}}:options);
                if(await control(env.DB,"put_ack")==="lost")throw new Error("synthetic lost native PUT ACK");
                return effect;
              },
              async delete(k){await event(env.DB,"delete",role,k);await native.delete(k);if(await control(env.DB,"delete_ack")==="lost")throw new Error("synthetic lost native DELETE ACK")},
            };
            const composition=input.selfHost?undefined:{usage:env.CUSTODY,owners:env.CUSTODY};
            const bucket=storedServiceUsageBucket(raw,composition,{bucketRole:role,writerId:"test-writer",maxBytes:1024*1024});
            if(input.action==="delete"){await bucket.delete(key);return Response.json({deleted:true})}
            const object=input.action==="get"?await bucket.get(key):input.action==="head"?await bucket.head(key):await bucket.put(key,input.value??"value",input.options??{});
            return Response.json(object?{key:object.key,size:object.size,version:object.version,httpMetadata:object.httpMetadata,customMetadata:object.customMetadata,...(input.action==="get"?{text:new TextDecoder().decode(await object.arrayBuffer())}:{})}:null);
          }catch(error){return Response.json({error:error.message},{status:503})}
        }};
      `);
      const result = await Promise.all([entry, inventory].map(async path => {
        const build = await Bun.build({ entrypoints: [path], target: "browser", format: "esm", external: ["cloudflare:workers"] });
        if (!build.success || build.outputs.length !== 1) throw new Error("stored service native build failed");
        return await build.outputs[0]!.text();
      }));
      return { caller: result[0]!, inventory: result[1]! };
    } finally { await rm(dir, { recursive: true, force: true }); }
  })();
  return await bundles;
}

const ROLES: readonly StoredBucketRole[] = ["state", "artifacts", "source", "backups"];
const BINDINGS = { state: "STATE", artifacts: "ARTIFACTS", source: "SOURCE", backups: "BACKUPS" } as const;
const digest = `sha256:${"a".repeat(64)}`;
const worker = (name: string, contents: string) => ({ name, compatibilityDate: "2026-07-17", modules: [{ type: "ESModule" as const, path: name + ".mjs", contents }] });

async function fixture() {
  const built = await buildBundles();
  const buckets = Object.fromEntries(ROLES.map(role => [BINDINGS[role], "stored-native-" + role]));
  const runtime = new Miniflare({ workers: [
    { ...worker("caller", built.caller), r2Buckets: buckets, d1Databases: { DB: "stored-native-fixture" }, serviceBindings: { CUSTODY: { name: "receiver", entrypoint: "Custody" }, INVENTORY: { name: "inventory", entrypoint: "PrivateStoredInventoryWorker" } } },
    { ...worker("receiver", RECEIVER), r2Buckets: { STATE: buckets.STATE! }, d1Databases: { DB: "stored-native-fixture" } },
    { ...worker("inventory", built.inventory), r2Buckets: { R2_ARTIFACTS: buckets.ARTIFACTS!, R2_SOURCE: buckets.SOURCE!, R2_BACKUPS: buckets.BACKUPS! }, serviceBindings: {
      R2_STATE: { name: "receiver", entrypoint: "ShortStatePages" },
      TAKOSUMI_STORED_INVENTORY_FENCES: { name: "receiver", entrypoint: "Custody" },
      TAKOSUMI_STORED_OBJECT_OWNERS: { name: "receiver", entrypoint: "Custody" },
    } },
  ] });
  const db = await runtime.getD1Database("DB", "caller");
  await db.exec(`
    CREATE TABLE fixture_controls(name TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE fixture_owners(role TEXT,key TEXT,workspace TEXT,PRIMARY KEY(role,key));
    CREATE TABLE fixture_objects(role TEXT,source_ref TEXT,object_ref TEXT,workspace TEXT,revision INTEGER,bytes TEXT,version_digest TEXT,pending_ref TEXT,PRIMARY KEY(role,object_ref));
    CREATE TABLE fixture_intents(operation_ref TEXT PRIMARY KEY,request TEXT,intent TEXT,token TEXT,state TEXT,ack TEXT);
    CREATE TABLE fixture_audit(method TEXT,input TEXT);
    CREATE TABLE fixture_effects(kind TEXT,role TEXT,key TEXT);
  `);
  async function control(name: string, value: string) {
    await db.prepare("INSERT INTO fixture_controls VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value").bind(name, value).run();
  }
  async function seed(role: StoredBucketRole, key: string, value?: string, workspace = "workspace_native") {
    const bucket = await runtime.getR2Bucket(BINDINGS[role], "caller");
    if (value !== undefined) await bucket.put(key, value, { httpMetadata: { contentType: "application/x-original" }, customMetadata: { original: "kept", owner: workspace } });
    const object = await bucket.head(key);
    await db.prepare("INSERT INTO fixture_owners VALUES(?,?,?)").bind(role, key, workspace).run();
    await db.prepare("INSERT INTO fixture_objects VALUES(?,?,?,?,0,?,?,NULL)").bind(role, "source_" + role, await storedObjectReference(role, key, "source_" + role), workspace, String(object?.size ?? 0), object ? await storedNativeVersion(object) : null).run();
    return bucket;
  }
  const request = async (input: Record<string, unknown>) => await runtime.dispatchFetch("https://stored.test/", { method: "POST", body: JSON.stringify(input) });
  async function count(table: "fixture_audit" | "fixture_effects", value: string) {
    return (await db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${table === "fixture_audit" ? "method" : "kind"}=?`).bind(value).first<{ n: number }>())!.n;
  }
  async function snapshot() {
    return await db.prepare("SELECT revision,bytes,version_digest,pending_ref FROM fixture_objects").first<{ revision: number; bytes: string; version_digest: string | null; pending_ref: string | null }>();
  }
  return { runtime, db, control, seed, request, count, snapshot, dispose: async () => await runtime.dispose() };
}

test("native complete-store wrapper preserves self-host behavior and rejects incomplete/overlapping composition", async () => {
  const f = await fixture();
  try {
    expect((await f.request({ action: "put", selfHost: true, value: "self-host", key: "unregistered" })).status).toBe(200);
    expect(await f.count("fixture_audit", "readStoredSource")).toBe(0);
    expect((await f.request({ action: "composition" })).status).toBe(503);
    expect((await f.request({ action: "composition", owners: true, legacy: true })).status).toBe(503);
    expect((await f.request({ action: "composition", owners: true })).status).toBe(200);
  } finally { await f.dispose(); }
});

test("native nonzero inventory supports exact mutable overwrite and delete in every bucket role", async () => {
  const f = await fixture();
  try {
    for (const role of ROLES) {
      const key = "objects/shared-name";
      const bucket = await f.seed(role, key, "old");
      const original = await bucket.head(key);
      const read = await f.request({ action: "get", role, key });
      expect(read.status).toBe(200);
      expect(await read.json()).toMatchObject({ size: 3, text: "old", httpMetadata: { contentType: "application/x-original" }, customMetadata: { original: "kept", owner: "workspace_native" } });
      const options = { httpMetadata: { contentType: "application/x-replacement" }, customMetadata: { original: "literal", purpose: "retained bytes" } };
      const overwrite = await f.request({ action: "put", role, key, value: "new-size", options });
      expect(overwrite.status).toBe(200);
      expect(await overwrite.json()).toMatchObject({ key, size: 8, ...options });
      const observed = await bucket.head(key);
      expect(observed!.version).not.toBe(original!.version);
      expect(observed!.customMetadata).toEqual(options.customMetadata);
      const row = await f.db.prepare("SELECT revision,bytes,version_digest,pending_ref FROM fixture_objects WHERE role=?").bind(role).first();
      expect(row).toEqual({ revision: 1, bytes: "8", version_digest: await storedNativeVersion(observed!), pending_ref: null });
      expect((await f.request({ action: "delete", role, key })).status).toBe(200);
      expect(await bucket.head(key)).toBeNull();
      expect(await f.db.prepare("SELECT revision,bytes,version_digest,pending_ref FROM fixture_objects WHERE role=?").bind(role).first()).toEqual({ revision: 2, bytes: "0", version_digest: null, pending_ref: null });
    }
    expect(await f.count("fixture_effects", "put")).toBe(4);
    expect(await f.count("fixture_effects", "delete")).toBe(4);
    expect(await f.count("fixture_audit", "confirmStoredObject")).toBe(8);
    const forwarded = await f.db.prepare("SELECT input FROM fixture_audit WHERE method='prepareStoredObject'").all<{ input: string }>();
    expect(forwarded.results.every(row => !row.input.includes("objects/shared-name"))).toBe(true);
  } finally { await f.dispose(); }
});

test("same-op paused native sender gives its CAS loser no dispatch, confirm or cancel authority", async () => {
  const f = await fixture();
  try {
    await f.seed("state", "race/object");
    await f.control("snapshot_barrier", "yes");
    await f.control("snapshot_readers", "0");
    await f.control("pause_dispatch", "yes");
    const first = f.request({ action: "put", key: "race/object", value: "same" });
    const second = f.request({ action: "put", key: "race/object", value: "same" });
    const loser = await Promise.race([first, second]);
    expect(loser.status).toBe(503);
    expect(await f.count("fixture_audit", "prepareStoredObject")).toBe(2);
    expect(await f.count("fixture_effects", "put")).toBe(0);
    expect(await f.count("fixture_audit", "confirmStoredObject")).toBe(0);
    expect(await f.count("fixture_audit", "cancelStoredObject")).toBe(0);
    expect((await f.snapshot())!.pending_ref).toBeString();
    await f.control("pause_dispatch", "no");
    const responses = await Promise.all([first, second]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 503]);
    expect(await f.count("fixture_effects", "put")).toBe(1);
    expect(await f.count("fixture_audit", "confirmStoredObject")).toBe(1);
    expect(await f.count("fixture_audit", "cancelStoredObject")).toBe(0);
    expect((await f.snapshot())!.revision).toBe(1);
  } finally { await f.control("pause_dispatch", "no"); await f.dispose(); }
}, 10000);

test("missing or foreign owner and missing native upload version fail before an effect", async () => {
  const f = await fixture();
  try {
    expect((await f.request({ action: "put", key: "missing/object" })).status).toBe(503);
    await f.seed("state", "foreign/object");
    await f.db.prepare("UPDATE fixture_owners SET workspace='workspace_foreign'").run();
    expect((await f.request({ action: "put", key: "foreign/object" })).status).toBe(503);
    await f.seed("state", "version/object", "old");
    expect((await f.request({ action: "put", key: "version/object", missingVersion: true })).status).toBe(503);
    expect(await f.count("fixture_effects", "put")).toBe(0);
    expect(await f.count("fixture_effects", "delete")).toBe(0);
    expect(await f.count("fixture_audit", "prepareStoredObject")).toBe(0);
  } finally { await f.dispose(); }
});

test("original dispatch token reconciles lost native PUT and DELETE ACKs exactly once", async () => {
  const f = await fixture();
  try {
    const bucket = await f.seed("artifacts", "ack/object", "old");
    const prior = await bucket.head("ack/object");
    await f.control("put_ack", "lost");
    expect((await f.request({ action: "put", role: "artifacts", key: "ack/object", value: "old", options: { httpMetadata: { contentType: "application/x-original" }, customMetadata: { original: "kept", owner: "workspace_native" } } })).status).toBe(200);
    const replayedBytes = await bucket.head("ack/object");
    expect(replayedBytes!.etag).toBe(prior!.etag);
    expect(replayedBytes!.version).not.toBe(prior!.version);
    expect(await f.count("fixture_effects", "put")).toBe(1);
    expect(await f.count("fixture_audit", "confirmStoredObject")).toBe(1);
    expect((await f.snapshot())!.pending_ref).toBeNull();
    await f.control("delete_ack", "lost");
    expect((await f.request({ action: "delete", role: "artifacts", key: "ack/object" })).status).toBe(200);
    expect(await bucket.head("ack/object")).toBeNull();
    expect(await f.count("fixture_effects", "delete")).toBe(1);
    expect(await f.count("fixture_audit", "confirmStoredObject")).toBe(2);
  } finally { await f.dispose(); }
});

test("lost prepare ACK preserves pending intent without a native send and replay cannot acquire its token", async () => {
  const f = await fixture();
  try {
    await f.seed("source", "prepare/object");
    await f.control("prepare_ack", "lost");
    expect((await f.request({ action: "put", role: "source", key: "prepare/object" })).status).toBe(503);
    expect((await f.snapshot())!.pending_ref).toBeString();
    await f.control("prepare_ack", "none");
    expect((await f.request({ action: "put", role: "source", key: "prepare/object" })).status).toBe(503);
    expect((await f.request({ action: "get", role: "source", key: "prepare/object" })).status).toBe(503);
    expect(await f.count("fixture_effects", "put")).toBe(0);
    expect(await f.count("fixture_effects", "get")).toBe(0);
    expect(await f.count("fixture_audit", "confirmStoredObject")).toBe(0);
    expect(await f.count("fixture_audit", "cancelStoredObject")).toBe(0);
  } finally { await f.dispose(); }
});

test("uncommitted confirm stays pending on matching GET and PUT replay without the original token", async () => {
  const f = await fixture();
  try {
    const bucket = await f.seed("backups", "confirm/object");
    await f.control("confirm_ack", "before");
    expect((await f.request({ action: "put", role: "backups", key: "confirm/object", value: "retained" })).status).toBe(503);
    expect((await bucket.head("confirm/object"))!.size).toBe(8);
    expect((await f.snapshot())!.pending_ref).toBeString();
    await f.control("confirm_ack", "none");
    expect((await f.request({ action: "get", role: "backups", key: "confirm/object" })).status).toBe(503);
    expect((await f.request({ action: "put", role: "backups", key: "confirm/object", value: "retained" })).status).toBe(503);
    expect(await f.count("fixture_effects", "put")).toBe(1);
    expect(await f.count("fixture_effects", "get")).toBe(1);
    expect(await f.count("fixture_audit", "confirmStoredObject")).toBe(1);
    expect(await f.count("fixture_audit", "cancelStoredObject")).toBe(0);
  } finally { await f.dispose(); }
});

test("committed then lost confirm ACK permits one read without replaying an effect or confirmation", async () => {
  const f = await fixture();
  try {
    await f.seed("state", "confirmed/object");
    await f.control("confirm_ack", "after");
    expect((await f.request({ action: "put", key: "confirmed/object", value: "retained" })).status).toBe(503);
    expect(await f.snapshot()).toMatchObject({ revision: 1, bytes: "8", pending_ref: null });
    const reads = await f.count("fixture_audit", "readStoredObject");
    const gets = await f.count("fixture_effects", "get");
    const response = await f.request({ action: "get", key: "confirmed/object" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ text: "retained" });
    expect(await f.count("fixture_audit", "readStoredObject")).toBe(reads + 1);
    expect(await f.count("fixture_effects", "get")).toBe(gets + 1);
    expect(await f.count("fixture_effects", "put")).toBe(1);
    expect(await f.count("fixture_audit", "confirmStoredObject")).toBe(1);
  } finally { await f.dispose(); }
});

test("native conditional refusal cancels only the original owned intent with no balance change", async () => {
  const f = await fixture();
  try {
    const bucket = await f.seed("state", "cancel/object", "old");
    const prior = await storedNativeVersion((await bucket.head("cancel/object"))!);
    await f.control("refuse_put", "yes");
    const response = await f.request({ action: "put", key: "cancel/object", value: "replacement" });
    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
    expect(await f.snapshot()).toEqual({ revision: 1, bytes: "3", version_digest: prior, pending_ref: null });
    expect(await f.count("fixture_audit", "cancelStoredObject")).toBe(1);
    expect(await f.count("fixture_audit", "confirmStoredObject")).toBe(0);
    expect((await f.db.prepare("SELECT state FROM fixture_intents").first())!.state).toBe("cancelled");
  } finally { await f.dispose(); }
});

async function inventoryFence(f: Awaited<ReturnType<typeof fixture>>, role: StoredBucketRole, cursor: string | null) {
  await f.db.prepare("INSERT INTO fixture_fences(role,value) VALUES(?,?) ON CONFLICT(role) DO UPDATE SET value=excluded.value").bind(role, JSON.stringify({ sourceRef: "source_" + role, inventoryRef: "inventory_one", bucketRole: role, qualificationDigest: digest, fenceDigest: digest, phase: "inventory", cursor })).run();
}

test("actual private inventory Worker follows short native truncated cursors and checks the fence around every page", async () => {
  const f = await fixture();
  try {
    await f.db.prepare("CREATE TABLE fixture_fences(role TEXT PRIMARY KEY,value TEXT)").run();
    for (let index = 0; index < 5; index++) await f.seed("state", "inventory/object-" + index, "x".repeat(index + 1));
    let cursor: string | null = null;
    const objects: Array<{ objectRef: string; workspaceId: string; bytes: string; versionDigest: string }> = [];
    let pages = 0;
    do {
      await inventoryFence(f, "state", cursor);
      const response = await f.request({ action: "inventory", page: { bucketRole: "state", inventoryRef: "inventory_one", cursor } });
      expect(response.status).toBe(200);
      const page = await response.json() as { sourceRef: string; cursor: string | null; nextCursor: string | null; pageDigest: string; objects: typeof objects };
      expect(page.sourceRef).toBe("source_state");
      expect(page.cursor).toBe(cursor);
      expect(page.pageDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
      expect(page.objects.length).toBeLessThan(64);
      objects.push(...page.objects);
      cursor = page.nextCursor;
      pages++;
      expect(pages).toBeLessThan(5);
    } while (cursor !== null);
    expect(pages).toBe(3);
    expect(objects).toHaveLength(5);
    expect(new Set(objects.map(object => object.objectRef)).size).toBe(5);
    expect(objects.reduce((sum, object) => sum + BigInt(object.bytes), 0n)).toBe(15n);
    expect(objects.every(object => object.workspaceId === "workspace_native" && /^sha256:[0-9a-f]{64}$/u.test(object.versionDigest))).toBe(true);
    expect(await f.count("fixture_audit", "readStoredInventoryFence")).toBe(6);
    expect(await f.count("fixture_audit", "inventoryNativeList")).toBe(3);
    expect((await f.request({ action: "inventory-http" })).status).toBe(404);
    expect(await f.count("fixture_audit", "prepareStoredObject")).toBe(0);
  } finally { await f.dispose(); }
});

test("private inventory refuses unknown owners and a fence changed during native enumeration", async () => {
  const f = await fixture();
  try {
    await f.db.prepare("CREATE TABLE fixture_fences(role TEXT PRIMARY KEY,value TEXT)").run();
    await f.seed("state", "inventory/unknown", "x");
    await f.db.prepare("DELETE FROM fixture_owners").run();
    await inventoryFence(f, "state", null);
    const input = { action: "inventory", page: { bucketRole: "state", inventoryRef: "inventory_one", cursor: null } };
    expect((await f.request(input)).status).toBe(503);
    await f.db.prepare("INSERT INTO fixture_owners VALUES('state','inventory/unknown','workspace_native')").run();
    await f.db.prepare("DELETE FROM fixture_audit").run();
    await f.control("fence_race", "yes");
    expect((await f.request(input)).status).toBe(503);
    expect(await f.count("fixture_audit", "readStoredInventoryFence")).toBe(2);
    expect(await f.count("fixture_audit", "prepareStoredObject")).toBe(0);
  } finally { await f.dispose(); }
});

test("native source custody calls stop at the fixed fifteen-second deadline without a storage effect", async () => {
  const f = await fixture();
  try {
    await f.seed("state", "timeout/object");
    await f.control("stall_source", "yes");
    const started = performance.now();
    const response = await f.request({ action: "put", key: "timeout/object" });
    const elapsed = performance.now() - started;
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "stored service custody is unavailable" });
    expect(elapsed).toBeGreaterThanOrEqual(14500);
    expect(elapsed).toBeLessThan(20000);
    expect(await f.count("fixture_effects", "put")).toBe(0);
    expect(await f.count("fixture_audit", "prepareStoredObject")).toBe(0);
  } finally { await f.dispose(); }
}, 25000);
