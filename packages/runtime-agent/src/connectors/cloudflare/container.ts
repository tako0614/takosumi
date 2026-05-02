/**
 * `CloudflareContainerConnector` — wraps `DirectCloudflareContainerLifecycle`
 * for `web-service@v1`.
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
  type CloudflareContainerDescriptor,
  DirectCloudflareContainerLifecycle,
} from "./_container_lifecycle.ts";

export interface CloudflareContainerConnectorOptions {
  readonly accountId: string;
  readonly apiToken: string;
  readonly fetch?: typeof fetch;
}

export class CloudflareContainerConnector implements Connector {
  readonly provider = "cloudflare-container";
  readonly shape = "web-service@v1";
  readonly #lifecycle: DirectCloudflareContainerLifecycle;

  constructor(opts: CloudflareContainerConnectorOptions) {
    this.#lifecycle = new DirectCloudflareContainerLifecycle({
      accountId: opts.accountId,
      apiToken: opts.apiToken,
      fetch: opts.fetch,
    });
  }

  async apply(req: LifecycleApplyRequest): Promise<LifecycleApplyResponse> {
    const spec = req.spec as unknown as {
      image: string;
      port: number;
      scale: { min: number; max: number };
      env?: Record<string, string>;
      bindings?: Record<string, string>;
    };
    const desc = await this.#lifecycle.createService({
      serviceName: nameOf(spec.image),
      image: spec.image,
      minInstances: spec.scale.min === 0 ? 0 : Math.max(0, spec.scale.min),
      maxInstances: spec.scale.max,
      port: spec.port,
      env: { ...(spec.env ?? {}), ...(spec.bindings ?? {}) },
    });
    return {
      handle: `${desc.accountId}/${desc.serviceName}`,
      outputs: outputsFor(desc),
    };
  }

  async destroy(
    req: LifecycleDestroyRequest,
  ): Promise<LifecycleDestroyResponse> {
    const deleted = await this.#lifecycle.deleteService({
      serviceName: nameFromHandle(req.handle),
    });
    return deleted ? { ok: true } : { ok: true, note: "service not found" };
  }

  async describe(
    req: LifecycleDescribeRequest,
  ): Promise<LifecycleDescribeResponse> {
    const desc = await this.#lifecycle.describeService({
      serviceName: nameFromHandle(req.handle),
    });
    if (!desc) return { status: "missing" };
    return { status: "running", outputs: outputsFor(desc) };
  }
}

function outputsFor(desc: CloudflareContainerDescriptor): JsonObject {
  return {
    url: desc.publicUrl,
    internalHost: desc.internalHost,
    internalPort: desc.port,
  };
}

function nameOf(image: string): string {
  const tail = image.split("/").at(-1)?.split(":")[0] ?? "svc";
  return tail.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
}

function nameFromHandle(handle: string): string {
  return handle.split("/").at(-1) ?? handle;
}
