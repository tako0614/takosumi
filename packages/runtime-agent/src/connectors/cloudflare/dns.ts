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
import type {
  Connector,
  ConnectorContext,
  ConnectorVerifyResult,
} from "../connector.ts";
import {
  verifyResultFromError,
  verifyResultFromStatus,
} from "../_verify_helpers.ts";
import { parseDnsRecordSpec } from "../_spec.ts";
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
  readonly provider = "@takos/cloudflare-dns";
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
    const spec = parseDnsRecordSpec(req.spec);
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

  async verify(_ctx: ConnectorContext): Promise<ConnectorVerifyResult> {
    try {
      const result = await this.#lifecycle.describeZoneResult();
      return verifyResultFromStatus(result.status, {
        okStatuses: [200],
        responseText: result.ok ? "" : result.text,
        context: "cf-dns:GetZone",
      });
    } catch (error) {
      return verifyResultFromError(error, "cf-dns:GetZone");
    }
  }
}

function outputsFor(desc: CloudflareDnsRecordDescriptor): JsonObject {
  return {
    fqdn: desc.fqdn,
    nameservers: ["ns1.cloudflare.com", "ns2.cloudflare.com"],
  };
}
