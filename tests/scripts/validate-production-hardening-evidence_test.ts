import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  TAKOSUMI_PLATFORM_HARDENING_CONTRIBUTION_KIND,
  type PlatformHardeningContribution,
} from "../../contract/platform-hardening.ts";
import { OSS_PLATFORM_HARDENING_CONTRIBUTION } from "../../deploy/platform/production_hardening.ts";
import {
  PRODUCTION_HARDENING_EVIDENCE_KIND,
  productionHardeningEvidenceTemplate,
  updateProductionHardeningEvidenceDigestsFile,
  validateProductionHardeningEvidence,
  validateProductionHardeningEvidenceFile,
} from "../../scripts/validate-production-hardening-evidence.ts";

test("OSS hardening template is provider and substrate neutral", () => {
  const template = productionHardeningEvidenceTemplate();
  expect(template.kind).toBe(PRODUCTION_HARDENING_EVIDENCE_KIND);
  expect(template.contributions).toHaveLength(1);
  expect(template.contributions[0]?.id).toBe("takosumi-oss");
  expect(template.contributions[0]?.checks.map(({ id }) => id)).toEqual(
    OSS_PLATFORM_HARDENING_CONTRIBUTION.checks.map(({ id }) => id),
  );
  expect(JSON.stringify(template)).not.toMatch(
    /cloudflare|OpenTofuRunnerObject|cloudflare-hello-worker/i,
  );
});

test("validated manifest emits one generic versioned gate bundle", () => {
  const result = validateProductionHardeningEvidence(validManifest());
  expect(result.status).toBe("passed");
  expect(result.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(Object.keys(result.env)).toEqual([
    "TAKOSUMI_PLATFORM_HARDENING_EVIDENCE",
  ]);
  expect(JSON.parse(result.env.TAKOSUMI_PLATFORM_HARDENING_EVIDENCE)).toEqual(
    result.gateEvidence,
  );
  expect(result.gateEvidence.contributions[0]?.checks).toHaveLength(6);
});

test("validator cleanly rejects the retired fixed manifest shape", () => {
  const manifest = validManifest();
  manifest.kind = "takosumi.production-hardening-evidence@v3";
  manifest.checks = { containerSmoke: {} };
  delete manifest.contributions;
  expect(() => validateProductionHardeningEvidence(manifest)).toThrow(
    `kind must be ${PRODUCTION_HARDENING_EVIDENCE_KIND}`,
  );
});

test("validator rejects mutable and fixture evidence refs", () => {
  const mutable = validManifest();
  mutable.contributions[0].checks[0].evidenceRef =
    "git+ssh://git@git.example.net/ops/state.git#evidence/check.json";
  expect(() => validateProductionHardeningEvidence(mutable)).toThrow(
    "must be pinned to an immutable git commit",
  );

  const fixture = validManifest();
  fixture.contributions[0].checks[0].evidenceRef = `git+ssh://git@git.example.net/ops/state.git@${COMMIT}#fixtures/check.json`;
  expect(() => validateProductionHardeningEvidence(fixture)).toThrow(
    "must be non-fixture operator evidence",
  );
});

test("validator uses contributed schemas instead of check-id branches", () => {
  const manifest = validManifest();
  const runner = manifest.contributions[0].checks.find(
    ({ id }: { id: string }) => id === "runner-execution-smoke",
  );
  runner.document.runnerBoundary = "operator-vm-pool";
  expect(validateProductionHardeningEvidence(manifest).status).toBe("passed");

  runner.document.runStatus = "failed";
  expect(() => validateProductionHardeningEvidence(manifest)).toThrow(
    "runStatus must be succeeded",
  );
});

test("operator contribution extends the registry without replacing OSS checks", () => {
  const registry = [OSS_PLATFORM_HARDENING_CONTRIBUTION, OPERATOR_CONTRIBUTION];
  const manifest = validManifest(registry);
  const result = validateProductionHardeningEvidence(manifest, undefined, {
    contributions: registry,
  });
  expect(result.registry.map(({ id }) => id)).toEqual([
    "takosumi-oss",
    "operator-extra",
  ]);
  expect(result.gateEvidence.contributions[1]?.checks[0]?.id).toBe(
    "runtime-attestation",
  );
});

test("validator rejects unknown contribution and missing registered check", () => {
  const unknown = validManifest();
  unknown.contributions.push({
    id: "unknown",
    capability: "unknown.v1",
    checks: [],
  });
  expect(() => validateProductionHardeningEvidence(unknown)).toThrow(
    "unknown contribution unknown",
  );

  const missing = validManifest();
  missing.contributions[0].checks.pop();
  expect(() => validateProductionHardeningEvidence(missing)).toThrow(
    "is missing check secret-boundary",
  );
});

test("evidence file verification and digest update cover every contribution", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "takosumi-hardening-evidence-"));
  try {
    const registry = [
      OSS_PLATFORM_HARDENING_CONTRIBUTION,
      OPERATOR_CONTRIBUTION,
    ];
    const manifest = validManifest(registry);
    await writeEvidenceFiles(tempDir, manifest);
    const manifestPath = join(tempDir, "evidence", "production-hardening.json");
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    await expect(
      validateProductionHardeningEvidenceFile(manifestPath, {
        contributions: registry,
      }),
    ).resolves.toMatchObject({ status: "passed" });

    const first = manifest.contributions[0].checks[0];
    first.evidenceDigest = `sha256:${"0".repeat(64)}`;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    const updated = await updateProductionHardeningEvidenceDigestsFile(
      manifestPath,
      { contributions: registry },
    );
    expect(updated.registry).toHaveLength(2);
    expect(first.evidenceDigest).not.toBe(
      updated.gateEvidence.contributions[0]?.checks[0]?.evidenceDigest,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("digest update does not write a schema-invalid manifest", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "takosumi-hardening-evidence-"));
  try {
    const manifest = validManifest();
    await writeEvidenceFiles(tempDir, manifest);
    const check = manifest.contributions[0].checks.find(
      ({ id }: { id: string }) => id === "secret-boundary",
    );
    delete check.document.apiPayloadsRedacted;
    const manifestPath = join(tempDir, "evidence", "production-hardening.json");
    const original = JSON.stringify(manifest, null, 2);
    await writeFile(manifestPath, original);

    await expect(
      updateProductionHardeningEvidenceDigestsFile(manifestPath),
    ).rejects.toThrow("apiPayloadsRedacted is required");
    expect(await Bun.file(manifestPath).text()).toBe(original);
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
      description: "The operator attests its explicitly selected runtime.",
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

async function writeEvidenceFiles(root: string, manifest: any): Promise<void> {
  for (const contribution of manifest.contributions) {
    for (const check of contribution.checks) {
      const path = check.evidenceRef.split("#", 2)[1];
      const content = `${contribution.id}/${check.id} live operator evidence\n`;
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
      check.evidenceDigest = `sha256:${createHash("sha256")
        .update(content)
        .digest("hex")}`;
    }
  }
}
