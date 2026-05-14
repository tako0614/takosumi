import {
  objectBodyBytes,
  verifyObjectDigest,
} from "../../../packages/kernel/src/adapters/object-storage/digest.ts";
import {
  type ObjectStorageDeleteInput,
  type ObjectStorageDigest,
  ObjectStorageDigestMismatchError,
  type ObjectStorageGetInput,
  type ObjectStorageHeadInput,
  type ObjectStorageListInput,
  type ObjectStorageListResult,
  type ObjectStorageObject,
  type ObjectStorageObjectHead,
  type ObjectStoragePort,
  type ObjectStoragePutInput,
} from "../../../packages/kernel/src/adapters/object-storage/mod.ts";
import type { R2Bucket, R2Object } from "./bindings.ts";

const DIGEST_METADATA_KEY = "takosumi-digest";
const LOGICAL_BUCKET_METADATA_KEY = "takosumi-bucket";
const LOGICAL_KEY_METADATA_KEY = "takosumi-key";

export class CloudflareR2ObjectStorage implements ObjectStoragePort {
  constructor(private readonly bucket: R2Bucket) {}

  async putObject(
    input: ObjectStoragePutInput,
  ): Promise<ObjectStorageObjectHead> {
    const body = objectBodyBytes(input.body);
    const digest = await verifyObjectDigest(body, input.expectedDigest);
    const object = await this.bucket.put(physicalKey(input), body, {
      httpMetadata: {
        ...(input.contentType ? { contentType: input.contentType } : {}),
      },
      customMetadata: {
        ...input.metadata,
        [DIGEST_METADATA_KEY]: digest,
        [LOGICAL_BUCKET_METADATA_KEY]: input.bucket,
        [LOGICAL_KEY_METADATA_KEY]: input.key,
      },
    });
    return headFromR2Object(object, input.bucket, input.key, digest);
  }

  async getObject(
    input: ObjectStorageGetInput,
  ): Promise<ObjectStorageObject | undefined> {
    const object = await this.bucket.get(physicalKey(input));
    if (!object) return undefined;
    const body = new Uint8Array(await object.arrayBuffer());
    const digest = await verifyObjectDigest(
      body,
      input.expectedDigest ??
        digestMetadata(object.customMetadata?.[DIGEST_METADATA_KEY]),
    );
    return {
      ...headFromR2Object(object, input.bucket, input.key, digest),
      body,
    };
  }

  async headObject(
    input: ObjectStorageHeadInput,
  ): Promise<ObjectStorageObjectHead | undefined> {
    const object = await this.bucket.head(physicalKey(input));
    if (!object) return undefined;
    const digest = digestMetadata(object.customMetadata?.[DIGEST_METADATA_KEY]);
    if (!digest) {
      if (input.expectedDigest) {
        throw new ObjectStorageDigestMismatchError(
          input.expectedDigest,
          `sha256:${object.etag}` as ObjectStorageDigest,
        );
      }
      throw new Error(
        `R2 object is missing ${DIGEST_METADATA_KEY}: ${input.key}`,
      );
    }
    if (input.expectedDigest && input.expectedDigest !== digest) {
      throw new ObjectStorageDigestMismatchError(input.expectedDigest, digest);
    }
    return headFromR2Object(object, input.bucket, input.key, digest);
  }

  async listObjects(
    input: ObjectStorageListInput,
  ): Promise<ObjectStorageListResult> {
    const prefix = `${encodeBucket(input.bucket)}/${input.prefix ?? ""}`;
    const result = await this.bucket.list({
      prefix,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.limit ? { limit: input.limit } : {}),
    });
    return {
      objects: result.objects.map((object) => {
        const logical = logicalLocation(object);
        return headFromR2Object(
          object,
          logical.bucket,
          logical.key,
          digestMetadata(object.customMetadata?.[DIGEST_METADATA_KEY]) ??
            `sha256:${object.etag}` as ObjectStorageDigest,
        );
      }),
      ...(result.truncated && result.cursor
        ? { nextCursor: result.cursor }
        : {}),
    };
  }

  async deleteObject(input: ObjectStorageDeleteInput): Promise<boolean> {
    const existing = await this.bucket.head(physicalKey(input));
    if (!existing) return false;
    await this.bucket.delete(physicalKey(input));
    return true;
  }
}

function physicalKey(input: { readonly bucket: string; readonly key: string }) {
  return `${encodeBucket(input.bucket)}/${input.key}`;
}

function encodeBucket(bucket: string): string {
  return encodeURIComponent(bucket);
}

function logicalLocation(object: R2Object): { bucket: string; key: string } {
  const bucket = object.customMetadata?.[LOGICAL_BUCKET_METADATA_KEY];
  const key = object.customMetadata?.[LOGICAL_KEY_METADATA_KEY];
  if (bucket && key) return { bucket, key };
  const slash = object.key.indexOf("/");
  if (slash < 0) return { bucket: "", key: object.key };
  return {
    bucket: decodeURIComponent(object.key.slice(0, slash)),
    key: object.key.slice(slash + 1),
  };
}

function headFromR2Object(
  object: R2Object,
  bucket: string,
  key: string,
  digest: ObjectStorageDigest,
): ObjectStorageObjectHead {
  const metadata = { ...(object.customMetadata ?? {}) };
  delete metadata[DIGEST_METADATA_KEY];
  delete metadata[LOGICAL_BUCKET_METADATA_KEY];
  delete metadata[LOGICAL_KEY_METADATA_KEY];
  return {
    bucket,
    key,
    contentLength: object.size,
    contentType: object.httpMetadata?.contentType,
    metadata,
    digest,
    etag: object.etag,
    updatedAt: object.uploaded.toISOString(),
  };
}

function digestMetadata(
  value: string | undefined,
): ObjectStorageDigest | undefined {
  return value?.startsWith("sha256:")
    ? value as ObjectStorageDigest
    : undefined;
}
