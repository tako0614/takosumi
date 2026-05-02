import { objectStorage } from "takosumi-contract";

export interface CloudflareR2ObjectHead {
  readonly bucket: string;
  readonly key: string;
  readonly contentLength?: number;
  readonly contentType?: string;
  readonly metadata?: Record<string, string>;
  readonly digest?: objectStorage.ObjectStorageDigest;
  readonly etag?: string;
  readonly updatedAt?: string;
}

export interface CloudflareR2Object extends CloudflareR2ObjectHead {
  readonly body: Uint8Array | ArrayBuffer | string;
}

export interface CloudflareR2PutObjectInput {
  readonly bucket: string;
  readonly key: string;
  readonly body: Uint8Array;
  readonly contentType?: string;
  readonly metadata?: Record<string, string>;
  readonly digest: objectStorage.ObjectStorageDigest;
}

export interface CloudflareR2ListInput {
  readonly bucket: string;
  readonly prefix?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface CloudflareR2ListResult {
  readonly objects: readonly CloudflareR2ObjectHead[];
  readonly nextCursor?: string;
}

export interface CloudflareR2ObjectStorageClient {
  putObject(input: CloudflareR2PutObjectInput): Promise<CloudflareR2ObjectHead>;
  getObject(
    input: objectStorage.ObjectStorageGetInput,
  ): Promise<CloudflareR2Object | undefined>;
  headObject(
    input: objectStorage.ObjectStorageHeadInput,
  ): Promise<CloudflareR2ObjectHead | undefined>;
  listObjects(input: CloudflareR2ListInput): Promise<CloudflareR2ListResult>;
  deleteObject(input: objectStorage.ObjectStorageDeleteInput): Promise<boolean>;
}

export interface CloudflareR2ObjectStorageAdapterOptions {
  readonly client: CloudflareR2ObjectStorageClient;
  readonly clock?: () => Date;
}

export class CloudflareR2ObjectStorageAdapter
  implements objectStorage.ObjectStoragePort {
  readonly #client: CloudflareR2ObjectStorageClient;
  readonly #clock: () => Date;

  constructor(options: CloudflareR2ObjectStorageAdapterOptions) {
    this.#client = options.client;
    this.#clock = options.clock ?? (() => new Date());
  }

  async putObject(
    input: objectStorage.ObjectStoragePutInput,
  ): Promise<objectStorage.ObjectStorageObjectHead> {
    const body = objectStorage.objectBodyBytes(input.body);
    const digest = await objectStorage.verifyObjectDigest(
      body,
      input.expectedDigest,
    );
    const stored = await this.#client.putObject({
      bucket: input.bucket,
      key: input.key,
      body,
      contentType: input.contentType,
      metadata: input.metadata,
      digest,
    });
    return this.#normalizeHead(stored, {
      contentLength: body.byteLength,
      contentType: input.contentType,
      digest,
      metadata: input.metadata,
    });
  }

  async getObject(
    input: objectStorage.ObjectStorageGetInput,
  ): Promise<objectStorage.ObjectStorageObject | undefined> {
    const record = await this.#client.getObject(input);
    if (!record) return undefined;
    const body = toBytes(record.body);
    const actualDigest = await objectStorage.verifyObjectDigest(
      body,
      input.expectedDigest,
    );
    if (record.digest !== undefined && record.digest !== actualDigest) {
      throw new objectStorage.ObjectStorageDigestMismatchError(
        record.digest,
        actualDigest,
      );
    }
    return {
      ...this.#normalizeHead(record, {
        contentLength: body.byteLength,
        digest: actualDigest,
        metadata: record.metadata,
      }),
      body,
    };
  }

  async headObject(
    input: objectStorage.ObjectStorageHeadInput,
  ): Promise<objectStorage.ObjectStorageObjectHead | undefined> {
    const record = await this.#client.headObject(input);
    if (!record) return undefined;
    if (
      input.expectedDigest !== undefined && record.digest !== undefined &&
      input.expectedDigest !== record.digest
    ) {
      throw new objectStorage.ObjectStorageDigestMismatchError(
        input.expectedDigest,
        record.digest,
      );
    }
    return this.#normalizeHead(record, {
      digest: input.expectedDigest,
      metadata: record.metadata,
    });
  }

  async listObjects(
    input: objectStorage.ObjectStorageListInput,
  ): Promise<objectStorage.ObjectStorageListResult> {
    const result = await this.#client.listObjects(input);
    return {
      objects: result.objects.map((item) => this.#normalizeHead(item)),
      nextCursor: result.nextCursor,
    };
  }

  deleteObject(
    input: objectStorage.ObjectStorageDeleteInput,
  ): Promise<boolean> {
    return this.#client.deleteObject(input);
  }

  #normalizeHead(
    record: CloudflareR2ObjectHead,
    fallback: {
      readonly contentLength?: number;
      readonly contentType?: string;
      readonly metadata?: Record<string, string>;
      readonly digest?: objectStorage.ObjectStorageDigest;
    } = {},
  ): objectStorage.ObjectStorageObjectHead {
    const digest = record.digest ?? fallback.digest;
    if (!digest) {
      throw new Error(
        `cloudflare r2 object ${record.bucket}/${record.key} missing digest`,
      );
    }
    return {
      bucket: record.bucket,
      key: record.key,
      contentLength: record.contentLength ?? fallback.contentLength ?? 0,
      contentType: record.contentType ?? fallback.contentType,
      metadata: { ...(fallback.metadata ?? {}), ...(record.metadata ?? {}) },
      digest,
      etag: record.etag ?? digest,
      updatedAt: record.updatedAt ?? this.#clock().toISOString(),
    };
  }
}

function toBytes(body: Uint8Array | ArrayBuffer | string): Uint8Array {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
  const copy = new Uint8Array(body.byteLength);
  copy.set(body);
  return copy;
}
