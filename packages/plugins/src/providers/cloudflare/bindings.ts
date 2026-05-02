import type { coordination, objectStorage, queue } from "takosumi-contract";
import {
  CloudflareD1StorageAdapter,
  type CloudflareD1StorageClient,
} from "./d1_storage.ts";
import {
  CloudflareDurableObjectsCoordinationAdapter,
  type CloudflareDurableObjectsCoordinationClient,
} from "./durable_objects_coordination.ts";
import { CloudflareQueueAdapter, type CloudflareQueueClient } from "./queue.ts";
import {
  type CloudflareR2ListResult,
  type CloudflareR2Object,
  type CloudflareR2ObjectHead,
  CloudflareR2ObjectStorageAdapter,
  type CloudflareR2ObjectStorageClient,
  type CloudflareR2PutObjectInput,
} from "./r2_object_storage.ts";

const DIGEST_METADATA_KEY = "takos-digest";

export interface CloudflareR2BucketBinding {
  put(
    key: string,
    value: Uint8Array,
    options?: CloudflareR2PutOptions,
  ): Promise<CloudflareR2ObjectBinding | null>;
  get(key: string): Promise<CloudflareR2ObjectBodyBinding | null>;
  head(key: string): Promise<CloudflareR2ObjectBinding | null>;
  list(
    options?: CloudflareR2ListOptions,
  ): Promise<CloudflareR2BindingListResult>;
  delete(key: string): Promise<void>;
}

export interface CloudflareR2PutOptions {
  readonly httpMetadata?: {
    readonly contentType?: string;
  };
  readonly customMetadata?: Record<string, string>;
}

export interface CloudflareR2ListOptions {
  readonly prefix?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface CloudflareR2BindingListResult {
  readonly objects: readonly CloudflareR2ObjectBinding[];
  readonly truncated?: boolean;
  readonly cursor?: string;
}

export interface CloudflareR2ObjectBinding {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly uploaded: Date;
  readonly httpMetadata?: {
    readonly contentType?: string;
  };
  readonly customMetadata?: Record<string, string>;
}

export interface CloudflareR2ObjectBodyBinding
  extends CloudflareR2ObjectBinding {
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface CloudflareR2BindingClientOptions {
  readonly bucket?: CloudflareR2BucketBinding;
  readonly bucketName?: string;
  readonly buckets?: Record<string, CloudflareR2BucketBinding>;
}

export function createCloudflareR2ObjectStorageClientFromBindings(
  options: CloudflareR2BindingClientOptions,
): CloudflareR2ObjectStorageClient {
  return new CloudflareR2BindingObjectStorageClient(options);
}

export function createCloudflareR2ObjectStorageAdapterFromBindings(
  options:
    & CloudflareR2BindingClientOptions
    & Omit<
      ConstructorParameters<typeof CloudflareR2ObjectStorageAdapter>[0],
      "client"
    >,
): CloudflareR2ObjectStorageAdapter {
  return new CloudflareR2ObjectStorageAdapter({
    ...options,
    client: createCloudflareR2ObjectStorageClientFromBindings(options),
  });
}

export interface CloudflareQueueBinding<TPayload = unknown> {
  send(
    message: CloudflareQueueBindingMessage<TPayload>,
    options?: CloudflareQueueSendOptions,
  ): Promise<void>;
}

export interface CloudflareQueueBindingMessage<TPayload = unknown> {
  readonly id: string;
  readonly queue: string;
  readonly payload: TPayload;
  readonly metadata: Record<string, unknown>;
  readonly enqueuedAt: string;
  readonly availableAt: string;
  readonly priority: number;
  readonly maxAttempts: number;
}

export interface CloudflareQueueSendOptions {
  readonly delaySeconds?: number;
}

export interface CloudflareQueueBindingClientOptions {
  readonly queue?: CloudflareQueueBinding;
  readonly queueName?: string;
  readonly queues?: Record<string, CloudflareQueueBinding>;
  readonly fullQueueClient?: CloudflareQueueClient;
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
}

export class CloudflareWorkerQueueUnsupportedOperationError extends Error {
  constructor(operation: "lease" | "ack" | "nack" | "deadLetter") {
    super(
      `cloudflare worker Queue binding only supports enqueue; inject a full CloudflareQueueClient to ${operation} messages`,
    );
    this.name = "CloudflareWorkerQueueUnsupportedOperationError";
  }
}

export function createCloudflareQueueClientFromBindings(
  options: CloudflareQueueBindingClientOptions,
): CloudflareQueueClient {
  if (options.fullQueueClient) return options.fullQueueClient;
  return new CloudflareQueueBindingClient(options);
}

export function createCloudflareQueueAdapterFromBindings(
  options: CloudflareQueueBindingClientOptions,
): CloudflareQueueAdapter {
  return new CloudflareQueueAdapter(
    createCloudflareQueueClientFromBindings(options),
  );
}

export interface CloudflareD1DatabaseBinding {
  prepare(query: string): unknown;
}

export interface CloudflareD1StorageGateway {
  createStorageClient(
    database: CloudflareD1DatabaseBinding,
  ): CloudflareD1StorageClient;
}

export type CloudflareD1StorageGatewayFactory = (
  database: CloudflareD1DatabaseBinding,
) => CloudflareD1StorageClient;

export interface CloudflareD1StorageBindingOptions {
  readonly database: CloudflareD1DatabaseBinding;
  readonly storageClient?: CloudflareD1StorageClient;
  readonly storageGateway?:
    | CloudflareD1StorageGateway
    | CloudflareD1StorageGatewayFactory;
}

export function createCloudflareD1StorageClientFromBinding(
  options: CloudflareD1StorageBindingOptions,
): CloudflareD1StorageClient {
  if (options.storageClient) return options.storageClient;
  if (typeof options.storageGateway === "function") {
    return options.storageGateway(options.database);
  }
  if (options.storageGateway) {
    return options.storageGateway.createStorageClient(options.database);
  }
  throw new Error(
    "cloudflare D1 binding cannot be used as Takos storage by itself; inject CloudflareD1StorageClient or CloudflareD1StorageGateway",
  );
}

export function createCloudflareD1StorageAdapterFromBinding(
  options: CloudflareD1StorageBindingOptions,
): CloudflareD1StorageAdapter {
  return new CloudflareD1StorageAdapter(
    createCloudflareD1StorageClientFromBinding(options),
  );
}

export interface CloudflareDurableObjectNamespaceBinding {
  idFromName(name: string): unknown;
  get(id: unknown): CloudflareDurableObjectStubBinding;
}

export interface CloudflareDurableObjectStubBinding {
  fetch(request: Request): Promise<Response>;
}

export interface CloudflareDurableObjectsBindingClientOptions {
  readonly namespace: CloudflareDurableObjectNamespaceBinding;
  readonly objectName?: string;
  readonly baseUrl?: string | URL;
}

export function createCloudflareDurableObjectsCoordinationClientFromBinding(
  options: CloudflareDurableObjectsBindingClientOptions,
): CloudflareDurableObjectsCoordinationClient {
  return new CloudflareDurableObjectsBindingCoordinationClient(options);
}

export function createCloudflareDurableObjectsCoordinationAdapterFromBinding(
  options: CloudflareDurableObjectsBindingClientOptions,
): CloudflareDurableObjectsCoordinationAdapter {
  return new CloudflareDurableObjectsCoordinationAdapter(
    createCloudflareDurableObjectsCoordinationClientFromBinding(options),
  );
}

class CloudflareR2BindingObjectStorageClient
  implements CloudflareR2ObjectStorageClient {
  readonly #bucket?: CloudflareR2BucketBinding;
  readonly #bucketName?: string;
  readonly #buckets: Readonly<Record<string, CloudflareR2BucketBinding>>;

  constructor(options: CloudflareR2BindingClientOptions) {
    this.#bucket = options.bucket;
    this.#bucketName = options.bucketName;
    this.#buckets = options.buckets ?? {};
  }

  async putObject(
    input: CloudflareR2PutObjectInput,
  ): Promise<CloudflareR2ObjectHead> {
    const bucket = this.#resolveBucket(input.bucket);
    const customMetadata = {
      ...(input.metadata ?? {}),
      [DIGEST_METADATA_KEY]: input.digest,
    };
    const stored = await bucket.put(input.key, input.body, {
      httpMetadata: { contentType: input.contentType },
      customMetadata,
    });
    if (!stored) {
      throw new Error(
        `cloudflare r2 binding did not return object metadata for ${input.bucket}/${input.key}`,
      );
    }
    return bindingObjectHead(input.bucket, stored, input.digest);
  }

  async getObject(
    input: objectStorage.ObjectStorageGetInput,
  ): Promise<CloudflareR2Object | undefined> {
    const object = await this.#resolveBucket(input.bucket).get(input.key);
    if (!object) return undefined;
    return {
      ...bindingObjectHead(input.bucket, object),
      body: new Uint8Array(await object.arrayBuffer()),
    };
  }

  async headObject(
    input: objectStorage.ObjectStorageHeadInput,
  ): Promise<CloudflareR2ObjectHead | undefined> {
    const object = await this.#resolveBucket(input.bucket).head(input.key);
    if (!object) return undefined;
    return bindingObjectHead(input.bucket, object);
  }

  async listObjects(
    input: objectStorage.ObjectStorageListInput,
  ): Promise<CloudflareR2ListResult> {
    const result = await this.#resolveBucket(input.bucket).list({
      prefix: input.prefix,
      cursor: input.cursor,
      limit: input.limit,
    });
    return {
      objects: result.objects.map((object) =>
        bindingObjectHead(input.bucket, object)
      ),
      nextCursor: result.truncated ? result.cursor : undefined,
    };
  }

  async deleteObject(
    input: objectStorage.ObjectStorageDeleteInput,
  ): Promise<boolean> {
    const bucket = this.#resolveBucket(input.bucket);
    const existed = await bucket.head(input.key);
    await bucket.delete(input.key);
    return existed !== null;
  }

  #resolveBucket(bucketName: string): CloudflareR2BucketBinding {
    const mapped = this.#buckets[bucketName];
    if (mapped) return mapped;
    if (this.#bucket && this.#bucketName === bucketName) return this.#bucket;
    throw new Error(
      `cloudflare r2 binding for bucket "${bucketName}" is not configured`,
    );
  }
}

class CloudflareQueueBindingClient implements CloudflareQueueClient {
  readonly #queue?: CloudflareQueueBinding;
  readonly #queueName?: string;
  readonly #queues: Readonly<Record<string, CloudflareQueueBinding>>;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;

  constructor(options: CloudflareQueueBindingClientOptions) {
    this.#queue = options.queue;
    this.#queueName = options.queueName;
    this.#queues = options.queues ?? {};
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
  }

  async enqueue<TPayload = unknown>(
    input: queue.EnqueueInput<TPayload>,
  ): Promise<queue.QueueMessage<TPayload>> {
    const now = this.#clock().toISOString();
    const message: queue.QueueMessage<TPayload> = {
      id: input.messageId ?? `cf_queue_${this.#idGenerator()}`,
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
    await this.#resolveQueue(input.queue).send(
      {
        id: message.id,
        queue: message.queue,
        payload: message.payload,
        metadata: message.metadata,
        enqueuedAt: message.enqueuedAt,
        availableAt: message.availableAt,
        priority: message.priority,
        maxAttempts: message.maxAttempts,
      },
      queueSendOptions(message.availableAt, now),
    );
    return message;
  }

  lease<TPayload = unknown>(
    _input: queue.LeaseInput,
  ): Promise<queue.QueueLease<TPayload> | undefined> {
    return Promise.reject(
      new CloudflareWorkerQueueUnsupportedOperationError("lease"),
    );
  }

  ack(_input: queue.AckInput): Promise<void> {
    return Promise.reject(
      new CloudflareWorkerQueueUnsupportedOperationError("ack"),
    );
  }

  nack<TPayload = unknown>(
    _input: queue.NackInput,
  ): Promise<queue.QueueMessage<TPayload>> {
    return Promise.reject(
      new CloudflareWorkerQueueUnsupportedOperationError("nack"),
    );
  }

  deadLetter<TPayload = unknown>(
    _input: queue.DeadLetterInput,
  ): Promise<queue.QueueMessage<TPayload>> {
    return Promise.reject(
      new CloudflareWorkerQueueUnsupportedOperationError("deadLetter"),
    );
  }

  #resolveQueue(queueName: string): CloudflareQueueBinding {
    const mapped = this.#queues[queueName];
    if (mapped) return mapped;
    if (this.#queue && this.#queueName === queueName) return this.#queue;
    throw new Error(
      `cloudflare Queue binding for queue "${queueName}" is not configured`,
    );
  }
}

class CloudflareDurableObjectsBindingCoordinationClient
  implements CloudflareDurableObjectsCoordinationClient {
  readonly #stub: CloudflareDurableObjectStubBinding;
  readonly #baseUrl: string;

  constructor(options: CloudflareDurableObjectsBindingClientOptions) {
    const objectName = options.objectName ?? "takos-control-plane";
    this.#stub = options.namespace.get(
      options.namespace.idFromName(objectName),
    );
    this.#baseUrl = `${options.baseUrl ?? "https://takos-coordination.local/"}`;
  }

  acquireLease(
    input: coordination.CoordinationLeaseInput,
  ): Promise<coordination.CoordinationLease> {
    return this.#post("acquire-lease", input);
  }

  renewLease(
    input: coordination.CoordinationRenewInput,
  ): Promise<coordination.CoordinationLease> {
    return this.#post("renew-lease", input);
  }

  releaseLease(
    input: coordination.CoordinationReleaseInput,
  ): Promise<boolean> {
    return this.#post("release-lease", input);
  }

  getLease(scope: string): Promise<coordination.CoordinationLease | undefined> {
    return this.#post("get-lease", { scope });
  }

  scheduleAlarm(
    input: coordination.CoordinationAlarmInput,
  ): Promise<coordination.CoordinationAlarm> {
    return this.#post("schedule-alarm", input);
  }

  cancelAlarm(id: string): Promise<boolean> {
    return this.#post("cancel-alarm", { id });
  }

  listAlarms(
    scope?: string,
  ): Promise<readonly coordination.CoordinationAlarm[]> {
    return this.#post("list-alarms", { scope });
  }

  async #post<TResult>(path: string, body: unknown): Promise<TResult> {
    const response = await this.#stub.fetch(
      new Request(urlFor(this.#baseUrl, path), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `cloudflare Durable Object coordination ${path} failed: HTTP ${response.status}${
          text ? `: ${text}` : ""
        }`,
      );
    }
    if (!text || response.status === 204) return undefined as TResult;
    const parsed = JSON.parse(text);
    return (isRecord(parsed) && Object.hasOwn(parsed, "result")
      ? parsed.result
      : parsed) as TResult;
  }
}

function bindingObjectHead(
  bucket: string,
  object: CloudflareR2ObjectBinding,
  digestOverride?: objectStorage.ObjectStorageDigest,
): CloudflareR2ObjectHead {
  const metadata = object.customMetadata ?? {};
  const digest = digestOverride ?? metadata[DIGEST_METADATA_KEY];
  if (!digest) {
    throw new Error(
      `cloudflare r2 object ${bucket}/${object.key} missing digest`,
    );
  }
  return {
    bucket,
    key: object.key,
    contentLength: object.size,
    contentType: object.httpMetadata?.contentType,
    metadata: stripDigestMetadata(metadata),
    digest: digest as objectStorage.ObjectStorageDigest,
    etag: object.etag,
    updatedAt: object.uploaded.toISOString(),
  };
}

function stripDigestMetadata(
  metadata: Record<string, string>,
): Record<string, string> {
  const { [DIGEST_METADATA_KEY]: _digest, ...rest } = metadata;
  return rest;
}

function queueSendOptions(
  availableAt: string,
  now: string,
): CloudflareQueueSendOptions | undefined {
  const delayMs = Date.parse(availableAt) - Date.parse(now);
  if (!Number.isFinite(delayMs) || delayMs <= 0) return undefined;
  return { delaySeconds: Math.ceil(delayMs / 1000) };
}

function urlFor(baseUrl: string, path: string): URL {
  const normalized = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(path, normalized);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
