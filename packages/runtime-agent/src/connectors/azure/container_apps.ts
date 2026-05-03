/**
 * `AzureContainerAppsConnector` — wraps `DirectAzureContainerAppsLifecycle`
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
  type AzureContainerAppDescriptor,
  DirectAzureContainerAppsLifecycle,
} from "./_container_apps_lifecycle.ts";

export interface AzureContainerAppsConnectorOptions {
  readonly subscriptionId: string;
  readonly resourceGroup: string;
  readonly region: string;
  readonly environmentName: string;
  readonly environmentResourceId: string;
  readonly bearerToken: string;
  readonly fetch?: typeof fetch;
}

export class AzureContainerAppsConnector implements Connector {
  readonly provider = "@takos/azure-container-apps";
  readonly shape = "web-service@v1";
  readonly acceptedArtifactKinds: readonly string[] = ["oci-image"];
  readonly #lifecycle: DirectAzureContainerAppsLifecycle;
  readonly #subscriptionId: string;
  readonly #resourceGroup: string;

  constructor(opts: AzureContainerAppsConnectorOptions) {
    this.#lifecycle = new DirectAzureContainerAppsLifecycle({
      subscriptionId: opts.subscriptionId,
      resourceGroup: opts.resourceGroup,
      region: opts.region,
      environmentName: opts.environmentName,
      environmentResourceId: opts.environmentResourceId,
      bearerToken: opts.bearerToken,
      fetch: opts.fetch,
    });
    this.#subscriptionId = opts.subscriptionId;
    this.#resourceGroup = opts.resourceGroup;
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
      serviceName: serviceNameFromImage(image),
      image,
      cpu: parseCpu(spec.resources?.cpu),
      memoryGib: parseMemoryGib(spec.resources?.memory),
      minReplicas: spec.scale.min,
      maxReplicas: spec.scale.max,
      internalPort: spec.port,
      env: { ...(spec.env ?? {}), ...(spec.bindings ?? {}) },
    });
    return {
      handle:
        `/subscriptions/${this.#subscriptionId}/resourceGroups/${this.#resourceGroup}/providers/Microsoft.App/containerApps/${desc.serviceName}`,
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
      const response = await this.#lifecycle.describeResourceGroupResponse();
      const text = response.ok ? "" : await response.text().catch(() => "");
      return verifyResultFromStatus(response.status, {
        okStatuses: [200],
        responseText: text,
        context: "azure-rm:ResourceGroup.get",
      });
    } catch (error) {
      return verifyResultFromError(error, "azure-rm:ResourceGroup.get");
    }
  }
}

function outputsFor(desc: AzureContainerAppDescriptor): JsonObject {
  return {
    url: desc.fqdn ? `https://${desc.fqdn}` : `https://${desc.internalHost}`,
    internalHost: desc.internalHost,
    internalPort: desc.internalPort,
  };
}

function serviceNameFromHandle(handle: string): string {
  return handle.split("/").at(-1) ?? handle;
}

function serviceNameFromImage(image: string): string {
  const tail = image.split("/").at(-1)?.split(":")[0] ?? "service";
  return tail.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
}

function parseCpu(cpu: string | undefined): number {
  if (!cpu) return 0.5;
  if (cpu.endsWith("m")) return parseInt(cpu, 10) / 1000;
  return parseFloat(cpu);
}

function parseMemoryGib(memory: string | undefined): number {
  if (!memory) return 1.0;
  if (memory.endsWith("Gi")) return parseFloat(memory);
  if (memory.endsWith("Mi")) return parseInt(memory, 10) / 1024;
  return parseFloat(memory);
}
