import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, expect, test } from "bun:test";
import {
  closeSignedStandardFormHostCandidate,
  generateStandardFormHostReports,
  loadCommittedHostMatrixForTest,
  STANDARD_HOST_REPORT_CERTIFICATE_IDENTITY,
  STANDARD_HOST_REPORT_MANIFEST,
  STANDARD_HOST_REPORT_SIGNED_MANIFEST,
  STANDARD_HOST_REPORT_SUBJECT,
} from "../../scripts/lib/standard-form-host-report-candidate.ts";

const roots: string[] = [];
const takosumiRoot = join(import.meta.dir, "..", "..");
const takosumiCommit = "a".repeat(40);
const takoformCommit = "b".repeat(40);

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("source-only reference host emits ten exact deterministic admission reports", async () => {
  const scratch = await temporaryRoot();
  const takoformRoot = await temporaryRoot();
  const first = join(scratch, "first");
  const second = join(scratch, "second");
  const entries = await loadCommittedHostMatrixForTest();

  const firstManifest = await generateStandardFormHostReports({
    entries,
    outputDir: first,
    takosumiRoot,
    takoformRoot,
    takosumiCommit,
    takoformCommit,
  });
  await generateStandardFormHostReports({
    entries,
    outputDir: second,
    takosumiRoot,
    takoformRoot,
    takosumiCommit,
    takoformCommit,
  });

  expect(firstManifest.reports).toHaveLength(10);
  expect(firstManifest.subject).toBe(STANDARD_HOST_REPORT_SUBJECT);
  expect(firstManifest.runnerVersion).toBe(`1.1.0+git.${takosumiCommit}`);
  expect(await snapshot(first)).toEqual(await snapshot(second));

  for (const item of firstManifest.reports) {
    const raw = await readFile(join(first, item.path));
    const report = JSON.parse(raw.toString("utf8"));
    expect(report).toMatchObject({
      format: "takoform.standard-runner-report@v1",
      role: "host-report",
      subject: STANDARD_HOST_REPORT_SUBJECT,
      runnerVersion: `1.1.0+git.${takosumiCommit}`,
      status: "passed",
      lifecycle: {
        create: true,
        read: true,
        update: true,
        delete: true,
        import: true,
        observe: true,
        refresh: true,
        drift: true,
      },
      positiveFixtures: [
        {
          name: "canonical",
          packageFixtureDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          passed: true,
        },
      ],
      negativeFixtures: [
        {
          name: "reject-invalid-semantics",
          packageFixtureDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          errorCode: "invalid_argument",
          passed: true,
        },
      ],
    });
    expect(report.executionEvidence.checks).toContain("drift");
    expect(report.executionEvidence.checks).toContain("import-idempotency");
    expect(`sha256:${digest(raw)}`).toBe(item.digest);
    expect((await stat(join(first, item.path))).mode & 0o777).toBe(0o600);
  }
  expect(
    (await stat(join(first, STANDARD_HOST_REPORT_MANIFEST))).mode & 0o777,
  ).toBe(0o600);
}, 30_000);

test("signed candidate closure admits exactly ten report bundles and checksums", async () => {
  const scratch = await temporaryRoot();
  const takoformRoot = await temporaryRoot();
  const candidate = join(scratch, "candidate");
  const entries = await loadCommittedHostMatrixForTest();
  const manifest = await generateStandardFormHostReports({
    entries,
    outputDir: candidate,
    takosumiRoot,
    takoformRoot,
    takosumiCommit,
    takoformCommit,
  });
  for (const report of manifest.reports) {
    const bundlePath = join(candidate, report.bundlePath);
    await mkdir(dirname(bundlePath), { recursive: true, mode: 0o700 });
    await writeFile(
      bundlePath,
      JSON.stringify({
        mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
      }),
      { mode: 0o600 },
    );
    await chmod(bundlePath, 0o600);
  }

  await closeSignedStandardFormHostCandidate({
    candidateDir: candidate,
    workflowRunId: "12345",
    workflowRunAttempt: "1",
  });

  const files = await listFiles(candidate);
  expect(files).toHaveLength(23);
  expect(files).toContain(STANDARD_HOST_REPORT_SIGNED_MANIFEST);
  expect(files).toContain("SHA256SUMS");
  const signed = JSON.parse(
    await readFile(
      join(candidate, STANDARD_HOST_REPORT_SIGNED_MANIFEST),
      "utf8",
    ),
  );
  expect(signed).toMatchObject({
    format: "takosumi.standard-form-host-report-signed-candidate@v1",
    status: "candidate-only",
    subject: STANDARD_HOST_REPORT_SUBJECT,
    certificateIdentity: STANDARD_HOST_REPORT_CERTIFICATE_IDENTITY,
    workflowRunId: "12345",
    workflowRunAttempt: 1,
  });
  expect(signed.entries).toHaveLength(10);
  await verifyChecksums(candidate);
}, 30_000);

test("generator refuses an existing or repository-owned output directory", async () => {
  const scratch = await temporaryRoot();
  const takoformRoot = await temporaryRoot();
  const entries = await loadCommittedHostMatrixForTest();
  const existing = join(scratch, "existing");
  await mkdir(existing);
  await expect(
    generateStandardFormHostReports({
      entries,
      outputDir: existing,
      takosumiRoot,
      takoformRoot,
      takosumiCommit,
      takoformCommit,
    }),
  ).rejects.toThrow();

  await expect(
    generateStandardFormHostReports({
      entries,
      outputDir: join(takosumiRoot, "tests", ".forbidden-host-reports"),
      takosumiRoot,
      takoformRoot,
      takosumiCommit,
      takoformCommit,
    }),
  ).rejects.toThrow("outside the Takosumi checkout");
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "takosumi-host-report-"));
  roots.push(root);
  return root;
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const path of await listFiles(root)) {
    result[path] = (await readFile(join(root, path))).toString("base64");
  }
  return result;
}

async function listFiles(root: string, directory = root): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await listFiles(root, absolute)));
    else if (entry.isFile()) result.push(relative(root, absolute));
  }
  return result.sort();
}

async function verifyChecksums(root: string): Promise<void> {
  const lines = (await readFile(join(root, "SHA256SUMS"), "utf8"))
    .trimEnd()
    .split("\n");
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  (.+)$/u.exec(line);
    expect(match).not.toBeNull();
    expect(digest(await readFile(join(root, match![2]!)))).toBe(match![1]);
  }
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
