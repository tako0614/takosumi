import { expect, test } from "bun:test";

import {
  classifyOpenTofuFailure,
  commandFailurePayload,
} from "../../runner/lib/exec.ts";
import { compactErrorCode } from "../../core/domains/deploy-control/projection_run.ts";

const CASES = [
  ["Invalid provider source address", "provider_source_invalid"],
  [
    "Failed to query available provider packages: provider registry registry.opentofu.org does not have a provider named example/missing",
    "provider_package_unavailable",
  ],
  [
    "Provider example/test does not have a package available for your current platform, linux_arm64",
    "provider_platform_binary_unavailable",
  ],
  ["Incompatible API version with plugin", "provider_protocol_mismatch"],
  [
    "provider registry.opentofu.org/example/test is denied before OpenTofu init",
    "provider_policy_denied",
  ],
  [
    "runner profile private does not allow local source paths",
    "runner_capability_missing",
  ],
  [
    "the local package doesn't match the checksums in the dependency lock file",
    "provider_checksum_mismatch",
  ],
] as const;

for (const [message, expected] of CASES) {
  test(`classifies ${expected}`, () => {
    expect(classifyOpenTofuFailure(message, "init")).toBe(expected);
  });
}

test("falls back to a concrete init failure code", () => {
  expect(classifyOpenTofuFailure("unexpected tofu init failure", "init")).toBe(
    "opentofu_init_failed",
  );
  expect(
    classifyOpenTofuFailure("unexpected tofu plan failure", "plan"),
  ).toBeUndefined();
});

test("command failure payload carries the stable code without exposing secrets", () => {
  const payload = commandFailurePayload(
    "run_test",
    "plan",
    {
      exitCode: 1,
      stdout: "",
      stderr:
        "Failed to query available provider packages with token secret-value",
    },
    { env: {}, redactionValues: ["secret-value"] },
    "init",
  );

  expect(payload.errorCode).toBe("provider_package_unavailable");
  expect(payload.stderr).toContain("[redacted]");
  expect(payload.stderr).not.toContain("secret-value");
});

test("public Run projection recovers a nested runner failure code", () => {
  expect(
    compactErrorCode(
      "OpenTofu runner rejected plan run run_test: 500 (provider_platform_binary_unavailable: no package)",
    ),
  ).toBe("provider_platform_binary_unavailable");
});
