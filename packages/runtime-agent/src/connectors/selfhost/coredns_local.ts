/**
 * `CorednsLocalConnector` — selfhost custom-domain backed by a CoreDNS
 * Corefile. Appends and removes A-record stanzas keyed by a synthetic
 * record name handle.
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

export interface CorednsLocalConnectorOptions {
  readonly zoneFile: string;
}

interface RecordDescriptor {
  readonly recordName: string;
  readonly fqdn: string;
  readonly target: string;
}

export class CorednsLocalConnector implements Connector {
  readonly provider = "coredns-local";
  readonly shape = "custom-domain@v1";
  readonly acceptedArtifactKinds: readonly string[] = [];
  readonly #zoneFile: string;
  readonly #records = new Map<string, RecordDescriptor>();
  #counter = 0;

  constructor(opts: CorednsLocalConnectorOptions) {
    this.#zoneFile = opts.zoneFile;
  }

  async apply(
    req: LifecycleApplyRequest,
    _ctx: ConnectorContext,
  ): Promise<LifecycleApplyResponse> {
    const spec = req.spec as unknown as { name: string; target: string };
    const recordName = `coredns-${++this.#counter}`;
    const desc: RecordDescriptor = {
      recordName,
      fqdn: spec.name,
      target: spec.target,
    };
    const stanza = `\n# ${recordName}\n${spec.name}. IN A ${spec.target}\n`;
    await Deno.writeTextFile(this.#zoneFile, stanza, { append: true });
    this.#records.set(recordName, desc);
    return {
      handle: recordName,
      outputs: outputsFor(desc),
    };
  }

  async destroy(
    req: LifecycleDestroyRequest,
    _ctx: ConnectorContext,
  ): Promise<LifecycleDestroyResponse> {
    const desc = this.#records.get(req.handle);
    if (!desc) return { ok: true, note: "record not found" };
    try {
      const text = await Deno.readTextFile(this.#zoneFile);
      const filtered = text
        .split("\n")
        .filter((line) =>
          !line.includes(`# ${req.handle}`) &&
          !line.startsWith(`${desc.fqdn}.`)
        )
        .join("\n");
      await Deno.writeTextFile(this.#zoneFile, filtered);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    this.#records.delete(req.handle);
    return { ok: true };
  }

  describe(
    req: LifecycleDescribeRequest,
    _ctx: ConnectorContext,
  ): Promise<LifecycleDescribeResponse> {
    const desc = this.#records.get(req.handle);
    if (!desc) return Promise.resolve({ status: "missing" });
    return Promise.resolve({
      status: "running",
      outputs: outputsFor(desc),
    });
  }

  async verify(_ctx: ConnectorContext): Promise<ConnectorVerifyResult> {
    try {
      const stat = await Deno.stat(this.#zoneFile);
      if (!stat.isFile) {
        return {
          ok: false,
          code: "permission_denied",
          note: `coredns:Deno.stat ${this.#zoneFile}: not a file`,
        };
      }
      return { ok: true, note: `Corefile present: ${this.#zoneFile}` };
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return {
          ok: false,
          code: "network_error",
          note: `coredns:Deno.stat ${this.#zoneFile}: file not found`,
        };
      }
      return verifyResultFromError(
        error,
        `coredns:Deno.stat ${this.#zoneFile}`,
      );
    }
  }
}

function outputsFor(desc: RecordDescriptor): JsonObject {
  return { fqdn: desc.fqdn };
}
