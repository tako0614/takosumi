/**
 * `CloudDnsConnector` — wraps `DirectCloudDnsLifecycle` for `custom-domain@v1`.
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
import type { Connector } from "../connector.ts";
import {
  type CloudDnsRecordDescriptor,
  DirectCloudDnsLifecycle,
} from "./_cloud_dns_lifecycle.ts";

export interface CloudDnsConnectorOptions {
  readonly project: string;
  readonly zoneName: string;
  readonly bearerToken?: string;
  readonly serviceAccountKey?: string;
  readonly ttlSeconds?: number;
  readonly fetch?: typeof fetch;
}

export class CloudDnsConnector implements Connector {
  readonly provider = "cloud-dns";
  readonly shape = "custom-domain@v1";
  readonly #lifecycle: DirectCloudDnsLifecycle;

  constructor(opts: CloudDnsConnectorOptions) {
    this.#lifecycle = new DirectCloudDnsLifecycle({
      project: opts.project,
      zoneName: opts.zoneName,
      bearerToken: opts.bearerToken,
      serviceAccountKey: opts.serviceAccountKey,
      ttlSeconds: opts.ttlSeconds,
      fetch: opts.fetch,
    });
  }

  async apply(req: LifecycleApplyRequest): Promise<LifecycleApplyResponse> {
    const spec = req.spec as unknown as { name: string; target: string };
    const desc = await this.#lifecycle.createRecord({
      fqdn: spec.name,
      target: spec.target,
    });
    return { handle: desc.recordName, outputs: outputsFor(desc) };
  }

  async destroy(
    req: LifecycleDestroyRequest,
  ): Promise<LifecycleDestroyResponse> {
    const deleted = await this.#lifecycle.deleteRecord({
      recordName: req.handle,
    });
    return deleted ? { ok: true } : { ok: true, note: "record not found" };
  }

  async describe(
    req: LifecycleDescribeRequest,
  ): Promise<LifecycleDescribeResponse> {
    const desc = await this.#lifecycle.describeRecord({
      recordName: req.handle,
    });
    if (!desc) return { status: "missing" };
    return { status: "running", outputs: outputsFor(desc) };
  }
}

function outputsFor(desc: CloudDnsRecordDescriptor): JsonObject {
  return { fqdn: desc.fqdn };
}
