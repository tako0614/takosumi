import { expect, test } from "bun:test";
import {
  parseTrustPolicy,
  R2TakoformPackageArtifactReader,
} from "../../../../core/adapters/takoform/composition.ts";

test("R2 package reader restricts immutable artifacts to the trusted prefix", async () => {
  const body = new TextEncoder().encode("artifact");
  const reader = new R2TakoformPackageArtifactReader(
    {
      get: async (key) =>
        key === "packages/example.json"
          ? {
              size: body.byteLength,
              arrayBuffer: async () => body.slice().buffer,
            }
          : null,
    },
    "packages/",
  );
  expect(
    new TextDecoder().decode(await reader.read("r2:packages/example.json")),
  ).toBe("artifact");
  await expect(reader.read("r2:trust/root.json")).rejects.toThrow(
    "outside the trusted R2 prefix",
  );
  await expect(reader.read("https://example.com/package")).rejects.toThrow(
    "must use the r2: scheme",
  );
});

test("host trust policy is exact, publisher-explicit, and digest-pinned", () => {
  const policy = parseTrustPolicy(
    JSON.stringify({
      schemaVersion: 1,
      artifactPrefix: "packages/",
      trustedRoot: {
        key: "trust/sigstore-public-good-root.json",
        digest: `sha256:${"a".repeat(64)}`,
      },
      publishers: [
        {
          oidcIssuer: "https://token.actions.githubusercontent.com",
          sourceRepository: "tako0614/terraform-provider-takoform",
          workflow: ".github/workflows/form-package-release.yml",
          tagPattern: "refs/tags/forms/*/v*",
        },
      ],
    }),
  );
  expect(policy.publishers[0]?.sourceRepository).toBe(
    "tako0614/terraform-provider-takoform",
  );
  expect(() =>
    parseTrustPolicy(
      JSON.stringify({ ...policy, publishers: [], implicitTrust: true }),
    ),
  ).toThrow("unknown or missing fields");
});
