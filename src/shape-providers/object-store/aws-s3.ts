import type { ProviderPlugin, ResourceHandle } from "takosumi-contract";
import type {
  ObjectStoreCapability,
  ObjectStoreOutputs,
  ObjectStoreSpec,
} from "../../shapes/object-store.ts";
import {
  type AwsS3BucketCreateInput,
  type AwsS3BucketDeleteInput,
  type AwsS3BucketDescribeInput,
  type AwsS3BucketDescriptor,
  type AwsS3LifecycleClient,
  AwsS3Provider,
} from "../../providers/aws/s3.ts";

export interface AwsS3ObjectStoreProviderOptions {
  readonly lifecycle: AwsS3LifecycleClient;
  readonly defaultRegion?: string;
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

export function createAwsS3ObjectStoreProvider(
  options: AwsS3ObjectStoreProviderOptions,
): ProviderPlugin<ObjectStoreSpec, ObjectStoreOutputs> {
  const inner = new AwsS3Provider({ lifecycle: options.lifecycle });
  const fallbackRegion = options.defaultRegion ?? "us-east-1";
  const secretBase = options.secretRefBase ?? "secret://aws/credentials";
  const clock = options.clock ?? (() => new Date());

  return {
    id: "aws-s3",
    version: "1.0.0",
    implements: { id: "object-store", version: "v1" },
    capabilities: SUPPORTED_CAPABILITIES,
    async apply(spec, _ctx) {
      const desc = await inner.createBucket(
        buildCreateInput(spec, fallbackRegion),
      );
      return {
        handle: desc.arn,
        outputs: outputsFromDescriptor(desc, fallbackRegion, secretBase),
      };
    },
    async destroy(handle, _ctx) {
      await inner.deleteBucket(buildDeleteInput(handle));
    },
    async status(handle, _ctx) {
      const desc = await inner.describeBucket(buildDescribeInput(handle));
      if (!desc) {
        return { kind: "deleted", observedAt: clock().toISOString() };
      }
      return {
        kind: "ready",
        outputs: outputsFromDescriptor(desc, fallbackRegion, secretBase),
        observedAt: clock().toISOString(),
      };
    },
  };
}

function buildCreateInput(
  spec: ObjectStoreSpec,
  fallbackRegion: string,
): AwsS3BucketCreateInput {
  return {
    bucketName: spec.name,
    region: spec.region ?? fallbackRegion,
    versioningEnabled: spec.versioning ?? false,
    publicAccessBlockEnabled: !(spec.public ?? false),
  };
}

function buildDescribeInput(handle: ResourceHandle): AwsS3BucketDescribeInput {
  return { bucketName: bucketNameFromHandle(handle) };
}

function buildDeleteInput(handle: ResourceHandle): AwsS3BucketDeleteInput {
  return { bucketName: bucketNameFromHandle(handle), emptyBeforeDelete: true };
}

function bucketNameFromHandle(handle: ResourceHandle): string {
  const sep = handle.indexOf(":::");
  return sep >= 0 ? handle.slice(sep + 3) : handle;
}

function outputsFromDescriptor(
  desc: AwsS3BucketDescriptor,
  fallbackRegion: string,
  secretBase: string,
): ObjectStoreOutputs {
  const region = desc.region ?? fallbackRegion;
  return {
    bucket: desc.bucketName,
    endpoint: `https://s3.${region}.amazonaws.com/${desc.bucketName}`,
    region,
    accessKeyRef: `${secretBase}/access-key`,
    secretKeyRef: `${secretBase}/secret-key`,
  };
}

export class InMemoryAwsS3Lifecycle implements AwsS3LifecycleClient {
  readonly #buckets = new Map<string, AwsS3BucketDescriptor>();
  readonly #defaultRegion: string;

  constructor(defaultRegion = "us-east-1") {
    this.#defaultRegion = defaultRegion;
  }

  createBucket(input: AwsS3BucketCreateInput): Promise<AwsS3BucketDescriptor> {
    const desc: AwsS3BucketDescriptor = {
      bucketName: input.bucketName,
      arn: `arn:aws:s3:::${input.bucketName}`,
      region: input.region ?? this.#defaultRegion,
      versioningEnabled: input.versioningEnabled ?? false,
      publicAccessBlockEnabled: input.publicAccessBlockEnabled ?? true,
    };
    this.#buckets.set(input.bucketName, desc);
    return Promise.resolve(desc);
  }

  describeBucket(
    input: AwsS3BucketDescribeInput,
  ): Promise<AwsS3BucketDescriptor | undefined> {
    return Promise.resolve(this.#buckets.get(input.bucketName));
  }

  deleteBucket(input: AwsS3BucketDeleteInput): Promise<boolean> {
    return Promise.resolve(this.#buckets.delete(input.bucketName));
  }

  size(): number {
    return this.#buckets.size;
  }
}
