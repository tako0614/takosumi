import { expect, test } from "bun:test";
import {
  privateRunFileManifestDigest,
} from "../../core/shared/private_run_file_refresh.ts";

const owner = { kind: "plan" as const, id: "plan_one" };

test("private Run file refresh manifest pins owner, Run and slot endpoints without grants", async () => {
  const first = await privateRunFileManifestDigest({
    owner,
    runnerRunId: "plan_one",
    files: [
      { slot: "zeta", endpoint: "https://core.example/internal/private-run-files/v1", grant: "opaque-a" },
      { slot: "alpha", endpoint: "https://core.example/internal/private-run-files/v1", grant: "opaque-b" },
    ],
  });
  expect(first).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(await privateRunFileManifestDigest({
    owner,
    runnerRunId: "plan_one",
    files: [
      { slot: "alpha", endpoint: "https://core.example/internal/private-run-files/v1", grant: "rotated-b" },
      { slot: "zeta", endpoint: "https://core.example/internal/private-run-files/v1", grant: "rotated-a" },
    ],
  })).toBe(first);
  expect(await privateRunFileManifestDigest({
    owner: { kind: "apply", id: "plan_one" },
    runnerRunId: "plan_one",
    files: [{ slot: "alpha", endpoint: "https://core.example/internal/private-run-files/v1", grant: "opaque-b" }],
  })).not.toBe(first);
  expect(await privateRunFileManifestDigest({
    owner,
    runnerRunId: "other_run",
    files: [{ slot: "alpha", endpoint: "https://core.example/internal/private-run-files/v1", grant: "opaque-b" }],
  })).not.toBe(first);
});
