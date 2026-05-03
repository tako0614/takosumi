import assert from "node:assert/strict";
import { Hono, type Hono as HonoApp } from "hono";
import {
  registerArtifactKind,
  unregisterArtifactKind,
} from "takosumi-contract";
import { registerBundledArtifactKinds } from "@takos/takosumi-plugins/shape-providers";
import { MemoryObjectStorage } from "../adapters/object-storage/memory.ts";
import { InMemoryTakosumiDeploymentRecordStore } from "../domains/deploy/takosumi_deployment_record_store.ts";
import {
  registerArtifactRoutes,
  TAKOSUMI_ARTIFACT_MAX_BYTES_DEFAULT,
  TAKOSUMI_ARTIFACTS_BUCKET,
  TAKOSUMI_ARTIFACTS_PATH,
} from "./artifact_routes.ts";

const VALID_TOKEN = "test-token-abc";
const FETCH_TOKEN = "fetch-token-readonly";

function createApp(opts: {
  token?: string | undefined;
  fetchToken?: string | undefined;
  storage?: MemoryObjectStorage;
  recordStore?: InMemoryTakosumiDeploymentRecordStore;
  now?: () => string;
  maxBytes?: number;
} = {}): {
  app: HonoApp;
  storage: MemoryObjectStorage;
  recordStore?: InMemoryTakosumiDeploymentRecordStore;
} {
  const app: HonoApp = new Hono();
  const storage = opts.storage ?? new MemoryObjectStorage();
  registerArtifactRoutes(app, {
    getDeployToken: () => opts.token,
    ...(opts.fetchToken !== undefined
      ? { getArtifactFetchToken: () => opts.fetchToken }
      : {}),
    objectStorage: storage,
    ...(opts.recordStore ? { recordStore: opts.recordStore } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
  });
  return {
    app,
    storage,
    ...(opts.recordStore ? { recordStore: opts.recordStore } : {}),
  };
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

// --- Task 2: pagination ------------------------------------------------------

Deno.test("artifact list with limit=1 returns 1 + nextCursor", async () => {
  const { app } = createApp({ token: VALID_TOKEN });
  await uploadArtifact(app, VALID_TOKEN, new Uint8Array([1]), "js-bundle");
  await uploadArtifact(app, VALID_TOKEN, new Uint8Array([2]), "lambda-zip");
  const res = await app.request(`${TAKOSUMI_ARTIFACTS_PATH}?limit=1`, {
    headers: authHeaders(VALID_TOKEN),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.artifacts.length, 1);
  assert.ok(body.nextCursor, "nextCursor must be present when more pages");
});

Deno.test(
  "artifact list following cursor surfaces every artifact exactly once",
  async () => {
    const { app } = createApp({ token: VALID_TOKEN });
    await uploadArtifact(app, VALID_TOKEN, new Uint8Array([1]), "k1");
    await uploadArtifact(app, VALID_TOKEN, new Uint8Array([2]), "k2");
    await uploadArtifact(app, VALID_TOKEN, new Uint8Array([3]), "k3");
    const first = await app.request(`${TAKOSUMI_ARTIFACTS_PATH}?limit=1`, {
      headers: authHeaders(VALID_TOKEN),
    });
    const firstBody = await first.json();
    assert.equal(firstBody.artifacts.length, 1);
    assert.ok(firstBody.nextCursor);
    const seenHashes = new Set<string>([firstBody.artifacts[0].hash]);
    let cursor: string | undefined = firstBody.nextCursor;
    let pages = 0;
    while (cursor && pages < 10) {
      const next: Response = await app.request(
        `${TAKOSUMI_ARTIFACTS_PATH}?limit=1&cursor=${
          encodeURIComponent(cursor)
        }`,
        { headers: authHeaders(VALID_TOKEN) },
      );
      const body = await next.json();
      for (const a of body.artifacts) {
        assert.ok(!seenHashes.has(a.hash), "duplicate hash across pages");
        seenHashes.add(a.hash);
      }
      cursor = body.nextCursor;
      pages++;
    }
    assert.equal(seenHashes.size, 3, "pagination must surface every artifact");
  },
);

Deno.test("artifact list rejects non-positive limit", async () => {
  const { app } = createApp({ token: VALID_TOKEN });
  const res = await app.request(`${TAKOSUMI_ARTIFACTS_PATH}?limit=0`, {
    headers: authHeaders(VALID_TOKEN),
  });
  assert.equal(res.status, 400);
});

// --- Task 1: GC --------------------------------------------------------------

Deno.test(
  "artifact gc removes unreferenced artifacts but keeps referenced ones",
  async () => {
    const recordStore = new InMemoryTakosumiDeploymentRecordStore();
    const { app, storage } = createApp({
      token: VALID_TOKEN,
      recordStore,
    });
    const keepUpload = await uploadArtifact(
      app,
      VALID_TOKEN,
      new TextEncoder().encode("keep"),
      "js-bundle",
    );
    const keepBody = await keepUpload.json();
    const dropUpload = await uploadArtifact(
      app,
      VALID_TOKEN,
      new TextEncoder().encode("drop"),
      "js-bundle",
    );
    const dropBody = await dropUpload.json();
    await recordStore.upsert({
      tenantId: "takosumi-deploy",
      name: "app",
      manifest: {
        resources: [{ spec: { artifact: { hash: keepBody.hash } } }],
      },
      appliedResources: [],
      status: "applied",
      now: "2026-05-02T00:00:00.000Z",
    });
    const res = await app.request(`${TAKOSUMI_ARTIFACTS_PATH}/gc`, {
      method: "POST",
      headers: authHeaders(VALID_TOKEN),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.deleted, [dropBody.hash]);
    assert.equal(body.retained, 1);
    const keepHead = await storage.headObject({
      bucket: TAKOSUMI_ARTIFACTS_BUCKET,
      key: `artifacts/${keepBody.hash}`,
    });
    const dropHead = await storage.headObject({
      bucket: TAKOSUMI_ARTIFACTS_BUCKET,
      key: `artifacts/${dropBody.hash}`,
    });
    assert.ok(keepHead);
    assert.equal(dropHead, undefined);
  },
);

Deno.test("artifact gc respects dry-run", async () => {
  const recordStore = new InMemoryTakosumiDeploymentRecordStore();
  const { app, storage } = createApp({
    token: VALID_TOKEN,
    recordStore,
  });
  const upload = await uploadArtifact(
    app,
    VALID_TOKEN,
    new TextEncoder().encode("orphan"),
    "js-bundle",
  );
  const stored = await upload.json();
  const res = await app.request(
    `${TAKOSUMI_ARTIFACTS_PATH}/gc?dryRun=1`,
    { method: "POST", headers: authHeaders(VALID_TOKEN) },
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.dryRun, true);
  assert.deepEqual(body.deleted, [stored.hash]);
  const head = await storage.headObject({
    bucket: TAKOSUMI_ARTIFACTS_BUCKET,
    key: `artifacts/${stored.hash}`,
  });
  assert.ok(head, "dry run must not actually delete the blob");
});

Deno.test(
  "artifact gc keeps artifacts referenced by destroyed records",
  async () => {
    const recordStore = new InMemoryTakosumiDeploymentRecordStore();
    const { app, storage } = createApp({
      token: VALID_TOKEN,
      recordStore,
    });
    const upload = await uploadArtifact(
      app,
      VALID_TOKEN,
      new TextEncoder().encode("still-pinned"),
      "js-bundle",
    );
    const stored = await upload.json();
    await recordStore.upsert({
      tenantId: "takosumi-deploy",
      name: "destroyed-app",
      manifest: {
        resources: [{ spec: { artifact: { hash: stored.hash } } }],
      },
      appliedResources: [],
      status: "applied",
      now: "2026-05-02T00:00:00.000Z",
    });
    await recordStore.markDestroyed(
      "takosumi-deploy",
      "destroyed-app",
      "2026-05-02T01:00:00.000Z",
    );
    const res = await app.request(`${TAKOSUMI_ARTIFACTS_PATH}/gc`, {
      method: "POST",
      headers: authHeaders(VALID_TOKEN),
    });
    const body = await res.json();
    assert.deepEqual(body.deleted, []);
    assert.equal(body.retained, 1);
    const head = await storage.headObject({
      bucket: TAKOSUMI_ARTIFACTS_BUCKET,
      key: `artifacts/${stored.hash}`,
    });
    assert.ok(head);
  },
);

Deno.test("artifact gc is idempotent", async () => {
  const recordStore = new InMemoryTakosumiDeploymentRecordStore();
  const { app } = createApp({ token: VALID_TOKEN, recordStore });
  await uploadArtifact(
    app,
    VALID_TOKEN,
    new TextEncoder().encode("orphan"),
    "js-bundle",
  );
  const first = await app.request(`${TAKOSUMI_ARTIFACTS_PATH}/gc`, {
    method: "POST",
    headers: authHeaders(VALID_TOKEN),
  });
  const firstBody = await first.json();
  assert.equal(firstBody.deleted.length, 1);
  const second = await app.request(`${TAKOSUMI_ARTIFACTS_PATH}/gc`, {
    method: "POST",
    headers: authHeaders(VALID_TOKEN),
  });
  const secondBody = await second.json();
  assert.equal(secondBody.deleted.length, 0);
  assert.equal(secondBody.retained, 0);
});

Deno.test("artifact gc requires deploy token (not fetch token)", async () => {
  const recordStore = new InMemoryTakosumiDeploymentRecordStore();
  const { app } = createApp({
    token: VALID_TOKEN,
    fetchToken: FETCH_TOKEN,
    recordStore,
  });
  const res = await app.request(`${TAKOSUMI_ARTIFACTS_PATH}/gc`, {
    method: "POST",
    headers: authHeaders(FETCH_TOKEN),
  });
  assert.equal(res.status, 401);
});

// --- Task 3: read-only fetch token -------------------------------------------

Deno.test("artifact GET accepts the read-only fetch token", async () => {
  const { app } = createApp({
    token: VALID_TOKEN,
    fetchToken: FETCH_TOKEN,
  });
  const upload = await uploadArtifact(
    app,
    VALID_TOKEN,
    new TextEncoder().encode("hello"),
    "js-bundle",
  );
  const stored = await upload.json();
  const res = await app.request(`${TAKOSUMI_ARTIFACTS_PATH}/${stored.hash}`, {
    headers: authHeaders(FETCH_TOKEN),
  });
  assert.equal(res.status, 200);
});

Deno.test("artifact HEAD accepts the read-only fetch token", async () => {
  const { app } = createApp({
    token: VALID_TOKEN,
    fetchToken: FETCH_TOKEN,
  });
  const upload = await uploadArtifact(
    app,
    VALID_TOKEN,
    new TextEncoder().encode("hello"),
    "js-bundle",
  );
  const stored = await upload.json();
  const res = await app.request(`${TAKOSUMI_ARTIFACTS_PATH}/${stored.hash}`, {
    method: "HEAD",
    headers: authHeaders(FETCH_TOKEN),
  });
  assert.equal(res.status, 200);
});

Deno.test(
  "artifact POST rejects the read-only fetch token with 401",
  async () => {
    const { app } = createApp({
      token: VALID_TOKEN,
      fetchToken: FETCH_TOKEN,
    });
    const form = new FormData();
    form.set("kind", "js-bundle");
    form.set("body", new Blob([new Uint8Array([1]) as BlobPart]), "f.bin");
    const res = await app.request(TAKOSUMI_ARTIFACTS_PATH, {
      method: "POST",
      headers: authHeaders(FETCH_TOKEN),
      body: form,
    });
    assert.equal(res.status, 401);
  },
);

Deno.test(
  "artifact DELETE rejects the read-only fetch token with 401",
  async () => {
    const { app } = createApp({
      token: VALID_TOKEN,
      fetchToken: FETCH_TOKEN,
    });
    const upload = await uploadArtifact(
      app,
      VALID_TOKEN,
      new Uint8Array([1, 2]),
      "js-bundle",
    );
    const stored = await upload.json();
    const res = await app.request(
      `${TAKOSUMI_ARTIFACTS_PATH}/${stored.hash}`,
      {
        method: "DELETE",
        headers: authHeaders(FETCH_TOKEN),
      },
    );
    assert.equal(res.status, 401);
  },
);

Deno.test("artifact GET still works with the deploy token", async () => {
  // Sanity: setting the fetch token must NOT lock out the deploy token.
  const { app } = createApp({
    token: VALID_TOKEN,
    fetchToken: FETCH_TOKEN,
  });
  const upload = await uploadArtifact(
    app,
    VALID_TOKEN,
    new TextEncoder().encode("hello"),
    "js-bundle",
  );
  const stored = await upload.json();
  const res = await app.request(`${TAKOSUMI_ARTIFACTS_PATH}/${stored.hash}`, {
    headers: authHeaders(VALID_TOKEN),
  });
  assert.equal(res.status, 200);
});

// --- Task 4: maxBytes / 413 resource_exhausted -------------------------------

Deno.test("artifact upload below maxBytes succeeds", async () => {
  const { app } = createApp({ token: VALID_TOKEN, maxBytes: 1024 });
  const bytes = new TextEncoder().encode("under-cap");
  const res = await uploadArtifact(app, VALID_TOKEN, bytes, "js-bundle");
  assert.equal(res.status, 200);
});

Deno.test(
  "artifact upload above custom maxBytes returns 413 resource_exhausted",
  async () => {
    const { app } = createApp({ token: VALID_TOKEN, maxBytes: 8 });
    const bytes = new Uint8Array(64); // 64 bytes > 8 bytes cap
    const res = await uploadArtifact(app, VALID_TOKEN, bytes, "js-bundle");
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.equal(body.error.code, "resource_exhausted");
    assert.match(body.error.message, /artifact bytes exceed maxBytes/);
    // operator hints surfaced in the error message
    assert.match(body.error.message, /TAKOSUMI_ARTIFACT_MAX_BYTES/);
    assert.match(body.error.message, /R2 \/ S3 \/ GCS/);
  },
);

Deno.test(
  "artifact upload with Content-Length above cap returns 413 without buffering",
  async () => {
    const { app } = createApp({ token: VALID_TOKEN, maxBytes: 1024 });
    // Body itself is small, but the declared Content-Length lies. The
    // pre-check fires before the multipart body is parsed.
    const res = await app.request(TAKOSUMI_ARTIFACTS_PATH, {
      method: "POST",
      headers: {
        ...authHeaders(VALID_TOKEN),
        "content-type": "multipart/form-data; boundary=fake",
        "content-length": "1048576", // 1 MiB declared
      },
      body: "fake",
    });
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.equal(body.error.code, "resource_exhausted");
    assert.match(body.error.message, /content-length exceed maxBytes/);
    assert.match(body.error.message, /1048576 > 1024/);
  },
);

Deno.test(
  "artifact upload with Content-Length below cap reaches multipart parse",
  async () => {
    // Sanity: cap should ONLY fire when declared length is over. A
    // small declared value passes the gate; we then expect the normal
    // multipart-parse error path (since the body isn't valid multipart).
    const { app } = createApp({ token: VALID_TOKEN, maxBytes: 1024 });
    const res = await app.request(TAKOSUMI_ARTIFACTS_PATH, {
      method: "POST",
      headers: {
        ...authHeaders(VALID_TOKEN),
        "content-type": "multipart/form-data; boundary=fake",
        "content-length": "16",
      },
      body: "not-real-multipart",
    });
    // The Content-Length pre-check did not 413; instead we either get
    // 400 invalid_argument (multipart parse failed) or 200 if Hono is
    // lenient. Either way we must NOT see 413 here.
    assert.notEqual(res.status, 413);
  },
);

Deno.test(
  "artifact maxBytes default is 50 MiB and exposed as a constant",
  () => {
    assert.equal(TAKOSUMI_ARTIFACT_MAX_BYTES_DEFAULT, 52_428_800);
  },
);

Deno.test(
  "artifact upload uses default 50 MiB cap when option omitted",
  async () => {
    // Operator omits maxBytes entirely. A 1 KiB payload must fly under
    // the implicit 50 MiB default.
    const { app } = createApp({ token: VALID_TOKEN });
    const bytes = new Uint8Array(1024);
    const res = await uploadArtifact(app, VALID_TOKEN, bytes, "js-bundle");
    assert.equal(res.status, 200);
  },
);

// --- Task: GET /v1/artifacts/kinds discovery endpoint ------------------------

Deno.test(
  "GET /v1/artifacts/kinds returns 401 without bearer auth",
  async () => {
    registerBundledArtifactKinds();
    const { app } = createApp({ token: VALID_TOKEN });
    const res = await app.request(`${TAKOSUMI_ARTIFACTS_PATH}/kinds`);
    assert.equal(res.status, 401);
  },
);

Deno.test(
  "GET /v1/artifacts/kinds surfaces the bundled artifact kinds",
  async () => {
    registerBundledArtifactKinds();
    const { app } = createApp({ token: VALID_TOKEN });
    const res = await app.request(`${TAKOSUMI_ARTIFACTS_PATH}/kinds`, {
      headers: authHeaders(VALID_TOKEN),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.kinds), "kinds must be an array");
    const ids = (body.kinds as Array<{ kind: string }>).map((k) => k.kind);
    for (
      const expected of [
        "oci-image",
        "js-bundle",
        "lambda-zip",
        "static-bundle",
        "wasm",
      ]
    ) {
      assert.ok(ids.includes(expected), `missing bundled kind: ${expected}`);
    }
    const jsBundle = (body.kinds as Array<{
      kind: string;
      contentTypeHint?: string;
    }>).find((k) => k.kind === "js-bundle");
    assert.ok(jsBundle);
    assert.equal(jsBundle!.contentTypeHint, "application/javascript");
  },
);

Deno.test(
  "GET /v1/artifacts/kinds reflects newly registered kinds",
  async () => {
    registerBundledArtifactKinds();
    const { app } = createApp({ token: VALID_TOKEN });
    const customKind = {
      kind: "test-only-custom-kind",
      description: "A test-only kind to verify discovery",
      contentTypeHint: "application/x-test",
    };
    registerArtifactKind(customKind);
    try {
      const res = await app.request(`${TAKOSUMI_ARTIFACTS_PATH}/kinds`, {
        headers: authHeaders(VALID_TOKEN),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      const found = (body.kinds as Array<{ kind: string }>).find((k) =>
        k.kind === "test-only-custom-kind"
      );
      assert.ok(found, "newly registered kind must appear in discovery");
    } finally {
      unregisterArtifactKind("test-only-custom-kind");
    }
  },
);

Deno.test(
  "GET /v1/artifacts/kinds returns 404 when deploy token unset",
  async () => {
    registerBundledArtifactKinds();
    const { app } = createApp({ token: undefined });
    const res = await app.request(`${TAKOSUMI_ARTIFACTS_PATH}/kinds`, {
      headers: authHeaders("anything"),
    });
    assert.equal(res.status, 404);
  },
);
