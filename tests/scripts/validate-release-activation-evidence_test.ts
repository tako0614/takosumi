import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RELEASE_ACTIVATION_EVIDENCE_KIND,
  releaseActivationEvidenceTemplate,
  updateReleaseActivationEvidenceDigestsFile,
  validateReleaseActivationEvidence,
  validateReleaseActivationEvidenceFile,
} from "../../scripts/validate-release-activation-evidence.ts";

test("release activation evidence template carries every required check", () => {
  const template = releaseActivationEvidenceTemplate();
  expect(template.kind).toBe(RELEASE_ACTIVATION_EVIDENCE_KIND);
  expect(Object.keys(template.checks).sort()).toEqual([
    "failureSurfacing",
    "ledgerIndependence",
    "payloadBoundary",
    "successfulActivation",
  ]);
  expect(template.checks.successfulActivation.webhookPayloadKind).toBe(
    "takosumi.operator.release-activation@v1",
  );
  expect(template.checks.successfulActivation.finalModel).toMatchObject({
    workspaceId: "<workspace-id>",
    projectId: "<project-id>",
    capsuleId: "<capsule-id>",
  });
  expect(Object.keys(template.checks.successfulActivation)).not.toContain(
    `legacy${"Runtime"}Ids`,
  );
  expect(template.checks.successfulActivation.activationRecordId).toBe(
    "<activation-record-id>",
  );
  expect(template.checks.payloadBoundary.forbiddenSecretClasses).toEqual([
    "providerCredentials",
    "runnerEnv",
    "secretOutputs",
    "releaseActivatorToken",
  ]);
});

test("release activation evidence manifest emits gate env", () => {
  const result = validateReleaseActivationEvidence(validManifest());

  expect(result.status).toBe("passed");
  expect(result.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(result.env).toMatchObject({
    TAKOSUMI_RELEASE_ACTIVATION_SUCCESS_EVIDENCE_REF:
      "git+ssh://git@github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/release-activation-success.md",
    TAKOSUMI_RELEASE_ACTIVATION_FAILURE_SURFACING_EVIDENCE_REF:
      "git+ssh://git@github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/release-activation-failure-surfacing.md",
    TAKOSUMI_RELEASE_ACTIVATION_LEDGER_INDEPENDENCE_EVIDENCE_REF:
      "git+ssh://git@github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/release-activation-ledger-independence.md",
    TAKOSUMI_RELEASE_ACTIVATION_PAYLOAD_BOUNDARY_EVIDENCE_REF:
      "git+ssh://git@github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/release-activation-payload-boundary.md",
  });
});

test("release activation evidence rejects mutable refs", () => {
  const manifest = validManifest();
  manifest.checks.successfulActivation.evidenceRef =
    "git+ssh://git@github.com/tako0614/takosumi-private.git#evidence/release-activation-success.md";

  expect(() => validateReleaseActivationEvidence(manifest)).toThrow(
    "successfulActivation.evidenceRef must be pinned to an immutable git commit",
  );
});

test("release activation evidence rejects fixture refs", () => {
  const manifest = validManifest();
  manifest.checks.successfulActivation.evidenceRef =
    "git+https://example.com/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/release-activation-success.md";

  expect(() => validateReleaseActivationEvidence(manifest)).toThrow(
    "successfulActivation.evidenceRef must be non-fixture operator evidence",
  );
});

test("release activation evidence requires a successful activation", () => {
  const manifest = validManifest();
  manifest.checks.successfulActivation.activationStatus = "pending";

  expect(() => validateReleaseActivationEvidence(manifest)).toThrow(
    "successfulActivation.activationStatus must be succeeded",
  );
});

test("release activation evidence requires failure surfacing in both surfaces", () => {
  const manifest = validManifest();
  manifest.checks.failureSurfacing.surfacedIn = ["activity"];

  expect(() => validateReleaseActivationEvidence(manifest)).toThrow(
    "failureSurfacing.surfacedIn is missing runTimeline",
  );
});

test("release activation evidence requires ledger independence", () => {
  const manifest = validManifest();
  manifest.checks.ledgerIndependence.activationDoesNotRollbackApplyLedger =
    false;

  expect(() => validateReleaseActivationEvidence(manifest)).toThrow(
    "ledgerIndependence.activationDoesNotRollbackApplyLedger must be true",
  );
});

test("release activation evidence requires failure surfacing and ledger refs to match", () => {
  const manifest = validManifest();
  manifest.checks.ledgerIndependence.applyRunId = "run_apply_other";

  expect(() => validateReleaseActivationEvidence(manifest)).toThrow(
    "ledgerIndependence.applyRunId must match failureSurfacing.applyRunId",
  );
});

test("release activation evidence requires payload boundary redaction", () => {
  const manifest = validManifest();
  manifest.checks.payloadBoundary.payloadContainsRunnerEnv = true;

  expect(() => validateReleaseActivationEvidence(manifest)).toThrow(
    "payloadBoundary.payloadContainsRunnerEnv must be false",
  );
});

test("release activation evidence file verifies evidence file digests", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "takosumi-release-evidence-"));
  try {
    const manifest = validManifest();
    await writeEvidenceFiles(tempDir, manifest);
    const manifestPath = join(tempDir, "evidence", "release-activation.json");
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    const result = await validateReleaseActivationEvidenceFile(manifestPath);
    expect(result.status).toBe("passed");

    manifest.checks.payloadBoundary.evidenceDigest =
      "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    await expect(
      validateReleaseActivationEvidenceFile(manifestPath),
    ).rejects.toThrow("payloadBoundary.evidenceDigest does not match");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("release activation evidence file can update evidence digests", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "takosumi-release-evidence-"));
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

    const manifestPath = join(tempDir, "evidence", "release-activation.json");
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    const result =
      await updateReleaseActivationEvidenceDigestsFile(manifestPath);
    const updated = JSON.parse(await Bun.file(manifestPath).text());

    expect(result.status).toBe("passed");
    expect(updated.checks.successfulActivation.evidenceDigest).toBe(
      expectedDigests.successfulActivation,
    );
    expect(updated.checks.failureSurfacing.evidenceDigest).toBe(
      expectedDigests.failureSurfacing,
    );
    expect(updated.checks.ledgerIndependence.evidenceDigest).toBe(
      expectedDigests.ledgerIndependence,
    );
    expect(updated.checks.payloadBoundary.evidenceDigest).toBe(
      expectedDigests.payloadBoundary,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("release activation evidence digest update does not write invalid manifests", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "takosumi-release-evidence-"));
  try {
    const manifest = validManifest();
    await writeEvidenceFiles(tempDir, manifest);
    manifest.checks.payloadBoundary.forbiddenSecretClasses = [
      "providerCredentials",
      "runnerEnv",
      "secretOutputs",
    ];
    manifest.checks.successfulActivation.evidenceDigest =
      "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    const manifestPath = join(tempDir, "evidence", "release-activation.json");
    const original = JSON.stringify(manifest, null, 2);
    await writeFile(manifestPath, original);

    await expect(
      updateReleaseActivationEvidenceDigestsFile(manifestPath),
    ).rejects.toThrow(
      "payloadBoundary.forbiddenSecretClasses is missing releaseActivatorToken",
    );
    expect(await Bun.file(manifestPath).text()).toBe(original);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function validManifest(): any {
  return {
    kind: RELEASE_ACTIVATION_EVIDENCE_KIND,
    generatedAt: "2026-06-21T00:00:00.000Z",
    environment: "production",
    checks: {
      successfulActivation: {
        evidenceRef:
          "git+ssh://git@github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/release-activation-success.md",
        evidenceDigest:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        live: true,
        summary:
          "Post-apply materializer published the app and the public health check passed.",
        platformUrl: "https://app.takosumi.com",
        webhookPayloadKind: "takosumi.operator.release-activation@v1",
        planRunId: "run_plan_1",
        applyRunId: "run_apply_1",
        finalModel: {
          workspaceId: "workspace_1",
          projectId: "project_1",
          capsuleId: "capsule_1",
          stateVersionId: "state_1",
          outputId: "output_1",
        },
        providerConnectionId: "pc_1",
        activationRecordId: "actrec_1",
        sourceSnapshotId: "snap_1",
        stateGeneration: 3,
        materializedResourceKind: "cloudflare-worker-script",
        activationStatus: "succeeded",
        launchUrl: "https://site.example.test",
        healthUrl: "https://site.example.test/healthz",
        healthStatus: 200,
        nonSensitiveOutputKeys: ["public_url", "worker_script_name"],
      },
      failureSurfacing: {
        evidenceRef:
          "git+ssh://git@github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/release-activation-failure-surfacing.md",
        evidenceDigest:
          "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        live: true,
        summary:
          "A failed release activation stayed visible in Activity and the run timeline.",
        applyRunId: "run_apply_1",
        activityEventId: "act_release_1",
        activationStatus: "failed",
        surfacedIn: ["activity", "runTimeline"],
        messageRedacted: true,
        applyRunStatus: "succeeded",
        activationRecordStatus: "active",
      },
      ledgerIndependence: {
        evidenceRef:
          "git+ssh://git@github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/release-activation-ledger-independence.md",
        evidenceDigest:
          "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        live: true,
        summary:
          "Apply ledger, StateVersion, Output, and activation record stayed committed after activation failure.",
        applyRunId: "run_apply_1",
        activityEventId: "act_release_1",
        stateVersionId: "state_1",
        outputId: "output_1",
        activationRecordId: "actrec_1",
        applyCommittedBeforeActivation: true,
        stateVersionRetained: true,
        outputRetained: true,
        activationRecordRetained: true,
        activationDoesNotRollbackApplyLedger: true,
      },
      payloadBoundary: {
        evidenceRef:
          "git+ssh://git@github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/release-activation-payload-boundary.md",
        evidenceDigest:
          "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        live: true,
        summary:
          "Captured webhook payload contained only non-sensitive refs and outputs.",
        payloadKind: "takosumi.operator.release-activation@v1",
        forbiddenSecretClasses: [
          "providerCredentials",
          "runnerEnv",
          "secretOutputs",
          "releaseActivatorToken",
        ],
        payloadContainsProviderCredentials: false,
        payloadContainsRunnerEnv: false,
        payloadContainsSecretOutputs: false,
        authorizationHeaderRedacted: true,
        nonSensitiveOutputsOnly: true,
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
