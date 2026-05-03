/**
 * `Route53Connector` — wraps `DirectRoute53Lifecycle` for `custom-domain@v1`.
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
  DirectRoute53Lifecycle,
  type Route53RecordDescriptor,
} from "./_route53_lifecycle.ts";

export interface Route53ConnectorOptions {
  readonly credentials: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly sessionToken?: string;
  };
  readonly hostedZoneId: string;
  readonly ttlSeconds?: number;
  readonly fetch?: typeof fetch;
}

export class Route53Connector implements Connector {
  readonly provider = "route53";
  readonly shape = "custom-domain@v1";
  readonly acceptedArtifactKinds: readonly string[] = [];
  readonly #lifecycle: DirectRoute53Lifecycle;

  constructor(opts: Route53ConnectorOptions) {
    this.#lifecycle = new DirectRoute53Lifecycle({
      credentials: opts.credentials,
      hostedZoneId: opts.hostedZoneId,
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
      recordType: "CNAME",
    });
    return { handle: desc.recordSetId, outputs: outputsFor(desc) };
  }

  async destroy(
    req: LifecycleDestroyRequest,
    _ctx: ConnectorContext,
  ): Promise<LifecycleDestroyResponse> {
    const deleted = await this.#lifecycle.deleteRecord({
      recordSetId: req.handle,
    });
    return deleted ? { ok: true } : { ok: true, note: "record not found" };
  }

  async describe(
    req: LifecycleDescribeRequest,
    _ctx: ConnectorContext,
  ): Promise<LifecycleDescribeResponse> {
    const desc = await this.#lifecycle.describeRecord({
      recordSetId: req.handle,
    });
    if (!desc) return { status: "missing" };
    return { status: "running", outputs: outputsFor(desc) };
  }
}

function outputsFor(desc: Route53RecordDescriptor): JsonObject {
  const out: JsonObject = { fqdn: desc.fqdn };
  if (desc.certificateArn) out.certificateArn = desc.certificateArn;
  return out;
}
