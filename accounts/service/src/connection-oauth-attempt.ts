import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import { stableJsonDigest } from "../../../core/adapters/source/digest.ts";

/** Credential setup transactions are never authorization codes or login grants. */
export const connectionOAuthAttemptPurpose = "connection-credential-oauth@v1";
export const connectionOAuthAttemptBucket = "connection_oauth_attempts_v1";
/** Independent of refresh/passkey phases; older runtimes simply pause this GC. */
export const connectionOAuthAttemptSweepKey = "connection-oauth-attempt-retention-v1";
export const MAX_CONNECTION_OAUTH_ATTEMPT_SWEEP_ROWS = 64;

export interface ConnectionOAuthAttemptSweepInput {
  readonly now: number;
  readonly maxRows?: number;
}

export interface ConnectionOAuthAttemptSweepResult {
  readonly scanned: number;
  readonly deleted: number;
}

export function connectionOAuthAttemptSweepLimit(input: ConnectionOAuthAttemptSweepInput): number {
  const limit = input.maxRows ?? MAX_CONNECTION_OAUTH_ATTEMPT_SWEEP_ROWS;
  if (!Number.isSafeInteger(input.now) || input.now < 0 || !Number.isInteger(limit) || limit < 1 || limit > MAX_CONNECTION_OAUTH_ATTEMPT_SWEEP_ROWS) {
    throw new TypeError("invalid Connection OAuth attempt sweep");
  }
  return limit;
}

export function connectionOAuthAttemptSweepCheckpoint(value: unknown): { generation: number; after: string } {
  if (value === undefined) return { generation: 0, after: "" };
  const r = value as { generation?: number; after?: string } | null;
  if (!r || !Number.isSafeInteger(r.generation) || r.generation! < 1 || r.generation! >= Number.MAX_SAFE_INTEGER || typeof r.after !== "string") {
    throw new TypeError("invalid Connection OAuth attempt sweep checkpoint");
  }
  return { generation: r.generation!, after: r.after };
}

export interface ConnectionOAuthAttemptRecord {
  readonly purpose: typeof connectionOAuthAttemptPurpose;
  readonly id: string;
  readonly helperId: string;
  readonly stateDigest: string;
  readonly browserBindingHash: string;
  readonly subject: TakosumiSubject;
  readonly scope: "personal" | "workspace";
  readonly createdAt: number;
  readonly expiresAt: number;
}

export function connectionOAuthAttemptId(helperId: string, stateDigest: string): Promise<string> {
  return stableJsonDigest([connectionOAuthAttemptPurpose, helperId, stateDigest]);
}

export async function validConnectionOAuthAttempt(value: unknown): Promise<boolean> {
  if (!value || typeof value !== "object") return false;
  const r = value as Partial<ConnectionOAuthAttemptRecord>;
  const digest = (v: unknown) => typeof v === "string" && /^sha256:[a-f0-9]{64}$/u.test(v);
  return r.purpose === connectionOAuthAttemptPurpose &&
    typeof r.helperId === "string" && r.helperId.length > 0 && r.helperId.length <= 256 &&
    typeof r.subject === "string" && r.subject.length > 0 &&
    (r.scope === "personal" || r.scope === "workspace") &&
    digest(r.id) && digest(r.stateDigest) && digest(r.browserBindingHash) &&
    Number.isSafeInteger(r.createdAt) && Number.isSafeInteger(r.expiresAt) &&
    r.createdAt! >= 0 && r.expiresAt! > r.createdAt! && r.expiresAt! - r.createdAt! <= 600_000 &&
    r.id === await connectionOAuthAttemptId(r.helperId, r.stateDigest!);
}
