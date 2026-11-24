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
export type RevisionPlanAttemptScope = readonly [
  subject: string,
  accountId: string,
  workspaceId: string,
  sourceId: string,
  stateVersionId: string,
  stateGeneration: number,
  installConfigId: string,
];

function attemptKey(capsuleId: string, requestJson: string, scope?: RevisionPlanAttemptScope): string {
  return scope
    ? `takosumi.revision-attempt:${JSON.stringify([...scope, capsuleId, requestJson])}`
    : `${capsuleId}\u0000${requestJson}`;
}

function storedAttempt(key: string, requestJson: string): RevisionPlanAttempt | undefined {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return;
    const { idempotencyKey, revisionPlanId } = JSON.parse(raw);
    if (typeof idempotencyKey !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(idempotencyKey)) return;
    return {
      requestJson, idempotencyKey,
      ...(typeof revisionPlanId === "string" && revisionPlanId.trim() ? { revisionPlanId } : {}),
    };
  } catch {
    // Missing, blocked or malformed tab storage falls back to the live attempt.
  }
}

function retainAttempt(
  attempts: RevisionPlanAttemptStore,
  key: string,
  attempt: RevisionPlanAttempt,
  scope?: RevisionPlanAttemptScope,
): void {
  attempts.set(key, attempt);
  if (!scope) return;
  try {
    const { idempotencyKey, revisionPlanId } = attempt;
    window.sessionStorage.setItem(key, JSON.stringify({ idempotencyKey, revisionPlanId }));
  } catch {
    // Keep the attempt in memory when tab storage is unavailable.
  }
}

/** Returns the retained attempt or mints one for this exact request. */
export function getOrCreateRevisionPlanAttempt(
  attempts: RevisionPlanAttemptStore,
  capsuleId: string,
  requestJson: string,
  scope?: RevisionPlanAttemptScope,
): RevisionPlanAttempt {
  const key = attemptKey(capsuleId, requestJson, scope);
  const attempt = attempts.get(key) ?? (scope && storedAttempt(key, requestJson)) ?? {
    requestJson,
    idempotencyKey: randomUuid(),
  };
  retainAttempt(attempts, key, attempt, scope);
  return attempt;
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
  scope?: RevisionPlanAttemptScope,
): void {
  const key = attemptKey(capsuleId, requestJson, scope);
  if (attempts.get(key) !== attempt || plan.capsuleId !== capsuleId ||
    typeof plan.id !== "string" || !plan.id.trim() ||
    typeof plan.revision?.targetRef !== "string" ||
    JSON.stringify({ ref: plan.revision.targetRef }) !== requestJson) return;
  retainAttempt(attempts, key, { ...attempt, revisionPlanId: plan.id }, scope);
}

/** A continued Plan releases only the attempt whose create ACK named it. */
export function releaseObservedRevisionPlanAttempt(
  attempts: RevisionPlanAttemptStore,
  capsuleId: string,
  requestJson: string,
  revisionPlanId: string,
  scope?: RevisionPlanAttemptScope,
): void {
  const key = attemptKey(capsuleId, requestJson, scope);
  const attempt = attempts.get(key) ?? (scope && storedAttempt(key, requestJson));
  if (revisionPlanId && attempt?.revisionPlanId === revisionPlanId) {
    releaseRevisionPlanAttempt(attempts, capsuleId, requestJson, attempt.idempotencyKey, scope);
  }
}

/** Releases the attempt whose Plan id was returned; the next request mints a new key. */
export function releaseRevisionPlanAttempt(
  attempts: RevisionPlanAttemptStore,
  capsuleId: string,
  requestJson: string,
  expectedIdempotencyKey?: string,
  scope?: RevisionPlanAttemptScope,
): void {
  const key = attemptKey(capsuleId, requestJson, scope);
  const stored = scope && storedAttempt(key, requestJson);
  const attempt = attempts.get(key) ?? stored;
  if (expectedIdempotencyKey !== undefined && attempt?.idempotencyKey !== expectedIdempotencyKey) return;
  attempts.delete(key);
  if (!stored || stored.idempotencyKey !== attempt?.idempotencyKey) return;
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Tab storage can be revoked after the attempt was read.
  }
}
