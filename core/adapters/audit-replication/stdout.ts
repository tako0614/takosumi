import type { ChainedAuditEvent } from "../../domains/observability/audit_chain.ts";
import type { AuditExternalReplicationSink } from "../../domains/audit-replication/external_log.ts";

/**
 * Development-only append sink. It is intentionally an adapter rather than a
 * domain implementation: stdout has no durability or immutability guarantee.
 */
export class StdoutAuditReplicationSink
  implements AuditExternalReplicationSink {
  readonly kind = "stdout";
  readonly assurance = "development" as const;
  readonly #records: ChainedAuditEvent[] = [];
  readonly #write: (line: string) => void;

  constructor(options: { readonly write?: (line: string) => void } = {}) {
    this.#write = options.write ?? ((line) => console.log(line));
  }

  replicate(record: ChainedAuditEvent): Promise<void> {
    if (
      this.#records.some((existing) =>
        existing.sequence === record.sequence && existing.hash === record.hash
      )
    ) {
      return Promise.resolve();
    }
    this.#records.push(structuredClone(record));
    this.#write(JSON.stringify({
      kind: "audit-replication",
      sequence: record.sequence,
      previousHash: record.previousHash,
      hash: record.hash,
      eventId: record.event.id,
      eventType: record.event.type,
      occurredAt: record.event.occurredAt,
    }));
    return Promise.resolve();
  }

  readChain(): Promise<readonly ChainedAuditEvent[]> {
    return Promise.resolve(
      [...this.#records].sort((a, b) => a.sequence - b.sequence).map((record) =>
        structuredClone(record)
      ),
    );
  }
}
