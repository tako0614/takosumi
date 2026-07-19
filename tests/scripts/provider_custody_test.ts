import { describe, expect, test } from "bun:test";

import { verifyProviderCustody } from "../../scripts/provider-custody.mjs";

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
