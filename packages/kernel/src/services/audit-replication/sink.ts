import type { ChainedAuditEvent } from "../observability/audit_chain.ts";

/**
 * AuditReplicationSink — external replication hook for tamper-evident audit
 * events. Implementations forward chained events to a downstream cold-store
 * (Sumo Logic / Datadog / S3 / Splunk / a corporate SIEM) so regulated
 * environments (PCI-DSS / HIPAA / SOX) can satisfy independent retention
 * and integrity requirements.
 *
 * Replication is **append-only** and **best-effort idempotent**: sinks must
 * accept replays of the same `event.id` without duplicating downstream
 * records. The hash chain in `previousHash` / `hash` lets downstream
 * verification detect gaps even if delivery is asynchronous.
 *
 * Sinks must NOT mutate the event before forwarding. The Phase 18 redaction
 * pipeline has already stripped sensitive fields before the chain hash was
 * computed; replicating a different shape would break tamper evidence.
 */
export interface AuditReplicationSink {
  /**
   * Forward a single chained audit record to the downstream system. Errors
   * surface to the caller so the replication driver can decide between
   * retry-with-backoff and dead-letter routing. Implementations should
   * retry transient failures internally where it is cheap to do so.
   */
  replicate(record: ChainedAuditEvent): Promise<AuditReplicationResult>;

  /**
   * Optional batch hook. When implemented, the driver prefers `replicateBatch`
   * to amortize network round trips. The default (sequential `replicate`)
   * is supplied by `runReplicationBatch` for sinks that omit this method.
   */
  replicateBatch?(
    records: readonly ChainedAuditEvent[],
  ): Promise<AuditReplicationBatchResult>;

  /**
   * Stable identifier for diagnostics / metrics. Should be specific enough
   * for an operator to disambiguate two sinks of the same kind (e.g.
   * `sumologic:hipaa-prod` vs `sumologic:pci-prod`).
   */
  readonly id: string;

  /**
   * Free-form descriptor of the downstream tier. Used by the runbook /
   * dashboards to surface which compliance regime each sink covers.
   */
  readonly description?: string;
}

export interface AuditReplicationResult {
  readonly id: string;
  readonly sequence: number;
  readonly accepted: boolean;
  /**
   * Optional downstream receipt (e.g. Sumo Logic message id, S3 etag).
   * Operators can correlate this with the corporate SIEM dashboard.
   */
  readonly receipt?: string;
}

export interface AuditReplicationBatchResult {
  readonly accepted: number;
  readonly results: readonly AuditReplicationResult[];
}

export async function runReplicationBatch(
  sink: AuditReplicationSink,
  records: readonly ChainedAuditEvent[],
): Promise<AuditReplicationBatchResult> {
  if (sink.replicateBatch) {
    return await sink.replicateBatch(records);
  }
  const results: AuditReplicationResult[] = [];
  for (const record of records) {
    results.push(await sink.replicate(record));
  }
  return {
    accepted: results.filter((entry) => entry.accepted).length,
    results,
  };
}

/**
 * In-memory replication sink used by tests and the local development harness.
 * Records are appended to an internal buffer; duplicate event ids are coerced
 * into a single entry so the sink models the idempotent-by-id contract that
 * downstream services (Sumo / Datadog / S3) advertise.
 */
export class InMemoryAuditReplicationSink implements AuditReplicationSink {
  readonly id: string;
  readonly description?: string;
  readonly #records: ChainedAuditEvent[] = [];
  readonly #seenIds = new Set<string>();

  constructor(
    options: { readonly id?: string; readonly description?: string } = {},
  ) {
    this.id = options.id ?? "memory-replication-sink";
    if (options.description !== undefined) {
      this.description = options.description;
    }
  }

  replicate(record: ChainedAuditEvent): Promise<AuditReplicationResult> {
    const id = record.event.id;
    if (this.#seenIds.has(id)) {
      return Promise.resolve({
        id,
        sequence: record.sequence,
        accepted: false,
        receipt: `dedup:${id}`,
      });
    }
    this.#seenIds.add(id);
    this.#records.push(structuredClone(record) as ChainedAuditEvent);
    return Promise.resolve({
      id,
      sequence: record.sequence,
      accepted: true,
      receipt: `memory:${id}:${record.sequence}`,
    });
  }

  replicateBatch(
    records: readonly ChainedAuditEvent[],
  ): Promise<AuditReplicationBatchResult> {
    return runReplicationBatch(
      // delegate to single-record path so dedup logic is shared
      { id: this.id, replicate: (record) => this.replicate(record) },
      records,
    );
  }

  /** Inspect captured records (test-only). */
  records(): readonly ChainedAuditEvent[] {
    return this.#records.map((record) =>
      structuredClone(record) as ChainedAuditEvent
    );
  }

  /** Clear the buffer (test-only). */
  reset(): void {
    this.#records.length = 0;
    this.#seenIds.clear();
  }
}

/**
 * Driver that fans out a chained audit record to N replication sinks. The
 * driver swallows individual sink failures by default so a misbehaving sink
 * does not block the in-region audit_events table from accepting the next
 * append. Operators wire the failure list into their alerting pipeline.
 */
export class AuditReplicationDriver {
  readonly #sinks: readonly AuditReplicationSink[];
  readonly #onFailure?: (error: AuditReplicationFailure) => void;

  constructor(options: {
    readonly sinks: readonly AuditReplicationSink[];
    readonly onFailure?: (error: AuditReplicationFailure) => void;
  }) {
    this.#sinks = options.sinks;
    if (options.onFailure !== undefined) this.#onFailure = options.onFailure;
  }

  async replicate(
    record: ChainedAuditEvent,
  ): Promise<readonly AuditReplicationFanoutResult[]> {
    const results: AuditReplicationFanoutResult[] = [];
    for (const sink of this.#sinks) {
      try {
        const result = await sink.replicate(record);
        results.push({ sink: sink.id, ok: true, result });
      } catch (error) {
        const failure: AuditReplicationFailure = {
          sink: sink.id,
          eventId: record.event.id,
          sequence: record.sequence,
          error: error instanceof Error ? error : new Error(String(error)),
        };
        this.#onFailure?.(failure);
        results.push({ sink: sink.id, ok: false, error: failure.error });
      }
    }
    return results;
  }
}

export interface AuditReplicationFanoutResult {
  readonly sink: string;
  readonly ok: boolean;
  readonly result?: AuditReplicationResult;
  readonly error?: Error;
}

export interface AuditReplicationFailure {
  readonly sink: string;
  readonly eventId: string;
  readonly sequence: number;
  readonly error: Error;
}
