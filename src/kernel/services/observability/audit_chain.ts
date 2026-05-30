import type { AuditEvent } from "../../domains/audit/types.ts";
import { redactJsonObject } from "./redaction.ts";

export const AUDIT_CHAIN_GENESIS_HASH = "0".repeat(64);

export interface ChainedAuditEvent {
  readonly sequence: number;
  readonly event: AuditEvent;
  readonly previousHash: string;
  readonly hash: string;
}

export interface AuditChainVerificationResult {
  readonly valid: boolean;
  readonly invalidAt?: number;
  readonly reason?: "previous-hash-mismatch" | "event-hash-mismatch";
  readonly expectedHash?: string;
  readonly actualHash?: string;
}

export function redactAuditEvent(event: AuditEvent): AuditEvent {
  return {
    ...event,
    actor: event.actor
      ? {
        ...event.actor,
        ...(event.actor.sessionId ? { sessionId: "[REDACTED]" } : {}),
      }
      : undefined,
    payload: redactJsonObject(event.payload),
  };
}

export async function chainAuditEvent(
  event: AuditEvent,
  previous: ChainedAuditEvent | undefined,
): Promise<ChainedAuditEvent> {
  const redactedEvent = redactAuditEvent(event);
  const previousHash = previous?.hash ?? AUDIT_CHAIN_GENESIS_HASH;
  const sequence = previous ? previous.sequence + 1 : 1;
  return {
    sequence,
    event: redactedEvent,
    previousHash,
    hash: await hashAuditRecord({
      sequence,
      event: redactedEvent,
      previousHash,
    }),
  };
}

export async function verifyAuditHashChain(
  records: readonly ChainedAuditEvent[],
): Promise<AuditChainVerificationResult> {
  let previousHash = AUDIT_CHAIN_GENESIS_HASH;
  for (const record of records) {
    if (record.previousHash !== previousHash) {
      return {
        valid: false,
        invalidAt: record.sequence,
        reason: "previous-hash-mismatch",
        expectedHash: previousHash,
        actualHash: record.previousHash,
      };
    }
    const expectedHash = await hashAuditRecord({
      sequence: record.sequence,
      event: record.event,
      previousHash: record.previousHash,
    });
    if (record.hash !== expectedHash) {
      return {
        valid: false,
        invalidAt: record.sequence,
        reason: "event-hash-mismatch",
        expectedHash,
        actualHash: record.hash,
      };
    }
    previousHash = record.hash;
  }
  return { valid: true };
}

async function hashAuditRecord(input: {
  readonly sequence: number;
  readonly event: AuditEvent;
  readonly previousHash: string;
}): Promise<string> {
  const canonical = canonicalJson(input);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${
    entries.map(([key, child]) =>
      `${JSON.stringify(key)}:${canonicalJson(child)}`
    ).join(",")
  }}`;
}
