import { expect, test } from "bun:test";
import { SigstoreTakoformPackageSignatureVerifier } from "../../../../core/adapters/takoform/signature.ts";

const digest = `sha256:${"0".repeat(64)}` as const;

test("Sigstore package policy requires a digest-pinned explicit publisher", async () => {
  expect(
    () =>
      new SigstoreTakoformPackageSignatureVerifier({
        trustedRootDigest: digest,
        loadTrustedRoot: async () => new Uint8Array(),
        publishers: [],
      }),
  ).toThrow("at least one trusted Takoform publisher");

  expect(
    () =>
      new SigstoreTakoformPackageSignatureVerifier({
        trustedRootDigest: digest,
        loadTrustedRoot: async () => new Uint8Array(),
        publishers: [
          {
            oidcIssuer: "https://token.actions.githubusercontent.com",
            sourceRepository: "tako0614/terraform-provider-takoform",
            workflow: ".github/workflows/form-package-release.yml",
            tagPattern: "refs/heads/main",
          },
        ],
      }),
  ).toThrow("single-segment Git tag glob");
});

test("malformed Sigstore material fails before a trust root can be used", async () => {
  let trustedRootReads = 0;
  const verifier = new SigstoreTakoformPackageSignatureVerifier({
    trustedRootDigest: digest,
    loadTrustedRoot: async () => {
      trustedRootReads++;
      return new Uint8Array();
    },
    publishers: [
      {
        oidcIssuer: "https://token.actions.githubusercontent.com",
        sourceRepository: "tako0614/terraform-provider-takoform",
        workflow: ".github/workflows/form-package-release.yml",
        tagPattern: "refs/tags/forms-*",
      },
    ],
  });

  await expect(verifier.verify(new Uint8Array([1]), {})).rejects.toThrow(
    "invalid Sigstore v0.3 bundle",
  );
  expect(trustedRootReads).toBe(0);
});
