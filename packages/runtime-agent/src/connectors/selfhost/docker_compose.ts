/**
 * `DockerComposeConnector` — selfhost web-service driven by `docker run`.
 *
 * Currently uses `Deno.Command` to invoke the Docker CLI directly. Operators
 * are expected to have docker installed and accessible on PATH. The connector
 * keeps an in-memory descriptor map for describe() lookups.
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

export interface DockerComposeConnectorOptions {
  readonly hostBinding?: string;
  readonly hostPortStart?: number;
  /** Override for tests: replacement for `Deno.Command`. */
  readonly command?: typeof Deno.Command;
}

interface ServiceDescriptor {
  readonly serviceName: string;
  readonly image: string;
  readonly hostPort: number;
  readonly internalPort: number;
  readonly env?: Readonly<Record<string, string>>;
}

export class DockerComposeConnector implements Connector {
  readonly provider = "docker-compose";
  readonly shape = "web-service@v1";
  readonly #hostBinding: string;
  readonly #portAlloc: () => number;
  readonly #command: typeof Deno.Command;
  readonly #services = new Map<string, ServiceDescriptor>();

  constructor(opts: DockerComposeConnectorOptions = {}) {
    this.#hostBinding = opts.hostBinding ?? "localhost";
    this.#portAlloc = createPortAllocator(opts.hostPortStart ?? 18080);
    this.#command = opts.command ?? Deno.Command;
  }

  async apply(req: LifecycleApplyRequest): Promise<LifecycleApplyResponse> {
    const spec = req.spec as unknown as {
      image: string;
      port: number;
      env?: Record<string, string>;
      bindings?: Record<string, string>;
      command?: readonly string[];
    };
    const serviceName = serviceNameFromImage(spec.image);
    const hostPort = this.#portAlloc();
    const env = { ...(spec.env ?? {}), ...(spec.bindings ?? {}) };
    const cmd = new this.#command("docker", {
      args: [
        "run",
        "-d",
        "--restart",
        "unless-stopped",
        "--name",
        serviceName,
        "-p",
        `${hostPort}:${spec.port}`,
        ...envFlags(env),
        spec.image,
        ...(spec.command ?? []),
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stderr } = await cmd.output();
    if (code !== 0) {
      throw new Error(
        `docker run failed for ${serviceName}: ${
          new TextDecoder().decode(stderr)
        }`,
      );
    }
    const desc: ServiceDescriptor = {
      serviceName,
      image: spec.image,
      hostPort,
      internalPort: spec.port,
      env,
    };
    this.#services.set(serviceName, desc);
    return {
      handle: serviceName,
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
    this.#services.delete(req.handle);
    return code === 0
      ? { ok: true }
      : { ok: true, note: "container not found" };
  }

  describe(
    req: LifecycleDescribeRequest,
  ): Promise<LifecycleDescribeResponse> {
    const desc = this.#services.get(req.handle);
    if (!desc) return Promise.resolve({ status: "missing" });
    return Promise.resolve({
      status: "running",
      outputs: this.#outputsFor(desc),
    });
  }

  #outputsFor(desc: ServiceDescriptor): JsonObject {
    return {
      url: `http://${this.#hostBinding}:${desc.hostPort}`,
      internalHost: desc.serviceName,
      internalPort: desc.internalPort,
    };
  }
}

function envFlags(env: Readonly<Record<string, string>> | undefined): string[] {
  if (!env) return [];
  const flags: string[] = [];
  for (const [k, v] of Object.entries(env)) flags.push("-e", `${k}=${v}`);
  return flags;
}

function serviceNameFromImage(image: string): string {
  const tail = image.split("/").at(-1)?.split(":")[0] ?? "web-service";
  return tail.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
}

function createPortAllocator(start: number): () => number {
  let next = start;
  return () => next++;
}
