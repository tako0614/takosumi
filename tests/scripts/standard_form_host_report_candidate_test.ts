import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ExecutedCurrentFormHostReport,
  HostReportManifest,
} from "../../scripts/lib/standard-form-host-report-candidate.ts";
import {
  finalizeSignedHostReportCandidate,
  HOST_REPORT_CHECKSUMS_BUNDLE_NAME,
  HOST_REPORT_MANIFEST_NAME,
  verifySignedHostReportCandidate,
  verifyUnsignedHostReportCandidate,
  writeUnsignedHostReportCandidate,
} from "../../scripts/lib/standard-form-host-report-candidate.ts";
import {
  TAKOFORM_IDEMPOTENCY_ISOLATION_DIMENSIONS,
  TAKOFORM_IDEMPOTENCY_REPLAY_DENIALS,
  TAKOFORM_PLAN_BINDING_INSTRUMENTED_INPUTS,
  TAKOFORM_PLAN_BINDING_PURE_INPUTS,
  TAKOFORM_PORTABLE_HOST_EXPECTED_GENERATION_TRANSITIONS,
  TAKOFORM_PORTABLE_HOST_EXPECTED_NEGATIVE_FIXTURES,
  TAKOFORM_PORTABLE_HOST_REQUIRED_INTERFACE_CHECKS,
  TAKOFORM_PORTABLE_HOST_REQUIRED_RUNNER_CHECKS,
  TAKOFORM_PORTABLE_HOST_RUNNER_INPUT_DIGEST,
  type TakoformPortableHostRunnerReport,
} from "../../scripts/lib/takoform-portable-host-evidence.ts";

const SOURCE = "1".repeat(40);
const TAKOFORM_SOURCE = "2".repeat(40);
const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";
const REQUIRED_CHECKS = [
  "apply",
  "read",
  "update",
  "delete-idempotency",
  "import-idempotency",
  "observe",
  "refresh",
  "drift",
] as const;

test("current host report candidate preserves ten exact mixed identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-host-report-test-"));
  try {
    const manifest = await writeUnsignedHostReportCandidate({
      outputRoot: root,
      sourceCommit: SOURCE,
      takoformSourceCommit: TAKOFORM_SOURCE,
      requestId: REQUEST_ID,
      reports: reports(),
      portableRunnerReport: runnerReport(),
    });
    expect(manifest.reports).toHaveLength(10);
    expect(
      new Set(
        manifest.reports.map(
          ({ identity }) => identity.formRef.definitionVersion,
        ),
      ),
    ).toEqual(new Set(["2.0.0", "3.0.0"]));
    expect(manifest.generation).toBe("ga-core-v2");
    expect(
      await verifyUnsignedHostReportCandidate(root, {
        sourceCommit: SOURCE,
        takoformSourceCommit: TAKOFORM_SOURCE,
        requestId: REQUEST_ID,
      }),
    ).toEqual(manifest);

    for (const entry of manifest.reports) {
      await writeFile(
        join(root, entry.bundlePath),
        JSON.stringify({ mediaType: "application/test", kind: entry.kind }),
        { flag: "wx" },
      );
    }
    await writeFile(
      join(root, manifest.portableRunner.bundlePath),
      JSON.stringify({ mediaType: "application/test", kind: "portable-runner" }),
      { flag: "wx" },
    );
    const signed = await finalizeSignedHostReportCandidate({
      outputRoot: root,
      sourceCommit: SOURCE,
      takoformSourceCommit: TAKOFORM_SOURCE,
      requestId: REQUEST_ID,
      workflowRunId: "12345",
      workflowRunAttempt: 1,
    });
    expect(signed.entries).toHaveLength(10);
    expect(signed.requestId).toBe(REQUEST_ID);
    expect(signed.workflowRunId).toBe("12345");
    expect(signed.workflowRunAttempt).toBe(1);
    expect(signed.source.commit).toBe(SOURCE);
    expect(signed.takoformSource.commit).toBe(TAKOFORM_SOURCE);
    expect(signed.portableRunner.reportDigest).toBe(
      manifest.portableRunner.digest,
    );
    expect(signed.closure).toEqual({
      checksumsPath: "SHA256SUMS",
      bundlePath: HOST_REPORT_CHECKSUMS_BUNDLE_NAME,
      certificateIdentity:
        "https://github.com/tako0614/takosumi/.github/workflows/standard-form-host-report.yml@refs/heads/main",
    });
    await expect(
      verifySignedHostReportCandidate(root, {
        sourceCommit: SOURCE,
        takoformSourceCommit: TAKOFORM_SOURCE,
        requestId: REQUEST_ID,
        workflowRunId: "12345",
        workflowRunAttempt: 1,
      }),
    ).rejects.toThrow();
    await writeFile(
      join(root, HOST_REPORT_CHECKSUMS_BUNDLE_NAME),
      JSON.stringify({ mediaType: "application/test", kind: "closure" }),
      { flag: "wx" },
    );
    expect(
      await verifySignedHostReportCandidate(root, {
        sourceCommit: SOURCE,
        takoformSourceCommit: TAKOFORM_SOURCE,
        requestId: REQUEST_ID,
        workflowRunId: "12345",
        workflowRunAttempt: 1,
      }),
    ).toEqual(signed);
    await expect(
      verifySignedHostReportCandidate(root, {
        sourceCommit: "3".repeat(40),
        takoformSourceCommit: TAKOFORM_SOURCE,
        requestId: REQUEST_ID,
        workflowRunId: "12345",
        workflowRunAttempt: 1,
      }),
    ).rejects.toThrow();
    await expect(
      verifySignedHostReportCandidate(root, {
        sourceCommit: SOURCE,
        takoformSourceCommit: "4".repeat(40),
        requestId: REQUEST_ID,
        workflowRunId: "12345",
        workflowRunAttempt: 1,
      }),
    ).rejects.toThrow();
    await expect(
      verifySignedHostReportCandidate(root, {
        sourceCommit: SOURCE,
        takoformSourceCommit: TAKOFORM_SOURCE,
        requestId: "123e4567-e89b-42d3-a456-426614174001",
        workflowRunId: "12345",
        workflowRunAttempt: 1,
      }),
    ).rejects.toThrow();
    await expect(
      verifySignedHostReportCandidate(root, {
        sourceCommit: SOURCE,
        takoformSourceCommit: TAKOFORM_SOURCE,
        requestId: REQUEST_ID,
        workflowRunId: "12346",
        workflowRunAttempt: 1,
      }),
    ).rejects.toThrow();
    await expect(
      verifySignedHostReportCandidate(root, {
        sourceCommit: SOURCE,
        takoformSourceCommit: TAKOFORM_SOURCE,
        requestId: REQUEST_ID,
        workflowRunId: "12345",
        workflowRunAttempt: 2,
      }),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("host report verification rejects report substitution", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-host-report-test-"));
  try {
    const manifest = await writeUnsignedHostReportCandidate({
      outputRoot: root,
      sourceCommit: SOURCE,
      takoformSourceCommit: TAKOFORM_SOURCE,
      requestId: REQUEST_ID,
      reports: reports(),
      portableRunnerReport: runnerReport(),
    });
    const first = manifest.reports[0]!;
    await writeFile(join(root, first.path), new Uint8Array([0x7b, 0x7d]));
    await expect(
      verifyUnsignedHostReportCandidate(root, {
        sourceCommit: SOURCE,
        takoformSourceCommit: TAKOFORM_SOURCE,
        requestId: REQUEST_ID,
      }),
    ).rejects.toThrow("digest mismatch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("host report manifest is canonical and has no set-wide version", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-host-report-test-"));
  try {
    await writeUnsignedHostReportCandidate({
      outputRoot: root,
      sourceCommit: SOURCE,
      takoformSourceCommit: TAKOFORM_SOURCE,
      requestId: REQUEST_ID,
      reports: reports(),
      portableRunnerReport: runnerReport(),
    });
    const manifest = JSON.parse(
      await readFile(join(root, HOST_REPORT_MANIFEST_NAME), "utf8"),
    ) as HostReportManifest & {
      readonly definitionVersion?: string;
      readonly packageVersion?: string;
    };
    expect(manifest.definitionVersion).toBeUndefined();
    expect(manifest.packageVersion).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("host report candidate rejects a non-canonical request id", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-host-report-test-"));
  try {
    await expect(
      writeUnsignedHostReportCandidate({
        outputRoot: root,
        sourceCommit: SOURCE,
        takoformSourceCommit: TAKOFORM_SOURCE,
        requestId: REQUEST_ID.toUpperCase(),
        reports: reports(),
        portableRunnerReport: runnerReport(),
      }),
    ).rejects.toThrow("request id must be a canonical UUID");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function reports(): ExecutedCurrentFormHostReport[] {
  return Array.from({ length: 10 }, (_, index) => {
    const name = `form-${index}`;
    const type = `form_${index}`;
    const version = index % 2 === 0 ? "2.0.0" : "3.0.0";
    const identity = {
      type,
      version,
      schemaDigest: `sha256:${String(index + 1).padStart(64, "0")}`,
      packageDigest: `sha256:${String(index + 11).padStart(64, "0")}`,
    };
    const positiveDigest = `sha256:${String(index + 21).padStart(64, "0")}`;
    const negativeDigest = `sha256:${String(index + 31).padStart(64, "0")}`;
    return {
      candidate: { kind: `Form${index}`, slug: name, identity },
      positive: [{ name: "canonical", packageFixtureDigest: positiveDigest }],
      negative: [
        { name: "reject-invalid", packageFixtureDigest: negativeDigest },
      ],
      execution: {
        apiVersion: "takosumi.portable-form-host-conformance/v1",
        identity,
        endpointOrigin: "https://in-process.takosumi.test",
        status: "passed",
        checks: REQUIRED_CHECKS,
        fixtures: {
          positive: [{ name: "canonical", inputDigest: positiveDigest }],
          negative: [
            {
              name: "reject-invalid",
              stage: "desired",
              inputDigest: negativeDigest,
              httpStatus: 400,
              errorCode: "invalid_argument",
            },
          ],
        },
        canonicalResourceId: `tkrn:space_host_report:Form${index}:${name}`,
        evidenceDigest: `sha256:${"f".repeat(64)}`,
      },
    };
  });
}

function runnerReport(): TakoformPortableHostRunnerReport {
  const stable = [
    ["invalid_argument", 400, false],
    ["unauthenticated", 401, false],
    ["permission_denied", 403, false],
    ["form_unknown", 404, false],
    ["form_not_installed", 409, false],
    ["form_unavailable", 503, false],
    ["form_identity_conflict", 409, false],
    ["resource_not_found", 404, false],
    ["resource_version_conflict", 412, false],
    ["resource_busy", 409, true],
    ["import_conflict", 409, false],
    ["policy_denied", 403, false],
    ["backend_unavailable", 503, true],
    ["interface_identity_ambiguous", 409, false],
    ["interface_instance_ambiguous", 409, false],
    ["internal_error", 500, false],
  ] as const;
  return {
    format: "takoform.portable-host-runner-report@v1",
    classification: "disposable-endpoint-conformance-run",
    publicationReady: false,
    status: "passed",
    subject: "host:http://127.0.0.1:43123",
    runnerSubject: "takoform.portable-host-conformance-runner@v1",
    runnerInputDigest: TAKOFORM_PORTABLE_HOST_RUNNER_INPUT_DIGEST,
    checks: TAKOFORM_PORTABLE_HOST_REQUIRED_RUNNER_CHECKS,
    errorProbes: stable.map(([code, httpStatus, retryable]) => ({
      code,
      httpStatus,
      retryable,
    })),
    negativeFixtures: TAKOFORM_PORTABLE_HOST_EXPECTED_NEGATIVE_FIXTURES,
    generationTransitions:
      TAKOFORM_PORTABLE_HOST_EXPECTED_GENERATION_TRANSITIONS,
    planBindingEvidence: {
      pureBlackBoxInputs: TAKOFORM_PLAN_BINDING_PURE_INPUTS,
      instrumentedAdapterInputs:
        TAKOFORM_PLAN_BINDING_INSTRUMENTED_INPUTS,
    },
    idempotencyEvidence: {
      isolationDimensions: TAKOFORM_IDEMPOTENCY_ISOLATION_DIMENSIONS,
      replayAuthorizationDenials: TAKOFORM_IDEMPOTENCY_REPLAY_DENIALS,
      successReplayPreservedAfterDenials: true,
    },
    interfaceEvidence: {
      checks: TAKOFORM_PORTABLE_HOST_REQUIRED_INTERFACE_CHECKS,
      absentBeforeReady: true,
      exactReadyProjection: true,
      absentAfterDelete: true,
    },
  };
}
