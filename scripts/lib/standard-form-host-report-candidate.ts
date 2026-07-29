import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";

import type { InstalledFormReference, JsonObject } from "takosumi-contract";
import {
  canonicalJsonBytes,
  parseCanonicalJson,
  type CanonicalJsonValue,
} from "../../core/adapters/takoform/canonical_json.ts";
import type { PortableFormHostConformanceReport } from "../../core/conformance/portable_form_host.ts";
import {
  assertPortableHostRunnerReport,
  TAKOFORM_PORTABLE_HOST_REPORT_FORMAT,
  TAKOFORM_PORTABLE_HOST_RUNNER_SUBJECT,
  type TakoformPortableHostRunnerReport,
} from "./takoform-portable-host-evidence.ts";

export const CURRENT_HOST_GENERATION = "ga-core-v2";
export const CURRENT_HOST_SUBJECT = "host:https://in-process.takosumi.test";
export const HOST_REPORT_MANIFEST_NAME = "host-report-manifest.json";
export const SIGNED_HOST_REPORT_CANDIDATE_NAME =
  "signed-host-report-candidate.json";
export const HOST_REPORT_CHECKSUMS_NAME = "SHA256SUMS";
export const HOST_REPORT_CHECKSUMS_BUNDLE_NAME =
  "SHA256SUMS.sigstore.json";
export const PORTABLE_HOST_RUNNER_REPORT_NAME =
  "portable-host-runner-report.json";
export const PORTABLE_HOST_RUNNER_BUNDLE_NAME =
  "portable-host-runner-report.sigstore.json";
export const HOST_REPORT_WORKFLOW =
  ".github/workflows/standard-form-host-report.yml";
export const HOST_REPORT_CERTIFICATE_IDENTITY =
  "https://github.com/tako0614/takosumi/.github/workflows/standard-form-host-report.yml@refs/heads/main";

const HOST_REPORT_FORMAT = "takoform.standard-runner-report@v1";
const MANIFEST_FORMAT = "takosumi.standard-form-host-report-candidate@v3";
const SIGNED_FORMAT = "takosumi.standard-form-host-report-signed-candidate@v4";
const PROOF_TYPE = "oss-reference-host-source-conformance";
const SOURCE_REPOSITORY = "https://github.com/tako0614/takosumi.git";
const TAKOFORM_REPOSITORY =
  "https://github.com/tako0614/terraform-provider-takoform.git";
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
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
const LIFECYCLE = {
  create: true,
  read: true,
  update: true,
  delete: true,
  import: true,
  observe: true,
  refresh: true,
  drift: true,
} as const;

export interface CurrentFormCandidate {
  readonly kind: string;
  readonly slug: string;
  readonly identity: InstalledFormReference;
}

export interface HostFixtureBinding {
  readonly name: string;
  readonly packageFixtureDigest: string;
}

export interface ExecutedCurrentFormHostReport {
  readonly candidate: CurrentFormCandidate;
  readonly execution: PortableFormHostConformanceReport;
  readonly positive: readonly HostFixtureBinding[];
  readonly negative: readonly HostFixtureBinding[];
}

export interface HostReportSource {
  readonly repository: string;
  readonly commit: string;
}

export interface HostReportDescriptor {
  readonly kind: string;
  readonly slug: string;
  readonly path: string;
  readonly bundlePath: string;
  readonly digest: string;
  readonly identity: PortableInstalledFormReference;
}

export interface PortableInstalledFormReference {
  readonly formRef: {
    readonly apiVersion: "forms.takoform.com/v1alpha1";
    readonly kind: string;
    readonly definitionVersion: string;
    readonly schemaDigest: string;
  };
  readonly packageDigest: string;
}

export interface HostReportManifest {
  readonly format: typeof MANIFEST_FORMAT;
  readonly status: "candidate-only";
  readonly proofType: typeof PROOF_TYPE;
  readonly subject: typeof CURRENT_HOST_SUBJECT;
  readonly generation: typeof CURRENT_HOST_GENERATION;
  readonly runnerVersion: string;
  readonly workflow: typeof HOST_REPORT_WORKFLOW;
  readonly requestId: string;
  readonly source: HostReportSource;
  readonly takoformSource: HostReportSource;
  readonly portableRunner: PortableHostRunnerDescriptor;
  readonly reports: readonly HostReportDescriptor[];
}

export interface PortableHostRunnerDescriptor {
  readonly path: typeof PORTABLE_HOST_RUNNER_REPORT_NAME;
  readonly bundlePath: typeof PORTABLE_HOST_RUNNER_BUNDLE_NAME;
  readonly digest: string;
  readonly format: typeof TAKOFORM_PORTABLE_HOST_REPORT_FORMAT;
  readonly runnerSubject: typeof TAKOFORM_PORTABLE_HOST_RUNNER_SUBJECT;
  readonly runnerInputDigest: string;
}

export interface SignedHostReportCandidate {
  readonly format: typeof SIGNED_FORMAT;
  readonly status: "candidate-only";
  readonly proofType: typeof PROOF_TYPE;
  readonly subject: typeof CURRENT_HOST_SUBJECT;
  readonly generation: typeof CURRENT_HOST_GENERATION;
  readonly certificateIdentity: typeof HOST_REPORT_CERTIFICATE_IDENTITY;
  readonly workflow: typeof HOST_REPORT_WORKFLOW;
  readonly requestId: string;
  readonly workflowRunId: string;
  readonly workflowRunAttempt: 1;
  readonly source: HostReportSource;
  readonly takoformSource: HostReportSource;
  readonly closure: {
    readonly checksumsPath: typeof HOST_REPORT_CHECKSUMS_NAME;
    readonly bundlePath: typeof HOST_REPORT_CHECKSUMS_BUNDLE_NAME;
    readonly certificateIdentity: typeof HOST_REPORT_CERTIFICATE_IDENTITY;
  };
  readonly manifest: { readonly path: string; readonly digest: string };
  readonly portableRunner: {
    readonly reportPath: typeof PORTABLE_HOST_RUNNER_REPORT_NAME;
    readonly reportDigest: string;
    readonly bundlePath: typeof PORTABLE_HOST_RUNNER_BUNDLE_NAME;
    readonly bundleDigest: string;
    readonly runnerSubject: typeof TAKOFORM_PORTABLE_HOST_RUNNER_SUBJECT;
    readonly runnerInputDigest: string;
  };
  readonly entries: readonly {
    readonly kind: string;
    readonly slug: string;
    readonly reportPath: string;
    readonly reportDigest: string;
    readonly bundlePath: string;
    readonly bundleDigest: string;
  }[];
}

export async function writeUnsignedHostReportCandidate(input: {
  readonly outputRoot: string;
  readonly sourceCommit: string;
  readonly takoformSourceCommit: string;
  readonly requestId: string;
  readonly reports: readonly ExecutedCurrentFormHostReport[];
  readonly portableRunnerReport: TakoformPortableHostRunnerReport;
}): Promise<HostReportManifest> {
  validateCommit("Takosumi source", input.sourceCommit);
  validateCommit("Takoform source", input.takoformSourceCommit);
  validateRequestId(input.requestId);
  if (input.reports.length !== 10) {
    throw new TypeError(
      `current host report requires exactly 10 Forms, got ${input.reports.length}`,
    );
  }
  await assertNewEmptyDirectory(input.outputRoot);
  assertPortableHostRunnerReport(input.portableRunnerReport);
  const portableRunnerBytes = canonicalBytes(
    input.portableRunnerReport as CanonicalJsonValue,
  );
  await writeExclusiveRelative(
    input.outputRoot,
    PORTABLE_HOST_RUNNER_REPORT_NAME,
    portableRunnerBytes,
  );
  const portableRunner: PortableHostRunnerDescriptor = {
    path: PORTABLE_HOST_RUNNER_REPORT_NAME,
    bundlePath: PORTABLE_HOST_RUNNER_BUNDLE_NAME,
    digest: digest(portableRunnerBytes),
    format: TAKOFORM_PORTABLE_HOST_REPORT_FORMAT,
    runnerSubject: TAKOFORM_PORTABLE_HOST_RUNNER_SUBJECT,
    runnerInputDigest: input.portableRunnerReport.runnerInputDigest,
  };
  const runnerVersion = `1.2.0+git.${input.sourceCommit}`;
  const descriptors: HostReportDescriptor[] = [];
  const seen = new Set<string>();
  for (const item of input.reports) {
    if (seen.has(item.candidate.kind)) {
      throw new TypeError(
        `current host report duplicates ${item.candidate.kind}`,
      );
    }
    seen.add(item.candidate.kind);
    const report = buildCanonicalRunnerReport(item, runnerVersion);
    const path = `packages/${item.candidate.slug}/host-report.json`;
    const bundlePath = `packages/${item.candidate.slug}/host-report.sigstore.json`;
    const bytes = canonicalBytes(report);
    await writeExclusiveRelative(input.outputRoot, path, bytes);
    descriptors.push({
      kind: item.candidate.kind,
      slug: item.candidate.slug,
      path,
      bundlePath,
      digest: digest(bytes),
      identity: portableIdentity(item.candidate.identity),
    });
  }
  const manifest: HostReportManifest = {
    format: MANIFEST_FORMAT,
    status: "candidate-only",
    proofType: PROOF_TYPE,
    subject: CURRENT_HOST_SUBJECT,
    generation: CURRENT_HOST_GENERATION,
    runnerVersion,
    workflow: HOST_REPORT_WORKFLOW,
    requestId: input.requestId,
    source: { repository: SOURCE_REPOSITORY, commit: input.sourceCommit },
    takoformSource: {
      repository: TAKOFORM_REPOSITORY,
      commit: input.takoformSourceCommit,
    },
    portableRunner,
    reports: descriptors,
  };
  await writeExclusiveRelative(
    input.outputRoot,
    HOST_REPORT_MANIFEST_NAME,
    canonicalBytes(manifest),
  );
  await verifyUnsignedHostReportCandidate(input.outputRoot, {
    sourceCommit: input.sourceCommit,
    takoformSourceCommit: input.takoformSourceCommit,
    requestId: input.requestId,
  });
  return manifest;
}

export async function verifyUnsignedHostReportCandidate(
  outputRoot: string,
  expected: {
    readonly sourceCommit: string;
    readonly takoformSourceCommit: string;
    readonly requestId: string;
  },
): Promise<HostReportManifest> {
  validateCommit("Takosumi source", expected.sourceCommit);
  validateCommit("Takoform source", expected.takoformSourceCommit);
  validateRequestId(expected.requestId);
  const bytes = await readBoundedRegularFile(
    outputRoot,
    HOST_REPORT_MANIFEST_NAME,
  );
  assertCanonical(bytes, HOST_REPORT_MANIFEST_NAME);
  const manifest = parseJson<HostReportManifest>(bytes);
  const runnerVersion = `1.2.0+git.${expected.sourceCommit}`;
  if (
    manifest.format !== MANIFEST_FORMAT ||
    manifest.status !== "candidate-only" ||
    manifest.proofType !== PROOF_TYPE ||
    manifest.subject !== CURRENT_HOST_SUBJECT ||
    manifest.generation !== CURRENT_HOST_GENERATION ||
    manifest.runnerVersion !== runnerVersion ||
    manifest.workflow !== HOST_REPORT_WORKFLOW ||
    manifest.requestId !== expected.requestId ||
    manifest.source.repository !== SOURCE_REPOSITORY ||
    manifest.source.commit !== expected.sourceCommit ||
    manifest.takoformSource.repository !== TAKOFORM_REPOSITORY ||
    manifest.takoformSource.commit !== expected.takoformSourceCommit ||
    manifest.reports.length !== 10
  ) {
    throw new TypeError("host-report manifest identity is invalid");
  }
  validatePortableRunnerDescriptor(manifest.portableRunner);
  const portableRunnerBytes = await readBoundedRegularFile(
    outputRoot,
    manifest.portableRunner.path,
  );
  assertCanonical(portableRunnerBytes, manifest.portableRunner.path);
  if (digest(portableRunnerBytes) !== manifest.portableRunner.digest) {
    throw new TypeError("portable host runner report digest mismatch");
  }
  const portableRunner = parseJson<unknown>(portableRunnerBytes);
  assertPortableHostRunnerReport(portableRunner);
  if (
    portableRunner.runnerSubject !== manifest.portableRunner.runnerSubject ||
    portableRunner.runnerInputDigest !==
      manifest.portableRunner.runnerInputDigest
  ) {
    throw new TypeError("portable host runner report binding is invalid");
  }
  const files = new Set<string>([
    HOST_REPORT_MANIFEST_NAME,
    manifest.portableRunner.path,
  ]);
  const kinds = new Set<string>();
  for (const descriptor of manifest.reports) {
    validateDescriptor(descriptor, kinds);
    files.add(descriptor.path);
    const reportBytes = await readBoundedRegularFile(
      outputRoot,
      descriptor.path,
    );
    assertCanonical(reportBytes, descriptor.path);
    if (digest(reportBytes) !== descriptor.digest) {
      throw new TypeError(`${descriptor.kind} host-report digest mismatch`);
    }
    validateCanonicalRunnerReport(
      parseJson<Record<string, unknown>>(reportBytes),
      descriptor,
      runnerVersion,
    );
  }
  const actual = await listRegularFiles(outputRoot);
  const wanted = [...files].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new TypeError(
      `unsigned host-report file closure differs: got ${actual.join(",")}`,
    );
  }
  return manifest;
}

export async function finalizeSignedHostReportCandidate(input: {
  readonly outputRoot: string;
  readonly sourceCommit: string;
  readonly takoformSourceCommit: string;
  readonly requestId: string;
  readonly workflowRunId: string;
  readonly workflowRunAttempt: number;
}): Promise<SignedHostReportCandidate> {
  if (!/^[1-9][0-9]*$/u.test(input.workflowRunId)) {
    throw new TypeError("workflow run id must be a positive decimal");
  }
  if (input.workflowRunAttempt !== 1) {
    throw new TypeError("host-report signer accepts only workflow attempt 1");
  }
  const manifest = await verifyUnsignedCandidateWithBundles(
    input.outputRoot,
    input,
  );
  const manifestBytes = await readBoundedRegularFile(
    input.outputRoot,
    HOST_REPORT_MANIFEST_NAME,
  );
  const signed: SignedHostReportCandidate = {
    format: SIGNED_FORMAT,
    status: "candidate-only",
    proofType: PROOF_TYPE,
    subject: CURRENT_HOST_SUBJECT,
    generation: CURRENT_HOST_GENERATION,
    certificateIdentity: HOST_REPORT_CERTIFICATE_IDENTITY,
    workflow: HOST_REPORT_WORKFLOW,
    requestId: input.requestId,
    workflowRunId: input.workflowRunId,
    workflowRunAttempt: 1,
    source: manifest.source,
    takoformSource: manifest.takoformSource,
    closure: {
      checksumsPath: HOST_REPORT_CHECKSUMS_NAME,
      bundlePath: HOST_REPORT_CHECKSUMS_BUNDLE_NAME,
      certificateIdentity: HOST_REPORT_CERTIFICATE_IDENTITY,
    },
    manifest: {
      path: HOST_REPORT_MANIFEST_NAME,
      digest: digest(manifestBytes),
    },
    portableRunner: {
      reportPath: manifest.portableRunner.path,
      reportDigest: manifest.portableRunner.digest,
      bundlePath: manifest.portableRunner.bundlePath,
      bundleDigest: digest(
        await readBoundedRegularFile(
          input.outputRoot,
          manifest.portableRunner.bundlePath,
        ),
      ),
      runnerSubject: manifest.portableRunner.runnerSubject,
      runnerInputDigest: manifest.portableRunner.runnerInputDigest,
    },
    entries: await Promise.all(
      manifest.reports.map(async (entry) => ({
        kind: entry.kind,
        slug: entry.slug,
        reportPath: entry.path,
        reportDigest: entry.digest,
        bundlePath: entry.bundlePath,
        bundleDigest: digest(
          await readBoundedRegularFile(input.outputRoot, entry.bundlePath),
        ),
      })),
    ),
  };
  await writeExclusiveRelative(
    input.outputRoot,
    SIGNED_HOST_REPORT_CANDIDATE_NAME,
    canonicalBytes(signed),
  );
  const checksumPaths = [
    HOST_REPORT_MANIFEST_NAME,
    SIGNED_HOST_REPORT_CANDIDATE_NAME,
    manifest.portableRunner.path,
    manifest.portableRunner.bundlePath,
    ...manifest.reports.flatMap((entry) => [entry.path, entry.bundlePath]),
  ].sort();
  const checksums = (
    await Promise.all(
      checksumPaths.map(async (path) => {
        const value = await readBoundedRegularFile(input.outputRoot, path);
        return `${digest(value).slice("sha256:".length)}  ${path}`;
      }),
    )
  ).join("\n");
  await writeExclusiveRelative(
    input.outputRoot,
    HOST_REPORT_CHECKSUMS_NAME,
    new TextEncoder().encode(`${checksums}\n`),
  );
  return await verifySignedHostReportCandidateInternal(
    input.outputRoot,
    input,
    false,
  );
}

export async function verifySignedHostReportCandidate(
  outputRoot: string,
  expected: {
    readonly sourceCommit: string;
    readonly takoformSourceCommit: string;
    readonly requestId: string;
    readonly workflowRunId: string;
    readonly workflowRunAttempt: number;
  },
): Promise<SignedHostReportCandidate> {
  return await verifySignedHostReportCandidateInternal(
    outputRoot,
    expected,
    true,
  );
}

async function verifySignedHostReportCandidateInternal(
  outputRoot: string,
  expected: {
    readonly sourceCommit: string;
    readonly takoformSourceCommit: string;
    readonly requestId: string;
    readonly workflowRunId: string;
    readonly workflowRunAttempt: number;
  },
  requireAuthenticatedClosure: boolean,
): Promise<SignedHostReportCandidate> {
  if (!/^[1-9][0-9]*$/u.test(expected.workflowRunId)) {
    throw new TypeError("workflow run id must be a positive decimal");
  }
  if (expected.workflowRunAttempt !== 1) {
    throw new TypeError("host-report signer accepts only workflow attempt 1");
  }
  const manifest = await verifyUnsignedCandidateWithBundles(
    outputRoot,
    expected,
  );
  const signedBytes = await readBoundedRegularFile(
    outputRoot,
    SIGNED_HOST_REPORT_CANDIDATE_NAME,
  );
  assertCanonical(signedBytes, SIGNED_HOST_REPORT_CANDIDATE_NAME);
  const signed = parseJson<SignedHostReportCandidate>(signedBytes);
  const manifestBytes = await readBoundedRegularFile(
    outputRoot,
    HOST_REPORT_MANIFEST_NAME,
  );
  if (
    signed.format !== SIGNED_FORMAT ||
    signed.status !== "candidate-only" ||
    signed.proofType !== PROOF_TYPE ||
    signed.subject !== CURRENT_HOST_SUBJECT ||
    signed.generation !== CURRENT_HOST_GENERATION ||
    signed.certificateIdentity !== HOST_REPORT_CERTIFICATE_IDENTITY ||
    signed.workflow !== HOST_REPORT_WORKFLOW ||
    signed.requestId !== expected.requestId ||
    signed.workflowRunId !== expected.workflowRunId ||
    signed.workflowRunAttempt !== expected.workflowRunAttempt ||
    signed.source.repository !== manifest.source.repository ||
    signed.source.commit !== expected.sourceCommit ||
    signed.takoformSource.repository !==
      manifest.takoformSource.repository ||
    signed.takoformSource.commit !== expected.takoformSourceCommit ||
    signed.closure?.checksumsPath !== HOST_REPORT_CHECKSUMS_NAME ||
    signed.closure.bundlePath !== HOST_REPORT_CHECKSUMS_BUNDLE_NAME ||
    signed.closure.certificateIdentity !==
      HOST_REPORT_CERTIFICATE_IDENTITY ||
    signed.manifest.path !== HOST_REPORT_MANIFEST_NAME ||
    signed.manifest.digest !== digest(manifestBytes) ||
    signed.portableRunner.reportPath !== manifest.portableRunner.path ||
    signed.portableRunner.reportDigest !== manifest.portableRunner.digest ||
    signed.portableRunner.bundlePath !== manifest.portableRunner.bundlePath ||
    signed.portableRunner.bundleDigest !==
      digest(
        await readBoundedRegularFile(
          outputRoot,
          manifest.portableRunner.bundlePath,
        ),
      ) ||
    signed.portableRunner.runnerSubject !==
      manifest.portableRunner.runnerSubject ||
    signed.portableRunner.runnerInputDigest !==
      manifest.portableRunner.runnerInputDigest ||
    signed.entries.length !== manifest.reports.length
  ) {
    throw new TypeError("signed host-report candidate identity is invalid");
  }
  for (const [index, descriptor] of manifest.reports.entries()) {
    const entry = signed.entries[index];
    if (
      !entry ||
      entry.kind !== descriptor.kind ||
      entry.slug !== descriptor.slug ||
      entry.reportPath !== descriptor.path ||
      entry.reportDigest !== descriptor.digest ||
      entry.bundlePath !== descriptor.bundlePath ||
      entry.bundleDigest !==
        digest(await readBoundedRegularFile(outputRoot, descriptor.bundlePath))
    ) {
      throw new TypeError(
        `${descriptor.kind} signed host-report binding is invalid`,
      );
    }
  }
  const checksumBytes = await readBoundedRegularFile(
    outputRoot,
    HOST_REPORT_CHECKSUMS_NAME,
  );
  const expectedPaths = [
    HOST_REPORT_MANIFEST_NAME,
    SIGNED_HOST_REPORT_CANDIDATE_NAME,
    manifest.portableRunner.path,
    manifest.portableRunner.bundlePath,
    ...manifest.reports.flatMap((entry) => [entry.path, entry.bundlePath]),
  ].sort();
  const expectedChecksums = (
    await Promise.all(
      expectedPaths.map(async (path) => {
        const value = await readBoundedRegularFile(outputRoot, path);
        return `${digest(value).slice("sha256:".length)}  ${path}`;
      }),
    )
  ).join("\n");
  if (new TextDecoder().decode(checksumBytes) !== `${expectedChecksums}\n`) {
    throw new TypeError(
      "host-report SHA256SUMS does not bind the exact closure",
    );
  }
  if (requireAuthenticatedClosure) {
    await readBoundedRegularFile(outputRoot, HOST_REPORT_CHECKSUMS_BUNDLE_NAME);
  }
  const actual = await listRegularFiles(outputRoot);
  const wanted = [
    ...expectedPaths,
    HOST_REPORT_CHECKSUMS_NAME,
    ...(requireAuthenticatedClosure
      ? [HOST_REPORT_CHECKSUMS_BUNDLE_NAME]
      : []),
  ].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new TypeError(
      `signed host-report file closure differs: got ${actual.join(",")}`,
    );
  }
  return signed;
}

function buildCanonicalRunnerReport(
  input: ExecutedCurrentFormHostReport,
  runnerVersion: string,
): CanonicalJsonValue {
  const execution = input.execution;
  if (
    execution.status !== "passed" ||
    execution.endpointOrigin !== "https://in-process.takosumi.test" ||
    !sameIdentity(execution.identity, input.candidate.identity)
  ) {
    throw new TypeError(
      `${input.candidate.kind} execution identity is invalid`,
    );
  }
  for (const required of REQUIRED_CHECKS) {
    if (!execution.checks.includes(required)) {
      throw new TypeError(
        `${input.candidate.kind} execution lacks ${required}`,
      );
    }
  }
  const positive = bindFixtures(
    input.candidate.kind,
    execution.fixtures.positive,
    input.positive,
    false,
  );
  const negative = bindFixtures(
    input.candidate.kind,
    execution.fixtures.negative,
    input.negative,
    true,
  );
  const identity = portableIdentity(input.candidate.identity);
  const executionEvidence = {
    apiVersion: execution.apiVersion,
    identity,
    endpointOrigin: execution.endpointOrigin,
    status: execution.status,
    checks: [...execution.checks],
    fixtures: {
      positive: positive.map((fixture) => ({
        name: fixture.name,
        inputDigest: fixture.effectiveInputDigest,
        packageFixtureDigest: fixture.packageFixtureDigest,
      })),
      negative: negative.map((fixture) => ({
        name: fixture.name,
        stage: "desired",
        inputDigest: fixture.effectiveInputDigest,
        packageFixtureDigest: fixture.packageFixtureDigest,
        httpStatus: 400,
        errorCode: "invalid_argument",
      })),
    },
    canonicalResourceId: execution.canonicalResourceId,
  } satisfies CanonicalJsonValue;
  return {
    format: HOST_REPORT_FORMAT,
    role: "host-report",
    subject: CURRENT_HOST_SUBJECT,
    runnerVersion,
    identity,
    status: "passed",
    lifecycle: LIFECYCLE,
    executionEvidence,
    executionEvidenceDigest: digest(canonicalBytes(executionEvidence)),
    positiveFixtures: positive.map((fixture) => ({
      ...fixture,
      passed: true,
    })),
    negativeFixtures: negative.map((fixture) => ({
      ...fixture,
      errorCode: "invalid_argument",
      passed: true,
    })),
  };
}

function bindFixtures(
  kind: string,
  executed: readonly { readonly name: string; readonly inputDigest: string }[],
  retained: readonly HostFixtureBinding[],
  negative: boolean,
): readonly {
  readonly name: string;
  readonly packageFixtureDigest: string;
  readonly effectiveInputDigest: string;
}[] {
  const retainedByName = new Map(
    retained.map((fixture) => [fixture.name, fixture] as const),
  );
  if (
    retainedByName.size !== retained.length ||
    executed.length !== retained.length
  ) {
    throw new TypeError(`${kind} fixture closure is incomplete`);
  }
  return executed.map((fixture) => {
    const binding = retainedByName.get(fixture.name);
    if (
      !binding ||
      !DIGEST_PATTERN.test(binding.packageFixtureDigest) ||
      !DIGEST_PATTERN.test(fixture.inputDigest)
    ) {
      throw new TypeError(`${kind} fixture ${fixture.name} is unbound`);
    }
    if (negative) {
      const evidence = fixture as {
        readonly stage?: string;
        readonly httpStatus?: number;
        readonly errorCode?: string;
      };
      if (
        evidence.stage !== "desired" ||
        evidence.httpStatus !== 400 ||
        evidence.errorCode !== "invalid_argument"
      ) {
        throw new TypeError(
          `${kind} negative fixture ${fixture.name} was not rejected canonically`,
        );
      }
    }
    return {
      name: fixture.name,
      packageFixtureDigest: binding.packageFixtureDigest,
      effectiveInputDigest: fixture.inputDigest,
    };
  });
}

function portableIdentity(
  identity: InstalledFormReference,
): PortableInstalledFormReference {
  const kind = identity.type
    .split("_")
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("");
  return {
    formRef: {
      apiVersion: "forms.takoform.com/v1alpha1",
      kind,
      definitionVersion: identity.version,
      schemaDigest: identity.schemaDigest,
    },
    packageDigest: identity.packageDigest,
  };
}

function validateCanonicalRunnerReport(
  report: Record<string, unknown>,
  descriptor: HostReportDescriptor,
  runnerVersion: string,
): void {
  if (
    report.format !== HOST_REPORT_FORMAT ||
    report.role !== "host-report" ||
    report.subject !== CURRENT_HOST_SUBJECT ||
    report.runnerVersion !== runnerVersion ||
    report.status !== "passed" ||
    JSON.stringify(report.identity) !== JSON.stringify(descriptor.identity) ||
    !isRecord(report.lifecycle) ||
    Object.entries(LIFECYCLE).some(
      ([operation, value]) => report.lifecycle?.[operation] !== value,
    ) ||
    !isRecord(report.executionEvidence) ||
    report.executionEvidenceDigest !==
      digest(canonicalBytes(report.executionEvidence as CanonicalJsonValue))
  ) {
    throw new TypeError(`${descriptor.kind} canonical host-report is invalid`);
  }
  const checks = report.executionEvidence.checks;
  if (
    !Array.isArray(checks) ||
    REQUIRED_CHECKS.some((check) => !checks.includes(check))
  ) {
    throw new TypeError(
      `${descriptor.kind} canonical host-report lacks lifecycle checks`,
    );
  }
}

function validateDescriptor(
  descriptor: HostReportDescriptor,
  kinds: Set<string>,
): void {
  if (
    !/^[A-Z][A-Za-z0-9]{0,127}$/u.test(descriptor.kind) ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(descriptor.slug) ||
    descriptor.path !== `packages/${descriptor.slug}/host-report.json` ||
    descriptor.bundlePath !==
      `packages/${descriptor.slug}/host-report.sigstore.json` ||
    !DIGEST_PATTERN.test(descriptor.digest) ||
    kinds.has(descriptor.kind) ||
    descriptor.identity.formRef.kind !== descriptor.kind ||
    descriptor.identity.formRef.apiVersion !== "forms.takoform.com/v1alpha1" ||
    !DIGEST_PATTERN.test(descriptor.identity.formRef.schemaDigest) ||
    !DIGEST_PATTERN.test(descriptor.identity.packageDigest)
  ) {
    throw new TypeError("host-report descriptor is invalid");
  }
  kinds.add(descriptor.kind);
}

function validatePortableRunnerDescriptor(
  descriptor: PortableHostRunnerDescriptor,
): void {
  if (
    !descriptor ||
    descriptor.path !== PORTABLE_HOST_RUNNER_REPORT_NAME ||
    descriptor.bundlePath !== PORTABLE_HOST_RUNNER_BUNDLE_NAME ||
    !DIGEST_PATTERN.test(descriptor.digest) ||
    descriptor.format !== TAKOFORM_PORTABLE_HOST_REPORT_FORMAT ||
    descriptor.runnerSubject !== TAKOFORM_PORTABLE_HOST_RUNNER_SUBJECT ||
    !DIGEST_PATTERN.test(descriptor.runnerInputDigest)
  ) {
    throw new TypeError("portable host runner descriptor is invalid");
  }
}

async function verifyUnsignedCandidateWithBundles(
  outputRoot: string,
  expected: {
    readonly sourceCommit: string;
    readonly takoformSourceCommit: string;
    readonly requestId: string;
  },
): Promise<HostReportManifest> {
  const manifestBytes = await readBoundedRegularFile(
    outputRoot,
    HOST_REPORT_MANIFEST_NAME,
  );
  assertCanonical(manifestBytes, HOST_REPORT_MANIFEST_NAME);
  const manifest = parseJson<HostReportManifest>(manifestBytes);
  const unsignedRoot = await temporaryUnsignedView(outputRoot, manifest);
  try {
    await verifyUnsignedHostReportCandidate(unsignedRoot, expected);
  } finally {
    await rm(unsignedRoot, { recursive: true, force: true });
  }
  await readBoundedRegularFile(
    outputRoot,
    manifest.portableRunner.bundlePath,
  );
  for (const descriptor of manifest.reports) {
    await readBoundedRegularFile(outputRoot, descriptor.bundlePath);
  }
  return manifest;
}

async function temporaryUnsignedView(
  outputRoot: string,
  manifest: HostReportManifest,
): Promise<string> {
  const temporary = await mkdtemp(
    resolve(tmpdir(), "takosumi-host-report-unsigned-"),
  );
  await writeExclusiveRelative(
    temporary,
    HOST_REPORT_MANIFEST_NAME,
    await readBoundedRegularFile(outputRoot, HOST_REPORT_MANIFEST_NAME),
  );
  await writeExclusiveRelative(
    temporary,
    manifest.portableRunner.path,
    await readBoundedRegularFile(outputRoot, manifest.portableRunner.path),
  );
  for (const descriptor of manifest.reports) {
    await writeExclusiveRelative(
      temporary,
      descriptor.path,
      await readBoundedRegularFile(outputRoot, descriptor.path),
    );
  }
  return temporary;
}

async function assertNewEmptyDirectory(path: string): Promise<void> {
  const absolute = resolve(path);
  try {
    const stat = await lstat(absolute);
    if (!stat.isDirectory()) {
      throw new TypeError("host-report output path is not a directory");
    }
    if ((await readdir(absolute)).length !== 0) {
      throw new TypeError("host-report output directory must be empty");
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      await mkdir(absolute, { recursive: true, mode: 0o700 });
      return;
    }
    throw error;
  }
}

async function writeExclusiveRelative(
  root: string,
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  const absolute = safePath(root, path);
  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
  await writeFile(absolute, bytes, { flag: "wx", mode: 0o600 });
}

async function readBoundedRegularFile(
  root: string,
  path: string,
): Promise<Uint8Array> {
  const absolute = safePath(root, path);
  const stat = await lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 << 20) {
    throw new TypeError(
      `host-report file is not bounded regular data: ${path}`,
    );
  }
  return new Uint8Array(await readFile(absolute));
}

function safePath(root: string, path: string): string {
  if (
    path === "" ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new TypeError(`unsafe host-report path: ${path}`);
  }
  const absoluteRoot = resolve(root);
  const absolute = resolve(absoluteRoot, path);
  const fromRoot = relative(absoluteRoot, absolute);
  if (fromRoot.startsWith("../") || fromRoot === "..") {
    throw new TypeError(`host-report path escapes output: ${path}`);
  }
  return absolute;
}

async function listRegularFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      const fromRoot = relative(resolve(root), absolute).replaceAll("\\", "/");
      if (entry.isSymbolicLink()) {
        throw new TypeError(`host-report closure contains symlink ${fromRoot}`);
      }
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) result.push(fromRoot);
      else
        throw new TypeError(
          `host-report closure contains non-regular entry ${fromRoot}`,
        );
    }
  }
  await visit(resolve(root));
  return result.sort();
}

function canonicalBytes(value: CanonicalJsonValue): Uint8Array {
  return canonicalJsonBytes(value);
}

function parseJson<T>(bytes: Uint8Array): T {
  return parseCanonicalJson(bytes) as T;
}

function assertCanonical(bytes: Uint8Array, label: string): void {
  const parsed = parseCanonicalJson(bytes);
  if (
    Buffer.compare(
      Buffer.from(bytes),
      Buffer.from(canonicalJsonBytes(parsed)),
    ) !== 0
  ) {
    throw new TypeError(`${label} is not RFC 8785 canonical`);
  }
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function validateCommit(label: string, commit: string): void {
  if (!COMMIT_PATTERN.test(commit)) {
    throw new TypeError(`${label} commit must be lowercase 40-hex`);
  }
}

function validateRequestId(requestId: string): void {
  if (!CANONICAL_UUID_PATTERN.test(requestId)) {
    throw new TypeError("request id must be a canonical UUID");
  }
}

function sameIdentity(
  left: InstalledFormReference,
  right: InstalledFormReference,
): boolean {
  return (
    left.type === right.type &&
    left.version === right.version &&
    left.schemaDigest === right.schemaDigest &&
    left.packageDigest === right.packageDigest
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
