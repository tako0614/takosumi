import assert from "node:assert/strict";
import {
  type AwsSqsLifecycleClient,
  AwsSqsProvider,
  type AwsSqsQueueDescriptor,
} from "../src/providers/aws/mod.ts";

const noSleep = {
  maxAttempts: 3,
  baseDelayMs: 1,
  sleep: () => Promise.resolve(),
};

const baseQueue: AwsSqsQueueDescriptor = {
  queueName: "jobs",
  queueUrl: "https://sqs.us-east-1.amazonaws.com/1/jobs",
  arn: "arn:aws:sqs:us-east-1:1:jobs",
  kind: "standard",
  attributes: { visibilityTimeoutSeconds: 30 },
};

function fakeLifecycle(
  overrides: Partial<AwsSqsLifecycleClient> = {},
): AwsSqsLifecycleClient {
  return {
    createQueue: () => Promise.resolve(baseQueue),
    describeQueue: () => Promise.resolve(baseQueue),
    deleteQueue: () => Promise.resolve(true),
    ...overrides,
  };
}

Deno.test("sqs createQueue happy path", async () => {
  const provider = new AwsSqsProvider({
    lifecycle: fakeLifecycle(),
    retry: noSleep,
  });
  const result = await provider.createQueue({ queueName: "jobs" });
  assert.equal(result.queueName, "jobs");
});

Deno.test("sqs describeQueue maps QueueDoesNotExist to undefined", async () => {
  const provider = new AwsSqsProvider({
    lifecycle: fakeLifecycle({
      describeQueue: () => {
        const e = new Error("nope") as Error & { name: string };
        e.name = "QueueDoesNotExist";
        return Promise.reject(e);
      },
    }),
    retry: noSleep,
  });
  const result = await provider.describeQueue({ queueName: "missing" });
  assert.equal(result, undefined);
});

Deno.test("sqs createQueue retries on RequestLimitExceeded", async () => {
  let attempts = 0;
  const provider = new AwsSqsProvider({
    lifecycle: fakeLifecycle({
      createQueue: () => {
        attempts += 1;
        if (attempts < 2) {
          const e = new Error("limit") as Error & { name: string };
          e.name = "RequestLimitExceeded";
          return Promise.reject(e);
        }
        return Promise.resolve(baseQueue);
      },
    }),
    retry: noSleep,
  });
  await provider.createQueue({ queueName: "jobs" });
  assert.equal(attempts, 2);
});

Deno.test("sqs listAllQueues paginates with nextToken", async () => {
  const pages = [
    { items: [{ ...baseQueue, queueName: "a" }], nextToken: "p2" },
    { items: [{ ...baseQueue, queueName: "b" }], nextToken: undefined },
  ];
  let pageIndex = 0;
  const provider = new AwsSqsProvider({
    lifecycle: fakeLifecycle({
      listQueues: () => Promise.resolve(pages[pageIndex++]),
    }),
    retry: noSleep,
  });
  const all = await provider.listAllQueues();
  assert.equal(all.length, 2);
  assert.equal(all[0]?.queueName, "a");
  assert.equal(all[1]?.queueName, "b");
});

Deno.test("sqs detectDrift reports kind mismatch", async () => {
  const provider = new AwsSqsProvider({
    lifecycle: fakeLifecycle({
      describeQueue: () => Promise.resolve({ ...baseQueue, kind: "fifo" }),
    }),
    retry: noSleep,
  });
  const drift = await provider.detectDrift({
    queueName: "jobs",
    kind: "standard",
    attributes: { visibilityTimeoutSeconds: 30 },
  });
  assert.equal(drift.length, 1);
  assert.equal(drift[0]?.path, "kind");
});

Deno.test("sqs sendMessage throws when queue client missing", async () => {
  const provider = new AwsSqsProvider({
    lifecycle: fakeLifecycle(),
    retry: noSleep,
  });
  await assert.rejects(
    () => provider.sendMessage({ queueName: "jobs", body: { ok: true } }),
    /queue client/,
  );
});
