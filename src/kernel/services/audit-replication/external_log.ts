/**
 * AuditExternalReplicationSink (Phase 18.3 M5).
 *
 * Replicates each chained audit event to an EXTERNAL append-only / immutable
 * log so that a malicious DBA who tampers with `audit_events` rows in the
 * primary SQL store cannot also rewrite the canonical audit history.
 *
 * Distinction from {@link AuditReplicationSink} (the existing fan-out hook):
 *
 *   - `AuditReplicationSink` is a record-by-record fan-out for downstream
 *     SIEM / cold-store ingestion (Sumo Logic, Datadog, etc.). It accepts
 *     per-record receipts and is best-effort idempotent.
 *   - `AuditExternalReplicationSink` is the *tamper-proofing* counterpart:
 *     it requires append-only / WORM semantics (S3 Object Lock,
 *     immutable storage) and exposes `readChain` so kernel boot can verify
 *     the SQL chain has not been silently mutated against the immutable
 *     replica. Production / staging boots refuse to start without one.
 */

import type { ChainedAuditEvent } from "../observability/audit_chain.ts";
import {
  AUDIT_CHAIN_GENESIS_HASH,
  verifyAuditHashChain,
} from "../observability/audit_chain.ts";

export interface AuditExternalReplicationSink {
  /** Human-readable label for diagnostics (e.g. "s3", "stdout"). */
  readonly kind: string;
  /**
   * Replicate one chained audit record to the external log. Implementations
   * MUST be idempotent: replaying the same `(sequence, hash)` is a no-op.
   */
  replicate(record: ChainedAuditEvent): Promise<void>;
  /**
   * Read the full external chain back, in `sequence` ascending order. Used
   * during boot-time verification to confirm the SQL chain has not been
   * silently mutated against the immutable replica.
   */
  readChain(): Promise<readonly ChainedAuditEvent[]>;
}

/**
 * Result of comparing the SQL-side audit chain against the external
 * replication log. `ok=false` means tampering or replication divergence
 * was detected and the operator must investigate before trusting the SQL
 * chain.
 */
export interface AuditReplicationVerificationResult {
  readonly ok: boolean;
  readonly externalCount: number;
  readonly primaryCount: number;
  readonly reason?:
    | "external-empty-but-primary-not"
    | "primary-shorter-than-external"
    | "sequence-mismatch"
    | "hash-mismatch"
    | "external-chain-invalid"
    | "primary-chain-invalid";
  readonly mismatchAtSequence?: number;
  readonly expectedHash?: string;
  readonly actualHash?: string;
}

/**
 * Verify that every record present in the external replica matches the
 * corresponding record in the primary (SQL) chain by `(sequence, hash)`.
 *
 * Allows the primary chain to be longer than the external replica (e.g.
 * boot-time replay catching up after a process restart): in that case the
 * extra primary suffix is replicated by the caller. The reverse - external
 * having entries the primary lacks - is treated as tampering: the DBA
 * deleted rows from `audit_events`.
 */
export async function verifyAuditReplicationConsistency(
  primary: readonly ChainedAuditEvent[],
  external: readonly ChainedAuditEvent[],
): Promise<AuditReplicationVerificationResult> {
  const primaryVerification = await verifyAuditHashChain(primary);
  if (!primaryVerification.valid) {
    return {
      ok: false,
      externalCount: external.length,
      primaryCount: primary.length,
      reason: "primary-chain-invalid",
      ...(primaryVerification.invalidAt !== undefined
        ? { mismatchAtSequence: primaryVerification.invalidAt }
        : {}),
      ...(primaryVerification.expectedHash !== undefined
        ? { expectedHash: primaryVerification.expectedHash }
        : {}),
      ...(primaryVerification.actualHash !== undefined
        ? { actualHash: primaryVerification.actualHash }
        : {}),
    };
  }
  const externalVerification = await verifyAuditHashChain(external);
  if (!externalVerification.valid) {
    return {
      ok: false,
      externalCount: external.length,
      primaryCount: primary.length,
      reason: "external-chain-invalid",
      ...(externalVerification.invalidAt !== undefined
        ? { mismatchAtSequence: externalVerification.invalidAt }
        : {}),
      ...(externalVerification.expectedHash !== undefined
        ? { expectedHash: externalVerification.expectedHash }
        : {}),
      ...(externalVerification.actualHash !== undefined
        ? { actualHash: externalVerification.actualHash }
        : {}),
    };
  }
  if (external.length === 0) {
    if (primary.length === 0) {
      return { ok: true, externalCount: 0, primaryCount: 0 };
    }
    return {
      ok: false,
      externalCount: 0,
      primaryCount: primary.length,
      reason: "external-empty-but-primary-not",
    };
  }
  if (primary.length < external.length) {
    return {
      ok: false,
      externalCount: external.length,
      primaryCount: primary.length,
      reason: "primary-shorter-than-external",
    };
  }
  for (let i = 0; i < external.length; i++) {
    const ext = external[i]!;
    const prim = primary[i]!;
    if (ext.sequence !== prim.sequence) {
      return {
        ok: false,
        externalCount: external.length,
        primaryCount: primary.length,
        reason: "sequence-mismatch",
        mismatchAtSequence: ext.sequence,
      };
    }
    if (ext.hash !== prim.hash) {
      return {
        ok: false,
        externalCount: external.length,
        primaryCount: primary.length,
        reason: "hash-mismatch",
        mismatchAtSequence: ext.sequence,
        expectedHash: ext.hash,
        actualHash: prim.hash,
      };
    }
  }
  return {
    ok: true,
    externalCount: external.length,
    primaryCount: primary.length,
  };
}

/**
 * StdoutReplicationSink: append-only test / local sink that writes a JSON
 * line per replicated audit event.
 *
 * NOT for production: a malicious operator with shell access can edit log
 * files. Use {@link S3ImmutableLogReplicationSink} (S3 Object Lock) or an
 * equivalent WORM target in production.
 */
export class StdoutReplicationSink implements AuditExternalReplicationSink {
  readonly kind = "stdout";
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
      [...this.#records].sort((a, b) => a.sequence - b.sequence).map((r) =>
        structuredClone(r)
      ),
    );
  }
}

/**
 * Minimal subset of the AWS S3 PutObject / ListObjectsV2 / GetObject API
 * needed by {@link S3ImmutableLogReplicationSink}. We accept a port here
 * so unit tests can substitute an in-memory fake without pulling the AWS
 * SDK into the kernel build.
 */
export interface S3ImmutableLogPort {
  /**
   * Upload an object with versioning + Object Lock retention. The sink
   * passes a `retainUntilDate` chosen to exceed the audit retention window
   * so a DBA cannot delete the immutable replica even if they obtain the
   * IAM key.
   */
  putObject(input: {
    readonly bucket: string;
    readonly key: string;
    readonly body: string;
    readonly contentType: "application/json";
    readonly objectLockMode: "GOVERNANCE" | "COMPLIANCE";
    readonly objectLockRetainUntilDate: string;
  }): Promise<void>;
  /** List object keys under the given prefix in lexical (== sequence) order. */
  listObjects(input: {
    readonly bucket: string;
    readonly prefix: string;
  }): Promise<readonly string[]>;
  /** Read the object body as text. */
  getObject(input: {
    readonly bucket: string;
    readonly key: string;
  }): Promise<string>;
}

/**
 * S3ImmutableLogReplicationSink: production-grade replication sink backed
 * by an S3 (or S3-compatible) bucket configured with versioning + Object
 * Lock in COMPLIANCE mode.
 *
 * Requirements (operator):
 *
 *   - Bucket has versioning enabled (`Versioning=Enabled`).
 *   - Bucket has Object Lock enabled with default retention.
 *   - The IAM principal uploading objects has `s3:PutObject` and
 *     `s3:PutObjectRetention` but NOT `s3:BypassGovernanceRetention`.
 *   - The retention period exceeds the audit retention window.
 *
 * Each event becomes one object at
 * `<prefix>/<10-digit-zero-padded-sequence>-<hash[:16]>.json`. Lexical key
 * order matches `sequence` order, so `listObjects` returns the chain
 * in-order.
 */
export class S3ImmutableLogReplicationSink
  implements AuditExternalReplicationSink {
  readonly kind = "s3";
  readonly #port: S3ImmutableLogPort;
  readonly #bucket: string;
  readonly #prefix: string;
  readonly #retentionMode: "GOVERNANCE" | "COMPLIANCE";
  readonly #retentionDays: number;
  readonly #clock: () => Date;

  constructor(options: {
    readonly port: S3ImmutableLogPort;
    readonly bucket: string;
    readonly prefix?: string;
    readonly retentionMode?: "GOVERNANCE" | "COMPLIANCE";
    readonly retentionDays?: number;
    readonly clock?: () => Date;
  }) {
    if (!options.bucket) throw new Error("S3 bucket required");
    this.#port = options.port;
    this.#bucket = options.bucket;
    this.#prefix = (options.prefix ?? "audit-replication").replace(/\/+$/, "");
    this.#retentionMode = options.retentionMode ?? "COMPLIANCE";
    this.#retentionDays = options.retentionDays ?? 365 * 7;
    this.#clock = options.clock ?? (() => new Date());
  }

  async replicate(record: ChainedAuditEvent): Promise<void> {
    const key = this.#keyFor(record);
    const body = JSON.stringify({
      sequence: record.sequence,
      previousHash: record.previousHash,
      hash: record.hash,
      event: record.event,
    });
    const retainUntil = new Date(
      this.#clock().getTime() + this.#retentionDays * 86_400_000,
    ).toISOString();
    await this.#port.putObject({
      bucket: this.#bucket,
      key,
      body,
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
    const sorted = [...keys].sort();
    const records: ChainedAuditEvent[] = [];
    for (const key of sorted) {
      const body = await this.#port.getObject({ bucket: this.#bucket, key });
      const parsed = JSON.parse(body) as {
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
    const padded = String(record.sequence).padStart(10, "0");
    const tag = record.hash.slice(0, 16);
    return `${this.#prefix}/${padded}-${tag}.json`;
  }
}

/**
 * Compose multiple sinks into one. Useful for emitting to both stdout
 * (operator visibility) and S3 (immutable archive) simultaneously.
 */
export class CompositeExternalReplicationSink
  implements AuditExternalReplicationSink {
  readonly kind = "composite";
  readonly #sinks: readonly AuditExternalReplicationSink[];

  constructor(sinks: readonly AuditExternalReplicationSink[]) {
    if (sinks.length === 0) {
      throw new Error("composite sink requires >= 1 sink");
    }
    this.#sinks = sinks;
  }

  async replicate(record: ChainedAuditEvent): Promise<void> {
    for (const sink of this.#sinks) {
      await sink.replicate(record);
    }
  }

  /** Reads the chain from the FIRST sink (which should be the canonical one). */
  readChain(): Promise<readonly ChainedAuditEvent[]> {
    return this.#sinks[0]!.readChain();
  }
}

/**
 * Configuration error surfaced when production / staging is started
 * without an external replication sink. Mirrors the
 * `SecretEncryptionConfigurationError` ergonomics.
 */
export class AuditReplicationConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditReplicationConfigurationError";
  }
}

const PRODUCTION_LIKE_ENVIRONMENTS = new Set([
  "production",
  "prod",
  "staging",
  "stage",
]);

export interface SelectAuditExternalReplicationSinkOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * Optional override S3 port (e.g. injected fake during tests). When
   * omitted and `TAKOSUMI_AUDIT_REPLICATION_KIND=s3`, the function throws
   * because the kernel build does not bundle the AWS SDK.
   */
  readonly s3Port?: S3ImmutableLogPort;
  /** Optional clock override; defaults to system time. */
  readonly clock?: () => Date;
}

/**
 * Select an {@link AuditExternalReplicationSink} based on env vars.
 *
 *   - `TAKOSUMI_AUDIT_REPLICATION_KIND=stdout` -> {@link StdoutReplicationSink}
 *   - `TAKOSUMI_AUDIT_REPLICATION_KIND=s3`     -> {@link S3ImmutableLogReplicationSink}
 *     (requires `TAKOSUMI_AUDIT_REPLICATION_S3_BUCKET` plus optional
 *      `TAKOSUMI_AUDIT_REPLICATION_S3_PREFIX`,
 *      `TAKOSUMI_AUDIT_REPLICATION_S3_RETENTION_MODE`,
 *      `TAKOSUMI_AUDIT_REPLICATION_S3_RETENTION_DAYS`).
 *
 * Production / staging without any configuration throws
 * {@link AuditReplicationConfigurationError}. Local / dev returns
 * `undefined` (replication disabled) unless explicitly configured.
 */
export function selectAuditExternalReplicationSink(
  options: SelectAuditExternalReplicationSinkOptions,
): AuditExternalReplicationSink | undefined {
  const env = options.env;
  const environment = normalizeEnvironment(
    env.TAKOSUMI_ENVIRONMENT ?? env.NODE_ENV ?? env.ENVIRONMENT,
  );
  const productionLike = PRODUCTION_LIKE_ENVIRONMENTS.has(environment);
  const kind = (env.TAKOSUMI_AUDIT_REPLICATION_KIND ?? "").trim().toLowerCase();

  if (!kind) {
    if (productionLike) {
      throw new AuditReplicationConfigurationError(
        `audit-replication sink missing in ${environment}: ` +
          `set TAKOSUMI_AUDIT_REPLICATION_KIND=s3 (with TAKOSUMI_AUDIT_REPLICATION_S3_BUCKET) ` +
          `or TAKOSUMI_AUDIT_REPLICATION_KIND=stdout. ` +
          `Refusing to start without an external immutable log; ` +
          `tamper-evident audit history requires off-DB replication.`,
      );
    }
    return undefined;
  }

  if (kind === "stdout") return new StdoutReplicationSink();
  if (kind === "s3") {
    const bucket = env.TAKOSUMI_AUDIT_REPLICATION_S3_BUCKET;
    if (!bucket) {
      throw new AuditReplicationConfigurationError(
        "TAKOSUMI_AUDIT_REPLICATION_KIND=s3 requires TAKOSUMI_AUDIT_REPLICATION_S3_BUCKET",
      );
    }
    if (!options.s3Port) {
      throw new AuditReplicationConfigurationError(
        "TAKOSUMI_AUDIT_REPLICATION_KIND=s3 requires an S3 port to be wired " +
          "into selectAuditExternalReplicationSink (the kernel does not " +
          "bundle the AWS SDK)",
      );
    }
    const retentionMode =
      (env.TAKOSUMI_AUDIT_REPLICATION_S3_RETENTION_MODE ?? "COMPLIANCE")
          .trim()
          .toUpperCase() === "GOVERNANCE"
        ? "GOVERNANCE"
        : "COMPLIANCE";
    const retentionDaysRaw = env.TAKOSUMI_AUDIT_REPLICATION_S3_RETENTION_DAYS;
    const retentionDays = retentionDaysRaw
      ? Number(retentionDaysRaw)
      : undefined;
    return new S3ImmutableLogReplicationSink({
      port: options.s3Port,
      bucket,
      ...(env.TAKOSUMI_AUDIT_REPLICATION_S3_PREFIX
        ? { prefix: env.TAKOSUMI_AUDIT_REPLICATION_S3_PREFIX }
        : {}),
      retentionMode,
      ...(retentionDays && Number.isFinite(retentionDays) && retentionDays > 0
        ? { retentionDays }
        : {}),
      ...(options.clock ? { clock: options.clock } : {}),
    });
  }
  throw new AuditReplicationConfigurationError(
    `unsupported TAKOSUMI_AUDIT_REPLICATION_KIND=${kind}; ` +
      `supported: stdout, s3`,
  );
}

function normalizeEnvironment(raw: string | undefined): string {
  return (raw ?? "local").trim().toLowerCase() || "local";
}
