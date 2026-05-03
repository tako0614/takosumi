/**
 * `SystemdUnitConnector` — selfhost web-service backed by a systemd unit file.
 *
 * Writes a unit file to `unitDir` and runs `systemctl enable --now`. The
 * connector keeps a small in-memory map only as a write-through cache; the
 * authoritative state for `describe()` is the on-disk unit file plus
 * `systemctl is-active`, so describe() survives runtime-agent restarts.
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

export interface SystemdUnitConnectorOptions {
  readonly unitDir?: string;
  readonly hostBinding?: string;
  readonly hostPortStart?: number;
  readonly command?: typeof Deno.Command;
}

interface UnitDescriptor {
  readonly unitName: string;
  readonly hostPort: number;
  readonly internalPort: number;
}

const HOST_PORT_MARKER = "X-Takos-HostPort";
const INTERNAL_PORT_MARKER = "X-Takos-InternalPort";

export class SystemdUnitConnector implements Connector {
  readonly provider = "@takos/selfhost-systemd";
  readonly shape = "web-service@v1";
  readonly acceptedArtifactKinds: readonly string[] = ["oci-image"];
  readonly #unitDir: string;
  readonly #hostBinding: string;
  readonly #portAlloc: () => number;
  readonly #command: typeof Deno.Command;
  readonly #units = new Map<string, UnitDescriptor>();

  constructor(opts: SystemdUnitConnectorOptions = {}) {
    this.#unitDir = opts.unitDir ?? "/etc/systemd/system";
    this.#hostBinding = opts.hostBinding ?? "127.0.0.1";
    this.#portAlloc = createPortAllocator(opts.hostPortStart ?? 28080);
    this.#command = opts.command ?? Deno.Command;
  }

  async apply(
    req: LifecycleApplyRequest,
    _ctx: ConnectorContext,
  ): Promise<LifecycleApplyResponse> {
    const spec = req.spec as unknown as {
      image?: string;
      artifact?: { kind: string; uri?: string };
      port: number;
      env?: Record<string, string>;
      bindings?: Record<string, string>;
      command?: readonly string[];
    };
    const image = spec.image ?? spec.artifact?.uri;
    if (!image) {
      throw new Error("web-service spec requires `image` or `artifact.uri`");
    }
    const unitName = `${nameOf(image)}.service`;
    const hostPort = this.#portAlloc();
    const unitFile = `${this.#unitDir}/${unitName}`;
    const env = { ...(spec.env ?? {}), ...(spec.bindings ?? {}) };
    const body = renderSystemdUnit({
      unitName,
      image,
      env,
      command: spec.command,
      hostPort,
      internalPort: spec.port,
    });
    await Deno.writeTextFile(unitFile, body);
    await this.#runOrThrow("systemctl", ["daemon-reload"]);
    await this.#runOrThrow("systemctl", ["enable", "--now", unitName]);
    const desc: UnitDescriptor = {
      unitName,
      hostPort,
      internalPort: spec.port,
    };
    this.#units.set(unitName, desc);
    return {
      handle: unitName,
      outputs: this.#outputsFor(desc),
    };
  }

  async destroy(
    req: LifecycleDestroyRequest,
    _ctx: ConnectorContext,
  ): Promise<LifecycleDestroyResponse> {
    const unitFile = `${this.#unitDir}/${req.handle}`;
    try {
      await this.#runOrThrow("systemctl", ["disable", "--now", req.handle]);
    } catch {
      // proceed with file cleanup even if systemctl reports the unit is
      // already stopped or not loaded.
    }
    try {
      await Deno.remove(unitFile);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    this.#units.delete(req.handle);
    return { ok: true };
  }

  async describe(
    req: LifecycleDescribeRequest,
    _ctx: ConnectorContext,
  ): Promise<LifecycleDescribeResponse> {
    const unitFile = `${this.#unitDir}/${req.handle}`;
    let body: string;
    try {
      body = await Deno.readTextFile(unitFile);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return { status: "missing" };
      throw error;
    }
    const cmd = new this.#command("systemctl", {
      args: ["is-active", req.handle],
      stdout: "piped",
      stderr: "piped",
    });
    const { code } = await cmd.output();
    if (code !== 0) return { status: "missing" };
    const ports = parsePortMarkers(body);
    if (!ports) return { status: "running" };
    return {
      status: "running",
      outputs: this.#outputsFor({
        unitName: req.handle,
        hostPort: ports.hostPort,
        internalPort: ports.internalPort,
      }),
    };
  }

  async verify(_ctx: ConnectorContext): Promise<ConnectorVerifyResult> {
    try {
      const cmd = new this.#command("systemctl", {
        args: ["--version"],
        stdout: "piped",
        stderr: "piped",
      });
      const { code, stderr } = await cmd.output();
      if (code === 0) return { ok: true, note: "systemctl reachable" };
      const message = new TextDecoder().decode(stderr).trim() ||
        `systemctl --version exited with code ${code}`;
      return {
        ok: false,
        code: "network_error",
        note: `systemctl:version: ${message}`,
      };
    } catch (error) {
      return verifyResultFromError(error, "systemctl:version");
    }
  }

  #outputsFor(desc: UnitDescriptor): JsonObject {
    return {
      url: `http://${this.#hostBinding}:${desc.hostPort}`,
      internalHost: this.#hostBinding,
      internalPort: desc.internalPort,
    };
  }

  async #runOrThrow(cmd: string, args: readonly string[]): Promise<void> {
    const child = new this.#command(cmd, {
      args: [...args],
      stdout: "null",
      stderr: "piped",
    });
    const { code, stderr } = await child.output();
    if (code !== 0) {
      throw new Error(
        `${cmd} ${args.join(" ")} exited with code ${code}: ${
          new TextDecoder().decode(stderr)
        }`,
      );
    }
  }
}

function renderSystemdUnit(input: {
  unitName: string;
  image: string;
  env?: Record<string, string>;
  command?: readonly string[];
  hostPort: number;
  internalPort: number;
}): string {
  const env = input.env
    ? Object.entries(input.env)
      .map(([k, v]) => `Environment=${k}=${v}`)
      .join("\n")
    : "";
  const exec = input.command && input.command.length > 0
    ? input.command.join(" ")
    : input.image;
  return [
    `# ${HOST_PORT_MARKER}=${input.hostPort}`,
    `# ${INTERNAL_PORT_MARKER}=${input.internalPort}`,
    "[Unit]",
    `Description=Takos Web Service ${input.unitName}`,
    "After=network.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${exec}`,
    env,
    "Restart=on-failure",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].filter(Boolean).join("\n");
}

function parsePortMarkers(
  body: string,
): { hostPort: number; internalPort: number } | undefined {
  const hostMatch = body.match(
    new RegExp(`^#\\s*${HOST_PORT_MARKER}=(\\d+)\\s*$`, "m"),
  );
  const internalMatch = body.match(
    new RegExp(`^#\\s*${INTERNAL_PORT_MARKER}=(\\d+)\\s*$`, "m"),
  );
  if (!hostMatch || !internalMatch) return undefined;
  const hostPort = Number(hostMatch[1]);
  const internalPort = Number(internalMatch[1]);
  if (
    !Number.isFinite(hostPort) || hostPort <= 0 ||
    !Number.isFinite(internalPort) || internalPort <= 0
  ) {
    return undefined;
  }
  return { hostPort, internalPort };
}

function nameOf(image: string): string {
  const tail = image.split("/").at(-1)?.split(":")[0] ?? "service";
  return tail.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
}

function createPortAllocator(start: number): () => number {
  let next = start;
  return () => next++;
}
