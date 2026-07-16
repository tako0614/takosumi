import { expect, test } from "bun:test";
import worker, * as platformWorker from "../../../deploy/platform/worker.ts";

test("platform Worker exposes only handler-compatible runtime exports", () => {
  expect(worker).toBeDefined();
  expect(typeof worker.fetch).toBe("function");

  for (const [name, value] of Object.entries(platformWorker)) {
    if (name === "default") continue;
    expect(typeof value, `${name} must be a Worker RPC handler or class`).toBe(
      "function",
    );
  }
});
