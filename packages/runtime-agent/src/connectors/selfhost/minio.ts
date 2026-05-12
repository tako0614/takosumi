/**
 * `MinioConnector` — selfhost object-store talking to a MinIO HTTP endpoint
 * via the S3-compatible REST API (PUT/HEAD/DELETE bucket).
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
import { parseNamedBucketSpec } from "../_spec.ts";

export interface MinioConnectorOptions {
  readonly endpoint: string;
  readonly region?: string;
  readonly secretRefBase?: string;
  readonly fetch?: typeof fetch;
}

export class MinioConnector implements Connector {
  readonly provider = "@takos/selfhost-minio";
  readonly shape = "object-store@v1";
  readonly acceptedArtifactKinds: readonly string[] = [];
  readonly #endpoint: string;
  readonly #region: string;
  readonly #secretBase: string;
  readonly #fetch: typeof fetch;

  constructor(opts: MinioConnectorOptions) {
    this.#endpoint = opts.endpoint.replace(/\/$/, "");
    this.#region = opts.region ?? "local";
    this.#secretBase = opts.secretRefBase ?? "secret://selfhosted/minio";
    this.#fetch = opts.fetch ?? fetch;
  }

  async apply(
    req: LifecycleApplyRequest,
    _ctx: ConnectorContext,
  ): Promise<LifecycleApplyResponse> {
    const spec = parseNamedBucketSpec(req.spec);
    const response = await this.#fetch(`${this.#endpoint}/${spec.name}`, {
      method: "PUT",
    });
    if (!response.ok && response.status !== 409 /* BucketAlreadyOwnedByYou */) {
      throw new Error(
        `minio create bucket failed: HTTP ${response.status} ${response.statusText}`,
      );
    }
    return {
      handle: spec.name,
      outputs: this.#outputsFor(spec.name),
    };
  }

  async destroy(
    req: LifecycleDestroyRequest,
    _ctx: ConnectorContext,
  ): Promise<LifecycleDestroyResponse> {
    const response = await this.#fetch(`${this.#endpoint}/${req.handle}`, {
      method: "DELETE",
    });
    if (response.ok || response.status === 404) {
      return { ok: true };
    }
    throw new Error(
      `minio delete bucket failed: HTTP ${response.status} ${response.statusText}`,
    );
  }

  async describe(
    req: LifecycleDescribeRequest,
    _ctx: ConnectorContext,
  ): Promise<LifecycleDescribeResponse> {
    const response = await this.#fetch(`${this.#endpoint}/${req.handle}`, {
      method: "HEAD",
    });
    if (response.status === 404) return { status: "missing" };
    if (!response.ok) {
      throw new Error(`minio describe bucket failed: HTTP ${response.status}`);
    }
    return {
      status: "running",
      outputs: this.#outputsFor(req.handle),
    };
  }

  async verify(_ctx: ConnectorContext): Promise<ConnectorVerifyResult> {
    try {
      const probeUrl = `${this.#endpoint}/minio/health/live`;
      const response = await this.#fetch(probeUrl, { method: "GET" });
      // 200 = live; 404 = endpoint reachable but no health probe (older
      // builds) — still indicates connectivity, so accept it.
      const text = response.ok ? "" : await response.text().catch(() => "");
      return verifyResultFromStatus(response.status, {
        okStatuses: [200, 204, 404],
        responseText: text,
        context: `minio:HealthLive ${this.#endpoint}`,
      });
    } catch (error) {
      return verifyResultFromError(
        error,
        `minio:HealthLive ${this.#endpoint}`,
      );
    }
  }

  #outputsFor(bucket: string): JsonObject {
    return {
      bucket,
      endpoint: `${this.#endpoint}/${bucket}`,
      region: this.#region,
      accessKeyRef: `${this.#secretBase}/access-key`,
      secretKeyRef: `${this.#secretBase}/secret-key`,
    };
  }
}
