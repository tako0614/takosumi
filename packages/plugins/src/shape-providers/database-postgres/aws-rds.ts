import type { ProviderPlugin } from "takosumi-contract";
import type {
  DatabasePostgresCapability,
  DatabasePostgresOutputs,
  DatabasePostgresSpec,
} from "../../shapes/database-postgres.ts";

export interface AwsRdsInstanceDescriptor {
  readonly instanceId: string;
  readonly endpoint: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly version: string;
  readonly arn: string;
}

export interface AwsRdsLifecycleClient {
  createInstance(input: {
    readonly instanceId: string;
    readonly engineVersion: string;
    readonly instanceClass: string;
    readonly allocatedStorageGb: number;
    readonly database: string;
    readonly username: string;
    readonly password: string;
    readonly multiAz: boolean;
  }): Promise<AwsRdsInstanceDescriptor>;
  describeInstance(input: {
    readonly instanceId: string;
  }): Promise<AwsRdsInstanceDescriptor | undefined>;
  deleteInstance(input: {
    readonly instanceId: string;
  }): Promise<boolean>;
}

export interface AwsRdsProviderOptions {
  readonly lifecycle: AwsRdsLifecycleClient;
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

const SIZE_TO_CLASS: Readonly<Record<string, string>> = {
  small: "db.t4g.small",
  medium: "db.t4g.medium",
  large: "db.r6g.large",
  xlarge: "db.r6g.xlarge",
};

export function createAwsRdsProvider(
  options: AwsRdsProviderOptions,
): ProviderPlugin<DatabasePostgresSpec, DatabasePostgresOutputs> {
  const lifecycle = options.lifecycle;
  const dbName = options.databaseName ?? "app";
  const user = options.username ?? "app";
  const secretBase = options.secretRefBase ?? "secret://aws/rds";
  const generatePassword = options.passwordGenerator ?? randomPassword;
  const clock = options.clock ?? (() => new Date());
  return {
    id: "@takos/aws-rds",
    version: "1.0.0",
    implements: { id: "database-postgres", version: "v1" },
    capabilities: SUPPORTED_CAPABILITIES,
    async apply(spec, _ctx) {
      const instanceId = `pg-${dbName}-${randomId()}`;
      const password = generatePassword();
      const desc = await lifecycle.createInstance({
        instanceId,
        engineVersion: spec.version,
        instanceClass: SIZE_TO_CLASS[spec.size] ?? "db.t4g.small",
        allocatedStorageGb: spec.storage?.sizeGiB ?? 20,
        database: dbName,
        username: user,
        password,
        multiAz: spec.highAvailability ?? false,
      });
      return { handle: desc.arn, outputs: outputsOf(desc, secretBase) };
    },
    async destroy(handle, _ctx) {
      await lifecycle.deleteInstance({ instanceId: idFromArn(handle) });
    },
    async status(handle, _ctx) {
      const desc = await lifecycle.describeInstance({
        instanceId: idFromArn(handle),
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
  desc: AwsRdsInstanceDescriptor,
  secretBase: string,
): DatabasePostgresOutputs {
  const passwordRef = `${secretBase}/${desc.instanceId}/password`;
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

export class InMemoryAwsRdsLifecycle implements AwsRdsLifecycleClient {
  readonly #instances = new Map<string, AwsRdsInstanceDescriptor>();
  readonly #region: string;

  constructor(region = "us-east-1") {
    this.#region = region;
  }

  createInstance(input: {
    readonly instanceId: string;
    readonly engineVersion: string;
    readonly database: string;
    readonly username: string;
  }): Promise<AwsRdsInstanceDescriptor> {
    const desc: AwsRdsInstanceDescriptor = {
      instanceId: input.instanceId,
      endpoint: `${input.instanceId}.xxx.${this.#region}.rds.amazonaws.com`,
      port: 5432,
      database: input.database,
      username: input.username,
      version: input.engineVersion,
      arn: `arn:aws:rds:${this.#region}:000000000000:db:${input.instanceId}`,
    };
    this.#instances.set(input.instanceId, desc);
    return Promise.resolve(desc);
  }

  describeInstance(input: {
    readonly instanceId: string;
  }): Promise<AwsRdsInstanceDescriptor | undefined> {
    return Promise.resolve(this.#instances.get(input.instanceId));
  }

  deleteInstance(input: {
    readonly instanceId: string;
  }): Promise<boolean> {
    return Promise.resolve(this.#instances.delete(input.instanceId));
  }
}
