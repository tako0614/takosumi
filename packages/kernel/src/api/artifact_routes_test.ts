import assert from "node:assert/strict";
import { Hono, type Hono as HonoApp } from "hono";
import { MemoryObjectStorage } from "../adapters/object-storage/memory.ts";
import {
  registerArtifactRoutes,
  TAKOSUMI_ARTIFACTS_BUCKET,
  TAKOSUMI_ARTIFACTS_PATH,
} from "./artifact_routes.ts";

const VALID_TOKEN = "test-token-abc";

function createApp(opts: {
  token?: string | undefined;
  storage?: MemoryObjectStorage;
  now?: () => string;
} = {}): { app: HonoApp; storage: MemoryObjectStorage } {
  const app: HonoApp = new Hono();
  const storage = opts.storage ?? new MemoryObjectStorage();
  registerArtifactRoutes(app, {
    getDeployToken: () => opts.token,
    objectStorage: storage,
    now: opts.now,
  });
  return { app, storage };
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function uploadArtifact(
  app: HonoApp,
  token: string,
  body: Uint8Array,
  kind: string,
  metadata?: Record<string, unknown>,
): Promise<Response> {
  const form = new FormData();
  form.set("kind", kind);
  if (metadata) form.set("metadata", JSON.stringify(metadata));
  form.set(
    "body",
    new Blob([body as BlobPart]),
    "artifact.bin",
  );
  return await app.request(TAKOSUMI_ARTIFACTS_PATH, {
    method: "POST",
    headers: authHeaders(token),
    body: form,
  });
}

Deno.test("artifact upload returns 404 when token unset", async () => {
  const { app } = createApp({ token: undefined });
  const res = await uploadArtifact(
    app,
    "irrelevant",
    new Uint8Array([1, 2, 3]),
    "js-bundle",
  );
  assert.equal(res.status, 404);
});

Deno.test("artifact upload returns 401 on missing auth", async () => {
  const { app } = createApp({ token: VALID_TOKEN });
  const form = new FormData();
  form.set("kind", "js-bundle");
  form.set("body", new Blob([new Uint8Array([1]) as BlobPart]), "f.bin");
  const res = await app.request(TAKOSUMI_ARTIFACTS_PATH, {
    method: "POST",
    body: form,
  });
  assert.equal(res.status, 401);
});

Deno.test("artifact upload returns 400 when kind missing", async () => {
  const { app } = createApp({ token: VALID_TOKEN });
  const form = new FormData();
  form.set("body", new Blob([new Uint8Array([1]) as BlobPart]), "f.bin");
  const res = await app.request(TAKOSUMI_ARTIFACTS_PATH, {
    method: "POST",
    headers: authHeaders(VALID_TOKEN),
    body: form,
  });
  assert.equal(res.status, 400);
});

Deno.test("artifact upload returns 400 when body field missing", async () => {
  const { app } = createApp({ token: VALID_TOKEN });
  const form = new FormData();
  form.set("kind", "js-bundle");
  const res = await app.request(TAKOSUMI_ARTIFACTS_PATH, {
    method: "POST",
    headers: authHeaders(VALID_TOKEN),
    body: form,
  });
  assert.equal(res.status, 400);
});

Deno.test("artifact upload stores blob and returns ArtifactStored", async () => {
  const { app, storage } = createApp({
    token: VALID_TOKEN,
    now: () => "2026-05-02T10:00:00.000Z",
  });
  const bytes = new TextEncoder().encode("console.log('hi');");
  const res = await uploadArtifact(app, VALID_TOKEN, bytes, "js-bundle", {
    entrypoint: "index.js",
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.kind, "js-bundle");
  assert.equal(body.size, bytes.length);
  assert.equal(body.uploadedAt, "2026-05-02T10:00:00.000Z");
  assert.match(body.hash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(body.metadata, { entrypoint: "index.js" });

  // verify stored under the deterministic key
  const head = await storage.headObject({
    bucket: TAKOSUMI_ARTIFACTS_BUCKET,
    key: `artifacts/${body.hash}`,
  });
  assert.ok(head, "artifact must be persisted to object storage");
  assert.equal(head!.contentLength, bytes.length);
  assert.equal(head!.metadata.kind, "js-bundle");
});

Deno.test("artifact upload rejects mismatched expectedDigest", async () => {
  const { app } = createApp({ token: VALID_TOKEN });
  const form = new FormData();
  form.set("kind", "js-bundle");
  form.set("expectedDigest", "sha256:0000000000000000");
  form.set(
    "body",
    new Blob([new TextEncoder().encode("x") as BlobPart]),
    "x.js",
  );
  const res = await app.request(TAKOSUMI_ARTIFACTS_PATH, {
    method: "POST",
    headers: authHeaders(VALID_TOKEN),
    body: form,
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error.message, /digest mismatch/);
});

Deno.test("artifact GET returns the stored bytes", async () => {
  const { app } = createApp({ token: VALID_TOKEN });
  const bytes = new TextEncoder().encode("payload-payload");
  const upload = await uploadArtifact(app, VALID_TOKEN, bytes, "raw");
  const stored = await upload.json();
  const res = await app.request(`${TAKOSUMI_ARTIFACTS_PATH}/${stored.hash}`, {
    method: "GET",
    headers: authHeaders(VALID_TOKEN),
  });
  assert.equal(res.status, 200);
  const got = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual(Array.from(got), Array.from(bytes));
  assert.equal(res.headers.get("x-takosumi-artifact-kind"), "raw");
});

Deno.test("artifact HEAD returns metadata headers without body", async () => {
  const { app } = createApp({ token: VALID_TOKEN });
  const bytes = new Uint8Array([10, 20, 30]);
  const upload = await uploadArtifact(app, VALID_TOKEN, bytes, "lambda-zip");
  const stored = await upload.json();
  const res = await app.request(`${TAKOSUMI_ARTIFACTS_PATH}/${stored.hash}`, {
    method: "HEAD",
    headers: authHeaders(VALID_TOKEN),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-takosumi-artifact-kind"), "lambda-zip");
  assert.equal(res.headers.get("x-takosumi-artifact-size"), "3");
});

Deno.test("artifact GET returns 404 for unknown hash", async () => {
  const { app } = createApp({ token: VALID_TOKEN });
  const res = await app.request(
    `${TAKOSUMI_ARTIFACTS_PATH}/sha256:deadbeef`,
    { headers: authHeaders(VALID_TOKEN) },
  );
  assert.equal(res.status, 404);
});

Deno.test("artifact list returns all uploaded artifacts", async () => {
  const { app } = createApp({ token: VALID_TOKEN });
  await uploadArtifact(app, VALID_TOKEN, new Uint8Array([1]), "js-bundle");
  await uploadArtifact(app, VALID_TOKEN, new Uint8Array([2]), "lambda-zip");
  const res = await app.request(TAKOSUMI_ARTIFACTS_PATH, {
    headers: authHeaders(VALID_TOKEN),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.artifacts.length, 2);
  assert.deepEqual(
    body.artifacts.map((a: { kind: string }) => a.kind).sort(),
    ["js-bundle", "lambda-zip"],
  );
});

Deno.test("artifact DELETE removes the blob", async () => {
  const { app } = createApp({ token: VALID_TOKEN });
  const upload = await uploadArtifact(
    app,
    VALID_TOKEN,
    new Uint8Array([1, 2]),
    "js-bundle",
  );
  const stored = await upload.json();
  const res = await app.request(`${TAKOSUMI_ARTIFACTS_PATH}/${stored.hash}`, {
    method: "DELETE",
    headers: authHeaders(VALID_TOKEN),
  });
  assert.equal(res.status, 204);
  const after = await app.request(`${TAKOSUMI_ARTIFACTS_PATH}/${stored.hash}`, {
    headers: authHeaders(VALID_TOKEN),
  });
  assert.equal(after.status, 404);
});
