import { expect, test } from "bun:test";

import {
  parseDataOnlyTarMode,
  parseChecksums,
  parsePublisherIdentity,
} from "../../scripts/verify-takoform-published-package-host-proof.ts";

test("published package policy projects one exact protected workflow ref", () => {
  expect(
    parsePublisherIdentity(
      {
        format: "takoform.sigstore-publisher-policy@v1",
        oidcIssuer: "https://token.actions.githubusercontent.com",
        certificateIdentity:
          "https://github.com/tako0614/terraform-provider-takoform/.github/workflows/form-package-release.yml@refs/heads/main",
        bundleMediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
      },
      "tako0614/terraform-provider-takoform",
    ),
  ).toEqual({
    oidcIssuer: "https://token.actions.githubusercontent.com",
    sourceRepository: "tako0614/terraform-provider-takoform",
    workflow: ".github/workflows/form-package-release.yml",
    refPattern: "refs/heads/main",
  });
});

test("published package policy rejects repository substitution", () => {
  expect(() =>
    parsePublisherIdentity(
      {
        format: "takoform.sigstore-publisher-policy@v1",
        oidcIssuer: "https://token.actions.githubusercontent.com",
        certificateIdentity:
          "https://github.com/attacker/provider/.github/workflows/release.yml@refs/heads/main",
        bundleMediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
      },
      "tako0614/terraform-provider-takoform",
    ),
  ).toThrow("repository drifted");
});

test("SHA256SUMS parser is closed and duplicate-safe", () => {
  const digest = "a".repeat(64);
  expect(
    parseChecksums(`${digest}  release-manifest.json\n`).get(
      "release-manifest.json",
    ),
  ).toBe(digest);
  expect(() =>
    parseChecksums(
      `${digest}  release-manifest.json\n${digest}  release-manifest.json\n`,
    ),
  ).toThrow("duplicate");
  expect(() => parseChecksums(`${digest} *unsafe/path\n`)).toThrow("malformed");
});

test("retained tar modes are preserved while executable and special modes fail closed", () => {
  expect(parseDataOnlyTarMode("-rw-r--r--")).toBe(0o644);
  expect(parseDataOnlyTarMode("-r--------")).toBe(0o400);
  expect(() => parseDataOnlyTarMode("-rwxr-xr-x")).toThrow("executable");
  expect(() => parseDataOnlyTarMode("-rwSr--r--")).toThrow("special mode");
});
