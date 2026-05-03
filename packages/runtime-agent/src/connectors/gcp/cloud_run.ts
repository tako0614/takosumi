/**
 * `CloudRunConnector` — wraps `DirectCloudRunLifecycle` for `web-service@v1`.
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
  type CloudRunServiceDescriptor,
  DirectCloudRunLifecycle,
} from "./_cloud_run_lifecycle.ts";

export interface CloudRunConnectorOptions {
  readonly project: string;
  readonly region: string;
  readonly bearerToken?: string;
  readonly serviceAccountKey?: string;
  readonly fetch?: typeof fetch;
}

export class CloudRunConnector implements Connector {
  readonly provider = "cloud-run";
  readonly shape = "web-service@v1";
  readonly acceptedArtifactKinds: readonly string[] = ["oci-image"];
  readonly #lifecycle: DirectCloudRunLifecycle;

  constructor(opts: CloudRunConnectorOptions) {
    this.#lifecycle = new DirectCloudRunLifecycle({
      project: opts.project,
      region: opts.region,
      bearerToken: opts.bearerToken,
      serviceAccountKey: opts.serviceAccountKey,
      fetch: opts.fetch,
    });
  }

  async apply(
    req: LifecycleApplyRequest,
    _ctx: ConnectorContext,
  ): Promise<LifecycleApplyResponse> {
    const spec = req.spec as unknown as {
      image?: string;
      artifact?: { kind: string; uri?: string };
      port: number;
      scale: { min: number; max: number };
      resources?: { cpu?: string; memory?: string };
      env?: Record<string, string>;
      bindings?: Record<string, string>;
    };
    const image = spec.image ?? spec.artifact?.uri;
    if (!image) {
      throw new Error("web-service spec requires `image` or `artifact.uri`");
    }
    const desc = await this.#lifecycle.createService({
      serviceName: serviceNameOf(image),
      image,
      minInstances: spec.scale.min,
      maxInstances: spec.scale.max,
      cpu: spec.resources?.cpu,
      memory: spec.resources?.memory,
      port: spec.port,
      env: { ...(spec.env ?? {}), ...(spec.bindings ?? {}) },
    });
    return {
      handle: `${desc.project}/${desc.region}/${desc.serviceName}`,
      outputs: outputsFor(desc),
    };
  }

  async destroy(
    req: LifecycleDestroyRequest,
    _ctx: ConnectorContext,
  ): Promise<LifecycleDestroyResponse> {
    const deleted = await this.#lifecycle.deleteService({
      serviceName: serviceNameFromHandle(req.handle),
    });
    return deleted ? { ok: true } : { ok: true, note: "service not found" };
  }

  async describe(
    req: LifecycleDescribeRequest,
    _ctx: ConnectorContext,
  ): Promise<LifecycleDescribeResponse> {
    const desc = await this.#lifecycle.describeService({
      serviceName: serviceNameFromHandle(req.handle),
    });
    if (!desc) return { status: "missing" };
    return { status: "running", outputs: outputsFor(desc) };
  }

  async verify(_ctx: ConnectorContext): Promise<ConnectorVerifyResult> {
    try {
      const result = await this.#lifecycle.listServicesResult();
      return verifyResultFromStatus(result.status, {
        okStatuses: [200],
        responseText: result.ok ? "" : result.text,
        context: "cloudrun:Services.list",
      });
    } catch (error) {
      return verifyResultFromError(error, "cloudrun:Services.list");
    }
  }
}

function outputsFor(desc: CloudRunServiceDescriptor): JsonObject {
  return {
    url: desc.url,
    internalHost: desc.internalHost,
    internalPort: desc.port,
  };
}

function serviceNameOf(image: string): string {
  const tail = image.split("/").at(-1)?.split(":")[0] ?? "svc";
  return tail.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
}

function serviceNameFromHandle(handle: string): string {
  return handle.split("/").at(-1) ?? handle;
}
