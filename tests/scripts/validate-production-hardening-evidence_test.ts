import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PRODUCTION_HARDENING_EVIDENCE_KIND,
  productionHardeningEvidenceTemplate,
  updateProductionHardeningEvidenceDigestsFile,
  validateProductionHardeningEvidence,
  validateProductionHardeningEvidenceFile,
} from "../../scripts/validate-production-hardening-evidence.ts";

test("production hardening evidence template carries every required check", () => {
  const template = productionHardeningEvidenceTemplate();
  expect(template.kind).toBe(PRODUCTION_HARDENING_EVIDENCE_KIND);
  expect(Object.keys(template.checks).sort()).toEqual([
    "containerSmoke",
    "costAttribution",
    "credentialRecipes",
    "egressEnforcement",
    "platformControlPlaneSmoke",
    "restoreRehearsal",
    "secretBoundary",
  ]);
  expect(
    template.checks.credentialRecipes.recipes.map((item) => item.id),
  ).toEqual(["aws", "cloudflare", "gcp", "github", "kubernetes"]);
  expect(
    template.checks.credentialRecipes.recipes.every((item) =>
      item.connectionModes.includes("provider_connection"),
    ),
  ).toBe(true);
  expect(template.checks.credentialRecipes.genericEnvRecipeVerified).toBe(
    true,
  );
  expect(
    template.checks.credentialRecipes.unregisteredProviderExecutionVerified,
  ).toBe(true);
  expect(template.checks.credentialRecipes.recipePresenceUsedAsAdmission).toBe(
    false,
  );
  expect(template.checks.secretBoundary.leakTargetsChecked).toContain(
    "hardeningGatePayloads",
  );
});

test("production hardening evidence manifest emits hardening gate env", () => {
  const result = validateProductionHardeningEvidence(validManifest());

  expect(result.status).toBe("passed");
  expect(result.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(result.env).toMatchObject({
    TAKOSUMI_CLOUDFLARE_CONTAINER_SMOKE_EVIDENCE_REF:
      "git+ssh://git@github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/container-smoke.md",
    TAKOSUMI_PLATFORM_CONTROL_PLANE_SMOKE_EVIDENCE_REF:
      "git+ssh://git@github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/platform-control-plane-smoke.md",
    TAKOSUMI_EGRESS_ENFORCEMENT_EVIDENCE_REF:
      "git+ssh://git@github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/egress.md",
    TAKOSUMI_RESTORE_REHEARSAL_EVIDENCE_REF:
      "git+ssh://git@github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/restore-rehearsal.md",
    TAKOSUMI_CREDENTIAL_RECIPE_EVIDENCE_REF:
      "git+ssh://git@github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/provider-connections.md",
    TAKOSUMI_COST_ATTRIBUTION_EVIDENCE_REF:
      "git+ssh://git@github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/cost-attribution.md",
    TAKOSUMI_SECRET_BOUNDARY_EVIDENCE_REF:
      "git+ssh://git@github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/secret-boundary.md",
  });
});

test("production hardening evidence rejects fixture refs", () => {
  const manifest = validManifest();
  manifest.checks.containerSmoke.evidenceRef =
    "git+https://example.com/takosumi.git@0123456789abcdef0123456789abcdef01234567#fixtures/container.md";

  expect(() => validateProductionHardeningEvidence(manifest)).toThrow(
    "containerSmoke.evidenceRef must be non-fixture operator evidence",
  );
});

test("production hardening evidence rejects mutable evidence refs", () => {
  const manifest = validManifest();
  manifest.checks.containerSmoke.evidenceRef =
    "git+ssh://git@github.com/tako0614/takosumi-private.git#evidence/container-smoke.md";

  expect(() => validateProductionHardeningEvidence(manifest)).toThrow(
    "containerSmoke.evidenceRef must be pinned to an immutable git commit",
  );
});

test("production hardening evidence requires canonical UTC generatedAt", () => {
  const manifest = validManifest();
  manifest.generatedAt = "June 8, 2026 00:00:00 UTC";

  expect(() => validateProductionHardeningEvidence(manifest)).toThrow(
    "production hardening evidence generatedAt is invalid",
  );
});

test("production hardening evidence rejects fake commit pins inside the evidence path", () => {
  const manifest = validManifest();
  manifest.checks.containerSmoke.evidenceRef =
    "git+ssh://git@github.com/tako0614/takosumi-private.git#evidence/foo@0123456789abcdef0123456789abcdef01234567#container-smoke.md";

  expect(() => validateProductionHardeningEvidence(manifest)).toThrow(
    "containerSmoke.evidenceRef must be a git+ ref with #path",
  );
});

test("production hardening evidence rejects fixture refs case-insensitively", () => {
  const manifest = validManifest();
  manifest.checks.containerSmoke.evidenceRef =
    "git+ssh://git@github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/TODO-container-smoke.md";

  expect(() => validateProductionHardeningEvidence(manifest)).toThrow(
    "containerSmoke.evidenceRef must be non-fixture operator evidence",
  );
});

test("production hardening evidence requires secret-boundary leak targets", () => {
  const manifest = validManifest();
  manifest.checks.secretBoundary.leakTargetsChecked = [
    "runnerDiagnostics",
    "apiPayloads",
    "runPayloads",
    "usagePayloads",
  ];

  expect(() => validateProductionHardeningEvidence(manifest)).toThrow(
    "secretBoundary.leakTargetsChecked is missing hardeningGatePayloads",
  );
});

test("production hardening evidence requires provider connection coverage", () => {
  const manifest = validManifest();
  manifest.checks.credentialRecipes.recipes =
    manifest.checks.credentialRecipes.recipes.filter(
      (provider: { id: string }) => provider.id !== "kubernetes",
    );

  expect(() => validateProductionHardeningEvidence(manifest)).toThrow(
    "credentialRecipes.recipes is missing kubernetes",
  );
});

test("production hardening evidence requires layer-2 platform control-plane coverage", () => {
  const manifest = validManifest();
  manifest.checks.platformControlPlaneSmoke.steps = [
    "spaceScopedProviderConnection",
    "scratchInstall",
    "plan",
    "apply",
    "deploymentVerified",
    "publicUrlVerified",
    "deploymentLedgerVerified",
  ];

  expect(() => validateProductionHardeningEvidence(manifest)).toThrow(
    "platformControlPlaneSmoke.steps is missing destroy",
  );
});

test("production hardening evidence requires restore rehearsal coverage", () => {
  const manifest = validManifest();
  manifest.checks.restoreRehearsal.scopesVerified = [
    "controlLedger",
    "stateSnapshots",
    "outputSnapshots",
  ];

  expect(() => validateProductionHardeningEvidence(manifest)).toThrow(
    "restoreRehearsal.scopesVerified is missing auditChain",
  );
});

test("production hardening evidence requires usage ledger samples", () => {
  const manifest = validManifest();
  manifest.checks.costAttribution.usageLedger.latestRunIds = [];

  expect(() => validateProductionHardeningEvidence(manifest)).toThrow(
    "costAttribution.usageLedger.latestRunIds must be a non-empty string array",
  );
});

test("production hardening evidence file verifies evidence file digests", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "takosumi-hardening-evidence-"));
  try {
    const manifest = validManifest();
    await writeEvidenceFiles(tempDir, manifest);
    const manifestPath = join(tempDir, "evidence", "production-hardening.json");
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    const result = await validateProductionHardeningEvidenceFile(manifestPath);
    expect(result.status).toBe("passed");

    manifest.checks.secretBoundary.evidenceDigest =
      "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    await expect(
      validateProductionHardeningEvidenceFile(manifestPath),
    ).rejects.toThrow("secretBoundary.evidenceDigest does not match");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("production hardening evidence file can update evidence digests", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "takosumi-hardening-evidence-"));
  try {
    const manifest = validManifest();
    await mkdir(join(tempDir, "evidence"), { recursive: true });
    const expectedDigests: Record<string, string> = {};
    for (const [name, check] of Object.entries(manifest.checks) as Array<
      [string, { evidenceRef: string; evidenceDigest: string }]
    >) {
      const path = check.evidenceRef.split("#", 2)[1];
      if (!path) throw new Error(`${name} evidenceRef missing path`);
      const content = `${name} updated operator evidence\n`;
      expectedDigests[name] = digest(content);
      check.evidenceDigest =
        "sha256:0000000000000000000000000000000000000000000000000000000000000000";
      await writeFile(join(tempDir, path), content);
    }

    const manifestPath = join(tempDir, "evidence", "production-hardening.json");
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    const result =
      await updateProductionHardeningEvidenceDigestsFile(manifestPath);
    const updated = JSON.parse(await Bun.file(manifestPath).text());

    expect(result.status).toBe("passed");
    expect(updated.checks.containerSmoke.evidenceDigest).toBe(
      expectedDigests.containerSmoke,
    );
    expect(updated.checks.egressEnforcement.evidenceDigest).toBe(
      expectedDigests.egressEnforcement,
    );
    expect(updated.checks.credentialRecipes.evidenceDigest).toBe(
      expectedDigests.credentialRecipes,
    );
    expect(updated.checks.secretBoundary.evidenceDigest).toBe(
      expectedDigests.secretBoundary,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("production hardening evidence digest update does not write invalid manifests", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "takosumi-hardening-evidence-"));
  try {
    const manifest = validManifest();
    await writeEvidenceFiles(tempDir, manifest);
    manifest.checks.credentialRecipes.recipes =
      manifest.checks.credentialRecipes.recipes.filter(
        (provider: { id: string }) => provider.id !== "github",
      );
    manifest.checks.containerSmoke.evidenceDigest =
      "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    const manifestPath = join(tempDir, "evidence", "production-hardening.json");
    const original = JSON.stringify(manifest, null, 2);
    await writeFile(manifestPath, original);

    await expect(
      updateProductionHardeningEvidenceDigestsFile(manifestPath),
    ).rejects.toThrow("credentialRecipes.recipes is missing github");
    expect(await Bun.file(manifestPath).text()).toBe(original);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function validManifest(): any {
  return {
    kind: PRODUCTION_HARDENING_EVIDENCE_KIND,
    generatedAt: "2026-06-08T00:00:00.000Z",
    environment: "production",
    checks: {
      containerSmoke: {
        evidenceRef:
          "git+ssh://git@github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/container-smoke.md",
        evidenceDigest:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        live: true,
        summary:
          "Deployed OpenTofuRunnerObject started a Cloudflare Container and applied a non-production Cloudflare fixture.",
        deployedRunnerObject: "OpenTofuRunnerObject",
        healthzStatus: 200,
        providerApply: {
          provider: "cloudflare",
          runId: "run_live_cloudflare_001",
          status: "succeeded",
          stateSnapshotId: "state_001",
          outputSnapshotId: "out_001",
        },
      },
      platformControlPlaneSmoke: {
        evidenceRef:
          "git+ssh://git@github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/platform-control-plane-smoke.md",
        evidenceDigest:
          "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        live: true,
        summary:
          "Layer-2 platform control-plane smoke installed, planned, applied, verified, and destroyed a scratch Cloudflare Worker Capsule through the platform API.",
        serviceUrl: "https://app.takosumi.com",
        scratchSpaceId: "space_scratch_001",
        capsuleModule: "cloudflare-hello-worker",
        credentialPath: "space_scoped_provider_connection",
        steps: [
          "spaceScopedProviderConnection",
          "scratchInstall",
          "plan",
          "apply",
          "deploymentVerified",
          "publicUrlVerified",
          "deploymentLedgerVerified",
          "destroy",
          "connectionRevoked",
        ],
        capsuleGateStatus: "passed",
        policyStatus: "passed",
        deploymentVerified: true,
        publicUrlVerified: true,
        deploymentLedgerVerified: true,
        destroyVerified: true,
        connectionRevoked: true,
      },
      egressEnforcement: {
        evidenceRef:
          "git+ssh://git@github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/egress.md",
        evidenceDigest:
          "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        live: true,
        summary:
          "OpenTofu runner boundary allowed the required provider API host and denied a blocked metadata source host.",
        runnerProfileId: "opentofu-default",
        runnerBoundary: "cloudflare-container",
        networkPolicyConfigured: true,
        providerAllowProbe: {
          host: "api.cloudflare.com",
          result: "allowed",
          provider: "cloudflare",
          runId: "apply_0123456789abcdef",
          status: "succeeded",
        },
        sourceDenyProbe: {
          host: "metadata.google.internal",
          result: "denied",
          statusCode: 400,
          errorCode: "invalid_argument",
        },
      },
      restoreRehearsal: {
        evidenceRef:
          "git+ssh://git@github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/restore-rehearsal.md",
        evidenceDigest:
          "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        live: true,
        summary:
          "Latest platform control-plane backup was restored in an isolated recovery target and the audit chain was verified.",
        target: "isolated_recovery",
        backupId: "backup_20260608_001",
        restoreMode: "isolated_restore",
        scopesVerified: [
          "controlLedger",
          "stateSnapshots",
          "outputSnapshots",
          "auditChain",
        ],
        auditChainVerified: true,
        rtoMinutes: 30,
        rpoMinutes: 15,
      },
      credentialRecipes: {
        evidenceRef:
          "git+ssh://git@github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/provider-connections.md",
        evidenceDigest:
          "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        live: true,
        summary:
          "Production Provider Connection evidence covers guided recipes and generic env while an unregistered provider uses the same OpenTofu execution path.",
        recipes: [
          {
            id: "aws",
            connectionModes: ["provider_connection"],
          },
          {
            id: "cloudflare",
            connectionModes: ["provider_connection"],
          },
          {
            id: "gcp",
            connectionModes: ["provider_connection"],
          },
          {
            id: "github",
            connectionModes: ["provider_connection"],
          },
          {
            id: "kubernetes",
            connectionModes: ["provider_connection"],
          },
        ],
        genericEnvRecipeVerified: true,
        unregisteredProviderExecutionVerified: true,
        recipePresenceUsedAsAdmission: false,
        secretValuesReturned: false,
      },
      costAttribution: {
        evidenceRef:
          "git+ssh://git@github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/cost-attribution.md",
        evidenceDigest:
          "sha256:9999999999999999999999999999999999999999999999999999999999999999",
        live: true,
        summary:
          "Production smoke Space has attributable runner-minute usage and showback billing enabled.",
        usageLedger: {
          spaceId: "space_scratch_001",
          eventCount: 10,
          latestRunIds: ["plan_0123456789abcdef", "apply_0123456789abcdef"],
        },
        billingMode: "showback",
        billingProvider: "manual",
        freshSamples: true,
        publicBillingPlanCount: 0,
      },
      secretBoundary: {
        evidenceRef:
          "git+ssh://git@github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/secret-boundary.md",
        evidenceDigest:
          "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        live: true,
        summary:
          "Live diagnostics, audit payloads, OutputSnapshots, and tenant Worker bindings were checked for operator secret leakage.",
        forbiddenSecretClasses: [
          "providerCredentials",
          "deployControlTokens",
          "stateBackendCredentials",
        ],
        leakTargetsChecked: [
          "runnerDiagnostics",
          "apiPayloads",
          "runPayloads",
          "usagePayloads",
          "hardeningGatePayloads",
        ],
        diagnosticsRedacted: true,
        apiPayloadsRedacted: true,
        runPayloadsRedacted: true,
        usagePayloadsRedacted: true,
        hardeningGatePayloadsRedacted: true,
      },
    },
  };
}

async function writeEvidenceFiles(
  root: string,
  manifest: ReturnType<typeof validManifest>,
): Promise<void> {
  await mkdir(join(root, "evidence"), { recursive: true });
  for (const [name, check] of Object.entries(manifest.checks) as Array<
    [string, { evidenceRef: string; evidenceDigest: string }]
  >) {
    const path = check.evidenceRef.split("#", 2)[1];
    if (!path) throw new Error(`${name} evidenceRef missing path`);
    const content = `${name} live operator evidence\n`;
    check.evidenceDigest = digest(content);
    await writeFile(join(root, path), content);
  }
}

function digest(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}
