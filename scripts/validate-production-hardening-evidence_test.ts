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
} from "./validate-production-hardening-evidence.ts";

test("production hardening evidence template carries every required check", () => {
  const template = productionHardeningEvidenceTemplate();
  expect(template.kind).toBe(PRODUCTION_HARDENING_EVIDENCE_KIND);
  expect(Object.keys(template.checks).sort()).toEqual([
    "containerSmoke",
    "egressEnforcement",
    "providerTemplates",
    "secretBoundary",
  ]);
  expect(template.checks.providerTemplates.verifiedSpaceProviders).toEqual([
    "aws",
    "gcp",
    "github",
    "kubernetes",
  ]);
  expect(template.checks.secretBoundary.leakTargetsChecked).toContain(
    "outputSnapshots",
  );
});

test("production hardening evidence manifest emits hardening gate env", () => {
  const result = validateProductionHardeningEvidence(validManifest());

  expect(result.status).toBe("passed");
  expect(result.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(result.env).toMatchObject({
    TAKOSUMI_CLOUDFLARE_CONTAINER_SMOKE_EVIDENCE_REF:
      "git+ssh://git@github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/container-smoke.md",
    TAKOSUMI_EGRESS_ENFORCEMENT_EVIDENCE_REF:
      "git+ssh://git@github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/egress.md",
    TAKOSUMI_PROVIDER_CATALOG_EVIDENCE_REF:
      "git+ssh://git@github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/provider-catalog.md",
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
    "failureAuditPayloads",
    "outputSnapshots",
  ];

  expect(() => validateProductionHardeningEvidence(manifest)).toThrow(
    "secretBoundary.leakTargetsChecked is missing tenantWorkerBindings",
  );
});

test("production hardening evidence requires provider templates coverage", () => {
  const manifest = validManifest();
  manifest.checks.providerTemplates.verifiedSpaceProviders = [
    "aws",
    "gcp",
    "github",
  ];

  expect(() => validateProductionHardeningEvidence(manifest)).toThrow(
    "providerTemplates.verifiedSpaceProviders is missing kubernetes",
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
    expect(updated.checks.providerTemplates.evidenceDigest).toBe(
      expectedDigests.providerTemplates,
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
    manifest.checks.providerTemplates.verifiedSpaceProviders = ["aws", "gcp"];
    manifest.checks.containerSmoke.evidenceDigest =
      "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    const manifestPath = join(tempDir, "evidence", "production-hardening.json");
    const original = JSON.stringify(manifest, null, 2);
    await writeFile(manifestPath, original);

    await expect(
      updateProductionHardeningEvidenceDigestsFile(manifestPath),
    ).rejects.toThrow(
      "providerTemplates.verifiedSpaceProviders is missing github",
    );
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
      egressEnforcement: {
        evidenceRef:
          "git+ssh://git@github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/egress.md",
        evidenceDigest:
          "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        live: true,
        summary:
          "Dispatch namespace outbound Worker allowed a policy host and denied a non-policy host.",
        dispatchNamespace: "takosumi-platform-prod",
        outboundWorkerConfigured: true,
        allowProbe: {
          host: "api.cloudflare.com",
          result: "allowed",
        },
        denyProbe: {
          host: "metadata.google.internal",
          result: "denied",
        },
      },
      providerTemplates: {
        evidenceRef:
          "git+ssh://git@github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/provider-catalog.md",
        evidenceDigest:
          "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        live: true,
        summary:
          "Provider Template records Cloudflare as managed default and AWS/GCP/GitHub/Kubernetes as verified Space providers.",
        cloudflareManagedDefault: {
          primaryCredentialSource: "takosumi_managed",
          defaultEligible: true,
        },
        verifiedSpaceProviders: ["aws", "gcp", "github", "kubernetes"],
        providerEnvSet: {
          providerPinRequired: true,
          egressPolicyRequired: true,
          customRunnerClassRequired: true,
          operatorDefaultAllowed: false,
        },
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
          "failureAuditPayloads",
          "outputSnapshots",
          "tenantWorkerBindings",
        ],
        diagnosticsRedacted: true,
        auditPayloadsRedacted: true,
        outputSnapshotsRedacted: true,
        tenantWorkerBindingsRedacted: true,
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
