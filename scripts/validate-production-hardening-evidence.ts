import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

export const PRODUCTION_HARDENING_EVIDENCE_KIND =
  "takosumi.production-hardening-evidence@v1" as const;

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const GIT_REF_PATTERN = /^git\+[^#]+#[^#]+$/;
const GIT_COMMIT_PIN_PATTERN = /@[0-9a-f]{40,64}$/i;
const REQUIRED_VERIFIED_SPACE_PROVIDERS = [
  "aws",
  "gcp",
  "github",
  "kubernetes",
] as const;
const REQUIRED_SECRET_CLASSES = [
  "providerCredentials",
  "deployControlTokens",
  "stateBackendCredentials",
] as const;
const REQUIRED_LEAK_TARGETS = [
  "runnerDiagnostics",
  "failureAuditPayloads",
  "outputSnapshots",
  "tenantWorkerBindings",
] as const;

export interface ProductionHardeningEvidenceManifest {
  readonly kind: typeof PRODUCTION_HARDENING_EVIDENCE_KIND;
  readonly generatedAt: string;
  readonly environment: "staging" | "production";
  readonly checks: {
    readonly containerSmoke: ContainerSmokeEvidence;
    readonly egressEnforcement: EgressEnforcementEvidence;
    readonly providerTemplates: ProviderTemplateEvidence;
    readonly secretBoundary: SecretBoundaryEvidence;
  };
}

export interface BaseEvidence {
  readonly evidenceRef: string;
  readonly evidenceDigest: string;
  readonly live: boolean;
  readonly summary: string;
}

export interface ContainerSmokeEvidence extends BaseEvidence {
  readonly deployedRunnerObject: string;
  readonly healthzStatus: number;
  readonly providerApply: {
    readonly provider: string;
    readonly runId: string;
    readonly status: "succeeded";
    readonly stateSnapshotId: string;
    readonly outputSnapshotId: string;
  };
}

export interface EgressEnforcementEvidence extends BaseEvidence {
  readonly dispatchNamespace: string;
  readonly outboundWorkerConfigured: boolean;
  readonly allowProbe: {
    readonly host: string;
    readonly result: "allowed";
  };
  readonly denyProbe: {
    readonly host: string;
    readonly result: "denied";
  };
}

export interface ProviderTemplateEvidence extends BaseEvidence {
  readonly cloudflareManagedDefault: {
    readonly primaryCredentialSource: "takosumi_managed";
    readonly defaultEligible: true;
  };
  readonly verifiedSpaceProviders: readonly string[];
  readonly providerEnvSet: {
    readonly providerPinRequired: true;
    readonly egressPolicyRequired: true;
    readonly customRunnerClassRequired: true;
    readonly operatorDefaultAllowed: false;
  };
}

export interface SecretBoundaryEvidence extends BaseEvidence {
  readonly forbiddenSecretClasses: readonly string[];
  readonly leakTargetsChecked: readonly string[];
  readonly diagnosticsRedacted: true;
  readonly auditPayloadsRedacted: true;
  readonly outputSnapshotsRedacted: true;
  readonly tenantWorkerBindingsRedacted: true;
}

export interface ProductionHardeningEvidenceValidation {
  readonly status: "passed";
  readonly manifestDigest: string;
  readonly generatedAt: string;
  readonly environment: ProductionHardeningEvidenceManifest["environment"];
  readonly env: Record<string, string>;
}

export interface ProductionHardeningEvidenceFileOptions {
  readonly evidenceRoot?: string;
}

export function productionHardeningEvidenceTemplate(): ProductionHardeningEvidenceManifest {
  const evidenceRefBase =
    "git+ssh://git@github.com/<operator>/takosumi-private.git@<40-hex-commit>";
  return {
    kind: PRODUCTION_HARDENING_EVIDENCE_KIND,
    generatedAt: "2026-06-08T00:00:00.000Z",
    environment: "production",
    checks: {
      containerSmoke: {
        evidenceRef: `${evidenceRefBase}#evidence/container-smoke.md`,
        evidenceDigest: "sha256:<64-lowercase-hex>",
        live: true,
        summary:
          "Deployed OpenTofuRunnerObject started a Cloudflare Container and applied a non-production provider fixture.",
        deployedRunnerObject: "OpenTofuRunnerObject",
        healthzStatus: 200,
        providerApply: {
          provider: "cloudflare",
          runId: "<run-id>",
          status: "succeeded",
          stateSnapshotId: "<state-snapshot-id>",
          outputSnapshotId: "<output-snapshot-id>",
        },
      },
      egressEnforcement: {
        evidenceRef: `${evidenceRefBase}#evidence/egress.md`,
        evidenceDigest: "sha256:<64-lowercase-hex>",
        live: true,
        summary:
          "Dispatch namespace outbound Worker allowed a policy host and denied a non-policy host.",
        dispatchNamespace: "<dispatch-namespace>",
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
        evidenceRef: `${evidenceRefBase}#evidence/provider-catalog.md`,
        evidenceDigest: "sha256:<64-lowercase-hex>",
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
        evidenceRef: `${evidenceRefBase}#evidence/secret-boundary.md`,
        evidenceDigest: "sha256:<64-lowercase-hex>",
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

export async function validateProductionHardeningEvidenceFile(
  path: string,
  options: ProductionHardeningEvidenceFileOptions = {},
): Promise<ProductionHardeningEvidenceValidation> {
  const raw = await readFile(path, "utf8");
  const manifest = readManifest(JSON.parse(raw) as unknown);
  await verifyEvidenceFileDigests(
    manifest,
    options.evidenceRoot ?? defaultEvidenceRoot(path),
  );
  return buildValidation(manifest, raw);
}

export async function updateProductionHardeningEvidenceDigestsFile(
  path: string,
  options: ProductionHardeningEvidenceFileOptions = {},
): Promise<ProductionHardeningEvidenceValidation> {
  const raw = await readFile(path, "utf8");
  const draft = record(
    JSON.parse(raw) as unknown,
    "production hardening evidence manifest",
  );
  const checks = record(draft.checks, "production hardening checks");
  const evidenceRoot = options.evidenceRoot ?? defaultEvidenceRoot(path);

  for (const name of [
    "containerSmoke",
    "egressEnforcement",
    "providerTemplates",
    "secretBoundary",
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

export function validateProductionHardeningEvidence(
  value: unknown,
  rawForDigest?: string,
): ProductionHardeningEvidenceValidation {
  const manifest = readManifest(value);
  return buildValidation(manifest, rawForDigest);
}

function buildValidation(
  manifest: ProductionHardeningEvidenceManifest,
  rawForDigest?: string,
): ProductionHardeningEvidenceValidation {
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
      TAKOSUMI_CLOUDFLARE_CONTAINER_SMOKE_EVIDENCE_REF:
        manifest.checks.containerSmoke.evidenceRef,
      TAKOSUMI_CLOUDFLARE_CONTAINER_SMOKE_EVIDENCE_DIGEST:
        manifest.checks.containerSmoke.evidenceDigest,
      TAKOSUMI_EGRESS_ENFORCEMENT_EVIDENCE_REF:
        manifest.checks.egressEnforcement.evidenceRef,
      TAKOSUMI_EGRESS_ENFORCEMENT_EVIDENCE_DIGEST:
        manifest.checks.egressEnforcement.evidenceDigest,
      TAKOSUMI_PROVIDER_CATALOG_EVIDENCE_REF:
        manifest.checks.providerTemplates.evidenceRef,
      TAKOSUMI_PROVIDER_CATALOG_EVIDENCE_DIGEST:
        manifest.checks.providerTemplates.evidenceDigest,
      TAKOSUMI_SECRET_BOUNDARY_EVIDENCE_REF:
        manifest.checks.secretBoundary.evidenceRef,
      TAKOSUMI_SECRET_BOUNDARY_EVIDENCE_DIGEST:
        manifest.checks.secretBoundary.evidenceDigest,
    },
  };
}

async function verifyEvidenceFileDigests(
  manifest: ProductionHardeningEvidenceManifest,
  evidenceRoot: string,
): Promise<void> {
  for (const [name, evidence] of [
    ["containerSmoke", manifest.checks.containerSmoke],
    ["egressEnforcement", manifest.checks.egressEnforcement],
    ["providerTemplates", manifest.checks.providerTemplates],
    ["secretBoundary", manifest.checks.secretBoundary],
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

function readManifest(value: unknown): ProductionHardeningEvidenceManifest {
  const manifest = record(value, "production hardening evidence manifest");
  if (manifest.kind !== PRODUCTION_HARDENING_EVIDENCE_KIND) {
    throw new Error(
      `production hardening evidence kind must be ${PRODUCTION_HARDENING_EVIDENCE_KIND}`,
    );
  }
  if (
    manifest.environment !== "staging" &&
    manifest.environment !== "production"
  ) {
    throw new Error("production hardening evidence environment is invalid");
  }
  if (!validIsoDate(manifest.generatedAt)) {
    throw new Error("production hardening evidence generatedAt is invalid");
  }
  const checks = record(manifest.checks, "production hardening checks");
  const containerSmoke = readContainerSmoke(checks.containerSmoke);
  const egressEnforcement = readEgressEnforcement(checks.egressEnforcement);
  const providerTemplates = readProviderTemplate(checks.providerTemplates);
  const secretBoundary = readSecretBoundary(checks.secretBoundary);
  return {
    kind: PRODUCTION_HARDENING_EVIDENCE_KIND,
    generatedAt: manifest.generatedAt,
    environment: manifest.environment,
    checks: {
      containerSmoke,
      egressEnforcement,
      providerTemplates,
      secretBoundary,
    },
  };
}

function readContainerSmoke(value: unknown): ContainerSmokeEvidence {
  const base = readBase(value, "containerSmoke");
  const row = record(value, "containerSmoke evidence");
  const providerApply = record(
    row.providerApply,
    "containerSmoke providerApply",
  );
  if (!nonEmptyString(row.deployedRunnerObject)) {
    throw new Error("containerSmoke.deployedRunnerObject is required");
  }
  if (row.healthzStatus !== 200) {
    throw new Error("containerSmoke.healthzStatus must be 200");
  }
  if (!nonEmptyString(providerApply.provider)) {
    throw new Error("containerSmoke.providerApply.provider is required");
  }
  if (!nonEmptyString(providerApply.runId)) {
    throw new Error("containerSmoke.providerApply.runId is required");
  }
  if (providerApply.status !== "succeeded") {
    throw new Error("containerSmoke.providerApply.status must be succeeded");
  }
  if (!nonEmptyString(providerApply.stateSnapshotId)) {
    throw new Error("containerSmoke.providerApply.stateSnapshotId is required");
  }
  if (!nonEmptyString(providerApply.outputSnapshotId)) {
    throw new Error(
      "containerSmoke.providerApply.outputSnapshotId is required",
    );
  }
  return {
    ...base,
    deployedRunnerObject: row.deployedRunnerObject,
    healthzStatus: row.healthzStatus,
    providerApply: {
      provider: providerApply.provider,
      runId: providerApply.runId,
      status: "succeeded",
      stateSnapshotId: providerApply.stateSnapshotId,
      outputSnapshotId: providerApply.outputSnapshotId,
    },
  };
}

function readEgressEnforcement(value: unknown): EgressEnforcementEvidence {
  const base = readBase(value, "egressEnforcement");
  const row = record(value, "egressEnforcement evidence");
  const allowProbe = record(row.allowProbe, "egressEnforcement allowProbe");
  const denyProbe = record(row.denyProbe, "egressEnforcement denyProbe");
  if (!nonEmptyString(row.dispatchNamespace)) {
    throw new Error("egressEnforcement.dispatchNamespace is required");
  }
  if (row.outboundWorkerConfigured !== true) {
    throw new Error("egressEnforcement.outboundWorkerConfigured must be true");
  }
  if (!nonEmptyString(allowProbe.host) || allowProbe.result !== "allowed") {
    throw new Error("egressEnforcement.allowProbe must show an allowed host");
  }
  if (!nonEmptyString(denyProbe.host) || denyProbe.result !== "denied") {
    throw new Error("egressEnforcement.denyProbe must show a denied host");
  }
  return {
    ...base,
    dispatchNamespace: row.dispatchNamespace,
    outboundWorkerConfigured: true,
    allowProbe: { host: allowProbe.host, result: "allowed" },
    denyProbe: { host: denyProbe.host, result: "denied" },
  };
}

function readProviderTemplate(value: unknown): ProviderTemplateEvidence {
  const base = readBase(value, "providerTemplates");
  const row = record(value, "providerTemplates evidence");
  const cloudflare = record(
    row.cloudflareManagedDefault,
    "providerTemplates cloudflareManagedDefault",
  );
  const pack = record(
    row.providerEnvSet,
    "providerTemplates providerEnvSet",
  );
  if (
    cloudflare.primaryCredentialSource !== "takosumi_managed" ||
    cloudflare.defaultEligible !== true
  ) {
    throw new Error(
      "providerTemplates.cloudflareManagedDefault must be takosumi_managed and defaultEligible",
    );
  }
  const verifiedSpaceProviders = stringArray(
    row.verifiedSpaceProviders,
    "providerTemplates.verifiedSpaceProviders",
  );
  for (const provider of REQUIRED_VERIFIED_SPACE_PROVIDERS) {
    if (!verifiedSpaceProviders.includes(provider)) {
      throw new Error(
        `providerTemplates.verifiedSpaceProviders is missing ${provider}`,
      );
    }
  }
  for (const [key, expected] of [
    ["providerPinRequired", true],
    ["egressPolicyRequired", true],
    ["customRunnerClassRequired", true],
    ["operatorDefaultAllowed", false],
  ] as const) {
    if (pack[key] !== expected) {
      throw new Error(`providerTemplates.providerEnvSet.${key} drifted`);
    }
  }
  return {
    ...base,
    cloudflareManagedDefault: {
      primaryCredentialSource: "takosumi_managed",
      defaultEligible: true,
    },
    verifiedSpaceProviders,
    providerEnvSet: {
      providerPinRequired: true,
      egressPolicyRequired: true,
      customRunnerClassRequired: true,
      operatorDefaultAllowed: false,
    },
  };
}

function readSecretBoundary(value: unknown): SecretBoundaryEvidence {
  const base = readBase(value, "secretBoundary");
  const row = record(value, "secretBoundary evidence");
  const forbiddenSecretClasses = stringArray(
    row.forbiddenSecretClasses,
    "secretBoundary.forbiddenSecretClasses",
  );
  const leakTargetsChecked = stringArray(
    row.leakTargetsChecked,
    "secretBoundary.leakTargetsChecked",
  );
  for (const secretClass of REQUIRED_SECRET_CLASSES) {
    if (!forbiddenSecretClasses.includes(secretClass)) {
      throw new Error(
        `secretBoundary.forbiddenSecretClasses is missing ${secretClass}`,
      );
    }
  }
  for (const target of REQUIRED_LEAK_TARGETS) {
    if (!leakTargetsChecked.includes(target)) {
      throw new Error(`secretBoundary.leakTargetsChecked is missing ${target}`);
    }
  }
  for (const key of [
    "diagnosticsRedacted",
    "auditPayloadsRedacted",
    "outputSnapshotsRedacted",
    "tenantWorkerBindingsRedacted",
  ] as const) {
    if (row[key] !== true) {
      throw new Error(`secretBoundary.${key} must be true`);
    }
  }
  return {
    ...base,
    forbiddenSecretClasses,
    leakTargetsChecked,
    diagnosticsRedacted: true,
    auditPayloadsRedacted: true,
    outputSnapshotsRedacted: true,
    tenantWorkerBindingsRedacted: true,
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
      console.log(
        JSON.stringify(productionHardeningEvidenceTemplate(), null, 2),
      );
      process.exit(0);
    }
    if (!path) {
      console.log(
        "Usage: bun scripts/validate-production-hardening-evidence.ts <manifest.json> [--evidence-root path]\n       bun scripts/validate-production-hardening-evidence.ts --update-digests <manifest.json> [--evidence-root path]\n       bun scripts/validate-production-hardening-evidence.ts --print-template",
      );
      process.exit(
        Bun.argv.some((arg) => arg === "--help" || arg === "-h") ? 0 : 1,
      );
    }
    const result = updateDigests
      ? await updateProductionHardeningEvidenceDigestsFile(path, {
          evidenceRoot,
        })
      : await validateProductionHardeningEvidenceFile(path, {
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
    if (arg.startsWith("--")) throw new Error(`unknown argument: ${arg}`);
    if (path) throw new Error(`unexpected argument: ${arg}`);
    path = arg;
  }
  return { path, evidenceRoot, printTemplate, updateDigests };
}
