import { describe, expect, test } from "bun:test";
import {
  packageReleaseDecision,
  requiredContractReleaseTag,
} from "../../scripts/contract-package-release.ts";

describe("Takosumi contract package release", () => {
  test("uses a package-scoped immutable release tag", () => {
    expect(requiredContractReleaseTag("2.1.0")).toBe("takosumi-contract-v2.1.0");
    expect(() => requiredContractReleaseTag("2.1")).toThrow("stable semver");
  });

  test("publishes only an absent identity or resumes exact bytes", () => {
    expect(packageReleaseDecision("sha512-candidate", undefined)).toBe("publish");
    expect(packageReleaseDecision("sha512-candidate", "sha512-candidate")).toBe("skip");
    expect(() =>
      packageReleaseDecision("sha512-candidate", "sha512-other"),
    ).toThrow("does not match");
  });
});
