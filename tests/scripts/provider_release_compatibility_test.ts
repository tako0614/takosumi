import { describe, expect, test } from "bun:test";
import {
  compareCandidateSchema,
  loadCompatibilityAuthorities,
  providerCliPrerequisites,
  structuralSha256,
  verifyProviderCompatibility,
} from "../../scripts/lib/provider-release-compatibility.mjs";
import { buildSanitizedProviderProofEnvironment } from "../../scripts/lib/provider-proof-environment.mjs";
import { assertExactRequestDeltas } from "../../scripts/lib/provider-proof-requests.mjs";
import { assertProviderStateIdentity } from "../../scripts/lib/provider-proof-state.mjs";

describe("provider release compatibility", () => {
  test("pins historical identity and rejects the feature-bearing patch in favor of 1.1.0", async () => {
    const { identity, policy } = await loadCompatibilityAuthorities();
    expect(identity.capture.containsStateValues).toBe(false);
    expect(identity.capture.containsSecrets).toBe(false);
    expect(policy.candidate).toMatchObject({
      version: "1.1.0",
      semverChange: "minor",
    });
    expect(policy.additiveResources).toHaveLength(4);
    expect(policy.additiveAttributes).toHaveLength(8);
    expect(policy.patchFeatureDecision).toMatchObject({
      status: "resolved-move-to-minor",
      admitted: false,
    });
    expect(policy.releaseEligibility).toBe("blocked");
  });

  test("treats missing Terraform and the explicit dual-FQN proof as blockers, never skips", async () => {
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
    expect(prerequisites.terraformMatrix.status).toBe("proof-command-required");
    expect(prerequisites.addressMatrix).toMatchObject({
      status: "explicit-dual-address-proof-required",
      addressesTreatedAsInterchangeable: false,
    });
  });

  test("clears only the Terraform CLI prerequisite when Terraform is on PATH", async () => {
    const { identity } = await loadCompatibilityAuthorities();
    const prerequisites = providerCliPrerequisites(identity, {
      tofu: "/test/tofu",
      terraform: "/tmp/hashicorp-terraform-1.15.8/terraform",
    });
    expect(prerequisites.terraform.status).toBe("ready");
    expect(prerequisites.terraformMatrix).toEqual({
      status: "proof-command-required",
      reason: "terraform-schema-state-and-fqn-proof-command-required",
      releaseBlocking: true,
    });
    expect(prerequisites.addressMatrix.status).toBe(
      "explicit-dual-address-proof-required",
    );
  });

  test("rejects an unclassified structural change", () => {
    const providerBlock = {
      attributes: { endpoint: { type: "string", optional: true } },
    };
    const resourceBlock = {
      attributes: { name: { type: "string", required: true } },
    };
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

  test("rejects required and sensitive drift on declared artifact_ref", () => {
    const { providerSchema, identity, policy } = additiveSchemaFixture();
    expect(
      compareCandidateSchema(providerSchema, identity, policy).compatible,
    ).toBe(true);
    const mutated = structuredClone(providerSchema);
    mutated.resource_schemas.takosumi_edge_worker.block.attributes.artifact_ref =
      {
        type: "string",
        required: true,
        sensitive: true,
      };
    const result = compareCandidateSchema(mutated, identity, policy);
    expect(result.compatible).toBe(false);
    expect(result.failures).toContain(
      "takosumi_edge_worker.artifact_ref additive attribute schema identity changed",
    );
  });

  test("rejects a required and sensitive field added inside vector_index", () => {
    const { providerSchema, identity, policy } = additiveSchemaFixture();
    const mutated = structuredClone(providerSchema);
    mutated.resource_schemas.takosumi_vector_index.block.attributes.credential =
      {
        type: "string",
        required: true,
        sensitive: true,
      };
    const result = compareCandidateSchema(mutated, identity, policy);
    expect(result.compatible).toBe(false);
    expect(result.failures).toContain(
      "takosumi_vector_index additive resource schema identity changed",
    );
  });

  test("rejects provider source drift that can change defaults or validators", () => {
    const { providerSchema, identity, policy } = additiveSchemaFixture();
    policy.additiveSchemaIdentity.implementationSources = [
      { path: "provider/internal/provider/schema.go", sha256: "a".repeat(64) },
    ];
    providerSchema._takosumiImplementationSources = structuredClone(
      policy.additiveSchemaIdentity.implementationSources,
    );
    expect(
      compareCandidateSchema(providerSchema, identity, policy).compatible,
    ).toBe(true);
    providerSchema._takosumiImplementationSources[0].sha256 = "b".repeat(64);
    const result = compareCandidateSchema(providerSchema, identity, policy);
    expect(result.compatible).toBe(false);
    expect(result.failures).toContain(
      "provider implementation source identity changed; defaults or validators may have drifted",
    );
  });

  test("builds proof subprocess environments from an allowlist with derived credential evidence", () => {
    const result = buildSanitizedProviderProofEnvironment(
      {
        PATH: "/test/bin",
        LANG: "C.UTF-8",
        HTTPS_PROXY: "http://proxy.invalid:8080",
        TAKOSUMI_TOKEN: "must-not-pass",
        CLOUDFLARE_API_TOKEN: "must-not-pass",
        AWS_SECRET_ACCESS_KEY: "must-not-pass",
        GOOGLE_APPLICATION_CREDENTIALS: "/must/not/pass.json",
        TF_VAR_provider_token: "must-not-pass",
      },
      {
        home: "/tmp/provider-proof-home",
        overrides: { TF_IN_AUTOMATION: "1" },
      },
    );
    expect(result.environment).toEqual({
      PATH: "/test/bin",
      LANG: "C.UTF-8",
      HTTPS_PROXY: "http://proxy.invalid:8080",
      HOME: "/tmp/provider-proof-home",
      TF_IN_AUTOMATION: "1",
    });
    expect(result.evidence.credentialsUsed).toBe(false);
    expect(result.evidence.credentialEnvironmentKeys).toEqual([]);
    expect(JSON.stringify(result.environment)).not.toContain("must-not-pass");
  });

  test("rejects every unexpected managed request in exact phase evidence", () => {
    const managedRoutes = [
      "PUT /v1/resources/ObjectBucket/assets",
      "DELETE /v1/resources/ObjectBucket/assets",
      "POST /v1/resources/preview",
      "DELETE /v1/target-pools/default",
    ];
    const expected = { "PUT /v1/resources/ObjectBucket/assets": 1 };
    expect(() =>
      assertExactRequestDeltas({
        before: {},
        after: {
          "PUT /v1/resources/ObjectBucket/assets": 1,
          "DELETE /v1/resources/ObjectBucket/assets": 1,
        },
        managedRoutes,
        expected,
        phase: "test phase",
      }),
    ).toThrow(
      "test phase expected DELETE /v1/resources/ObjectBucket/assets delta 0, observed 1",
    );
    expect(() =>
      assertExactRequestDeltas({
        before: {},
        after: { "POST /v1/resources/preview": 1 },
        managedRoutes,
        expected: {},
        phase: "test phase",
      }),
    ).toThrow(
      "test phase expected POST /v1/resources/preview delta 0, observed 1",
    );
    expect(() =>
      assertExactRequestDeltas({
        before: {},
        after: { "DELETE /v1/target-pools/default": 1 },
        managedRoutes,
        expected: {},
        phase: "test phase",
      }),
    ).toThrow(
      "test phase expected DELETE /v1/target-pools/default delta 0, observed 1",
    );
    expect(() =>
      assertExactRequestDeltas({
        before: {},
        after: {},
        managedRoutes,
        expected: { "GET /unmanaged": 1 },
        phase: "test phase",
      }),
    ).toThrow("test phase declared unmanaged expected route GET /unmanaged");
  });

  test("rejects an interchangeable or missing provider FQN in CLI state evidence", () => {
    const state = {
      values: {
        root_module: {
          resources: [
            {
              address: "takosumi_object_bucket.current",
              provider_name: "registry.terraform.io/takosjp/takosumi",
              values: { storage_class: "standard" },
            },
          ],
        },
      },
    };
    expect(() =>
      assertProviderStateIdentity({
        state,
        resourceAddress: "takosumi_object_bucket.current",
        providerAddress: "registry.opentofu.org/takosjp/takosumi",
        expectedValues: { storage_class: "standard" },
        label: "OpenTofu state proof",
      }),
    ).toThrow(
      "OpenTofu state proof did not retain provider FQN registry.opentofu.org/takosjp/takosumi",
    );
    expect(() =>
      assertProviderStateIdentity({
        state,
        resourceAddress: "takosumi_object_bucket.missing",
        providerAddress: "registry.opentofu.org/takosjp/takosumi",
        label: "OpenTofu state proof",
      }),
    ).toThrow(
      "OpenTofu state proof did not retain provider FQN registry.opentofu.org/takosjp/takosumi",
    );
  });

  test("matches the current provider machine schema only after declared additions are removed", async () => {
    const result = await verifyProviderCompatibility();
    expect(result.schemaCompatibility.compatible).toBe(true);
    expect(result.schemaCompatibility.additiveResources).toEqual([
      "takosumi_durable_workflow",
      "takosumi_schedule",
      "takosumi_stateful_actor_namespace",
      "takosumi_vector_index",
    ]);
    expect(result.releaseReady).toBe(false);
    expect(result.blockers).not.toContain("patch-feature-decision-unapproved");
    expect(result.blockers).not.toContain("provider-address-split-unproven");
    expect(result.blockers).toContain(
      "terraform-schema-state-and-fqn-proof-command-required",
    );
  }, 30_000);
});

function additiveSchemaFixture() {
  const providerBlock = {
    attributes: { endpoint: { type: "string", optional: true } },
  };
  const historicalEdge = {
    attributes: { name: { type: "string", required: true } },
  };
  const edge: any = structuredClone(historicalEdge);
  edge.attributes.artifact_ref = { type: "string", optional: true };
  const vector = {
    attributes: {
      name: { type: "string", required: true },
      dimensions: { type: "number", required: true },
    },
  };
  const identity = {
    stateIdentity: {
      providerSchemaVersion: 0,
      providerStructuralSha256: structuralSha256(providerBlock),
      resources: {
        takosumi_edge_worker: {
          schemaVersion: 0,
          structuralSha256: structuralSha256(historicalEdge),
        },
      },
    },
  };
  const policy: any = {
    additiveResources: ["takosumi_vector_index"],
    additiveAttributes: ["takosumi_edge_worker.artifact_ref"],
    additiveSchemaIdentity: {
      resources: {
        takosumi_vector_index: {
          schemaVersion: 0,
          structuralSha256: structuralSha256(vector),
        },
      },
      attributes: {
        "takosumi_edge_worker.artifact_ref": structuralSha256(
          edge.attributes.artifact_ref,
        ),
      },
      implementationSources: [],
    },
  };
  const providerSchema: any = {
    provider: { version: 0, block: providerBlock },
    resource_schemas: {
      takosumi_edge_worker: { version: 0, block: edge },
      takosumi_vector_index: { version: 0, block: vector },
    },
    _takosumiImplementationSources: [],
  };
  return {
    providerSchema,
    identity,
    policy,
  };
}
