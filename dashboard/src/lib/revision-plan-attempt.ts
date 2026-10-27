/**
 * Retains one idempotency key per Capsule/request pair for revision-plan
 * retries. A POST or later reconcile response can be lost after the durable
 * coordinator committed, so failed attempts must remain replayable even when
 * the failure is a definite HTTP response. Once a Plan id comes back the
 * attempt is finished and its key is released: the server replays the
 * original record for a reused key, so the next request for the same ref
 * (after Cancel, a failed apply, or a later update) must mint a new one.
 */
import { randomUuid } from "./random-uuid.ts";

export interface RevisionPlanAttempt {
  readonly requestJson: string;
  readonly idempotencyKey: string;
}

export type RevisionPlanAttemptStore = Map<string, RevisionPlanAttempt>;

function attemptKey(capsuleId: string, requestJson: string): string {
  return `${capsuleId}\u0000${requestJson}`;
}

/** Returns the retained attempt or mints one for this exact request. */
export function getOrCreateRevisionPlanAttempt(
  attempts: RevisionPlanAttemptStore,
  capsuleId: string,
  requestJson: string,
): RevisionPlanAttempt {
  const key = attemptKey(capsuleId, requestJson);
  const retained = attempts.get(key);
  if (retained) return retained;
  const created = {
    requestJson,
    idempotencyKey: randomUuid(),
  };
  attempts.set(key, created);
  return created;
}

/** Releases the attempt whose Plan id was returned; the next request mints a new key. */
export function releaseRevisionPlanAttempt(
  attempts: RevisionPlanAttemptStore,
  capsuleId: string,
  requestJson: string,
): void {
  attempts.delete(attemptKey(capsuleId, requestJson));
}
