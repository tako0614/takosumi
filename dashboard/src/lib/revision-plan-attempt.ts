/**
 * Retains one idempotency key per Capsule/request pair for revision-plan
 * retries. A POST or later reconcile response can be lost after the durable
 * coordinator committed, so failed attempts must remain replayable even when
 * the failure is a definite HTTP response.
 */
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
    idempotencyKey: crypto.randomUUID(),
  };
  attempts.set(key, created);
  return created;
}
