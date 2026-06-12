import { expect, test } from "bun:test";
import {
  consumeOpenTofuRunBatch,
  type ConsumeOpenTofuRunDeps,
  safeParseOpenTofuRunQueueMessage,
} from "./run_queue_consumer.ts";
import { InstallationLeaseBusyError } from "../../core/domains/deploy-control/installation_lease.ts";
import type {
  CloudflareWorkerEnv,
  QueueBatch,
  QueueMessage,
  QueueRetryOptions,
} from "./bindings.ts";

const validBody = (action: string) => ({
  kind: "takosumi.opentofu-run@v1",
  action,
  runId: "run_1",
  spaceId: "space_1",
});

/** A recording queue message so a test can assert ack vs retry-with-delay. */
function recordingMessage(
  body: unknown,
  attempts = 1,
): QueueMessage & {
  readonly acked: () => number;
  readonly retried: () => QueueRetryOptions[];
} {
  let ackCount = 0;
  const retries: QueueRetryOptions[] = [];
  return {
    id: "m1",
    body,
    attempts,
    ack: () => {
      ackCount += 1;
    },
    retry: (options?: QueueRetryOptions) => {
      retries.push(options ?? {});
    },
    acked: () => ackCount,
    retried: () => retries,
  };
}

const FAKE_ENV = {} as unknown as CloudflareWorkerEnv;

function batchOf(message: QueueMessage): QueueBatch {
  return { queue: "takosumi-runs", messages: [message] };
}

test("dispatchable actions parse as ok", () => {
  for (const action of ["plan", "apply", "source_sync"]) {
    const result = safeParseOpenTofuRunQueueMessage(validBody(action));
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.message.action).toBe(action as never);
    }
  }
});

test("destroy / backup / compatibility_check parse as ok (handled before dispatch)", () => {
  for (const action of ["destroy", "backup", "compatibility_check"]) {
    expect(safeParseOpenTofuRunQueueMessage(validBody(action)).kind).toBe("ok");
  }
});

test("schema-reserved-but-unimplemented restore action is rejected fail-closed", () => {
  // `restore` is a reserved Run type in contract/runs.ts with no
  // producer, no queue action, and no handler. A message claiming action
  // "restore" must be treated as an invalid (poison) message so it is acked and
  // dropped, never dispatched to a non-existent destructive restore handler.
  const result = safeParseOpenTofuRunQueueMessage(validBody("restore"));
  expect(result.kind).toBe("invalid");
});

test("any unknown action is rejected fail-closed", () => {
  expect(safeParseOpenTofuRunQueueMessage(validBody("drift_check")).kind).toBe(
    "invalid",
  );
  expect(safeParseOpenTofuRunQueueMessage(validBody("definitely_not_real")).kind)
    .toBe("invalid");
});

test("a non-OpenTofu payload is classified separately, not invalid", () => {
  const result = safeParseOpenTofuRunQueueMessage({ kind: "some-other-queue@v1" });
  expect(result.kind).toBe("not_opentofu");
});

// --- lease-busy is scheduling, not failure ---

test("a lease-busy dispatch retries with a delay and never marks retries-exhausted (run stays queued)", async () => {
  let exhaustedCalls = 0;
  const deps: ConsumeOpenTofuRunDeps = {
    dispatch: () =>
      Promise.reject(new InstallationLeaseBusyError("installation:i:production")),
    markRetriesExhausted: () => {
      exhaustedCalls += 1;
      return Promise.resolve();
    },
  };
  // attempts past the retry budget so the run WOULD be marked exhausted if the
  // lease-busy error were treated as an ordinary failure.
  const message = recordingMessage(validBody("apply"), 99);

  await consumeOpenTofuRunBatch(batchOf(message), FAKE_ENV, deps);

  // The run was re-enqueued with a backoff, NOT acked, and never marked failed.
  expect(message.retried()).toEqual([{ delaySeconds: 10 }]);
  expect(message.acked()).toBe(0);
  expect(exhaustedCalls).toBe(0);
});

test("an ordinary dispatch failure on the final attempt DOES mark retries-exhausted and acks", async () => {
  let exhaustedCalls = 0;
  const deps: ConsumeOpenTofuRunDeps = {
    dispatch: () => Promise.reject(new Error("opentofu init failed")),
    markRetriesExhausted: () => {
      exhaustedCalls += 1;
      return Promise.resolve();
    },
  };
  const message = recordingMessage(validBody("apply"), 99);

  await consumeOpenTofuRunBatch(batchOf(message), FAKE_ENV, deps);

  // Contrast with lease-busy: an ordinary failure on the final attempt is acked
  // after the ledger update, and never retried.
  expect(exhaustedCalls).toBe(1);
  expect(message.acked()).toBe(1);
  expect(message.retried()).toEqual([]);
});

test("an ordinary dispatch failure before the final attempt rethrows (Queues retries the message)", async () => {
  const deps: ConsumeOpenTofuRunDeps = {
    dispatch: () => Promise.reject(new Error("transient")),
    markRetriesExhausted: () => Promise.resolve(),
  };
  // attempt 1 is below the retry budget, so the consumer rethrows.
  const message = recordingMessage(validBody("apply"), 1);

  await expect(
    consumeOpenTofuRunBatch(batchOf(message), FAKE_ENV, deps),
  ).rejects.toThrow();
  expect(message.acked()).toBe(0);
  expect(message.retried()).toEqual([]);
});
