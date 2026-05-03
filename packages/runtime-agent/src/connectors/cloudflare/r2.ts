/**
 * `CloudflareR2Connector` — wraps `DirectCloudflareR2Lifecycle` for
 * `object-store@v1`.
 */

import type {
  JsonObject,
  LifecycleApplyRequest,
  LifecycleApplyResponse,
  LifecycleDescribeRequest,
  LifecycleDescribeResponse,
  LifecycleDestroyRequest,
  LifecycleDestroyResponse,
} from "takosumi-contract";
import type { Connector, ConnectorContext } from "../connector.ts";
import {
  type CloudflareR2BucketDescriptor,
  DirectCloudflareR2Lifecycle,
} from "./_r2_lifecycle.ts";

export interface CloudflareR2ConnectorOptions {
  readonly accountId: string;
  readonly apiToken: string;
  readonly secretRefBase?: string;
  readonly fetch?: typeof fetch;
}

const HANDLE_PREFIX = "cloudflare:r2:";

export class CloudflareR2Connector implements Connector {
  readonly provider = "cloudflare-r2";
  readonly shape = "object-store@v1";
  readonly acceptedArtifactKinds: readonly string[] = [];
  readonly #lifecycle: DirectCloudflareR2Lifecycle;
  readonly #accountId: string;
  readonly #secretBase: string;

  constructor(opts: CloudflareR2ConnectorOptions) {
    this.#lifecycle = new DirectCloudflareR2Lifecycle({
      accountId: opts.accountId,
      apiToken: opts.apiToken,
      fetch: opts.fetch,
    });
    this.#accountId = opts.accountId;
    this.#secretBase = opts.secretRefBase ??
      `secret://cloudflare/${opts.accountId}/r2`;
  }

  async apply(
    req: LifecycleApplyRequest,
    _ctx: ConnectorContext,
  ): Promise<LifecycleApplyResponse> {
    const spec = req.spec as unknown as {
      name: string;
      region?: string;
      public?: boolean;
    };
    const desc = await this.#lifecycle.createBucket({
      bucketName: spec.name,
      locationHint: spec.region,
      publicAccess: spec.public ?? false,
    });
    return {
      handle: `${HANDLE_PREFIX}${desc.accountId}:${desc.bucketName}`,
      outputs: this.#outputsFor(desc),
    };
  }

  async destroy(
    req: LifecycleDestroyRequest,
    _ctx: ConnectorContext,
  ): Promise<LifecycleDestroyResponse> {
    const deleted = await this.#lifecycle.deleteBucket({
      bucketName: bucketFromHandle(req.handle),
    });
    return deleted ? { ok: true } : { ok: true, note: "bucket not found" };
  }

  async describe(
    req: LifecycleDescribeRequest,
    _ctx: ConnectorContext,
  ): Promise<LifecycleDescribeResponse> {
    const desc = await this.#lifecycle.describeBucket({
      bucketName: bucketFromHandle(req.handle),
    });
    if (!desc) return { status: "missing" };
    return { status: "running", outputs: this.#outputsFor(desc) };
  }

  #outputsFor(desc: CloudflareR2BucketDescriptor): JsonObject {
    return {
      bucket: desc.bucketName,
      endpoint:
        `https://${this.#accountId}.r2.cloudflarestorage.com/${desc.bucketName}`,
      region: desc.locationHint ?? "auto",
      accessKeyRef: `${this.#secretBase}/access-key`,
      secretKeyRef: `${this.#secretBase}/secret-key`,
    };
  }
}

function bucketFromHandle(handle: string): string {
  const parts = handle.split(":");
  return parts.at(-1) ?? handle;
}
