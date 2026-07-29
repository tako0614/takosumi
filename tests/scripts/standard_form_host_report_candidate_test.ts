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
  HOST_REPORT_MANIFEST_NAME,
  verifySignedHostReportCandidate,
  verifyUnsignedHostReportCandidate,
  writeUnsignedHostReportCandidate,
} from "../../scripts/lib/standard-form-host-report-candidate.ts";

const SOURCE = "1".repeat(40);
const TAKOFORM_SOURCE = "2".repeat(40);
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
      reports: reports(),
    });
    expect(manifest.reports).toHaveLength(10);
    expect(
      new Set(
        manifest.reports.map(
          ({ identity }) => identity.formRef.definitionVersion,
        ),
      ),
    ).toEqual(new Set(["1.0.0", "2.0.0"]));
    expect(
      await verifyUnsignedHostReportCandidate(root, {
        sourceCommit: SOURCE,
        takoformSourceCommit: TAKOFORM_SOURCE,
      }),
    ).toEqual(manifest);

    for (const entry of manifest.reports) {
      await writeFile(
        join(root, entry.bundlePath),
        JSON.stringify({ mediaType: "application/test", kind: entry.kind }),
        { flag: "wx" },
      );
    }
    const signed = await finalizeSignedHostReportCandidate({
      outputRoot: root,
      sourceCommit: SOURCE,
      takoformSourceCommit: TAKOFORM_SOURCE,
      workflowRunId: "12345",
      workflowRunAttempt: 1,
    });
    expect(signed.entries).toHaveLength(10);
    expect(
      await verifySignedHostReportCandidate(root, {
        sourceCommit: SOURCE,
        takoformSourceCommit: TAKOFORM_SOURCE,
        workflowRunId: "12345",
        workflowRunAttempt: 1,
      }),
    ).toEqual(signed);
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
      reports: reports(),
    });
    const first = manifest.reports[0]!;
    await writeFile(join(root, first.path), new Uint8Array([0x7b, 0x7d]));
    await expect(
      verifyUnsignedHostReportCandidate(root, {
        sourceCommit: SOURCE,
        takoformSourceCommit: TAKOFORM_SOURCE,
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
      reports: reports(),
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

function reports(): ExecutedCurrentFormHostReport[] {
  return Array.from({ length: 10 }, (_, index) => {
    const name = `form-${index}`;
    const type = `form_${index}`;
    const version = index % 2 === 0 ? "1.0.0" : "2.0.0";
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
