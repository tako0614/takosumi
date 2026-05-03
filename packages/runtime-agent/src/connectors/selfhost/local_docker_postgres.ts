/**
 * `LocalDockerPostgresConnector` — selfhost `database-postgres@v1` backed by
 * a local docker-managed Postgres container.
 *
 * `describe()` queries the docker daemon via `docker inspect` so the connector
 * can recover state across runtime-agent restarts. The in-memory descriptor
 * map is only a write-through cache used by `apply()` to compute outputs.
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
import { verifyResultFromError } from "../_verify_helpers.ts";

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

const PORT_RETRY_LIMIT = 50;

export class LocalDockerPostgresConnector implements Connector {
  readonly provider = "@takos/selfhost-postgres";
  readonly shape = "database-postgres@v1";
  readonly acceptedArtifactKinds: readonly string[] = ["oci-image"];
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

  async apply(
    req: LifecycleApplyRequest,
    _ctx: ConnectorContext,
  ): Promise<LifecycleApplyResponse> {
    const spec = req.spec as unknown as { version: string };
    const containerName = `pg-${this.#dbName}-${randomId()}`;
    const password = this.#generatePassword();

    let lastErr = "";
    let hostPort = 0;
    for (let attempt = 0; attempt < PORT_RETRY_LIMIT; attempt++) {
      hostPort = this.#portAlloc();
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
      if (code === 0) {
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
      lastErr = new TextDecoder().decode(stderr);
      if (!isPortAllocationError(lastErr)) {
        throw new Error(`docker run postgres failed: ${lastErr}`);
      }
      // port collision — try the next port
    }
    throw new Error(
      `docker run postgres failed after ${PORT_RETRY_LIMIT} port retries: ${lastErr}`,
    );
  }

  async destroy(
    req: LifecycleDestroyRequest,
    _ctx: ConnectorContext,
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

  async describe(
    req: LifecycleDescribeRequest,
    _ctx: ConnectorContext,
  ): Promise<LifecycleDescribeResponse> {
    const cmd = new this.#command("docker", {
      args: ["inspect", req.handle, "--format", "{{json .}}"],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout } = await cmd.output();
    if (code !== 0) return { status: "missing" };
    const text = new TextDecoder().decode(stdout).trim();
    if (!text) return { status: "missing" };
    let parsed: DockerInspect;
    try {
      parsed = JSON.parse(text) as DockerInspect;
    } catch {
      return { status: "missing" };
    }
    const status = parsed.State?.Status;
    if (status !== "running") return { status: "missing" };
    const outputs = this.#outputsFromInspect(req.handle, parsed);
    return outputs
      ? { status: "running", outputs }
      : { status: "running" };
  }

  async verify(_ctx: ConnectorContext): Promise<ConnectorVerifyResult> {
    try {
      const cmd = new this.#command("docker", {
        args: ["version", "--format", "{{.Server.Version}}"],
        stdout: "piped",
        stderr: "piped",
      });
      const { code, stderr } = await cmd.output();
      if (code === 0) return { ok: true, note: "docker daemon reachable" };
      const message = new TextDecoder().decode(stderr).trim() ||
        `docker version exited with code ${code}`;
      return {
        ok: false,
        code: "network_error",
        note: `docker:version: ${message}`,
      };
    } catch (error) {
      return verifyResultFromError(error, "docker:version");
    }
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

  #outputsFromInspect(
    handle: string,
    inspect: DockerInspect,
  ): JsonObject | undefined {
    const portMap = inspect.NetworkSettings?.Ports ?? {};
    const bindings = portMap["5432/tcp"];
    const hostPort = bindings && bindings.length > 0
      ? Number(bindings[0]?.HostPort)
      : NaN;
    if (!Number.isFinite(hostPort) || hostPort <= 0) return undefined;

    const env = parseEnv(inspect.Config?.Env ?? []);
    const database = env["POSTGRES_DB"] ?? this.#dbName;
    const username = env["POSTGRES_USER"] ?? this.#user;
    const host = this.#hostBinding;
    return {
      host,
      port: hostPort,
      database,
      username,
      passwordSecretRef: `${this.#secretBase}/${handle}/password`,
      connectionString:
        `postgresql://${username}@${host}:${hostPort}/${database}`,
    };
  }
}

interface DockerInspect {
  State?: { Status?: string };
  NetworkSettings?: {
    Ports?: Record<string, { HostIp?: string; HostPort?: string }[] | null>;
  };
  Config?: { Env?: string[] };
}

function isPortAllocationError(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return lower.includes("port is already allocated") ||
    lower.includes("address already in use") ||
    lower.includes("bind: address already in use") ||
    lower.includes("port already in use");
}

function parseEnv(entries: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of entries) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const key = entry.slice(0, eq);
    const value = entry.slice(eq + 1);
    out[key] = value;
  }
  return out;
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
