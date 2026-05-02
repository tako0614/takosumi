/**
 * Unit tests for the shared GCP provider runtime helpers
 * (`src/providers/gcp/_runtime.ts`).
 *
 * The runtime module is the foundation for all 6 GCP provider materializers,
 * so these tests guard the contract every provider relies on.
 */

import assert from "node:assert/strict";
import {
  buildRuntimeDetails,
  classifyGcpError,
  computeDrift,
  computeIdempotencyKey,
  defaultGcpRuntimePolicy,
  executionFromCondition,
  type GcpProviderCondition,
  resolveRuntimeContext,
  withRetry,
} from "../src/providers/gcp/mod.ts";

const fixedDate = "2026-04-30T00:00:00.000Z";

Deno.test("classifyGcpError: NOT_FOUND status maps to non-retriable not-found", () => {
  const err = Object.assign(new Error("missing"), { status: "NOT_FOUND" });
  const condition = classifyGcpError(err);
  assert.equal(condition.status, "not-found");
  assert.equal(condition.retriable, false);
  assert.equal(condition.code, "NOT_FOUND");
});

Deno.test("classifyGcpError: PERMISSION_DENIED is non-retriable", () => {
  const err = Object.assign(new Error("forbidden"), {
    status: "PERMISSION_DENIED",
  });
  const condition = classifyGcpError(err);
  assert.equal(condition.status, "permission-denied");
  assert.equal(condition.retriable, false);
});

Deno.test("classifyGcpError: RESOURCE_EXHAUSTED is retriable rate-limited", () => {
  const err = Object.assign(new Error("quota"), {
    status: "RESOURCE_EXHAUSTED",
  });
  const condition = classifyGcpError(err);
  assert.equal(condition.status, "rate-limited");
  assert.equal(condition.retriable, true);
});

Deno.test("classifyGcpError: DEADLINE_EXCEEDED is retriable deadline-exceeded", () => {
  const err = Object.assign(new Error("deadline"), {
    status: "DEADLINE_EXCEEDED",
  });
  const condition = classifyGcpError(err);
  assert.equal(condition.status, "deadline-exceeded");
  assert.equal(condition.retriable, true);
});

Deno.test("classifyGcpError: HTTP 429 falls back to rate-limited", () => {
  const err = Object.assign(new Error("rate"), { httpStatus: 429 });
  const condition = classifyGcpError(err);
  assert.equal(condition.status, "rate-limited");
  assert.equal(condition.retriable, true);
  assert.equal(condition.httpStatus, 429);
});

Deno.test("classifyGcpError: HTTP 503 maps to retriable unavailable", () => {
  const err = Object.assign(new Error("svc unavailable"), { httpStatus: 503 });
  const condition = classifyGcpError(err);
  assert.equal(condition.status, "unavailable");
  assert.equal(condition.retriable, true);
});

Deno.test("classifyGcpError: HTTP 404 is non-retriable not-found", () => {
  const err = Object.assign(new Error("missing"), { httpStatus: 404 });
  const condition = classifyGcpError(err);
  assert.equal(condition.status, "not-found");
  assert.equal(condition.retriable, false);
});

Deno.test("classifyGcpError: plain string fallback uses message heuristics", () => {
  const condition = classifyGcpError("rate limit hit");
  assert.equal(condition.status, "rate-limited");
  assert.equal(condition.retriable, true);
});

Deno.test("classifyGcpError: returns unknown for unrecognised input", () => {
  const condition = classifyGcpError(undefined);
  assert.equal(condition.status, "unknown");
  assert.equal(condition.retriable, false);
});

Deno.test("withRetry: succeeds without retry on first call", async () => {
  const ctx = resolveRuntimeContext({ clock: () => new Date(fixedDate) });
  let calls = 0;
  const outcome = await withRetry(ctx, () => {
    calls += 1;
    return Promise.resolve("ok");
  });
  assert.equal(outcome.result, "ok");
  assert.equal(outcome.condition.status, "ok");
  assert.equal(outcome.attempts.length, 0);
  assert.equal(calls, 1);
});

Deno.test("withRetry: retries on rate-limit and eventually succeeds", async () => {
  let now = 0;
  const ctx = resolveRuntimeContext({
    clock: () => new Date(now),
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
    random: () => 0,
    policy: {
      ...defaultGcpRuntimePolicy,
      timeoutMs: 60_000,
      initialBackoffMs: 1,
      maxBackoffMs: 4,
      maxRetries: 3,
      jitterMs: 0,
    },
  });
  let calls = 0;
  const outcome = await withRetry(ctx, () => {
    calls += 1;
    if (calls < 3) {
      return Promise.reject(
        Object.assign(new Error("rate"), { status: "RESOURCE_EXHAUSTED" }),
      );
    }
    return Promise.resolve(42);
  });
  assert.equal(outcome.result, 42);
  assert.equal(outcome.attempts.length, 2);
  assert.equal(calls, 3);
});

Deno.test("withRetry: gives up immediately on non-retriable", async () => {
  const ctx = resolveRuntimeContext({
    clock: () => new Date(fixedDate),
    sleep: () => Promise.resolve(),
    policy: {
      ...defaultGcpRuntimePolicy,
      timeoutMs: 60_000,
      initialBackoffMs: 1,
      maxRetries: 3,
      jitterMs: 0,
    },
  });
  let calls = 0;
  const outcome = await withRetry(ctx, () => {
    calls += 1;
    return Promise.reject(
      Object.assign(new Error("nope"), { status: "PERMISSION_DENIED" }),
    );
  });
  assert.equal(calls, 1);
  assert.equal(outcome.result, undefined);
  assert.equal(outcome.condition.status, "permission-denied");
});

Deno.test("withRetry: enqueues runtime-agent handoff on persistent timeout", async () => {
  let now = 0;
  const handoffCalls: unknown[] = [];
  const ctx = resolveRuntimeContext({
    clock: () => new Date(now),
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
    random: () => 0,
    policy: {
      ...defaultGcpRuntimePolicy,
      timeoutMs: 5,
      initialBackoffMs: 1,
      maxBackoffMs: 1,
      maxRetries: 0,
      jitterMs: 0,
    },
    runtimeAgentHandoff: {
      enqueue(input) {
        handoffCalls.push(input);
        return Promise.resolve("work_1");
      },
    },
  });
  const outcome = await withRetry(
    ctx,
    () =>
      Promise.reject(
        Object.assign(new Error("deadline"), { status: "DEADLINE_EXCEEDED" }),
      ),
    {
      handoffInput: {
        descriptor: "provider.gcp.cloud-run@v1",
        desiredStateId: "desired_1",
        targetId: "service_1",
        idempotencyKey: "key_1",
        enqueuedAt: fixedDate,
      },
    },
  );
  assert.equal(outcome.handedOff, true);
  assert.equal(outcome.handoffWorkId, "work_1");
  assert.equal(handoffCalls.length, 1);
});

Deno.test("computeIdempotencyKey: deterministic for same descriptor/state/target", () => {
  const a = computeIdempotencyKey({
    descriptor: "provider.gcp.cloud-run@v1",
    desiredStateId: "desired_1",
    targetId: "svc",
  });
  const b = computeIdempotencyKey({
    descriptor: "provider.gcp.cloud-run@v1",
    desiredStateId: "desired_1",
    targetId: "svc",
  });
  assert.equal(a, b);
  assert.match(a, /^gcp-[a-f0-9]{8}-/);
});

Deno.test("computeIdempotencyKey: differs across descriptors", () => {
  const a = computeIdempotencyKey({
    descriptor: "provider.gcp.cloud-run@v1",
    desiredStateId: "ds",
    targetId: "t",
  });
  const b = computeIdempotencyKey({
    descriptor: "provider.gcp.gcs@v1",
    desiredStateId: "ds",
    targetId: "t",
  });
  assert.notEqual(a, b);
});

Deno.test("computeDrift: returns missing when observed is undefined", () => {
  const report = computeDrift(
    { name: "value" },
    undefined,
    fixedDate,
  );
  assert.equal(report.status, "missing");
  assert.equal(report.entries.length, 0);
});

Deno.test("computeDrift: returns in-sync when desired matches observed", () => {
  const report = computeDrift(
    { region: "us-central1", tier: "db-f1-micro" },
    { region: "us-central1", tier: "db-f1-micro", state: "RUNNABLE" },
    fixedDate,
  );
  assert.equal(report.status, "in-sync");
});

Deno.test("computeDrift: surfaces drift entries when fields differ", () => {
  const report = computeDrift(
    { region: "us-central1", tier: "db-f1-micro" },
    { region: "us-central1", tier: "db-g1-small" },
    fixedDate,
  );
  assert.equal(report.status, "drift");
  assert.equal(report.entries.length, 1);
  assert.equal(report.entries[0]!.path, "tier");
  assert.equal(report.entries[0]!.desired, "db-f1-micro");
  assert.equal(report.entries[0]!.observed, "db-g1-small");
});

Deno.test("buildRuntimeDetails + executionFromCondition produce kernel-shaped records", () => {
  const condition: GcpProviderCondition = {
    status: "ok",
    retriable: false,
    message: "ok",
  };
  const details = buildRuntimeDetails(
    {
      condition,
      attempts: [],
      durationMs: 5,
      timedOut: false,
      handedOff: false,
    },
    "gcp-key",
  );
  assert.equal(details.idempotencyKey, "gcp-key");
  assert.equal(details.retryAttempts, 0);
  assert.equal(details.timedOut, false);
  assert.equal(details.handedOff, false);

  const exec = executionFromCondition(condition, fixedDate, fixedDate);
  assert.equal(exec!.status, "succeeded");
  assert.equal(exec!.code, 0);
});

Deno.test("executionFromCondition: failure condition becomes failed status with stderr", () => {
  const exec = executionFromCondition(
    { status: "permission-denied", retriable: false, message: "denied" },
    fixedDate,
    fixedDate,
  );
  assert.equal(exec!.status, "failed");
  assert.equal(exec!.code, 1);
  assert.equal(exec!.stderr, "denied");
});
