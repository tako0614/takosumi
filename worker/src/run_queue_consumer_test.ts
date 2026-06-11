import { expect, test } from "bun:test";
import { safeParseOpenTofuRunQueueMessage } from "./run_queue_consumer.ts";

const validBody = (action: string) => ({
  kind: "takosumi.opentofu-run@v1",
  action,
  runId: "run_1",
  spaceId: "space_1",
});

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
