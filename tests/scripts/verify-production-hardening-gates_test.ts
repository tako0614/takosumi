import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PRODUCTION_HARDENING_EVIDENCE_KIND,
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

test("production hardening gate verification matches live response to manifest env", () => {
  const manifest = validManifest();
  const manifestValidation = validateProductionHardeningEvidence(manifest);
  const result = verifyProductionHardeningGateResponse(
    manifestValidation,
    gateResponse(manifest),
    { requireEnforced: true },
  );

  expect(result.status).toBe("passed");
  expect(result.enforced).toBe(true);
  expect(result.environment).toBe("production");
  expect(result.generatedAt).toBe("2026-06-08T00:00:00.000Z");
  expect(result.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(result.checks.providerCatalog.evidenceRef).toBe(
    manifest.checks.providerCatalog.evidenceRef,
  );
});

test("production hardening gate verification emits a public-safe summary artifact", () => {
  const manifest = validManifest();
  const result = verifyProductionHardeningGateResponse(
    validateProductionHardeningEvidence(manifest),
    gateResponse(manifest),
    { requireEnforced: true },
  );

  const summary = buildProductionHardeningGatePublicSummary(result);

  expect(summary.kind).toBe(
    "takosumi.production-hardening-gate-public-summary@v1",
  );
  expect(summary.status).toBe("enforced");
  expect(summary.date).toBe("2026-06-08");
  expect(summary.environment).toBe("production");
  expect(summary.validator.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect("checkCount" in summary.validator).toBe(false);
  expect("checks" in summary.validator).toBe(false);
  expect(summary.privateEvidenceRefClass).toBe("git+ssh://...");
  expect(JSON.stringify(summary)).not.toContain("takosumi-private.git");
  expect(JSON.stringify(summary)).not.toContain("evidence/container-smoke.md");
});

test("production hardening gate public summary validation accepts generated summaries", () => {
  const manifest = validManifest();
  const result = verifyProductionHardeningGateResponse(
    validateProductionHardeningEvidence(manifest),
    gateResponse(manifest),
    { requireEnforced: true },
  );

  const report = validateProductionHardeningGatePublicSummaryArtifact(
    buildProductionHardeningGatePublicSummary(result),
    result,
  );

  expect(report.kind).toBe(
    "takosumi.production-hardening-gate-public-summary-report@v1",
  );
  expect(report.valid).toBe(true);
  expect(report.enforced).toBe(true);
  expect(report.errors).toEqual([]);
});

test("production hardening gate public summary validation rejects drift", () => {
  const manifest = validManifest();
  const result = verifyProductionHardeningGateResponse(
    validateProductionHardeningEvidence(manifest),
    gateResponse(manifest),
    { requireEnforced: true },
  );
  const summary: any = buildProductionHardeningGatePublicSummary(result);
  summary.validator.manifestDigest =
    "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  summary.privateEvidenceRefClass =
    "git+ssh://git@github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/container-smoke.md";
  summary.validator.checks = ["containerSmoke"];

  const report = validateProductionHardeningGatePublicSummaryArtifact(
    summary,
    result,
  );

  expect(report.valid).toBe(false);
  expect(report.errors).toContain(
    "validator.manifestDigest must match manifest digest",
  );
  expect(report.errors).toContain(
    "privateEvidenceRefClass must match redacted evidence refs",
  );
  expect(report.errors).toContain(
    "privateEvidenceRefClass must be a redacted scheme class",
  );
  expect(report.errors).toContain(
    "validator.checks is not public summary material",
  );
});

test("production hardening gate CLI validates a public summary file", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "takosumi-hardening-summary-"));
  try {
    const manifest = validManifest();
    await writeEvidenceFiles(tempDir, manifest);
    const manifestPath = join(tempDir, "evidence", "production-hardening.json");
    const gatePath = join(tempDir, "hardening-gates.json");
    const summaryPath = join(tempDir, "hardening-public-summary.json");
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    await writeFile(gatePath, JSON.stringify(gateResponse(manifest), null, 2));
    const verification = await verifyProductionHardeningGateFiles(
      manifestPath,
      gatePath,
      { requireEnforced: true },
    );
    await writeFile(
      summaryPath,
      JSON.stringify(
        buildProductionHardeningGatePublicSummary(verification),
        null,
        2,
      ),
    );

    const result = await runVerifierCli([
      manifestPath,
      gatePath,
      "--public-summary-file",
      summaryPath,
      "--require-enforced",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout);
    expect(report.valid).toBe(true);
    expect(report.kind).toBe(
      "takosumi.production-hardening-gate-public-summary-report@v1",
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("production hardening gate CLI rejects a drifted public summary file", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "takosumi-hardening-summary-"));
  try {
    const manifest = validManifest();
    await writeEvidenceFiles(tempDir, manifest);
    const manifestPath = join(tempDir, "evidence", "production-hardening.json");
    const gatePath = join(tempDir, "hardening-gates.json");
    const summaryPath = join(tempDir, "hardening-public-summary.json");
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    await writeFile(gatePath, JSON.stringify(gateResponse(manifest), null, 2));
    const verification = await verifyProductionHardeningGateFiles(
      manifestPath,
      gatePath,
      { requireEnforced: true },
    );
    const summary: any =
      buildProductionHardeningGatePublicSummary(verification);
    summary.validator.manifestDigest =
      "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    await writeFile(summaryPath, JSON.stringify(summary, null, 2));

    const result = await runVerifierCli([
      manifestPath,
      gatePath,
      "--public-summary-file",
      summaryPath,
      "--require-enforced",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout);
    expect(report.valid).toBe(false);
    expect(report.errors).toContain(
      "validator.manifestDigest must match manifest digest",
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("production hardening gate verification emits a markdown row", () => {
  const manifest = validManifest();
  const result = verifyProductionHardeningGateResponse(
    validateProductionHardeningEvidence(manifest),
    gateResponse(manifest),
    { requireEnforced: true },
  );

  const row = formatProductionHardeningGatePublicSummaryMarkdownRow(
    buildProductionHardeningGatePublicSummary(result),
  );

  expect(row.startsWith("| 2026-06-08 | enforced | production |")).toBe(true);
  expect(row).toContain("platform-hardening-gates");
  expect(row).toContain("git+ssh://...");
  expect(row).toContain(`sha256:`);
  expect(row).not.toContain("takosumi-private.git");
});

test("production hardening gate public summary rejects sensitive text", () => {
  const manifest = validManifest();
  const result = verifyProductionHardeningGateResponse(
    validateProductionHardeningEvidence(manifest),
    gateResponse(manifest),
    { requireEnforced: true },
  );

  expect(() =>
    buildProductionHardeningGatePublicSummary(
      result,
      "Hardening passed for AWS account 123456789012 with bearer secret_token_value.",
    ),
  ).toThrow("--public-summary must not contain secrets or bearer tokens");
});

test("production hardening gate public summary rejects private evidence refs", () => {
  const manifest = validManifest();
  const result = verifyProductionHardeningGateResponse(
    validateProductionHardeningEvidence(manifest),
    gateResponse(manifest),
    { requireEnforced: true },
  );

  expect(() =>
    buildProductionHardeningGatePublicSummary(
      result,
      "Hardening passed with git+ssh://git@github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/container-smoke.md attached.",
    ),
  ).toThrow("--public-summary must not contain private evidence refs");
});

test("production hardening gate verification rejects digest drift", () => {
  const manifest = validManifest();
  const response = gateResponse(manifest);
  response.checks.secretBoundary.evidenceDigest =
    "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

  expect(() =>
    verifyProductionHardeningGateResponse(
      validateProductionHardeningEvidence(manifest),
      response,
    ),
  ).toThrow("production hardening gate secretBoundary evidenceDigest drifted");
});

test("production hardening gate verification rejects failed checks", () => {
  const manifest = validManifest();
  const response = gateResponse(manifest);
  response.ok = false;
  response.checks.egressEnforcement = {
    ok: false,
    reason: "missing_evidence_ref",
  };

  expect(() =>
    verifyProductionHardeningGateResponse(
      validateProductionHardeningEvidence(manifest),
      response,
    ),
  ).toThrow("production hardening gate response is not ok");
});

test("production hardening gate verification can require enforce mode", () => {
  const manifest = validManifest();
  const response = gateResponse(manifest);
  response.enforced = false;

  expect(() =>
    verifyProductionHardeningGateResponse(
      validateProductionHardeningEvidence(manifest),
      response,
      { requireEnforced: true },
    ),
  ).toThrow("production hardening gate is not enforced");
});

test("production hardening gate file verification validates evidence files first", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "takosumi-hardening-gates-"));
  try {
    const manifest = validManifest();
    await writeEvidenceFiles(tempDir, manifest);
    const manifestPath = join(tempDir, "evidence", "production-hardening.json");
    const gatePath = join(tempDir, "hardening-gates.json");
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    await writeFile(gatePath, JSON.stringify(gateResponse(manifest), null, 2));

    const result = await verifyProductionHardeningGateFiles(
      manifestPath,
      gatePath,
      { requireEnforced: true },
    );

    expect(result.status).toBe("passed");
    expect(result.checks.containerSmoke.evidenceDigest).toBe(
      manifest.checks.containerSmoke.evidenceDigest,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("production hardening gate URL verification fetches the live internal gate with bearer auth", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "takosumi-hardening-gate-url-"));
  try {
    const manifest = validManifest();
    await writeEvidenceFiles(tempDir, manifest);
    const manifestPath = join(tempDir, "evidence", "production-hardening.json");
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    const fetchCalls: Array<{
      readonly url: string;
      readonly authorization: string | null;
    }> = [];

    const result = await verifyProductionHardeningGateUrl(
      manifestPath,
      "https://app.takosumi.com/internal/platform/hardening-gates",
      {
        requireEnforced: true,
        bearerToken: "operator-token",
        fetch: ((input, init) => {
          const url = input instanceof URL ? input.href : String(input);
          const headers = new Headers(init?.headers);
          fetchCalls.push({
            url,
            authorization: headers.get("authorization"),
          });
          return Promise.resolve(
            Response.json(gateResponse(manifest), { status: 200 }),
          );
        }) as typeof fetch,
      },
    );

    expect(result.status).toBe("passed");
    expect(fetchCalls).toEqual([
      {
        url: "https://app.takosumi.com/internal/platform/hardening-gates",
        authorization: "Bearer operator-token",
      },
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("production hardening gate URL verification requires a bearer token", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "takosumi-hardening-gate-url-"));
  try {
    const manifest = validManifest();
    await writeEvidenceFiles(tempDir, manifest);
    const manifestPath = join(tempDir, "evidence", "production-hardening.json");
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    await expect(
      verifyProductionHardeningGateUrl(
        manifestPath,
        "https://app.takosumi.com/internal/platform/hardening-gates",
      ),
    ).rejects.toThrow("production hardening gate bearer token is required");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function gateResponse(manifest: ReturnType<typeof validManifest>): any {
  return {
    ok: true,
    enforced: true,
    checks: {
      containerSmoke: {
        ok: true,
        evidenceRef: manifest.checks.containerSmoke.evidenceRef,
        evidenceDigest: manifest.checks.containerSmoke.evidenceDigest,
      },
      platformControlPlaneSmoke: {
        ok: true,
        evidenceRef: manifest.checks.platformControlPlaneSmoke.evidenceRef,
        evidenceDigest:
          manifest.checks.platformControlPlaneSmoke.evidenceDigest,
      },
      egressEnforcement: {
        ok: true,
        evidenceRef: manifest.checks.egressEnforcement.evidenceRef,
        evidenceDigest: manifest.checks.egressEnforcement.evidenceDigest,
      },
      restoreRehearsal: {
        ok: true,
        evidenceRef: manifest.checks.restoreRehearsal.evidenceRef,
        evidenceDigest: manifest.checks.restoreRehearsal.evidenceDigest,
      },
      providerCatalog: {
        ok: true,
        evidenceRef: manifest.checks.providerCatalog.evidenceRef,
        evidenceDigest: manifest.checks.providerCatalog.evidenceDigest,
      },
      costAttribution: {
        ok: true,
        evidenceRef: manifest.checks.costAttribution.evidenceRef,
        evidenceDigest: manifest.checks.costAttribution.evidenceDigest,
      },
      secretBoundary: {
        ok: true,
        evidenceRef: manifest.checks.secretBoundary.evidenceRef,
        evidenceDigest: manifest.checks.secretBoundary.evidenceDigest,
      },
    },
  };
}

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
        runnerProfileId: "cloudflare-default",
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
      providerCatalog: {
        evidenceRef:
          "git+ssh://git@github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/provider-catalog.md",
        evidenceDigest:
          "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        live: true,
        summary:
          "Production Provider Catalog returned only own-key provider metadata and no Cloud-only Gateway or secret projection.",
        providers: [
          { id: "aws", ownershipOptions: ["own_key"] },
          { id: "cloudflare", ownershipOptions: ["own_key"] },
          { id: "gcp", ownershipOptions: ["own_key"] },
          { id: "github", ownershipOptions: ["own_key"] },
          { id: "kubernetes", ownershipOptions: ["own_key"] },
        ],
        cloudOnlyGatewayProjectionReturned: false,
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
    check.evidenceDigest = `sha256:${createHash("sha256")
      .update(content)
      .digest("hex")}`;
    await writeFile(join(root, path), content);
  }
}

async function runVerifierCli(args: string[]): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const proc = Bun.spawn(
    [
      process.execPath,
      join(
        import.meta.dir,
        "../../scripts/verify-production-hardening-gates.ts",
      ),
      ...args,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}
