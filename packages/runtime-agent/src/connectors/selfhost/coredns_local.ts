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
import type { Connector } from "../connector.ts";

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
  readonly #zoneFile: string;
  readonly #records = new Map<string, RecordDescriptor>();
  #counter = 0;

  constructor(opts: CorednsLocalConnectorOptions) {
    this.#zoneFile = opts.zoneFile;
  }

  async apply(req: LifecycleApplyRequest): Promise<LifecycleApplyResponse> {
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
  ): Promise<LifecycleDescribeResponse> {
    const desc = this.#records.get(req.handle);
    if (!desc) return Promise.resolve({ status: "missing" });
    return Promise.resolve({
      status: "running",
      outputs: outputsFor(desc),
    });
  }
}

function outputsFor(desc: RecordDescriptor): JsonObject {
  return { fqdn: desc.fqdn };
}
