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
  readonly acceptedArtifactKinds: readonly string[] = [];
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

  async apply(
    req: LifecycleApplyRequest,
    _ctx: ConnectorContext,
  ): Promise<LifecycleApplyResponse> {
    const spec = req.spec as unknown as { name: string; target: string };
    const desc = await this.#lifecycle.createRecord({
      fqdn: spec.name,
      target: spec.target,
    });
    return { handle: desc.recordName, outputs: outputsFor(desc) };
  }

  async destroy(
    req: LifecycleDestroyRequest,
    _ctx: ConnectorContext,
  ): Promise<LifecycleDestroyResponse> {
    const deleted = await this.#lifecycle.deleteRecord({
      recordName: req.handle,
    });
    return deleted ? { ok: true } : { ok: true, note: "record not found" };
  }

  async describe(
    req: LifecycleDescribeRequest,
    _ctx: ConnectorContext,
  ): Promise<LifecycleDescribeResponse> {
    const desc = await this.#lifecycle.describeRecord({
      recordName: req.handle,
    });
    if (!desc) return { status: "missing" };
    return { status: "running", outputs: outputsFor(desc) };
  }

  async verify(_ctx: ConnectorContext): Promise<ConnectorVerifyResult> {
    try {
      const result = await this.#lifecycle.listManagedZonesResult();
      return verifyResultFromStatus(result.status, {
        okStatuses: [200],
        responseText: result.ok ? "" : result.text,
        context: "clouddns:ManagedZones.list",
      });
    } catch (error) {
      return verifyResultFromError(error, "clouddns:ManagedZones.list");
    }
  }
}

function outputsFor(desc: CloudDnsRecordDescriptor): JsonObject {
  return { fqdn: desc.fqdn };
}
