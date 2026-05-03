import type { ProviderPlugin, ResourceHandle } from "takosumi-contract";
import type {
  ObjectStoreCapability,
  ObjectStoreOutputs,
  ObjectStoreSpec,
} from "../../shapes/object-store.ts";

export interface CloudflareR2BucketDescriptor {
  readonly accountId: string;
  readonly bucketName: string;
  readonly locationHint?: string;
  readonly publicAccess?: boolean;
}

export interface CloudflareR2BucketCreateInput {
  readonly bucketName: string;
  readonly locationHint?: string;
  readonly publicAccess?: boolean;
}

export interface CloudflareR2BucketLifecycleClient {
  createBucket(
    input: CloudflareR2BucketCreateInput,
  ): Promise<CloudflareR2BucketDescriptor>;
  describeBucket(input: {
    readonly bucketName: string;
  }): Promise<CloudflareR2BucketDescriptor | undefined>;
  deleteBucket(input: {
    readonly bucketName: string;
  }): Promise<boolean>;
}

export interface CloudflareR2ObjectStoreProviderOptions {
  readonly lifecycle: CloudflareR2BucketLifecycleClient;
  readonly accountId: string;
  readonly secretRefBase?: string;
  readonly clock?: () => Date;
}

const SUPPORTED_CAPABILITIES: readonly ObjectStoreCapability[] = [
  "presigned-urls",
  "public-access",
  "multipart-upload",
];

export function createCloudflareR2ObjectStoreProvider(
  options: CloudflareR2ObjectStoreProviderOptions,
): ProviderPlugin<ObjectStoreSpec, ObjectStoreOutputs> {
  const lifecycle = options.lifecycle;
  const accountId = options.accountId;
  const secretBase = options.secretRefBase ??
    `secret://cloudflare/${accountId}/r2`;
  const clock = options.clock ?? (() => new Date());

  return {
    id: "@takos/cloudflare-r2",
    version: "1.0.0",
    implements: { id: "object-store", version: "v1" },
    capabilities: SUPPORTED_CAPABILITIES,
    async apply(spec, _ctx) {
      const desc = await lifecycle.createBucket({
        bucketName: spec.name,
        locationHint: spec.region,
        publicAccess: spec.public ?? false,
      });
      return {
        handle: r2Handle(desc.accountId, desc.bucketName),
        outputs: outputsFromDescriptor(desc, secretBase),
      };
    },
    async destroy(handle, _ctx) {
      await lifecycle.deleteBucket({
        bucketName: bucketNameFromHandle(handle),
      });
    },
    async status(handle, _ctx) {
      const desc = await lifecycle.describeBucket({
        bucketName: bucketNameFromHandle(handle),
      });
      if (!desc) {
        return { kind: "deleted", observedAt: clock().toISOString() };
      }
      return {
        kind: "ready",
        outputs: outputsFromDescriptor(desc, secretBase),
        observedAt: clock().toISOString(),
      };
    },
  };
}

function r2Handle(accountId: string, bucketName: string): ResourceHandle {
  return `cloudflare:r2:${accountId}:${bucketName}`;
}

function bucketNameFromHandle(handle: ResourceHandle): string {
  const parts = handle.split(":");
  return parts.at(-1) ?? handle;
}

function outputsFromDescriptor(
  desc: CloudflareR2BucketDescriptor,
  secretBase: string,
): ObjectStoreOutputs {
  return {
    bucket: desc.bucketName,
    endpoint:
      `https://${desc.accountId}.r2.cloudflarestorage.com/${desc.bucketName}`,
    region: desc.locationHint ?? "auto",
    accessKeyRef: `${secretBase}/access-key`,
    secretKeyRef: `${secretBase}/secret-key`,
  };
}

export class InMemoryCloudflareR2Lifecycle
  implements CloudflareR2BucketLifecycleClient {
  readonly #buckets = new Map<string, CloudflareR2BucketDescriptor>();
  readonly #accountId: string;

  constructor(accountId: string) {
    this.#accountId = accountId;
  }

  createBucket(
    input: CloudflareR2BucketCreateInput,
  ): Promise<CloudflareR2BucketDescriptor> {
    const desc: CloudflareR2BucketDescriptor = {
      accountId: this.#accountId,
      bucketName: input.bucketName,
      locationHint: input.locationHint,
      publicAccess: input.publicAccess,
    };
    this.#buckets.set(input.bucketName, desc);
    return Promise.resolve(desc);
  }

  describeBucket(
    input: { readonly bucketName: string },
  ): Promise<CloudflareR2BucketDescriptor | undefined> {
    return Promise.resolve(this.#buckets.get(input.bucketName));
  }

  deleteBucket(input: { readonly bucketName: string }): Promise<boolean> {
    return Promise.resolve(this.#buckets.delete(input.bucketName));
  }

  size(): number {
    return this.#buckets.size;
  }
}
