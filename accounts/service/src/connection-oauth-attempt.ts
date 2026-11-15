import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import { stableJsonDigest } from "../../../core/adapters/source/digest.ts";

/** Credential setup transactions are never authorization codes or login grants. */
export const connectionOAuthAttemptPurpose = "connection-credential-oauth@v1";
export const connectionOAuthAttemptBucket = "connection_oauth_attempts_v1";

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
