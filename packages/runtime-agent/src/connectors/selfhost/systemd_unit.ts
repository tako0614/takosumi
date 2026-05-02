/**
 * `SystemdUnitConnector` — selfhost web-service backed by a systemd unit file.
 *
 * Writes a unit file to `unitDir` and runs `systemctl enable --now`. The
 * connector keeps a small in-memory map for describe lookups.
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

export class SystemdUnitConnector implements Connector {
  readonly provider = "systemd-unit";
  readonly shape = "web-service@v1";
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

  async apply(req: LifecycleApplyRequest): Promise<LifecycleApplyResponse> {
    const spec = req.spec as unknown as {
      image: string;
      port: number;
      env?: Record<string, string>;
      bindings?: Record<string, string>;
      command?: readonly string[];
    };
    const unitName = `${nameOf(spec.image)}.service`;
    const hostPort = this.#portAlloc();
    const unitFile = `${this.#unitDir}/${unitName}`;
    const env = { ...(spec.env ?? {}), ...(spec.bindings ?? {}) };
    const body = renderSystemdUnit({
      unitName,
      image: spec.image,
      env,
      command: spec.command,
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

  describe(
    req: LifecycleDescribeRequest,
  ): Promise<LifecycleDescribeResponse> {
    const desc = this.#units.get(req.handle);
    if (!desc) return Promise.resolve({ status: "missing" });
    return Promise.resolve({
      status: "running",
      outputs: this.#outputsFor(desc),
    });
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

function nameOf(image: string): string {
  const tail = image.split("/").at(-1)?.split(":")[0] ?? "service";
  return tail.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
}

function createPortAllocator(start: number): () => number {
  let next = start;
  return () => next++;
}
