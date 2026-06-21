import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

export const RELEASE_ACTIVATION_EVIDENCE_KIND =
  "takosumi.release-activation-evidence@v1" as const;

const RELEASE_ACTIVATION_WEBHOOK_KIND =
  "takosumi.operator.release-activation@v1" as const;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const GIT_REF_PATTERN = /^git\+[^#]+#[^#]+$/;
const GIT_COMMIT_PIN_PATTERN = /@[0-9a-f]{40,64}$/i;
const REQUIRED_SURFACES = ["activity", "runTimeline"] as const;
const REQUIRED_SECRET_CLASSES = [
  "providerCredentials",
  "runnerEnv",
  "secretOutputs",
  "releaseActivatorToken",
] as const;

export interface ReleaseActivationEvidenceManifest {
  readonly kind: typeof RELEASE_ACTIVATION_EVIDENCE_KIND;
  readonly generatedAt: string;
  readonly environment: "staging" | "production";
  readonly checks: {
    readonly successfulActivation: SuccessfulActivationEvidence;
    readonly failureSurfacing: FailureSurfacingEvidence;
    readonly ledgerIndependence: LedgerIndependenceEvidence;
    readonly payloadBoundary: PayloadBoundaryEvidence;
  };
}

export interface BaseEvidence {
  readonly evidenceRef: string;
  readonly evidenceDigest: string;
  readonly live: true;
  readonly summary: string;
}

export interface FinalModelRefs {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly capsuleId: string;
  readonly stateVersionId: string;
  readonly outputId: string;
}

export interface LegacyRuntimeIds {
  readonly spaceId: string;
  readonly installationId: string;
  readonly outputSnapshotId: string;
}

export interface SuccessfulActivationEvidence extends BaseEvidence {
  readonly platformUrl: string;
  readonly webhookPayloadKind: typeof RELEASE_ACTIVATION_WEBHOOK_KIND;
  readonly planRunId: string;
  readonly applyRunId: string;
  readonly finalModel: FinalModelRefs;
  readonly legacyRuntimeIds: LegacyRuntimeIds;
  readonly providerConnectionId: string;
  readonly deploymentId: string;
  readonly sourceSnapshotId: string;
  readonly stateGeneration: number;
  readonly materializedResourceKind: string;
  readonly activationStatus: "succeeded";
  readonly launchUrl: string;
  readonly healthUrl: string;
  readonly healthStatus: 200;
  readonly nonSensitiveOutputKeys: readonly string[];
}

export interface FailureSurfacingEvidence extends BaseEvidence {
  readonly applyRunId: string;
  readonly activityEventId: string;
  readonly activationStatus: "failed" | "pending";
  readonly surfacedIn: readonly string[];
  readonly messageRedacted: true;
  readonly applyRunStatus: "succeeded";
  readonly deploymentStatus: "active";
}

export interface LedgerIndependenceEvidence extends BaseEvidence {
  readonly applyRunId: string;
  readonly activityEventId: string;
  readonly stateVersionId: string;
  readonly outputId: string;
  readonly deploymentId: string;
  readonly applyCommittedBeforeActivation: true;
  readonly stateSnapshotRetained: true;
  readonly outputSnapshotRetained: true;
  readonly deploymentRetained: true;
  readonly activationDoesNotRollbackApplyLedger: true;
}

export interface PayloadBoundaryEvidence extends BaseEvidence {
  readonly payloadKind: typeof RELEASE_ACTIVATION_WEBHOOK_KIND;
  readonly forbiddenSecretClasses: readonly string[];
  readonly payloadContainsProviderCredentials: false;
  readonly payloadContainsRunnerEnv: false;
  readonly payloadContainsSecretOutputs: false;
  readonly authorizationHeaderRedacted: true;
  readonly nonSensitiveOutputsOnly: true;
}

export interface ReleaseActivationEvidenceValidation {
  readonly status: "passed";
  readonly manifestDigest: string;
  readonly generatedAt: string;
  readonly environment: ReleaseActivationEvidenceManifest["environment"];
  readonly env: Record<string, string>;
}

export interface ReleaseActivationEvidenceFileOptions {
  readonly evidenceRoot?: string;
}

export function releaseActivationEvidenceTemplate(): ReleaseActivationEvidenceManifest {
  const evidenceRefBase =
    "git+ssh://git@github.com/<operator>/takosumi-private.git@<40-hex-commit>";
  return {
    kind: RELEASE_ACTIVATION_EVIDENCE_KIND,
    generatedAt: "2026-06-21T00:00:00.000Z",
    environment: "production",
    checks: {
      successfulActivation: {
        evidenceRef: `${evidenceRefBase}#evidence/release-activation-success.md`,
        evidenceDigest: "sha256:<64-lowercase-hex>",
        live: true,
        summary:
          "A post-apply release activator materialized the app and passed launch and health checks without receiving provider credentials.",
        platformUrl: "https://app.takosumi.com",
        webhookPayloadKind: RELEASE_ACTIVATION_WEBHOOK_KIND,
        planRunId: "<plan-run-id>",
        applyRunId: "<apply-run-id>",
        finalModel: {
          workspaceId: "<workspace-id>",
          projectId: "<project-id>",
          capsuleId: "<capsule-id>",
          stateVersionId: "<state-version-id>",
          outputId: "<output-id>",
        },
        legacyRuntimeIds: {
          spaceId: "<space-id>",
          installationId: "<installation-id>",
          outputSnapshotId: "<output-snapshot-id>",
        },
        providerConnectionId: "<provider-connection-id>",
        deploymentId: "<deployment-id>",
        sourceSnapshotId: "<source-snapshot-id>",
        stateGeneration: 1,
        materializedResourceKind: "<materialized-resource-kind>",
        activationStatus: "succeeded",
        launchUrl: "https://<app-host>/",
        healthUrl: "https://<app-host>/healthz",
        healthStatus: 200,
        nonSensitiveOutputKeys: ["public_url"],
      },
      failureSurfacing: {
        evidenceRef: `${evidenceRefBase}#evidence/release-activation-failure-surfacing.md`,
        evidenceDigest: "sha256:<64-lowercase-hex>",
        live: true,
        summary:
          "A failed or pending release activation was surfaced to Activity and the run timeline while the OpenTofu apply remained succeeded.",
        applyRunId: "<apply-run-id>",
        activityEventId: "<activity-event-id>",
        activationStatus: "failed",
        surfacedIn: ["activity", "runTimeline"],
        messageRedacted: true,
        applyRunStatus: "succeeded",
        deploymentStatus: "active",
      },
      ledgerIndependence: {
        evidenceRef: `${evidenceRefBase}#evidence/release-activation-ledger-independence.md`,
        evidenceDigest: "sha256:<64-lowercase-hex>",
        live: true,
        summary:
          "Release activation status did not roll back the committed apply ledger, StateVersion, Output, or Deployment.",
        applyRunId: "<apply-run-id>",
        activityEventId: "<activity-event-id>",
        stateVersionId: "<state-version-id>",
        outputId: "<output-id>",
        deploymentId: "<deployment-id>",
        applyCommittedBeforeActivation: true,
        stateSnapshotRetained: true,
        outputSnapshotRetained: true,
        deploymentRetained: true,
        activationDoesNotRollbackApplyLedger: true,
      },
      payloadBoundary: {
        evidenceRef: `${evidenceRefBase}#evidence/release-activation-payload-boundary.md`,
        evidenceDigest: "sha256:<64-lowercase-hex>",
        live: true,
        summary:
          "Captured release activation payload and evidence contain only non-sensitive apply/deployment references and redacted authorization metadata.",
        payloadKind: RELEASE_ACTIVATION_WEBHOOK_KIND,
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

export async function validateReleaseActivationEvidenceFile(
  path: string,
  options: ReleaseActivationEvidenceFileOptions = {},
): Promise<ReleaseActivationEvidenceValidation> {
  const raw = await readFile(path, "utf8");
  const manifest = readManifest(JSON.parse(raw) as unknown);
  await verifyEvidenceFileDigests(
    manifest,
    options.evidenceRoot ?? defaultEvidenceRoot(path),
  );
  return buildValidation(manifest, raw);
}

export async function updateReleaseActivationEvidenceDigestsFile(
  path: string,
  options: ReleaseActivationEvidenceFileOptions = {},
): Promise<ReleaseActivationEvidenceValidation> {
  const raw = await readFile(path, "utf8");
  const draft = record(
    JSON.parse(raw) as unknown,
    "release activation evidence manifest",
  );
  const checks = record(draft.checks, "release activation checks");
  const evidenceRoot = options.evidenceRoot ?? defaultEvidenceRoot(path);

  for (const name of [
    "successfulActivation",
    "failureSurfacing",
    "ledgerIndependence",
    "payloadBoundary",
  ] as const) {
    const check = record(checks[name], `${name} evidence`);
    const evidenceRef = nonEmpty(check.evidenceRef, `${name}.evidenceRef`);
    const evidencePath = evidencePathFromGitRef(
      evidenceRef,
      evidenceRoot,
      name,
    );
    const bytes = await readFile(evidencePath);
    check.evidenceDigest = `sha256:${createHash("sha256")
      .update(bytes)
      .digest("hex")}`;
  }

  const nextRaw = `${JSON.stringify(draft, null, 2)}\n`;
  const manifest = readManifest(draft);
  await verifyEvidenceFileDigests(manifest, evidenceRoot);
  await writeFile(path, nextRaw);
  return buildValidation(manifest, nextRaw);
}

export function validateReleaseActivationEvidence(
  value: unknown,
  rawForDigest?: string,
): ReleaseActivationEvidenceValidation {
  const manifest = readManifest(value);
  return buildValidation(manifest, rawForDigest);
}

function buildValidation(
  manifest: ReleaseActivationEvidenceManifest,
  rawForDigest?: string,
): ReleaseActivationEvidenceValidation {
  const canonical = rawForDigest ?? JSON.stringify(manifest);
  const manifestDigest = `sha256:${createHash("sha256")
    .update(canonical)
    .digest("hex")}`;
  return {
    status: "passed",
    manifestDigest,
    generatedAt: manifest.generatedAt,
    environment: manifest.environment,
    env: {
      TAKOSUMI_RELEASE_ACTIVATION_SUCCESS_EVIDENCE_REF:
        manifest.checks.successfulActivation.evidenceRef,
      TAKOSUMI_RELEASE_ACTIVATION_SUCCESS_EVIDENCE_DIGEST:
        manifest.checks.successfulActivation.evidenceDigest,
      TAKOSUMI_RELEASE_ACTIVATION_FAILURE_SURFACING_EVIDENCE_REF:
        manifest.checks.failureSurfacing.evidenceRef,
      TAKOSUMI_RELEASE_ACTIVATION_FAILURE_SURFACING_EVIDENCE_DIGEST:
        manifest.checks.failureSurfacing.evidenceDigest,
      TAKOSUMI_RELEASE_ACTIVATION_LEDGER_INDEPENDENCE_EVIDENCE_REF:
        manifest.checks.ledgerIndependence.evidenceRef,
      TAKOSUMI_RELEASE_ACTIVATION_LEDGER_INDEPENDENCE_EVIDENCE_DIGEST:
        manifest.checks.ledgerIndependence.evidenceDigest,
      TAKOSUMI_RELEASE_ACTIVATION_PAYLOAD_BOUNDARY_EVIDENCE_REF:
        manifest.checks.payloadBoundary.evidenceRef,
      TAKOSUMI_RELEASE_ACTIVATION_PAYLOAD_BOUNDARY_EVIDENCE_DIGEST:
        manifest.checks.payloadBoundary.evidenceDigest,
    },
  };
}

async function verifyEvidenceFileDigests(
  manifest: ReleaseActivationEvidenceManifest,
  evidenceRoot: string,
): Promise<void> {
  for (const [name, evidence] of [
    ["successfulActivation", manifest.checks.successfulActivation],
    ["failureSurfacing", manifest.checks.failureSurfacing],
    ["ledgerIndependence", manifest.checks.ledgerIndependence],
    ["payloadBoundary", manifest.checks.payloadBoundary],
  ] as const) {
    const evidencePath = evidencePathFromGitRef(
      evidence.evidenceRef,
      evidenceRoot,
      name,
    );
    const bytes = await readFile(evidencePath);
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (digest !== evidence.evidenceDigest) {
      throw new Error(`${name}.evidenceDigest does not match ${evidencePath}`);
    }
  }
}

function evidencePathFromGitRef(
  evidenceRef: string,
  evidenceRoot: string,
  name: string,
): string {
  const { path } = parseEvidenceRef(evidenceRef, name);
  if (!path || path.startsWith("/") || path.split(/[\\/]+/).includes("..")) {
    throw new Error(`${name}.evidenceRef path is unsafe`);
  }
  return resolve(evidenceRoot, path);
}

function defaultEvidenceRoot(path: string): string {
  const dir = dirname(resolve(path));
  return basename(dir) === "evidence" ? dirname(dir) : dir;
}

function readManifest(value: unknown): ReleaseActivationEvidenceManifest {
  const manifest = record(value, "release activation evidence manifest");
  if (manifest.kind !== RELEASE_ACTIVATION_EVIDENCE_KIND) {
    throw new Error(
      `release activation evidence kind must be ${RELEASE_ACTIVATION_EVIDENCE_KIND}`,
    );
  }
  if (
    manifest.environment !== "staging" &&
    manifest.environment !== "production"
  ) {
    throw new Error("release activation evidence environment is invalid");
  }
  if (!validIsoDate(manifest.generatedAt)) {
    throw new Error("release activation evidence generatedAt is invalid");
  }
  const checks = record(manifest.checks, "release activation checks");
  const successfulActivation = readSuccessfulActivation(
    checks.successfulActivation,
  );
  const failureSurfacing = readFailureSurfacing(checks.failureSurfacing);
  const ledgerIndependence = readLedgerIndependence(checks.ledgerIndependence);
  const payloadBoundary = readPayloadBoundary(checks.payloadBoundary);
  if (ledgerIndependence.applyRunId !== failureSurfacing.applyRunId) {
    throw new Error(
      "ledgerIndependence.applyRunId must match failureSurfacing.applyRunId",
    );
  }
  if (ledgerIndependence.activityEventId !== failureSurfacing.activityEventId) {
    throw new Error(
      "ledgerIndependence.activityEventId must match failureSurfacing.activityEventId",
    );
  }
  return {
    kind: RELEASE_ACTIVATION_EVIDENCE_KIND,
    generatedAt: manifest.generatedAt,
    environment: manifest.environment,
    checks: {
      successfulActivation,
      failureSurfacing,
      ledgerIndependence,
      payloadBoundary,
    },
  };
}

function readSuccessfulActivation(
  value: unknown,
): SuccessfulActivationEvidence {
  const base = readBase(value, "successfulActivation");
  const row = record(value, "successfulActivation evidence");
  if (!httpsUrl(row.platformUrl)) {
    throw new Error("successfulActivation.platformUrl must be https");
  }
  if (row.webhookPayloadKind !== RELEASE_ACTIVATION_WEBHOOK_KIND) {
    throw new Error(
      `successfulActivation.webhookPayloadKind must be ${RELEASE_ACTIVATION_WEBHOOK_KIND}`,
    );
  }
  if (!positiveInteger(row.stateGeneration)) {
    throw new Error("successfulActivation.stateGeneration must be positive");
  }
  if (row.activationStatus !== "succeeded") {
    throw new Error(
      "successfulActivation.activationStatus must be succeeded",
    );
  }
  if (!httpsUrl(row.launchUrl)) {
    throw new Error("successfulActivation.launchUrl must be https");
  }
  if (!httpsUrl(row.healthUrl)) {
    throw new Error("successfulActivation.healthUrl must be https");
  }
  if (row.healthStatus !== 200) {
    throw new Error("successfulActivation.healthStatus must be 200");
  }
  const nonSensitiveOutputKeys = stringArray(
    row.nonSensitiveOutputKeys,
    "successfulActivation.nonSensitiveOutputKeys",
  );
  return {
    ...base,
    platformUrl: row.platformUrl,
    webhookPayloadKind: RELEASE_ACTIVATION_WEBHOOK_KIND,
    planRunId: nonEmpty(row.planRunId, "successfulActivation.planRunId"),
    applyRunId: nonEmpty(row.applyRunId, "successfulActivation.applyRunId"),
    finalModel: readFinalModelRefs(
      row.finalModel,
      "successfulActivation.finalModel",
    ),
    legacyRuntimeIds: readLegacyRuntimeIds(
      row.legacyRuntimeIds,
      "successfulActivation.legacyRuntimeIds",
    ),
    providerConnectionId: nonEmpty(
      row.providerConnectionId,
      "successfulActivation.providerConnectionId",
    ),
    deploymentId: nonEmpty(
      row.deploymentId,
      "successfulActivation.deploymentId",
    ),
    sourceSnapshotId: nonEmpty(
      row.sourceSnapshotId,
      "successfulActivation.sourceSnapshotId",
    ),
    stateGeneration: row.stateGeneration,
    materializedResourceKind: nonEmpty(
      row.materializedResourceKind,
      "successfulActivation.materializedResourceKind",
    ),
    activationStatus: "succeeded",
    launchUrl: row.launchUrl,
    healthUrl: row.healthUrl,
    healthStatus: 200,
    nonSensitiveOutputKeys,
  };
}

function readFailureSurfacing(value: unknown): FailureSurfacingEvidence {
  const base = readBase(value, "failureSurfacing");
  const row = record(value, "failureSurfacing evidence");
  if (row.activationStatus !== "failed" && row.activationStatus !== "pending") {
    throw new Error(
      "failureSurfacing.activationStatus must be failed or pending",
    );
  }
  const surfacedIn = stringArray(row.surfacedIn, "failureSurfacing.surfacedIn");
  for (const surface of REQUIRED_SURFACES) {
    if (!surfacedIn.includes(surface)) {
      throw new Error(`failureSurfacing.surfacedIn is missing ${surface}`);
    }
  }
  if (row.messageRedacted !== true) {
    throw new Error("failureSurfacing.messageRedacted must be true");
  }
  if (row.applyRunStatus !== "succeeded") {
    throw new Error("failureSurfacing.applyRunStatus must be succeeded");
  }
  if (row.deploymentStatus !== "active") {
    throw new Error("failureSurfacing.deploymentStatus must be active");
  }
  return {
    ...base,
    applyRunId: nonEmpty(row.applyRunId, "failureSurfacing.applyRunId"),
    activityEventId: nonEmpty(
      row.activityEventId,
      "failureSurfacing.activityEventId",
    ),
    activationStatus: row.activationStatus,
    surfacedIn,
    messageRedacted: true,
    applyRunStatus: "succeeded",
    deploymentStatus: "active",
  };
}

function readLedgerIndependence(value: unknown): LedgerIndependenceEvidence {
  const base = readBase(value, "ledgerIndependence");
  const row = record(value, "ledgerIndependence evidence");
  for (const key of [
    "applyCommittedBeforeActivation",
    "stateSnapshotRetained",
    "outputSnapshotRetained",
    "deploymentRetained",
    "activationDoesNotRollbackApplyLedger",
  ] as const) {
    if (row[key] !== true) {
      throw new Error(`ledgerIndependence.${key} must be true`);
    }
  }
  return {
    ...base,
    applyRunId: nonEmpty(row.applyRunId, "ledgerIndependence.applyRunId"),
    activityEventId: nonEmpty(
      row.activityEventId,
      "ledgerIndependence.activityEventId",
    ),
    stateVersionId: nonEmpty(
      row.stateVersionId,
      "ledgerIndependence.stateVersionId",
    ),
    outputId: nonEmpty(
      row.outputId,
      "ledgerIndependence.outputId",
    ),
    deploymentId: nonEmpty(
      row.deploymentId,
      "ledgerIndependence.deploymentId",
    ),
    applyCommittedBeforeActivation: true,
    stateSnapshotRetained: true,
    outputSnapshotRetained: true,
    deploymentRetained: true,
    activationDoesNotRollbackApplyLedger: true,
  };
}

function readFinalModelRefs(value: unknown, name: string): FinalModelRefs {
  const row = record(value, name);
  return {
    workspaceId: nonEmpty(row.workspaceId, `${name}.workspaceId`),
    projectId: nonEmpty(row.projectId, `${name}.projectId`),
    capsuleId: nonEmpty(row.capsuleId, `${name}.capsuleId`),
    stateVersionId: nonEmpty(row.stateVersionId, `${name}.stateVersionId`),
    outputId: nonEmpty(row.outputId, `${name}.outputId`),
  };
}

function readLegacyRuntimeIds(value: unknown, name: string): LegacyRuntimeIds {
  const row = record(value, name);
  return {
    spaceId: nonEmpty(row.spaceId, `${name}.spaceId`),
    installationId: nonEmpty(row.installationId, `${name}.installationId`),
    outputSnapshotId: nonEmpty(row.outputSnapshotId, `${name}.outputSnapshotId`),
  };
}

function readPayloadBoundary(value: unknown): PayloadBoundaryEvidence {
  const base = readBase(value, "payloadBoundary");
  const row = record(value, "payloadBoundary evidence");
  if (row.payloadKind !== RELEASE_ACTIVATION_WEBHOOK_KIND) {
    throw new Error(
      `payloadBoundary.payloadKind must be ${RELEASE_ACTIVATION_WEBHOOK_KIND}`,
    );
  }
  const forbiddenSecretClasses = stringArray(
    row.forbiddenSecretClasses,
    "payloadBoundary.forbiddenSecretClasses",
  );
  for (const secretClass of REQUIRED_SECRET_CLASSES) {
    if (!forbiddenSecretClasses.includes(secretClass)) {
      throw new Error(
        `payloadBoundary.forbiddenSecretClasses is missing ${secretClass}`,
      );
    }
  }
  for (const key of [
    "payloadContainsProviderCredentials",
    "payloadContainsRunnerEnv",
    "payloadContainsSecretOutputs",
  ] as const) {
    if (row[key] !== false) {
      throw new Error(`payloadBoundary.${key} must be false`);
    }
  }
  if (row.authorizationHeaderRedacted !== true) {
    throw new Error("payloadBoundary.authorizationHeaderRedacted must be true");
  }
  if (row.nonSensitiveOutputsOnly !== true) {
    throw new Error("payloadBoundary.nonSensitiveOutputsOnly must be true");
  }
  return {
    ...base,
    payloadKind: RELEASE_ACTIVATION_WEBHOOK_KIND,
    forbiddenSecretClasses,
    payloadContainsProviderCredentials: false,
    payloadContainsRunnerEnv: false,
    payloadContainsSecretOutputs: false,
    authorizationHeaderRedacted: true,
    nonSensitiveOutputsOnly: true,
  };
}

function readBase(value: unknown, name: string): BaseEvidence {
  const row = record(value, `${name} evidence`);
  if (row.live !== true) {
    throw new Error(`${name}.live must be true`);
  }
  if (!nonEmptyString(row.summary)) {
    throw new Error(`${name}.summary is required`);
  }
  const evidenceRef = nonEmpty(row.evidenceRef, `${name}.evidenceRef`);
  if (!GIT_REF_PATTERN.test(evidenceRef)) {
    throw new Error(`${name}.evidenceRef must be a git+ ref with #path`);
  }
  const parsedEvidenceRef = parseEvidenceRef(evidenceRef, name);
  if (!GIT_COMMIT_PIN_PATTERN.test(parsedEvidenceRef.gitRef)) {
    throw new Error(
      `${name}.evidenceRef must be pinned to an immutable git commit`,
    );
  }
  if (
    /fixture|todo|example\.com|\.invalid|localhost|127\.0\.0\.1/i.test(
      evidenceRef,
    )
  ) {
    throw new Error(
      `${name}.evidenceRef must be non-fixture operator evidence`,
    );
  }
  const evidenceDigest = nonEmpty(row.evidenceDigest, `${name}.evidenceDigest`);
  if (!DIGEST_PATTERN.test(evidenceDigest)) {
    throw new Error(`${name}.evidenceDigest must be sha256:<64hex>`);
  }
  return { evidenceRef, evidenceDigest, live: true, summary: row.summary };
}

function parseEvidenceRef(
  evidenceRef: string,
  name: string,
): { readonly gitRef: string; readonly path: string } {
  const parts = evidenceRef.split("#");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`${name}.evidenceRef must be a git+ ref with #path`);
  }
  return { gitRef: parts[0], path: parts[1] };
}

function httpsUrl(value: unknown): value is string {
  if (!nonEmptyString(value)) return false;
  const parsed = new URL(value);
  return parsed.protocol === "https:";
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringArray(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${name} must be a non-empty string array`);
  }
  if (!value.every(nonEmptyString)) {
    throw new Error(`${name} must contain only non-empty strings`);
  }
  return value;
}

function nonEmpty(value: unknown, name: string): string {
  if (!nonEmptyString(value)) throw new Error(`${name} is required`);
  return value;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
  );
}

function validIsoDate(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

if (import.meta.main) {
  try {
    const { path, evidenceRoot, printTemplate, updateDigests } = parseCliArgs(
      Bun.argv.slice(2),
    );
    if (printTemplate) {
      console.log(JSON.stringify(releaseActivationEvidenceTemplate(), null, 2));
      process.exit(0);
    }
    if (!path) {
      console.log(
        "Usage: bun scripts/validate-release-activation-evidence.ts <manifest.json> [--evidence-root path]\n       bun scripts/validate-release-activation-evidence.ts --update-digests <manifest.json> [--evidence-root path]\n       bun scripts/validate-release-activation-evidence.ts --print-template",
      );
      process.exit(
        Bun.argv.some((arg) => arg === "--help" || arg === "-h") ? 0 : 1,
      );
    }
    const result = updateDigests
      ? await updateReleaseActivationEvidenceDigestsFile(path, {
          evidenceRoot,
        })
      : await validateReleaseActivationEvidenceFile(path, {
          evidenceRoot,
        });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

function parseCliArgs(args: readonly string[]): {
  readonly path?: string;
  readonly evidenceRoot?: string;
  readonly printTemplate?: boolean;
  readonly updateDigests?: boolean;
} {
  let path: string | undefined;
  let evidenceRoot: string | undefined;
  let printTemplate = false;
  let updateDigests = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") return {};
    if (arg === "--print-template") {
      printTemplate = true;
      continue;
    }
    if (arg === "--update-digests") {
      updateDigests = true;
      continue;
    }
    if (arg === "--evidence-root") {
      evidenceRoot = args[index + 1];
      if (!evidenceRoot) throw new Error("--evidence-root requires a path");
      index += 1;
      continue;
    }
    if (path) throw new Error(`unexpected argument: ${arg}`);
    path = arg;
  }
  return { path, evidenceRoot, printTemplate, updateDigests };
}
