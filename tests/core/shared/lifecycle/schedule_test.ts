import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  PollSchedule,
  RetrySchedule,
} from "../../../../core/shared/lifecycle/mod.ts";

test("retry schedule caps growth and exhausts the attempt budget", () => {
  const schedule = new RetrySchedule(
    {
      minDelayMs: 1_000,
      maxDelayMs: 8_000,
      maxAttempts: 4,
      jitter: "equal",
    },
    { random: () => 1 },
  );

  const delays: number[] = [];
  for (let attempts = 0; attempts < 3; attempts += 1) {
    const decision = schedule.next({ attempts, now: 0, reason: "boom" });
    assert.equal(decision.kind, "retry");
    if (decision.kind !== "retry") return;
    assert.equal(decision.attempt, attempts + 1);
    assert.equal(decision.at, decision.delayMs);
    delays.push(decision.delayMs);
  }
  assert.deepEqual(delays, [1_000, 2_000, 4_000]);

  const exhausted = schedule.next({ attempts: 3, now: 0, reason: "boom" });
  assert.equal(exhausted.kind, "exhausted");
  if (exhausted.kind !== "exhausted") return;
  assert.equal(exhausted.attempt, 4);
  assert.equal(exhausted.maxAttempts, 4);
});

test("retry schedule never returns a delay below the floor", () => {
  const schedule = new RetrySchedule(
    {
      minDelayMs: 5_000,
      maxDelayMs: 60_000,
      maxAttempts: 10,
      jitter: "full",
    },
    { random: () => 0 },
  );
  const decision = schedule.next({ attempts: 5, now: 100, reason: "boom" });
  assert.equal(decision.kind, "retry");
  if (decision.kind !== "retry") return;
  assert.equal(decision.delayMs, 5_000);
  assert.equal(decision.at, 5_100);
});

test("retry schedule rejects an unbounded or unjittered spec", () => {
  assert.throws(
    () =>
      new RetrySchedule({
        minDelayMs: 0,
        maxDelayMs: 1_000,
        maxAttempts: 3,
        jitter: "full",
      }),
    /minDelayMs/,
  );
  assert.throws(
    () =>
      new RetrySchedule({
        minDelayMs: 10_000,
        maxDelayMs: 1_000,
        maxAttempts: 3,
        jitter: "full",
      }),
    /maxDelayMs/,
  );
  assert.throws(
    () =>
      new RetrySchedule({
        minDelayMs: 1_000,
        maxDelayMs: 1_000,
        maxAttempts: 0,
        jitter: "full",
      }),
    /maxAttempts/,
  );
});

test("poll schedule backs off and ends at the wall-clock deadline", () => {
  const schedule = new PollSchedule(
    {
      minDelayMs: 1_000,
      maxDelayMs: 4_000,
      deadlineMs: 60_000,
      jitter: "full",
    },
    { random: () => 1 },
  );

  const first = schedule.next({
    polls: 0,
    elapsedMs: 0,
    now: 0,
    reason: "still queued",
  });
  assert.equal(first.kind, "poll");
  if (first.kind !== "poll") return;
  assert.equal(first.poll, 1);
  assert.equal(first.delayMs, 1_000);

  const capped = schedule.next({
    polls: 9,
    elapsedMs: 30_000,
    now: 0,
    reason: "still queued",
  });
  assert.equal(capped.kind, "poll");
  if (capped.kind !== "poll") return;
  assert.equal(capped.delayMs, 4_000);

  const expired = schedule.next({
    polls: 20,
    elapsedMs: 60_000,
    now: 0,
    reason: "still queued",
  });
  assert.equal(expired.kind, "deadline-exceeded");
  if (expired.kind !== "deadline-exceeded") return;
  assert.equal(expired.deadlineMs, 60_000);
  assert.equal(expired.elapsedMs, 60_000);
});

test("poll schedule rejects a deadline that allows no poll", () => {
  assert.throws(
    () =>
      new PollSchedule({
        minDelayMs: 1_000,
        maxDelayMs: 10_000,
        deadlineMs: 500,
        jitter: "equal",
      }),
    /deadlineMs/,
  );
});
