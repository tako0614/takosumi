import { expect, test } from "bun:test";
import { getOrCreateRevisionPlanAttempt, releaseRevisionPlanAttempt } from "../../../../dashboard/src/lib/revision-plan-attempt.ts";

test("retains A after an unknown A outcome and a definite B failure", () => {
  const attempts = new Map();
  const requestA = JSON.stringify({ ref: "release/a" });
  const requestB = JSON.stringify({ ref: "release/b" });

  const firstA = getOrCreateRevisionPlanAttempt(attempts, "capsule_1", requestA);
  // A's POST acknowledgement is unknown; no cleanup is performed.
  const firstB = getOrCreateRevisionPlanAttempt(attempts, "capsule_1", requestB);
  // B's POST is definitely rejected; its failure must not clear A.
  const retryA = getOrCreateRevisionPlanAttempt(attempts, "capsule_1", requestA);

  expect(firstA.idempotencyKey).toBeString();
  expect(firstB.idempotencyKey).toBeString();
  expect(firstA.idempotencyKey).not.toBe(firstB.idempotencyKey);
  expect(retryA).toEqual(firstA);
});

test("separate Capsules do not share retained revision attempts", () => {
  const attempts = new Map();
  const request = JSON.stringify({ ref: "release/a" });

  const capsuleA = getOrCreateRevisionPlanAttempt(
    attempts,
    "capsule_a",
    request,
  );
  const capsuleB = getOrCreateRevisionPlanAttempt(
    attempts,
    "capsule_b",
    request,
  );

  expect(capsuleA.idempotencyKey).not.toBe(capsuleB.idempotencyKey);
});

test("a returned Plan releases its key so the same ref later gets a fresh one", () => {
  const attempts = new Map();
  const request = JSON.stringify({ ref: "main" });
  const first = getOrCreateRevisionPlanAttempt(attempts, "capsule_1", request);
  releaseRevisionPlanAttempt(attempts, "capsule_1", request);
  const next = getOrCreateRevisionPlanAttempt(attempts, "capsule_1", request);
  expect(next.idempotencyKey).not.toBe(first.idempotencyKey);
  // Releasing one Capsule's attempt leaves another's intact.
  const other = getOrCreateRevisionPlanAttempt(attempts, "capsule_2", request);
  releaseRevisionPlanAttempt(attempts, "capsule_1", request);
  expect(getOrCreateRevisionPlanAttempt(attempts, "capsule_2", request)).toEqual(other);
});
