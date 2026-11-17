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
  /** Observed from this attempt's successful create acknowledgement only. */
  readonly revisionPlanId?: string;
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

/** Bind a create acknowledgement only to the still-retained exact attempt. */
export function observeRevisionPlanAttempt(
  attempts: RevisionPlanAttemptStore,
  capsuleId: string,
  requestJson: string,
  attempt: RevisionPlanAttempt,
  plan: {
    readonly id: string;
    readonly capsuleId: string;
    readonly revision: { readonly targetRef: string };
  },
): void {
  const key = attemptKey(capsuleId, requestJson);
  if (attempts.get(key) !== attempt || plan.capsuleId !== capsuleId ||
    typeof plan.id !== "string" || !plan.id.trim() ||
    typeof plan.revision?.targetRef !== "string" ||
    JSON.stringify({ ref: plan.revision.targetRef }) !== requestJson) return;
  attempts.set(key, { ...attempt, revisionPlanId: plan.id });
}

/** A continued Plan releases only the attempt whose create ACK named it. */
export function releaseObservedRevisionPlanAttempt(
  attempts: RevisionPlanAttemptStore,
  capsuleId: string,
  requestJson: string,
  revisionPlanId: string,
): void {
  const key = attemptKey(capsuleId, requestJson);
  if (revisionPlanId && attempts.get(key)?.revisionPlanId === revisionPlanId) {
    attempts.delete(key);
  }
}

/** Releases the attempt whose Plan id was returned; the next request mints a new key. */
export function releaseRevisionPlanAttempt(
  attempts: RevisionPlanAttemptStore,
  capsuleId: string,
  requestJson: string,
  expectedIdempotencyKey?: string,
): void {
  const key = attemptKey(capsuleId, requestJson);
  if (expectedIdempotencyKey !== undefined &&
    attempts.get(key)?.idempotencyKey !== expectedIdempotencyKey) return;
  attempts.delete(key);
}
