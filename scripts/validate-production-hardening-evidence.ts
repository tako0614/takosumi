import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

export const PRODUCTION_HARDENING_EVIDENCE_KIND =
  "takosumi.production-hardening-evidence@v1" as const;

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const GIT_REF_PATTERN = /^git\+[^#]+#[^#]+$/;
const GIT_COMMIT_PIN_PATTERN = /@[0-9a-f]{40,64}$/i;
const REQUIRED_PROVIDER_CATALOG_IDS = [
  "aws",
  "cloudflare",
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
  "apiPayloads",
  "runPayloads",
  "usagePayloads",
  "hardeningGatePayloads",
] as const;
const REQUIRED_LAYER2_STEPS = [
  "spaceScopedProviderConnection",
  "scratchInstall",
  "plan",
  "apply",
  "deploymentVerified",
  "destroy",
] as const;
const REQUIRED_RESTORE_SCOPES = [
  "controlLedger",
  "stateSnapshots",
  "outputSnapshots",
  "auditChain",
] as const;

export interface ProductionHardeningEvidenceManifest {
  readonly kind: typeof PRODUCTION_HARDENING_EVIDENCE_KIND;
  readonly generatedAt: string;
  readonly environment: "staging" | "production";
  readonly checks: {
    readonly containerSmoke: ContainerSmokeEvidence;
    readonly platformControlPlaneSmoke: PlatformControlPlaneSmokeEvidence;
    readonly egressEnforcement: EgressEnforcementEvidence;
    readonly restoreRehearsal: RestoreRehearsalEvidence;
    readonly providerCatalog: ProviderCatalogEvidence;
    readonly costAttribution: CostAttributionEvidence;
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

export interface PlatformControlPlaneSmokeEvidence extends BaseEvidence {
  readonly serviceUrl: string;
  readonly scratchSpaceId: string;
  readonly capsuleModule: "cloudflare-hello-worker";
  readonly credentialPath: "space_scoped_provider_connection";
  readonly steps: readonly string[];
  readonly capsuleGateStatus: "passed";
  readonly policyStatus: "passed";
  readonly deploymentVerified: true;
  readonly destroyVerified: true;
}

export interface EgressEnforcementEvidence extends BaseEvidence {
  readonly runnerProfileId: string;
  readonly runnerBoundary: "cloudflare-container";
  readonly networkPolicyConfigured: boolean;
  readonly providerAllowProbe: {
    readonly host: string;
    readonly result: "allowed";
    readonly provider: string;
    readonly runId: string;
    readonly status: "succeeded";
  };
  readonly sourceDenyProbe: {
    readonly host: string;
    readonly result: "denied";
    readonly statusCode: number;
    readonly errorCode: string;
  };
}

export interface RestoreRehearsalEvidence extends BaseEvidence {
  readonly target: "staging" | "isolated_recovery" | "production_smoke";
  readonly backupId: string;
  readonly restoreMode:
    | "validate_only"
    | "isolated_restore"
    | "live_smoke_restore";
  readonly scopesVerified: readonly string[];
  readonly auditChainVerified: true;
  readonly rtoMinutes: number;
  readonly rpoMinutes: number;
}

export interface ProviderCatalogEvidence extends BaseEvidence {
  readonly providers: readonly {
    readonly id: string;
    readonly ownershipOptions: readonly ["own_key"];
  }[];
  readonly cloudOnlyGatewayProjectionReturned: false;
  readonly secretValuesReturned: false;
}

export interface CostAttributionEvidence extends BaseEvidence {
  readonly usageLedger: {
    readonly spaceId: string;
    readonly eventCount: number;
    readonly latestRunIds: readonly string[];
  };
  readonly billingMode: "showback" | "enforce";
  readonly billingProvider: "manual" | "stripe";
  readonly freshSamples: true;
  readonly publicBillingPlanCount: number;
}

export interface SecretBoundaryEvidence extends BaseEvidence {
  readonly forbiddenSecretClasses: readonly string[];
  readonly leakTargetsChecked: readonly string[];
  readonly diagnosticsRedacted: true;
  readonly apiPayloadsRedacted: true;
  readonly runPayloadsRedacted: true;
  readonly usagePayloadsRedacted: true;
  readonly hardeningGatePayloadsRedacted: true;
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
      platformControlPlaneSmoke: {
        evidenceRef: `${evidenceRefBase}#evidence/platform-control-plane-smoke.md`,
        evidenceDigest: "sha256:<64-lowercase-hex>",
        live: true,
        summary:
          "Layer-2 platform control-plane smoke installed, planned, applied, verified, and destroyed a scratch Cloudflare Worker Capsule through the platform API.",
        serviceUrl: "https://app.takosumi.com",
        scratchSpaceId: "<scratch-space-id>",
        capsuleModule: "cloudflare-hello-worker",
        credentialPath: "space_scoped_provider_connection",
        steps: [
          "spaceScopedProviderConnection",
          "scratchInstall",
          "plan",
          "apply",
          "deploymentVerified",
          "destroy",
        ],
        capsuleGateStatus: "passed",
        policyStatus: "passed",
        deploymentVerified: true,
        destroyVerified: true,
      },
      egressEnforcement: {
        evidenceRef: `${evidenceRefBase}#evidence/egress.md`,
        evidenceDigest: "sha256:<64-lowercase-hex>",
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
          runId: "<apply-run-id>",
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
        evidenceRef: `${evidenceRefBase}#evidence/restore-rehearsal.md`,
        evidenceDigest: "sha256:<64-lowercase-hex>",
        live: true,
        summary:
          "Latest platform control-plane backup was restored or validated in an isolated recovery target and the audit chain was verified.",
        target: "production_smoke",
        backupId: "<backup-id>",
        restoreMode: "live_smoke_restore",
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
        evidenceRef: `${evidenceRefBase}#evidence/provider-catalog.md`,
        evidenceDigest: "sha256:<64-lowercase-hex>",
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
        evidenceRef: `${evidenceRefBase}#evidence/cost-attribution.md`,
        evidenceDigest: "sha256:<64-lowercase-hex>",
        live: true,
        summary:
          "Production smoke Space has attributable runner-minute usage and showback billing enabled.",
        usageLedger: {
          spaceId: "<space-id>",
          eventCount: 1,
          latestRunIds: ["<run-id>"],
        },
        billingMode: "showback",
        billingProvider: "manual",
        freshSamples: true,
        publicBillingPlanCount: 0,
      },
      secretBoundary: {
        evidenceRef: `${evidenceRefBase}#evidence/secret-boundary.md`,
        evidenceDigest: "sha256:<64-lowercase-hex>",
        live: true,
        summary:
          "Live diagnostics, account API payloads, run payloads, usage payloads, and hardening gate payloads were checked for operator secret leakage.",
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
    "platformControlPlaneSmoke",
    "egressEnforcement",
    "restoreRehearsal",
    "providerCatalog",
    "costAttribution",
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
      TAKOSUMI_PLATFORM_CONTROL_PLANE_SMOKE_EVIDENCE_REF:
        manifest.checks.platformControlPlaneSmoke.evidenceRef,
      TAKOSUMI_PLATFORM_CONTROL_PLANE_SMOKE_EVIDENCE_DIGEST:
        manifest.checks.platformControlPlaneSmoke.evidenceDigest,
      TAKOSUMI_EGRESS_ENFORCEMENT_EVIDENCE_REF:
        manifest.checks.egressEnforcement.evidenceRef,
      TAKOSUMI_EGRESS_ENFORCEMENT_EVIDENCE_DIGEST:
        manifest.checks.egressEnforcement.evidenceDigest,
      TAKOSUMI_RESTORE_REHEARSAL_EVIDENCE_REF:
        manifest.checks.restoreRehearsal.evidenceRef,
      TAKOSUMI_RESTORE_REHEARSAL_EVIDENCE_DIGEST:
        manifest.checks.restoreRehearsal.evidenceDigest,
      TAKOSUMI_PROVIDER_CATALOG_EVIDENCE_REF:
        manifest.checks.providerCatalog.evidenceRef,
      TAKOSUMI_PROVIDER_CATALOG_EVIDENCE_DIGEST:
        manifest.checks.providerCatalog.evidenceDigest,
      TAKOSUMI_COST_ATTRIBUTION_EVIDENCE_REF:
        manifest.checks.costAttribution.evidenceRef,
      TAKOSUMI_COST_ATTRIBUTION_EVIDENCE_DIGEST:
        manifest.checks.costAttribution.evidenceDigest,
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
    ["platformControlPlaneSmoke", manifest.checks.platformControlPlaneSmoke],
    ["egressEnforcement", manifest.checks.egressEnforcement],
    ["restoreRehearsal", manifest.checks.restoreRehearsal],
    ["providerCatalog", manifest.checks.providerCatalog],
    ["costAttribution", manifest.checks.costAttribution],
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
  const platformControlPlaneSmoke = readPlatformControlPlaneSmoke(
    checks.platformControlPlaneSmoke,
  );
  const egressEnforcement = readEgressEnforcement(checks.egressEnforcement);
  const restoreRehearsal = readRestoreRehearsal(checks.restoreRehearsal);
  const providerCatalog = readProviderCatalog(checks.providerCatalog);
  const costAttribution = readCostAttribution(checks.costAttribution);
  const secretBoundary = readSecretBoundary(checks.secretBoundary);
  return {
    kind: PRODUCTION_HARDENING_EVIDENCE_KIND,
    generatedAt: manifest.generatedAt,
    environment: manifest.environment,
    checks: {
      containerSmoke,
      platformControlPlaneSmoke,
      egressEnforcement,
      restoreRehearsal,
      providerCatalog,
      costAttribution,
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

function readPlatformControlPlaneSmoke(
  value: unknown,
): PlatformControlPlaneSmokeEvidence {
  const base = readBase(value, "platformControlPlaneSmoke");
  const row = record(value, "platformControlPlaneSmoke evidence");
  if (!nonEmptyString(row.serviceUrl)) {
    throw new Error("platformControlPlaneSmoke.serviceUrl is required");
  }
  const serviceUrl = new URL(row.serviceUrl);
  if (serviceUrl.protocol !== "https:" && serviceUrl.hostname !== "localhost") {
    throw new Error("platformControlPlaneSmoke.serviceUrl must be https");
  }
  if (!nonEmptyString(row.scratchSpaceId)) {
    throw new Error("platformControlPlaneSmoke.scratchSpaceId is required");
  }
  if (row.capsuleModule !== "cloudflare-hello-worker") {
    throw new Error(
      "platformControlPlaneSmoke.capsuleModule must be cloudflare-hello-worker",
    );
  }
  if (row.credentialPath !== "space_scoped_provider_connection") {
    throw new Error(
      "platformControlPlaneSmoke.credentialPath must be space_scoped_provider_connection",
    );
  }
  const steps = stringArray(row.steps, "platformControlPlaneSmoke.steps");
  for (const step of REQUIRED_LAYER2_STEPS) {
    if (!steps.includes(step)) {
      throw new Error(`platformControlPlaneSmoke.steps is missing ${step}`);
    }
  }
  if (row.capsuleGateStatus !== "passed") {
    throw new Error(
      "platformControlPlaneSmoke.capsuleGateStatus must be passed",
    );
  }
  if (row.policyStatus !== "passed") {
    throw new Error("platformControlPlaneSmoke.policyStatus must be passed");
  }
  if (row.deploymentVerified !== true) {
    throw new Error(
      "platformControlPlaneSmoke.deploymentVerified must be true",
    );
  }
  if (row.destroyVerified !== true) {
    throw new Error("platformControlPlaneSmoke.destroyVerified must be true");
  }
  return {
    ...base,
    serviceUrl: row.serviceUrl,
    scratchSpaceId: row.scratchSpaceId,
    capsuleModule: "cloudflare-hello-worker",
    credentialPath: "space_scoped_provider_connection",
    steps,
    capsuleGateStatus: "passed",
    policyStatus: "passed",
    deploymentVerified: true,
    destroyVerified: true,
  };
}

function readEgressEnforcement(value: unknown): EgressEnforcementEvidence {
  const base = readBase(value, "egressEnforcement");
  const row = record(value, "egressEnforcement evidence");
  const providerAllowProbe = record(
    row.providerAllowProbe,
    "egressEnforcement providerAllowProbe",
  );
  const sourceDenyProbe = record(
    row.sourceDenyProbe,
    "egressEnforcement sourceDenyProbe",
  );
  if (!nonEmptyString(row.runnerProfileId)) {
    throw new Error("egressEnforcement.runnerProfileId is required");
  }
  if (row.runnerBoundary !== "cloudflare-container") {
    throw new Error("egressEnforcement.runnerBoundary is invalid");
  }
  if (row.networkPolicyConfigured !== true) {
    throw new Error("egressEnforcement.networkPolicyConfigured must be true");
  }
  if (
    !nonEmptyString(providerAllowProbe.host) ||
    providerAllowProbe.result !== "allowed" ||
    !nonEmptyString(providerAllowProbe.provider) ||
    !nonEmptyString(providerAllowProbe.runId) ||
    providerAllowProbe.status !== "succeeded"
  ) {
    throw new Error(
      "egressEnforcement.providerAllowProbe must show a succeeded provider API allow probe",
    );
  }
  if (
    !nonEmptyString(sourceDenyProbe.host) ||
    sourceDenyProbe.result !== "denied" ||
    !Number.isSafeInteger(sourceDenyProbe.statusCode) ||
    sourceDenyProbe.statusCode < 400 ||
    !nonEmptyString(sourceDenyProbe.errorCode)
  ) {
    throw new Error(
      "egressEnforcement.sourceDenyProbe must show a denied source host",
    );
  }
  return {
    ...base,
    runnerProfileId: row.runnerProfileId,
    runnerBoundary: "cloudflare-container",
    networkPolicyConfigured: true,
    providerAllowProbe: {
      host: providerAllowProbe.host,
      result: "allowed",
      provider: providerAllowProbe.provider,
      runId: providerAllowProbe.runId,
      status: "succeeded",
    },
    sourceDenyProbe: {
      host: sourceDenyProbe.host,
      result: "denied",
      statusCode: sourceDenyProbe.statusCode,
      errorCode: sourceDenyProbe.errorCode,
    },
  };
}

function readRestoreRehearsal(value: unknown): RestoreRehearsalEvidence {
  const base = readBase(value, "restoreRehearsal");
  const row = record(value, "restoreRehearsal evidence");
  if (
    row.target !== "staging" &&
    row.target !== "isolated_recovery" &&
    row.target !== "production_smoke"
  ) {
    throw new Error("restoreRehearsal.target is invalid");
  }
  if (!nonEmptyString(row.backupId)) {
    throw new Error("restoreRehearsal.backupId is required");
  }
  if (
    row.restoreMode !== "validate_only" &&
    row.restoreMode !== "isolated_restore" &&
    row.restoreMode !== "live_smoke_restore"
  ) {
    throw new Error("restoreRehearsal.restoreMode is invalid");
  }
  const scopesVerified = stringArray(
    row.scopesVerified,
    "restoreRehearsal.scopesVerified",
  );
  for (const scope of REQUIRED_RESTORE_SCOPES) {
    if (!scopesVerified.includes(scope)) {
      throw new Error(`restoreRehearsal.scopesVerified is missing ${scope}`);
    }
  }
  if (row.auditChainVerified !== true) {
    throw new Error("restoreRehearsal.auditChainVerified must be true");
  }
  if (!positiveNumber(row.rtoMinutes)) {
    throw new Error("restoreRehearsal.rtoMinutes must be positive");
  }
  if (!positiveNumber(row.rpoMinutes)) {
    throw new Error("restoreRehearsal.rpoMinutes must be positive");
  }
  return {
    ...base,
    target: row.target,
    backupId: row.backupId,
    restoreMode: row.restoreMode,
    scopesVerified,
    auditChainVerified: true,
    rtoMinutes: row.rtoMinutes,
    rpoMinutes: row.rpoMinutes,
  };
}

function readProviderCatalog(value: unknown): ProviderCatalogEvidence {
  const base = readBase(value, "providerCatalog");
  const row = record(value, "providerCatalog evidence");
  const providersRaw = array(
    row.providers,
    "providerCatalog.providers",
  );
  const providers = providersRaw.map((item, index) => {
    const provider = record(item, `providerCatalog.providers[${index}]`);
    if (!nonEmptyString(provider.id)) {
      throw new Error(`providerCatalog.providers[${index}].id is required`);
    }
    const ownershipOptions = stringArray(
      provider.ownershipOptions,
      `providerCatalog.providers[${index}].ownershipOptions`,
    );
    requireSameMembers(
      ownershipOptions,
      ["own_key"],
      `providerCatalog.providers[${index}].ownershipOptions`,
    );
    return {
      id: provider.id,
      ownershipOptions: ["own_key"] as const,
    };
  });
  const providerIds = providers.map((provider) => provider.id);
  for (const provider of REQUIRED_PROVIDER_CATALOG_IDS) {
    if (!providerIds.includes(provider)) {
      throw new Error(`providerCatalog.providers is missing ${provider}`);
    }
  }
  if (row.cloudOnlyGatewayProjectionReturned !== false) {
    throw new Error(
      "providerCatalog.cloudOnlyGatewayProjectionReturned must be false",
    );
  }
  if (row.secretValuesReturned !== false) {
    throw new Error("providerCatalog.secretValuesReturned must be false");
  }
  return {
    ...base,
    providers,
    cloudOnlyGatewayProjectionReturned: false,
    secretValuesReturned: false,
  };
}

function readCostAttribution(value: unknown): CostAttributionEvidence {
  const base = readBase(value, "costAttribution");
  const row = record(value, "costAttribution evidence");
  const usageLedger = record(
    row.usageLedger,
    "costAttribution.usageLedger",
  );
  if (!nonEmptyString(usageLedger.spaceId)) {
    throw new Error("costAttribution.usageLedger.spaceId is required");
  }
  if (
    typeof usageLedger.eventCount !== "number" ||
    !Number.isSafeInteger(usageLedger.eventCount) ||
    usageLedger.eventCount < 1
  ) {
    throw new Error("costAttribution.usageLedger.eventCount must be positive");
  }
  const latestRunIds = stringArray(
    usageLedger.latestRunIds,
    "costAttribution.usageLedger.latestRunIds",
  );
  if (latestRunIds.length === 0) {
    throw new Error(
      "costAttribution.usageLedger.latestRunIds must include at least one run",
    );
  }
  if (row.billingMode !== "showback" && row.billingMode !== "enforce") {
    throw new Error("costAttribution.billingMode must be showback or enforce");
  }
  if (row.billingProvider !== "manual" && row.billingProvider !== "stripe") {
    throw new Error("costAttribution.billingProvider must be manual or stripe");
  }
  if (row.freshSamples !== true) {
    throw new Error("costAttribution.freshSamples must be true");
  }
  if (
    typeof row.publicBillingPlanCount !== "number" ||
    !Number.isSafeInteger(row.publicBillingPlanCount) ||
    row.publicBillingPlanCount < 0
  ) {
    throw new Error("costAttribution.publicBillingPlanCount must be >= 0");
  }
  return {
    ...base,
    usageLedger: {
      spaceId: usageLedger.spaceId,
      eventCount: usageLedger.eventCount,
      latestRunIds,
    },
    billingMode: row.billingMode,
    billingProvider: row.billingProvider,
    freshSamples: true,
    publicBillingPlanCount: row.publicBillingPlanCount,
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
    "apiPayloadsRedacted",
    "runPayloadsRedacted",
    "usagePayloadsRedacted",
    "hardeningGatePayloadsRedacted",
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
    apiPayloadsRedacted: true,
    runPayloadsRedacted: true,
    usagePayloadsRedacted: true,
    hardeningGatePayloadsRedacted: true,
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

function array(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${name} must be a non-empty array`);
  }
  return value;
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

function requireSameMembers(
  actual: readonly string[],
  expected: readonly string[],
  name: string,
): void {
  for (const item of expected) {
    if (!actual.includes(item)) throw new Error(`${name} is missing ${item}`);
  }
  for (const item of actual) {
    if (!expected.includes(item))
      throw new Error(`${name} has unknown ${item}`);
  }
}

function nonEmpty(value: unknown, name: string): string {
  if (!nonEmptyString(value)) throw new Error(`${name} is required`);
  return value;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
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
