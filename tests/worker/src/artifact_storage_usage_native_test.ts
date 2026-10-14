import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HOST = `
  import { WorkerEntrypoint } from "cloudflare:workers";
  export class Custody extends WorkerEntrypoint {
    async readArtifactRetention(input) {
      const row = await this.env.DB.prepare("SELECT input, ack FROM observations WHERE artifact_ref = ?").bind(input.artifactRef).first();
      if (!row) return null;
      const original = JSON.parse(row.input);
      if (original.workspaceId !== input.workspaceId) throw new Error("foreign workspace");
      return { bytes: original.bytes, ...(row.ack ? { acknowledgementDigest: row.ack } : {}) };
    }
    async prepareArtifactRetention(input) {
      const original = await this.readArtifactRetention(input);
      if (!original && input.replayOnly) throw new Error("no prior intent");
      if (original && original.bytes !== input.bytes) throw new Error("changed bytes");
      await this.env.DB.prepare("INSERT INTO observations(artifact_ref,input) VALUES(?,?) ON CONFLICT DO NOTHING").bind(input.artifactRef, JSON.stringify(input)).run();
      return { operationRef: "retain:" + input.artifactRef.slice(7), state: original?.acknowledgementDigest ? "confirmed" : "pending" };
    }
    async confirmArtifactRetention(input) {
      await this.env.DB.prepare("INSERT INTO attempts(input) VALUES(?)").bind(JSON.stringify(input)).run();
      const fail = await this.env.DB.prepare("SELECT value FROM controls WHERE key='fail-confirm'").first();
      if (fail?.value === 'yes') {
        await this.env.DB.prepare("UPDATE controls SET value='no' WHERE key='fail-confirm'").run();
        throw new Error("synthetic private counter-source detail");
      }
      await this.env.DB.prepare("UPDATE observations SET ack=? WHERE artifact_ref=? AND (ack IS NULL OR ack=?)").bind(input.acknowledgementDigest,input.artifactRef,input.acknowledgementDigest).run();
    }
    async prepareArtifactRelease(input) {
      if ((await this.env.DB.prepare("SELECT value FROM controls WHERE key='malformed-release'").first())?.value === 'yes') return {};
      const original = await this.readArtifactRetention(input);
      if (!original?.acknowledgementDigest || original.bytes !== input.bytes) throw new Error("missing retention");
      return { operationRef: "release:" + input.artifactRef.slice(7) };
    }
    async confirmArtifactRelease(input) {
      await this.env.DB.prepare("UPDATE observations SET released=1 WHERE artifact_ref=?").bind(input.artifactRef).run();
    }
  }
  export default { fetch() { return new Response(null,{status:404}); } };
`;

test("workerd R2 writer records exact encrypted bytes and preserves unknown ACK for explicit replay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "takosumi-artifact-usage-"));
  let runtime: Miniflare | undefined;
  try {
    const adapter = fileURLToPath(new URL("../../../worker/src/artifact-storage-usage.ts", import.meta.url));
    const entry = join(dir, "caller.ts");
    await Bun.write(entry, `
      import { artifactStorageUsageBucket } from ${JSON.stringify(adapter)};
      let physicalPuts = 0, physicalDeletes = 0;
      export default { async fetch(request,env) {
        const route = new URL(request.url).pathname;
        const key = "workspaces/ws_native/capsules/" + (route.includes("conditional") ? "c_conditional" : "c_native") + "/environments/stage/state-versions/00000001.tfstate.enc";
        const raw = {
          get: k => env.STATE.get(k), head: k => env.STATE.head(k), list: o => env.STATE.list(o),
          async put(...args) { physicalPuts++; const result = await env.STATE.put(...args); if (route === "/lost-put" || route === "/lost-put-conditional") throw new Error("lost PUT ACK"); return result; },
          async delete(k) { physicalDeletes++; await env.STATE.delete(k); if (route === "/lost-delete") throw new Error("lost DELETE ACK"); },
        };
        const bucket = artifactStorageUsageBucket(raw, env.CUSTODY);
        try {
          if (route === "/delete" || route === "/lost-delete" || route === "/malformed-delete") await bucket.delete(key);
          else if (route === "/read") return Response.json({ objects: (await bucket.list()).objects.length, physicalPuts,physicalDeletes });
          else if (route === "/adopt") {
            const object = await bucket.get(key);
            if (!object || (new Uint8Array(await object.arrayBuffer())).join(",") !== "1,2,3,4") throw new Error("adoption byte mismatch");
          }
          else {
            const bytes = new Uint8Array(route === "/changed" ? [1,2,3,5] : [1,2,3,4]);
            await bucket.put(key, bytes, {...(route.includes("conditional") ? {onlyIf:{etagDoesNotMatch:"*"}} : {}),customMetadata:{
              "takosumi-workspace-id":"ws_native", "takosumi-logical-target-state-ref":key,
              "takosumi-ciphertext-length":"4",
            }});
          }
          return Response.json({physicalPuts,physicalDeletes});
        } catch (error) { return Response.json({error:error.message,physicalPuts,physicalDeletes}, {status:503}); }
      } };
    `);
    const built = await Bun.build({ entrypoints: [entry], target: "browser", format: "esm", external: ["cloudflare:workers"], write: false });
    if (!built.success) throw new Error("artifact usage caller bundle failed");
    runtime = new Miniflare({ workers: [
      { name: "caller", compatibilityDate: "2026-07-17", modules: [{ type: "ESModule", path: "caller.mjs", contents: await built.outputs[0]!.text() }],
        r2Buckets: { STATE: "artifact-state-native" }, serviceBindings: { CUSTODY: { name: "custody", entrypoint: "Custody" } } },
      { name: "custody", compatibilityDate: "2026-07-17", modules: [{ type: "ESModule", path: "custody.mjs", contents: HOST }],
        d1Databases: { DB: "artifact-usage-native" } },
    ] });
    const db = await runtime.getD1Database("DB", "custody");
    await db.exec("CREATE TABLE observations(artifact_ref TEXT PRIMARY KEY,input TEXT NOT NULL,ack TEXT,released INTEGER DEFAULT 0); CREATE TABLE attempts(input TEXT NOT NULL); CREATE TABLE controls(key TEXT PRIMARY KEY,value TEXT); INSERT INTO controls VALUES('fail-confirm','yes');");
    const lost = await runtime.dispatchFetch("https://artifact.test/lost-put");
    expect(lost.status).toBe(503);
    expect(await lost.json()).toEqual({ error: "artifact storage custody is unavailable", physicalPuts: 1, physicalDeletes: 0 });
    expect((await db.prepare("SELECT count(*) AS n FROM attempts").first<{ n: number }>())?.n).toBe(1);
    expect((await db.prepare("SELECT ack FROM observations").first<{ ack: string | null }>())?.ack).toBeNull();
    const replay = await runtime.dispatchFetch("https://artifact.test/adopt");
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ physicalPuts: 1, physicalDeletes: 0 });
    const fact = await db.prepare("SELECT input,ack FROM observations").first<{ input: string; ack: string }>();
    expect(JSON.parse(fact!.input)).toMatchObject({ workspaceId: "ws_native", bytes: "4", replayOnly: false });
    expect(fact!.input).not.toContain("workspaces/");
    expect(fact!.ack).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect((await runtime.dispatchFetch("https://artifact.test/changed")).status).toBe(503);
    await db.prepare("INSERT INTO controls VALUES('malformed-release','yes')").run();
    const malformed = await runtime.dispatchFetch("https://artifact.test/malformed-delete");
    expect(malformed.status).toBe(503);
    expect(await malformed.json()).toEqual({ error: "artifact storage custody is unavailable", physicalPuts: 1, physicalDeletes: 0 });
    await db.prepare("UPDATE controls SET value='no' WHERE key='malformed-release'").run();
    expect((await runtime.dispatchFetch("https://artifact.test/lost-delete")).status).toBe(503);
    expect((await db.prepare("SELECT released FROM observations").first<{ released: number }>())?.released).toBe(0);
    expect((await runtime.dispatchFetch("https://artifact.test/delete")).status).toBe(200);
    expect((await db.prepare("SELECT released FROM observations").first<{ released: number }>())?.released).toBe(1);
    expect((await runtime.dispatchFetch("https://artifact.test/recreate")).status).toBe(503);
    expect(await (await runtime.dispatchFetch("https://artifact.test/read")).json()).toEqual({ objects: 0, physicalPuts: 1, physicalDeletes: 1 });
    await db.prepare("UPDATE controls SET value='yes' WHERE key='fail-confirm'").run();
    expect((await runtime.dispatchFetch("https://artifact.test/lost-put-conditional")).status).toBe(503);
    expect((await db.prepare("SELECT count(*) AS n FROM observations WHERE ack IS NULL").first<{ n: number }>())?.n).toBe(1);
    expect((await runtime.dispatchFetch("https://artifact.test/replay-conditional")).status).toBe(200);
    expect((await db.prepare("SELECT count(*) AS n FROM observations WHERE ack IS NULL").first<{ n: number }>())?.n).toBe(0);
    expect(await (await runtime.dispatchFetch("https://artifact.test/read")).json()).toEqual({ objects: 1, physicalPuts: 2, physicalDeletes: 1 });
  } finally {
    await runtime?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);

test("workerd recovery verify gates existing handle adoption on the original retention intent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "takosumi-recovery-usage-"));
  let runtime: Miniflare | undefined;
  try {
    const recovery = fileURLToPath(new URL("../../../worker/src/state_recovery_artifact_store.ts", import.meta.url));
    const crypto = fileURLToPath(new URL("../../../worker/src/state_crypto.ts", import.meta.url));
    const allocator = fileURLToPath(new URL("../../../core/adapters/storage/artifact-references.ts", import.meta.url));
    const entry = join(dir, "caller.ts");
    await Bun.write(entry, `
      import {R2RecoveryStateArtifactStore} from ${JSON.stringify(recovery)};
      import {digestBytes,StateArtifactCrypto} from ${JSON.stringify(crypto)};
      import {ObjectKeyArtifactReferenceAllocator} from ${JSON.stringify(allocator)};
      export default {async fetch(request,env){
        const route=new URL(request.url).pathname;
        const plaintext=new TextEncoder().encode(JSON.stringify({version:4,terraform_version:"1.9.8",serial:1,lineage:"7a651571-502c-47d3-b737-cecc3877d714",resources:[{mode:"managed",type:"fixture_resource",name:"fixture",provider:"provider[\\\"registry.example/fixture\\\"]",instances:[{schema_version:0,attributes:{}}]}],outputs:{}}));
        const input={workspaceId:"ws_native",capsuleId:route==="/missing"?"historical":"confirmed",environment:"stage",generation:1,
          failedApplyRunId:"failed",recoveryRunId:"recovery",plaintextSha256:await digestBytes(plaintext),custodyEvidenceDigest:"sha256:"+"a".repeat(64),plaintext};
        const common={bucket:env.STATE,allocator:new ObjectKeyArtifactReferenceAllocator(),
          crypto:StateArtifactCrypto.fromEnv({TAKOSUMI_SECRET_STORE_PASSPHRASE:"native-fixture-only-passphrase-0123456789abcdef"})};
        try{
          const observer=new R2RecoveryStateArtifactStore({...common,storageUsage:env.CUSTODY});
          if(route==="/stage")await observer.stage(input);
          else{
            const old=await new R2RecoveryStateArtifactStore(common).stage(input);
            await observer.verify({workspaceId:input.workspaceId,capsuleId:input.capsuleId,failedApplyRunId:"failed",recoveryRunId:"recovery",artifactHandle:old.handle});
          }
          return Response.json({verified:true});
        }catch(error){return Response.json({error:error.message},{status:503})}
      }};
    `);
    const result = await Bun.build({ entrypoints: [entry], target: "browser", format: "esm", external: ["cloudflare:workers"], write: false });
    if (!result.success) throw new Error("recovery usage native bundle failed");
    runtime = new Miniflare({ workers: [
      { name: "caller", compatibilityDate: "2026-07-17", modules: [{ type: "ESModule", path: "caller.mjs", contents: await result.outputs[0]!.text() }],
        r2Buckets: { STATE: "recovery-usage-native" }, serviceBindings: { CUSTODY: { name: "custody", entrypoint: "Custody" } } },
      { name: "custody", compatibilityDate: "2026-07-17", modules: [{ type: "ESModule", path: "custody.mjs", contents: HOST }],
        d1Databases: { DB: "recovery-usage-native" } },
    ] });
    const db = await runtime.getD1Database("DB", "custody");
    await db.exec("CREATE TABLE observations(artifact_ref TEXT PRIMARY KEY,input TEXT NOT NULL,ack TEXT,released INTEGER DEFAULT 0); CREATE TABLE attempts(input TEXT NOT NULL); CREATE TABLE controls(key TEXT PRIMARY KEY,value TEXT); INSERT INTO controls VALUES('fail-confirm','yes');");
    expect((await runtime.dispatchFetch("https://recovery.test/missing")).status).toBe(503);
    expect((await db.prepare("SELECT count(*) AS n FROM observations").first<{ n: number }>())?.n).toBe(0);
    const stage = await runtime.dispatchFetch("https://recovery.test/stage");
    expect(stage.status).toBe(503);
    expect(await stage.json()).toEqual({ error: "artifact storage custody is unavailable" });
    expect((await db.prepare("SELECT count(*) AS n FROM attempts").first<{ n: number }>())?.n).toBe(1);
    expect((await db.prepare("SELECT ack FROM observations").first<{ ack: string | null }>())?.ack).toBeNull();
    expect((await runtime.dispatchFetch("https://recovery.test/verify")).status).toBe(200);
    expect((await db.prepare("SELECT count(*) AS n FROM attempts").first<{ n: number }>())?.n).toBe(2);
    expect((await db.prepare("SELECT ack FROM observations").first<{ ack: string }>())?.ack).toMatch(/^sha256:[0-9a-f]{64}$/u);
  } finally { await runtime?.dispose(); await rm(dir, { recursive: true, force: true }); }
}, 30000);
