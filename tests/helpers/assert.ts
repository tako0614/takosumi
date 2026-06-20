import nodeAssert from "node:assert/strict";

export class AssertionError extends Error {
  override name = "AssertionError";
}

export function assert(expr: unknown, msg = "Assertion failed."): asserts expr {
  if (!expr) throw new AssertionError(msg);
}

export function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  nodeAssert.deepStrictEqual(actual, expected, msg);
}

export function assertNotEquals<T>(actual: T, expected: T, msg?: string): void {
  nodeAssert.notDeepStrictEqual(actual, expected, msg);
}

export function assertStringIncludes(
  actual: string,
  expected: string,
  msg?: string,
): void {
  assert(
    actual.includes(expected),
    msg ??
      `Expected string to include ${JSON.stringify(expected)}\n  actual: ${
        JSON.stringify(actual)
      }`,
  );
}

export function assertThrows(
  fn: () => unknown,
  msgOrClass?: unknown,
  msgIncludes?: unknown,
  msg?: unknown,
): unknown {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  assertThrown(thrown, msgOrClass, msgIncludes, msg, "throw");
  return thrown;
}

export async function assertRejects(
  fn: () => Promise<unknown>,
  msgOrClass?: unknown,
  msgIncludes?: unknown,
  msg?: unknown,
): Promise<unknown> {
  let thrown: unknown;
  try {
    await fn();
  } catch (error) {
    thrown = error;
  }
  assertThrown(thrown, msgOrClass, msgIncludes, msg, "reject");
  return thrown;
}

function assertThrown(
  thrown: unknown,
  msgOrClass: unknown,
  msgIncludes: unknown,
  msg: unknown,
  verb: "throw" | "reject",
): asserts thrown {
  if (thrown === undefined) {
    throw new AssertionError(
      typeof msgOrClass === "string"
        ? msgOrClass
        : `Expected function to ${verb}.`,
    );
  }
  if (
    typeof msgOrClass === "function" &&
    !(thrown instanceof (msgOrClass as new (...args: never[]) => Error))
  ) {
    throw new AssertionError(
      typeof msg === "string"
        ? msg
        : `Expected error to be instance of ${
          (msgOrClass as { name?: string }).name
        }`,
    );
  }
  if (
    typeof msgIncludes === "string" &&
    !(thrown as Error)?.message?.includes(msgIncludes)
  ) {
    throw new AssertionError(
      typeof msg === "string"
        ? msg
        : `Expected error message to include ${JSON.stringify(msgIncludes)}`,
    );
  }
}
