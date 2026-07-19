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
      releaseWorkflow: "absent",
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
});
