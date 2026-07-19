import { describe, expect, test } from "bun:test";

import {
  PROVIDER_QUARANTINE_PATH,
  validateProviderCustodyRegistry,
  validateQuarantineManifest,
  verifyManifestSidecar,
  verifyProviderCustody,
} from "../../scripts/provider-custody.mjs";

async function quarantineManifest(): Promise<Record<string, any>> {
  return JSON.parse(await Bun.file(PROVIDER_QUARANTINE_PATH).text());
}

async function custodyRegistry(): Promise<Record<string, any>> {
  return JSON.parse(
    await Bun.file(
      new URL("../../provider/release/registry.json", import.meta.url),
    ).text(),
  );
}

describe("discontinued terraform-provider-takosumi custody", () => {
  test("has no publication lane and retains migration evidence", async () => {
    const result = await verifyProviderCustody();

    expect(result).toMatchObject({
      kind: "takosumi.provider-custody@v1",
      status: "discontinued",
      publishable: false,
      newVersionsAllowed: false,
      retainedVersion: "1.0.0",
      cancelledSnapshot: "1.1.4",
      sourceProvenance: "unresolved",
      releaseWorkflow: "absent",
      mutationPaths: "absent",
      defaultMirrorVersions: [],
    });
    expect(Object.keys(result.authorityDigests)).toEqual(
      expect.arrayContaining([
        "quarantine/1.0.0.json",
        "failures/1.1.0.json",
        "failures/1.1.3.json",
        "compatibility/1.0.0-state-identity.json",
        "compatibility/1.1.4-delta-policy.json",
        "compatibility/service-form-removal-policy.json",
      ]),
    );
  });

  test("rejects semantic mutations of the exact retained 1.0.0 custody record", async () => {
    const canonical = await quarantineManifest();
    expect(validateQuarantineManifest(structuredClone(canonical))).toEqual(
      canonical,
    );

    const mutations: Array<(manifest: Record<string, any>) => void> = [
      (manifest) => {
        manifest.source.modulePath = "github.com/example/provider";
      },
      (manifest) => {
        manifest.source.sourceCommit = "0".repeat(40);
      },
      (manifest) => {
        manifest.source.archiveClaimedVersion = "9.9.9";
      },
      (manifest) => {
        manifest.mirror.indexEntry = null;
      },
      (manifest) => {
        manifest.mirror.indexEntry.protocols = ["6.0"];
      },
      (manifest) => {
        manifest.mirror.indexEntry.platforms[0] = {
          os: "windows",
          arch: "amd64",
        };
      },
      (manifest) => {
        manifest.mirror.assets[0].path =
          "registry.opentofu.org/takosjp/takosumi/9.9.9.json";
        manifest.mirror.assets[0].url =
          "https://app.takosumi.com/opentofu/providers/registry.opentofu.org/takosjp/takosumi/9.9.9.json";
      },
      (manifest) => {
        manifest.mirror.indexObservation.path =
          "registry.opentofu.org/takosjp/takosumi/other.json";
        manifest.mirror.indexObservation.url =
          "https://app.takosumi.com/opentofu/providers/registry.opentofu.org/takosjp/takosumi/other.json";
      },
    ];

    for (const mutate of mutations) {
      const clone = structuredClone(canonical);
      mutate(clone);
      expect(() => validateQuarantineManifest(clone)).toThrow();
    }
  });

  test("rejects registry drift from the quarantine manifest sidecar", async () => {
    const canonical = await custodyRegistry();
    const digest = await verifyManifestSidecar(PROVIDER_QUARANTINE_PATH);
    expect(
      validateProviderCustodyRegistry(structuredClone(canonical), digest),
    ).toEqual(canonical);

    const wrongManifest = structuredClone(canonical);
    wrongManifest.versions[0].manifest = "quarantine/9.9.9.json";
    expect(() =>
      validateProviderCustodyRegistry(wrongManifest, digest),
    ).toThrow();

    const wrongDigest = structuredClone(canonical);
    wrongDigest.versions[0].sha256 = "0".repeat(64);
    expect(() =>
      validateProviderCustodyRegistry(wrongDigest, digest),
    ).toThrow();
  });

  test("keeps Capsule blueprints separate from Form-backed Resource descriptors", async () => {
    const [agents, finalPlan, operatorModuleDocs] = await Promise.all([
      Bun.file(new URL("../../AGENTS.md", import.meta.url)).text(),
      Bun.file(
        new URL("../../docs/internal/final-plan.md", import.meta.url),
      ).text(),
      Bun.file(
        new URL(
          "../../opentofu-modules/operator-control-mcp/README.md",
          import.meta.url,
        ),
      ).text(),
    ]);

    expect(agents).toContain("Resource-owned `form_descriptor`");
    expect(agents).not.toContain("two Capsule sources");
    expect(finalPlan).toContain(
      "New Capsule-owned Interface specs materialize from one active source",
    );
    expect(finalPlan).toMatch(
      /Resource-owned\s+`form_descriptor`\s+provenance/,
    );
    expect(operatorModuleDocs).toContain("not a\nCapsule module-author path");
  });
});
