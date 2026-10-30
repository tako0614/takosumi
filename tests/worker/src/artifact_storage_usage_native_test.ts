import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Hosted-shaped custody (takosumi-hosted origin/main before 9B): it requires
// a workspaceId on every call and keys its ledger by it.
const HOST = `
  import { WorkerEntrypoint } from "cloudflare:workers";
  export class Custody extends WorkerEntrypoint {
    async readArtifactRetention(input) {
      if (typeof input.workspaceId !== "string" || !input.workspaceId) throw new Error("storageToken: workspaceId required");
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
      if (typeof input.workspaceId !== "string" || !input.workspaceId) throw new Error("storageToken: workspaceId required");
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
      if (typeof input.workspaceId !== "string" || !input.workspaceId) throw new Error("storageToken: workspaceId required");
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
        const appKey = route.startsWith("/app-");
        const mutableAppInput = route === "/app-mutable";
        const key = appKey
          ? "apps/c_app/environments/stage/state-versions/00000001.tfstate.enc"
          : "workspaces/ws_native/capsules/" + (route.includes("conditional") ? "c_conditional" : "c_native") + "/environments/stage/state-versions/00000001.tfstate.enc";
        const bytes = new Uint8Array(mutableAppInput ? [1,2,3,4] : route === "/changed" ? [1,2,3,5] : [1,2,3,4]);
        // An apps/ object names its Capsule and root; any Workspace metadata on
        // it is not an owner (TASK-0118 P9.1-f).
        const customMetadata = appKey ? {
          "takosumi-workspace-id": "ws_unrelated",
          "takosumi-capsule-id": route === "/app-mismatch" ? "c_other" : "c_app",
          "takosumi-storage-root": route === "/app-wrong-root" ? "apps/c_other" : "apps/c_app",
          "takosumi-logical-target-state-ref":key, "takosumi-ciphertext-length":"4",
        } : {
          "takosumi-workspace-id":"ws_native", "takosumi-logical-target-state-ref":key,
          "takosumi-ciphertext-length":"4",
        };
        const raw = {
          get: k => env.STATE.get(k), head: k => env.STATE.head(k), list: o => env.STATE.list(o),
          async put(...args) { physicalPuts++; const result = await env.STATE.put(...args); if (route === "/lost-put" || route === "/lost-put-conditional") throw new Error("lost PUT ACK"); return result; },
          async delete(k) { physicalDeletes++; await env.STATE.delete(k); if (route === "/lost-delete") throw new Error("lost DELETE ACK"); },
        };
        // The Capsule's frozen scope, as the Runner reads it from the Capsule row.
        const bucket = artifactStorageUsageBucket(raw, env.CUSTODY, {
          resolveAppScope: async (capsuleId) => route === "/app-no-scope" || capsuleId !== "c_app" ? undefined : "ws_native",
        });
        try {
          if (route === "/delete" || route === "/lost-delete" || route === "/malformed-delete") await bucket.delete(key);
          else if (route === "/read") return Response.json({ objects: (await bucket.list()).objects.length, physicalPuts,physicalDeletes });
          else if (route === "/adopt") {
            const object = await bucket.get(key);
            if (!object || (new Uint8Array(await object.arrayBuffer())).join(",") !== "1,2,3,4") throw new Error("adoption byte mismatch");
          }
          else {
            const pending = bucket.put(key, bytes, {...(route.includes("conditional") ? {onlyIf:{etagDoesNotMatch:"*"}} : {}),customMetadata});
            if (route === "/app-mutable") {
              // The caller changes its inputs while the write is still awaiting.
              bytes.fill(9);
              customMetadata["takosumi-capsule-id"] = "c_other";
              customMetadata["takosumi-ciphertext-length"] = "999";
            }
            await pending;
            if (route === "/app-mutable") {
              const object = await raw.get(key);
              return Response.json({bytes:[...new Uint8Array(await object.arrayBuffer())],customMetadata:object.customMetadata});
            }
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
    const beforeApps = await (await runtime.dispatchFetch("https://artifact.test/read")).json() as { physicalPuts: number };
    // An apps/ key is measured for the Capsule its own root names; the object
    // must name that Capsule and root, and nothing is looked up to a Workspace.
    for (const route of ["/app-mismatch", "/app-wrong-root"]) {
      const refused = await runtime.dispatchFetch(`https://artifact.test${route}`);
      expect(refused.status, route).toBe(503);
      expect(await refused.json(), route).toMatchObject({ error: "artifact storage acknowledgement is invalid", physicalPuts: beforeApps.physicalPuts });
    }
    // Without a Capsule scope there is no custody to report to the host.
    const noScope = await runtime.dispatchFetch("https://artifact.test/app-no-scope");
    expect(noScope.status).toBe(503);
    expect(await noScope.json()).toMatchObject({ error: "artifact storage custody is unavailable", physicalPuts: beforeApps.physicalPuts });
    const mutableApp = await runtime.dispatchFetch("https://artifact.test/app-mutable");
    expect(mutableApp.status).toBe(200);
    const mutableResult = await mutableApp.json() as { bytes: number[]; customMetadata: Record<string, string> };
    expect(mutableResult.bytes).toEqual([1, 2, 3, 4]);
    expect(mutableResult.customMetadata).toMatchObject({
      "takosumi-capsule-id": "c_app",
      "takosumi-storage-root": "apps/c_app",
      "takosumi-logical-target-state-ref": "apps/c_app/environments/stage/state-versions/00000001.tfstate.enc",
      "takosumi-ciphertext-length": "4",
    });
    const appReceipt = await db.prepare("SELECT input,ack FROM observations ORDER BY rowid DESC LIMIT 1")
      .first<{ input: string; ack: string }>();
    const appFact = JSON.parse(appReceipt!.input);
    // Measured for the Capsule; the Hosted-shaped host still gets its frozen
    // scope as workspaceId (not the "ws_unrelated" object metadata).
    expect(appFact).toMatchObject({ workspaceId: "ws_native", capsuleId: "c_app", bytes: "4", replayOnly: false });
    expect(appReceipt!.ack).toBe(mutableResult.customMetadata["takosumi-storage-observation-digest"]);
    // An exact replay of the same apps/ object adopts the existing receipt.
    const replayedApp = await runtime.dispatchFetch("https://artifact.test/app-valid");
    expect(replayedApp.status).toBe(200);
    expect(await replayedApp.json()).toMatchObject({ physicalPuts: beforeApps.physicalPuts + 1 });
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
          capsules:{async getCapsule(id){return {id,workspaceId:"ws_native",environment:"stage"};},async getCapsuleStorageRoot(id){return "workspaces/ws_native/capsules/"+id;}},
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
