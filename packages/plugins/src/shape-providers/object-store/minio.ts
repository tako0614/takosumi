import type { ProviderPlugin } from "takosumi-contract";
import type {
  ObjectStoreCapability,
  ObjectStoreOutputs,
  ObjectStoreSpec,
} from "../../shapes/object-store.ts";

export interface MinioBucketDescriptor {
  readonly bucketName: string;
  readonly endpoint: string;
}

export interface MinioLifecycleClient {
  createBucket(input: {
    readonly bucketName: string;
    readonly versioning?: boolean;
    readonly publicAccess?: boolean;
  }): Promise<MinioBucketDescriptor>;
  describeBucket(input: {
    readonly bucketName: string;
  }): Promise<MinioBucketDescriptor | undefined>;
  deleteBucket(input: {
    readonly bucketName: string;
  }): Promise<boolean>;
}

export interface MinioProviderOptions {
  readonly lifecycle: MinioLifecycleClient;
  readonly endpoint: string;
  readonly region?: string;
  readonly secretRefBase?: string;
  readonly clock?: () => Date;
}

const SUPPORTED_CAPABILITIES: readonly ObjectStoreCapability[] = [
  "versioning",
  "presigned-urls",
  "server-side-encryption",
  "public-access",
  "lifecycle-rules",
  "multipart-upload",
];

export function createMinioObjectStoreProvider(
  options: MinioProviderOptions,
): ProviderPlugin<ObjectStoreSpec, ObjectStoreOutputs> {
  const lifecycle = options.lifecycle;
  const endpoint = options.endpoint;
  const region = options.region ?? "local";
  const secretBase = options.secretRefBase ?? "secret://selfhosted/minio";
  const clock = options.clock ?? (() => new Date());

  function outputsOf(desc: MinioBucketDescriptor): ObjectStoreOutputs {
    return {
      bucket: desc.bucketName,
      endpoint: `${endpoint}/${desc.bucketName}`,
      region,
      accessKeyRef: `${secretBase}/access-key`,
      secretKeyRef: `${secretBase}/secret-key`,
    };
  }

  return {
    id: "@takos/selfhost-minio",
    version: "1.0.0",
    implements: { id: "object-store", version: "v1" },
    capabilities: SUPPORTED_CAPABILITIES,
    async apply(spec, _ctx) {
      const desc = await lifecycle.createBucket({
        bucketName: spec.name,
        versioning: spec.versioning ?? false,
        publicAccess: spec.public ?? false,
      });
      return { handle: desc.bucketName, outputs: outputsOf(desc) };
    },
    async destroy(handle, _ctx) {
      await lifecycle.deleteBucket({ bucketName: handle });
    },
    async status(handle, _ctx) {
      const desc = await lifecycle.describeBucket({ bucketName: handle });
      if (!desc) return { kind: "deleted", observedAt: clock().toISOString() };
      return {
        kind: "ready",
        outputs: outputsOf(desc),
        observedAt: clock().toISOString(),
      };
    },
  };
}

export class InMemoryMinioLifecycle implements MinioLifecycleClient {
  readonly #buckets = new Map<string, MinioBucketDescriptor>();
  readonly #endpoint: string;

  constructor(endpoint: string) {
    this.#endpoint = endpoint;
  }

  createBucket(input: {
    readonly bucketName: string;
  }): Promise<MinioBucketDescriptor> {
    const desc: MinioBucketDescriptor = {
      bucketName: input.bucketName,
      endpoint: this.#endpoint,
    };
    this.#buckets.set(input.bucketName, desc);
    return Promise.resolve(desc);
  }

  describeBucket(input: {
    readonly bucketName: string;
  }): Promise<MinioBucketDescriptor | undefined> {
    return Promise.resolve(this.#buckets.get(input.bucketName));
  }

  deleteBucket(input: {
    readonly bucketName: string;
  }): Promise<boolean> {
    return Promise.resolve(this.#buckets.delete(input.bucketName));
  }
}
