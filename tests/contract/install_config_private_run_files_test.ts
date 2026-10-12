import { expect, test } from "bun:test";
import { normalizeInstallConfigPrivateRunFiles } from "../../contract/install-configs.ts";

test("private Run file slot declaration accepts an exact opaque slot list", () => {
  expect(normalizeInstallConfigPrivateRunFiles([
    { slot: "worker-state.v1" },
    { slot: "issuer_cache-2" },
  ])).toEqual([
    { slot: "worker-state.v1" },
    { slot: "issuer_cache-2" },
  ]);
  expect(normalizeInstallConfigPrivateRunFiles(undefined)).toBeUndefined();
  expect(normalizeInstallConfigPrivateRunFiles([])).toEqual([]);
});

test("private Run file slot declaration rejects malformed and duplicate entries", () => {
  for (const value of [
    "worker-state",
    [{ slot: "../escape" }],
    [{ slot: "" }],
    [{ slot: "valid", other: "ignored" }],
    [{ slot: "same" }, { slot: "same" }],
  ]) {
    expect(() => normalizeInstallConfigPrivateRunFiles(value)).toThrow();
  }
});
