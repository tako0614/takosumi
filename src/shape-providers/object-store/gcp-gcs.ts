import type { ProviderPlugin } from "takosumi-contract";
import type {
  ObjectStoreCapability,
  ObjectStoreOutputs,
  ObjectStoreSpec,
} from "../../shapes/object-store.ts";

export interface GcsBucketDescriptor {
  readonly project: string;
  readonly bucketName: string;
  readonly location: string;
  readonly resourceName: string;
}

export interface GcsLifecycleClient {
  createBucket(input: {
    readonly bucketName: string;
    readonly location?: string;
    readonly versioning?: boolean;
    readonly publicAccess?: boolean;
  }): Promise<GcsBucketDescriptor>;
  describeBucket(input: {
    readonly bucketName: string;
  }): Promise<GcsBucketDescriptor | undefined>;
  deleteBucket(input: {
    readonly bucketName: string;
  }): Promise<boolean>;
}

export interface GcsProviderOptions {
  readonly lifecycle: GcsLifecycleClient;
  readonly project: string;
  readonly defaultLocation?: string;
  readonly secretRefBase?: string;
  readonly clock?: () => Date;
}

const SUPPORTED_CAPABILITIES: readonly ObjectStoreCapability[] = [
  "versioning",
  "presigned-urls",
  "server-side-encryption",
  "public-access",
  "event-notifications",
  "lifecycle-rules",
  "multipart-upload",
];

export function createGcsObjectStoreProvider(
  options: GcsProviderOptions,
): ProviderPlugin<ObjectStoreSpec, ObjectStoreOutputs> {
  const lifecycle = options.lifecycle;
  const fallbackLocation = options.defaultLocation ?? "us-central1";
  const secretBase = options.secretRefBase ?? "secret://gcp/gcs";
  const clock = options.clock ?? (() => new Date());
  return {
    id: "gcp-gcs",
    version: "1.0.0",
    implements: { id: "object-store", version: "v1" },
    capabilities: SUPPORTED_CAPABILITIES,
    async apply(spec, _ctx) {
      const desc = await lifecycle.createBucket({
        bucketName: spec.name,
        location: spec.region ?? fallbackLocation,
        versioning: spec.versioning ?? false,
        publicAccess: spec.public ?? false,
      });
      return {
        handle: desc.resourceName,
        outputs: outputsOf(desc, secretBase),
      };
    },
    async destroy(handle, _ctx) {
      await lifecycle.deleteBucket({ bucketName: nameFromResource(handle) });
    },
    async status(handle, _ctx) {
      const desc = await lifecycle.describeBucket({
        bucketName: nameFromResource(handle),
      });
      if (!desc) return { kind: "deleted", observedAt: clock().toISOString() };
      return {
        kind: "ready",
        outputs: outputsOf(desc, secretBase),
        observedAt: clock().toISOString(),
      };
    },
  };
}

function outputsOf(
  desc: GcsBucketDescriptor,
  secretBase: string,
): ObjectStoreOutputs {
  return {
    bucket: desc.bucketName,
    endpoint: `https://storage.googleapis.com/${desc.bucketName}`,
    region: desc.location,
    accessKeyRef: `${secretBase}/access-key`,
    secretKeyRef: `${secretBase}/secret-key`,
  };
}

function nameFromResource(resource: string): string {
  return resource.split("/").at(-1) ?? resource;
}

export class InMemoryGcsLifecycle implements GcsLifecycleClient {
  readonly #buckets = new Map<string, GcsBucketDescriptor>();
  readonly #project: string;

  constructor(project: string) {
    this.#project = project;
  }

  createBucket(input: {
    readonly bucketName: string;
    readonly location?: string;
  }): Promise<GcsBucketDescriptor> {
    const desc: GcsBucketDescriptor = {
      project: this.#project,
      bucketName: input.bucketName,
      location: input.location ?? "us-central1",
      resourceName: `projects/${this.#project}/buckets/${input.bucketName}`,
    };
    this.#buckets.set(input.bucketName, desc);
    return Promise.resolve(desc);
  }

  describeBucket(input: {
    readonly bucketName: string;
  }): Promise<GcsBucketDescriptor | undefined> {
    return Promise.resolve(this.#buckets.get(input.bucketName));
  }

  deleteBucket(input: {
    readonly bucketName: string;
  }): Promise<boolean> {
    return Promise.resolve(this.#buckets.delete(input.bucketName));
  }
}
