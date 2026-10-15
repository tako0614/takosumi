import { expect, test } from "bun:test";
import platformWorker from "../../../deploy/platform/worker.ts";
import { createWorkerServiceApp } from "../../../worker/src/worker_service.ts";
import type { CloudflareWorkerEnv, D1Database, R2Bucket, R2Object, R2ObjectBody, R2Objects, R2PutOptions } from "../../../worker/src/bindings.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";
import { PartitionedSecretBoundaryCrypto } from "../../../core/adapters/secret-store/memory.ts";
import { createPrivateRunFileGrantCodec } from "../../../core/domains/private-run-files/grant.ts";
import { createDeployControlService, createRunOwnerDeployControlService } from "../../../worker/src/deploy_control_seam.ts";

const CONFIG = { endpoint: "https://private-file.example/internal/private-run-files/v1", prefix: "isolated-fixture/private-files", maxBytes: 16 * 1024 * 1024 };
const PASSPHRASE = "platform-private-file-local-fixture-0123456789abcdef";
const SCOPE = { workspaceId: "private_workspace", capsuleId: "private_capsule", environment: "test", slot: "opaque.intent" };
const AUTHORITY = { runId: "private_plan", executionAuthorityEpoch: 3, leaseToken: "local-private-file-lease" };

async function fixture() {
  const db = new SqliteFakeD1();
  const bucket = new FakeR2Bucket();
  const env = { TAKOSUMI_CONTROL_DB: db, R2_ARTIFACTS: bucket, TAKOSUMI_ENVIRONMENT: "test", TAKOSUMI_SECRET_STORE_PASSPHRASE: PASSPHRASE, TAKOSUMI_PRIVATE_RUN_FILES: JSON.stringify(CONFIG) } as unknown as CloudflareWorkerEnv;
  const core = await createWorkerServiceApp(env, "takosumi-api", { privateRunFiles: CONFIG, operatorInstallConfigs: [] });
  await db.prepare(`insert into workspaces (id,handle,record_json,created_at,updated_at) values (?,?,'{}','2026-10-15','2026-10-15')`).bind(SCOPE.workspaceId, "private-workspace").run();
  await db.prepare(`insert into capsules (id,space_id,project_id,name,slug,install_config_id,environment,status,record_json,created_at,updated_at,execution_authority_epoch) values (?,?,?,?,?,?,?,'active','{}','2026-10-15','2026-10-15',?)`).bind(SCOPE.capsuleId,SCOPE.workspaceId,"private_project","private-capsule","private-capsule","private_install",SCOPE.environment,AUTHORITY.executionAuthorityEpoch).run();
  await db.prepare(`insert into runs (id,space_id,installation_id,environment,type,status,lease_token,run_json,created_at) values (?,?,?,?,'plan','running',?,?,'2026-10-15')`).bind(AUTHORITY.runId,SCOPE.workspaceId,SCOPE.capsuleId,SCOPE.environment,AUTHORITY.leaseToken,JSON.stringify({id:AUTHORITY.runId,workspaceId:SCOPE.workspaceId,capsuleId:SCOPE.capsuleId,status:"running",capsuleExecutionAuthorityEpoch:AUTHORITY.executionAuthorityEpoch})).run();
  const grants = createPrivateRunFileGrantCodec({ cryptoBoundary: new PartitionedSecretBoundaryCrypto({ globalPassphrase: PASSPHRASE }) });
  const grant = await grants.mint({ scope: SCOPE, authority: AUTHORITY, operations: ["read","commit","resolve"], expiresAt: Date.now()+60_000 });
  return { db, bucket, env, core, grants, grant };
}
function request(grant: string, operation = "read", body: unknown = {}) {
  return new Request(`${CONFIG.endpoint}/${operation}`, { method: "POST", headers: { authorization: `Bearer ${grant}`, "content-type": "application/json" }, body: JSON.stringify(body) });
}

test("unified platform routes the real Core private-file capability without broad internal-edge opt-in", async () => {
  const { env, core, grant } = await fixture();
  const direct = await core.app.fetch(request(grant));
  expect(direct.status).toBe(200);
  expect(await direct.json()).toEqual({ kind: "absent" });
  const actual = await platformWorker.fetch(request(grant), env as never);
  expect(actual.status).toBe(200);
  expect(await actual.json()).toEqual({ kind: "absent" });
  for (const service of [await createDeployControlService(env), await createRunOwnerDeployControlService(env)]) {
    const response = await service.app.fetch(request(grant));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kind: "absent" });
  }
  expect(actual.headers.get("cache-control")).toBe("no-store");
});

test("default OFF and invalid/mismatched ingress perform no Core initialization or body read", async () => {
  let databaseUses = 0;
  const db = { prepare() { databaseUses++; throw new Error("unexpected database use"); } };
  const off = { TAKOSUMI_CONTROL_DB: db } as never;
  expect((await platformWorker.fetch(request("unused"), off)).status).toBe(404);
  const invalid = { TAKOSUMI_CONTROL_DB: db, TAKOSUMI_PRIVATE_RUN_FILES: "{}" } as never;
  expect((await platformWorker.fetch(request("unused"), invalid)).status).toBe(503);
  const on = { TAKOSUMI_CONTROL_DB: db, TAKOSUMI_PRIVATE_RUN_FILES: JSON.stringify(CONFIG) } as never;
  for (const url of [`${CONFIG.endpoint}/read?x=1`, `${CONFIG.endpoint}/read#x`, `${CONFIG.endpoint}/other`, `${CONFIG.endpoint}/read/`, CONFIG.endpoint.replace("private-file.example", "alias.example")+"/read"]) {
    expect((await platformWorker.fetch(new Request(url, { method: "POST" }), on)).status).toBe(404);
  }
  expect((await platformWorker.fetch(new Request(`${CONFIG.endpoint}/read`), on)).status).toBe(405);
  for (const header of ["origin", "cookie", "x-takosumi-account-session"]) {
    const response = await platformWorker.fetch(new Request(`${CONFIG.endpoint}/read`, { method: "POST", headers: { [header]: "browser-context" }, body: "{}" }), on);
    expect(response.status).toBe(403);
  }
  expect(databaseUses).toBe(0);
});

test("session/PAT and wrong-operation capabilities cannot replace the Core grant", async () => {
  const { env, grant, grants } = await fixture();
  for (const token of ["ordinary-session", "ordinary-pat", "prfg1.invalid"]) {
    const response = await platformWorker.fetch(request(token), env as never);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ kind: "authorization_rejected" });
  }
  const readOnly = await grants.mint({ scope: SCOPE, authority: AUTHORITY, operations: ["read"], expiresAt: Date.now()+60_000 });
  expect((await platformWorker.fetch(request(readOnly, "commit", { expectedVersion: 0, commitId: "forbidden", bytesBase64: "" }), env as never)).status).toBe(403);
  const claims = await grants.open(grant);
  expect(Object.hasOwn(claims, "endpoint")).toBe(false);
  expect(claims.authority).toEqual(AUTHORITY);
  expect(claims.expiresAt - claims.issuedAt).toBeLessThanOrEqual(20 * 60_000);
});

test("platform commit/read/resolve retains encrypted-byte custody, CAS replay and current lease fence", async () => {
  const { env, db, bucket, grant } = await fixture();
  const bytes = new TextEncoder().encode("opaque-local-fixture-payload");
  const digestBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const digest = `sha256:${[...digestBytes].map(x => x.toString(16).padStart(2,"0")).join("")}`;
  const commit = { expectedVersion: 0, commitId: "immutable-local-commit", bytesBase64: btoa(new TextDecoder().decode(bytes)) };
  const first = await platformWorker.fetch(request(grant, "commit", commit), env as never);
  expect(first.status).toBe(200);
  expect((await first.json() as { kind: string }).kind).toBe("committed");
  const replay = await platformWorker.fetch(request(grant, "commit", commit), env as never);
  expect((await replay.json() as { kind: string }).kind).toBe("replayed");
  const read = await platformWorker.fetch(request(grant), env as never);
  expect(await read.json()).toMatchObject({ kind: "present", version: 1, digest, bytesBase64: commit.bytesBase64 });
  const resolve = await platformWorker.fetch(request(grant, "resolve", { expectedVersion: 0, commitId: commit.commitId, digest }), env as never);
  expect((await resolve.json() as { kind: string }).kind).toBe("committed");
  const unknown = await platformWorker.fetch(request(grant, "resolve", { expectedVersion: 1, commitId: "not-a-receipt", digest }), env as never);
  expect(unknown.status).toBe(200);
  expect(await unknown.json()).toEqual({ kind: "not_found" });
  expect(bucket.getCount).toBeGreaterThan(0);
  await db.prepare("update runs set lease_token = ? where id = ?").bind("replacement-lease", AUTHORITY.runId).run();
  const stale = await platformWorker.fetch(request(grant), env as never);
  expect(stale.status).toBe(403);
  expect(await stale.json()).toEqual({ kind: "authorization_rejected" });
});

test("actual scoped capability cannot rebind Workspace, Capsule, environment, Run or epoch through platform ingress", async () => {
  const { env, db, bucket, grants, grant } = await fixture();
  for (const input of [
    { scope: { ...SCOPE, workspaceId: "foreign_workspace" }, authority: AUTHORITY },
    { scope: { ...SCOPE, capsuleId: "foreign_capsule" }, authority: AUTHORITY },
    { scope: { ...SCOPE, environment: "foreign" }, authority: AUTHORITY },
    { scope: SCOPE, authority: { ...AUTHORITY, runId: "foreign_run" } },
    { scope: SCOPE, authority: { ...AUTHORITY, executionAuthorityEpoch: AUTHORITY.executionAuthorityEpoch + 1 } },
  ]) {
    const token = await grants.mint({ ...input, operations: ["read"], expiresAt: Date.now() + 60_000 });
    const response = await platformWorker.fetch(request(token), env as never);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ kind: "authorization_rejected" });
  }
  expect((await platformWorker.fetch(request(grant, "read", { scope: SCOPE, authority: AUTHORITY }), env as never)).status).toBe(400);
  expect((await platformWorker.fetch(request(grant), env as never)).status).toBe(200);
  await db.prepare("update runs set status = 'succeeded' where id = ?").bind(AUTHORITY.runId).run();
  expect((await platformWorker.fetch(request(grant), env as never)).status).toBe(403);
  expect(bucket.getCount).toBe(0);
  expect(bucket.putCount).toBe(0);
});

test("configured ingress refuses missing R2 custody or partitioned encryption", async () => {
  const { env, grant } = await fixture();
  for (const missing of ["R2_ARTIFACTS", "TAKOSUMI_SECRET_STORE_PASSPHRASE"]) {
    const incomplete = { ...env, [missing]: undefined };
    const response = await platformWorker.fetch(request(grant), incomplete as never);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ kind: "unavailable" });
  }
});

class FakeR2Bucket implements R2Bucket {
  readonly #objects = new Map<string, { bytes: Uint8Array; metadata: Record<string, string> }>();
  getCount = 0;
  putCount = 0;

  async put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null, options?: R2PutOptions): Promise<R2Object | null> {
    this.putCount += 1;
    if (options?.onlyIf?.etagDoesNotMatch === "*" && this.#objects.has(key)) return null;
    if (!(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)) throw new Error("fixture expects byte input");
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value.slice(0)) : new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    this.#objects.set(key, { bytes, metadata: { ...(options?.customMetadata ?? {}) } });
    return this.asObject(key);
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    this.getCount += 1;
    const object = this.#objects.get(key);
    if (!object) return null;
    const bytes = object.bytes.slice();
    return {
      ...this.asObject(key),
      body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes.slice()); controller.close(); } }),
      arrayBuffer: async () => bytes.slice().buffer,
    };
  }

  async head(key: string): Promise<R2Object | null> { return this.#objects.has(key) ? this.asObject(key) : null; }
  async list(_options?: import("../../../worker/src/bindings.ts").R2ListOptions): Promise<R2Objects> { return { objects: [], truncated: false }; }
  async delete(key: string): Promise<void> { this.#objects.delete(key); }

  private asObject(key: string): R2Object {
    const object = this.#objects.get(key)!;
    return { key, size: object.bytes.byteLength, etag: `etag-${key}`, uploaded: new Date(0), customMetadata: { ...object.metadata } };
  }
}
