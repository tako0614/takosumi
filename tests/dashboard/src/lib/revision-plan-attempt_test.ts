import { expect, test } from "bun:test";
import { getOrCreateRevisionPlanAttempt, observeRevisionPlanAttempt, releaseObservedRevisionPlanAttempt, releaseRevisionPlanAttempt } from "../../../../dashboard/src/lib/revision-plan-attempt.ts";

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

test("observed coordinator completion releases only its exact retained request", () => {
  const attempts = new Map();
  const request = JSON.stringify({ ref: "release/a" });
  const first = getOrCreateRevisionPlanAttempt(attempts, "capsule_a", request);
  const other = getOrCreateRevisionPlanAttempt(attempts, "capsule_b", request);
  const plan = { id: "revision_a", capsuleId: "capsule_a", revision: { targetRef: "release/a" } };
  // A matching ref after a lost first POST ACK is not proof of this key's ID.
  releaseObservedRevisionPlanAttempt(attempts, "capsule_a", request, plan.id);
  expect(getOrCreateRevisionPlanAttempt(attempts, "capsule_a", request)).toBe(first);
  for (const mismatch of [
    { ...plan, capsuleId: "capsule_b" },
    { ...plan, revision: { targetRef: "release/b" } },
    { ...plan, revision: undefined as never },
    { ...plan, id: "" },
  ]) {
    observeRevisionPlanAttempt(attempts, "capsule_a", request, first, mismatch);
    expect(getOrCreateRevisionPlanAttempt(attempts, "capsule_a", request)).toBe(first);
  }
  observeRevisionPlanAttempt(attempts, "capsule_a", request, first, plan);
  const observed = getOrCreateRevisionPlanAttempt(attempts, "capsule_a", request);
  expect(observed).toEqual({ ...first, revisionPlanId: plan.id });
  releaseObservedRevisionPlanAttempt(attempts, "capsule_b", request, plan.id);
  releaseObservedRevisionPlanAttempt(attempts, "capsule_a", JSON.stringify({ ref: "release/b" }), plan.id);
  releaseObservedRevisionPlanAttempt(attempts, "capsule_a", request, "revision_other");
  expect(getOrCreateRevisionPlanAttempt(attempts, "capsule_a", request)).toBe(observed);
  expect(getOrCreateRevisionPlanAttempt(attempts, "capsule_b", request)).toBe(other);
  releaseObservedRevisionPlanAttempt(attempts, "capsule_a", request, plan.id);
  expect(getOrCreateRevisionPlanAttempt(attempts, "capsule_a", request).idempotencyKey).not.toBe(first.idempotencyKey);
});

test("late responses cannot claim or release a replacement intent", () => {
  const attempts = new Map();
  const request = JSON.stringify({ ref: "release/a" });
  const first = getOrCreateRevisionPlanAttempt(attempts, "capsule_a", request);
  releaseRevisionPlanAttempt(attempts, "capsule_a", request, first.idempotencyKey);
  const next = getOrCreateRevisionPlanAttempt(attempts, "capsule_a", request);
  const oldPlan = { id: "revision_old", capsuleId: "capsule_a", revision: { targetRef: "release/a" } };
  observeRevisionPlanAttempt(attempts, "capsule_a", request, first, oldPlan);
  releaseObservedRevisionPlanAttempt(attempts, "capsule_a", request, oldPlan.id);
  releaseRevisionPlanAttempt(attempts, "capsule_a", request, first.idempotencyKey);
  expect(getOrCreateRevisionPlanAttempt(attempts, "capsule_a", request)).toBe(next);
  observeRevisionPlanAttempt(attempts, "capsule_a", request, next, { ...oldPlan, id: "revision_new" });
  releaseObservedRevisionPlanAttempt(attempts, "capsule_a", request, oldPlan.id);
  expect(getOrCreateRevisionPlanAttempt(attempts, "capsule_a", request)).toEqual({ ...next, revisionPlanId: "revision_new" });
});
