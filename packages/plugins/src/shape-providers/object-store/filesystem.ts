import type { ProviderPlugin, ResourceHandle } from "takosumi-contract";
import type {
  ObjectStoreCapability,
  ObjectStoreOutputs,
  ObjectStoreSpec,
} from "../../shapes/object-store.ts";

export interface FilesystemBucketDescriptor {
  readonly path: string;
  readonly bucketName: string;
}

export interface FilesystemBucketLifecycleClient {
  createBucket(input: {
    readonly bucketName: string;
  }): Promise<FilesystemBucketDescriptor>;
  describeBucket(input: {
    readonly bucketName: string;
  }): Promise<FilesystemBucketDescriptor | undefined>;
  deleteBucket(input: {
    readonly bucketName: string;
    readonly recursive?: boolean;
  }): Promise<boolean>;
}

export interface FilesystemObjectStoreProviderOptions {
  readonly lifecycle: FilesystemBucketLifecycleClient;
  readonly rootDir: string;
  readonly secretRefBase?: string;
  readonly clock?: () => Date;
}

const SUPPORTED_CAPABILITIES: readonly ObjectStoreCapability[] = [
  "presigned-urls",
];

export function createFilesystemObjectStoreProvider(
  options: FilesystemObjectStoreProviderOptions,
): ProviderPlugin<ObjectStoreSpec, ObjectStoreOutputs> {
  const lifecycle = options.lifecycle;
  const rootDir = options.rootDir;
  const secretBase = options.secretRefBase ??
    `secret://selfhosted/object-store`;
  const clock = options.clock ?? (() => new Date());

  return {
    id: "filesystem",
    version: "1.0.0",
    implements: { id: "object-store", version: "v1" },
    capabilities: SUPPORTED_CAPABILITIES,
    async apply(spec, _ctx) {
      const desc = await lifecycle.createBucket({ bucketName: spec.name });
      return {
        handle: desc.path,
        outputs: outputsFromDescriptor(desc, secretBase),
      };
    },
    async destroy(handle, _ctx) {
      await lifecycle.deleteBucket({
        bucketName: bucketNameFromPath(handle, rootDir),
        recursive: true,
      });
    },
    async status(handle, _ctx) {
      const desc = await lifecycle.describeBucket({
        bucketName: bucketNameFromPath(handle, rootDir),
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

function bucketNameFromPath(handle: ResourceHandle, rootDir: string): string {
  const stripped = handle.startsWith(`${rootDir}/`)
    ? handle.slice(rootDir.length + 1)
    : handle;
  const slash = stripped.indexOf("/");
  return slash >= 0 ? stripped.slice(0, slash) : stripped;
}

function outputsFromDescriptor(
  desc: FilesystemBucketDescriptor,
  secretBase: string,
): ObjectStoreOutputs {
  return {
    bucket: desc.bucketName,
    endpoint: `file://${desc.path}`,
    region: "local",
    accessKeyRef: `${secretBase}/access-key`,
    secretKeyRef: `${secretBase}/secret-key`,
  };
}

export class InMemoryFilesystemLifecycle
  implements FilesystemBucketLifecycleClient {
  readonly #buckets = new Map<string, FilesystemBucketDescriptor>();
  readonly #rootDir: string;

  constructor(rootDir: string) {
    this.#rootDir = rootDir;
  }

  createBucket(
    input: { readonly bucketName: string },
  ): Promise<FilesystemBucketDescriptor> {
    const desc: FilesystemBucketDescriptor = {
      bucketName: input.bucketName,
      path: `${this.#rootDir}/${input.bucketName}`,
    };
    this.#buckets.set(input.bucketName, desc);
    return Promise.resolve(desc);
  }

  describeBucket(
    input: { readonly bucketName: string },
  ): Promise<FilesystemBucketDescriptor | undefined> {
    return Promise.resolve(this.#buckets.get(input.bucketName));
  }

  deleteBucket(
    input: { readonly bucketName: string },
  ): Promise<boolean> {
    return Promise.resolve(this.#buckets.delete(input.bucketName));
  }

  size(): number {
    return this.#buckets.size;
  }
}
