import { objectStorage } from "takosumi-contract/reference/compat";
import { bytesFromBody, freezeClone, sha256Digest } from "./common.ts";

export interface ExternalObjectClient {
  putObject(input: ExternalObjectPut): Promise<ExternalObjectHead>;
  getObject(
    input: ExternalObjectLocation,
  ): Promise<ExternalObject | undefined>;
  headObject(
    input: ExternalObjectLocation,
  ): Promise<ExternalObjectHead | undefined>;
  listObjects(input: {
    readonly bucket: string;
    readonly prefix?: string;
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<{
    readonly objects: readonly ExternalObjectHead[];
    readonly nextCursor?: string;
  }>;
  deleteObject(input: ExternalObjectLocation): Promise<boolean>;
}

export interface ExternalObjectLocation {
  readonly bucket: string;
  readonly key: string;
}

export interface ExternalObjectPut extends ExternalObjectLocation {
  readonly body: Uint8Array;
  readonly contentType?: string;
  readonly metadata: Record<string, string>;
  readonly digest: objectStorage.ObjectStorageDigest;
}

export interface ExternalObjectHead extends ExternalObjectLocation {
  readonly contentLength: number;
  readonly contentType?: string;
  readonly metadata?: Record<string, string>;
  readonly digest?: objectStorage.ObjectStorageDigest;
  readonly etag?: string;
  readonly updatedAt?: string;
}

export interface ExternalObject extends ExternalObjectHead {
  readonly body: Uint8Array;
}

export interface ExternalObjectStorageAdapterOptions {
  readonly client: ExternalObjectClient;
  readonly clock?: () => Date;
}

export class ExternalObjectStorageAdapter
  implements objectStorage.ObjectStoragePort {
  readonly #client: ExternalObjectClient;
  readonly #clock: () => Date;

  constructor(options: ExternalObjectStorageAdapterOptions) {
    this.#client = options.client;
    this.#clock = options.clock ?? (() => new Date());
  }

  async putObject(
    input: objectStorage.ObjectStoragePutInput,
  ): Promise<objectStorage.ObjectStorageObjectHead> {
    const body = bytesFromBody(input.body);
    const digest = await verifyDigest(body, input.expectedDigest);
    const head = await this.#client.putObject({
      bucket: input.bucket,
      key: input.key,
      body,
      contentType: input.contentType,
      metadata: { ...(input.metadata ?? {}) },
      digest,
    });
    return normalizeHead(head, digest, this.#clock);
  }

  async getObject(
    input: objectStorage.ObjectStorageGetInput,
  ): Promise<objectStorage.ObjectStorageObject | undefined> {
    const object = await this.#client.getObject(input);
    if (!object) return undefined;
    const digest = await verifyDigest(
      object.body,
      input.expectedDigest ?? object.digest,
    );
    return freezeClone({
      ...normalizeHead(object, digest, this.#clock),
      body: bytesFromBody(object.body),
    });
  }

  async headObject(
    input: objectStorage.ObjectStorageHeadInput,
  ): Promise<objectStorage.ObjectStorageObjectHead | undefined> {
    const head = await this.#client.headObject(input);
    if (!head) return undefined;
    if (
      input.expectedDigest && head.digest &&
      input.expectedDigest !== head.digest
    ) {
      throw new objectStorage.ObjectStorageDigestMismatchError(
        input.expectedDigest,
        head.digest,
      );
    }
    return normalizeHead(
      head,
      input.expectedDigest ?? head.digest,
      this.#clock,
    );
  }

  async listObjects(
    input: objectStorage.ObjectStorageListInput,
  ): Promise<objectStorage.ObjectStorageListResult> {
    const result = await this.#client.listObjects(input);
    return freezeClone({
      objects: result.objects.map((head) =>
        normalizeHead(head, head.digest, this.#clock)
      ),
      nextCursor: result.nextCursor,
    });
  }

  deleteObject(
    input: objectStorage.ObjectStorageDeleteInput,
  ): Promise<boolean> {
    return this.#client.deleteObject(input);
  }
}

async function verifyDigest(
  body: Uint8Array,
  expectedDigest?: objectStorage.ObjectStorageDigest,
): Promise<objectStorage.ObjectStorageDigest> {
  const actualDigest = await sha256Digest(body);
  if (expectedDigest && expectedDigest !== actualDigest) {
    throw new objectStorage.ObjectStorageDigestMismatchError(
      expectedDigest,
      actualDigest,
    );
  }
  return actualDigest;
}

function normalizeHead(
  head: ExternalObjectHead,
  digest: objectStorage.ObjectStorageDigest | undefined,
  clock: () => Date,
): objectStorage.ObjectStorageObjectHead {
  const normalizedDigest = digest ?? head.digest ??
    `sha256:${head.etag ?? "unknown"}` as objectStorage.ObjectStorageDigest;
  return freezeClone({
    bucket: head.bucket,
    key: head.key,
    contentLength: head.contentLength,
    contentType: head.contentType,
    metadata: { ...(head.metadata ?? {}) },
    digest: normalizedDigest,
    etag: head.etag ?? normalizedDigest.slice("sha256:".length),
    updatedAt: head.updatedAt ?? clock().toISOString(),
  });
}
