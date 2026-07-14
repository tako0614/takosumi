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
 *     it requires append-only / WORM semantics from an injected adapter and
 *     exposes `readChain` so service boot can verify
 *     the SQL chain has not been silently mutated against the immutable
 *     replica. Production / staging boots refuse to start without one.
 */

import type { ChainedAuditEvent } from "../observability/audit_chain.ts";
import { verifyAuditHashChain } from "../observability/audit_chain.ts";

export interface AuditExternalReplicationSink {
  /** Human-readable adapter label for diagnostics. */
  readonly kind: string;
  /** Whether the adapter provides the immutable guarantee required in prod. */
  readonly assurance: "development" | "immutable";
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
 * Compose multiple sinks into one. Useful for emitting to both stdout
 * (operator visibility) and an immutable archive simultaneously.
 */
export class CompositeExternalReplicationSink
  implements AuditExternalReplicationSink {
  readonly kind = "composite";
  readonly assurance: AuditExternalReplicationSink["assurance"];
  readonly #sinks: readonly AuditExternalReplicationSink[];

  constructor(sinks: readonly AuditExternalReplicationSink[]) {
    if (sinks.length === 0) {
      throw new Error("composite sink requires >= 1 sink");
    }
    this.#sinks = sinks;
    // readChain delegates to the first/canonical sink, so its guarantee is the
    // guarantee the composite can truthfully expose.
    this.assurance = sinks[0]!.assurance;
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
