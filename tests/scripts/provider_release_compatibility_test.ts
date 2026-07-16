import { describe, expect, test } from "bun:test";
import {
  compareCandidateSchema,
  loadCompatibilityAuthorities,
  providerCliPrerequisites,
  structuralSha256,
  verifyProviderCompatibility,
} from "../../scripts/lib/provider-release-compatibility.mjs";

describe("provider release compatibility", () => {
  test("pins a non-secret historical identity and fails feature-bearing patch review closed", async () => {
    const { identity, policy } = await loadCompatibilityAuthorities();
    expect(identity.capture.containsStateValues).toBe(false);
    expect(identity.capture.containsSecrets).toBe(false);
    expect(policy.candidate.semverChange).toBe("patch");
    expect(policy.additiveResources).toHaveLength(4);
    expect(policy.additiveAttributes).toHaveLength(8);
    expect(policy.patchFeatureDecision).toMatchObject({
      status: "blocked-review",
      admitted: false,
    });
    expect(policy.releaseEligibility).toBe("blocked");
  });

  test("treats missing Terraform and the FQN split as blockers, never skips", async () => {
    const { identity } = await loadCompatibilityAuthorities();
    const prerequisites = providerCliPrerequisites(identity, {
      tofu: "/test/tofu",
      terraform: null,
    });
    expect(prerequisites.openTofu.status).toBe("ready");
    expect(prerequisites.terraform).toEqual({
      status: "blocked-prerequisite",
      reason: "terraform-cli-unavailable",
      releaseBlocking: true,
    });
    expect(JSON.stringify(prerequisites)).not.toContain("skip");
    expect(prerequisites.addressMatrix.status).toBe("blocked-address-split");
  });

  test("rejects an unclassified structural change", () => {
    const providerBlock = { attributes: { endpoint: { type: "string", optional: true } } };
    const resourceBlock = { attributes: { name: { type: "string", required: true } } };
    const identity = {
      stateIdentity: {
        providerSchemaVersion: 0,
        providerStructuralSha256: structuralSha256(providerBlock),
        resources: {
          takosumi_example: {
            schemaVersion: 0,
            structuralSha256: structuralSha256(resourceBlock),
          },
        },
      },
    };
    const policy = { additiveResources: [], additiveAttributes: [] };
    const changed: any = structuredClone(resourceBlock);
    changed.attributes.undeclared = { type: "string", optional: true };
    const result = compareCandidateSchema(
      {
        provider: { version: 0, block: providerBlock },
        resource_schemas: { takosumi_example: { version: 0, block: changed } },
      },
      identity,
      policy,
    );
    expect(result.compatible).toBe(false);
    expect(result.failures).toContain(
      "takosumi_example contains an unclassified structural change",
    );
  });

  test(
    "matches the current provider machine schema only after declared additions are removed",
    async () => {
      const result = await verifyProviderCompatibility();
      expect(result.schemaCompatibility.compatible).toBe(true);
      expect(result.schemaCompatibility.additiveResources).toEqual([
        "takosumi_durable_workflow",
        "takosumi_schedule",
        "takosumi_stateful_actor_namespace",
        "takosumi_vector_index",
      ]);
      expect(result.releaseReady).toBe(false);
      expect(result.blockers).toContain("patch-feature-decision-unapproved");
      expect(result.blockers).toContain("provider-address-split-unproven");
    },
    30_000,
  );
});
