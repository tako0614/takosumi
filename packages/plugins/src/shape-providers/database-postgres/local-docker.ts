import type { ProviderPlugin } from "takosumi-contract";
import type {
  DatabasePostgresCapability,
  DatabasePostgresOutputs,
  DatabasePostgresSpec,
} from "../../shapes/database-postgres.ts";

export interface LocalDockerPostgresDescriptor {
  readonly containerName: string;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly version: string;
}

export interface LocalDockerPostgresCreateInput {
  readonly containerName: string;
  readonly version: string;
  readonly database: string;
  readonly username: string;
  readonly password: string;
  readonly hostPort: number;
}

export interface LocalDockerPostgresLifecycleClient {
  createInstance(
    input: LocalDockerPostgresCreateInput,
  ): Promise<LocalDockerPostgresDescriptor>;
  describeInstance(input: {
    readonly containerName: string;
  }): Promise<LocalDockerPostgresDescriptor | undefined>;
  deleteInstance(input: {
    readonly containerName: string;
  }): Promise<boolean>;
}

export interface LocalDockerPostgresProviderOptions {
  readonly lifecycle: LocalDockerPostgresLifecycleClient;
  readonly hostBinding?: string;
  readonly hostPortStart?: number;
  readonly secretRefBase?: string;
  readonly databaseName?: string;
  readonly username?: string;
  readonly passwordGenerator?: () => string;
  readonly clock?: () => Date;
}

const SUPPORTED_CAPABILITIES: readonly DatabasePostgresCapability[] = [
  "ssl-required",
  "extensions",
];

export function createLocalDockerPostgresProvider(
  options: LocalDockerPostgresProviderOptions,
): ProviderPlugin<DatabasePostgresSpec, DatabasePostgresOutputs> {
  const lifecycle = options.lifecycle;
  const hostBinding = options.hostBinding ?? "localhost";
  const portAllocator = createPortAllocator(options.hostPortStart ?? 15432);
  const secretBase = options.secretRefBase ??
    "secret://selfhosted/database-postgres";
  const defaultDb = options.databaseName ?? "app";
  const defaultUser = options.username ?? "app";
  const generatePassword = options.passwordGenerator ??
    (() => generatePasswordToken());
  const clock = options.clock ?? (() => new Date());

  return {
    id: "local-docker",
    version: "1.0.0",
    implements: { id: "database-postgres", version: "v1" },
    capabilities: SUPPORTED_CAPABILITIES,
    async apply(spec, _ctx) {
      const containerName = `pg-${defaultDb}-${randomSuffix()}`;
      const hostPort = portAllocator();
      const password = generatePassword();
      const desc = await lifecycle.createInstance({
        containerName,
        version: spec.version,
        database: defaultDb,
        username: defaultUser,
        password,
        hostPort,
      });
      return {
        handle: containerName,
        outputs: outputsFromDescriptor(
          desc,
          hostBinding,
          hostPort,
          secretBase,
          containerName,
        ),
      };
    },
    async destroy(handle, _ctx) {
      await lifecycle.deleteInstance({ containerName: handle });
    },
    async status(handle, _ctx) {
      const desc = await lifecycle.describeInstance({ containerName: handle });
      if (!desc) {
        return { kind: "deleted", observedAt: clock().toISOString() };
      }
      return {
        kind: "ready",
        outputs: outputsFromDescriptor(
          desc,
          hostBinding,
          desc.port,
          secretBase,
          handle,
        ),
        observedAt: clock().toISOString(),
      };
    },
  };
}

function outputsFromDescriptor(
  desc: LocalDockerPostgresDescriptor,
  hostBinding: string,
  hostPort: number,
  secretBase: string,
  containerName: string,
): DatabasePostgresOutputs {
  const passwordRef = `${secretBase}/${containerName}/password`;
  return {
    host: hostBinding,
    port: hostPort,
    database: desc.database,
    username: desc.username,
    passwordSecretRef: passwordRef,
    connectionString:
      `postgresql://${desc.username}@${hostBinding}:${hostPort}/${desc.database}`,
  };
}

function createPortAllocator(start: number): () => number {
  let next = start;
  return () => next++;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

function generatePasswordToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export class InMemoryLocalDockerPostgresLifecycle
  implements LocalDockerPostgresLifecycleClient {
  readonly #instances = new Map<string, LocalDockerPostgresDescriptor>();
  readonly #passwords = new Map<string, string>();

  createInstance(
    input: LocalDockerPostgresCreateInput,
  ): Promise<LocalDockerPostgresDescriptor> {
    const desc: LocalDockerPostgresDescriptor = {
      containerName: input.containerName,
      host: "localhost",
      port: input.hostPort,
      database: input.database,
      username: input.username,
      version: input.version,
    };
    this.#instances.set(input.containerName, desc);
    this.#passwords.set(input.containerName, input.password);
    return Promise.resolve(desc);
  }

  describeInstance(
    input: { readonly containerName: string },
  ): Promise<LocalDockerPostgresDescriptor | undefined> {
    return Promise.resolve(this.#instances.get(input.containerName));
  }

  deleteInstance(
    input: { readonly containerName: string },
  ): Promise<boolean> {
    this.#passwords.delete(input.containerName);
    return Promise.resolve(this.#instances.delete(input.containerName));
  }

  size(): number {
    return this.#instances.size;
  }

  password(containerName: string): string | undefined {
    return this.#passwords.get(containerName);
  }
}
