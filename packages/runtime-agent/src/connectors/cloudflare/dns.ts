/**
 * `CloudflareDnsConnector` — wraps `DirectCloudflareDnsLifecycle` for
 * `custom-domain@v1`.
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
  type CloudflareDnsRecordDescriptor,
  DirectCloudflareDnsLifecycle,
} from "./_dns_lifecycle.ts";

export interface CloudflareDnsConnectorOptions {
  readonly zoneId: string;
  readonly apiToken: string;
  readonly recordType?: "A" | "AAAA" | "CNAME";
  readonly ttlSeconds?: number;
  readonly fetch?: typeof fetch;
}

export class CloudflareDnsConnector implements Connector {
  readonly provider = "cloudflare-dns";
  readonly shape = "custom-domain@v1";
  readonly acceptedArtifactKinds: readonly string[] = [];
  readonly #lifecycle: DirectCloudflareDnsLifecycle;

  constructor(opts: CloudflareDnsConnectorOptions) {
    this.#lifecycle = new DirectCloudflareDnsLifecycle({
      zoneId: opts.zoneId,
      apiToken: opts.apiToken,
      recordType: opts.recordType,
      ttlSeconds: opts.ttlSeconds,
      fetch: opts.fetch,
    });
  }

  async apply(
    req: LifecycleApplyRequest,
    _ctx: ConnectorContext,
  ): Promise<LifecycleApplyResponse> {
    const spec = req.spec as unknown as { name: string; target: string };
    const desc = await this.#lifecycle.createRecord({
      fqdn: spec.name,
      target: spec.target,
      proxied: true,
    });
    return { handle: desc.recordId, outputs: outputsFor(desc) };
  }

  async destroy(
    req: LifecycleDestroyRequest,
    _ctx: ConnectorContext,
  ): Promise<LifecycleDestroyResponse> {
    const deleted = await this.#lifecycle.deleteRecord({
      recordId: req.handle,
    });
    return deleted ? { ok: true } : { ok: true, note: "record not found" };
  }

  async describe(
    req: LifecycleDescribeRequest,
    _ctx: ConnectorContext,
  ): Promise<LifecycleDescribeResponse> {
    const desc = await this.#lifecycle.describeRecord({
      recordId: req.handle,
    });
    if (!desc) return { status: "missing" };
    return { status: "running", outputs: outputsFor(desc) };
  }
}

function outputsFor(desc: CloudflareDnsRecordDescriptor): JsonObject {
  return {
    fqdn: desc.fqdn,
    nameservers: ["ns1.cloudflare.com", "ns2.cloudflare.com"],
  };
}
