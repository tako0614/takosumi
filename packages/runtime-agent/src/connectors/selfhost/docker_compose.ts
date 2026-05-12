/**
 * `DockerComposeConnector` — selfhost web-service driven by `docker run`.
 *
 * Currently uses `Deno.Command` to invoke the Docker CLI directly. Operators
 * are expected to have docker installed and accessible on PATH. The connector
 * keeps an in-memory descriptor map only as a write-through cache for `apply()`
 * outputs; `describe()` queries the actual docker daemon via `docker inspect`
 * so it survives runtime-agent restarts.
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
import { parseSelfhostWebServiceSpec } from "../_spec.ts";

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

const PORT_RETRY_LIMIT = 50;

export class DockerComposeConnector implements Connector {
  readonly provider = "@takos/selfhost-docker-compose";
  readonly shape = "web-service@v1";
  readonly acceptedArtifactKinds: readonly string[] = ["oci-image"];
  readonly #hostBinding: string;
  readonly #portAlloc: () => number;
  readonly #command: typeof Deno.Command;
  readonly #services = new Map<string, ServiceDescriptor>();

  constructor(opts: DockerComposeConnectorOptions = {}) {
    this.#hostBinding = opts.hostBinding ?? "localhost";
    this.#portAlloc = createPortAllocator(opts.hostPortStart ?? 18080);
    this.#command = opts.command ?? Deno.Command;
  }

  async apply(
    req: LifecycleApplyRequest,
    _ctx: ConnectorContext,
  ): Promise<LifecycleApplyResponse> {
    const spec = parseSelfhostWebServiceSpec(req.spec);
    const image = spec.image ?? spec.artifact?.uri;
    if (!image) {
      throw new Error("web-service spec requires `image` or `artifact.uri`");
    }
    const serviceName = serviceNameFromImage(image);
    const env = { ...(spec.env ?? {}), ...(spec.bindings ?? {}) };

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
          serviceName,
          "-p",
          `${hostPort}:${spec.port}`,
          ...envFlags(env),
          image,
          ...(spec.command ?? []),
        ],
        stdout: "piped",
        stderr: "piped",
      });
      const { code, stderr } = await cmd.output();
      if (code === 0) {
        const desc: ServiceDescriptor = {
          serviceName,
          image,
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
      lastErr = new TextDecoder().decode(stderr);
      if (!isPortAllocationError(lastErr)) {
        throw new Error(`docker run failed for ${serviceName}: ${lastErr}`);
      }
      // port collision — try the next port
    }
    throw new Error(
      `docker run failed for ${serviceName} after ${PORT_RETRY_LIMIT} port retries: ${lastErr}`,
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
    this.#services.delete(req.handle);
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
    return outputs ? { status: "running", outputs } : { status: "running" };
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

  #outputsFor(desc: ServiceDescriptor): JsonObject {
    return {
      url: `http://${this.#hostBinding}:${desc.hostPort}`,
      internalHost: desc.serviceName,
      internalPort: desc.internalPort,
    };
  }

  #outputsFromInspect(
    handle: string,
    inspect: DockerInspect,
  ): JsonObject | undefined {
    const portMap = inspect.NetworkSettings?.Ports ?? {};
    const portKey = Object.keys(portMap)[0];
    if (!portKey) return undefined;
    const bindings = portMap[portKey];
    const hostPort = bindings && bindings.length > 0
      ? Number(bindings[0]?.HostPort)
      : NaN;
    if (!Number.isFinite(hostPort) || hostPort <= 0) return undefined;
    const internalPort = Number(portKey.split("/")[0]);
    if (!Number.isFinite(internalPort) || internalPort <= 0) return undefined;
    return {
      url: `http://${this.#hostBinding}:${hostPort}`,
      internalHost: handle,
      internalPort,
    };
  }
}

interface DockerInspect {
  State?: { Status?: string };
  NetworkSettings?: {
    Ports?: Record<string, { HostIp?: string; HostPort?: string }[] | null>;
  };
  Config?: { ExposedPorts?: Record<string, unknown>; Env?: string[] };
}

function isPortAllocationError(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return lower.includes("port is already allocated") ||
    lower.includes("address already in use") ||
    lower.includes("bind: address already in use") ||
    lower.includes("port already in use");
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
