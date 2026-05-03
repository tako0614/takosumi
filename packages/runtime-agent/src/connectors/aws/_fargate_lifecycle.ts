/**
 * `DirectAwsFargateLifecycle` — calls AWS ECS Fargate APIs directly via
 * SigV4-signed JSON-over-HTTP. The ECS API uses the AWS JSON 1.1 protocol.
 */

import {
  type AwsSigV4Credentials,
  ensureAwsResponseOk,
  sigv4Fetch,
} from "../../_aws_sigv4.ts";

export interface AwsFargateServiceDescriptor {
  readonly serviceName: string;
  readonly clusterName: string;
  readonly region: string;
  readonly serviceArn: string;
  readonly loadBalancerUrl?: string;
  readonly internalHost: string;
  readonly internalPort: number;
}

export interface AwsFargateServiceCreateInput {
  readonly serviceName: string;
  readonly image: string;
  readonly cpu: number;
  readonly memory: number;
  readonly minTasks: number;
  readonly maxTasks: number;
  readonly internalPort: number;
  readonly env?: Readonly<Record<string, string>>;
}

export interface DirectAwsFargateLifecycleOptions {
  readonly credentials: AwsSigV4Credentials;
  readonly region: string;
  readonly clusterName: string;
  readonly subnetIds: readonly string[];
  readonly securityGroupIds?: readonly string[];
  readonly executionRoleArn?: string;
  readonly taskRoleArn?: string;
  readonly assignPublicIp?: boolean;
  readonly fetch?: typeof fetch;
}

export class DirectAwsFargateLifecycle {
  readonly #opts: DirectAwsFargateLifecycleOptions;

  constructor(options: DirectAwsFargateLifecycleOptions) {
    this.#opts = options;
  }

  async createService(
    input: AwsFargateServiceCreateInput,
  ): Promise<AwsFargateServiceDescriptor> {
    if (this.#opts.subnetIds.length === 0) {
      throw new Error(
        "DirectAwsFargateLifecycle requires at least one subnetId for Fargate awsvpc network mode",
      );
    }
    const taskDefArn = await this.#registerTaskDefinition(input);
    await this.#callEcs("CreateService", {
      cluster: this.#opts.clusterName,
      serviceName: input.serviceName,
      taskDefinition: taskDefArn,
      desiredCount: input.minTasks,
      launchType: "FARGATE",
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: this.#opts.subnetIds,
          securityGroups: this.#opts.securityGroupIds ?? [],
          assignPublicIp: this.#opts.assignPublicIp === false
            ? "DISABLED"
            : "ENABLED",
        },
      },
    });
    const arn = serviceArn(
      this.#opts.region,
      this.#opts.clusterName,
      input.serviceName,
    );
    return {
      serviceName: input.serviceName,
      clusterName: this.#opts.clusterName,
      region: this.#opts.region,
      serviceArn: arn,
      internalHost: `${input.serviceName}.${this.#opts.clusterName}.local`,
      internalPort: input.internalPort,
    };
  }

  async describeService(
    input: { readonly serviceName: string },
  ): Promise<AwsFargateServiceDescriptor | undefined> {
    const result = await this.#callEcs<DescribeServicesResponse>(
      "DescribeServices",
      { cluster: this.#opts.clusterName, services: [input.serviceName] },
    );
    const svc = result.services?.find((s) =>
      s.serviceName === input.serviceName
    );
    if (!svc || svc.status === "INACTIVE" || svc.status === "DRAINING") {
      return undefined;
    }
    return {
      serviceName: input.serviceName,
      clusterName: this.#opts.clusterName,
      region: this.#opts.region,
      serviceArn: svc.serviceArn ??
        serviceArn(
          this.#opts.region,
          this.#opts.clusterName,
          input.serviceName,
        ),
      internalHost: `${input.serviceName}.${this.#opts.clusterName}.local`,
      internalPort: 0,
    };
  }

  async deleteService(
    input: { readonly serviceName: string },
  ): Promise<boolean> {
    try {
      await this.#callEcs("UpdateService", {
        cluster: this.#opts.clusterName,
        service: input.serviceName,
        desiredCount: 0,
      });
    } catch {
      // best effort: continue with delete
    }
    const response = await this.#sendEcs("DeleteService", {
      cluster: this.#opts.clusterName,
      service: input.serviceName,
      force: true,
    });
    if (response.status === 404) return false;
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      if (/ServiceNotFoundException|InvalidParameterException/.test(text)) {
        return false;
      }
      throw new Error(
        `ecs:DeleteService failed: HTTP ${response.status} ${text}`,
      );
    }
    return true;
  }

  /**
   * Verify-only helper: issues `DescribeClusters` against the configured
   * cluster, returning the raw `Response` so the connector can map status
   * codes onto a `ConnectorVerifyResult` without throwing.
   */
  describeClustersResponse(): Promise<Response> {
    return this.#sendEcs("DescribeClusters", {
      clusters: [this.#opts.clusterName],
    });
  }

  async #registerTaskDefinition(
    input: AwsFargateServiceCreateInput,
  ): Promise<string> {
    const family = familyOf(input.serviceName);
    const result = await this.#callEcs<RegisterTaskDefinitionResponse>(
      "RegisterTaskDefinition",
      {
        family,
        networkMode: "awsvpc",
        requiresCompatibilities: ["FARGATE"],
        cpu: `${input.cpu}`,
        memory: `${input.memory}`,
        executionRoleArn: this.#opts.executionRoleArn,
        taskRoleArn: this.#opts.taskRoleArn,
        containerDefinitions: [
          {
            name: family,
            image: input.image,
            essential: true,
            portMappings: [
              { containerPort: input.internalPort, protocol: "tcp" },
            ],
            environment: input.env
              ? Object.entries(input.env).map(([name, value]) => ({
                name,
                value,
              }))
              : undefined,
          },
        ],
      },
    );
    return result.taskDefinition?.taskDefinitionArn ?? family;
  }

  async #callEcs<T = unknown>(action: string, body: unknown): Promise<T> {
    const response = await this.#sendEcs(action, body);
    await ensureAwsResponseOk(response, `ecs:${action}`);
    const text = await response.text();
    return text ? JSON.parse(text) as T : ({} as T);
  }

  #sendEcs(action: string, body: unknown): Promise<Response> {
    return sigv4Fetch(
      {
        method: "POST",
        url: `https://ecs.${this.#opts.region}.amazonaws.com/`,
        service: "ecs",
        region: this.#opts.region,
        headers: {
          "content-type": "application/x-amz-json-1.1",
          "x-amz-target": `AmazonEC2ContainerServiceV20141113.${action}`,
        },
        body: JSON.stringify(body),
      },
      {
        credentials: this.#opts.credentials,
        fetch: this.#opts.fetch,
      },
    );
  }
}

interface DescribeServicesResponse {
  readonly services?: readonly {
    readonly serviceName?: string;
    readonly serviceArn?: string;
    readonly status?: string;
  }[];
}

interface RegisterTaskDefinitionResponse {
  readonly taskDefinition?: {
    readonly taskDefinitionArn?: string;
  };
}

function familyOf(serviceName: string): string {
  return `${serviceName}-task`;
}

function serviceArn(
  region: string,
  cluster: string,
  serviceName: string,
): string {
  return `arn:aws:ecs:${region}:operator:service/${cluster}/${serviceName}`;
}
