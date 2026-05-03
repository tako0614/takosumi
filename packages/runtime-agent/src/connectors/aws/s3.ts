/**
 * `AwsS3Connector` — wraps `DirectAwsS3Lifecycle` and exposes the
 * `Connector` lifecycle protocol envelope expected by the runtime-agent.
 */

import type { JsonObject } from "takosumi-contract";
import type {
  LifecycleApplyRequest,
  LifecycleApplyResponse,
  LifecycleDescribeRequest,
  LifecycleDescribeResponse,
  LifecycleDestroyRequest,
  LifecycleDestroyResponse,
} from "takosumi-contract";
import type { Connector, ConnectorContext } from "../connector.ts";
import {
  type AwsS3BucketDescriptor,
  DirectAwsS3Lifecycle,
} from "./_s3_lifecycle.ts";

export interface AwsS3ConnectorOptions {
  readonly region: string;
  readonly credentials: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly sessionToken?: string;
  };
  readonly secretRefBase?: string;
  readonly fetch?: typeof fetch;
}

const ARN_PREFIX = "arn:aws:s3:::";

export class AwsS3Connector implements Connector {
  readonly provider = "aws-s3";
  readonly shape = "object-store@v1";
  readonly acceptedArtifactKinds: readonly string[] = [];
  readonly #lifecycle: DirectAwsS3Lifecycle;
  readonly #region: string;
  readonly #secretBase: string;

  constructor(opts: AwsS3ConnectorOptions) {
    this.#lifecycle = new DirectAwsS3Lifecycle({
      region: opts.region,
      credentials: opts.credentials,
      fetch: opts.fetch,
    });
    this.#region = opts.region;
    this.#secretBase = opts.secretRefBase ?? "secret://aws/credentials";
  }

  async apply(
    req: LifecycleApplyRequest,
    _ctx: ConnectorContext,
  ): Promise<LifecycleApplyResponse> {
    const spec = req.spec as unknown as {
      name: string;
      region?: string;
      versioning?: boolean;
      public?: boolean;
    };
    const desc = await this.#lifecycle.createBucket({
      bucketName: spec.name,
      region: spec.region ?? this.#region,
      versioningEnabled: spec.versioning ?? false,
      publicAccessBlockEnabled: !(spec.public ?? false),
    });
    return {
      handle: desc.arn,
      outputs: this.#outputsFor(desc),
    };
  }

  async destroy(
    req: LifecycleDestroyRequest,
    _ctx: ConnectorContext,
  ): Promise<LifecycleDestroyResponse> {
    const bucket = bucketFromArn(req.handle);
    const deleted = await this.#lifecycle.deleteBucket({
      bucketName: bucket,
      emptyBeforeDelete: true,
    });
    return deleted ? { ok: true } : { ok: true, note: "bucket not found" };
  }

  async describe(
    req: LifecycleDescribeRequest,
    _ctx: ConnectorContext,
  ): Promise<LifecycleDescribeResponse> {
    const bucket = bucketFromArn(req.handle);
    const desc = await this.#lifecycle.describeBucket({ bucketName: bucket });
    if (!desc) return { status: "missing" };
    return { status: "running", outputs: this.#outputsFor(desc) };
  }

  #outputsFor(desc: AwsS3BucketDescriptor): JsonObject {
    const region = desc.region ?? this.#region;
    return {
      bucket: desc.bucketName,
      endpoint: `https://s3.${region}.amazonaws.com/${desc.bucketName}`,
      region,
      accessKeyRef: `${this.#secretBase}/access-key`,
      secretKeyRef: `${this.#secretBase}/secret-key`,
    };
  }
}

function bucketFromArn(handle: string): string {
  return handle.startsWith(ARN_PREFIX)
    ? handle.slice(ARN_PREFIX.length)
    : handle;
}
