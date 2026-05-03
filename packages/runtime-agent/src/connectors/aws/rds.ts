/**
 * `AwsRdsConnector` — wraps `DirectAwsRdsLifecycle` for the
 * `database-postgres@v1` shape.
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
  type AwsRdsInstanceDescriptor,
  DirectAwsRdsLifecycle,
} from "./_rds_lifecycle.ts";

export interface AwsRdsConnectorOptions {
  readonly region: string;
  readonly credentials: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly sessionToken?: string;
  };
  readonly subnetGroupName?: string;
  readonly securityGroupIds?: readonly string[];
  readonly databaseName?: string;
  readonly username?: string;
  readonly secretRefBase?: string;
  readonly passwordGenerator?: () => string;
  readonly fetch?: typeof fetch;
}

const SIZE_TO_CLASS: Readonly<Record<string, string>> = {
  small: "db.t4g.small",
  medium: "db.t4g.medium",
  large: "db.r6g.large",
  xlarge: "db.r6g.xlarge",
};

export class AwsRdsConnector implements Connector {
  readonly provider = "@takos/aws-rds";
  readonly shape = "database-postgres@v1";
  readonly acceptedArtifactKinds: readonly string[] = [];
  readonly #lifecycle: DirectAwsRdsLifecycle;
  readonly #dbName: string;
  readonly #user: string;
  readonly #secretBase: string;
  readonly #generatePassword: () => string;

  constructor(opts: AwsRdsConnectorOptions) {
    this.#lifecycle = new DirectAwsRdsLifecycle({
      region: opts.region,
      credentials: opts.credentials,
      subnetGroupName: opts.subnetGroupName,
      securityGroupIds: opts.securityGroupIds,
      fetch: opts.fetch,
    });
    this.#dbName = opts.databaseName ?? "app";
    this.#user = opts.username ?? "app";
    this.#secretBase = opts.secretRefBase ?? "secret://aws/rds";
    this.#generatePassword = opts.passwordGenerator ?? randomPassword;
  }

  async apply(
    req: LifecycleApplyRequest,
    _ctx: ConnectorContext,
  ): Promise<LifecycleApplyResponse> {
    const spec = req.spec as unknown as {
      version: string;
      size: string;
      storage?: { sizeGiB?: number };
      highAvailability?: boolean;
    };
    const instanceId = `pg-${this.#dbName}-${randomId()}`;
    const password = this.#generatePassword();
    const desc = await this.#lifecycle.createInstance({
      instanceId,
      engineVersion: spec.version,
      instanceClass: SIZE_TO_CLASS[spec.size] ?? "db.t4g.small",
      allocatedStorageGb: spec.storage?.sizeGiB ?? 20,
      database: this.#dbName,
      username: this.#user,
      password,
      multiAz: spec.highAvailability ?? false,
    });
    return { handle: desc.arn, outputs: this.#outputsFor(desc) };
  }

  async destroy(
    req: LifecycleDestroyRequest,
    _ctx: ConnectorContext,
  ): Promise<LifecycleDestroyResponse> {
    const deleted = await this.#lifecycle.deleteInstance({
      instanceId: idFromArn(req.handle),
    });
    return deleted ? { ok: true } : { ok: true, note: "instance not found" };
  }

  async describe(
    req: LifecycleDescribeRequest,
    _ctx: ConnectorContext,
  ): Promise<LifecycleDescribeResponse> {
    const desc = await this.#lifecycle.describeInstance({
      instanceId: idFromArn(req.handle),
    });
    if (!desc) return { status: "missing" };
    return { status: "running", outputs: this.#outputsFor(desc) };
  }

  async verify(_ctx: ConnectorContext): Promise<ConnectorVerifyResult> {
    try {
      const response = await this.#lifecycle.describeInstancesResponse();
      const text = response.ok ? "" : await response.text().catch(() => "");
      return verifyResultFromStatus(response.status, {
        okStatuses: [200],
        responseText: text,
        context: "rds:DescribeDBInstances",
      });
    } catch (error) {
      return verifyResultFromError(error, "rds:DescribeDBInstances");
    }
  }

  #outputsFor(desc: AwsRdsInstanceDescriptor): JsonObject {
    const passwordRef = `${this.#secretBase}/${desc.instanceId}/password`;
    return {
      host: desc.endpoint,
      port: desc.port,
      database: desc.database,
      username: desc.username,
      passwordSecretRef: passwordRef,
      connectionString:
        `postgresql://${desc.username}@${desc.endpoint}:${desc.port}/${desc.database}?sslmode=require`,
    };
  }
}

function idFromArn(arn: string): string {
  return arn.split(":").at(-1) ?? arn;
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 8);
}

function randomPassword(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
