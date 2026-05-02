import assert from "node:assert/strict";
import {
  AwsTimeoutError,
  classifyAwsError,
  collectPaginated,
  deriveOperationKey,
  detectDrift,
  isRetryableCategory,
  paginate,
  runAwsCall,
  withRetry,
  withTimeout,
} from "../src/providers/aws/support.ts";

const env = {
  clock: () => new Date("2026-04-30T00:00:00.000Z"),
  idGenerator: () => "id_1",
};

Deno.test("classifyAwsError maps well-known AWS error codes", () => {
  assert.equal(
    classifyAwsError({ name: "ResourceNotFoundException" }),
    "not-found",
  );
  assert.equal(classifyAwsError({ Code: "ThrottlingException" }), "throttling");
  assert.equal(
    classifyAwsError({ __type: "com.amazonaws.s3#NoSuchBucket" }),
    "not-found",
  );
  assert.equal(
    classifyAwsError({ statusCode: 503 }),
    "service-unavailable",
  );
  assert.equal(classifyAwsError({ statusCode: 403 }), "access-denied");
  assert.equal(classifyAwsError({ statusCode: 429 }), "throttling");
  assert.equal(classifyAwsError(new Error("random")), "unknown");
  assert.equal(classifyAwsError(undefined), "unknown");
});

Deno.test("isRetryableCategory marks transient categories as retryable", () => {
  assert.equal(isRetryableCategory("throttling"), true);
  assert.equal(isRetryableCategory("service-unavailable"), true);
  assert.equal(isRetryableCategory("internal"), true);
  assert.equal(isRetryableCategory("timeout"), true);
  assert.equal(isRetryableCategory("not-found"), false);
  assert.equal(isRetryableCategory("validation"), false);
  assert.equal(isRetryableCategory("access-denied"), false);
});

Deno.test("withRetry retries on throttling and succeeds within budget", async () => {
  let attempts = 0;
  const result = await withRetry(
    "test-op",
    () => {
      attempts += 1;
      if (attempts < 3) {
        const err = new Error("rate") as Error & { name: string };
        err.name = "ThrottlingException";
        return Promise.reject(err);
      }
      return Promise.resolve("ok");
    },
    {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 1,
      sleep: () => Promise.resolve(),
    },
  );
  assert.equal(result, "ok");
  assert.equal(attempts, 3);
});

Deno.test("withRetry does not retry on validation errors", async () => {
  let attempts = 0;
  await assert.rejects(
    () =>
      withRetry(
        "test-op",
        () => {
          attempts += 1;
          const err = new Error("bad") as Error & { name: string };
          err.name = "ValidationException";
          return Promise.reject(err);
        },
        { maxAttempts: 3, sleep: () => Promise.resolve() },
      ),
    /bad/,
  );
  assert.equal(attempts, 1);
});

Deno.test("withRetry exhausts budget and throws last error", async () => {
  let attempts = 0;
  await assert.rejects(
    () =>
      withRetry(
        "test-op",
        () => {
          attempts += 1;
          const err = new Error("503") as Error & { name: string };
          err.name = "ServiceUnavailable";
          return Promise.reject(err);
        },
        { maxAttempts: 3, baseDelayMs: 1, sleep: () => Promise.resolve() },
      ),
  );
  assert.equal(attempts, 3);
});

Deno.test("withTimeout throws AwsTimeoutError when fn exceeds budget", async () => {
  let inner: ReturnType<typeof setTimeout> | undefined;
  await assert.rejects(
    () =>
      withTimeout("slow", 5, () =>
        new Promise<string>((resolve) => {
          inner = setTimeout(() => resolve("late"), 1000);
        })),
    AwsTimeoutError,
  );
  if (inner !== undefined) clearTimeout(inner);
});

Deno.test("detectDrift reports differing scalar fields", () => {
  const drift = detectDrift({ a: 1, b: 2 }, { a: 1, b: 3 });
  assert.equal(drift.length, 1);
  assert.equal(drift[0]?.path, "b");
  assert.equal(drift[0]?.desired, 2);
  assert.equal(drift[0]?.observed, 3);
});

Deno.test("detectDrift ignores undefined desired fields", () => {
  const drift = detectDrift({ a: undefined, b: 2 }, { a: 999, b: 2 });
  assert.equal(drift.length, 0);
});

Deno.test("detectDrift compares arrays element-wise", () => {
  const drift = detectDrift({ ids: ["a", "b"] }, { ids: ["a", "c"] });
  assert.equal(drift.length, 1);
  assert.equal(drift[0]?.path, "ids[1]");
});

Deno.test("paginate iterates across NextToken pages", async () => {
  const pages = [
    { items: [1, 2], nextToken: "p2" },
    { items: [3, 4], nextToken: "p3" },
    { items: [5], nextToken: undefined },
  ];
  let pageIndex = 0;
  const items = await collectPaginated(
    "test-list",
    () => Promise.resolve(pages[pageIndex++]),
    { maxAttempts: 1, baseDelayMs: 1, timeoutMs: 1000 },
  );
  assert.deepEqual([...items], [1, 2, 3, 4, 5]);
});

Deno.test("paginate retries individual page on throttling", async () => {
  let calls = 0;
  const items: number[] = [];
  for await (
    const item of paginate(
      "test-list",
      () => {
        calls += 1;
        if (calls === 1) {
          const err = new Error("throttle") as Error & { name: string };
          err.name = "ThrottlingException";
          return Promise.reject(err);
        }
        return Promise.resolve({ items: [calls], nextToken: undefined });
      },
      { maxAttempts: 3, baseDelayMs: 1, sleep: () => Promise.resolve() },
    )
  ) {
    items.push(item);
  }
  assert.deepEqual(items, [2]);
});

Deno.test("runAwsCall emits succeeded operation on happy path", async () => {
  const outcome = await runAwsCall(
    {
      kind: "test-call",
      target: "tgt",
      desiredStateId: "ds_1",
      command: ["aws", "test"],
    },
    env,
    () => Promise.resolve("ok"),
  );
  assert.equal(outcome.status, "succeeded");
  if (outcome.status !== "succeeded") return;
  assert.equal(outcome.result, "ok");
  assert.equal(outcome.operation.kind, "test-call");
  assert.equal(outcome.operation.execution?.status, "succeeded");
});

Deno.test("runAwsCall emits failed operation with errorCategory", async () => {
  const outcome = await runAwsCall(
    {
      kind: "test-call",
      target: "tgt",
      desiredStateId: "ds_1",
      command: ["aws", "test"],
      retry: { maxAttempts: 1 },
    },
    env,
    () => {
      const err = new Error("bad") as Error & { name: string };
      err.name = "ValidationException";
      return Promise.reject(err);
    },
  );
  assert.equal(outcome.status, "failed");
  if (outcome.status !== "failed") return;
  assert.equal(outcome.category, "validation");
  assert.equal(outcome.operation.execution?.status, "failed");
  assert.equal(outcome.operation.details.errorCategory, "validation");
});

Deno.test("deriveOperationKey is deterministic across calls", () => {
  assert.equal(
    deriveOperationKey("kind", "tgt", "ds_1"),
    deriveOperationKey("kind", "tgt", "ds_1"),
  );
  assert.notEqual(
    deriveOperationKey("kind", "tgt", "ds_1"),
    deriveOperationKey("kind", "tgt", "ds_2"),
  );
});
