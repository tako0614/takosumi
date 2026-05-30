import { objectBodyBytes, verifyObjectDigest } from "./digest.ts";
import type {
  ObjectStorageDeleteInput,
  ObjectStorageGetInput,
  ObjectStorageListInput,
  ObjectStorageListResult,
  ObjectStorageObject,
  ObjectStorageObjectHead,
  ObjectStoragePort,
  ObjectStoragePutInput,
} from "./types.ts";

export interface MemoryObjectStorageOptions {
  readonly clock?: () => Date;
}

interface StoredObject extends ObjectStorageObjectHead {
  readonly body: Uint8Array;
}

export class MemoryObjectStorage implements ObjectStoragePort {
  readonly #objects = new Map<string, StoredObject>();
  readonly #clock: () => Date;

  constructor(options: MemoryObjectStorageOptions = {}) {
    this.#clock = options.clock ?? (() => new Date());
  }

  async putObject(
    input: ObjectStoragePutInput,
  ): Promise<ObjectStorageObjectHead> {
    const body = objectBodyBytes(input.body);
    const digest = await verifyObjectDigest(body, input.expectedDigest);
    const record: StoredObject = Object.freeze({
      bucket: input.bucket,
      key: input.key,
      body: new Uint8Array(body),
      contentLength: body.byteLength,
      contentType: input.contentType,
      metadata: Object.freeze({ ...(input.metadata ?? {}) }),
      digest,
      etag: digest.slice("sha256:".length),
      updatedAt: this.#clock().toISOString(),
    });
    this.#objects.set(storageId(input.bucket, input.key), record);
    return cloneHead(record);
  }

  async getObject(
    input: ObjectStorageGetInput,
  ): Promise<ObjectStorageObject | undefined> {
    const record = this.#objects.get(storageId(input.bucket, input.key));
    if (record === undefined) return undefined;
    await verifyObjectDigest(
      record.body,
      input.expectedDigest ?? record.digest,
    );
    return Object.freeze({
      ...cloneHead(record),
      body: new Uint8Array(record.body),
    });
  }

  async headObject(
    input: ObjectStorageGetInput,
  ): Promise<ObjectStorageObjectHead | undefined> {
    const record = this.#objects.get(storageId(input.bucket, input.key));
    if (record === undefined) return undefined;
    await verifyObjectDigest(
      record.body,
      input.expectedDigest ?? record.digest,
    );
    return cloneHead(record);
  }

  listObjects(input: ObjectStorageListInput): Promise<ObjectStorageListResult> {
    const prefix = input.prefix ?? "";
    const limit = input.limit ?? Number.POSITIVE_INFINITY;
    const startAfter = input.cursor ?? "";
    const objects = Array.from(this.#objects.values())
      .filter((object) => object.bucket === input.bucket)
      .filter((object) => object.key.startsWith(prefix))
      .sort((left, right) => left.key.localeCompare(right.key))
      .filter((object) => startAfter === "" || object.key > startAfter);
    const page = objects.slice(0, limit).map(cloneHead);
    const nextCursor = objects.length > page.length
      ? page[page.length - 1]?.key
      : undefined;
    return Promise.resolve(Object.freeze({ objects: page, nextCursor }));
  }

  deleteObject(input: ObjectStorageDeleteInput): Promise<boolean> {
    return Promise.resolve(
      this.#objects.delete(storageId(input.bucket, input.key)),
    );
  }
}

function storageId(bucket: string, key: string): string {
  return `${bucket}\0${key}`;
}

function cloneHead(record: ObjectStorageObjectHead): ObjectStorageObjectHead {
  return Object.freeze({
    bucket: record.bucket,
    key: record.key,
    contentLength: record.contentLength,
    contentType: record.contentType,
    metadata: { ...record.metadata },
    digest: record.digest,
    etag: record.etag,
    updatedAt: record.updatedAt,
  });
}
