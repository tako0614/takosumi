import assert from "node:assert/strict";
import { type queue, storage } from "takosumi-contract";
import {
  type CloudflareD1DatabaseBinding,
  type CloudflareDurableObjectNamespaceBinding,
  type CloudflareDurableObjectStubBinding,
  type CloudflareQueueBindingMessage,
  type CloudflareQueueClient,
  type CloudflareR2BucketBinding,
  type CloudflareR2ListOptions,
  type CloudflareR2ObjectBinding,
  type CloudflareR2ObjectBodyBinding,
  CloudflareWorkerQueueUnsupportedOperationError,
  createCloudflareD1StorageAdapterFromBinding,
  createCloudflareDurableObjectsCoordinationAdapterFromBinding,
  createCloudflareQueueAdapterFromBindings,
  createCloudflareR2ObjectStorageAdapterFromBindings,
} from "../src/providers/cloudflare/mod.ts";

const now = "2026-04-29T00:00:00.000Z";

Deno.test("Cloudflare R2 binding client adapts Worker bucket operations", async () => {
  const bucket = new FakeR2BucketBinding();
  const adapter = createCloudflareR2ObjectStorageAdapterFromBindings({
    bucket,
    bucketName: "takos-artifacts",
  });

  const put = await adapter.putObject({
    bucket: "takos-artifacts",
    key: "objects/hello.txt",
    body: "hello",
    contentType: "text/plain",
    metadata: { role: "artifact" },
  });

  assert.equal(put.contentLength, 5);
  assert.equal(put.contentType, "text/plain");
  assert.equal(put.metadata.role, "artifact");
  assert.equal(put.metadata["takos-digest"], undefined);
  assert.match(put.digest, /^sha256:/);

  const got = await adapter.getObject({
    bucket: "takos-artifacts",
    key: "objects/hello.txt",
    expectedDigest: put.digest,
  });
  assert.equal(new TextDecoder().decode(got?.body), "hello");

  const listed = await adapter.listObjects({
    bucket: "takos-artifacts",
    prefix: "objects/",
  });
  assert.equal(listed.objects.length, 1);
  assert.equal(listed.objects[0]?.key, "objects/hello.txt");

  assert.equal(
    await adapter.deleteObject({
      bucket: "takos-artifacts",
      key: "objects/hello.txt",
    }),
    true,
  );
  assert.equal(
    await adapter.headObject({
      bucket: "takos-artifacts",
      key: "objects/hello.txt",
    }),
    undefined,
  );
});

Deno.test("Cloudflare Queue binding client only exposes enqueue without a full queue client", async () => {
  const binding = new FakeQueueBinding();
  const adapter = createCloudflareQueueAdapterFromBindings({
    queue: binding,
    queueName: "control",
    clock: () => new Date(now),
    idGenerator: () => "message_1",
  });

  const message = await adapter.enqueue({
    queue: "control",
    payload: { op: "deploy" },
    availableAt: "2026-04-29T00:00:05.000Z",
    metadata: { source: "test" },
  });

  assert.equal(message.id, "cf_queue_message_1");
  assert.equal(binding.sent[0]?.message.id, message.id);
  assert.deepEqual(binding.sent[0]?.message.payload, { op: "deploy" });
  assert.equal(binding.sent[0]?.options?.delaySeconds, 5);

  await assert.rejects(
    () => adapter.lease({ queue: "control" }),
    CloudflareWorkerQueueUnsupportedOperationError,
  );
  await assert.rejects(
    () =>
      adapter.ack({
        queue: "control",
        messageId: message.id,
        leaseToken: "lease",
      }),
    /inject a full CloudflareQueueClient/,
  );
});

Deno.test("Cloudflare Queue binding helper delegates when a full queue client is injected", async () => {
  const fullQueueClient = new FakeFullQueueClient();
  const adapter = createCloudflareQueueAdapterFromBindings({
    fullQueueClient,
  });

  const message = await adapter.enqueue({
    queue: "control",
    payload: "payload",
  });
  const lease = await adapter.lease({ queue: "control" });
  await adapter.ack({
    queue: "control",
    messageId: message.id,
    leaseToken: lease?.token ?? "",
  });

  assert.equal(fullQueueClient.acked[0], "message_1");
});

Deno.test("Cloudflare D1 binding helper requires an injected storage client or gateway", async () => {
  const database = new FakeD1DatabaseBinding();

  assert.throws(
    () => createCloudflareD1StorageAdapterFromBinding({ database }),
    /cannot be used as Takos storage by itself/,
  );

  const memoryStorage = new storage.MemoryStorageDriver();
  const adapter = createCloudflareD1StorageAdapterFromBinding({
    database,
    storageGateway: {
      createStorageClient(input) {
        assert.equal(input, database);
        return memoryStorage;
      },
    },
  });

  assert.equal(await adapter.transaction(() => "committed"), "committed");
});

Deno.test("Cloudflare Durable Object binding helper calls coordination endpoints", async () => {
  const stub = new FakeDurableObjectStub();
  const namespace = new FakeDurableObjectNamespace(stub);
  const adapter = createCloudflareDurableObjectsCoordinationAdapterFromBinding({
    namespace,
    objectName: "takos-control-plane",
  });

  const lease = await adapter.acquireLease({
    scope: "deploy:space_1",
    holderId: "worker_1",
    ttlMs: 30_000,
  });
  assert.equal(lease.acquired, true);
  assert.equal(lease.token, "lease_1");

  assert.equal(
    (await adapter.getLease("deploy:space_1"))?.holderId,
    "worker_1",
  );
  assert.deepEqual(stub.paths, ["acquire-lease", "get-lease"]);
});

class FakeR2BucketBinding implements CloudflareR2BucketBinding {
  readonly #objects = new Map<string, StoredR2Object>();

  put(
    key: string,
    value: Uint8Array,
    options?: Parameters<CloudflareR2BucketBinding["put"]>[2],
  ): Promise<CloudflareR2ObjectBinding> {
    const object: StoredR2Object = {
      key,
      size: value.byteLength,
      etag: `etag:${key}`,
      uploaded: new Date(now),
      httpMetadata: options?.httpMetadata,
      customMetadata: options?.customMetadata,
      body: copyBytes(value),
      arrayBuffer() {
        return Promise.resolve(copyBytes(this.body).buffer);
      },
    };
    this.#objects.set(key, object);
    return Promise.resolve(object);
  }

  get(key: string): Promise<CloudflareR2ObjectBodyBinding | null> {
    return Promise.resolve(this.#objects.get(key) ?? null);
  }

  head(key: string): Promise<CloudflareR2ObjectBinding | null> {
    return Promise.resolve(this.#objects.get(key) ?? null);
  }

  list(options?: CloudflareR2ListOptions) {
    const objects = [...this.#objects.values()].filter((object) =>
      options?.prefix === undefined || object.key.startsWith(options.prefix)
    );
    return Promise.resolve({ objects, truncated: false });
  }

  delete(key: string): Promise<void> {
    this.#objects.delete(key);
    return Promise.resolve();
  }
}

interface StoredR2Object extends CloudflareR2ObjectBodyBinding {
  readonly body: Uint8Array;
}

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

class FakeQueueBinding {
  readonly sent: {
    readonly message: CloudflareQueueBindingMessage;
    readonly options?: { readonly delaySeconds?: number };
  }[] = [];

  send(
    message: CloudflareQueueBindingMessage,
    options?: { readonly delaySeconds?: number },
  ): Promise<void> {
    this.sent.push({ message, options });
    return Promise.resolve();
  }
}

class FakeFullQueueClient implements CloudflareQueueClient {
  readonly acked: string[] = [];
  #message: queue.QueueMessage<unknown> | undefined;

  enqueue<TPayload>(
    input: queue.EnqueueInput<TPayload>,
  ): Promise<queue.QueueMessage<TPayload>> {
    const message: queue.QueueMessage<TPayload> = {
      id: input.messageId ?? "message_1",
      queue: input.queue,
      payload: input.payload,
      status: "queued",
      priority: input.priority ?? 0,
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 3,
      enqueuedAt: now,
      availableAt: input.availableAt ?? now,
      metadata: input.metadata ?? {},
    };
    this.#message = message;
    return Promise.resolve(message);
  }

  lease<TPayload>(): Promise<queue.QueueLease<TPayload> | undefined> {
    if (!this.#message) return Promise.resolve(undefined);
    return Promise.resolve({
      token: "lease_1",
      message: {
        ...this.#message,
        status: "leased",
        leaseToken: "lease_1",
      } as queue.QueueMessage<TPayload>,
      leasedAt: now,
      expiresAt: now,
    });
  }

  ack(input: queue.AckInput): Promise<void> {
    this.acked.push(input.messageId);
    return Promise.resolve();
  }

  nack<TPayload>(): Promise<queue.QueueMessage<TPayload>> {
    return Promise.resolve(this.#message as queue.QueueMessage<TPayload>);
  }

  deadLetter<TPayload>(): Promise<queue.QueueMessage<TPayload>> {
    return Promise.resolve(this.#message as queue.QueueMessage<TPayload>);
  }
}

class FakeD1DatabaseBinding implements CloudflareD1DatabaseBinding {
  prepare(query: string): unknown {
    return { query };
  }
}

class FakeDurableObjectNamespace
  implements CloudflareDurableObjectNamespaceBinding {
  constructor(readonly stub: CloudflareDurableObjectStubBinding) {}

  idFromName(name: string): string {
    return name;
  }

  get(_id: unknown): CloudflareDurableObjectStubBinding {
    return this.stub;
  }
}

class FakeDurableObjectStub implements CloudflareDurableObjectStubBinding {
  readonly paths: string[] = [];
  #lease: unknown;

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname.replace(/^\/+/, "");
    this.paths.push(path);
    const body = await request.json() as Record<string, unknown>;
    if (path === "acquire-lease") {
      this.#lease = {
        scope: body.scope,
        holderId: body.holderId,
        token: "lease_1",
        acquired: true,
        expiresAt: "2026-04-29T00:00:30.000Z",
      };
      return Response.json({ result: this.#lease });
    }
    if (path === "get-lease") {
      return Response.json({ result: this.#lease });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }
}
