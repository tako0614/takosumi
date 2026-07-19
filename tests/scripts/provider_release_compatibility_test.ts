import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureCandidateSchema,
  compareCandidateSchema,
  createProviderCompatibilityProofArtifact,
  loadProviderCompatibilityProofArtifact,
  loadCompatibilityAuthorities,
  providerCliPrerequisites,
  resolveCompatibilityGoCommand,
  structuralSha256,
  validateProviderCompatibilityProofArtifact,
  verifyProviderCompatibility,
  writeProviderCompatibilityProofArtifact,
} from "../../scripts/lib/provider-release-compatibility.mjs";
import { buildSanitizedProviderProofEnvironment } from "../../scripts/lib/provider-proof-environment.mjs";
import { assertExactRequestDeltas } from "../../scripts/lib/provider-proof-requests.mjs";
import { assertProviderStateIdentity } from "../../scripts/lib/provider-proof-state.mjs";

describe("provider release compatibility", () => {
  const goDigest = createHash("sha256").update("reviewed-go").digest("hex");
  const digestCommand = async () => goDigest;

  test("uses the executable pinned Go toolchain after exact version verification", async () => {
    const commands: string[] = [];
    const command = await resolveCompatibilityGoCommand(
      {
        path: "/usr/lib/go-1.26/bin/go",
        version: "go1.26.0",
        sha256: goDigest,
      },
      {
        accessCommand: async (path: string) => commands.push(`access:${path}`),
        findOnPath: () => "/opt/hostedtoolcache/go/1.26.0/x64/bin/go",
        runCommand: (path: string, args: string[]) => {
          commands.push(`${path} ${args.join(" ")}`);
          return "go version go1.26.0 linux/amd64\n";
        },
        digestCommand,
      },
    );
    expect(command).toBe("/usr/lib/go-1.26/bin/go");
    expect(commands).toEqual([
      "access:/usr/lib/go-1.26/bin/go",
      "/usr/lib/go-1.26/bin/go version",
    ]);
  });

  test("falls back to PATH only when the pinned Go path is missing", async () => {
    const command = await resolveCompatibilityGoCommand(
      {
        path: "/usr/lib/go-1.26/bin/go",
        version: "go1.26.0",
        sha256: goDigest,
      },
      {
        accessCommand: async () => {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        },
        findOnPath: (name: string) =>
          name === "go" ? "/opt/hostedtoolcache/go/1.26.0/x64/bin/go" : null,
        runCommand: (path: string) => {
          expect(path).toBe("/opt/hostedtoolcache/go/1.26.0/x64/bin/go");
          return "go version go1.26.0 linux/amd64\n";
        },
        digestCommand,
      },
    );
    expect(command).toBe("/opt/hostedtoolcache/go/1.26.0/x64/bin/go");
  });

  test("fails closed when the selected Go version does not exactly match", async () => {
    await expect(
      resolveCompatibilityGoCommand(
        { path: "/missing/go", version: "go1.26.0", sha256: goDigest },
        {
          accessCommand: async () => {
            throw Object.assign(new Error("missing"), { code: "ENOENT" });
          },
          findOnPath: () => "/usr/bin/go",
          runCommand: () => "go version go1.26.1 linux/amd64\n",
          digestCommand,
        },
      ),
    ).rejects.toThrow("version mismatch: expected go1.26.0, observed go1.26.1");
  });

  test("does not fall back for a non-missing pinned Go failure", async () => {
    let searchedPath = false;
    await expect(
      resolveCompatibilityGoCommand(
        {
          path: "/usr/lib/go-1.26/bin/go",
          version: "go1.26.0",
          sha256: goDigest,
        },
        {
          accessCommand: async () => {
            throw Object.assign(new Error("permission denied"), {
              code: "EACCES",
            });
          },
          findOnPath: () => {
            searchedPath = true;
            return "/usr/bin/go";
          },
        },
      ),
    ).rejects.toThrow("cannot execute pinned Go toolchain");
    expect(searchedPath).toBe(false);
  });

  test("fails when neither pinned nor PATH Go is available", async () => {
    await expect(
      resolveCompatibilityGoCommand(
        { path: "/missing/go", version: "go1.26.0", sha256: goDigest },
        {
          accessCommand: async () => {
            throw Object.assign(new Error("missing"), { code: "ENOENT" });
          },
          findOnPath: () => null,
        },
      ),
    ).rejects.toThrow("go is unavailable on PATH");
  });

  test("fails closed when the selected Go executable digest differs", async () => {
    await expect(
      resolveCompatibilityGoCommand(
        { path: "/missing/go", version: "go1.26.0", sha256: goDigest },
        {
          accessCommand: async () => {
            throw Object.assign(new Error("missing"), { code: "ENOENT" });
          },
          findOnPath: () => "/opt/hostedtoolcache/go/1.26.0/x64/bin/go",
          runCommand: () => "go version go1.26.0 linux/amd64\n",
          digestCommand: async () => "f".repeat(64),
        },
      ),
    ).rejects.toThrow("digest mismatch");
  });

  test("pins historical identity and rejects the feature-bearing patch in favor of 1.1.4", async () => {
    const { identity, policy } = await loadCompatibilityAuthorities();
    expect(identity.capture.containsStateValues).toBe(false);
    expect(identity.capture.containsSecrets).toBe(false);
    expect(policy.candidate).toMatchObject({
      version: "1.1.4",
      semverChange: "minor",
    });
    expect(policy.additiveResources).toHaveLength(5);
    expect(policy.additiveAttributes).toHaveLength(9);
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

  test("writes digest-bound proof evidence and rejects a tampered sidecar", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-proof-artifact-test-"));
    try {
      const authorities = await loadCompatibilityAuthorities();
      const artifact = await createProviderCompatibilityProofArtifact({
        proof: completeStateProof(authorities),
        toolchains: completeProofToolchains(),
      });
      const path = join(root, "proof.json");
      await writeProviderCompatibilityProofArtifact(artifact, { path });
      expect(
        (await loadProviderCompatibilityProofArtifact({ path })).status,
      ).toBe("proof-complete");
      const bytes = await readFile(path);
      await writeFile(`${path}.sha256`, `${"0".repeat(64)}  proof.json\n`);
      const tampered = await loadProviderCompatibilityProofArtifact({ path });
      expect(tampered).toMatchObject({
        status: "invalid-evidence",
        reason: "provider compatibility proof artifact digest sidecar mismatch",
      });
      expect(bytes.length).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("matches the current provider machine schema only after declared additions are removed", async () => {
    const providerSchema = await captureCandidateSchema();
    const result = await verifyProviderCompatibility({
      providerSchema,
      proofArtifact: null,
    });
    expect(result.schemaCompatibility.compatible).toBe(true);
    expect(result.schemaCompatibility.additiveResources).toEqual([
      "takosumi_durable_workflow",
      "takosumi_interface",
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

    const authorities = await loadCompatibilityAuthorities();
    const proofArtifact = await createProviderCompatibilityProofArtifact({
      proof: completeStateProof(authorities),
      toolchains: completeProofToolchains(),
    });
    const serializedProof = JSON.stringify(proofArtifact);
    expect(serializedProof).not.toContain("cliPath");
    expect(serializedProof).not.toContain("forwardedKeys");
    expect(serializedProof).not.toContain("environmentEvidence");
    expect(serializedProof).not.toContain("TOKEN");
    const ready = await verifyProviderCompatibility({
      providerSchema,
      proofArtifact,
    });
    expect(ready.releaseReady).toBe(true);
    expect(ready.blockers).toEqual([]);
    expect(ready.prerequisites.terraformMatrix).toMatchObject({
      status: "proof-complete",
      releaseBlocking: false,
    });
    expect(ready.prerequisites.addressMatrix).toMatchObject({
      status: "explicit-dual-address-proof-complete",
      releaseBlocking: false,
      addressesTreatedAsInterchangeable: false,
    });
    expect(ready.terraformCompatibility.releaseEvidenceStatus).toBe(
      "proof-complete",
    );

    const stale = structuredClone(proofArtifact);
    stale.bindings.proofSourceSha256 = "f".repeat(64);
    await expect(
      validateProviderCompatibilityProofArtifact(stale),
    ).rejects.toThrow("stale for the current source");
  }, 30_000);
});

function completeProofToolchains() {
  return {
    openTofu: {
      version: "1.12.3",
      platform: "linux_amd64",
      executableSha256: "a".repeat(64),
    },
    terraform: {
      version: "1.15.8",
      platform: "linux_amd64",
      executableSha256: "b".repeat(64),
    },
  };
}

function completeStateProof(
  authorities: Awaited<ReturnType<typeof loadCompatibilityAuthorities>>,
) {
  return {
    kind: "takosumi.provider-old-state-compatibility-proof@v1",
    baselineVersion: authorities.identity.provider.version,
    candidateVersion: authorities.policy.candidate.version,
    resourceTypes: [
      "takosumi_container_service",
      "takosumi_edge_worker",
      "takosumi_kv_store",
      "takosumi_object_bucket",
      "takosumi_queue",
      "takosumi_sql_database",
      "takosumi_target_pool",
    ],
    stateValuesRecorded: false,
    environmentEvidence: {
      mode: "explicit-allowlist",
      forwardedKeys: ["HOME", "PATH"],
      credentialEnvironmentKeys: [],
      credentialsUsed: false,
    },
    credentialsUsed: false,
    oldStateRefreshFreeNoOp: true,
    currentObserveRefresh: true,
    currentMutationDuringRefresh: false,
    oldProviderRollbackNoOp: true,
    currentOmittedBucketCreateCanonicalized: true,
    openTofuEvidence: {
      status: "proof-complete",
      providerAddress: authorities.identity.provider.openTofuAddress,
      schemaStructuralSha256: "c".repeat(64),
      stateProviderAddressExact: true,
      storageClassKnownStandard: true,
      addressesTreatedAsInterchangeable: false,
      stateValuesRecorded: false,
    },
    terraformEvidence: {
      status: "proof-complete",
      terraformAddress: authorities.identity.provider.terraformServeAddress,
      openTofuAddress: authorities.identity.provider.openTofuAddress,
      schemaLoadedAtTerraformAddress: true,
      schemaStructuralSha256: "c".repeat(64),
      stateProviderAddressExact: true,
      refreshPlanNoOp: true,
      addressesTreatedAsInterchangeable: false,
      stateValuesRecorded: false,
    },
    phaseEvidence: {
      oldApply: "six-resource-put-and-target-pool-put-exact",
      currentRefreshFreePlan: "zero-managed-route-requests",
      currentRefresh: "six-resource-observe-and-target-pool-get-exact",
      oldRollback: "six-resource-get-and-target-pool-get-exact",
    },
    exactHistoricalFilesystemMirror: true,
    devOverrideUsedOnlyForCandidate: true,
  };
}

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
