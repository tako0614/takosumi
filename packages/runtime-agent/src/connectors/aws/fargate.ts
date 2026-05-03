/**
 * `AwsFargateConnector` — wraps `DirectAwsFargateLifecycle` for the
 * `web-service@v1` shape.
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
  type AwsFargateServiceDescriptor,
  DirectAwsFargateLifecycle,
} from "./_fargate_lifecycle.ts";

export interface AwsFargateConnectorOptions {
  readonly region: string;
  readonly credentials: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly sessionToken?: string;
  };
  readonly clusterName: string;
  readonly subnetIds: readonly string[];
  readonly securityGroupIds?: readonly string[];
  readonly executionRoleArn?: string;
  readonly taskRoleArn?: string;
  readonly assignPublicIp?: boolean;
  readonly fetch?: typeof fetch;
}

export class AwsFargateConnector implements Connector {
  readonly provider = "aws-fargate";
  readonly shape = "web-service@v1";
  readonly acceptedArtifactKinds: readonly string[] = ["oci-image"];
  readonly #lifecycle: DirectAwsFargateLifecycle;

  constructor(opts: AwsFargateConnectorOptions) {
    this.#lifecycle = new DirectAwsFargateLifecycle({
      region: opts.region,
      credentials: opts.credentials,
      clusterName: opts.clusterName,
      subnetIds: opts.subnetIds,
      securityGroupIds: opts.securityGroupIds,
      executionRoleArn: opts.executionRoleArn,
      taskRoleArn: opts.taskRoleArn,
      assignPublicIp: opts.assignPublicIp,
      fetch: opts.fetch,
    });
  }

  async apply(
    req: LifecycleApplyRequest,
    _ctx: ConnectorContext,
  ): Promise<LifecycleApplyResponse> {
    const spec = specOf(req);
    const image = imageOf(spec);
    const desc = await this.#lifecycle.createService({
      serviceName: serviceNameFromImage(image),
      image,
      cpu: parseCpu(spec.resources?.cpu),
      memory: parseMemory(spec.resources?.memory),
      minTasks: spec.scale.min,
      maxTasks: spec.scale.max,
      internalPort: spec.port,
      env: { ...(spec.env ?? {}), ...(spec.bindings ?? {}) },
    });
    return { handle: desc.serviceArn, outputs: outputsFor(desc) };
  }

  async destroy(
    req: LifecycleDestroyRequest,
    _ctx: ConnectorContext,
  ): Promise<LifecycleDestroyResponse> {
    const deleted = await this.#lifecycle.deleteService({
      serviceName: serviceNameFromArn(req.handle),
    });
    return deleted ? { ok: true } : { ok: true, note: "service not found" };
  }

  async describe(
    req: LifecycleDescribeRequest,
    _ctx: ConnectorContext,
  ): Promise<LifecycleDescribeResponse> {
    const desc = await this.#lifecycle.describeService({
      serviceName: serviceNameFromArn(req.handle),
    });
    if (!desc) return { status: "missing" };
    return { status: "running", outputs: outputsFor(desc) };
  }

  async verify(_ctx: ConnectorContext): Promise<ConnectorVerifyResult> {
    try {
      const response = await this.#lifecycle.describeClustersResponse();
      const text = response.ok ? "" : await response.text().catch(() => "");
      return verifyResultFromStatus(response.status, {
        okStatuses: [200],
        responseText: text,
        context: "ecs:DescribeClusters",
      });
    } catch (error) {
      return verifyResultFromError(error, "ecs:DescribeClusters");
    }
  }
}

interface WebServiceSpec {
  readonly image?: string;
  readonly artifact?: { readonly kind: string; readonly uri?: string };
  readonly port: number;
  readonly scale: { readonly min: number; readonly max: number };
  readonly resources?: { readonly cpu?: string; readonly memory?: string };
  readonly env?: Readonly<Record<string, string>>;
  readonly bindings?: Readonly<Record<string, string>>;
  readonly command?: readonly string[];
}

function specOf(req: LifecycleApplyRequest): WebServiceSpec {
  return req.spec as unknown as WebServiceSpec;
}

function imageOf(spec: WebServiceSpec): string {
  const image = spec.image ?? spec.artifact?.uri;
  if (!image) {
    throw new Error("web-service spec requires `image` or `artifact.uri`");
  }
  return image;
}

function outputsFor(desc: AwsFargateServiceDescriptor): JsonObject {
  return {
    url: desc.loadBalancerUrl ?? `https://${desc.internalHost}`,
    internalHost: desc.internalHost,
    internalPort: desc.internalPort,
  };
}

function serviceNameFromImage(image: string): string {
  const tail = image.split("/").at(-1)?.split(":")[0] ?? "service";
  return tail.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
}

function serviceNameFromArn(arn: string): string {
  return arn.split("/").at(-1) ?? arn;
}

function parseCpu(cpu: string | undefined): number {
  if (!cpu) return 256;
  if (cpu.endsWith("m")) return parseInt(cpu, 10);
  return Math.round(parseFloat(cpu) * 1024);
}

function parseMemory(memory: string | undefined): number {
  if (!memory) return 512;
  if (memory.endsWith("Mi")) return parseInt(memory, 10);
  if (memory.endsWith("Gi")) return parseInt(memory, 10) * 1024;
  return parseInt(memory, 10);
}
