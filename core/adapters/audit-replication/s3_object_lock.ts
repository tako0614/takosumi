import type { AuditExternalReplicationSink } from "../../domains/audit-replication/external_log.ts";
import {
  AUDIT_CHAIN_GENESIS_HASH,
  type ChainedAuditEvent,
} from "../../domains/observability/audit_chain.ts";

/** Minimal S3-compatible Object Lock seam owned by this adapter. */
export interface S3ObjectLockAuditPort {
  putObject(input: {
    readonly bucket: string;
    readonly key: string;
    readonly body: string;
    readonly contentType: "application/json";
    readonly objectLockMode: "GOVERNANCE" | "COMPLIANCE";
    readonly objectLockRetainUntilDate: string;
  }): Promise<void>;
  listObjects(input: {
    readonly bucket: string;
    readonly prefix: string;
  }): Promise<readonly string[]>;
  getObject(input: {
    readonly bucket: string;
    readonly key: string;
  }): Promise<string>;
}

/**
 * Optional S3-compatible WORM adapter. The audit domain only sees the generic
 * immutable-sink contract; bucket names, Object Lock and object keys stay here.
 */
export class S3ObjectLockAuditReplicationSink
  implements AuditExternalReplicationSink {
  readonly kind = "s3-object-lock";
  readonly assurance = "immutable" as const;
  readonly #port: S3ObjectLockAuditPort;
  readonly #bucket: string;
  readonly #prefix: string;
  readonly #retentionMode: "GOVERNANCE" | "COMPLIANCE";
  readonly #retentionDays: number;
  readonly #clock: () => Date;

  constructor(options: {
    readonly port: S3ObjectLockAuditPort;
    readonly bucket: string;
    readonly prefix?: string;
    readonly retentionMode?: "GOVERNANCE" | "COMPLIANCE";
    readonly retentionDays?: number;
    readonly clock?: () => Date;
  }) {
    if (!options.bucket.trim()) throw new Error("S3 bucket required");
    this.#port = options.port;
    this.#bucket = options.bucket;
    this.#prefix = (options.prefix ?? "audit-replication").replace(/\/+$/, "");
    this.#retentionMode = options.retentionMode ?? "COMPLIANCE";
    this.#retentionDays = options.retentionDays ?? 365 * 7;
    this.#clock = options.clock ?? (() => new Date());
  }

  async replicate(record: ChainedAuditEvent): Promise<void> {
    const retainUntil = new Date(
      this.#clock().getTime() + this.#retentionDays * 86_400_000,
    ).toISOString();
    await this.#port.putObject({
      bucket: this.#bucket,
      key: this.#keyFor(record),
      body: JSON.stringify({
        sequence: record.sequence,
        previousHash: record.previousHash,
        hash: record.hash,
        event: record.event,
      }),
      contentType: "application/json",
      objectLockMode: this.#retentionMode,
      objectLockRetainUntilDate: retainUntil,
    });
  }

  async readChain(): Promise<readonly ChainedAuditEvent[]> {
    const keys = await this.#port.listObjects({
      bucket: this.#bucket,
      prefix: `${this.#prefix}/`,
    });
    const records: ChainedAuditEvent[] = [];
    for (const key of [...keys].sort()) {
      const parsed = JSON.parse(
        await this.#port.getObject({ bucket: this.#bucket, key }),
      ) as {
        sequence: number;
        previousHash?: string;
        hash: string;
        event: ChainedAuditEvent["event"];
      };
      records.push({
        sequence: parsed.sequence,
        previousHash: parsed.previousHash ?? AUDIT_CHAIN_GENESIS_HASH,
        hash: parsed.hash,
        event: parsed.event,
      });
    }
    return records;
  }

  #keyFor(record: ChainedAuditEvent): string {
    const sequence = String(record.sequence).padStart(10, "0");
    return `${this.#prefix}/${sequence}-${record.hash.slice(0, 16)}.json`;
  }
}
