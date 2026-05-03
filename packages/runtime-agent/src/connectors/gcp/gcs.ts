/**
 * `GcpGcsConnector` — wraps `DirectGcsLifecycle` for `object-store@v1`.
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
import type {
  Connector,
  ConnectorContext,
  ConnectorVerifyResult,
} from "../connector.ts";
import {
  verifyResultFromError,
  verifyResultFromStatus,
} from "../_verify_helpers.ts";
import {
  DirectGcsLifecycle,
  type GcsBucketDescriptor,
} from "./_gcs_lifecycle.ts";

export interface GcpGcsConnectorOptions {
  readonly project: string;
  readonly defaultLocation?: string;
  readonly bearerToken?: string;
  readonly serviceAccountKey?: string;
  readonly secretRefBase?: string;
  readonly fetch?: typeof fetch;
}

export class GcpGcsConnector implements Connector {
  readonly provider = "gcp-gcs";
  readonly shape = "object-store@v1";
  readonly acceptedArtifactKinds: readonly string[] = [];
  readonly #lifecycle: DirectGcsLifecycle;
  readonly #defaultLocation: string;
  readonly #secretBase: string;

  constructor(opts: GcpGcsConnectorOptions) {
    this.#lifecycle = new DirectGcsLifecycle({
      project: opts.project,
      defaultLocation: opts.defaultLocation,
      bearerToken: opts.bearerToken,
      serviceAccountKey: opts.serviceAccountKey,
      fetch: opts.fetch,
    });
    this.#defaultLocation = opts.defaultLocation ?? "us-central1";
    this.#secretBase = opts.secretRefBase ?? "secret://gcp/gcs";
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
      location: spec.region ?? this.#defaultLocation,
      versioning: spec.versioning ?? false,
      publicAccess: spec.public ?? false,
    });
    return { handle: desc.resourceName, outputs: this.#outputsFor(desc) };
  }

  async destroy(
    req: LifecycleDestroyRequest,
    _ctx: ConnectorContext,
  ): Promise<LifecycleDestroyResponse> {
    const deleted = await this.#lifecycle.deleteBucket({
      bucketName: nameFromResource(req.handle),
    });
    return deleted ? { ok: true } : { ok: true, note: "bucket not found" };
  }

  async describe(
    req: LifecycleDescribeRequest,
    _ctx: ConnectorContext,
  ): Promise<LifecycleDescribeResponse> {
    const desc = await this.#lifecycle.describeBucket({
      bucketName: nameFromResource(req.handle),
    });
    if (!desc) return { status: "missing" };
    return { status: "running", outputs: this.#outputsFor(desc) };
  }

  async verify(_ctx: ConnectorContext): Promise<ConnectorVerifyResult> {
    try {
      const result = await this.#lifecycle.listBucketsResult();
      return verifyResultFromStatus(result.status, {
        okStatuses: [200],
        responseText: result.ok ? "" : result.text,
        context: "gcs:Buckets.list",
      });
    } catch (error) {
      return verifyResultFromError(error, "gcs:Buckets.list");
    }
  }

  #outputsFor(desc: GcsBucketDescriptor): JsonObject {
    return {
      bucket: desc.bucketName,
      endpoint: `https://storage.googleapis.com/${desc.bucketName}`,
      region: desc.location,
      accessKeyRef: `${this.#secretBase}/access-key`,
      secretKeyRef: `${this.#secretBase}/secret-key`,
    };
  }
}

function nameFromResource(resource: string): string {
  return resource.split("/").at(-1) ?? resource;
}
