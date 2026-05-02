import assert from "node:assert/strict";
import {
  classifyObjectError,
  type SelfHostedObjectClient,
  SelfHostedObjectError,
  type SelfHostedObjectHead,
  type SelfHostedObjectLocation,
  type SelfHostedObjectPut,
  SelfHostedObjectReconciler,
} from "../src/providers/selfhosted/mod.ts";

class FakeS3 implements SelfHostedObjectClient {
  readonly objects = new Map<
    string,
    SelfHostedObjectHead & {
      body: Uint8Array;
    }
  >();
  readonly calls: Record<string, number> = {};
  readonly putFailures: number[] = [];
  readonly listFailures: number[] = [];

  putObject(input: SelfHostedObjectPut): Promise<SelfHostedObjectHead> {
    this.calls.put = (this.calls.put ?? 0) + 1;
    if (this.putFailures.length > 0) {
      const code = this.putFailures.shift()!;
      const error = new Error(`fake-${code}`);
      (error as unknown as { status: number }).status = code;
      throw error;
    }
    const head = {
      bucket: input.bucket,
      key: input.key,
      contentLength: input.body.byteLength,
      contentType: input.contentType,
      metadata: input.metadata,
      digest: input.digest,
      etag: input.digest.slice("sha256:".length),
      updatedAt: "2026-04-30T00:00:00.000Z",
      body: input.body,
    };
    this.objects.set(`${input.bucket}:${input.key}`, head);
    return Promise.resolve(head);
  }

  getObject(input: SelfHostedObjectLocation) {
    this.calls.get = (this.calls.get ?? 0) + 1;
    return Promise.resolve(this.objects.get(`${input.bucket}:${input.key}`));
  }

  headObject(input: SelfHostedObjectLocation) {
    this.calls.head = (this.calls.head ?? 0) + 1;
    return Promise.resolve(this.objects.get(`${input.bucket}:${input.key}`));
  }

  listObjects(
    input: { bucket: string; prefix?: string; cursor?: string; limit?: number },
  ) {
    this.calls.list = (this.calls.list ?? 0) + 1;
    if (this.listFailures.length > 0) {
      const code = this.listFailures.shift()!;
      const error = new Error(`fake-${code}`);
      (error as unknown as { status: number }).status = code;
      throw error;
    }
    const all = [...this.objects.values()].filter((entry) =>
      entry.bucket === input.bucket &&
      (!input.prefix || entry.key.startsWith(input.prefix))
    );
    const start = input.cursor ? Number.parseInt(input.cursor, 10) : 0;
    const limit = input.limit ?? all.length;
    const slice = all.slice(start, start + limit);
    const nextCursor = (start + slice.length) < all.length
      ? String(start + slice.length)
      : undefined;
    return Promise.resolve({ objects: slice, nextCursor });
  }

  deleteObject(input: SelfHostedObjectLocation) {
    this.calls.delete = (this.calls.delete ?? 0) + 1;
    return Promise.resolve(this.objects.delete(`${input.bucket}:${input.key}`));
  }
}

Deno.test("selfhosted object reconciler retries on 503 then succeeds", async () => {
  const client = new FakeS3();
  client.putFailures.push(503);
  const reconciler = new SelfHostedObjectReconciler({
    client,
    sleep: () => Promise.resolve(),
    initialBackoffMs: 1,
    maxAttempts: 3,
  });
  const head = await reconciler.putObject({
    bucket: "b",
    key: "k",
    body: new Uint8Array([1, 2, 3]),
    metadata: {},
    digest: "sha256:0",
  });
  assert.equal(head.bucket, "b");
  assert.equal(client.calls.put, 2);
});

Deno.test("selfhosted object reconciler surfaces NotFound as non-retryable", async () => {
  const client = new FakeS3();
  client.putFailures.push(404);
  const reconciler = new SelfHostedObjectReconciler({
    client,
    sleep: () => Promise.resolve(),
    initialBackoffMs: 1,
    maxAttempts: 3,
  });
  await assert.rejects(
    () =>
      reconciler.putObject({
        bucket: "b",
        key: "k",
        body: new Uint8Array(),
        metadata: {},
        digest: "sha256:0",
      }),
    (error) =>
      error instanceof SelfHostedObjectError &&
      error.code === "not-found",
  );
  assert.equal(client.calls.put, 1);
});

Deno.test("selfhosted object reconciler listAll paginates across cursors", async () => {
  const client = new FakeS3();
  for (let i = 0; i < 5; i++) {
    await client.putObject({
      bucket: "b",
      key: `k${i}`,
      body: new Uint8Array([i]),
      metadata: {},
      digest: `sha256:${i}`,
    });
  }
  const reconciler = new SelfHostedObjectReconciler({ client });
  const all = await reconciler.listAll({ bucket: "b", limit: 2, maxPages: 5 });
  assert.equal(all.length, 2);
});

Deno.test("classifyObjectError maps throttling status to retryable error", () => {
  const error = new Error("Slow Down");
  (error as unknown as { status: number }).status = 429;
  const classified = classifyObjectError(error);
  assert.equal(classified.code, "throttled");
  assert.equal(classified.retryable, true);
});

Deno.test("selfhosted object reconciler ensureBucket noops when client lacks support", async () => {
  const client = new FakeS3();
  const reconciler = new SelfHostedObjectReconciler({ client });
  // Should not throw.
  await reconciler.ensureBucket({ bucket: "b" });
  assert.equal(client.calls.put ?? 0, 0);
});
