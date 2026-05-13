import type { ProviderPlugin } from "takosumi-contract";
import type {
  DatabasePostgresCapability,
  DatabasePostgresOutputs,
  DatabasePostgresSpec,
} from "../../shapes/database-postgres.ts";

export interface CloudSqlInstanceDescriptor {
  readonly instanceName: string;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly version: string;
  readonly project: string;
  readonly region: string;
  readonly resourceName: string;
}

export interface CloudSqlLifecycleClient {
  createInstance(input: {
    readonly instanceName: string;
    readonly engineVersion: string;
    readonly tier: string;
    readonly storageSizeGb: number;
    readonly database: string;
    readonly username: string;
    readonly password: string;
    readonly highAvailability: boolean;
  }): Promise<CloudSqlInstanceDescriptor>;
  describeInstance(input: {
    readonly instanceName: string;
  }): Promise<CloudSqlInstanceDescriptor | undefined>;
  deleteInstance(input: {
    readonly instanceName: string;
  }): Promise<boolean>;
}

export interface CloudSqlProviderOptions {
  readonly lifecycle: CloudSqlLifecycleClient;
  readonly project: string;
  readonly region: string;
  readonly databaseName?: string;
  readonly username?: string;
  readonly secretRefBase?: string;
  readonly passwordGenerator?: () => string;
  readonly clock?: () => Date;
}

const SUPPORTED_CAPABILITIES: readonly DatabasePostgresCapability[] = [
  "pitr",
  "read-replicas",
  "high-availability",
  "backups",
  "ssl-required",
  "extensions",
];

const SIZE_TO_TIER: Readonly<Record<string, string>> = {
  small: "db-g1-small",
  medium: "db-custom-2-7680",
  large: "db-custom-4-15360",
  xlarge: "db-custom-8-30720",
};

export function createCloudSqlProvider(
  options: CloudSqlProviderOptions,
): ProviderPlugin<DatabasePostgresSpec, DatabasePostgresOutputs> {
  const lifecycle = options.lifecycle;
  const dbName = options.databaseName ?? "app";
  const user = options.username ?? "app";
  const secretBase = options.secretRefBase ?? "secret://gcp/cloud-sql";
  const generate = options.passwordGenerator ?? randomPassword;
  const clock = options.clock ?? (() => new Date());
  return {
    id: "@takos/gcp-cloud-sql",
    version: "1.0.0",
    implements: { id: "database-postgres", version: "v1" },
    capabilities: SUPPORTED_CAPABILITIES,
    async apply(spec, _ctx) {
      const instanceName = `pg-${dbName}-${randomId()}`;
      const password = generate();
      const desc = await lifecycle.createInstance({
        instanceName,
        engineVersion: `POSTGRES_${spec.version}`,
        tier: SIZE_TO_TIER[spec.size] ?? "db-g1-small",
        storageSizeGb: spec.storage?.sizeGiB ?? 10,
        database: dbName,
        username: user,
        password,
        highAvailability: spec.highAvailability ?? false,
      });
      return {
        handle: desc.resourceName,
        outputs: outputsOf(desc, secretBase),
      };
    },
    async destroy(handle, _ctx) {
      await lifecycle.deleteInstance({
        instanceName: nameFromResource(handle),
      });
    },
    async status(handle, _ctx) {
      const desc = await lifecycle.describeInstance({
        instanceName: nameFromResource(handle),
      });
      if (!desc) return { kind: "deleted", observedAt: clock().toISOString() };
      return {
        kind: "ready",
        outputs: outputsOf(desc, secretBase),
        observedAt: clock().toISOString(),
      };
    },
  };
}

function outputsOf(
  desc: CloudSqlInstanceDescriptor,
  secretBase: string,
): DatabasePostgresOutputs {
  const passwordRef = `${secretBase}/${desc.instanceName}/password`;
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

function nameFromResource(resource: string): string {
  return resource.split("/").at(-1) ?? resource;
}

function randomId(): string {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function randomPassword(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export class InMemoryCloudSqlLifecycle implements CloudSqlLifecycleClient {
  readonly #instances = new Map<string, CloudSqlInstanceDescriptor>();
  readonly #project: string;
  readonly #region: string;

  constructor(project: string, region: string) {
    this.#project = project;
    this.#region = region;
  }

  createInstance(input: {
    readonly instanceName: string;
    readonly engineVersion: string;
    readonly database: string;
    readonly username: string;
  }): Promise<CloudSqlInstanceDescriptor> {
    const desc: CloudSqlInstanceDescriptor = {
      instanceName: input.instanceName,
      host:
        `${input.instanceName}.${this.#project}.${this.#region}.cloudsql.example`,
      port: 5432,
      database: input.database,
      username: input.username,
      version: input.engineVersion,
      project: this.#project,
      region: this.#region,
      resourceName: `projects/${this.#project}/instances/${input.instanceName}`,
    };
    this.#instances.set(input.instanceName, desc);
    return Promise.resolve(desc);
  }

  describeInstance(input: {
    readonly instanceName: string;
  }): Promise<CloudSqlInstanceDescriptor | undefined> {
    return Promise.resolve(this.#instances.get(input.instanceName));
  }

  deleteInstance(input: {
    readonly instanceName: string;
  }): Promise<boolean> {
    return Promise.resolve(this.#instances.delete(input.instanceName));
  }
}
