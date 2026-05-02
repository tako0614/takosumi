/**
 * `LocalDockerPostgresConnector` — selfhost `database-postgres@v1` backed by
 * a local docker-managed Postgres container.
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

export interface LocalDockerPostgresConnectorOptions {
  readonly hostBinding?: string;
  readonly hostPortStart?: number;
  readonly databaseName?: string;
  readonly username?: string;
  readonly secretRefBase?: string;
  readonly passwordGenerator?: () => string;
  readonly command?: typeof Deno.Command;
}

interface InstanceDescriptor {
  readonly containerName: string;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly version: string;
}

export class LocalDockerPostgresConnector implements Connector {
  readonly provider = "local-docker";
  readonly shape = "database-postgres@v1";
  readonly #hostBinding: string;
  readonly #portAlloc: () => number;
  readonly #dbName: string;
  readonly #user: string;
  readonly #secretBase: string;
  readonly #generatePassword: () => string;
  readonly #command: typeof Deno.Command;
  readonly #instances = new Map<string, InstanceDescriptor>();

  constructor(opts: LocalDockerPostgresConnectorOptions = {}) {
    this.#hostBinding = opts.hostBinding ?? "localhost";
    this.#portAlloc = createPortAllocator(opts.hostPortStart ?? 15432);
    this.#dbName = opts.databaseName ?? "app";
    this.#user = opts.username ?? "app";
    this.#secretBase = opts.secretRefBase ??
      "secret://selfhosted/database-postgres";
    this.#generatePassword = opts.passwordGenerator ?? randomPassword;
    this.#command = opts.command ?? Deno.Command;
  }

  async apply(req: LifecycleApplyRequest): Promise<LifecycleApplyResponse> {
    const spec = req.spec as unknown as { version: string };
    const containerName = `pg-${this.#dbName}-${randomId()}`;
    const hostPort = this.#portAlloc();
    const password = this.#generatePassword();
    const cmd = new this.#command("docker", {
      args: [
        "run",
        "-d",
        "--restart",
        "unless-stopped",
        "--name",
        containerName,
        "-p",
        `${hostPort}:5432`,
        "-e",
        `POSTGRES_DB=${this.#dbName}`,
        "-e",
        `POSTGRES_USER=${this.#user}`,
        "-e",
        `POSTGRES_PASSWORD=${password}`,
        `postgres:${spec.version}`,
      ],
      stdout: "null",
      stderr: "piped",
    });
    const { code, stderr } = await cmd.output();
    if (code !== 0) {
      throw new Error(
        `docker run postgres failed: ${new TextDecoder().decode(stderr)}`,
      );
    }
    const desc: InstanceDescriptor = {
      containerName,
      host: this.#hostBinding,
      port: hostPort,
      database: this.#dbName,
      username: this.#user,
      version: spec.version,
    };
    this.#instances.set(containerName, desc);
    return {
      handle: containerName,
      outputs: this.#outputsFor(desc),
    };
  }

  async destroy(
    req: LifecycleDestroyRequest,
  ): Promise<LifecycleDestroyResponse> {
    const cmd = new this.#command("docker", {
      args: ["rm", "-f", req.handle],
      stdout: "null",
      stderr: "piped",
    });
    const { code } = await cmd.output();
    this.#instances.delete(req.handle);
    return code === 0
      ? { ok: true }
      : { ok: true, note: "container not found" };
  }

  describe(
    req: LifecycleDescribeRequest,
  ): Promise<LifecycleDescribeResponse> {
    const desc = this.#instances.get(req.handle);
    if (!desc) return Promise.resolve({ status: "missing" });
    return Promise.resolve({
      status: "running",
      outputs: this.#outputsFor(desc),
    });
  }

  #outputsFor(desc: InstanceDescriptor): JsonObject {
    return {
      host: desc.host,
      port: desc.port,
      database: desc.database,
      username: desc.username,
      passwordSecretRef: `${this.#secretBase}/${desc.containerName}/password`,
      connectionString:
        `postgresql://${desc.username}@${desc.host}:${desc.port}/${desc.database}`,
    };
  }
}

function createPortAllocator(start: number): () => number {
  let next = start;
  return () => next++;
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 8);
}

function randomPassword(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
