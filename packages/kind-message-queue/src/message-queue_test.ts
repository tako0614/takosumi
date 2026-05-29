import { assertEquals } from "jsr:@std/assert@^1.0.6";
import type { ShapeValidationIssue } from "takosumi-contract/reference/shape";
import { MessageQueueKind } from "./message-queue.ts";

Deno.test("MessageQueueKind accepts the minimal portable spec", () => {
  assertEquals(validateSpec({ name: "jobs" }), []);
});

Deno.test("MessageQueueKind accepts optional retry cap and dead-letter queue", () => {
  assertEquals(
    validateSpec({
      name: "jobs",
      deliveryDelay: 0,
      maxRetries: 5,
      deadLetterQueue: "jobs-dlq",
    }),
    [],
  );
  // maxRetries: 0 is a meaningful "no retries before dead-letter" value.
  assertEquals(validateSpec({ name: "jobs", maxRetries: 0 }), []);
});

Deno.test("MessageQueueKind rejects a negative or non-integer maxRetries", () => {
  assertEquals(
    validateSpec({ name: "jobs", maxRetries: -1 }),
    [{ path: "$.maxRetries", message: "must be a non-negative integer" }],
  );
  assertEquals(
    validateSpec({ name: "jobs", maxRetries: 1.5 }),
    [{ path: "$.maxRetries", message: "must be a non-negative integer" }],
  );
});

Deno.test("MessageQueueKind rejects an empty or non-string deadLetterQueue", () => {
  assertEquals(
    validateSpec({ name: "jobs", deadLetterQueue: "" }),
    [{ path: "$.deadLetterQueue", message: "must be a non-empty string" }],
  );
  assertEquals(
    validateSpec({ name: "jobs", deadLetterQueue: 123 }),
    [{ path: "$.deadLetterQueue", message: "must be a non-empty string" }],
  );
});

Deno.test("MessageQueueKind keeps backend-specific controls in native kinds", () => {
  assertEquals(
    validateSpec({ name: "jobs", retries: 3 }),
    [{ path: "$.retries", message: "unknown field" }],
  );
});

function validateSpec(value: unknown): ShapeValidationIssue[] {
  const issues: ShapeValidationIssue[] = [];
  MessageQueueKind.validateSpec(value, issues);
  return issues;
}
