import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  TAKOSUMI_PLATFORM_HARDENING_CONTRIBUTION_KIND,
  type PlatformHardeningContribution,
} from "../../contract/platform-hardening.ts";
import {
  evaluateProductionHardeningGates,
  OSS_PLATFORM_HARDENING_CONTRIBUTION,
} from "../../deploy/platform/production_hardening.ts";
import {
  productionHardeningEvidenceTemplate,
  validateProductionHardeningEvidence,
} from "../../scripts/validate-production-hardening-evidence.ts";
import {
  buildProductionHardeningGatePublicSummary,
  formatProductionHardeningGatePublicSummaryMarkdownRow,
  validateProductionHardeningGatePublicSummaryArtifact,
  verifyProductionHardeningGateFiles,
  verifyProductionHardeningGateResponse,
  verifyProductionHardeningGateUrl,
} from "../../scripts/verify-production-hardening-gates.ts";

test("generic gate verification matches the registry and evidence bundle", () => {
  const validation = validateProductionHardeningEvidence(validManifest());
  const response = gateResponse(validation, true);
  const result = verifyProductionHardeningGateResponse(validation, response, {
    requireEnforced: true,
  });
  expect(result.status).toBe("passed");
  expect(result.contributions[0]?.id).toBe("takosumi-oss");
  expect(result.contributions[0]?.checks).toHaveLength(6);
});

test("gate evaluator is fail closed for absent evidence without fixed check fields", () => {
  const result = evaluateProductionHardeningGates({
    TAKOSUMI_PRODUCTION_HARDENING_GATE: "enforce",
  });
  expect(result.ok).toBe(false);
  expect(result.enforced).toBe(true);
  expect(result.configurationErrors).toEqual([]);
  expect(result.contributions).toHaveLength(1);
  expect(result.contributions[0]?.checks[0]).toMatchObject({
    id: "runner-execution-smoke",
    ok: false,
    reason: "missing_evidence",
  });
  expect(result).not.toHaveProperty("checks.containerSmoke");
});

test("gate evaluator composes arbitrary host contributions", () => {
  const registry = [OSS_PLATFORM_HARDENING_CONTRIBUTION, OPERATOR_CONTRIBUTION];
  const validation = validateProductionHardeningEvidence(
    validManifest(registry),
    undefined,
    { contributions: registry },
  );
  const response = gateResponse(validation, true, [OPERATOR_CONTRIBUTION]);
  expect(response.ok).toBe(true);
  expect(response.contributions.map(({ id }) => id)).toEqual([
    "takosumi-oss",
    "operator-extra",
  ]);
  expect(
    verifyProductionHardeningGateResponse(validation, response).status,
  ).toBe("passed");
});

test("gate evaluator rejects registry drift and old fixed response shapes", () => {
  const validation = validateProductionHardeningEvidence(validManifest());
  const driftedBundle = JSON.parse(
    validation.env.TAKOSUMI_PLATFORM_HARDENING_EVIDENCE,
  );
  driftedBundle.contributions[0].checks.push({
    id: "unknown",
    evidenceRef: "git+ssh://git@git.example.net/x.git@" + COMMIT + "#x",
    evidenceDigest: `sha256:${"a".repeat(64)}`,
  });
  const response = evaluateProductionHardeningGates({
    TAKOSUMI_PLATFORM_HARDENING_EVIDENCE: JSON.stringify(driftedBundle),
  });
  expect(response.ok).toBe(false);
  expect(response.configurationErrors).toContain(
    "hardening evidence contribution takosumi-oss has unknown check unknown",
  );
  expect(() =>
    verifyProductionHardeningGateResponse(validation, {
      ok: true,
      enforced: true,
      checks: {},
    }),
  ).toThrow("response kind must be");
});

test("verification rejects digest drift, failed checks, and observe mode", () => {
  const validation = validateProductionHardeningEvidence(validManifest());
  const digestDrift = gateResponse(validation, true) as any;
  digestDrift.contributions[0].checks[0].evidenceDigest = `sha256:${"f".repeat(64)}`;
  expect(() =>
    verifyProductionHardeningGateResponse(validation, digestDrift),
  ).toThrow("evidenceDigest drifted");

  const failed = gateResponse(validation, true) as any;
  failed.ok = false;
  failed.contributions[0].checks[0] = {
    id: "runner-execution-smoke",
    ok: false,
    reason: "missing_evidence_ref",
  };
  expect(() =>
    verifyProductionHardeningGateResponse(validation, failed),
  ).toThrow("response is not ok");

  expect(() =>
    verifyProductionHardeningGateResponse(
      validation,
      gateResponse(validation, false),
      { requireEnforced: true },
    ),
  ).toThrow("gate is not enforced");
});

test("public summary exposes contribution identity but no private refs", () => {
  const validation = validateProductionHardeningEvidence(validManifest());
  const verification = verifyProductionHardeningGateResponse(
    validation,
    gateResponse(validation, true),
  );
  const summary = buildProductionHardeningGatePublicSummary(verification);
  expect(summary.kind).toBe(
    "takosumi.production-hardening-gate-public-summary@v2",
  );
  expect(summary.validator.contributions).toEqual([
    {
      id: "takosumi-oss",
      capability: "platform.hardening.oss-baseline.v1",
    },
  ]);
  expect(summary.privateEvidenceRefClass).toBe("git+ssh://...");
  expect(JSON.stringify(summary)).not.toContain("git.example.net");
  expect(
    validateProductionHardeningGatePublicSummaryArtifact(summary, verification)
      .valid,
  ).toBe(true);
  expect(
    formatProductionHardeningGatePublicSummaryMarkdownRow(summary),
  ).toContain("takosumi-oss");
});

test("public summary rejects legacy kind and contribution drift", () => {
  const validation = validateProductionHardeningEvidence(validManifest());
  const verification = verifyProductionHardeningGateResponse(
    validation,
    gateResponse(validation, true),
  );
  const summary = buildProductionHardeningGatePublicSummary(
    verification,
  ) as any;
  summary.kind = "takosumi.production-hardening-gate-public-summary@v1";
  summary.validator.contributions = [];
  const report = validateProductionHardeningGatePublicSummaryArtifact(
    summary,
    verification,
  );
  expect(report.valid).toBe(false);
  expect(report.errors).toContain(
    "kind must be takosumi.production-hardening-gate-public-summary@v2",
  );
  expect(report.errors).toContain(
    "validator.contributions must match gate verification",
  );
});

test("file verification validates private evidence before gate output", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "takosumi-hardening-gates-"));
  try {
    const manifest = validManifest();
    await writeEvidenceFiles(tempDir, manifest);
    const validation = validateProductionHardeningEvidence(manifest);
    const manifestPath = join(tempDir, "evidence", "production-hardening.json");
    const gatePath = join(tempDir, "hardening-gates.json");
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    await writeFile(
      gatePath,
      JSON.stringify(gateResponse(validation, true), null, 2),
    );
    await expect(
      verifyProductionHardeningGateFiles(manifestPath, gatePath, {
        requireEnforced: true,
      }),
    ).resolves.toMatchObject({ status: "passed", enforced: true });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("URL verification uses bearer auth and generic response", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "takosumi-hardening-url-"));
  try {
    const manifest = validManifest();
    await writeEvidenceFiles(tempDir, manifest);
    const validation = validateProductionHardeningEvidence(manifest);
    const manifestPath = join(tempDir, "evidence", "production-hardening.json");
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    const seen: Request[] = [];
    const result = await verifyProductionHardeningGateUrl(
      manifestPath,
      "https://operator.example/internal/platform/hardening-gates",
      {
        bearerToken: "operator-token",
        fetch: (request, init) => {
          seen.push(new Request(request, init));
          return Promise.resolve(Response.json(gateResponse(validation, true)));
        },
      },
    );
    expect(result.status).toBe("passed");
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer operator-token");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

const OPERATOR_CONTRIBUTION = {
  kind: TAKOSUMI_PLATFORM_HARDENING_CONTRIBUTION_KIND,
  id: "operator-extra",
  capability: "operator.runtime-attestation.v1",
  checks: [
    {
      id: "runtime-attestation",
      title: "Runtime attestation",
      description: "Attests the selected operator runtime.",
      evidenceSchema: {
        required: ["runtime", "attested"],
        properties: {
          runtime: { type: "string" },
          attested: { type: "boolean", const: true },
        },
      },
    },
  ],
} as const satisfies PlatformHardeningContribution;

function validManifest(
  registry: readonly PlatformHardeningContribution[] = [
    OSS_PLATFORM_HARDENING_CONTRIBUTION,
  ],
): any {
  const manifest = productionHardeningEvidenceTemplate({
    contributions: registry,
  }) as any;
  for (const contribution of manifest.contributions) {
    for (const check of contribution.checks) {
      check.evidenceRef =
        `git+ssh://git@git.example.net/ops/state.git@${COMMIT}` +
        `#evidence/${contribution.id}/${check.id}.json`;
      check.evidenceDigest = `sha256:${"a".repeat(64)}`;
    }
  }
  return manifest;
}

function gateResponse(
  validation: ReturnType<typeof validateProductionHardeningEvidence>,
  enforced: boolean,
  additional: readonly PlatformHardeningContribution[] = [],
) {
  return evaluateProductionHardeningGates({
    TAKOSUMI_PRODUCTION_HARDENING_GATE: enforced ? "enforce" : "observe",
    TAKOSUMI_PLATFORM_HARDENING_CONTRIBUTIONS: additional,
    TAKOSUMI_PLATFORM_HARDENING_EVIDENCE:
      validation.env.TAKOSUMI_PLATFORM_HARDENING_EVIDENCE,
  });
}

async function writeEvidenceFiles(root: string, manifest: any): Promise<void> {
  for (const contribution of manifest.contributions) {
    for (const check of contribution.checks) {
      const path = check.evidenceRef.split("#", 2)[1];
      const content = `${contribution.id}/${check.id} live evidence\n`;
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
      check.evidenceDigest = `sha256:${createHash("sha256")
        .update(content)
        .digest("hex")}`;
    }
  }
}
