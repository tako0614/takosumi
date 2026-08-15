import { expect, test } from "bun:test";

import { installRunNeedsFallbackRead } from "./install-run-polling.ts";

test("install Run keeps a fallback read until a terminal state", () => {
  expect(installRunNeedsFallbackRead(undefined)).toBe(true);
  expect(installRunNeedsFallbackRead({ status: "queued" } as never)).toBe(
    true,
  );
  expect(installRunNeedsFallbackRead({ status: "running" } as never)).toBe(
    true,
  );
  for (const status of [
    "succeeded",
    "failed",
    "cancelled",
    "expired",
  ] as const) {
    expect(installRunNeedsFallbackRead({ status } as never)).toBe(false);
  }
});
