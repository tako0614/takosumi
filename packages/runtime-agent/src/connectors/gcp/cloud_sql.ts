/**
 * `CloudSqlConnector` — wraps `DirectCloudSqlLifecycle` for
 * `database-postgres@v1`.
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
  type CloudSqlInstanceDescriptor,
  DirectCloudSqlLifecycle,
} from "./_cloud_sql_lifecycle.ts";

export interface CloudSqlConnectorOptions {
  readonly project: string;
  readonly region: string;
  readonly bearerToken?: string;
  readonly serviceAccountKey?: string;
  readonly databaseName?: string;
  readonly username?: string;
  readonly secretRefBase?: string;
  readonly passwordGenerator?: () => string;
  readonly fetch?: typeof fetch;
}

const SIZE_TO_TIER: Readonly<Record<string, string>> = {
  small: "db-g1-small",
  medium: "db-custom-2-7680",
  large: "db-custom-4-15360",
  xlarge: "db-custom-8-30720",
};

export class CloudSqlConnector implements Connector {
  readonly provider = "@takos/gcp-cloud-sql";
  readonly shape = "database-postgres@v1";
  readonly acceptedArtifactKinds: readonly string[] = [];
  readonly #lifecycle: DirectCloudSqlLifecycle;
  readonly #dbName: string;
  readonly #user: string;
  readonly #secretBase: string;
  readonly #generatePassword: () => string;

  constructor(opts: CloudSqlConnectorOptions) {
    this.#lifecycle = new DirectCloudSqlLifecycle({
      project: opts.project,
      region: opts.region,
      bearerToken: opts.bearerToken,
      serviceAccountKey: opts.serviceAccountKey,
      fetch: opts.fetch,
    });
    this.#dbName = opts.databaseName ?? "app";
    this.#user = opts.username ?? "app";
    this.#secretBase = opts.secretRefBase ?? "secret://gcp/cloud-sql";
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
    const instanceName = `pg-${this.#dbName}-${randomId()}`;
    const password = this.#generatePassword();
    const desc = await this.#lifecycle.createInstance({
      instanceName,
      engineVersion: `POSTGRES_${spec.version}`,
      tier: SIZE_TO_TIER[spec.size] ?? "db-g1-small",
      storageSizeGb: spec.storage?.sizeGiB ?? 10,
      database: this.#dbName,
      username: this.#user,
      password,
      highAvailability: spec.highAvailability ?? false,
    });
    return { handle: desc.resourceName, outputs: this.#outputsFor(desc) };
  }

  async destroy(
    req: LifecycleDestroyRequest,
    _ctx: ConnectorContext,
  ): Promise<LifecycleDestroyResponse> {
    const deleted = await this.#lifecycle.deleteInstance({
      instanceName: nameFromResource(req.handle),
    });
    return deleted ? { ok: true } : { ok: true, note: "instance not found" };
  }

  async describe(
    req: LifecycleDescribeRequest,
    _ctx: ConnectorContext,
  ): Promise<LifecycleDescribeResponse> {
    const desc = await this.#lifecycle.describeInstance({
      instanceName: nameFromResource(req.handle),
    });
    if (!desc) return { status: "missing" };
    return { status: "running", outputs: this.#outputsFor(desc) };
  }

  async verify(_ctx: ConnectorContext): Promise<ConnectorVerifyResult> {
    try {
      const result = await this.#lifecycle.listInstancesResult();
      return verifyResultFromStatus(result.status, {
        okStatuses: [200],
        responseText: result.ok ? "" : result.text,
        context: "cloudsql:Instances.list",
      });
    } catch (error) {
      return verifyResultFromError(error, "cloudsql:Instances.list");
    }
  }

  #outputsFor(desc: CloudSqlInstanceDescriptor): JsonObject {
    const passwordRef = `${this.#secretBase}/${desc.instanceName}/password`;
    return {
      host: desc.host,
      port: desc.port,
      database: desc.database,
      username: desc.username,
      passwordSecretRef: passwordRef,
      connectionString:
        `postgresql://${desc.username}@${desc.host}:${desc.port}/${desc.database}?sslmode=require`,
    };
  }
}

function nameFromResource(resource: string): string {
  return resource.split("/").at(-1) ?? resource;
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 8);
}

function randomPassword(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
